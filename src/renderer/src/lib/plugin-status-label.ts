import type { PluginStatus } from '@shared/plugin/manifest'

/** The short label for a plugin's load state, such as "Loaded" or "Failed to load". */
export const pluginStatusLabel = (status: PluginStatus): string => {
  switch (status._tag) {
    case 'Unloaded':
      return 'Not loaded'
    case 'Loading':
      return 'Loading…'
    case 'Loaded':
      return status.reloadError === undefined ? 'Loaded' : 'Loaded · last reload failed'
    case 'Failed':
      return 'Failed to load'
    case 'Waiting':
      return `Waiting for ${status.missing.join(', ')}`
    case 'RestartRequired':
      return 'Restart dia to reload'
  }
}
