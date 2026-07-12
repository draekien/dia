import { Either, Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import { PaneNode } from '../main/domain/pane-tree'
import {
  CHANNEL,
  ClosePane,
  IpcEvent,
  type LayoutChanged,
  type PaneMessageAppended,
  ResolvePermission,
  SendMessage,
  SplitPane
} from '../main/ipc/contract'

const encodeSendMessage = Schema.encodeSync(SendMessage)
const encodeResolvePermission = Schema.encodeSync(ResolvePermission)
const encodeSplitPane = Schema.encodeSync(SplitPane)
const encodeClosePane = Schema.encodeSync(ClosePane)
const decodeEvent = Schema.decodeUnknownEither(IpcEvent)
const decodeTree = Schema.decodeUnknownSync(PaneNode)

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
  getInitialLayout(): Promise<PaneNode> {
    return ipcRenderer.invoke(CHANNEL.getInitialLayout).then((raw) => decodeTree(raw))
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
  }
}

export type DiaApi = typeof api

contextBridge.exposeInMainWorld('dia', api)
