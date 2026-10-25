import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { NoActivity, Todo } from '@shared/domain/agent-summary'
import { SessionId } from '@shared/domain/pane'
import { AgentName, ProjectId, type Workspace } from '@shared/domain/project'
import { Effect, FileSystem, Option, Path } from 'effect'
import { makePersistenceServiceLive, PersistenceService } from './persistence'
import { directoryKey } from './project-directory'

const PANE_A = '11111111-1111-4111-8111-111111111111'
const PANE_B = '22222222-2222-4222-8222-222222222222'
const PANE_C = '33333333-3333-4333-8333-333333333333'
const PANE_PENDING = '44444444-4444-4444-8444-444444444444'

const config = (paneId: string, cwd: string) => ({
  paneId,
  cwd,
  model: 'claude-sonnet-5-5',
  thinkingLevel: 'adaptive' as const,
  permissionMode: 'default' as const
})

const withPersistence = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, PersistenceService | FileSystem.FileSystem | Path.Path>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-persistence-' })
    return yield* body(dir).pipe(Effect.provide(makePersistenceServiceLive(dir)))
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))

const load = Effect.flatMap(PersistenceService, (service) => service.loadWorkspace)

describe('PersistenceService workspace', () => {
  it.effect('loads the projects, tabs, order and visible tab it saved', () =>
    withPersistence(() =>
      Effect.gen(function* () {
        const service = yield* PersistenceService
        const workspace: Workspace = {
          projects: [
            {
              project: {
                projectId: ProjectId.make(PANE_C),
                directory: 'F:\\b',
                directoryKey: 'f:\\b',
                displayName: 'b',
                isGitRepo: false
              },
              tabs: [
                {
                  name: AgentName.make('heron'),
                  config: config(PANE_A, 'F:\\b'),
                  sessionId: SessionId.make('s-1'),
                  archived: false
                }
              ]
            },
            {
              project: {
                projectId: ProjectId.make(PANE_PENDING),
                directory: 'F:\\a',
                directoryKey: 'f:\\a',
                displayName: 'a',
                isGitRepo: true
              },
              tabs: [
                { name: AgentName.make('otter'), config: config(PANE_B, 'F:\\a'), archived: true }
              ]
            }
          ],
          visibleTab: PANE_A
        }

        yield* service.saveWorkspace(workspace)

        assert.deepStrictEqual(yield* load, Option.some(workspace))
      })
    )
  )

  it.effect('loads nothing when no workspace file exists', () =>
    withPersistence(() => Effect.map(load, (loaded) => assert.isTrue(Option.isNone(loaded))))
  )

  it.effect('loads nothing when the workspace file is malformed', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${dir}/workspace.json`, '{"version":2,"workspace":{}}')

        assert.isTrue(Option.isNone(yield* load))
      })
    )
  )
})

describe('PersistenceService version 1 migration', () => {
  const writeLegacy = (dir: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = path.join(dir, 'repo')
      const plain = path.join(dir, 'plain')
      const gone = path.join(dir, 'gone')
      yield* fs.makeDirectory(path.join(repo, '.git'), { recursive: true })
      yield* fs.makeDirectory(plain)
      const legacy = {
        tree: {
          _tag: 'Split',
          direction: 'row',
          sizes: [0.25, 0.25, 0.25, 0.25],
          children: [
            { _tag: 'Leaf', paneId: PANE_A, status: 'ready', cwd: plain },
            { _tag: 'Leaf', paneId: PANE_PENDING, status: 'pending' },
            {
              _tag: 'Leaf',
              paneId: PANE_B,
              status: 'ready',
              cwd: path.join(dir, 'wt'),
              sourceRepo: repo
            },
            { _tag: 'Leaf', paneId: PANE_C, status: 'ready', cwd: gone }
          ]
        },
        panes: {
          [PANE_A]: { config: config(PANE_A, plain), sessionId: 'session-a' },
          [PANE_B]: {
            config: {
              ...config(PANE_B, path.join(dir, 'wt')),
              worktree: { path: path.join(dir, 'wt'), branch: 'dia/brave-otter', sourceRepo: repo }
            }
          },
          [PANE_C]: { config: config(PANE_C, gone) }
        }
      }
      const raw = JSON.stringify(legacy)
      yield* fs.writeFileString(path.join(dir, 'workspace.json'), raw)
      return { repo, plain, gone, raw }
    })

  it.effect('creates one project per source directory, in the order of their first pane', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        const { repo, plain, gone } = yield* writeLegacy(dir)

        const workspace = Option.getOrThrow(yield* load)

        assert.deepStrictEqual(
          workspace.projects.map((entry) => entry.project.directory),
          [plain, repo, gone]
        )
      })
    )
  )

  it.effect('keeps every configured pane as a tab with its session and drops pending panes', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const workspace = Option.getOrThrow(yield* load)
        const tabs = workspace.projects.flatMap((entry) => entry.tabs)

        assert.deepStrictEqual(
          tabs.map((tab) => tab.config.paneId),
          [PANE_A, PANE_B, PANE_C]
        )
        assert.strictEqual(tabs[0].sessionId, 'session-a')
      })
    )
  )

  it.effect('names a worktree tab after its dia/ branch', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const workspace = Option.getOrThrow(yield* load)

        assert.strictEqual(workspace.projects[1].tabs[0].name, 'brave-otter')
      })
    )
  )

  it.effect('detects git repos and keeps a project whose directory no longer exists', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        const { gone } = yield* writeLegacy(dir)

        const workspace = Option.getOrThrow(yield* load)

        assert.deepStrictEqual(
          workspace.projects.map((entry) => entry.project.isGitRepo),
          [false, true, false]
        )
        assert.strictEqual(workspace.projects[2].project.directoryKey, yield* directoryKey(gone))
      })
    )
  )

  it.effect('shows the first migrated tab', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const workspace = Option.getOrThrow(yield* load)

        assert.deepStrictEqual(workspace.visibleTab, PANE_A)
      })
    )
  )

  it.effect('saves the migration, so a second load returns the same projects and names', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        yield* writeLegacy(dir)

        const first = Option.getOrThrow(yield* load)
        const second = Option.getOrThrow(yield* load)

        assert.deepStrictEqual(second, first)
      })
    )
  )

  it.effect('keeps the version 1 file as workspace.v1.json', () =>
    withPersistence((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { raw } = yield* writeLegacy(dir)

        yield* load

        assert.strictEqual(yield* fs.readFileString(`${dir}/workspace.v1.json`), raw)
      })
    )
  )
})

describe('PersistenceService activity', () => {
  it.effect('loads the activity lines it saved', () =>
    withPersistence(() =>
      Effect.gen(function* () {
        const service = yield* PersistenceService
        const activity = {
          [PANE_A]: Todo.make({ text: 'Fixing the bug' }),
          [PANE_B]: NoActivity.make({})
        }

        yield* service.saveActivity(activity)

        assert.deepStrictEqual(yield* service.loadActivity, activity)
      })
    )
  )

  it.effect('loads no activity when the file is missing', () =>
    withPersistence(() =>
      Effect.gen(function* () {
        const service = yield* PersistenceService

        assert.deepStrictEqual(yield* service.loadActivity, {})
      })
    )
  )
})
