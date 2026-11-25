---
name: building-dia-plugins
description: Write, load and reload a dia plugin (plugin.json, host entry, @dia/plugin imports) with the plugin_override and plugin_reload tools. Use when asked to add a feature to dia itself, change how dia behaves, or create, fix or debug a dia plugin.
---

# Building dia plugins

Scope: plugins that the dia app runs in its Host process. `references/api.md`, in the directory of this `SKILL.md`, lists every export of `@dia/plugin` with its documentation and states the plugin API version of the installed dia. dia rewrites `references/api.md` when the installed dia exports a different API; dia writes this `SKILL.md` only when it is missing, so an edit to it is kept.

## Plugin folder

A plugin is a folder that holds `plugin.json` and a host entry module written in TypeScript. dia loads the TypeScript source directly; there is no build step.

```
weather/
├── package.json      { "type": "module" }
├── plugin.json
└── host.ts
```

- dia refuses a folder that does not resolve to a `package.json` with `"type": "module"`, looked up from the plugin folder towards the file system root. Put that `package.json` in the plugin folder when no parent folder has one.
- The folder needs no `node_modules`. dia supplies `effect` and `@dia/plugin` at runtime, so the plugin uses the same copies dia uses.
- Create the files with the Write tool. Place the folder where it stays under version control, for example `plugins/<name>/` in the meta repo, the git repository that holds this skill at `plugin/skills/building-dia-plugins/`.

## plugin.json

```json
{
  "name": "weather",
  "api": "<the version at the top of references/api.md>",
  "category": "feature",
  "host": "host.ts",
  "load": "lazy"
}
```

| Key | Rule |
| --- | --- |
| `name` | Lowercase letters, digits and hyphens, starting with a letter. dia refuses a plugin whose `name` differs from the name it is loaded under. Do not start a new plugin's name with `dia-`: the plugins dia ships use that prefix, and an override under a shipped plugin's name replaces that plugin. |
| `api` | The plugin API version stated at the top of `references/api.md`. While dia is below `0.1.0`, dia refuses any other version, and every change to the plugin context increments it. |
| `category` | `feature` for a plugin you write. `adapter` is for plugins that connect dia to an agent. |
| `host` | Path of the host entry module, relative to the plugin folder. |
| `renderer` | Path of a renderer entry module. dia loads a renderer entry only for the plugins built into dia; a plugin loaded from a folder runs its `host` entry only. |
| `inject` | Service key names the plugin reads with `ctx.inject`. dia reopens the plugin when a provider of one of those keys changes. |
| `exports` | `.ts` files, relative to the plugin folder, that other plugins import as `@dia-plugin/<name>/<path without .ts>`. Other plugins can import only the files listed here. |
| `load` | `eager` finishes loading before dia reports ready; `lazy` (the default) loads in the background after that; `manual` stays unloaded until the user loads it in Settings › Plugins. |

## Host entry

The host entry's default export is a `PluginSetup<HostPluginContext>`: a function from the plugin context to an `Effect`. dia runs the effect in a `Scope` that belongs to the plugin and closes that `Scope` when the plugin unloads or reloads.

```ts
import type { HostPluginContext, PluginSetup } from '@dia/plugin'
import { Effect } from 'effect'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.logInfo('Weather plugin closed', { plugin: ctx.name }))
    yield* Effect.logInfo('Weather plugin opened', { plugin: ctx.name, dataDir: ctx.dataDir })
  })

export default setup
```

- Import dia's types and values from `@dia/plugin` only. A plugin cannot import dia's `src/` files.
- Acquire every resource in the setup `Scope` (`Effect.acquireRelease`, `Effect.addFinalizer`, `Effect.forkScoped`), so closing the `Scope` releases it. A timer or listener created outside the `Scope` keeps running after a reload.
- `ctx.dataDir` is a directory for the plugin's own files. It survives reloads and restarts.
- `HostPluginContext` in `references/api.md` lists the rest of the context: `ctx.provide`, `ctx.inject`, `ctx.whenProvided`, `ctx.serve`, `ctx.events`, `ctx.activities`, `ctx.database` and others.

## Status bar entry

The status bar is the row along the bottom of dia's window. A plugin adds an entry to it from its renderer entry with `addEntry`. dia loads a renderer entry only for the plugins built into dia (`plugins/<name>/` in the dia repository), so a plugin loaded from a folder with `plugin_override` cannot add a status bar entry.

```ts
import type { PluginServices, PluginSetup } from '@dia/plugin'
import { addEntry } from '@dia/renderer-plugin'
import { StatusBarItemsSlot } from '@dia-plugin/dia-layout/slots'
import { Effect } from 'effect'
import { Atom } from 'effect/reactivity'
import { createElement } from 'react'
import { ClickCountEntry } from './click-count-entry'

const setup: PluginSetup<PluginServices> = (ctx) =>
  Effect.gen(function* () {
    const clicks = Atom.make(0).pipe(Atom.keepAlive)
    yield* addEntry(ctx, StatusBarItemsSlot, {
      id: 'clicks',
      order: 100,
      side: 'end',
      component: () => createElement(ClickCountEntry, { clicks })
    })
  })

export default setup
```

| Field | Rule |
| --- | --- |
| `id` | Unique within the plugin. |
| `side` | `start` puts the entry in the left group, `end` in the right group. |
| `order` | Sorts the entries in a group. The lowest `order` sits nearest the window edge. |
| `component` | A React component that draws the whole entry, including its tooltip and click action. Draw it as `<Button variant="ghost" size="xs">` from `@dia/renderer-plugin`, as dia's own entries do. |

- Unloading the plugin removes its entry. Reloading `dia-layout` draws the entry again without reloading the plugin.
- Create the state the entry shows in setup with `Atom.keepAlive`, as above. Without `keepAlive`, the state returns to its initial value whenever the status bar is drawn again, for example after `dia-layout` reloads.
- `plugins/dia-example/renderer.ts` and `plugins/dia-example/click-count-entry.tsx` in the dia repository hold the complete example.

## Load and reload

| Tool | Input | Effect |
| --- | --- | --- |
| `plugin_override` | `name`, `directory` (absolute path of the plugin folder) | Makes dia load plugin `name` from `directory`, then reloads it. A `name` that dia does not ship adds a new plugin. dia keeps the override across restarts. |
| `plugin_reload` | `name` | Loads the current source of the plugin again. Call it after each edit. |
| `plugin_clear_override` | `name` | Returns a plugin dia ships to the copy built into dia and reloads it. |

- A failed reload keeps the previous version running and returns the failure, for example a wrong `api` version, a syntax error or a failure in setup. Fix the source and call `plugin_reload` again.
- dia refuses a reload after the plugin's loads have added 100 MB to the Host's memory, and after a change to a file outside the plugin folder that the plugin imports. The plugin keeps running until dia restarts.
- A reload closes and reopens only the reloaded plugin and the plugins that inject a service it provides. Agent sessions keep running.
