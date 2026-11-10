import { Checkbox } from '@base-ui/react/checkbox'
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import * as React from 'react'

/** The order of a sorted column. */
export type TableSortDirection = 'ascending' | 'descending'

/** The one sorted column, named by the `column` of its `TableHead`. */
export type TableSort = { column: string; direction: TableSortDirection }

type RowTarget =
  | { kind: 'record'; value: string }
  | { kind: 'group'; value: string; values: ReadonlyArray<string> }

type TableContextValue = {
  isInteractive: boolean
  isSortable: boolean
  isSelectable: boolean
  sort: TableSort | null
  activeValue: string | null
  peekValue: string | null
  selectedValues: ReadonlyArray<string>
  expandedValues: ReadonlyArray<string>
  onSort: (column: string) => void
  onRowFocus: (value: string) => void
  onRowKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>, row: RowTarget) => void
  onToggleSelected: (values: ReadonlyArray<string>) => void
  onToggleExpanded: (value: string) => void
}

const TableContext = React.createContext<TableContextValue | null>(null)

const rowSelector = 'tbody > tr[data-value]'

const linkSelector = '[data-slot="table-row-link"]'

const selectSelector = '[data-slot="table-row-select"]'

/** Props for {@link Table}. */
export type TableProps = useRender.ComponentProps<'table'> & {
  /** The sorted column, or `null` when none is. Pass with `onSortChange` to control the sort. */
  sort?: TableSort | null
  /** The sort on first render when the sort is uncontrolled. */
  defaultSort?: TableSort | null
  /** Called with the next sort when a sortable `TableHead` is pressed. Sort the rows yourself. */
  onSortChange?: (sort: TableSort) => void
  /** The values of the expanded rows. Pass with `onExpandedValuesChange` to control expansion. */
  expandedValues?: ReadonlyArray<string>
  /** The rows expanded on first render when expansion is uncontrolled. */
  defaultExpandedValues?: ReadonlyArray<string>
  /** Called with the next expanded rows when → ← Enter Space or a `TableRowExpand` changes them. */
  onExpandedValuesChange?: (values: ReadonlyArray<string>) => void
  /** The values of the selected rows. Pass with `onSelectedValuesChange` to control selection. */
  selectedValues?: ReadonlyArray<string>
  /** The values selected on first render when selection is uncontrolled. */
  defaultSelectedValues?: ReadonlyArray<string>
  /** Called with the next selection when X, Shift+Space, a row checkbox or Esc changes it. */
  onSelectedValuesChange?: (values: ReadonlyArray<string>) => void
  /** The value of the peeked row, or `null` when peek is closed. Pass with `onPeekValueChange` to control peek. */
  peekValue?: string | null
  /** The row peeked on first render when peek is uncontrolled. */
  defaultPeekValue?: string | null
  /** Called when Space toggles peek, Esc closes it, or peek follows focus to another row. */
  onPeekValueChange?: (value: string | null) => void
}

function useControllable<TValue>(
  controlled: TValue | undefined,
  defaultValue: TValue,
  onChange: ((value: TValue) => void) | undefined
) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue)
  const isControlled = controlled !== undefined
  const value = isControlled ? controlled : uncontrolled
  function setValue(next: TValue) {
    if (!isControlled) {
      setUncontrolled(next)
    }
    onChange?.(next)
  }
  return [value, setValue] as const
}

function isSet(...props: ReadonlyArray<unknown>): boolean {
  return props.some((prop) => prop !== undefined)
}

function bodyRows(root: HTMLElement | null): ReadonlyArray<HTMLTableRowElement> {
  return root === null ? [] : Array.from(root.querySelectorAll<HTMLTableRowElement>(rowSelector))
}

function rowLevel(row: HTMLElement): number {
  return Number(row.getAttribute('aria-level') ?? '1')
}

function parentRow(
  rows: ReadonlyArray<HTMLTableRowElement>,
  row: HTMLTableRowElement
): HTMLTableRowElement | undefined {
  const level = rowLevel(row)
  return rows
    .slice(0, rows.indexOf(row))
    .reverse()
    .find((other) => rowLevel(other) < level)
}

function recordRow(
  rows: ReadonlyArray<HTMLTableRowElement>,
  row: HTMLTableRowElement | undefined
): HTMLTableRowElement | undefined {
  if (row === undefined || row.dataset.slot === 'table-group-row') {
    return undefined
  }
  return row.querySelector(linkSelector) === null ? recordRow(rows, parentRow(rows, row)) : row
}

