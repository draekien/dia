import { Answers, type QuestionResponse } from '@shared/domain/attention'
import type { PaneQuestionRequested } from '@shared/ipc/contract'
import { useState } from 'react'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { RadioGroup, RadioGroupItem } from './ui/radio-group'

type Question = PaneQuestionRequested['questions'][number]

const OTHER = '__other__'

// The SDK's AskUserQuestionOutput keys answers by the full question text
// (question text -> answer string); keying by header instead makes the CLI find
// no answer for any question and report that the user did not answer.
function questionKey(question: Question): string {
  return question.question
}

function resolveAnswers(
  questions: PaneQuestionRequested['questions'],
  single: Record<string, string>,
  multi: Record<string, ReadonlySet<string>>,
  otherText: Record<string, string>
): Record<string, string | ReadonlyArray<string>> {
  const answers: Record<string, string | ReadonlyArray<string>> = {}
  for (const question of questions) {
    const key = questionKey(question)
    if (question.multiSelect) {
      const chosen = multi[key] ?? new Set<string>()
      const values = question.options
        .filter((option) => chosen.has(option.label))
        .map((option) => option.label)
      if (chosen.has(OTHER)) {
        const custom = (otherText[key] ?? '').trim()
        if (custom.length > 0) values.push(custom)
      }
      answers[key] = values
    } else {
      const selection = single[key]
      answers[key] = selection === OTHER ? (otherText[key] ?? '').trim() : (selection ?? '')
    }
  }
  return answers
}

function isComplete(
  questions: PaneQuestionRequested['questions'],
  single: Record<string, string>,
  multi: Record<string, ReadonlySet<string>>,
  otherText: Record<string, string>
): boolean {
  return questions.every((question) => {
    const key = questionKey(question)
    const hasCustom = (otherText[key] ?? '').trim().length > 0
    if (question.multiSelect) {
      const chosen = multi[key] ?? new Set<string>()
      if (chosen.size === 0) return false
      return chosen.has(OTHER) ? hasCustom : true
    }
    const selection = single[key]
    if (selection === undefined || selection === '') return false
    return selection === OTHER ? hasCustom : true
  })
}

/**
 * Inline card that presents a pane's pending clarifying questions and collects the user's
 * answers. Each question renders its options as a radio group (single-select) or checkboxes
 * (`multiSelect`), always with an "Other" free-text option for answers that fit none of the
 * choices. Pass the pane's {@link PaneQuestionRequested} as `request`; `onResolve` is called
 * once, when every question is answered and the user submits, with an `Answers`
 * {@link QuestionResponse} keyed by each question's full text (the shape the SDK
 * matches answers against).
 */
export function ClarifyingQuestionCard({
  request,
  onResolve
}: {
  request: PaneQuestionRequested
  onResolve: (response: QuestionResponse) => void
}) {
  const [single, setSingle] = useState<Record<string, string>>({})
  const [multi, setMulti] = useState<Record<string, ReadonlySet<string>>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})

  const complete = isComplete(request.questions, single, multi, otherText)

  function toggleMulti(key: string, value: string, checked: boolean): void {
    setMulti((prev) => {
      const next = new Set(prev[key] ?? [])
      if (checked) next.add(value)
      else next.delete(value)
      return { ...prev, [key]: next }
    })
  }

  function submit(): void {
    if (!complete) return
    onResolve(
      Answers.make({
        questions: request.questions,
        answers: resolveAnswers(request.questions, single, multi, otherText)
      })
    )
  }

  return (
    <section className="mt-2 flex flex-col gap-4 rounded-md border bg-muted/40 p-3">
      <p className="text-base font-semibold text-foreground">Claude needs your input</p>
      {request.questions.map((question) => {
        const key = questionKey(question)
        const otherSelected = question.multiSelect
          ? (multi[key]?.has(OTHER) ?? false)
          : single[key] === OTHER
        return (
          <fieldset key={key} className="flex flex-col gap-2 border-0 p-0">
            <legend className="mb-1 text-sm text-foreground">{question.question}</legend>
            {question.multiSelect ? (
              <div className="flex flex-col gap-2">
                {question.options.map((option) => (
                  <div key={option.label} className="flex items-start gap-2">
                    <Checkbox
                      className="mt-0.5"
                      id={`${key}-${option.label}`}
                      checked={multi[key]?.has(option.label) ?? false}
                      onCheckedChange={(checked) =>
                        toggleMulti(key, option.label, checked === true)
                      }
                    />
                    <Label
                      htmlFor={`${key}-${option.label}`}
                      className="flex flex-col items-start gap-0.5 font-normal text-foreground"
                    >
                      <span>{option.label}</span>
                      {option.description !== undefined && (
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      )}
                    </Label>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${key}-other`}
                    checked={multi[key]?.has(OTHER) ?? false}
                    onCheckedChange={(checked) => toggleMulti(key, OTHER, checked === true)}
                  />
                  <Label htmlFor={`${key}-other`} className="font-normal text-foreground">
                    Other
                  </Label>
                </div>
              </div>
            ) : (
              <RadioGroup
                value={single[key] ?? ''}
                onValueChange={(value) => setSingle((prev) => ({ ...prev, [key]: value }))}
              >
                {question.options.map((option) => (
                  <div key={option.label} className="flex items-start gap-2">
                    <RadioGroupItem
                      className="mt-0.5"
                      value={option.label}
                      id={`${key}-${option.label}`}
                    />
                    <Label
                      htmlFor={`${key}-${option.label}`}
                      className="flex flex-col items-start gap-0.5 font-normal text-foreground"
                    >
                      <span>{option.label}</span>
                      {option.description !== undefined && (
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      )}
                    </Label>
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <RadioGroupItem value={OTHER} id={`${key}-other`} />
                  <Label htmlFor={`${key}-other`} className="font-normal text-foreground">
                    Other
                  </Label>
                </div>
              </RadioGroup>
            )}
            {otherSelected && (
              <Input
                autoFocus
                aria-label={`Custom answer for ${question.question}`}
                placeholder="Type your answer"
                value={otherText[key] ?? ''}
                onChange={(event) =>
                  setOtherText((prev) => ({ ...prev, [key]: event.target.value }))
                }
              />
            )}
          </fieldset>
        )
      })}
      <div className="flex justify-end">
        <Button size="sm" disabled={!complete} onClick={submit}>
          Submit
        </Button>
      </div>
    </section>
  )
}
