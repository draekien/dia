import type { DiaTool } from '@dia/plugin'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type DiaToolServerOptions, isDiaToolName, makeDiaSdkTools } from './tool-server'

const reloadTool = (log: Array<string>): DiaTool => ({
  name: 'plugin_reload',
  description: 'Reload a plugin.',
  input: { name: { description: 'Plugin name.', pattern: /^[a-z]+$/ } },
  run: (input) =>
    Effect.sync(() => {
      log.push(`run:${input.name}`)
      return { text: `reloaded ${input.name}`, isError: false }
    })
})

const harness = (approved: boolean) => {
  const log: Array<string> = []
  const options: DiaToolServerOptions = {
    tools: [reloadTool(log)],
    approve: (toolName, input) =>
      Effect.sync(() => {
        log.push(`approve:${toolName}:${JSON.stringify(input)}`)
        return approved
      }),
    run: (effect) => Effect.runPromise(effect)
  }
  const [sdkTool] = makeDiaSdkTools(options)
  if (sdkTool === undefined) throw new Error('no tool built')
  const call = async (args: Record<string, string>) => {
    const result = await (
      sdkTool.handler as (
        a: unknown,
        e: unknown
      ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
    )(args, {})
    return { text: result.content[0]?.text ?? '', isError: result.isError === true }
  }
  return { log, call, sdkTool }
}

describe('dia SDK tools', () => {
  it('asks for approval under the qualified tool name before running the tool', async () => {
    const { log, call } = harness(true)

    const result = await call({ name: 'chat' })

    expect(log).toEqual(['approve:mcp__dia__plugin_reload:{"name":"chat"}', 'run:chat'])
    expect(result).toEqual({ text: 'reloaded chat', isError: false })
  })

  it('does not run the tool and tells the agent when the user declines', async () => {
    const { log, call } = harness(false)

    const result = await call({ name: 'chat' })

    expect(log).toEqual(['approve:mcp__dia__plugin_reload:{"name":"chat"}'])
    expect(result).toEqual({
      text: 'The user did not approve this plugin change.',
      isError: true
    })
  })

  it('validates each input field against its pattern', () => {
    const schema = z.object(harness(true).sdkTool.inputSchema as z.ZodRawShape)

    expect(schema.safeParse({ name: 'chat' }).success).toBe(true)
    expect(schema.safeParse({ name: 'Chat' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })
})

describe('isDiaToolName', () => {
  const tools = [reloadTool([])]

  it('recognises a dia tool by its qualified name', () => {
    expect(isDiaToolName(tools, 'mcp__dia__plugin_reload')).toBe(true)
  })

  it.each([
    'Bash',
    'plugin_reload',
    'mcp__dia__plugin_override',
    'mcp__other__plugin_reload'
  ])('does not recognise %s', (name) => {
    expect(isDiaToolName(tools, name)).toBe(false)
  })
})
