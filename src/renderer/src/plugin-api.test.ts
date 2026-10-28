// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

describe('plugin-api actions', () => {
  it('binds every action when lib/actions is evaluated before plugin-api', async () => {
    await import('./lib/actions')
    const { actions } = await import('./plugin-api')

    const unbound = Object.entries(actions)
      .filter(([, action]) => typeof action !== 'function')
      .map(([name]) => name)

    expect(unbound).toEqual([])
  })
})
