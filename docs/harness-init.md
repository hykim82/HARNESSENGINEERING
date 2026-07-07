# Harness Init

## Purpose

Phase 7 packages the HARNESSENGINEERING rules into an opt-in asset for
future projects.

The package must not automatically modify new repositories. It should help a
human or orchestrator install the harness only after an explicit request.

Status:

```text
stable
```

Reason:

- Phase 0-6 design documents exist and are committed.
- Validated on two separate target repositories: HARNESS_VALIDATION_TARGET
  (non-loop documentation path, Linear HYK-69) and 모바일마크다운에디터 (loop
  path via a markdown parser, Linear HYK-76).
- Relay Protocol v2 and the Windows/WSL execution lessons are folded in
  (HYK-77); see `docs/claude-orchestrator-handoff.md` for the protocol.
- Honesty note: the ui-review non-loop profile is defined but not yet
  run-validated end-to-end (the documentation profile was); it will be
  exercised during the target project's UI phases.
- No global `harness-init` skill has been installed from this repository.
- v2 (HYK-92) parameterizes the package into two install profiles
  (`solo-full`, `team-local`) and adds `install.mjs`; see "Profiles (v2,
  HYK-92)" below. Validated by installing `team-local` into a real second
  repository (`TEAM10`, a shared team SPA) and dry-running `solo-full`
  against this repository itself.

## Profiles (v2, HYK-92)

This session's enforcement layer (HYK-83/86/87/88/90) was built directly
into HARNESSENGINEERING itself, not the template — applying it to a new
project meant manually re-deriving it, which drifts. v2 extracts it into two
profiles, each backed by a real instance:

- **`solo-full`** — this repository. A single operator, GitHub-public,
  server-side enforcement: protected default branch (PR + green `enforce`
  CI + one human approval, `enforce_admins` on), a Write-only bot
  collaborator doing the pushing (identity separation, B1/HYK-87), gitleaks
  in CI, plus the local `hooks/commit-msg` / `hooks/pre-commit` and
  role-guard `PreToolUse` hook for fast local feedback.
- **`team-local`** — a repo this account does not own or administer (e.g. a
  shared classroom/team repo). No server-side gate is added — this account
  cannot add one, and even if it could, imposing it on a repo the whole team
  uses is out of scope. Enforcement here is **local-only**: the same check
  scripts and git hooks, run from a personal `verify.sh`, ignored from the
  shared repo's history entirely (see "team-local gitignore" below). Landing
  work still goes through a feature branch and an upstream PR under the
  team's own review process, not this harness's rules.

### Parameters

Five placeholder tokens, filled in at install time (`install.mjs` does
plain string substitution — no template engine):

| Token | Meaning | solo-full example | team-local example |
| --- | --- | --- | --- |
| `<PROFILE>` | which profile was installed | `solo-full` | `team-local` |
| `<REPO_PATH>` | absolute path to the target repo | `C:\...\HARNESSENGINEERING` | `C:\...\TEAM10` |
| `<CONTROL_ROOM_PATH>` | path to the operator's control room (outside the repo) | `D:\문서관리\하네스-관제실` | *(omit — team-local has no control room)* |
| `<GITHUB_REPO>` | `owner/repo` | `hykim82/HARNESSENGINEERING` | `AL06-Class/AL06TEAM10` |
| `<BOT_ACCOUNT>` | Write-only bot collaborator | `codexlocal101-rgb` | *(omit — team-local pushes directly, no bot)* |
| `<VERIFY_CMD>` | the one command verify.sh runs | `node scripts/check/review-gate.test.mjs && ...` | `npm run build` |

`<CONTROL_ROOM_PATH>` and `<BOT_ACCOUNT>` are optional and may be blank for
`team-local`; `install.mjs` requires them only when `<PROFILE>` is
`solo-full`.

### What each profile installs

Both profiles (profile-agnostic core):

- `.harness/STATUS.md`, `.harness/PHASE-HANDOFF.md` — from
  `status.template.md` / `phase-handoff.template.md`, now carrying a
  `Profile: <PROFILE>` header and profile-conditional relay notes.
