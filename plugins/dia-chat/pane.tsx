import {
  actions,
  awaitsUser,
  Bubble,
  BubbleContent,
  Button,
  cn,
  disabledPermissionModesFor,
  findModelOption,
  fitThinkingLevel,
  formatElapsed,
  formatResetTime,
  hasSteps,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  InstallNotice,
  isParkNotice,
  lastUserText,
  Marker,
  MarkerContent,
  MarkerIcon,
  Message,
  MessageContent,
  type MessagePart,
  offeredPermissionModes,
  type PaneChatState,
  type PaneMessage,
  PERMISSION_MODE_OPTIONS,
  PermissionModeItems,
  paneChatAtom,
  paneEditQueuedAtom,
  paneInterruptAtom,
  paneRemoveQueuedAtom,
  paneRewindAtom,
  paneSendAtom,
  paneSendQueuedNowAtom,
  revealRailCard,
  rewindRowState,
  rewindTargets,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SessionRail,
  StepStatusIcon,
  type StepsSection as StepsSectionBlock,
  sendModeAtom,
  sendModeForEnter,
  showsSetup,
  TabSetupSteps,
  type ToolCallPart,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  thinkingLevelLabel,
  thinkingLevelsFor,
  turnActivity,
  turnBlocks,
  useAdapterStatus,
  useAgentSummaries,
  useAttachmentTypes,
  useDisabledPermissionModes,
  useList,
  useModelCatalog,
  useRailCardShown,
  useRailLayout,
  useTranscriptWidth
} from '@dia/renderer-plugin'
import { RailCardsSlot } from '@dia-plugin/dia-chat/slots'
import { useAtom, useAtomSet, useAtomValue } from '@effect/atom-react'
import type { AgentSummary } from '@shared/domain/agent-summary'
import { PathAttachment, type ProjectEntry } from '@shared/domain/attachment'
import type {
  PermissionResponse,
  QuestionResponse,
  UserInputRequest
} from '@shared/domain/attention'
import type { SendMode } from '@shared/domain/message-queue'
import {
  DEFAULT_PERMISSION_MODE,
  DEFAULT_THINKING_LEVEL,
  type PermissionMode,
  type ThinkingLevel
} from '@shared/domain/pane'
import type { SlashCommandInfo } from '@shared/domain/slash-command'
import { useForm } from '@tanstack/react-form'
import { cva } from 'class-variance-authority'
import { AsyncResult } from 'effect/reactivity'
import {
  AlertTriangle,
  ArrowUp,
  Brain,
  ListPlus,
  Loader2Icon,
  Plus,
  RotateCcw,
  SquareIcon
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AttachmentChip, SentAttachments } from './attachment-chips'
import {
  activeMentionToken,
  entryPath,
  filterProjectEntries,
  removeToken
} from './attachment-draft'
import { ClarifyingQuestionCard, type ClarifyingQuestionHandle } from './clarifying-question-card'
import {
  type ComposerAction,
  composerAction,
  composerActionHint,
  composerPlaceholder
} from './composer-action'
import {
  composerSettingTrigger,
  permissionSettingLabel,
  thinkingSettingLabel
} from './composer-settings'
import { CONTEXT_CARD_ID } from './context-card'
import { contextColor, contextNeedsAttention, contextPercent } from './context-meter'
import { Markdown } from './markdown'
import { ModelPicker } from './model-picker'
import { PathMenu, pathMenuListboxId, pathMenuOptionId } from './path-menu'
import { PermissionRequestCard } from './permission-request-card'
import { PlanReviewCard } from './plan-review-card'
import { QueuedMessages } from './queued-messages'
import { RewindAction, type RewindActionProps } from './rewind-action'
import {
  activeSlashToken,
  completeSlashCommand,
  filterSlashCommands,
  type TriggerToken,
  wrapHighlight
} from './slash-command-filter'
import { SlashCommandMenu, slashMenuListboxId, slashMenuOptionId } from './slash-command-menu'
import { type LiveSteps, StepsSection, summaryFocus } from './steps-section'
import { approximateTokens, exactTokens } from './token-count'
import { TranscriptItem, TranscriptScroller } from './transcript-scroller'
import { StallActions, TurnActivityLine } from './turn-activity-line'
import { filesOf, useComposerAttachments, useProjectEntries } from './use-composer-attachments'
import { useElapsedClock } from './use-elapsed-clock'
import { usePaneChat } from './use-pane-chat'

interface PaneProps {
  paneId: string
  cwd: string
  model: string
  thinkingLevel?: ThinkingLevel
  permissionMode?: PermissionMode
  focusComposer?: boolean
  projectName?: string
  branch?: string
  /** The session's owner sets its model, thinking level and permission mode; hides their pickers and rewind. */
  fixedSettings?: boolean
}

const CONTEXT_CARD_KEY = `chat.${CONTEXT_CARD_ID}`

