// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpServerNameTaken, PluginSource, RegisteredServer, UserSource } from './registry'
import type { McpServer } from './servers'
import { McpServersSettings, makeServersAtom } from './settings-page'

const ctx = { name: 'mcp' }
const EDITOR = 'Your MCP servers as JSON'

const GITHUB: McpServer = { type: 'http', url: 'https://api.github.com/mcp', headers: {} }
const LINEAR: McpServer = { type: 'sse', url: 'https://mcp.linear.app/sse', headers: {} }

const encodeList = Schema.encodeSync(Schema.toCodecJson(Schema.Array(RegisteredServer)))
const encodeTaken = Schema.encodeSync(Schema.toCodecJson(McpServerNameTaken))

const user = (name: string, server: McpServer): RegisteredServer => ({
  name,
  server,
  source: UserSource.make({})
})
const fromPlugin = (name: string, server: McpServer, plugin: string): RegisteredServer => ({
  name,
  server,
  source: PluginSource.make({ plugin })
})

const installHost = (
  list: ReadonlyArray<RegisteredServer>,
  reply: () => unknown = () => ({ _tag: 'Success', value: null })
) => {
  const watchers = new Set<(value: unknown) => void>()
  const call = vi.fn(async (_plugin: string, _tag: string, _payload: unknown) => reply())
  Object.assign(window, {
    dia: {
      plugins: {
        call,
        subscribe: (
          _plugin: string,
          _tag: string,
          _payload: unknown,
          onValue: (v: unknown) => void
        ) => {
          watchers.add(onValue)
          queueMicrotask(() => onValue(encodeList(list)))
          return () => watchers.delete(onValue)
        },
        onStatusChanged: () => () => {}
      }
    }
  })
  return {
    call,
    push: (next: ReadonlyArray<RegisteredServer>) =>
      act(() => {
        for (const watcher of watchers) watcher(encodeList(next))
      })
  }
}

const renderPage = async () => {
  render(<McpServersSettings ctx={ctx} serversAtom={makeServersAtom(ctx)} />)
  return (await screen.findByLabelText(EDITOR)) as HTMLTextAreaElement
}

const type = (editor: HTMLTextAreaElement, text: string) =>
  fireEvent.change(editor, { target: { value: text } })

const clickSave = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('MCP servers settings page', () => {
  it("shows the user's servers in the editor and a plugin's server as a row with no control", async () => {
    installHost([user('github', GITHUB), fromPlugin('linear', LINEAR, 'linear-tools')])

    const editor = await renderPage()

    expect({
      editor: JSON.parse(editor.value),
      row: screen.getByText('linear').closest('li')?.textContent,
      textboxes: screen.getAllByRole('textbox').length
    }).toEqual({
      editor: { github: GITHUB },
      row: 'linearsselinear-tools',
      textboxes: 1
    })
  })

  it('sends the edited servers on Save', async () => {
    const host = installHost([])
    const editor = await renderPage()

    type(editor, JSON.stringify({ linear: LINEAR }))
    await clickSave()

    expect(host.call.mock.calls).toEqual([
      ['mcp', 'SaveUserServers', { servers: { linear: LINEAR } }]
    ])
  })

  it("names the plugin that holds a saved name and keeps the user's text", async () => {
    installHost([fromPlugin('linear', LINEAR, 'linear-tools')], () => ({
      _tag: 'Failure',
      error: {
        _tag: 'PluginCallFailed',
        error: encodeTaken(
          new McpServerNameTaken({
            name: 'linear',
            holder: PluginSource.make({ plugin: 'linear-tools' })
          })
        )
      }
    }))
    const editor = await renderPage()
    const text = JSON.stringify({ linear: GITHUB })

    type(editor, text)
    await clickSave()

    expect({
      message: screen.queryByText(
        'linear is provided by the linear-tools plugin. Rename your server.'
      ),
      editor: editor.value
    }).toEqual({ message: expect.anything(), editor: text })
  })

  it('shows the parse error and sends nothing when the text is not a server map', async () => {
    const host = installHost([])
    const editor = await renderPage()

    type(editor, '{ "github": ')
    await clickSave()

    expect({
      sent: host.call.mock.calls.length,
      invalid: editor.getAttribute('aria-invalid')
    }).toEqual({ sent: 0, invalid: 'true' })
  })

  it('keeps unsaved text when a new list arrives', async () => {
    const host = installHost([user('github', GITHUB)])
    const editor = await renderPage()
    const text = JSON.stringify({ github: LINEAR })
    type(editor, text)

    host.push([user('github', GITHUB), fromPlugin('jira', LINEAR, 'atlassian')])
    await screen.findByText('jira')

    expect(editor.value).toBe(text)
  })

  it('shows the new list when the text has no unsaved edits', async () => {
    const host = installHost([user('github', GITHUB)])
    const editor = await renderPage()

    host.push([user('github', GITHUB), user('linear', LINEAR)])

    await waitFor(() =>
      expect(JSON.parse(editor.value)).toEqual({ github: GITHUB, linear: LINEAR })
    )
  })

  it('disables Save while the text matches the saved servers', async () => {
    installHost([user('github', GITHUB)])
    await renderPage()

    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })
})
