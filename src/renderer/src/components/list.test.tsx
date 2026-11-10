// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { List, ListRow, ListRowLink, ListRowName, ListRowSubject } from './list'

afterEach(cleanup)

function Row({ value, children }: { readonly value: string; readonly children?: React.ReactNode }) {
  return (
    <ListRow value={value}>
      <ListRowLink render={<div />} data-testid={value}>
        <ListRowSubject>
          <ListRowName>{value}</ListRowName>
        </ListRowSubject>
      </ListRowLink>
      {children}
    </ListRow>
  )
}

describe('List', () => {
  it('moves ArrowDown to the next row of the same list, skipping rows of a list nested in a row', () => {
    render(
      <List aria-label="Outer">
        <Row value="first">
          <List aria-label="Inner">
            <Row value="nested" />
          </List>
        </Row>
        <Row value="second" />
      </List>
    )
    const first = screen.getByTestId('first')
    first.focus()

    fireEvent.keyDown(first, { key: 'ArrowDown' })

    expect(document.activeElement).toBe(screen.getByTestId('second'))
  })
})
