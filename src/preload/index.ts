import { ConversationMessage } from '@shared/domain/pane'
import { PaneNode } from '@shared/domain/pane-tree'
import { ThemePreference } from '@shared/domain/theme'
import {
  CHANNEL,
  ChooseDirectoryResult,
  ClosePane,
  CreatePane,
  type DiaApi,
  FocusPane,
  IpcEvent,
  ResolvePermission,
  ResolvePlanReview,
  ResolveQuestion,
  SendMessage,
  SetPermissionMode,
  SetThinkingLevel,
  SplitPane
} from '@shared/ipc/contract'
import { Either, Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'

const encodeSendMessage = Schema.encodeSync(SendMessage)
const encodeResolvePermission = Schema.encodeSync(ResolvePermission)
const encodeResolveQuestion = Schema.encodeSync(ResolveQuestion)
const encodeSplitPane = Schema.encodeSync(SplitPane)
const encodeClosePane = Schema.encodeSync(ClosePane)
const encodeCreatePane = Schema.encodeSync(CreatePane)
const encodeSetThinkingLevel = Schema.encodeSync(SetThinkingLevel)
const encodeSetPermissionMode = Schema.encodeSync(SetPermissionMode)
const encodeResolvePlanReview = Schema.encodeSync(ResolvePlanReview)
const encodeFocusPane = Schema.encodeSync(FocusPane)
const decodeEvent = Schema.decodeUnknownEither(IpcEvent)
const decodeTree = Schema.decodeUnknownSync(PaneNode)
const decodeHistory = Schema.decodeUnknownSync(Schema.Array(ConversationMessage))
const decodeChooseDirectoryResult = Schema.decodeUnknownSync(ChooseDirectoryResult)
const decodeTheme = Schema.decodeUnknownSync(ThemePreference)
const encodeTheme = Schema.encodeSync(ThemePreference)

// A single raw ipcRenderer listener fans out to every subscriber below. Each subscriber
// registering its own ipcRenderer.on would multiply with pane count and event-type count,
// tripping Node's default 10-listener-per-emitter cap (MaxListenersExceededWarning).
const subscribers = new Set<(event: IpcEvent) => void>()

ipcRenderer.on(CHANNEL.event, (_electronEvent, raw: unknown) => {
  const decoded = decodeEvent(raw)
  if (Either.isLeft(decoded)) {
    // @effect-diagnostics-next-line globalConsole:off -- preload runs in Electron's isolated bridge context with no Effect runtime/logger available.
    console.warn('Dropped malformed IPC event', decoded.left)
    return
  }
  for (const subscriber of subscribers) subscriber(decoded.right)
})

function subscribeToEvents(onDecoded: (event: IpcEvent) => void): () => void {
  subscribers.add(onDecoded)
  return () => subscribers.delete(onDecoded)
}

const api: DiaApi = {
  sendMessage(paneId, text) {
    ipcRenderer.send(CHANNEL.command, encodeSendMessage(SendMessage.make({ paneId, text })))
  },
  resolvePermission(paneId, requestId, response) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeResolvePermission(ResolvePermission.make({ paneId, requestId, response }))
    )
  },
  resolveQuestion(paneId, requestId, response) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeResolveQuestion(ResolveQuestion.make({ paneId, requestId, response }))
    )
  },
  splitPane(paneId, direction) {
    ipcRenderer.send(CHANNEL.command, encodeSplitPane(SplitPane.make({ paneId, direction })))
  },
  closePane(paneId) {
    ipcRenderer.send(CHANNEL.command, encodeClosePane(ClosePane.make({ paneId })))
  },
  createPane(paneId, cwd, model, thinkingLevel, permissionMode, useWorktree) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeCreatePane(
        CreatePane.make({ paneId, cwd, model, thinkingLevel, permissionMode, useWorktree })
      )
    )
  },
  setThinkingLevel(paneId, level) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeSetThinkingLevel(SetThinkingLevel.make({ paneId, level }))
    )
  },
  setPermissionMode(paneId, mode) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeSetPermissionMode(SetPermissionMode.make({ paneId, mode }))
    )
  },
  resolvePlanReview(paneId, requestId, approved) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeResolvePlanReview(ResolvePlanReview.make({ paneId, requestId, approved }))
    )
  },
  focusPane(paneId) {
    ipcRenderer.send(CHANNEL.command, encodeFocusPane(FocusPane.make({ paneId })))
  },
  getInitialLayout() {
    return ipcRenderer.invoke(CHANNEL.getInitialLayout).then((raw) => decodeTree(raw))
  },
  getPaneHistory(paneId) {
    return ipcRenderer.invoke(CHANNEL.getPaneHistory, paneId).then((raw) => decodeHistory(raw))
  },
  chooseDirectory() {
    return ipcRenderer
      .invoke(CHANNEL.chooseDirectory)
      .then((raw) => decodeChooseDirectoryResult(raw))
  },
  getTheme() {
    return ipcRenderer.invoke(CHANNEL.getTheme).then((raw) => decodeTheme(raw))
  },
  setTheme(theme) {
    return ipcRenderer.invoke(CHANNEL.setTheme, encodeTheme(theme))
  },
  onMessageAppended(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneMessageAppended') listener(event)
    })
  },
  onLayoutChanged(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'LayoutChanged') listener(event)
    })
  },
  onPaneCreateFailed(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneCreateFailed') listener(event)
    })
  },
  onAttentionChanged(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneAttentionChanged') listener(event)
    })
  },
  onPermissionRequested(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PanePermissionRequested') listener(event)
    })
  },
  onQuestionRequested(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneQuestionRequested') listener(event)
    })
  },
  onPlanReviewRequested(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PanePlanReviewRequested') listener(event)
    })
  },
  onAssistantTextDelta(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneAssistantTextDelta') listener(event)
    })
  },
  onAssistantThinkingDelta(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneAssistantThinkingDelta') listener(event)
    })
  },
  onToolCallStarted(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneToolCallStarted') listener(event)
    })
  },
  onToolCallCompleted(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneToolCallCompleted') listener(event)
    })
  }
}

contextBridge.exposeInMainWorld('dia', api)
