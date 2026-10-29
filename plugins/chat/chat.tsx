import { useTabOpenedFromNewAgent, useView, useWorkspace } from '@dia/renderer-plugin'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import Pane from './pane'

/**
 * The chat for the visible tab, filling the `main.tab` slot. Renders nothing when the view is not
 * a tab or the tab no longer exists in the workspace.
 */
export function Chat() {
  const view = useView()
  const workspace = useWorkspace()
  const focusComposer = useTabOpenedFromNewAgent()
  if (view?._tag !== 'TabView' || workspace === undefined) return null
  const found = tabOf(workspace, view.paneId)
  if (Result.isFailure(found)) return null
  const { config } = found.success.tab
  return (
    <Pane
      key={config.paneId}
      paneId={config.paneId}
      cwd={config.cwd}
      model={config.model}
      thinkingLevel={config.thinkingLevel}
      permissionMode={config.permissionMode}
      focusComposer={focusComposer}
    />
  )
}
