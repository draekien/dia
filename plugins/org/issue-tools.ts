import type { DiaTool, DiaToolField, DiaToolResult } from '@dia/plugin'
import { Data, Effect, Schema } from 'effect'
import {
  CommentBody,
  type HireId,
  IssueChange,
  IssueDescription,
  IssueId,
  type IssueNotFound,
  type ObjectiveId,
  StartedStatus,
  WorkTitle
} from './domain'
import type { Work } from './work'

/** Where a hired agent's session works: its issue, that issue's objective, and the hired agent. */
export interface IssueToolScope {
  readonly issueId: IssueId
  readonly objectiveId: ObjectiveId
  readonly hireId: HireId
}

class InvalidInput extends Data.TaggedError('InvalidInput')<{ readonly message: string }> {}

type Input = Readonly<Partial<Record<string, string>>>

const result = (text: string, isError = false): DiaToolResult => ({ text, isError })

const required = (description: string): DiaToolField => ({ description, pattern: /[\s\S]/ })

const optional = (description: string): DiaToolField => ({
  description,
  pattern: /^[\s\S]*$/,
  optional: true
})

const present = (input: Input, field: string): string | undefined => {
  const value = input[field]
  return value === undefined || value === '' ? undefined : value
}

const decodeField = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  field: string,
  value: string
) =>
  Schema.decodeEffect(schema)(value).pipe(
    Effect.mapError((error) => new InvalidInput({ message: `Invalid ${field}: ${error.message}` }))
  )

const decodeOptional = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  field: string,
  value: string | undefined
) => (value === undefined ? Effect.undefined : decodeField(schema, field, value))

const decodeIssueId = (field: string, value: string) =>
  Schema.decodeEffect(IssueId)(value).pipe(
    Effect.mapError(
      () =>
        new InvalidInput({ message: `Invalid ${field}: "${value}" is not an issue id (a UUID).` })
    )
  )

const decodeStatus = (value: string | undefined) =>
  value === undefined || Schema.is(StartedStatus)(value)
    ? Effect.succeed(value)
    : Effect.fail(
        new InvalidInput({
          message: `Invalid status "${value}". Allowed: ${StartedStatus.literals.join(', ')}.`
        })
      )

const notInObjective = (issueId: IssueId) => `Issue ${issueId} is not in this objective.`

type SharedError = InvalidInput | IssueNotFound

const isSharedError = (error: { readonly _tag: string }): error is SharedError =>
  error._tag === 'InvalidInput' || error._tag === 'IssueNotFound'

const describeShared = (error: SharedError): string =>
  error._tag === 'InvalidInput' ? error.message : notInObjective(error.issueId)

const recover =
  (tool: string, action: string) =>
  <E extends { readonly _tag: string }>(
    effect: Effect.Effect<DiaToolResult, E>,
    describe: (error: Exclude<E, SharedError>) => string = () => `Could not ${action}.`
  ): Effect.Effect<DiaToolResult> =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logInfo('Issue tool refused the call', { tool, error: error._tag }).pipe(
          Effect.as(
            result(
              isSharedError(error)
                ? describeShared(error)
                : describe(error as Exclude<E, SharedError>),
              true
            )
          )
        )
      ),
      Effect.catchCause((cause) =>
        Effect.logError('Issue tool failed', { tool }, cause).pipe(
          Effect.as(result(`Could not ${action}.`, true))
        )
      )
    )

const issueIdOrOwn = (input: Input, scope: IssueToolScope) => {
  const raw = present(input, 'issue_id')
  return raw === undefined ? Effect.succeed(scope.issueId) : decodeIssueId('issue_id', raw)
}

/**
 * The dia tools a hired agent's session gets: create_issue, update_issue and comment_issue,
 * each acting only within `scope.objectiveId`, with comments authored by `scope.hireId`.
 * `update_issue` and `comment_issue` default to `scope.issueId`; only that issue's status can
 * change. A refused call returns its reason to the agent with `isError` set and writes nothing.
 * Build them once per hired agent session and pass them as the session's dia tools.
 */
