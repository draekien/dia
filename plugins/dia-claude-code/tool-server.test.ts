import type { DiaTool } from '@dia/plugin'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { makeDiaSdkTools } from './tool-server'

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

const harness = (tool: DiaTool = reloadTool([])) => {
  const [sdkTool] = makeDiaSdkTools({ tools: [tool], run: (effect) => Effect.runPromise(effect) })
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
  return { call, sdkTool }
}

describe('dia SDK tools', () => {
  it('runs the tool with the agent input and returns its result', async () => {
    const log: Array<string> = []
    const { call } = harness(reloadTool(log))

    const result = await call({ name: 'chat' })

    expect(log).toEqual(['run:chat'])
    expect(result).toEqual({ text: 'reloaded chat', isError: false })
  })

  it('reports a tool result that is an error as an MCP error', async () => {
    const { call } = harness({
      ...reloadTool([]),
      run: () => Effect.succeed({ text: 'failed', isError: true })
    })

    expect(await call({ name: 'chat' })).toEqual({ text: 'failed', isError: true })
  })

  it('validates each input field against its pattern', () => {
    const schema = z.object(harness().sdkTool.inputSchema as z.ZodRawShape)

    expect(schema.safeParse({ name: 'chat' }).success).toBe(true)
    expect(schema.safeParse({ name: 'Chat' }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('accepts an omitted optional field and still checks it when present', () => {
    const { sdkTool } = harness({
      ...reloadTool([]),
      input: {
        name: { description: 'Plugin name.', pattern: /^[a-z]+$/ },
        note: { description: 'Note.', pattern: /^[a-z]+$/, optional: true }
      }
    })
    const schema = z.object(sdkTool.inputSchema as z.ZodRawShape)

    expect(schema.safeParse({ name: 'chat' }).success).toBe(true)
    expect(schema.safeParse({ name: 'chat', note: 'ok' }).success).toBe(true)
    expect(schema.safeParse({ name: 'chat', note: 'NO' }).success).toBe(false)
    expect(schema.safeParse({ note: 'ok' }).success).toBe(false)
  })
})
