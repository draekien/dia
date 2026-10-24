import type { PluginInfo, PluginOverrideResult } from '@shared/plugin/manifest'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { type DiaToolResult, makePluginTools } from './dia-tools'

const info = (name: string, status: PluginInfo['status'] = { _tag: 'Loaded' }): PluginInfo => ({
  name,
  category: 'feature',
  origin: 'default',
  root: `plugins/${name}`,
  status,
  memoryBytes: 0,
  provides: []
})

const harness = (
  script: {
    readonly reloadResult?: (name: string) => PluginInfo
    readonly overrideResult?: PluginOverrideResult
  } = {}
) => {
  const log: Array<string> = []
  const tools = makePluginTools({
    reload: (name) =>
      Effect.sync(() => {
        log.push(`reload:${name}`)
        return (script.reloadResult ?? info)(name)
      }),
    setOverride: (name, directory) =>
      Effect.sync(() => {
        log.push(`setOverride:${name}:${directory}`)
        return script.overrideResult ?? { _tag: 'Applied' }
      }),
    clearOverride: (name) => Effect.sync(() => void log.push(`clearOverride:${name}`))
  })
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`no tool ${name}`)
    return found
  }
  const call = (name: string, args: Record<string, string>): Promise<DiaToolResult> =>
    Effect.runPromise(tool(name).run(args))
  return { log, call, tool, tools }
}

describe('plugin tools', () => {
  it('offers exactly the override, reload and clear-override tools', () => {
    expect(
      harness()
        .tools.map((tool) => tool.name)
        .sort()
    ).toEqual(['plugin_clear_override', 'plugin_override', 'plugin_reload'])
  })

  it('reports a plugin that loaded cleanly as a success', async () => {
    const { call } = harness()

    expect(await call('plugin_reload', { name: 'chat' })).toEqual({
      text: 'Plugin "chat" is loaded.',
      isError: false
    })
  })

  it('reports a plugin that is still loading without calling it an error', async () => {
    const { call } = harness({ reloadResult: (name) => info(name, { _tag: 'Loading' }) })

    expect(await call('plugin_reload', { name: 'chat' })).toEqual({
      text: 'Plugin "chat" is still loading.',
      isError: false
    })
  })

  it('reports a plugin that failed to load as an error with the reason', async () => {
    const { call } = harness({
      reloadResult: (name) => info(name, { _tag: 'Failed', message: 'Cannot import "host.ts"' })
    })

    const result = await call('plugin_reload', { name: 'chat' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Cannot import "host.ts"')
  })

  it('reports a failed reload that left the previous version running as an error', async () => {
    const { call } = harness({
      reloadResult: (name) => info(name, { _tag: 'Loaded', reloadError: 'boom' })
    })

    const result = await call('plugin_reload', { name: 'chat' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('previous version')
    expect(result.text).toContain('boom')
  })

  it('reports a plugin that needs a restart as an error with the reason', async () => {
    const { call } = harness({
      reloadResult: (name) =>
        info(name, { _tag: 'RestartRequired', reason: 'memory', message: 'over the limit' })
    })

    const result = await call('plugin_reload', { name: 'chat' })

    expect(result.isError).toBe(true)
    expect(result.text).toContain('over the limit')
  })

  it('sets the override and then reloads the plugin', async () => {
    const { log, call } = harness()

    await call('plugin_override', { name: 'chat', directory: '/work/chat' })

    expect(log).toEqual(['setOverride:chat:/work/chat', 'reload:chat'])
  })

  it('does not reload when the override is refused and says why', async () => {
    const { log, call } = harness({
      overrideResult: { _tag: 'Rejected', message: 'no plugin.json' }
    })

    const result = await call('plugin_override', { name: 'chat', directory: '/work/chat' })

    expect(log.some((entry) => entry.startsWith('reload:'))).toBe(false)
    expect(result).toEqual({ text: 'Override refused: no plugin.json', isError: true })
  })

  it('clears the override and then reloads the plugin', async () => {
    const { log, call } = harness()

    await call('plugin_clear_override', { name: 'chat' })

    expect(log).toEqual(['clearOverride:chat', 'reload:chat'])
  })

  describe('input patterns', () => {
    const pattern = (tool: string, field: string) => {
      const found = harness().tool(tool).input[field]
      if (found === undefined) throw new Error(`no field ${field}`)
      return found.pattern
    }

    it.each(['chat', 'theme-2'])('accepts the plugin name %s', (name) => {
      expect(pattern('plugin_reload', 'name').test(name)).toBe(true)
    })

    it.each(['../etc', 'Chat', '', '2fast', 'a b'])('rejects the plugin name "%s"', (name) => {
      expect(pattern('plugin_reload', 'name').test(name)).toBe(false)
    })

    it('rejects an empty override directory and accepts any non-empty one', () => {
      expect(pattern('plugin_override', 'directory').test('')).toBe(false)
      expect(pattern('plugin_override', 'directory').test(' ')).toBe(true)
    })
  })
})
