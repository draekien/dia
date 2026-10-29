import type { ModelCatalogSnapshotJson } from '@shared/ipc/contract'

/**
 * The model in `state` whose `value` is `value`, or `undefined` while no list is loaded or when
 * the list does not include it.
 */
export const findModelOption = (
  state: ModelCatalogSnapshotJson['state'] | undefined,
  value: string | undefined
) => (state?._tag === 'Ready' ? state.models.find((option) => option.value === value) : undefined)
