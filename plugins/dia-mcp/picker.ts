import { ServiceKey } from '@dia/plugin'
import type { ComponentType } from 'react'

/**
 * Props of the MCP server picker. `label` is the accessible name of its search box; the picker's
 * search box takes no external `<label htmlFor>`. `value` is the chosen server names; a chosen
 * name the registry lacks is listed as `<name> (missing)`. `onChange` receives the next list.
 */
export interface McpServerPickerProps {
  readonly label: string
  readonly value: ReadonlyArray<string>
  readonly onChange: (value: ReadonlyArray<string>) => void
}

/**
 * The MCP server picker the `mcp` plugin provides. Read it with `useProvided(McpServerPickerKey)`;
 * it is `undefined` while no plugin provides it.
 */
export const McpServerPickerKey = ServiceKey.make(
  'mcpServerPicker',
  (value): value is ComponentType<McpServerPickerProps> => typeof value === 'function'
)
