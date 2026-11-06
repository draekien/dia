# Org roles and hiring (#177)

Scope: module. A new built-in feature plugin, `plugins/org`, owns the org's roles, hired agents and org settings (ADR-0033) in its own SQLite database (ADR-0042). It provides them to the Host and other plugins as an `Org` service. It has no RPCs and no screens; #178 adds them. Out of scope: objectives, tasks and the scheduler (#179); the router role (org plan step 2); choosing a model per role (open question in `docs/prds/org.md`).

## Interface

### `src/shared/domain/org.ts` (platform-neutral, ADR-0013)

```ts
/** The built-in roles dia ships (ADR-0033, without `router`). A built-in role's name is its kind. */
export const BuiltInRole = Schema.Literals(['planner', 'engineer', 'reviewer', 'researcher', 'retro'])

/** Identifies a role; a UUID. */
export const RoleId = Uuid.pipe(Schema.brand('RoleId'))

/** A role's name: trimmed, 1 to 40 characters, unique across roles ignoring ASCII case. */
export const RoleName = Schema.Trimmed.pipe(Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(40)), Schema.brand('RoleName'))

/**
 * A role (ADR-0033). `builtIn` is the built-in kind, or null for a copy. A disabled role cannot be
 * hired into. `instructions` is appended to its sessions' system prompt; `skills` are skill names
 * as the Agent SDK's `Options.skills` takes them, empty meaning Claude Code's own skill set
 * (#179 then omits `Options.skills`: `sdk.d.ts` 0.3.311 lines 2330-2347, "omitted: … the CLI's
 * own defaults still apply", while `[]` would enable no skill);
 * `permissions` and `mcpServers` are what the role adds to a session (`RoleSessionOptions`,
 * #176); `bypassOptIn` is the role's `bypassPermissions` opt-in (ADR-0054).
 */
export const Role = Schema.Struct({
  id: RoleId,
  name: RoleName,
  builtIn: Schema.NullOr(BuiltInRole),
  enabled: Schema.Boolean,
  instructions: Schema.String,
  skills: Schema.Array(Schema.String),
  permissions: PermissionRules,
  mcpServers: Schema.Record(Schema.String, RoleMcpServer),
  bypassOptIn: Schema.Boolean
})

/**
 * A change to a role's editable fields; an absent field is left as it is. On a built-in role,
 * `name` is refused when it differs from the current name. The name-taken check ignores the role
 * being edited, so recasing a copy's own name is allowed.
 */
export const RoleEdit = Schema.Struct({
  name: Schema.optionalKey(RoleName),
  instructions: Schema.optionalKey(Schema.String),
  skills: Schema.optionalKey(Schema.Array(Schema.String)),
  permissions: Schema.optionalKey(PermissionRules),
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, RoleMcpServer)),
  bypassOptIn: Schema.optionalKey(Schema.Boolean)
})

/** Identifies a hired agent; a UUID. */
export const HireId = Uuid.pipe(Schema.brand('HireId'))

/**
 * A hired agent (ADR-0033): a role plus an optional name, unique when set. `bypassOverride`
 * overrides its role's `bypassOptIn` when not null. `hiredAt` is epoch milliseconds.
 */
export const HiredAgent = Schema.Struct({
  id: HireId,
  roleId: RoleId,
  name: Schema.NullOr(AgentName),
  bypassOverride: Schema.NullOr(Schema.Boolean),
  hiredAt: Schema.Number
})

/** The most hired agents that run at once across every role (ADR-0033); at least 1. */
export const OverallCap = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)), Schema.brand('OverallCap'))

/** The org's settings. */
export const OrgSettings = Schema.Struct({ overallCap: OverallCap })
```

Each schema is followed by `export type X = typeof X.Type`.

Errors, each `class X extends Schema.TaggedError<X>()('X', { ... })` (the form `ActivityNotFound` uses in `src/shared/domain/background-activity.ts`) with a JSDoc line naming when it fails, so #178 can send them over RPC: `RoleNotFound { roleId }`, `RoleNameTaken { roleName }`, `BuiltInRoleRenamed { roleId }`, `BuiltInRoleDeleted { roleId }`, `RoleHasHires { roleId, hires: Schema.Int }`, `RoleDisabled { roleId }`, `HireNotFound { hireId }`, `HireNameTaken { agentName }` (not `name`, which would shadow `Error.name`).

### `src/host/services/org-seam.ts` (exported from `@dia/plugin`)

