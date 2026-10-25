import { AGENT_NAME_ADJECTIVES, AGENT_NAME_NOUNS } from '@dia/plugin'
import { Effect, Random } from 'effect'

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
  const adjective = yield* Random.choice(AGENT_NAME_ADJECTIVES)
  const noun = yield* Random.choice(AGENT_NAME_NOUNS)
  return `${adjective}-${noun}`
})
