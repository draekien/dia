// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Schema } from 'effect'
import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Skill } from './registry'
import { makeSkillsFamily, SkillPicker } from './skill-picker'

const ctx = { name: 'skills' }

const PLAN: Skill = { name: 'dia-meta:plan', description: 'Plans work', group: 'Meta repo' }
const REVIEW: Skill = { name: 'review', description: 'Reviews a diff', group: 'Your skills' }
const DEPLOY: Skill = { name: 'deploy', description: '', group: 'Your skills' }

const encodeSkills = Schema.encodeSync(Schema.toCodecJson(Schema.Array(Skill)))

const installHost = (skills: ReadonlyArray<Skill>) => {
  const watchers = new Set<(value: unknown) => void>()
  Object.assign(window, {
    dia: {
      plugins: {
        call: vi.fn(),
        subscribe: (
          _plugin: string,
          _tag: string,
          _payload: unknown,
          onValue: (v: unknown) => void
        ) => {
          watchers.add(onValue)
          queueMicrotask(() => onValue(encodeSkills(skills)))
          return () => watchers.delete(onValue)
        },
        onStatusChanged: () => () => {}
      }
    }
  })
  return {
    push: (next: ReadonlyArray<Skill>) =>
      act(() => {
        for (const watcher of watchers) watcher(encodeSkills(next))
      })
  }
}

function Harness({ initial }: { readonly initial: ReadonlyArray<string> }) {
  const [value, setValue] = useState(initial)
  return (
    <form>
      <SkillPicker
        label="Skills"
        value={value}
        onChange={setValue}
        skillsFamily={makeSkillsFamily(ctx)}
      />
      <output aria-label="Chosen">{value.join(',')}</output>
    </form>
  )
}

const renderPicker = async (initial: ReadonlyArray<string> = []) => {
  render(<Harness initial={initial} />)
  await screen.findByRole('listbox')
}

const chosen = () => screen.getByRole('status', { name: 'Chosen' }).textContent

const group = (heading: string) => screen.getByRole('group', { name: heading })

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'dia')
})

describe('SkillPicker', () => {
  it('lists each skill under its group heading', async () => {
    installHost([PLAN, DEPLOY, REVIEW])

    await renderPicker()

    expect({
      meta: within(group('Meta repo')).queryByText('dia-meta:plan') !== null,
      user: within(group('Your skills')).queryByText('review') !== null
    }).toEqual({ meta: true, user: true })
  })

  it('adds a clicked skill to the chosen names', async () => {
    installHost([PLAN, REVIEW])
    await renderPicker(['review'])

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /dia-meta:plan/ }))
    })

    expect(chosen()).toBe('review,dia-meta:plan')
  })

  it('removes a clicked chosen skill from the chosen names', async () => {
    installHost([PLAN, REVIEW])
    await renderPicker(['review', 'dia-meta:plan'])

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /review/ }))
    })

    expect(chosen()).toBe('dia-meta:plan')
  })

  it('lists a chosen name no skill has under Missing', async () => {
    installHost([REVIEW])

    await renderPicker(['gone'])

    expect(within(group('Missing')).getByRole('option').textContent).toContain('gone(missing)')
  })

  it('shows a skill the host adds while the picker is open', async () => {
    const host = installHost([REVIEW])
    await renderPicker()

    await host.push([REVIEW, DEPLOY])

    expect(screen.getByRole('option', { name: /deploy/ })).toBeTruthy()
  })

  it('says sessions get every skill when none is chosen', async () => {
    installHost([REVIEW])

    await renderPicker()

    expect(screen.getByText('None selected: sessions get every skill.')).toBeTruthy()
  })

  it('cancels Enter in the search box, so the browser does not submit the surrounding form', async () => {
    installHost([REVIEW])
    await renderPicker()

    const notCancelled = fireEvent.keyDown(screen.getByRole('combobox', { name: 'Skills' }), {
      key: 'Enter'
    })

    expect(notCancelled).toBe(false)
  })
})
