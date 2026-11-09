import { AgentName } from '@dia/plugin'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Duration, Effect, Exit, FileSystem, Layer, Path, Scope, Stream } from 'effect'
import { SqlClient } from 'effect/sql'
import { TestClock } from 'effect/testing'
import { openDatabase } from '../../src/host/services/database'
import { HireId, HireNotFound, type JobTitle, JobTitleId, JobTitleName, OverallCap } from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { holdBuiltInDefinitions } from './registries.fake'
import type { Org } from './service'
import { makeWork } from './work'

const openOrgIn = (filename: string, definitionsFilename = ':memory:') =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const sql = yield* openDatabase(filename, orgMigrations).pipe(Scope.provide(scope))
    const org = yield* makeWork(() => Effect.succeed(true)).pipe(
      Effect.flatMap(({ openIssuesOf }) => makeOrg(openIssuesOf)),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    const definitions = yield* holdBuiltInDefinitions(org, definitionsFilename).pipe(
      Scope.provide(scope)
    )
    return { org, definitions, close: Scope.close(scope, Exit.void) }
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

const workerBuiltIns = (org: Org) =>
  org.jobTitles.pipe(
    Effect.map((jobTitles) =>
      jobTitles.filter((jobTitle) => jobTitle.builtIn !== 'executive-assistant')
    )
  )

describe('Org.watchJobTitleChanges', () => {
  it.effect('emits once after enabling and once after editing a job title', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Executive assistant')
      const changes = yield* org.watchJobTitleChanges

      yield* org.setJobTitleEnabled(jobTitle.id, false)
      yield* org.editJobTitle(jobTitle.id, { thinkingLevel: 'high' })

      assert.strictEqual((yield* Stream.runCollect(Stream.take(changes, 2))).length, 2)
    }).pipe(Effect.scoped)
  )
})

