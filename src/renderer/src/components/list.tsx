import { Checkbox } from '@base-ui/react/checkbox'
import { mergeProps } from '@base-ui/react/merge-props'
import { useRender } from '@base-ui/react/use-render'
// biome-ignore lint/correctness/useImportExtensions: shadcn add copies this import into consumer projects, which may not allow .ts extensions
import { cn } from '@renderer/lib/cn'
import * as React from 'react'

type ListContextValue = {
  activeValue: string | null
  peekValue: string | null
  selectedValues: ReadonlyArray<string>
  onLinkFocus: (value: string) => void
  onLinkKeyDown: (event: React.KeyboardEvent<HTMLElement>, value: string) => void
  onToggleSelected: (value: string) => void
  onTogglePeek: (value: string) => void
}

const ListContext = React.createContext<ListContextValue | null>(null)

const linkSelector = '[data-slot="list-row-link"]'

const listSelector = '[data-slot="list"]'

const rowSelector = '[data-slot="list-row"]'

const selectSelector = '[data-slot="list-row-select"]'

/** Props for {@link List}. */
export type ListProps = Omit<useRender.ComponentProps<'ul'>, 'defaultValue'> & {
  /** The values of the selected rows. Pass with `onSelectedValuesChange` to control selection. */
  selectedValues?: ReadonlyArray<string>
  /** The values selected on first render when selection is uncontrolled. */
  defaultSelectedValues?: ReadonlyArray<string>
  /** Called with the next selection when X, the row checkbox or Esc changes it. */
  onSelectedValuesChange?: (values: ReadonlyArray<string>) => void
  /** The value of the peeked row, or `null` when peek is closed. Pass with `onPeekValueChange` to control peek. */
  peekValue?: string | null
  /** The row peeked on first render when peek is uncontrolled. */
  defaultPeekValue?: string | null
  /** Called when Space or a `ListRowPeek` toggles peek, Esc closes it, or peek follows focus to another row. */
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

function rowLinks(root: HTMLElement | null): ReadonlyArray<HTMLElement> {
  return root === null
    ? []
    : Array.from(root.querySelectorAll<HTMLElement>(linkSelector)).filter(
        (link) => link.closest(listSelector) === root
      )
}

/**
 * A list of records, one `ListRow` per record. Owns the row keyboard model: the list is one
 * tab stop; ↑ ↓ Home End move focus between rows; Space toggles peek on the focused row and an
 * open peek follows focus; X toggles selection on a row that has a `ListRowSelect`; Esc closes
 * peek, then clears the selection. A `ListRowPeek` toggles peek by pointer.
 * Peek renders nothing itself: read `peekValue` and render a read-only preview of the record's
 * page beside the list, under the row or in a drawer.
 * The list is a grid that its rows share, so their columns line up. Give any other child, such as an
 * inline peek, `col-span-full`.
 */
export function List({
  selectedValues: selectedValuesProp,
  defaultSelectedValues = [],
  onSelectedValuesChange,
  peekValue: peekValueProp,
  defaultPeekValue = null,
  onPeekValueChange,
  render,
  className,
  ref,
  ...props
}: ListProps): React.ReactElement {
  const rootRef = React.useRef<HTMLUListElement>(null)
  const [activeValue, setActiveValue] = React.useState<string | null>(null)
  const [selectedValues, setSelectedValues] = useControllable(
    selectedValuesProp,
    defaultSelectedValues,
    onSelectedValuesChange
  )
  const [peekValue, setPeekValue] = useControllable(
    peekValueProp,
    defaultPeekValue,
    onPeekValueChange
  )

  React.useEffect(() => {
    const links = rowLinks(rootRef.current)
    const first = links[0]?.dataset.value
    if (first === undefined) {
      return
    }
    if (!links.some((link) => link.dataset.value === activeValue)) {
      setActiveValue(first)
    }
  })

  function toggleSelected(value: string) {
    setSelectedValues(
      selectedValues.includes(value)
        ? selectedValues.filter((selected) => selected !== value)
        : [...selectedValues, value]
    )
  }

  function focusLink(link: HTMLElement | undefined) {
    const value = link?.dataset.value
    if (link === undefined || value === undefined) {
      return
    }
    link.focus()
    if (peekValue !== null && peekValue !== value) {
      setPeekValue(value)
    }
  }

  function handleLinkKeyDown(event: React.KeyboardEvent<HTMLElement>, value: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return
    }
    const links = rowLinks(rootRef.current)
    const index = links.indexOf(event.currentTarget)
    switch (event.key) {
      case ' ':
        event.preventDefault()
        setPeekValue(peekValue === value ? null : value)
        return
      case 'x':
      case 'X':
        if (
          (event.currentTarget.closest(rowSelector)?.querySelector(selectSelector) ?? null) === null
        ) {
          return
        }
        event.preventDefault()
        toggleSelected(value)
        return
      case 'ArrowDown':
        event.preventDefault()
        focusLink(links[index + 1])
        return
      case 'ArrowUp':
        event.preventDefault()
        focusLink(links[index - 1])
        return
      case 'Home':
        event.preventDefault()
        focusLink(links[0])
        return
      case 'End':
        event.preventDefault()
        focusLink(links.at(-1))
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

  function togglePeek(value: string) {
    rowLinks(rootRef.current)
      .find((link) => link.dataset.value === value)
      ?.focus()
    setPeekValue(peekValue === value ? null : value)
  }

  const context: ListContextValue = {
    activeValue,
    peekValue,
    selectedValues,
    onLinkFocus: setActiveValue,
    onLinkKeyDown: handleLinkKeyDown,
    onToggleSelected: toggleSelected,
    onTogglePeek: togglePeek
  }

  const element = useRender({
    defaultTagName: 'ul',
    render,
    ref: ref === undefined ? rootRef : [ref, rootRef],
    state: { slot: 'list' },
    props: mergeProps<'ul'>(
      {
        className: cn(
          '@container grid grid-cols-[auto_auto_auto_minmax(0,auto)_minmax(0,1fr)_repeat(8,auto)_auto_auto]',
          className
        )
      },
      props
    )
  })

  return <ListContext.Provider value={context}>{element}</ListContext.Provider>
}

/** Reads the enclosing `List`'s state. Throws when called outside a `List`. */
// biome-ignore lint/style/useComponentExportOnlyModules: the ListRow parts and custom row parts read the list state through this hook
export function useList(): ListContextValue {
  const context = React.useContext(ListContext)
  if (context === null) {
    throw new Error('ListRow must be rendered inside a List.')
  }
  return context
}

type ListRowContextValue =
  | {
      kind: 'record'
      value: string
      nameId: string
      isSelected: boolean
      isPeeked: boolean
    }
  | { kind: 'loading' }

const ListRowContext = React.createContext<ListRowContextValue | null>(null)

function useListRow(part: string): ListRowContextValue {
  const context = React.useContext(ListRowContext)
  if (context === null) {
    throw new Error(`${part} must be rendered inside a ListRow or ListRowLoading.`)
  }
  return context
}

/**
 * How a part behaves when the list is narrow. `"keep"` always draws it in full. `"abbreviate"`
 * swaps it for its short form when the list is narrower than 768px. `"hide"` abbreviates it below
 * 768px and removes it below 640px; a hidden value must still appear in peek and on the item's page.
 */
export type ListRowNarrow = 'keep' | 'abbreviate' | 'hide'

const narrowClass: Readonly<Record<ListRowNarrow, string>> = {
  keep: '',
  abbreviate:
    '@max-abbreviate:**:data-[abbreviation=long]:sr-only @max-abbreviate:**:data-[abbreviation=short]:inline',
  hide: '@max-abbreviate:**:data-[abbreviation=long]:sr-only @max-abbreviate:**:data-[abbreviation=short]:inline @max-hide:hidden'
}

const rowClass =
  'group/list-row col-span-full grid min-h-11 grid-cols-subgrid items-center rounded-floor px-2'

function Bar({ className }: { className: string }) {
  return (
    <span className={cn('block h-2 rounded-full bg-muted motion-safe:animate-pulse', className)} />
  )
}

/** Props for {@link ListRow}. */
export type ListRowProps = useRender.ComponentProps<'li'> & {
  /** The item's unique value. `List` selection and peek refer to rows by this value. */
  value: string
}

/**
 * One item in a `List`. Its parts are named for the rank of the information they hold:
 * `ListRowSubject` (rank 1: what the row is about), one `ListRowFact` per fact the list exists
 * to compare (rank 2), and `ListRowLink` to the item's own page (rank 5). Peek, rendered from
 * `List`'s `peekValue`, previews part of that page read-only; rank 4 is a `preview-card` on a
 * rank 1 or 2 value.
 * Columns line up down the list whatever the values are.
 */
export function ListRow({ value, render, className, ...props }: ListRowProps): React.ReactElement {
  const list = useList()
  const nameId = React.useId()
  const isSelected = list.selectedValues.includes(value)
  const isPeeked = list.peekValue === value

  const element = useRender({
    defaultTagName: 'li',
    render,
    state: { slot: 'list-row', selected: isSelected, peeked: isPeeked },
    props: mergeProps<'li'>(
      {
        className: cn(
          rowClass,
          'hover:bg-foreground/4 data-[selected]:bg-foreground/4 data-[selected]:hover:bg-foreground/7 has-[[data-slot=list-row-link]:focus-visible]:bg-foreground/4 has-[[data-slot=list-row-link]:focus-visible]:inset-ring has-[[data-slot=list-row-link]:focus-visible]:inset-ring-ring/40 data-peeked:bg-foreground/4 data-peeked:inset-ring data-peeked:inset-ring-ring/40',
          className
        )
      },
      props
    )
  })

  return (
    <ListRowContext.Provider value={{ kind: 'record', value, nameId, isSelected, isPeeked }}>
      {element}
    </ListRowContext.Provider>
  )
}

/**
 * A placeholder row shown while items load. Compose the same parts as `ListRow`; each part draws
 * a bar and ignores its children, so the loading row has the columns of the rows that replace it.
 */
export function ListRowLoading({
  render,
  className,
  ...props
}: useRender.ComponentProps<'li'>): React.ReactElement {
  const element = useRender({
    defaultTagName: 'li',
    render,
    state: { slot: 'list-row-loading' },
    props: mergeProps<'li'>({ className: cn(rowClass, className), 'aria-hidden': true }, props)
  })
  return <ListRowContext.Provider value={{ kind: 'loading' }}>{element}</ListRowContext.Provider>
}

/** Props for {@link ListRowSelect}. */
export type ListRowSelectProps = Omit<
  Checkbox.Root.Props,
  'checked' | 'defaultChecked' | 'onCheckedChange' | 'children'
>

const selectClass =
  'col-start-1 flex size-6 shrink-0 items-center justify-center pointer-coarse:size-11'

/**
 * The row's selection checkbox. It is 24×24px, 44×44px on a coarse pointer, and is drawn only on
 * a hovered, focused or selected row, and always on a coarse pointer. It is not a tab stop: X on
 * the focused row toggles it. Its accessible name is "Select" followed by the row's name.
 */
export function ListRowSelect({ className, ...props }: ListRowSelectProps): React.ReactElement {
  const row = useListRow('ListRowSelect')
  const list = useList()
  const labelId = React.useId()

  if (row.kind === 'loading') {
    return <span data-slot="list-row-select" className={selectClass} />
  }

  return (
    <Checkbox.Root
      data-slot="list-row-select"
      tabIndex={-1}
      checked={row.isSelected}
      onCheckedChange={() => list.onToggleSelected(row.value)}
      aria-labelledby={`${labelId} ${row.nameId}`}
      className={cn(
        selectClass,
        'group/select invisible cursor-pointer rounded-floor outline-none data-checked:visible pointer-coarse:visible group-hover/list-row:visible group-has-[[data-slot=list-row-link]:focus-visible]/list-row:visible',
        className
      )}
      {...props}
    >
      <span id={labelId} className="sr-only">
        Select
      </span>
      <span className="flex size-4 items-center justify-center rounded-checkbox border border-input bg-background text-primary-foreground shadow-xs transition-colors group-hover/select:border-muted-foreground group-data-checked/select:border-primary group-data-checked/select:bg-primary">
        <Checkbox.Indicator>
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3">
            <path
              d="M3.5 8.5 6.5 11.5 12.5 4.5"
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

const linkClass = 'col-[2/-3] grid h-full min-h-11 grid-cols-subgrid items-center pl-1'

const peekClass =
  'col-[-3/-2] ml-1 flex size-6 shrink-0 items-center justify-center rounded-floor pointer-coarse:size-11'

/** Props for {@link ListRowPeek}. */
export type ListRowPeekProps = Omit<React.ComponentProps<'button'>, 'children' | 'type'>

/**
 * A button at the end of the row that toggles peek on it, so a pointer reaches peek while a click
 * on `ListRowLink` opens the item's page. It is 24×24px, 44×44px on a coarse pointer, and is
 * drawn only on a hovered, focused or peeked row, and always on a coarse pointer. It is not a tab
 * stop: Space on the focused row toggles peek. Its accessible name is "Peek" followed by the row's
 * name; pass `aria-controls` the id of the element that renders peek.
 */
export function ListRowPeek({ className, ...props }: ListRowPeekProps): React.ReactElement {
  const row = useListRow('ListRowPeek')
  const list = useList()
  const labelId = React.useId()

  if (row.kind === 'loading') {
    return <span data-slot="list-row-peek" className={peekClass} />
  }

  return (
    <button
      {...mergeProps<'button'>(
        {
          type: 'button',
          tabIndex: -1,
          'aria-expanded': row.isPeeked,
          'aria-labelledby': `${labelId} ${row.nameId}`,
          onClick: () => list.onTogglePeek(row.value),
          className: cn(
            peekClass,
            'invisible cursor-pointer text-muted-foreground outline-none transition-colors hover:bg-foreground/7 hover:text-foreground aria-expanded:visible aria-expanded:text-foreground pointer-coarse:visible group-hover/list-row:visible group-has-[[data-slot=list-row-link]:focus-visible]/list-row:visible',
            className
          )
        },
        props
      )}
      data-slot="list-row-peek"
    >
      <span id={labelId} className="sr-only">
        Peek
      </span>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
        <path
          d="M1.75 8S4 3.75 8 3.75 14.25 8 14.25 8 12 12.25 8 12.25 1.75 8 1.75 8Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}

const actionClass = 'col-[-2/-1] ml-1 flex items-center'

/**
 * The row's action control at its end, after `ListRowPeek`: one button, usually the trigger of a
 * menu of the actions the item offers. It is outside `ListRowLink`, so it is its own tab stop and
 * the `List` keys do not reach it. Name it after the row, such as "Actions for invoice REC-104".
 * A loading row draws an empty slot.
 */
export function ListRowAction({
  render,
  className,
  children,
  ...props
}: useRender.ComponentProps<'span'>): React.ReactElement {
  const row = useListRow('ListRowAction')
  const isRecord = row.kind === 'record'
  return useRender({
    defaultTagName: 'span',
    render: isRecord ? render : <span />,
    state: { slot: 'list-row-action' },
    props: mergeProps<'span'>(
      { className: cn(actionClass, className) },
      isRecord ? { ...props, children } : {}
    )
  })
}

/**
 * The link to the item's own page (rank 5), holding `ListRowSubject` and the `ListRowFact`s.
 * Pass your router's link through `render`. It is the row's one focus target and handles the
 * `List` keys.
 */
export function ListRowLink({
  render,
  className,
  children,
  ...props
}: useRender.ComponentProps<'a'>): React.ReactElement {
  const row = useListRow('ListRowLink')
  const list = useList()
  const isRecord = row.kind === 'record'

  return useRender({
    defaultTagName: 'a',
    render: isRecord ? render : <span />,
    state: isRecord ? { slot: 'list-row-link', value: row.value } : { slot: 'list-row-link' },
    props: isRecord
      ? mergeProps<'a'>(
          {
            className: cn(linkClass, 'outline-none', className),
            tabIndex: list.activeValue === row.value ? 0 : -1,
            'aria-expanded': row.isPeeked,
            'aria-keyshortcuts': 'Space X ArrowUp ArrowDown Home End Escape',
            onFocus: () => list.onLinkFocus(row.value),
            onKeyDown: (event) => list.onLinkKeyDown(event, row.value),
            children: (
              <>
                {children}
                {row.isSelected ? <span className="sr-only">, selected</span> : null}
              </>
            )
          },
          props
        )
      : { className: cn(linkClass, className), children }
  })
}

/** Props for a row part. */
export type ListRowPartProps = useRender.ComponentProps<'span'>

/** Props for a row part whose narrow behaviour the caller chooses. */
export type ListRowNarrowPartProps = ListRowPartProps & {
  /** How the part behaves when the list is narrow. Defaults to `"keep"`. */
  narrow?: ListRowNarrow
}

function usePart(
  part: string,
  slot: string,
  partClassName: string,
  placeholder: React.ReactNode,
  { render, className, children, ...props }: ListRowPartProps
) {
  const row = useListRow(part)
  const isRecord = row.kind === 'record'
  return useRender({
    defaultTagName: 'span',
    render: isRecord ? render : <span />,
    state: { slot },
    props: mergeProps<'span'>(
      { className: cn(partClassName, className) },
      isRecord ? { ...props, children } : { children: placeholder }
    )
  })
}

/**
 * Rank 1: what the row is about. Holds an optional `ListRowId` and `ListRowMedia`, then one
 * `ListRowName` and an optional `ListRowDescription`, at the start of the row.
 */
export function ListRowSubject({ children, ...props }: ListRowPartProps): React.ReactElement {
  return usePart(
    'ListRowSubject',
    'list-row-subject',
    'col-[1/5] grid min-w-0 grid-cols-subgrid items-center',
    children,
    { ...props, children }
  )
}

/** The item's ID, such as `REC-104`, in muted tabular figures. */
export function ListRowId({
  narrow = 'keep',
  ...props
}: ListRowNarrowPartProps): React.ReactElement {
  return usePart(
    'ListRowId',
    'list-row-id',
    cn('col-start-1 truncate pr-3 text-muted-foreground text-xs tabular-nums', narrowClass[narrow]),
    <Bar className="w-12" />,
    props
  )
}

const mediaVariantClass = {
  default: '*:flex *:size-full *:items-center *:justify-center **:data-[abbreviation=long]:sr-only',
  icon: 'text-muted-foreground [&_svg]:size-4'
} as const

/** Props for {@link ListRowMedia}. */
export type ListRowMediaProps = ListRowNarrowPartProps &
  (
    | {
        /**
         * `"default"` holds a `status` or `entity` and draws only its media, with its name and
         * description read by screen readers only. `"icon"` holds one muted icon.
         * Defaults to `"default"`.
         */
        variant?: 'default'
      }
    | {
        variant: 'icon'
        /** What the icon stands for, such as "Invoice"; read by screen readers in place of the icon. */
        label: string
      }
  )

function mediaPartProps(props: ListRowMediaProps): ListRowPartProps {
  if (props.variant !== 'icon') {
    const { variant: _variant, narrow: _narrow, ...rest } = props
    return rest
  }
  const { variant: _variant, narrow: _narrow, label, children, ...rest } = props
  return {
    ...rest,
    role: 'img',
    'aria-label': label,
    children: <span aria-hidden="true">{children}</span>
  }
}

/**
 * A 24×24px picture of the item drawn between the ID and the name, such as its status dot, its
 * owner's initials or an icon for its kind.
 */
export function ListRowMedia(props: ListRowMediaProps): React.ReactElement {
  return usePart(
    'ListRowMedia',
    'list-row-media',
    cn(
      'col-start-2 mr-2 flex size-6 items-center justify-center',
      mediaVariantClass[props.variant ?? 'default'],
      narrowClass[props.narrow ?? 'keep']
    ),
    props.variant === 'icon' ? (
      <span className="size-4 rounded-floor bg-muted" />
    ) : (
      <span className="size-2.5 rounded-full bg-muted" />
    ),
    mediaPartProps(props)
  )
}

/**
 * The item's name. It takes the width it needs from what the other columns leave and truncates;
 * it is never hidden.
 */
export function ListRowName(props: ListRowPartProps): React.ReactElement {
  const row = useListRow('ListRowName')
  return usePart(
    'ListRowName',
    'list-row-name',
    'col-start-3 min-w-0 truncate font-medium text-sm',
    <Bar className="w-40 max-w-full" />,
    { ...props, id: row.kind === 'record' ? row.nameId : undefined }
  )
}

/**
 * One line after the name saying what the item is about, in muted text. It fills the width the
 * other columns leave, truncates before the name does, and is hidden when the list is narrower
 * than 640px.
 */
export function ListRowDescription(props: ListRowPartProps): React.ReactElement {
  return usePart(
    'ListRowDescription',
    'list-row-description',
    'col-start-4 min-w-0 truncate pl-3 text-muted-foreground text-sm @max-hide:hidden',
    <Bar className="w-2/3" />,
    props
  )
}

const missingLabel = { unavailable: 'Unavailable', hidden: 'Hidden' } as const

/** Props for {@link ListRowFact}. */
export type ListRowFactProps =
  | (ListRowNarrowPartProps & { missing?: undefined })
  | (Omit<ListRowNarrowPartProps, 'children' | 'render'> & {
      /**
       * Why the fact cannot be shown: `"unavailable"` when it failed to load, `"hidden"` when the
       * viewer's role cannot see it. The fact then draws that word in muted text instead of a
       * value. State why, and how to get access, outside the list, once for every fact it replaces.
       */
      missing: keyof typeof missingLabel
    })

function missingFactProps({
  missing,
  className,
  ...props
}: Extract<ListRowFactProps, { missing: string }>): ListRowPartProps {
  return {
    ...props,
    className: cn('text-muted-foreground', className),
    children: <span className="truncate">{missingLabel[missing]}</span>
  }
}

/**
 * Rank 2: one fact about the subject that the list exists to compare, such as a state or a figure.
 * Each `ListRowFact` is its own column, and the row holds at most eight. Hold one `status`,
 * `entity`, `figure`, `meter` or `relative-time` in it, or set `missing` when the value cannot be
 * shown.
 */
export function ListRowFact({ narrow = 'keep', ...props }: ListRowFactProps): React.ReactElement {
  const factClass = cn('flex min-w-0 items-center pl-4 text-sm', narrowClass[narrow])
  const partProps = props.missing === undefined ? props : missingFactProps(props)
  return usePart('ListRowFact', 'list-row-fact', factClass, <Bar className="w-16" />, partProps)
}
