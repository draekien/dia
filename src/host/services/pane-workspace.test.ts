import { NodeCrypto, NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS } from '@shared/domain/agent-name'
import { type PaneConfig, SessionId, WorktreeKept, WorktreeReleased } from '@shared/domain/pane'
import {
  AgentName,
  type CreateTabRequest,
  type Project,
  ProjectId,
  type Tab,
  type Workspace,
  WorktreeNotRemovedError,
  WorktreeNotRestoredError
} from '@shared/domain/project'
import type { RemovalProgress } from '@shared/domain/project-removal'
import type { IpcEvent } from '@shared/ipc/contract'
import type { ServiceKey } from '@shared/plugin/api'
import type { PathsMoved } from '@shared/plugin/paths-moved'
import { type PluginRegistry, ServiceWithdrawnError } from '@shared/plugin/plugin-registry'
import { fakeInject, fakeUse } from '@shared/plugin/plugin-registry.fake'
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Queue,
  Result,
  Stream,
  SubscriptionRef
} from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { EventHub } from './event-hub'
import { PaneWorkspace, PaneWorkspaceLive } from './pane-workspace'
import { PathMoves } from './path-moves'
import { RunEventLog } from './run-event-log'
import { type AppendEntry, RunEventWriteError } from './run-events-seam'
import { RunsClient } from './runs-client'
import {
  type DiscoveredSession,
  type RunChange,
  RunSessionChanged,
  type RunSpec,
  RunTabRequested
} from './runs-seam'
import { WorkspaceFeed, WorkspaceFeedLive } from './workspace-feed'
import { type WorkspaceLoadError, WorkspaceStore, WorkspaceWriteError } from './workspace-store'
import {
  type GitOps,
  WorktreeCreateError,
  WorktreeReattachError,
  WorktreesKey
} from './worktrees-seam'

const PANE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const PANE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PANE_NEW = 'cccccccc-0000-4000-8000-000000000003'
const PROJECT_1 = ProjectId.make('11111111-0000-4000-8000-000000000001')
const PROJECT_2 = ProjectId.make('22222222-0000-4000-8000-000000000002')

interface Harness {
  readonly log: Array<string>
  readonly saves: Array<Workspace>
  readonly published: Array<IpcEvent>
  readonly requests: Array<RunSpec>
  readonly existing: Set<string>
  readonly emit: (change: RunChange) => Effect.Effect<void>
  readonly layer: Layer.Layer<PaneWorkspace | WorkspaceFeed, WorkspaceLoadError>
}

interface HarnessOptions {
  readonly persisted?: Workspace
  readonly directories?: ReadonlyArray<string>
  readonly files?: ReadonlyArray<string>
  readonly openRun?: (
    spec: RunSpec,
    emit: (change: RunChange) => Effect.Effect<void>
  ) => Effect.Effect<PaneConfig, WorktreeCreateError | WorktreeReattachError>
  readonly live?: ReadonlySet<string>
  readonly closeRun?: (runId: string) => Effect.Effect<void>
  readonly retireRun?: (runId: string) => Effect.Effect<void>
  readonly gitOps?: (existing: Set<string>) => GitOps
  readonly discovered?: ReadonlyArray<DiscoveredSession>
  readonly storedSessionIds?: ReadonlyArray<string>
  readonly unloadedDirectoryKeys?: ReadonlyArray<string>
  readonly failEventAppend?: boolean
  readonly worktreesWithdrawn?: boolean
  readonly movedFolders?: ReadonlyArray<PathsMoved>
}

const withdrawn = new ServiceWithdrawnError({
  key: WorktreesKey.name,
  plugin: 'worktrees',
  message: 'The "worktrees" plugin closed while a call using "worktrees" was running'
})

const configOf = (spec: RunSpec): PaneConfig => ({
  paneId: spec.runId,
  cwd: spec.sourceCwd,
  model: spec.model,
  thinkingLevel: spec.thinkingLevel,
  permissionMode: spec.permissionMode
})

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const log: Array<string> = []
  const saves: Array<Workspace> = []
  const published: Array<IpcEvent> = []
  const requests: Array<RunSpec> = []
  const existing = new Set([...(options.directories ?? []), ...(options.files ?? [])])
  const directories = new Set(options.directories ?? [])

  const changes = Effect.runSync(Queue.unbounded<RunChange>())
  const emit = (change: RunChange) =>
    Queue.offer(changes, change).pipe(
      Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 20 })),
      Effect.asVoid
    )

  const runs = Layer.succeed(RunsClient, {
    open: (spec) => {
      requests.push(spec)
      return options.openRun === undefined
        ? Effect.succeed(configOf(spec))
        : options.openRun(spec, emit)
    },
    close: (runId) =>
      Effect.sync(() => log.push(`close ${runId}`)).pipe(
        Effect.andThen(options.closeRun?.(runId) ?? Effect.void)
      ),
    retire: (runId, as) =>
      Effect.sync(() => log.push(`retire ${runId} ${as}`)).pipe(
        Effect.andThen(options.retireRun?.(runId) ?? Effect.void)
      ),
    isLive: (runId) => Effect.succeed(options.live?.has(runId) === true),
    setThinkingLevel: () => Effect.void,
    setPermissionMode: () => Effect.void,
    setModel: () => Effect.void,
    changes: Stream.fromQueue(changes),
    discoverSessions: (directory) =>
      Effect.sync(() => {
        log.push(`discoverSessions ${directory}`)
        return options.discovered ?? []
      })
  })

  const store = Layer.succeed(WorkspaceStore, {
    load: Effect.succeed(Option.fromNullishOr(options.persisted)),
    save: (workspace) =>
      workspace.projects.some((entry) =>
        options.unloadedDirectoryKeys?.includes(entry.project.directoryKey)
      )
        ? Effect.fail(new WorkspaceWriteError({ cause: 'UNIQUE constraint failed' }))
        : Effect.sync(() => void saves.push(workspace)),
    directoryKeys: Effect.succeed(new Set(options.unloadedDirectoryKeys)),
    sessionIds: Effect.succeed(
      new Set((options.storedSessionIds ?? []).map((id) => SessionId.make(id)))
    ),
    unreadable: Effect.succeed([]),
    deleteUnreadable: () => Effect.void,
    holders: Effect.succeed({ sessions: new Map(), worktrees: new Map() }),
    resolvedImports: Effect.succeed(new Set<string>()),
    recordImportResolution: () => Effect.void
  })

  const hub = Layer.succeed(EventHub, {
    publish: (event) =>
      Effect.sync(() => {
        published.push(event)
        log.push(`publish ${event._tag}`)
      }),
    subscribe: () => Stream.empty
  })

  const provided = new Map<string, unknown>()
  if (options.gitOps !== undefined) provided.set(WorktreesKey.name, options.gitOps(existing))
  const read = (key: string) => Option.fromNullishOr(provided.get(key))
  const provideUse = fakeUse(read)
  const plugins = Layer.succeed(HostPlugins, {
    inject: fakeInject(read),
    use: (key: ServiceKey<unknown>, f: (value: unknown) => Effect.Effect<unknown>) =>
      options.worktreesWithdrawn === true && key === WorktreesKey
        ? Effect.fail(withdrawn)
        : provideUse(key, f)
  } as unknown as PluginRegistry)

  const runEvents = Layer.succeed(RunEventLog, {
    append: (runId: string, entries: ReadonlyArray<AppendEntry>) =>
      options.failEventAppend === true
        ? Effect.fail(new RunEventWriteError({ cause: 'disk full' }))
        : Effect.sync(() => {
            for (const entry of entries) log.push(`append ${runId} ${entry.event._tag}`)
            return entries.map(() => Option.some(1))
          }),
    release: () => Effect.void
  } as unknown as RunEventLog['Service'])

  const notFound = (path: string) =>
    PlatformError.systemError({
      _tag: 'NotFound',
      module: 'FileSystem',
      method: 'stat',
      pathOrDescriptor: path
    })
  const slashes = (path: string) => path.replace(/\\/g, '/')
  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(existing.has(slashes(path))),
    stat: (path) =>
      directories.has(slashes(path))
        ? Effect.succeed({ type: 'Directory' } as FileSystem.File.Info)
        : Effect.fail(notFound(path))
  })

  const pathMoves = Layer.succeed(PathMoves, {
    hasRun: () => Effect.succeed(false),
    recordRun: () => Effect.void,
    recordMove: () => Effect.void,
    subscribe: (_owner, handle) =>
      Effect.forEach(options.movedFolders ?? [], handle, { discard: true }).pipe(Effect.orDie)
  })

  const layer = Layer.provide(
    PaneWorkspaceLive,
    Layer.mergeAll(
      runs,
      pathMoves,
      store,
      hub,
      plugins,
      runEvents,
      fs,
      NodePath.layer,
      NodeCrypto.layer
    )
  ).pipe(Layer.provideMerge(WorkspaceFeedLive))
  return { log, saves, published, requests, existing, emit, layer }
}