/** The classes of the centred transcript column, capped at the app-wide transcript `width`. */
export const transcriptColumn = cva('mx-auto w-full', {
  variants: {
    width: {
      narrow: 'max-w-2xl',
      default: 'max-w-3xl',
      wide: 'max-w-5xl'
    }
  }
})

const COLUMN_MAX_PX = { narrow: 672, default: 768, wide: 1024 } as const

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

function ToolCallLabel({ part }: { part: ToolCallPart }): React.JSX.Element {
  const summary = toolInputSummary(part.input)
  return (
    <>
      <span className="shrink-0 text-foreground/90">{part.name}</span>
      {summary !== undefined && (
        <span className="truncate text-muted-foreground" title={summary}>
          {summary}
        </span>
      )}
    </>
  )
}

type ToolCallStatus = 'running' | 'failed' | 'completed'

const toolCallStatus = (part: ToolCallPart): ToolCallStatus => {
  if (part.state === 'running') return 'running'
  return part.isError === true ? 'failed' : 'completed'
}

function ToolCallRow({ part }: { part: ToolCallPart }): React.JSX.Element {
  const status = toolCallStatus(part)
  const output = formatToolOutput(part.output)
  const row = (
    <Marker className="pl-0.5 font-mono text-xs">
      <MarkerIcon className="flex items-center justify-center">
        <StepStatusIcon status={status === 'completed' ? 'done' : status} />
      </MarkerIcon>
      <MarkerContent className="flex min-w-0 items-center gap-2">
        <ToolCallLabel part={part} />
        {part.detail !== undefined && (
          <span className="truncate font-sans text-muted-foreground">{part.detail}</span>
        )}
        {status === 'running' && part.elapsedSeconds !== undefined && (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatElapsed(part.elapsedSeconds * 1000)}
          </span>
        )}
      </MarkerContent>
      <span className="sr-only">{status}</span>
    </Marker>
  )
  if (output === undefined) return row
  return (
    <details className="min-w-0">
      <summary className={cn('cursor-pointer list-none hover:bg-muted/60', summaryFocus)}>
        {row}
      </summary>
      <pre className="mt-1 max-h-64 scrollbar-app overflow-auto rounded [scrollbar-gutter:auto] bg-muted px-3 py-2 font-mono text-xs text-foreground/90">
        {output}
      </pre>
    </details>
  )
}

