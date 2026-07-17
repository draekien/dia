import { Either } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  closePane,
  InvalidResizeError,
  LastPaneError,
  markPaneReady,
  type PaneNode,
  PaneNotFoundError,
  resizeSplit,
  splitPane
} from './pane-tree'

const PANE_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const PANE_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const PANE_C = 'cccccccc-0000-4000-8000-000000000003'

const leaf = (paneId: string, status: 'pending' | 'ready' = 'ready'): PaneNode => ({
  _tag: 'Leaf',
  paneId,
  status
})

describe('splitPane', () => {
  it('splits a lone leaf into a two-child Split with equal sizes, the new leaf pending', () => {
    const tree = leaf(PANE_A)

    const result = splitPane(tree, PANE_A, 'row', PANE_B)

    expect(result).toEqual(
      Either.right({
        _tag: 'Split',
        direction: 'row',
        children: [leaf(PANE_A), leaf(PANE_B, 'pending')],
        sizes: [0.5, 0.5]
      })
    )
  })

  it('splits a nested leaf in a different direction, preserving the outer Split', () => {
    const rowSplit = Either.getOrThrow(splitPane(leaf(PANE_A), PANE_A, 'row', PANE_B))

    const result = splitPane(rowSplit, PANE_B, 'column', PANE_C)

    expect(result).toEqual(
      Either.right({
        _tag: 'Split',
        direction: 'row',
        children: [
          leaf(PANE_A),
          {
            _tag: 'Split',
            direction: 'column',
            children: [leaf(PANE_B, 'pending'), leaf(PANE_C, 'pending')],
            sizes: [0.5, 0.5]
          }
        ],
        sizes: [0.5, 0.5]
      })
    )
  })

  it('returns PaneNotFoundError for an unknown paneId', () => {
    const result = splitPane(leaf(PANE_A), 'not-a-real-id', 'row', PANE_B)

    expect(result).toEqual(Either.left(new PaneNotFoundError({ paneId: 'not-a-real-id' })))
  })
})

describe('markPaneReady', () => {
  it('flips a pending leaf to ready', () => {
    const split = Either.getOrThrow(splitPane(leaf(PANE_A), PANE_A, 'row', PANE_B))

    const result = markPaneReady(split, PANE_B, '/repo')

    expect(result).toEqual(
      Either.right({
        _tag: 'Split',
        direction: 'row',
        children: [leaf(PANE_A), { ...leaf(PANE_B, 'ready'), cwd: '/repo' }],
        sizes: [0.5, 0.5]
      })
    )
  })

  it('returns PaneNotFoundError for an unknown paneId', () => {
    const result = markPaneReady(leaf(PANE_A), 'not-a-real-id', '/repo')

    expect(result).toEqual(Either.left(new PaneNotFoundError({ paneId: 'not-a-real-id' })))
  })
})

describe('closePane', () => {
  it('collapses a two-child Split back to the surviving sibling', () => {
    const split = Either.getOrThrow(splitPane(leaf(PANE_A), PANE_A, 'row', PANE_B))

    const result = closePane(split, PANE_B)

    expect(result).toEqual(Either.right(leaf(PANE_A)))
  })

  it('collapses the correct nested Split, leaving the outer Split intact', () => {
    const rowSplit = Either.getOrThrow(splitPane(leaf(PANE_A), PANE_A, 'row', PANE_B))
    const nested = Either.getOrThrow(splitPane(rowSplit, PANE_B, 'column', PANE_C))

    const result = closePane(nested, PANE_C)

    expect(result).toEqual(
      Either.right({
        _tag: 'Split',
        direction: 'row',
        children: [leaf(PANE_A), leaf(PANE_B, 'pending')],
        sizes: [0.5, 0.5]
      })
    )
  })

  it('returns PaneNotFoundError for an unknown paneId', () => {
    const result = closePane(leaf(PANE_A), 'not-a-real-id')

    expect(result).toEqual(Either.left(new PaneNotFoundError({ paneId: 'not-a-real-id' })))
  })

  it('returns LastPaneError when closing the sole remaining pane', () => {
    const result = closePane(leaf(PANE_A), PANE_A)

    expect(result).toEqual(Either.left(new LastPaneError({ paneId: PANE_A })))
  })
})

describe('resizeSplit', () => {
  const nestedTree: PaneNode = {
    _tag: 'Split',
    direction: 'row',
    children: [
      leaf(PANE_A),
      {
        _tag: 'Split',
        direction: 'column',
        children: [leaf(PANE_B), leaf(PANE_C)],
        sizes: [0.5, 0.5]
      }
    ],
    sizes: [0.5, 0.5]
  }

  it('updates the root Split when path is empty', () => {
    const result = resizeSplit(nestedTree, [], [0.3, 0.7])

    expect(result).toEqual(
      Either.right({
        ...nestedTree,
        sizes: [0.3, 0.7]
      })
    )
  })

  it('updates only the targeted nested Split, leaving the outer Split untouched', () => {
    const result = resizeSplit(nestedTree, [1], [0.2, 0.8])

    expect(result).toEqual(
      Either.right({
        ...nestedTree,
        children: [
          leaf(PANE_A),
          {
            _tag: 'Split',
            direction: 'column',
            children: [leaf(PANE_B), leaf(PANE_C)],
            sizes: [0.2, 0.8]
          }
        ]
      })
    )
  })

  it('returns InvalidResizeError for an out-of-bounds path index', () => {
    const result = resizeSplit(nestedTree, [5], [0.5, 0.5])

    expect(Either.isLeft(result)).toBe(true)
    expect(result).toEqual(Either.left(expect.any(InvalidResizeError)))
  })

  it('returns InvalidResizeError when the path resolves to a Leaf', () => {
    const result = resizeSplit(nestedTree, [0], [0.5, 0.5])

    expect(Either.isLeft(result)).toBe(true)
    expect(result).toEqual(Either.left(expect.any(InvalidResizeError)))
  })

  it('returns InvalidResizeError when sizes length does not match children count', () => {
    const result = resizeSplit(nestedTree, [], [0.3, 0.3, 0.4])

    expect(Either.isLeft(result)).toBe(true)
    expect(result).toEqual(Either.left(expect.any(InvalidResizeError)))
  })

  it('returns InvalidResizeError for a non-positive size', () => {
    const result = resizeSplit(nestedTree, [], [0, 1])

    expect(Either.isLeft(result)).toBe(true)
    expect(result).toEqual(Either.left(expect.any(InvalidResizeError)))
  })
})
