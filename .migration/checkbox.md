# checkbox

2026-11-01, transformation engine (legacy `new-york`), migrated to `@base-ui/react/checkbox`.

## Changed

* `src/renderer/src/components/ui/checkbox.tsx`: props typed `CheckboxPrimitive.Root.Props`; `data-[state=checked]:*` → `data-checked:*`; `disabled:cursor-not-allowed disabled:opacity-50` → `data-disabled:*` because the root is now a `<span>`.
* `plugins/chat/clarifying-question-card.tsx`: control ids built from `useId()` and indexes instead of question and option text (see radio-group); the Enter-key handler reads `hasAttribute('data-unchecked')` instead of `dataset.state === 'unchecked'`, and falls back to `[role="radio"], [role="checkbox"]` instead of `button`.
* Call sites `onCheckedChange={(next) => … next === true}` need no change: Base UI passes a boolean.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* The root is a `<span role="checkbox">` plus a hidden `<input>` that receives `id`; it is no longer a `<button>`.
* `checked="indeterminate"` is now a separate `indeterminate` boolean prop. No call site used it.

## Verify by hand

* In a multi-select clarifying question, focus an option with Tab and press Enter: it becomes checked without submitting.
* Click an option's label: it toggles.
