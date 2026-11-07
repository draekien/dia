---
status: "accepted, amended by ADR-0062"
date: 2026-11-07
decision-makers: William Pei
---

# Type a plugin service by a key its provider exports

## Context and Problem Statement

`ctx.inject`, `registry.use` and `ctx.whenProvided` return `unknown` (`src/shared/plugin/api.ts`), so a service's type has to live in the kernel: `src/host/services/org-seam.ts` declares `Org` for the `org` plugin, and a consumer casts to it. Adding or changing a service changes the kernel and `PLUGIN_API_VERSION`. How does a consumer get a service's type from the plugin that provides it, and how is a value checked when the provider and the consumer were written against different versions (an override at another commit)?

## Decision Drivers

* A plugin's contracts belong in the plugin (ADR-0019), and ADR-0059 lets a plugin export a module other plugins import.
* `@dia/plugin` maps to `src/shared/plugin/api.ts` in `tsconfig.base.json` and to `src/host/plugin-api.ts` in the node, web, test and plugin-exports configs; TypeScript cannot augment an interface through a module that only re-exports it.
* An override can run a provider at an older commit than the consumer was checked against; the Host's seams already guard against this at runtime (`hasMembers` in `meta-repo-seam.ts`, `agentBackendProblems` in `agent-backend.ts`).
* Reference: cordis and deepseek-harness declare a service's type by augmenting `Context` in the providing package (`cordis/packages/hmr/src/index.ts:11`, `deepseek-harness/packages/api/gateway/src/client/index.ts:127`) and avoid version skew by installing one copy of each package; cordis's `check` (`cordis/packages/core/src/reflect.ts:213`) is an availability predicate, not a type guard.

## Considered Options

* A typed key value, exported by the provider, with a required guard run on read
* Module augmentation of a `Services` interface in `@dia/plugin`
* A typed key with no runtime check, or with a check of key identity only

## Decision Outcome

Chosen option: "a typed key value with a required guard run on read", because it works under both `@dia/plugin` mappings, the consumer's import of the key is the edge ADR-0059 uses to reload importers, and only the reader's guard can tell that an override provider's value lacks what the reader expects (user decisions, 2026-11-07, issue #199). The design is `docs/designs/typed-plugin-services.md`.

| Rule | Value |
| --- | --- |
| Key | `ServiceKey.make(name, is)` in a module the provider exports; `A` is inferred from the guard `is: (value: unknown) => value is A` |
| Reading | `inject`, `use` and `whenProvided` return `A` for a `ServiceKey<A>`; a string key still returns `unknown` |
| Check | A read runs the reader's `is` on the provided value. A value that fails, or a guard that throws, counts as not provided, and a warning names the key and the provider |
| Storage | One slot per name: a string key and a `ServiceKey` with the same name read the same provider; a manifest's `inject` lists names |
| Host-consumed services | The agent backend, meta repo and worktrees keep string keys and their seams in `src/`; the Host cannot import `plugins/*`. Converting them is considered under #201 |

This amends ADR-0055 (`use` accepts a typed key and checks the value before taking a lease) and ADR-0056 (`whenProvided` accepts typed keys, and a setup runs only when every typed key's guard passes).

### Consequences

* Good, because a service declared only inside its plugin is typed for every consumer that imports its key, with no file under `src/` naming the type.
* Good, because a provider at an older version reads as absent instead of failing inside the consumer.
* Bad, because each service carries a hand-written guard that must be updated when its interface changes.
* Bad, because a consumer that imports a provider's key fails to load when the provider is not installed (ADR-0059).

## Pros and Cons of the Options

### A typed key value with a required guard

* Good, because it needs no change to how `@dia/plugin` resolves.
* Bad, because a guard can drift from the interface it checks.

### Module augmentation

* Good, because it matches cordis and needs no key value.
* Bad, because the augmentation would target a module that only re-exports `PluginServices` in at least one tsconfig.
* Bad, because two plugins declaring the same name merge into one interface.

### No check, or key identity only

* Good, because it needs no guard.
* Bad, because an override provider and its consumer both import the override's key module, so identity passes while the value's shape is old.

## More Information

Issue #199; Host-consumed keys deferred in https://github.com/draekien/dia/issues/201#issuecomment-6701958969. ADR-0062 types them with `ServiceKey`s defined in `src/`.