export const makeIssueTools = (
  work: Pick<Work, 'proposeIssue' | 'updateIssue' | 'commentIssue'>,
  scope: IssueToolScope
): ReadonlyArray<DiaTool> => [
  {
    name: 'create_issue',
    description:
      'Propose a new issue in your objective. It goes to Triage, unassigned, for the user to accept or decline. Give it a description another agent can act on.',
    input: {
      title: required('Title of the issue, up to 120 characters.'),
      description: optional('What the issue asks for, so an agent can act on it.'),
      parent_issue_id: optional('Id of the issue in this objective it belongs under.')
    },
    run: (input) =>
      recover('create_issue', 'create the issue')(
        Effect.gen(function* () {
          const title = yield* decodeField(WorkTitle, 'title', (input.title ?? '').trim())
          const description =
            (yield* decodeOptional(
              IssueDescription,
              'description',
              present(input, 'description')
            )) ?? ''
          const parent = present(input, 'parent_issue_id')
          const parentIssueId =
            parent === undefined ? null : yield* decodeIssueId('parent_issue_id', parent)
          const issue = yield* work.proposeIssue(scope.objectiveId, {
            parentIssueId,
            title,
            description
          })
          return result(`Created issue ${issue.id} "${issue.title}" in Triage.`)
        }),
        (error) => {
          switch (error._tag) {
            case 'ObjectiveNotFound':
              return `Objective ${error.objectiveId} no longer exists.`
          }
        }
      )
  },
  {
    name: 'update_issue',
    description:
      "Change an issue in your objective. Set your own issue's status as you work: understanding, designing, implementing, testing, verifying, in_review. Set in_review when the work is ready for the user.",
    input: {
      issue_id: optional('Id of the issue to change; your own issue when omitted.'),
      title: optional('New title, up to 120 characters.'),
      description: optional('New description.'),
      status: optional(
        `New status of your own issue, one of: ${StartedStatus.literals.join(', ')}.`
      )
    },
    run: (input) =>
      recover('update_issue', 'update the issue')(
        Effect.gen(function* () {
          const issueId = yield* issueIdOrOwn(input, scope)
          const title = yield* decodeOptional(WorkTitle, 'title', present(input, 'title')?.trim())
          const description = yield* decodeOptional(
            IssueDescription,
            'description',
            present(input, 'description')
          )
          const status = yield* decodeStatus(present(input, 'status'))
          if (status !== undefined && issueId !== scope.issueId) {
            return yield* new InvalidInput({ message: "Only your own issue's status can change." })
          }
          const change = IssueChange.make({
            ...(title === undefined ? {} : { title }),
            ...(description === undefined ? {} : { description }),
            ...(status === undefined ? {} : { status })
          })
          yield* work.updateIssue(scope.objectiveId, issueId, change)
          const changed = [
            ...(change.title === undefined ? [] : ['title']),
            ...(change.description === undefined ? [] : ['description']),
            ...(change.status === undefined ? [] : [`status ${change.status}`])
          ]
          return result(
            changed.length === 0
              ? `Issue ${issueId} is unchanged: no field was given.`
              : `Updated issue ${issueId}: ${changed.join(', ')}.`
          )
        }),
        (error) => {
          switch (error._tag) {
            case 'IssueNotStarted':
              return `Issue ${error.issueId} is in ${error.status}; only a started issue's status can change.`
            case 'IssueClosed':
              return `Issue ${error.issueId} is ${error.status}; a closed issue's title and description cannot change.`
          }
        }
      )
  },
  {
    name: 'comment_issue',
    description:
      'Add a comment to an issue in your objective, for the user and other agents to read.',
    input: {
      issue_id: optional('Id of the issue to comment on; your own issue when omitted.'),
      body: required('Text of the comment.')
    },
    run: (input) =>
      recover(
        'comment_issue',
        'comment on the issue'
      )(
        Effect.gen(function* () {
          const issueId = yield* issueIdOrOwn(input, scope)
          const body = yield* decodeField(CommentBody, 'body', (input.body ?? '').trim())
          yield* work.commentIssue(scope.objectiveId, issueId, scope.hireId, body)
          return result(`Commented on issue ${issueId}.`)
        })
      )
  }
]
