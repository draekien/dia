const externalProtocols = new Set(['http:', 'https:', 'mailto:'])

/**
 * Reports whether a URL the renderer asked to open or navigate to may be handed to the
 * operating system with `shell.openExternal`. Pass the absolute URL Electron reports; only
 * `http:`, `https:` and `mailto:` URLs return `true`.
 */
export function isExternalUrl(url: string): boolean {
  return URL.canParse(url) && externalProtocols.has(new URL(url).protocol)
}

/**
 * Reports whether a navigation URL stays inside the app, so the window may load it. Pass the
 * absolute URL from `will-navigate` and the app's origins in `scheme://host` form, such as
 * `dia://app` or `http://localhost:5173`. Works for the custom `dia:` scheme, whose
 * `URL.origin` Node reports as `'null'`.
 */
export function isAppNavigation(url: string, appOrigins: ReadonlyArray<string>): boolean {
  if (!URL.canParse(url)) return false
  const { protocol, host } = new URL(url)
  return appOrigins.includes(`${protocol}//${host}`)
}