```ts
/**
 * The org (ADR-0033), as the `org` plugin provides it under `ORG_KEY`. Reads return the current
 * state; each change is one transaction and returns the changed value. A role's cap is the number
 * of hired agents of that role. `roles` lists the built-in roles in seed order, then copies in creation order (ascending `rowid`); `hiredAgents` lists by `hiredAt`, then `rowid`. A database failure, or a failure to generate an id, is a defect.
 */
export interface Org {
  readonly roles: Effect.Effect<ReadonlyArray<Role>>
  readonly hiredAgents: Effect.Effect<ReadonlyArray<HiredAgent>>
  readonly settings: Effect.Effect<OrgSettings>
  readonly setRoleEnabled: (roleId: RoleId, enabled: boolean) => Effect.Effect<Role, RoleNotFound>
  readonly copyRole: (roleId: RoleId, name: RoleName) => Effect.Effect<Role, RoleNotFound | RoleNameTaken>
  readonly editRole: (roleId: RoleId, edit: RoleEdit) => Effect.Effect<Role, RoleNotFound | RoleNameTaken | BuiltInRoleRenamed>
  readonly deleteRole: (roleId: RoleId) => Effect.Effect<void, RoleNotFound | BuiltInRoleDeleted | RoleHasHires>
  readonly hire: (roleId: RoleId, name: AgentName | null) => Effect.Effect<HiredAgent, RoleNotFound | RoleDisabled | HireNameTaken>
  readonly dismiss: (hireId: HireId) => Effect.Effect<void, HireNotFound>
  readonly setOverallCap: (cap: OverallCap) => Effect.Effect<OrgSettings>
}
```

`ORG_KEY = 'org'` is added to `src/shared/plugin/api.ts` beside `META_REPO_KEY`. `org-seam.ts` imports its types from `@shared/domain/org`. A Host plugin imports runtime values only from `@dia/plugin` (root `CLAUDE.md`), so `src/host/plugin-api.ts` re-exports from `../shared/domain/org` every schema and error class `plugins/org` uses as a value (`Role`, `HiredAgent`, `OrgSettings`, `RoleName`, `OverallCap`, `RoleId`, `HireId`, the eight errors) and `type Org` from `./services/org-seam`. `ORG_KEY`, `orgMigrations`, `makeOrg`, every error class and every `Org` member carry JSDoc.

Each change runs in one `sql.withTransaction`: it reads the rows its checks need (role exists, is built in, is enabled, name free, hire count), returns the tagged error when a check fails, and otherwise writes. The table constraints are a backstop: a constraint `SqlError` there is a defect, so no error is derived by parsing SQLite's message text. Values are built with `Role.make`, `HiredAgent.make` and `OrgSettings.make`. Each change logs `Effect.logInfo` with the ids it touched. `hire` sets `hiredAt` from `Clock.currentTimeMillis`, so tests can fix it with `TestClock`.

`copyRole` copies every field except `id` (new), `name` (given) and `builtIn` (null); the copy is enabled. Hire names and role names are both unique ignoring ASCII case.

### `plugins/org`

