import { DEFAULT_THEME, type ThemePreference } from '@shared/domain/theme'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

interface ThemeContextValue {
  readonly theme: ThemePreference
  readonly setTheme: (theme: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)'

function resolveIsDark(theme: ThemePreference): boolean {
  if (theme === 'system') return window.matchMedia(DARK_SCHEME_QUERY).matches
  return theme === 'dark'
}

function readToken(variable: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${variable})`
  probe.style.display = 'none'
  document.body.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}

function pushTitleBarOverlay(): void {
  window.dia.setTitleBarOverlay({ color: readToken('--surface'), symbolColor: readToken('--ink') })
}

function applyTheme(theme: ThemePreference): void {
  document.documentElement.classList.toggle('dark', resolveIsDark(theme))
  pushTitleBarOverlay()
}

/**
 * Wraps the app to provide the current colour-theme preference and a setter via
 * {@link useTheme}. On mount it loads the persisted preference through the
 * `window.dia` bridge and applies it to the document root; while `system` is
 * active it tracks OS colour-scheme changes live. The document keeps whatever
 * class `index.html` pre-set until the stored preference resolves, so the theme
 * is applied exactly once rather than flipping through an interim value.
 */
export function ThemeProvider({ children }: { readonly children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemePreference | null>(null)

  useEffect(() => {
    let cancelled = false
    window.dia.getTheme().then((stored) => {
      if (!cancelled) setThemeState(stored)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (theme === null) return
    applyTheme(theme)
    if (theme !== 'system') return
    const media = window.matchMedia(DARK_SCHEME_QUERY)
    const onChange = () => applyTheme('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next)
    applyTheme(next)
    window.dia.setTheme(next)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme: theme ?? DEFAULT_THEME, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

/**
 * Reads the active {@link ThemePreference} and a setter to change and persist it.
 * Must be called from within a {@link ThemeProvider}; throws otherwise.
 */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (context === null) throw new Error('useTheme must be used within a ThemeProvider')
  return context
}
