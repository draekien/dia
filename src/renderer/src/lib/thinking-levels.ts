import type { ThinkingLevel } from '@shared/domain/pane'

/**
 * The selectable thinking levels paired with their human-readable labels, in
 * menu order. Use to render the thinking-level `Select` in both the pane
 * creation form and the live pane header.
 */
export const THINKING_LEVEL_OPTIONS: ReadonlyArray<{
  readonly value: ThinkingLevel
  readonly label: string
}> = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]
