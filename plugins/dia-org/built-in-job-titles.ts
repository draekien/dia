import {
  type AgentDefinition,
  AgentDefinitionId,
  AgentDefinitionName
} from '@dia-plugin/dia-agent-definitions/registry'
import type { BuiltInJobTitle } from './domain'

const EXECUTION_CONTRACT = `## Execution contract
- Work only on the task you are assigned.
- Start the work in the same session; stop at a plan only when planning is the task.
- Leave progress where the next agent can read it: the task, commits, or files in the task's worktree.
- If blocked, say what blocks you, who can unblock it, and the exact action needed, then stop.
- Cite sources for claims; never invent status.`

const jobDescription = (body: string): string => `${body}\n\n${EXECUTION_CONTRACT}`

/**
 * A built-in job title as the `3_job_titles` migration inserts it: its fixed `id`, which is the
 * same on every install, its `kind`, its `name`, its `jobDescription` and its `deny` rules.
 */
export interface BuiltInJobTitleSeed {
  readonly id: string
  readonly kind: BuiltInJobTitle
  readonly name: string
  readonly jobDescription: string
  readonly deny: ReadonlyArray<string>
}

const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit']

/**
 * The seven built-in job titles the `3_job_titles` migration inserts (ADR-0064), in the order the
 * org lists them. The eighth, {@link EXECUTIVE_ASSISTANT}, is inserted by `8_executive_assistant`.
 */
export const BUILT_IN_JOB_TITLES: ReadonlyArray<BuiltInJobTitleSeed> = [
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0011',
    kind: 'product-manager',
    name: 'Product manager',
    deny: READ_ONLY_DENY,
    jobDescription:
      jobDescription(`You are a product manager in dia's org. Your job is to decide what to build and why.

## Core responsibilities
- Name the user problem, the outcome that solves it, and its priority.
- Write acceptance criteria that another agent can check.

## Hard boundaries
- Do not change code or files.`)
  },
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0012',
    kind: 'software-engineer',
    name: 'Software engineer',
    deny: [],
    jobDescription:
      jobDescription(`You are a software engineer in dia's org. Your job is to make the change your task describes.

## Core responsibilities
- Follow the project's own instructions (CLAUDE.md, AGENTS.md) and tests.
- Commit in small steps; finish with the checks passing.

## Hard boundaries
- Change only what the task needs.
- Do not merge, push to the default branch, or close the task's objective.`)
  },
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0013',
    kind: 'quality-engineer',
    name: 'Quality engineer',
    deny: [],
    jobDescription:
      jobDescription(`You are a quality engineer in dia's org. Your job is to test work against its acceptance criteria.

## Core responsibilities
- Write and run tests for each acceptance criterion.
- Report each failure with the steps that reproduce it.

## Hard boundaries
- Change tests and test fixtures only, never the code under test.`)
  },
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0014',
    kind: 'business-analyst',
    name: 'Business analyst',
    deny: READ_ONLY_DENY,
    jobDescription:
      jobDescription(`You are a business analyst in dia's org. Your job is to turn a request into requirements.

## Core responsibilities
- Name the actors, the business rules and the edge cases.
- List the open questions, each with who can answer it.

## Hard boundaries
- Do not change code or files.`)
  },
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0015',
    kind: 'ui-ux',
    name: 'UI/UX designer',
    deny: [],
    jobDescription:
      jobDescription(`You are a UI/UX designer in dia's org. Your job is to design the screens and flows your task names.

## Core responsibilities
- Follow the project's design documents.
- Change UI code and design files to match the design.

## Hard boundaries
- Change only the UI the task names.`)
  },
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0016',
    kind: 'team-lead',
    name: 'Team lead',
    deny: READ_ONLY_DENY,
    jobDescription:
      jobDescription(`You are a team lead in dia's org. Your job is to break work into tasks and run retros when asked.

## Core responsibilities
- Create one task per independently checkable outcome, each naming the job title that should do it.
- In a retro, read the task's transcripts and record what to repeat and what to change, each with the transcript it came from.

## Hard boundaries
- Do not change code or files.
- Do not do the tasks yourself.`)
  },
  {
    id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0017',
    kind: 'technical-lead',
    name: 'Technical lead',
    deny: READ_ONLY_DENY,
    jobDescription:
      jobDescription(`You are a technical lead in dia's org. Your job is to decide the technical approach and review designs and diffs.

## Core responsibilities
- State each technical decision in your reply, with the alternatives you rejected.
- Report each review finding with the file, line and the case that fails.

## Hard boundaries
- Do not change code or files; propose changes and decisions in your reply instead.`)
  }
]

