import { assert, describe, it } from '@effect/vitest'
import { capToolOutput, TOOL_OUTPUT_LIMIT } from './agent-event'

describe('capToolOutput', () => {
  it('keeps an output of exactly the limit unchanged', () => {
    const output = 'x'.repeat(TOOL_OUTPUT_LIMIT)

    assert.strictEqual(capToolOutput(output), output)
  })

  it('cuts an output one character over the limit and says one character was omitted', () => {
    const kept = 'a'.repeat(TOOL_OUTPUT_LIMIT)

    assert.strictEqual(
      capToolOutput(`${kept}b`),
      `${kept}\n[output truncated: 1 characters omitted]`
    )
  })

  it('caps at 256 KiB characters', () => {
    assert.strictEqual(TOOL_OUTPUT_LIMIT, 262_144)
  })
})