- `verify.sh` — from `verify.sh.template`, a one-line `exec <VERIFY_CMD>`
  wrapper that propagates the real exit code.
- A `.gitignore` append — from `gitignore.append.template`, which one
  block a profile receives.
- `hooks/commit-msg`, `hooks/pre-commit`, and
  `scripts/check/{review-gate,relay-handshake,role-guard}.{mjs,test.mjs}` —
  copied **directly from this repository's live files**, not a frozen
  template copy, so an install always ships whatever this repo's
  enforcement layer currently is (the exact drift this v2 exists to avoid).

`solo-full` only, additionally:

- `AGENTS.append.md` appended to the target's `AGENTS.md` (skipped if
  equivalent rules already exist).
- `.github/workflows/enforce.yml` and `.gitleaks.toml`, copied live from
  this repo.
- `.harness/github-setup-checklist.md` — a checklist of the one-time,
  human-only GitHub web UI steps (branch protection, inviting the
  Write-only bot, enabling secret scanning). **Never automated** — this
  mirrors the B1 anchor principle that server-side authority setup is a
  human action outside agent control.

`team-local` only, differently:

- **`AGENTS.md` is left untouched.** It is shared, committed team state;
  appending personal harness rules to it would impose this account's
  tooling on the team repo, which is exactly what this profile exists not
  to do.
- **No `.github/workflows/enforce.yml`, no `.gitleaks.toml`, no GitHub
  checklist.** There is no server-side gate to add.
- The `gitignore.append.template`'s `team-local` block ignores the entire
  local harness toolchain — `.harness/`, `verify.sh`, `hooks/commit-msg`,
  `hooks/pre-commit`, `scripts/check/` — on top of the relay directory, so
  none of it ever becomes a tracked change in the shared repo.

### `install.mjs` usage

```sh
node templates/harness-init/install.mjs \
  --profile solo-full \
  --repo-path "C:\path\to\repo" \
  --control-room-path "D:\path\to\control-room" \
  --github-repo "owner/repo" \
  --bot-account "bot-account-name" \
  --verify-cmd "node scripts/check/review-gate.test.mjs && ..." \
  [--dry-run]

node templates/harness-init/install.mjs \
  --profile team-local \
  --repo-path "C:\path\to\team\repo" \
  --github-repo "owner/repo" \
  --verify-cmd "npm run build" \
  [--dry-run]
```

Parameters may also be supplied via a `harness-init.config.json` placed in
the target repo (or passed with `--config <path>`); CLI flags override
matching config-file keys. `install.mjs` never overwrites an existing file
— an existing path is skipped with a warning, never replaced. `--dry-run`
logs every action it would take without writing anything, useful for
confirming the skip path on a repo that already has the harness installed.
Run output ends with an installed/skipped file summary, and for
`solo-full`, the GitHub setup checklist.

## Package Contents

Local package path:

```text
templates/harness-init/
```

Contents:

- `README.md`: package usage guide
- `AGENTS.append.md`: project instruction snippet
- `task-contract.template.md`: task contract template
- `non-loop-evidence.template.md`: non-loop evidence packet template
- `harness-records.template.md`: Linear outage fallback record template
- `harness-progress.template.md`: long-running progress template
- `harness-metrics.template.md`: evaluation metric template
- `model-routing.template.md`: model and engine routing template
- `claude-orchestrator-prompt.template.md`: Claude Code Orchestrator startup prompt
- `codex-verifier-prompt.template.md`: Codex Verifier startup prompt
- `codex-reviewer-prompt.template.md`: Codex Reviewer startup prompt
- `handoff-packet.template.md`: Claude-to-Codex handoff format
- `question-packet.template.md`: role-to-Orchestrator question format
- `phase-handoff.template.md`: phase-boundary handoff for session rotation
- `status.template.md`: short "where am I" status board
- `skill/SKILL.md`: draft skill instructions for a future `harness-init` skill

## Opt-In Rule

Harness init runs only when the user explicitly asks for it.

Valid triggers:

