import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { draftOfText } from './draft'
import { type McpServers, mcpServersDraft, readMcpServersDraft } from './servers'

const parsed = (text: string) => {
  const result = readMcpServersDraft(draftOfText(text))
  if (Result.isFailure(result)) throw new Error(`refused: ${result.failure}`)
  return result.success
}
const refusal = (text: string) => {
  const result = readMcpServersDraft(draftOfText(text))
  return Result.isFailure(result) ? result.failure : undefined
}

describe('readMcpServersDraft', () => {
  it('reads an entry with a command and no type as stdio, with empty args and env', () => {
    expect(parsed('{ "files": { "command": "npx" } }')).toEqual({
      files: { type: 'stdio', command: 'npx', args: [], env: {} }
    })
  })

  it.each(['http', 'sse'] as const)('fills the missing headers of an %s entry', (type) => {
    expect(parsed(`{ "remote": { "type": "${type}", "url": "https://mcp.example.com" } }`)).toEqual(
      { remote: { type, url: 'https://mcp.example.com', headers: {} } }
    )
  })

  it('reads blank text as no servers', () => {
    expect(parsed('  \n')).toEqual({})
  })

  it('drops keys the server schema does not know', () => {
    expect(parsed('{ "files": { "command": "npx", "timeout": 5 } }')).toEqual({
      files: { type: 'stdio', command: 'npx', args: [], env: {} }
    })
  })

  it('refuses malformed JSON with a message', () => {
    expect(refusal('{ "files": ')).toEqual(expect.any(String))
  })

  it('refuses the mcpServers wrapper with a message', () => {
    expect(refusal('{ "mcpServers": { "files": { "command": "npx" } } }')).toEqual(
      expect.any(String)
    )
  })
})

describe('mcpServersDraft', () => {
  it('prints no servers as empty text', () => {
    expect(mcpServersDraft({})).toBe('')
  })

  it('prints servers that parse back to the same value', () => {
    const servers: McpServers = {
      files: { type: 'stdio', command: 'npx', args: ['-y', 'files'], env: { ROOT: '/srv' } },
      remote: { type: 'http', url: 'https://mcp.example.com', headers: { Authorization: 'x' } }
    }

    expect(parsed(mcpServersDraft(servers))).toEqual(servers)
  })
})
