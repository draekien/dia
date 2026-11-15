import {
  offeredPermissionModes,
  PERMISSION_MODE_OPTIONS,
  PermissionModeItems,
  type PermissionModeOption,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  thinkingLevelLabel
} from '@dia/renderer-plugin'
import type { PermissionMode, ThinkingLevel } from '@shared/domain/pane'
import type React from 'react'
import {
  composerSettingTrigger,
  permissionSettingLabel,
  thinkingSettingLabel
} from './composer-settings'

/**
 * The composer's thinking-level picker: shows `value` and offers `levels`, calling `onChange` with
 * the level the user picks.
 */
export function ThinkingLevelSelect({
  value,
  levels,
  onChange
}: {
  value: ThinkingLevel
  levels: ReadonlyArray<ThinkingLevel>
  onChange: (level: ThinkingLevel) => void
}): React.JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger size="sm" aria-label="Thinking level" className={composerSettingTrigger()}>
        <SelectValue>{thinkingSettingLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {thinkingLevelLabel(level)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * The composer's permission-mode picker: shows `value` and offers `options` (every mode when
 * absent) except `disabledModes`, calling `onChange` with the mode the user picks.
 */
export function PermissionModeSelect({
  value,
  disabledModes,
  options = PERMISSION_MODE_OPTIONS,
  onChange
}: {
  value: PermissionMode
  disabledModes: ReadonlyArray<PermissionMode>
  options?: ReadonlyArray<PermissionModeOption<PermissionMode>>
  onChange: (mode: PermissionMode) => void
}): React.JSX.Element {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next)
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Permission mode"
        className={composerSettingTrigger({
          emphasis: value === 'bypassPermissions' ? 'foreground' : 'muted'
        })}
      >
        <SelectValue>{permissionSettingLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start">
        <PermissionModeItems options={offeredPermissionModes(options, disabledModes, value)} />
      </SelectContent>
    </Select>
  )
}
