import type { PaneId } from '@shared/domain/pane'
import type { Workspace } from '@shared/domain/project'
import { Uuid } from '@shared/domain/uuid'
import { PluginName } from '@shared/plugin/manifest'
import { Option, Schema } from 'effect'

/**
 * Names a page plugin `plugin` added to the layout plugin's `PagesSlot` and the page `id` it gave.
 * `target`, when present, is passed to the page, which reads it to choose what it shows.
 */
export const PageKey = Schema.Struct({
  plugin: PluginName,
  id: Schema.String,
  target: Schema.optional(Schema.String)
})
export type PageKey = typeof PageKey.Type

/** The content area shows page `id` of plugin `plugin`. */
export const PageView = Schema.TaggedStruct('PageView', PageKey.fields)
export type PageView = typeof PageView.Type

/** The content area shows the tab `paneId`. */
export const TabView = Schema.TaggedStruct('TabView', { paneId: Uuid })
export type TabView = typeof TabView.Type

/** The content area shows the new-thread page for draft `draftId`. */
export const NewThreadView = Schema.TaggedStruct('NewThreadView', { draftId: Uuid })
export type NewThreadView = typeof NewThreadView.Type

/** What the content area shows. Read it with `useView()`; switch on `_tag`. */
export const View = Schema.Union([PageView, TabView, NewThreadView])
export type View = typeof View.Type

/**
 * The open new-thread page: the draft it edits, and the tab that was visible when it opened. The
 * page closes once the workspace shows a different tab.
 */
export interface NewThreadForm {
  readonly draftId: Uuid
  readonly shownBefore: PaneId | null
}

/**
 * The open page, and the tab that was visible before it (or before the new-thread page it replaced)
 * opened. The page closes once the workspace shows a different tab.
 */
export interface OpenPage {
  readonly key: PageKey
  readonly shownBefore: PaneId | null
}

/**
 * Whether a workspace change closes the open page: true when the workspace now shows a tab other
 * than the one visible before it opened.
 */
export const closesOpenPage = (open: OpenPage, workspace: Workspace): boolean =>
  workspace.visibleTab !== null && workspace.visibleTab !== open.shownBefore

/**
 * The new-thread page to show when the user opens draft `draftId`. A page opened over another open
 * new-thread page keeps the earlier page's `shownBefore`, because the earlier page already hid that
 * tab and `visibleTab` is `null` while any new-thread page is open.
 */
export const openNewThreadForm = (
  current: Option.Option<NewThreadForm>,
  draftId: Uuid,
  visibleTab: PaneId | null
): NewThreadForm => ({
  draftId,
  shownBefore: Option.match(current, {
    onNone: () => visibleTab,
    onSome: (form) => form.shownBefore
  })
})

/**
 * Whether a workspace change closes the open new-thread page: true when the workspace now shows a
 * tab other than the one visible when the page opened.
 */
export const closesNewThreadForm = (form: NewThreadForm, workspace: Workspace): boolean =>
  workspace.visibleTab !== null && workspace.visibleTab !== form.shownBefore

/**
 * The {@link View} for a workspace, the open new-thread page and the open page, in priority order:
 * the page while it is open, else the new-thread page while it is open, else the visible tab, else
 * the new-thread page for draft `fallbackDraftId`. `undefined` until the workspace has loaded.
 */
export const viewOf = (
  workspace: Option.Option<Workspace>,
  form: Option.Option<NewThreadForm>,
  page: Option.Option<OpenPage>,
  fallbackDraftId: Uuid
): View | undefined => {
  if (Option.isNone(workspace)) return undefined
  if (Option.isSome(page)) return PageView.make(page.value.key)
  if (Option.isSome(form)) return NewThreadView.make({ draftId: form.value.draftId })
  if (workspace.value.visibleTab !== null) {
    return TabView.make({ paneId: workspace.value.visibleTab })
  }
  return NewThreadView.make({ draftId: fallbackDraftId })
}
