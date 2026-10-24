import {
  type HostPluginContext,
  PENDING_USER_INPUT_KEY,
  PERMISSION_MODE_CONTROLLER_KEY,
  type PluginSetup
} from '@dia/plugin'
import { Effect } from 'effect'
import { makePendingUserInput } from './pending-user-input'
import { makePermissionModeController } from './permission-mode-controller'

const setup: PluginSetup<HostPluginContext> = (ctx) =>
  Effect.gen(function* () {
    yield* ctx.provide(PENDING_USER_INPUT_KEY, makePendingUserInput)
    yield* ctx.provide(PERMISSION_MODE_CONTROLLER_KEY, () => makePermissionModeController)
    yield* Effect.logInfo('Permissions provided', { plugin: ctx.name })
  })

export default setup
