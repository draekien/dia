export type PaneNode =
  | { readonly _tag: 'Leaf'; readonly paneId: string }
  | {
      readonly _tag: 'Split'
      readonly direction: 'row' | 'column'
      readonly children: ReadonlyArray<PaneNode>
      readonly sizes: ReadonlyArray<number>
    }

declare global {
  interface Window {
    dia: {
      sendMessage(paneId: string, text: string): void
      resolvePermission(
        paneId: string,
        requestId: string,
        decision: 'allow' | 'deny',
        message?: string
      ): void
      splitPane(paneId: string, direction: 'row' | 'column'): void
      closePane(paneId: string): void
      getInitialLayout(): Promise<PaneNode>
      onMessageAppended(
        listener: (event: {
          paneId: string
          message: { role: 'user' | 'assistant'; content: string }
        }) => void
      ): () => void
      onLayoutChanged(listener: (event: { tree: PaneNode }) => void): () => void
    }
  }
}
