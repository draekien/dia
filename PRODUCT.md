# Product

## Register

product

## Users

William — dia's sole user and developer. He uses dia on his own desktop machine to drive local Claude Code sessions, including using dia to develop dia itself (dogfooding). His context: running multiple parallel agent conversations at once (up to 6 panes), each against a different working directory/model, watching for which pane needs attention (permission request, error, completion) while focused on another.

## Product Purpose

dia is a personal desktop alternative to Claude Desktop: a tmux-like, split-pane workspace where each pane runs its own independent Claude Agent SDK session. It exists to remove the cost of context-switching between separate single-session windows, so parallel, exploratory agent-driven work (e.g. two areas of a codebase, or dia's own development alongside another project) becomes as easy as glancing at a pane. Success looks like William using dia, with 6+ concurrent panes, as his daily driver for this kind of work, with layouts and histories surviving restarts losslessly.

## Brand Personality

Polished consumer desktop app — the craft level of a well-made Mac/Linux native app, not a bare-bones dev tool. No single fixed reference; the bar is "feels considered and finished," not a specific named product's visual language. Calm and legible under load: with up to 6 panes open at once, the UI must stay readable and low-friction rather than busy or decorative.

## Anti-references

- Not a raw terminal-multiplexer aesthetic (no ASCII-art borders, no minimal-chrome-for-its-own-sake) — this should read as a native app, not a wrapped terminal.
- Not a generic "AI chat SaaS" look (no gradient hero treatments, no marketing-site visual patterns) — this is a personal tool, not a product being sold.
- Not visually noisy or attention-grabbing outside of the deliberate pulse indicators — status signaling (amber/red/green pulse) should be the one place the UI raises its voice.

## Design Principles

1. **Glanceability over detail** — with 6 panes running at once, state (idle / awaiting permission / errored / completed) must be readable at a glance, before focusing any single pane.
2. **One voice for attention** — the pulse indicators are the UI's only urgent visual signal; nothing else competes with them for attention.
3. **Calm density** — fit many independent panes on screen without the layout feeling cramped or chaotic; density and legibility are not in tension here, they're both requirements.
4. **Native, not decorative** — craft reads through restraint and finish (spacing, type, motion), not through ornamentation borrowed from marketing sites.
5. **Fast under real use** — since this drives real development work (including on itself), interaction latency and responsiveness are part of the design, not just the visuals.

## Accessibility & Inclusion

Baseline: standard contrast (WCAG AA) and full keyboard navigability. No specific personal accommodation beyond that — single-user, non-public-facing app — but reduced-motion support is still expected as standard hygiene for any pulse/transition animation.
