import { ServiceKey } from '@dia/plugin'
import type { ComponentType } from 'react'

/**
 * Props of the skill picker. `label` is the accessible name of its search box; the picker's
 * search box takes no external `<label htmlFor>`. `value` is the chosen skill names, as
 * `Options.skills` takes them; `onChange` receives the next list. `cwd`, when set, adds the skills
 * of the project at that directory.
 */
export interface SkillPickerProps {
  readonly label: string
  readonly value: ReadonlyArray<string>
  readonly onChange: (value: ReadonlyArray<string>) => void
  readonly cwd?: string
}

/**
 * The skill picker the skills plugin provides. Read it with `useProvided(SkillPickerKey)`; it is
 * `undefined` while no plugin provides it.
 */
export const SkillPickerKey = ServiceKey.make(
  'skillPicker',
  (value): value is ComponentType<SkillPickerProps> => typeof value === 'function'
)
