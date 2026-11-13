import { FirstIssue, ObjectiveId, WorkTitle } from '@dia-plugin/dia-issues/domain'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Scope, SubscriptionRef } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { openIssues, PROJECT } from '../dia-issues/issues.fake'
import { ASSISTANT_LABEL, makeAssistant } from './assistant'
import { EXECUTIVE_ASSISTANT } from './built-in-job-titles'
import type { JobTitleId } from './domain'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { holdBuiltInDefinitions } from './registries.fake'
import { fakeBackend, fakeRuns, model } from './runs.fake'

const DIRECTORY = 'C:/dia/plugins/dia-org/assistant'
const CLAIMED = ObjectiveId.make('00000000-0000-4000-8000-500000000001')
const UNCLAIMED = ObjectiveId.make('00000000-0000-4000-8000-500000000002')

const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 50; turn += 1) yield* Effect.yieldNow
})

const setUp = Effect.gen(function* () {
  const dbScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(dbScope, Exit.void))
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(dbScope))
  const org = yield* makeOrg.pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.provide(NodeCrypto.layer)
  )
  yield* holdBuiltInDefinitions(org)
  const { issues } = yield* openIssues
  const fake = fakeRuns()
  const runId = yield* SubscriptionRef.make<string | null>(null)
  const assistant = yield* makeAssistant({
    org,
    work: issues,
    runs: fake.runs,
    backend: fakeBackend([model('opus')]),
    directory: DIRECTORY,
    runId
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  const createObjective = (id: ObjectiveId, title: string) =>
    issues.createObjective(
      {
        id,
        projectId: PROJECT,
        title: WorkTitle.make(title),
        description: '',
        priority: 'normal',
        assignee: null
      },
      [
        FirstIssue.make({
          kind: 'planning',
          title: WorkTitle.make(title),
          description: '',
          assignee: null
        })
      ]
    )
  return { org, issues, fake, runId, assistant, createObjective }
})

describe('Executive assistant', () => {
  it.effect('starts its run on the first request, labelled for the routing tools', () =>
    Effect.gen(function* () {
      const env = yield* setUp

      const runId = yield* env.assistant.ask('Add dark mode')

      const [started] = env.fake.started
      assert.isDefined(started)
      assert.strictEqual(started.runId, runId)
      assert.strictEqual(started.cwd, DIRECTORY)
      assert.deepStrictEqual(started.labels, [ASSISTANT_LABEL])
      assert.isTrue(started.text.endsWith('\n\nAdd dark mode'))
      assert.isTrue(started.text.startsWith(EXECUTIVE_ASSISTANT.jobDescription.slice(0, 40)))
      assert.strictEqual(yield* SubscriptionRef.get(env.runId), runId)
    }).pipe(Effect.scoped)
  )

  it.effect('sends a later request to the same run', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const first = yield* env.assistant.ask('Add dark mode')

      const second = yield* env.assistant.ask('Also a light mode')

      assert.strictEqual(second, first)
      assert.strictEqual(env.fake.started.length, 1)
      assert.deepStrictEqual(env.fake.sent, [{ runId: first, text: 'Also a light mode' }])
    }).pipe(Effect.scoped)
  )

  it.effect('starts a new run after its run was archived', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const first = yield* env.assistant.ask('Add dark mode')
      env.fake.setRun(first, 'archived', false)

      const second = yield* env.assistant.ask('Again')

      assert.notStrictEqual(second, first)
      assert.strictEqual(env.fake.started.length, 2)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a request while its job title is disabled', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.org.setJobTitleEnabled(EXECUTIVE_ASSISTANT.id as JobTitleId, false)

      const result = yield* Effect.flip(env.assistant.ask('Add dark mode'))

      assert.strictEqual(result._tag, 'AssistantDisabled')
      assert.strictEqual(env.fake.started.length, 0)
    }).pipe(Effect.scoped)
  )

  it.effect('prefixes notices of objectives it claimed to the next request', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const runId = yield* env.assistant.ask('Plan the login')
      yield* env.assistant.claim(CLAIMED)
      yield* env.createObjective(CLAIMED, 'Login')
      yield* env.createObjective(UNCLAIMED, 'Billing')
      yield* settle
      yield* env.issues.stopObjective(CLAIMED)
      yield* env.issues.stopObjective(UNCLAIMED)
      yield* settle

      yield* env.assistant.ask('What happened?')

      assert.deepStrictEqual(env.fake.sent, [
        { runId, text: 'Objective "Login" is completed.\nWhat happened?' }
      ])
    }).pipe(Effect.scoped)
  )

  it.effect('archives its run on start over, and the next request starts a new one', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const first = yield* env.assistant.ask('Add dark mode')

      yield* env.assistant.startOver

      assert.deepStrictEqual(env.fake.retired, [first])
      assert.isNull(yield* SubscriptionRef.get(env.runId))
      const second = yield* env.assistant.ask('Again')
      assert.notStrictEqual(second, first)
    }).pipe(Effect.scoped)
  )
})
