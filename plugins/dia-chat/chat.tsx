import { useTabOpenedFromNewAgent, useView, useWorkspace } from '@dia/renderer-plugin'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import { ArchivedTranscript } from './archived-transcript'
import { NewThreadPage } from './new-thread-page'
import Pane from './pane'

/**
 * The chat for the visible tab, filling the `main.tab` slot; an archived tab shows its transcript
 * read-only, and the new-thread view shows the new-thread page for its draft. Renders nothing for
 * any other view, or when the tab is gone.
 */
export function Chat() {
  const view = useView()
  const workspace = useWorkspace()
  const focusComposer = useTabOpenedFromNewAgent()
  if (view?._tag === 'NewThreadView')
    return <NewThreadPage key={view.draftId} draftId={view.draftId} />
  if (view?._tag !== 'TabView' || workspace === undefined) return null
  const found = tabOf(workspace, view.paneId)
  if (Result.isFailure(found)) return null
  const { config, archived } = found.success.tab
  const { project } = found.success
  if (archived)
    return <ArchivedTranscript key={config.paneId} paneId={config.paneId} cwd={config.cwd} />
  return (
    <Pane
      key={config.paneId}
      paneId={config.paneId}
      cwd={config.cwd}
      model={config.model}
      thinkingLevel={config.thinkingLevel}
      permissionMode={config.permissionMode}
      focusComposer={focusComposer}
      projectName={project.displayName}
      branch={config.worktree?.branch}
    />
  )
}
