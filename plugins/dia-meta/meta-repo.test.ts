import { makeGit } from '@dia-plugin/dia-git/git'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Effect, FileSystem, Option, Path } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { ensureMetaRepo, makeMetaRepo } from './meta-repo'

const SHIPPED_SKILL = '---\nname: building-dia-plugins\n---\n\nWrite plugin.json first.\n'
const SHIPPED_REFERENCE = '# @dia/plugin API reference\n\n### MetaRepoKey\n'
const CHANGED_REFERENCE = `${SHIPPED_REFERENCE}\n### WorktreesKey\n`
const SKILL_PATH = 'plugin/skills/building-dia-plugins/SKILL.md'
const REFERENCE_PATH = 'plugin/skills/building-dia-plugins/references/api.md'
const SKILL_COMMIT_SUBJECT = 'docs: update the built-in building-dia-plugins skill'

const scratchRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-meta-' })
  const skillSource = path.join(root, 'shipped', 'building-dia-plugins')
  const ship = (file: string, content: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(skillSource, file)), { recursive: true })
      yield* fs.writeFileString(path.join(skillSource, file), content)
    })
  yield* ship('SKILL.md', SHIPPED_SKILL)
  yield* ship('references/api.md', SHIPPED_REFERENCE)
  return { fs, path, root, directory: path.join(root, 'repo'), skillSource, ship }
})

const git = (directory: string, ...args: ReadonlyArray<string>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.string(ChildProcess.make('git', [...args]).pipe(ChildProcess.setCwd(directory)))
  ).pipe(Effect.map((output) => output.trim()))

describe('ensureMetaRepo', () => {
  it.effect('creates instructions.md and the plugin manifest in a new directory', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource } = yield* scratchRepo

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* fs.readFileString(path.join(directory, 'instructions.md')), '')
      const manifest = JSON.parse(
        yield* fs.readFileString(path.join(directory, 'plugin', '.claude-plugin', 'plugin.json'))
      )
      assert.strictEqual(manifest.name, 'dia-meta')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('copies the shipped building-dia-plugins skill and its API reference', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource } = yield* scratchRepo

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* fs.readFileString(path.join(directory, SKILL_PATH)), SHIPPED_SKILL)
      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, REFERENCE_PATH)),
        SHIPPED_REFERENCE
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('makes the directory a git repo whose one commit holds every created file', () =>
    Effect.gen(function* () {
      const { directory, skillSource } = yield* scratchRepo

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
      assert.deepStrictEqual((yield* git(directory, 'ls-files')).split('\n').sort(), [
        'instructions.md',
        'plugin/.claude-plugin/plugin.json',
        SKILL_PATH,
        REFERENCE_PATH
      ])
      assert.strictEqual(yield* git(directory, 'status', '--porcelain'), '')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('commits the files on a later start when the first commit did not happen', () =>
    Effect.gen(function* () {
      const { fs, directory, skillSource } = yield* scratchRepo
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* git(directory, 'init')

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('keeps an existing instructions.md and adds no commit on a later start', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
      yield* fs.writeFileString(path.join(directory, 'instructions.md'), 'Prefer rg over grep.')

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, 'instructions.md')),
        'Prefer rg over grep.'
      )
      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('keeps an edited SKILL.md uncommitted when a later dia ships a different one', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource, ship } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
      yield* fs.writeFileString(path.join(directory, SKILL_PATH), 'Edited by the meta agent.')
      yield* ship('SKILL.md', `${SHIPPED_SKILL}A newer starting text.\n`)

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, SKILL_PATH)),
        'Edited by the meta agent.'
      )
      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('rewrites a changed API reference and commits it on its own', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource, ship } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
      yield* ship('references/api.md', CHANGED_REFERENCE)

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, REFERENCE_PATH)),
        CHANGED_REFERENCE
      )
      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '2')
      assert.strictEqual(
        yield* git(directory, 'show', '--name-only', '--format=%s', 'HEAD'),
        `${SKILL_COMMIT_SUBJECT}\n\n${REFERENCE_PATH}`
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('restores an edited API reference to the shipped one and commits it', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
      yield* fs.writeFileString(path.join(directory, REFERENCE_PATH), 'Edited by hand.')
      yield* git(
        directory,
        '-c',
        'user.name=tester',
        '-c',
        'user.email=tester@localhost',
        'commit',
        '-qam',
        'docs: edit the reference'
      )

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(
        yield* fs.readFileString(path.join(directory, REFERENCE_PATH)),
        SHIPPED_REFERENCE
      )
      assert.strictEqual(yield* git(directory, 'status', '--porcelain'), '')
      assert.strictEqual(yield* git(directory, 'log', '-1', '--format=%s'), SKILL_COMMIT_SUBJECT)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('treats an API reference that differs only in CRLF line endings as unchanged', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
      const crlf = SHIPPED_REFERENCE.replaceAll('\n', '\r\n')
      yield* fs.writeFileString(path.join(directory, REFERENCE_PATH), crlf)

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* fs.readFileString(path.join(directory, REFERENCE_PATH)), crlf)
      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('adds no commit when the shipped API reference is unchanged', () =>
    Effect.gen(function* () {
      const { directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '1')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('commits the skill into a meta repo created before dia shipped it', () =>
    Effect.gen(function* () {
      const { fs, path, root, directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, path.join(root, 'nothing-shipped'), yield* makeGit)

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(yield* fs.readFileString(path.join(directory, SKILL_PATH)), SHIPPED_SKILL)
      assert.strictEqual(yield* git(directory, 'rev-list', '--count', 'HEAD'), '2')
      assert.deepStrictEqual(
        (yield* git(directory, 'show', '--name-only', '--format=', 'HEAD')).split('\n').sort(),
        [SKILL_PATH, REFERENCE_PATH]
      )
      assert.strictEqual(yield* git(directory, 'status', '--porcelain'), '')
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('leaves staged and unstaged changes to other files out of the skill commit', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource, ship } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
      yield* fs.writeFileString(path.join(directory, 'instructions.md'), 'Use pnpm.')
      yield* git(directory, 'add', 'instructions.md')
      yield* fs.writeFileString(path.join(directory, SKILL_PATH), 'Edited by the meta agent.')
      yield* ship('references/api.md', CHANGED_REFERENCE)

      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)

      assert.strictEqual(
        yield* git(directory, 'show', '--name-only', '--format=', 'HEAD'),
        REFERENCE_PATH
      )
      assert.deepStrictEqual((yield* git(directory, 'status', '--porcelain')).split('\n'), [
        'M  instructions.md',
        ` M ${SKILL_PATH}`
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('creates the rest of the repo when dia shipped no skill files', () =>
    Effect.gen(function* () {
      const { fs, path, root, directory } = yield* scratchRepo

      yield* ensureMetaRepo(directory, path.join(root, 'nothing-shipped'), yield* makeGit)

      assert.deepStrictEqual((yield* git(directory, 'ls-files')).split('\n').sort(), [
        'instructions.md',
        'plugin/.claude-plugin/plugin.json'
      ])
      assert.isFalse(yield* fs.exists(path.join(directory, 'plugin', 'skills')))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe('makeMetaRepo', () => {
  it.effect('offers the trimmed instructions and the plugin directory', () =>
    Effect.gen(function* () {
      const { fs, path, directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
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
      const { fs, path, directory, skillSource } = yield* scratchRepo
      yield* ensureMetaRepo(directory, skillSource, yield* makeGit)
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
