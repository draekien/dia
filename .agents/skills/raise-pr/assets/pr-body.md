<Stacked PRs only: `Stacked on #<n>; merge that PR first.` Delete this line otherwise.>

## Summary

<One sentence: what changed and why. `Closes #<n>`.>

| File | Change |
| --- | --- |
| `<file or module>` | <what it now does> |

<Spec `docs/designs/<name>.md` · ADR-<NNNN> · reasoning `<entry>` · `PROTOCOL_VERSION` changed or unchanged.>

## Proof

<Build and commit, e.g. "Packaged build (`electron-builder --dir`) of `<sha>`, scratch profiles." Or, for a change with no runtime effect: `No app run made: <reason>. Proof: <the check that exercises the change, and its result>.`>

**1. <Behaviour, as a claim>.** <One line naming the observed value.>

![<alt text>](./1-<name>.png)

<One numbered block per visible behaviour: a screenshot, a before/after table of two screenshots, or a recording (`![<name>](./2-<name>.mp4)`).>

**<N>. Cases verified without media**

| Case | Observed |
| --- | --- |
| <behaviour with no visible effect> | <quoted value> |

**Checks:** `pnpm typecheck` exits 0 · `pnpm lint` <result> · `pnpm test` <N> files / <N> tests passed<, new tests; for a bug fix, which were red before the change>.

**Review passes:** `/simplify` and `/code-review medium --fix` ran. Applied: <fixes>. Not fixed:

| Finding | Why not |
| --- | --- |
| <finding> | <reason> |

## Not covered

- <Each claimed or affected behaviour that was not exercised, and why.>
- <Known follow-ups, not done in this PR.>
