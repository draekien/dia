// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolving the spawn path is a synchronous check, run once per query start.
import { statSync } from 'node:fs'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the Agent SDK takes a synchronous path; resolving it is a pure path computation over an injected file check.
import { posix, win32 } from 'node:path'
import type { HostPluginContext } from '@dia/plugin'
import { Effect, FileSystem, Option, Path, Schema } from 'effect'

/** Whether `path` names an existing file. Pass it to {@link makeClaudeInstall} outside tests. */
export const isExistingFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The `ended` reason of a session that could not start because no Claude Code install was found. */
export const NOT_INSTALLED_REASON = 'Claude Code is not installed'

/** The `ended` reason of a session that could not start because the stored install path cannot be run. */
export const overrideUnrunnableReason = (override: string): string =>
  `The configured install path cannot be run: ${override}`

const WINDOWS_SHIM_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1'])

const NPM_PACKAGE_ENTRIES = [
  ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'],
  ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js']
] as const

const envValue = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform
): string | undefined => {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

const withWindowsExtensions = (
  file: string,
  env: Readonly<Record<string, string | undefined>>
): ReadonlyArray<string> => {
  if (win32.extname(file) !== '') return [file]
  const extensions = (envValue(env, 'PATHEXT', 'win32') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0)
  return [file, ...extensions.map((extension) => `${file}${extension.toLowerCase()}`)]
}

const shimTarget = (shim: string, isFile: (path: string) => boolean): Option.Option<string> => {
  const directory = win32.dirname(shim)
  for (const segments of NPM_PACKAGE_ENTRIES) {
    const candidate = win32.join(directory, ...segments)
    if (isFile(candidate)) return Option.some(candidate)
  }
  return Option.none()
}

/**
 * Resolves `command` (an absolute path or a bare name such as `claude`) to a path the Agent SDK
 * can spawn without a shell, or none when nothing runnable exists. Pure: `env` and `isFile` are
 * injected.
 */
export const resolveSpawnablePath = (
  command: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  isFile: (path: string) => boolean
): Option.Option<string> => {
  const paths = platform === 'win32' ? win32 : posix
  const directories = paths.isAbsolute(command)
    ? ['']
    : (envValue(env, 'PATH', platform) ?? '').split(paths.delimiter).filter((dir) => dir !== '')
  for (const directory of directories) {
    const file = directory === '' ? command : paths.join(directory, command)
    const candidates = platform === 'win32' ? withWindowsExtensions(file, env) : [file]
    const found = candidates.find(isFile)
    if (found === undefined) continue
    const extension = win32.extname(found).toLowerCase()
    if (platform === 'win32' && WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return shimTarget(found, isFile)
    }
    return Option.some(found)
  }
  return Option.none()
}

/**
 * Where the adapter finds the Claude Code it runs. Build it with {@link makeClaudeInstall}; pass
 * it to the health check and to every session and probe that starts a query.
 */
export interface ClaudeInstall {
  /**
   * The path to spawn, read again on every call. With an override stored: that override
   * resolved to a spawnable path, or none when it cannot be run; a stored override never falls
   * through to `PATH`. Without one: `claude` on `PATH`, or none.
   */
  readonly resolve: Effect.Effect<Option.Option<string>>
  /** The stored override. */
  readonly override: Effect.Effect<Option.Option<string>>
  /** Stores (`Some`) or clears (`None`) the override. Queries started afterwards use it. */
  readonly setOverride: (path: Option.Option<string>) => Effect.Effect<void>
}

const InstallFile = Schema.fromJsonString(
  Schema.Struct({ override: Schema.optional(Schema.NonEmptyString) })
)

const INSTALL_FILE = 'install.json'

/**
 * Builds the {@link ClaudeInstall} that keeps its override in `<dataDir>/install.json` and
 * resolves against this process's platform and environment. `isFile` reports whether a path is
 * an existing file; it is a parameter so tests need no real files.
 */
export const makeClaudeInstall = Effect.fnUntraced(function* (
  ctx: Pick<HostPluginContext, 'dataDir'>,
  isFile: (path: string) => boolean
): Effect.fn.Return<ClaudeInstall, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(ctx.dataDir, INSTALL_FILE)

  const override = fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(InstallFile)),
    Effect.map((stored) => Option.fromUndefinedOr(stored.override)),
    Effect.tapError((error) =>
      error._tag === 'PlatformError' && error.reason._tag === 'NotFound'
        ? Effect.void
        : Effect.logWarning('Ignored an unreadable install file', { file, error: error.message })
    ),
    Effect.orElseSucceed(() => Option.none<string>())
  )

  const resolve = Effect.gen(function* () {
    const stored = yield* override
    const command = Option.getOrElse(stored, () => 'claude')
    const resolved = resolveSpawnablePath(command, process.platform, process.env, isFile)
    yield* Effect.logDebug('Resolved the Claude Code install', {
      override: Option.getOrUndefined(stored),
      resolved: Option.getOrUndefined(resolved)
    })
    return resolved
  })

  const setOverride = (next: Option.Option<string>) =>
    fs
      .writeFileString(
        file,
        Schema.encodeSync(InstallFile)(
          Option.match(next, { onNone: () => ({}), onSome: (value) => ({ override: value }) })
        )
      )
      .pipe(
        Effect.andThen(
          Effect.logInfo('Changed the Claude Code install path', {
            override: Option.getOrUndefined(next)
          })
        ),
        Effect.catch((error) =>
          Effect.logError('Could not save the Claude Code install path', {
            file,
            error: error.message
          })
        )
      )

  return { resolve, override, setOverride }
})

/**
 * The `query()` options that make the Agent SDK run the install at `path`. `env` passes this
 * process's environment plus `CLAUDE_CODE_STARTUP_FAILURE_RESULTS`, so a known startup failure
 * arrives as a `result` message with `startup_failure_reason`.
 */
export const installQueryOptions = (
  path: string
): { readonly pathToClaudeCodeExecutable: string; readonly env: Record<string, string> } => ({
  pathToClaudeCodeExecutable: path,
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1'
  }
})
