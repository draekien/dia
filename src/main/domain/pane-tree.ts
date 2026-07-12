import { Data, Either, Schema } from 'effect'

export type PaneId = string

export interface PaneLeaf {
  readonly _tag: 'Leaf'
  readonly paneId: PaneId
}

export interface PaneSplit {
  readonly _tag: 'Split'
  readonly direction: 'row' | 'column'
  readonly children: ReadonlyArray<PaneNode>
  readonly sizes: ReadonlyArray<number>
}

export type PaneNode = PaneLeaf | PaneSplit

const PaneLeafSchema = Schema.TaggedStruct('Leaf', {
  paneId: Schema.UUID
})

const PaneSplitSchema = Schema.TaggedStruct('Split', {
  direction: Schema.Literal('row', 'column'),
  children: Schema.Array(Schema.suspend((): Schema.Schema<PaneNode> => PaneNode)),
  sizes: Schema.Array(Schema.Number)
})

export const PaneNode: Schema.Schema<PaneNode> = Schema.Union(PaneLeafSchema, PaneSplitSchema)

export class PaneNotFoundError extends Data.TaggedError('PaneNotFoundError')<{
  readonly paneId: PaneId
}> {}

export class LastPaneError extends Data.TaggedError('LastPaneError')<{
  readonly paneId: PaneId
}> {}

export class InvalidResizeError extends Data.TaggedError('InvalidResizeError')<{
  readonly reason: string
}> {}

function splitNode(
  node: PaneNode,
  targetPaneId: PaneId,
  direction: 'row' | 'column',
  newPaneId: PaneId
): Either.Either<PaneNode, PaneNotFoundError> {
  if (node._tag === 'Leaf') {
    if (node.paneId !== targetPaneId) {
      return Either.left(new PaneNotFoundError({ paneId: targetPaneId }))
    }
    return Either.right({
      _tag: 'Split',
      direction,
      children: [node, { _tag: 'Leaf', paneId: newPaneId }],
      sizes: [0.5, 0.5]
    })
  }

  for (let i = 0; i < node.children.length; i++) {
    const result = splitNode(node.children[i], targetPaneId, direction, newPaneId)
    if (Either.isRight(result)) {
      const children = node.children.slice()
      children[i] = result.right
      return Either.right({ ...node, children })
    }
  }
  return Either.left(new PaneNotFoundError({ paneId: targetPaneId }))
}

export function splitPane(
  tree: PaneNode,
  targetPaneId: PaneId,
  direction: 'row' | 'column',
  newPaneId: PaneId
): Either.Either<PaneNode, PaneNotFoundError> {
  return splitNode(tree, targetPaneId, direction, newPaneId)
}

function closeNode(
  node: PaneSplit,
  targetPaneId: PaneId
): Either.Either<PaneNode, PaneNotFoundError> {
  const targetIndex = node.children.findIndex(
    (child) => child._tag === 'Leaf' && child.paneId === targetPaneId
  )
  if (targetIndex !== -1) {
    const remaining = node.children.filter((_, i) => i !== targetIndex)
    // Every Split is created with exactly 2 children (splitPane) and only ever loses one at a
    // time, so removing one child always collapses the Split into its sole remaining sibling.
    return Either.right(remaining[0])
  }

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (child._tag !== 'Split') continue
    const result = closeNode(child, targetPaneId)
    if (Either.isRight(result)) {
      const children = node.children.slice()
      children[i] = result.right
      return Either.right({ ...node, children })
    }
  }
  return Either.left(new PaneNotFoundError({ paneId: targetPaneId }))
}

export function closePane(
  tree: PaneNode,
  targetPaneId: PaneId
): Either.Either<PaneNode, PaneNotFoundError | LastPaneError> {
  if (tree._tag === 'Leaf') {
    if (tree.paneId === targetPaneId) {
      return Either.left(new LastPaneError({ paneId: targetPaneId }))
    }
    return Either.left(new PaneNotFoundError({ paneId: targetPaneId }))
  }
  return closeNode(tree, targetPaneId)
}

export function resizeSplit(
  tree: PaneNode,
  path: ReadonlyArray<number>,
  sizes: ReadonlyArray<number>
): Either.Either<PaneNode, InvalidResizeError> {
  if (sizes.some((size) => size <= 0)) {
    return Either.left(new InvalidResizeError({ reason: 'sizes must all be positive' }))
  }

  if (path.length === 0) {
    if (tree._tag !== 'Split') {
      return Either.left(new InvalidResizeError({ reason: 'root is not a Split' }))
    }
    if (sizes.length !== tree.children.length) {
      return Either.left(
        new InvalidResizeError({ reason: "sizes length must match the split's children count" })
      )
    }
    return Either.right({ ...tree, sizes })
  }

  if (tree._tag !== 'Split') {
    return Either.left(new InvalidResizeError({ reason: 'path traverses into a Leaf' }))
  }

  const [index, ...rest] = path
  const child = tree.children[index]
  if (child === undefined) {
    return Either.left(new InvalidResizeError({ reason: 'path index out of bounds' }))
  }

  return Either.map(resizeSplit(child, rest, sizes), (updatedChild) => {
    const children = tree.children.slice()
    children[index] = updatedChild
    return { ...tree, children }
  })
}
