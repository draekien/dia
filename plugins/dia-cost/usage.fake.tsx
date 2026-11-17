import { Option, Stream } from 'effect'
import { Atom } from 'effect/reactivity'
import type { RunUsage } from './calls'
import type { UsageAtoms } from './usage-card'

/** A run id to pass as `runId` to the usage components under test. */
export const RUN = 'aaaaaaaa-0000-4000-8000-000000000001'

/** Usage atoms that report `usage` for every run id, for rendering the usage components in tests. */
export const followed = (usage: RunUsage) =>
  Atom.family((_runId: string) =>
    Atom.make(Stream.make(Option.some(usage)))
  ) as unknown as UsageAtoms
