import { Button, cn } from '@dia/renderer-plugin'
import { ArrowDownIcon } from 'lucide-react'
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef, useState } from 'react'

const PREVIOUS_TURN_PEEK_PX = 64
const AT_END_THRESHOLD_PX = 8

/**
 * Returns the height in pixels of the empty space below a transcript's last item.
 *
 * The space is never less than `overlayHeight`, so the last item can scroll clear of the
 * composer. When `anchorTop` is set, the space also lets the transcript scroll far enough to
 * show the anchor 64px below the top of the viewport, until the content after the anchor fills
 * the viewport. All positions are in pixels from the top of the scrollable content.
 */
export function transcriptEndSpace({
  overlayHeight,
  anchorTop,
  itemsBottom,
  viewportHeight
}: {
  overlayHeight: number
  anchorTop: number | null
  itemsBottom: number
  viewportHeight: number
}): number {
  if (anchorTop === null) return overlayHeight
  return Math.max(overlayHeight, anchorTop - PREVIOUS_TURN_PEEK_PX + viewportHeight - itemsBottom)
}

/**
 * A transcript row, rendered as a direct child of `TranscriptScroller`. Set `anchor` on rows the
 * user sent: when a new anchor row appears, the scroller shows it at the top of the pane while its
 * reply streams in.
 */
export function TranscriptItem({
  anchor = false,
  className,
  ...props
}: ComponentProps<'div'> & { anchor?: boolean }) {
  return (
    <div
      data-transcript-anchor={anchor || undefined}
      className={cn(
        'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
        className
      )}
      {...props}
    />
  )
}

/**
 * A full-pane scrolling transcript with `overlay` (the composer) floating over its bottom edge.
 *
 * It follows the end of the transcript while the user is at the end, stops following when the
 * user scrolls away, and shows a scroll-to-end button until they return. `contentClassName` sets
 * the column that both the transcript and the overlay are laid out in. The parent must give the
 * scroller a height.
 */
export function TranscriptScroller({
  children,
  overlay,
  contentClassName
}: {
  children: ReactNode
  overlay: ReactNode
  contentClassName?: string
}) {
  const viewportRef = useRef<HTMLElement>(null)
  const itemsRef = useRef<HTMLDivElement>(null)
  const spacerRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const [following, setFollowing] = useState(true)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const items = itemsRef.current
    const spacer = spacerRef.current
    const overlayElement = overlayRef.current
    if (!viewport || !items || !spacer || !overlayElement) return

    const lastAnchorRow = (): HTMLElement | null => {
      for (let row = items.lastElementChild; row !== null; row = row.previousElementSibling) {
        if (row instanceof HTMLElement && row.dataset.transcriptAnchor !== undefined) return row
      }
      return null
    }

    let lastAnchor = lastAnchorRow()
    let lastSpace = -1
    const layout = (): void => {
      const anchor = lastAnchorRow()
      if (anchor !== lastAnchor) followingRef.current = true
      lastAnchor = anchor
      const contentTop = viewport.getBoundingClientRect().top - viewport.scrollTop
      const overlayHeight = overlayElement.offsetHeight
      const space = transcriptEndSpace({
        overlayHeight,
        anchorTop: anchor === null ? null : anchor.getBoundingClientRect().top - contentTop,
        itemsBottom: items.getBoundingClientRect().bottom - contentTop,
        viewportHeight: viewport.clientHeight
      })
      viewport.style.scrollPaddingBottom = `${overlayHeight}px`
      if (space !== lastSpace) {
        spacer.style.height = `${space}px`
        lastSpace = space
      }
      if (followingRef.current) viewport.scrollTop = viewport.scrollHeight
    }

    layout()
    const observer = new ResizeObserver(layout)
    for (const element of [viewport, items, overlayElement]) observer.observe(element)
    return () => observer.disconnect()
  }, [])

  function trackEnd(): void {
    const viewport = viewportRef.current
    if (!viewport) return
    const scrolledUp = viewport.scrollTop < lastScrollTopRef.current
    lastScrollTopRef.current = viewport.scrollTop
    if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AT_END_THRESHOLD_PX) {
      followingRef.current = true
    } else if (scrolledUp) {
      followingRef.current = false
    }
    setFollowing(followingRef.current)
  }

  function scrollToEnd(): void {
    const viewport = viewportRef.current
    if (!viewport) return
    followingRef.current = true
    setFollowing(true)
    viewport.scrollTop = viewport.scrollHeight
  }

  return (
    <div className="relative min-h-0 flex-1">
      <section
        ref={viewportRef}
        aria-label="Messages"
        onScroll={trackEnd}
        className="size-full scrollbar-app overflow-y-auto overscroll-contain px-1.5"
      >
        <div className={contentClassName}>
          <div
            ref={itemsRef}
            role="log"
            aria-relevant="additions"
            className="flex flex-col gap-2 pt-2"
          >
            {children}
          </div>
          <div ref={spacerRef} aria-hidden />
        </div>
      </section>
      <div ref={overlayRef} className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
        <div
          className={cn(
            'pointer-events-auto relative bg-background before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-linear-to-t before:from-background',
            contentClassName
          )}
        >
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Scroll to end"
            data-active={!following}
            inert={following}
            onClick={scrollToEnd}
            className="absolute bottom-full left-1/2 mb-4 -translate-x-1/2 transition-[translate,scale,opacity] duration-200 ease-out data-[active=false]:pointer-events-none data-[active=false]:translate-y-2 data-[active=false]:scale-95 data-[active=false]:opacity-0 motion-reduce:transition-none"
          >
            <ArrowDownIcon />
          </Button>
          {overlay}
        </div>
      </div>
    </div>
  )
}