- "Install harness in this project."
- "Apply harness-init here."
- "Create the harness task contract and records for this repository."

Invalid triggers:

- opening a new repository
- starting a normal coding task
- detecting that `AGENTS.md` is missing
- detecting that `LOOP.md` is missing

Missing harness files mean:

```text
harness not applied yet
```

They do not mean the repository is broken.

## Installation Procedure

1. Read the target repository `AGENTS.md` if it exists.
2. Determine the Linear project name from `Linear-Project:` or repository name.
3. Ask before creating a Linear project if it does not exist.
4. Show the files that would be created or appended.
5. Ask for explicit approval to apply the harness.
6. Append `AGENTS.append.md` content only when the target project does not
   already define equivalent harness rules.
7. Copy templates only when they do not overwrite existing project files.
8. Record what was installed in Linear.
9. Leave loop profile uninstalled unless the user separately requests
   `$loop-init` or explicit loop installation.

## Default Target Files

Suggested target layout:

```text
AGENTS.md
docs/task-contract.md
docs/harness-records.md
docs/harness-progress.md
docs/harness-metrics.md
docs/non-loop-evidence.md
docs/model-routing.md
```

These files are suggestions, not mandatory global paths. A target repository may
choose different paths if the Task Contract records them.

Packet templates (`handoff-packet`, `question-packet`) and role prompts are not
copied by default. Roles reference them from the source package
`templates/harness-init/`, or copy them into the target only on explicit
request. This list is the single source of truth for default installation;
`templates/harness-init/README.md` and `skill/SKILL.md` defer to it.

## Loop Profile Boundary

Harness init does not install the loop profile by default.

Loop profile remains separate:

- `LOOP.md`
- `METRICS.md`
- `scripts/verify.sh`
- `scripts/check-cases.mjs`
- `.gitattributes`

Install loop only when:

- the task can be judged by one command returning PASS/FAIL
- the user explicitly approves loop installation
- the target repository accepts the loop assets

If `LOOP.md` is absent, treat it as:

```text
loop profile not applied
```

Do not treat it as a harness failure.

## Linear Integration

Harness init should preserve the global Linear rule:

- use the project named by `Linear-Project:`
- do not create a new Linear project without asking
- create or connect an issue before work starts
- move AI-managed work only to In Review
- never move an issue to Done

If Linear is unavailable:

- report the outage immediately
- use `docs/harness-records.md` only if work continues
- include the outage in the final report

## Notion Integration

Notion is optional.

Use Notion only when the Task Contract names it as:

- source of truth
- publication target
- external record location

If Notion is unavailable, report it and keep a Linear or repository fallback
record.

## Global Asset Backup Guide

Before changing global Codex assets, record:

- exact source path
- exact destination path
- timestamp
- reason for change
- rollback path

Global assets include:

- `~/.codex/AGENTS.md`
- `~/.codex/skills/`
- `~/.codex/agents/`

Harness init does not change these global paths.

## Validation Plan

Before calling this package stable:

1. Choose a separate target repository.
2. Start Claude Code as Orchestrator using
   `claude-orchestrator-prompt.template.md`. If operating procedure is
   unclear from that prompt and `.harness/STATUS.md` alone, read
   `docs/claude-orchestrator-handoff.md` before proceeding.
3. Apply harness init with explicit approval.
4. Create one non-loop Task Contract.
5. Run one task to In Review.
6. Send one handoff packet from Claude Orchestrator to Codex Reviewer.
7. Send one question packet from Coder, Verifier, or Reviewer to Claude
   Orchestrator and record the answer.
8. Record a metric using `harness-metrics.template.md`.
9. Confirm no loop files were installed unless explicitly requested.
10. Confirm the target repository can remove the harness files cleanly.

Stable status requires evidence from a real target project.

## Phase 7 Completion

Phase 7 is complete when:

- harness-init package exists in `templates/harness-init/`
- opt-in rule is explicit
- loop profile remains optional and separate
- Linear and Notion rules are documented
- global asset changes are forbidden
- validation plan exists
- package status is clearly marked draft or stable
