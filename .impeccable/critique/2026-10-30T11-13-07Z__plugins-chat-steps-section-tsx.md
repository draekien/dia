---
target: turn steps sections, live summary, tool rows and agent text layout
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:F:\\Dev\\dia\\plugins\\chat\\steps-section.tsx"
target_fingerprint: "sha256:5c95763806c3d235010d377f88260c17dcd6abcdff35ec51c38524c7e2d5c4f6"
target_path: "F:\\Dev\\dia\\plugins\\chat\\steps-section.tsx"
timestamp: 2026-10-30T11-13-07Z
slug: plugins-chat-steps-section-tsx
---
Method: dual-agent (A: a59da48987581094e · B: ac861fd3d90ce685e), run sequentially because both drive the one dia window. Run as step 1 of the raise-pr gate on branch fix/turn-steps-critique (PR #67), head 8c24d87..d27ff61.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | The working and stalled dot look the same until the stall buttons appear |
| 2 | Match System / Real World | 3 | Plain copy; "steps", "failed", "Resend" |
| 3 | User Control and Freedom | 3 | Native disclosure; no expand-all |
| 4 | Consistency and Standards | 3 | Tool rows tint on hover while summaries change text colour; thinking body `pl-3` vs section body `pl-6` |
| 5 | Error Prevention | 3 | Stall actions sit outside `<summary>` |
| 6 | Recognition Rather Than Recall | 2 | A collapsed section names no tools |
| 7 | Flexibility and Efficiency | 2 | No expand-all or shortcut |
| 8 | Aesthetic and Minimalist Design | 4 | One muted line per section; text always visible |
| 9 | Error Recovery | 2 | `1 failed` does not say which call failed |
| 10 | Help and Documentation | 2 | Nothing explains the dot or the stalled state |
| **Total** | | **27/40** | **Acceptable** |

## Design Specificity Verdict

LLM assessment: the decisions come from dia's model (neutral working pulse shared with the Status Indicator, failed count in foreground text under the One Voice Rule, mono targets under the Content-Is-Mono Rule). The visual form is the category-standard muted disclosure line.

Deterministic scan: CLI `detect` on steps-section.tsx, turn-activity-line.tsx, pane.tsx: 0 findings (exit 0). CDP scan of the running app, sections closed and then all 5 `<details>` opened: 1 finding each time (exit 2), `line-length` ~92 chars on a message paragraph in `.typeset-docs`, out of scope. Measured contrast of the muted text-xs summary on the dark background: 5.78:1.

## Priority Issues

1. [P1] The summary's accessible name ran its parts together: the `aria-hidden` separator hid its spaces, so a screen reader got `1 step11s` (confirmed by a jsdom test). Fix: keep the spaces outside the hidden `·`.
2. [P1] A failure is not identifiable from the collapsed section: `1 failed` names no call. Fix: name the tool when one call failed (`Bash failed`), count when more failed.
3. [P2] Stalled and working share the same pulsing dot. Fix: stop the pulse when stalled.
4. [P2] The `aria-live` label announces every step change during a long run, and the end of a turn is not announced.
5. [P3] Assessment A reported a nonzero Bash exit shown as completed. False positive: the seeded command ended in `echo`, so it exited 0.

## Persona Red Flags

Alex: no expand-all; a collapsed section names no tools.
Sam: summary name ran together (issue 1); every step change announced; failure only discoverable inside the section.

## Minor Observations

- A long tool target truncates with no way to read it in full without opening the output.
- Two hover styles: tool rows tint the background; summaries change text colour.
- Thinking body indents `pl-3`; section bodies `pl-6`.
- The running summary has no chevron.
- A turn restored from history shows no sections.

## Questions to Consider

- Should a section that contains a failure open by default?
- Should a restored turn regroup into sections?
- Should the stalled state carry its own copy?
