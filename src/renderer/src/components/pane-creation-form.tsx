import { Button } from '@renderer/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { THINKING_LEVEL_OPTIONS } from '@renderer/lib/thinking-levels'
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '@shared/domain/pane'
import type { ChooseDirectoryResult } from '@shared/ipc/contract'
import { useEffect, useState } from 'react'

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
  // Hides Cancel when this is the workspace's only pane -- there's no other pane or session to
  // return to, so canceling would just reopen this same form.
  isOnlyPane: boolean
}

function PaneCreationForm({ paneId, isOnlyPane }: PaneCreationFormProps) {
  const [state, setState] = useState<FormState>({ step: 'idle' })
  const [model, setModel] = useState(MODEL_OPTIONS[0].value)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [useWorktree, setUseWorktree] = useState(false)

  useEffect(() => {
    return window.dia.onPaneCreateFailed((event) => {
      if (event.paneId !== paneId) return
      setState((prev) =>
        prev.step === 'idle' ? prev : { ...prev, step: 'error', reason: event.reason }
      )
    })
  }, [paneId])

  // @effect-diagnostics-next-line asyncFunction:off -- React event handler awaiting an IPC call; the renderer is React, not Effect-orchestrated.
  async function handleChooseDirectory() {
    const result: ChooseDirectoryResult = await window.dia.chooseDirectory()
    if (result === null) return
    setState({ step: 'chosen', path: result.path, isGitRepo: result.isGitRepo })
  }

  function handleStart() {
    if (state.step !== 'chosen') return
    setState({ step: 'creating', path: state.path, isGitRepo: state.isGitRepo })
    window.dia.createPane(paneId, state.path, model, thinkingLevel, state.isGitRepo && useWorktree)
  }

  function handleRetry() {
    if (state.step !== 'error') return
    setState({ step: 'chosen', path: state.path, isGitRepo: state.isGitRepo })
  }

  const isBusy = state.step === 'creating'

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 bg-background p-6 text-ink">
      {!isOnlyPane && (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => window.dia.closePane(paneId)}
          className="absolute top-4 right-4 text-ink-muted hover:text-ink"
        >
          Cancel
        </Button>
      )}
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-base font-semibold">New pane</span>
          <span className="text-sm text-ink-muted">
            Choose a working directory to start this session.
          </span>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={handleChooseDirectory}
          disabled={isBusy}
          className="w-full justify-start bg-surface font-normal"
        >
          {state.step === 'idle' ? 'Choose directory…' : state.path}
        </Button>

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

            <div className="flex flex-col gap-1">
              <span className="text-xs text-ink-muted">Thinking</span>
              <Select
                value={thinkingLevel}
                onValueChange={(value: ThinkingLevel) => setThinkingLevel(value)}
                disabled={isBusy}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {THINKING_LEVEL_OPTIONS.map((option) => (
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

            <Button
              type="button"
              onClick={state.step === 'error' ? handleRetry : handleStart}
              disabled={isBusy}
            >
              {isBusy ? 'Creating…' : state.step === 'error' ? 'Try again' : 'Start'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export default PaneCreationForm
