import { Loader2Icon } from 'lucide-react'
import { usePluginList } from '../hooks/use-plugin-list'

/**
 * A line of text in the app header, `Loading plugins 2 of 5`, shown while the Host is still
 * loading plugins and gone once every plugin has settled. The count is the plugins that have left
 * the `Loading` state over all known plugins. Mount it once in the app header; it renders nothing
 * until the first plugin list arrives.
 */
export function PluginLoadIndicator() {
  const { plugins } = usePluginList()
  if (plugins === undefined) return null
  const loading = plugins.filter((plugin) => plugin.status._tag === 'Loading').length
  if (loading === 0) return null

  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-ink-muted tabular-nums">
      <Loader2Icon className="size-3.5 motion-safe:animate-spin" />
      Loading plugins {plugins.length - loading} of {plugins.length}
    </span>
  )
}
