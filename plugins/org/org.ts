import type { AgentName } from '@dia/plugin'
import type {
  AgentDefinition,
  AgentDefinitionNameTaken,
  AgentDefinitionNotFound,
  AgentDefinitionRegistry,
  ContributedDefinitionRenamed
} from '@dia-plugin/agent-definitions/registry'
import { Clock, Crypto, Effect, Option, PubSub, Ref, Schema, Semaphore, Stream } from 'effect'
import { SqlClient, type SqlError } from 'effect/sql'
import { BUILT_IN_DEFINITIONS, BUILT_IN_KIND_BY_ID } from './built-in-job-titles'
import {
  BuiltInJobTitleDeleted,
  BuiltInJobTitleRenamed,
  descendantsOf,
  HiredAgent,
  HireHasOpenIssues,
  type HireId,
  HireNameTaken,
  HireNotFound,
  IssuesNotLoaded,
  type JobTitle,
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
import type { HeldIssues, Org } from './service'

const HireRow = Schema.Struct({
  hire_id: HiredAgent.fields.id,
  job_title_id: HiredAgent.fields.jobTitleId,
  name: HiredAgent.fields.name,
  bypass_override: Schema.NullOr(Schema.BooleanFromBit),
  reports_to: HiredAgent.fields.reportsTo,
  hired_at: HiredAgent.fields.hiredAt
})

const SettingsRow = Schema.Struct({ overall_cap: OrgSettings.fields.overallCap })

const JobTitleSettingsRow = Schema.Struct({
  job_title_id: Schema.String,
  enabled: Schema.BooleanFromBit
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

const decodeHireRows = rowsDecoder(HireRow)
const decodeSettingsRows = rowsDecoder(SettingsRow)
const decodeJobTitleSettingsRows = rowsDecoder(JobTitleSettingsRow)

const BUILT_IN_ORDER: ReadonlyMap<string, number> = new Map(
  BUILT_IN_DEFINITIONS.map((definition, index) => [definition.id, index])
)

const listOrder = (left: JobTitle, right: JobTitle): number => {
  const leftIndex = BUILT_IN_ORDER.get(left.id) ?? BUILT_IN_ORDER.size
  const rightIndex = BUILT_IN_ORDER.get(right.id) ?? BUILT_IN_ORDER.size
  if (leftIndex !== rightIndex) return leftIndex - rightIndex
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

const toJobTitle = (definition: AgentDefinition, enabled: boolean): JobTitle => ({
  ...definition,
  builtIn: BUILT_IN_KIND_BY_ID.get(definition.id) ?? null,
  enabled
})

const fromRegistry = <A>(
  jobTitleId: JobTitleId,
  effect: Effect.Effect<
    A,
    AgentDefinitionNameTaken | AgentDefinitionNotFound | ContributedDefinitionRenamed
  >
) =>
  effect.pipe(
    Effect.catchTag('AgentDefinitionNameTaken', (error) =>
      Effect.fail(JobTitleNameTaken.make({ jobTitleName: error.name }))
    ),
    Effect.catchTag('AgentDefinitionNotFound', () =>
      Effect.fail(JobTitleNotFound.make({ jobTitleId }))
    ),
    Effect.catchTag('ContributedDefinitionRenamed', () =>
      Effect.fail(BuiltInJobTitleRenamed.make({ jobTitleId }))
    )
  )

/**
 * Builds the {@link Org} over the `org` plugin's database, which `orgMigrations` must already have
 * migrated. The job titles are the agent definitions of the registry `holdDefinitions` holds;
 * while none is held, there are none. `dismiss` counts open issues through the issues
 * `holdIssues` holds. Call it once in the plugin's setup and provide the result under
 * `OrgService`.
 */
export const makeOrg = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const crypto = yield* Crypto.Crypto
  const jobTitleChanges = yield* PubSub.unbounded<void>()
  const publishJobTitleChange = PubSub.publish(jobTitleChanges, undefined)
  const hireChanges = yield* PubSub.unbounded<void>()
  const publishHireChange = PubSub.publish(hireChanges, undefined)
  const heldIssues = yield* Ref.make(Option.none<HeldIssues>())
  const definitions = yield* Ref.make(Option.none<AgentDefinitionRegistry>())
  const hireLock = yield* Semaphore.make(1)

  const transaction = <A, E>(effect: Effect.Effect<A, E | SqlError.SqlError>) =>
    sql.withTransaction(effect).pipe(Effect.catchTag('SqlError', Effect.die))
  const orDie = <A>(effect: Effect.Effect<A, SqlError.SqlError>) =>
    effect.pipe(Effect.catchTag('SqlError', Effect.die))

  const newId = crypto.randomUUIDv4().pipe(Effect.orDie)

  const jobTitles = Effect.gen(function* () {
    const registry = yield* Ref.get(definitions)
    if (Option.isNone(registry)) return []
    const listed = yield* registry.value.list
    const settings = yield* decodeJobTitleSettingsRows(
      yield* orDie(sql`SELECT job_title_id, enabled FROM job_title_settings`)
    )
    const enabled = new Map(settings.map((row) => [row.job_title_id, row.enabled]))
    return listed
      .map(({ definition }) => toJobTitle(definition, enabled.get(definition.id) ?? true))
      .sort(listOrder)
  })

  const findJobTitle = Effect.fnUntraced(function* (jobTitleId: JobTitleId) {
    const jobTitle = (yield* jobTitles).find((candidate) => candidate.id === jobTitleId)
    if (jobTitle === undefined) {
      return yield* JobTitleNotFound.make({ jobTitleId })
    }
    return jobTitle
  })

  const registryFor = Effect.fnUntraced(function* (jobTitleId: JobTitleId) {
    const registry = yield* Ref.get(definitions)
    if (Option.isNone(registry)) {
      return yield* JobTitleNotFound.make({ jobTitleId })
    }
    return registry.value
  })

  const holdDefinitions = (registry: AgentDefinitionRegistry) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Ref.set(definitions, Option.some(registry)).pipe(
          Effect.andThen(publishJobTitleChange),
          Effect.andThen(Effect.logDebug('Org holds the agent definition registry'))
        ),
        () =>
          Ref.set(definitions, Option.none()).pipe(
            Effect.andThen(publishJobTitleChange),
            Effect.andThen(Effect.logDebug('Org released the agent definition registry'))
          )
      )
      yield* registry.changes.pipe(
        Stream.runForEach(() => publishJobTitleChange),
        Effect.forkScoped
      )
    })

  const holdIssues = (issues: HeldIssues) =>
    Effect.acquireRelease(
      Ref.set(heldIssues, Option.some(issues)).pipe(
        Effect.andThen(Effect.logDebug('Org holds the issues of its hired agents'))
      ),
      () =>
        Ref.set(heldIssues, Option.none()).pipe(
          Effect.andThen(Effect.logDebug('Org released the issues of its hired agents'))
        )
    ).pipe(Effect.asVoid)

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
    const jobTitle = yield* findJobTitle(jobTitleId)
    yield* orDie(sql`INSERT INTO job_title_settings (job_title_id, enabled)
        VALUES (${jobTitleId}, ${enabled ? 1 : 0})
        ON CONFLICT (job_title_id) DO UPDATE SET enabled = excluded.enabled`)
    yield* publishJobTitleChange
    yield* Effect.logInfo('Set job title enabled', { jobTitleId, enabled })
    return { ...jobTitle, enabled }
  })

  const copyJobTitle = Effect.fn('Org.copyJobTitle')(function* (
    jobTitleId: JobTitleId,
    name: JobTitleName
  ) {
    const {
      id: _id,
      builtIn: _builtIn,
      enabled: _enabled,
      ...fields
    } = yield* findJobTitle(jobTitleId)
    const registry = yield* registryFor(jobTitleId)
    const created = yield* registry
      .create({ ...fields, name })
      .pipe(
        Effect.catchTag('AgentDefinitionNameTaken', (error) =>
          Effect.fail(JobTitleNameTaken.make({ jobTitleName: error.name }))
        )
      )
    yield* Effect.logInfo('Copied job title', { jobTitleId, copyId: created.id })
    return toJobTitle(created, true)
  })

  const editJobTitle = Effect.fn('Org.editJobTitle')(function* (
    jobTitleId: JobTitleId,
    edit: JobTitleEdit
  ) {
    const current = yield* findJobTitle(jobTitleId)
    const registry = yield* registryFor(jobTitleId)
    const edited = yield* fromRegistry(jobTitleId, registry.edit(jobTitleId, edit))
    yield* Effect.logInfo('Edited job title', { jobTitleId, fields: Object.keys(edit) })
    return toJobTitle(edited, current.enabled)
  })

  const deleteJobTitle = Effect.fn('Org.deleteJobTitle')(function* (jobTitleId: JobTitleId) {
    yield* hireLock.withPermits(1)(
      Effect.gen(function* () {
        const jobTitle = yield* findJobTitle(jobTitleId)
        if (jobTitle.builtIn !== null) {
          return yield* BuiltInJobTitleDeleted.make({ jobTitleId })
        }
        const hires = yield* orDie(
          sql<{
            readonly hires: number
          }>`SELECT count(*) AS hires FROM hired_agents WHERE job_title_id = ${jobTitleId}`
        )
        const count = hires[0]?.hires ?? 0
        if (count > 0) {
          return yield* JobTitleHasHires.make({ jobTitleId, hires: count })
        }
        const registry = yield* registryFor(jobTitleId)
        yield* registry.delete(jobTitleId).pipe(
          Effect.catchTag('AgentDefinitionNotFound', () =>
            Effect.fail(JobTitleNotFound.make({ jobTitleId }))
          ),
          Effect.catchTag('ContributedDefinitionDeleted', () =>
            Effect.fail(BuiltInJobTitleDeleted.make({ jobTitleId }))
          )
        )
        yield* orDie(sql`DELETE FROM job_title_settings WHERE job_title_id = ${jobTitleId}`)
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
    const hired = yield* hireLock.withPermits(1)(
      Effect.gen(function* () {
        const jobTitle = yield* findJobTitle(jobTitleId)
        if (!jobTitle.enabled) {
          return yield* JobTitleDisabled.make({ jobTitleId })
        }
        if (jobTitle.builtIn === 'executive-assistant') {
          return yield* JobTitleNotHireable.make({ jobTitleId })
        }
        return yield* transaction(
          Effect.gen(function* () {
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
      })
    )
    yield* publishHireChange
    yield* Effect.logInfo('Hired agent', { jobTitleId, hireId: id, reportsTo })
    return hired
  })

  const dismiss = Effect.fn('Org.dismiss')(function* (hireId: HireId) {
    const issues = yield* Ref.get(heldIssues)
    const movedReports = yield* transaction(
      Effect.gen(function* () {
        const dismissed = yield* findHire(hireId)
        if (Option.isNone(issues)) return yield* IssuesNotLoaded.make({})
        const openIssues = yield* issues.value.countOpenIssues(hireId)
        if (openIssues > 0) {
          return yield* HireHasOpenIssues.make({ hireId, issues: openIssues })
        }
        const moved =
          yield* sql`UPDATE hired_agents SET reports_to = ${dismissed.reportsTo} WHERE reports_to = ${hireId} RETURNING hire_id`
        yield* sql`DELETE FROM hired_agents WHERE hire_id = ${hireId}`
        return moved.length
      })
    )
    yield* publishHireChange
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
    yield* publishHireChange
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
    watchJobTitleChanges: Effect.map(PubSub.subscribe(jobTitleChanges), Stream.fromSubscription),
    holdDefinitions,
    watchHireChanges: Effect.map(PubSub.subscribe(hireChanges), Stream.fromSubscription),
    holdIssues,
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