function headerButtons(element: HTMLElement): ReadonlyArray<HTMLButtonElement> {
  const head = element.closest('table')?.tHead
  if (head === null || head === undefined) {
    return []
  }
  return Array.from(head.querySelectorAll('button')).filter(
    (button) => typeof button.checkVisibility !== 'function' || button.checkVisibility()
  )
}

/**
 * A table for comparing values down a column. Use it in place of shadcn/ui's `Table`; its parts
 * keep their names and add the rest of the table elements, sorting, child rows, group rows,
 * selection and peek.
 *
 * Pass any of `sort`, `expandedValues`, `selectedValues` or `peekValue`, or their `default` and
 * `on…Change` props, and the table becomes a treegrid with one tab stop on its rows: give each
 * body `TableRow` a `value`. ↑ ↓ Home End move between rows; → expands a row, then moves into
 * it; ← collapses it, then moves to its parent; ↑ from the first row moves to the sorted header,
 * ← → move between headers and ↓ returns to the rows; while the body has no row to focus, each
 * sortable header is a tab stop. Enter opens the row's `TableRowLink` and
 * toggles a group; Space peeks the row when the table sets a peek prop, and toggles a group; on a row without a link both act on
 * its parent. X and Shift+Space toggle selection on a row with a `TableRowSelect`; Esc closes
 * peek, then clears the selection. The table sorts, groups and loads nothing: render the rows
 * in order, and only the children of expanded rows.
 *
 * The table names itself from its `TableCaption`. When narrower than 768px, a part marked
 * `narrow="abbreviate"` shows its short form; when narrower than 640px, a part marked
 * `narrow="hide"` is removed: mark a column's `TableHead` and its `TableCell`s alike, and keep
 * the hidden values in peek and on the row's page.
 */
