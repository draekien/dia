import { Option } from 'effect'
import type { BuiltInJobTitle, JobTitle, JobTitleId, TeamPlan } from './domain'

/** A built-in team shape: a label, a lead of a built-in job title or none, and its members. */
export interface TeamPreset {
  readonly id: string
  readonly label: string
  readonly lead: BuiltInJobTitle | null
  readonly members: ReadonlyArray<BuiltInJobTitle>
}

/** The built-in team shapes the Staff the org dialog offers, in display order. */
export const TEAM_PRESETS: ReadonlyArray<TeamPreset> = [
  {
    id: 'feature-team',
    label: 'Feature team',
    lead: 'team-lead',
    members: ['software-engineer', 'software-engineer', 'quality-engineer']
  },
  {
    id: 'product-team',
    label: 'Product team',
    lead: 'product-manager',
    members: ['ui-ux', 'software-engineer']
  },
  { id: 'solo-engineer', label: 'Solo engineer', lead: null, members: ['software-engineer'] }
]

const enabledIdOf = (
  kind: BuiltInJobTitle,
  jobTitles: ReadonlyArray<JobTitle>
): Option.Option<JobTitleId> =>
  Option.fromNullishOr(
    jobTitles.find((jobTitle) => jobTitle.builtIn === kind && jobTitle.enabled)?.id
  )

/**
 * `preset` as a {@link TeamPlan} over `jobTitles`: each built-in kind becomes the id of the enabled
 * job title with that `builtIn`. None when any kind the preset names has no enabled job title.
 */
export const planOf = (
  preset: TeamPreset,
  jobTitles: ReadonlyArray<JobTitle>
): Option.Option<TeamPlan> =>
  Option.all({
    lead:
      preset.lead === null
        ? Option.some(null)
        : Option.map(enabledIdOf(preset.lead, jobTitles), (id): JobTitleId | null => id),
    members: Option.all(preset.members.map((kind) => enabledIdOf(kind, jobTitles)))
  })
