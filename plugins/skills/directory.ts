import {
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  type PlatformError,
  Stream
} from 'effect'
import * as Arr from 'effect/Array'
import { readFrontmatter } from './frontmatter'
import type { Skill, SkillSource } from './registry'

/**
 * Where a directory's skills come from and how they are named. `group` is the picker heading;
 * `plugin`, when set, prefixes each name as `<plugin>:`.
 */
export interface SkillDirectory {
  readonly directory: string
  readonly group: string
  readonly plugin: Option.Option<string>
}

const DEBOUNCE = Duration.millis(200)

const isNotFound = (error: PlatformError.PlatformError): boolean => error.reason._tag === 'NotFound'

const skillOf = Effect.fnUntraced(function* (
  options: SkillDirectory,
  entry: string,
  text: string,
  file: string
) {
  const frontmatter = readFrontmatter(text)
  if (Option.isNone(frontmatter)) {
    yield* Effect.logWarning('SKILL.md has no readable frontmatter', { file })
  }
  const name = Option.flatMap(frontmatter, (fields) => fields.name)
  const description = Option.flatMap(frontmatter, (fields) => fields.description)
  const skill: Skill = {
    name: Option.match(options.plugin, {
      onNone: () => entry,
      onSome: (plugin) => `${plugin}:${Option.getOrElse(name, () => entry)}`
    }),
    description: Option.getOrElse(description, () => ''),
    group: options.group
  }
  return skill
})

const readSkill = Effect.fnUntraced(function* (options: SkillDirectory, entry: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(options.directory, entry, 'SKILL.md')
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap((text) => Effect.asSome(skillOf(options, entry, text, file))),
    Effect.catch((error) =>
      isNotFound(error) || error.reason._tag === 'BadResource'
        ? Effect.succeedNone
        : Effect.as(Effect.logWarning('Could not read SKILL.md', { file, error }), Option.none())
    )
  )
})

/**
 * The skills in `options.directory` now: one per subdirectory that holds a `SKILL.md`. Each is
 * named by its subdirectory, or `<plugin>:<frontmatter name or subdirectory>` when
 * `options.plugin` is set. `[]` when the directory does not exist or cannot be read. Use it for a
 * directory that changes only when another watched file changes, such as a versioned plugin
 * install; use {@link directorySkills} to follow a directory.
 */
export const readSkills = Effect.fnUntraced(function* (options: SkillDirectory) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(options.directory).pipe(
    Effect.catch((error) =>
      isNotFound(error)
        ? Effect.succeed([])
        : Effect.as(
            Effect.logWarning('Could not read skills directory', {
              directory: options.directory,
              error
            }),
            []
          )
    )
  )
  const skills = yield* Effect.forEach(entries, (entry) => readSkill(options, entry), {
    concurrency: 8
  })
  return Arr.getSomes(skills)
})

const watched = (
  target: string,
  recursive: boolean,
  keep: (event: FileSystem.WatchEvent) => boolean
): Stream.Stream<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const ready = yield* Deferred.make<void>()
      const targetRemoved = (event: FileSystem.WatchEvent) =>
        event._tag === 'Remove'
          ? Effect.map(fs.exists(target), (exists) => !exists).pipe(
              Effect.orElseSucceed(() => false)
            )
          : Effect.succeed(false)
      const events = fs
        .watch(target, { recursive, onReady: () => Deferred.doneUnsafe(ready, Exit.void) })
        .pipe(Stream.takeUntilEffect(targetRemoved), Stream.filter(keep), Stream.debounce(DEBOUNCE))
      return Stream.merge(Stream.fromEffect(Deferred.await(ready)), Stream.as(events, undefined))
    })
  )

const endOnWatchFailure =
  (target: string) =>
  <R>(stream: Stream.Stream<void, PlatformError.PlatformError, R>) =>
    stream.pipe(
      Stream.catchTag('PlatformError', (error) =>
        Stream.fromEffect(Effect.logWarning('Stopped watching', { path: target, error }))
      )
    )

/**
 * Emits once when its watcher is installed, then once after changes at `path` (recursive for a
 * directory) pause for 200 ms. While `path` does not exist it watches the parent directory
 * non-recursively, emits nothing for siblings, and switches to `path` when an event names it; if
 * the parent does not exist either it emits once and ends. When `path` is removed while watched,
 * it follows `path` again as a missing path. Exported for sources that follow files
 * other than a skills directory, such as Claude Code's settings files.
 */
export const pathChanges = (
  path: string
): Stream.Stream<void, never, FileSystem.FileSystem | Path.Path> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      const info = yield* fs.stat(path).pipe(Effect.option)
      if (Option.isSome(info)) {
        const removed = fs.exists(path).pipe(
          Effect.orElseSucceed(() => true),
          Effect.map((exists) => !exists)
        )
        return watched(path, info.value.type === 'Directory', () => true).pipe(
          endOnWatchFailure(path),
          Stream.concat(
            Stream.unwrap(Effect.map(removed, (gone) => (gone ? pathChanges(path) : Stream.empty)))
          )
        )
      }
      const parent = paths.dirname(path)
      const name = paths.basename(path)
      if (!(yield* fs.exists(parent).pipe(Effect.orElseSucceed(() => false)))) {
        return Stream.make(undefined)
      }
      yield* Effect.logDebug('Watching the parent of a missing path', { path, parent })
      const untilCreated = watched(parent, false, (event) => paths.basename(event.path) === name)
      return untilCreated.pipe(
        Stream.take(2),
        Stream.concat(Stream.suspend(() => pathChanges(path))),
        endOnWatchFailure(parent)
      )
    })
  )

/** `readSkills(options)` when its watcher is installed, and again after each change under the directory. */
export const directorySkills = (
  options: SkillDirectory
): Stream.Stream<ReadonlyArray<Skill>, never, FileSystem.FileSystem | Path.Path> =>
  pathChanges(options.directory).pipe(Stream.mapEffect(() => readSkills(options)))

/**
 * A source with id `id` whose skills are `directorySkills(options)` for every context. The source
 * keeps the `FileSystem` and `Path` it was built with, so its stream needs no services.
 */
export const directorySource = Effect.fnUntraced(function* (id: string, options: SkillDirectory) {
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const source: SkillSource = {
    id,
    skills: () => directorySkills(options).pipe(Stream.provideContext(services))
  }
  return source
})
