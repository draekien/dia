import type { PaneId } from '@dia/plugin'

/** The example plugin's right panel body: names the pane it is shown for. */
export function ExamplePanel({ paneId }: { readonly paneId: PaneId }) {
  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <p className="text-ink">The example plugin added this panel.</p>
      <p className="text-ink-muted">
        Pane <span className="font-mono text-xs">{paneId}</span>
      </p>
    </div>
  )
}
