import { Schema } from 'effect'

/** The maximum width of the transcript column, one setting for the whole app. */
export const TranscriptWidth = Schema.Literals(['narrow', 'default', 'wide'])
export type TranscriptWidth = typeof TranscriptWidth.Type

/** The transcript width before the user chooses one. */
export const DEFAULT_TRANSCRIPT_WIDTH: TranscriptWidth = 'default'