const project = (projectId: ProjectId, directory: string, isGitRepo = true): Project => ({
  projectId,
  directory,
  directoryKey: directory.toLowerCase(),
  displayName: directory,
  isGitRepo
})

const tab = (paneId: string, cwd: string, extra: Partial<Tab> = {}): Tab => ({
  name: AgentName.make(`agent-${paneId.slice(0, 4)}`),
  config: { paneId, cwd, model: 'm', thinkingLevel: 'adaptive', permissionMode: 'default' },
  archived: false,
  ...extra
})

const twoProjects = (visible: string | undefined = PANE_A): Workspace => ({
  projects: [
    { project: project(PROJECT_1, '/repo'), tabs: [tab(PANE_A, '/repo')] },
    { project: project(PROJECT_2, '/other'), tabs: [tab(PANE_B, '/other')] }
  ],
  visibleTab: visible ?? null
})

const request = (overrides: Partial<CreateTabRequest> = {}): CreateTabRequest => ({
  projectId: PROJECT_1,
  paneId: PANE_NEW,
  name: AgentName.make('heron'),
  model: 'claude-sonnet-5-5',
  thinkingLevel: 'adaptive',
  permissionMode: 'default',
  useWorktree: false,
  ...overrides
})

const ignore = (_event: IpcEvent): Effect.Effect<void> => Effect.void

const run = <A, E>(harness: Harness, body: Effect.Effect<A, E, PaneWorkspace | WorkspaceFeed>) =>
  body.pipe(Effect.provide(harness.layer))

const current = Effect.flatMap(PaneWorkspace, (workspace) => workspace.getWorkspace)

const tabsOf = (workspace: Workspace) =>
  workspace.projects.flatMap((entry) => entry.tabs.map((t) => t.config.paneId))

const resolvedKey = Effect.fnUntraced(function* (directory: string) {
  const path = yield* Path.Path
  const resolved = path.resolve(directory)
  return path.sep === '\\' ? resolved.toLowerCase() : resolved
})

describe('PaneWorkspace loading', () => {
  it.effect('starts with no projects when nothing is persisted', () =>
    Effect.gen(function* () {
      const workspace = yield* run(makeHarness(), current)

      assert.deepStrictEqual(workspace.projects, [])
      assert.isNull(workspace.visibleTab)
    })
  )

  it.effect(
    'shows the first tab of a persisted workspace with no visible tab, without starting it',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ persisted: twoProjects(undefined) })

        const workspace = yield* run(harness, current)

        assert.deepStrictEqual(workspace.visibleTab, PANE_A)
        assert.strictEqual(harness.requests.length, 0)
      })
  )
})

describe('PaneWorkspace moved folders', () => {
  const move = { from: '/data/plugins/worktrees', to: '/data/plugins/dia-worktrees' }
  const worktreeTab = tab(PANE_A, '/data/plugins/worktrees/trees/heron', {
    config: {
      paneId: PANE_A,
      cwd: '/data/plugins/worktrees/trees/heron',
      model: 'm',
      thinkingLevel: 'adaptive',
      permissionMode: 'default',
      worktree: {
        path: '/data/plugins/worktrees/trees/heron',
        branch: 'dia/heron',
        sourceRepo: '/repo'
      }
    }
  })
  const moved: Workspace = {
    projects: [
      { project: project(PROJECT_1, '/repo'), tabs: [worktreeTab] },
      { project: project(PROJECT_2, '/other'), tabs: [tab(PANE_B, '/other')] }
    ],
    visibleTab: PANE_A
  }

  it.effect('points a tab under a moved folder at the new folder', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: moved, movedFolders: [move] })

      const workspace = yield* run(harness, current)

      const config = workspace.projects[0]?.tabs[0]?.config
      assert.strictEqual(config?.cwd, '/data/plugins/dia-worktrees/trees/heron')
      assert.strictEqual(config?.worktree?.path, '/data/plugins/dia-worktrees/trees/heron')
      assert.strictEqual(config?.worktree?.sourceRepo, '/repo')
    })
  )

  it.effect('saves the moved paths', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: moved, movedFolders: [move] })

      yield* run(harness, current)

      assert.strictEqual(
        harness.saves.at(-1)?.projects[0]?.tabs[0]?.config.cwd,
        '/data/plugins/dia-worktrees/trees/heron'
      )
    })
  )

  it.effect('leaves tabs outside the moved folder and saves nothing when none moved', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects(), movedFolders: [move] })

      const workspace = yield* run(harness, current)

      assert.deepStrictEqual(workspace, twoProjects())
      assert.strictEqual(harness.saves.length, 0)
    })
  )
})

describe('PaneWorkspace workspace feed', () => {
  it.effect('holds the loaded workspace, then each change', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects(undefined) })

      const [loaded, changed] = yield* run(
        harness,
        Effect.gen(function* () {
          const feed = yield* WorkspaceFeed
          const before = yield* SubscriptionRef.get(feed)
          yield* (yield* PaneWorkspace).selectTab(PANE_B, ignore)
          return [before, yield* SubscriptionRef.get(feed)] as const
        })
      )

      assert.deepStrictEqual(loaded.visibleTab, PANE_A)
      assert.deepStrictEqual(changed.visibleTab, PANE_B)
    })
  )
})

