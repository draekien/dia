import * as NodeServices from '@effect/platform-node/NodeServices'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, FileSystem, Option, Path, Queue, Stream } from 'effect'
import { directorySkills, pathChanges, readSkills } from './directory'

const WAIT = Duration.seconds(5)
const QUIET = Duration.millis(800)

const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'dia-skills-' })
  const writeSkill = (directory: string, entry: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(directory, entry), { recursive: true })
      yield* fs.writeFileString(path.join(directory, entry, 'SKILL.md'), text)
    })
  return { fs, path, root, writeSkill }
})

const follow = <A>(stream: Stream.Stream<A, never, FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const emitted = yield* Queue.unbounded<A>()
    yield* Effect.forkScoped(Stream.runForEach(stream, (value) => Queue.offer(emitted, value)))
    return emitted
  })

const next = <A>(emitted: Queue.Queue<A>) => Queue.take(emitted).pipe(Effect.timeout(WAIT))

const userSkills = (directory: string) => ({
  directory,
  group: 'Your skills',
  plugin: Option.none<string>()
})

describe('readSkills', () => {
  it.effect('names a skill by its directory and reads its description', () =>
    Effect.gen(function* () {
      const { root, writeSkill } = yield* scratch
      yield* writeSkill(root, 'review', '---\nname: other\ndescription: Reviews a diff\n---\n')

      assert.deepStrictEqual(yield* readSkills(userSkills(root)), [
        { name: 'review', description: 'Reviews a diff', group: 'Your skills' }
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect("names a plugin's skill <plugin>:<frontmatter name>", () =>
    Effect.gen(function* () {
      const { root, writeSkill } = yield* scratch
      yield* writeSkill(root, 'plan-dir', '---\nname: plan\ndescription: Plans work\n---\n')

      const skills = yield* readSkills({
        directory: root,
        group: 'Meta repo',
        plugin: Option.some('dia-meta')
      })

      assert.deepStrictEqual(skills, [
        { name: 'dia-meta:plan', description: 'Plans work', group: 'Meta repo' }
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('lists a SKILL.md without readable frontmatter with an empty description', () =>
    Effect.gen(function* () {
      const { root, writeSkill } = yield* scratch
      yield* writeSkill(root, 'notes', '# Notes\n')

      assert.deepStrictEqual(yield* readSkills(userSkills(root)), [
        { name: 'notes', description: '', group: 'Your skills' }
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('skips a subdirectory without a SKILL.md and a file beside the skills', () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* scratch
      yield* fs.makeDirectory(path.join(root, 'empty'))
      yield* fs.writeFileString(path.join(root, 'README.md'), '# skills')

      assert.deepStrictEqual(yield* readSkills(userSkills(root)), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.effect('lists no skill for a directory that does not exist', () =>
    Effect.gen(function* () {
      const { path, root } = yield* scratch

      assert.deepStrictEqual(yield* readSkills(userSkills(path.join(root, 'missing'))), [])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe('directorySkills', () => {
  it.live('emits a SKILL.md written after the first emission', () =>
    Effect.gen(function* () {
      const { root, writeSkill } = yield* scratch
      const emitted = yield* follow(directorySkills(userSkills(root)))
      assert.deepStrictEqual(yield* next(emitted), [])

      yield* writeSkill(root, 'review', '---\ndescription: Reviews a diff\n---\n')

      assert.deepStrictEqual(yield* next(emitted), [
        { name: 'review', description: 'Reviews a diff', group: 'Your skills' }
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('emits the skills of a directory created after the first emission', () =>
    Effect.gen(function* () {
      const { path, root, writeSkill } = yield* scratch
      const directory = path.join(root, 'skills')
      const emitted = yield* follow(directorySkills(userSkills(directory)))
      assert.deepStrictEqual(yield* next(emitted), [])

      yield* writeSkill(directory, 'review', '---\ndescription: Reviews a diff\n---\n')

      const skills = yield* Stream.fromQueue(emitted).pipe(
        Stream.filter((list) => list.length > 0),
        Stream.runHead,
        Effect.timeout(WAIT)
      )
      assert.deepStrictEqual(
        skills,
        Option.some([{ name: 'review', description: 'Reviews a diff', group: 'Your skills' }])
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})

describe('pathChanges', () => {
  it.live('does not emit for a sibling of a missing path', () =>
    Effect.gen(function* () {
      const { fs, path, root } = yield* scratch
      const emitted = yield* follow(pathChanges(path.join(root, 'settings.json')))
      yield* next(emitted)

      yield* fs.writeFileString(path.join(root, 'other.json'), '{}')
      yield* Effect.sleep(QUIET)

      assert.strictEqual(yield* Queue.size(emitted), 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )

  it.live('emits once and ends when the parent of the path does not exist', () =>
    Effect.gen(function* () {
      const { path, root } = yield* scratch

      const emissions = yield* pathChanges(path.join(root, 'missing', 'settings.json')).pipe(
        Stream.runCount,
        Effect.timeout(WAIT)
      )

      assert.strictEqual(emissions, 1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  )
})
