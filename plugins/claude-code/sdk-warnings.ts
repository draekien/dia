import { Effect, Predicate } from 'effect'

/** The Node process-warning code the Agent SDK uses when `canUseTool` will not be called. */
export const CAN_USE_TOOL_SHADOWED = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

type WarningSource = Pick<NodeJS.EventEmitter, 'on' | 'off'>

const isShadowedWarning = (warning: unknown): warning is Error =>
  warning instanceof Error &&
  Predicate.hasProperty(warning, 'code') &&
  warning.code === CAN_USE_TOOL_SHADOWED

/**
 * While the calling scope is open, logs at info level each `'warning'` event `source` emits with
 * code {@link CAN_USE_TOOL_SHADOWED}, and logs nothing for a warning with another code. `source` is
 * the emitter of Node process warnings: `process`. Node still prints the warning to stderr.
 */
export const logShadowedCanUseToolWarnings = Effect.fn('logShadowedCanUseToolWarnings')(function* (
  source: WarningSource
) {
  const services = yield* Effect.context<never>()
  const listener = (warning: unknown) => {
    if (!isShadowedWarning(warning)) return
    Effect.runForkWith(services)(
      Effect.logInfo('Agent SDK will not call canUseTool', { message: warning.message })
    )
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => source.on('warning', listener)),
    () => Effect.sync(() => source.off('warning', listener))
  )
})
