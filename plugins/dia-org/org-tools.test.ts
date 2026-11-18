import type { DiaToolResult, ToolScope } from '@dia/plugin'
import type { ApprovalAnswer, ApprovalRequest } from '@dia-plugin/dia-tools/tools'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { AgentName } from '@shared/domain/project'
import { Effect, Exit, Ref, Schema, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { ASSISTANT_LABEL } from './assistant'
import { EXECUTIVE_ASSISTANT } from './built-in-job-titles'
import { HireId, type JobTitle, JobTitleId, JobTitleName } from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeOrgTools } from './org-tools'
import { holdBuiltInDefinitions } from './registries.fake'

const SCOPE: ToolScope = { runId: 'run-assistant', labels: [ASSISTANT_LABEL], context: null }
const MISSING_JOB_TITLE = JobTitleId.make('00000000-0000-4000-8000-000000000999')
const MISSING_HIRE = HireId.make('00000000-0000-4000-8000-000000000998')
const ENGINEER = 'Software engineer'
const PRODUCT_MANAGER = 'Product manager'
const RULES = { allow: ['Bash(git status)'], ask: [], deny: [] }

const setUp = (answer: ApprovalAnswer = 'approved') =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
    const org = yield* makeOrg.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provide(NodeCrypto.layer)
    )
    yield* holdBuiltInDefinitions(org).pipe(Scope.provide(scope))
    yield* org.holdIssues({ countOpenIssues: () => Effect.succeed(0) }).pipe(Scope.provide(scope))
    const asked = yield* Ref.make<ReadonlyArray<ApprovalRequest>>([])
    const tools = makeOrgTools({
      org,
      requestApproval: (_scope, request) =>
        Ref.update(asked, (requests) => [...requests, request]).pipe(Effect.as(answer))
    })
    const run = (name: string, input: unknown): Effect.Effect<DiaToolResult> =>
      Effect.gen(function* () {
        const tool = tools.find((entry) => entry.name === name)
        assert.isDefined(tool, name)
        const decoded = yield* Schema.decodeUnknownEffect(tool.input)(input).pipe(Effect.orDie)
        return yield* tool.run(decoded, SCOPE)
      })
    const jobTitle = (name: string) =>
      Effect.map(org.jobTitles, (jobTitles) => {
        const found = jobTitles.find((entry) => entry.name === name)
        assert.isDefined(found, name)
        return found
      })
    return { org, tools, run, asked: Ref.get(asked), jobTitle }
  })

const fieldsOf = ({ id: _id, builtIn: _builtIn, enabled: _enabled, ...fields }: JobTitle) => fields
const pretty = (value: object) => JSON.stringify(value, null, 2)

describe('makeOrgTools', () => {
  it.effect('offers the eleven org tools', () =>
    Effect.gen(function* () {
      const { tools } = yield* setUp()

      assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), [
        'hire',
        'hire_dismiss',
        'hire_rename',
        'hire_set_reports_to',
        'job_title_copy',
        'job_title_create',
        'job_title_delete',
        'job_title_edit',
        'job_title_set_enabled',
        'org_read',
        'staff_team'
      ])
    }).pipe(Effect.scoped)
  )
})

describe('org_read', () => {
  it.effect('returns every job title and each hire with its stored and display name', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      const lead = yield* org.hire(engineer.id, AgentName.make('Ada'), null)
      const unnamed = yield* org.hire(engineer.id, null, lead.id)

      const read = yield* run('org_read', {})

      const parsed = JSON.parse(read.text)
      assert.deepStrictEqual(
        [read.isError, parsed.jobTitles, parsed.hiredAgents],
        [
          false,
          yield* org.jobTitles,
          [
            {
              id: lead.id,
              name: 'Ada',
              displayName: 'Ada',
              jobTitleId: engineer.id,
              jobTitle: ENGINEER,
              reportsTo: null
            },
            {
              id: unnamed.id,
              name: null,
              displayName: `Unnamed ${ENGINEER}`,
              jobTitleId: engineer.id,
              jobTitle: ENGINEER,
              reportsTo: lead.id
            }
          ]
        ]
      )
    }).pipe(Effect.scoped)
  )
})

