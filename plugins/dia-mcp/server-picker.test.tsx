// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Schema } from 'effect'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PluginSource, RegisteredServer, UserSource } from './registry'
import { McpServerPicker } from './server-picker'
import type { McpServer } from './servers'
import { makeServersAtom } from './settings-page'

const ctx = { name: 'mcp' }
const CONFIG: McpServer = { type: 'http', url: 'https://api.github.com/mcp', headers: {} }

const user = (name: string): RegisteredServer => ({
  name,
  server: CONFIG,
  source: UserSource.make({})
})
const fromPlugin = (name: string, plugin: string): RegisteredServer => ({
  name,
  server: CONFIG,
  source: PluginSource.make({ plugin })
})

const encodeList = Schema.encodeSync(Schema.toCodecJson(Schema.Array(RegisteredServer)))

const installHost = (list: ReadonlyArray<RegisteredServer>, deliver = true) => {
  Object.assign(window, {
    dia: {
      plugins: {
        call: vi.fn(),
        subscribe: (
          _plugin: string,
          _tag: string,
          _payload: unknown,
          onValue: (v: unknown) => void
        ) => {
          if (deliver) queueMicrotask(() => onValue(encodeList(list)))
          return () => {}
        },
        onStatusChanged: () => () => {}
      }
    }
  })
}

function Harness({ initial }: { readonly initial: ReadonlyArray<string> }) {
  const [value, setValue] = useState(initial)
  return (
    <form>
      <McpServerPicker
        label="Servers"
        value={value}
        onChange={setValue}
        serversAtom={makeServersAtom(ctx)}
      />
      <output aria-label="Chosen">{value.join(',')}</output>
    </form>
  )
}

const renderPicker = async (initial: ReadonlyArray<string> = []) => {
  render(<Harness initial={initial} />)
  await screen.findByRole('listbox')
}

const chosen = () => screen.getByRole('status', { name: 'Chosen' }).textContent
const group = (heading: string) => screen.getByRole('group', { name: heading })

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('McpServerPicker', () => {
  it('lists user servers under "Your servers" and plugin servers under "Plugin › <plugin>"', async () => {
    installHost([user('github'), fromPlugin('linear', 'linear-tools')])

    await renderPicker()

    expect({
      user: within(group('Your servers')).queryByText('github') !== null,
      plugin: within(group('Plugin › linear-tools')).queryByText('linear') !== null,
      crossed: within(group('Your servers')).queryByText('linear') !== null
    }).toEqual({ user: true, plugin: true, crossed: false })
  })

  it('adds a clicked server to the chosen names', async () => {
    installHost([user('github'), user('jira')])
    await renderPicker(['github'])

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /jira/ }))
    })

    expect(chosen()).toBe('github,jira')
  })

  it('removes a clicked chosen server from the chosen names', async () => {
    installHost([user('github'), user('jira')])
    await renderPicker(['github', 'jira'])

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /github/ }))
    })

    expect(chosen()).toBe('jira')
  })

  it('lists a chosen name the registry lacks as "<name> (missing)"', async () => {
    installHost([user('github')])

    await renderPicker(['gone'])

    expect(within(group('Missing')).getByRole('option').textContent).toContain('gone(missing)')
  })

  it('has no Missing group when every chosen name is registered', async () => {
    installHost([user('github')])

    await renderPicker(['github'])

    expect(screen.queryByRole('group', { name: 'Missing' })).toBeNull()
  })

  it('shows a busy skeleton and no list before the host delivers the servers', () => {
    installHost([user('github')], false)

    render(<Harness initial={[]} />)

    expect([
      document.querySelector('[aria-busy="true"]') !== null,
      screen.queryByRole('listbox')
    ]).toEqual([true, null])
  })
})
