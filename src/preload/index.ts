import { Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import {
  CHANNEL,
  IpcEvent,
  type PaneMessageAppended,
  ResolvePermission,
  SendMessage
} from '../main/ipc/contract'

const encodeSendMessage = Schema.encodeSync(SendMessage)
const encodeResolvePermission = Schema.encodeSync(ResolvePermission)
const decodeEvent = Schema.decodeUnknownSync(IpcEvent)

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
  onMessageAppended(listener: (event: PaneMessageAppended) => void): () => void {
    const handler = (_electronEvent: Electron.IpcRendererEvent, raw: unknown): void => {
      const event = decodeEvent(raw)
      if (event._tag === 'PaneMessageAppended') {
        listener(event)
      }
    }
    ipcRenderer.on(CHANNEL.event, handler)
    return () => ipcRenderer.removeListener(CHANNEL.event, handler)
  }
}

export type DiaApi = typeof api

contextBridge.exposeInMainWorld('dia', api)
