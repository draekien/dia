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

export type PermissionRequest = {
  readonly requestId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
}

export type PaneError = { readonly message: string }

export type AttentionState =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'AwaitingPermission'; readonly request: PermissionRequest }
  | { readonly _tag: 'Errored'; readonly error: PaneError }
  | { readonly _tag: 'Completed' }

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
      onAttentionChanged(
        listener: (event: { paneId: string; attention: AttentionState }) => void
      ): () => void
      onPermissionRequested(
        listener: (event: PermissionRequest & { paneId: string }) => void
      ): () => void
      onAssistantTextDelta(listener: (event: { paneId: string; text: string }) => void): () => void
    }
  }
}
