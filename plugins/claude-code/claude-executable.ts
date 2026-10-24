import { createRequire } from 'node:module'
// @effect-diagnostics-next-line nodeBuiltinImport:off -- resolving the SDK's native binary path is a synchronous filesystem-path computation outside any Effect.
import { sep } from 'node:path'

/**
 * Resolves the Agent SDK's bundled native Claude Code binary to a real, spawnable filesystem
 * path. In a packaged app it returns the copy under `app.asar.unpacked`, because the OS cannot
 * execute a file inside `app.asar`. Returns `undefined` when the binary cannot be resolved (for
 * example an unpackaged dev run), so the SDK uses its own resolution.
 */
export const resolveClaudeExecutable = (): string | undefined => {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const nativePackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
  try {
    const resolved = createRequire(import.meta.url).resolve(`${nativePackage}/claude${ext}`)
    return resolved.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
  } catch {
    return undefined
  }
}
