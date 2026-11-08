import { scheduleTask } from '@effect/atom-react'
import type { AgentSummary } from '@shared/domain/agent-summary'
import type { AttachedSession } from '@shared/domain/attached-session'
import type { PaneId } from '@shared/domain/pane'
import type { Workspace } from '@shared/domain/project'
import { DEFAULT_TRANSCRIPT_WIDTH, type TranscriptWidth } from '@shared/domain/transcript-width'
import { Effect, Option, Queue, Ref, Stream, SubscriptionRef } from 'effect'
import { AsyncResult, Atom, AtomRegistry } from 'effect/reactivity'
import {
  closesNewAgentForm,
  closesOpenPage,
  type NewAgentForm,
  type OpenAttached,
  type OpenPage,
  type View,
  viewOf
} from './view'

/**
 * The atom registry the whole renderer shares. `main.tsx` provides it to React through
 * `RegistryContext`; code outside React (plugin actions) reads and writes atoms through it.
 */
export const appRegistry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 })

const fromListener = <A>(listen: (push: (value: A) => void) => () => void): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => listen((value) => Queue.offerUnsafe(queue, value))),
      (unsubscribe) => Effect.sync(unsubscribe)
    )
  )

/**
 * The open New agent form, or `None`. Set it to open or close the form; it also closes when the
 * workspace shows a tab other than the one visible when it opened.
 */
export const newAgentFormAtom = Atom.make<Option.Option<NewAgentForm>>(Option.none()).pipe(
  Atom.keepAlive
)

/**
 * The open page, or `None`. Set it through `actions.openPage`; it also closes when the workspace
 * shows a tab other than the one visible before it opened, or when its plugin removes the page.
 */
export const openPageAtom = Atom.make<Option.Option<OpenPage>>(Option.none()).pipe(Atom.keepAlive)

/**
 * The open attached session (ADR-0070), or `None`. Set it through `actions.selectAttached`; it
 * also closes when the workspace shows a tab other than the one visible before it opened, and
 * when its session is detached, which shows that tab again.
 */
export const openAttachedAtom = Atom.make<Option.Option<OpenAttached>>(Option.none()).pipe(
  Atom.keepAlive
)

const resumeVisibleTab = (workspace: Option.Option<Workspace>) =>
  Effect.gen(function* () {
    if (Option.isNone(workspace) || workspace.value.visibleTab === null) return
    const paneId = workspace.value.visibleTab
    yield* Effect.logDebug('Resuming the visible tab', { paneId })
    window.dia.selectTab(paneId)
  })

const loadedWorkspaceAtom = Atom.subscriptionRef((get) =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(Option.none<Workspace>())
    yield* fromListener<Workspace>((push) =>
      window.dia.onWorkspaceChanged((event) => push(event.workspace))
    ).pipe(
      Stream.runForEach((workspace) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(ref, Option.some(workspace))
          const form = get.registry.get(newAgentFormAtom)
          if (Option.isSome(form) && closesNewAgentForm(form.value, workspace)) {
            get.registry.set(newAgentFormAtom, Option.none())
          }
          const page = get.registry.get(openPageAtom)
          if (Option.isSome(page) && closesOpenPage(page.value, workspace)) {
            yield* Effect.logDebug('The workspace showed a tab, closing the open page')
            get.registry.set(openPageAtom, Option.none())
          }
          const attached = get.registry.get(openAttachedAtom)
          if (Option.isSome(attached) && closesOpenPage(attached.value, workspace)) {
            yield* Effect.logDebug('The workspace showed a tab, closing the attached session')
            get.registry.set(openAttachedAtom, Option.none())
          }
        })
      ),
      Effect.forkScoped
    )
    yield* fromListener<void>((push) => window.dia.onAgentSummariesReplaced(() => push())).pipe(
      Stream.runForEach(() => SubscriptionRef.get(ref).pipe(Effect.flatMap(resumeVisibleTab))),
      Effect.forkScoped
    )
    const fetched = yield* Effect.promise(() => window.dia.getWorkspace())
    const current = yield* SubscriptionRef.updateAndGet(ref, (existing) =>
      Option.isSome(existing) ? existing : Option.some(fetched)
    )
    yield* Effect.logInfo('Loaded the workspace', { projects: fetched.projects.length })
    yield* resumeVisibleTab(current)
    return ref
  })
).pipe(Atom.keepAlive)

/**
 * The workspace: projects in order, their tabs and the visible tab. `None` until it first loads;
 * then it follows every `WorkspaceChanged`. Read with `useAtomValue(workspaceAtom)`.
 */
export const workspaceAtom = Atom.make(
  (get): Option.Option<Workspace> =>
    AsyncResult.getOrElse(get(loadedWorkspaceAtom), () => Option.none<Workspace>())
).pipe(Atom.keepAlive)