describe('PaneWorkspace.registerProject', () => {
  it.effect('adds the project, saves it and publishes WorkspaceChanged before returning', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ directories: ['/repo'], files: ['/repo/.git'] })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).registerProject(PROJECT_1, '/repo')
          return yield* current
        })
      )

      assert.strictEqual(workspace.projects[0].project.directory, '/repo')
      assert.strictEqual(harness.saves.at(-1), workspace)
      assert.deepStrictEqual(harness.published.at(-1), { _tag: 'WorkspaceChanged', workspace })
    })
  )

  it.effect('records whether the directory is a git repo', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ directories: ['/repo', '/plain'], files: ['/repo/.git'] })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          yield* service.registerProject(PROJECT_1, '/repo')
          yield* service.registerProject(PROJECT_2, '/plain')
          return yield* current
        })
      )

      assert.deepStrictEqual(
        workspace.projects.map((entry) => entry.project.isGitRepo),
        [true, false]
      )
    })
  )

  it.effect('refuses a directory another project registered under another spelling', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ directories: ['/repo', '/repo/'] })

      const error = yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          yield* service.registerProject(PROJECT_1, '/repo')
          return yield* Effect.flip(service.registerProject(PROJECT_2, '/repo/'))
        })
      )

      assert.strictEqual(error._tag, 'ProjectAlreadyRegisteredError')
    })
  )

  it.effect('succeeds without a change when the same project is registered again', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ directories: ['/repo'] })

      yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          yield* service.registerProject(PROJECT_1, '/repo')
          yield* service.registerProject(PROJECT_1, '/repo')
        })
      )

      assert.strictEqual(harness.saves.length, 1)
    })
  )

  it.effect('refuses a path that is not an existing directory', () =>
    Effect.gen(function* () {
      const error = yield* run(
        makeHarness(),
        Effect.flatMap(PaneWorkspace, (service) =>
          Effect.flip(service.registerProject(PROJECT_1, '/missing'))
        )
      )

      assert.strictEqual(error._tag, 'DirectoryNotFoundError')
    })
  )

  it.effect('stores the comparison key of the directory', () =>
    Effect.gen(function* () {
      const workspace = yield* run(
        makeHarness({ directories: ['/Repo'] }),
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).registerProject(PROJECT_1, '/Repo')
          return yield* current
        })
      )

      assert.strictEqual(workspace.projects[0].project.directoryKey, yield* resolvedKey('/Repo'))
    }).pipe(Effect.provide(NodePath.layer))
  )

  it.effect(
    'refuses a directory a stored project it could not load has, and later saves succeed',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          directories: ['/held', '/repo'],
          unloadedDirectoryKeys: [yield* resolvedKey('/held')]
        })

        const [error, workspace] = yield* run(
          harness,
          Effect.gen(function* () {
            const service = yield* PaneWorkspace
            const refused = yield* Effect.flip(service.registerProject(PROJECT_1, '/held'))
            yield* service.registerProject(PROJECT_2, '/repo')
            return [refused, yield* current] as const
          })
        )

        assert.strictEqual(error._tag, 'StoredProjectUnreadableError')
        assert.deepStrictEqual(
          workspace.projects.map((entry) => entry.project.projectId),
          [PROJECT_2]
        )
        assert.strictEqual(harness.saves.at(-1), workspace)
      }).pipe(Effect.provide(NodePath.layer))
  )
})

describe('PaneWorkspace.importTab', () => {
  const PROJECT_3 = ProjectId.make('33333333-0000-4000-8000-000000000003')

  it.effect('adds the tab to the project with its directory key and keeps the visible tab', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects() })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).importTab(
            { ...project(PROJECT_3, '/OTHER'), directoryKey: '/other' },
            tab(PANE_NEW, '/other')
          )
          return yield* current
        })
      )

      assert.deepStrictEqual(
        [workspace.projects.map((entry) => entry.tabs.length), workspace.visibleTab],
        [[1, 2], PANE_A]
      )
      assert.strictEqual(workspace.projects[1].tabs[1].config.paneId, PANE_NEW)
      assert.strictEqual(harness.saves.at(-1), workspace)
    })
  )

  it.effect('registers the project with the tab when no project has its directory', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects() })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).importTab(
            project(PROJECT_3, '/gone'),
            tab(PANE_NEW, '/gone')
          )
          return yield* current
        })
      )

      assert.deepStrictEqual(workspace.projects[2], {
        project: project(PROJECT_3, '/gone'),
        tabs: [tab(PANE_NEW, '/gone')]
      })
      assert.strictEqual(workspace.visibleTab, PANE_A)
    })
  )

  it.effect('leaves the workspace unchanged for a pane id it already has', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects() })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).importTab(project(PROJECT_1, '/repo'), tab(PANE_B, '/repo'))
          return yield* current
        })
      )

      assert.deepStrictEqual(tabsOf(workspace), [PANE_A, PANE_B])
    })
  )

  it.effect(
    'refuses a directory a stored project it could not load has, and later saves succeed',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ persisted: twoProjects(), unloadedDirectoryKeys: ['/held'] })

        const [error, workspace] = yield* run(
          harness,
          Effect.gen(function* () {
            const service = yield* PaneWorkspace
            const refused = yield* Effect.flip(
              service.importTab(project(PROJECT_3, '/held'), tab(PANE_NEW, '/held'))
            )
            yield* service.importTab(project(PROJECT_3, '/gone'), tab(PANE_NEW, '/gone'))
            return [refused, yield* current] as const
          })
        )

        assert.strictEqual(error._tag, 'StoredProjectUnreadableError')
        assert.deepStrictEqual(tabsOf(workspace), [PANE_A, PANE_B, PANE_NEW])
        assert.strictEqual(harness.saves.at(-1), workspace)
      })
  )
})

describe('PaneWorkspace.registerProject importing discovered sessions', () => {
  const discovered = (sessionId: string, title: string, startedAt: number): DiscoveredSession => ({
    sessionId: SessionId.make(sessionId),
    title,
    startedAt,
    model: 'adapter-model'
  })

  const register = (harness: Harness) =>
    run(
      harness,
      Effect.gen(function* () {
        yield* (yield* PaneWorkspace).registerProject(PROJECT_2, '/other')
        return yield* current
      })
    )

  it.effect('imports each discovered session as a tab of the project, oldest first', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        directories: ['/other'],
        discovered: [discovered('s-new', 'Newer chat', 200), discovered('s-old', 'Older chat', 100)]
      })

      const workspace = yield* register(harness)

      const tabs = workspace.projects[0].tabs
      assert.deepStrictEqual(
        tabs.map((t): ReadonlyArray<string | undefined> => [t.sessionId, t.name]),
        [
          ['s-old', 'Older chat'],
          ['s-new', 'Newer chat']
        ]
      )
      assert.ok(harness.log.includes('discoverSessions /other'))
    })
  )

  it.effect(
    'opens an imported tab in the project directory on the adapter model with safe modes',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          directories: ['/other'],
          discovered: [discovered('s-1', 'Chat', 1)]
        })

        const imported = (yield* register(harness)).projects[0].tabs[0]

        assert.deepStrictEqual(
          {
            cwd: imported.config.cwd,
            model: imported.config.model,
            thinkingLevel: imported.config.thinkingLevel,
            permissionMode: imported.config.permissionMode,
            archived: imported.archived
          },
          {
            cwd: '/other',
            model: 'adapter-model',
            thinkingLevel: 'medium',
            permissionMode: 'default',
            archived: false
          }
        )
      })
  )

  it.effect('starts no session and leaves the visible tab', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: {
          projects: [{ project: project(PROJECT_1, '/repo'), tabs: [tab(PANE_A, '/repo')] }],
          visibleTab: PANE_A
        },
        directories: ['/other'],
        discovered: [discovered('s-1', 'Chat', 1)]
      })

      const workspace = yield* register(harness)

      assert.strictEqual(workspace.visibleTab, PANE_A)
      assert.deepStrictEqual(harness.requests, [])
    })
  )

  it.effect('does not import a session host.db records for another agent', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        directories: ['/other'],
        storedSessionIds: ['s-superseded'],
        discovered: [discovered('s-superseded', 'Old', 1), discovered('s-free', 'Free', 2)]
      })

      const workspace = yield* register(harness)

      assert.deepStrictEqual(
        workspace.projects[0].tabs.map((t): string | undefined => t.sessionId),
        ['s-free']
      )
    })
  )

  it.effect('names a session with a blank title with a generated name', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        directories: ['/other'],
        discovered: [discovered('s-1', '   ', 1)]
      })

      const [adjective, noun] = (yield* register(harness)).projects[0].tabs[0].name.split('-')

      assert.ok((AGENT_NAME_ADJECTIVES as ReadonlyArray<string>).includes(adjective))
      assert.ok((AGENT_NAME_NOUNS as ReadonlyArray<string>).includes(noun))
    })
  )
})

