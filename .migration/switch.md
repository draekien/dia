# switch

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/switch`.

## Changed

* `src/renderer/src/components/ui/switch.tsx`: props typed `SwitchPrimitive.Root.Props`; `data-[state=checked|unchecked]:*` → `data-checked:*` / `data-unchecked:*` on root and thumb; `disabled:*` → `data-disabled:*`.
* `src/renderer/src/components/pane-creation-form.test.tsx`: the worktree switch's disabled state is read from `aria-disabled` (`'true'` when disabled, absent when enabled) instead of `HTMLButtonElement.disabled`. Proved falsifiable by flipping the disabled assertion.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* The root is a `<span role="switch">` with `aria-disabled`, not a `<button disabled>`. Whether a disabled switch is still skipped by Tab was not checked.

## Verify by hand

* New agent form with no worktrees plugin: the Worktree switch is greyed out and clicking it does nothing.
* With the worktrees plugin: click the switch and the thumb slides right.
