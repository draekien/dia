---
target: turn steps sections, live summary and Transcript mode setting
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:F:\\Dev\\dia\\plugins\\chat\\steps-section.tsx"
target_fingerprint: "sha256:1abc01c367268873040fc19cebb3abef321a6357b0a699ad39104f83d42e9403"
target_path: "F:\\Dev\\dia\\plugins\\chat\\steps-section.tsx"
timestamp: 2026-10-30T10-36-13Z
slug: plugins-chat-steps-section-tsx
---
Method: dual-agent (A: ac064c20ee347b757 · B: a279fe6ced7bb5372). B returned no output; the parent ran `impeccable detect` (CLI and `--cdp 9333`) after A finished.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Live label shows `Bash 6s` with no target until the call resolves; live `9s` becomes final `8s` |
| 2 | Match System / Real World | 3 | "All text" is not self-explanatory |
| 3 | User Control and Freedom | 3 | Open state lost on mode switch; no expand-all |
| 4 | Consistency and Standards | 2 | Section chevron, Brain marker, chevron-less clickable tool rows; OS amber focus ring |
| 5 | Error Prevention | 3 | `Interrupt & retry` sits beside `Resend` inside the summary toggle |
| 6 | Recognition Rather Than Recall | 3 | Collapsed summary names no tools or files |
| 7 | Flexibility and Efficiency | 2 | No shortcut to expand; mode only in Settings |
| 8 | Aesthetic and Minimalist Design | 3 | Quiet and on-brand; four left edges within 26px |
| 9 | Error Recovery | 1 | A failed tool call renders with a check and "completed" |
| 10 | Help and Documentation | 2 | "Transcript mode" row has no description |
| **Total** | | **24/40** | **Acceptable** |

## Design Specificity Verdict

LLM assessment: the pattern (`› N steps · 12s`) is the category-standard reasoning disclosure. dia-specific parts: Marker rows, mono tool targets (Content-Is-Mono Rule), a neutral slow pulse outside the status colours (One Voice Rule), and the live activity line inside the summary.

Deterministic scan: CLI `detect` on steps-section.tsx, turn-activity-line.tsx, pane.tsx, general-settings.tsx: 0 findings. CDP scan of the running app: 3 findings. 1 is in turn steps: low contrast, `span.truncate.text-muted-foreground/80` (tool target) at 4.1:1 on #0b0d11, which agrees with A's 4.07:1. 2 are outside scope (line length ~93 chars and a one-word last line in a message bubble). The pixel pass read nothing because the window was not in the foreground; contrast came from computed styles.

## Priority Issues

1. [P0] A failed tool call looks successful. `ToolCallRow` never reads `part.isError` (check icon, sr-only "completed"); `stepsSummary` counts steps only. Fix: failed icon + "failed" label on the row; `· N failed` on the section summary.
2. [P1] Agent prose between steps renders as the same muted bubble as the final answer. Fix: render text inside a section in a quieter form than the answer bubble.
3. [P1] Stall actions are buttons nested inside `<summary>`, so they join the disclosure's accessible name. Fix: keep dot, label and elapsed in the summary; render the actions after it.
4. [P1] The summaries have no focus style; Chromium draws the OS accent (amber) outline. Fix: `rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50` on the three summaries.
5. [P2] Muted text with opacity fails AA at text-xs: target `/80` 4.07:1 dark / 3.61:1 light; elapsed `/70` 3.38:1 / 2.97:1. Fix: drop the opacity modifiers.

## Persona Red Flags

Alex: no keyboard shortcut to expand; mode only via Ctrl K › Settings › ToggleGroup; history turns ignore the mode; tool rows are full-width clickable details with no chevron.
Sam: amber OS focus ring; summary name "3 steps · 9s" with no verb; stall buttons nested in summary; failed tool announced "completed"; muted text under 4.5:1.

## Minor Observations

- Live label has no target while a tool runs: `input` is set only on completion.
- Live elapsed counts from turn start, final duration from first part (`9s` → `8s`).
- "Thinking" is mono in ThinkingDisclosure and sans in the live label.
- Running summary shows no sign it can be expanded.
- `1:05` reads like a clock time next to "steps".
- Long tool targets truncate the end (the filename).
- "Transcript mode" needs a one-line description.
- Mode switch re-keys blocks, so open sections close.
- Left edges: bubble 360, chevron 364, bubble text 373, summary text 386.

## Questions to Consider

- Should prose that changes the meaning of the answer be hidden behind a count of tool calls?
- Should the summary report outcomes (files changed, failures) instead of step count and time?
- Is the transcript mode a view of the data, or only of turns streamed this session?
