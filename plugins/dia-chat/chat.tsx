import {
  useAttachedSessions,
  useTabOpenedFromNewAgent,
  useView,
  useWorkspace
} from '@dia/renderer-plugin'
import { tabOf } from '@shared/domain/workspace'
import { Result } from 'effect'
import { ArchivedTranscript } from './archived-transcript'
import Pane from './pane'

/**
 * The chat for the visible tab or the open attached session (ADR-0070), filling the `main.tab`
 * slot; an archived tab shows its transcript read-only, and an attached session hides the
 * controls its owner sets. Renders nothing for any other view, or when the tab or session is gone.
 */
export function Chat() {
  const view = useView()
  const workspace = useWorkspace()
  const attachedSessions = useAttachedSessions()
  const focusComposer = useTabOpenedFromNewAgent()
  if (view?._tag === 'AttachedView') {
    const attached = attachedSessions.find((session) => session.config.paneId === view.paneId)
    if (attached === undefined) return null
    const { config } = attached
    const project = workspace?.projects.find(
      (entry) => entry.project.projectId === attached.projectId
    )?.project
    return (
      <Pane
        key={config.paneId}
        paneId={config.paneId}
        cwd={config.cwd}
        model={config.model}
        thinkingLevel={config.thinkingLevel}
        permissionMode={config.permissionMode}
        projectName={project?.displayName}
        fixedSettings
      />
    )
  }
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
