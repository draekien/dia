# Architecture Decision Records

This directory holds dia's Architecture Decision Records (ADRs), written in [MADR](https://adr.github.io/madr/) format.

- `template.md` — the MADR template used for new records.
- `NNNN-title.md` — one record per decision, numbered sequentially.

## Index

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-electron-as-desktop-app-shell.md) | Use Electron as the desktop application shell | accepted |
| [0002](0002-react-typescript-for-renderer.md) | Use React with TypeScript for the renderer | accepted |
| [0003](0003-agent-sdk-runs-in-electron-utility-process.md) | Run the Claude Agent SDK in an Electron utilityProcess | accepted |
| [0004](0004-electron-vite-for-build-tooling.md) | Use electron-vite for build tooling | accepted |
| [0005](0005-tailwind-and-shadcn-ui-for-styling.md) | Use Tailwind CSS and shadcn/ui for renderer styling | accepted |
| [0006](0006-pnpm-single-package-repo-layout.md) | Use pnpm with a single-package repo layout | accepted |
| [0007](0007-one-utility-process-per-pane.md) | Run one utilityProcess per pane for concurrent independent agent sessions | accepted |
| [0008](0008-local-file-persistence-for-session-and-layout-state.md) | Use local file-based persistence for pane layout and session state | accepted |
| [0009](0009-effect-ts-for-main-process-orchestration.md) | Use Effect TS for main-process orchestration logic | superseded by ADR-0010 |
| [0010](0010-extend-effect-ts-to-pane-process-orchestration.md) | Extend Effect TS to pane-process orchestration | accepted |

## Adding a new ADR

Copy `template.md` to `NNNN-short-title.md` (next sequential number), fill it in, and add a row to the index above.
