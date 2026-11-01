import { permissionModeLabel, thinkingLevelLabel } from '@dia/renderer-plugin'
import type { PermissionMode, ThinkingLevel } from '@shared/domain/pane'
import { cva } from 'class-variance-authority'

/**
 * Classes for a setting trigger on the line under the composer: borderless muted text, or
 * foreground weight with `emphasis: 'foreground'` for a setting the user should notice.
 */
export const composerSettingTrigger = cva(
  'gap-1 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent/50',
  {
    variants: {
      emphasis: {
        muted: 'text-muted-foreground',
        foreground: 'font-medium text-foreground'
      }
    },
    defaultVariants: { emphasis: 'muted' }
  }
)

/** The settings line text for a pane's thinking `level`, for example `Medium effort`. */
export const thinkingSettingLabel = (level: ThinkingLevel): string => {
  if (level === 'adaptive') return 'Adaptive thinking'
  if (level === 'off') return 'Thinking off'
  return `${thinkingLevelLabel(level)} effort`
}

/** The settings line text for a pane's permission `mode`, for example `Auto mode`. */
export const permissionSettingLabel = (mode: PermissionMode): string =>
  `${permissionModeLabel(mode)} mode`