function ThinkingDisclosure({ content }: { content: string }): React.JSX.Element {
  return (
    <details className="min-w-0">
      <summary
        className={cn('w-fit cursor-pointer list-none hover:*:text-foreground', summaryFocus)}
      >
        <Marker className="w-fit pl-0.5 text-xs">
          <MarkerIcon className="flex items-center justify-center">
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

function PartView({ part }: { part: MessagePart }): React.ReactNode {
  if (part.type === 'tool-call') return <ToolCallRow part={part} />
  if (part.content.trim() === '') return null
  if (part.type === 'thinking') return <ThinkingDisclosure content={part.content} />
  return <Markdown content={part.content} />
}

function UserPartView({ part }: { part: MessagePart }): React.ReactNode {
  if (part.type !== 'text' || part.content.trim() === '') return null
  return (
    <Bubble variant="tinted" align="end">
      <BubbleContent>
        <Markdown content={part.content} />
      </BubbleContent>
    </Bubble>
  )
}

const sectionLive = (
  section: StepsSectionBlock,
  live: LiveSteps,
  nowMs: number | undefined
): LiveSteps => {
  const firstAt = section.parts[0]?.startedAt
  return {
    ...live,
    label: live.label ?? latestStepLabel(section),
    activity:
      firstAt === undefined || nowMs === undefined || live.activity.elapsedLabel === undefined
        ? live.activity
        : {
            ...live.activity,
            elapsedLabel: formatElapsed(Math.max(0, (section.followedAt ?? nowMs) - firstAt))
          }
  }
}

const isLiveTurn = (message: PaneMessage): boolean =>
  message.role === 'assistant' && message.parts.some((part) => part.startedAt !== undefined)

function TurnBlocksView({
  message,
  live,
  nowMs
}: {
  message: PaneMessage
  live: LiveSteps | undefined
  nowMs: number | undefined
}): React.JSX.Element {
  const blocks = turnBlocks(message.parts)
  const lastSection = blocks.filter((block) => block.type === 'steps').at(-1)
  return (
    <>
      {blocks.map((block, blockIndex) => {
        const key = `${message.id}:${blockIndex}`
        if (block.type === 'text') return <PartView key={key} part={block} />
        return (
          <StepsSection
            key={key}
            section={block}
            live={
              block === lastSection && live !== undefined
                ? sectionLive(block, live, nowMs)
                : undefined
            }
          >
            {block.parts.map((part, partIndex) => {
              const partKey = `${key}:${partIndex}`
              return <PartView key={partKey} part={part} />
            })}
          </StepsSection>
        )
      })}
    </>
  )
}

function latestStepLabel(section: StepsSectionBlock): React.ReactNode {
  const latest = section.parts.at(-1)
  if (latest?.type !== 'tool-call') return 'Thinking'
  return (
    <span className="flex min-w-0 items-center gap-2 font-mono">
      <ToolCallLabel part={latest} />
    </span>
  )
}

function TokenCount({ count }: { count: number }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="cursor-default">
            <span aria-hidden="true">{approximateTokens(count)}</span>
            <span className="sr-only">{exactTokens(count)}</span>
          </span>
        }
      />
      <TooltipContent>{exactTokens(count)}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Renders one {@link PaneMessage} as an aligned bubble stack: user turns as a
 * single trailing tinted bubble, assistant turns as their ordered parts
 * (collapsed thinking disclosures, Markdown text with no bubble, tool-call status rows).
 * Thinking parts render as a collapsed `Thinking` disclosure, click to expand.
 * Text parts render markdown directly with no reveal animation. Pass `rewind` for an agent turn
 * the user may rewind to (one `rewindTargets` maps): a {@link RewindAction} row under the turn
 * shows `rewind.state` and calls `rewind.onStart` after a press and hold, keeping this turn and
 * discarding everything after it.
 * An assistant turn that streamed in this session collapses each run of steps into a section
 * and keeps its text visible between them (see {@link turnBlocks}); a turn restored from history
 * shows every part. Pass `live` for the turn still running, to show
 * its activity on its last section's summary line; `nowMs` (epoch milliseconds) times
 * that section from its first part.
 * Pass a message from a pane's chat state ({@link paneChatAtom}). A user turn's attachments show
 * as read-only chips under its text, with paths relative to `cwd`.
 */
export function MessageView({
  message,
  rewind,
  live,
  nowMs,
  cwd = ''
}: {
  message: PaneMessage
  rewind?: RewindActionProps
  live?: LiveSteps
  nowMs?: number
  cwd?: string
}): React.JSX.Element {
  if (message.role === 'user' && message.resumedAt !== undefined) {
    return (
      <Marker variant="separator" className="py-1 text-xs">
        <MarkerContent>
          Resumed at {formatResetTime(message.resumedAt, nowMs ?? message.resumedAt)}
        </MarkerContent>
      </Marker>
    )
  }
  if (message.role === 'notice') {
    const text = message.parts.find((part) => part.type === 'text')?.content ?? ''
    const compaction = message.compaction
    const link = message.link
    return (
      <Marker variant="separator" className="py-1 text-xs">
        <MarkerContent>
          {text}
          {link !== undefined && (
            <Button
              variant="link"
              size="xs"
              className="h-auto px-1 py-0"
              onClick={() =>
                actions.openPage({ plugin: link.plugin, id: link.page, target: link.target })
              }
            >
              {link.label}
            </Button>
          )}
          {compaction?.postTokens !== undefined && (
            <>
              {' — '}
              <TokenCount count={compaction.preTokens} />
              {' → '}
              <TokenCount count={compaction.postTokens} />
              <span aria-hidden="true"> tokens</span>
            </>
          )}
        </MarkerContent>
      </Marker>
    )
  }
  if (message.role === 'error') {
    const text = message.parts.find((part) => part.type === 'text')?.content ?? ''
    return (
      <Marker className="py-1 text-destructive text-xs">
        <MarkerIcon>
          <AlertTriangle className="size-3" />
        </MarkerIcon>
        <MarkerContent>{text}</MarkerContent>
      </Marker>
    )
  }
  const isUser = message.role === 'user'
  return (
    <div className={rewind !== undefined ? 'group/turn' : undefined}>
      <Message align={isUser ? 'end' : 'start'}>
        <MessageContent>
          {isLiveTurn(message) ? (
            <TurnBlocksView message={message} live={live} nowMs={nowMs} />
          ) : (
            message.parts.map((part, index) => {
              const key = `${message.id}:${index}`
              return isUser ? (
                <UserPartView key={key} part={part} />
              ) : (
                <PartView key={key} part={part} />
              )
            })
          )}
          {isUser && message.attachments !== undefined && (
            <SentAttachments attachments={message.attachments} cwd={cwd} />
          )}
        </MessageContent>
      </Message>
      {rewind !== undefined && <RewindAction {...rewind} />}
    </div>
  )
}

function ThinkingLevelSelect({
  value,
  levels,
  onChange
}: {
  value: ThinkingLevel
  levels: ReadonlyArray<ThinkingLevel>
  onChange: (level: ThinkingLevel) => void
}): React.JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label="Thinking level" className={composerSettingTrigger()}>
        <SelectValue>{thinkingSettingLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {thinkingLevelLabel(level)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function PermissionModeSelect({
  value,
  disabledModes,
  onChange
}: {
  value: PermissionMode
  disabledModes: ReadonlyArray<PermissionMode>
  onChange: (mode: PermissionMode) => void
}): React.JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Permission mode"
        className={composerSettingTrigger({
          emphasis: value === 'bypassPermissions' ? 'foreground' : 'muted'
        })}
      >
        <SelectValue>{permissionSettingLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <PermissionModeItems
          options={offeredPermissionModes(PERMISSION_MODE_OPTIONS, disabledModes, value)}
        />
      </SelectContent>
    </Select>
  )
}

const MODIFIER_KEY =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)
    ? '⌘'
    : 'Ctrl'

const actionIcons = { queue: ListPlus, sendNow: ArrowUp, stop: SquareIcon } as const

/**
 * The composer's bottom-right icon button for `action`, with `hint` as its tooltip. Clicking a
 * `stop` action calls `onStop`; clicking a `submit` action calls `onSubmit` with the click, whose
 * Cmd/Ctrl state picks the send mode. Its label is announced politely when it changes.
 */
export function ComposerActionButton({
  action,
  hint,
  onStop,
  onSubmit
}: {
  action: ComposerAction
  hint: readonly [string, string]
  onStop: () => void
  onSubmit: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const Icon = actionIcons[action.icon]
  const isStop = action.kind === 'stop'
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <InputGroupButton
              type="button"
              variant={isStop ? 'outline' : action.disabled ? 'secondary' : 'default'}
              size="icon-sm"
              className="ml-auto transition-colors duration-150 motion-reduce:transition-none"
              aria-label={action.label}
              disabled={!isStop && action.disabled}
              onClick={isStop ? onStop : onSubmit}
            >
              <Icon
                key={action.icon}
                className="animate-in duration-150 fade-in motion-reduce:animate-none"
              />
            </InputGroupButton>
          }
        />
        <TooltipContent side="top" align="end">
          {isStop ? (
            action.label
          ) : (
            <div className="flex flex-col gap-0.5">
              <span>{hint[0]}</span>
              <span className="opacity-70">{hint[1]}</span>
            </div>
          )}
        </TooltipContent>
      </Tooltip>
      <span className="sr-only" aria-live="polite">
        {action.label}
      </span>
    </>
  )
}

const unansweredRequest = (
  summary: AgentSummary | undefined,
  answeredRequestId: string | null
): UserInputRequest | undefined => {
  if (summary?.status._tag !== 'StatusNeedsInput') return undefined
  const { request } = summary.status
  return request?.requestId === answeredRequestId ? undefined : request
}

const messageActivitySignature = (state: PaneChatState): string => {
  const last = state.messages.at(-1)
  const lastPart = last?.parts.at(-1)
  const detail =
    lastPart === undefined
      ? ''
      : lastPart.type === 'tool-call'
        ? lastPart.state
        : String(lastPart.content.length)
  return `${state.messages.length}:${last?.parts.length ?? 0}:${detail}:${state.turnStatus ?? ''}`
}

function ChatSessionRail({ paneId }: { readonly paneId: string }) {
  return <SessionRail paneId={paneId} cards={useList(RailCardsSlot)} />
}

function PaneChat({
  paneId,
  cwd,
  model,
  onModelChange,
  thinkingLevel,
  thinkingLevels,
  onThinkingLevelChange,
  permissionMode,
  disabledPermissionModes,
  onPermissionModeChange,
  column,
  columnMax,
  focusComposer,
  projectName,
  branch,
  fixedSettings
}: {
  paneId: string
  cwd: string
  model: string
  onModelChange: (model: string) => void
  thinkingLevel: ThinkingLevel
  thinkingLevels: ReadonlyArray<ThinkingLevel>
  onThinkingLevelChange: (level: ThinkingLevel) => void
  permissionMode: PermissionMode
  disabledPermissionModes: ReadonlyArray<PermissionMode>
  column: string
  columnMax: number
  onPermissionModeChange: (mode: PermissionMode) => void
  focusComposer: boolean
  projectName: string | undefined
  branch: string | undefined
  fixedSettings: boolean
}): React.JSX.Element {
  const chat = usePaneChat(paneId)
  const attention = chat.attention
  const sendMessage = useAtomSet(paneSendAtom(paneId))
  const editQueued = useAtomSet(paneEditQueuedAtom(paneId))
  const removeQueued = useAtomSet(paneRemoveQueuedAtom(paneId))
  const sendQueuedNow = useAtomSet(paneSendQueuedNowAtom(paneId))
  const stop = useAtomSet(paneInterruptAtom(paneId))
  const defaultSendMode = useAtomValue(sendModeAtom)
  const [rewindProgress, commandRewind] = useAtom(paneRewindAtom(paneId))
  const targets = useMemo(() => rewindTargets(chat.messages), [chat.messages])
  const rewindRowFor = (message: PaneMessage): RewindActionProps | undefined => {
    const target = targets.get(message.id)
    if (target === undefined || fixedSettings) return undefined
    return {
      state: rewindRowState(rewindProgress, target),
      onStart: () => commandRewind({ type: 'start', target }),
      onDismiss: () => commandRewind({ type: 'dismiss' })
    }
  }

  const adapterStatus = useAdapterStatus()
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [caret, setCaret] = useState(0)
  const [modifierHeld, setModifierHeld] = useState(false)
  const [pathHighlight, setPathHighlight] = useState(0)
  const [pathDismissed, setPathDismissed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const questionRef = useRef<ClarifyingQuestionHandle>(null)
  const attachments = useComposerAttachments(useAttachmentTypes())

  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses once, when the composer first mounts
  useEffect(() => {
    if (focusComposer) textareaRef.current?.focus()
  }, [])

  const summary = useAgentSummaries().get(paneId)
  const [answeredRequestId, setAnsweredRequestId] = useState<string | null>(null)
  const pendingRequest = unansweredRequest(summary, answeredRequestId)
  const pendingPermission = pendingRequest?._tag === 'PermissionRequest' ? pendingRequest : null
  const pendingQuestion = pendingRequest?._tag === 'ClarifyingQuestion' ? pendingRequest : null
  const pendingPlanReview = pendingRequest?._tag === 'PlanReview' ? pendingRequest : null

  const isLoading = chat.isLoading
  const [paneWidth, setPaneWidth] = useState<number>()
  const rail = useRailLayout(paneWidth, columnMax)
  const historyLoaded = AsyncResult.isSuccess(useAtomValue(paneChatAtom(paneId)))
  const emptySession = chat.messages.length === 0 && !isLoading && chat.queued.length === 0
  const contextCardShown = useRailCardShown(CONTEXT_CARD_KEY)
  const compactFailed = chat.compactionFailure?.reason === 'failed'
  const contextUsage = summary?.contextUsage
  const contextWarning =
    !contextCardShown &&
    contextUsage !== undefined &&
    contextNeedsAttention(contextUsage, compactFailed)
      ? contextUsage
      : null
  const activitySignature = messageActivitySignature(chat)

  const { elapsedMs, idleMs, nowMs } = useElapsedClock(isLoading, activitySignature)
  const parkedForUser = summary !== undefined && awaitsUser(summary)
  const lastMessage = chat.messages.at(-1)
  const activity = turnActivity(chat, elapsedMs, idleMs)

  const pendingInteraction = pendingRequest !== undefined
  const answeringQuestion = pendingQuestion !== null && attachments.ready.length === 0
  const retryText = lastUserText(chat)

  const resend = (): void => {
    if (retryText !== undefined) sendMessage({ text: retryText, mode: defaultSendMode })
  }
  const interruptAndRetry = (): void => {
    if (retryText !== undefined) sendMessage({ text: retryText, mode: 'steer' })
  }
  const showActivity = activity !== null && !pendingInteraction
  const runningTurn = chat.messages.at(-1)
  const liveSteps: LiveSteps | undefined = showActivity
    ? {
        activity,
        label: chat.turnStatus ?? undefined,
        onResend: resend,
        onInterruptAndRetry: interruptAndRetry
      }
    : undefined
  const activityInSteps =
    runningTurn !== undefined && isLiveTurn(runningTurn) && hasSteps(runningTurn.parts)

  const clearPendingInteractions = (): void => {
    if (pendingRequest !== undefined) setAnsweredRequestId(pendingRequest.requestId)
  }

  const actionDefaultMode: SendMode = pendingInteraction ? 'steer' : defaultSendMode
  const trackModifier = (event: React.KeyboardEvent): void =>
    setModifierHeld(event.metaKey || event.ctrlKey)

  const stopTurn = (): void => {
    stop()
    clearPendingInteractions()
  }

  const form = useForm({
    defaultValues: { text: '' },
    onSubmitMeta: { mode: defaultSendMode } as { readonly mode: SendMode },
    onSubmit: ({ value, formApi, meta }) => {
      const text = value.text.trim()
      const ready = attachments.ready
      if (attachments.reading || (!text && ready.length === 0)) return
      if (answeringQuestion) {
        questionRef.current?.answerCurrent(text)
        formApi.reset()
        return
      }
      const mode = pendingInteraction ? 'steer' : meta.mode
      sendMessage({ text, mode, attachments: ready })
      if (mode === 'steer' || !isLoading) clearPendingInteractions()
      formApi.reset()
      attachments.clear()
    }
  })
  const mention = activeMentionToken(form.state.values.text, caret)
  const projectEntries = useProjectEntries(cwd, mention !== null)
  const mentionQuery = mention?.query ?? null
  const pathMatches = useMemo(
    () => (mentionQuery === null ? [] : filterProjectEntries(projectEntries.entries, mentionQuery)),
    [projectEntries.entries, mentionQuery]
  )

  function respondToPermission(response: PermissionResponse): void {
    if (!pendingPermission) return
    window.dia.resolvePermission(paneId, pendingPermission.requestId, response)
    setAnsweredRequestId(pendingPermission.requestId)
  }

  function respondToQuestion(response: QuestionResponse): void {
    if (!pendingQuestion) return
    window.dia.resolveQuestion(paneId, pendingQuestion.requestId, response)
    setAnsweredRequestId(pendingQuestion.requestId)
  }

  function respondToPlanReview(approved: boolean): void {
    if (!pendingPlanReview) return
    window.dia.resolvePlanReview(paneId, pendingPlanReview.requestId, approved)
    setAnsweredRequestId(pendingPlanReview.requestId)
  }

  return (
    <TranscriptScroller
      contentClassName={column}
      shiftLeft={emptySession ? 0 : rail.shiftLeft}
      centred={historyLoaded ? emptySession : null}
      onWidthChange={setPaneWidth}
      aside={emptySession ? null : <ChatSessionRail paneId={paneId} />}
      lead={
        projectName === undefined ? null : (
          <p className="mb-3 flex justify-center gap-2 text-muted-foreground text-xs">
            <span>{projectName}</span>
            {branch !== undefined && <span className="font-mono">{branch}</span>}
          </p>
        )
      }
      overlay={
        <>
          {pendingPermission !== null && (
            <PermissionRequestCard request={pendingPermission} onResolve={respondToPermission} />
          )}
          {pendingQuestion !== null && (
            <ClarifyingQuestionCard
              ref={questionRef}
              request={pendingQuestion}
              onResolve={respondToQuestion}
            />
          )}
          {pendingPlanReview !== null && (
            <PlanReviewCard request={pendingPlanReview} onResolve={respondToPlanReview} />
          )}
          <InstallNotice status={adapterStatus} />
          <form
            className="mt-2"
            onKeyDown={trackModifier}
            onKeyUp={trackModifier}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setModifierHeld(false)
            }}
            onDragOver={(event) => {
              if (!event.dataTransfer.types.includes('Files')) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'copy'
              setDragging(true)
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragging(false)
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              void attachments.add(filesOf(event.dataTransfer))
            }}
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit({ mode: defaultSendMode })
            }}
          >
            <form.Field name="text">
              {(field) => {
                const token = activeSlashToken(field.state.value, caret)
                const matches =
                  token === null ? [] : filterSlashCommands(chat.slashCommands, token.query)
                const isMenuOpen = matches.length > 0 && !slashDismissed
                const highlight = wrapHighlight(slashHighlight, 0, matches.length)
                const isPathMenuOpen = mention !== null && !isMenuOpen && !pathDismissed
                const pathIndex = wrapHighlight(pathHighlight, 0, pathMatches.length)

                const placeCaret = (nextCaret: number): void => {
                  requestAnimationFrame(() => {
                    const element = textareaRef.current
                    if (element === null) return
                    element.selectionStart = nextCaret
                    element.selectionEnd = nextCaret
                    setCaret(nextCaret)
                  })
                }
                const changeText = (value: string, nextCaret: number): void => {
                  field.handleChange(value)
                  setCaret(nextCaret)
                  setSlashDismissed(false)
                  setSlashHighlight(0)
                  setPathDismissed(false)
                  setPathHighlight(0)
                }
                const selectPath = (entry: ProjectEntry, at: TriggerToken): void => {
                  const { value, caret: nextCaret } = removeToken(field.state.value, at)
                  field.handleChange(value)
                  setPathHighlight(0)
                  attachments.attach(
                    PathAttachment.make({ path: entryPath(cwd, entry), kind: entry.kind })
                  )
                  placeCaret(nextCaret)
                }
                const selectCommand = (command: SlashCommandInfo, at: TriggerToken): void => {
                  const { value, caret: nextCaret } = completeSlashCommand(
                    field.state.value,
                    at,
                    command
                  )
                  field.handleChange(value)
                  setSlashHighlight(0)
                  placeCaret(nextCaret)
                }

                return (
                  <div className="relative">
                    {chat.warmingCommands && (
                      <div className="mb-1.5 flex items-center gap-2 px-1 text-muted-foreground text-xs">
                        <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
                        Loading commands…
                      </div>
                    )}
                    <QueuedMessages
                      queued={chat.queued}
                      held={chat.queueHeld}
                      cwd={cwd}
                      onSendNow={(messageId) => {
                        sendQueuedNow(messageId)
                        clearPendingInteractions()
                      }}
                      onEdit={(messageId, text, kept) =>
                        editQueued({ messageId, text, attachments: kept })
                      }
                      onRemove={removeQueued}
                    />
                    {isPathMenuOpen && mention !== null && (
                      <PathMenu
                        paneId={paneId}
                        entries={pathMatches}
                        loading={projectEntries.loading}
                        highlightedIndex={pathIndex}
                        onSelect={(entry) => selectPath(entry, mention)}
                        onHighlight={setPathHighlight}
                      />
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
                    <InputGroup
                      className={cn(
                        'transition-[color,box-shadow,border-color] duration-150 motion-reduce:transition-none',
                        dragging && 'outline-1 outline-primary outline-solid'
                      )}
                    >
                      {dragging && (
                        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/85 text-foreground text-sm">
                          Drop to attach
                        </div>
                      )}
                      <InputGroupTextarea
                        ref={textareaRef}
                        className="min-h-11 max-h-60"
                        value={field.state.value}
                        onChange={(event) =>
                          changeText(event.target.value, event.target.selectionStart)
                        }
                        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                        onPaste={(event) => {
                          const files = filesOf(event.clipboardData)
                          if (files.length === 0) return
                          event.preventDefault()
                          void attachments.add(files)
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === 'Backspace' &&
                            event.currentTarget.selectionStart === 0 &&
                            event.currentTarget.selectionEnd === 0 &&
                            attachments.drafts.length > 0
                          ) {
                            event.preventDefault()
                            attachments.removeLast()
                            return
                          }
                          if (isPathMenuOpen) {
                            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                              event.preventDefault()
                              setPathHighlight(
                                wrapHighlight(
                                  pathIndex,
                                  event.key === 'ArrowDown' ? 1 : -1,
                                  pathMatches.length
                                )
                              )
                              return
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault()
                              setPathDismissed(true)
                              return
                            }
                            if (
                              (event.key === 'Enter' || event.key === 'Tab') &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              const entry = pathMatches[pathIndex]
                              if (entry !== undefined && mention !== null) {
                                event.preventDefault()
                                selectPath(entry, mention)
                                return
                              }
                            }
                          }
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
                            void form.handleSubmit({
                              mode: sendModeForEnter(defaultSendMode, event)
                            })
                          }
                        }}
                        role="combobox"
                        aria-expanded={isMenuOpen || isPathMenuOpen}
                        aria-controls={
                          isPathMenuOpen ? pathMenuListboxId(paneId) : slashMenuListboxId(paneId)
                        }
                        aria-autocomplete="list"
                        aria-activedescendant={
                          isMenuOpen
                            ? slashMenuOptionId(paneId, highlight)
                            : isPathMenuOpen && pathMatches.length > 0
                              ? pathMenuOptionId(paneId, pathIndex)
                              : undefined
                        }
                        placeholder={composerPlaceholder(
                          isLoading,
                          actionDefaultMode,
                          answeringQuestion
                        )}
                        aria-label="Message dia"
                      />
                      {attachments.drafts.length > 0 && (
                        <InputGroupAddon
                          align="block-start"
                          className="flex-wrap gap-1.5 pt-1 pb-0"
                        >
                          {attachments.drafts.map((draft) => (
                            <AttachmentChip
                              key={draft.key}
                              draft={draft}
                              cwd={cwd}
                              onRemove={() => attachments.remove(draft.key)}
                            />
                          ))}
                        </InputGroupAddon>
                      )}
                      <InputGroupAddon align="block-end">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <InputGroupButton
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                className="-ml-1.5 translate-y-2.5"
                                aria-label="Attach files"
                                onClick={() => fileInputRef.current?.click()}
                              >
                                <Plus />
                              </InputGroupButton>
                            }
                          />
                          <TooltipContent>Attach files, or drop, paste or type @</TooltipContent>
                        </Tooltip>
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          hidden
                          tabIndex={-1}
                          onChange={(event) => {
                            const files = [...(event.currentTarget.files ?? [])]
                            event.currentTarget.value = ''
                            void attachments.add(
                              files.map((file) => ({ file, isDirectory: false }))
                            )
                          }}
                        />
                        <ComposerActionButton
                          action={composerAction({
                            running: isLoading,
                            hasText:
                              field.state.value.trim() !== '' || attachments.ready.length > 0,
                            modifierHeld: modifierHeld && !pendingInteraction,
                            defaultMode: actionDefaultMode,
                            answering: answeringQuestion
                          })}
                          hint={composerActionHint({
                            running: isLoading,
                            pending: pendingInteraction,
                            answering: answeringQuestion,
                            defaultMode: actionDefaultMode,
                            modifierKey: MODIFIER_KEY
                          })}
                          onStop={stopTurn}
                          onSubmit={(event) =>
                            void form.handleSubmit({
                              mode: sendModeForEnter(defaultSendMode, event)
                            })
                          }
                        />
                      </InputGroupAddon>
                    </InputGroup>
                    <div className="mt-1 flex min-w-0 items-center gap-0.5 pl-[5px]">
                      {!fixedSettings && (
                        <>
                          <ModelPicker value={model} onChange={onModelChange} />
                          <ThinkingLevelSelect
                            value={thinkingLevel}
                            levels={thinkingLevels}
                            onChange={onThinkingLevelChange}
                          />
                          <PermissionModeSelect
                            value={permissionMode}
                            disabledModes={disabledPermissionModes}
                            onChange={onPermissionModeChange}
                          />
                        </>
                      )}
                      {contextWarning !== null && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="ml-auto font-medium"
                          style={{ color: contextColor(contextWarning, compactFailed) }}
                          onClick={() => revealRailCard(CONTEXT_CARD_KEY)}
                        >
                          {contextPercent(contextWarning)}% context
                        </Button>
                      )}
                    </div>
                  </div>
                )
              }}
            </form.Field>
          </form>
        </>
      }
    >
      {chat.messages.map((message) => (
        <TranscriptItem key={message.id} anchor={message.role === 'user'}>
          <MessageView
            message={message}
            cwd={cwd}
            rewind={rewindRowFor(message)}
            live={message === runningTurn ? liveSteps : undefined}
            nowMs={nowMs}
          />
          {parkedForUser && message === lastMessage && isParkNotice(message) && (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  textareaRef.current?.focus()
                  actions.resumeParkedAgent(paneId)
                }}
              >
                Resume
              </Button>
            </div>
          )}
        </TranscriptItem>
      ))}
      {showActivity && !activityInSteps && (
        <div className="flex flex-col gap-1">
          <TurnActivityLine activity={activity} />
          {activity.stalled && (
            <StallActions
              className="pl-6"
              onResend={resend}
              onInterruptAndRetry={interruptAndRetry}
            />
          )}
        </div>
      )}
      {chat.setup !== undefined && showsSetup(chat.setup) && (
        <div className="px-1">
          <TabSetupSteps steps={chat.setup} />
        </div>
      )}
      {attention._tag === 'Errored' && retryText !== undefined && (
        <div className="flex px-1">
          <Button type="button" variant="outline" size="xs" className="gap-1" onClick={resend}>
            <RotateCcw />
            Retry
          </Button>
        </div>
      )}
    </TranscriptScroller>
  )
}

