import type { AdapterStatusJson } from '@renderer/hooks/use-adapter-status'
import { openSettings } from './settings/settings-dialog'
import { Button } from './ui/button'

/**
 * Why agents cannot start with the install in `status`, or `undefined` when nothing blocks them
 * (including while no status is known or no check has finished).
 */
export const installProblem = (status: AdapterStatusJson | undefined): string | undefined => {
  const health = status?.health
  switch (health?._tag) {
    case 'HealthNotInstalled':
      return 'Claude Code is not installed.'
    case 'HealthNotSignedIn':
      return 'Claude Code is not signed in. Run `claude auth login` and try again.'
    case 'HealthError':
      return health.installPath !== undefined && health.version === undefined
        ? health.message
        : undefined
    default:
      return undefined
  }
}

/**
 * A neutral one-line notice explaining why agents cannot start with the install in `status`,
 * with a button that opens the Claude Code page of the Settings dialog. Renders nothing when {@link installProblem} finds
 * no problem.
 */
export function InstallNotice({ status }: { readonly status: AdapterStatusJson | undefined }) {
  const problem = installProblem(status)
  if (problem === undefined) return null
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
      <span className="min-w-0 flex-1">{problem}</span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={() => openSettings({ page: 'adapters', adapter: 'claude-code' })}
      >
        Open Settings
      </Button>
    </p>
  )
}
