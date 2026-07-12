import { Schema } from 'effect'
import { contextBridge, ipcRenderer } from 'electron'
import { CHANNEL, IpcEvent, type PaneMessageAppended, SendMessage } from '../main/ipc/contract'

const encodeSendMessage = Schema.encodeSync(SendMessage)
const decodeEvent = Schema.decodeUnknownSync(IpcEvent)

const api = {
  sendMessage(paneId: string, text: string): void {
    ipcRenderer.send(CHANNEL.command, encodeSendMessage({ _tag: 'SendMessage', paneId, text }))
  },
  onMessageAppended(listener: (event: PaneMessageAppended) => void): () => void {
    const handler = (_electronEvent: Electron.IpcRendererEvent, raw: unknown): void => {
      listener(decodeEvent(raw))
    }
    ipcRenderer.on(CHANNEL.event, handler)
    return () => ipcRenderer.removeListener(CHANNEL.event, handler)
  }
}

export type DiaApi = typeof api

contextBridge.exposeInMainWorld('dia', api)
