import { NodeServices } from '@effect/platform-node'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
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

describe('ProjectEntries', () => {
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

      assert.deepStrictEqual(
        [...entries].sort((a, b) => a.path.localeCompare(b.path)),
        [
          { path: 'src', kind: 'directory' },
          { path: 'src/a.ts', kind: 'file' }
        ]
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProjectEntriesLive, NodeServices.layer))
    )
  )

  it.effect('lists nothing for a directory that does not exist', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-entries-' })
      const entries = yield* (yield* ProjectEntries).list(path.join(root, 'missing'))
      assert.deepStrictEqual(entries, [])
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProjectEntriesLive, NodeServices.layer))
    )
  )
})
