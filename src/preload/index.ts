import { Either, Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import { PaneNode } from '../main/domain/pane-tree'
import {
  CHANNEL,
  ChooseDirectoryResult,
  ClosePane,
  CreatePane,
  IpcEvent,
  type LayoutChanged,
  type PaneCreateFailed,
  type PaneMessageAppended,
  ResolvePermission,
  SendMessage,
  SplitPane
} from '../main/ipc/contract'

const encodeSendMessage = Schema.encodeSync(SendMessage)
const encodeResolvePermission = Schema.encodeSync(ResolvePermission)
const encodeSplitPane = Schema.encodeSync(SplitPane)
const encodeClosePane = Schema.encodeSync(ClosePane)
const encodeCreatePane = Schema.encodeSync(CreatePane)
const decodeEvent = Schema.decodeUnknownEither(IpcEvent)
const decodeTree = Schema.decodeUnknownSync(PaneNode)
const decodeChooseDirectoryResult = Schema.decodeUnknownSync(ChooseDirectoryResult)

function subscribeToEvents(onDecoded: (event: IpcEvent) => void): () => void {
  const handler = (_electronEvent: Electron.IpcRendererEvent, raw: unknown): void => {
    const decoded = decodeEvent(raw)
    if (Either.isLeft(decoded)) {
      console.warn('Dropped malformed IPC event', decoded.left)
      return
    }
    onDecoded(decoded.right)
  }
  ipcRenderer.on(CHANNEL.event, handler)
  return () => ipcRenderer.removeListener(CHANNEL.event, handler)
}

const api = {
  sendMessage(paneId: string, text: string): void {
    ipcRenderer.send(CHANNEL.command, encodeSendMessage({ _tag: 'SendMessage', paneId, text }))
  },
  resolvePermission(
    paneId: string,
    requestId: string,
    decision: 'allow' | 'deny',
    message?: string
  ): void {
    ipcRenderer.send(
      CHANNEL.command,
      encodeResolvePermission({ _tag: 'ResolvePermission', paneId, requestId, decision, message })
    )
  },
  splitPane(paneId: string, direction: 'row' | 'column'): void {
    ipcRenderer.send(CHANNEL.command, encodeSplitPane({ _tag: 'SplitPane', paneId, direction }))
  },
  closePane(paneId: string): void {
    ipcRenderer.send(CHANNEL.command, encodeClosePane({ _tag: 'ClosePane', paneId }))
  },
  createPane(paneId: string, cwd: string, model: string, useWorktree: boolean): void {
    ipcRenderer.send(
      CHANNEL.command,
      encodeCreatePane({ _tag: 'CreatePane', paneId, cwd, model, useWorktree })
    )
  },
  getInitialLayout(): Promise<PaneNode> {
    return ipcRenderer.invoke(CHANNEL.getInitialLayout).then((raw) => decodeTree(raw))
  },
  chooseDirectory(): Promise<ChooseDirectoryResult> {
    return ipcRenderer
      .invoke(CHANNEL.chooseDirectory)
      .then((raw) => decodeChooseDirectoryResult(raw))
  },
  onMessageAppended(listener: (event: PaneMessageAppended) => void): () => void {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneMessageAppended') listener(event)
    })
  },
  onLayoutChanged(listener: (event: LayoutChanged) => void): () => void {
    return subscribeToEvents((event) => {
      if (event._tag === 'LayoutChanged') listener(event)
    })
  },
  onPaneCreateFailed(listener: (event: PaneCreateFailed) => void): () => void {
    return subscribeToEvents((event) => {
      if (event._tag === 'PaneCreateFailed') listener(event)
    })
  }
}

export type DiaApi = typeof api

contextBridge.exposeInMainWorld('dia', api)
