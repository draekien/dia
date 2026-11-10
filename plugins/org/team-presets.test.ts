import { Option } from 'effect'
import { describe, expect, it } from 'vitest'
import { JOB_TITLES, jobTitleNamed } from './org-host.fake'
import { planOf, TEAM_PRESETS } from './team-presets'

const preset = (id: string) => {
  const found = TEAM_PRESETS.find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no preset ${id}`)
  return found
}

const disabling = (name: string) =>
  JOB_TITLES.map((jobTitle) =>
    jobTitle.name === name ? { ...jobTitle, enabled: false } : jobTitle
  )

describe('planOf', () => {
  it('maps each built-in kind to the id of its enabled job title', () => {
    expect(planOf(preset('feature-team'), JOB_TITLES)).toEqual(
      Option.some({
        lead: jobTitleNamed('Team lead').id,
        members: [
          jobTitleNamed('Software engineer').id,
          jobTitleNamed('Software engineer').id,
          jobTitleNamed('Quality engineer').id
        ]
      })
    )
  })

  it('keeps a null lead for a preset with no lead', () => {
    expect(planOf(preset('solo-engineer'), JOB_TITLES)).toEqual(
      Option.some({ lead: null, members: [jobTitleNamed('Software engineer').id] })
    )
  })

  it('returns none when the lead job title is disabled', () => {
    expect(planOf(preset('feature-team'), disabling('Team lead'))).toEqual(Option.none())
  })

  it('returns none when a member job title is disabled', () => {
    expect(planOf(preset('feature-team'), disabling('Quality engineer'))).toEqual(Option.none())
  })

  it('ignores a copy that is not the built-in job title', () => {
    const copyOnly = disabling('Software engineer').concat({
      ...jobTitleNamed('Software engineer'),
      builtIn: null,
      enabled: true
    })
    expect(planOf(preset('solo-engineer'), copyOnly)).toEqual(Option.none())
  })
})
