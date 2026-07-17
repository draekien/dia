import { ConversationMessage } from '@main/domain/pane'
import { PaneNode } from '@main/domain/pane-tree'
import {
  CHANNEL,
  ChooseDirectoryResult,
  ClosePane,
  CreatePane,
  type DiaApi,
  FocusPane,
  IpcEvent,
  ResolvePermission,
  ResolveQuestion,
  SendMessage,
  SplitPane
} from '@main/ipc/contract'
import { Either, Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'

const encodeSendMessage = Schema.encodeSync(SendMessage)
const encodeResolvePermission = Schema.encodeSync(ResolvePermission)
const encodeResolveQuestion = Schema.encodeSync(ResolveQuestion)
const encodeSplitPane = Schema.encodeSync(SplitPane)
const encodeClosePane = Schema.encodeSync(ClosePane)
const encodeCreatePane = Schema.encodeSync(CreatePane)
const encodeFocusPane = Schema.encodeSync(FocusPane)
const decodeEvent = Schema.decodeUnknownEither(IpcEvent)
const decodeTree = Schema.decodeUnknownSync(PaneNode)
const decodeHistory = Schema.decodeUnknownSync(Schema.Array(ConversationMessage))
const decodeChooseDirectoryResult = Schema.decodeUnknownSync(ChooseDirectoryResult)

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
    ipcRenderer.send(CHANNEL.command, encodeSendMessage({ _tag: 'SendMessage', paneId, text }))
  },
  resolvePermission(paneId, requestId, response) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeResolvePermission({ _tag: 'ResolvePermission', paneId, requestId, response })
    )
  },
  resolveQuestion(paneId, requestId, response) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeResolveQuestion({ _tag: 'ResolveQuestion', paneId, requestId, response })
    )
  },
  splitPane(paneId, direction) {
    ipcRenderer.send(CHANNEL.command, encodeSplitPane({ _tag: 'SplitPane', paneId, direction }))
  },
  closePane(paneId) {
    ipcRenderer.send(CHANNEL.command, encodeClosePane({ _tag: 'ClosePane', paneId }))
  },
  createPane(paneId, cwd, model, useWorktree) {
    ipcRenderer.send(
      CHANNEL.command,
      encodeCreatePane({ _tag: 'CreatePane', paneId, cwd, model, useWorktree })
    )
  },
  focusPane(paneId) {
    ipcRenderer.send(CHANNEL.command, encodeFocusPane({ _tag: 'FocusPane', paneId }))
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
  onAssistantTextDelta(listener) {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneAssistantTextDelta') listener(event)
    })
  }
}

contextBridge.exposeInMainWorld('dia', api)
