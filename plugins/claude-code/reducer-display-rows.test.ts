import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { OutboundMessage } from '@dia/plugin'
import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { makeSessionEventReducer } from './reducer'

const sdkMessage = (fields: Record<string, unknown>): SDKMessage =>
  ({
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'test-session',
    ...fields
  }) as unknown as SDKMessage

const system = (subtype: string, fields: Record<string, unknown> = {}): SDKMessage =>
  sdkMessage({ type: 'system', subtype, ...fields })

const stepOnce = (message: SDKMessage): ReadonlyArray<OutboundMessage> =>
  makeSessionEventReducer(Option.none()).step(message)

const success = (isError = false): SDKMessage =>
  sdkMessage({ type: 'result', subtype: 'success', is_error: isError })

describe('makeSessionEventReducer — refusals without a fallback', () => {
  const refusal = (fields: Record<string, unknown>): SDKMessage =>
    system('model_refusal_no_fallback', {
      original_model: 'claude-opus-5-5',
      request_id: null,
      content: 'Claude declined this request.',
      ...fields
    })

  it('ends the refused turn as errored with the refusal explanation', () => {
    const reducer = makeSessionEventReducer(Option.none())
    expect(reducer.step(refusal({ api_refusal_explanation: 'It asked for malware.' }))).toEqual([])
    expect(reducer.step(success())).toEqual([
      {
        _tag: 'TurnErrored',
        error: { message: 'claude-opus-5-5 declined the request: It asked for malware.' }
      }
    ])
  })

  it('uses the refusal content when the SDK sends no explanation', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(refusal({ api_refusal_explanation: null }))
    expect(reducer.step(success())).toEqual([
      {
        _tag: 'TurnErrored',
        error: { message: 'claude-opus-5-5 declined the request: Claude declined this request.' }
      }
    ])
  })

  it('completes the next turn normally after a refused turn ended', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(refusal({}))
    reducer.step(success())
    expect(reducer.step(success())).toEqual([{ _tag: 'TurnCompleted' }])
  })

  it('parks instead when the account also refused the turn', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(refusal({}))
    reducer.step(
      sdkMessage({ type: 'assistant', message: { content: [] }, error: 'authentication_failed' })
    )
    expect(reducer.step(success(true))).toEqual([
      { _tag: 'TurnParked', cause: { _tag: 'SignedOut' } }
    ])
  })
})

describe('makeSessionEventReducer — hook responses', () => {
  const hookResponse = (fields: Record<string, unknown>): SDKMessage =>
    system('hook_response', {
      hook_id: 'h1',
      hook_name: 'SessionStart:startup',
      hook_event: 'SessionStart',
      output: '',
      stdout: '',
      stderr: '',
      ...fields
    })

  it('records a failed hook with its exit code and first non-empty stderr line', () => {
    const emitted = stepOnce(
      hookResponse({ outcome: 'error', exit_code: 1, stderr: '\nnode: not found\nat line 2' })
    )
    expect(emitted).toEqual([
      { _tag: 'SessionNotice', text: 'SessionStart:startup hook failed (exit 1): node: not found' }
    ])
  })

  it('falls back to the hook output when stderr is empty', () => {
    const emitted = stepOnce(hookResponse({ outcome: 'error', output: 'blocked by policy' }))
    expect(emitted).toEqual([
      { _tag: 'SessionNotice', text: 'SessionStart:startup hook failed: blocked by policy' }
    ])
  })

  it('records a failed hook with no exit code or output by its name alone', () => {
    expect(stepOnce(hookResponse({ outcome: 'error' }))).toEqual([
      { _tag: 'SessionNotice', text: 'SessionStart:startup hook failed' }
    ])
  })

  it('shortens a failed hook line longer than 200 characters to 200 including the ellipsis', () => {
    const emitted = stepOnce(hookResponse({ outcome: 'error', stderr: 'x'.repeat(250) }))
    expect(emitted).toEqual([
      { _tag: 'SessionNotice', text: `SessionStart:startup hook failed: ${'x'.repeat(199)}…` }
    ])
  })

  it.each(['success', 'cancelled'])('does not show a hook whose outcome is %s', (outcome) => {
    expect(stepOnce(hookResponse({ outcome, stdout: 'ok' }))).toEqual([])
  })

  it.each(['hook_started', 'hook_progress'])('does not show %s', (subtype) => {
    expect(
      stepOnce(system(subtype, { hook_id: 'h1', hook_name: 'Stop', hook_event: 'Stop' }))
    ).toEqual([])
  })
})