describe('PaneWorkspace.createTab', () => {
  const oneProject = (isGitRepo = true): Workspace => ({
    projects: [{ project: project(PROJECT_1, '/repo', isGitRepo), tabs: [tab(PANE_A, '/repo')] }],
    visibleTab: PANE_A
  })

  it.effect('starts the agent in the project directory and shows the new tab', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: oneProject() })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).createTab(request(), ignore)
          return yield* current
        })
      )

      assert.strictEqual(harness.requests[0].sourceCwd, '/repo')
      assert.deepStrictEqual(tabsOf(workspace), [PANE_A, PANE_NEW])
      assert.deepStrictEqual(workspace.visibleTab, PANE_NEW)
      assert.strictEqual(workspace.projects[0].tabs[1].name, 'heron')
    })
  )

  it.effect('names an unnamed worktree tab after its branch without the dia/ prefix', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: oneProject(),
        openRun: (spec) =>
          Effect.succeed({
            ...configOf(spec),
            cwd: '/worktrees/swift-raven',
            worktree: {
              path: '/worktrees/swift-raven',
              branch: 'dia/swift-raven',
              sourceRepo: '/repo'
            }
          })
      })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).createTab(
            request({ name: null, useWorktree: true }),
            ignore
          )
          return yield* current
        })
      )

      assert.deepStrictEqual(harness.requests[0].worktree, {
        _tag: 'Create',
        label: 'Tab · /repo'
      })
      assert.strictEqual(workspace.projects[0].tabs[1].name, 'swift-raven')
    })
  )

  it.effect('gives an unnamed tab without a worktree an adjective-noun name', () =>
    Effect.gen(function* () {
      const workspace = yield* run(
        makeHarness({ persisted: oneProject() }),
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).createTab(request({ name: null }), ignore)
          return yield* current
        })
      )

      const [adjective, noun] = workspace.projects[0].tabs[1].name.split('-')
      assert.include(AGENT_NAME_ADJECTIVES, adjective)
      assert.include(AGENT_NAME_NOUNS, noun)
    })
  )

  it.effect(
    'refuses a worktree for a project that is not a git repo without starting anything',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ persisted: oneProject(false) })

        const error = yield* run(
          harness,
          Effect.flatMap(PaneWorkspace, (service) =>
            Effect.flip(service.createTab(request({ useWorktree: true }), ignore))
          )
        )

        assert.strictEqual(error._tag, 'WorktreeUnavailableError')
        assert.strictEqual(harness.requests.length, 0)
      })
  )

  it.effect('refuses an unknown project without starting anything', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: oneProject() })

      const error = yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (service) =>
          Effect.flip(service.createTab(request({ projectId: PROJECT_2 }), ignore))
        )
      )

      assert.strictEqual(error._tag, 'ProjectNotFoundError')
      assert.strictEqual(harness.requests.length, 0)
    })
  )

  it.effect('adds no tab when the agent fails to start', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: oneProject(),
        openRun: (spec) =>
          Effect.fail(
            new WorktreeCreateError({ paneId: spec.runId, sourceRepo: '/repo', cause: 'boom' })
          )
      })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* Effect.flip(
            (yield* PaneWorkspace).createTab(request({ useWorktree: true }), ignore)
          )
          return yield* current
        })
      )

      assert.deepStrictEqual(tabsOf(workspace), [PANE_A])
    })
  )

  it.effect('keeps a session id the agent reported while starting', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: oneProject(),
        openRun: (spec, emit) =>
          emit(
            RunSessionChanged.make({
              runId: spec.runId,
              sessionId: SessionId.make('early-session')
            })
          ).pipe(Effect.as(configOf(spec)))
      })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).createTab(request(), ignore)
          return yield* current
        })
      )

      assert.strictEqual(workspace.projects[0].tabs[1].sessionId, 'early-session')
    })
  )
})

describe('PaneWorkspace tab changes', () => {
  it.effect('shows the selected tab and resumes its recorded session', () =>
    Effect.gen(function* () {
      const persisted = twoProjects()
      const withSession: Workspace = {
        ...persisted,
        projects: [
          persisted.projects[0],
          {
            ...persisted.projects[1],
            tabs: [tab(PANE_B, '/other', { sessionId: SessionId.make('s-b') })]
          }
        ]
      }
      const harness = makeHarness({ persisted: withSession, directories: ['/other'] })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).selectTab(PANE_B, ignore)
          return yield* current
        })
      )

      assert.deepStrictEqual(workspace.visibleTab, PANE_B)
      assert.deepStrictEqual(harness.requests[0].resume, Option.some(SessionId.make('s-b')))
    })
  )

  it.effect('shows no tab when none is selected', () =>
    Effect.gen(function* () {
      const workspace = yield* run(
        makeHarness({ persisted: twoProjects() }),
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).selectTab(null, ignore)
          return yield* current
        })
      )

      assert.isNull(workspace.visibleTab)
    })
  )

  it.effect('saves a new project order', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects() })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (service) => service.moveProject(PROJECT_2, 0))
      )

      assert.deepStrictEqual(
        harness.saves.at(-1)?.projects.map((entry) => entry.project.projectId),
        [PROJECT_2, PROJECT_1]
      )
    })
  )

  it.effect('renames a tab', () =>
    Effect.gen(function* () {
      const workspace = yield* run(
        makeHarness({ persisted: twoProjects() }),
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).renameTab(PANE_B, AgentName.make('quiet-heron'))
          return yield* current
        })
      )

      assert.strictEqual(workspace.projects[1].tabs[0].name, 'quiet-heron')
    })
  )

  it.effect('stores a permission mode on the tab config', () =>
    Effect.gen(function* () {
      const workspace = yield* run(
        makeHarness({ persisted: twoProjects() }),
        Effect.gen(function* () {
          yield* (yield* PaneWorkspace).setPermissionMode(PANE_A, 'acceptEdits')
          return yield* current
        })
      )

      assert.strictEqual(workspace.projects[0].tabs[0].config.permissionMode, 'acceptEdits')
    })
  )

  it.effect('fails to change an unknown tab', () =>
    Effect.gen(function* () {
      const error = yield* run(
        makeHarness({ persisted: twoProjects() }),
        Effect.flatMap(PaneWorkspace, (service) =>
          Effect.flip(service.setThinkingLevel(PANE_NEW, 'high'))
        )
      )

      assert.strictEqual(error._tag, 'TabNotFoundError')
    })
  )
})

