# A plugin imports `@effect/platform-node` by subpath, not by its index

**Date:** 2026-10-24

## Context

Phase 4 step 4 moved the git operations into `plugins/git-ops`, whose `host.ts` provides `NodeServices.layer` to the git code. With `import { NodeServices } from '@effect/platform-node'` the plugin loaded in the unpackaged app, but in an `electron-builder --dir` build it ended `git-ops:Failed` with `Cannot find package 'redis' imported from …\app.asar\node_modules\@effect\platform-node\dist\NodeRedis.js`.

## Reasoning / Learning

The package index (`dist/index.js`) re-exports every module, including `NodeRedis.js`, which imports the optional peer `redis`. The unpackaged run resolved `redis` through the pnpm store; the packaged app does not contain it. The package's `exports` map allows `./*` → `./dist/*.js`, so `@effect/platform-node/NodeServices` loads only the modules `NodeServices` needs (`NodeChildProcessSpawner`, `NodeFileSystem`, `NodePath`, `NodeCrypto`, `NodeStdio`, `NodeTerminal`).

## Implication

A plugin that needs Node platform services imports `import * as NodeServices from '@effect/platform-node/NodeServices'`. Check any new plugin that imports a package index in a packaged build, because the unpackaged run can hide a missing optional peer.
