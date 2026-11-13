// @vitest-environment jsdom
import { ClarifyingQuestion } from '@shared/domain/attention'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClarifyingQuestionCard,
  type ClarifyingQuestionHandle,
  DECLINED_ANSWER
} from './clarifying-question-card'

const SCOPE = 'Which scope?'
const PLACEMENT = 'Where should it live?'
const STORES = 'Which stores?'

const scope = {
  question: SCOPE,
  header: 'Scope',
  options: [
    { label: 'Small', description: '' },
    { label: 'Large', description: '' }
  ],
  multiSelect: false
}
const placement = {
  question: PLACEMENT,
  header: 'Placement',
  options: [
    { label: 'Kernel', description: '' },
    { label: 'Plugin', description: '' }
  ],
  multiSelect: false
}
const stores = {
  question: STORES,
  header: 'Stores',
  options: [
    { label: 'Postgres', description: '' },
    { label: 'Redis', description: '' },
    { label: 'SQLite', description: '' }
  ],
  multiSelect: true
}

const requestOf = (...questions: ClarifyingQuestion['questions'][number][]) =>
  ClarifyingQuestion.make({ requestId: 'request-1', questions })

function renderCard(request: ClarifyingQuestion) {
  const onResolve = vi.fn()
  const ref = createRef<ClarifyingQuestionHandle>()
  render(<ClarifyingQuestionCard ref={ref} request={request} onResolve={onResolve} />)
  const answer = (text: string) => act(() => ref.current?.answerCurrent(text))
  return { onResolve, answer }
}

const click = (role: 'radio' | 'checkbox' | 'button', name: string) =>
  fireEvent.click(screen.getByRole(role, { name }))

const resolvedAnswers = (onResolve: ReturnType<typeof vi.fn>) =>
  onResolve.mock.calls[0]?.[0].answers

afterEach(cleanup)

