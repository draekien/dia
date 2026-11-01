// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = () => {}
  window.HTMLElement.prototype.hasPointerCapture = () => false
  window.HTMLElement.prototype.releasePointerCapture = () => {}
})
afterEach(cleanup)

const Menu = ({ label, option }: { label: string; option: string }) => (
  <Select defaultValue={option}>
    <SelectTrigger aria-label={label}>
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value={option}>{option}</SelectItem>
    </SelectContent>
  </Select>
)

const press = (element: Element) =>
  fireEvent.pointerDown(element, { button: 0, ctrlKey: false, pointerType: 'mouse' })

describe('Select', () => {
  it('closes an open menu when another select is opened', () => {
    render(
      <>
        <Menu label="Model" option="Opus 5.5" />
        <Menu label="Effort" option="Medium" />
      </>
    )
    press(screen.getByRole('combobox', { name: 'Model' }))
    expect(screen.getAllByRole('listbox', { hidden: true })).toHaveLength(1)

    press(screen.getByRole('combobox', { name: 'Effort', hidden: true }))

    expect(screen.getAllByRole('listbox', { hidden: true })).toHaveLength(1)
    expect(screen.getByRole('option', { name: 'Medium' })).toBeTruthy()
  })
})
