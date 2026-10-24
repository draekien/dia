# Thinking plugin

Status: superseded by `docs/designs/claude-code-adapter.md` (ADR-0029). The seam and plugin described here were removed; the code lives in the `claude-code` adapter.

## Purpose

The mapping from a pane's `ThinkingLevel` to Agent SDK query options (`thinkingOptions`) becomes the built-in plugin `thinking`. The kernel keeps `query()` and looks the mapping up by service key once per session start. `thinking` is an essential plugin (ADR-0028): the Host refuses to unload it or to load an override of it.

## Interface

```
src/host/session/thinking-seam.ts                        (kernel)
  THINKING_OPTIONS_KEY = 'thinkingOptions'               value: (level: ThinkingLevel) => ThinkingOptions
  interface ThinkingOptions { thinking?: ThinkingConfig; effort?: EffortLevel }
  resolveThinkingOptions(registry: Pick<PluginRegistry, 'inject'>, level: ThinkingLevel):
    Effect<ThinkingOptions>                              never fails

plugins/thinking/
  plugin.json   { name: 'thinking', api: '1', host: 'host.ts', load: 'eager' }
  host.ts       provides THINKING_OPTIONS_KEY
  thinking-options.ts, thinking-options.test.ts          (moved from src/host/session)

src/host/plugin-api.ts
  re-exports THINKING_OPTIONS_KEY, ThinkingOptions, ThinkingOptionsFactory
```

## Behaviour

- `ESSENTIAL_PLUGINS` is `['permissions', 'thinking']`.
- `resolveThinkingOptions` is called in `runSession` before each `query()`. It calls the provided factory with the pane's level and returns its result.
- When no plugin provides the key, the provided value is not a function, or the factory throws, it logs a warning or error and returns `{}`. The SDK then applies its own default thinking and the pane's chosen level is ignored.
- A reload of `thinking` applies from the next session start; a running session keeps the options it was started with.
- `PluginInfo` and `DiaRpcs` are unchanged, so `PROTOCOL_VERSION` stays 5.

## Constraints

- Thinking is not a safety gate; the fallback `{}` is chosen over `{ thinking: { type: 'disabled' } }` so the SDK's default is not overridden by the kernel.
- `thinking` is essential by the user's decision, so the level a pane shows is honoured whenever the Host runs normally.

## Refinement record

No separate critique rounds were run: the design copies the `session-reducer` seam, and the one open decision (the fallback) was settled by the user.
