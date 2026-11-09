import { Duration, Effect, Option, Stream, SubscriptionRef } from 'effect'
import * as Arr from 'effect/Array'
import {
  type Skill,
  type SkillContext,
  SkillResolution,
  type SkillSource,
  SkillSourceIdTaken,
  type SkillSourceRegistry
} from './registry'

type Sources = ReadonlyMap<string, SkillSource>

const byGroupThenName = (left: Skill, right: Skill): number =>
  left.group.localeCompare(right.group) || left.name.localeCompare(right.name)

const sameSkill = (left: Skill, right: Skill): boolean =>
  left.name === right.name && left.description === right.description && left.group === right.group

const sameSkills = (left: ReadonlyArray<Skill>, right: ReadonlyArray<Skill>): boolean =>
  left.length === right.length &&
  left.every((skill, index) => sameSkill(skill, right[index] as Skill))

const skillsOf = (sources: Sources, context: SkillContext): Stream.Stream<ReadonlyArray<Skill>> => {
  if (sources.size === 0) return Stream.make([])
  const streams = [...sources.values()].map((source) => source.skills(context))
  return Stream.zipLatestAll(...streams).pipe(
    Stream.map((lists: ReadonlyArray<ReadonlyArray<Skill>>) => lists.flat().sort(byGroupThenName))
  )
}

const RESOLVE_TIME_LIMIT = Duration.seconds(2)

const resolveIn = (
  sources: Sources,
  names: ReadonlyArray<string>,
  context: SkillContext
): Effect.Effect<Option.Option<SkillResolution>> =>
  Effect.forEach(
    [...sources.values()],
    (source) =>
      source.skills(context).pipe(
        Stream.runHead,
        Effect.map((skills) => ({
          source,
          names: new Set(Option.getOrElse(skills, () => []).map((skill) => skill.name))
        }))
      ),
    { concurrency: 'unbounded' }
  ).pipe(
    Effect.map((listed) =>
      SkillResolution.make({
        missing: names.filter((name) => !listed.some((entry) => entry.names.has(name))),
        pluginPaths: Arr.dedupe(
          Arr.getSomes(
            listed
              .filter((entry) => names.some((name) => entry.names.has(name)))
              .map((entry) => entry.source.pluginPath)
          )
        )
      })
    ),
    Effect.timeoutOption(RESOLVE_TIME_LIMIT)
  )

/** Makes an empty skill source registry. Call it once, in `skills`' host setup. */
export const makeRegistry: Effect.Effect<SkillSourceRegistry> = Effect.gen(function* () {
  const ref = yield* SubscriptionRef.make<Sources>(new Map())

  const add = (source: SkillSource) =>
    SubscriptionRef.modifyEffect(ref, (sources) =>
      sources.has(source.id)
        ? Effect.fail(new SkillSourceIdTaken({ id: source.id }))
        : Effect.succeed([source, new Map(sources).set(source.id, source)] as const)
    )

  const remove = (source: SkillSource) =>
    SubscriptionRef.update(ref, (sources) => {
      if (sources.get(source.id) !== source) return sources
      const next = new Map(sources)
      next.delete(source.id)
      return next
    }).pipe(Effect.tap(() => Effect.logInfo('Skill source removed', { id: source.id })))

  const register: SkillSourceRegistry['register'] = (source) =>
    Effect.acquireRelease(add(source), remove).pipe(
      Effect.tap(() => Effect.logInfo('Skill source registered', { id: source.id })),
      Effect.tapError(() => Effect.logWarning('Skill source refused', { id: source.id })),
      Effect.asVoid
    )

  return {
    register,
    skills: (context) =>
      SubscriptionRef.changes(ref).pipe(
        Stream.switchMap((sources) => skillsOf(sources, context)),
        Stream.changesWith(sameSkills)
      ),
    resolve: (names, context) =>
      Effect.gen(function* () {
        const sources = yield* SubscriptionRef.get(ref)
        const resolution =
          sources.size === 0 ? Option.none() : yield* resolveIn(sources, names, context)
        yield* Effect.logDebug('Resolved skill names', {
          names: names.length,
          sources: sources.size,
          resolved: Option.isSome(resolution)
        })
        return resolution
      })
  }
})
