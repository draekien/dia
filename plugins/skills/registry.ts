import { ServiceKey } from '@dia/plugin'
import { type Effect, type Option, Predicate, Schema, type Scope, type Stream } from 'effect'

/**
 * A skill a session can load. `name` is the name `Options.skills` takes, for example
 * `dia-meta:code-review`; `group` is the heading the picker lists it under.
 */
export const Skill = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.String,
  group: Schema.NonEmptyString
})
/** The decoded type of {@link Skill}. */
export type Skill = typeof Skill.Type

/** What a source's skills depend on: the project directory a session would run in, if any. */
export interface SkillContext {
  readonly cwd: Option.Option<string>
}

/**
 * A provider of skills. `id` names the source in the registry. `skills(context)` emits the
 * source's current skills at once and again whenever they change; it never fails.
 */
export interface SkillSource {
  readonly id: string
  readonly skills: (context: SkillContext) => Stream.Stream<ReadonlyArray<Skill>>
}

/** `register` refused the source `id`: another source holds that id. */
export class SkillSourceIdTaken extends Schema.TaggedError<SkillSourceIdTaken>()(
  'SkillSourceIdTaken',
  { id: Schema.String }
) {}

/**
 * Every skill source dia knows. Read it with `ctx.whenProvided([SkillSourceRegistryKey], …)`.
 */
export interface SkillSourceRegistry {
  /**
   * Adds `source` until the calling scope closes. Call it inside `whenProvided`, once per source,
   * so the source is removed when the caller or `skills` closes and added again when both are
   * open. Fails with {@link SkillSourceIdTaken} when another source holds `source.id`.
   */
  readonly register: (source: SkillSource) => Effect.Effect<void, SkillSourceIdTaken, Scope.Scope>
  /**
   * Every registered source's skills for `context`, sorted by group then name: the list now, then
   * the whole list again after each change to a source or to the set of sources.
   */
  readonly skills: (context: SkillContext) => Stream.Stream<ReadonlyArray<Skill>>
}

const MEMBERS: Record<keyof SkillSourceRegistry, (member: unknown) => boolean> = {
  register: Predicate.isFunction,
  skills: Predicate.isFunction
}

/** Whether `value` has every {@link SkillSourceRegistry} member. */
export const isSkillSourceRegistry = (value: unknown): value is SkillSourceRegistry =>
  Object.entries(MEMBERS).every(
    ([member, check]) => Predicate.hasProperty(value, member) && check(value[member])
  )

/** The key the `skills` plugin provides its {@link SkillSourceRegistry} under. */
export const SkillSourceRegistryKey = ServiceKey.make('skillSourceRegistry', isSkillSourceRegistry)
