import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Settings {
  readonly lastDirectory?: string
}

export interface SettingsStore {
  readonly getLastDirectory: () => string | undefined
  readonly setLastDirectory: (path: string) => void
}

export function makeSettingsStore(userDataPath: string): SettingsStore {
  const filePath = join(userDataPath, 'settings.json')

  function read(): Settings {
    if (!existsSync(filePath)) return {}
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  function write(settings: Settings): void {
    writeFileSync(filePath, JSON.stringify(settings, null, 2))
  }

  return {
    getLastDirectory: () => read().lastDirectory,
    setLastDirectory: (path) => write({ ...read(), lastDirectory: path })
  }
}