describe('makeSessionEventReducer — plugin installs and notifications', () => {
  it('records a failed plugin install with its name and error', () => {
    const emitted = stepOnce(
      system('plugin_install', { status: 'failed', name: 'acme-tools', error: 'network down' })
    )
    expect(emitted).toEqual([
      { _tag: 'SessionNotice', text: 'Plugin install failed: acme-tools: network down' }
    ])
  })

  it('records a failed plugin install that names neither plugin nor error', () => {
    expect(stepOnce(system('plugin_install', { status: 'failed' }))).toEqual([
      { _tag: 'SessionNotice', text: 'Plugin install failed' }
    ])
  })

  it.each(['started', 'installed', 'completed'])('does not show a plugin install %s', (status) => {
    expect(stepOnce(system('plugin_install', { status, name: 'acme-tools' }))).toEqual([])
  })

  it.each(['high', 'immediate'])('records a %s-priority notification', (priority) => {
    const emitted = stepOnce(
      system('notification', { key: 'mcp', text: 'MCP server github failed', priority })
    )
    expect(emitted).toEqual([{ _tag: 'SessionNotice', text: 'MCP server github failed' }])
  })

  it.each(['low', 'medium'])('does not show a %s-priority notification', (priority) => {
    expect(stepOnce(system('notification', { key: 'tip', text: 'Tip', priority }))).toEqual([])
  })
})

describe('makeSessionEventReducer — memory recall', () => {
  const recall = (paths: ReadonlyArray<string>): SDKMessage =>
    system('memory_recall', {
      mode: 'select',
      memories: paths.map((path) => ({ path, scope: 'personal' }))
    })

  it('names up to three recalled memory files and counts the rest', () => {
    const emitted = stepOnce(
      recall(['a/auth.md', 'b\\testing.md', 'c/style.md', 'd/build.md', 'e/ci.md'])
    )
    expect(emitted).toEqual([
      {
        _tag: 'SessionNotice',
        text: 'Recalled from memory: auth.md, testing.md, style.md and 2 more'
      }
    ])
  })

  it('names exactly three recalled memory files without a count', () => {
    expect(stepOnce(recall(['auth.md', 'testing.md', 'style.md']))).toEqual([
      { _tag: 'SessionNotice', text: 'Recalled from memory: auth.md, testing.md, style.md' }
    ])
  })

  it('names a single recalled memory file', () => {
    expect(stepOnce(recall(['/home/me/.claude/memory/auth.md']))).toEqual([
      { _tag: 'SessionNotice', text: 'Recalled from memory: auth.md' }
    ])
  })

  it('names a synthesized memory by its kind instead of its sentinel path', () => {
    expect(stepOnce(recall(['<synthesis:C:\\Users\\me\\.claude\\memory>']))).toEqual([
      { _tag: 'SessionNotice', text: 'Recalled from memory: synthesized memories' }
    ])
  })

  it('names an organization memory URL by its last non-empty segment', () => {
    expect(stepOnce(recall(['https://example.com/memories/style/']))).toEqual([
      { _tag: 'SessionNotice', text: 'Recalled from memory: style' }
    ])
  })

  it('does not show a memory recall with no memories', () => {
    expect(stepOnce(recall([]))).toEqual([])
  })
})

describe('makeSessionEventReducer — sign-in status', () => {
  const authStatus = (fields: Record<string, unknown>): SDKMessage =>
    sdkMessage({ type: 'auth_status', output: [], ...fields })

  it('names the sign-in on the activity line and clears it when sign-in ends', () => {
    const reducer = makeSessionEventReducer(Option.none())
    expect(reducer.step(authStatus({ isAuthenticating: true }))).toEqual([
      { _tag: 'TurnStatusChanged', label: 'Signing in' }
    ])
    expect(reducer.step(authStatus({ isAuthenticating: false }))).toEqual([
      { _tag: 'TurnStatusChanged', label: null }
    ])
  })

  it('records a failed sign-in after clearing the sign-in label', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(authStatus({ isAuthenticating: true }))
    expect(reducer.step(authStatus({ isAuthenticating: false, error: 'token expired' }))).toEqual([
      { _tag: 'TurnStatusChanged', label: null },
      { _tag: 'SessionNotice', text: 'Sign-in failed: token expired' }
    ])
  })

  it('leaves another label in place when a sign-in ends that never showed', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(system('status', { status: 'compacting' }))
    expect(reducer.step(authStatus({ isAuthenticating: false }))).toEqual([])
  })
})

