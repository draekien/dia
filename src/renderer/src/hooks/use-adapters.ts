import type { AdapterSummaryJson } from '@shared/ipc/contract'
import { useEffect, useState } from 'react'

/**
 * Keeps the registered agent adapters, ordered by label then id, through `window.dia.adapters`.
 * Returns an empty list until the first list arrives and while no adapter is registered. Each
 * caller keeps its own copy.
 */
export function useAdapters(): ReadonlyArray<AdapterSummaryJson> {
  const [adapters, setAdapters] = useState<ReadonlyArray<AdapterSummaryJson>>([])
  useEffect(() => window.dia.adapters.onChanged(setAdapters), [])
  return adapters
}
