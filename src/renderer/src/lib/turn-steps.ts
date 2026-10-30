import type { MessagePart, TextPart, ThinkingPart, ToolCallPart } from './pane-chat'

/** A thinking or tool-call part of an assistant turn: one step the agent took. */
export type StepPart = ThinkingPart | ToolCallPart

/**
 * A run of consecutive steps in a turn, collapsed behind one summary line. `parts` holds them in
 * arrival order. `followedAt` is the arrival time of the text right after the section, when there
 * is one.
 */
export interface StepsSection {
  readonly type: 'steps'
  readonly parts: ReadonlyArray<StepPart>
  readonly followedAt?: number
}

/** One block of an assistant turn as the transcript lays it out: visible text, or a section. */
export type TurnBlock = TextPart | StepsSection

const isStep = (part: MessagePart): part is StepPart => part.type !== 'text'

const isShown = (part: MessagePart): boolean =>
  part.type === 'tool-call' || part.content.trim() !== ''

const groupSteps = (parts: ReadonlyArray<MessagePart>): Array<TurnBlock> => {
  const blocks: Array<TurnBlock> = []
  let run: Array<StepPart> = []
  for (const part of parts) {
    if (isStep(part)) {
      run.push(part)
      continue
    }
    if (run.length > 0) blocks.push({ type: 'steps', parts: run })
    run = []
    blocks.push(part)
  }
  if (run.length > 0) blocks.push({ type: 'steps', parts: run })
  return blocks
}

const withFollowedAt = (blocks: ReadonlyArray<TurnBlock>): ReadonlyArray<TurnBlock> =>
  blocks.map((block, index) => {
    const next = blocks[index + 1]
    const followedAt = next?.type === 'text' ? next.startedAt : undefined
    return block.type === 'steps' && followedAt !== undefined ? { ...block, followedAt } : block
  })

/**
 * Lays out an assistant turn's `parts`: every text part stays visible, and each run of
 * consecutive steps collapses into one {@link StepsSection}. A turn with no steps is all text.
 * Blank text and thinking parts are left out.
 */
export const turnBlocks = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<TurnBlock> =>
  withFollowedAt(groupSteps(parts.filter(isShown)))

/** Whether `parts` hold any step, so that {@link turnBlocks} lays out at least one section. */
export const hasSteps = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.some((part) => isStep(part) && isShown(part))

/**
 * How long `section` took in milliseconds: from the first part's arrival to the arrival of the
 * text after it, or else to the last arrival or tool completion in it. `undefined` when its parts
 * carry no arrival times (a restored turn).
 */
export const sectionDurationMs = (section: StepsSection): number | undefined => {
  const times = section.parts.flatMap((part) => [
    part.startedAt,
    part.type === 'tool-call' ? part.endedAt : undefined
  ])
  const known = times.filter((time): time is number => time !== undefined)
  if (known.length === 0) return undefined
  return (section.followedAt ?? Math.max(...known)) - Math.min(...known)
}