describe('hire tools', () => {
  it.effect(
    'hire adds an unnamed hire reporting to the user when name and reportsTo are left out',
    () =>
      Effect.gen(function* () {
        const { org, run, jobTitle } = yield* setUp()
        const engineer = yield* jobTitle(ENGINEER)

        const hired = yield* run('hire', { jobTitleId: engineer.id })

        const hires = yield* org.hiredAgents
        assert.deepStrictEqual(
          [hired.isError, hires.map((hire) => [hire.jobTitleId, hire.name, hire.reportsTo])],
          [false, [[engineer.id, null, null]]]
        )
      }).pipe(Effect.scoped)
  )

  it.effect('hire into the Executive assistant returns the refusal and hires nobody', () =>
    Effect.gen(function* () {
      const { org, run } = yield* setUp()

      const refused = yield* run('hire', { jobTitleId: EXECUTIVE_ASSISTANT.id })

      assert.deepStrictEqual(
        [refused, (yield* org.hiredAgents).length],
        [{ text: 'The Executive assistant job title cannot be hired.', isError: true }, 0]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('staff_team hires a lead and members reporting to the lead', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      const lead = yield* jobTitle('Team lead')

      yield* run('staff_team', { lead: lead.id, members: [engineer.id, engineer.id] })

      const hires = yield* org.hiredAgents
      const leadHire = hires.find((hire) => hire.jobTitleId === lead.id)
      assert.isDefined(leadHire)
      assert.deepStrictEqual(
        hires.filter((hire) => hire.jobTitleId === engineer.id).map((hire) => hire.reportsTo),
        [leadHire.id, leadHire.id]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('staff_team refuses a plan with no lead and no members at decoding', () =>
    Effect.gen(function* () {
      const { tools } = yield* setUp()
      const tool = tools.find((entry) => entry.name === 'staff_team')
      assert.isDefined(tool)

      const decoded = yield* Effect.exit(
        Schema.decodeUnknownEffect(tool.input)({ lead: null, members: [] })
      )

      assert.isTrue(Exit.isFailure(decoded))
    }).pipe(Effect.scoped)
  )

  it.effect('hire_rename with null clears the stored name', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const ada = yield* org.hire((yield* jobTitle(ENGINEER)).id, AgentName.make('Ada'), null)

      yield* run('hire_rename', { hireId: ada.id, name: null })

      assert.deepStrictEqual(
        (yield* org.hiredAgents).map((hire) => hire.name),
        [null]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('hire_rename refuses a name another hire holds, ignoring case', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      yield* org.hire(engineer.id, AgentName.make('Ada'), null)
      const other = yield* org.hire(engineer.id, null, null)

      const refused = yield* run('hire_rename', { hireId: other.id, name: 'ADA' })

      assert.deepStrictEqual(refused, {
        text: 'A hired agent named "ADA" already exists.',
        isError: true
      })
    }).pipe(Effect.scoped)
  )

  it.effect('hire_rename requires name, so leaving it out fails decoding', () =>
    Effect.gen(function* () {
      const { tools } = yield* setUp()
      const tool = tools.find((entry) => entry.name === 'hire_rename')
      assert.isDefined(tool)

      const decoded = yield* Effect.exit(
        Schema.decodeUnknownEffect(tool.input)({ hireId: MISSING_HIRE })
      )

      assert.isTrue(Exit.isFailure(decoded))
    }).pipe(Effect.scoped)
  )

  it.effect('hire_set_reports_to with null makes the hire report to the user', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      const lead = yield* org.hire(engineer.id, null, null)
      const report = yield* org.hire(engineer.id, null, lead.id)

      yield* run('hire_set_reports_to', { hireId: report.id, reportsTo: null })

      const moved = (yield* org.hiredAgents).find((hire) => hire.id === report.id)
      assert.strictEqual(moved?.reportsTo, null)
    }).pipe(Effect.scoped)
  )

  it.effect('hire_set_reports_to refuses a hire reporting to its own report', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      const lead = yield* org.hire(engineer.id, null, null)
      const report = yield* org.hire(engineer.id, null, lead.id)

      const refused = yield* run('hire_set_reports_to', { hireId: lead.id, reportsTo: report.id })

      assert.deepStrictEqual(refused, {
        text: 'That reporting line would make the agent report to itself or to one of its own reports.',
        isError: true
      })
    }).pipe(Effect.scoped)
  )

  it.effect('hire_dismiss removes the hire', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const hire = yield* org.hire((yield* jobTitle(ENGINEER)).id, null, null)

      yield* run('hire_dismiss', { hireId: hire.id })

      assert.deepStrictEqual(yield* org.hiredAgents, [])
    }).pipe(Effect.scoped)
  )

  it.effect('hire_dismiss of a missing hire names its id and tells the agent to read the org', () =>
    Effect.gen(function* () {
      const { run } = yield* setUp()

      const refused = yield* run('hire_dismiss', { hireId: MISSING_HIRE })

      assert.deepStrictEqual(refused, {
        text: `No hired agent has id "${MISSING_HIRE}". Call org_read first and use the ids it returns.`,
        isError: true
      })
    }).pipe(Effect.scoped)
  )
})

