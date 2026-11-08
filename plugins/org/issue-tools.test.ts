import { ProjectId } from '@dia/plugin'
import * as NodeCrypto from '@effect/platform-node/NodeCrypto'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Exit, Scope } from 'effect'
import { SqlClient } from 'effect/sql'
import { openDatabase } from '../../src/host/services/database'
import { HireId, IssueId, ObjectiveId, PlanRoute, StartedStatus, WorkTitle } from './domain'
import { type IssueToolScope, makeIssueTools } from './issue-tools'
import { orgMigrations } from './migrations'
import { makeOrg } from './org'
import { makeWork, type Work } from './work'

const PROJECT = ProjectId.make('00000000-0000-4000-8000-400000000001')
const OBJECTIVE = ObjectiveId.make('00000000-0000-4000-8000-500000000001')
const OTHER_OBJECTIVE = ObjectiveId.make('00000000-0000-4000-8000-500000000002')
const MISSING_ISSUE = IssueId.make('00000000-0000-4000-8000-600000000099')

const objective = (id: ObjectiveId) => ({
  id,
  projectId: PROJECT,
  title: WorkTitle.make('Ship the marketplace'),
  description: '',
  priority: 'normal' as const,
  route: PlanRoute.make({ assignee: null })
})

const setUp = Effect.gen(function* () {
  const scope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
  const sql = yield* openDatabase(':memory:', orgMigrations).pipe(Scope.provide(scope))
  const { work, runs, org } = yield* Effect.gen(function* () {
    const made = yield* makeWork(() => Effect.succeed(true))
    return { ...made, org: yield* makeOrg(made.openIssuesOf) }
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.provide(NodeCrypto.layer))
  const jobTitle = (yield* org.jobTitles)[0]
  assert.isDefined(jobTitle)
  const hire = yield* org.hire(jobTitle.id, null, null)
  yield* work.createObjective(objective(OBJECTIVE))
  yield* work.createObjective(objective(OTHER_OBJECTIVE))
  const [own, other] = (yield* work.snapshot).issues
  assert.isDefined(own)
  assert.isDefined(other)
  yield* work.assignIssue(own.id, hire.id)
  assert.isTrue(yield* runs.markStarted(own.id, hire.id))
  const scopeOf: IssueToolScope = { issueId: own.id, objectiveId: OBJECTIVE, hireId: hire.id }
  const tools = new Map(makeIssueTools(work, scopeOf).map((tool) => [tool.name, tool]))
  const run = (name: string, input: Record<string, string>) => {
    const tool = tools.get(name)
    assert.isDefined(tool, name)
    return tool.run(input)
  }
  const issueOf = (id: IssueId) =>
    Effect.map(work.snapshot, (snapshot) => snapshot.issues.find((issue) => issue.id === id))
  const sibling = yield* work.createIssue({
    id: IssueId.make('00000000-0000-4000-8000-600000000001'),
    objectiveId: OBJECTIVE,
    parentIssueId: null,
    title: WorkTitle.make('Sibling'),
    description: '',
    assignee: null
  })
  return { work, sql, run, issueOf, own, other, sibling, hire }
})

describe('create_issue', () => {
  it.effect("adds an unassigned triage issue to the session's objective", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('create_issue', {
        title: 'Fetch the index',
        description: 'Read the plugin index.'
      })
      const created = (yield* env.work.snapshot).issues.at(-1)
      assert.deepStrictEqual(
        [created?.objectiveId, created?.status, created?.assignee, created?.description],
        [OBJECTIVE, 'triage', null, 'Read the plugin index.']
      )
      assert.deepStrictEqual(result, {
        text: `Created issue ${created?.id} "Fetch the index" in Triage.`,
        isError: false
      })
    }).pipe(Effect.scoped)
  )

  it.effect('trims the title and stores an empty description for an omitted one', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.run('create_issue', { title: '  Fetch the index  ', description: '' })
      const created = (yield* env.work.snapshot).issues.at(-1)
      assert.deepStrictEqual([created?.title, created?.description], ['Fetch the index', ''])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a title that is empty after trimming, and writes nothing', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const before = (yield* env.work.snapshot).issues.length
      const result = yield* env.run('create_issue', { title: '   ' })
      assert.isTrue(result.isError)
      assert.strictEqual((yield* env.work.snapshot).issues.length, before)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a parent issue in another objective as not in this objective', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const before = (yield* env.work.snapshot).issues.length
      const result = yield* env.run('create_issue', {
        title: 'Child',
        parent_issue_id: env.other.id
      })
      assert.deepStrictEqual(result, {
        text: `Issue ${env.other.id} is not in this objective.`,
        isError: true
      })
      assert.strictEqual((yield* env.work.snapshot).issues.length, before)
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a parent issue id that is not a uuid', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('create_issue', { title: 'Child', parent_issue_id: 'abc' })
      assert.deepStrictEqual(result, {
        text: 'Invalid parent_issue_id: "abc" is not an issue id (a UUID).',
        isError: true
      })
    }).pipe(Effect.scoped)
  )

  it.effect('returns a defect as Could not create the issue', () =>
    Effect.gen(function* () {
      const dying: Pick<Work, 'proposeIssue' | 'updateIssue' | 'commentIssue'> = {
        proposeIssue: () => Effect.die(new Error('disk full')),
        updateIssue: () => Effect.die(new Error('disk full')),
        commentIssue: () => Effect.die(new Error('disk full'))
      }
      const [create] = makeIssueTools(dying, {
        issueId: MISSING_ISSUE,
        objectiveId: OBJECTIVE,
        hireId: HireId.make('00000000-0000-4000-8000-200000000001')
      })
      assert.isDefined(create)
      const result = yield* create.run({ title: 'Anything' })
      assert.deepStrictEqual(result, { text: 'Could not create the issue.', isError: true })
    })
  )
})

