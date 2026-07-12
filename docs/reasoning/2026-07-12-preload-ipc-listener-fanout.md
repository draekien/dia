# One `ipcRenderer.on` per subscriber multiplies with pane count and trips Node's listener cap

**Date:** 2026-07-12

## Context

While adding attention/permission/streaming-text listeners to the renderer for the pulse-indicator feature, `preload/index.ts`'s `subscribeToEvents` helper called `ipcRenderer.on(CHANNEL.event, handler)` fresh on every invocation, with one `useEffect` subscription per event type per mounted `Pane`. This had one subscriber (`onMessageAppended`) per pane before this feature; adding `onAssistantTextDelta`, `onAttentionChanged`, and `onPermissionRequested` took it to four per pane. With two panes open, that's 8+ raw listeners on the same `IpcRenderer` instance, which trips Electron/Node's default `MaxListeners` of 10 (`MaxListenersExceededWarning`).

## Reasoning / Learning

`ipcRenderer` is a single shared `EventEmitter` per renderer process — every `subscribeToEvents` call was registering an independent raw listener on it rather than sharing one. The listener count scales with `panes × event types the renderer cares about`, not with anything bounded, so it was only a matter of opening enough panes (or adding enough event-type listeners per pane, as this feature did) before hitting the cap. The warning is real signal, not noise to suppress — bumping `setMaxListeners` higher just delays the same unbounded-growth problem.

The actual fix: register exactly one raw `ipcRenderer.on(CHANNEL.event, ...)` listener at preload module-load time, decode once, and fan the decoded event out to an internal `Set<(event: IpcEvent) => void>` of subscribers. `subscribeToEvents` now just adds/removes from that `Set` — which has no listener-count ceiling — instead of touching `ipcRenderer` at all after the initial registration.

## Implication

Any preload/renderer IPC bridge that supports multiple independent subscribers (multiple panes, multiple components each wanting a filtered slice of the same event stream) should register the raw Electron IPC listener exactly once and fan out internally, never let call-site count map 1:1 onto `ipcRenderer.on` calls. If a `MaxListenersExceededWarning` shows up again anywhere in this codebase, look for the same pattern before reaching for `setMaxListeners`.
