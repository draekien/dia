---
target: parked-agents UI
total_score: 22
max_score: 36
na_heuristics: 10
p0_count: 0
p1_count: 2
target_identity: "file:F:\\Dev\\dia\\src\\renderer\\src\\components\\account-banner.tsx"
target_fingerprint: "sha256:18d66b4e77816043d8152ef4ab7b446930f704adfbddff10db148c9459b5cd23"
target_path: "F:\\Dev\\dia\\src\\renderer\\src\\components\\account-banner.tsx"
timestamp: 2026-10-30T12-41-07Z
slug: src-renderer-src-components-account-banner-tsx
---
Method: dual-agent (A: ac8b82cd77e69e4e1 · B: a9c1e616dfa17fb92)

Run notes: the parked state cannot be put into the running app without a real usage-limit refusal, so neither assessment inspected rendered pixels. B ran the static detector only; no CDP scan.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Park notice keeps future tense ("resumes 14:30") after the resume (`pane-chat.ts:345-353`) |
| 2 | Match System / Real World | 2 | "Usage limit reset" reads as a command; "resets" vs "resumes" carry who-acts in one word (`account-banner.tsx:33,43,45`) |
| 3 | User Control and Freedom | 2 | No resume-now while parked-to-resume or waiting for a future reset |
| 4 | Consistency and Standards | 2 | Banner `text-sm` + outline vs InstallNotice `text-xs` + ghost; signed-out copy differs (`install-notice.tsx:15`) |
| 5 | Error Prevention | 3 | 7-day bound and grace prevent loops; Resume all on unknown reset invites a re-refusal |
| 6 | Recognition Rather Than Recall | 2 | Banner gives no count of affected agents |
| 7 | Flexibility and Efficiency | 2 | Bulk Resume all exists; no per-agent hold or resume-now |
| 8 | Aesthetic and Minimalist Design | 3 | One flat neutral line; weakened by amber rows during wait-for-me |
| 9 | Error Recovery | 3 | Signed-out gives a concrete fix plus Retry |
| 10 | Help and Documentation | n/a | No help surface in dia |
| **Total** | | **22/36** | **Acceptable** |

## Design Specificity Verdict

LLM assessment: mostly authored for dia — neutral banner under the One Voice Rule, mono `claude`, aria-hidden separators, outcome-worded setting. One choice works against the product: a usage-limit park in Wait-for-me mode folds to amber needs-input while the user can do nothing until the reset.

Deterministic scan: `impeccable detect` over the six changed UI files exited 0 with 0 findings. The detector found nothing the review missed; the review's issues (status semantics, contrast of a translucent dot, live-region timing) are not static-pattern findings.

## Priority Issues

1. [P1] Wait-for-me park before the reset shows amber needs-input. `agent-summary.ts` folds `ParkedForUser{UsageLimit}` to `StatusNeedsInput` while `awaitsUser` is false. Amber pulses and sorts above real permission requests: a false alarm per PRODUCT.md principle 1. Fix: show StatusParked (`Resets 14:30`) until the reset passes, then needs-input. Command: /impeccable clarify.
2. [P1] Parked dot `bg-ink-muted/40` is about 1.8:1 against the sidebar (estimate), under the 3:1 non-text contrast floor, and is close to the hollow idle ring in the collapsed rail. Fix: full `bg-ink-muted` with a distinct shape. Command: /impeccable polish.
3. [P2] Banner inconsistencies: `text-sm`/outline vs InstallNotice `text-xs`/ghost; signed-out instruction differs ("Run `claude` in a terminal and sign in" vs "Run `claude auth login`"); `·` not aria-hidden in the waiting/resuming strings and the notice. Command: /impeccable clarify.
4. [P2] Live region inserted already filled may not announce; Resume/Retry unmount after click and focus drops to body. Fix: keep a mounted empty `role="status"` container. Command: /impeccable harden.
5. [P3] Transcript does not record the resume; the automatic `continue` shows as a user bubble. Command: /impeccable clarify.

## Persona Red Flags

- Power user with many agents: no agent count in the banner; amber rows bury the real permission prompt; overview rows do not re-render on a clock, so `Fri 14:30` never becomes `14:30`.
- Screen-reader user: banner may not announce on first appearance; focus lost after Resume; the overview row reads "Usage limit reached" with no reset time.
- William returning after hours: stale future-tense notice and a `continue` bubble he did not type.

## Minor Observations

- `Hand` icon for "Wait for me" reads as "stop".
- Banner is left-aligned at `px-4` while the transcript is centred.
- `formatResetTime` shows "Fri 9:00" for a reset almost seven days away on a Friday.

## Questions to Consider

- Does the resuming-on-its-own case need a banner at all, or is the dimmed dot plus row line enough?
- Should one account-level cause be one signal instead of N rows?
