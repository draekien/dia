import {
  type AgentBackend,
  type AgentSession,
  type DiaTool,
  type HostSessions,
  type OutboundMessage,
  type PaneId,
  type SessionAttachment,
  type SessionId,
  SessionNotice
} from '@dia/plugin'
import type { IssuesSnapshot, ObjectiveId } from '@dia-plugin/issues/domain'
import type { Issues } from '@dia-plugin/issues/service'
import {
  Crypto,
  Effect,
  Exit,
  Option,
  Ref,
  Scope,
  Stream,
  SubscriptionRef,
  SynchronizedRef
} from 'effect'
import { SqlClient } from 'effect/sql'
import { type JobTitle, type MissingReference, sameMissingReferences } from './domain'
import type { Org } from './service'
import type { SessionTools, SessionToolsResult } from './session-tools'

/** The org's one Executive assistant session (ADR-0071). */
export interface Assistant {
  /** Records that the assistant created objective `objectiveId`, so its changes produce notices. */
  readonly claim: (objectiveId: ObjectiveId) => Effect.Effect<void>
  /** Replaces the session with a new one that has an empty transcript. */
  readonly startOver: Effect.Effect<void>
}

/**
 * What the assistant reads and drives: the org's job titles and their changes, the work it
 * reports on, the agent backend that runs its session, `tools`, which builds its routing tools
 * from the assistant's `claim`, the Host's `attach` and the working `directory` of its session,
 * which must exist. `sessionTools` resolves the Executive assistant definition's MCP servers and
 * skills; `missing` is where the assistant publishes the names it found missing, empty while it
 * can start and after its scope closes.
 */
export interface AssistantDeps {
  readonly org: Pick<Org, 'jobTitles' | 'watchJobTitleChanges'>
  readonly sessionTools: Pick<SessionTools, 'forDefinition' | 'references'>
  readonly missing: SubscriptionRef.SubscriptionRef<ReadonlyArray<MissingReference>>
  readonly pane: SubscriptionRef.SubscriptionRef<PaneId | null>
  readonly work: Pick<Issues, 'snapshot' | 'watchChanges'>
  readonly backend: AgentBackend
  readonly tools: (claim: Assistant['claim']) => ReadonlyArray<DiaTool>
  readonly attach: HostSessions['attach']
  readonly directory: string
}

type Emit = (message: OutboundMessage) => Effect.Effect<void>

type Ready = Extract<SessionToolsResult, { readonly _tag: 'Ready' }>

interface Resolved {
  readonly jobTitle: JobTitle
  readonly result: SessionToolsResult
}

interface Notice {
  readonly objectiveId: ObjectiveId
  readonly text: string
}

const LABEL = 'Executive assistant'

const noticesBetween = (
  previous: IssuesSnapshot,
  current: IssuesSnapshot,
  claimed: ReadonlySet<string>
): ReadonlyArray<Notice> => {
  const issueNotices = current.issues.flatMap((issue): ReadonlyArray<Notice> => {
    if (!claimed.has(issue.objectiveId)) return []
    const before = previous.issues.find((entry) => entry.id === issue.id)?.status
    if (before === issue.status) return []
    if (issue.status === 'triage') {
      return [{ objectiveId: issue.objectiveId, text: `"${issue.title}" needs triage.` }]
    }
    if (issue.status === 'in_review') {
      return [{ objectiveId: issue.objectiveId, text: `"${issue.title}" is in review.` }]
    }
    return []
  })
  const objectiveNotices = current.objectives.flatMap((objective): ReadonlyArray<Notice> => {
    if (!claimed.has(objective.id) || objective.state !== 'completed') return []
    const before = previous.objectives.find((entry) => entry.id === objective.id)?.state
    return before === 'completed'
      ? []
      : [{ objectiveId: objective.id, text: `Objective "${objective.title}" is completed.` }]
  })
  return [...issueNotices, ...objectiveNotices]
}

const enabledBuiltInOf = (jobTitles: ReadonlyArray<JobTitle>) =>
  Option.fromNullishOr(
    jobTitles.find((jobTitle) => jobTitle.builtIn === 'executive-assistant' && jobTitle.enabled)
  )

/**
 * Builds the org's Executive assistant inside the calling scope (ADR-0071). While the built-in
 * Executive assistant job title is enabled and its MCP servers and skills resolve, one session
 * runs in the agent overview's Assistant group and resumes the stored session after a restart;
 * disabling the job title closes it. While a name it holds resolves to nothing, the session is
 * closed and `deps.missing` lists the names; while names cannot be resolved yet, the session is
 * left as it is. `startOver` does nothing while the names do not resolve. `deps.pane` holds the
 * session's pane id while it is attached and null otherwise. The
 * assistant reports triage, review and completion of the objectives it claimed as notices in its
 * pane, and prefixes their text to the user's next message. Closing the scope ends the session.
 */
