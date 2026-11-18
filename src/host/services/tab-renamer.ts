import type { AgentName, TabNotFoundError } from '@shared/domain/project'
import { Context, type Effect, Layer, Option, Ref } from 'effect'

/** A function that renames tab `paneId` to `name`; fails with `TabNotFoundError` for an unknown tab. */
export type RenameTab = (paneId: string, name: AgentName) => Effect.Effect<void, TabNotFoundError>

/**
 * The Host's tab renamer, held in a `Ref`. {@link PaneWorkspace} fills it with its `renameTab` when
 * it is built; {@link HostPlugins} reads it for `ctx.renameTab`. It holds `Option.none()` until
 * `PaneWorkspace` is built. Provide it with {@link TabRenamerLive}.
 */
export class TabRenamer extends Context.Service<TabRenamer, Ref.Ref<Option.Option<RenameTab>>>()(
  'TabRenamer'
) {}

/** Builds an empty {@link TabRenamer}. Build it once per Host and share it. */
export const TabRenamerLive = Layer.effect(TabRenamer, Ref.make(Option.none<RenameTab>()))
