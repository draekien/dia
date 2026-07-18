import { Message, MessageContent } from '@renderer/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@renderer/components/ui/message-scroller'
import { cn } from '@renderer/lib/utils'
import {
  type AttentionState,
  Idle,
  type PermissionResponse,
  type QuestionResponse
} from '@shared/domain/attention'
import type { ConversationMessage } from '@shared/domain/pane'
import type { PanePermissionRequested, PaneQuestionRequested } from '@shared/ipc/contract'
import type { ToolCallPart, ToolCallState, UIMessage } from '@tanstack/ai-client'
import { useChat } from '@tanstack/ai-react'
import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeHighlightLines from 'rehype-highlight-code-lines'
import remarkGfm from 'remark-gfm'
import { createPaneConnectionAdapter } from '../lib/ipc-connection-adapter'
import { ClarifyingQuestionCard } from './clarifying-question-card'
import { PermissionRequestCard } from './permission-request-card'
import { PulseIndicator } from './pulse-indicator'
import { Bubble, BubbleContent } from './ui/bubble'
import { Button } from './ui/button'
import { Input } from './ui/input'

interface PaneProps {
  paneId: string
  cwd?: string
  sourceRepo?: string
  isFocused?: boolean
  isDimmed?: boolean
  onFocus?: () => void
}

/**
 * Returns the final path segment of a filesystem path, tolerating either
 * separator and a trailing one. Use to render a compact directory/file label.
 */
export function dirName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, '')
  const lastSeparator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSeparator === -1 ? normalized : normalized.slice(lastSeparator + 1)
}

const summaryKeys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt'] as const

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) record[key] = entry
  return record
}

/**
 * Picks the most representative single-line summary of a tool call's input for
 * a compact status row (the first recognised key: command, path, pattern, …),
 * shortening paths to their final segment. Pass a parsed tool-input record;
 * returns `undefined` when nothing summarisable is present.
 */
export function toolInputSummary(input: Record<string, unknown> | undefined): string | undefined {
  if (input === undefined) return undefined
  for (const key of summaryKeys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return key === 'file_path' || key === 'path' ? dirName(value) : value
    }
  }
  return undefined
}

/**
 * Parses a tool call's `arguments` JSON string into a plain record for
 * summarising, returning `undefined` for empty or non-object arguments. Use to
 * feed {@link toolInputSummary} from a `tool-call` message part.
 */
export function parseToolArguments(argumentsJson: string): Record<string, unknown> | undefined {
  const trimmed = argumentsJson.trim()
  if (trimmed === '') return undefined
  try {
    return toRecord(JSON.parse(trimmed))
  } catch {
    return undefined
  }
}

/**
 * Renders a tool call's `output` as displayable text — strings verbatim,
 * anything else pretty-printed JSON — returning `undefined` when there is no
 * output to show. Use to decide whether to render an output disclosure.
 */
export function formatToolOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined
  if (typeof output === 'string') return output === '' ? undefined : output
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return undefined
  }
}

/**
 * Collapses a tool call's fine-grained lifecycle state into the two visual
 * states the status row distinguishes: `running` while the call is in flight,
 * `done` once it has resolved (successfully or not). Use to drive the row icon.
 */
export function toolCallDisplayState(state: ToolCallState): 'running' | 'done' {
  return state === 'complete' || state === 'error' ? 'done' : 'running'
}

/**
 * Projects a pane's persisted conversation history into `useChat`'s
 * `initialMessages`, giving each turn a stable pane-scoped id and a single
 * text part. Pass the result as `initialMessages` when mounting {@link PaneChat}.
 */
export function historyToInitialMessages(
  paneId: string,
  history: ReadonlyArray<ConversationMessage>
): UIMessage[] {
  return history.map((message, index) => ({
    id: `${paneId}:history:${index}`,
    role: message.role,
    parts: [{ type: 'text', content: message.content }]
  }))
}

/**
 * Chooses the `initialMessages` to seed `useChat` with on (re)mount: a live
 * message snapshot cached from a prior mount when present, otherwise the pane's
 * persisted history. The snapshot lets the pane survive the remount a split
 * forces without losing the current session's messages. Pass the QueryClient's
 * cached snapshot (or `undefined`) and the pane's history.
 */
export function resolveInitialMessages(
  snapshot: UIMessage[] | undefined,
  paneId: string,
  history: ReadonlyArray<ConversationMessage>
): UIMessage[] {
  return snapshot ?? historyToInitialMessages(paneId, history)
}

const typesetClassName = 'typeset typeset-docs max-w-[75ch]'

