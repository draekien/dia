import { Data, Either, Schema } from 'effect'

/** Identifier for a single pane, unique within a window's pane tree. */
export type PaneId = string

/** Schema for a {@link PaneLeaf}. Use `PaneLeafSchema.make({...})` to construct a leaf so the `_tag` is set and fields are validated. */
export const PaneLeafSchema = Schema.TaggedStruct('Leaf', {
  paneId: Schema.UUID,
  status: Schema.Literal('pending', 'ready'),
  cwd: Schema.optional(Schema.String),
  sourceRepo: Schema.optional(Schema.String)
})

/** Schema for a {@link PaneSplit}. Use `PaneSplitSchema.make({...})` to construct a split so the `_tag` is set and fields are validated. */
export const PaneSplitSchema = Schema.TaggedStruct('Split', {
  direction: Schema.Literal('row', 'column'),
  children: Schema.Array(Schema.suspend((): Schema.Schema<PaneNode> => PaneNode)),
  sizes: Schema.Array(Schema.Number)
})

/**
 * A single terminal/session pane — a leaf in the binary pane-split tree.
 *
 * `sourceRepo` is set only when `cwd` points into a worktree, so the UI can display the
 * originating repo instead of the worktree directory name (a bare paneId/GUID).
 */
export type PaneLeaf = typeof PaneLeafSchema.Type

/**
 * A binary split of two child panes along `direction`, with their relative `sizes`. Declared as
 * an interface extending the schema's type so the recursive `children` reference resolves.
 */
export interface PaneSplit extends Schema.Schema.Type<typeof PaneSplitSchema> {}

/** A node in the pane tree: either a leaf pane or a split of child nodes. */
export type PaneNode = PaneLeaf | PaneSplit

/** Schema for validating and decoding a {@link PaneNode} (e.g. when loading persisted state). */
export const PaneNode: Schema.Schema<PaneNode> = Schema.Union(PaneLeafSchema, PaneSplitSchema)

/** Raised when an operation targets a `paneId` that doesn't exist in the tree. */
export class PaneNotFoundError extends Data.TaggedError('PaneNotFoundError')<{
  readonly paneId: PaneId
}> {}

/** Raised by {@link closePane} when asked to close the tree's only remaining pane. */
export class LastPaneError extends Data.TaggedError('LastPaneError')<{
  readonly paneId: PaneId
}> {}

/** Raised by {@link resizeSplit} when the requested sizes are invalid for the target split. */
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
    return Either.right(
      PaneSplitSchema.make({
        direction,
        children: [node, PaneLeafSchema.make({ paneId: newPaneId, status: 'pending' })],
        sizes: [0.5, 0.5]
      })
    )
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

/**
 * Splits the leaf pane identified by `targetPaneId` into a new {@link PaneSplit} containing the
 * original pane and a fresh pending pane (`newPaneId`), divided evenly along `direction`.
 *
 * Fails with {@link PaneNotFoundError} if `targetPaneId` is not found anywhere in `tree`.
 */
export function splitPane(
  tree: PaneNode,
  targetPaneId: PaneId,
  direction: 'row' | 'column',
  newPaneId: PaneId
): Either.Either<PaneNode, PaneNotFoundError> {
  return splitNode(tree, targetPaneId, direction, newPaneId)
}

function markReadyNode(
  node: PaneNode,
  targetPaneId: PaneId,
  cwd: string,
  sourceRepo: string | undefined
): Either.Either<PaneNode, PaneNotFoundError> {
  if (node._tag === 'Leaf') {
    if (node.paneId !== targetPaneId) {
      return Either.left(new PaneNotFoundError({ paneId: targetPaneId }))
    }
    return Either.right({ ...node, status: 'ready', cwd, sourceRepo })
  }

  for (let i = 0; i < node.children.length; i++) {
    const result = markReadyNode(node.children[i], targetPaneId, cwd, sourceRepo)
    if (Either.isRight(result)) {
      const children = node.children.slice()
      children[i] = result.right
      return Either.right({ ...node, children })
    }
  }
  return Either.left(new PaneNotFoundError({ paneId: targetPaneId }))
}

/**
 * Marks the leaf pane identified by `targetPaneId` as `ready`, recording its `cwd` and, if the
 * pane originated from a worktree, its `sourceRepo`. Call once a pane's shell/session has attached.
 *
 * Fails with {@link PaneNotFoundError} if `targetPaneId` is not found anywhere in `tree`.
 */
export function markPaneReady(
  tree: PaneNode,
  targetPaneId: PaneId,
  cwd: string,
  sourceRepo?: string
): Either.Either<PaneNode, PaneNotFoundError> {
  return markReadyNode(tree, targetPaneId, cwd, sourceRepo)
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

/**
 * Removes the leaf pane identified by `targetPaneId` from the tree, collapsing its parent split
 * into the sibling pane that remains.
 *
 * Fails with {@link LastPaneError} if `targetPaneId` is the tree's sole remaining pane (a tree
 * must always have at least one pane), or {@link PaneNotFoundError} if it isn't found.
 */
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

/**
 * Updates the `sizes` of the split located at `path` (a sequence of child indices from the root).
 * An empty `path` targets the root split itself.
 *
 * Fails with {@link InvalidResizeError} if any size is non-positive, `path` does not resolve to a
 * `Split` node, or `sizes` does not match that split's number of children.
 */
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
