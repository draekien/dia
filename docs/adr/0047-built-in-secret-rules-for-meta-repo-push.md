---
status: "accepted"
date: 2026-11-01
decision-makers: William Pei
---

# Scan meta repo pushes with a built-in rule set, run in the Host over `git log -p`

## Context and Problem Statement

ADR-0025 lets the user push the meta repo to a remote and requires dia to scan the commits being pushed for secrets and refuse the push when the scan finds one; it leaves the scanner to implementation, and `docs/prds/agent-os.md` lists it as an open question. Goal 8 of that PRD requires a push that contains a test secret to be refused in every attempt. Which scanner runs, and how does it see exactly the commits being pushed?

## Decision Drivers

* It must run in the installed Windows build (ADR-0016: an electron-builder NSIS installer) without assuming Node, npm or a scanner on the user's machine, and without network access.
* It must detect the credential formats an agent transcript can contain: Anthropic, OpenAI, GitHub and AWS keys, private keys, and generic high-entropy secrets assigned to a key or password name.
* It must scan the commits the push sends, not the working tree.
* Nothing in the meta repo may switch the scan off: a meta agent writes the repo, and it copies transcript text (ADR-0025, Consequences).
* A refusal must name each finding (file, commit, rule) without showing the secret.
* The licence must allow shipping it inside dia's installer; the installer size and the release pipeline should not grow much.

## Considered Options

* A built-in rule set in the `meta` plugin, run over `git log -p` output
* betterleaks, bundled as a binary
* gitleaks, bundled as a binary
* TruffleHog, bundled as a binary
* secretlint, as an npm dependency run in the Host

## Decision Outcome

Chosen option: "A built-in rule set in the `meta` plugin, run over `git log -p` output", because it runs in the Host that already runs the push, adds no binary, download step or dependency to the installer, has no allow comment, ignore file or config file a meta agent could add to the repo, and covers every credential format in the decision drivers.

The plugin runs `git log -p --text --unified=0 <head> --not --remotes=<remote>` after a `git fetch`, so it scans the added lines and messages of exactly the commits the remote does not have. `docs/designs/meta-repo-push.md` lists the rules and the git options. The rules are adapted from gitleaks' MIT-licensed default configuration.

### Consequences

* Good, because the installer, `electron-builder.yml` and the release workflow do not change.
* Good, because no file in the meta repo changes what the scan reports.
* Good, because the scan is a pure function over git's output, tested without a scanner process.
* Bad, because dia maintains the rules: a provider's new key format is missed until a rule is added. Replacing the rule set with betterleaks is the upgrade path; the scan sits behind one function in `plugins/meta`.
* Bad, because the rule set is smaller than a dedicated scanner's (about a dozen rules against gitleaks' 200) and has no token-efficiency filter, so it misses rarer providers and may refuse a high-entropy value that is not a secret. A false positive can only be cleared by removing the value from the unpushed commits.

## Pros and Cons of the Options

### A built-in rule set in the `meta` plugin, run over `git log -p` output

* Good, because it needs only the `git` that the meta repo already requires.
* Good, because it works offline and has no licence or size cost.
* Bad, because detection quality is dia's responsibility.

### betterleaks, bundled as a binary

The successor to gitleaks by gitleaks' author, MIT, v1.9.0 (2026-09-29); the Windows x64 zip is 10 MB.

* Good, because it has the broadest rule set of the options and a token-efficiency (BPE) filter for generic secrets.
* Good, because `betterleaks git --revision=A..B` scans a commit range by reading git objects in-process, without running `git`, hooks or credential helpers, and it does not load a `.betterleaks.toml` from the scanned repo.
* Bad, because the binary must be downloaded and checksummed in every build (no npm package ships it), added to the installer and unpacked from `app.asar` so it can be executed.
* Bad, because `betterleaks:allow` and `gitleaks:allow` comments suppress findings by default, so every invocation must pass `--no-allow-signatures`.
* Bad, because `--revision` takes one `A..B` range, not "not on any remote-tracking ref".

### gitleaks, bundled as a binary

MIT, v8.30.1; the Windows x64 zip is 8 MB.

* Good, because `gitleaks git --log-opts` scans any `git log` range and its rules are widely used.
* Bad, because its README marks it feature complete with security patches only, its author now maintaining betterleaks.
* Bad, because it auto-loads `.gitleaks.toml` from the scanned repo unless `--config` is set, and honours `gitleaks:allow` and `.gitleaksignore`, so a file in the meta repo can switch findings off.
* Bad, because it has the same download-and-unpack packaging cost as betterleaks.

### TruffleHog, bundled as a binary

* Good, because it verifies many credential types against their providers.
* Bad, because it is AGPL-3.0, and the Windows archive of v3.99.7 is 77 MB.
* Bad, because verification makes network calls; it must be switched off to keep the scan offline.

### secretlint, as an npm dependency run in the Host

MIT, v13.1.0; `@secretlint/secretlint-rule-preset-recommend` covers 28 providers, Anthropic, OpenAI, GitHub, AWS and private keys among them.

* Good, because it runs in the Host's Node runtime with no binary, and its provider rules are maintained upstream.
* Bad, because it has no generic high-entropy rule, so dia would still write one.
* Bad, because it lints files: the added lines of each commit would have to be reassembled into files to keep line numbers.
* Bad, because its `secretlint-disable` comments suppress findings unless the comment filter is left out of the configuration.

## More Information

* betterleaks: https://github.com/betterleaks/betterleaks (README and `docs/scanning.md`: `--revision`, allow signatures, config loading).
* gitleaks: https://github.com/gitleaks/gitleaks (README: `--log-opts`, `.gitleaks.toml` loading, `gitleaks:allow`, project status); default rules in `config/gitleaks.toml`.
* TruffleHog: https://github.com/trufflesecurity/trufflehog (licence, release assets).
* secretlint: https://github.com/secretlint/secretlint (`packages/@secretlint/secretlint-rule-preset-recommend`).
* Related: ADR-0025 (the meta repo), ADR-0016 (installer), `docs/designs/meta-repo-push.md`.
