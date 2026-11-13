import type { GitFileChange, PluginServices } from '@dia/plugin'
import { callHost, cn, followHost } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { ChevronRightIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { FollowRunChanges, GetFileDiff, type RunChanges, type TurnChanges } from './calls'

const PLUGIN = 'dia-checkpoints'

/** Makes the atoms that follow each run's changes for the `dia-checkpoints` renderer entry `ctx`. */
export const makeChangesAtoms = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((runId: string) => Atom.make(followHost(ctx, FollowRunChanges, { runId })))

/** The atom family {@link makeChangesAtoms} makes; {@link ChangesPanel} reads one of its atoms. */
export type ChangesAtoms = ReturnType<typeof makeChangesAtoms>

type LineKind = 'added' | 'deleted' | 'hunk' | 'context'

const kindOf = (line: string): LineKind => {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'deleted'
  return 'context'
}

/** The lines of `patch` from its first hunk on, each with its kind; file headers are dropped. */
export const patchLines = (patch: string): ReadonlyArray<{ text: string; kind: LineKind }> => {
  const lines = patch.replace(/\n$/, '').split('\n')
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'))
  if (firstHunk === -1) return []
  return lines.slice(firstHunk).map((text) => ({ text, kind: kindOf(text) }))
}

/**
 * The summary a turn header shows for the files a turn changed: the file count and the added and
 * deleted line totals, for example `2 files +14 −3`. Binary files count as files with no lines.
 */
export const turnSummary = (files: ReadonlyArray<GitFileChange>): string => {
  const added = files.reduce((sum, file) => sum + file.added, 0)
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0)
  const count = files.length === 1 ? '1 file' : `${files.length} files`
  return `${count} +${added} −${deleted}`
}

const lineClass: Record<LineKind, string> = {
  added: 'bg-primary/10 text-foreground',
  deleted: 'bg-muted text-muted-foreground',
  hunk: 'text-muted-foreground',
  context: 'text-foreground'
}

function Patch({
  runId,
  turn,
  path
}: {
  readonly runId: string
  readonly turn: number
  readonly path: string
}): React.JSX.Element {
  const diffAtom = useMemo(
    () => Atom.make(callHost(PLUGIN, GetFileDiff, { runId, turn, path })),
    [runId, turn, path]
  )
  const result = useAtomValue(diffAtom)
  return AsyncResult.match(result, {
    onInitial: () => <p className="pl-5 text-muted-foreground text-xs">Loading the diff…</p>,
    onFailure: () => (
      <p className="pl-5 text-muted-foreground text-xs">This diff is not available.</p>
    ),
    onSuccess: ({ value }) => {
      const lines = patchLines(value)
      if (lines.length === 0) {
        return <p className="pl-5 text-muted-foreground text-xs">No text changes</p>
      }
      return (
        <pre className="overflow-x-auto rounded-md border py-1 font-mono text-[11px] leading-4">
          {lines.map((line, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: patch lines repeat and carry no id
              key={index}
              className={cn('w-max min-w-full px-2 whitespace-pre', lineClass[line.kind])}
            >
              {line.text}
            </div>
          ))}
        </pre>
      )
    }
  })
}

const fileName = (path: string) => path.split('/').at(-1) ?? path

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

function FileRow({
  runId,
  turn,
  file
}: {
  readonly runId: string
  readonly turn: number
  readonly file: GitFileChange
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <li className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        title={file.path}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
        />
        <span className="shrink-0 font-mono text-xs">{fileName(file.path)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {folderOf(file.path)}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {file.binary ? 'Binary' : `+${file.added} −${file.deleted}`}
        </span>
      </button>
      {open && <Patch runId={runId} turn={turn} path={file.path} />}
    </li>
  )
}

function TurnFiles({
  runId,
  changes
}: {
  readonly runId: string
  readonly changes: TurnChanges
}): React.JSX.Element {
  if (changes._tag === 'TurnOpen') {
    return <p className="text-muted-foreground text-xs">Changes show when this turn ends</p>
  }
  if (changes.files.length === 0) {
    return <p className="text-muted-foreground text-xs">No file changes</p>
  }
  return (
    <ul className="flex flex-col gap-1">
      {changes.files.map((file) => (
        <FileRow key={file.path} runId={runId} turn={changes.turn} file={file} />
      ))}
    </ul>
  )
}

function Turn({
  runId,
  changes
}: {
  readonly runId: string
  readonly changes: TurnChanges
}): React.JSX.Element {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <h3 className="flex min-w-0 items-baseline gap-2 text-xs">
        <span className="shrink-0 text-muted-foreground">Turn {changes.turn}</span>
        <span className="min-w-0 flex-1 truncate font-medium" title={changes.prompt}>
          {changes.prompt}
        </span>
        {changes._tag === 'TurnFinished' && changes.files.length > 0 && (
          <span className="shrink-0 text-muted-foreground tabular-nums">
            {turnSummary(changes.files)}
          </span>
        )}
      </h3>
      <TurnFiles runId={runId} changes={changes} />
    </li>
  )
}

const turnsOf = (changes: RunChanges) => (changes._tag === 'RunTurns' ? changes.turns : [])

/**
 * The right panel's Changes body for run `runId`: its turns, newest first, each headed by its
 * prompt, file count and line totals, with the files it changed; a file opens to its diff. It
 * follows `changesAtoms(runId)` and says so when the run is not in a git repository.
 */
export function ChangesPanel({
  runId,
  changesAtoms
}: {
  readonly runId: string
  readonly changesAtoms: ChangesAtoms
}): React.JSX.Element {
  const result = useAtomValue(changesAtoms(runId))
  const changes = AsyncResult.isSuccess(result) ? Option.getOrUndefined(result.value) : undefined
  if (changes?._tag === 'NotARepository') {
    return <p className="p-3 text-muted-foreground text-sm">Not a git repository</p>
  }
  const turns = changes === undefined ? [] : turnsOf(changes)
  if (turns.length === 0) {
    return <p className="p-3 text-muted-foreground text-sm">No changes yet</p>
  }
  return (
    <ul className="flex flex-col divide-y divide-border p-3">
      {[...turns].reverse().map((turn) => (
        <Turn key={turn.turn} runId={runId} changes={turn} />
      ))}
    </ul>
  )
}
