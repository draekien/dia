export type PaneNode =
  | {
      readonly _tag: 'Leaf'
      readonly paneId: string
      readonly status: 'pending' | 'ready'
      readonly cwd?: string
      readonly sourceRepo?: string
    }
  | {
      readonly _tag: 'Split'
      readonly direction: 'row' | 'column'
      readonly children: ReadonlyArray<PaneNode>
      readonly sizes: ReadonlyArray<number>
    }

export type ChooseDirectoryResult = { readonly path: string; readonly isGitRepo: boolean } | null

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
      createPane(paneId: string, cwd: string, model: string, useWorktree: boolean): void
      getInitialLayout(): Promise<PaneNode>
      chooseDirectory(): Promise<ChooseDirectoryResult>
      onMessageAppended(
        listener: (event: {
          paneId: string
          message: { role: 'user' | 'assistant'; content: string }
        }) => void
      ): () => void
      onLayoutChanged(listener: (event: { tree: PaneNode }) => void): () => void
      onPaneCreateFailed(listener: (event: { paneId: string; reason: string }) => void): () => void
    }
  }
}
