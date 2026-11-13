import type { QueuedRun } from './queue'

/** A queued entry as {@link pickStarts} sees it: `order` is its enqueue position. */
export interface PickEntry {
  readonly order: number
  readonly entry: QueuedRun
}

/** What one pass of the queue sees: `keyOf` maps each run the queue started to its key id. */
export interface PickInput<Entry extends PickEntry> {
  readonly limit: number
  readonly busy: ReadonlySet<string>
  readonly keyOf: ReadonlyMap<string, string>
  readonly queued: ReadonlyArray<Entry>
}

const byStartOrder = (left: PickEntry, right: PickEntry): number =>
  (right.entry.priority ?? 0) - (left.entry.priority ?? 0) || left.order - right.order

/**
 * The entries one pass starts, in start order: highest priority first, then oldest, while the
 * busy runs plus the picks stay below `limit`. An entry whose key already has `key.limit` busy
 * runs (counting earlier picks of the same pass) is skipped and stays queued. Pure.
 */
export const pickStarts = <Entry extends PickEntry>(
  input: PickInput<Entry>
): ReadonlyArray<Entry> => {
  const perKey = new Map<string, number>()
  for (const runId of input.busy) {
    const key = input.keyOf.get(runId)
    if (key !== undefined) perKey.set(key, (perKey.get(key) ?? 0) + 1)
  }
  const picked: Array<Entry> = []
  for (const candidate of [...input.queued].sort(byStartOrder)) {
    if (input.busy.size + picked.length >= input.limit) break
    const key = candidate.entry.key
    if (key !== undefined) {
      const count = perKey.get(key.id) ?? 0
      if (count >= key.limit) continue
      perKey.set(key.id, count + 1)
    }
    picked.push(candidate)
  }
  return picked
}
