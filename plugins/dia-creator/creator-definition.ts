import {
  type AgentDefinition,
  AgentDefinitionId,
  AgentDefinitionName,
  type AgentDefinitionRegistry
} from '@dia-plugin/dia-agent-definitions/registry'
import { Effect } from 'effect'

/** The run label that marks a Creator run and scopes the Creator-only dia tools to it. */
export const CREATOR_LABEL = 'dia-creator'

const JOB_DESCRIPTION = `You are Creator, an agent that changes dia itself. You build dia plugins and skills in the meta repo.

## Where you work
- Your current directory is your own git worktree of the meta repo, on its own branch. Make every change there.
- A dia plugin lives in plugins/<name>/ and a skill in plugin/skills/<name>/SKILL.md.
- Before you start, read the building-dia-plugins skill for a plugin or the writing-meta-skills skill for a skill.

## How you work
- Load a plugin you are writing with plugin_override, pointing it at its folder in your current directory, and reload it with plugin_reload after each change.
- Use plugin_list and plugin_inspect to read which plugins dia has, their state and their manifests.
- Commit every finished change on your branch with a one-line conventional commit message. The user reverts and merges your work commit by commit.
- Do not merge your branch. The user merges it from the thread.`

/**
 * The built-in Creator agent definition. Its model and thinking level choose a Creator run's
 * options; its job description is appended to the run's system prompt; its permissions allow the
 * five `plugin_*` dia tools, and file edits and shell commands follow the run's permission mode.
 */
export const CREATOR_DEFINITION: AgentDefinition = {
  id: AgentDefinitionId.make('0b6c2f57-8f0e-4d5e-9c6a-6a1c2e7f3d01'),
  name: AgentDefinitionName.make('Creator'),
  jobDescription: JOB_DESCRIPTION,
  skills: [],
  permissions: {
    allow: [
      'mcp__dia__plugin_list',
      'mcp__dia__plugin_inspect',
      'mcp__dia__plugin_override',
      'mcp__dia__plugin_reload',
      'mcp__dia__plugin_clear_override'
    ],
    ask: [],
    deny: []
  },
  mcpServers: [],
  bypassOptIn: false,
  selection: null,
  thinkingLevel: 'medium'
}

/**
 * Lists {@link CREATOR_DEFINITION} in `registry` as contributed by `plugin` until the calling
 * scope closes. When another definition holds its id or name, it logs a warning and lists nothing;
 * a Creator thread then cannot start.
 */
export const registerCreatorDefinition = (registry: AgentDefinitionRegistry, plugin: string) =>
  registry.register(CREATOR_DEFINITION, plugin).pipe(
    Effect.tap(() => Effect.logInfo('Creator agent definition registered')),
    Effect.catchTag('AgentDefinitionIdTaken', () =>
      Effect.logWarning('Another plugin holds the Creator definition id', {
        definitionId: CREATOR_DEFINITION.id
      })
    ),
    Effect.catchTag('AgentDefinitionNameTaken', () =>
      Effect.logWarning('Another definition is named Creator', {
        definitionId: CREATOR_DEFINITION.id
      })
    )
  )
