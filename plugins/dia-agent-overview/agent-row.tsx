import {
  actions,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
  cn,
  formatResetTime,
  permissionModeLabel,
  SidebarMenuButton,
  SidebarMenuItem,
  StatusIndicator,
  statusLabel,
  toast,
  useSidebar
} from '@dia/renderer-plugin'
import type { AgentSummary } from '@shared/domain/agent-summary'
import type { PermissionMode } from '@shared/domain/pane'
import { AgentName } from '@shared/domain/project'
import { Option, Schema } from 'effect'
import { useState } from 'react'
import { type OverviewRow, rowKey } from './overview'
import type { Retirement } from './retire-agent-dialog'

const decodeName = Schema.decodeUnknownOption(AgentName)

/**
 * The second line of a row: the reason for a row that needs input or failed, the resume or reset time
 * of a parked row (`nowMs` defaults to now), else the turn's
 * named state (such as a retry), else the activity line. `mono` is true for a tool call, which is literal output.
 */
export const secondLine = (
  summary: AgentSummary,
  // @effect-diagnostics-next-line globalDate:off -- the row reads the resume time against the wall clock; no Effect runtime exists in the renderer.
  nowMs: number = Date.now()
): { readonly text: string; readonly mono: boolean } => {
  switch (summary.status._tag) {
    case 'StatusNeedsInput':
    case 'StatusFailed':
      return { text: summary.status.reason, mono: false }
    case 'StatusParked':
      return {
        text: `${summary.status.resumedBy === 'dia' ? 'Resumes' : 'Resets'} ${formatResetTime(summary.status.until, nowMs)}`,
        mono: false
      }
  }
  if (summary.turnStatus !== undefined) return { text: summary.turnStatus, mono: false }
  switch (summary.activity._tag) {
    case 'Todo':
      return { text: summary.activity.text, mono: false }
    case 'ToolUse':
      return {
        text:
          summary.activity.target === null
            ? summary.activity.tool
            : `${summary.activity.tool} ${summary.activity.target}`,
        mono: true
      }
    case 'NoActivity':
      return { text: 'No activity yet', mono: false }
  }
}

/**
 * The words an overview row adds after the tab name for the tab's permission mode `mode`: the
 * mode's label for `bypassPermissions`, which runs tools without asking, and `null` for every other mode.
 */
export const modeMarker = (mode: PermissionMode): string | null =>
  mode === 'bypassPermissions' ? permissionModeLabel(mode) : null

function RenameField({ row, onDone }: { readonly row: OverviewRow; readonly onDone: () => void }) {
  const [value, setValue] = useState<string>(row.name)
  const decoded = decodeName(value.trim())
  const commit = () => {
    if (Option.isSome(decoded) && decoded.value !== row.name)
      actions.renameTab(row.paneId, decoded.value)
    onDone()
  }
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: F2 and "Rename" move focus into the field they open
      autoFocus
      aria-label={`Rename ${row.name}`}
      aria-invalid={Option.isNone(decoded)}
      value={value}
      maxLength={64}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter' && Option.isSome(decoded)) commit()
        if (event.key === 'Escape') onDone()
      }}
      className="w-full min-w-0 rounded-sm border border-ring bg-surface px-1 text-sm text-ink outline-none aria-invalid:border-error"
    />
  )
}

interface AgentRowProps {
  readonly row: OverviewRow
  readonly projectName: string | null
  readonly selected: boolean
  readonly renaming: boolean
  readonly tabbable: boolean
  readonly archived: boolean
  readonly onRename: (renaming: boolean) => void
  readonly onRetire: (retirement: Retirement) => void
  readonly onStartOver?: (() => void) | undefined
}

/**
 * Unarchives the agent of `row`, and shows the reason in an error toast when its working
 * directory could not be restored.
 */
const unarchive = (row: OverviewRow): Promise<void> =>
  actions.unarchiveTab(row.paneId).then(
    (reason) => {
      if (reason !== null) {
        toast.add({ title: `Could not unarchive ${row.name}`, description: reason, type: 'error' })
      }
    },
    () => {
      toast.add({
        title: `Could not unarchive ${row.name}`,
        description: "The connection to dia's background process was lost.",
        type: 'error'
      })
    }
  )

