import { Schema } from 'effect'

/**
 * Which text of an agent turn stays visible when its steps are collapsed, one setting for the
 * whole app. `answer-only` shows only the text after the turn's last step and collapses the
 * rest into one section; `all-text` shows every text part and collapses each run of steps
 * between them.
 */
export const TranscriptMode = Schema.Literals(['answer-only', 'all-text'])
export type TranscriptMode = typeof TranscriptMode.Type

/** The transcript mode before the user chooses one. */
export const DEFAULT_TRANSCRIPT_MODE: TranscriptMode = 'answer-only'

/** Every transcript mode, in the order a control offers them. */
export const TRANSCRIPT_MODES: ReadonlyArray<TranscriptMode> = TranscriptMode.literals
