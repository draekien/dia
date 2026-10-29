import { createContext, useContext } from 'react'

/**
 * Carries whether the visible tab was opened by submitting the New agent form. `TabContent`
 * provides it around the `main.tab` slot; read it with {@link useTabOpenedFromNewAgent}.
 */
export const TabOpenedFromNewAgent = createContext(false)

/**
 * Whether the visible tab was opened by submitting the New agent form. Read it in the component
 * that fills the `main.tab` slot, to focus the composer on a new agent's first render.
 */
export function useTabOpenedFromNewAgent(): boolean {
  return useContext(TabOpenedFromNewAgent)
}
