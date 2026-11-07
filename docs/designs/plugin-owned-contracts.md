# Plugin-owned contracts (issue #201)

## Purpose

Move the contracts that only one plugin uses out of the kernel (`src/`) into that plugin, and type the three service keys the Host reads (ADR-0060), without changing what the app does.

## Scope

- In: the org domain schemas; the three Host service keys `agentBackend`, `metaRepo` and `worktrees`; `components/ui/radio-group.tsx`; `PLUGIN_API_VERSION`; the documents that name the old locations.
- Out: the six renderer files used by one plugin (`status-indicator.tsx`, `account-banner.tsx`, `workspace-problems.tsx`, `turn-steps.ts`, `turn-activity.ts`, `use-attachment-types.ts`), which a follow-up issue moves; the items in the Audit table, which stay.

## Org domain

`src/shared/domain/org.ts` moves unchanged to `plugins/org/domain.ts`, and `src/shared/domain/org.test.ts` to `plugins/org/domain.test.ts`.

- `plugins/org/plugin.json` `exports` becomes `["service.ts", "domain.ts"]`. `plugins/org/domain.ts` is added to the `include` of `tsconfig.plugin-exports.json` and `tsconfig.web.json`.
- `domain.ts` imports only `effect` and `@dia/plugin` (ADR-0059): `AgentName`, `Uuid`, `PermissionRules` and `RoleMcpServer` from `@dia/plugin`.
- `src/host/plugin-api.ts` stops re-exporting the 16 org values and adds the value exports `Uuid` (from `@shared/domain/uuid`), `PermissionRules` and `RoleMcpServer` (from `@shared/domain/role-session`). `RoleSessionOptions` stays a type export.
- Inside `plugins/org`, `service.ts`, `org.ts`, `built-in-roles.ts`, `migrations.ts` and `org.test.ts` import the org names from `./domain`. `service.ts` keeps `ServiceKey` and `type AgentName` from `@dia/plugin`; `migrations.ts` keeps `type PluginMigrations` from `@dia/plugin`; `org.ts` and `org.test.ts` import `AgentName` from `@dia/plugin`. No file in `plugins/org` imports `@shared/*`. `plugins/org/host.ts` does not change.
- A plugin other than `org` that needs an org type imports `@dia-plugin/org/domain`. It does not list `org` in `inject`: an import of an exported module needs no `inject` entry (ADR-0059). An adapter plugin cannot import it (ADR-0059).

## Host service keys

Each string key becomes a `ServiceKey` defined next to the interface it types. The Host reads them, so they stay in `src/`.

| Removed export | Replacement | Module | `is` accepts |
| --- | --- | --- | --- |
| `AGENT_BACKEND_KEY` (`src/host/session/agent-backend.ts`) | `AgentBackendKey: ServiceKey<AgentBackend, 'agentBackend'>` | `src/host/session/agent-backend.ts` | a value for which `agentBackendProblems(Option.some(value))` is empty |
| `META_REPO_KEY` (`src/shared/plugin/api.ts`) | `MetaRepoKey: ServiceKey<SessionMetaRepo, 'metaRepo'>` | `src/host/services/meta-repo-seam.ts` | a value whose `forNewSession` passes `Effect.isEffect` (it is an effect, not a function: `plugins/meta/meta-repo.ts:103`) |
| `WORKTREES_KEY` (`src/shared/plugin/api.ts`) | `WorktreesKey: ServiceKey<GitOps, 'worktrees'>` | `src/host/services/worktrees-seam.ts` | a value with every `GitOps` operation as a function |

Each key has a JSDoc stating what it reads as, what its `is` accepts, and which registry call reads it (`inject` for `AgentBackendKey`, `use` for the other two, ADR-0055).

The registry stores a provided value without running `is`; a read with a typed key returns `None` for a value that fails `is`, and the registry logs `A provided service failed its key check` with the key and provider (`src/shared/plugin/plugin-registry.ts:459-475`, `warnRejected` and `checkedSlot`, used by `inject` and `use`).

