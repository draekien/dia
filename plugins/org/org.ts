import type { AgentName } from '@dia/plugin'
import { Clock, Crypto, Effect, Schema } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import {
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  descendantsOf,
  HiredAgent,
  HireHasOpenIssues,
  type HireId,
  HireNameTaken,
  HireNotFound,
  JobTitle,
  JobTitleDisabled,
  type JobTitleEdit,
  JobTitleHasHires,
  type JobTitleId,
  type JobTitleName,
  JobTitleNameTaken,
  JobTitleNotFound,
  JobTitleNotHireable,
  OrgSettings,
  type OverallCap,
  ReportsToCycle
} from './domain'
import type { Org } from './service'

const JobTitleRow = Schema.Struct({
  job_title_id: JobTitle.fields.id,
  name: JobTitle.fields.name,
  built_in: JobTitle.fields.builtIn,
  enabled: Schema.BooleanFromBit,
  job_description: JobTitle.fields.jobDescription,
  skills: Schema.fromJsonString(JobTitle.fields.skills),
  permissions: Schema.fromJsonString(JobTitle.fields.permissions),
  mcp_servers: Schema.fromJsonString(JobTitle.fields.mcpServers),
  bypass_opt_in: Schema.BooleanFromBit,
  model: JobTitle.fields.model,
  thinking_level: JobTitle.fields.thinkingLevel
})

const HireRow = Schema.Struct({
  hire_id: HiredAgent.fields.id,
  job_title_id: HiredAgent.fields.jobTitleId,
  name: HiredAgent.fields.name,
  bypass_override: Schema.NullOr(Schema.BooleanFromBit),
  reports_to: HiredAgent.fields.reportsTo,
  hired_at: HiredAgent.fields.hiredAt
})

const SettingsRow = Schema.Struct({ overall_cap: OrgSettings.fields.overallCap })

const toJobTitle = (row: typeof JobTitleRow.Type): JobTitle => ({
  id: row.job_title_id,
  name: row.name,
  builtIn: row.built_in,
  enabled: row.enabled,
  jobDescription: row.job_description,
  skills: row.skills,
  permissions: row.permissions,
  mcpServers: row.mcp_servers,
  bypassOptIn: row.bypass_opt_in,
  model: row.model,
  thinkingLevel: row.thinking_level
})

const encodeJobTitleRow = Schema.encodeSync(JobTitleRow)

const toJobTitleRow = (jobTitle: JobTitle) =>
  encodeJobTitleRow({
    job_title_id: jobTitle.id,
    name: jobTitle.name,
    built_in: jobTitle.builtIn,
    enabled: jobTitle.enabled,
    job_description: jobTitle.jobDescription,
    skills: jobTitle.skills,
    permissions: jobTitle.permissions,
    mcp_servers: jobTitle.mcpServers,
    bypass_opt_in: jobTitle.bypassOptIn,
    model: jobTitle.model,
    thinking_level: jobTitle.thinkingLevel
  })

const toHiredAgent = (row: typeof HireRow.Type): HiredAgent => ({
  id: row.hire_id,
  jobTitleId: row.job_title_id,
  name: row.name,
  bypassOverride: row.bypass_override,
  reportsTo: row.reports_to,
  hiredAt: row.hired_at
})

const encodeHireRow = Schema.encodeSync(HireRow)

const toHireRow = (agent: HiredAgent) =>
  encodeHireRow({
    hire_id: agent.id,
    job_title_id: agent.jobTitleId,
    name: agent.name,
    bypass_override: agent.bypassOverride,
    reports_to: agent.reportsTo,
    hired_at: agent.hiredAt
  })

const rowsDecoder =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (rows: ReadonlyArray<unknown>) =>
    Schema.decodeUnknownEffect(Schema.Array(schema))(rows).pipe(Effect.orDie)

const decodeJobTitleRows = rowsDecoder(JobTitleRow)
const decodeHireRows = rowsDecoder(HireRow)
const decodeSettingsRows = rowsDecoder(SettingsRow)

/**
 * Builds the {@link Org} over the `org` plugin's database, which `orgMigrations` must already have
 * migrated. `openIssuesOf` counts the issues assigned to a hired agent that are neither `done` nor `canceled`; it is
 * read inside `dismiss`'s transaction, so it must use the same SQL client. Call it once in the
 * plugin's setup and provide the result under `OrgService`.
 */
