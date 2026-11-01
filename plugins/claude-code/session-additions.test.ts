import { assert, describe, it } from '@effect/vitest'
import { sessionAdditionsOptions } from './session-additions'

describe('sessionAdditionsOptions', () => {
  it('uses the Claude Code preset without an append or plugins when nothing is added', () => {
    assert.deepStrictEqual(sessionAdditionsOptions({ systemPromptAppend: '', pluginPaths: [] }), {
      systemPrompt: { type: 'preset', preset: 'claude_code' }
    })
  })

  it('appends the text to the Claude Code preset', () => {
    assert.deepStrictEqual(
      sessionAdditionsOptions({ systemPromptAppend: 'Use pnpm.', pluginPaths: [] }).systemPrompt,
      { type: 'preset', preset: 'claude_code', append: 'Use pnpm.' }
    )
  })

  it('loads each plugin path as a local plugin, in order', () => {
    assert.deepStrictEqual(
      sessionAdditionsOptions({ systemPromptAppend: '', pluginPaths: ['/meta/plugin', '/other'] })
        .plugins,
      [
        { type: 'local', path: '/meta/plugin' },
        { type: 'local', path: '/other' }
      ]
    )
  })
})
