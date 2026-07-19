import { Result } from '@effect-atom/atom'
import { useAtomSet, useAtomValue } from '@effect-atom/atom-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@renderer/components/ui/alert-dialog'
import { Marker, MarkerContent, MarkerIcon } from '@renderer/components/ui/marker'
import { Message, MessageContent } from '@renderer/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport
} from '@renderer/components/ui/message-scroller'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { PERMISSION_MODE_OPTIONS } from '@renderer/lib/permission-modes'
import {
  type ActiveSlashToken,
  activeSlashToken,
  filterSlashCommands,
  slashCommandCompletion,
  wrapHighlight
} from '@renderer/lib/slash-command-menu'
import { THINKING_LEVEL_OPTIONS } from '@renderer/lib/thinking-levels'
import { cn } from '@renderer/lib/utils'
import {
  type AttentionState,
  Idle,
  type PermissionResponse,
  type QuestionResponse
} from '@shared/domain/attention'
import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_LEVEL,
  type PermissionMode,
  type ThinkingLevel
} from '@shared/domain/pane'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import type {
  PanePermissionRequested,
  PanePlanReviewRequested,
  PaneQuestionRequested
} from '@shared/ipc/contract'
import { useForm } from '@tanstack/react-form'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Brain, Check, Loader2Icon, RotateCcw, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PaneMessage, ToolCallPart } from '../lib/pane-chat'
import { emptyPaneChatState } from '../lib/pane-chat'
import { paneChatAtom, paneRewindAtom, paneSendAtom } from '../lib/pane-chat-atoms'
import { ClarifyingQuestionCard } from './clarifying-question-card'
import { Markdown } from './markdown'
import { PermissionRequestCard } from './permission-request-card'
import { PlanReviewCard } from './plan-review-card'
import { PulseIndicator } from './pulse-indicator'
import { SlashCommandMenu, slashMenuListboxId, slashMenuOptionId } from './slash-command-menu'
import { Bubble, BubbleContent } from './ui/bubble'
import { Button } from './ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from './ui/input-group'

