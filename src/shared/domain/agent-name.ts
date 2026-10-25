import { Effect, Random } from 'effect'
import { AgentName } from './project'

/** The first words of generated agent names and worktree slugs. */
export const AGENT_NAME_ADJECTIVES = [
  'amber',
  'brave',
  'bright',
  'calm',
  'clever',
  'crimson',
  'dapper',
  'eager',
  'fuzzy',
  'gentle',
  'golden',
  'happy',
  'jolly',
  'keen',
  'lively',
  'lucky',
  'mellow',
  'nimble',
  'plucky',
  'quiet',
  'rapid',
  'shiny',
  'silver',
  'swift',
  'tidy',
  'witty'
] as const

/** The second words of generated agent names and worktree slugs. */
export const AGENT_NAME_NOUNS = [
  'otter',
  'falcon',
  'maple',
  'harbor',
  'comet',
  'willow',
  'ember',
  'pebble',
  'meadow',
  'lantern',
  'badger',
  'cedar',
  'ferret',
  'glacier',
  'heron',
  'jasper',
  'koala',
  'lynx',
  'marmot',
  'newt',
  'osprey',
  'panda',
  'quail',
  'raven',
  'sparrow',
  'thistle'
] as const

/**
 * An `adjective-noun` agent name (for example `brave-otter`) for a tab the user did not name.
 * Deterministic under a seeded `Random`. Not unique: two tabs can get the same name.
 */
export const generateAgentName: Effect.Effect<AgentName> = Effect.gen(function* () {
  const adjective = yield* Random.choice(AGENT_NAME_ADJECTIVES)
  const noun = yield* Random.choice(AGENT_NAME_NOUNS)
  return AgentName.make(`${adjective}-${noun}`)
})