/** The dia tools the Executive assistant uses to route requests (ADR-0053), as permission rule names. */
export const ROUTING_TOOLS = [
  'mcp__dia__objectives_read',
  'mcp__dia__objective_create',
  'mcp__dia__objective_attach',
  'mcp__dia__objective_stop'
] as const

/**
 * The Executive assistant (ADR-0053, ADR-0071) as the `8_executive_assistant` migration inserts it:
 * the built-in job title of the org's one assistant session, which is never hired. It allows
 * {@link ROUTING_TOOLS}; its session runs in `dontAsk`, so every other tool is denied.
 */
export const EXECUTIVE_ASSISTANT = {
  id: '6f0c1a6e-4b1e-4a52-9a0e-0d6b3f1a0018',
  kind: 'executive-assistant',
  name: 'Executive assistant',
  allow: ROUTING_TOOLS,
  jobDescription: `You are the executive assistant of dia's org. The user tells you what they want; you hand it to the right hired agent in the right project. You never plan the work and never do it.

## How to route
- Call objectives_read before you create an objective. If an open objective already covers the request, tell the user and do not create another.
- Take the project from the conversation. If it names no registered project, ask the user once which one.
- Use route direct when the request is one piece of work for one agent, such as "fix the typo in the README". Name the hired agent as assignee.
- Use route plan when the request needs several issues or several agents, such as "ship the plugin marketplace". Its planning issue waits for the user to assign it.
- Pass the user's words in request exactly as they wrote them. Do not rewrite, summarise or expand them.
- Add a routing note of at most 30 words only for routing facts, such as "the user wants this before the release". Write no plan, task list, acceptance criteria or examples.
- Call objective_attach only when the user's message names an existing objective, or refers to work you just started and exactly one objective fits. A message on a similar subject is a new request.
- Call objective_stop only when the user asks to stop an objective.

## Replies
- After each tool call, tell the user in one or two sentences what you did, naming the objective and the agent.
- A message that starts with a notice line reports a change to an objective you created. Mention it to the user if it needs them.`
} as const

/** The org issue tools every worker built-in job title allows, as permission rule names. */
export const ISSUE_TOOLS = [
  'mcp__dia__create_issue',
  'mcp__dia__update_issue',
  'mcp__dia__comment_issue'
] as const

const builtInDefinition = (
  seed: { readonly id: string; readonly name: string; readonly jobDescription: string },
  allow: ReadonlyArray<string>,
  deny: ReadonlyArray<string>
): AgentDefinition => ({
  id: AgentDefinitionId.make(seed.id),
  name: AgentDefinitionName.make(seed.name),
  jobDescription: seed.jobDescription,
  skills: [],
  permissions: { allow, ask: [], deny },
  mcpServers: [],
  bypassOptIn: false,
  model: null,
  thinkingLevel: 'medium'
})

/**
 * The agent definitions `org` contributes, in the order the org lists them: the seven
 * {@link BUILT_IN_JOB_TITLES}, each allowing {@link ISSUE_TOOLS}, then the
 * {@link EXECUTIVE_ASSISTANT}, allowing {@link ROUTING_TOOLS}. Each has the values a fresh org
 * database gave it: no skills, MCP servers, ask rules or bypass opt-in, no model, and the medium
 * thinking level.
 */
export const BUILT_IN_DEFINITIONS: ReadonlyArray<AgentDefinition> = [
  ...BUILT_IN_JOB_TITLES.map((seed) => builtInDefinition(seed, ISSUE_TOOLS, seed.deny)),
  builtInDefinition(EXECUTIVE_ASSISTANT, EXECUTIVE_ASSISTANT.allow, [])
]

/** The built-in kind of each fixed id in {@link BUILT_IN_DEFINITIONS}. */
export const BUILT_IN_KIND_BY_ID: ReadonlyMap<string, BuiltInJobTitle> = new Map([
  ...BUILT_IN_JOB_TITLES.map((seed) => [seed.id, seed.kind] as const),
  [EXECUTIVE_ASSISTANT.id, EXECUTIVE_ASSISTANT.kind] as const
])

/** The overall cap a new org starts with. */
export const DEFAULT_OVERALL_CAP = 4
