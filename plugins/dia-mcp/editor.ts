import { ServiceKey } from '@dia/plugin'
import type { ComponentType } from 'react'
import type { McpServersDraft } from './servers'

/**
 * Props of the MCP servers editor. `id` is the id of the control a `<label htmlFor>` names.
 * `draft` is the value shown; `onChange` receives each edit. `error` is shown under the control
 * and marks it invalid.
 */
export interface McpServersEditorProps {
  readonly id: string
  readonly draft: McpServersDraft
  readonly onChange: (draft: McpServersDraft) => void
  readonly error?: string
}

/**
 * The MCP servers editor the mcp plugin provides. Read it with
 * `useProvided(McpServersEditorKey)`; it is `undefined` while no plugin provides it.
 */
export const McpServersEditorKey = ServiceKey.make(
  'mcpServersEditor',
  (value): value is ComponentType<McpServersEditorProps> => typeof value === 'function'
)