function Markdown({
  content,
  className
}: {
  content: string
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn(typesetClassName, className)}>
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

function ToolCallRow({ part }: { part: ToolCallPart }): React.JSX.Element {
  const status = toolCallDisplayState(part.state)
  const summary = toolInputSummary(parseToolArguments(part.arguments) ?? toRecord(part.input))
  const output = formatToolOutput(part.output)
  const row = (
    <div className="flex items-center gap-2 pl-0.5 font-mono text-xs text-muted-foreground">
      <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
        {status === 'running' ? (
          <span className="size-1.5 animate-pulse-slow rounded-full bg-muted-foreground motion-reduce:animate-none" />
        ) : (
          <Check className="size-3 text-muted-foreground/70" strokeWidth={2.5} />
        )}
      </span>
      <span className="shrink-0 text-foreground/90">{part.name}</span>
      {summary !== undefined && (
        <span className="truncate text-muted-foreground/80">{summary}</span>
      )}
      <span className="sr-only">{status === 'running' ? 'running' : 'completed'}</span>
    </div>
  )
  if (output === undefined) return row
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer list-none">{row}</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted px-3 py-2 font-mono text-xs text-foreground/90">
        {output}
      </pre>
    </details>
  )
}

/**
 * Renders one `useChat` message as an aligned bubble stack: user turns as a
 * single trailing tinted bubble, assistant turns as their ordered parts (text
 * bubbles, tool-call status rows). Text parts render markdown directly with no
 * reveal animation. Tool-result parts are omitted (their output is shown on the
 * tool-call part). Pass a message from `useChat`'s `messages`.
 */
export function MessageView({ message }: { message: UIMessage }): React.JSX.Element {
  const isUser = message.role === 'user'
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        {message.parts.map((part, index) => {
          const key = `${message.id}:${index}`
          if (part.type === 'text') {
            if (part.content.trim() === '') return null
            return (
              <Bubble
                key={key}
                variant={isUser ? 'tinted' : 'muted'}
                align={isUser ? 'end' : 'start'}
              >
                <BubbleContent>
                  <Markdown content={part.content} />
                </BubbleContent>
              </Bubble>
            )
          }
          if (part.type === 'tool-call') return <ToolCallRow key={key} part={part} />
          return null
        })}
      </MessageContent>
    </Message>
  )
}

function PaneChat({
  paneId,
  initialMessages
}: {
  paneId: string
  initialMessages: UIMessage[]
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const pendingPermissionQueryKey = ['pane', paneId, 'pendingPermission'] as const
  const pendingQuestionQueryKey = ['pane', paneId, 'pendingQuestion'] as const
  const messagesQueryKey = ['pane', paneId, 'messages'] as const

  const connection = useMemo(() => createPaneConnectionAdapter(paneId), [paneId])
  const chat = useChat({ connection, initialMessages, threadId: paneId })

  useEffect(() => {
    queryClient.setQueryData<UIMessage[]>(messagesQueryKey, chat.messages)
  }, [queryClient, messagesQueryKey, chat.messages])

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
      void chat.sendMessage(text)
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
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-2 py-2">
              {chat.messages.map((message) => (
                <MessageScrollerItem
                  key={message.id}
                  messageId={message.id}
                  scrollAnchor={message.role === 'user'}
                >
                  <MessageView message={message} />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
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
  const attentionQueryKey = ['pane', paneId, 'attention'] as const
  const historyQueryKey = ['pane', paneId, 'history'] as const

  const { data: attention = Idle.make({}) } = useQuery<AttentionState>({
    queryKey: attentionQueryKey,
    queryFn: () => Idle.make({}),
    staleTime: Infinity
  })
  const { data: history, isPending: isHistoryPending } = useQuery<
    ReadonlyArray<ConversationMessage>
  >({
    queryKey: historyQueryKey,
    queryFn: () => window.dia.getPaneHistory(paneId),
    staleTime: Infinity
  })

  useEffect(() => {
    return window.dia.onAttentionChanged((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<AttentionState>(attentionQueryKey, event.attention)
    })
  }, [queryClient, paneId, attentionQueryKey])

  const initialMessages = useMemo(
    () =>
      resolveInitialMessages(
        queryClient.getQueryData<UIMessage[]>(['pane', paneId, 'messages']),
        paneId,
        history ?? []
      ),
    [queryClient, paneId, history]
  )

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
        {isHistoryPending ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <PaneChat key={paneId} paneId={paneId} initialMessages={initialMessages} />
        )}
      </div>
    </div>
  )
}

export default Pane