export function Table({
  sort: sortProp,
  defaultSort,
  onSortChange,
  expandedValues: expandedValuesProp,
  defaultExpandedValues,
  onExpandedValuesChange,
  selectedValues: selectedValuesProp,
  defaultSelectedValues,
  onSelectedValuesChange,
  peekValue: peekValueProp,
  defaultPeekValue,
  onPeekValueChange,
  render,
  className,
  ref,
  ...props
}: TableProps): React.ReactElement {
  const rootRef = React.useRef<HTMLTableElement>(null)
  const [activeValue, setActiveValue] = React.useState<string | null>(null)
  const [sort, setSort] = useControllable<TableSort | null>(
    sortProp,
    defaultSort ?? null,
    onSortChange === undefined ? undefined : (next) => next !== null && onSortChange(next)
  )
  const [expandedValues, setExpandedValues] = useControllable(
    expandedValuesProp,
    defaultExpandedValues ?? [],
    onExpandedValuesChange
  )
  const [selectedValues, setSelectedValues] = useControllable(
    selectedValuesProp,
    defaultSelectedValues ?? [],
    onSelectedValuesChange
  )
  const [peekValue, setPeekValue] = useControllable(
    peekValueProp,
    defaultPeekValue ?? null,
    onPeekValueChange
  )
  const isSortable = isSet(sortProp, defaultSort, onSortChange)
  const isSelectable = isSet(selectedValuesProp, defaultSelectedValues, onSelectedValuesChange)
  const isPeekable = isSet(peekValueProp, defaultPeekValue, onPeekValueChange)
  const isInteractive =
    isSortable ||
    isSelectable ||
    isPeekable ||
    isSet(expandedValuesProp, defaultExpandedValues, onExpandedValuesChange)

  React.useEffect(() => {
    if (
      activeValue !== null &&
      rootRef.current?.querySelector(`${rowSelector}[data-value="${CSS.escape(activeValue)}"]`)
    ) {
      return
    }
    const first = bodyRows(rootRef.current)[0]?.dataset.value ?? null
    if (first !== activeValue) {
      setActiveValue(first)
    }
  })

  function sortBy(column: string) {
    setSort({
      column,
      direction:
        sort?.column === column && sort.direction === 'ascending' ? 'descending' : 'ascending'
    })
  }

  function toggleSelected(values: ReadonlyArray<string>) {
    const isAllSelected = values.every((value) => selectedValues.includes(value))
    setSelectedValues(
      isAllSelected
        ? selectedValues.filter((selected) => !values.includes(selected))
        : [...selectedValues, ...values.filter((value) => !selectedValues.includes(value))]
    )
  }

  function setExpanded(value: string, isExpanded: boolean) {
    if (expandedValues.includes(value) === isExpanded) {
      return
    }
    setExpandedValues(
      isExpanded
        ? [...expandedValues, value]
        : expandedValues.filter((expanded) => expanded !== value)
    )
  }

  function focusRow(
    rows: ReadonlyArray<HTMLTableRowElement>,
    row: HTMLTableRowElement | undefined
  ) {
    if (row === undefined) {
      return
    }
    row.focus()
    const record = recordRow(rows, row)?.dataset.value
    if (peekValue !== null && record !== undefined && record !== peekValue) {
      setPeekValue(record)
    }
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLTableRowElement>, target: RowTarget) {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    const row = event.currentTarget
    const rows = bodyRows(rootRef.current)
    const index = rows.indexOf(row)
    const isExpandable = row.hasAttribute('aria-expanded')
    const isExpanded = row.getAttribute('aria-expanded') === 'true'
    switch (event.key) {
      case ' ': {
        event.preventDefault()
        if (event.shiftKey) {
          toggleRowSelected(row, target)
        } else if (target.kind === 'group') {
          setExpanded(target.value, !isExpanded)
        } else {
          const record = recordRow(rows, row)?.dataset.value
          if (isPeekable && record !== undefined) {
            setPeekValue(peekValue === record ? null : record)
          }
        }
        return
      }
      case 'x':
      case 'X':
        event.preventDefault()
        toggleRowSelected(row, target)
        return
      case 'Enter':
        event.preventDefault()
        if (target.kind === 'group') {
          setExpanded(target.value, !isExpanded)
        } else {
          recordRow(rows, row)?.querySelector<HTMLElement>(linkSelector)?.click()
        }
        return
      case 'ArrowRight':
        event.preventDefault()
        if (!isExpandable) {
          return
        }
        if (isExpanded) {
          focusRow(rows, rows[index + 1])
        } else {
          setExpanded(target.value, true)
        }
        return
      case 'ArrowLeft':
        event.preventDefault()
        if (isExpanded) {
          setExpanded(target.value, false)
        } else {
          focusRow(rows, parentRow(rows, row))
        }
        return
      case 'ArrowDown':
        event.preventDefault()
        focusRow(rows, rows[index + 1])
        return
      case 'ArrowUp': {
        event.preventDefault()
        if (index > 0) {
          focusRow(rows, rows[index - 1])
          return
        }
        const buttons = headerButtons(row)
        ;(buttons.find((button) => button.closest('[aria-sort]') !== null) ?? buttons[0])?.focus()
        return
      }
      case 'Home':
        event.preventDefault()
        focusRow(rows, rows[0])
        return
      case 'End':
        event.preventDefault()
        focusRow(rows, rows.at(-1))
        return
      case 'Escape':
        if (peekValue !== null) {
          setPeekValue(null)
        } else if (selectedValues.length > 0) {
          setSelectedValues([])
        }
        return
      default:
        return
    }
  }

  function toggleRowSelected(row: HTMLTableRowElement, target: RowTarget) {
    if (row.querySelector(selectSelector) === null) {
      return
    }
    toggleSelected(target.kind === 'group' ? target.values : [target.value])
  }

  const context: TableContextValue = {
    isInteractive,
    isSortable,
    isSelectable,
    sort,
    activeValue,
    peekValue,
    selectedValues,
    expandedValues,
    onSort: sortBy,
    onRowFocus: setActiveValue,
    onRowKeyDown: handleRowKeyDown,
    onToggleSelected: toggleSelected,
    onToggleExpanded: (value) => setExpanded(value, !expandedValues.includes(value))
  }

  const element = useRender({
    defaultTagName: 'table',
    render,
    ref: ref === undefined ? rootRef : [ref, rootRef],
    state: { slot: 'table' },
    props: mergeProps<'table'>(
      {
        role: isInteractive ? 'treegrid' : undefined,
        'aria-multiselectable': isSelectable ? true : undefined,
        className: cn('w-full caption-top border-collapse text-sm', className)
      },
      props
    )
  })

  return (
    <TableContext.Provider value={context}>
      <div data-slot="table-container" className="@container relative w-full overflow-x-auto">
        {element}
      </div>
    </TableContext.Provider>
  )
}

/** Reads the enclosing `Table`'s state. Throws when called outside a `Table`. */
// biome-ignore lint/style/useComponentExportOnlyModules: custom row parts read the table state through this hook
export function useTable(): TableContextValue {
  const context = React.useContext(TableContext)
  if (context === null) {
    throw new Error('Table parts must be rendered inside a Table.')
  }
  return context
}

