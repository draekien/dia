import { cn } from '@renderer/lib/utils'
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
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeHighlightLines from 'rehype-highlight-code-lines'
import remarkGfm from 'remark-gfm'
import { ClarifyingQuestionCard } from './clarifying-question-card'
import { PermissionRequestCard } from './permission-request-card'
import { PulseIndicator } from './pulse-indicator'
import { Button } from './ui/button'
import { Input } from './ui/input'

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

const proseClassName =
  'prose prose-sm prose-invert max-w-[68ch] prose-pre:max-w-none prose-p:my-2 prose-headings:mb-2 prose-headings:mt-3 prose-pre:my-2 prose-pre:bg-background prose-code:font-mono prose-code:before:content-none prose-code:after:content-none prose-a:text-primary [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'

function Markdown({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn(proseClassName, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[
          [rehypeHighlight, { detect: true, ignoreMissing: true }],
          [rehypeHighlightLines, { showLineNumbers: true }]
        ]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

const revealCatchUpDivisor = 6

function StreamingMessage({ text }: { text: string }): React.JSX.Element {
  const [revealedLength, setRevealedLength] = useState(0)
  const targetLengthRef = useRef(text.length)
  targetLengthRef.current = text.length

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let frame = 0
    const tick = (): void => {
      setRevealedLength((current) => {
        const target = targetLengthRef.current
        if (current >= target) return current
        if (reduced) return target
        const step = Math.max(1, Math.ceil((target - current) / revealCatchUpDivisor))
        return Math.min(target, current + step)
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="animate-stream-enter text-left motion-reduce:animate-none">
      <div className="inline-block max-w-full rounded bg-surface px-3 py-2">
        <Markdown content={text.slice(0, revealedLength)} className="stream-cursor" />
      </div>
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
      className={cn(
        'relative flex h-full flex-col bg-background p-4 text-ink outline-none transition-shadow',
        isFocused && 'ring-2 ring-ring ring-inset'
      )}
    >
      <div
        className={cn(
          'flex h-full min-h-0 flex-1 flex-col transition-opacity duration-200 ease-out motion-reduce:transition-none',
          isDimmed ? 'opacity-50' : 'opacity-100'
        )}
      >
        <div className="flex items-center justify-between gap-2 pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <PulseIndicator attention={attention} />
            {cwd !== undefined && (
              <span
                title={sourceRepo !== undefined ? `${sourceRepo} (worktree at ${cwd})` : cwd}
                className="flex min-w-0 items-center gap-1.5 rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-ink-muted"
              >
                <span className="truncate">{dirName(sourceRepo ?? cwd)}</span>
                {sourceRepo !== undefined && (
                  <span className="shrink-0 rounded-sm bg-background px-1 text-xs text-ink-muted">
                    worktree
                  </span>
                )}
              </span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => window.dia.splitPane(paneId, 'row')}
            >
              Split ↔
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => window.dia.splitPane(paneId, 'column')}
            >
              Split ↕
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => window.dia.closePane(paneId)}
            >
              Close
            </Button>
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
                <div className="inline-block max-w-full rounded bg-surface px-3 py-2 text-left">
                  <Markdown content={item.content} />
                </div>
              </div>
            )
          })}
          {streamingText !== '' && <StreamingMessage text={streamingText} />}
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
              <Input
                className="flex-1"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Message dia..."
              />
            )}
          </form.Field>
          <Button type="submit" size="sm">
            Send
          </Button>
        </form>
      </div>
    </div>
  )
}

export default Pane
