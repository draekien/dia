import {
  type AgentDefinition,
  type AgentDefinitionRegistry,
  AgentDefinition as AgentDefinitionSchema
} from '@dia-plugin/dia-agent-definitions/registry'
import { AssigneeRef, Issue, IssueComment, Objective } from '@dia-plugin/dia-issues/domain'
import { ImportedEvent, type Issues } from '@dia-plugin/dia-issues/service'
import type { McpServerRegistry } from '@dia-plugin/dia-mcp/registry'
import { McpServers } from '@dia-plugin/dia-mcp/servers'
import { Effect, Schema } from 'effect'
import { SqlClient } from 'effect/sql'
import { BUILT_IN_DEFINITIONS } from './built-in-job-titles'
import { MissingReference, ORG_PROVIDER, refusalOf } from './domain'

const HANDOVER_TABLE = 'job_titles_handover'

const HandoverRow = Schema.Struct({
  job_title_id: AgentDefinitionSchema.fields.id,
  name: AgentDefinitionSchema.fields.name,
  job_description: Schema.String,
  skills: Schema.fromJsonString(AgentDefinitionSchema.fields.skills),
  permissions: Schema.fromJsonString(AgentDefinitionSchema.fields.permissions),
  mcp_servers: Schema.fromJsonString(McpServers),
  bypass_opt_in: Schema.BooleanFromBit,
  model: AgentDefinitionSchema.fields.model,
  thinking_level: AgentDefinitionSchema.fields.thinkingLevel
})
type HandoverRow = typeof HandoverRow.Type

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(HandoverRow))

const BUILT_INS: ReadonlyMap<string, AgentDefinition> = new Map(
  BUILT_IN_DEFINITIONS.map((definition) => [definition.id, definition])
)

const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  const set = new Set(left)
  return set.size === new Set(right).size && right.every((entry) => set.has(entry))
}

const sameAsBuiltIn = (row: AgentDefinition, builtIn: AgentDefinition): boolean =>
  row.jobDescription.trim() === builtIn.jobDescription.trim() &&
  sameSet(row.skills, builtIn.skills) &&
  sameSet(row.permissions.allow, builtIn.permissions.allow) &&
  sameSet(row.permissions.ask, builtIn.permissions.ask) &&
  sameSet(row.permissions.deny, builtIn.permissions.deny) &&
  sameSet(row.mcpServers, builtIn.mcpServers) &&
  row.bypassOptIn === builtIn.bypassOptIn &&
  row.model === builtIn.model &&
  row.thinkingLevel === builtIn.thinkingLevel

const toDefinition = (row: HandoverRow, mcpServers: ReadonlyArray<string>): AgentDefinition => ({
  id: row.job_title_id,
  name: row.name,
  jobDescription: row.job_description,
  skills: row.skills,
  permissions: row.permissions,
  mcpServers,
  bypassOptIn: row.bypass_opt_in,
  model: row.model,
  thinkingLevel: row.thinking_level
})

const serverEntries = (row: HandoverRow) =>
  Object.keys(row.mcp_servers)
    .sort()
    .flatMap((name) => {
      const server = row.mcp_servers[name]
      return server === undefined ? [] : [{ name, server }]
    })

/**
 * Whether the `org` database still holds job titles to hand over: `9_agent_definitions` renamed
 * them to `job_titles_handover`, and {@link handOverJobTitles} drops that table when it is done.
 */
