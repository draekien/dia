# A recursive watch on Windows emits `rename` events without end after its directory is deleted

**Date:** 2026-11-08

## Context

`pathChanges` in `plugins/skills/directory.ts` follows a skills directory with `FileSystem.watch(directory, { recursive: true })`, which calls Node's `fs.watch`. The code review of #221 removed a watched directory (the effect of `git checkout` to a branch without `.claude/skills`) and checked whether the picker recovered when the directory came back.

## Reasoning / Learning

On Windows, after `rmSync` of a directory under a recursive `fs.watch`, Node emits `rename` events for that directory continuously. It reports no error and does not close the watcher. A Node probe (`fs.watch(dir, { recursive: true })`, then `rmSync(dir, { recursive: true })`) showed the flood.

Consequences for the earlier code:

- `Stream.debounce(Duration.millis(200))` never saw a 200 ms pause, so `pathChanges` emitted nothing more and used CPU until the subscription closed.
- The watch never ended, so the missing-path branch, which follows the parent until the directory is created again, never ran. A directory created again was not seen.

The fix ends the watch at the first `Remove` event after which `fs.exists(target)` is `false`, then runs `pathChanges(path)` again, which takes the missing-path branch.

Not verified: whether Linux or macOS emit a `Remove` event for the deletion of the watched directory itself. If one emits none, the watch there neither floods nor recovers.

## Implication

Any watch that must survive deletion of its own target needs an explicit end condition on a `Remove` event plus an existence check. Do not rely on the watcher erroring or closing. `plugins/skills/directory.test.ts` covers removal and re-creation of a skills directory.
