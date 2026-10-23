import { Effect, Exit } from 'effect'

const { register } = await import('tsx/esm/api')
register()

const { runHost } = await import('./host-main')

Effect.runFork(runHost).addObserver((exit) => {
  // @effect-diagnostics-next-line globalConsole:off -- last-resort report from the Host's top-level entry when no Effect logger is running.
  if (Exit.isFailure(exit)) console.error('Host exited with a failure', exit.cause)
  process.exit(Exit.isSuccess(exit) ? 0 : 1)
})
