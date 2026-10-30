import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { sendModeAtom } from '@renderer/lib/send-mode-atom'
import { usageLimitResumeAtom } from '@renderer/lib/usage-limit-resume-atom'
import type { SendMode } from '@shared/domain/message-queue'
import type { UsageLimitResume } from '@shared/domain/parking'
import type { ThemePreference } from '@shared/domain/theme'
import {
  CornerDownRightIcon,
  HandIcon,
  ListEndIcon,
  MonitorIcon,
  MoonIcon,
  PlayIcon,
  SunIcon
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useTheme } from '../theme-provider'
import { TranscriptWidthToggle } from '../transcript-width-toggle'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'

interface ChoiceItem<Value extends string> {
  readonly value: Value
  readonly label: string
  readonly icon: ComponentType
}

const THEME_ITEMS: ReadonlyArray<ChoiceItem<ThemePreference>> = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon }
]

const SEND_MODE_ITEMS: ReadonlyArray<ChoiceItem<SendMode>> = [
  { value: 'queue', label: 'Queue', icon: ListEndIcon },
  { value: 'steer', label: 'Steer', icon: CornerDownRightIcon }
]

const USAGE_LIMIT_RESUME_ITEMS: ReadonlyArray<ChoiceItem<UsageLimitResume>> = [
  { value: 'automatic', label: 'Resume automatically', icon: PlayIcon },
  { value: 'manual', label: 'Wait for me', icon: HandIcon }
]

function SettingRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <span className="text-sm text-ink">{label}</span>
      {children}
    </div>
  )
}

/**
 * The General settings page: the colour theme (light / dark / system), the default send mode
 * (queue / steer: what Enter does while a turn runs), what dia does when a usage limit resets
 * (resume the parked agents, or wait for the user) and the app-wide transcript width. Each
 * control shows the stored value and stores the one the user picks. Render it inside a scrolling
 * container within a {@link ThemeProvider}.
 */
export function GeneralSettings() {
  const { theme, setTheme } = useTheme()
  const sendMode = useAtomValue(sendModeAtom)
  const setSendMode = useAtomSet(sendModeAtom)
  const usageLimitResume = useAtomValue(usageLimitResumeAtom)
  const setUsageLimitResume = useAtomSet(usageLimitResumeAtom)

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col divide-y px-4 py-3">
      <SettingRow label="Theme">
        <ToggleGroup
          type="single"
          value={theme}
          onValueChange={(value) => {
            if (value !== '') setTheme(value as ThemePreference)
          }}
          variant="outline"
          size="sm"
          aria-label="Theme"
        >
          {THEME_ITEMS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} aria-label={item.label}>
              <item.icon />
              <span>{item.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <SettingRow label="Send mode">
        <ToggleGroup
          type="single"
          value={sendMode}
          onValueChange={(value) => {
            if (value !== '') setSendMode(value as SendMode)
          }}
          variant="outline"
          size="sm"
          aria-label="Send mode"
        >
          {SEND_MODE_ITEMS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} aria-label={item.label}>
              <item.icon />
              <span>{item.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <SettingRow label="When the usage limit resets">
        <ToggleGroup
          type="single"
          value={usageLimitResume}
          onValueChange={(value) => {
            if (value !== '') setUsageLimitResume(value as UsageLimitResume)
          }}
          variant="outline"
          size="sm"
          aria-label="When the usage limit resets"
        >
          {USAGE_LIMIT_RESUME_ITEMS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} aria-label={item.label}>
              <item.icon />
              <span>{item.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
      <SettingRow label="Transcript width">
        <TranscriptWidthToggle />
      </SettingRow>
    </div>
  )
}