function Pane({
  paneId,
  cwd,
  model,
  thinkingLevel,
  permissionMode,
  focusComposer = false,
  projectName,
  branch,
  fixedSettings = false
}: PaneProps) {
  const [width] = useTranscriptWidth()

  const [level, setLevel] = useState<ThinkingLevel>(thinkingLevel ?? DEFAULT_THINKING_LEVEL)
  const [mode, setMode] = useState<PermissionMode>(permissionMode ?? DEFAULT_PERMISSION_MODE)

  const [chosenModel, setChosenModel] = useState(model)
  const { state: catalogState } = useModelCatalog()
  const settingsDisabledModes = useDisabledPermissionModes(cwd)
  const modelOption = (value: string) => findModelOption(catalogState, value)

  function changeModel(next: string): void {
    setChosenModel(next)
    window.dia.setModel(paneId, next)
    const nextOption = modelOption(next)
    const fitted = fitThinkingLevel(level, thinkingLevelsFor(nextOption))
    if (fitted !== level) changeThinkingLevel(fitted)
    if (disabledPermissionModesFor(settingsDisabledModes, nextOption).includes(mode)) {
      changePermissionMode('default')
    }
  }

  const [shownModelProp, setShownModelProp] = useState(model)
  if (model !== shownModelProp) {
    setShownModelProp(model)
    setChosenModel(model)
  }

  function changeThinkingLevel(next: ThinkingLevel): void {
    setLevel(next)
    window.dia.setThinkingLevel(paneId, next)
  }

  function changePermissionMode(next: PermissionMode): void {
    setMode(next)
    window.dia.setPermissionMode(paneId, next)
  }

  const [shownModeProp, setShownModeProp] = useState(permissionMode)
  if (permissionMode !== shownModeProp) {
    setShownModeProp(permissionMode)
    if (permissionMode !== undefined) setMode(permissionMode)
  }

  const thinkingLevels = thinkingLevelsFor(modelOption(chosenModel))

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop guard only, so a file dropped outside the composer does not navigate the window
    <div
      className="flex h-full flex-col bg-background text-ink"
      onDragOver={(event) => {
        if (event.defaultPrevented || !event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'none'
      }}
      onDrop={(event) => event.preventDefault()}
    >
      <PaneChat
        key={paneId}
        paneId={paneId}
        cwd={cwd}
        model={chosenModel}
        onModelChange={changeModel}
        thinkingLevel={fitThinkingLevel(level, thinkingLevels)}
        thinkingLevels={thinkingLevels}
        onThinkingLevelChange={changeThinkingLevel}
        permissionMode={mode}
        disabledPermissionModes={disabledPermissionModesFor(
          settingsDisabledModes,
          modelOption(chosenModel)
        )}
        onPermissionModeChange={changePermissionMode}
        column={transcriptColumn({ width })}
        columnMax={COLUMN_MAX_PX[width]}
        focusComposer={focusComposer}
        projectName={projectName}
        branch={branch}
        fixedSettings={fixedSettings}
      />
    </div>
  )
}

export default Pane
