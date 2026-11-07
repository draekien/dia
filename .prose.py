import re


def edit(path, pairs):
    with open(path, encoding='utf-8') as f:
        s = f.read()
    for a, b in pairs:
        if a not in s:
            raise SystemExit(f'no match in {path}: {a[:70]}')
        s = s.replace(a, b)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(s)


edit('plugins/org/domain.ts', [
    ('''/** The built-in roles dia ships (ADR-0033, without `router`). A built-in role's name is its kind. */
export const BuiltInJobTitle = Schema.Literals([
  'planner',
  'engineer',
  'reviewer',
  'researcher',
  'retro'
])''',
     '''/**
 * The kinds of the built-in job titles dia ships (ADR-0064; `router`, ADR-0053, is not one). A
 * built-in job title keeps its fixed name; its kind identifies it.
 */
export const BuiltInJobTitle = Schema.Literals([
  'product-manager',
  'software-engineer',
  'quality-engineer',
  'business-analyst',
  'ui-ux',
  'team-lead',
  'technical-lead'
])'''),
    ('/** Identifies a role; a UUID. Built-in roles have the same id on every install. */',
     '/** Identifies a job title; a UUID. Built-in job titles have the same id on every install. */'),
    (" * A role's name: trimmed, 1 to {@link JOB_TITLE_NAME_MAX_LENGTH} characters, unique across roles",
     " * A job title's name: trimmed, 1 to {@link JOB_TITLE_NAME_MAX_LENGTH} characters, unique across job titles"),
    ("/** A role's skills:", "/** A job title's skills:"),
    ("/** A role's MCP servers, keyed by server name. */", "/** A job title's MCP servers, keyed by server name. */"),
    (''' * A role (ADR-0033). `builtIn` is the built-in kind, or null for a copy. A disabled role cannot be
 * hired into. `jobDescription` is appended to its sessions' system prompt.''',
     ''' * A job title (ADR-0033, ADR-0064). `builtIn` is the built-in kind, or null for a copy. A disabled
 * job title cannot be hired into. `jobDescription` is appended to its sessions' system prompt.'''),
    (' * session of a role with no skills omits', ' * session of a job title with no skills omits'),
    (" * `permissions` and `mcpServers` are what the role adds to a session (`SessionToolOptions`);\n * `bypassOptIn` is the role's",
     " * `permissions` and `mcpServers` are what the job title adds to a session (`SessionToolOptions`);\n * `bypassOptIn` is the job title's"),
    (''' * A change to a role's editable fields; an absent field is left as it is. On a built-in role,
 * `name` is refused when it differs from the current name. The name-taken check ignores the role''',
     ''' * A change to a job title's editable fields; an absent field is left as it is. On a built-in job
 * title, `name` is refused when it differs from the current name. The name-taken check ignores the job title'''),
    (" * A hired agent (ADR-0033): a role plus an optional name,", " * A hired agent (ADR-0033): a job title plus an optional name,"),
    (" * `bypassOverride` overrides its role's `bypassOptIn`", " * `bypassOverride` overrides its job title's `bypassOptIn`"),
    ("across every role (ADR-0033)", "across every job title (ADR-0033)"),
    ("/** Failure of an `Org` change: no role has id `jobTitleId`. */", "/** Failure of an `Org` change: no job title has id `jobTitleId`. */"),
    ("/** Failure of copying or editing a role: another role already has `jobTitleName`, ignoring ASCII case. */",
     "/**\n * Failure of copying or editing a job title: another job title already has `jobTitleName`,\n * ignoring ASCII case.\n */"),
    ("/** Failure of editing a role: `jobTitleId` is a built-in role and the edit changes its name. */",
     "/** Failure of editing a job title: `jobTitleId` is built in and the edit changes its name. */"),
    ("/** Failure of deleting a role: `jobTitleId` is a built-in role, which can only be disabled. */",
     "/** Failure of deleting a job title: `jobTitleId` is built in, so it can only be disabled. */"),
    ("/** Failure of deleting a role: `hires` agents of role `jobTitleId` are still hired. */",
     "/** Failure of deleting a job title: `hires` agents of job title `jobTitleId` are still hired. */"),
    ("/** Failure of hiring: role `jobTitleId` is disabled. */", "/** Failure of hiring: job title `jobTitleId` is disabled. */"),
])

edit('plugins/org/service.ts', [
    (''' * current state; each change is one transaction and returns the changed value. A role's cap is the
 * number of hired agents of that role. `roles` lists the built-in roles in seed order, then copies''',
     ''' * current state; each change is one transaction and returns the changed value. A job title's cap is
 * the number of hired agents of that job title. `jobTitles` lists the built-in job titles in seed
 * order, then copies'''),
    ("into a new enabled role named `name` that is not", "into a new enabled job title named `name` that is not"),
    ("`hire` hires an agent of an enabled role,", "`hire` hires an agent of an enabled job title,"),
    ('  readonly roles: Effect.Effect<ReadonlyArray<JobTitle>>', '  readonly jobTitles: Effect.Effect<ReadonlyArray<JobTitle>>'),
    ('  roles: Effect.isEffect,', '  jobTitles: Effect.isEffect,'),
])

with open('plugins/org/org.ts', encoding='utf-8') as f:
    s = f.read()
s = s.replace('  jobDescription: JobTitle.fields.jobDescription,', '  job_description: JobTitle.fields.jobDescription,')
s = s.replace('  jobDescription: row.jobDescription,', '  jobDescription: row.job_description,')
s = s.replace('    jobDescription: role.jobDescription,', '    job_description: role.jobDescription,')
s = re.sub(r'\brole\b', 'jobTitle', s)
s = s.replace('  const roles = Effect.gen(', '  const jobTitles = Effect.gen(')
s = s.replace('\n    roles,\n', '\n    jobTitles,\n')
for a, b in [("'Set role enabled'", "'Set job title enabled'"), ("'Copied role'", "'Copied job title'"),
             ("'Edited role'", "'Edited job title'"), ("'Deleted role'", "'Deleted job title'")]:
    assert a in s, a
    s = s.replace(a, b)
with open('plugins/org/org.ts', 'w', encoding='utf-8', newline='\n') as f:
    f.write(s)

edit('plugins/org/host.ts', [
    ('    const roles = yield* org.roles\n', '    const jobTitles = yield* org.jobTitles\n'),
    ('      roles: roles.length,', '      jobTitles: jobTitles.length,'),
])

edit('plugins/example/host.ts', [
    ('    const roleCount = yield* Ref.make(Option.none<number>())', '    const jobTitleCount = yield* Ref.make(Option.none<number>())'),
    ('''        const roles = yield* org.roles
        yield* Ref.set(roleCount, Option.some(roles.length))
        yield* Effect.addFinalizer(() => Ref.set(roleCount, Option.none()))
        yield* Effect.logInfo('Example plugin read the org', { roles: roles.length })''',
     '''        const jobTitles = yield* org.jobTitles
        yield* Ref.set(jobTitleCount, Option.some(jobTitles.length))
        yield* Effect.addFinalizer(() => Ref.set(jobTitleCount, Option.none()))
        yield* Effect.logInfo('Example plugin read the org', { jobTitles: jobTitles.length })'''),
    ('      Ref.get(roleCount).pipe(', '      Ref.get(jobTitleCount).pipe('),
    ("host entry · ${count} roles`", "host entry · ${count} job titles`"),
])