interface PaneProps {
  paneId: string
  cwd?: string
  sourceRepo?: string
  thinkingLevel?: ThinkingLevel
  permissionMode?: PermissionMode
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

function ToolCallRow({ part }: { part: ToolCallPart }): React.JSX.Element {
  const status = part.state
  const summary = toolInputSummary(part.input)
  const output = formatToolOutput(part.output)
  const row = (
    <Marker className="pl-0.5 font-mono text-xs">
      <MarkerIcon className="flex items-center justify-center">
        {status === 'running' ? (
          <span className="size-1.5 animate-pulse-slow rounded-full bg-muted-foreground motion-reduce:animate-none" />
        ) : (
          <Check className="size-3 text-muted-foreground/70" strokeWidth={2.5} />
        )}
      </MarkerIcon>
      <MarkerContent className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-foreground/90">{part.name}</span>
        {summary !== undefined && (
          <span className="truncate text-muted-foreground/80">{summary}</span>
        )}
      </MarkerContent>
      <span className="sr-only">{status === 'running' ? 'running' : 'completed'}</span>
    </Marker>
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

function ThinkingDisclosure({ content }: { content: string }): React.JSX.Element {
  return (
    <details className="min-w-0">
      <summary className="w-fit cursor-pointer list-none">
        <Marker className="w-fit font-mono text-xs">
          <MarkerIcon>
            <Brain className="size-3" />
          </MarkerIcon>
          <MarkerContent>Thinking</MarkerContent>
        </Marker>
      </summary>
      <div className="mt-1 pl-3">
        <Markdown content={content} className="text-muted-foreground" />
      </div>
    </details>
  )
}

/**
 * Renders one {@link PaneMessage} as an aligned bubble stack: user turns as a
 * single trailing tinted bubble, assistant turns as their ordered parts
 * (collapsed thinking disclosures, text bubbles, tool-call status rows).
 * Thinking parts render as a collapsed `Thinking` disclosure, click to expand.
 * Text parts render markdown directly with no reveal animation. When `onRewind`
 * is provided and the turn is a rewindable user turn (carries a
 * `checkpointUuid`), a hover-revealed separator marker is shown below the
 * message with a rewind action that invokes `onRewind` with this message.
 * Pass a message from a pane's chat state ({@link paneChatAtom}).
 */
export function MessageView({
  message,
  onRewind
}: {
  message: PaneMessage
  onRewind?: (message: PaneMessage) => void
}): React.JSX.Element {
  if (message.role === 'notice') {
    const text = message.parts.find((part) => part.type === 'text')?.content ?? ''
    return (
      <Marker variant="separator" className="py-1 text-xs">
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    )
  }
  const isUser = message.role === 'user'
  const canRewind = isUser && message.checkpointUuid !== undefined && onRewind !== undefined
  return (
    <div className={canRewind ? 'group/turn' : undefined}>
      <Message align={isUser ? 'end' : 'start'}>
        <MessageContent>
          {message.parts.map((part, index) => {
            const key = `${message.id}:${index}`
            if (part.type === 'thinking') {
              if (part.content.trim() === '') return null
              return <ThinkingDisclosure key={key} content={part.content} />
            }
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
      {canRewind && (
        <Marker
          variant="separator"
          className="mt-1 opacity-0 after:hidden transition-opacity group-hover/turn:opacity-100 group-focus-within/turn:opacity-100 motion-reduce:transition-none"
        >
          <MarkerContent>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="Rewind to this point"
              onClick={() => onRewind(message)}
              className="gap-1 text-muted-foreground hover:text-foreground"
            >
              <RotateCcw />
              Rewind to this point
            </Button>
          </MarkerContent>
        </Marker>
      )}
    </div>
  )
}

function ThinkingLevelSelect({
  value,
  onChange
}: {
  value: ThinkingLevel
  onChange: (level: ThinkingLevel) => void
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label="Thinking level"
        className="gap-1 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent/50"
      >
        <Brain />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {THINKING_LEVEL_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function PermissionModeSelect({
  value,
  onChange
}: {
  value: PermissionMode
  onChange: (mode: PermissionMode) => void
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        size="sm"
        aria-label="Permission mode"
        className="gap-1 border-0 bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent/50"
      >
        <ShieldCheck />
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {PERMISSION_MODE_OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function PaneChat({
  paneId,
  thinkingLevel,
  onThinkingLevelChange,
  permissionMode,
  onPermissionModeChange
}: {
  paneId: string
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange: (level: ThinkingLevel) => void
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const pendingPermissionQueryKey = ['pane', paneId, 'pendingPermission'] as const
  const pendingQuestionQueryKey = ['pane', paneId, 'pendingQuestion'] as const
  const pendingPlanReviewQueryKey = ['pane', paneId, 'pendingPlanReview'] as const

  const chat = Result.getOrElse(useAtomValue(paneChatAtom(paneId)), () => emptyPaneChatState)
  const sendMessage = useAtomSet(paneSendAtom(paneId))
  const rewind = useAtomSet(paneRewindAtom(paneId))
  const [rewindTarget, setRewindTarget] = useState<PaneMessage | null>(null)

  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [caret, setCaret] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
  const { data: pendingPlanReview = null } = useQuery<PanePlanReviewRequested | null>({
    queryKey: pendingPlanReviewQueryKey,
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

  useEffect(() => {
    return window.dia.onPlanReviewRequested((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<PanePlanReviewRequested | null>(pendingPlanReviewQueryKey, event)
    })
  }, [queryClient, paneId, pendingPlanReviewQueryKey])

  const form = useForm({
    defaultValues: { text: '' },
    onSubmit: ({ value, formApi }) => {
      const text = value.text.trim()
      if (!text) return
      sendMessage(text)
      queryClient.setQueryData<PanePermissionRequested | null>(pendingPermissionQueryKey, null)
      queryClient.setQueryData<PaneQuestionRequested | null>(pendingQuestionQueryKey, null)
      queryClient.setQueryData<PanePlanReviewRequested | null>(pendingPlanReviewQueryKey, null)
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

  function respondToPlanReview(approved: boolean): void {
    if (!pendingPlanReview) return
    window.dia.resolvePlanReview(paneId, pendingPlanReview.requestId, approved)
    queryClient.setQueryData<PanePlanReviewRequested | null>(pendingPlanReviewQueryKey, null)
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
                  <MessageView message={message} onRewind={setRewindTarget} />
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
      {pendingPlanReview !== null && (
        <PlanReviewCard request={pendingPlanReview} onResolve={respondToPlanReview} />
      )}
      <form
        className="mt-2"
        onSubmit={(event) => {
          event.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.Field name="text">
          {(field) => {
            const token = activeSlashToken(field.state.value, caret)
            const matches =
              token === null ? [] : filterSlashCommands(chat.slashCommands, token.query)
            const isMenuOpen = matches.length > 0 && !slashDismissed
            const highlight = wrapHighlight(slashHighlight, 0, matches.length)

            const changeText = (value: string, nextCaret: number): void => {
              field.handleChange(value)
              setCaret(nextCaret)
              setSlashDismissed(false)
              setSlashHighlight(0)
            }
            const selectCommand = (command: SlashCommandInfo, at: ActiveSlashToken): void => {
              const completion = slashCommandCompletion(command)
              const value =
                field.state.value.slice(0, at.start) + completion + field.state.value.slice(at.end)
              const nextCaret = at.start + completion.length
              field.handleChange(value)
              setSlashHighlight(0)
              requestAnimationFrame(() => {
                const element = textareaRef.current
                if (element === null) return
                element.selectionStart = nextCaret
                element.selectionEnd = nextCaret
                setCaret(nextCaret)
              })
            }

            return (
              <div className="relative">
                {chat.warmingCommands && (
                  <div className="mb-1.5 flex items-center gap-2 px-1 text-muted-foreground text-xs">
                    <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    Loading commands…
                  </div>
                )}
                {isMenuOpen && token !== null && (
                  <SlashCommandMenu
                    paneId={paneId}
                    commands={matches}
                    highlightedIndex={highlight}
                    onSelect={(command) => selectCommand(command, token)}
                    onHighlight={setSlashHighlight}
                  />
                )}
                <InputGroup>
                  <InputGroupTextarea
                    ref={textareaRef}
                    className="min-h-14"
                    value={field.state.value}
                    onChange={(event) =>
                      changeText(event.target.value, event.target.selectionStart)
                    }
                    onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                    onKeyDown={(event) => {
                      if (isMenuOpen) {
                        if (event.key === 'ArrowDown') {
                          event.preventDefault()
                          setSlashHighlight(wrapHighlight(highlight, 1, matches.length))
                          return
                        }
                        if (event.key === 'ArrowUp') {
                          event.preventDefault()
                          setSlashHighlight(wrapHighlight(highlight, -1, matches.length))
                          return
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setSlashDismissed(true)
                          return
                        }
                        if (
                          (event.key === 'Enter' || event.key === 'Tab') &&
                          !event.shiftKey &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault()
                          const command = matches[highlight]
                          if (command !== undefined && token !== null) {
                            selectCommand(command, token)
                          }
                          return
                        }
                      }
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault()
                        void form.handleSubmit()
                      }
                    }}
                    role="combobox"
                    aria-expanded={isMenuOpen}
                    aria-controls={slashMenuListboxId(paneId)}
                    aria-autocomplete="list"
                    aria-activedescendant={
                      isMenuOpen ? slashMenuOptionId(paneId, highlight) : undefined
                    }
                    placeholder="Message dia..."
                    aria-label="Message dia"
                  />
                  <InputGroupAddon align="block-end">
                    <ThinkingLevelSelect value={thinkingLevel} onChange={onThinkingLevelChange} />
                    <PermissionModeSelect
                      value={permissionMode}
                      onChange={onPermissionModeChange}
                    />
                    <InputGroupButton
                      type="submit"
                      variant="default"
                      size="icon-sm"
                      className="ml-auto"
                      aria-label="Send message"
                      disabled={field.state.value.trim() === ''}
                    >
                      <ArrowUp />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </div>
            )
          }}
        </form.Field>
      </form>
      <AlertDialog
        open={rewindTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRewindTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rewind to this point?</AlertDialogTitle>
            <AlertDialogDescription>
              This restores your files and the conversation to just before this message. Everything
              after it — later messages and the file edits Claude made — is discarded. Changes made
              through the terminal can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (rewindTarget?.checkpointUuid !== undefined) {
                  rewind({
                    checkpointUuid: rewindTarget.checkpointUuid,
                    resumeAnchorUuid: rewindTarget.resumeAnchorUuid
                  })
                }
                setRewindTarget(null)
              }}
            >
              Rewind
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function Pane({
  paneId,
  cwd,
  sourceRepo,
  thinkingLevel,
  permissionMode,
  isFocused = false,
  isDimmed = false,
  onFocus
}: PaneProps) {
  const queryClient = useQueryClient()
  const attentionQueryKey = ['pane', paneId, 'attention'] as const

  const [level, setLevel] = useState<ThinkingLevel>(thinkingLevel ?? DEFAULT_THINKING_LEVEL)
  const [mode, setMode] = useState<PermissionMode>(permissionMode ?? DEFAULT_PERMISSION_MODE)

  function changeThinkingLevel(next: ThinkingLevel): void {
    setLevel(next)
    window.dia.setThinkingLevel(paneId, next)
  }

  function changePermissionMode(next: PermissionMode): void {
    setMode(next)
    window.dia.setPermissionMode(paneId, next)
  }

  useEffect(() => {
    if (permissionMode !== undefined) setMode(permissionMode)
  }, [permissionMode])

  const { data: attention = Idle.make({}) } = useQuery<AttentionState>({
    queryKey: attentionQueryKey,
    queryFn: () => Idle.make({}),
    staleTime: Infinity
  })

  useEffect(() => {
    return window.dia.onAttentionChanged((event) => {
      if (event.paneId !== paneId) return
      queryClient.setQueryData<AttentionState>(attentionQueryKey, event.attention)
    })
  }, [queryClient, paneId, attentionQueryKey])

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
        <PaneChat
          key={paneId}
          paneId={paneId}
          thinkingLevel={level}
          onThinkingLevelChange={changeThinkingLevel}
          permissionMode={mode}
          onPermissionModeChange={changePermissionMode}
        />
      </div>
    </div>
  )
}

export default Pane