describe('PaneWorkspace.removeProject', () => {
  const worktree = {
    path: '/worktrees/brave-otter',
    branch: 'dia/brave-otter',
    sourceRepo: '/repo'
  }
  const removable = (): Workspace => ({
    projects: [
      {
        project: project(PROJECT_1, '/repo'),
        tabs: [
          tab(PANE_A, worktree.path, {
            sessionId: SessionId.make('s-a'),
            config: { ...tab(PANE_A, worktree.path).config, worktree }
          })
        ]
      },
      { project: project(PROJECT_2, '/other'), tabs: [tab(PANE_B, '/other')] }
    ],
    visibleTab: PANE_A
  })

  const removeAll = (projectId: ProjectId, force = false) =>
    Effect.flatMap(PaneWorkspace, (service) =>
      Stream.runCollect(service.removeProject(projectId, force))
    )

  const removingGitOps = (existing: Set<string>): GitOps => ({
    createWorktree: () => Effect.die('not called'),
    reattachWorktree: () => Effect.die('not called'),
    findIncludedFiles: () => Effect.die('not called'),
    copyIncludedFiles: () => Effect.die('not called'),
    releaseWorktree: (info) =>
      Effect.sync(() => void existing.delete(info.path)).pipe(Effect.as(WorktreeReleased.make({})))
  })

  const tags = (progress: ReadonlyArray<RemovalProgress>) =>
    progress.map((step) =>
      step._tag === 'ProjectRemoved' ? step._tag : `${step._tag} ${step.item._tag}`
    )

  it.effect('stops each agent, deletes its worktree, then drops the project', () =>
    Effect.gen(function* () {
      const withGit = makeHarness({
        persisted: removable(),
        files: [worktree.path],
        gitOps: removingGitOps
      })

      const progress = yield* run(withGit, removeAll(PROJECT_1))

      assert.deepStrictEqual(tags(progress), [
        'Removing AgentItem',
        'Removed AgentItem',
        'Removing WorktreeItem',
        'Removed WorktreeItem',
        'ProjectRemoved'
      ])
      assert.deepStrictEqual(
        withGit.saves.at(-1)?.projects.map((entry) => entry.project.projectId),
        [PROJECT_2]
      )
    })
  )

  it.effect('drops the project and leaves a kept worktree on disk as handled', () =>
    Effect.gen(function* () {
      const keepingGitOps = (): GitOps => ({
        ...removingGitOps(new Set()),
        releaseWorktree: () => Effect.succeed(WorktreeKept.make({ changedFiles: 2 }))
      })
      const harness = makeHarness({
        persisted: removable(),
        files: [worktree.path],
        gitOps: keepingGitOps
      })

      const progress = yield* run(harness, removeAll(PROJECT_1))

      assert.deepStrictEqual(
        [tags(progress).at(-1), harness.saves.at(-1)?.projects.length],
        ['ProjectRemoved', 1]
      )
    })
  )

  it.effect('moves the visible tab to the next project before stopping any agent', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: removable() })

      yield* run(harness, removeAll(PROJECT_1))

      const firstChange = harness.published.find((event) => event._tag === 'WorkspaceChanged')
      assert.deepStrictEqual(
        firstChange?._tag === 'WorkspaceChanged' ? firstChange.workspace.visibleTab : undefined,
        PANE_B
      )
      assert.isBelow(
        harness.log.indexOf('publish WorkspaceChanged'),
        harness.log.indexOf(`retire ${PANE_A} deleted`)
      )
    })
  )

  it.effect('keeps the project when the worktrees plugin unloads during a removal', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: removable(),
        files: [worktree.path],
        worktreesWithdrawn: true
      })

      const progress = yield* run(harness, removeAll(PROJECT_1))

      const failed = progress.find((step) => step._tag === 'RemoveFailed')
      assert.deepStrictEqual(failed, {
        _tag: 'RemoveFailed',
        item: { _tag: 'WorktreeItem', path: worktree.path },
        reason: `Could not remove the worktree: ${withdrawn.message}`
      })
      assert.notInclude(tags(progress), 'ProjectRemoved')
    })
  )

  it.effect(
    'keeps the project when a worktree cannot be removed because the plugin is not loaded',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ persisted: removable(), files: [worktree.path] })

        const progress = yield* run(harness, removeAll(PROJECT_1))

        const failed = progress.find((step) => step._tag === 'RemoveFailed')
        assert.deepStrictEqual(failed, {
          _tag: 'RemoveFailed',
          item: { _tag: 'WorktreeItem', path: worktree.path },
          reason: 'Load the worktrees plugin to remove this worktree'
        })
        assert.notInclude(tags(progress), 'ProjectRemoved')
        assert.strictEqual(harness.saves.at(-1)?.projects.length, 2)
      })
  )

  it.effect('reports a worktree whose directory is still on disk after removal as failed', () =>
    Effect.gen(function* () {
      const stubborn: GitOps = {
        createWorktree: () => Effect.die('not called'),
        reattachWorktree: () => Effect.die('not called'),
        findIncludedFiles: () => Effect.die('not called'),
        copyIncludedFiles: () => Effect.die('not called'),
        releaseWorktree: () => Effect.succeed(WorktreeReleased.make({}))
      }
      const harness = makeHarness({
        persisted: removable(),
        files: [worktree.path],
        gitOps: () => stubborn
      })

      const progress = yield* run(harness, removeAll(PROJECT_1))

      assert.include(tags(progress), 'RemoveFailed WorktreeItem')
    })
  )

  it.effect('retries a failed worktree on the next removal and then drops the project', () =>
    Effect.gen(function* () {
      let attempts = 0
      const removesOnSecondAttempt = (existing: Set<string>): GitOps => ({
        createWorktree: () => Effect.die('not called'),
        reattachWorktree: () => Effect.die('not called'),
        findIncludedFiles: () => Effect.die('not called'),
        copyIncludedFiles: () => Effect.die('not called'),
        releaseWorktree: (info) =>
          Effect.sync(() => {
            attempts += 1
            if (attempts > 1) existing.delete(info.path)
          }).pipe(Effect.as(WorktreeReleased.make({})))
      })
      const harness = makeHarness({
        persisted: removable(),
        files: [worktree.path],
        gitOps: removesOnSecondAttempt
      })

      const [first, second] = yield* run(
        harness,
        Effect.all([removeAll(PROJECT_1), removeAll(PROJECT_1)])
      )

      assert.include(tags(first), 'RemoveFailed WorktreeItem')
      assert.notInclude(tags(first), 'ProjectRemoved')
      assert.include(tags(second), 'ProjectRemoved')
    })
  )

  it.effect('with force, stops agents and drops the project without deleting worktrees', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: removable(), files: [worktree.path] })

      const progress = yield* run(harness, removeAll(PROJECT_1, true))

      assert.deepStrictEqual(tags(progress), [
        'Removing AgentItem',
        'Removed AgentItem',
        'ProjectRemoved'
      ])
      assert.isTrue(harness.existing.has(worktree.path))
    })
  )

  it.effect('fails for an unknown project', () =>
    Effect.gen(function* () {
      const unknown = ProjectId.make(PANE_NEW)

      const error = yield* run(
        makeHarness({ persisted: removable() }),
        Effect.flip(removeAll(unknown))
      )

      assert.strictEqual(error._tag, 'ProjectNotFoundError')
    })
  )

  it.effect('refuses new tabs and tab selection in the project while it is being removed', () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const harness = makeHarness({
        persisted: removable(),
        retireRun: () => Deferred.await(release)
      })

      const [createError, selectError] = yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          const removal = yield* Effect.forkChild(
            Stream.runCollect(service.removeProject(PROJECT_1, true))
          )
          while (!harness.log.includes(`retire ${PANE_A} deleted`)) yield* Effect.yieldNow
          const createError = yield* Effect.flip(service.createTab(request(), ignore))
          const selectError = yield* Effect.flip(service.selectTab(PANE_A, ignore))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(removal)
          return [createError, selectError] as const
        })
      )

      assert.strictEqual(createError._tag, 'ProjectNotFoundError')
      assert.strictEqual(selectError._tag, 'TabNotFoundError')
      assert.strictEqual(harness.requests.length, 0)
    })
  )
})

