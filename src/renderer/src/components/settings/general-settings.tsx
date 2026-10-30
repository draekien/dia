import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { sendModeAtom } from '@renderer/lib/send-mode-atom'
import type { SendMode } from '@shared/domain/message-queue'
import type { ThemePreference } from '@shared/domain/theme'
import type { TranscriptMode } from '@shared/domain/transcript-mode'
import {
  CornerDownRightIcon,
  ListEndIcon,
  ListIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useTranscriptMode } from '../../plugin-api'
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

const TRANSCRIPT_MODE_ITEMS: ReadonlyArray<ChoiceItem<TranscriptMode>> = [
  { value: 'answer-only', label: 'Answer only', icon: MessageSquareTextIcon },
  { value: 'all-text', label: 'All text', icon: ListIcon }
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
 * (queue / steer: what Enter does while a turn runs), the app-wide transcript width, and the
 * transcript mode (answer only / all text: which text of a turn stays visible beside its collapsed
 * steps). Each
 * control shows the stored value and stores the one the user picks. Render it inside a scrolling
 * container within a {@link ThemeProvider}.
 */
export function GeneralSettings() {
  const { theme, setTheme } = useTheme()
  const sendMode = useAtomValue(sendModeAtom)
  const setSendMode = useAtomSet(sendModeAtom)
  const [transcriptMode, setTranscriptMode] = useTranscriptMode()

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
      <SettingRow label="Transcript width">
        <TranscriptWidthToggle />
      </SettingRow>
      <SettingRow label="Transcript mode">
        <ToggleGroup
          type="single"
          value={transcriptMode}
          onValueChange={(value) => {
            if (value !== '') setTranscriptMode(value as TranscriptMode)
          }}
          variant="outline"
          size="sm"
          aria-label="Transcript mode"
        >
          {TRANSCRIPT_MODE_ITEMS.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value} aria-label={item.label}>
              <item.icon />
              <span>{item.label}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </SettingRow>
    </div>
  )
}
