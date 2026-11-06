import type {
  McpSdkServerConfigWithInstance,
  McpServerConfig
} from '@anthropic-ai/claude-agent-sdk'
import type { RoleSessionOptions } from '@dia/plugin'
import { assert, describe, it } from '@effect/vitest'
import type { RoleMcpServer } from '@shared/domain/role-session'
import { Option } from 'effect'
import { sessionToolOptions } from './session-tool-options'

const taskTools = ['TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList']

const diaServer = {
  type: 'sdk',
  name: 'dia',
  instance: {}
} as unknown as McpSdkServerConfigWithInstance

const github: RoleMcpServer = {
  type: 'stdio',
  command: 'github-mcp',
  args: ['--read-only'],
  env: { GITHUB_TOKEN: 'token' }
}

const roleWith = (overrides: Partial<RoleSessionOptions>): RoleSessionOptions => ({
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

describe('sessionToolOptions for a role', () => {
  it('gives a role with no rules or servers the same options as an ad-hoc tab', () => {
    assert.deepStrictEqual(
      sessionToolOptions(Option.some(roleWith({})), Option.some(diaServer)),
      sessionToolOptions(Option.none(), Option.some(diaServer))
    )
  })

  it('allows the role allow rules after the task-tracking tools', () => {
    const role = roleWith({
      permissions: { allow: ['Read', 'Bash(pnpm test)'], ask: [], deny: [] }
    })

    assert.deepStrictEqual(sessionToolOptions(Option.some(role), Option.none()).allowedTools, [
      ...taskTools,
      'Read',
      'Bash(pnpm test)'
    ])
  })

  it('passes the deny rules as disallowedTools', () => {
    const role = roleWith({ permissions: { allow: [], ask: [], deny: ['Bash(git push *)'] } })

    assert.deepStrictEqual(sessionToolOptions(Option.some(role), Option.none()).disallowedTools, [
      'Bash(git push *)'
    ])
  })

  it('passes the ask rules as settings permission ask rules', () => {
    const role = roleWith({ permissions: { allow: [], ask: ['Bash(git status*)'], deny: [] } })

    assert.deepStrictEqual(sessionToolOptions(Option.some(role), Option.none()).settings, {
      permissions: { ask: ['Bash(git status*)'] }
    })
  })

  it('adds the role MCP servers beside the dia tool server', () => {
    const expected: McpServerConfig = {
      type: 'stdio',
      command: 'github-mcp',
      args: ['--read-only'],
      env: { GITHUB_TOKEN: 'token' }
    }

    assert.deepStrictEqual(
      sessionToolOptions(Option.some(roleWith({ mcpServers: { github } })), Option.some(diaServer))
        .mcpServers,
      { github: expected, dia: diaServer }
    )
  })

  it('replaces a role server named dia with the dia tool server', () => {
    const role = roleWith({ mcpServers: { dia: github } })

    assert.deepStrictEqual(
      sessionToolOptions(Option.some(role), Option.some(diaServer)).mcpServers,
      { dia: diaServer }
    )
  })

  it('keeps a role server named dia when there is no dia tool server', () => {
    const role = roleWith({ mcpServers: { dia: github } })

    assert.deepStrictEqual(sessionToolOptions(Option.some(role), Option.none()).mcpServers?.dia, {
      ...github,
      args: ['--read-only']
    })
  })
})
