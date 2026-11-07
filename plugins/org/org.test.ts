import { AgentName } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Exit, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import { HireId, type JobTitle, JobTitleId, JobTitleName, OverallCap } from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'

const openOrgIn = (filename: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const sql = yield* openDatabase(filename, orgMigrations).pipe(Scope.provide(scope))
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    return { org, close: Scope.close(scope, Exit.void) }
  })

const freshOrg = Effect.map(openOrgIn(':memory:'), ({ org }) => org)

const jobTitleNamed = (jobTitles: ReadonlyArray<JobTitle>, name: string): JobTitle => {
  const jobTitle = jobTitles.find((candidate) => candidate.name === name)
  assert.isDefined(jobTitle, `no job title named ${name}`)
  return jobTitle as JobTitle
}

const builtIn = (name: string) =>
  Effect.gen(function* () {
    const org = yield* freshOrg
    return { org, jobTitle: jobTitleNamed(yield* org.jobTitles, name) }
  })

const UNKNOWN_JOB_TITLE = JobTitleId.make('00000000-0000-4000-8000-000000000000')

describe('org seed', () => {
  it.effect('lists the seven built-in job titles in seed order, enabled, with their kinds', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const jobTitles = yield* org.jobTitles
      assert.deepStrictEqual(
        jobTitles.map((jobTitle): [string, string | null, boolean] => [
          jobTitle.name,
          jobTitle.builtIn,
          jobTitle.enabled
        ]),
        [
          ['Product manager', 'product-manager', true],
          ['Software engineer', 'software-engineer', true],
          ['Quality engineer', 'quality-engineer', true],
          ['Business analyst', 'business-analyst', true],
          ['UI/UX designer', 'ui-ux', true],
          ['Team lead', 'team-lead', true],
          ['Technical lead', 'technical-lead', true]
        ]
      )
    })
  )

  it.effect('denies file edits to the four job titles that do not change files', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const jobTitles = yield* org.jobTitles
      const readOnly = ['Edit', 'Write', 'NotebookEdit']
      assert.deepStrictEqual(
        jobTitles.map((jobTitle): [string, ReadonlyArray<string>] => [
          jobTitle.name,
          jobTitle.permissions.deny
        ]),
        [
          ['Product manager', readOnly],
          ['Software engineer', []],
          ['Quality engineer', []],
          ['Business analyst', readOnly],
          ['UI/UX designer', []],
          ['Team lead', readOnly],
          ['Technical lead', readOnly]
        ]
      )
    })
  )

  it.effect(
    'gives every built-in job title no skills, MCP servers, allow or ask rules, or bypass',
    () =>
      Effect.gen(function* () {
        const org = yield* freshOrg
        for (const jobTitle of yield* org.jobTitles) {
          assert.deepStrictEqual(
            [
              jobTitle.skills,
              jobTitle.mcpServers,
              jobTitle.permissions.allow,
              jobTitle.permissions.ask,
              jobTitle.bypassOptIn
            ],
            [[], {}, [], [], false],
            jobTitle.name
          )
        }
      })
  )

  it.effect('appends the execution contract to every built-in job description', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      for (const jobTitle of yield* org.jobTitles) {
        assert.include(jobTitle.jobDescription, '## Execution contract', jobTitle.name)
      }
    })
  )

  it.effect('hires nobody', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      assert.deepStrictEqual(yield* org.hiredAgents, [])
    })
  )

  it.effect('starts with an overall cap of 4', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      assert.strictEqual((yield* org.settings).overallCap, 4)
    })
  )
})

describe('Org.setJobTitleEnabled', () => {
  it.effect('disables a job title and lists it disabled', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Quality engineer')
      const changed = yield* org.setJobTitleEnabled(jobTitle.id, false)
      assert.isFalse(changed.enabled)
      assert.isFalse(jobTitleNamed(yield* org.jobTitles, 'Quality engineer').enabled)
    })
  )

  it.effect('fails with JobTitleNotFound for an unknown job title', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.setJobTitleEnabled(UNKNOWN_JOB_TITLE, false))
      assert.strictEqual(error._tag, 'JobTitleNotFound')
    })
  )
})

