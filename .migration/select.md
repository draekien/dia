# select

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/select` with the Portal > Positioner > Popup model.

## Changed

* `src/renderer/src/components/ui/select.tsx`:
  * `Select` is now the bare `SelectPrimitive.Root`. The Radix workaround that closed the previously open select (`closeOpenSelect` plus a controlled `open` state) is removed: an open Base UI select mounts a full-window inert backdrop, so the next press closes it before it can reach another select.
  * `SelectContent`: `position` prop replaced by `alignItemWithTrigger`, default `false` to keep Radix `position="popper"` placement (below the trigger, not over it); `side`/`sideOffset`(4)/`align`/`alignOffset` forwarded to `Positioner`. `Viewport` → `List` (keeps `p-1 scroll-my-1`). The `List` is the scroll container (`min-h-0 overflow-x-hidden overflow-y-auto`) inside a `flex flex-col overflow-hidden` `Popup`, because Base UI shows the scroll arrows from the `List`'s scroll position; with the `Popup` scrolling, the arrows never appeared and the native scrollbar showed (found in the running app). The popper-only translate classes are dropped because `sideOffset` now provides the gap. `--radix-select-*` vars → `--available-height` / `--transform-origin`; `min-w-[var(--radix-select-trigger-width)]` → `min-w-[max(8rem,var(--anchor-width))]`.
  * `Label` → `GroupLabel`; `ScrollUpButton`/`ScrollDownButton` → `ScrollUpArrow`/`ScrollDownArrow` (gained `top-0`/`bottom-0 z-10 w-full bg-popover`); `Icon asChild` → `Icon render={…}`; `data-[placeholder]` → `data-placeholder`; `data-[disabled]` → `data-disabled`.
* `onValueChange` now receives `(value | null, eventDetails)`. 9 call sites gained a `null` guard: `model-picker.tsx`, `pane.tsx` (2), `model-field.tsx`, `pane-creation-form.tsx` (2), `claude-code-settings.tsx` (3). Unused `ThinkingLevel` / `StartupPermissionMode` imports removed from `claude-code-settings.tsx`.
* `<SelectValue />` without children shows the raw value in Base UI. The 4 bare sites now pass the label: `model-picker.tsx` (`label ?? value`), `model-field.tsx` (display name, with `value ?? null` so the `Loading models…` placeholder still shows), `pane-creation-form.tsx` (`thinkingLevelLabel`), `claude-code-settings.tsx` (`model?.displayName`).
* `src/renderer/src/components/ui/select.test.tsx`: `press` fires `mousedown` after `pointerdown` (Base UI opens on `mousedown`), and the test awaits the listbox. Proved falsifiable by flipping the expected listbox count to 2.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* Opening a second select while one is open: the first press closes the open select; a second press opens the other one. Radix with the removed workaround opened the other one on the first press. Verified in the packaged app with CDP mouse input.
* While a select is open, the rest of the window is inert (Base UI `modal` defaults to `true`): page scroll is locked and outside clicks only dismiss.

## Verify by hand

* Composer → Model: the list opens below the trigger showing display names; the trigger shows the chosen model's display name, not its id.
* With the Model list open, click the Thinking trigger: note whether one or two clicks are needed to open it (see Behavior changes).
* New agent form before models load: the Model trigger reads "Loading models…".
* Type a letter while a select is focused: typeahead jumps to the matching option.
