# Closing the plugin registry's scope must close dependants first

**Date:** 2026-11-10

## Context

`archive/org/host.test.ts` failed every test with `SqlError: database is not open` once it also loaded the `issues` plugin. The stack named `Issues.registerProvider`: the finalizer that releases the `org` provider runs `requeueAll`, which queries the `issues` database.

## Reasoning / Learning

`makePluginRegistry` forks each plugin's scope from the scope the registry was made in, and forks each `whenProvided` setup scope from the plugin that calls `whenProvided`. `unload` closes a provider's dependants and `whenProvided` setups before the provider (`closeWithDependants`). Closing the registry's own scope did not go through `closeWithDependants`: it closed the forked plugin scopes in reverse load order. `org` loads before `issues`, so `issues` closed first, its database closed with it, and then `org`'s `whenProvided([IssuesKey])` scope ran the provider release against the closed database. The same order ran at app shutdown.

The fix is in `src/shared/plugin/plugin-registry.ts`: plugin scopes fork from an inner `pluginsScope`, and a finalizer added after it unloads every entry through `closeWithDependants`, last loaded first. A finalizer added on the outer scope before the plugin scopes fork would run after them, which is why the inner scope is needed. Catching the defect in `releaseProvider` was ruled out: it would skip the requeue instead of running it in the right order.

## Implication

A finalizer in a `whenProvided` setup may use the provider's resources, also when the whole registry closes. `src/shared/plugin/plugin-registry.test.ts` "closes the child before its provider when the registry scope closes" covers it.
