# Runtime code imports `@effect/platform-node` by subpath, not by its index

**Date:** 2026-10-24

## Context

Phase 4 step 4 moved the git operations into `plugins/worktrees` (then named `git-ops`), whose `host.ts` provides `NodeServices.layer` to the git code. With `import { NodeServices } from '@effect/platform-node'` the plugin loaded in the unpackaged app, but in an `electron-builder --dir` build it ended `git-ops:Failed` with `Cannot find package 'redis' imported from …\app.asar\node_modules\@effect\platform-node\dist\NodeRedis.js`.

On 2026-10-28 the upgrade from electron-vite 5 to 6 caused the same error in the main process, so the packaged app failed at startup. electron-vite 5 bundled `@effect/platform-node` into `out/main`; electron-vite 6 externalizes it, so `out/main` imported the package index from `node_modules` at runtime.

## Reasoning / Learning

The package index (`dist/index.js`) re-exports every module, including `NodeRedis.js`, which imports the optional peer `redis`. The unpackaged run resolved `redis` through the pnpm store; the packaged app does not contain it. The package's `exports` map allows `./*` → `./dist/*.js`, so `@effect/platform-node/NodeServices` loads only the modules `NodeServices` needs (`NodeChildProcessSpawner`, `NodeFileSystem`, `NodePath`, `NodeCrypto`, `NodeStdio`, `NodeTerminal`).

## Implication

Plugins, `src/main` and `src/host` import each `@effect/platform-node` module by its subpath, for example `import * as NodeServices from '@effect/platform-node/NodeServices'`. Tests may import the index, because vitest resolves `redis` from `node_modules`. Check any change that adds a package-index import to runtime code in a packaged build, because the unpackaged run can hide a missing optional peer.