/**
 * The table's name, drawn above it. Screen readers announce the table by it; hide it with
 * `sr-only` when a heading beside the table already names it.
 */
export function TableCaption({
  render,
  className,
  ...props
}: useRender.ComponentProps<'caption'>): React.ReactElement {
  return useRender({
    defaultTagName: 'caption',
    render,
    state: { slot: 'table-caption' },
    props: mergeProps<'caption'>(
      { className: cn('pb-2 text-left font-medium text-sm', className) },
      props
    )
  })
}

/** A group of `TableColumn`s, placed after `TableCaption` and before `TableHeader`. */
export function TableColumnGroup({
  render,
  ...props
}: useRender.ComponentProps<'colgroup'>): React.ReactElement {
  return useRender({
    defaultTagName: 'colgroup',
    render,
    state: { slot: 'table-column-group' },
    props
  })
}

/** One column, or `span` columns, of a `TableColumnGroup`; set its width with `className`. */
export function TableColumn({
  render,
  ...props
}: useRender.ComponentProps<'col'>): React.ReactElement {
  return useRender({ defaultTagName: 'col', render, state: { slot: 'table-column' }, props })
}

type Section = 'head' | 'body' | 'foot'

const SectionContext = React.createContext<Section>('body')

/** The header rows, holding one `TableHead` per column. */
export function TableHeader({
  render,
  className,
  ...props
}: useRender.ComponentProps<'thead'>): React.ReactElement {
  const element = useRender({
    defaultTagName: 'thead',
    render,
    state: { slot: 'table-header' },
    props: mergeProps<'thead'>({ className }, props)
  })
  return <SectionContext.Provider value="head">{element}</SectionContext.Provider>
}

/** The body rows. Use one `TableBody` per run of rows, or one for the whole table. */
export function TableBody({
  render,
  ...props
}: useRender.ComponentProps<'tbody'>): React.ReactElement {
  const element = useRender({
    defaultTagName: 'tbody',
    render,
    state: { slot: 'table-body' },
    props
  })
  return <SectionContext.Provider value="body">{element}</SectionContext.Provider>
}

/** Summary rows, such as totals, after the body. */
export function TableFooter({
  render,
  className,
  ...props
}: useRender.ComponentProps<'tfoot'>): React.ReactElement {
  const element = useRender({
    defaultTagName: 'tfoot',
    render,
    state: { slot: 'table-footer' },
    props: mergeProps<'tfoot'>({ className: cn('font-medium', className) }, props)
  })
  return <SectionContext.Provider value="foot">{element}</SectionContext.Provider>
}

type RowContextValue =
  | { kind: 'static' }
  | { kind: 'loading' }
  | {
      kind: 'record' | 'group'
      value: string
      values: ReadonlyArray<string>
      nameId: string
      selectedCount: number
      isExpanded: boolean
      setHasSelect: (hasSelect: boolean) => void
      setHasExpand: (hasExpand: boolean) => void
    }

const RowContext = React.createContext<RowContextValue>({ kind: 'static' })

const rowKeyShortcuts =
  'Space Shift+Space X Enter ArrowUp ArrowDown ArrowLeft ArrowRight Home End Escape'

const rowClass =
  'group/table-row relative isolate *:first:before:pointer-events-none *:first:before:absolute *:first:before:inset-0 *:first:before:-z-1'

const edgeRowClass =
  'relative isolate *:first:before:pointer-events-none *:first:before:absolute *:first:before:inset-0 *:first:before:-z-1 *:first:before:bg-muted'

const staticRowClass: Record<Section, string> = {
  head: cn(edgeRowClass, '*:first:before:rounded-t-floor'),
  body: rowClass,
  foot: cn(edgeRowClass, '*:first:before:rounded-b-floor')
}

function handleRowClick(event: React.MouseEvent<HTMLTableRowElement>) {
  const isControl =
    event.target instanceof Element &&
    event.target.closest("a, button, input, label, [role='checkbox']") !== null
  if (isControl || window.getSelection()?.isCollapsed === false) {
    return
  }
  event.currentTarget.querySelector<HTMLElement>(linkSelector)?.click()
}