describe('org seed', () => {
  it.effect('lists the eight built-in job titles in seed order, enabled, with their kinds', () =>
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
          ['Technical lead', 'technical-lead', true],
          ['Executive assistant', 'executive-assistant', true]
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
          ['Technical lead', readOnly],
          ['Executive assistant', []]
        ]
      )
    })
  )

  it.effect(
    'gives every worker built-in job title no skills, MCP servers, ask rules or bypass, and allows only the issue tools',
    () =>
      Effect.gen(function* () {
        const org = yield* freshOrg
        for (const jobTitle of yield* workerBuiltIns(org)) {
          assert.deepStrictEqual(
            [
              jobTitle.skills,
              jobTitle.mcpServers,
              jobTitle.permissions.allow,
              jobTitle.permissions.ask,
              jobTitle.bypassOptIn
            ],
            [
              [],
              [],
              ['mcp__dia__create_issue', 'mcp__dia__update_issue', 'mcp__dia__comment_issue'],
              [],
              false
            ],
            jobTitle.name
          )
        }
      })
  )

  it.effect('allows the Executive assistant only the four routing tools', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const assistant = (yield* org.jobTitles).find(
        (jobTitle) => jobTitle.builtIn === 'executive-assistant'
      )
      assert.deepStrictEqual(assistant?.permissions, {
        allow: [
          'mcp__dia__objectives_read',
          'mcp__dia__objective_create',
          'mcp__dia__objective_attach',
          'mcp__dia__objective_stop'
        ],
        ask: [],
        deny: []
      })
    })
  )

  it.effect('appends the execution contract to every worker built-in job description', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      for (const jobTitle of yield* workerBuiltIns(org)) {
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

describe('Org job titles from the agent definition registry', () => {
  it.effect('lists no job titles while no registry is held', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
      const org = yield* makeWork(() => Effect.succeed(true)).pipe(
        Effect.flatMap(({ openIssuesOf }) => makeOrg(openIssuesOf)),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provide(NodeCrypto.layer)
      )
      const held = yield* Scope.make()
      yield* holdBuiltInDefinitions(org).pipe(Scope.provide(held))
      const whileHeld = (yield* org.jobTitles).length
      yield* Scope.close(held, Exit.void)
      assert.deepStrictEqual([whileHeld, (yield* org.jobTitles).length], [8, 0])
    })
  )

  it.effect('lists a user definition after the built-ins, with no built-in kind, enabled', () =>
    Effect.gen(function* () {
      const { org, definitions } = yield* openOrgIn(':memory:')
      const engineer = jobTitleNamed(yield* org.jobTitles, 'Software engineer')
      const { id: _id, ...fields } = engineer
      const added = yield* definitions.create({
        ...fields,
        name: JobTitleName.make('Archivist')
      })
      const listed = (yield* org.jobTitles).at(-1)
      assert.deepStrictEqual([listed?.id, listed?.builtIn, listed?.enabled], [added.id, null, true])
    })
  )

  it.effect('emits a job title change when another plugin changes a definition', () =>
    Effect.gen(function* () {
      const { org, definitions } = yield* openOrgIn(':memory:')
      const engineer = jobTitleNamed(yield* org.jobTitles, 'Software engineer')
      const changes = yield* org.watchJobTitleChanges
      yield* definitions.edit(engineer.id, { thinkingLevel: 'high' })
      assert.strictEqual((yield* Stream.runCollect(Stream.take(changes, 1))).length, 1)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses to delete a definition another plugin contributes', () =>
    Effect.gen(function* () {
      const { org, definitions } = yield* openOrgIn(':memory:')
      const engineer = jobTitleNamed(yield* org.jobTitles, 'Software engineer')
      const contributed = JobTitleId.make('00000000-0000-4000-8000-0000000000c1')
      yield* definitions.register(
        { ...engineer, id: contributed, name: JobTitleName.make('Contributed') },
        'example'
      )
      const error = yield* Effect.flip(org.deleteJobTitle(contributed))
      assert.strictEqual(error._tag, 'BuiltInJobTitleDeleted')
    }).pipe(Effect.scoped)
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
      assert.deepStrictEqual([error._tag, (yield* org.jobTitles).length], ['JobTitleNameTaken', 8])
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
  it.effect('deletes a copy with no hires from the registry', () =>
    Effect.gen(function* () {
      const { org, definitions } = yield* openOrgIn(':memory:')
      const jobTitle = jobTitleNamed(yield* org.jobTitles, 'Software engineer')
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('builder'))
      yield* org.deleteJobTitle(copy.id)
      assert.notInclude(
        (yield* definitions.list).map((listed) => listed.definition.id),
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
      yield* org.hire(copy.id, null, null)
      yield* org.hire(copy.id, null, null)
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
      const hired = yield* org.hire(jobTitle.id, AgentName.make('Ada'), null)
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
      const first = yield* org.hire(jobTitle.id, null, null)
      const second = yield* org.hire(jobTitle.id, null, null)
      const ids = (yield* org.hiredAgents).map((hire) => hire.id)
      assert.deepStrictEqual(ids, [first.id, second.id])
    })
  )

  it.effect('fails with HireNameTaken for a hired name in another case', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* org.hire(jobTitle.id, AgentName.make('Ada'), null)
      const error = yield* Effect.flip(org.hire(jobTitle.id, AgentName.make('ADA'), null))
      assert.strictEqual(error._tag, 'HireNameTaken')
    })
  )

  it.effect('fails with JobTitleNotHireable for the Executive assistant', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Executive assistant')
      const error = yield* Effect.flip(org.hire(jobTitle.id, null, null))
      assert.deepStrictEqual(
        [error._tag, (yield* org.hiredAgents).length],
        ['JobTitleNotHireable', 0]
      )
    })
  )

  it.effect('hires into a copy of the Executive assistant', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Executive assistant')
      const copy = yield* org.copyJobTitle(jobTitle.id, JobTitleName.make('Release assistant'))
      const hired = yield* org.hire(copy.id, null, null)
      assert.strictEqual(hired.jobTitleId, copy.id)
    })
  )

  it.effect('fails with JobTitleDisabled for a disabled job title', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* org.setJobTitleEnabled(jobTitle.id, false)
      const error = yield* Effect.flip(org.hire(jobTitle.id, null, null))
      assert.deepStrictEqual([error._tag, (yield* org.hiredAgents).length], ['JobTitleDisabled', 0])
    })
  )

  it.effect('fails with JobTitleNotFound for an unknown job title', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.hire(UNKNOWN_JOB_TITLE, null, null))
      assert.strictEqual(error._tag, 'JobTitleNotFound')
    })
  )
})

