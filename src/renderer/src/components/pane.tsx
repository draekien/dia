import {
  type AttentionState,
  Idle,
  type PermissionResponse,
  type QuestionResponse
} from '@shared/domain/attention'
import type {
  PanePermissionRequested,
  PaneQuestionRequested,
  PaneToolCallCompleted
} from '@shared/ipc/contract'
import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect } from 'react'
import { ClarifyingQuestionCard } from './clarifying-question-card'
import { PermissionRequestCard } from './permission-request-card'
import { PulseIndicator } from './pulse-indicator'

interface MessageItem {
  kind: 'message'
  role: 'user' | 'assistant'
  content: string
}

type ToolInput = PaneToolCallCompleted['input']

interface ToolEventItem {
  kind: 'tool'
  toolCallId: string
  toolName: string
  status: 'running' | 'done'
  input?: ToolInput
}

type TimelineItem = MessageItem | ToolEventItem

interface PaneProps {
  paneId: string
  cwd?: string
  sourceRepo?: string
  isFocused?: boolean
  isDimmed?: boolean
  onFocus?: () => void
}

export function dirName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSeparator === -1 ? normalized : normalized.slice(lastSeparator + 1)
}

const summaryKeys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt'] as const

function toolInputSummary(input: ToolInput | undefined): string | undefined {
  if (input === undefined) return undefined
  for (const key of summaryKeys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return key === 'file_path' || key === 'path' ? dirName(value) : value
    }
  }
  return undefined
}

function ToolEventRow({ event }: { event: ToolEventItem }): React.JSX.Element {
  const running = event.status === 'running'
  const summary = toolInputSummary(event.input)
  return (
    <div className="flex items-center gap-2 pl-0.5 font-mono text-xs text-ink-muted">
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
        {running ? (
          <span className="size-1.5 animate-pulse-slow rounded-full bg-ink-muted motion-reduce:animate-none" />
        ) : (
          <Check className="size-3 text-ink-muted/70" strokeWidth={2.5} />
        )}
      </span>
      <span className="shrink-0 text-ink/90">{event.toolName}</span>
      {summary !== undefined && <span className="truncate text-ink-muted/80">{summary}</span>}
      <span className="sr-only">{running ? 'running' : 'completed'}</span>
    </div>
  )
}

