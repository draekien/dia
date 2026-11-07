// @vitest-environment jsdom
import { useProvided } from '@dia/renderer-plugin'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Effect } from 'effect'
import { createElement, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { startRendererRegistry } from '../../src/renderer/src/lib/renderer-registry.fake'
import { McpServersEditorKey } from './editor'
import mcp from './renderer'
import { mcpServersDraft, readMcpServersDraft } from './servers'

function Host() {
  const Editor = useProvided(McpServersEditorKey)
  const [draft, setDraft] = useState(() => mcpServersDraft({}))
  if (Editor === undefined) return <p>No editor</p>
  return (
    <>
      <label htmlFor="servers">MCP servers</label>
      {createElement(Editor, {
        id: 'servers',
        draft,
        onChange: setDraft,
        error: 'Expected a JSON object'
      })}
      <output>{JSON.stringify(readMcpServersDraft(draft))}</output>
    </>
  )
}

afterEach(cleanup)

describe('mcp renderer entry', () => {
  it('provides an editor whose edits reach onChange as a readable draft', async () => {
    await startRendererRegistry({ mcp })
    render(<Host />)

    fireEvent.change(screen.getByLabelText('MCP servers'), {
      target: { value: '{ "files": { "command": "npx" } }' }
    })

    expect(JSON.parse(screen.getByRole('status').textContent ?? '')).toMatchObject({
      value: { files: { type: 'stdio', command: 'npx', args: [], env: {} } }
    })
  })

  it('marks the editor invalid and shows the error it is given', async () => {
    await startRendererRegistry({ mcp })
    render(<Host />)

    expect([
      screen.getByLabelText('MCP servers').getAttribute('aria-invalid'),
      screen.getByText('Expected a JSON object')
    ]).toEqual(['true', expect.anything()])
  })

  it('stops providing the editor when the plugin unloads', async () => {
    const registry = await startRendererRegistry({ mcp })
    render(<Host />)

    await act(() => Effect.runPromise(registry.unload('mcp')))

    expect(screen.getByText('No editor')).toBeTruthy()
  })
})
