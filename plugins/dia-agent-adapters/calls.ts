import {
  AdapterStatusSnapshot,
  AttachmentType,
  ModelCatalogSnapshot,
  PermissionMode
} from '@dia/plugin'
import { Schema } from 'effect'
import { Rpc } from 'effect/rpc'

/**
 * The adapter that answers a call below: the id of a registered adapter, which is the adapter
 * plugin's name. An id that is not registered is answered as an adapter that is not loaded.
 */
const adapter = Schema.NonEmptyString

/** One registered adapter as the renderer sees it: `id` is the plugin's name, `label` its display name. */
export const AdapterSummary = Schema.Struct({ id: Schema.String, label: Schema.String })
/** One registered adapter as the renderer sees it; see {@link AdapterSummary}. */
export type AdapterSummary = typeof AdapterSummary.Type

/** The registered adapters, ordered by label then id: the list now and after each change. */
export const FollowAdapters = Rpc.make('FollowAdapters', {
  payload: {},
  success: Schema.Array(AdapterSummary),
  stream: true
})

/** The model list of adapter `adapter`. */
export const GetModels = Rpc.make('GetModels', {
  payload: { adapter },
  success: ModelCatalogSnapshot
})

/** Re-reads the model list of adapter `adapter`; completes when the read ends. */
export const RefreshModels = Rpc.make('RefreshModels', { payload: { adapter } })

/** The model list of adapter `adapter` now and after each change. */
export const FollowModels = Rpc.make('FollowModels', {
  payload: { adapter },
  success: ModelCatalogSnapshot,
  stream: true
})

/** The install status of adapter `adapter`. */
export const GetAdapterStatus = Rpc.make('GetAdapterStatus', {
  payload: { adapter },
  success: AdapterStatusSnapshot
})

/** Re-checks the install of adapter `adapter`; completes when the check ends. */
export const CheckAdapterHealth = Rpc.make('CheckAdapterHealth', { payload: { adapter } })

/** Stores (or clears, with null) where adapter `adapter` finds its install, then re-checks it. */
export const SetInstallPath = Rpc.make('SetInstallPath', {
  payload: { adapter, path: Schema.NullOr(Schema.NonEmptyString) }
})

/** The install status of adapter `adapter` now and after each change. */
export const FollowAdapterStatus = Rpc.make('FollowAdapterStatus', {
  payload: { adapter },
  success: AdapterStatusSnapshot,
  stream: true
})

/** The permission modes the settings of adapter `adapter` turn off for a session started in `cwd`. */
export const GetDisabledPermissionModes = Rpc.make('GetDisabledPermissionModes', {
  payload: { adapter, cwd: Schema.String },
  success: Schema.Array(PermissionMode)
})

/** The file types a session of adapter `adapter` accepts as content blocks. */
export const GetAttachmentTypes = Rpc.make('GetAttachmentTypes', {
  payload: { adapter },
  success: Schema.Array(AttachmentType)
})
