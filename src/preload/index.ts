import { StartupLog } from '@shared/domain/startup'
import { UpdateStatus } from '@shared/domain/update'
import {
  CHANNEL,
  type DiaApi,
  HostConnection,
  IpcEvent,
  TitleBarOverlayColors,
  type UpdateStatusChanged
} from '@shared/ipc/contract'
import {
  DiaRpcs,
  PROTOCOL_VERSION,
  TOKEN_SUBPROTOCOL_PREFIX,
  VERSION_SUBPROTOCOL_PREFIX
} from '@shared/ipc/rpc'
import { Context, Effect, Layer, ManagedRuntime, Result, Schema } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Socket } from 'effect/socket'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { type DiaRpcClient, makeHostApi } from './host-api'

const decodeHostConnection = Schema.decodeUnknownSync(HostConnection)
const decodeEvent = Schema.decodeUnknownResult(IpcEvent)
const encodeTitleBarOverlay = Schema.encodeSync(TitleBarOverlayColors)
const decodeUpdateStatus = Schema.decodeUnknownSync(UpdateStatus)
const decodeStartupLog = Schema.decodeUnknownSync(StartupLog)

class DiaClient extends Context.Service<DiaClient, DiaRpcClient>()('preload/DiaClient') {}

const hostClientLayer = Layer.unwrap(
  Effect.promise(() => ipcRenderer.invoke(CHANNEL.getHostConnection)).pipe(
    Effect.map(decodeHostConnection),
    Effect.map((connection) =>
      Layer.effect(DiaClient)(RpcClient.make(DiaRpcs)).pipe(
        Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
        Layer.provide(
          Socket.layerWebSocket(`ws://127.0.0.1:${connection.port}`, {
            protocols: [
              `${TOKEN_SUBPROTOCOL_PREFIX}${connection.token}`,
              `${VERSION_SUBPROTOCOL_PREFIX}${PROTOCOL_VERSION}`
            ]
          })
        ),
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
        Layer.provide(RpcSerialization.layerJson)
      )
    )
  )
)

const runtime = ManagedRuntime.make(hostClientLayer)
const clientPromise = runtime.runPromise(Effect.service(DiaClient))

const updateListeners = new Set<(event: UpdateStatusChanged) => void>()
const startupListeners = new Set<(log: StartupLog) => void>()

ipcRenderer.on(CHANNEL.event, (_electronEvent, raw: unknown) => {
  const decoded = decodeEvent(raw)
  if (Result.isFailure(decoded)) {
    // @effect-diagnostics-next-line globalConsole:off -- preload runs in Electron's isolated bridge context with no Effect runtime/logger available.
    console.warn('Dropped malformed IPC event', decoded.failure)
    return
  }
  const event = decoded.success
  if (event._tag === 'UpdateStatusChanged') {
    for (const listener of updateListeners) listener(event)
  } else if (event._tag === 'StartupLogChanged') {
    for (const listener of startupListeners) listener(event.log)
  }
})

const hostApi = makeHostApi({
  client: Effect.promise(() => clientPromise),
  pickDirectory: (defaultPath) => ipcRenderer.invoke(CHANNEL.chooseDirectory, defaultPath),
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- preload runs in Electron's isolated bridge context with no Effect runtime.
  newRequestId: () => crypto.randomUUID(),
  warn: (message, detail) => {
    // @effect-diagnostics-next-line globalConsole:off -- preload runs in Electron's isolated bridge context with no Effect runtime/logger available.
    console.warn(message, detail)
  }
})

const api: DiaApi = {
  ...hostApi,
  pickFile: () => ipcRenderer.invoke(CHANNEL.chooseFile, null),
  pathForFile: (file) => webUtils.getPathForFile(file as File),
  setTitleBarOverlay(colors) {
    ipcRenderer.send(CHANNEL.setTitleBarOverlay, encodeTitleBarOverlay(colors))
  },
  getAppVersion() {
    return ipcRenderer
      .invoke(CHANNEL.getAppVersion)
      .then((raw) => (typeof raw === 'string' ? raw : ''))
  },
  getUpdateStatus() {
    return ipcRenderer.invoke(CHANNEL.getUpdateStatus).then((raw) => decodeUpdateStatus(raw))
  },
  checkForUpdates() {
    ipcRenderer.send(CHANNEL.checkForUpdates)
  },
  installUpdate() {
    ipcRenderer.send(CHANNEL.installUpdate)
  },
  toggleDevTools() {
    ipcRenderer.send(CHANNEL.toggleDevTools)
  },
  revealPath(directory) {
    return ipcRenderer.invoke(CHANNEL.revealPath, directory).then(() => undefined)
  },
  onUpdateStatusChanged(listener) {
    updateListeners.add(listener)
    return () => updateListeners.delete(listener)
  },
  getStartupLog() {
    return ipcRenderer.invoke(CHANNEL.getStartupLog).then((raw) => decodeStartupLog(raw))
  },
  onStartupLogChanged(listener) {
    startupListeners.add(listener)
    return () => startupListeners.delete(listener)
  }
}

contextBridge.exposeInMainWorld('dia', api)
