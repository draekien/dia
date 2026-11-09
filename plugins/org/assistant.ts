import {
  type AgentBackend,
  type AgentSession,
  type DiaTool,
  type HostSessions,
  type OutboundMessage,
  type SessionAttachment,
  type SessionId,
  SessionNotice
} from '@dia/plugin'
import { Crypto, Effect, Exit, Option, Ref, Scope, Stream, SynchronizedRef } from 'effect'
import { SqlClient } from 'effect/sql'
import type { JobTitle, ObjectiveId, WorkSnapshot } from './domain'
import type { Org } from './service'
import type { Work } from './work'

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
 * which must exist.
 */
export interface AssistantDeps {
  readonly org: Pick<Org, 'jobTitles' | 'watchJobTitleChanges'>
  readonly work: Pick<Work, 'snapshot' | 'watchChanges'>
  readonly backend: AgentBackend
  readonly tools: (claim: Assistant['claim']) => ReadonlyArray<DiaTool>
  readonly attach: HostSessions['attach']
  readonly directory: string
}

type Emit = (message: OutboundMessage) => Effect.Effect<void>

interface Notice {
  readonly objectiveId: ObjectiveId
  readonly text: string
}

const LABEL = 'Executive assistant'

const noticesBetween = (
  previous: WorkSnapshot,
  current: WorkSnapshot,
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
 * Executive assistant job title is enabled, one session runs in the agent overview's Assistant
 * group and resumes the stored session after a restart; disabling the job title closes it. The
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
          pluginPaths: [],
          diaTools: tools,
          tools: Option.some({
            permissions: jobTitle.permissions,
            mcpServers: jobTitle.mcpServers,
            skills: jobTitle.skills
          })
        })
        return withNotices(session)
      })

  const attachNow = (jobTitle: JobTitle, startOver: Effect.Effect<void>) =>
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
          open: open(jobTitle, config, resume)
        })
        .pipe(Scope.provide(scope))
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

  const startOver: Effect.Effect<void> = SynchronizedRef.updateEffect(attached, (current) =>
    Effect.gen(function* () {
      yield* Ref.set(pending, [])
      const paneId = yield* newPaneId
      yield* sql`UPDATE assistant_session SET pane_id = ${paneId}, session_id = NULL WHERE id = 1`.pipe(
        Effect.orDie
      )
      yield* Effect.logInfo('Executive assistant starts over', { paneId })
      if (Option.isNone(current)) return current
      yield* detach(current.value)
      const jobTitle = enabledBuiltInOf(yield* deps.org.jobTitles)
      return Option.isSome(jobTitle)
        ? Option.some(yield* attachNow(jobTitle.value, startOver))
        : Option.none()
    }).pipe(Effect.uninterruptible)
  )

  const followJobTitle = SynchronizedRef.updateEffect(attached, (current) =>
    Effect.gen(function* () {
      const jobTitle = enabledBuiltInOf(yield* deps.org.jobTitles)
      if (Option.isSome(jobTitle) && Option.isNone(current)) {
        return Option.some(yield* attachNow(jobTitle.value, startOver))
      }
      if (Option.isNone(jobTitle) && Option.isSome(current)) {
        yield* detach(current.value)
        return Option.none()
      }
      return current
    })
  )

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
          link: { label: 'Open', plugin: 'org', page: 'org', target: notice.objectiveId }
        })
      )
      yield* Effect.logInfo('Executive assistant notice', { objectiveId: notice.objectiveId })
    })

  const jobTitleChanges = yield* deps.org.watchJobTitleChanges
  const workChanges = yield* deps.work.watchChanges
  const previous = yield* Ref.make(yield* deps.work.snapshot)

  yield* Effect.addFinalizer(() =>
    SynchronizedRef.get(attached).pipe(
      Effect.flatMap((current) => (Option.isSome(current) ? detach(current.value) : Effect.void))
    )
  )
  yield* followJobTitle.pipe(
    Effect.andThen(jobTitleChanges.pipe(Stream.runForEach(() => followJobTitle))),
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
