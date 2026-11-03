---
paths:
  - "**/*.test.ts"
  - "**/*.test.tsx"
---

# Tests run without Claude

CI has no `claude` binary and no logged-in Claude account. Every test must pass on a machine that has neither.

- Do not call the Claude binary or a real Claude account from a test. Stub the `@anthropic-ai/claude-agent-sdk` functions the code under test calls.
- A `vi.mock('@anthropic-ai/claude-agent-sdk', ...)` factory that spreads `importOriginal()` keeps every other SDK export real. Override each SDK function the code under test reaches, for example `getSessionMessages`.
- A test that passes locally can fail in CI only because the developer's machine has Claude installed and logged in. Before relying on a local pass, check that no SDK call, file read under `~/.claude` or process spawn reaches the real installation.
- Example: `session-queue.test.ts` timed out in CI at 5000ms because the real `getSessionMessages` ran. The fix was `getSessionMessages: () => Promise.resolve([])` in the mock.
