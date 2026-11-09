import { ProjectId } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { AgentName } from '@shared/domain/project'
import { Effect, Exit, Ref, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { type IssueId, ObjectiveId, PlanRoute, WorkTitle } from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { holdBuiltInDefinitions } from './registries.fake'
import { makeRoutingTools } from './routing-tools'
import { makeWork } from './work'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')
const EXISTING = ObjectiveId.make('00000000-0000-4000-8000-500000000001')
const NEW_ID = ObjectiveId.make('00000000-0000-4000-8000-500000000002')

const setUp = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
  const { work, runs, org } = yield* Effect.gen(function* () {
    const made = yield* makeWork(() => Effect.succeed(true))
    return { ...made, org: yield* makeOrg(made.openIssuesOf) }
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
  yield* holdBuiltInDefinitions(org).pipe(Scope.provide(scope))
  const engineer = (yield* org.jobTitles)[1]
  assert.isDefined(engineer)
  const ada = yield* org.hire(engineer.id, AgentName.make('Ada'), null)
  const claimed = yield* Ref.make<ReadonlyArray<ObjectiveId>>([])
  const messaged = yield* Ref.make<ReadonlyArray<string>>([])
  const released = yield* Ref.make<ReadonlyArray<IssueId>>([])
  const live = new Set<IssueId>()
  const tools = makeRoutingTools({
    work,
    projects: Effect.succeed([{ id: PROJECT, name: 'fixture' }]),
    hires: Effect.succeed([{ id: ada.id, name: 'Ada', jobTitle: engineer.name }]),
    newObjectiveId: Effect.succeed(NEW_ID),
    claim: (objectiveId) => Ref.update(claimed, (ids) => [...ids, objectiveId]),
    dispatcher: {
      signal: Effect.void,
      message: (issueId, text) =>
        live.has(issueId)
          ? Ref.update(messaged, (texts) => [...texts, `${issueId}:${text}`]).pipe(Effect.as(true))
          : Effect.succeed(false),
      release: (issueId) => Ref.update(released, (ids) => [...ids, issueId])
    }
  })
  const run = (name: string, input: Record<string, string>) => {
    const tool = tools.find((entry) => entry.name === name)
    assert.isDefined(tool, name)
    return tool.run(input)
  }
  return { work, runs, ada, run, claimed, messaged, released, live }
})

const withExisting = Effect.gen(function* () {
  const env = yield* setUp
  yield* env.work.createObjective({
    id: EXISTING,
    projectId: PROJECT,
    title: WorkTitle.make('Ship the marketplace'),
    description: 'Let users install plugins.',
    priority: 'normal',
    route: PlanRoute.make({ assignee: env.ada.id })
  })
  const [planning] = (yield* env.work.snapshot).issues
  assert.isDefined(planning)
  assert.isTrue(yield* env.runs.markStarted(planning.id, env.ada.id))
  return { ...env, planning }
})

describe('objectives_read', () => {
  it.effect('lists the projects, the hired agents and each open objective with its issues', () =>
    Effect.gen(function* () {
      const env = yield* withExisting
      const read = yield* env.run('objectives_read', {})
      assert.deepStrictEqual(read, {
        text: [
          'Projects:',
          `- ${PROJECT} fixture`,
          'Hired agents:',
          `- ${env.ada.id} Ada (Software engineer)`,
          'Open objectives:',
          `- ${EXISTING} "Ship the marketplace" in fixture, normal priority`,
          '  - planning issue "Plan: Ship the marketplace": understanding, assigned to Ada'
        ].join('\n'),
        isError: false
      })
    }).pipe(Effect.scoped)
  )
})

describe('objective_create', () => {
  const direct = {
    project: 'fixture',
    title: 'Fix the typo in the README',
    request: 'fix the typo in the README, give it to Ada',
    route: 'direct',
    assignee: 'ada'
  }

  it.effect(
    "creates a direct objective with the user's words and the note, claiming it first",
    () =>
      Effect.gen(function* () {
        const env = yield* setUp
        const created = yield* env.run('objective_create', {
          ...direct,
          note: 'the user wants this before the release'
        })
        const snapshot = yield* env.work.snapshot
        assert.deepStrictEqual(
          [
            created.isError,
            yield* Ref.get(env.claimed),
            snapshot.objectives.map((objective) => objective.description),
            snapshot.issues.map((issue) => [issue.kind, issue.assignee])
          ],
          [
            false,
            [NEW_ID],
            [
              'fix the typo in the README, give it to Ada\n\nRouting note: the user wants this before the release'
            ],
            [['work', env.ada.id]]
          ]
        )
      }).pipe(Effect.scoped)
  )

  it.effect('creates a plan objective with an unassigned planning issue', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.run('objective_create', {
        project: PROJECT,
        title: 'Ship the plugin marketplace',
        request: 'ship the plugin marketplace',
        route: 'plan'
      })
      assert.deepStrictEqual(
        (yield* env.work.snapshot).issues.map((issue) => [issue.kind, issue.assignee]),
        [['planning', null]]
      )
    }).pipe(Effect.scoped)
  )

  const refusals: ReadonlyArray<readonly [string, Record<string, string>, string]> = [
    [
      'direct without an assignee',
      { ...direct, assignee: '' },
      'Route direct needs an assignee: a hired agent.'
    ],
    [
      'plan with an assignee',
      { ...direct, route: 'plan' },
      'Route plan takes no assignee: its planning issue waits for the user to assign it.'
    ],
    ['an unknown route', { ...direct, route: 'later' }, 'Invalid route: use direct or plan.'],
    ['an unknown agent', { ...direct, assignee: 'Grace' }, 'No hired agent is called "Grace".'],
    [
      'an unknown project',
      { ...direct, project: 'elsewhere' },
      'No registered project is called "elsewhere".'
    ],
    [
      'a 31-word note',
      { ...direct, note: Array.from({ length: 31 }, () => 'word').join(' ') },
      'The routing note has 31 words; keep it to 30 or fewer.'
    ]
  ]

  for (const [label, input, message] of refusals) {
    it.effect(`refuses ${label} and creates nothing`, () =>
      Effect.gen(function* () {
        const env = yield* setUp
        const refused = yield* env.run('objective_create', input)
        assert.deepStrictEqual(
          [refused, (yield* env.work.snapshot).objectives.length],
          [{ text: message, isError: true }, 0]
        )
      }).pipe(Effect.scoped)
    )
  }
})

