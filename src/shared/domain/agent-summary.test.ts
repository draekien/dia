import { describe, expect, it } from 'vitest'
import type { IpcEvent } from '../ipc/contract'
import {
  type AgentStatus,
  type AgentSummary,
  foldSummary,
  idleSummary,
  markShown,
  NoActivity,
  StatusFailed,
  StatusFinished,
  StatusIdle,
  StatusNeedsInput,
  StatusWorking,
  statusRank,
  Todo,
  ToolUse
} from './agent-summary'
import type { AttentionState } from './attention'

const paneId = '10000000-0000-4000-8000-000000000001'
const otherPaneId = '10000000-0000-4000-8000-000000000002'

const idle = idleSummary(paneId, NoActivity.make({}))
const withStatus = (status: AgentStatus): AgentSummary => ({ ...idle, status })
const withTodo = (text: string): AgentSummary => ({ ...idle, activity: Todo.make({ text }) })

const started = (toolName: string): IpcEvent => ({
  _tag: 'PaneToolCallStarted',
  paneId,
  toolCallId: 'call-1',
  toolName
})

const completed = (toolName: string, input: Record<string, unknown>): IpcEvent => ({
  _tag: 'PaneToolCallCompleted',
  paneId,
  toolCallId: 'call-1',
  toolName,
  input,
  output: '',
  isError: false
})

const attention = (state: AttentionState): IpcEvent => ({
  _tag: 'PaneAttentionChanged',
  paneId,
  attention: state
})