export const makeOrg = (openIssuesOf: (hireId: HireId) => Effect.Effect<number>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto

    const transaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
      sql.withTransaction(effect).pipe(Effect.catchTag('SqlError', Effect.die))

    const newId = crypto.randomUUIDv4().pipe(Effect.orDie)

    const findJobTitle = Effect.fnUntraced(function* (jobTitleId: JobTitleId) {
      const rows = yield* sql`SELECT * FROM job_titles WHERE job_title_id = ${jobTitleId}`
      const [row] = yield* decodeJobTitleRows(rows)
      if (row === undefined) {
        return yield* JobTitleNotFound.make({ jobTitleId })
      }
      return toJobTitle(row)
    })

    const findHire = Effect.fnUntraced(function* (hireId: HireId) {
      const rows = yield* sql`SELECT * FROM hired_agents WHERE hire_id = ${hireId}`
      const [row] = yield* decodeHireRows(rows)
      if (row === undefined) {
        return yield* HireNotFound.make({ hireId })
      }
      return toHiredAgent(row)
    })

    const ensureHireNameFree = Effect.fnUntraced(function* (
      name: AgentName,
      exceptId: HireId | null
    ) {
      const rows =
        yield* sql`SELECT 1 FROM hired_agents WHERE name = ${name} AND hire_id IS NOT ${exceptId}`
      if (rows.length > 0) {
        return yield* HireNameTaken.make({ agentName: name })
      }
    })

    const updateHire = (agent: HiredAgent) =>
      sql`UPDATE hired_agents SET ${sql.update(toHireRow(agent), ['hire_id'])} WHERE hire_id = ${agent.id}`

    const ensureJobTitleNameFree = Effect.fnUntraced(function* (
      name: JobTitleName,
      exceptId: JobTitleId | null
    ) {
      const rows =
        yield* sql`SELECT 1 FROM job_titles WHERE name = ${name} AND job_title_id IS NOT ${exceptId}`
      if (rows.length > 0) {
        return yield* JobTitleNameTaken.make({ jobTitleName: name })
      }
    })

    const insertJobTitle = (jobTitle: JobTitle) =>
      sql`INSERT INTO job_titles ${sql.insert(toJobTitleRow(jobTitle))}`

    const updateJobTitle = (jobTitle: JobTitle) =>
      sql`UPDATE job_titles SET ${sql.update(toJobTitleRow(jobTitle), ['job_title_id'])} WHERE job_title_id = ${jobTitle.id}`

    const jobTitles = Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM job_titles ORDER BY built_in IS NULL, rowid`
      return (yield* decodeJobTitleRows(rows)).map(toJobTitle)
    }).pipe(Effect.catchTag('SqlError', Effect.die))

    const hiredAgents = Effect.gen(function* () {
      const rows = yield* sql`SELECT * FROM hired_agents ORDER BY hired_at, rowid`
      return (yield* decodeHireRows(rows)).map(toHiredAgent)
    }).pipe(Effect.catchTag('SqlError', Effect.die))

    const settings = Effect.gen(function* () {
      const rows = yield* sql`SELECT overall_cap FROM org_settings`
      const [row] = yield* decodeSettingsRows(rows)
      if (row === undefined) {
        return yield* Effect.die('The org_settings row is missing')
      }
      return OrgSettings.make({ overallCap: row.overall_cap })
    }).pipe(Effect.catchTag('SqlError', Effect.die))

    const setJobTitleEnabled = Effect.fn('Org.setJobTitleEnabled')(function* (
      jobTitleId: JobTitleId,
      enabled: boolean
    ) {
      const jobTitle = yield* transaction(
        Effect.gen(function* () {
          const changed = { ...(yield* findJobTitle(jobTitleId)), enabled }
          yield* updateJobTitle(changed)
          return changed
        })
      )
      yield* Effect.logInfo('Set job title enabled', { jobTitleId, enabled })
      return jobTitle
    })

    const copyJobTitle = Effect.fn('Org.copyJobTitle')(function* (
      jobTitleId: JobTitleId,
      name: JobTitleName
    ) {
      const id = JobTitle.fields.id.make(yield* newId)
      const copy = yield* transaction(
        Effect.gen(function* () {
          const source = yield* findJobTitle(jobTitleId)
          yield* ensureJobTitleNameFree(name, null)
          const copied: JobTitle = { ...source, id, name, builtIn: null, enabled: true }
          yield* insertJobTitle(copied)
          return copied
        })
      )
      yield* Effect.logInfo('Copied job title', { jobTitleId, copyId: id })
      return copy
    })

    const editJobTitle = Effect.fn('Org.editJobTitle')(function* (
      jobTitleId: JobTitleId,
      edit: JobTitleEdit
    ) {
      const jobTitle = yield* transaction(
        Effect.gen(function* () {
          const current = yield* findJobTitle(jobTitleId)
          if (edit.name !== undefined && edit.name !== current.name) {
            if (current.builtIn !== null) {
              return yield* BuiltInJobTitleRenamed.make({ jobTitleId })
            }
            yield* ensureJobTitleNameFree(edit.name, jobTitleId)
          }
          const edited: JobTitle = {
            ...current,
            ...edit,
            id: current.id,
            builtIn: current.builtIn,
            enabled: current.enabled
          }
          yield* updateJobTitle(edited)
          return edited
        })
      )
      yield* Effect.logInfo('Edited job title', { jobTitleId, fields: Object.keys(edit) })
      return jobTitle
    })

    const deleteJobTitle = Effect.fn('Org.deleteJobTitle')(function* (jobTitleId: JobTitleId) {
      yield* transaction(
        Effect.gen(function* () {
          const jobTitle = yield* findJobTitle(jobTitleId)
          if (jobTitle.builtIn !== null) {
            return yield* BuiltInJobTitleDeleted.make({ jobTitleId })
          }
          const hires = yield* sql<{
            readonly hires: number
          }>`SELECT count(*) AS hires FROM hired_agents WHERE job_title_id = ${jobTitleId}`
          const count = hires[0]?.hires ?? 0
          if (count > 0) {
            return yield* JobTitleHasHires.make({ jobTitleId, hires: count })
          }
          yield* sql`DELETE FROM job_titles WHERE job_title_id = ${jobTitleId}`
        })
      )
      yield* Effect.logInfo('Deleted job title', { jobTitleId })
    })

    const hire = Effect.fn('Org.hire')(function* (
      jobTitleId: JobTitleId,
      name: AgentName | null,
      reportsTo: HireId | null
    ) {
      const id = HiredAgent.fields.id.make(yield* newId)
      const hiredAt = yield* Clock.currentTimeMillis
      const hired = yield* transaction(
        Effect.gen(function* () {
          const jobTitle = yield* findJobTitle(jobTitleId)
          if (!jobTitle.enabled) {
            return yield* JobTitleDisabled.make({ jobTitleId })
          }
          if (jobTitle.builtIn === 'executive-assistant') {
            return yield* JobTitleNotHireable.make({ jobTitleId })
          }
          if (name !== null) {
            yield* ensureHireNameFree(name, null)
          }
          if (reportsTo !== null) {
            yield* findHire(reportsTo)
          }
          const agent = HiredAgent.make({
            id,
            jobTitleId,
            name,
            bypassOverride: null,
            reportsTo,
            hiredAt
          })
          yield* sql`INSERT INTO hired_agents ${sql.insert(toHireRow(agent))}`
          return agent
        })
      )
      yield* Effect.logInfo('Hired agent', { jobTitleId, hireId: id, reportsTo })
      return hired
    })

    const dismiss = Effect.fn('Org.dismiss')(function* (hireId: HireId) {
      const movedReports = yield* transaction(
        Effect.gen(function* () {
          const dismissed = yield* findHire(hireId)
          const openIssues = yield* openIssuesOf(hireId)
          if (openIssues > 0) {
            return yield* HireHasOpenIssues.make({ hireId, issues: openIssues })
          }
          const moved =
            yield* sql`UPDATE hired_agents SET reports_to = ${dismissed.reportsTo} WHERE reports_to = ${hireId} RETURNING hire_id`
          yield* sql`DELETE FROM hired_agents WHERE hire_id = ${hireId}`
          return moved.length
        })
      )
      yield* Effect.logInfo('Dismissed agent', { hireId, movedReports })
    })

    const renameHire = Effect.fn('Org.renameHire')(function* (
      hireId: HireId,
      name: AgentName | null
    ) {
      const renamed = yield* transaction(
        Effect.gen(function* () {
          const current = yield* findHire(hireId)
          if (name !== null) {
            yield* ensureHireNameFree(name, hireId)
          }
          const changed = HiredAgent.make({ ...current, name })
          yield* updateHire(changed)
          return changed
        })
      )
      yield* Effect.logInfo('Renamed hired agent', { hireId })
      return renamed
    })

    const setBypassOverride = Effect.fn('Org.setBypassOverride')(function* (
      hireId: HireId,
      override: boolean | null
    ) {
      const changed = yield* transaction(
        Effect.gen(function* () {
          const current = yield* findHire(hireId)
          const next = HiredAgent.make({ ...current, bypassOverride: override })
          yield* updateHire(next)
          return next
        })
      )
      yield* Effect.logInfo('Set bypass override', { hireId, override })
      return changed
    })

    const setReportsTo = Effect.fn('Org.setReportsTo')(function* (
      hireId: HireId,
      reportsTo: HireId | null
    ) {
      const changed = yield* transaction(
        Effect.gen(function* () {
          const current = yield* findHire(hireId)
          if (reportsTo !== null) {
            yield* findHire(reportsTo)
            if (reportsTo === hireId || descendantsOf(yield* hiredAgents, hireId).has(reportsTo)) {
              return yield* ReportsToCycle.make({ hireId, reportsTo })
            }
          }
          const next = HiredAgent.make({ ...current, reportsTo })
          yield* updateHire(next)
          return next
        })
      )
      yield* Effect.logInfo('Set reporting line', { hireId, reportsTo })
      return changed
    })

    const setOverallCap = Effect.fn('Org.setOverallCap')(function* (cap: OverallCap) {
      yield* sql`UPDATE org_settings SET overall_cap = ${cap}`.pipe(
        Effect.catchTag('SqlError', Effect.die)
      )
      yield* Effect.logInfo('Set overall cap', { overallCap: cap })
      return OrgSettings.make({ overallCap: cap })
    })

    return {
      jobTitles,
      hiredAgents,
      settings,
      setJobTitleEnabled,
      copyJobTitle,
      editJobTitle,
      deleteJobTitle,
      hire,
      dismiss,
      renameHire,
      setBypassOverride,
      setReportsTo,
      setOverallCap
    } satisfies Org
  })
