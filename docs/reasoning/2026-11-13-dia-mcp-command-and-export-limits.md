# The `claude mcp add` option order, and what an exported plugin module cannot use

**Date:** 2026-11-13

## Context

`dia-tools` hands out a `claude mcp add` command for `dia-mcp`, and exports `tools.ts` to other plugins. Both failed the first time in ways the tests did not show.

## Reasoning / Learning

- `claude mcp add` treats `--env` as variadic. In `claude mcp add --scope user --transport stdio --env A=1 dia -- cmd`, `dia` is read as a second `--env` value and the command fails with `Invalid environment variable format: dia`. Put `--scope` and `--transport` after the last `--env`, directly before the server name: `claude mcp add --env A=1 --env B=2 --scope user --transport stdio dia -- cmd`.
- A module listed in a `plugin.json` `exports` is type-checked by `tsconfig.plugin-exports.json`, which has no DOM or Node libraries. It cannot use `TextEncoder`, `import.meta.url`, or import `@modelcontextprotocol/sdk` (`plugin-exports.test.ts` fails). `tools.ts` hashes through `Hex` and `Crypto` from `effect`, and types `mcpServer` as `object`.
- A plugin's `import.meta.resolve('@dia/plugin')` returns the URL of `out/main/plugin-api.js` at runtime (the loader's resolve hook), so a file electron-vite builds into `out/main` is found as its sibling. `dia-tools` finds `dia-mcp.js` this way; in a packaged build the path is inside `app.asar`, which dia's executable reads under `ELECTRON_RUN_AS_NODE=1`.
- In an app driven over CDP, `navigator.clipboard.writeText` rejects while the document is not focused. `Emulation.setFocusEmulationEnabled` makes it succeed.

## Implication

Keep the option order in `plugins/dia-tools/host.ts` when changing the command. Keep MCP SDK types and platform globals out of `plugins/*/tools.ts` and every other exported plugin module.