describe('foldSummary activity', () => {
  it('shows the in-progress TodoWrite item by its active form', () => {
    const event = completed('TodoWrite', {
      todos: [
        { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
        { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' }
      ]
    })

    expect(foldSummary(idle, event).activity).toEqual(Todo.make({ text: 'Fixing the bug' }))
  })

  it('falls back to the in-progress item content when it has no active form', () => {
    const event = completed('TodoWrite', {
      todos: [{ content: 'Fix the bug', status: 'in_progress' }]
    })

    expect(foldSummary(idle, event).activity).toEqual(Todo.make({ text: 'Fix the bug' }))
  })

  it('shows the TodoWrite call itself when no item is in progress', () => {
    const event = completed('TodoWrite', {
      todos: [{ content: 'Done', status: 'completed', activeForm: 'Doing' }]
    })

    expect(foldSummary(withTodo('Doing'), event).activity).toEqual(
      ToolUse.make({ tool: 'TodoWrite', target: null })
    )
  })

  it('shows a started tool call without a target', () => {
    expect(foldSummary(idle, started('Read')).activity).toEqual(
      ToolUse.make({ tool: 'Read', target: null })
    )
  })

  it('shows a completed tool call with its file path as target', () => {
    const event = completed('Edit', { file_path: 'src/app.tsx', old_string: 'a' })

    expect(foldSummary(idle, event).activity).toEqual(
      ToolUse.make({ tool: 'Edit', target: 'src/app.tsx' })
    )
  })

  it('prefers command over pattern when both are present', () => {
    const event = completed('Custom', { pattern: '*.ts', command: 'pnpm test' })

    expect(foldSummary(idle, event).activity).toEqual(
      ToolUse.make({ tool: 'Custom', target: 'pnpm test' })
    )
  })

  it('shows no target when the input has none of the target fields', () => {
    const event = completed('Task', { description: 'explore' })

    expect(foldSummary(idle, event).activity).toEqual(ToolUse.make({ tool: 'Task', target: null }))
  })

  it('keeps a todo line when another tool starts', () => {
    expect(foldSummary(withTodo('Fixing the bug'), started('Read')).activity).toEqual(
      Todo.make({ text: 'Fixing the bug' })
    )
  })

  it('keeps a todo line when another tool completes', () => {
    expect(
      foldSummary(withTodo('Fixing the bug'), completed('Read', { file_path: 'a.ts' })).activity
    ).toEqual(Todo.make({ text: 'Fixing the bug' }))
  })

  it('ignores events for another pane', () => {
    expect(foldSummary(idle, { ...started('Read'), paneId: otherPaneId } as IpcEvent)).toBe(idle)
  })
})

describe('foldSummary status', () => {
  it('becomes working when user messages are sent', () => {
    const event: IpcEvent = { _tag: 'PaneUserMessagesSent', paneId, messages: [] }

    expect(foldSummary(withStatus(StatusFinished.make({})), event).status).toEqual(
      StatusWorking.make({})
    )
  })

  it('needs input with the tool and target when a permission is requested', () => {
    const event = attention({
      _tag: 'AwaitingPermission',
      request: {
        _tag: 'PermissionRequest',
        requestId: 'r',
        toolName: 'Bash',
        input: { command: 'rm -rf out' }
      }
    })

    expect(foldSummary(idle, event).status).toEqual(
      StatusNeedsInput.make({ reason: 'Allow Bash rm -rf out?' })
    )
  })

  it('needs input with the first question text when the agent asks a question', () => {
    const question = (text: string) => ({
      question: text,
      header: 'h',
      options: [],
      multiSelect: false
    })
    const event = attention({
      _tag: 'AwaitingPermission',
      request: {
        _tag: 'ClarifyingQuestion',
        requestId: 'r',
        questions: [question('Which branch?'), question('Why?')]
      }
    })

    expect(foldSummary(idle, event).status).toEqual(
      StatusNeedsInput.make({ reason: 'Which branch?' })
    )
  })

  it('needs input to review the plan when a plan review is requested', () => {
    const event = attention({
      _tag: 'AwaitingPermission',
      request: { _tag: 'PlanReview', requestId: 'r', plan: 'p' }
    })

    expect(foldSummary(idle, event).status).toEqual(
      StatusNeedsInput.make({ reason: 'Review the plan' })
    )
  })

  it('returns to working when a pending request resolves to idle', () => {
    const summary = withStatus(StatusNeedsInput.make({ reason: 'Review the plan' }))

    expect(foldSummary(summary, attention({ _tag: 'Idle' })).status).toEqual(StatusWorking.make({}))
  })

  it('stays finished when the supervisor settles completed to idle', () => {
    const summary = withStatus(StatusFinished.make({}))

    expect(foldSummary(summary, attention({ _tag: 'Idle' })).status).toEqual(
      StatusFinished.make({})
    )
  })

  it('becomes finished when the turn completes', () => {
    expect(
      foldSummary(withStatus(StatusWorking.make({})), attention({ _tag: 'Completed' })).status
    ).toEqual(StatusFinished.make({}))
  })

  it('fails with the error message when the session errors', () => {
    const event = attention({ _tag: 'Errored', error: { message: 'rate limited' } })

    expect(foldSummary(idle, event).status).toEqual(StatusFailed.make({ reason: 'rate limited' }))
  })

  it('fails with the error message when the session crashes', () => {
    const event = attention({ _tag: 'Crashed', error: { message: 'process exited' } })

    expect(foldSummary(idle, event).status).toEqual(StatusFailed.make({ reason: 'process exited' }))
  })
})

describe('markShown', () => {
  it('turns finished into idle', () => {
    expect(markShown(withStatus(StatusFinished.make({}))).status).toEqual(StatusIdle.make({}))
  })

  it('leaves a needs-input status unchanged', () => {
    const summary = withStatus(StatusNeedsInput.make({ reason: 'Review the plan' }))

    expect(markShown(summary)).toBe(summary)
  })
})

describe('statusRank', () => {
  it('orders needs input, failed, working, finished, idle', () => {
    const statuses: ReadonlyArray<AgentStatus> = [
      StatusIdle.make({}),
      StatusWorking.make({}),
      StatusFailed.make({ reason: 'x' }),
      StatusFinished.make({}),
      StatusNeedsInput.make({ reason: 'y' })
    ]

    const sorted = [...statuses]
      .sort((a, b) => statusRank(a) - statusRank(b))
      .map((status) => status._tag)

    expect(sorted).toEqual([
      'StatusNeedsInput',
      'StatusFailed',
      'StatusWorking',
      'StatusFinished',
      'StatusIdle'
    ])
  })
})