`agentBackend`:

- `agentBackendProblems` builds its messages from a module-private `const BACKEND_KEY_NAME = 'agentBackend'`, which `ServiceKey.make(BACKEND_KEY_NAME, …)` also uses.
- `adapterContract` is `{ keys: [AgentBackendKey.name], problems: (provided) => agentBackendProblems(provided(AgentBackendKey.name)) }`. It reads the raw value, so an adapter missing `models` still fails to load with `"agentBackend.models" is not a function`.
- `resolveAgentBackend` reads `AgentBackendKey`. When the read is `None`, it logs `No valid agent backend is provided` with `reason` and no `problems` field, and returns the "not loaded" backend. The per-method list is reported once, at adapter load, through `adapterContract`; a runtime read does not repeat it.
- `agentBackendChanges` starts with `Stream.make(AgentBackendKey.name)` and filters `registry.changes`, which emits key names, on `AgentBackendKey.name`.

`metaRepo`:

- `SessionMetaRepo` is `Pick<MetaRepo, 'forNewSession'> & Partial<Omit<MetaRepo, 'forNewSession'>>`, exported from `meta-repo-seam.ts` and not from `@dia/plugin`. `MetaRepoKey`'s `is` checks only `forNewSession`, because one name allows one key (ADR-0060) and an older `meta` plugin provides only that member. Providers type their value as `MetaRepo`, which is assignable.
- `resolveSessionAdditions` reads `MetaRepoKey` and runs `forNewSession`; its `lacksMembers(SESSION_MEMBERS)` error is deleted, replaced by the registry's key-check warning.
- `withMetaRepo` reads `MetaRepoKey` and narrows with `hasMembers(value, ALL_MEMBERS)` before it runs `run`; a value without the push members logs `lacksMembers(ALL_MEMBERS)` and returns `MetaRepoFailed` `The meta plugin is not loaded.`, as today.
- Remove `SessionMetaRepo` and make `is` check all four members in a later issue, once no `meta` plugin without the push members can load.

`worktrees`:

- `hasGitOperations` becomes `WorktreesKey`'s `is`. `withGitOps` reads `WorktreesKey` and calls `f` with the `GitOps`; its `The worktrees service does not have every GitOps operation` error is deleted, replaced by the registry's key-check warning.
- `pane-creation-form.tsx` imports `WorktreesKey` from `@dia/plugin` (renderer alias `electron.vite.config.ts:44`) and checks `plugin.provides.includes(WorktreesKey.name)`. It is the first kernel renderer file to import `@dia/plugin`. The renderer bundle already contains `src/host/plugin-api.ts`, because `plugins/layout/slots.ts:1` and `plugins/chat/slots.ts:1` import `ListSlot` from it, so the import adds no module to the bundle.

All three:

- `plugins/claude-code/host.ts`, `plugins/meta/host.ts` and `plugins/worktrees/host.ts` provide under the typed key from `@dia/plugin`, so a value that is not the type is a compile error.
- `src/host/plugin-api.ts` exports `AgentBackendKey`, `MetaRepoKey` and `WorktreesKey`, and no longer exports the three strings.
- Every test that imports a removed key compares and publishes the key's `.name`: `fakeInject` and `fakeUse` (`plugin-registry.fake.ts:9`) pass their callback a name string, so `key === AgentBackendKey.name`. `pane-workspace.test.ts:181-190` builds its `inject` and `use` by hand: both take `key: AnyServiceKey` and read `nameOf(key)` for the `Map` lookup and the `worktreesWithdrawn` comparison, and `inject` goes through `fakeInject` so it applies `is`. The same holds for `PubSub.publish(changes, …)`, `ServiceWithdrawnError.key`, `Map` keys and `plugin('worktrees', [WorktreesKey.name])` in `pane-creation-form.test.tsx`.
- The fakes apply the key's `is`, so every stub a test provides through `fakeInject` or `fakeUse` is a complete `GitOps` or `AgentBackend`, or has `forNewSession` for `MetaRepoKey`, unless the test asserts the `None` path on purpose.

