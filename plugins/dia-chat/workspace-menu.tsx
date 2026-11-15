import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  callHost,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch
} from '@dia/renderer-plugin'
import {
  type Branch,
  type BranchList,
  type CheckoutHead,
  ReadBranches,
  SwitchBranch
} from '@dia-plugin/dia-git/calls'
import type { WorktreeStart } from '@shared/domain/project'
import { Effect, Result } from 'effect'
import { CheckIcon, ChevronDownIcon, GitBranchIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

const GIT = 'dia-git'

type Branches =
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Loaded'; readonly list: BranchList }
  | { readonly _tag: 'Failed'; readonly reason: string }

/** How the trigger names checkout `head`: its branch, or "detached at" its short commit. */
export const headLabel = (head: CheckoutHead): string =>
  head._tag === 'OnBranch' ? head.branch : `detached at ${head.commit}`

/**
 * The branch a new worktree starts from: the draft's chosen `worktree.base`, else the repository's
 * default base, else null when neither is known.
 */
export const worktreeBase = (
  worktree: WorktreeStart,
  list: BranchList | undefined
): string | null => worktree.base ?? list?.defaultBase ?? null

/**
 * The bases the worktree list offers, in order: the default base first, then remote branches, then
 * local ones.
 */
export const baseChoices = (list: BranchList): ReadonlyArray<Branch> => {
  const isDefault = (branch: Branch) => branch.name === list.defaultBase
  return [
    ...list.branches.filter(isDefault),
    ...list.branches.filter((branch) => !isDefault(branch) && branch.remote !== null),
    ...list.branches.filter((branch) => !isDefault(branch) && branch.remote === null)
  ]
}

/** The sentence shown when the checkout refuses a switch over uncommitted changes on `branch`. */
export const uncommittedText = (branch: string | null): string =>
  `${branch ?? 'The checkout'} has uncommitted changes. Commit or stash them first, or turn on Worktree.`

const failureText = (failure: { readonly reason: string } | { readonly message: string }) =>
  'reason' in failure ? failure.reason : failure.message

const readBranches = (directory: string) =>
  callHost(GIT, ReadBranches, { directory }).pipe(
    Effect.mapError(failureText),
    Effect.tapError((reason) =>
      Effect.logWarning('Could not read branches', { directory, reason })
    ),
    Effect.result,
    Effect.runPromise
  )

const switchBranch = (directory: string, branch: Branch) =>
  callHost(GIT, SwitchBranch, { directory, branch }).pipe(
    Effect.mapError((failure) =>
      failure._tag === 'UncommittedChanges' ? uncommittedText(failure.branch) : failureText(failure)
    ),
    Effect.tap(() =>
      Effect.logInfo('Switched the checkout branch', { directory, branch: branch.name })
    ),
    Effect.tapError((reason) => Effect.logInfo('Branch switch refused', { directory, reason }))
  )

const workspaceLabel = (worktree: WorktreeStart | null, branches: Branches): string => {
  const list = branches._tag === 'Loaded' ? branches.list : undefined
  if (worktree !== null) return `Worktree from ${worktreeBase(worktree, list) ?? 'HEAD'}`
  if (list !== undefined) return headLabel(list.head)
  return branches._tag === 'Failed' ? 'Checkout' : '…'
}

const LOADING: Branches = { _tag: 'Loading' }

function useBranches(directory: string) {
  const [read, setRead] = useState<{ readonly directory: string; readonly branches: Branches }>()
  useEffect(() => {
    let current = true
    void readBranches(directory).then((result) => {
      if (!current) return
      setRead({
        directory,
        branches: Result.isSuccess(result)
          ? { _tag: 'Loaded', list: result.success }
          : { _tag: 'Failed', reason: result.failure }
      })
    })
    return () => {
      current = false
    }
  }, [directory])
  const branches = read?.directory === directory ? read.branches : LOADING
  const loaded = (list: BranchList) => setRead({ directory, branches: { _tag: 'Loaded', list } })
  return [branches, loaded] as const
}

function BranchItem({
  branch,
  checked,
  note,
  onPick
}: {
  readonly branch: Branch
  readonly checked: boolean
  readonly note?: string
  readonly onPick: () => void
}) {
  return (
    <CommandItem value={branch.name} onSelect={onPick}>
      <span className="truncate">{branch.name}</span>
      {note === undefined ? null : <span className="text-ink-muted text-xs">{note}</span>}
      <CheckIcon className={checked ? 'ml-auto' : 'ml-auto invisible'} />
    </CommandItem>
  )
}

interface WorkspaceMenuProps {
  /** The project's checkout directory. */
  readonly directory: string
  /** The draft's worktree choice: null to work in the checkout. */
  readonly worktree: WorktreeStart | null
  /** Called with the new worktree choice when the user flips the switch or picks a base. */
  readonly onWorktreeChange: (worktree: WorktreeStart | null) => void
  /** The name of a thread working in this checkout now, which a branch switch would disturb. */
  readonly busyThread: string | null
}

/**
 * The new-thread page's workspace control for the git project at `directory`. With the Worktree
 * switch off, the trigger names the checkout's branch and picking a branch switches the checkout
 * (asking first when `busyThread` is working there; refusing over uncommitted changes). With it
 * on, the trigger names the base branch the new worktree starts from, and picking one sets it.
 */
export function WorkspaceMenu({
  directory,
  worktree,
  onWorktreeChange,
  busyThread
}: WorkspaceMenuProps) {
  const [branches, setLoaded] = useBranches(directory)
  const [open, setOpen] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [guarded, setGuarded] = useState<Branch | null>(null)
  const switchId = useId()
  const list = branches._tag === 'Loaded' ? branches.list : undefined

  const switchTo = (branch: Branch) => {
    setGuarded(null)
    setRefusal(null)
    void Effect.runPromise(
      switchBranch(directory, branch).pipe(
        Effect.match({
          onFailure: (reason) => {
            setRefusal(reason)
            setOpen(true)
          },
          onSuccess: (next) => {
            setLoaded(next)
            setOpen(false)
          }
        })
      )
    )
  }

  const pickCheckoutBranch = (branch: Branch) => {
    if (list?.head._tag === 'OnBranch' && list.head.branch === branch.name) {
      setOpen(false)
      return
    }
    if (busyThread !== null) {
      setOpen(false)
      setGuarded(branch)
      return
    }
    switchTo(branch)
  }

  const pickBase = (branch: Branch) => {
    onWorktreeChange({ base: branch.name === list?.defaultBase ? null : branch.name })
    setOpen(false)
  }

  const label = workspaceLabel(worktree, branches)

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setRefusal(null)
        }}
      >
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="max-w-64 text-ink-muted"
              aria-label={`Workspace: ${label}`}
            >
              <GitBranchIcon data-icon="inline-start" />
              <span className="truncate">{label}</span>
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          }
        />
        <PopoverContent align="end" className="w-72 gap-0 p-0">
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="flex flex-col">
              <Label htmlFor={switchId}>Worktree</Label>
              <span className="text-ink-muted text-xs">
                {worktree === null
                  ? 'Work in the checkout on its branch'
                  : 'A new branch in its own directory'}
              </span>
            </div>
            <Switch
              id={switchId}
              checked={worktree !== null}
              onCheckedChange={(checked) => {
                setRefusal(null)
                onWorktreeChange(checked ? { base: null } : null)
              }}
            />
          </div>
          {refusal === null ? null : (
            <p role="alert" className="border-t px-3 py-2 text-error text-xs">
              {refusal}
            </p>
          )}
          <Command className="border-t">
            <CommandInput
              placeholder={worktree === null ? 'Switch branch…' : 'Start from branch…'}
            />
            <CommandList>
              {branches._tag === 'Failed' ? (
                <p className="px-3 py-2 text-ink-muted text-xs">
                  Could not read branches: {branches.reason}
                </p>
              ) : (
                <CommandEmpty>No branch matches.</CommandEmpty>
              )}
              {list === undefined ? null : worktree === null ? (
                <CommandGroup heading="Switch the checkout to">
                  {list.branches.map((branch) => (
                    <BranchItem
                      key={branch.name}
                      branch={branch}
                      checked={list.head._tag === 'OnBranch' && list.head.branch === branch.name}
                      onPick={() => pickCheckoutBranch(branch)}
                    />
                  ))}
                </CommandGroup>
              ) : (
                <CommandGroup heading="Start the worktree from">
                  {baseChoices(list).map((branch) => (
                    <BranchItem
                      key={branch.name}
                      branch={branch}
                      checked={worktreeBase(worktree, list) === branch.name}
                      note={branch.name === list.defaultBase ? 'default' : undefined}
                      onPick={() => pickBase(branch)}
                    />
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <AlertDialog
        open={guarded !== null}
        onOpenChange={(next) => {
          if (!next) setGuarded(null)
        }}
      >
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {busyThread} is working in this checkout. Switch anyway?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Switching to {guarded?.name} changes the files under it while it works. Turn on
              Worktree to start this thread in its own directory instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={() => guarded !== null && switchTo(guarded)}>Switch anyway</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
