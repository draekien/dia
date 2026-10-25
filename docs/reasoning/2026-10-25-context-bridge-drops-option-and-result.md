# `contextBridge` turns an Effect `Option` or `Result` into a different object

**Date:** 2026-10-25

## Context

The first draft of the projects-and-tabs workspace (`docs/designs/agent-overview.md`) typed `Workspace.visibleTab`, `ToolUse.target` and `CreateTabRequest.name` as `Schema.OptionFromNullOr`, and `DiaApi.registerProject` and `removeProject` returned a `Result`. Each of these values crosses `contextBridge.exposeInMainWorld` (`src/preload/index.ts`) between the preload and the renderer.

## Reasoning / Learning

An effect v4 `Option` or `Result` keeps its `_tag` and methods on its prototype. Only the payload is an own property:

```
Object.keys(Option.some('x'))                     // ['value']
Object.keys(Option.none())                        // []
structuredClone({ s: Option.some('x'), n: Option.none() })
                                                  // { s: { value: 'x' }, n: {} }
```

`contextBridge` copies objects without their prototype, as `structuredClone` does. In the renderer, `Option.isSome(visibleTab)` is then false for every visible tab, and `Option.none()` arrives as `{}`. A `Schema.TaggedError` instance is an `Error`, so it also loses its fields when copied. No type error shows any of this, because `DiaApi` declares the decoded types.

Values that do cross intact are plain objects with an own `_tag`: `Schema.TaggedStruct(...).make` output, arrays, strings and `null`. Every `DiaApi` value before this change was plain data, for example `PluginOverrideResult`.

## Implication

- A schema whose values cross `contextBridge` uses `Schema.NullOr`, not `Schema.OptionFromNullOr`. `Workspace`, `AgentSummary` and `CreateTabRequest` follow this rule.
- A `DiaApi` method does not return a `Result` or a typed-error instance. `registerProject` resolves `null` or the encoded error (`RegisterProjectRefusal`, from `Schema.encodeSync(RegisterProjectError)`). `removeProject` resolves `void`.
- `Option` stays fine on one side of the bridge, for example in the renderer's own atoms or inside the Host.
