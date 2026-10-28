# Untrusted Markdown URLs and the `dia:` origin

**Date:** 2026-10-28

## Context

Assistant Markdown is untrusted. `@tanstack/markdown`'s `sanitizeUrl` removes every scheme except `http`, `https`, `mailto` and `tel`, but keeps relative URLs. `setWindowOpenHandler` passed every `details.url` to `shell.openExternal`, and Markdown images loaded remote URLs as soon as they rendered.

## Reasoning / Learning

- The packaged renderer runs at `dia://app`, so a relative href such as `//attacker/share` resolves to `dia://attacker/share`, not to a `file://` UNC path. `serveRenderer` only serves files inside `out/renderer`.
- `details.url` in `setWindowOpenHandler` and the `url` in `will-navigate` are resolved absolute URLs. `src/main/external-url.ts` allows only `http:`, `https:` and `mailto:` through `shell.openExternal`, and both handlers use it.
- Node's `URL` in the main process reports `origin` as `'null'` for `dia://app/...`, because Node does not know that `dia:` is registered as a standard scheme. Comparing `new URL(url).origin` against `RENDERER_ORIGIN` therefore blocks the app's own navigations. `isAppNavigation` compares `${protocol}//${host}` instead. A packaged-build run showed the failure; the dev build, at `http://localhost`, does not show it.
- `urlTransform` in `markdown.tsx` returns `null` for any image whose URL is not an absolute, parseable `http(s)` URL, and the package then renders the image's alt text. Remote images render as a "Load image from <host>" button and load only after a click, because no Content-Security-Policy restricts `img-src`.

## Implication

Check origins of `dia:` URLs in the main process with scheme and host, not `URL.origin`. Verify navigation and link changes in a packaged build.