| File | Holds |
| --- | --- |
| `plugin.json` | `{ "name": "org", "api": "0.0.19", "category": "feature", "host": "host.ts" }` (lazy: nothing reads `Org` at startup in #177; #179 revisits when sessions depend on it) |
| `host.ts` | setup: `ctx.database(orgMigrations)`, then `ctx.provide(ORG_KEY, yield* makeOrg)` with the `SqlClient` and `Crypto` provided; logs the role and hire counts |
| `migrations.ts` | `orgMigrations`: `1_create_org_tables`, `2_seed_org` |
| `built-in-roles.ts` | the five roles' fixed ids (UUID literals), instructions (with the shared execution contract) and deny lists, as agreed in #177's Understand phase; the `retro` hire's fixed id |
| `org.ts` | `makeOrg: Effect<Org, never, SqlClient \| Crypto>`; row encoding and decoding |

Tables (`1_create_org_tables`):

```sql
CREATE TABLE roles (
  role_id       TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  built_in      TEXT    UNIQUE CHECK (built_in IN ('planner','engineer','reviewer','researcher','retro')),
  enabled       INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  instructions  TEXT    NOT NULL,
  skills        TEXT    NOT NULL,  -- JSON array
  permissions   TEXT    NOT NULL,  -- JSON PermissionRules
  mcp_servers   TEXT    NOT NULL,  -- JSON record
  bypass_opt_in INTEGER NOT NULL CHECK (bypass_opt_in IN (0, 1))
);
CREATE TABLE hired_agents (
  hire_id         TEXT    PRIMARY KEY,
  role_id         TEXT    NOT NULL REFERENCES roles,  -- NO ACTION: deleting a role with hires fails
  name            TEXT    UNIQUE COLLATE NOCASE,  -- SQLite allows many NULLs in a UNIQUE column
  bypass_override INTEGER CHECK (bypass_override IN (0, 1)),
  hired_at        INTEGER NOT NULL
);
CREATE TABLE org_settings (
  singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
  overall_cap INTEGER NOT NULL CHECK (overall_cap >= 1)
);
```

`2_seed_org` inserts the five built-in roles under their fixed ids (enabled, empty `allow`/`ask`, no skills, no MCP servers, bypass off), one unnamed `retro` hire under its fixed id with `hired_at` from `Clock.currentTimeMillis`, and `overall_cap = 4`. A migration's requirement is `SqlClient` only (`PluginMigrations`, `src/shared/plugin/api.ts`), so it cannot use `Crypto`; `Clock` is a reference with a default. `makeOrg` requires `Crypto` for the ids of copies and later hires; `host.ts` provides it with `NodeServices.layer`. Because a migration runs once per database, a dismissed `retro` is never re-hired, and a later dia version adds a built-in role through a new migration.

## Design Rationale

**The seed is a migration**: ADR-0042's runner applies each key once and records it; a first-run flag would duplicate that record.

**`builtIn` kind, not the name, identifies a built-in role**: #181 starts `planner` by kind; names of copies can change, and built-in names are fixed so the kind and name never disagree.

**Checks are reads inside the change's transaction**: the plugin holds the only connection to its file, so a read and the write after it in one transaction see no other writer: `SqliteClient` serialises transactions on its one connection with a semaphore (`@effect/sql-sqlite-node` `SqliteClient.ts`), and every write here is a transaction. Reading avoids deriving `RoleNameTaken` or `RoleHasHires` from SQLite's message text; the constraints stay as a backstop.

**Built-in roles have fixed ids**: the seed migration cannot generate ids, and fixed ids are the same on every install, so tests and later issues can name a built-in role by id as well as by kind.

**Errors as schema classes**: #178 sends them over `DiaRpcs` unchanged.

**Interface in a seam file**: the `meta` plugin's `MetaRepo` sets the precedent (`src/host/services/meta-repo-seam.ts`); a plugin cannot be imported from `src/`, so the contract lives in the Host and the plugin implements it.

**JSON columns for lists and records**: they are read and written whole with their role, never queried by element.

## Tests

- `plugins/org/org.test.ts` against `openDatabase(':memory:', orgMigrations)`, imported by relative path from `src/host/services/database.ts` (tests are not shipped, so the `@dia/plugin`-only rule does not apply):
  - seed: five roles with their kinds, texts and deny lists; one `retro` hire; cap 4.
  - dismissing `retro` then re-running `orgMigrations` against the same file leaves no hire (temp-file database).
  - `setRoleEnabled`, `copyRole` (copy enabled, `builtIn` null, same instructions), `editRole` (field change; built-in rename refused; built-in edit with its unchanged name allowed; name clash refused, ignoring case; recasing a copy's own name allowed).
  - `deleteRole`: copy without hires deleted; built-in refused; copy with hires refused with its hire count.
  - `hire` / `dismiss`; hire into a disabled role refused; duplicate hire name refused, ignoring case; hires per role count.
  - `setOverallCap`.
  - order: a copy is listed after the built-in roles; hires are listed in hire order.
- `src/shared/domain/org.test.ts`: `RoleName` and `OverallCap` reject empty / over-length / 0.

## Refinement Record

**Round 1**

Applied
- *Correctness, 1 (blocker)*: a migration cannot use `Crypto`; built-in roles and the seeded `retro` hire get fixed UUID literals, `hired_at` from `Clock`.
- *Correctness, 2*: `Schema.TaggedErrorClass` does not exist in v4; errors use `Schema.TaggedError<X>()`.
- *Correctness, 3*: constraint-to-error mapping was unspecified. Checks are now reads inside the transaction; constraints are a backstop whose violation is a defect. (The finding's alternative, parsing `UniqueViolation.constraint`, was not taken: it depends on SQLite's message text.)
- *Correctness, 5*: NOCASE is ASCII-only; stated.
- *Correctness, 6, 7*: NULLs in UNIQUE and `NO ACTION` stated in the DDL.
- *Project rules, 8*: JSDoc on every export, `.make`, logging, `Schema.Int`, type imports stated.
- *Design, 9*: `hire` takes `AgentName | null`, matching `HiredAgent.name`.
- *Correctness, 10*: empty `skills` cites `sdk.d.ts`; #179 must omit `Options.skills` because `[]` enables none.

Rejected
- *Correctness, 4* (make the plugin eager): no code reads `Org` at startup in #177; eager would add the database open to every start before anything uses it. #179 revisits.

**Round 2**

Applied
- *Correctness and project rules, 1 (major)*: the plugin's runtime imports were unnamed; `plugin-api.ts` now re-exports every org schema and error the plugin uses as a value.
- *Correctness, 2*: transaction safety comes from `SqliteClient`'s semaphore on its one connection, not from `node:sqlite` being synchronous.
- *POLA, 3*: `editRole` with a built-in's unchanged name is allowed, and the name check ignores the edited role.
- *POLA, 4*: hire names are unique ignoring ASCII case, like role names.
- *Correctness, 5*: a failure to generate an id is a defect.
- *Project rules, 6*: the test imports `openDatabase` by relative path.

**Round 3**

Applied
- *Project rules, minor 1*: `hire` takes `hiredAt` from `Clock`.
- *POLA, minor 2*: `roles` and `hiredAgents` have a stated order, with a test.

Round 3 raised no blocker or major finding, so the rounds end here.