function useBodyRow(
  kind: 'record' | 'group',
  value: string,
  values: ReadonlyArray<string>,
  level: number
) {
  const table = useTable()
  const nameId = React.useId()
  const [hasSelect, setHasSelect] = React.useState(false)
  const [hasExpand, setHasExpand] = React.useState(false)
  const isExpanded = table.expandedValues.includes(value)
  const selectedCount = values.filter((selected) => table.selectedValues.includes(selected)).length
  const isSelected = values.length > 0 && selectedCount === values.length
  const isPeeked = table.peekValue === value
  const target: RowTarget = kind === 'group' ? { kind, value, values } : { kind, value }

  const context: RowContextValue = {
    kind,
    value,
    values,
    nameId,
    selectedCount,
    isExpanded,
    setHasSelect,
    setHasExpand
  }
  const state = {
    slot: kind === 'group' ? 'table-group-row' : 'table-row',
    value,
    peeked: isPeeked
  }
  const props: React.ComponentProps<'tr'> = table.isInteractive
    ? {
        tabIndex: table.activeValue === value ? 0 : -1,
        'aria-level': level,
        'aria-expanded': hasExpand ? isExpanded : undefined,
        'aria-selected': table.isSelectable && hasSelect ? isSelected : undefined,
        'aria-labelledby': nameId,
        'aria-keyshortcuts': rowKeyShortcuts,
        onFocus: (event) => {
          if (event.target === event.currentTarget) {
            table.onRowFocus(value)
          }
        },
        onKeyDown: (event) => table.onRowKeyDown(event, target)
      }
    : {}
  return { context, state, props }
}

/** Props for {@link TableRow}. */
export type TableRowProps = useRender.ComponentProps<'tr'> & {
  /**
   * The row's unique value. `Table` focus, expansion, selection and peek refer to rows by it.
   * Give one to every body row of a table that sets any of those props; omit it in header and
   * footer rows.
   */
  value?: string
  /** The row's depth: 1 for a top-level row, 2 for its children, and so on. Defaults to 1. */
  level?: number
}

/**
 * One row. In a body, give it a `value` to make it a record: a row whose `TableRowLink` opens its
 * page, or a child row under a record, drawn after it with a `level` one higher.
 */
export function TableRow({ value, level, ...props }: TableRowProps): React.ReactElement {
  return value === undefined ? (
    <StaticRow {...props} />
  ) : (
    <BodyRow kind="record" value={value} values={[value]} level={level ?? 1} {...props} />
  )
}

function StaticRow({ render, className, ...props }: useRender.ComponentProps<'tr'>) {
  const section = React.useContext(SectionContext)
  return useRender({
    defaultTagName: 'tr',
    render,
    state: { slot: 'table-row' },
    props: mergeProps<'tr'>({ className: cn(staticRowClass[section], className) }, props)
  })
}

function BodyRow({
  kind,
  value,
  values,
  level,
  render,
  className,
  ...props
}: useRender.ComponentProps<'tr'> & {
  kind: 'record' | 'group'
  value: string
  values: ReadonlyArray<string>
  level: number
}) {
  const row = useBodyRow(kind, value, values, level)
  const element = useRender({
    defaultTagName: 'tr',
    render,
    state: row.state,
    props: mergeProps<'tr'>(
      row.props,
      {
        onClick: handleRowClick,
        className: cn(
          rowClass,
          'has-data-[slot=table-row-link]:cursor-pointer outline-none focus-visible:*:first:before:inset-ring focus-visible:*:first:before:inset-ring-ring/40 data-peeked:*:first:before:inset-ring data-peeked:*:first:before:inset-ring-ring/40',
          kind === 'group'
            ? 'h-9 *:first:before:bg-muted/40 hover:*:first:before:bg-muted/70 pointer-coarse:h-11'
            : 'h-11 hover:*:first:before:bg-foreground/4 focus-visible:*:first:before:bg-foreground/4 data-peeked:*:first:before:bg-foreground/4 aria-selected:*:first:before:bg-foreground/4 aria-selected:hover:*:first:before:bg-foreground/7',
          className
        )
      },
      props
    )
  })
  return <RowContext.Provider value={row.context}>{element}</RowContext.Provider>
}

/** Props for {@link TableGroupRow}. */
export type TableGroupRowProps = useRender.ComponentProps<'tr'> & {
  /** The group's unique value; it is expanded while this value is in `expandedValues`. */
  value: string
  /** The values of the rows in the group, which its `TableRowSelect` selects together. */
  values: ReadonlyArray<string>
  /** The group's depth. Defaults to 1. */
  level?: number
}

