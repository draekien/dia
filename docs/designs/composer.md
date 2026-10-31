# Composer: header row and contextual action button

Issue #85, part of the composer redesign #81. The visual rules are in `DESIGN.md` > Components > Composer.

## Layout

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Opus 5.5    Medium effort    Auto mode                       (#86 donut)   │  InputGroupAddon block-start
├────────────────────────────────────────────────────────────────────────────┤
│ textarea                                                                   │
│ (#74 attach)                                                       [≡+]   │  InputGroupAddon block-end
└────────────────────────────────────────────────────────────────────────────┘
```

- `ModelPicker`, `ThinkingLevelSelect` and `PermissionModeSelect` (`plugins/chat/pane.tsx`, `plugins/chat/model-picker.tsx`) render in the header row with `composerSettingTrigger` classes and no icon.
- `plugins/chat/composer-settings.ts` owns the header text: `thinkingSettingLabel` (`Medium effort`, `Adaptive thinking`, `Thinking off`), `permissionSettingLabel` (`Auto mode`) and `skipsApproval` (`auto`, `bypassPermissions`), which selects `emphasis: 'foreground'`.
- The queued messages, the slash command menu and `Loading commands…` stay above the `InputGroup`, unchanged.

## Action button

`composerAction({ running, hasText, modifierHeld, defaultMode })` in `plugins/chat/composer-action.ts` returns the button for one composer state:

| `running` | `hasText` | `modifierHeld` | Result |
|---|---|---|---|
| false | false | either | `submit`, icon `sendNow`, `Send`, disabled |
| false | true | false | `submit`, the default mode's icon, `Send` |
| false | true | true | `submit`, the other mode's icon, `Send` |
| true | false | either | `stop`, icon `stop`, `Stop` |
| true | true | false | `submit`, the default mode's icon, `Queue` or `Steer now` |
| true | true | true | `submit`, the other mode's icon, `Steer now` or `Queue` |

`ComposerActionButton` (`plugins/chat/pane.tsx`) maps `queue` to `ListPlus`, `sendNow` to `ArrowUp` and `stop` to `SquareIcon`. It puts the label in `aria-label` and in an `aria-live="polite"` `sr-only` span, and shows `composerActionHint` in a tooltip. A click on `submit` calls `form.handleSubmit` with `sendModeForEnter(defaultSendMode, clickEvent)`, so Ctrl/⌘+click sends in the other mode, as Ctrl/⌘+Enter does.

- **Modifier state:** the form's `keydown` and `keyup` set `modifierHeld` to `metaKey || ctrlKey`. The form's `blur` (a `focusout`, which also fires when the window loses focus while the composer holds it) resets it to false unless focus moves to another element inside the form.
- **Pending card:** while a permission, question or plan card is pending, a send always steers (unchanged). The button then passes `defaultMode: 'steer'` and ignores the modifier, so it shows the mode the send uses, and `composerActionHint` gets `pending: true`, so the tooltip says every send steers instead of naming the modifier.
- **Motion:** the icon swap has no transition, so reduced motion needs no special case.

## Placeholder

`composerPlaceholder(running, defaultMode)`:

| State | Text |
|---|---|
| idle | `Message this agent, or type / for commands` |
| running, default `queue` | `Queue a message for after this turn, or type / for commands` |
| running, default `steer` | `Steer this turn, or type / for commands` |

## Unchanged

- Keyboard: Enter sends in the default mode, Ctrl/⌘+Enter in the other, Shift+Enter adds a line.
- The textarea keeps `aria-label="Message dia"`.

## Decisions

- **The select chevrons stay.** The issue asks for text triggers; the chevron is kept at the trigger's existing 50% opacity because it is the only sign that the text opens a menu. Removing it would mean overriding `SelectTrigger` internals from outside.
- **The button is `type="button"`, not `submit`.** A form `submit` event carries no modifier keys, so the click handler submits with the click's `ctrlKey`/`metaKey` instead.
- **`MODIFIER_KEY` is local to `pane.tsx`.** `window-status.tsx` has the same platform check; it is in the core renderer, which plugins can reach only through `@dia/renderer-plugin`, and a two-line check does not justify a new plugin API export.

## Refinement record

One inline round (`--effort low --runner inline`).

| Finding | Tag | Outcome |
|---|---|---|
| A `submit` button would lose Ctrl/⌘ on click (Strategic Programming: the button must honour the same modifier rule as Enter). | major | Applied: `type="button"` and `sendModeForEnter` on the click event. |
| With a pending card the button could show `Queue` while the send steers (Define Errors Out of Existence: the label must not misstate the action). | major | Applied: `defaultMode: 'steer'` and no modifier while a card is pending. |
| `composerAction` could take the effective mode instead of `modifierHeld` and `defaultMode`. | minor | Rejected: the idle-and-empty row ignores both, and the issue's table is keyed on the modifier, so the function mirrors it. |