describe('objective_attach', () => {
  it.effect("queues the message on each running issue's session and counts the deliveries", () =>
    Effect.gen(function* () {
      const env = yield* withExisting
      env.live.add(env.planning.id)
      const attached = yield* env.run('objective_attach', {
        objective: EXISTING,
        message: 'use the staging bucket'
      })
      assert.deepStrictEqual(
        [attached.text, yield* Ref.get(env.messaged)],
        ['Delivered to 1 running session.', [`${env.planning.id}:use the staging bucket`]]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('says no agent is working when no issue has a live session', () =>
    Effect.gen(function* () {
      const env = yield* withExisting
      const attached = yield* env.run('objective_attach', { objective: EXISTING, message: 'hi' })
      assert.deepStrictEqual(attached, {
        text: 'No agent is working on this objective now.',
        isError: false
      })
    }).pipe(Effect.scoped)
  )
})

describe('objective_stop', () => {
  it.effect('cancels the open issues and releases each one', () =>
    Effect.gen(function* () {
      const env = yield* withExisting
      const stopped = yield* env.run('objective_stop', { objective: EXISTING })
      assert.deepStrictEqual(
        [stopped.text, yield* Ref.get(env.released)],
        [
          'Stopped "Ship the marketplace": canceled "Plan: Ship the marketplace".',
          [env.planning.id]
        ]
      )
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an unknown objective', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const refused = yield* env.run('objective_stop', { objective: NEW_ID })
      assert.deepStrictEqual(refused, { text: `No objective has id "${NEW_ID}".`, isError: true })
    }).pipe(Effect.scoped)
  )
})
