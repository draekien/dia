# After a rewind restores a file, the next write to it gets no new checkpoint

**Date:** 2026-10-25

## Context

In the unpackaged app, turns 1 to 3 wrote `a.txt` = `one`, `two`, `three`. Rewinding turn 3 and then turn 2 restored `one`. A later turn in the fork wrote `two` again, and rewinding that turn left `a.txt` as `two`: `rewindFiles` returned `canRewind: true` and changed nothing. A dry run of `rewindFiles` on that fork session reported `"filesChanged":[]`.

## Reasoning / Learning

- **The defect is in Claude Code's file checkpointing, not in dia.** A script using the Agent SDK 0.3.207 alone (bundled CLI, `enableFileCheckpointing`, `replay-user-messages`) reproduced it: three turns write `one`, `two`, `three`; a query forked at turn 2 applies `rewindFiles` to turns 3 and 2; a query forked at turn 1 writes `two-again`; that turn's snapshot names the same stale backup as in dia.
- **The cause is in the transcript's `file-history-snapshot` entries.** The CLI stores a file's pre-edit content as numbered backups under `~/.claude/file-history/<session>/<hash>@v<n>`. Each user turn's snapshot names the backup to restore. In both the dia fork and the SDK-only fork, the write turn after the rewind names `@v3`, whose content is `two` (the content before turn 3). The content before the write turn was `one`, and the CLI made no new backup for it. A rewind of that turn therefore restores `two`.
- **Without a prior rewind the CLI does make a new backup.** In the SDK-only run that forked without a prior `rewindFiles`, the file held `three` before the fork's write, and the snapshot named a new `@v4` = `three`.
- A rewind to a turn earlier than the last rewind works: a forked query restored `a.txt` to a turn of its parent session (turn 2 in the app, turn 1 in an SDK-only dry run).
- For an applied rewind (`dryRun` unset), `RewindFilesResult.filesChanged` is empty or absent in this SDK version, also when the file changed: dia logged `filesChanged: 0` for rewinds that restored `a.txt`. A dry run lists the files.

## Implication

- When a rewind test in the app appears to restore nothing, check the snapshot's backup content before suspecting dia. The case to avoid: a turn that rewrites a file that an earlier rewind restored.
- To observe a rewind in the app without this defect, have the rewound turn create a new file; the rewind then deletes it.
