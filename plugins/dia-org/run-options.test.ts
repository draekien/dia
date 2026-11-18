import { Issue, IssueId, Objective, ObjectiveId, WorkTitle } from '@dia-plugin/dia-issues/domain'
import { assert, describe, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { PROJECT } from '../dia-issues/issues.fake'
import { type JobTitle, JobTitleId, JobTitleName } from './domain'
import { issuePrompt, runSettings } from './run-options'
import { fakeChoices, model } from './runs.fake'

const ISSUE_ID = IssueId.make('00000000-0000-4000-8000-000000000001')
const OBJECTIVE_ID = ObjectiveId.make('00000000-0000-4000-8000-000000000002')
const REQUEST = 'Fix the login button\n\nRouting note: The user attached a screenshot.'

const objective = (title: string, description: string) =>
  Objective.make({
    id: OBJECTIVE_ID,
    projectId: PROJECT,
    title: WorkTitle.make(title),
    description,
    priority: 'normal',
    assignee: null,
    state: 'open',
    createdAt: 1
  })

const issue = (kind: 'work' | 'planning', title: string, description: string) =>
  Issue.make({
    id: ISSUE_ID,
    objectiveId: OBJECTIVE_ID,
    parentIssueId: null,
    kind,
    title: WorkTitle.make(title),
    description,
    status: 'todo',
    assignee: null,
    paneId: '00000000-0000-4000-8000-000000000003',
    sessionId: null,
    refusal: null,
    createdAt: 2
  })

describe('issuePrompt', () => {
  it('states a direct-routed work issue once when it repeats its objective', () => {
    const prompt = issuePrompt(issue('work', 'Login bug', REQUEST), objective('Login bug', REQUEST))
    assert.strictEqual(prompt, `Login bug\n\n${REQUEST}\n\nIssue: ${ISSUE_ID}`)
  })

  it('gives a planned work issue both its own and its objective description', () => {
    const prompt = issuePrompt(
      issue('work', 'Add the retry button', 'Show a retry button on failure.'),
      objective('Login bug', REQUEST)
    )
    assert.strictEqual(
      prompt,
      `Add the retry button\n\nShow a retry button on failure.\n\nIssue: ${ISSUE_ID}\nObjective: Login bug\n\n${REQUEST}`
    )
  })

  it('keeps the labelled objective when only the titles match', () => {
    const prompt = issuePrompt(
      issue('work', 'Login bug', 'Fix the login button'),
      objective('Login bug', REQUEST)
    )
    assert.strictEqual(
      prompt,
      `Login bug\n\nFix the login button\n\nIssue: ${ISSUE_ID}\nObjective: Login bug\n\n${REQUEST}`
    )
  })

  it('asks a planning issue to plan its objective', () => {
    const prompt = issuePrompt(
      issue('planning', 'Plan: Login bug', ''),
      objective('Login bug', REQUEST)
    )
    assert.isTrue(
      prompt.startsWith(`Plan the objective "Login bug".\n\n${REQUEST}\n\nBreak it into issues`)
    )
  })
})

const jobTitle = (selection: JobTitle['selection']): JobTitle => ({
  id: JobTitleId.make('00000000-0000-4000-8000-000000000010'),
  name: JobTitleName.make('Engineer'),
  jobDescription: '',
  skills: [],
  permissions: { allow: [], ask: [], deny: [] },
  mcpServers: [],
  bypassOptIn: false,
  selection,
  thinkingLevel: 'high',
  builtIn: null,
  enabled: true
})

describe('runSettings', () => {
  const choices = fakeChoices([model('opus', true)], [], 'adapter-a')

  it.effect("starts on the backend of the job title's selection, with its model", () =>
    Effect.gen(function* () {
      const settings = yield* runSettings(
        choices,
        jobTitle({ backend: 'adapter-a', model: 'opus' }),
        '/repo',
        false
      )

      assert.deepStrictEqual(
        settings,
        Option.some({
          model: 'opus',
          backend: 'adapter-a',
          thinkingLevel: 'high',
          permissionMode: 'auto'
        })
      )
    })
  )

  it.effect('starts a job title with no selection on the default selection', () =>
    Effect.gen(function* () {
      const settings = yield* runSettings(choices, jobTitle(null), '/repo', false)

      assert.deepStrictEqual(
        Option.map(settings, ({ backend, model }) => [backend, model]),
        Option.some(['adapter-a', 'opus'])
      )
    })
  )

  it.effect('starts no run for a job title with no selection while no adapter is loaded', () =>
    Effect.gen(function* () {
      const none = { ...choices, defaultSelection: Effect.succeed(Option.none()) }

      const settings = yield* runSettings(none, jobTitle(null), '/repo', false)

      assert.isTrue(Option.isNone(settings))
    })
  )

  it.effect('still starts a run whose selection names an adapter that is not registered', () =>
    Effect.gen(function* () {
      const settings = yield* runSettings(
        choices,
        jobTitle({ backend: 'unloaded-adapter', model: 'beta' }),
        '/repo',
        false
      )

      assert.deepStrictEqual(
        Option.map(settings, ({ backend, model, permissionMode }) => [
          backend,
          model,
          permissionMode
        ]),
        Option.some(['unloaded-adapter', 'beta', 'default'])
      )
    })
  )
})
