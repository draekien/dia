# Plugin module exports

Issue: draekien/dia#198. Blocks #199, #200 and #201.

Lets a plugin list source files that other code may import as `@dia-plugin/<name>/<file>`, resolves that specifier in the Host, the renderer build, typecheck and tests, makes `@dia/plugin` resolve in the renderer build, and reloads a plugin's Host importers when it reloads.

## Success criteria

1. In a packaged build, `plugins/example`'s host and renderer entries both import `@dia-plugin/example/messages`, which imports a schema from `@dia/plugin`; the Example page shows the greeting.
2. A host entry that imports `@dia-plugin/<other>/<file>` gets the exporter's copy as of the exporter's last load (the override directory when one was set then), or the catalog's current copy when the exporter has never loaded. Changing the override gives importers new instances at the exporter's next load, or at the importer's next load when the exporter has never loaded.
3. An unknown plugin, or a file the exporter does not list in `exports`, fails only the importing plugin (`Failed` on a first load, otherwise it keeps its previous version with `reloadError`; the message contains the specifier); other plugins load.
4. An exporter that is unloaded or disabled still resolves for its importers, and an importer that loads before its exporter shares one module instance with it.
5. Loading the exporter closes the plugins that import a module the load gave a new instance, directly or through other exports, before it closes, and loads each of them once again after it opens, so all of them run the new module instances. When no module changed, no importer is closed. The edges come from the resolve hook.
6. An exported module that uses `process`, `Buffer`, `window` or `document`, or imports a `node:*` module, fails `pnpm typecheck`; one that imports anything other than `effect`, `effect/*`, `@dia/plugin`, `@dia-plugin/*` or a relative file fails `pnpm test`.
7. A manifest export missing from `tsconfig.plugin-exports.json` › `include` or `tsconfig.web.json` › `include` fails `pnpm test`.

## Part 1: the manifest field

```jsonc
// plugins/example/plugin.json
{
  "name": "example",
  "api": "0.0.23",
  "category": "feature",
  "host": "host.ts",
  "renderer": "renderer.ts",
  "exports": ["messages.ts"],
  "load": "eager"
}
```

`src/shared/plugin/manifest.ts`:

```ts
/** A file a plugin lets other code import: a `.ts` path relative to the plugin directory, without `..`. */
export const PluginExport = Schema.String.check(Schema.isPattern(/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.ts$/))

// FeatureManifest and AdapterManifest each gain:
exports: Schema.optional(Schema.Array(PluginExport))
```

The specifier for an export is `@dia-plugin/<plugin name>/<export without .ts>`: `"exports": ["messages.ts"]` in plugin `example` gives `@dia-plugin/example/messages`; `"exports": ["domain/role.ts"]` gives `@dia-plugin/example/domain/role`. A `.tsx` file cannot be exported.

`src/shared/plugin/plugin-export.ts` holds the one parser every resolver uses:

```ts
/** The plugin and file an `@dia-plugin/...` specifier names. */
export interface PluginExportTarget { readonly plugin: string; readonly file: string }

/**
 * Resolves `specifier` against the exports `exportsOf` reports for each plugin name
 * (`undefined` for an unknown plugin). Returns `undefined` when `specifier` does not start with
 * `@dia-plugin/`, the target when the plugin lists `<file>.ts`, or a message for an unknown
 * plugin or an unlisted file.
 */
export const resolvePluginExport: (
  specifier: string,
  exportsOf: (plugin: string) => ReadonlyArray<string> | undefined
) => PluginExportTarget | { readonly message: string } | undefined
```

Messages: `Cannot import "@dia-plugin/x/y": no plugin named "x"` and `Cannot import "@dia-plugin/x/y": plugin "x" does not export "y.ts"`.

`PLUGIN_API_VERSION` goes from 0.0.22 to 0.0.23, and every `plugins/*/plugin.json` `api` follows.

## Part 2: what an exported module may import

An exported module, and every module it imports, loads in both the Host and the renderer, so it follows ADR-0013's rules for `src/shared`:

| May import | May not import or use |
| --- | --- |
| `effect` and its subpaths | `node:*` and Node globals (`process`, `Buffer`) |
| `@dia/plugin` | DOM globals (`window`, `document`) |
| `@dia-plugin/<name>/<file>` | `@shared/*`, `@renderer/*`, `@dia/renderer-plugin` |
| relative files in the same plugin | `react` and any other package |