function Pane({
  paneId,
  cwd,
  sourceRepo,
  isFocused = false,
  isDimmed = false,
  onFocus
}: PaneProps) {
  const queryClient = useQueryClient()
  const timelineQueryKey = ['pane', paneId, 'timeline'] as const
  const attentionQueryKey = ['pane', paneId, 'attention'] as const
  const streamingTextQueryKey = ['pane', paneId, 'streamingText'] as const
  const pendingPermissionQueryKey = ['pane', paneId, 'pendingPermission'] as const
  const pendingQuestionQueryKey = ['pane', paneId, 'pendingQuestion'] as const

  const { data: timeline = [] } = useQuery<TimelineItem[]>({
    queryKey: timelineQueryKey,
    queryFn: () =>
      window.dia.getPaneHistory(paneId).then((history) =>
        history.map(
          (message): TimelineItem => ({
            kind: 'message',
            role: message.role,
            content: message.content
          })
        )
      ),
    staleTime: Infinity
  })
  const { data: attention = Idle.make({}) } = useQuery<AttentionState>({
    queryKey: attentionQueryKey,
    queryFn: () => Idle.make({}),
    staleTime: Infinity
  })
  const { data: streamingText = '' } = useQuery<string>({
    queryKey: streamingTextQueryKey,
    queryFn: () => '',
    staleTime: Infinity
  })
  const { data: pendingPermission = null } = useQuery<PanePermissionRequested | null>({
    queryKey: pendingPermissionQueryKey,
    queryFn: () => null,
    staleTime: Infinity
  })
  const { data: pendingQuestion = null } = useQuery<PaneQuestionRequested | null>({
    queryKey: pendingQuestionQueryKey,
    queryFn: () => null,
    staleTime: Infinity
  })

  useEffect(() => {
    return window.dia.onMessageAppended((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<TimelineItem[]>(timelineQueryKey, (prev = []) => [
        ...prev,
        { kind: 'message', role: event.message.role, content: event.message.content }
      ])
      if (event.message.role === 'assistant') {
        queryClient.setQueryData<string>(streamingTextQueryKey, '')
      }
    })
  }, [queryClient, paneId, timelineQueryKey, streamingTextQueryKey])

  useEffect(() => {
    return window.dia.onAssistantTextDelta((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<string>(streamingTextQueryKey, (prev = '') => prev + event.text)
    })
  }, [queryClient, paneId, streamingTextQueryKey])

  useEffect(() => {
    return window.dia.onToolCallStarted((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<TimelineItem[]>(timelineQueryKey, (prev = []) =>
        prev.some((item) => item.kind === 'tool' && item.toolCallId === event.toolCallId)
          ? prev
          : [
              ...prev,
              {
                kind: 'tool',
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                status: 'running'
              }
            ]
      )
    })
  }, [queryClient, paneId, timelineQueryKey])

  useEffect(() => {
    return window.dia.onToolCallCompleted((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<TimelineItem[]>(timelineQueryKey, (prev = []) =>
        prev.map((item) =>
          item.kind === 'tool' && item.toolCallId === event.toolCallId
            ? { ...item, status: 'done', input: event.input }
            : item
        )
      )
    })
  }, [queryClient, paneId, timelineQueryKey])

  useEffect(() => {
    return window.dia.onAttentionChanged((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<AttentionState>(attentionQueryKey, event.attention)
    })
  }, [queryClient, paneId, attentionQueryKey])

  useEffect(() => {
    return window.dia.onPermissionRequested((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<PanePermissionRequested | null>(pendingPermissionQueryKey, event)
    })
  }, [queryClient, paneId, pendingPermissionQueryKey])

  useEffect(() => {
    return window.dia.onQuestionRequested((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<PaneQuestionRequested | null>(pendingQuestionQueryKey, event)
    })
  }, [queryClient, paneId, pendingQuestionQueryKey])

  const form = useForm({
    defaultValues: { text: '' },
    onSubmit: ({ value, formApi }) => {
      const text = value.text.trim()
      if (!text) return
      queryClient.setQueryData<TimelineItem[]>(timelineQueryKey, (prev = []) => [
        ...prev,
        { kind: 'message', role: 'user', content: text }
      ])
      window.dia.sendMessage(paneId, text)
      queryClient.setQueryData<PanePermissionRequested | null>(pendingPermissionQueryKey, null)
      queryClient.setQueryData<PaneQuestionRequested | null>(pendingQuestionQueryKey, null)
      formApi.reset()
    }
  })

  function respondToPermission(response: PermissionResponse): void {
    if (!pendingPermission) return
    window.dia.resolvePermission(paneId, pendingPermission.requestId, response)
    queryClient.setQueryData<PanePermissionRequested | null>(pendingPermissionQueryKey, null)
  }

  function respondToQuestion(response: QuestionResponse): void {
    if (!pendingQuestion) return
    window.dia.resolveQuestion(paneId, pendingQuestion.requestId, response)
    queryClient.setQueryData<PaneQuestionRequested | null>(pendingQuestionQueryKey, null)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: tracks focus bubbling up from any descendant control to mark this pane active
    <div
      // biome-ignore lint/a11y/noNoninteractiveTabindex: must itself be focusable so clicking empty pane space still activates it
      tabIndex={0}
      onFocus={onFocus}
      className={`relative flex h-full flex-col bg-neutral-950 p-4 text-neutral-100 outline-none transition-shadow ${
        isFocused ? 'ring-2 ring-ring ring-inset' : ''
      }`}
    >
      <div
        className={`flex h-full min-h-0 flex-1 flex-col transition-opacity duration-200 ease-out motion-reduce:transition-none ${
          isDimmed ? 'opacity-50' : 'opacity-100'
        }`}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <PulseIndicator attention={attention} />
            {cwd !== undefined && (
              <span
                title={sourceRepo !== undefined ? `${sourceRepo} (worktree at ${cwd})` : cwd}
                className="flex min-w-0 items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-400"
              >
                <span className="truncate">{dirName(sourceRepo ?? cwd)}</span>
                {sourceRepo !== undefined && (
                  <span className="shrink-0 rounded-sm bg-neutral-800 px-1 text-[10px] text-neutral-500">
                    worktree
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="rounded border border-neutral-700 px-2 py-1 text-xs"
              onClick={() => window.dia.splitPane(paneId, 'row')}
            >
              Split ↔
            </button>
            <button
              type="button"
              className="rounded border border-neutral-700 px-2 py-1 text-xs"
              onClick={() => window.dia.splitPane(paneId, 'column')}
            >
              Split ↕
            </button>
            <button
              type="button"
              className="rounded border border-neutral-700 px-2 py-1 text-xs"
              onClick={() => window.dia.closePane(paneId)}
            >
              Close
            </button>
          </div>
        </div>
        <div className="flex-1 space-y-2 overflow-y-auto">
          {timeline.map((item, index) => {
            if (item.kind === 'tool') {
              // biome-ignore lint/suspicious/noArrayIndexKey: timeline is append-only; items only update in place, never reorder
              return <ToolEventRow key={index} event={item} />
            }
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: timeline is append-only; items only update in place, never reorder
              <div key={index} className={item.role === 'user' ? 'text-right' : 'text-left'}>
                <span className="inline-block rounded bg-neutral-800 px-3 py-1">
                  {item.content}
                </span>
              </div>
            )
          })}
          {streamingText !== '' && (
            <div className="text-left">
              <span className="inline-block rounded bg-neutral-800 px-3 py-1">{streamingText}</span>
            </div>
          )}
        </div>
        {pendingPermission !== null && (
          <PermissionRequestCard request={pendingPermission} onResolve={respondToPermission} />
        )}
        {pendingQuestion !== null && (
          <ClarifyingQuestionCard request={pendingQuestion} onResolve={respondToQuestion} />
        )}
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <form.Field name="text">
            {(field) => (
              <input
                className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Message dia..."
              />
            )}
          </form.Field>
          <button type="submit" className="rounded bg-neutral-100 px-3 py-1 text-neutral-950">
            Send
          </button>
        </form>
      </div>
    </div>
  )
}

export default Pane
