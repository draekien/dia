# Settings › Plugins › Unload stops only the Host entry; a plugin's page stays

**Date:** 2026-11-07

## Context

Verifying plugin pages (ADR-0057, issue #194) in a packaged build: the plan was to unload `example` from Settings › Plugins and watch its page leave the sidebar.

## Reasoning / Learning

`usePlugins().unload` (`src/renderer/src/hooks/use-plugins.ts`) calls `window.dia.plugins.unload`, which unloads the plugin in the Host's registry only. The renderer has its own registry (`startRendererPlugins`, `src/renderer/src/plugins/built-in-renderer-plugins.ts`), and nothing in the renderer follows `PluginStatusChanged` to unload or reload a renderer entry. So after Unload in Settings, the plugin's pages, rail cards and slot fillers stay, and a page that calls `callHost` shows `PluginNotServing` ("Plugin example does not serve ReadGreeting").

`addPage` does remove a page and close it when the renderer entry's scope closes; `src/renderer/src/lib/pages.test.ts` covers that. No UI closes that scope today.

## Implication

A page must render `PluginNotServing` as a normal state, not a crash: its host entry can be unloaded while the page stays. Making Settings unload both entries is a separate change to the renderer registry, not part of ADR-0057.
