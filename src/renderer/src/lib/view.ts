import type { PaneId } from '@shared/domain/pane'
import { ProjectId, type Workspace } from '@shared/domain/project'
import { Uuid } from '@shared/domain/uuid'
import { Option, Schema } from 'effect'

/** The content area shows the tab `paneId`. */
export const TabView = Schema.TaggedStruct('TabView', { paneId: Uuid })
export type TabView = typeof TabView.Type

/** The content area shows the New agent form for project `projectId`. */
export const NewAgentView = Schema.TaggedStruct('NewAgentView', { projectId: ProjectId })
export type NewAgentView = typeof NewAgentView.Type

/** The content area shows the first-run screen: no project is registered. */
export const FirstRunView = Schema.TaggedStruct('FirstRunView', {})
export type FirstRunView = typeof FirstRunView.Type

/** The content area offers "New agent": projects exist but no tab is visible. */
export const EmptyProjectView = Schema.TaggedStruct('EmptyProjectView', {})
export type EmptyProjectView = typeof EmptyProjectView.Type

/** What the content area shows. Read it with `useView()`; switch on `_tag`. */
export const View = Schema.Union([TabView, NewAgentView, FirstRunView, EmptyProjectView])
export type View = typeof View.Type

/**
 * The open New agent form: the project it creates a tab in, and the tab that was visible when it
 * opened. The form closes once the workspace shows a different tab.
 */
export interface NewAgentForm {
  readonly projectId: ProjectId
  readonly shownBefore: PaneId | null
}

/**
 * The New agent form to show when the user asks for one in project `projectId`. A form opened
 * over another open form keeps the earlier form's `shownBefore`, because the earlier form already
 * hid that tab and `visibleTab` is `null` while any form is open.
 */
export const openNewAgentForm = (
  current: Option.Option<NewAgentForm>,
  projectId: ProjectId,
  visibleTab: PaneId | null
): NewAgentForm => ({
  projectId,
  shownBefore: Option.match(current, {
    onNone: () => visibleTab,
    onSome: (form) => form.shownBefore
  })
})

/**
 * Whether a workspace change closes the open New agent form: true when the workspace now shows a
 * tab other than the one visible when the form opened, or the form's project is gone.
 */
export const closesNewAgentForm = (form: NewAgentForm, workspace: Workspace): boolean =>
  (workspace.visibleTab !== null && workspace.visibleTab !== form.shownBefore) ||
  !workspace.projects.some((entry) => entry.project.projectId === form.projectId)

/**
 * The {@link View} for a workspace and the open New agent form, in priority order: the form while
 * it is open, else the visible tab, else the first-run screen when no project exists, else the
 * empty-project prompt. `undefined` until the workspace has loaded.
 */
export const viewOf = (
  workspace: Option.Option<Workspace>,
  form: Option.Option<NewAgentForm>
): View | undefined => {
  if (Option.isNone(workspace)) return undefined
  if (Option.isSome(form)) return NewAgentView.make({ projectId: form.value.projectId })
  if (workspace.value.visibleTab !== null) {
    return TabView.make({ paneId: workspace.value.visibleTab })
  }
  if (workspace.value.projects.length === 0) return FirstRunView.make({})
  return EmptyProjectView.make({})
}