describe('PaneWorkspace.archiveTab and deleteTab', () => {
  const worktree = {
    path: '/worktrees/brave-otter',
    branch: 'dia/brave-otter',
    sourceRepo: '/repo'
  }
  const worktreeTab = tab(PANE_A, worktree.path, {
    sessionId: SessionId.make('s-a'),
    config: { ...tab(PANE_A, worktree.path).config, worktree }
  })
  const persisted = (): Workspace => ({
    projects: [
      { project: project(PROJECT_1, '/repo'), tabs: [worktreeTab] },
      { project: project(PROJECT_2, '/other'), tabs: [tab(PANE_B, '/other')] }
    ],
    visibleTab: PANE_A
  })
  const removingGitOps = (existing: Set<string>): GitOps => ({
    createWorktree: () => Effect.die('not called'),
    reattachWorktree: () => Effect.die('not called'),
    findIncludedFiles: () => Effect.die('not called'),
    copyIncludedFiles: () => Effect.die('not called'),
    releaseWorktree: (info) =>
      Effect.sync(() => void existing.delete(info.path)).pipe(Effect.as(WorktreeReleased.make({})))
  })
  const stubbornGitOps = (): GitOps => ({
    createWorktree: () => Effect.die('not called'),
    reattachWorktree: () => Effect.die('not called'),
    findIncludedFiles: () => Effect.die('not called'),
    copyIncludedFiles: () => Effect.die('not called'),
    releaseWorktree: () => Effect.succeed(WorktreeReleased.make({}))
  })
  const withWorktree = (gitOps?: (existing: Set<string>) => GitOps) =>
    makeHarness({ persisted: persisted(), files: [worktree.path], gitOps })
  const archive = (paneId: string) => Effect.flatMap(PaneWorkspace, (s) => s.archiveTab(paneId))
  const remove = (paneId: string) => Effect.flatMap(PaneWorkspace, (s) => s.deleteTab(paneId))

  it.effect(
    'archiving stops the agent, removes the worktree and keeps its config and session',
    () =>
      Effect.gen(function* () {
        const harness = withWorktree(removingGitOps)

        const workspace = yield* run(harness, archive(PANE_A).pipe(Effect.andThen(current)))

        assert.include(harness.log, `close ${PANE_A}`)
        assert.include(harness.log, `retire ${PANE_A} archived`)
        assert.isFalse(harness.existing.has(worktree.path))
        assert.deepStrictEqual(workspace.projects[0].tabs[0], { ...worktreeTab, archived: true })
        assert.deepStrictEqual(harness.saves.at(-1), workspace)
      })
  )

  it.effect('archiving records AgentArchived after the session stops', () =>
    Effect.gen(function* () {
      const harness = withWorktree(removingGitOps)

      yield* run(harness, archive(PANE_A))

      const closed = harness.log.indexOf(`close ${PANE_A}`)
      const recorded = harness.log.indexOf(`append ${PANE_A} AgentArchived`)
      assert.isTrue(closed !== -1 && recorded > closed)
    })
  )

  it.effect('archives a tab even when AgentArchived cannot be recorded', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: persisted(),
        files: [worktree.path],
        gitOps: removingGitOps,
        failEventAppend: true
      })

      const workspace = yield* run(harness, archive(PANE_A).pipe(Effect.andThen(current)))

      assert.isTrue(workspace.projects[0].tabs[0].archived)
    })
  )

  it.effect('deleting records no archive event', () =>
    Effect.gen(function* () {
      const harness = withWorktree(removingGitOps)

      yield* run(harness, remove(PANE_A))

      assert.isFalse(harness.log.some((line) => line.startsWith('append ')))
    })
  )

  it.effect('deleting stops the agent, removes the worktree, drops the tab and shows another', () =>
    Effect.gen(function* () {
      const harness = withWorktree(removingGitOps)

      const workspace = yield* run(harness, remove(PANE_A).pipe(Effect.andThen(current)))

      assert.include(harness.log, `close ${PANE_A}`)
      assert.include(harness.log, `retire ${PANE_A} deleted`)
      assert.isFalse(harness.existing.has(worktree.path))
      assert.deepStrictEqual(tabsOf(workspace), [PANE_B])
      assert.strictEqual(workspace.visibleTab, PANE_B)
      assert.deepStrictEqual(harness.saves.at(-1), workspace)
    })
  )

  it.effect('leaves the tab unchanged when its worktree is still on disk afterwards', () =>
    Effect.gen(function* () {
      const harness = withWorktree(stubbornGitOps)

      const [archiveError, deleteError, workspace] = yield* run(
        harness,
        Effect.all([Effect.flip(archive(PANE_A)), Effect.flip(remove(PANE_A)), current])
      )

      assert.deepStrictEqual(
        [archiveError._tag, deleteError._tag],
        ['WorktreeNotRemovedError', 'WorktreeNotRemovedError']
      )
      assert.deepStrictEqual(workspace, persisted())
      assert.strictEqual(harness.saves.length, 0)
    })
  )

  it.effect('names the worktrees plugin when it is not loaded', () =>
    Effect.gen(function* () {
      const error = yield* run(withWorktree(), Effect.flip(archive(PANE_A)))

      assert.deepStrictEqual(
        error,
        new WorktreeNotRemovedError({
          paneId: PANE_A,
          path: worktree.path,
          reason: 'Load the worktrees plugin to remove this worktree'
        })
      )
    })
  )

  it.effect('archives and deletes a tab without a worktree without the worktrees plugin', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects() })

      const workspace = yield* run(
        harness,
        Effect.all([archive(PANE_A), remove(PANE_B)]).pipe(Effect.andThen(current))
      )

      assert.deepStrictEqual(
        workspace.projects.map((entry) => entry.tabs.map((t) => [t.config.paneId, t.archived])),
        [[[PANE_A, true]], []]
      )
    })
  )

  it.effect('fails for an unknown tab', () =>
    Effect.gen(function* () {
      const error = yield* run(
        makeHarness({ persisted: twoProjects() }),
        Effect.flip(remove(PANE_NEW))
      )

      assert.strictEqual(error._tag, 'TabNotFoundError')
    })
  )

  const archivedPersisted = (): Workspace => ({
    ...persisted(),
    projects: [
      { project: project(PROJECT_1, '/repo'), tabs: [{ ...worktreeTab, archived: true }] },
      persisted().projects[1]
    ]
  })

  it.effect(
    'deletes an archived tab without touching a directory now at its old worktree path',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          persisted: archivedPersisted(),
          files: [worktree.path],
          gitOps: stubbornGitOps
        })

        const workspace = yield* run(harness, remove(PANE_A).pipe(Effect.andThen(current)))

        assert.deepStrictEqual(tabsOf(workspace), [PANE_B])
        assert.isTrue(harness.existing.has(worktree.path))
      })
  )

  it.effect('archiving an archived tab again records no second AgentArchived', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: archivedPersisted(), gitOps: removingGitOps })

      yield* run(harness, archive(PANE_A))

      assert.isFalse(harness.log.some((line) => line.startsWith('append ')))
    })
  )

  it.effect('refuses showing, starting or retiring the tab again while it is being archived', () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const harness = makeHarness({
        persisted: twoProjects(PANE_B),
        closeRun: () => Deferred.await(release)
      })

      const [selectError, deleteError] = yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          const archiving = yield* Effect.forkChild(service.archiveTab(PANE_A))
          while (!harness.log.includes(`close ${PANE_A}`)) yield* Effect.yieldNow
          const selectError = yield* Effect.flip(service.selectTab(PANE_A, ignore))
          const deleteError = yield* Effect.flip(service.deleteTab(PANE_A))
          const starting = yield* Effect.forkChild(service.resumePane(PANE_A, ignore))
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(archiving)
          yield* Fiber.join(starting)
          return [selectError, deleteError] as const
        })
      )

      assert.deepStrictEqual(
        [selectError._tag, deleteError._tag],
        ['TabNotFoundError', 'TabNotFoundError']
      )
      assert.strictEqual(harness.requests.length, 0)
    })
  )

  it.effect('shows an archived tab without starting its session', () =>
    Effect.gen(function* () {
      const archived = twoProjects(PANE_B)
      const harness = makeHarness({
        persisted: {
          ...archived,
          projects: [
            {
              ...archived.projects[0],
              tabs: [tab(PANE_A, '/repo', { sessionId: SessionId.make('s-a'), archived: true })]
            },
            archived.projects[1]
          ]
        },
        directories: ['/repo']
      })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          yield* service.selectTab(PANE_A, ignore)
          return yield* service.getWorkspace
        })
      )

      assert.strictEqual(workspace.visibleTab, PANE_A)
      assert.strictEqual(harness.requests.length, 0)
    })
  )
})

