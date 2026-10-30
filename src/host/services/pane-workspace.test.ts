import { NodePath } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS } from '@shared/domain/agent-name'
import { EMPTY_MESSAGE_QUEUE } from '@shared/domain/message-queue'
import { type ConversationMessage, type PaneConfig, SessionId } from '@shared/domain/pane'
import {
  AgentName,
  type CreateTabRequest,
  type Project,
  ProjectId,
  type Tab,
  type Workspace
} from '@shared/domain/project'
import type { RemovalProgress } from '@shared/domain/project-removal'
import type { IpcEvent } from '@shared/ipc/contract'
import { WORKTREES_KEY } from '@shared/plugin/api'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Result,
  Stream
} from 'effect'
import { HostPlugins } from '../plugins/host-plugins'
import { AGENT_BACKEND_KEY, type AgentBackend, SessionDeleteError } from '../session/agent-backend'
import { EventHub } from './event-hub'
import { type PaneCreationRequest, type PaneHandle, PaneSupervisor } from './pane-supervisor'
import { makePaneWorkspaceLive, PaneWorkspace } from './pane-workspace'
import { PersistenceService } from './persistence'
import { TranscriptReader } from './transcript-reader'
import { type GitOps, WorktreeCreateError } from './worktrees-seam'

const PANE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const PANE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PANE_NEW = 'cccccccc-0000-4000-8000-000000000003'
const PROJECT_1 = ProjectId.make('11111111-0000-4000-8000-000000000001')
const PROJECT_2 = ProjectId.make('22222222-0000-4000-8000-000000000002')
const WORKTREES_ROOT = '/worktrees'

const fakeHandle: PaneHandle = {
  sendMessage: () => Effect.void,
  editQueuedMessage: () => Effect.void,
  removeQueuedMessage: () => Effect.void,
  messageQueue: Effect.succeed(EMPTY_MESSAGE_QUEUE),
  setThinkingLevel: () => Effect.void,
  setPermissionMode: () => Effect.void,
  setModel: () => Effect.void,
  resolvePermission: () => Effect.void,
  resolveQuestion: () => Effect.void,
  resolvePlanReview: () => Effect.void,
  rewindToCheckpoint: () => Effect.void,
  interrupt: () => Effect.void,
  markCrashed: () => Effect.void,
  resume: Effect.void
}

interface Harness {
  readonly log: Array<string>
  readonly saves: Array<Workspace>
  readonly published: Array<IpcEvent>
  readonly requests: Array<PaneCreationRequest>
  readonly deletedSessions: Array<string>
  readonly existing: Set<string>
  readonly layer: Layer.Layer<PaneWorkspace>
}

interface HarnessOptions {
  readonly persisted?: Workspace
  readonly directories?: ReadonlyArray<string>
  readonly files?: ReadonlyArray<string>
  readonly openPane?: PaneSupervisor['Service']['openPane']
  readonly live?: ReadonlySet<string>
  readonly closePane?: (paneId: string) => Effect.Effect<void>
  readonly gitOps?: (existing: Set<string>) => GitOps
  readonly deleteSession?: AgentBackend['deleteSession']
  readonly history?: ReadonlyArray<ConversationMessage>
}

const configOf = (request: PaneCreationRequest): PaneConfig => ({
  paneId: request.paneId,
  cwd: request.sourceCwd,
  model: request.model,
  thinkingLevel: request.thinkingLevel,
  permissionMode: request.permissionMode
})