describe('Org.dismiss', () => {
  it.effect('removes the hired agent', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const hired = yield* org.hire(jobTitle.id, null, null)
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

const UNKNOWN_HIRE = HireId.make('00000000-0000-4000-8000-000000000000')

const OTHER_UNKNOWN_HIRE = HireId.make('00000000-0000-4000-8000-000000000001')

const hireChain = Effect.gen(function* () {
  const { org, jobTitle } = yield* builtIn('Software engineer')
  const lead = yield* org.hire(jobTitle.id, AgentName.make('Lead'), null)
  const middle = yield* org.hire(jobTitle.id, AgentName.make('Middle'), lead.id)
  const leaf = yield* org.hire(jobTitle.id, AgentName.make('Leaf'), middle.id)
  return { org, jobTitle, lead, middle, leaf }
})

const reportsToOf = (org: Org, hireId: HireId) =>
  Effect.map(org.hiredAgents, (hires) => hires.find((hire) => hire.id === hireId)?.reportsTo)

describe('Org.setReportsTo', () => {
  it.effect('makes a hired agent report to another hired agent', () =>
    Effect.gen(function* () {
      const { org, lead, leaf } = yield* hireChain
      yield* org.setReportsTo(leaf.id, lead.id)
      assert.strictEqual(yield* reportsToOf(org, leaf.id), lead.id)
    })
  )

  it.effect('makes a hired agent report to the user when reportsTo is null', () =>
    Effect.gen(function* () {
      const { org, middle } = yield* hireChain
      yield* org.setReportsTo(middle.id, null)
      assert.isNull(yield* reportsToOf(org, middle.id))
    })
  )

  it.effect('allows reporting to an agent in another branch', () =>
    Effect.gen(function* () {
      const { org, jobTitle, lead, leaf } = yield* hireChain
      const sibling = yield* org.hire(jobTitle.id, AgentName.make('Sibling'), lead.id)
      yield* org.setReportsTo(leaf.id, sibling.id)
      assert.strictEqual(yield* reportsToOf(org, leaf.id), sibling.id)
    })
  )

  it.effect('fails with ReportsToCycle for an agent reporting to itself', () =>
    Effect.gen(function* () {
      const { org, lead } = yield* hireChain
      const error = yield* Effect.flip(org.setReportsTo(lead.id, lead.id))
      assert.deepStrictEqual(
        [error._tag, error._tag === 'ReportsToCycle' ? error.reportsTo : undefined],
        ['ReportsToCycle', lead.id]
      )
    })
  )

  it.effect(
    'fails with ReportsToCycle for an agent two levels below it, and keeps the old line',
    () =>
      Effect.gen(function* () {
        const { org, lead, leaf } = yield* hireChain
        const error = yield* Effect.flip(org.setReportsTo(lead.id, leaf.id))
        assert.deepStrictEqual(
          [error._tag, yield* reportsToOf(org, lead.id)],
          ['ReportsToCycle', null]
        )
      })
  )

  it.effect('fails with HireNotFound for an unknown hire', () =>
    Effect.gen(function* () {
      const { org, lead } = yield* hireChain
      const error = yield* Effect.flip(org.setReportsTo(UNKNOWN_HIRE, lead.id))
      assert.deepStrictEqual(error, HireNotFound.make({ hireId: UNKNOWN_HIRE }))
    })
  )

  it.effect('fails with HireNotFound naming an unknown reportsTo', () =>
    Effect.gen(function* () {
      const { org, leaf } = yield* hireChain
      const error = yield* Effect.flip(org.setReportsTo(leaf.id, UNKNOWN_HIRE))
      assert.deepStrictEqual(error, HireNotFound.make({ hireId: UNKNOWN_HIRE }))
    })
  )

  it.effect('names the hire, not reportsTo, when both are unknown', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.setReportsTo(UNKNOWN_HIRE, OTHER_UNKNOWN_HIRE))
      assert.deepStrictEqual(error, HireNotFound.make({ hireId: UNKNOWN_HIRE }))
    })
  )
})

describe('Org.hire with a reporting line', () => {
  it.effect('stores the manager the agent reports to', () =>
    Effect.gen(function* () {
      const { org, middle, leaf } = yield* hireChain
      assert.deepStrictEqual(
        [leaf.reportsTo, yield* reportsToOf(org, leaf.id)],
        [middle.id, middle.id]
      )
    })
  )

  it.effect('fails with HireNotFound for an unknown manager and hires nobody', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const error = yield* Effect.flip(org.hire(jobTitle.id, null, UNKNOWN_HIRE))
      assert.deepStrictEqual(
        [error, (yield* org.hiredAgents).length],
        [HireNotFound.make({ hireId: UNKNOWN_HIRE }), 0]
      )
    })
  )
})

