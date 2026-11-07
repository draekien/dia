import { useAtomValue } from '@effect/atom-react'
import type { PluginServices } from '@shared/plugin/api'
import { Effect, Option, type Scope } from 'effect'
import { Atom } from 'effect/reactivity'
import type { ComponentType } from 'react'
import type { PageKey } from './view'
import { appRegistry, openPageAtom } from './workspace-atoms'

/** A page a plugin adds to the content area with {@link addPage}. */
export interface Page {
  /** Unique within the plugin, for example `greeting`. */
  readonly id: string
  /** The sidebar entry's text and the content header's breadcrumb, for example `Example`. */
  readonly label: string
  /** The sidebar entry's icon, for example a `lucide-react` icon component. */
  readonly icon: ComponentType<{ readonly className?: string }>
  /** Sort position in the sidebar; lower first. Ties keep the order pages were added. */
  readonly order: number
  /** Renders the page body; the kernel draws the content header. */
  readonly component: ComponentType
}

/** A {@link Page} as the kernel holds it, with the {@link PageKey} that opens it. */
export interface RegisteredPage extends Page {
  readonly key: PageKey
}

const sameKey = (a: PageKey, b: PageKey): boolean => a.plugin === b.plugin && a.id === b.id

/** The page among `pages` that `key` names, or `undefined` when no plugin has added it. */
export const findPage = (
  pages: ReadonlyArray<RegisteredPage>,
  key: PageKey
): RegisteredPage | undefined => pages.find((page) => sameKey(page.key, key))

/** Every page plugins added, sorted by `order`, ties in the order they were added. */
export const pagesAtom = Atom.make<ReadonlyArray<RegisteredPage>>([]).pipe(Atom.keepAlive)

/**
 * Adds `page` to the sidebar and the content area for as long as the plugin's scope is open. Its
 * key is the plugin's name and `page.id`. When the scope closes, as on unload or reload, the page
 * is removed and, if it is open, the content area shows what it would without it. Call it from a
 * renderer plugin's setup.
 */
export const addPage = (
  ctx: PluginServices,
  page: Page
): Effect.Effect<void, never, Scope.Scope> => {
  const entry: RegisteredPage = { ...page, key: { plugin: ctx.name, id: page.id } }
  const annotations = { plugin: ctx.name, id: page.id }
  return Effect.acquireRelease(
    Effect.sync(() =>
      appRegistry.update(pagesAtom, (pages) =>
        [...pages.filter((existing) => !sameKey(existing.key, entry.key)), entry].sort(
          (a, b) => a.order - b.order
        )
      )
    ).pipe(Effect.tap(() => Effect.logDebug('Added a page', annotations))),
    () =>
      Effect.gen(function* () {
        appRegistry.update(pagesAtom, (pages) => pages.filter((existing) => existing !== entry))
        const open = appRegistry.get(openPageAtom)
        if (Option.isSome(open) && sameKey(open.value.key, entry.key)) {
          appRegistry.set(openPageAtom, Option.none())
          yield* Effect.logDebug('Closed the open page its plugin removed', annotations)
        }
        yield* Effect.logDebug('Removed a page', annotations)
      })
  )
}

/** Every page plugins added, sorted by `order`. Re-renders when a page is added or removed. */
export function usePages(): ReadonlyArray<RegisteredPage> {
  return useAtomValue(pagesAtom)
}
