# Meta repo push

Status: implemented for issue #19 (agent OS plan step 8, ADR-0025, ADR-0047).

## Purpose

The user sets a remote for the meta repo and pushes its current branch from Settings. Before every push the `meta` plugin scans the commits that the remote does not have yet for secrets and refuses the push when it finds one. A refusal names each finding by rule, file, line and commit, and never the secret.

## Interface

```
src/shared/domain/meta-repo.ts                                      (platform-neutral)
  SecretFinding     { rule: string, description: string, commit: string, file: string | null, line: int }
                    file null: the line is in the commit message
  MetaRepoState     TaggedStruct 'MetaRepoState'  { remoteUrl: string | null, branch: string | null }
  MetaRepoPushed    TaggedStruct 'MetaRepoPushed' { branch: string, remoteUrl: string, commitCount: int }
  MetaRepoPushRefused TaggedStruct 'MetaRepoPushRefused' { findings: NonEmptyArray<SecretFinding> }
  MetaRepoFailed    TaggedStruct 'MetaRepoFailed' { message: string }
  MetaRepoStateResult = MetaRepoState | MetaRepoFailed
  MetaRepoPushResult  = MetaRepoPushed | MetaRepoPushRefused | MetaRepoFailed

src/host/services/meta-repo-seam.ts                                 (kernel)
  interface MetaRepo {
    forNewSession: Effect<SessionAdditions>                         unchanged
    state: Effect<MetaRepoStateResult>
    setRemote: (url: string) => Effect<MetaRepoStateResult>
    push: Effect<MetaRepoPushResult>
  }                                                                 none of them fails
  withMetaRepo(registry, use): Effect<A | MetaRepoFailed>           MetaRepoFailed, logged, when the plugin is
                                                                    not loaded, malformed, or `use` dies
  resolveSessionAdditions(registry)                                 unchanged behaviour

src/shared/ipc/rpc.ts            (PROTOCOL_VERSION bump)
  GetMetaRepo                    success MetaRepoStateResult
  SetMetaRemote { url }          success MetaRepoStateResult
  PushMetaRepo                   success MetaRepoPushResult
  The handlers call withMetaRepo, which answers MetaRepoFailed "The meta plugin is not loaded." when no plugin provides a MetaRepo.

src/shared/ipc/contract.ts, src/preload/host-api.ts
  window.dia.metaRepo { getState(), setRemote(url), push() }  -> encoded results

src/host/plugin-api.ts           (PLUGIN_API_VERSION bump, every plugin.json)
  exports MetaRepoState, MetaRepoPushed, MetaRepoPushRefused, MetaRepoFailed, SecretFinding
  and the types MetaRepoStateResult, MetaRepoPushResult

plugins/meta/
  secret-rules.ts   SECRET_RULES, findSecretRule(line): SecretRule | undefined (first match only)
  push-scan.ts      SCAN_LOG_OPTIONS, the git log options whose output scanPatchLog reads
                    scanPatchLog(output): { commitCount, findings }
  meta-push.ts      makeMetaPush(directory): { state, setRemote, push }, redactUrlCredentials
  meta-repo.ts      makeMetaRepo(directory) combines forNewSession with makeMetaPush

src/renderer/src/components/settings/meta-repo-settings.tsx
  Settings page "Meta repo": remote URL field with Save, Push button, last result
```

## Behaviour

### Remote

- The remote is the git remote named `origin` in the meta repo; dia stores nothing else. `state` reads it with `git remote get-url origin` (no remote gives `null`) and the current branch with `git symbolic-ref --quiet --short HEAD` (detached gives `null`).
- `setRemote(url)` trims `url` and refuses (as `MetaRepoFailed`) an empty URL, one containing whitespace, or one starting with `-`, so the value can never be read by git as an option. It runs `git remote set-url origin <url>` when `origin` exists and `git remote add origin <url>` otherwise, then returns the new `state`.
- Every URL and git message that leaves the plugin has the password in a URL's user-info replaced (`https://user:***@host`), and the user name of an `http(s)` URL without a password replaced too (`https://***@host`), so a token embedded in the remote URL is not shown or logged.

### Push

`push` runs these steps under one semaphore shared with `setRemote`, so two pushes never interleave:

1. Read the remote (missing: `MetaRepoFailed "Add a remote first."`) and the branch (detached HEAD: `MetaRepoFailed`), and resolve `HEAD` to a commit SHA `head`.
2. `git fetch --prune origin`, so `refs/remotes/origin/*` record what the remote has now.
3. Scan the commits the push sends: those reachable from `head` and from no `refs/remotes/origin/*` ref, with `git -c core.quotePath=false log -p --text --no-color --no-ext-diff --no-textconv --no-renames --unified=0 --src-prefix=a/ --dst-prefix=b/ --diff-merges=first-parent --format=%x00%H%n%B%x00 <head> --not --remotes=origin`. A commit already on the remote, on any branch, is not scanned again. `scanPatchLog` checks every added line (with its file and new line number) and every commit message line against `SECRET_RULES`, and counts the commits. `--text` scans files that `.gitattributes` marks binary or `-diff`, and the explicit prefixes, `--no-ext-diff` and `--no-textconv` keep the user's or the repo's git config from changing the output or running a program.
4. Findings: return `MetaRepoPushRefused` with every finding; git is not run again, so the remote is unchanged.
5. No findings: `git push origin <head>:refs/heads/<branch>`. Pushing the scanned SHA, not the branch name, means a commit made between the scan and the push is not sent. Success returns `MetaRepoPushed` with the number of scanned commits.

