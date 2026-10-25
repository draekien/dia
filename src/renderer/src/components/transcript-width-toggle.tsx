import { TRANSCRIPT_WIDTHS, type TranscriptWidth } from '@shared/domain/transcript-width'
import { useTranscriptWidth } from '../plugin-api'
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group'

const WIDTH_LABELS: Record<TranscriptWidth, string> = {
  narrow: 'Narrow',
  default: 'Default',
  wide: 'Wide'
}

/**
 * The Narrow / Default / Wide choice of the app-wide transcript width. Shows the stored width and
 * stores the one the user picks; place it wherever the setting is offered.
 */
export function TranscriptWidthToggle() {
  const [width, setWidth] = useTranscriptWidth()
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label="Transcript width"
      value={width}
      onValueChange={(value: TranscriptWidth | '') => {
        if (value !== '') setWidth(value)
      }}
    >
      {TRANSCRIPT_WIDTHS.map((option) => (
        <ToggleGroupItem key={option} value={option} className="flex-1">
          {WIDTH_LABELS[option]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
