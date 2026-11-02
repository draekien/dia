import {
  Button,
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle
} from '@dia/renderer-plugin'
import { Answers, type ClarifyingQuestion, type QuestionResponse } from '@shared/domain/attention'
import { XIcon } from 'lucide-react'
import { type Ref, useId, useImperativeHandle, useRef, useState } from 'react'
import { QuestionProgress, type QuestionProgressStatus } from './question-progress'

type Question = ClarifyingQuestion['questions'][number]

/**
 * The answer sent to the agent for a question the user skipped. A multi-select question receives
 * it as a one-element array.
 */
export const DECLINED_ANSWER =
  'User declined to answer this question. Check the other answers they provided to decide if it needs to be asked in a different way'

/**
 * The answer sent for every question when the user skipped all of them, so there are no other
 * answers to consult. A multi-select question receives it as a one-element array.
 */
export const DECLINED_ALL_ANSWER = 'The user declined to answer'

/** Imperative handle of {@link ClarifyingQuestionCard}, for the composer that sits beside it. */
export interface ClarifyingQuestionHandle {
  /**
   * Records `text` as the user's own answer to the question on screen. A single-select question
   * drops its chosen option and moves on, or submits when nothing is left to answer. A
   * multi-select question adds the text to its checked options and stays on the question. Blank
   * text is ignored.
   */
  readonly answerCurrent: (text: string) => void
}

// The SDK's AskUserQuestionOutput keys answers by the full question text
// (question text -> answer string); keying by header instead makes the CLI find
// no answer for any question and report that the user did not answer.
function questionKey(question: Question): string {
  return question.question
}

type Picks = Record<string, ReadonlyArray<string>>
type Typed = Record<string, string>
type Statuses = Record<string, QuestionProgressStatus>

function resolveAnswers(
  questions: ClarifyingQuestion['questions'],
  picks: Picks,
  typed: Typed,
  statuses: Statuses
): Record<string, string | ReadonlyArray<string>> {
  const answers: Record<string, string | ReadonlyArray<string>> = {}
  const declined = questions.every((question) => statuses[questionKey(question)] === 'skipped')
    ? DECLINED_ALL_ANSWER
    : DECLINED_ANSWER
  for (const question of questions) {
    const key = questionKey(question)
    const custom = typed[key] ?? ''
    if (statuses[key] === 'skipped') {
      answers[key] = question.multiSelect ? [declined] : declined
    } else if (question.multiSelect) {
      const chosen = picks[key] ?? []
      const values = question.options
        .map((option) => option.label)
        .filter((label) => chosen.includes(label))
      answers[key] = custom === '' ? values : [...values, custom]
    } else {
      answers[key] = custom === '' ? (picks[key]?.[0] ?? '') : custom
    }
  }
  return answers
}

function statusOf(all: Statuses, key: string): QuestionProgressStatus {
  return all[key] ?? 'unanswered'
}

/**
 * Inline card that presents a pane's pending clarifying questions one at a time and collects the
 * user's answers. Each question shows its options as radios (single-select) or checkboxes
 * (`multiSelect`) and can be skipped, which answers it with {@link DECLINED_ANSWER}, or with
 * {@link DECLINED_ALL_ANSWER} for every question when all of them were skipped. The user can
 * also answer in the composer through the `ref` handle ({@link ClarifyingQuestionHandle}). Pass
 * the pane's {@link ClarifyingQuestion} as `request`; `onResolve` is called once, when every
 * question is answered or skipped and the user submits, with an `Answers`
 * {@link QuestionResponse} keyed by each question's full text (the shape the SDK matches answers
 * against).
 */