describe('Org.copyJobTitle', () => {
  it.effect('copies every field except id, name and builtIn, and lists the copy last', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Quality engineer')
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('strict reviewer'))
      assert.notStrictEqual(copy.id, jobTitle.id)
      assert.deepStrictEqual(copy, {
        ...jobTitle,
        id: copy.id,
        name: JobTitleName.make('strict reviewer'),
        builtIn: null
      })
      const jobTitles = yield* org.jobTitles
      assert.deepStrictEqual(jobTitles.at(-1), copy)
    })
  )

  it.effect('makes the copy of a disabled job title enabled', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Quality engineer')
      yield* org.setJobTitleEnabled(jobTitle.id, false)
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('strict reviewer'))
      assert.isTrue(copy.enabled)
    })
  )

  it.effect('fails with JobTitleNameTaken for an existing name in another case', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Quality engineer')
      const error = yield* Effect.flip(
        org.copyJobTitle(jobTitle.id, JobTitleName.make('SOFTWARE ENGINEER'))
      )
      assert.deepStrictEqual([error._tag, (yield* org.jobTitles).length], ['JobTitleNameTaken', 7])
    })
  )

  it.effect('fails with JobTitleNotFound for an unknown job title', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(
        org.copyJobTitle(UNKNOWN_JOB_TITLE, JobTitleName.make('ghost'))
      )
      assert.strictEqual(error._tag, 'JobTitleNotFound')
    })
  )
})

describe('Org.editJobTitle', () => {
  it.effect('applies the present fields and keeps the absent ones', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const permissions = { allow: ['Bash(pnpm test)'], ask: ['Bash(git push:*)'], deny: [] }
      const edited = yield* org.editJobTitle(jobTitle.id, { permissions, skills: ['tdd'] })
      assert.deepStrictEqual(edited, { ...jobTitle, permissions, skills: ['tdd'] })
      assert.deepStrictEqual(jobTitleNamed(yield* org.jobTitles, 'Software engineer'), edited)
    })
  )

  it.effect(
    'keeps the id, builtIn and enabled of the job title when the edit is a whole job title',
    () =>
      Effect.gen(function* () {
        const { org, jobTitle: productManager } = yield* builtIn('Product manager')
        yield* org.setJobTitleEnabled(productManager.id, false)
        const copy = yield* org.copyJobTitle(productManager.id, JobTitleName.make('builder'))
        const disabledProductManager = jobTitleNamed(yield* org.jobTitles, 'Product manager')
        const edited = yield* org.editJobTitle(copy.id, {
          ...disabledProductManager,
          name: copy.name
        })
        assert.deepStrictEqual([edited.id, edited.builtIn, edited.enabled], [copy.id, null, true])
        assert.deepStrictEqual(jobTitleNamed(yield* org.jobTitles, 'builder'), edited)
      })
  )

  it.effect('refuses to rename a built-in job title', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const error = yield* Effect.flip(
        org.editJobTitle(jobTitle.id, { name: JobTitleName.make('builder') })
      )
      assert.strictEqual(error._tag, 'BuiltInJobTitleRenamed')
    })
  )

  it.effect('accepts a built-in job title edit that repeats its current name', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const edited = yield* org.editJobTitle(jobTitle.id, {
        name: jobTitle.name,
        bypassOptIn: true
      })
      assert.isTrue(edited.bypassOptIn)
    })
  )

  it.effect('lets a copy change the case of its own name', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('builder'))
      const edited = yield* org.editJobTitle(copy.id, { name: JobTitleName.make('Builder') })
      assert.strictEqual(edited.name, 'Builder')
    })
  )

  it.effect(
    "fails with JobTitleNameTaken when a copy takes another job title's name in another case",
    () =>
      Effect.gen(function* () {
        const { org, jobTitle } = yield* builtIn('Software engineer')
        const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('builder'))
        const error = yield* Effect.flip(
          org.editJobTitle(copy.id, { name: JobTitleName.make('TEAM LEAD') })
        )
        assert.strictEqual(error._tag, 'JobTitleNameTaken')
      })
  )
})

