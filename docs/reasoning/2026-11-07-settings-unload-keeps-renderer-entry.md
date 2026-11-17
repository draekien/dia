# A plugin's renderer entry closes only by following the Host

**Date:** 2026-11-07 (updated 2026-11-17 for ADR-0084)

## Context

Verifying plugin pages (ADR-0057, issue #194) in a packaged build: the plan was to unload `example` from Settings › Plugins and watch its page leave the sidebar. The page stayed.

## Reasoning / Learning

`usePlugins().unload` (`src/renderer/src/hooks/use-plugins.ts`) calls `window.dia.plugins.unload`, which unloads the plugin in the Host's registry only. The renderer has its own registry (`startRendererPlugins`, `src/renderer/src/plugins/built-in-renderer-plugins.ts`). Until ADR-0084, nothing in the renderer acted on `PluginStatusChanged`, so after Unload the plugin's pages, rail cards and slot fillers stayed, and a page that called `callHost` showed `PluginNotServing` ("Plugin example does not serve ReadGreeting").

ADR-0084 added `followHostPlugins` (`src/renderer/src/plugins/renderer-plugins.ts`): on each `PluginStatusChanged` it unloads the renderer entry of a plugin the Host reports `Unloaded`, and loads the renderer entry of a plugin the Host reports `Loaded`. `addPage` removes a page when the renderer entry's scope closes; `src/renderer/src/lib/pages.test.ts` covers that.

## Implication

A page must still render `PluginNotServing` as a normal state, not a crash. A Host entry can fail, or reload, while its renderer entry stays loaded, and a lazy Host entry may not serve yet when the page first calls it.