export function ClarifyingQuestionCard({
  request,
  onResolve,
  ref
}: {
  request: ClarifyingQuestion
  onResolve: (response: QuestionResponse) => void
  ref?: Ref<ClarifyingQuestionHandle>
}) {
  const titleId = useId()
  const keys = request.questions.map(questionKey)
  const [active, setActive] = useState(keys[0] ?? '')
  const [picks, setPicks] = useState<Picks>({})
  const [typed, setTyped] = useState<Typed>({})
  const [statuses, setStatuses] = useState<Statuses>({})
  const statusesRef = useRef<Statuses>({})

  function recordStatus(key: string, status: QuestionProgressStatus): void {
    statusesRef.current = { ...statusesRef.current, [key]: status }
    setStatuses(statusesRef.current)
  }

  function submit(nextPicks: Picks, nextTyped: Typed, nextStatuses: Statuses): void {
    onResolve(
      Answers.make({
        questions: request.questions,
        answers: resolveAnswers(request.questions, nextPicks, nextTyped, nextStatuses)
      })
    )
  }

  function answerCurrent(text: string): void {
    const question = request.questions.find((candidate) => questionKey(candidate) === active)
    const custom = text.trim()
    if (question === undefined || custom === '') return
    const nextTyped = { ...typed, [active]: custom }
    const nextPicks = question.multiSelect ? picks : { ...picks, [active]: [] }
    setTyped(nextTyped)
    setPicks(nextPicks)
    if (question.multiSelect) return
    const nextStatuses: Statuses = { ...statusesRef.current, [active]: 'answered' }
    recordStatus(active, 'answered')
    const position = keys.indexOf(active)
    const next =
      keys.find((key, index) => index > position && statusOf(nextStatuses, key) === 'unanswered') ??
      keys.find((key) => statusOf(nextStatuses, key) === 'unanswered')
    if (next === undefined) submit(nextPicks, nextTyped, nextStatuses)
    else setActive(next)
  }

  useImperativeHandle(ref, () => ({ answerCurrent }))

  function choose(question: Question, label: string, checked: boolean): void {
    const key = questionKey(question)
    if (!question.multiSelect) {
      if (!checked) return
      setPicks((prev) => ({ ...prev, [key]: [label] }))
      setTyped((prev) => ({ ...prev, [key]: '' }))
      return
    }
    setPicks((prev) => {
      const rest = (prev[key] ?? []).filter((existing) => existing !== label)
      return { ...prev, [key]: checked ? [...rest, label] : rest }
    })
  }

  function clearTyped(key: string): void {
    setTyped((prev) => ({ ...prev, [key]: '' }))
  }

  return (
    <div className="mt-2 flex flex-col gap-4 rounded-md border bg-muted/40 p-3">
      <p id={titleId} className="font-semibold text-base text-foreground">
        Claude needs your input
      </p>
      <QuestionProgress
        statuses={keys.map((key) => statusOf(statuses, key))}
        current={Math.max(0, keys.indexOf(active))}
      />
      <Questionnaire
        aria-labelledby={titleId}
        item={active}
        onItemChange={setActive}
        onSubmit={(event) => {
          event.preventDefault()
          submit(picks, typed, statusesRef.current)
        }}
      >
        {request.questions.map((question) => {
          const key = questionKey(question)
          const custom = typed[key] ?? ''
          return (
            <QuestionnaireItem
              key={key}
              name={key}
              multiple={question.multiSelect}
              onStatusChange={(status) => recordStatus(key, status)}
            >
              <QuestionnaireTitle className="font-medium text-sm">
                {question.question}
              </QuestionnaireTitle>
              <QuestionnaireChoices>
                {question.options.map((option) => (
                  <QuestionnaireChoice
                    key={option.label}
                    value={option.label}
                    checked={picks[key]?.includes(option.label) ?? false}
                    onChange={(event) => choose(question, option.label, event.target.checked)}
                  >
                    <span className="font-medium">{option.label}</span>
                    {option.description !== undefined && (
                      <QuestionnaireChoiceDescription className="text-xs">
                        {option.description}
                      </QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
                {custom !== '' && (
                  <div className="flex items-start gap-2">
                    <QuestionnaireChoice
                      className="flex-1"
                      value={custom}
                      checked
                      onChange={(event) => {
                        if (!event.target.checked) clearTyped(key)
                      }}
                    >
                      <span className="font-medium">{custom}</span>
                      <QuestionnaireChoiceDescription className="text-xs">
                        Your answer
                      </QuestionnaireChoiceDescription>
                    </QuestionnaireChoice>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove your answer"
                      onClick={() => clearTyped(key)}
                    >
                      <XIcon />
                    </Button>
                  </div>
                )}
              </QuestionnaireChoices>
              <QuestionnaireError />
            </QuestionnaireItem>
          )
        })}
        <QuestionnaireActions>
          <QuestionnairePrevious variant="ghost" size="sm" />
          <QuestionnaireSkip variant="ghost" size="sm" />
          <QuestionnaireNext size="sm" />
          <QuestionnaireSubmit size="sm" />
        </QuestionnaireActions>
        <p className="text-muted-foreground text-xs">Or type your own answer in the message box</p>
      </Questionnaire>
    </div>
  )
}
