import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { SessionToolOptions } from '@dia/plugin'
import type { McpServer } from '@dia-plugin/dia-mcp/servers'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Logger, Option } from 'effect'
import { sessionToolOptions } from './session-tool-options'

const options = (...args: Parameters<typeof sessionToolOptions>) =>
  Effect.runSync(sessionToolOptions(...args))

const taskTools = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']

const diaServer: McpServer = {
  type: 'http',
  url: 'http://127.0.0.1:4000/mcp',
  headers: { Authorization: 'Bearer token' }
}

const github: McpServer = {
  type: 'stdio',
  command: 'github-mcp',
  args: ['--read-only'],
  env: { GITHUB_TOKEN: 'token' }
}

const toolsWith = (overrides: Partial<SessionToolOptions>): SessionToolOptions => ({
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: {},
  skills: [],
  ...overrides
})

describe('sessionToolOptions with no tool options', () => {
  it('allows only the task-tracking tools', () => {
    assert.deepStrictEqual(options(Option.none()), {
      allowedTools: taskTools
    })
  })
})

describe('sessionToolOptions with session tool options', () => {
  it('enables only the listed skills', () => {
    const tools = toolsWith({ skills: ['review', 'dia-meta:plan'] })

    assert.deepStrictEqual(options(Option.some(tools)).skills, ['review', 'dia-meta:plan'])
  })

  it('leaves every skill enabled when the list is empty', () => {
    assert.notProperty(options(Option.some(toolsWith({}))), 'skills')
  })

  it('gives tool options with no rules or servers the same options as none', () => {
    assert.deepStrictEqual(options(Option.some(toolsWith({}))), options(Option.none()))
  })

  it('allows the allow rules after the task-tracking tools', () => {
    const tools = toolsWith({
      permissions: { allow: ['Read', 'Bash(pnpm test)'], ask: [], deny: [] }
    })

    assert.deepStrictEqual(options(Option.some(tools)).allowedTools, [
      ...taskTools,
      'Read',
      'Bash(pnpm test)'
    ])
  })

  it('passes the deny rules as disallowedTools', () => {
    const tools = toolsWith({ permissions: { allow: [], ask: [], deny: ['Bash(git push *)'] } })

    assert.deepStrictEqual(options(Option.some(tools)).disallowedTools, ['Bash(git push *)'])
  })

  it('passes the ask rules as settings permission ask rules', () => {
    const tools = toolsWith({ permissions: { allow: [], ask: ['Bash(git status*)'], deny: [] } })

    assert.deepStrictEqual(options(Option.some(tools)).settings, {
      permissions: { ask: ['Bash(git status*)'] }
    })
  })

  it('passes every MCP server, including the dia server, as the SDK config', () => {
    const expected: McpServerConfig = {
      type: 'stdio',
      command: 'github-mcp',
      args: ['--read-only'],
      env: { GITHUB_TOKEN: 'token' }
    }

    assert.deepStrictEqual(
      options(Option.some(toolsWith({ mcpServers: { github, dia: diaServer } }))).mcpServers,
      { github: expected, dia: diaServer }
    )
  })

  it.effect('leaves out a server that is not an MCP server, logs it, and keeps the others', () => {
    const logs: Array<unknown> = []
    const capture = Logger.make(({ message }) => {
      logs.push(message)
    })
    const tools = toolsWith({ mcpServers: { github, files: { type: 'ftp' } } })

    return Effect.gen(function* () {
      const result = yield* sessionToolOptions(Option.some(tools))

      assert.deepStrictEqual(Object.keys(result.mcpServers ?? {}), ['github'])
      assert.isTrue(
        logs.some((message) =>
          JSON.stringify(message).includes('An MCP server was left out of the session')
        )
      )
    }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })))
  })
})
