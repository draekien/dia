import { Effect } from 'effect'
import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * What a {@link PluginBoundary} renders in place of a component that threw: `error` is the thrown
 * value, and `retry` renders the component again.
 */
export type PluginFallback = (error: unknown, retry: () => void) => ReactNode

type PluginBoundaryProps = {
  readonly plugin: string
  readonly at: string
  readonly resetKey: unknown
  readonly fallback?: PluginFallback
  readonly children: ReactNode
}

type PluginBoundaryState = {
  readonly resetKey: unknown
  readonly failure: { readonly error: unknown } | undefined
}

/**
 * Renders `children`, a component `plugin` supplied for slot `at`. When it throws while rendering,
 * renders `fallback` (nothing by default) in its place and logs the error, so the rest of the
 * window keeps working. Renders `children` again when the fallback calls `retry`, or once
 * `resetKey` changes; pass the component being drawn, so a plugin that reloads with a new
 * component is shown again.
 */
export class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  override state: PluginBoundaryState = { resetKey: this.props.resetKey, failure: undefined }

  static getDerivedStateFromError(error: unknown): Partial<PluginBoundaryState> {
    return { failure: { error } }
  }

  static getDerivedStateFromProps(
    props: PluginBoundaryProps,
    state: PluginBoundaryState
  ): Partial<PluginBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { resetKey: props.resetKey, failure: undefined }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    Effect.runFork(
      Effect.logError('A plugin component failed to render', {
        plugin: this.props.plugin,
        at: this.props.at,
        error,
        componentStack: info.componentStack
      })
    )
  }

  private readonly retry = (): void => {
    Effect.runFork(
      Effect.logDebug('Rendering a failed plugin component again', {
        plugin: this.props.plugin,
        at: this.props.at
      })
    )
    this.setState({ failure: undefined })
  }

  override render(): ReactNode {
    const { failure } = this.state
    if (failure === undefined) return this.props.children
    return this.props.fallback?.(failure.error, this.retry) ?? null
  }
}