describe('Org.deleteJobTitle', () => {
  it.effect('deletes a copy with no hires', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('builder'))
      yield* org.deleteJobTitle(copy.id)
      assert.notInclude(
        (yield* org.jobTitles).map((listed) => listed.id),
        copy.id
      )
    })
  )

  it.effect('refuses to delete a built-in job title', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Product manager')
      const error = yield* Effect.flip(org.deleteJobTitle(jobTitle.id))
      assert.strictEqual(error._tag, 'BuiltInJobTitleDeleted')
    })
  )

  it.effect('refuses to delete a copy with hires and reports how many', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('builder'))
      yield* org.hire(copy.id, null)
      yield* org.hire(copy.id, null)
      const error = yield* Effect.flip(org.deleteJobTitle(copy.id))
      assert.deepStrictEqual(
        [error._tag, error._tag === 'JobTitleHasHires' ? error.hires : undefined],
        ['JobTitleHasHires', 2]
      )
    })
  )
})

describe('Org.hire', () => {
  it.effect('hires a named agent at the current time', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* TestClock.adjust(Duration.seconds(5))
      const hired = yield* org.hire(jobTitle.id, AgentName.make('Ada'))
      assert.deepStrictEqual(
        [hired.jobTitleId, hired.name, hired.bypassOverride, hired.hiredAt],
        [jobTitle.id, 'Ada', null, Duration.toMillis(Duration.seconds(5))]
      )
    })
  )

  it.effect('lists hires by hire time, then by creation order', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* TestClock.adjust(Duration.seconds(1))
      const first = yield* org.hire(jobTitle.id, null)
      const second = yield* org.hire(jobTitle.id, null)
      const ids = (yield* org.hiredAgents).map((hire) => hire.id)
      assert.deepStrictEqual(ids, [first.id, second.id])
    })
  )

  it.effect('fails with HireNameTaken for a hired name in another case', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* org.hire(jobTitle.id, AgentName.make('Ada'))
      const error = yield* Effect.flip(org.hire(jobTitle.id, AgentName.make('ADA')))
      assert.strictEqual(error._tag, 'HireNameTaken')
    })
  )

  it.effect('fails with JobTitleDisabled for a disabled job title', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* org.setJobTitleEnabled(jobTitle.id, false)
      const error = yield* Effect.flip(org.hire(jobTitle.id, null))
      assert.deepStrictEqual([error._tag, (yield* org.hiredAgents).length], ['JobTitleDisabled', 0])
    })
  )

  it.effect('fails with JobTitleNotFound for an unknown job title', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.hire(UNKNOWN_JOB_TITLE, null))
      assert.strictEqual(error._tag, 'JobTitleNotFound')
    })
  )
})

describe('Org.dismiss', () => {
  it.effect('removes the hired agent', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const hired = yield* org.hire(jobTitle.id, null)
      yield* org.dismiss(hired.id)
      assert.notInclude(
        (yield* org.hiredAgents).map((hire) => hire.id),
        hired.id
      )
    })
  )

  it.effect('fails with HireNotFound for an unknown hire', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(
        org.dismiss(HireId.make('00000000-0000-4000-8000-000000000000'))
      )
      assert.strictEqual(error._tag, 'HireNotFound')
    })
  )
})

describe('Org.setOverallCap', () => {
  it.effect('stores the new cap', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      yield* org.setOverallCap(OverallCap.make(7))
      assert.strictEqual((yield* org.settings).overallCap, 7)
    })
  )
})
