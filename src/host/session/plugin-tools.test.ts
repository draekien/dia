import type { PluginInfo, PluginOverrideResult } from '@shared/plugin/manifest'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isPluginToolName, makePluginTools, type PluginToolOptions } from './plugin-tools'

const info = (name: string, status: PluginInfo['status'] = { _tag: 'Loaded' }): PluginInfo => ({
  name,
  origin: 'default',
  root: `plugins/${name}`,
  status,
  memoryBytes: 0
})

const harness = (
  script: {
    readonly approved?: boolean
    readonly reloadResult?: (name: string) => PluginInfo
    readonly overrideResult?: PluginOverrideResult
  } = {}
) => {
  const log: Array<string> = []
  const options: PluginToolOptions = {
    host: {
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
    },
    approve: (toolName, input) =>
      Effect.sync(() => {
        log.push(`approve:${toolName}:${JSON.stringify(input)}`)
        return script.approved ?? true
      }),
    run: (effect) => Effect.runPromise(effect)
  }
  const tools = makePluginTools(options)
  const call = async (name: string, args: Record<string, string>) => {
    const found = tools.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`no tool ${name}`)
    const result = await (
      found.handler as (
        a: unknown,
        e: unknown
      ) => Promise<{
        content: Array<{ text: string }>
        isError?: boolean
      }>
    )(args, {})
    return { text: result.content[0]?.text ?? '', isError: result.isError === true }
  }
  return { log, call, tools }
}

describe('plugin tools', () => {
  it('offers exactly the override, reload and clear-override tools', () => {
    expect(
      harness()
        .tools.map((tool) => tool.name)
        .sort()
    ).toEqual(['plugin_clear_override', 'plugin_override', 'plugin_reload'])
  })

  it('asks for approval under the full tool name before it touches a plugin', async () => {
    const { log, call } = harness()

    await call('plugin_reload', { name: 'chat' })

    expect(log).toEqual(['approve:mcp__dia__plugin_reload:{"name":"chat"}', 'reload:chat'])
  })

  it.each([
    ['plugin_reload', { name: 'chat' }],
    ['plugin_override', { name: 'chat', directory: '/work/chat' }],
    ['plugin_clear_override', { name: 'chat' }]
  ])('does nothing and tells the agent when the user declines %s', async (tool, args) => {
    const { log, call } = harness({ approved: false })

    const result = await call(tool, args)

    expect(log).toHaveLength(1)
    expect(log[0]).toContain(`approve:mcp__dia__${tool}`)
    expect(result).toEqual({
      text: 'The user did not approve this plugin change.',
      isError: true
    })
  })

  it('reports a plugin that loaded cleanly as a success', async () => {
    const { call } = harness()

    expect(await call('plugin_reload', { name: 'chat' })).toEqual({
      text: 'Plugin "chat" is loaded.',
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

    expect(log.slice(1)).toEqual(['setOverride:chat:/work/chat', 'reload:chat'])
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

    expect(log.slice(1)).toEqual(['clearOverride:chat', 'reload:chat'])
  })

  describe('input schema', () => {
    const schemaOf = (tool: string) => {
      const found = harness().tools.find((candidate) => candidate.name === tool)
      if (found === undefined) throw new Error(`no tool ${tool}`)
      return z.object(found.inputSchema as z.ZodRawShape)
    }

    it.each(['chat', 'theme-2'])('accepts the plugin name %s', (name) => {
      expect(schemaOf('plugin_reload').safeParse({ name }).success).toBe(true)
    })

    it.each(['../etc', 'Chat', '', '2fast', 'a b'])('rejects the plugin name "%s"', (name) => {
      expect(schemaOf('plugin_reload').safeParse({ name }).success).toBe(false)
    })

    it('requires a directory for an override', () => {
      expect(schemaOf('plugin_override').safeParse({ name: 'chat' }).success).toBe(false)
      expect(schemaOf('plugin_override').safeParse({ name: 'chat', directory: '' }).success).toBe(
        false
      )
    })
  })
})

describe('isPluginToolName', () => {
  it.each([
    'mcp__dia__plugin_override',
    'mcp__dia__plugin_reload',
    'mcp__dia__plugin_clear_override'
  ])('recognises %s', (name) => {
    expect(isPluginToolName(name)).toBe(true)
  })

  it.each([
    'Bash',
    'mcp__dia__other',
    'mcp__other__plugin_reload',
    'plugin_reload'
  ])('does not recognise %s', (name) => {
    expect(isPluginToolName(name)).toBe(false)
  })
})