const makeHarness = (options: HarnessOptions = {}): Harness => {
  const log: Array<string> = []
  const saves: Array<Workspace> = []
  const published: Array<IpcEvent> = []
  const requests: Array<PaneCreationRequest> = []
  const deletedSessions: Array<string> = []
  const existing = new Set([...(options.directories ?? []), ...(options.files ?? [])])
  const directories = new Set(options.directories ?? [])

  const supervisor = Layer.succeed(PaneSupervisor, {
    openPane: (request, onEvent, onSessionId, onModeChanged) => {
      requests.push(request)
      return options.openPane === undefined
        ? Effect.succeed({ handle: fakeHandle, config: configOf(request) })
        : options.openPane(request, onEvent, onSessionId, onModeChanged)
    },
    closePane: (paneId) =>
      Effect.sync(() => log.push(`closePane ${paneId}`)).pipe(
        Effect.andThen(options.closePane?.(paneId) ?? Effect.void)
      ),
    getHandle: (paneId) =>
      Effect.succeed(options.live?.has(paneId) === true ? Option.some(fakeHandle) : Option.none()),
    closeAll: () => Effect.void,
    setUsageLimitResume: () => Effect.void
  })

  const persistence = Layer.succeed(PersistenceService, {
    loadWorkspace: Effect.succeed(Option.fromNullishOr(options.persisted)),
    saveWorkspace: (workspace) => Effect.sync(() => void saves.push(workspace)),
    loadActivity: Effect.succeed({}),
    saveActivity: () => Effect.void
  })

  const hub = Layer.succeed(EventHub, {
    publish: (event) =>
      Effect.sync(() => {
        published.push(event)
        log.push(`publish ${event._tag}`)
      }),
    subscribe: () => Stream.empty
  })

  const backend: AgentBackend = {
    openSession: () => Effect.die('not called'),
    readHistory: () => Effect.succeed([]),
    deleteSession:
      options.deleteSession ??
      ((sessionId) => Effect.sync(() => void deletedSessions.push(sessionId))),
    models: () => Stream.empty,
    refreshModels: () => Effect.die('not called'),
    status: () => Stream.empty,
    checkHealth: () => Effect.void,
    setInstallPath: () => Effect.void,
    disabledPermissionModes: () => Effect.succeed([])
  }
  const provided = new Map<string, unknown>([[AGENT_BACKEND_KEY, backend]])
  if (options.gitOps !== undefined) provided.set(WORKTREES_KEY, options.gitOps(existing))
  const plugins = Layer.succeed(HostPlugins, {
    inject: (key: string) => Effect.succeed(Option.fromNullishOr(provided.get(key)))
  } as unknown as PluginRegistry)

  const transcripts = Layer.succeed(TranscriptReader, {
    readHistory: (sessionId, cwd) =>
      Effect.sync(() => {
        log.push(`readHistory ${sessionId} ${cwd}`)
        return options.history ?? []
      })
  })

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

  const layer = Layer.provide(
    makePaneWorkspaceLive(WORKTREES_ROOT),
    Layer.mergeAll(supervisor, persistence, hub, plugins, transcripts, fs, NodePath.layer)
  )
  return { log, saves, published, requests, deletedSessions, existing, layer }
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

const run = <A, E>(harness: Harness, body: Effect.Effect<A, E, PaneWorkspace>) =>
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
        openPane: (req) =>
          Effect.succeed({
            handle: fakeHandle,
            config: {
              ...configOf(req),
              cwd: '/worktrees/swift-raven',
              worktree: {
                path: '/worktrees/swift-raven',
                branch: 'dia/swift-raven',
                sourceRepo: '/repo'
              }
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
        worktreesRoot: WORKTREES_ROOT
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
        openPane: (req) =>
          Effect.fail(
            new WorktreeCreateError({ paneId: req.paneId, sourceRepo: '/repo', cause: 'boom' })
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
        openPane: (req, _onEvent, onSessionId) =>
          onSessionId(SessionId.make('early-session')).pipe(
            Effect.as({ handle: fakeHandle, config: configOf(req) })
          )
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
      assert.strictEqual(harness.requests[0].resume, 's-b')
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
    removeWorktree: (info) => Effect.sync(() => void existing.delete(info.path))
  })

  const tags = (progress: ReadonlyArray<RemovalProgress>) =>
    progress.map((step) =>
      step._tag === 'ProjectRemoved' ? step._tag : `${step._tag} ${step.item._tag}`
    )

  it.effect('stops each agent, deletes its worktree and transcript, then drops the project', () =>
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
        'Removing TranscriptItem',
        'Removed TranscriptItem',
        'ProjectRemoved'
      ])
      assert.deepStrictEqual(withGit.deletedSessions, ['s-a'])
      assert.deepStrictEqual(
        withGit.saves.at(-1)?.projects.map((entry) => entry.project.projectId),
        [PROJECT_2]
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
        harness.log.indexOf(`closePane ${PANE_A}`)
      )
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
        removeWorktree: () => Effect.void
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

  it.effect('retries a failed transcript on the next removal and then drops the project', () =>
    Effect.gen(function* () {
      let attempts = 0
      const harness = makeHarness({
        persisted: removable(),
        deleteSession: (sessionId) =>
          Effect.suspend(() => {
            attempts += 1
            return attempts === 1
              ? Effect.fail(new SessionDeleteError({ sessionId, reason: 'EBUSY' }))
              : Effect.void
          })
      })

      const [first, second] = yield* run(
        harness,
        Effect.all([removeAll(PROJECT_1), removeAll(PROJECT_1)])
      )

      assert.include(tags(first), 'RemoveFailed TranscriptItem')
      assert.notInclude(tags(first), 'ProjectRemoved')
      assert.include(tags(second), 'ProjectRemoved')
    })
  )

  it.effect(
    'with force, stops agents and drops the project without deleting worktrees or transcripts',
    () =>
      Effect.gen(function* () {
        const harness = makeHarness({ persisted: removable(), files: [worktree.path] })

        const progress = yield* run(harness, removeAll(PROJECT_1, true))

        assert.deepStrictEqual(tags(progress), [
          'Removing AgentItem',
          'Removed AgentItem',
          'ProjectRemoved'
        ])
        assert.deepStrictEqual(harness.deletedSessions, [])
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
        closePane: () => Deferred.await(release)
      })

      const [createError, selectError] = yield* run(
        harness,
        Effect.gen(function* () {
          const service = yield* PaneWorkspace
          const removal = yield* Effect.forkChild(
            Stream.runCollect(service.removeProject(PROJECT_1, true))
          )
          while (!harness.log.includes(`closePane ${PANE_A}`)) yield* Effect.yieldNow
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

  it.effect('getPaneHistory reads the transcript by the tab session id and cwd', () =>
    Effect.gen(function* () {
      const history: ReadonlyArray<ConversationMessage> = [{ role: 'user', content: 'hello' }]
      const harness = makeHarness({ persisted: withSession(), history })

      const read = yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.getPaneHistory(PANE_A))
      )

      assert.deepStrictEqual(read, history)
      assert.include(harness.log, 'readHistory restored-1 /repo')
    })
  )

  it.effect('resumePane continues the recorded session in the tab directory', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withSession(), directories: ['/repo'] })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.resumePane(PANE_A, ignore))
      )

      assert.strictEqual(harness.requests[0].resume, 'restored-1')
      assert.strictEqual(harness.requests[0].sourceCwd, '/repo')
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

  it.effect('ensureLive starts a fresh session for a tab with no recorded session', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withoutSession, directories: ['/repo'] })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.ensureLive(PANE_A, ignore))
      )

      assert.strictEqual(harness.requests.length, 1)
      assert.strictEqual(harness.requests[0].resume, undefined)
    })
  )

  it.effect('ensureLive does nothing for an unknown tab', () =>
    Effect.gen(function* () {
      const harness = makeHarness({ persisted: withoutSession, directories: ['/repo'] })

      yield* run(
        harness,
        Effect.flatMap(PaneWorkspace, (s) => s.ensureLive(PANE_NEW, ignore))
      )

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
        openPane: (req) =>
          Effect.fail(
            new WorktreeCreateError({ paneId: req.paneId, sourceRepo: '/repo', cause: 'boom' })
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
