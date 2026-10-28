# A scroll event from the last pin can stop transcript following

**Date:** 2026-10-28

## Context

`TranscriptScroller` (`src/renderer/src/components/transcript-scroller.tsx`) replaced `@shadcn/react`'s `MessageScroller`. It follows the end of the transcript by setting `scrollTop` to `scrollHeight` from a `ResizeObserver` callback. In the first version, the `scroll` handler set "following" to whether the viewport was within 8px of the end. During a long streaming reply in the running app, following stopped after the view fell about 25px behind the end, and the reply then streamed below the composer.

## Reasoning / Learning

The `scroll` event for a programmatic `scrollTop` write is dispatched in the next frame's scroll steps, which run before that frame's `ResizeObserver` callbacks. React can commit more reply text between the two frames. The handler then sees the viewport 25px from the end and treats the programmatic pin as a user scrolling away, before the `ResizeObserver` callback can pin again.

The handler now stops following only when `scrollTop` decreased since the previous `scroll` event, which a pin to the end never does. Reaching the end always resumes following.

Separately, Chromium delivers no `ResizeObserver` callbacks while the window's `document.visibilityState` is `hidden`, so geometry read over CDP from a hidden dev window shows the state before layout ran. Each `Page.captureScreenshot` renders one frame, so capturing a screenshot before each read gives current values.

## Implication

Do not decide from the distance to the end alone that the user scrolled away; use the scroll direction. When verifying scroll behaviour over CDP, check `document.visibilityState` first, and capture a screenshot before each geometry read while it is `hidden`.
