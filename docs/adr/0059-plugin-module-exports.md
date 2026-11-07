---
status: "accepted"
date: 2026-11-07
decision-makers: William Pei
---

# Let a plugin export source modules that other plugins import

## Context and Problem Statement

A plugin's `host` and `renderer` entries already share a module by relative path (`plugins/example/messages.ts`), but that module can import only `effect`: the Host's resolve hook maps only `effect` and `@dia/plugin` (`src/host/plugins/plugin-modules.ts`), and the renderer build has no `@dia/plugin` alias (`electron.vite.config.ts`). No plugin can import another plugin's module. So a plugin's call contracts and domain schemas live in `src/shared` and are re-exported from `src/host/plugin-api.ts` (#177, #178). How does a plugin share a module that imports domain schemas, with its own entries and with other plugins?

## Decision Drivers

* A plugin's contracts belong in the plugin, not in the kernel.
* An exported module loads in the Host (tsx, from source) and in the renderer (bundled by Vite), so it must be platform-neutral (ADR-0013).
* An override edit to an exporter must not leave importers running the previous module instance (ADR-0020 hot reload).
* Reference: deepseek-harness makes each plugin a package that other packages import by name; its runtime resolution maps shared package names to one installed copy, and a client module table resolves imports between plugins (`apps/desktop/README.md`, `packages/boot/app-boot/README.md`, `packages/client/modules/src/client/system.ts`; findings on #198).

## Considered Options

* A list of exported files in `plugin.json`, imported as `@dia-plugin/<name>/<file>`
* A named export map in `plugin.json`
* Keep contracts in `src/shared`

## Decision Outcome

Chosen option: "a list of exported files", because the subpath equals the file path, so `tsconfig` paths and the vitest alias need one static line each (user decision, 2026-11-07, issue #198). The design is `docs/designs/plugin-module-exports.md`.

| Rule | Value |
| --- | --- |
| Declaring | `"exports": ["messages.ts"]` in `plugin.json`; `.ts` files only |
| Importing | `@dia-plugin/<name>/<file without .ts>`, from any plugin module, in the Host, the renderer build, typecheck and tests |
| What an export may import | `effect`, `@dia/plugin`, `@dia-plugin/*`, relative files; no Node or DOM globals. Enforced by `tsconfig.plugin-exports.json` and `plugin-exports.test.ts` |
| Missing exporter | An unknown plugin or an unlisted file fails only the importing plugin. An unloaded or disabled exporter still resolves: an export is a source file, not a service |
| Exporter reload | The registry closes the plugins that import a module the load changed, and loads each again once after the exporter's load. The import edges come from the Host resolve hook |
| Adapters | An adapter may export, but may not import another plugin's export, for the reason ADR-0029 forbids its `inject` |
| `@dia/plugin` in the renderer | The renderer build aliases it to `src/host/plugin-api.ts`, whose runtime imports are `effect` and `src/shared` |

### Consequences

* Good, because a plugin owns its contracts, and #199 can move service types into the providing plugin.
* Good, because one parser (`resolvePluginExport`) gives the Host, the renderer build and the test the same rules and messages.
* Bad, because the registry gains a second reason to reload a plugin next to `inject`.
* Bad, because each export needs an `include` line in two tsconfigs; a test fails when one is missing.
* Bad, because the plugin context gains a manifest field, so `PLUGIN_API_VERSION` goes from 0.0.22 to 0.0.23.

## Pros and Cons of the Options

### A list of exported files

* Good, because typecheck and vitest map the specifier with one static line.
* Bad, because a file cannot be exported under a name other than its path.

### A named export map

* Good, because the export name can differ from the file path.
* Bad, because `tsconfig` paths cannot read a manifest, so each name needs a generated `paths` entry.

### Keep contracts in `src/shared`

* Good, because it needs no change.
* Bad, because every plugin feature then changes the kernel, which ADR-0019 set out to avoid.

## More Information

* Amends ADR-0019 (plugins depend on each other through imports as well as `inject`) and ADR-0020 (the loader and the renderer build resolve one more specifier, `@dia-plugin/*`). Related: ADR-0013, ADR-0029, ADR-0032.
