import type { ModelOption } from '@shared/domain/model'
import { EffortLevel, type ThinkingLevel } from '@shared/domain/pane'

const LABELS: Record<ThinkingLevel, string> = {
  adaptive: 'Adaptive',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max'
}

const MENU_ORDER: ReadonlyArray<ThinkingLevel> = ['adaptive', 'off', ...EffortLevel.literals]

const LEVELS_FOR_UNKNOWN_MODEL: ReadonlyArray<ThinkingLevel> = [
  'adaptive',
  'off',
  'low',
  'medium',
  'high'
]

/** The menu label of `level`. */
export const thinkingLevelLabel = (level: ThinkingLevel): string => LABELS[level]

/**
 * The thinking levels to offer for `model`, in menu order: `off`, plus `adaptive` and the model's
 * effort levels when it can think adaptively. When `model` is `undefined` (the list is not loaded
 * or does not include it) it returns `adaptive`, `off`, `low`, `medium` and `high`.
 */
export const thinkingLevelsFor = (model: ModelOption | undefined): ReadonlyArray<ThinkingLevel> => {
  if (model === undefined) return LEVELS_FOR_UNKNOWN_MODEL
  return MENU_ORDER.filter(
    (level) =>
      level === 'off' ||
      (model.adaptiveThinking &&
        (level === 'adaptive' || model.effortLevels.some((effort) => effort === level)))
  )
}

/**
 * `level` when `offered` includes it. Otherwise the highest offered effort below `level` (as
 * Claude Code itself lowers an unsupported effort), then `adaptive`, then `off`. `offered` comes
 * from {@link thinkingLevelsFor} and always includes `off`.
 */
export const fitThinkingLevel = (
  level: ThinkingLevel,
  offered: ReadonlyArray<ThinkingLevel>
): ThinkingLevel => {
  if (offered.includes(level)) return level
  const efforts: ReadonlyArray<ThinkingLevel> = EffortLevel.literals
  const lower = efforts.slice(0, Math.max(efforts.indexOf(level), 0)).reverse()
  return (
    lower.find((effort) => offered.includes(effort)) ??
    (offered.includes('adaptive') ? 'adaptive' : 'off')
  )
}