describe('job_title_create', () => {
  it.effect('creates an enabled job title with the new job title defaults, without asking', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()

      yield* run('job_title_create', { name: 'Archivist', jobDescription: 'Keeps records.' })

      const archivist = yield* jobTitle('Archivist')
      assert.deepStrictEqual(
        [
          { ...fieldsOf(archivist), enabled: archivist.enabled, builtIn: archivist.builtIn },
          yield* asked
        ],
        [
          {
            name: 'Archivist',
            jobDescription: 'Keeps records.',
            skills: [],
            permissions: { allow: [], ask: [], deny: [] },
            mcpServers: [],
            bypassOptIn: false,
            selection: null,
            thinkingLevel: 'medium',
            enabled: true,
            builtIn: null
          },
          []
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('asks before creating a job title with permission rules, showing its fields', () =>
    Effect.gen(function* () {
      const { run, asked } = yield* setUp()

      yield* run('job_title_create', {
        name: 'Archivist',
        jobDescription: 'Keeps records.',
        permissions: RULES
      })

      assert.deepStrictEqual(yield* asked, [
        {
          title: 'Create job title "Archivist"',
          before: '',
          after: pretty({
            skills: [],
            permissions: RULES,
            mcpServers: [],
            bypassOptIn: false,
            selection: null,
            thinkingLevel: 'medium',
            name: 'Archivist',
            jobDescription: 'Keeps records.'
          })
        }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('asks before creating a job title with the bypass opt-in', () =>
    Effect.gen(function* () {
      const { run, asked } = yield* setUp()

      yield* run('job_title_create', { name: 'Archivist', jobDescription: '', bypassOptIn: true })

      assert.deepStrictEqual(
        (yield* asked).map((request) => request.title),
        ['Create job title "Archivist"']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('creates nothing when the user declines', () =>
    Effect.gen(function* () {
      const { org, run } = yield* setUp('declined')
      const before = (yield* org.jobTitles).length

      const declined = yield* run('job_title_create', {
        name: 'Archivist',
        jobDescription: '',
        permissions: RULES
      })

      assert.deepStrictEqual(
        [declined, (yield* org.jobTitles).length],
        [
          {
            text: 'The user declined "Create job title "Archivist""; nothing changed.',
            isError: true
          },
          before
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a name another job title holds, ignoring case', () =>
    Effect.gen(function* () {
      const { run } = yield* setUp()

      const refused = yield* run('job_title_create', {
        name: 'SOFTWARE ENGINEER',
        jobDescription: ''
      })

      assert.deepStrictEqual(refused, {
        text: 'A job title named "SOFTWARE ENGINEER" already exists.',
        isError: true
      })
    }).pipe(Effect.scoped)
  )
})

describe('job_title_edit', () => {
  it.effect('applies a plain edit of a worker job title without asking', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)

      yield* run('job_title_edit', { jobTitleId: engineer.id, jobDescription: 'Writes Rust.' })

      assert.deepStrictEqual(
        [(yield* jobTitle(ENGINEER)).jobDescription, (yield* asked).length],
        ['Writes Rust.', 0]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('asks before setting empty rules on a job title that has deny rules', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const manager = yield* jobTitle(PRODUCT_MANAGER)

      yield* run('job_title_edit', {
        jobTitleId: manager.id,
        permissions: { allow: [], ask: [], deny: [] }
      })

      assert.deepStrictEqual(
        (yield* asked).map((request) => request.title),
        [`Edit job title "${PRODUCT_MANAGER}"`]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('does not ask for an edit that sets the permission rules a job title already has', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const manager = yield* jobTitle(PRODUCT_MANAGER)

      yield* run('job_title_edit', { jobTitleId: manager.id, permissions: manager.permissions })

      assert.deepStrictEqual(yield* asked, [])
    }).pipe(Effect.scoped)
  )

  it.effect('asks before turning off the bypass opt-in', () =>
    Effect.gen(function* () {
      const { org, run, asked, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      yield* org.editJobTitle(engineer.id, { bypassOptIn: true })

      yield* run('job_title_edit', { jobTitleId: engineer.id, bypassOptIn: false })

      assert.deepStrictEqual(
        (yield* asked).map((request) => request.title),
        [`Edit job title "${ENGINEER}"`]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('asks before setting permission rules, showing the fields before and after', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)

      yield* run('job_title_edit', { jobTitleId: engineer.id, permissions: RULES })

      assert.deepStrictEqual(yield* asked, [
        {
          title: `Edit job title "${ENGINEER}"`,
          before: pretty(fieldsOf(engineer)),
          after: pretty({ ...fieldsOf(engineer), permissions: RULES })
        }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('applies the permission rules once the user approves', () =>
    Effect.gen(function* () {
      const { run, jobTitle } = yield* setUp('approved')
      const engineer = yield* jobTitle(ENGINEER)

      yield* run('job_title_edit', { jobTitleId: engineer.id, permissions: RULES })

      assert.deepStrictEqual((yield* jobTitle(ENGINEER)).permissions, RULES)
    }).pipe(Effect.scoped)
  )

  it.effect('leaves the job title unchanged when the user declines', () =>
    Effect.gen(function* () {
      const { run, jobTitle } = yield* setUp('declined')
      const engineer = yield* jobTitle(ENGINEER)

      const declined = yield* run('job_title_edit', {
        jobTitleId: engineer.id,
        permissions: RULES,
        jobDescription: 'Writes Rust.'
      })

      assert.deepStrictEqual([declined.isError, yield* jobTitle(ENGINEER)], [true, engineer])
    }).pipe(Effect.scoped)
  )

  it.effect('asks before turning on the bypass opt-in', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)

      yield* run('job_title_edit', { jobTitleId: engineer.id, bypassOptIn: true })

      assert.deepStrictEqual(
        (yield* asked).map((request) => request.title),
        [`Edit job title "${ENGINEER}"`]
      )
    }).pipe(Effect.scoped)
  )

  it.effect("asks before any edit of the Executive assistant's job description", () =>
    Effect.gen(function* () {
      const { run, asked } = yield* setUp()

      yield* run('job_title_edit', {
        jobTitleId: EXECUTIVE_ASSISTANT.id,
        jobDescription: 'Route everything to Ada.'
      })

      assert.deepStrictEqual(
        (yield* asked).map((request) => request.title),
        ['Edit job title "Executive assistant"']
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a missing job title without asking', () =>
    Effect.gen(function* () {
      const { run, asked } = yield* setUp()

      const refused = yield* run('job_title_edit', {
        jobTitleId: MISSING_JOB_TITLE,
        permissions: RULES
      })

      assert.deepStrictEqual(
        [refused, yield* asked],
        [
          {
            text: `No job title has id "${MISSING_JOB_TITLE}". Call org_read first and use the ids it returns.`,
            isError: true
          },
          []
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses renaming a built-in job title', () =>
    Effect.gen(function* () {
      const { run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)

      const refused = yield* run('job_title_edit', { jobTitleId: engineer.id, name: 'Coder' })

      assert.deepStrictEqual(refused, {
        text: 'A built-in job title cannot be renamed; copy it under a new name instead.',
        isError: true
      })
    }).pipe(Effect.scoped)
  )
})

describe('job_title_copy, job_title_set_enabled and job_title_delete', () => {
  it.effect('job_title_copy adds an enabled copy with the new name and the same fields', () =>
    Effect.gen(function* () {
      const { run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)

      yield* run('job_title_copy', { jobTitleId: engineer.id, name: 'Rust engineer' })

      const copy = yield* jobTitle('Rust engineer')
      assert.deepStrictEqual(
        [fieldsOf(copy), copy.enabled, copy.builtIn],
        [{ ...fieldsOf(engineer), name: 'Rust engineer' }, true, null]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('job_title_set_enabled disables a worker job title without asking', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)

      yield* run('job_title_set_enabled', { jobTitleId: engineer.id, enabled: false })

      assert.deepStrictEqual([(yield* jobTitle(ENGINEER)).enabled, yield* asked], [false, []])
    }).pipe(Effect.scoped)
  )

  it.effect('job_title_set_enabled asks before disabling the Executive assistant', () =>
    Effect.gen(function* () {
      const { run, asked, jobTitle } = yield* setUp()
      const assistant = yield* jobTitle(EXECUTIVE_ASSISTANT.name)

      yield* run('job_title_set_enabled', { jobTitleId: assistant.id, enabled: false })

      const before = { ...fieldsOf(assistant), enabled: true }
      assert.deepStrictEqual(yield* asked, [
        {
          title: 'Disable job title "Executive assistant"',
          before: pretty(before),
          after: pretty({ ...before, enabled: false })
        }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('job_title_set_enabled keeps the Executive assistant enabled when declined', () =>
    Effect.gen(function* () {
      const { run, jobTitle } = yield* setUp('declined')

      yield* run('job_title_set_enabled', { jobTitleId: EXECUTIVE_ASSISTANT.id, enabled: false })

      assert.isTrue((yield* jobTitle(EXECUTIVE_ASSISTANT.name)).enabled)
    }).pipe(Effect.scoped)
  )

  it.effect('job_title_delete removes a copy', () =>
    Effect.gen(function* () {
      const { org, run, jobTitle } = yield* setUp()
      const engineer = yield* jobTitle(ENGINEER)
      const copy = yield* org.copyJobTitle(engineer.id, JobTitleName.make('Rust engineer'))

      yield* run('job_title_delete', { jobTitleId: copy.id })

      assert.isUndefined((yield* org.jobTitles).find((entry) => entry.id === copy.id))
    }).pipe(Effect.scoped)
  )

  it.effect('job_title_delete refuses a copy with hires', () =>
    Effect.gen(function* () {
      const { org, run } = yield* setUp()
      yield* run('job_title_create', { name: 'Archivist', jobDescription: '' })
      const archivist = (yield* org.jobTitles).find((entry) => entry.name === 'Archivist')
      assert.isDefined(archivist)
      yield* org.hire(archivist.id, null, null)

      const refused = yield* run('job_title_delete', { jobTitleId: archivist.id })

      assert.deepStrictEqual(refused, {
        text: 'The job title has 1 hired agents; dismiss them first.',
        isError: true
      })
    }).pipe(Effect.scoped)
  )

  it.effect('job_title_delete of the Executive assistant is refused without asking', () =>
    Effect.gen(function* () {
      const { run, asked } = yield* setUp()

      const refused = yield* run('job_title_delete', { jobTitleId: EXECUTIVE_ASSISTANT.id })

      assert.deepStrictEqual(
        [refused, yield* asked],
        [
          {
            text: 'A built-in job title cannot be deleted; disable it instead.',
            isError: true
          },
          []
        ]
      )
    }).pipe(Effect.scoped)
  )
})
