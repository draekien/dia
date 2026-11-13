import type { Git, GitError, GitFileChange, GitRef } from '@dia/plugin'
import { Effect } from 'effect'
import { ChangesUnavailable, type TurnChanges, TurnFinished, TurnOpen } from './calls'

const REF_ROOT = 'refs/dia/checkpoints'

type Edge = 'start' | 'end'

interface TurnRecord {
  readonly turn: number
  readonly prompt: string
  readonly start: string
  readonly end: string | undefined
}

const runFolder = (runId: string) => `${REF_ROOT}/${runId}/`

const refOf = (runId: string, turn: number, edge: Edge) => `${runFolder(runId)}${turn}/${edge}`

const recordsOf = (runId: string, refs: ReadonlyArray<GitRef>): ReadonlyArray<TurnRecord> => {
  const byTurn = new Map<number, { prompt?: string; start?: string; end?: string }>()
  for (const ref of refs) {
    const [turnText, edge] = ref.name.slice(runFolder(runId).length).split('/')
    const turn = Number(turnText)
    if (!Number.isInteger(turn) || (edge !== 'start' && edge !== 'end')) continue
    const record = byTurn.get(turn) ?? {}
    byTurn.set(
      turn,
      edge === 'start'
        ? { ...record, prompt: ref.subject, start: ref.commit }
        : { ...record, end: ref.commit }
    )
  }
  return [...byTurn.entries()]
    .flatMap(([turn, { prompt = '', start, end }]) =>
      start === undefined ? [] : [{ turn, prompt, start, end }]
    )
    .sort((a, b) => a.turn - b.turn)
}

/**
 * The turn snapshots of runs, kept as refs in each run's repository. Call `beginTurn` and
 * `endTurn` as a run's turns start and end, and read them back with `turns` and `fileDiff`. Every
 * method takes the run's id and its working directory, and fails with `GitError` when git does
 * (for example when the directory is not in a repository).
 */
export interface Checkpoints {
  /**
   * Records the start of run `runId`'s next turn with `prompt`. A previous turn with no end ends
   * at the same snapshot.
   */
  readonly beginTurn: (runId: string, cwd: string, prompt: string) => Effect.Effect<void, GitError>
  /** Records the end of run `runId`'s latest turn, replacing an end it had. Does nothing when the run has no turn. */
  readonly endTurn: (runId: string, cwd: string) => Effect.Effect<void, GitError>
  /** Run `runId`'s turns in order, finished ones with the files they changed. */
  readonly turns: (
    runId: string,
    cwd: string
  ) => Effect.Effect<ReadonlyArray<TurnChanges>, GitError>
  /**
   * The patch of `path` in finished turn `turn` of run `runId`. Fails with {@link ChangesUnavailable}
   * when that turn is not recorded or has no end.
   */
  readonly fileDiff: (
    runId: string,
    cwd: string,
    turn: number,
    path: string
  ) => Effect.Effect<string, GitError | ChangesUnavailable>
}

/** Builds {@link Checkpoints} over `git`. It keeps each finished turn's file list in memory. */
export const makeCheckpoints = (git: Git): Checkpoints => {
  const fileLists = new Map<string, ReadonlyArray<GitFileChange>>()

  const records = (runId: string, cwd: string) =>
    Effect.map(git.refs(cwd, runFolder(runId)), (refs) => recordsOf(runId, refs))

  const filesOf = Effect.fnUntraced(function* (cwd: string, start: string, end: string) {
    const key = `${start}..${end}`
    const cached = fileLists.get(key)
    if (cached !== undefined) return cached
    const files = yield* git.changedFiles(cwd, start, end)
    fileLists.set(key, files)
    return files
  })

  return {
    beginTurn: Effect.fnUntraced(function* (runId, cwd, prompt) {
      const last = (yield* records(runId, cwd)).at(-1)
      const turn = (last?.turn ?? 0) + 1
      const closesLast = last !== undefined && last.end === undefined
      yield* git.snapshot(
        cwd,
        [refOf(runId, turn, 'start'), ...(closesLast ? [refOf(runId, last.turn, 'end')] : [])],
        prompt === '' ? `Turn ${turn}` : prompt
      )
      yield* Effect.logDebug('Recorded a turn start', { runId, turn, closesLast })
    }),
    endTurn: Effect.fnUntraced(function* (runId, cwd) {
      const last = (yield* records(runId, cwd)).at(-1)
      if (last === undefined) {
        return yield* Effect.logDebug('No turn to end', { runId })
      }
      yield* git.snapshot(cwd, [refOf(runId, last.turn, 'end')], `End of turn ${last.turn}`)
      yield* Effect.logDebug('Recorded a turn end', { runId, turn: last.turn })
    }),
    turns: Effect.fnUntraced(function* (runId, cwd) {
      return yield* Effect.forEach(
        yield* records(runId, cwd),
        ({ turn, prompt, start, end }): Effect.Effect<TurnChanges, GitError> =>
          end === undefined
            ? Effect.succeed(TurnOpen.make({ turn, prompt }))
            : Effect.map(filesOf(cwd, start, end), (files) =>
                TurnFinished.make({ turn, prompt, files })
              ),
        { concurrency: 4 }
      )
    }),
    fileDiff: Effect.fnUntraced(function* (runId, cwd, turn, path) {
      const record = (yield* records(runId, cwd)).find((candidate) => candidate.turn === turn)
      if (record?.end === undefined) return yield* new ChangesUnavailable({ runId })
      return yield* git.diff(cwd, {
        revisions: [record.start, record.end],
        paths: [`:(top,literal)${path}`]
      })
    })
  }
}