describe('PaneWorkspace.unarchiveTab', () => {
  const worktree = {
    path: '/worktrees/brave-otter',
    branch: 'dia/brave-otter',
    sourceRepo: '/repo'
  }
  const archivedTab = tab(PANE_A, worktree.path, {
    sessionId: SessionId.make('s-a'),
    config: { ...tab(PANE_A, worktree.path).config, worktree },
    archived: true
  })
  const persisted = (paneTab: Tab = archivedTab): Workspace => ({
    projects: [{ project: project(PROJECT_1, '/repo'), tabs: [paneTab, tab(PANE_B, '/repo')] }],
    visibleTab: PANE_B
  })
  const reattachingGitOps =
    (reattach: GitOps['reattachWorktree']) =>
    (existing: Set<string>): GitOps => ({
      createWorktree: () => Effect.die('not called'),
      reattachWorktree: (info, paneId) =>
        reattach(info, paneId).pipe(Effect.tap(() => Effect.sync(() => existing.add(info.path)))),
      findIncludedFiles: () => Effect.die('not called'),
      copyIncludedFiles: () => Effect.die('not called'),
      releaseWorktree: () => Effect.die('not called')
    })
  const restoring = reattachingGitOps((info) => Effect.succeed(info))
  const missingBranch = reattachingGitOps((info, paneId) =>
    Effect.fail(
      new WorktreeReattachError({
        paneId,
        path: info.path,
        cause: `Branch ${info.branch} no longer exists`
      })
    )
  )
  const unarchive = (paneId: string) => Effect.flatMap(PaneWorkspace, (s) => s.unarchiveTab(paneId))
  const appended = (harness: Harness) => harness.log.filter((line) => line.startsWith('append '))

  it.effect('restores the worktree, records AgentUnarchived and marks the tab not archived', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: persisted(), gitOps: restoring })

      const workspace = yield* run(harness, unarchive(PANE_A).pipe(Effect.andThen(current)))

      assert.isTrue(harness.existing.has(worktree.path))
      assert.deepStrictEqual(appended(harness), [`append ${PANE_A} AgentUnarchived`])
      assert.deepStrictEqual(workspace.projects[0].tabs[0], { ...archivedTab, archived: false })
      assert.strictEqual(workspace.visibleTab, PANE_B)
      assert.deepStrictEqual(harness.saves.at(-1), workspace)
    })
  )

  it.effect('starts no session', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: persisted(), gitOps: restoring })

      yield* run(harness, unarchive(PANE_A))

      assert.strictEqual(harness.requests.length, 0)
    })
  )

  it.effect('leaves the tab archived and records nothing when the branch is gone', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: persisted(), gitOps: missingBranch })

      const [error, workspace] = yield* run(
        harness,
        Effect.all([Effect.flip(unarchive(PANE_A)), current])
      )

      assert.deepStrictEqual(
        error,
        new WorktreeNotRestoredError({
          paneId: PANE_A,
          path: worktree.path,
          reason: 'Branch dia/brave-otter no longer exists'
        })
      )
      assert.deepStrictEqual(workspace, persisted())
      assert.deepStrictEqual(appended(harness), [])
      assert.strictEqual(harness.saves.length, 0)
    })
  )

  it.effect('names the closed plugin when the worktrees plugin unloads during a restore', () =>
    Effect.gen(function* () {
      const error = yield* run(
        makeHarness({ persisted: persisted(), worktreesWithdrawn: true }),
        Effect.flip(unarchive(PANE_A))
      )

      assert.deepStrictEqual(
        error,
        new WorktreeNotRestoredError({
          paneId: PANE_A,
          path: worktree.path,
          reason: withdrawn.message
        })
      )
    })
  )

  it.effect('names the worktrees plugin when it is not loaded', () =>
    Effect.gen(function* () {
      const error = yield* run(
        makeHarness({ persisted: persisted() }),
        Effect.flip(unarchive(PANE_A))
      )

      assert.deepStrictEqual(
        error,
        new WorktreeNotRestoredError({
          paneId: PANE_A,
          path: worktree.path,
          reason: 'Load the worktrees plugin to restore this worktree'
        })
      )
    })
  )

  it.effect('unarchives a tab with no worktree whose working directory exists', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: persisted(tab(PANE_A, '/repo', { archived: true })),
        directories: ['/repo']
      })

      const workspace = yield* run(harness, unarchive(PANE_A).pipe(Effect.andThen(current)))

      assert.isFalse(workspace.projects[0].tabs[0].archived)
      assert.deepStrictEqual(appended(harness), [`append ${PANE_A} AgentUnarchived`])
    })
  )

  it.effect('leaves a tab with no worktree archived when its working directory is gone', () =>
    Effect.gen(function* () {
      const gone = '/worktrees/old-heron'
      const harness = makeHarness({ persisted: persisted(tab(PANE_A, gone, { archived: true })) })

      const error = yield* run(harness, Effect.flip(unarchive(PANE_A)))

      assert.deepStrictEqual(
        error,
        new WorktreeNotRestoredError({
          paneId: PANE_A,
          path: gone,
          reason: `The working directory ${gone} no longer exists`
        })
      )
      assert.deepStrictEqual(appended(harness), [])
    })
  )

  it.effect('does nothing for a tab that is not archived', () =>
    Effect.gen(function* () {
      const live = { ...archivedTab, archived: false }
      const harness = makeHarness({
        persisted: persisted(live),
        gitOps: reattachingGitOps(() => Effect.die('reattach must not run'))
      })

      const workspace = yield* run(harness, unarchive(PANE_A).pipe(Effect.andThen(current)))

      assert.deepStrictEqual(workspace, persisted(live))
      assert.deepStrictEqual(appended(harness), [])
    })
  )

  it.effect('fails for an unknown tab', () =>
    Effect.gen(function* () {
      const error = yield* run(
        makeHarness({ persisted: persisted(), gitOps: restoring }),
        Effect.flip(unarchive(PANE_NEW))
      )

      assert.strictEqual(error._tag, 'TabNotFoundError')
    })
  )

  it.effect('unarchives a tab even when AgentUnarchived cannot be recorded', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: persisted(),
        gitOps: restoring,
        failEventAppend: true
      })

      const workspace = yield* run(harness, unarchive(PANE_A).pipe(Effect.andThen(current)))

      assert.isFalse(workspace.projects[0].tabs[0].archived)
    })
  )
})