export const makeAssistant = Effect.fn('makeAssistant')(function* (deps: AssistantDeps) {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const newPaneId = crypto.randomUUIDv4().pipe(Effect.orDie)
  const claim = (objectiveId: ObjectiveId) =>
    sql`INSERT OR IGNORE INTO assistant_objectives (objective_id) VALUES (${objectiveId})`.pipe(
      Effect.orDie,
      Effect.tap(() => Effect.logDebug('Executive assistant claimed an objective', { objectiveId }))
    )
  const tools = deps.tools(claim)
  const attached = yield* SynchronizedRef.make(Option.none<Scope.Closeable>())
  const emitRef = yield* Ref.make(Option.none<Emit>())
  const pending = yield* Ref.make<ReadonlyArray<string>>([])

  yield* sql`INSERT OR IGNORE INTO assistant_session (id, pane_id, session_id)
    VALUES (1, ${yield* newPaneId}, NULL)`.pipe(Effect.orDie)

  const readSession = sql<{ readonly pane_id: string; readonly session_id: SessionId | null }>`
    SELECT pane_id, session_id FROM assistant_session WHERE id = 1`.pipe(
    Effect.orDie,
    Effect.flatMap((rows) =>
      rows[0] === undefined ? Effect.die('assistant_session has no row') : Effect.succeed(rows[0])
    )
  )

  const saveSessionId = (sessionId: string) =>
    sql`UPDATE assistant_session SET session_id = ${sessionId} WHERE id = 1`.pipe(
      Effect.orDie,
      Effect.tap(() => Effect.logDebug('Executive assistant session id saved', { sessionId }))
    )

  const modelFor = (jobTitle: JobTitle) =>
    jobTitle.model === null
      ? deps.backend.models().pipe(
          Stream.filter((state) => state._tag === 'Ready'),
          Stream.runHead,
          Effect.map(Option.map((state) => state.models[0].value)),
          Effect.flatMap(Effect.fromOption),
          Effect.orDie
        )
      : Effect.succeed(jobTitle.model)

  const withNotices = (session: AgentSession): AgentSession => ({
    ...session,
    sendText: (text, mode, attachments) =>
      Ref.getAndSet(pending, []).pipe(
        Effect.flatMap((notices) =>
          session.sendText([...notices, text].join('\n'), mode, attachments)
        )
      )
  })

  const open =
    (
      jobTitle: JobTitle,
      ready: Ready,
      config: SessionAttachment['display']['config'],
      resume: Option.Option<SessionId>
    ) =>
    (emit: Emit) =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(Ref.set(emitRef, Option.some(emit)), () =>
          Ref.set(emitRef, Option.none())
        )
        const session = yield* deps.backend.openSession({
          config,
          resume,
          emit: (message) =>
            (message._tag === 'SessionStarted'
              ? saveSessionId(message.sessionId)
              : Effect.void
            ).pipe(Effect.andThen(emit(message))),
          systemPromptAppend: jobTitle.jobDescription,
          pluginPaths: ready.pluginPaths,
          diaTools: tools,
          tools: Option.some(ready.tools)
        })
        return withNotices(session)
      })

  const attachNow = (jobTitle: JobTitle, ready: Ready, startOver: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const row = yield* readSession
      const config = {
        paneId: row.pane_id,
        cwd: deps.directory,
        model: yield* modelFor(jobTitle),
        thinkingLevel: jobTitle.thinkingLevel,
        permissionMode: 'dontAsk' as const
      }
      const resume = Option.fromNullishOr(row.session_id)
      const scope = yield* Scope.make()
      yield* deps
        .attach({
          display: { config, projectId: null, label: LABEL, caption: '' },
          resume,
          reset: Option.some(startOver),
          open: open(jobTitle, ready, config, resume)
        })
        .pipe(Scope.provide(scope))
      yield* SubscriptionRef.set(deps.pane, row.pane_id)
      yield* Effect.logInfo('Executive assistant attached', {
        paneId: row.pane_id,
        model: config.model,
        resumed: Option.isSome(resume)
      })
      return scope
    })

  const detach = (scope: Scope.Closeable) =>
    Scope.close(scope, Exit.void).pipe(
      Effect.tap(() => Effect.logInfo('Executive assistant detached'))
    )

  const resolveEnabled: Effect.Effect<Option.Option<Resolved>> = Effect.gen(function* () {
    const jobTitle = enabledBuiltInOf(yield* deps.org.jobTitles)
    if (Option.isNone(jobTitle)) return Option.none()
    const result = yield* deps.sessionTools.forDefinition(jobTitle.value, deps.directory)
    return Option.some({ jobTitle: jobTitle.value, result })
  })

  const setMissing = (missing: ReadonlyArray<MissingReference>) =>
    SubscriptionRef.getAndSet(deps.missing, missing).pipe(
      Effect.tap((before) =>
        missing.length > 0 && !sameMissingReferences(before, missing)
          ? Effect.logWarning('Executive assistant cannot start: names are missing', { missing })
          : Effect.void
      )
    )

  const startOver: Effect.Effect<void> = Effect.gen(function* () {
    const resolved = yield* resolveEnabled
    const ready = Option.flatMap(resolved, ({ jobTitle, result }) =>
      result._tag === 'Ready' ? Option.some({ jobTitle, result }) : Option.none()
    )
    if (Option.isSome(resolved) && Option.isNone(ready)) {
      yield* Effect.logInfo('Executive assistant cannot start over now', {
        result: resolved.value.result._tag
      })
      return
    }
    yield* SynchronizedRef.updateEffect(attached, (current) =>
      Effect.gen(function* () {
        yield* Ref.set(pending, [])
        const paneId = yield* newPaneId
        yield* sql`UPDATE assistant_session SET pane_id = ${paneId}, session_id = NULL WHERE id = 1`.pipe(
          Effect.orDie
        )
        yield* Effect.logInfo('Executive assistant starts over', { paneId })
        if (Option.isNone(current)) return current
        yield* detach(current.value)
        if (Option.isSome(ready)) {
          return Option.some(yield* attachNow(ready.value.jobTitle, ready.value.result, startOver))
        }
        yield* SubscriptionRef.set(deps.pane, null)
        return Option.none()
      }).pipe(Effect.uninterruptible)
    )
  })

  const follow = Effect.gen(function* () {
    const resolved = yield* resolveEnabled
    yield* SynchronizedRef.updateEffect(attached, (current) =>
      Effect.gen(function* () {
        if (Option.isNone(resolved)) {
          yield* setMissing([])
          if (Option.isSome(current)) yield* detach(current.value)
          yield* SubscriptionRef.set(deps.pane, null)
          return Option.none()
        }
        const { jobTitle, result } = resolved.value
        switch (result._tag) {
          case 'Ready':
            yield* setMissing([])
            return Option.isNone(current)
              ? Option.some(yield* attachNow(jobTitle, result, startOver))
              : current
          case 'Missing':
            yield* setMissing(result.missing)
            if (Option.isSome(current)) yield* detach(current.value)
            yield* SubscriptionRef.set(deps.pane, null)
            return Option.none()
          case 'Unavailable':
            yield* Effect.logDebug('Executive assistant waits for its session tools to resolve')
            return current
        }
      })
    )
  })

  const claimed = sql<{ readonly objective_id: string }>`
    SELECT objective_id FROM assistant_objectives`.pipe(
    Effect.orDie,
    Effect.map((rows) => new Set(rows.map((row) => row.objective_id)))
  )

  const deliver = (notice: Notice) =>
    Effect.gen(function* () {
      const emit = yield* Ref.get(emitRef)
      if (Option.isNone(emit)) return
      yield* Ref.update(pending, (texts) => [...texts, notice.text])
      yield* emit.value(
        SessionNotice.make({
          text: notice.text,
          link: { label: 'Open', plugin: 'issues', page: 'issues', target: notice.objectiveId }
        })
      )
      yield* Effect.logInfo('Executive assistant notice', { objectiveId: notice.objectiveId })
    })

  const jobTitleChanges = yield* deps.org.watchJobTitleChanges
  const workChanges = yield* deps.work.watchChanges
  const previous = yield* Ref.make(yield* deps.work.snapshot)

  yield* Effect.addFinalizer(() =>
    SynchronizedRef.get(attached).pipe(
      Effect.flatMap((current) => (Option.isSome(current) ? detach(current.value) : Effect.void)),
      Effect.andThen(SubscriptionRef.set(deps.missing, [])),
      Effect.andThen(SubscriptionRef.set(deps.pane, null))
    )
  )
  yield* follow.pipe(
    Effect.andThen(
      Stream.merge(jobTitleChanges, deps.sessionTools.references(deps.directory)).pipe(
        Stream.runForEach(() => follow)
      )
    ),
    Effect.forkScoped
  )
  yield* workChanges.pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const current = yield* deps.work.snapshot
        const before = yield* Ref.getAndSet(previous, current)
        yield* Effect.forEach(noticesBetween(before, current, yield* claimed), deliver, {
          discard: true
        })
      })
    ),
    Effect.forkScoped
  )

  return {
    claim,
    startOver
  } satisfies Assistant
})
