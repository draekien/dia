# `supportedCommands()` lists only the command that runs

**Date:** 2026-10-31

## Context

A code review of #76 (PR #101) found that the slash menu keys rows by `command.name`, and that the SDK's `SlashCommand.builtin` JSDoc says "Rows can share a name". The review concluded that two rows could repeat a React key, and that the built-in row runs when they do. Both claims came from the JSDoc. Neither had been observed.

## Reasoning / Learning

A probe with `@anthropic-ai/claude-agent-sdk` 0.3.311 (`settingSources: ['user', 'project', 'local']`) showed:

| Project | `supportedCommands()` | `/context` runs |
| --- | --- | --- |
| `F:/Dev/dia`, with the user's plugins | 125 commands, 52 with `builtin: true`, no repeated name; `context` has `builtin: true` | the built-in |
| A scratch project with `.claude/skills/context/SKILL.md` | 119 commands, 51 with `builtin: true`, no repeated name; `context` is the project skill, with no `builtin` field | the project skill (`result success "SKILL-RAN"`) |

- A custom skill with a built-in name replaces the built-in, and the built-in row is removed from the list rather than marked. The [slash commands page](https://code.claude.com/docs/en/slash-commands.md) ("Resolve skills that share a name") states the same for a terminal session: "your skill replaces the built-in command, but not its aliases", and "Enterprise over personal, and personal over project". The Agent SDK page does not state the order; the probe is the SDK evidence.
- Which setup makes `supportedCommands()` return two rows with one name is unknown. None of the setups above did.
- Git Bash rewrites a `/context` argument to `C:/Program Files/Git/context`. Run such a probe with `MSYS_NO_PATHCONV=1`.

## Implication

- `key={command.name}` in `plugins/chat/slash-command-menu.tsx` is unique for every list observed. Do not change it to an index key on the strength of the JSDoc alone; reproduce a repeated name first.
- The slash menu cannot show a shadowed command, because the list does not contain it. Finding shadowed commands needs the skill locations and the built-in names compared directly (#108).