describe('PaneWorkspace sessions', () => {
  const withSession = (cwd = '/repo', extra: Partial<PaneConfig> = {}): Workspace => ({
    projects: [
      {
        project: project(PROJECT_1, '/repo'),
        tabs: [
          tab(PANE_A, cwd, {
            sessionId: SessionId.make('restored-1'),
            config: { ...tab(PANE_A, cwd).config, ...extra }
          })
        ]
      }
    ],
    visibleTab: PANE_A
  })
  const withoutSession: Workspace = {
    projects: [{ project: project(PROJECT_1, '/repo'), tabs: [tab(PANE_A, '/repo')] }],
    visibleTab: PANE_A
  }

  const recordEvents = () => {
    const events: Array<IpcEvent> = []
    return { events, onEvent: (event: IpcEvent) => Effect.sync(() => void events.push(event)) }
  }

  it.effect('resumePane continues the recorded session in the tab directory', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withSession(), directories: ['/repo'] })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, ignore))
      )

      assert.deepStrictEqual(harness.requests[0].resume, Option.some(SessionId.make('restored-1')))
      assert.strictEqual(harness.requests[0].sourceCwd, '/repo')
    })
  )

  it.effect('starts the next message fresh after the resumed conversation was not found', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: withSession(),
        directories: ['/repo'],
        openRun: (spec, emit) =>
          (Option.isNone(spec.resume)
            ? Effect.void
            : emit(RunSessionChanged.make({ runId: spec.runId, sessionId: null }))
          ).pipe(Effect.as(configOf(spec)))
      })

      const tabAfter = yield* run(
        harness,
        Effect.gen(function* () {
          const workspace = yield* PaneWorkspace
          yield* workspace.resumePane(PANE_A, ignore)
          yield* workspace.resumePane(PANE_A, ignore)
          yield* workspace.selectTab(PANE_A, ignore)
          return (yield* current).projects[0].tabs[0]
        })
      )

      assert.deepStrictEqual(
        harness.requests.map((req) => req.resume),
        [Option.some(SessionId.make('restored-1')), Option.none()]
      )
      assert.notProperty(tabAfter, 'sessionId')
      assert.deepStrictEqual(tabAfter.config, withSession().projects[0].tabs[0].config)
      assert.deepStrictEqual(
        { model: harness.requests[1].model, sourceCwd: harness.requests[1].sourceCwd },
        { model: tabAfter.config.model, sourceCwd: '/repo' }
      )
    })
  )

  it.effect('resumePane does nothing for a running tab', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: withSession(),
        directories: ['/repo'],
        live: new Set([PANE_A])
      })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, ignore))
      )

      assert.strictEqual(harness.requests.length, 0)
    })
  )

  it.effect('resumePane does nothing for a tab with no recorded session', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withoutSession, directories: ['/repo'] })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, ignore))
      )

      assert.strictEqual(harness.requests.length, 0)
    })
  )

  it.effect('selectTab starts a new conversation for a tab with no recorded session', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withoutSession, directories: ['/repo'] })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.selectTab(PANE_A, ignore))
      )

      assert.strictEqual(harness.requests.length, 1)
      assert.isTrue(Option.isNone(harness.requests[0].resume))
    })
  )

  it.effect('selectTab fails for an unknown tab without starting a run', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withoutSession, directories: ['/repo'] })

      const error = yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => Effect.flip(s.selectTab(PANE_NEW, ignore)))
      )

      assert.strictEqual(error._tag, 'TabNotFoundError')
      assert.strictEqual(harness.requests.length, 0)
    })
  )

  it.effect('resumePane reports Errored without starting when the working directory is gone', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withSession() })
      const { events, onEvent } = recordEvents()

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, onEvent))
      )

      assert.strictEqual(harness.requests.length, 0)
      assert.deepStrictEqual(
        events.map((event) =>
          event._tag === 'PaneAttentionChanged' ? event.attention._tag : event._tag
        ),
        ['Errored']
      )
    })
  )

  it.effect('resumePane reattaches a worktree tab without checking its working directory', () =>
    Effect.gen(function* () {
      const worktree = { path: '/wt/x', branch: 'dia/silver-heron', sourceRepo: '/repo' }
      const harness = makeHarness({ persisted: withSession('/wt/x', { worktree }) })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, ignore))
      )

      assert.deepStrictEqual(harness.requests[0].worktree, { _tag: 'Reattach', info: worktree })
      assert.strictEqual(harness.requests[0].sourceCwd, '/repo')
    })
  )

  it.effect('resumePane reports Errored when the agent fails to start', () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        persisted: withSession(),
        directories: ['/repo'],
        openRun: (spec) =>
          Effect.fail(
            new WorktreeCreateError({ paneId: spec.runId, sourceRepo: '/repo', cause: 'boom' })
          )
      })
      const { events, onEvent } = recordEvents()

      const result = yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, onEvent).pipe(Effect.result))
      )

      assert.isTrue(Result.isSuccess(result))
      assert.strictEqual(events[0]?._tag, 'PaneAttentionChanged')
    })
  )
})

describe('PaneWorkspace run tab requests', () => {
  it.effect('adds a tab for the run to the project of its directory and shows it', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: twoProjects() })

      const workspace = yield* run(
        harness,
        Effect.gen(function* () {
          yield* harness.emit(
            RunTabRequested.make({
              runId: PANE_NEW,
              directory: '/other',
              projectDirectory: '/other',
              select: true,
              model: 'm',
              thinkingLevel: 'adaptive',
              permissionMode: 'default',
              sessionId: SessionId.make('s-new')
            })
          )
          return yield* current
        })
      )

      assert.deepStrictEqual(
        workspace.projects.map((entry) => entry.tabs.map((t) => t.config.paneId)),
        [[PANE_A], [PANE_B, PANE_NEW]]
      )
      assert.strictEqual(workspace.projects[1].tabs[1].sessionId, 's-new')
      assert.strictEqual(workspace.visibleTab, PANE_NEW)
    })
  )

  it.effect(
    'adds a tab working in a worktree to the project at projectDirectory and keeps the visible tab when select is false',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ persisted: twoProjects() })
        const worktree = '/trees/issue-1'

        const workspace = yield* run(
          harness,
          Effect.gen(function* () {
            yield* harness.emit(
              RunTabRequested.make({
                runId: PANE_NEW,
                directory: worktree,
                projectDirectory: '/repo',
                select: false,
                model: 'm',
                thinkingLevel: 'adaptive',
                permissionMode: 'default',
                sessionId: null
              })
            )
            return yield* current
          })
        )

        assert.deepStrictEqual(
          workspace.projects.map((entry) => entry.tabs.map((t) => t.config.paneId)),
          [[PANE_A, PANE_NEW], [PANE_B]]
        )
        assert.strictEqual(workspace.projects[0].tabs[1].config.cwd, worktree)
        assert.strictEqual(workspace.visibleTab, PANE_A)
      })
  )
})
