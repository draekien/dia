import type { GitFileChange, PluginServices } from '@dia/plugin'
import { callHost, cn, followHost } from '@dia/renderer-plugin'
import { useAtomValue } from '@effect/atom-react'
import { Option } from 'effect'
import { AsyncResult, Atom } from 'effect/reactivity'
import { ChevronRightIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { FollowRunChanges, GetFileDiff, type TurnChanges } from './calls'

const PLUGIN = 'dia-checkpoints'

/** Makes the atoms that follow each run's turns for the `dia-checkpoints` renderer entry `ctx`. */
export const makeChangesAtoms = (ctx: Pick<PluginServices, 'name'>) =>
  Atom.family((runId: string) => Atom.make(followHost(ctx, FollowRunChanges, { runId })))

/** The atom family {@link makeChangesAtoms} makes; {@link ChangesCard} reads one of its atoms. */
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
    onInitial: () => <p className="text-muted-foreground">Loading the diff…</p>,
    onFailure: () => <p className="text-muted-foreground">This diff is not available.</p>,
    onSuccess: ({ value }) => {
      const lines = patchLines(value)
      if (lines.length === 0) return <p className="text-muted-foreground">No text changes</p>
      return (
        <pre className="max-h-64 overflow-auto rounded-md border font-mono text-[11px] leading-4">
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
    <li className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        title={file.path}
        onClick={() => setOpen((value) => !value)}
        className="flex min-w-0 items-center gap-1.5 rounded-sm text-left hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{fileName(file.path)}</span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {file.binary ? 'Binary' : `+${file.added} −${file.deleted}`}
        </span>
      </button>
      {open && <Patch runId={runId} turn={turn} path={file.path} />}
    </li>
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
    <li className="flex flex-col gap-1.5">
      <p className="flex min-w-0 gap-1.5 text-xs">
        <span className="shrink-0 text-muted-foreground">Turn {changes.turn}</span>
        <span className="min-w-0 truncate" title={changes.prompt}>
          {changes.prompt}
        </span>
      </p>
      {changes._tag === 'TurnOpen' ? (
        <p className="text-muted-foreground">Changes show when this turn ends</p>
      ) : changes.files.length === 0 ? (
        <p className="text-muted-foreground">No file changes</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {changes.files.map((file) => (
            <FileRow key={file.path} runId={runId} turn={changes.turn} file={file} />
          ))}
        </ul>
      )}
    </li>
  )
}

/**
 * The session rail's Changes card body for run `runId`: its turns, newest first, each with its
 * prompt and the files it changed; a file opens to its diff. It follows `changesAtoms(runId)`.
 */
export function ChangesCard({
  runId,
  changesAtoms
}: {
  readonly runId: string
  readonly changesAtoms: ChangesAtoms
}): React.JSX.Element {
  const result = useAtomValue(changesAtoms(runId))
  const turns = AsyncResult.isSuccess(result) ? Option.getOrElse(result.value, () => []) : []
  if (turns.length === 0) return <p className="text-muted-foreground">No changes yet</p>
  return (
    <ul className="flex flex-col gap-3">
      {[...turns].reverse().map((changes) => (
        <Turn key={changes.turn} runId={runId} changes={changes} />
      ))}
    </ul>
  )
}
