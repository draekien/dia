# Review rules

- When a diff changes a component that `DESIGN.md` specifies, check that `DESIGN.md` states the placement, size, weight and copy the component renders. Report each difference.
- When a diff adds text that describes a permission mode (JSDoc, UI copy, `DESIGN.md`), check it against the mode's description in `src/renderer/src/lib/permission-modes.ts`. Example: `bypassPermissions` runs tools without asking, and plugin changes still ask, so "skips every approval" is wrong.
