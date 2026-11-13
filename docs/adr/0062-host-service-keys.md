---
status: "accepted, amended by ADR-0065, ADR-0073 and ADR-0074"
date: 2026-11-07
decision-makers: William Pei
---

# Type the services the Host reads by keys defined in `src/`

## Context and Problem Statement

ADR-0060 types a plugin service by a `ServiceKey` the providing plugin exports, and left three services with string keys: the agent backend (`AGENT_BACKEND_KEY`), the meta repo (`META_REPO_KEY`) and the worktrees `GitOps` (`WORKTREES_KEY`). The Host reads all three, and `out/main` cannot import `plugins/*`, so their keys cannot live in the providing plugin. Each seam checked the `unknown` value it read with its own guard. How are these three services typed? (Issue #201.)

## Decision Drivers

* A provider that provides a value of the wrong type fails to compile, as ADR-0060 gives plugin-owned services.
* The per-method problem list `agentBackendProblems` still reports what an adapter is missing.
* A `meta` plugin that provides only `forNewSession` still adds to sessions.

## Considered Options

* `ServiceKey`s defined in `src/` beside the interface each types
* Keep string keys and the seams' own guards

## Decision Outcome

Chosen option: "`ServiceKey`s defined in `src/` beside the interface each types", because it gives providers and Host readers one typed key per service while the key stays where the Host can import it.

* `AgentBackendKey` (`src/host/session/agent-backend.ts`) accepts a value `agentBackendProblems` finds no problem with. `MetaRepoKey` (`src/host/services/meta-repo-seam.ts`) accepts a value whose `forNewSession` is an effect, and reads as `SessionMetaRepo`. `WorktreesKey` (`src/host/services/worktrees-seam.ts`) accepts a value with every `GitOps` operation. `@dia/plugin` exports all three; the stored names stay `agentBackend`, `metaRepo` and `worktrees`.
* A key's `is` returns a boolean. A value that fails it reads as not provided, and the registry logs `A provided service failed its key check`. The per-method list from `agentBackendProblems` is reported at adapter load through `adapterContract`, which reads the raw value; `resolveAgentBackend` does not repeat it.
* `MetaRepoKey` checks only `forNewSession`, because one name allows one key. `withMetaRepo` checks the push members itself before it runs.
* A contract only plugins use lives in an exported module of the plugin that owns it (ADR-0059), not in `src/`. The org domain schemas move to `plugins/org/domain.ts` (`@dia-plugin/org/domain`).

This ADR amends ADR-0060.

### Consequences

* Good, because `ctx.provide(WorktreesKey, value)` fails to compile when `value` is not a `GitOps`.
* Good, because the seams no longer repeat a member check the key already makes.
* Bad, because a runtime read of an invalid agent backend no longer logs which methods are missing; the adapter load failure is the only place that lists them.
* Bad, because `MetaRepoKey` reads as a type whose push members may be missing, until no `meta` plugin without them can load.

## Pros and Cons of the Options

### Keep string keys and the seams' own guards

* Good, because nothing changes for the three providers.
* Bad, because a provider of the wrong type compiles, and each seam keeps its own guard.

## More Information

Spec: `docs/designs/plugin-owned-contracts.md`. cordis removes a service whose `check` fails from the store on every read (`packages/core/src/fiber.ts:387-398` in `cordiverse/cordis`), as `checkedSlot` does here.