describe('ClarifyingQuestionCard answering with options', () => {
  it('submits the chosen option of a single question', () => {
    const { onResolve } = renderCard(requestOf(scope))

    click('radio', 'Small')
    click('button', 'Submit')

    expect(onResolve).toHaveBeenCalledTimes(1)
    expect(resolvedAnswers(onResolve)).toEqual({ [SCOPE]: 'Small' })
  })

  it('collects one answer per question across steps', () => {
    const { onResolve } = renderCard(requestOf(scope, placement))

    click('radio', 'Small')
    click('button', 'Next')
    click('radio', 'Plugin')
    click('button', 'Submit')

    expect(resolvedAnswers(onResolve)).toEqual({ [SCOPE]: 'Small', [PLACEMENT]: 'Plugin' })
  })

  it('answers a multi-select question with every checked option in option order', () => {
    const { onResolve } = renderCard(requestOf(stores))

    click('checkbox', 'Redis')
    click('checkbox', 'Postgres')
    click('button', 'Submit')

    expect(resolvedAnswers(onResolve)).toEqual({ [STORES]: ['Postgres', 'Redis'] })
  })

  it('does not move past a question that is neither answered nor skipped', () => {
    renderCard(requestOf(scope, placement))

    click('button', 'Next')

    expect(screen.queryByRole('radio', { name: 'Kernel' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Choose an answer or skip this question.')
  })

  it('offers no Other option, because the composer takes custom answers', () => {
    renderCard(requestOf(scope, stores))

    expect(screen.queryByRole('radio', { name: 'Other' })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('ClarifyingQuestionCard progress', () => {
  it('shows no progress bar for a single question', () => {
    renderCard(requestOf(scope))

    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('reports the position and moves it with the step', () => {
    renderCard(requestOf(scope, placement))
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuenow')).toBe('1')
    expect(bar.getAttribute('aria-valuemax')).toBe('2')

    click('radio', 'Small')
    click('button', 'Next')

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2')
  })

  it('marks answered and skipped segments', () => {
    renderCard(requestOf(scope, placement, stores))

    click('radio', 'Small')
    click('button', 'Next')
    click('button', 'Skip')

    const bar = screen.getByRole('progressbar')
    const statuses = [...bar.querySelectorAll('[data-status]')].map((segment) =>
      segment.getAttribute('data-status')
    )
    expect(statuses).toEqual(['answered', 'skipped', 'unanswered'])
  })
})

describe('ClarifyingQuestionCard skipping', () => {
  it('answers every question with the short declined text when all are skipped, as an array for a multi-select', async () => {
    const { onResolve } = renderCard(requestOf(scope, stores))

    click('button', 'Skip')
    click('button', 'Skip')

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(resolvedAnswers(onResolve)).toEqual({
      [SCOPE]: 'The user declined to answer',
      [STORES]: ['The user declined to answer']
    })
  })

  it('answers a single skipped question with the short declined text', async () => {
    const { onResolve } = renderCard(requestOf(scope))

    click('button', 'Skip')

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1))
    expect(resolvedAnswers(onResolve)).toEqual({ [SCOPE]: 'The user declined to answer' })
  })

  it('keeps the other answers when one question is skipped', () => {
    const { onResolve } = renderCard(requestOf(scope, stores))

    click('button', 'Skip')
    click('checkbox', 'Postgres')
    click('button', 'Submit')

    expect(resolvedAnswers(onResolve)).toEqual({
      [SCOPE]: DECLINED_ANSWER,
      [STORES]: ['Postgres']
    })
  })
})

describe('ClarifyingQuestionCard answering in the composer', () => {
  it('replaces the chosen option of a single-select question and moves to the next', () => {
    const { onResolve, answer } = renderCard(requestOf(scope, placement))
    click('radio', 'Small')

    answer('neither, use passkeys')

    expect(screen.getByRole('radio', { name: 'Kernel' })).toBeTruthy()
    click('radio', 'Plugin')
    click('button', 'Submit')
    expect(resolvedAnswers(onResolve)).toEqual({
      [SCOPE]: 'neither, use passkeys',
      [PLACEMENT]: 'Plugin'
    })
  })

  it('submits at once when it answers the last open question', () => {
    const { onResolve, answer } = renderCard(requestOf(scope))

    answer('something else')

    expect(resolvedAnswers(onResolve)).toEqual({ [SCOPE]: 'something else' })
  })

  it('appends to the checked options of a multi-select question and stays on it', () => {
    const { onResolve, answer } = renderCard(requestOf(stores))
    click('checkbox', 'Redis')
    click('checkbox', 'Postgres')

    answer('DuckDB')

    expect(onResolve).not.toHaveBeenCalled()
    click('button', 'Submit')
    expect(resolvedAnswers(onResolve)).toEqual({ [STORES]: ['Postgres', 'Redis', 'DuckDB'] })
  })

  it('keeps only the latest typed answer', () => {
    const { onResolve, answer } = renderCard(requestOf(stores))
    click('checkbox', 'Redis')

    answer('DuckDB')
    answer('ClickHouse')
    click('button', 'Submit')

    expect(resolvedAnswers(onResolve)).toEqual({ [STORES]: ['Redis', 'ClickHouse'] })
  })

  it('drops the typed answer when it is removed', () => {
    const { onResolve, answer } = renderCard(requestOf(stores))
    click('checkbox', 'Redis')
    answer('DuckDB')

    click('button', 'Remove your answer')
    click('button', 'Submit')

    expect(resolvedAnswers(onResolve)).toEqual({ [STORES]: ['Redis'] })
  })

  it('ignores blank text', () => {
    const { onResolve, answer } = renderCard(requestOf(stores))
    click('checkbox', 'Redis')

    answer('   ')

    expect(screen.queryByRole('button', { name: 'Remove your answer' })).toBeNull()
    click('button', 'Submit')
    expect(resolvedAnswers(onResolve)).toEqual({ [STORES]: ['Redis'] })
  })

  it('answers a skipped question once text is typed for it', () => {
    const { onResolve, answer } = renderCard(requestOf(stores, scope))
    click('button', 'Skip')
    click('button', 'Previous')

    answer('DuckDB')
    click('button', 'Next')
    click('radio', 'Small')
    click('button', 'Submit')

    expect(resolvedAnswers(onResolve)).toEqual({ [STORES]: ['DuckDB'], [SCOPE]: 'Small' })
  })
})
