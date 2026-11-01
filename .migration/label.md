# label

2026-11-01, transformation engine (legacy `new-york`), Radix `Label` has no Base UI counterpart: replaced by a native `<label>`.

## Changed

* `src/renderer/src/components/ui/label.tsx`: `LabelPrimitive.Root` → `<label>`; props typed `React.ComponentProps<'label'>`; a `biome-ignore lint/a11y/noLabelWithoutControl` comment because callers associate the control through `htmlFor`. Classes unchanged.
* Leftover scan: clean.

## Left alone

* `peer-disabled:*` classes: kept. They no longer match Base UI checkboxes, radios or switches, which render a `<span>` and cannot be `:disabled`; they still match native inputs.

## Behavior changes

* Radix `Label` prevented text selection on double-click via a `mousedown` handler. The native label relies on the `select-none` class only.

## Verify by hand

* Click the text of "Remember" in a permission request card: the switch toggles.
* Click an option's text in a clarifying question card: the radio or checkbox is chosen.
