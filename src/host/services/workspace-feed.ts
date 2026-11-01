import { EMPTY_WORKSPACE, type Workspace } from '@shared/domain/project'
import { Context, Layer, SubscriptionRef } from 'effect'

/**
 * The Host's current workspace. {@link PaneWorkspace} is its only writer; read it with
 * `SubscriptionRef.get`, or follow it with `SubscriptionRef.changes`, which emits the current
 * workspace first. It holds `EMPTY_WORKSPACE` until `PaneWorkspace` is built. Provide it with
 * {@link WorkspaceFeedLive}.
 */
export class WorkspaceFeed extends Context.Service<
  WorkspaceFeed,
  SubscriptionRef.SubscriptionRef<Workspace>
>()('WorkspaceFeed') {}

/** Builds an empty {@link WorkspaceFeed}. Build it once per Host and share it. */
export const WorkspaceFeedLive = Layer.effect(WorkspaceFeed, SubscriptionRef.make(EMPTY_WORKSPACE))