Any git command that exits non-zero gives `MetaRepoFailed` with the step and git's last stderr line (credentials redacted). A rejected non-fast-forward push is reported the same way; dia never force-pushes.

### Credentials and hangs

- git uses the user's own credential helper or ssh agent; dia stores no credential.
- Every git command the plugin runs gets `GIT_TERMINAL_PROMPT=0`, so git fails instead of waiting for a username on a terminal the Host does not have.
- `fetch` and `push` time out after 2 minutes (`Duration.minutes(2)`), which leaves time for a credential helper's sign-in window. A timeout interrupts the command, which kills its process tree, and returns `MetaRepoFailed`. The Host's other work is never blocked: the RPC runs on its own fiber.

### Scanner

`SECRET_RULES` (ADR-0047) is a fixed list of regular expressions, adapted from gitleaks' default rules (MIT):

| Rule | Matches |
| --- | --- |
| `anthropic-key` | `sk-ant-<kind><nn>-` followed by 20+ key characters (API, admin and OAuth tokens) |
| `openai-key` | `sk-…T3BlbkFJ…` and `sk-proj-`/`sk-svcacct-`/`sk-admin-` keys |
| `github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` + 36, `github_pat_` + 82 |
| `aws-access-key` | `AKIA`/`ASIA`/`ABIA`/`ACCA`/`A3T?` + 16 base32 characters |
| `private-key` | a `-----BEGIN … PRIVATE KEY-----` line |
| `slack-token` | `xox[bpaers]-` tokens |
| `google-api-key` | `AIza` + 35 |
| `stripe-key` | `sk_live_`, `rk_live_`, `sk_test_`, `rk_test_` + 10+ |
| `npm-token` | `npm_` + 36 |
| `jwt` | three base64url segments starting with `ey` |
| `generic-secret` | a key, token, secret, password, credential or auth name assigned (`=`, `:`, `=>`) a value of 16+ characters that has a letter and a digit and Shannon entropy ≥ 3.5 bits per character |

There is no allow comment and no ignore file: a finding can only be cleared by removing the secret from the unpushed commits.

### UI

Settings gets a fourth page, "Meta repo", after Plugins. It shows the current remote (redacted) and branch, an empty URL field with a Save button that sets a new remote, and a Push button. The field is never prefilled, so a redacted URL is never saved back. While a push runs the button shows a spinner and is disabled. A pushed result shows "Pushed N commits of <branch> to <url>". A refusal shows "Push refused: dia found N possible secrets in the commits to push" and a list, one row per finding: rule description, `file:line` (or "commit message, line N"), short commit SHA. A failure shows its message. When the meta plugin is not loaded the page shows that message and no controls. The command palette lists the page as `Settings › Meta repo`.

## Design Rationale

- **The remote lives in git config** — `git remote` already stores it; a second copy in dia's settings could disagree with what `git push` uses.
- **Scan `head --not --remotes=origin`** — git sends the objects the remote lacks; the remote-tracking refs, refreshed by the fetch, are dia's record of what the remote has. Scanning the whole history would re-flag a secret the user already pushed with another tool and could never be cleared without rewriting history.
- **Push the scanned SHA** — removes the race between scan and push.
- **The plugin returns result unions, not errors** — every outcome is something the Settings page shows; the bridge carries plain data (contextBridge drops prototypes).
- **Settings, not the agent overview** — the remote is configuration and the push is a rare manual action; the overview lists agents.

## Rejected Alternatives

- **A bundled scanner binary (betterleaks, gitleaks, trufflehog)** — see ADR-0047.
- **A pre-push hook in the meta repo** — a hook also runs for `git push` from a terminal, but needs a scanner runnable outside the Host and is skipped by `--no-verify`. Out of scope.
- **An allow comment for false positives** — a meta agent copying transcript text could copy the comment too.

## Refinement Record

Rounds ran inline (no subagents in this run), effort medium; round 2 raised no blocker or major finding, so the rounds stopped.

**Applied**
- *Correctness* (round 1, major) — "binary files have no added lines and are not scanned": a `.gitattributes` line `* -diff` would hide every file from the scan. Now `--text`.
- *Correctness* (round 1, major) — the user's `diff.noprefix` config would drop the `b/` prefix the parser expects. Now explicit `--src-prefix`/`--dst-prefix`.
- *Correctness* (round 1, major) — a prefilled URL field shows the redacted URL; saving it would store `***` as the password. The field is now empty and the current remote is shown as text.
- *Correctness* (round 1, minor) — listing commits and scanning them were two git runs over the same range; the scan now counts the commits.
- *Define Errors Out of Existence* (round 1, minor) — `file: ''` for a commit message is now `file: null`.

**Rejected**
- *Information Hiding* (round 1, minor) — "`MetaRepo` mixes session additions and push": both are what the meta repo offers; the kernel still sees no file, path or git command.

**Escalated**
- None. Gate decisions were taken autonomously (no user in this run) and are listed in the PR.
