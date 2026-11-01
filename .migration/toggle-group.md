# toggle-group

2026-11-01, transformation engine (legacy `new-york`), group on `@base-ui/react/toggle-group`, items on `@base-ui/react/toggle`.

## Changed

* `src/renderer/src/components/ui/toggle-group.tsx`: root → callable `ToggleGroupPrimitive`; items → `TogglePrimitive` (Base UI has no group-item part). Classes unchanged.
* `src/renderer/src/components/settings/general-settings.tsx` (Theme, Send mode, usage-limit resume) and `src/renderer/src/components/transcript-width-toggle.tsx`: `type="single"` removed; `value={x}` → `value={[x]}`; `onValueChange={(value) => { if (value !== '') … }}` → `onValueChange={([value]) => { if (value !== undefined) … }}`. Deselecting the pressed item now yields `[]`, which the guard ignores, as the `''` guard did.
* `src/renderer/src/components/settings/settings-dialog.test.tsx`: items queried by `getByRole('button', …)` instead of `'radio'`.
* Leftover scan: clean.

## Left alone

* Nothing.

## Behavior changes

* Radix rendered single-select items as `role="radio"` inside a `role="group"`. Base UI renders `<button aria-pressed>`. Screen readers announce "toggle button, pressed" instead of "radio button, checked". Flagged; not patched.

## Verify by hand

* Settings → General: click Dark, then click Dark again. The theme stays Dark (clicking the pressed item does not clear it).
* Tab into the Theme group and use the arrow keys: focus moves between items.