An export's own `@dia-plugin/...` imports resolve from its plugin root and record edges like any plugin module's.

`tsconfig.plugin-exports.json` enforces the global and Node-type rules:

```jsonc
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": [],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "paths": {
      "@shared/*": ["./src/shared/*"],
      "@dia/plugin": ["./src/host/plugin-api.ts"],
      "@dia-plugin/*": ["./plugins/*"]
    }
  },
  "include": ["plugins/example/messages.ts"]
}
```

It maps `@shared/*` because `src/host/plugin-api.ts` and the host files it re-exports (`session/agent-backend.ts`, `session/protocol.ts`, `services/*-seam.ts`) import through it. `pnpm typecheck` runs it as a fifth `tsc --noEmit -p` step.

`include` lists only the exported files; tsc follows their relative imports.

`src/host/plugins/plugin-exports.test.ts` reads every `plugins/*/plugin.json` and, for each export:

- fails when the file is not in `tsconfig.plugin-exports.json` › `include` or `tsconfig.web.json` › `include`;
- strips `//` and `/* */` comments, then collects specifiers from `(import|export)\s[^'"`;]*?\bfrom\s*['"]X['"]` (including `import type`, `export { } from`, `export * from`), `import\s*['"]X['"]` and `import\s*\(\s*['"]X['"]\s*\)`. It fails on a `require(`, on an `import(` whose argument is not a string literal, and on `import.meta`. TypeScript 7.0.2 ships no JS compiler API, so the test uses these patterns;
- a relative specifier must name a `.ts` file inside the same plugin directory, which is read the same way (each file once); an `@dia-plugin/...` specifier must resolve through `resolvePluginExport`, and its target is read as that plugin's export; any other specifier must be `effect`, `effect/*` or `@dia/plugin`. A type-only `react` import compiles under `types: []` through `node_modules`, so only this test catches it.

Each failure names the file and the specifier.

## Part 3: Host resolution

`PluginLoader` (`src/shared/plugin/plugin-registry.ts`) takes the catalog name:

```ts
readonly peek: (name: string, root: string) => Effect.Effect<PluginManifest, PluginLoadError>
readonly load: <A, E, R>(
  name: string,
  root: string,
  use: (loaded: LoadedPlugin<Context>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | PluginLoadError | PluginRestartRequiredError, R>
```

The `PluginLoader` doc becomes: "`peek` reads and decodes the manifest at `root` without importing any entry; a Host loader may also record the plugin's source for import resolution." `LoadedPlugin` gains `importers: ReadonlyArray<string>` (Part 4). The registry's call sites pass the catalog name: `peekCategory` and its callers, `loadModeOf`, `infoOf`, `list`, `unloadLocked` and `loadLocked`. `categoryOfEntry` peeks the catalog's current root (`catalog.resolve(name)`) when the entry has not loaded, so `declare` is only ever called with a catalog-resolved root.

`PluginModules` (`src/host/plugins/plugin-modules.ts`) gains:

```ts
/**
 * Records that plugin `name` loads from `root`, has `category` and exports `exports`, and
 * registers `root` with the resolution hook (installing the hook if needed), so the plugin's
 * modules are versioned and resolve `@dia/plugin` and `effect` before the plugin has loaded.
 * Replaces the record until a `transact` has run for `name`; after that only `transact`
 * changes it, so the hook resolves the copy that was last loaded. When it replaces a record
 * whose root differs, it gives the modules recorded under the old root new generations, so
 * importers evaluate again at their next load.
 */
readonly declare: (name: string, root: string, category: PluginCategory, exports: ReadonlyArray<string>) => void
```

`transact` takes the plugin's record and passes the importers to `use`:

```ts
/**
 * ... `importers` lists the plugins other than `name` that own a module this transaction gave
 * a new generation, each once, ordered so each plugin comes after the plugins it imports.
 */
readonly transact: <A, E, R>(
  name: string,
  root: string,
  category: PluginCategory,
  exports: ReadonlyArray<string>,
  use: (importers: ReadonlyArray<string>) => Effect.Effect<A, E, R>
) => Effect.Effect<A, E | PluginRestartRequiredError, R>
```

Inside the transaction the record becomes `{ root, category, exports }` and is marked transacted. When `root` differs from the root of `name`'s previous record, every recorded module under that previous root counts as changed (an earlier root replaced by `declare` had its modules invalidated by `declare`), alongside the files whose signature changed. Before `invalidate` drops the links, `transact` reads the plugin import graph (each module's imports, mapped to plugin names through the records' root prefixes); after it, `importers` is the plugins other than `name` that own a module in the returned `affected` set, in the depth-first post-order of that graph with names visited in sorted order. A cycle is broken at the first plugin visited. The record is part of the `snapshot`, so a failed transaction restores it.

The loader's `load` becomes `modules.transact(name, root, manifest.category, manifest.exports ?? [], (importers) => use({ ...loaded, importers }))`.

The loader declares and transacts under the catalog `name`, passing the manifest's `category` and `exports`. A manifest whose `name` differs from the catalog name fails in `swap` (`plugin-registry.ts:871`), and the failed transaction restores the record.

The resolve hook handles `@dia-plugin/<name>/<file>` when the importer is inside a plugin root, using `resolvePluginExport` over the records:

| Case | Result |
| --- | --- |
| a target | `nextResolve(pathToFileURL(<root of name>/<file>.ts).href, context)`, then the existing branch for URLs inside a plugin root (`recordImport`, `record(signatures)`, `generations.versioned`) |
| a message | throws `Error(message)` |
| the importer's plugin is an adapter and `name` is another plugin | throws `Error('An adapter cannot import "@dia-plugin/<name>/<file>": reloading "<name>" would close the adapter')` |

A throw inside the hook rejects the importing `import()`; `importSetup` turns it into `PluginLoadError("Cannot import \"<entry>\": <message>")`, and the registry marks the importer `Failed` with that message.

The registry's `start` calls `list()` and `loadModeOf`, which peek every plugin before the first load, so every plugin's exports resolve after `start` whether or not it is loaded.

## Part 4: loading importers again

The Host loader puts the `importers` its `transact` passes on `LoadedPlugin.importers`. The renderer loader sets `[]`, because renderer entries are bundled and never reload. When no module changed, `importers` is empty and nothing below happens.

`loadNamed` splits into `loadLocked(name)` (its body) and `lock.withPermits(1)(loadLocked(name))`. `loadLocked` creates `closed: Array<string>` before calling the loader and passes it to `swap`. For a first load as well as a reload:

1. In `swap`, after the API-version, name and `resolveSetup` checks and immediately before its `closeWithDependants(name)`, go through `loaded.importers` from last to first. An importer whose entry has a `setup` (`Loaded`, `Waiting` or `RestartRequired`) is closed with `closeWithDependants` when it has a scope, and pushed to `closed`. A `Failed` or `Unloaded` importer is left alone; it imports the exporter's current module whenever it next loads.
2. In `loadLocked`, after `deps.loader.load(...)` returns or fails and before `settle`, call `loadLocked` for each name in `closed`, in `loaded.importers` order. Each runs its own `transact` after the exporter's has ended, so the module generations are final: new when the exporter's load succeeded, restored when it failed. After each importer's `loadLocked`, an importer that has a `setup`, no scope, and status `Loaded` or `RestartRequired` is opened again with `openOrFail` from its previous setup. So an importer whose reload fails, or is refused (memory, dependency), runs its previous version with `reloadError` or `RestartRequired`, as a plugin that is not an importer does.

When the exporter's load fails before `swap` runs (invalid manifest, API mismatch, `RestartRequired`), `closed` stays empty and the importers keep running.

Importers are closed inside the exporter's tracked load, so the heap they free lowers the exporter's measured growth. Accepted: the memory guard is an estimate.

A nested importer load gives no module a new generation (its files did not change, and the exporter's transaction already gave its modules new ones), so its `importers` list is empty and it loads nothing else. Two plugins that import each other's exports therefore load once each.

## Tests

| Criterion | Test |
| --- | --- |
| 1 | `verify-in-app`, packaged build |
| 2 | `plugin-modules.test.ts` (real fixture plugins): an override set while the exporter is unloaded, then the importer loads again and gets the new copy; the same with the exporter loaded first, then loaded again |
| 3 | `plugin-modules.test.ts`: an unlisted file, an unknown plugin, an adapter importing another plugin; `plugin-export.test.ts` for `resolvePluginExport` |
| 4 | `plugin-modules.test.ts`: an importer loads before its exporter; both see one instance |
| 5 | `plugin-registry` tests with a fake loader: a chain a ← b ← c loads each once, in order; a cycle a ↔ b ends; a `Waiting` importer loads with a fresh setup; a failed importer load reopens its previous setup; a failed exporter load after step 1 loads importers against restored generations; an unchanged exporter load closes no importer |
| 6 | the import half: `plugin-exports.test.ts`; the typecheck half is the config only, with no failing fixture |
| 7 | `plugin-exports.test.ts` |

## Part 5: renderer build, typecheck and tests

| Place | Change |
| --- | --- |
| `electron.vite.config.ts` › `renderer` | alias `@dia/plugin` → `src/host/plugin-api.ts`; the `diaPluginExports()` Vite plugin |
| `vite/plugin-exports.ts` (new, in `tsconfig.node.json` › `include`) | `diaPluginExports()`: `resolveId` reads `plugins/<name>/plugin.json` and calls `resolvePluginExport`; a target resolves to `plugins/<name>/<file>.ts`, a message fails the build. It imports `resolvePluginExport` by relative path |
| `tsconfig.node.json`, `tsconfig.test.json` | `paths` gains `"@dia-plugin/*": ["./plugins/*"]` |
| `tsconfig.web.json` | its own `paths`: `@shared/*`, `@renderer/*`, `@dia/renderer-plugin`, `@dia/plugin` → `src/host/plugin-api.ts`, `@dia-plugin/*`; `include` gains `src/host/plugin-api.ts` and the host files it re-exports, because the project is `composite` |
| `vitest.config.ts` | alias `'@dia-plugin': resolve('plugins')` |

`tsconfig.base.json` is unchanged, so `tsconfig.shared.json` cannot import `plugins/*`.

## Part 6: the example plugin

```ts
// plugins/example/messages.ts
import { SessionId } from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/** Asks the example plugin's `host` entry for its greeting, optionally naming the session it is for. */
export const ReadGreeting = Rpc.make('ReadGreeting', {
  payload: { session: Schema.optional(SessionId) },
  success: Schema.String
})
```

`host.ts` and `renderer.ts` import `ReadGreeting` from `@dia-plugin/example/messages`. `renderer.ts`'s `callHost(ctx, ReadGreeting, {})` is unchanged.

## Design rationale

**A file list, not a named map** — the subpath is the file path, so `tsconfig` and vitest need one static line each (user decision, 2026-11-07).

**Edges from the resolve hook** — the hook sees every cross-plugin import, so the edge set cannot drift from the code; a manifest list would repeat it (user decision). `transact` derives the importers from the modules it gave new generations, so a load that changed nothing closes no importer, and a nested importer load lists none.

**A separate tsconfig plus an import test** — the compiler rejects Node and DOM globals, as `tsconfig.shared.json` does for `src/shared` (user decision). The tsconfig must map `@shared/*` for the `@dia/plugin` barrel, so the import allow-list is a test. The test reads specifiers with regular expressions because "TypeScript 7.0 ... does not ship with an API" ([announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)); when the patterns prove fragile, or TypeScript 7.1 ships its announced API, the test can switch to that API or to `@typescript/typescript6`, which re-exports the 6.0 API.

**One parser** — the Host hook, the Vite plugin and the test share `resolvePluginExport`, so the specifier rules and messages are written once.

**Importers load after the exporter's transaction** — loading them inside `swap` would nest `transact`, which `PluginModules` forbids, and would see generations a failed load then restores.

**Adapters may not import other plugins' exports** — ADR-0029 forbids an adapter's `inject` because reloading the provider would close the adapter; an import edge would do the same through Part 4. An adapter may list `exports` and import its own; an adapter never reloads, so its importers are never closed by Part 4.

**Resolution does not need a loaded exporter** — an export is a source file, not a service, so an unloaded or disabled exporter still resolves (criterion 4).

## ADR

New ADR-0059 "Let a plugin export source modules that other plugins import", amending ADR-0019 (cross-plugin dependency now includes imports) and ADR-0020 (one more alias, `@dia-plugin/*`, in the loader and the renderer build).

## Refinement Record

**Round 1**

Applied:
- *Correctness* (blocker) — `declare` did not register the exporter root, so an exporter's modules resolved unversioned before it loaded. `declare` now registers the root.
- *Correctness* (blocker) — reloading importers inside `swap` nested `transact`. They now load after `loader.load` returns.
- *Correctness* (blocker) — `invalidate` drops the links `importersOf` reads. The list is read before `transact`.
- *Correctness* (blocker) — setting an override did not invalidate importers. A changed root counts the previous root's modules as changed; the record is in the snapshot.
- *Correctness* (blocker) — `composite` and the replaced `paths` stopped the exports tsconfig compiling. `composite` dropped, `@shared/*` mapped, the import allow-list moved to a test.
- *Correctness* (major) — the hook hand-built a result and skipped versioning. It now calls `nextResolve` and the existing branch.
- *Correctness* (major) — `peek(root)` could declare under a manifest's own name and undo nothing. Loader methods take the catalog name; `peek` declares only unknown names; `transact` owns the record.
- *Correctness* (major) — only direct importers of a running exporter were reloaded, with self-imports and cycles undefined. `importersOf` is transitive and ordered, applies to first loads, excludes self.
- *Project rules* (major) — the Vite plugin duplicated the hook's rules and sat in `build/`. One parser in `src/shared/plugin/plugin-export.ts`; the plugin in `vite/`, typechecked by `tsconfig.node.json`.
- *Correctness* (minor) — the vitest regex alias. Now a string alias.
- *Correctness* (minor) — `PluginCallInvalid` is `CallPlugin`'s own error. The example uses `SessionId`.
- *Wording* (minor) — `.tsx`, adapter exports and nested export imports stated.

**Round 2**

Applied:
- *Correctness* (major) — `declare` kept the first record, so after an override change an unloaded exporter resolved to the old copy. `declare` replaces the record until the first `transact`. Extended beyond the finding: `transact` treats modules under every root `name` was declared with before as changed, so an override changed while the exporter is unloaded still invalidates importers.
- *Correctness* (major) — the closed importers were lost when `swap` failed. `loadLocked` owns a `closed` list that `swap` fills just before closing the exporter; step 2 runs on success and failure.
- *Correctness* (major) — `Waiting` importers kept their stale `setup`, and `Failed` or `Unloaded` ones would have been revived. Importers with a `setup` are reloaded; the rest are left alone.
- *Correctness* (major) — `importersOf` had no algorithm. Specified: module graph to plugin graph, depth-first post-order, sorted visit order.
- *Correctness* (major) — the import test had no exact rule. Patterns and fail conditions stated; TypeScript 7.0.2 has no JS API (verified: `node_modules/typescript/lib` holds only `tsc.js`, and `preProcessFile` is undefined).
- *Information Hiding* (minor) — `peek`'s new side effect is now in the `PluginLoader` doc; call sites listed.
- *Correctness* (minor) — a name-mismatched manifest relies on `swap`'s check and `transact`'s restore; stated.
- *Correctness* (minor) — importers' freed heap lands in the exporter's tracked window; accepted and stated.
- *Wording* (minor) — `include` lists only exported files; tsc follows relative imports.

No change:
- *YAGNI* (minor) — the record's `category` field: the finding kept it as the cheapest synchronous adapter check.

**Round 3**

Applied:
- *Correctness* (blocker) — loading an importer from `loadLocked` read its importers again, so a chain loaded c twice and a cycle never ended. `transact` now passes `use` the plugins owning modules it gave new generations; a nested load changes nothing and lists none. `PluginModules.importersOf` removed.
- *Correctness, YAGNI* (major) — every exporter load restarted its importers, including at start when nothing changed. Follows from the fix above; criterion 5 now says no importer is closed when no module changed.
- *Correctness* (blocker) — an override set while the exporter is unloaded did not reach a reloaded importer: its cached module stayed bound to the old root. Criterion 2 now states when importers see a new root (the exporter's next load, or the importer's next load when the exporter has never loaded), and `declare` invalidates the old root's modules when it replaces an untransacted record.
- *Correctness* (major) — an importer whose load failed after step 1 closed it was left `Loaded` with no scope. It now reopens its previous setup.
- *Correctness* (minor) — criterion 3 said `Failed`; a reload keeps the previous version with `reloadError`. Reworded.
- *Correctness* (minor) — call sites peeked different roots for one name. `categoryOfEntry` peeks the catalog's current root.
- *Testing* (minor) — tests for criteria 2–5 were not named. Tests table added.

**Round 1 (continued)**

Applied with a correction:
- *Correctness* (minor) — the finding said `tsconfig.web.json` already maps `@dia/plugin` to the host barrel. It inherits base's map to `src/shared/plugin/api.ts` (`tsconfig.web.json:1-16` has no `paths`), and it is `composite`. `tsconfig.web.json` gets its own `paths` and `include` entries; `tsconfig.base.json` is unchanged.
