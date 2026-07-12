import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { useEffect, useState } from 'react'
import type { ChooseDirectoryResult } from './dia'

// Placeholder list pending a confirmed source for available models.
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
]

type FormState =
  | { readonly step: 'idle' }
  | { readonly step: 'chosen'; readonly path: string; readonly isGitRepo: boolean }
  | { readonly step: 'creating'; readonly path: string; readonly isGitRepo: boolean }
  | {
      readonly step: 'error'
      readonly path: string
      readonly isGitRepo: boolean
      readonly reason: string
    }

interface PaneCreationFormProps {
  paneId: string
}

function PaneCreationForm({ paneId }: PaneCreationFormProps) {
  const [state, setState] = useState<FormState>({ step: 'idle' })
  const [model, setModel] = useState(MODEL_OPTIONS[0].value)
  const [useWorktree, setUseWorktree] = useState(false)

  useEffect(() => {
    return window.dia.onPaneCreateFailed((event) => {
      if (event.paneId !== paneId) return
      setState((prev) =>
        prev.step === 'idle' ? prev : { ...prev, step: 'error', reason: event.reason }
      )
    })
  }, [paneId])

  async function handleChooseDirectory() {
    const result: ChooseDirectoryResult = await window.dia.chooseDirectory()
    if (result === null) return
    setState({ step: 'chosen', path: result.path, isGitRepo: result.isGitRepo })
  }

  function handleStart() {
    if (state.step !== 'chosen') return
    setState({ step: 'creating', path: state.path, isGitRepo: state.isGitRepo })
    window.dia.createPane(paneId, state.path, model, state.isGitRepo && useWorktree)
  }

  function handleRetry() {
    if (state.step !== 'error') return
    setState({ step: 'chosen', path: state.path, isGitRepo: state.isGitRepo })
  }

  const isBusy = state.step === 'creating'

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 bg-background p-6 text-ink">
      <button
        type="button"
        onClick={() => window.dia.closePane(paneId)}
        className="absolute top-4 right-4 rounded-md border border-border px-2 py-1 text-xs text-ink-muted transition-colors hover:border-primary hover:text-ink"
      >
        Cancel
      </button>
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">New pane</span>
          <span className="text-sm text-ink-muted">
            Choose a working directory to start this session.
          </span>
        </div>

        <button
          type="button"
          onClick={handleChooseDirectory}
          disabled={isBusy}
          className="rounded-md border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.step === 'idle' ? 'Choose directory…' : state.path}
        </button>

        {state.step !== 'idle' && (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-ink-muted">Model</span>
              <Select value={model} onValueChange={setModel} disabled={isBusy}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {state.isGitRepo && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <label htmlFor="use-worktree">Use a git worktree</label>
                <Switch
                  id="use-worktree"
                  checked={useWorktree}
                  onCheckedChange={setUseWorktree}
                  disabled={isBusy}
                />
              </div>
            )}

            {state.step === 'error' && <p className="text-sm text-destructive">{state.reason}</p>}

            <button
              type="button"
              onClick={state.step === 'error' ? handleRetry : handleStart}
              disabled={isBusy}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? 'Creating…' : state.step === 'error' ? 'Try again' : 'Start'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

export default PaneCreationForm