const closeDetached = (
  registry: AtomRegistry.AtomRegistry,
  sessions: ReadonlyArray<AttachedSession>
) =>
  Effect.gen(function* () {
    const open = registry.get(openAttachedAtom)
    if (Option.isNone(open)) return
    if (sessions.some((session) => session.config.paneId === open.value.paneId)) return
    yield* Effect.logDebug('The open attached session was detached', {
      paneId: open.value.paneId
    })
    registry.set(openAttachedAtom, Option.none())
    if (open.value.shownBefore !== null) window.dia.selectTab(open.value.shownBefore)
  })

const loadedAttachedSessionsAtom = Atom.subscriptionRef((get) =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<ReadonlyArray<AttachedSession>>([])
    const pushed = yield* Ref.make(false)
    yield* fromListener<ReadonlyArray<AttachedSession>>((push) =>
      window.dia.onAttachedSessionsChanged((event) => push(event.sessions))
    ).pipe(
      Stream.runForEach((sessions) =>
        Ref.set(pushed, true).pipe(
          Effect.andThen(SubscriptionRef.set(ref, sessions)),
          Effect.andThen(closeDetached(get.registry, sessions))
        )
      ),
      Effect.forkScoped
    )
    const fetched = yield* Effect.promise(() => window.dia.getAttachedSessions())
    if (!(yield* Ref.get(pushed))) yield* SubscriptionRef.set(ref, fetched)
    yield* Effect.logDebug('Loaded attached sessions', { count: fetched.length })
    return ref
  })
).pipe(Atom.keepAlive)

/**
 * Every session a plugin has attached (ADR-0070); empty until it first loads. Read with
 * `useAtomValue(attachedSessionsAtom)`.
 */
export const attachedSessionsAtom = Atom.make(
  (get): ReadonlyArray<AttachedSession> =>
    AsyncResult.getOrElse(get(loadedAttachedSessionsAtom), () => [])
).pipe(Atom.keepAlive)

const loadedSummariesAtom = Atom.subscriptionRef(
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<ReadonlyMap<PaneId, AgentSummary>>(new Map())
    yield* fromListener<AgentSummary>((push) =>
      window.dia.onAgentSummaryChanged((event) => push(event.summary))
    ).pipe(
      Stream.runForEach((summary) =>
        SubscriptionRef.update(ref, (summaries) => new Map(summaries).set(summary.paneId, summary))
      ),
      Effect.forkScoped
    )
    yield* fromListener<ReadonlyArray<AgentSummary>>((push) =>
      window.dia.onAgentSummariesReplaced((event) => push(event.summaries))
    ).pipe(
      Stream.runForEach((summaries) =>
        SubscriptionRef.set(ref, new Map(summaries.map((summary) => [summary.paneId, summary])))
      ),
      Effect.forkScoped
    )
    const fetched = yield* Effect.promise(() => window.dia.getAgentSummaries())
    yield* SubscriptionRef.update(ref, (summaries) => {
      const merged = new Map(summaries)
      for (const summary of fetched) {
        if (!merged.has(summary.paneId)) merged.set(summary.paneId, summary)
      }
      return merged
    })
    yield* Effect.logDebug('Loaded agent summaries', { count: fetched.length })
    return ref
  })
).pipe(Atom.keepAlive)

/**
 * The current {@link AgentSummary} of every tab, keyed by pane id; empty until it first loads.
 * Read with `useAtomValue(agentSummariesAtom)`.
 */
export const agentSummariesAtom = Atom.make(
  (get): ReadonlyMap<PaneId, AgentSummary> =>
    AsyncResult.getOrElse(get(loadedSummariesAtom), () => new Map<PaneId, AgentSummary>())
).pipe(Atom.keepAlive)

const storedTranscriptWidthAtom = Atom.make(
  Effect.promise(() => window.dia.getTranscriptWidth()).pipe(
    Effect.tap((width) => Effect.logDebug('Loaded the transcript width', { width }))
  )
).pipe(Atom.keepAlive)

const chosenTranscriptWidthAtom = Atom.make<TranscriptWidth | null>(null).pipe(Atom.keepAlive)

/**
 * The app-wide maximum width of the transcript column. Reads `'default'` until the persisted
 * choice loads. Set it to change and persist the width.
 */
export const transcriptWidthAtom = Atom.writable(
  (get): TranscriptWidth =>
    get(chosenTranscriptWidthAtom) ??
    AsyncResult.getOrElse(get(storedTranscriptWidthAtom), () => DEFAULT_TRANSCRIPT_WIDTH),
  (ctx, width: TranscriptWidth) => {
    ctx.set(chosenTranscriptWidthAtom, width)
    window.dia.setTranscriptWidth(width)
  }
).pipe(Atom.keepAlive)

/** What the content area shows; `undefined` until the workspace loads. See {@link viewOf}. */
export const viewAtom = Atom.make((get): View | undefined =>
  viewOf(
    get(workspaceAtom),
    get(newAgentFormAtom),
    get(openPageAtom),
    get(openAttachedAtom),
    get(attachedSessionsAtom)
  )
).pipe(Atom.keepAlive)