describe('Org.dismiss with reports', () => {
  it.effect("moves a mid-chain agent's reports to its own manager", () =>
    Effect.gen(function* () {
      const { org, lead, middle, leaf } = yield* hireChain
      yield* org.dismiss(middle.id)
      assert.strictEqual(yield* reportsToOf(org, leaf.id), lead.id)
    })
  )

  it.effect('moves the reports of an agent that reports to the user to the user', () =>
    Effect.gen(function* () {
      const { org, lead, middle } = yield* hireChain
      yield* org.dismiss(lead.id)
      assert.isNull(yield* reportsToOf(org, middle.id))
    })
  )
})

describe('Org.renameHire', () => {
  it.effect('names a hired agent', () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const hired = yield* org.hire(jobTitle.id, null, null)
      yield* org.renameHire(hired.id, AgentName.make('Ada'))
      const listed = (yield* org.hiredAgents).find((hire) => hire.id === hired.id)
      assert.strictEqual(listed?.name, 'Ada')
    })
  )

  it.effect("clears a hired agent's name when the name is null", () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const hired = yield* org.hire(jobTitle.id, AgentName.make('Ada'), null)
      const renamed = yield* org.renameHire(hired.id, null)
      assert.strictEqual(renamed.name, null)
    })
  )

  it.effect("fails with HireNameTaken for another hire's name in another case", () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      yield* org.hire(jobTitle.id, AgentName.make('Ada'), null)
      const ben = yield* org.hire(jobTitle.id, AgentName.make('Ben'), null)
      const error = yield* Effect.flip(org.renameHire(ben.id, AgentName.make('ADA')))
      assert.strictEqual(error._tag, 'HireNameTaken')
    })
  )

  it.effect("allows recasing the hire's own name", () =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const hired = yield* org.hire(jobTitle.id, AgentName.make('ada'), null)
      const renamed = yield* org.renameHire(hired.id, AgentName.make('Ada'))
      assert.strictEqual(renamed.name, 'Ada')
    })
  )

  it.effect('fails with HireNotFound for an unknown hire', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.renameHire(UNKNOWN_HIRE, null))
      assert.strictEqual(error._tag, 'HireNotFound')
    })
  )
})

describe('Org.setBypassOverride', () => {
  it.effect.each([true, false, null])('stores the override %s', (override) =>
    Effect.gen(function* () {
      const { org, jobTitle } = yield* builtIn('Software engineer')
      const hired = yield* org.hire(jobTitle.id, null, null)
      yield* org.setBypassOverride(hired.id, override)
      const listed = (yield* org.hiredAgents).find((hire) => hire.id === hired.id)
      assert.strictEqual(listed?.bypassOverride, override)
    })
  )

  it.effect('fails with HireNotFound for an unknown hire', () =>
    Effect.gen(function* () {
      const org = yield* freshOrg
      const error = yield* Effect.flip(org.setBypassOverride(UNKNOWN_HIRE, true))
      assert.strictEqual(error._tag, 'HireNotFound')
    })
  )
})

describe('Org changes across a reopen', () => {
  it.effect(
    'keeps an edited job title, a disabled job title, a renamed hire, a reporting line and the overall cap after the org reopens',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const filename = path.join(directory, 'data.db')
        const definitionsFilename = path.join(directory, 'definitions.db')
        const first = yield* openOrgIn(filename, definitionsFilename)
        const engineer = jobTitleNamed(yield* first.org.jobTitles, 'Software engineer')
        yield* first.org.editJobTitle(engineer.id, { jobDescription: 'Write tests first.' })
        const tester = jobTitleNamed(yield* first.org.jobTitles, 'Quality engineer')
        yield* first.org.setJobTitleEnabled(tester.id, false)
        const hired = yield* first.org.hire(engineer.id, null, null)
        yield* first.org.renameHire(hired.id, AgentName.make('Ada'))
        const report = yield* first.org.hire(engineer.id, null, hired.id)
        yield* first.org.setReportsTo(report.id, null)
        yield* first.org.setOverallCap(OverallCap.make(6))
        yield* first.close

        const second = yield* openOrgIn(filename, definitionsFilename)
        const reopened = [
          jobTitleNamed(yield* second.org.jobTitles, 'Software engineer').jobDescription,
          jobTitleNamed(yield* second.org.jobTitles, 'Quality engineer').enabled,
          (yield* second.org.hiredAgents).find((hire) => hire.id === hired.id)?.name,
          (yield* second.org.hiredAgents).find((hire) => hire.id === report.id)?.reportsTo,
          (yield* second.org.settings).overallCap
        ]
        yield* second.close
        assert.deepStrictEqual(reopened, [
          'Write tests first.',
          false,
          'Ada',
          null,
          OverallCap.make(6)
        ])
      }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
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
