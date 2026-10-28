import {
  actions,
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
  cn,
  SidebarMenuButton,
  SidebarMenuItem,
  StatusIndicator,
  statusLabel,
  useSidebar
} from '@dia/renderer-plugin'
import type { AgentSummary } from '@shared/domain/agent-summary'
import { AgentName } from '@shared/domain/project'
import { Option, Schema } from 'effect'
import { useState } from 'react'
import { type OverviewRow, rowKey } from './overview'

const decodeName = Schema.decodeUnknownOption(AgentName)

/**
 * The second line of a row: the reason for a row that needs input or failed, else the activity
 * line. `mono` is true for a tool call, which is literal output.
 */
export const secondLine = (
  summary: AgentSummary
): { readonly text: string; readonly mono: boolean } => {
  switch (summary.status._tag) {
    case 'StatusNeedsInput':
    case 'StatusFailed':
      return { text: summary.status.reason, mono: false }
  }
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
  readonly projectName: string
  readonly selected: boolean
  readonly renaming: boolean
  readonly tabbable: boolean
  readonly onRename: (renaming: boolean) => void
}

/**
 * One agent in the overview: its status dot, name and second line. Clicking it or pressing
 * `Enter` shows the agent's tab; `F2` or the row menu renames it.
 */
export function AgentRow({
  row,
  projectName,
  selected,
  renaming,
  tabbable,
  onRename
}: AgentRowProps) {
  const collapsed = useSidebar().state === 'collapsed'
  const line = secondLine(row.summary)
  const status = statusLabel(row.summary.status)
  const label = `${row.name}, ${status}. ${line.text}`
  const summaryText = `${projectName} / ${row.name} · ${status} · ${line.text}`
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
        <SidebarMenuButton asChild size="lg" isActive={selected} className={buttonClass}>
          <div data-nav={rowKey(row.paneId)}>
            {body(<RenameField row={row} onDone={() => onRename(false)} />)}
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }
  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            isActive={selected}
            tooltip={summaryText}
            data-nav={rowKey(row.paneId)}
            tabIndex={tabbable ? 0 : -1}
            aria-label={collapsed ? summaryText : label}
            aria-current={selected ? 'page' : undefined}
            title={collapsed ? undefined : `${projectName} / ${row.name}`}
            onClick={() => actions.selectTab(row.paneId)}
            onKeyDown={(event) => {
              if (event.key === 'F2') {
                event.preventDefault()
                onRename(true)
              }
            }}
            className={buttonClass}
          >
            {body(<span className="truncate text-sm text-ink">{row.name}</span>)}
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuGroup>
            <ContextMenuItem onSelect={() => actions.selectTab(row.paneId)}>Show</ContextMenuItem>
            <ContextMenuItem onSelect={() => onRename(true)}>
              Rename
              <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuGroup>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  )
}
