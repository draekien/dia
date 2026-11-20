import type { AgentNotification } from '@shared/domain/notification'
import type { PluginStartupEvent } from '@shared/domain/startup'
import { type HostToMainMessage, Notify, StartupProgress } from '@shared/ipc/host-process'
import { Context, Effect, Layer, type Stream, SubscriptionRef } from 'effect'

/**
 * dia's window as the Host knows it. `attended` emits whether the user can see the window, the
 * current value first; it is `true` until main first reports. Call `setAttended` with each report
 * from main. `notify` asks main to show an OS notification. `reportStartup` tells main about one
 * step of the plugin kernel's startup, so the window can show it. Provide it with
 * {@link makeAppWindowLive}.
 */
export class AppWindow extends Context.Service<
  AppWindow,
  {
    readonly attended: Stream.Stream<boolean>
    readonly setAttended: (attended: boolean) => Effect.Effect<void>
    readonly notify: (notification: AgentNotification) => Effect.Effect<void>
    readonly reportStartup: (event: PluginStartupEvent) => Effect.Effect<void>
  }
>()('AppWindow') {}

/** Builds the live {@link AppWindow}. `post` sends one message to main. */
export const makeAppWindowLive = (post: (message: HostToMainMessage) => Effect.Effect<void>) =>
  Layer.effect(
    AppWindow,
    Effect.gen(function* () {
      const attendedRef = yield* SubscriptionRef.make(true)
      return {
        attended: SubscriptionRef.changes(attendedRef),
        setAttended: (attended) =>
          SubscriptionRef.set(attendedRef, attended).pipe(
            Effect.andThen(Effect.logDebug('Window attention changed', { attended }))
          ),
        notify: (notification) => post(Notify.make({ notification })),
        reportStartup: (event) =>
          post(StartupProgress.make({ event })).pipe(
            Effect.andThen(Effect.logDebug('Reported a startup step to main', { step: event._tag }))
          )
      }
    })
  )
