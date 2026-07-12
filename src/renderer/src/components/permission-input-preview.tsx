import type { ReactNode } from 'react'

interface AskUserQuestionOption {
  readonly label: string
  readonly description?: string
}

interface AskUserQuestionQuestion {
  readonly question: string
  readonly header?: string
  readonly options: ReadonlyArray<AskUserQuestionOption>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAskUserQuestionInput(
  input: Record<string, unknown>
): input is { questions: ReadonlyArray<AskUserQuestionQuestion> } {
  return (
    Array.isArray(input.questions) &&
    input.questions.every(
      (question) =>
        isRecord(question) &&
        typeof question.question === 'string' &&
        Array.isArray(question.options) &&
        question.options.every((option) => isRecord(option) && typeof option.label === 'string')
    )
  )
}

// Field/value labels are the tool's own data, not dia chrome -- rendered in mono per
// DESIGN.md's Content-Is-Mono Rule, distinct from the sans field labels around them.
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return spaced.length === 0 ? spaced : spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function InputValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined) return null

  if (typeof value === 'string') {
    return value.includes('\n') || value.length > 80 ? (
      <pre className="max-h-40 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-2 font-mono text-xs whitespace-pre-wrap text-neutral-300">
        {value}
      </pre>
    ) : (
      <span className="font-mono text-xs text-neutral-300">{value}</span>
    )
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-xs text-neutral-300">{String(value)}</span>
  }

  if (Array.isArray(value)) {
    return (
      <ul className="space-y-1">
        {value.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool input arrays are re-rendered whole, never reordered in place
          <li key={index} className="rounded border border-neutral-800 bg-neutral-900 p-2">
            <InputValue value={item} />
          </li>
        ))}
      </ul>
    )
  }

  if (isRecord(value)) {
    return <InputFields input={value} />
  }

  return <span className="font-mono text-xs text-neutral-300">{String(value)}</span>
}

function InputFields({ input }: { input: Record<string, unknown> }): ReactNode {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== null)
  if (entries.length === 0) return null

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key}>
          <div className="text-xs font-medium text-neutral-500">{humanizeKey(key)}</div>
          <InputValue value={value} />
        </div>
      ))}
    </div>
  )
}

// AskUserQuestion gets a dedicated Q&A layout since it's the tool users hit constantly;
// every other tool falls back to the generic field renderer above.
function AskUserQuestionPreview({
  questions
}: {
  questions: ReadonlyArray<AskUserQuestionQuestion>
}): ReactNode {
  return (
    <div className="space-y-3">
      {questions.map((question, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: questions are re-rendered whole, never reordered in place
        <div key={index} className="space-y-1.5">
          <p className="text-sm text-neutral-200">{question.header ?? question.question}</p>
          {question.header !== undefined && question.header !== question.question && (
            <p className="text-xs text-neutral-500">{question.question}</p>
          )}
          <ul className="space-y-1">
            {question.options.map((option, optionIndex) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: options are re-rendered whole, never reordered in place
                key={optionIndex}
                className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5"
              >
                <div className="text-xs font-medium text-neutral-200">{option.label}</div>
                {option.description !== undefined && (
                  <div className="text-xs text-neutral-500">{option.description}</div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

export function PermissionInputPreview({
  toolName,
  input
}: {
  toolName: string
  input: Record<string, unknown>
}): ReactNode {
  if (toolName === 'AskUserQuestion' && isAskUserQuestionInput(input)) {
    return <AskUserQuestionPreview questions={input.questions} />
  }
  return <InputFields input={input} />
}
