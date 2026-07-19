import { Effect, Random } from 'effect'

const ADJECTIVES = [
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

const NOUNS = [
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
 * Produces a friendly, human-readable worktree slug of the form
 * `adjective-noun` (e.g. `brave-otter`), for naming a pane's git worktree
 * branch and directory in place of an opaque UUID. Draws both words at random
 * from fixed word lists, so it is deterministic under a seeded `Random`
 * (e.g. the test runtime). It is **not** guaranteed unique on its own -- the
 * caller must collision-check the resulting branch/directory against what
 * already exists and call again to regenerate on a clash.
 */
export const generateWorktreeSlug = Effect.fn('generateWorktreeSlug')(function* () {
  const adjective = yield* Random.choice(ADJECTIVES)
  const noun = yield* Random.choice(NOUNS)
  return `${adjective}-${noun}`
})
