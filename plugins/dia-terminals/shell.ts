/** The program a terminal starts and its arguments, and the title the terminal is listed under. */
export interface ShellCommand {
  readonly file: string
  readonly args: ReadonlyArray<string>
  readonly title: string
}

/**
 * What a terminal on `platform` runs: `command` through the platform's shell, or an interactive
 * shell when `command` is undefined. Windows uses `powershell.exe`; other platforms use
 * `shell` (the `SHELL` environment variable) or `/bin/sh`.
 */
export const shellCommand = (
  platform: NodeJS.Platform,
  shell: string | undefined,
  command?: string
): ShellCommand => {
  if (platform === 'win32') {
    const args =
      command === undefined ? ['-NoLogo'] : ['-NoLogo', '-NoProfile', '-Command', command]
    return { file: 'powershell.exe', args, title: command ?? 'PowerShell' }
  }
  const file = shell ?? '/bin/sh'
  const args = command === undefined ? [] : ['-c', command]
  return { file, args, title: command ?? file.split('/').at(-1) ?? file }
}
