// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Schema } from 'effect'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalInfo } from './terminals'
import { makeTerminalsAtoms, TerminalsPanel } from './terminals-panel'

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    dispose() {}
    onData() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
  }
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  }
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const RUN = 'run-1'
const encodeInfo = Schema.encodeSync(Schema.toCodecJson(TerminalInfo))

const DEV_SERVER: TerminalInfo = {
  _tag: 'TerminalExited',
  terminalId: 't1',
  runId: RUN,
  title: 'pnpm dev',
  exitCode: 1
}
const SHELL: TerminalInfo = { _tag: 'TerminalRunning', terminalId: 't2', runId: RUN, title: 'pwsh' }

const installHost = (terminals: ReadonlyArray<TerminalInfo>) => {
  const call = vi.fn(async (_plugin: string, tag: string, _payload: unknown) =>
    tag === 'OpenTerminal'
      ? { _tag: 'Success', value: encodeInfo({ ...SHELL, terminalId: 't3' }) }
      : { _tag: 'Success', value: null }
  )
  const subscribe = (
    _plugin: string,
    tag: string,
    _payload: unknown,
    onValue: (value: unknown) => void
  ) => {
    if (tag === 'FollowTerminals')
      queueMicrotask(() => onValue(terminals.map((info) => encodeInfo(info))))
    return () => {}
  }
  Object.assign(window, {
    dia: { plugins: { call, subscribe, onStatusChanged: () => () => {} } }
  })
  return call
}

const sentCalls = (call: ReturnType<typeof installHost>) =>
  call.mock.calls
    .filter(([, tag]) => tag !== 'ResizeTerminal')
    .map(([, tag, payload]) => [tag, payload])

const showPanel = () =>
  render(
    <TerminalsPanel runId={RUN} terminalsAtoms={makeTerminalsAtoms({ name: 'dia-terminals' })} />
  )

const tab = (title: string) => screen.getByRole('button', { name: new RegExp(`^${title}`) })

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
  window.HTMLCanvasElement.prototype.getContext = () => null
})
beforeEach(() => cleanup())
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('TerminalsPanel', () => {
  it('opens a shell for the run from the empty state', async () => {
    const call = installHost([])
    showPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'New terminal' }))

    await waitFor(() => expect(sentCalls(call)).toEqual([['OpenTerminal', { runId: RUN }]]))
    expect(screen.getByText('No terminals')).toBeTruthy()
  })

  it('shows one tab per terminal with the newest selected', async () => {
    installHost([DEV_SERVER, SHELL])
    showPanel()

    await screen.findByRole('button', { name: /^pwsh/ })

    expect(tab('pnpm dev').getAttribute('aria-pressed')).toBe('false')
    expect(tab('pwsh').getAttribute('aria-pressed')).toBe('true')
  })

  it('names the exit code of an exited terminal in its tab', async () => {
    installHost([DEV_SERVER, SHELL])
    showPanel()

    await screen.findByRole('button', { name: /^pwsh/ })

    expect(tab('pnpm dev').getAttribute('title')).toBe('pnpm dev, exit code 1')
  })

  it('stops the selected running terminal', async () => {
    const call = installHost([DEV_SERVER, SHELL])
    showPanel()

    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }))

    await waitFor(() =>
      expect(sentCalls(call)).toContainEqual(['StopTerminal', { terminalId: SHELL.terminalId }])
    )
  })

  it('removes an exited terminal once its tab is selected', async () => {
    const call = installHost([DEV_SERVER, SHELL])
    showPanel()
    fireEvent.click(await screen.findByRole('button', { name: /^pnpm dev/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    await waitFor(() =>
      expect(sentCalls(call)).toContainEqual([
        'RemoveTerminal',
        { terminalId: DEV_SERVER.terminalId }
      ])
    )
    expect(sentCalls(call)).not.toContainEqual(['StopTerminal', { terminalId: SHELL.terminalId }])
  })
})
