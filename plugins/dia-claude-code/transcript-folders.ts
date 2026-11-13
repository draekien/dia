import * as os from 'node:os'
import { listSessions } from '@anthropic-ai/claude-agent-sdk'
import { type PathsMoved, relocatePath } from '@dia/plugin'
import { Config, Effect, FileSystem, Option, Path } from 'effect'

const MAX_FOLDER_NAME = 200

/** Claude Code's folder for the transcripts of sessions run in `cwd`, under `projectsDir`. */
export const transcriptFolderOf = (projectsDir: string, cwd: string): string =>
  `${projectsDir}/${folderNameOf(cwd)}`

const folderNameOf = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * The folder Claude Code keeps transcripts in: `<CLAUDE_CONFIG_DIR>/projects`, or
 * `~/.claude/projects` when the variable is unset.
 */
export const claudeProjectsDir: Effect.Effect<string> = Config.String('CLAUDE_CONFIG_DIR').pipe(
  Config.withDefault(`${os.homedir()}/.claude`),
  Effect.orElseSucceed(() => `${os.homedir()}/.claude`),
  Effect.map((configDir) => `${configDir}/projects`)
)

/** The working directory of every Claude Code session on this machine, from the Agent SDK. */
export const sessionCwds: Effect.Effect<ReadonlyArray<string>, unknown> = Effect.tryPromise(() =>
  listSessions()
).pipe(Effect.map((sessions) => [...new Set(sessions.flatMap((session) => session.cwd ?? []))]))

/**
 * Renames the transcript folder of each session working directory in `cwds` that lies under
 * `move.from` to the folder of its new path, so Claude Code resumes those sessions there. `cwds`
 * runs only when `projectsDir` holds a folder whose name could belong to a directory under
 * `move.from`. A folder that does not exist, a destination that already exists, and a name Claude
 * Code would shorten (over 200 characters) are logged and skipped; nothing is deleted. Fails only
 * when `cwds` or a rename fails. Requires `FileSystem` and `Path`.
 */
export const moveTranscriptFolders = Effect.fn('ClaudeCode.moveTranscriptFolders')(function* (
  move: PathsMoved,
  projectsDir: string,
  cwds: Effect.Effect<ReadonlyArray<string>, unknown>
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const exists = (folder: string) => fs.exists(folder).pipe(Effect.orElseSucceed(() => false))
  const prefix = folderNameOf(move.from).toLowerCase()
  const folders = yield* fs.readDirectory(projectsDir).pipe(Effect.orElseSucceed(() => []))
  if (!folders.some((folder) => folder.toLowerCase().startsWith(prefix))) return
  for (const cwd of yield* cwds) {
    const relocated = relocatePath(cwd, move)
    if (Option.isNone(relocated)) continue
    const target = relocated.value
    const from = path.normalize(transcriptFolderOf(projectsDir, cwd))
    const to = path.normalize(transcriptFolderOf(projectsDir, target))
    if (path.basename(to).length > MAX_FOLDER_NAME) {
      yield* Effect.logWarning('Left a transcript folder whose new name Claude Code shortens', {
        cwd,
        target
      })
      continue
    }
    if (!(yield* exists(from))) continue
    if (yield* exists(to)) {
      yield* Effect.logWarning('Left a transcript folder; its new folder already exists', {
        from,
        to
      })
      continue
    }
    yield* fs.rename(from, to)
    yield* Effect.logInfo('Moved a transcript folder with its working directory', { from, to })
  }
})