describe('makeSessionEventReducer — messages logged only or hidden', () => {
  it.each([
    ['task_started', system('task_started', { task_id: 't1', description: 'Run tests' })],
    ['task_updated', system('task_updated', { task_id: 't1', patch: { status: 'running' } })],
    ['session_state_changed', system('session_state_changed', { state: 'idle' })],
    [
      'control_request_progress',
      system('control_request_progress', { request_id: 'r1', status: 'started' })
    ],
    ['files_persisted', system('files_persisted', { files: [], failed: [], processed_at: '' })],
    [
      'elicitation_complete',
      system('elicitation_complete', { mcp_server_name: 'github', elicitation_id: 'e1' })
    ],
    ['worker_shutting_down', system('worker_shutting_down', { reason: 'update' })],
    [
      'mirror_error',
      system('mirror_error', { error: 'timeout', key: { projectKey: 'p', sessionId: 's' } })
    ],
    [
      'tool_use_summary',
      sdkMessage({ type: 'tool_use_summary', summary: 'Read 3 files', preceding_tool_use_ids: [] })
    ],
    ['prompt_suggestion', sdkMessage({ type: 'prompt_suggestion', suggestion: 'run the tests' })]
  ])('produces no protocol message for %s', (_name, message) => {
    expect(stepOnce(message)).toEqual([])
  })
})

describe('makeSessionEventReducer — background tasks', () => {
  const changed = (tasks: ReadonlyArray<Record<string, unknown>>): SDKMessage =>
    system('background_tasks_changed', { tasks })

  it('reports every running background task by id and description', () => {
    const emitted = stepOnce(
      changed([
        { task_id: 'b1', task_type: 'local_bash', description: 'Run the test watcher' },
        { task_id: 'a1', task_type: 'local_agent', description: 'Review the diff' }
      ])
    )
    expect(emitted).toEqual([
      {
        _tag: 'BackgroundTasksChanged',
        tasks: [
          { taskId: 'b1', description: 'Run the test watcher' },
          { taskId: 'a1', description: 'Review the diff' }
        ]
      }
    ])
  })

  it('leaves out ambient tasks, which the SDK says are not activity', () => {
    const emitted = stepOnce(
      changed([
        { task_id: 'w1', task_type: 'monitor', description: 'Watch settings', ambient: true },
        { task_id: 'b1', task_type: 'local_bash', description: 'Run the build' }
      ])
    )
    expect(emitted).toEqual([
      { _tag: 'BackgroundTasksChanged', tasks: [{ taskId: 'b1', description: 'Run the build' }] }
    ])
  })

  it('reports an empty set when the last background task ends', () => {
    expect(stepOnce(changed([]))).toEqual([{ _tag: 'BackgroundTasksChanged', tasks: [] }])
  })
})

describe('makeSessionEventReducer — one-line notices and recovered refusals', () => {
  const mainAssistantText = (stopReason: string): SDKMessage =>
    sdkMessage({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: 'Here is another way.' }],
        stop_reason: stopReason
      }
    })
  const refusal = system('model_refusal_no_fallback', {
    original_model: 'claude-opus-5-5',
    request_id: null,
    content: ''
  })

  it('shows only the first line of a multi-line notification', () => {
    const emitted = stepOnce(
      system('notification', {
        key: 'mcp',
        text: 'MCP server failed\n  at connect',
        priority: 'high'
      })
    )
    expect(emitted).toEqual([{ _tag: 'SessionNotice', text: 'MCP server failed' }])
  })

  it('shows only the first line of a multi-line plugin install error', () => {
    const emitted = stepOnce(
      system('plugin_install', { status: 'failed', name: 'acme', error: 'ENOTFOUND\n  at fetch' })
    )
    expect(emitted).toEqual([
      { _tag: 'SessionNotice', text: 'Plugin install failed: acme: ENOTFOUND' }
    ])
  })

  it('names the refusing model alone when the refusal has no reason', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(refusal)
    expect(reducer.step(success())).toEqual([
      { _tag: 'TurnErrored', error: { message: 'claude-opus-5-5 declined the request' } }
    ])
  })

  it('completes the turn when the main agent wrote more text after the refusal', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(refusal)
    reducer.step(mainAssistantText('end_turn'))
    expect(reducer.step(success())).toEqual([{ _tag: 'TurnCompleted' }])
  })

  it('keeps the refusal when the text arrives on the refused assistant frame', () => {
    const reducer = makeSessionEventReducer(Option.none())
    reducer.step(refusal)
    reducer.step(mainAssistantText('refusal'))
    expect(reducer.step(success())).toEqual([
      { _tag: 'TurnErrored', error: { message: 'claude-opus-5-5 declined the request' } }
    ])
  })
})
