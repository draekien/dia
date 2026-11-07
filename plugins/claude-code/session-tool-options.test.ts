import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionToolOptions } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { McpServer } from '@shared/domain/session-tools'
import { Option } from 'effect'
import { sessionToolOptions } from './session-tool-options'

const taskTools = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']

const diaServer = {
  type: 'sdk',
  name: 'dia',
  instance: {}
} as unknown as McpSdkServerConfigWithInstance

const github: McpServer = {
  type: 'stdio',
  command: 'github-mcp',
  args: ['--read-only'],
  env: { GITHUB_TOKEN: 'token' }
}

const toolsWith = (overrides: Partial<SessionToolOptions>): SessionToolOptions => ({
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: {},
  ...overrides
})

describe('sessionToolOptions for an ad-hoc tab', () => {
  it('allows only the task-tracking tools when there is no dia tool server', () => {
    assert.deepStrictEqual(sessionToolOptions(Option.none(), Option.none()), {
      allowedTools: taskTools
    })
  })

  it('adds the dia tool server under its key', () => {
    assert.deepStrictEqual(sessionToolOptions(Option.none(), Option.some(diaServer)), {
      allowedTools: taskTools,
      mcpServers: { dia: diaServer }
    })
  })
})

describe('sessionToolOptions with session tool options', () => {
  it('gives tool options with no rules or servers the same options as an ad-hoc tab', () => {
    assert.deepStrictEqual(
      sessionToolOptions(Option.some(toolsWith({})), Option.some(diaServer)),
      sessionToolOptions(Option.none(), Option.some(diaServer))
    )
  })

  it('allows the allow rules after the task-tracking tools', () => {
    const tools = toolsWith({
      permissions: { allow: ['Read', 'Bash(pnpm test)'], ask: [], deny: [] }
    })

    assert.deepStrictEqual(sessionToolOptions(Option.some(tools), Option.none()).allowedTools, [
      ...taskTools,
      'Read',
      'Bash(pnpm test)'
    ])
  })

  it('passes the deny rules as disallowedTools', () => {
    const tools = toolsWith({ permissions: { allow: [], ask: [], deny: ['Bash(git push *)'] } })

    assert.deepStrictEqual(sessionToolOptions(Option.some(tools), Option.none()).disallowedTools, [
      'Bash(git push *)'
    ])
  })

  it('passes the ask rules as settings permission ask rules', () => {
    const tools = toolsWith({ permissions: { allow: [], ask: ['Bash(git status*)'], deny: [] } })

    assert.deepStrictEqual(sessionToolOptions(Option.some(tools), Option.none()).settings, {
      permissions: { ask: ['Bash(git status*)'] }
    })
  })

  it('adds the MCP servers beside the dia tool server', () => {
    const expected: McpServerConfig = {
      type: 'stdio',
      command: 'github-mcp',
      args: ['--read-only'],
      env: { GITHUB_TOKEN: 'token' }
    }

    assert.deepStrictEqual(
      sessionToolOptions(Option.some(toolsWith({ mcpServers: { github } })), Option.some(diaServer))
        .mcpServers,
      { github: expected, dia: diaServer }
    )
  })

  it('replaces a server named dia with the dia tool server', () => {
    const tools = toolsWith({ mcpServers: { dia: github } })

    assert.deepStrictEqual(
      sessionToolOptions(Option.some(tools), Option.some(diaServer)).mcpServers,
      { dia: diaServer }
    )
  })

  it('keeps a server named dia when there is no dia tool server', () => {
    const tools = toolsWith({ mcpServers: { dia: github } })

    assert.deepStrictEqual(sessionToolOptions(Option.some(tools), Option.none()).mcpServers?.dia, {
      ...github,
      args: ['--read-only']
    })
  })
})