/**
 * The header row of a group, such as every invoice with one status. Hold a `TableRowExpand`, the
 * group's name in a `TableHead`, and its counts and sums in the columns they total; keep them
 * when the group is collapsed. Enter and Space toggle it; render its rows after it only while it
 * is expanded, and hide a group with no rows.
 */
export function TableGroupRow({
  value,
  values,
  level,
  ...props
}: TableGroupRowProps): React.ReactElement {
  return <BodyRow kind="group" value={value} values={values} level={level ?? 1} {...props} />
}

/**
 * A placeholder row shown while rows load. Compose the same cells as the rows that replace it;
 * each cell with children draws a bar in their place.
 */
export function TableRowLoading({
  render,
  className,
  ...props
}: useRender.ComponentProps<'tr'>): React.ReactElement {
  const element = useRender({
    defaultTagName: 'tr',
    render,
    state: { slot: 'table-row-loading' },
    props: mergeProps<'tr'>(
      { className: cn(rowClass, 'h-11', className), 'aria-hidden': true },
      props
    )
  })
  return <RowContext.Provider value={{ kind: 'loading' }}>{element}</RowContext.Provider>
}

/**
 * How a column behaves when the table is narrow. `"keep"` always draws it in full. `"abbreviate"`
 * swaps its values for their short form when the table is narrower than 768px. `"hide"`
 * abbreviates it below 768px and removes it below 640px.
 */
export type TableNarrow = 'keep' | 'abbreviate' | 'hide'

const narrowClass: Readonly<Record<TableNarrow, string>> = {
  keep: '',
  abbreviate:
    '@max-abbreviate:**:data-[abbreviation=long]:sr-only @max-abbreviate:**:data-[abbreviation=short]:inline',
  hide: '@max-abbreviate:**:data-[abbreviation=long]:sr-only @max-abbreviate:**:data-[abbreviation=short]:inline @max-hide:hidden'
}

/** Props for {@link TableHead} and {@link TableCell}. */
type CellOptions = {
  /** `"end"` right-aligns the column in tabular figures, for numbers. Defaults to `"start"`. */
  align?: 'start' | 'end'
  /** How the column behaves when the table is narrow. Defaults to `"keep"`. */
  narrow?: TableNarrow
}

function Bar({ className }: { className: string }) {
  return (
    <span
      className={cn('block h-2 rounded-floor bg-foreground/8 motion-safe:animate-pulse', className)}
    />
  )
}

function cellClass({ align = 'start', narrow = 'keep' }: CellOptions): string {
  return cn(
    'whitespace-nowrap px-2 align-middle',
    align === 'end' && 'text-right tabular-nums',
    narrowClass[narrow]
  )
}

/** Props for {@link TableHead}. */
export type TableHeadProps = Omit<useRender.ComponentProps<'th'>, 'align'> &
  CellOptions & {
    /**
     * In `TableHeader`, the column's key. When the `Table` is sortable, the header becomes a
     * button that sorts by this key and carries `aria-sort` while it is the sorted column.
     */
    column?: string
  }

/**
 * A header cell. In `TableHeader` it names a column; in a body or footer row it names the row,
 * holding the row's `TableRowLink` or the group's name. Screen readers read a row by its header.
 */
export function TableHead({
  column,
  align,
  narrow,
  render,
  className,
  children,
  ...props
}: TableHeadProps): React.ReactElement {
  const section = React.useContext(SectionContext)
  const table = useTable()
  const row = React.useContext(RowContext)
  const isColumnHeader = section === 'head'
  const direction =
    column !== undefined && table.sort?.column === column ? table.sort.direction : null
  const isSortButton = isColumnHeader && column !== undefined && table.isSortable

  return useRender({
    defaultTagName: 'th',
    render,
    state: { slot: 'table-head' },
    props: mergeProps<'th'>(
      {
        scope: isColumnHeader ? 'col' : 'row',
        id: row.kind === 'record' || row.kind === 'group' ? row.nameId : undefined,
        'aria-sort': isSortButton ? (direction ?? undefined) : undefined,
        className: cn(
          'text-left',
          cellClass({ align, narrow }),
          isColumnHeader
            ? 'h-9 font-medium text-muted-foreground text-xs'
            : 'font-normal has-data-[slot=table-row-link]:w-full has-data-[slot=table-row-link]:max-w-0',
          className
        ),
        children:
          row.kind === 'loading' && children !== undefined && children !== null ? (
            <Bar className="w-32 max-w-full" />
          ) : isSortButton ? (
            <SortButton column={column} direction={direction} align={align ?? 'start'}>
              {children}
            </SortButton>
          ) : (
            children
          )
      },
      props
    )
  })
}

function handleHeaderKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
  const buttons = headerButtons(event.currentTarget)
  const index = buttons.indexOf(event.currentTarget)
  switch (event.key) {
    case 'ArrowRight':
      event.preventDefault()
      buttons[index + 1]?.focus()
      return
    case 'ArrowLeft':
      event.preventDefault()
      buttons[index - 1]?.focus()
      return
    case 'ArrowDown':
      event.preventDefault()
      event.currentTarget
        .closest('table')
        ?.querySelector<HTMLElement>(`${rowSelector}[tabindex="0"]`)
        ?.focus()
      return
    default:
      return
  }
}

function SortButton({
  column,
  direction,
  align,
  children
}: {
  column: string
  direction: TableSortDirection | null
  align: 'start' | 'end'
  children: React.ReactNode
}) {
  const table = useTable()
  return (
    <button
      type="button"
      tabIndex={table.activeValue === null ? 0 : -1}
      onClick={() => table.onSort(column)}
      onKeyDown={handleHeaderKeyDown}
      className={cn(
        'group/sort inline-flex min-h-6 cursor-pointer items-center gap-related rounded-floor font-medium outline-hidden hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11',
        align === 'end' && 'flex-row-reverse',
        direction !== null && 'text-foreground'
      )}
    >
      {children}
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn(
          'size-3.5 shrink-0',
          direction === null &&
            'invisible group-hover/sort:visible group-focus-visible/sort:visible pointer-coarse:visible',
          direction === 'descending' && 'rotate-180'
        )}
      >
        <path
          d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/** Props for {@link TableCell}. */
export type TableCellProps = Omit<useRender.ComponentProps<'td'>, 'align'> & CellOptions

function isRowControl(children: React.ReactNode): boolean {
  return (
    React.isValidElement(children) &&
    (children.type === TableRowSelect || children.type === TableRowExpand)
  )
}

/**
 * A data cell. In a `TableRowLoading` a cell with children draws a bar in their place, except a
 * `TableRowSelect` or `TableRowExpand`, which keeps its size.
 */
export function TableCell({
  align,
  narrow,
  render,
  className,
  children,
  ...props
}: TableCellProps): React.ReactElement {
  const row = React.useContext(RowContext)
  const table = useTable()
  return useRender({
    defaultTagName: 'td',
    render,
    state: { slot: 'table-cell' },
    props: mergeProps<'td'>(
      {
        role: table.isInteractive ? 'gridcell' : undefined,
        className: cn(cellClass({ align, narrow }), className),
        children:
          row.kind === 'loading' &&
          children !== undefined &&
          children !== null &&
          !isRowControl(children) ? (
            <Bar className={cn('w-16', align === 'end' && 'ml-auto')} />
          ) : (
            children
          )
      },
      props
    )
  })
}

/**
 * One muted line under a cell's value, drawn only when the table is narrower than 640px: put a
 * hidden column's value here, such as the due date under the customer.
 */
export function TableCellDetail({
  render,
  className,
  ...props
}: useRender.ComponentProps<'span'>): React.ReactElement {
  return useRender({
    defaultTagName: 'span',
    render,
    state: { slot: 'table-cell-detail' },
    props: mergeProps<'span'>(
      { className: cn('block truncate text-muted-foreground text-xs @hide:hidden', className) },
      props
    )
  })
}

function useBodyRowPart(part: string) {
  const row = React.useContext(RowContext)
  if (row.kind === 'static') {
    throw new Error(
      `${part} must be rendered inside a TableRow with a value, a TableGroupRow or a TableRowLoading.`
    )
  }
  return row
}

const controlClass = 'flex size-6 shrink-0 items-center justify-center pointer-coarse:size-11'

/** Props for {@link TableRowSelect}. */
export type TableRowSelectProps = Omit<
  Checkbox.Root.Props,
  'checked' | 'defaultChecked' | 'indeterminate' | 'onCheckedChange' | 'children'
>

/**
 * The row's selection checkbox; a row without one cannot be selected. In a `TableGroupRow` it
 * selects every row in the group and shows mixed while only some are. It is 24×24px, 44×44px on
 * a coarse pointer, drawn only on a hovered, focused or selected row and always on a coarse
 * pointer. It is not a tab stop: X or Shift+Space on the focused row toggles it.
 */
export function TableRowSelect({ className, ...props }: TableRowSelectProps): React.ReactElement {
  const row = useBodyRowPart('TableRowSelect')
  const table = useTable()
  const labelId = React.useId()
  const setHasSelect = row.kind === 'loading' ? null : row.setHasSelect

  React.useEffect(() => {
    setHasSelect?.(true)
    return () => setHasSelect?.(false)
  }, [setHasSelect])

  if (row.kind === 'loading') {
    return <span data-slot="table-row-select" className={controlClass} />
  }

  const { selectedCount } = row
  return (
    <Checkbox.Root
      data-slot="table-row-select"
      tabIndex={-1}
      checked={row.values.length > 0 && selectedCount === row.values.length}
      indeterminate={selectedCount > 0 && selectedCount < row.values.length}
      onCheckedChange={() => table.onToggleSelected(row.values)}
      aria-labelledby={`${labelId} ${row.nameId}`}
      className={cn(
        controlClass,
        'group/select invisible cursor-pointer rounded-floor outline-none data-checked:visible data-indeterminate:visible pointer-coarse:visible group-hover/table-row:visible group-focus-visible/table-row:visible',
        className
      )}
      {...props}
    >
      <span id={labelId} className="sr-only">
        Select
      </span>
      <span className="flex size-4 items-center justify-center rounded-checkbox border border-input bg-background text-primary-foreground shadow-xs transition-colors group-hover/select:border-muted-foreground group-data-checked/select:border-primary group-data-checked/select:bg-primary group-data-indeterminate/select:border-primary group-data-indeterminate/select:bg-primary">
        <Checkbox.Indicator>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3">
            <path
              d={selectedCount < row.values.length ? 'M4 8h8' : 'M3.5 8.5 6.5 11.5 12.5 4.5'}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Checkbox.Indicator>
      </span>
    </Checkbox.Root>
  )
}

/** Props for {@link TableRowExpand}. */
export type TableRowExpandProps = Omit<React.ComponentProps<'button'>, 'children' | 'type'>

/**
 * The chevron that shows or hides the row's children; render it only on a row that has children.
 * It is 24×24px, 44×44px on a coarse pointer, and not a tab stop: → and ← on the focused row
 * expand and collapse it. Its accessible name is "Expand" or "Collapse", described by the row's
 * name.
 */
export function TableRowExpand({ className, ...props }: TableRowExpandProps): React.ReactElement {
  const row = useBodyRowPart('TableRowExpand')
  const table = useTable()
  const setHasExpand = row.kind === 'loading' ? null : row.setHasExpand

  React.useEffect(() => {
    setHasExpand?.(true)
    return () => setHasExpand?.(false)
  }, [setHasExpand])

  if (row.kind === 'loading') {
    return <span data-slot="table-row-expand" className={controlClass} />
  }

  return (
    <button
      {...mergeProps<'button'>(
        {
          type: 'button',
          tabIndex: -1,
          'aria-label': row.isExpanded ? 'Collapse' : 'Expand',
          'aria-describedby': row.nameId,
          onClick: () => table.onToggleExpanded(row.value),
          className: cn(
            controlClass,
            'cursor-pointer rounded-floor text-muted-foreground transition-colors hover:bg-foreground/7 hover:text-foreground',
            className
          )
        },
        props
      )}
      data-slot="table-row-expand"
    >
      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className={cn('size-4 motion-safe:transition-transform', row.isExpanded && 'rotate-90')}
      >
        <path
          d="M6 3.5 10.5 8 6 12.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}

/**
 * The link to the row's own page, holding the row's name. A click anywhere on the row follows
 * it, except on the row's checkbox and chevron; Enter on the focused row follows it too. Pass
 * your router's link through `render`. It is not a tab stop: the row is.
 */
export function TableRowLink({
  render,
  className,
  children,
  ...props
}: useRender.ComponentProps<'a'>): React.ReactElement {
  const row = useBodyRowPart('TableRowLink')
  const isLoading = row.kind === 'loading'
  return useRender({
    defaultTagName: 'a',
    render: isLoading ? <span /> : render,
    state: { slot: 'table-row-link' },
    props: isLoading
      ? { className: 'block', children: <Bar className="w-32 max-w-full" /> }
      : mergeProps<'a'>(
          {
            tabIndex: -1,
            className: cn('block truncate font-medium outline-none', className),
            children
          },
          props
        )
  })
}
