const externalProtocols = new Set(['http:', 'https:', 'mailto:'])

/**
 * Reports whether a URL the renderer asked to open or navigate to may be handed to the
 * operating system with `shell.openExternal`. Pass the absolute URL Electron reports; only
 * `http:`, `https:` and `mailto:` URLs return `true`.
 */
export function isExternalUrl(url: string): boolean {
  return URL.canParse(url) && externalProtocols.has(new URL(url).protocol)
}
