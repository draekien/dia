# Context donut

Issue #86, part of the composer redesign #81. The data comes from #84 (`docs/designs/context-usage.md`); the visual rules are in `DESIGN.md` > Components > Composer.

## Colour

`contextColor(usage, compactFailed)` in `plugins/chat/context-meter.ts` returns a CSS colour. The red end is `autoCompactThreshold / maxTokens`, or 0.9 when `usage` has no threshold.

| Share of the window | Colour |
|---|---|
| up to 0.5 | `var(--ink-muted)` |
| 0.5 to 0.75 | `color-mix(in oklab, var(--pulse-amber) p%, var(--ink-muted))`, `p` rising from 0 to 100 |
| 0.75 | `var(--pulse-amber)` |
| 0.75 to the red end | `color-mix(in oklch, var(--pulse-red) p%, var(--pulse-amber))` |
| at or above the red end, or `compactFailed` | `var(--pulse-red)` |

`color-mix` blends in the browser, so the theme's light and dark tokens both blend without a JS colour library. Amber to red blends in OKLCH, which keeps lightness and chroma along the hue. Neutral to amber blends in OKLab: `--ink-muted` has hue 255 at chroma 0.015, and an OKLCH blend with amber (hue 70) passes through hue 339 (`oklch(0.69 0.085 339)` at 62%, a pink), while OKLab gives `oklab(0.69 0.024 0.065)`, hue 70. The neutral end is `--ink-muted`, not `--muted-foreground`: the `@theme inline` block maps `--color-muted-foreground` without emitting a `--muted-foreground` variable, so `var(--muted-foreground)` is invalid at runtime. The ring and the popover meter use the same colour.

## Component

`ContextDonut` (`plugins/chat/context-donut.tsx`) sits at the right end of the header row in `plugins/chat/pane.tsx`.

| Prop | Source in `PaneChat` |
|---|---|
| `usage` | `chat.contextUsage` |
| `failure` | `chat.compactionFailure` |
| `compacting` | `isLoading` and the last sent text is the `/compact` command, with or without instructions |
| `running` | `isLoading` |
| `onCompact` | `sendMessage({ text: '/compact', mode })`, the same path as typing it |

- The trigger is a 16px ring with a 2px stroke, named `Context 88% used` (`Context usage` before the first reading).
- The popover shows `88% of context used`, `~176k of ~200k tokens` (`approximateTokens`; the exact counts in `title`), a `role="meter"` bar and `Compact conversation`.
- While `running` and not `compacting`, Compact has `aria-disabled` and no click handler, and stays focusable so its tooltip `Available when this turn ends` shows on hover and focus.
- While `compacting`, Compact is disabled with `aria-busy`, and the ring is neutral and pulses (no pulse under reduced motion).
- `failure.message` shows under the button: in `text-error` for `failed`, muted for `nothingToCompact`.

## Compaction failure event

| Layer | Name | Carries |
| --- | --- | --- |
| Shared domain (`src/shared/domain/context-usage.ts`) | `CompactionFailure` | `reason: 'nothingToCompact' \| 'failed'`, `message` |
| Session protocol | `CompactionFailed` | `failure` |
| Renderer event | `PaneCompactionFailed` | `paneId`, `failure` |
| Preload | `onCompactionFailed(listener)` | the event |
| Renderer state | `compactionFailure: CompactionFailure \| null` | set by the event; cleared by `PaneUserMessagesSent`, `PaneConversationCompacted` and a reset |

The adapter reducer (`plugins/claude-code/reducer.ts`) emits it beside the existing `SessionNotice` when a `status` message has `compact_result: 'failed'`. `compact_error` equal to `Not enough messages to compact.` maps to `nothingToCompact` with that text; any other error maps to `failed` with `Compaction failed: <error>`. `PROTOCOL_VERSION` goes from `0.0.12` to `0.0.13`.

## Decisions

| Decision | Reason |
|---|---|
| A structured event, not matching the notice text in the renderer | The renderer is adapter-neutral; the SDK's wording stays in the claude-code adapter. |
| `nothingToCompact` does not turn the ring red | A probe of `/compact` on a new session: `compact_result: 'failed'`, `compact_error: 'Not enough messages to compact.'`, at 6% usage. A red ring would report an error where nothing went wrong. |
| A failure clears on the next send or compaction, not on the next reading | The probe shows a reading (`PaneContextUsageChanged`) right after the failed turn ends, so clearing on a reading would clear the failure at once. |
| `compacting` is derived from the last sent text | It also covers a typed `/compact` and needs no extra state. |
| Compact is disabled during a turn | The issue's open choice; queueing `/compact` would add a second meaning to the button. |
