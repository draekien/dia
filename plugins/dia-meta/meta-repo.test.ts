import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { ensureMetaRepo, makeMetaRepo } from './meta-repo'

const scratchRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-meta-' })
  return { fs, path, directory: path.join(root, 'repo') }
})

const git = (directory: string, ...args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make('git', [...args]).pipe(ChildProcess.setCwd(directory)))
  ).pipe(Effect.map((output) => output.trim()))

describe('ensureMetaRepo', () => {
  it.effect('creates instructions.md and the plugin manifest in a new directory', () =>
    Effect.gen(function* () {
      const { fs, path, directory } = yield* scratchRepo

      yield* ensureMetaRepo(directory, yield* makeGit)

      assert.strictEqual(yield* fs.readFileString(path.join(directory, 'instructions.md')), '')
      const manifest = JSON.parse(
        yield* fs.readFileString(path.join(directory, 'plugin', '.claude-plugin', 'plugin.json'))
      )
      assert.strictEqual(manifest.name, 'dia-meta')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('makes the directory a git repo whose one commit holds both files', () =>
    Effect.gen(function* () {
      const { directory } = yield* scratchRepo

      yield* ensureMetaRepo(directory, yield* makeGit)

      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
      assert.deepStrictEqual((yield* git(directory, 'ls-files')).split('\n').sort(), [
        'instructions.md',
        'plugin/.claude-plugin/plugin.json'
      ])
      assert.strictEqual(yield* git(directory, 'status', '--porcelain'), '')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('commits the files on a later start when the first commit did not happen', () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* scratchRepo
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* git(directory, 'init')

      yield* ensureMetaRepo(directory, yield* makeGit)

      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('keeps an existing instructions.md and adds no commit on a later start', () =>
    Effect.gen(function* () {
      const { fs, path, directory } = yield* scratchRepo
      yield* ensureMetaRepo(directory, yield* makeGit)
      yield* fs.writeFileString(path.join(directory, 'instructions.md'), 'Prefer rg over grep.')

      yield* ensureMetaRepo(directory, yield* makeGit)

      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, 'instructions.md')),
        'Prefer rg over grep.'
      )
      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe('makeMetaRepo', () => {
  it.effect('offers the trimmed instructions and the plugin directory', () =>
    Effect.gen(function* () {
      const { fs, path, directory } = yield* scratchRepo
      yield* ensureMetaRepo(directory, yield* makeGit)
      yield* fs.writeFileString(path.join(directory, 'instructions.md'), '\nUse pnpm.\n\n')
      const repo = yield* makeMetaRepo(directory, Effect.succeed(Option.some(yield* makeGit)))

      const additions = yield* repo.forNewSession

      assert.deepStrictEqual(additions, {
        systemPromptAppend: 'Use pnpm.',
        pluginPaths: [path.join(directory, 'plugin')]
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('reads an instructions change made after it was created', () =>
    Effect.gen(function* () {
      const { fs, path, directory } = yield* scratchRepo
      yield* ensureMetaRepo(directory, yield* makeGit)
      const repo = yield* makeMetaRepo(directory, Effect.succeed(Option.some(yield* makeGit)))
      const before = yield* repo.forNewSession

      yield* fs.writeFileString(path.join(directory, 'instructions.md'), 'Use pnpm.')
      const after = yield* repo.forNewSession

      assert.strictEqual(before.systemPromptAppend, '')
      assert.strictEqual(after.systemPromptAppend, 'Use pnpm.')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('appends nothing when instructions.md cannot be read', () =>
    Effect.gen(function* () {
      const { directory } = yield* scratchRepo
      const repo = yield* makeMetaRepo(directory, Effect.succeed(Option.some(yield* makeGit)))

      const additions = yield* repo.forNewSession

      assert.strictEqual(additions.systemPromptAppend, '')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