/**
 * One agent in the overview: its status dot, name and second line. Clicking it or pressing
 * `Enter` shows the agent's tab; `F2` or the row menu renames it. The row menu also archives an
 * agent that is not `archived` through `onRetire`, unarchives one that is, and deletes any agent
 * through `onRetire`. A row with a `caption` is an attached session (ADR-0070): it shows a
 * non-empty caption after the name, opens the session, and its menu shows it and, when
 * `onStartOver` is given, offers Start over. A `projectName` of null leaves the project out of the
 * tooltip and accessible name.
 */
export function AgentRow({
  row,
  projectName,
  selected,
  renaming,
  tabbable,
  archived,
  onRename,
  onRetire,
  onStartOver
}: AgentRowProps) {
  const collapsed = useSidebar().state === 'collapsed'
  const line = secondLine(row.summary)
  const status = statusLabel(row.summary.status)
  const marker = modeMarker(row.permissionMode)
  const markerSuffix = marker === null ? '' : ` · ${marker}`
  const attached = row.caption !== null
  const fullName = row.caption ? `${row.name} (${row.caption})` : row.name
  const place = projectName === null ? fullName : `${projectName} / ${fullName}`
  const label = `${fullName}, ${status}. ${line.text}${markerSuffix}`
  const summaryText = `${place} · ${status} · ${line.text}${markerSuffix}`
  const show = () => (attached ? actions.selectAttached(row.paneId) : actions.selectTab(row.paneId))
  const body = (name: React.ReactNode) => (
    <>
      <StatusIndicator status={row.summary.status} />
      <span className="flex min-w-0 flex-1 flex-col group-data-[collapsible=icon]:hidden">
        {name}
        <span className={cn('truncate text-xs text-ink-muted', line.mono && 'font-mono')}>
          {line.text}
        </span>
      </span>
    </>
  )
  const buttonClass = 'cursor-default group-data-[collapsible=icon]:justify-center'
  if (renaming) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          render={<div data-nav={rowKey(row.paneId)} />}
          size="lg"
          isActive={selected}
          className={buttonClass}
        >
          {body(<RenameField row={row} onDone={() => onRename(false)} />)}
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }
  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger
          render={
            <SidebarMenuButton
              size="lg"
              isActive={selected}
              tooltip={summaryText}
              data-nav={rowKey(row.paneId)}
              tabIndex={tabbable ? 0 : -1}
              aria-label={collapsed ? summaryText : label}
              aria-current={selected ? 'page' : undefined}
              title={collapsed ? undefined : place}
              onClick={show}
              onKeyDown={(event) => {
                if (event.key === 'F2' && !attached) {
                  event.preventDefault()
                  onRename(true)
                }
              }}
              className={buttonClass}
            >
              {body(
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm text-ink">{row.name}</span>
                  {row.caption && (
                    <span className="min-w-0 truncate text-xs text-ink-muted">{row.caption}</span>
                  )}
                  {marker !== null && (
                    <span className="ml-auto shrink-0 text-xs font-medium text-ink">{marker}</span>
                  )}
                </span>
              )}
            </SidebarMenuButton>
          }
        />
        <ContextMenuContent className="w-48">
          <ContextMenuGroup>
            <ContextMenuItem onClick={show}>Show</ContextMenuItem>
            {!attached && (
              <ContextMenuItem onClick={() => onRename(true)}>
                Rename
                <ContextMenuShortcut>F2</ContextMenuShortcut>
              </ContextMenuItem>
            )}
          </ContextMenuGroup>
          {onStartOver !== undefined && (
            <>
              <ContextMenuSeparator />
              <ContextMenuGroup>
                <ContextMenuItem onClick={onStartOver}>Start over</ContextMenuItem>
              </ContextMenuGroup>
            </>
          )}
          {!attached && <ContextMenuSeparator />}
          {!attached && (
            <ContextMenuGroup>
              {archived ? (
                <ContextMenuItem onClick={() => void unarchive(row)}>Unarchive</ContextMenuItem>
              ) : (
                <ContextMenuItem onClick={() => onRetire('archive')}>Archive</ContextMenuItem>
              )}
              <ContextMenuItem variant="destructive" onClick={() => onRetire('delete')}>
                Delete…
              </ContextMenuItem>
            </ContextMenuGroup>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  )
}
