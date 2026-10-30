import type { TranscriptMode } from '@shared/domain/transcript-mode'
import type { MessagePart, TextPart, ThinkingPart, ToolCallPart } from './pane-chat'

/** A thinking or tool-call part of an assistant turn: one step the agent took. */
export type StepPart = ThinkingPart | ToolCallPart

/** A text part shown outside every collapsed section. */
export interface VisibleText {
  readonly type: 'text'
  readonly part: TextPart
}

/**
 * A run of a turn's parts collapsed behind one summary line. `parts` holds them in arrival
 * order; in `answer-only` mode it may include text written between steps. `followedAt` is the
 * arrival time of the part right after the section, when there is one.
 */
export interface StepsSection {
  readonly type: 'steps'
  readonly parts: ReadonlyArray<MessagePart>
  readonly followedAt?: number
}

/** One block of an assistant turn as the transcript lays it out. */
export type TurnBlock = VisibleText | StepsSection

const isStep = (part: MessagePart): part is StepPart => part.type !== 'text'

const isText = (part: MessagePart): part is TextPart => part.type === 'text'

const answerOnlyBlocks = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<TurnBlock> => {
  const lastStep = parts.reduce((last, part, index) => (isStep(part) ? index : last), -1)
  const answer = parts
    .slice(lastStep + 1)
    .filter(isText)
    .map(visibleText)
  if (lastStep === -1) return answer
  const followedAt = parts[lastStep + 1]?.startedAt
  return [
    {
      type: 'steps',
      parts: parts.slice(0, lastStep + 1),
      ...(followedAt !== undefined ? { followedAt } : {})
    },
    ...answer
  ]
}

const allTextBlocks = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<TurnBlock> => {
  const blocks: Array<TurnBlock> = []
  for (const part of parts) {
    const last = blocks.at(-1)
    const lastSection = last?.type === 'steps' ? last : undefined
    if (part.type === 'text') {
      if (lastSection !== undefined && part.startedAt !== undefined) {
        blocks[blocks.length - 1] = { ...lastSection, followedAt: part.startedAt }
      }
      blocks.push(visibleText(part))
    } else if (lastSection !== undefined) {
      blocks[blocks.length - 1] = { type: 'steps', parts: [...lastSection.parts, part] }
    } else {
      blocks.push({ type: 'steps', parts: [part] })
    }
  }
  return blocks
}

const visibleText = (part: TextPart): VisibleText => ({ type: 'text', part })

/**
 * Lays out an assistant turn's `parts` for `mode`. `answer-only` puts every part up to and
 * including the last step in one {@link StepsSection} and shows the text after it;
 * `all-text` shows every text part and collapses each run of consecutive steps. A turn with no
 * steps is all {@link VisibleText}.
 */
export const turnBlocks = (
  parts: ReadonlyArray<MessagePart>,
  mode: TranscriptMode
): ReadonlyArray<TurnBlock> =>
  mode === 'answer-only' ? answerOnlyBlocks(parts) : allTextBlocks(parts)

/** The steps in `section`: its thinking and tool-call parts, without the text between them. */
export const sectionSteps = (section: StepsSection): ReadonlyArray<StepPart> =>
  section.parts.filter(isStep)

/**
 * How long `section` took in milliseconds: from the first part's arrival to the arrival of the
 * part after it, or else to the last arrival or tool completion in it. `undefined` when its parts
 * carry no arrival times (a restored turn).
 */
export const sectionDurationMs = (section: StepsSection): number | undefined => {
  const times = section.parts.flatMap((part) => [
    part.startedAt,
    part.type === 'tool-call' ? part.endedAt : undefined
  ])
  if (section.followedAt !== undefined) times.push(section.followedAt)
  const known = times.filter((time): time is number => time !== undefined)
  if (known.length === 0) return undefined
  return Math.max(...known) - Math.min(...known)
}
