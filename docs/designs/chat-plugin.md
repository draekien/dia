# Chat plugin

Issue #9, phase 4, last item: move the chat UI, the permission card, the question card and the rewind button into the `plugins/chat` feature. Decisions: ADR-0031 (slots), amended by ADR-0040.

## Slots

```
plugins/layout ─ <Slot main.header>   kernel default: TabHeader
               └ <Slot main>          kernel default: TabContent
                   ├ FirstRunView      kernel: FirstRun
                   ├ EmptyProjectView  kernel: EmptyProject
                   ├ NewAgentView      kernel: PaneCreationForm
                   └ TabView           <Slot main.tab>   plugins/chat fills it
                                         empty → NoChatPlugin
```

- `main.tab` (`MAIN_TAB` in `src/renderer/src/lib/slots.ts`) is a `single` slot. `TabContent` renders it only for `TabView`. It has no kernel default; while it is empty, `TabContent` shows `NoChatPlugin`: "No chat plugin is loaded.".
- `main` keeps `TabContent` as its kernel default, so first run, an empty project and the New agent form work with the chat unloaded.
- `main.header` is unchanged. Its kernel default `TabHeader` keeps the transcript width button, because only the plugin that fills `main.header` draws in that row; the width is kernel state (`transcriptWidthAtom`) that General settings also edits.

## What moves

`plugins/chat` (feature, eager, renderer only) holds the React components that only the chat renders:

| From `src/renderer/src/components/` | To `plugins/chat/` |
| --- | --- |
| `pane.tsx`, `pane.test.tsx` | `pane.tsx`, `pane.test.tsx` |
| `permission-request-card.tsx` | same name |
| `clarifying-question-card.tsx`, `.test.tsx` | same names |
| `plan-review-card.tsx` | same name |
| `queued-messages.tsx` | same name |
| `slash-command-menu.tsx` | same name |
| `lib/slash-command-menu.ts`, `.test.ts` | `slash-command-filter.ts`, `.test.ts` (renamed: the component above has the base name) |
| `hooks/use-elapsed-clock.ts` | same name |
| `transcript-scroller.tsx`, `.test.ts` | same names |
| `turn-activity-line.tsx` | same name |
| `model-picker.tsx` | same name |
| `markdown.tsx`, `.test.tsx` | same names |
| `VisibleTab` in `tab-content.tsx` | `chat.tsx` (`Chat`) |

`plugins/chat/renderer.ts`: `fillSlot(ctx, MAIN_TAB, Chat)`. `Chat` reads the visible tab with `useView`, `useWorkspace` and `tabOf` (`@shared/domain/workspace`) and renders `Pane` keyed by the pane id.

## What stays in the kernel

State, Host calls and components other kernel screens use stay in `src/renderer/src`: `lib/pane-chat`, `lib/pane-chat-atoms`, `lib/send-mode-atom`, `lib/turn-activity`, `lib/permission-modes`, `lib/thinking-levels`, `lib/model-options`, the other hooks, `InstallNotice` and `PermissionModeItems` (both also used by `PaneCreationForm`). Chat state lives in the kernel's `Atom.family` and the kernel's `QueryClient`, so unloading or reloading the plugin does not lose a pane's transcript or a pending permission request.

`@dia/renderer-plugin` exports what the moved files import, by name, so no plugin file imports `@renderer/*`:

- `MAIN_TAB` and `useTabOpenedFromNewAgent()`. `TabContent` computes whether the previous view was `NewAgentView` and provides it through a React context around the `main.tab` slot; the hook reads it. `Pane` focuses the composer when it is true. A slot filler has no props, and it mounts only when the view becomes `TabView`, so it cannot compute the previous view itself.
- Hooks: `useAdapterStatus`, `useDisabledPermissionModes`, `useModelCatalog`, `useModelPreferences`. `Pane` reads the transcript width through the existing `useTranscriptWidth`.
- Chat state: the `pane-chat` types, `emptyPaneChatState`, `lastUserText`, the six `pane*Atom`s, `sendModeAtom`, `sendModeForEnter`, `turnActivity`.
- Pure helpers: `findModelOption`, the four permission-mode helpers, the three thinking-level helpers.

- Components: `InstallNotice`, `PermissionModeItems`, `openSettings`, and the shadcn primitives `alert-dialog`, `bubble`, `input-group`, `label`, `marker`, `message`, `radio-group`, `select`, `switch`, `textarea`.

A non-React `.ts` module in the plugin may import only `@shared/*` and npm packages, because `tsconfig.node.json` also compiles `plugins/**/*.ts` and does not map `@dia/renderer-plugin`. `lib/turn-activity` imports the kernel's `PaneChatState`, so it stays in the kernel.

`PLUGIN_API_VERSION` 0.0.3 → 0.0.4 and `"api": "0.0.4"` in every `plugins/*/plugin.json` (ADR-0032).

## Verify

- `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- New test: `TabContent` renders the `main.tab` filler for `TabView` and `NoChatPlugin` while the slot is empty; the first-run screen renders with the slot empty.
- In the app: with `plugins/chat` loaded, a turn streams, a Write call shows the permission card, and a rewind marker shows on a past user turn. With `plugins/chat/plugin.json` renamed, a tab shows `NoChatPlugin`, and the first-run and New agent screens still render.

## Refinement record

Round 1 (inline, low effort):

- major, Information Hiding — "`Chat` reads `usePrevious(view)`": a filler mounts only for `TabView`, so its previous value is always `undefined` and the composer never focuses after New agent. Applied: `TabContent` provides the flag through context; the plugin reads `useTabOpenedFromNewAgent()`.
- major, Correctness — moving `pane-chat` state into the plugin would drop transcripts on reload and needs each `.ts` module listed in `tsconfig.web.json` by path. Applied: state stays in the kernel.
- minor, Strategic Programming — `export *` for kernel `lib/*` modules would publish internals the chat does not use. Applied: named exports for `lib/*`; `export *` only for shadcn primitive modules, as the existing exports do.
- Rejected: moving the transcript width button into the chat. The button sits in the `main.header` row, which a `main.tab` filler cannot draw into.
