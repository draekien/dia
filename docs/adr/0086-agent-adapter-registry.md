---
status: accepted
date: 2026-11-18
decision-makers: William Pei
---

# Agent adapters register with `dia-agent-adapters`, every model choice names its adapter, and a run keeps the adapter it started on

## Context and Problem Statement

One plugin, `dia-claude-code`, provides the `AgentBackend` under `AgentBackendKey` (ADR-0065, ADR-0074). A `ServiceKey` holds one value per name (`src/shared/plugin/api.ts:17`), so dia cannot load a second agent adapter, and a model id such as `opus` has no adapter attached. dia is planned to support several agent adapters, and features such as thread titles need to pick an adapter by what it offers. How do adapters make themselves available, and how does a consumer choose one?

## Decision Drivers

* A second adapter must load beside `dia-claude-code` without a kernel change to service keys.
* A model id is only meaningful within the adapter that listed it.
* A conversation lives in one adapter's transcript store, so a run cannot move to another adapter.
* Data saved before the change (runs, tabs, preferences, job titles, schedules) must keep working.

## Considered Options

* A registry plugin, `dia-agent-adapters`, that adapters register with
* Several providers of `agentBackend` under ids
* Keep one `agentBackend` and add an adapter id only to the model setting

## Decision Outcome

Chosen option: "A registry plugin, `dia-agent-adapters`, that adapters register with", because it needs no kernel change to service keys and matches how t3code keeps the adapter in every model selection (`packages/contracts/src/modelSelection.ts:9` in the `t3code` clone).

* `dia-agent-adapters` replaces `dia-adapters`. It provides `AgentAdaptersKey`. An adapter calls `register(ctx, { label, backend })` in its setup scope; the id is the plugin's name. It serves each adapter's models, status, health, install path, disabled permission modes and attachment types to the renderer, and owns the Adapters settings page.
* Every model choice is `ModelSelection { backend, model }`: the default for new threads, job titles and schedules.
* Each run and tab records `backend` when it is created. No operation changes it. A run whose adapter is not registered is reported (`<id> is not loaded`) and is never moved to another adapter.
* Records saved before this ADR read as `dia-claude-code` (`LEGACY_ADAPTER_ID`): a decoding default for JSON records and a `backend` column with that default on the `agents` table.

The design is `docs/designs/agent-adapter-registry.md`.

This ADR amends ADR-0065 (model preferences no longer belong to the plugin that provides `agentBackend`; they are kept per adapter in `dia-runs`), ADR-0074 (`dia-runs` no longer exports `AgentBackendKey` or owns the model-catalog and adapter-status feeds; `dia-agent-adapters` exports the `AgentBackend` contract) and ADR-0062 (the `AgentBackendKey` plugin key is removed).

### Consequences

* Good, because a second adapter registers without changing `dia-runs`, `dia-org` or the kernel.
* Good, because a consumer selects an adapter by id from one list, and the stacked text generation work adds an optional `textGeneration` to the same registration (ADR-0087).
* Bad, because the change reaches every plugin that starts a run, and the `CreateTab` RPC (`PROTOCOL_VERSION` bump).
* Bad, because while an adapter is not registered its runs report `<id> is not loaded` with the plugin id, not the adapter's label: the label exists only in the registration.

## Pros and Cons of the Options

### A registry plugin, `dia-agent-adapters`, that adapters register with

* Good, because registrations follow the registering plugin's scope, so reload and unload need no extra code.
* Bad, because adapter facts (models, status) are served by a different plugin than run choices (preferences, defaults), so the renderer calls two plugins.

### Several providers of `agentBackend` under ids

* Bad, because `ServiceKey` holds one value per name; ids would change the kernel's service registry for one plugin's use.

### Keep one `agentBackend` and add an adapter id only to the model setting

* Bad, because runs, job titles and schedules would still store bare model ids that a second adapter would read.

## More Information

t3code facts were read from the `.repos/t3code` clone at `337c5858c`: thread records keep `providerInstanceId` (`packages/contracts/src/orchestrationV2.ts:449`); switching to an unavailable provider is rejected (`apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts:37`).