export const handoverPending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${HANDOVER_TABLE}`
  return rows.length > 0
}).pipe(Effect.orDie)

/**
 * Moves the job titles `9_agent_definitions` left in `job_titles_handover` into `definitions` and
 * their inline MCP servers into `mcp`, then drops the table. Each server is imported under the
 * name `mcp.importServers` returns, which the definition then names. A built-in job title is
 * imported as an override only when it differs from its contributed definition; every other job
 * title is imported as a user definition with its id. Running it again after a failure before the
 * drop imports nothing twice; running it once the table is gone does nothing. Call it while both
 * registries are provided.
 */
export const handOverJobTitles = (
  definitions: AgentDefinitionRegistry,
  mcp: McpServerRegistry
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!(yield* handoverPending)) {
      yield* Effect.logDebug('No org job titles left to hand over')
      return
    }
    const rows = yield* decodeRows(
      yield* sql`SELECT job_title_id, name, job_description, skills, permissions,
        mcp_servers, bypass_opt_in, model, thinking_level FROM job_titles_handover ORDER BY rowid`
    )
    const servers = rows.map(serverEntries)
    const offered = servers.flat()
    const names = yield* mcp.importServers(offered)
    yield* Effect.logInfo('Handed org MCP servers to mcp', {
      servers: names.length,
      renamed: names.filter((name, index) => name !== offered[index]?.name).length
    })
    let offset = 0
    const overrides: Array<AgentDefinition> = []
    const userDefinitions: Array<AgentDefinition> = []
    for (const [index, row] of rows.entries()) {
      const count = servers[index]?.length ?? 0
      const definition = toDefinition(row, names.slice(offset, offset + count))
      offset += count
      const builtIn = BUILT_INS.get(row.job_title_id)
      if (builtIn === undefined) userDefinitions.push(definition)
      else if (!sameAsBuiltIn(definition, builtIn)) overrides.push(definition)
    }
    yield* definitions.importOverrides(overrides)
    yield* definitions.importDefinitions(userDefinitions)
    yield* sql.unsafe(`DROP TABLE ${HANDOVER_TABLE}`)
    yield* Effect.logInfo('Handed org job titles to agent-definitions', {
      jobTitles: rows.length,
      overrides: overrides.length,
      definitions: userDefinitions.length
    })
  }).pipe(Effect.orDie)

const WORK_HANDOVER_TABLES = [
  'issue_comments_handover',
  'issues_handover',
  'objectives_handover',
  'org_events_handover'
] as const

const hireRef = (hireId: string | null) =>
  hireId === null ? null : AssigneeRef.make({ provider: ORG_PROVIDER, id: hireId })

const ObjectiveHandoverRow = Schema.Struct({
  objective_id: Objective.fields.id,
  project_id: Objective.fields.projectId,
  title: Objective.fields.title,
  description: Objective.fields.description,
  priority: Objective.fields.priority,
  assignee: Schema.NullOr(Schema.String),
  state: Objective.fields.state,
  created_at: Objective.fields.createdAt
})

const IssueHandoverRow = Schema.Struct({
  issue_id: Issue.fields.id,
  objective_id: Issue.fields.objectiveId,
  parent_issue_id: Issue.fields.parentIssueId,
  kind: Issue.fields.kind,
  title: Issue.fields.title,
  description: Issue.fields.description,
  status: Issue.fields.status,
  assignee: Schema.NullOr(Schema.String),
  pane_id: Issue.fields.paneId,
  session_id: Issue.fields.sessionId,
  missing: Schema.fromJsonString(Schema.Array(MissingReference)),
  created_at: Issue.fields.createdAt
})

const CommentHandoverRow = Schema.Struct({
  comment_id: IssueComment.fields.id,
  issue_id: IssueComment.fields.issueId,
  author: Schema.NullOr(Schema.String),
  body: IssueComment.fields.body,
  created_at: IssueComment.fields.createdAt
})

const EventHandoverRow = Schema.Struct({
  seq: ImportedEvent.fields.seq,
  at: ImportedEvent.fields.at,
  objective_id: ImportedEvent.fields.objectiveId,
  issue_id: ImportedEvent.fields.issueId,
  event: ImportedEvent.fields.event
})

const decodeAll = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  rows: ReadonlyArray<unknown>
) => Schema.decodeUnknownEffect(Schema.Array(schema))(rows)

/**
 * Whether the `org` database still holds objectives, issues, comments or events to hand over:
 * `10_issues_handover` renamed them to `*_handover`, and {@link handOverWork} drops them when it
 * is done.
 */
export const workHandoverPending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND ${sql.in('name', WORK_HANDOVER_TABLES)}`
  return rows.length > 0
}).pipe(Effect.orDie)

/**
 * Moves the objectives, issues, comments and events `10_issues_handover` left in the `*_handover`
 * tables into `issues`, then drops the tables. Each hired agent named as an assignee or author
 * becomes an assignee reference of the `org` provider; an issue's missing names become its refusal.
 * Running it again after a failure before the drop imports nothing twice; running it once the
 * tables are gone does nothing. Call it while `issues` is provided, before registering the org as
 * an assignee provider.
 */
export const handOverWork = (
  issues: Pick<Issues, 'importWork'>
): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!(yield* workHandoverPending)) {
      yield* Effect.logDebug('No org work left to hand over')
      return
    }
    const objectives = yield* decodeAll(
      ObjectiveHandoverRow,
      yield* sql`SELECT * FROM objectives_handover ORDER BY rowid`
    )
    const issueRows = yield* decodeAll(
      IssueHandoverRow,
      yield* sql`SELECT * FROM issues_handover ORDER BY rowid`
    )
    const comments = yield* decodeAll(
      CommentHandoverRow,
      yield* sql`SELECT * FROM issue_comments_handover ORDER BY rowid`
    )
    const events = yield* decodeAll(
      EventHandoverRow,
      yield* sql`SELECT * FROM org_events_handover ORDER BY seq`
    )
    yield* issues.importWork({
      objectives: objectives.map((row) =>
        Objective.make({
          id: row.objective_id,
          projectId: row.project_id,
          title: row.title,
          description: row.description,
          priority: row.priority,
          assignee: hireRef(row.assignee),
          state: row.state,
          createdAt: row.created_at
        })
      ),
      issues: issueRows.map((row) =>
        Issue.make({
          id: row.issue_id,
          objectiveId: row.objective_id,
          parentIssueId: row.parent_issue_id,
          kind: row.kind,
          title: row.title,
          description: row.description,
          status: row.status,
          assignee: hireRef(row.assignee),
          paneId: row.pane_id,
          sessionId: row.session_id,
          refusal:
            row.status === 'triage' && row.missing.length > 0 ? refusalOf(row.missing) : null,
          createdAt: row.created_at
        })
      ),
      comments: comments.map((row) =>
        IssueComment.make({
          id: row.comment_id,
          issueId: row.issue_id,
          author: hireRef(row.author),
          body: row.body,
          createdAt: row.created_at
        })
      ),
      events: events.map((row) =>
        ImportedEvent.make({
          seq: row.seq,
          at: row.at,
          objectiveId: row.objective_id,
          issueId: row.issue_id,
          event: row.event
        })
      )
    })
    yield* sql.withTransaction(
      Effect.forEach(WORK_HANDOVER_TABLES, (table) => sql.unsafe(`DROP TABLE ${table}`), {
        discard: true
      })
    )
    yield* Effect.logInfo('Handed org work to issues', {
      objectives: objectives.length,
      issues: issueRows.length,
      comments: comments.length,
      events: events.length
    })
  }).pipe(Effect.orDie)