## Other changes

- Delete `src/renderer/src/components/ui/radio-group.tsx` and the line `export * from './components/ui/radio-group'` in `src/renderer/src/plugin-api.ts`. No plugin or kernel file uses `RadioGroup` or `RadioGroupItem`; `shadcn add radio-group` restores it.
- `PLUGIN_API_VERSION` and every `plugins/*/plugin.json` `api` become `0.0.26`, because `@dia/plugin` and `@dia/renderer-plugin` remove exports.

## Documents

- Add `docs/adr/0062-host-service-keys.md` (accepted, amends ADR-0060) and its row in `docs/adr/README.md`. It records that the Host-consumed keys become `ServiceKey`s defined in `src/` beside the interface they type, that `MetaRepoKey` accepts a session-only `meta` plugin, and that the per-method list from `agentBackendProblems` is reported only at adapter load. ADR-0060's decision text is not rewritten; its status and README row name ADR-0062, and a line under its "More Information" points to it.
- Replace the old names in every file `grep -rnE "AGENT_BACKEND_KEY|META_REPO_KEY|WORKTREES_KEY|domain/org" docs CLAUDE.md DESIGN.md` matches, except `docs/plans/` (historical). Today that is `docs/designs/adapter-category.md`, `claude-code-adapter.md`, `git-ops-plugin.md`, `meta-repo.md`, `org-roles-and-hiring.md`, `plugin-service-leases.md` and `typed-plugin-services.md`.
- Root `CLAUDE.md`, the `@dia/plugin` rule: add "A contract that only plugins use lives in an exported module of the plugin that owns it, not in `src/`."
- ADR-0048, ADR-0055, ADR-0057, `plugin-pages-and-messages.md` and `DESIGN.md`, named in the issue, name none of the moved items and do not change.

## Audit: what stays in `src/`

| Item | Why it stays |
| --- | --- |
| `AgentBackend`, `AgentBackendKey`, `agentBackendProblems`, `adapterContract`, `role-session.ts` | The Host opens sessions through them; `out/main` cannot import `plugins/*`. |
| `MetaRepo`, `MetaRepoKey`, `withMetaRepo`, `resolveSessionAdditions`, `@shared/domain/meta-repo` | The Host starts sessions with meta additions and serves the Settings meta repo calls. |
| `GitOps`, `WorktreesKey`, `withGitOps`, the worktree errors | The Host creates and removes pane worktrees. |
| `pane-creation-form.tsx` worktree check | The kernel form shows the worktree option only while a plugin provides `WorktreesKey`. |
| `pane*Atom`s, `pane-rewind.ts` | Kernel state, so a transcript survives the chat plugin unloading. |
| `SessionRail`, `revealRailCard`, `useRailCardShown` | They share rail state with the kernel `TabHeader`'s `RailToggle`. |
| shadcn `ui/` files | `components.json` `aliases.ui` fixes their location for `shadcn add` and `--diff`. |

## Success criteria

1. `grep -rE "domain/org|AGENT_BACKEND_KEY|META_REPO_KEY|WORKTREES_KEY" src/` prints nothing.
2. Each key's `is` rejects a value missing a required member; `MetaRepoKey` accepts a value with only `forNewSession` (unit tests).
3. An adapter missing `models` fails to load with `"agentBackend.models" is not a function` (unit test).
4. `pnpm typecheck` (exit code), `pnpm lint` and `pnpm test` exit 0; `plugin-exports.test.ts` accepts `plugins/org/domain.ts`; `plugin-modules.test.ts` passes; `plugins/org/domain.test.ts` runs; the `pane-supervisor`, `pane-workspace`, `model-catalog-feed` and `adapter-status-feed` tests pass with only the key rename.
5. Packaged build: `org`, `meta`, `worktrees`, `claude-code` load with no error in `app.log`; a session replies; the new-pane form offers a worktree.
