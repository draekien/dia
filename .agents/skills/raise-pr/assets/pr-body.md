<Stacked PRs only: `Stacked on #<n>; merge that PR first.` Delete this line otherwise.>

## Summary

<What changed and why, in terms a reviewer checks against the diff. Name the files or modules that carry the change, the design spec under `docs/designs/` if one was written, and any reasoning entry under `docs/reasoning/`. State whether `PROTOCOL_VERSION` changed.>

## Proof

- `pnpm typecheck` exit 0, `pnpm lint` clean, `pnpm test` <N> files / <N> tests passed. <New tests, and for a bug fix: which were red before the change.>
- <Proof record from `verify-in-app`; or, for a change with no runtime effect: `No app run made: <reason>. Proof: <the check that exercises the change, and its result>.`>
- `/simplify` and `/code-review medium --fix` ran; <fixes applied, and findings not fixed with the reason>.

## Not covered

- <Each claimed or affected behaviour that was not exercised, and why.>
- <Known follow-ups, not done in this PR.>
