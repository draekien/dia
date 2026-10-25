import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@renderer/components/ui/select'
import { Switch } from '@renderer/components/ui/switch'
import { usePluginList } from '@renderer/hooks/use-plugin-list'
import { cancelNewAgent } from '@renderer/lib/actions'
import { CREATE_PERMISSION_MODE_OPTIONS } from '@renderer/lib/permission-modes'
import { THINKING_LEVEL_OPTIONS } from '@renderer/lib/thinking-levels'
import {
  DEFAULT_THINKING_LEVEL,
  type StartupPermissionMode,
  type ThinkingLevel
} from '@shared/domain/pane'
import { AgentName, type Project } from '@shared/domain/project'
import { CreateTab } from '@shared/ipc/contract'
import { WORKTREES_KEY } from '@shared/plugin/api'
import type { PluginInfo } from '@shared/plugin/manifest'
import { Option, Schema } from 'effect'
import { useEffect, useState } from 'react'

// Placeholder list pending a confirmed source for available models.
const MODEL_OPTIONS = [
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' }
]

const providesWorktrees = (plugins: ReadonlyArray<PluginInfo> | undefined): boolean =>
  plugins?.some((plugin) => plugin.provides.includes(WORKTREES_KEY)) ?? false

type FormState =
  | { readonly step: 'editing' }
  | { readonly step: 'creating' }
  | { readonly step: 'error'; readonly reason: string }

const decodeName = Schema.decodeUnknownOption(AgentName)

interface PaneCreationFormProps {
  readonly project: Project
}

/**
 * The New agent form for `project`: an optional name, the model, thinking level, permission mode
 * and, for a git project, the worktree switch. "Start agent" asks the Host to create the tab,
 * which then becomes the visible tab; Cancel returns to the tab shown before the form opened.
 */
function PaneCreationForm({ project }: PaneCreationFormProps) {
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- React state initialiser outside any Effect; the id only has to be unique.
  const [paneId] = useState(() => crypto.randomUUID())
  const [state, setState] = useState<FormState>({ step: 'editing' })
  const [name, setName] = useState('')
  const [model, setModel] = useState(MODEL_OPTIONS[0].value)
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(DEFAULT_THINKING_LEVEL)
  const [permissionMode, setPermissionMode] = useState<StartupPermissionMode>('auto')
  const [useWorktree, setUseWorktree] = useState(false)
  const worktreesAvailable = providesWorktrees(usePluginList().plugins)
  const worktreeOn = project.isGitRepo && worktreesAvailable && useWorktree

  useEffect(() => {
    return window.dia.onPaneCreateFailed((event) => {
      if (event.paneId !== paneId) return
      setState({ step: 'error', reason: event.reason })
    })
  }, [paneId])

  function handleStart() {
    setState({ step: 'creating' })
    window.dia.createTab(
      CreateTab.make({
        projectId: project.projectId,
        paneId,
        name: Option.getOrNull(decodeName(name.trim())),
        model,
        thinkingLevel,
        permissionMode,
        useWorktree: worktreeOn
      })
    )
  }

  const isBusy = state.step === 'creating'

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 bg-background p-6 text-ink">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <span className="text-base font-semibold">New agent in {project.displayName}</span>

        <div className="flex flex-col gap-1">
          <label htmlFor="agent-name" className="text-xs text-ink-muted">
            Name · optional
          </label>
          <Input
            id="agent-name"
            value={name}
            maxLength={64}
            placeholder="A two-word name is generated when blank"
            onChange={(event) => setName(event.target.value)}
            disabled={isBusy}
          />
        </div>

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

        <div className="flex flex-col gap-1">
          <span className="text-xs text-ink-muted">Permissions</span>
          <Select
            value={permissionMode}
            onValueChange={(value: StartupPermissionMode) => setPermissionMode(value)}
            disabled={isBusy}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CREATE_PERMISSION_MODE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {project.isGitRepo && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 text-sm">
              <label htmlFor="use-worktree">Use a git worktree</label>
              <Switch
                id="use-worktree"
                checked={worktreeOn}
                onCheckedChange={setUseWorktree}
                disabled={isBusy || !worktreesAvailable}
                aria-describedby={worktreesAvailable ? undefined : 'use-worktree-hint'}
              />
            </div>
            {!worktreesAvailable && (
              <p id="use-worktree-hint" className="text-xs text-ink-muted">
                Load the worktrees plugin to use worktrees
              </p>
            )}
          </div>
        )}

        {state.step === 'error' && <p className="text-sm text-destructive">{state.reason}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={cancelNewAgent} disabled={isBusy}>
            Cancel
          </Button>
          <Button type="button" onClick={handleStart} disabled={isBusy}>
            {isBusy ? 'Starting…' : state.step === 'error' ? 'Try again' : 'Start agent'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default PaneCreationForm