describe('update_issue', () => {
  it.effect("sets the session's own issue status when issue_id is omitted", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('update_issue', { status: 'in_review' })
      assert.deepStrictEqual(result, {
        text: `Updated issue ${env.own.id}: status in_review.`,
        isError: false
      })
      assert.strictEqual((yield* env.issueOf(env.own.id))?.status, 'in_review')
    }).pipe(Effect.scoped)
  )

  it.effect("sets the session's own issue status when issue_id names it in upper case", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.run('update_issue', { issue_id: env.own.id.toUpperCase(), status: 'testing' })
      assert.strictEqual((yield* env.issueOf(env.own.id))?.status, 'testing')
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a status for another issue, leaving it as it is', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('update_issue', {
        issue_id: env.sibling.id,
        status: 'in_review'
      })
      assert.deepStrictEqual(result, {
        text: "Only your own issue's status can change.",
        isError: true
      })
      assert.strictEqual((yield* env.issueOf(env.sibling.id))?.status, 'todo')
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a status outside the six started statuses and lists them', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('update_issue', { status: 'done' })
      assert.deepStrictEqual(result, {
        text: `Invalid status "done". Allowed: ${StartedStatus.literals.join(', ')}.`,
        isError: true
      })
      assert.strictEqual((yield* env.issueOf(env.own.id))?.status, 'understanding')
    }).pipe(Effect.scoped)
  )

  it.effect('treats empty fields as omitted', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('update_issue', {
        issue_id: '',
        title: '',
        description: '',
        status: ''
      })
      const own = yield* env.issueOf(env.own.id)
      assert.isFalse(result.isError)
      assert.deepStrictEqual([own?.title, own?.status], [env.own.title, 'understanding'])
    }).pipe(Effect.scoped)
  )

  it.effect('changes the trimmed title of another issue in the objective', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.run('update_issue', { issue_id: env.sibling.id, title: '  Renamed  ' })
      assert.strictEqual((yield* env.issueOf(env.sibling.id))?.title, 'Renamed')
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an issue of another objective as not in this objective', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('update_issue', { issue_id: env.other.id, title: 'Renamed' })
      assert.deepStrictEqual(result, {
        text: `Issue ${env.other.id} is not in this objective.`,
        isError: true
      })
      assert.strictEqual((yield* env.issueOf(env.other.id))?.title, env.other.title)
    }).pipe(Effect.scoped)
  )

  it.effect('names the status when its own issue is done', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      yield* env.work.finishIssue(env.own.id)
      const result = yield* env.run('update_issue', { status: 'testing' })
      assert.deepStrictEqual(result, {
        text: `Issue ${env.own.id} is in done; only a started issue's status can change.`,
        isError: true
      })
    }).pipe(Effect.scoped)
  )
})

describe('comment_issue', () => {
  it.effect("comments on the session's own issue as its hired agent, with the body trimmed", () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('comment_issue', { body: '  Planned three issues.  ' })
      const comments = (yield* env.work.snapshot).comments
      assert.deepStrictEqual(
        comments.map((comment) => [comment.issueId, comment.author, comment.body]),
        [[env.own.id, env.hire.id, 'Planned three issues.']]
      )
      assert.deepStrictEqual(result, { text: `Commented on issue ${env.own.id}.`, isError: false })
    }).pipe(Effect.scoped)
  )

  it.effect('refuses a body that is empty after trimming, and writes nothing', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('comment_issue', { body: ' \n ' })
      assert.isTrue(result.isError)
      assert.deepStrictEqual((yield* env.work.snapshot).comments, [])
    }).pipe(Effect.scoped)
  )

  it.effect('refuses an issue of another objective, and writes nothing', () =>
    Effect.gen(function* () {
      const env = yield* setUp
      const result = yield* env.run('comment_issue', { issue_id: env.other.id, body: 'Hi' })
      assert.isTrue(result.isError)
      assert.deepStrictEqual((yield* env.work.snapshot).comments, [])
    }).pipe(Effect.scoped)
  )
})
