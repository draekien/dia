import type { ReactNode } from 'react'

/** The heading of one section of a Settings page. `id` labels the `<section>` through `aria-labelledby`. */
export function SectionHeading({
  id,
  children
}: {
  readonly id: string
  readonly children: string
}) {
  return (
    <h3 id={id} className="text-sm font-medium text-ink">
      {children}
    </h3>
  )
}

/** One label and value pair of a Settings page's `<dl>`; render it inside a `<dl>`. */
export function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  )
}
