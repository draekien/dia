---
name: writing-meta-skills
description: Write or change a skill that dia loads into every agent it starts, in the meta repo's plugin/skills folder. Use when asked to teach every dia agent a procedure, add a skill to dia, or fix a skill dia ships to its agents.
---

# Writing meta skills

Scope: skills in the meta repo, the git repository that holds this `SKILL.md` at `plugin/skills/writing-meta-skills/`. dia loads the meta repo's `plugin/` folder as a Claude Code plugin named `dia-meta` into every agent session it starts, so every skill in `plugin/skills/` reaches every agent as `dia-meta:<skill name>`.

## Skill folder

A skill is a folder in `plugin/skills/` that holds a `SKILL.md`. The folder name is the skill name.

```
plugin/skills/
└── reviewing-migrations/
    ├── SKILL.md
    └── references/
        └── checklist.md
```

- Name the folder with lowercase letters, digits and hyphens, for example `reviewing-migrations`.
- Put material the agent reads only for some tasks in files beside `SKILL.md`, for example `references/checklist.md`, and name each file in `SKILL.md` with the task it serves.
- dia writes `building-dia-plugins/SKILL.md` and `writing-meta-skills/SKILL.md` only when they are missing, so an edit to either is kept. dia rewrites `building-dia-plugins/references/api.md` whenever the installed dia exports a different API; do not edit that file.

## SKILL.md

```markdown
---
name: reviewing-migrations
description: Check a database migration for data loss and locking before it runs. Use when asked to write, review or run a SQL migration.
---

# Reviewing migrations

1. Read the migration and list each table it changes.
2. For each dropped or narrowed column, find the code that reads it.
```

| Field | Rule |
| --- | --- |
| `name` | The folder name. |
| `description` | One sentence saying what the skill does, then `Use when` and the requests that should load it. An agent sees only `name` and `description` until it loads the skill, so name the words a user would type. |

- Write each step as an instruction the agent can carry out: name the file, command or tool.
- Keep `SKILL.md` to what every use of the skill needs.

## When a skill takes effect

An agent session reads the meta repo's skills when it starts. A session that is already running does not see a new or changed skill.

## Commit

Commit every finished skill change with a one-line conventional commit message, for example `docs(skills): add reviewing-migrations`.
