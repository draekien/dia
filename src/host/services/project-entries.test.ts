import { makeGit } from '@dia-plugin/dia-git/git'
import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import type { ProjectEntry } from '@shared/domain/attachment'
import type { PluginRegistry } from '@shared/plugin/plugin-registry'
import { ServiceWithdrawnError } from '@shared/plugin/plugin-registry'
import { fakeUse } from '@shared/plugin/plugin-registry.fake'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { HostPlugins } from '../plugins/host-plugins'
import type { Git } from './git-seam'
import { GitKey } from './git-seam'
import { entriesFromFiles, ProjectEntries, ProjectEntriesLive } from './project-entries'

describe('entriesFromFiles', () => {
  it('lists every directory the files lie in before the files, each in path order', () => {
    assert.deepStrictEqual(entriesFromFiles(['src/b.ts', 'README.md', 'src/lib/a.ts']), [
      { path: 'src', kind: 'directory' },
      { path: 'src/lib', kind: 'directory' },
      { path: 'README.md', kind: 'file' },
      { path: 'src/b.ts', kind: 'file' },
      { path: 'src/lib/a.ts', kind: 'file' }
    ])
  })

  it('stops at the limit', () => {
    assert.strictEqual(entriesFromFiles(['a/1', 'a/2', 'a/3'], 2).length, 2)
  })

  it('lists nothing for no files', () => {
    assert.deepStrictEqual(entriesFromFiles([]), [])
  })
})

type GitProvider = 'provided' | 'not loaded' | 'withdrawn'

const pluginsWith = (provider: GitProvider) =>
  Layer.effect(
    HostPlugins,
    Effect.gen(function* () {
      const git = yield* makeGit
      const read = (key: string) =>
        provider === 'provided' && key === GitKey.name ? Option.some<Git>(git) : Option.none()
      const use: PluginRegistry['use'] =
        provider === 'withdrawn'
          ? () =>
              Effect.fail(
                new ServiceWithdrawnError({
                  key: GitKey.name,
                  plugin: 'dia-git',
                  message: 'The "dia-git" plugin closed while a call using "git" was running'
                })
              )
          : fakeUse(read)
      return { use } as unknown as PluginRegistry
    })
  )

const entriesLayer = (provider: GitProvider) =>
  Layer.provideMerge(
    ProjectEntriesLive,
    Layer.merge(Layer.provide(pluginsWith(provider), NodeServices.layer), NodeServices.layer)
  )

const sorted = (entries: ReadonlyArray<ProjectEntry>) =>
  [...entries].sort((a, b) => a.path.localeCompare(b.path))

const repoWithIgnoredFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-entries-git-' })
  yield* spawner.exitCode(ChildProcess.make('git', ['init', '-q']).pipe(ChildProcess.setCwd(root)))
  yield* Effect.addFinalizer(() =>
    spawner
      .exitCode(
        ChildProcess.make('git', ['fsmonitor--daemon', 'stop']).pipe(ChildProcess.setCwd(root))
      )
      .pipe(Effect.ignore)
  )
  yield* fs.writeFileString(path.join(root, '.gitignore'), 'secret.env\n')
  yield* fs.writeFileString(path.join(root, 'secret.env'), '')
  yield* fs.writeFileString(path.join(root, 'a.ts'), '')
  return root
})

const ALL_FILES = [
  { path: '.gitignore', kind: 'file' },
  { path: 'a.ts', kind: 'file' },
  { path: 'secret.env', kind: 'file' }
]

describe('ProjectEntries', () => {
  it.effect('lists a git repository through dia-git, leaving out ignored files', () =>
    Effect.gen(function* () {
      const root = yield* repoWithIgnoredFile

      const entries = yield* (yield* ProjectEntries).list(root)

      assert.deepStrictEqual(
        sorted(entries),
        ALL_FILES.filter((entry) => entry.path !== 'secret.env')
      )
    }).pipe(Effect.scoped, Effect.provide(entriesLayer('provided')))
  )

  it.effect('walks a git repository while dia-git is not loaded', () =>
    Effect.gen(function* () {
      const root = yield* repoWithIgnoredFile

      const entries = yield* (yield* ProjectEntries).list(root)

      assert.deepStrictEqual(sorted(entries), ALL_FILES)
    }).pipe(Effect.scoped, Effect.provide(entriesLayer('not loaded')))
  )

  it.effect('walks a git repository when dia-git closes during the call', () =>
    Effect.gen(function* () {
      const root = yield* repoWithIgnoredFile

      const entries = yield* (yield* ProjectEntries).list(root)

      assert.deepStrictEqual(sorted(entries), ALL_FILES)
    }).pipe(Effect.scoped, Effect.provide(entriesLayer('withdrawn')))
  )

  it.effect('walks a directory outside git, skipping node_modules', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-entries-' })
      yield* fs.makeDirectory(path.join(root, 'src'))
      yield* fs.makeDirectory(path.join(root, 'node_modules', 'pkg'), { recursive: true })
      yield* fs.writeFileString(path.join(root, 'src', 'a.ts'), '')
      yield* fs.writeFileString(path.join(root, 'node_modules', 'pkg', 'index.js'), '')

      const entries = yield* (yield* ProjectEntries).list(root)

      assert.deepStrictEqual(sorted(entries), [
        { path: 'src', kind: 'directory' },
        { path: 'src/a.ts', kind: 'file' }
      ])
    }).pipe(Effect.scoped, Effect.provide(entriesLayer('provided')))
  )

  it.effect('lists nothing for a directory that does not exist', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-entries-' })
      const entries = yield* (yield* ProjectEntries).list(path.join(root, 'missing'))
      assert.deepStrictEqual(entries, [])
    }).pipe(Effect.scoped, Effect.provide(entriesLayer('provided')))
  )
})
