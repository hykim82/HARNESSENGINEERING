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
- `.harness/PROJECT-CONTEXT.md` — from `project-context.template.md`
  (HYK-94, structure updated HYK-96 Scope D). Two headings, one
  enforcement-relevant distinction: `## HARD CONSTRAINTS` (short,
  imperative — the only section `scripts/check/context-inject.mjs` injects
  into every new session via the `SessionStart` hook) and `## 목표·의도·맥락`
  (Goals/Intent/Context — freeform storage, never injected, can grow
  without cost). A `UserPromptSubmit` hook blocks all prompts if the file
  is missing, or if `HARD CONSTRAINTS` is empty or still has an unedited
  template placeholder in it (HYK-96 Scope A). See `docs/enforcement-v1.md`
  ("D6 — project-context injection", "Scope A", "Scope D") for the full
  mechanism.
- `verify.sh` — from `verify.sh.template`, a one-line
  `exec sh -c '<VERIFY_CMD>'` wrapper that runs the whole (possibly
  `&&`-chained) command through a shell and propagates its real exit code.
- `.claude/skills/capture-context/SKILL.md` — from
  `skill/capture-context/SKILL.md` (HYK-96 Scope C), a `/capture-context`
  skill that scans the session for durable goals/intent/hard-constraint
  facts, proposes a delta against the current `PROJECT-CONTEXT.md`, and
  writes it only after human edit/approval. Installed for **both**
  profiles. For `team-local`, `.claude/skills/capture-context/` is also
  added to the profile's `.gitignore` block (see below) — the skill is
  harness tooling and must not become tracked team-repo state. See
  `docs/enforcement-v1.md` ("D6 — project-context injection", "Scope C")
  for the full mechanism.
- A `.gitignore` append — from `gitignore.append.template`, which one
  block a profile receives.
- `hooks/commit-msg`, `hooks/pre-commit`, and
  `scripts/check/{review-gate,relay-handshake,role-guard,context-inject,status-fresh,clear-safe-check}.{mjs,test.mjs}` —
  copied **directly from this repository's live files**, not a frozen
  template copy, so an install always ships whatever this repo's
  enforcement layer currently is (the exact drift this v2 exists to avoid).
  `status-fresh.{mjs,test.mjs}` was missing from this list before HYK-95 —
  a copy-list gap, now fixed. `clear-safe-check.mjs` (HYK-96 Scope B) is a
  soft, non-blocking `/clear` reconciliation reminder — see "Claude Code
  hooks: now pre-wired by `install.mjs`" below.
- **`<target>/.git/hooks/commit-msg` and `<target>/.git/hooks/pre-commit`**
  (HYK-95) — a *real*, per-clone install of the two git hooks above, on top
  of the tracked copy under `hooks/`. Only runs when `<target>/.git` exists
  as a directory (a fresh, not-yet-`git init`'d target gets a warning
  instead, no crash); never overwrites an existing installed hook
  (skip + warn, same convention as every other file this installer writes).
  A target with no `.git/` at all still gets the tracked `hooks/` copy, for
  a later manual install.
- **`<target>/.claude/settings.local.json`** (HYK-95) — generated or merged
  with the same `hooks` block this repository's own live file carries
  (`PreToolUse` role-guard, `Stop` status-fresh + clear-safe-check,
  `SessionStart` + `UserPromptSubmit` context-inject), with STATUS/
  PROJECT-CONTEXT paths resolved per profile (control room for `solo-full`,
  `$CLAUDE_PROJECT_DIR/.harness/...` for `team-local`). See "Claude Code
  hooks: now pre-wired by `install.mjs`" below for the merge rules and
  limits. Both profiles' `.gitignore` block now also ignore
  `.claude/settings.local.json` — it carries this machine's absolute local
  paths, not shareable repo content.

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
  `hooks/pre-commit`, `scripts/check/`, `.claude/skills/capture-context/`,
  `.claude/settings.local.json` — on top of the relay directory, so none of
  it ever becomes a tracked change in the shared repo.

### Claude Code hooks: now pre-wired by `install.mjs` (HYK-95)

Before HYK-95, three check scripts were meant to run as Claude Code hooks
but `install.mjs` never touched `.claude/settings.local.json` to wire
them — a human had to hand-copy a JSON snippet after every install. The
installer now generates or merges that file directly:

- `scripts/check/status-fresh.mjs` as a `Stop` hook (HYK-91).
- `scripts/check/clear-safe-check.mjs` as a second `Stop` hook command
  (HYK-96 Scope B) — soft, non-blocking (`exit 1`, never `exit 2`); it
  cannot be a hard gate even in principle, since Claude Code has no hook
  that fires *before* `/clear` clears context, only ones that fire after,
  in the new session, too late to capture anything.
- `scripts/check/context-inject.mjs` as a `SessionStart` hook (inject) and
  a `UserPromptSubmit` hook (block if the project context card is missing
  or unusable) (HYK-94).
- `scripts/check/role-guard.mjs` as the `PreToolUse` hook (HYK-86) — this
  one was already effectively "pre-wired" in spirit since a fresh install
  has no prior settings file to conflict with, but it is now included in
  the same generated block rather than left undocumented.

**STATUS/PROJECT-CONTEXT path, per profile:** `solo-full` points both hooks
at `<controlRoomPath>/STATUS.md` and `<controlRoomPath>/PROJECT-CONTEXT.md`
(forward-slash normalized, matching this repo's own live example);
`team-local` has no control room, so it points at its own
`$CLAUDE_PROJECT_DIR/.harness/STATUS.md` / `.../PROJECT-CONTEXT.md` — the
portable token needs no substitution, unlike the installer's other
placeholders.

**Merge rules, in order** (never regex/string surgery on existing JSON —
always parse, modify, and `JSON.stringify(obj, null, 2)`):

1. No `.claude/settings.local.json` yet → create it with just `{ "hooks":
   {...} }`.
2. File exists, no top-level `hooks` key (e.g. only `permissions`) →
   existing keys preserved, `hooks` added.
3. File exists and already has a `hooks` key → **not touched.**
   Auto-merging hook arrays risks silently misrouting a wiring the operator
   already set up on purpose. The installer skips, warns, and prints the
   generated hooks block as a snippet for a human to merge by hand.
4. File exists but isn't valid JSON → same as (3): not touched, warning +
   snippet fallback.

`--dry-run` never writes; it prints what it *would* create or merge (create
and merge-success paths also print the same snippet, so a preview is
possible without writing).

**Self-modification boundary, restated (why this is safe to automate now):**
elsewhere in this document, writing to `.claude/settings.local.json` is
treated as a human action, because *a currently running session*
self-modifying its own live settings mid-task is out of scope for an agent
to do to itself. `install.mjs` targets a **different, not-yet-started**
target repository, so that specific rationale for a human-only step does
not apply here — this is scaffolding a new project, not editing an active
session's own control surface. What is *still* a required human step
regardless: reviewing the generated file, restarting Claude Code once so
the new hooks actually load, and confirming they fire. **Never run this
installer against `HARNESSENGINEERING`'s own `.claude/` directory** — that
*is* self-modification of an active repo's live settings, exactly the case
the boundary exists to exclude.

**Git hooks, restated:** `<target>/.git/hooks/{commit-msg,pre-commit}` are
also now installed for real (not just the tracked `hooks/` copy) when
`<target>/.git` exists as a directory at install time — this remains
per-clone by git's own model (`.git/hooks/` is never tracked), so a repo
cloned later from the freshly-scaffolded one still needs its own install
(same as before HYK-95, just automated for the repo the installer runs
against directly).

All hook wiring is documented with exact `.claude/settings.local.json` JSON
snippets in `docs/enforcement-v1.md` ("STATUS freshness — Tier 2", "D6 —
project-context injection", "Scope B") for manual reference, even though
`install.mjs` now writes the equivalent block itself.

### Credential boundary (HYK-100)

**Why:** during the first real TEAM10 dogfood, a product-branch push was
attempted under the harness bot's identity (`codexlocal101-rgb`) instead of
the operator's own GitHub account, and was rejected only because the bot
lacked write access to that repo — a near-miss, not a caught bug. The root
cause: the machine has more than one `github.com` credential registered,
and which one git's credential machinery hands over for a given push is not
deterministic on its own. The manual fix applied at the time was
`git config --local credential.helper "!gh auth git-credential"`, which
pins *this one clone* to authenticate as whatever account `gh` is currently
logged in as, sidestepping the ambiguity entirely. `install.mjs` now
mechanizes that fix for `team-local`.

**`team-local` — set automatically, with two "don't touch it" fallbacks and
one "can't safely do it" fallback:**

1. `<target>/.git` doesn't exist yet → skip + warn (manual setup once it's a
   real repo), same convention as the `.git/hooks/` install above.
2. `origin`'s remote URL is SSH (`git@...` or `ssh://...`) → skip
   (informational, not a warning) — SSH pushes never consult a credential
   helper at all, so setting one would be inert.
3. `git config --local credential.helper` is already set to something →
   **not touched.** Same never-overwrite convention as every other file
   this installer writes; skip + warn + a snippet showing the command to
   run by hand if the existing value turns out to be wrong for this clone.
4. `gh` is not on `PATH` (checked via `gh --version`) → **not set.**
   Pinning to a helper that can't actually authenticate would break every
   push outright, which is worse than leaving the original ambiguity in
   place; skip + warn + a snippet to run once `gh` is installed and logged
   in as the intended account.
5. Otherwise → `git -C <target> config --local credential.helper "!gh auth
   git-credential"`, repo-local scope only (never touches global config).

Any unexpected error during this step (a transient git failure, etc.) is
caught and treated the same as case 3/4 — warn and continue, never abort
the rest of the install. This is a safety nicety layered on top of the
install, not a step the rest of the install depends on.

**`solo-full` — checklist item only, not automated.** `install.mjs` adds one
line to the GitHub setup checklist (`soloFullChecklist`) asking the human to
confirm the clone's push identity matches intent, instead of setting
anything. Reason for the asymmetry: `team-local`'s answer is always "pin to
whatever `gh` is logged in as" (the operator's own account, since a
team-local clone never pushes as the bot). `solo-full` has no single correct
answer — a bot-push flow (this repository's own model: branch → push as the
bot → PR → human merge) *legitimately wants* the bot's PAT, not the
operator's personal `gh` login, so automatically pinning either one could
just as easily be wrong as right. Which credential is correct there is a
human call this installer isn't positioned to make.

**Known limits (honesty notes):**

- **Not an anchor, a default.** `credential.helper` is itself a local git
  config value — an agent or operator can change or remove it just as
  easily as this installer set it. This closes an *accidental*
  cross-identity push (the ambiguity that caused the actual near-miss), not
  a deliberate one; it sits in the same local-trust-boundary family as
  every other check in this document.
- **Follows `gh`'s login, not a fixed account.** If someone runs
  `gh auth login` as a different account later in that same clone, pushes
  silently follow the new login — this pins "whichever account `gh`
  currently reports," not one specific identity for all time.
- **HTTP(S) remotes assumed; SSH is detected and skipped.** Credential
  helpers only apply to HTTP(S) git remotes. `install.mjs` checks `origin`'s
  URL scheme and skips (not warns) when it's SSH, rather than setting an
  inert value — a deliberate judgment call for this task, recorded here so
  a future reader knows it was checked, not overlooked.

### Git hooks and worktrees (HYK-101)

**Symptom (hit twice for real, on TEAM10 coder sessions):** `team-local`'s
`scripts/check/` is untracked (gitignored) by design — it's this account's
personal tooling, not shared team-repo state. A `git worktree add` checkout
only ever gets *tracked* files, so a linked worktree never has
`scripts/check/` at all. Before this fix, `hooks/commit-msg` unconditionally
built its script path from `git rev-parse --show-toplevel` (the *current*
worktree's own root), so every commit attempted from inside a worktree
crashed with `MODULE_NOT_FOUND` — not a review-gate rejection, a hard crash
that blocked the commit for a reason with nothing to do with commit-message
format. The workaround at the time was manually re-copying
`scripts/check/` into every new worktree, which is exactly the kind of
"only works if a human remembers" gap this harness exists to close.

**Resolution order, now built into `hooks/commit-msg`:**

1. Try `<current-worktree-root>/scripts/check/review-gate.mjs` (unchanged,
   original behavior — this is what a non-worktree clone, or a worktree
   that happens to have the file, already hits).
2. If that's missing, resolve `git rev-parse --git-common-dir` — this
   always points at the *shared* `.git` directory regardless of which
   worktree the hook is running in (relative `.git` from the main worktree
   itself, an absolute path from a linked one) — normalize it to absolute
   and strip the trailing `/.git` to recover the main clone's root, then
   retry the script path there.
3. If still missing (main clone doesn't have it installed either, or some
   other layout entirely), **fail open**: print a one-line warning
   naming this section and exit `0` rather than crashing. A missing check
   script is a setup gap, not a commit-message format violation, and this
   hook's job is to enforce format — it should not additionally require its
   own dependency to exist. This mirrors `hooks/pre-commit`'s existing
   fail-open posture when `gitleaks` itself isn't installed.

`hooks/pre-commit` was checked for the same class of bug and does **not**
need the equivalent fix: it resolves `gitleaks`/`gitleaks.exe` from `PATH`
(an installed binary, not a repo-relative file) and only uses
`$root` as `cd`'s target, which is a valid, fully-functional directory in a
linked worktree exactly as it is in the main one. This was confirmed by
inspection (`grep scripts/check hooks/pre-commit` finds nothing) and by a
live worktree commit through the unmodified hook, not left alone by
oversight.

**Nothing to change in `install.mjs`:** both hook files are copied from
this repository's live `hooks/` source at install time (`copyRawFile`, see
above) rather than from a frozen template copy — so this fix ships to every
future install automatically, with no installer-side change required.
Confirmed directly: `install.mjs`'s copy calls read
`path.join(REPO_ROOT, "hooks", "commit-msg")` verbatim.

**Known limit (honesty note):** the fail-open branch means a worktree
whose main clone is *also* missing `scripts/check/` will skip the
commit-message check silently rather than blocking — the commit goes
through with no review-gate enforcement at all. This was a deliberate
choice: a crash is strictly worse than a skipped local check, since the
authoritative gate for anything that matters is still `enforce.yml`
server-side (same "local hooks are fast feedback, CI is authoritative"
principle already documented for `hooks/pre-commit`'s gitleaks fallback).
It does mean a worktree can silently lose local review-gate enforcement in
a way that produces no visible failure — only the printed warning — so it
is worth actually reading hook output once after setting up a new
worktree, not something this fix makes airtight.

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
- `skill/capture-context/SKILL.md`: `/capture-context` capture-assist skill
  template, installed to `.claude/skills/capture-context/SKILL.md` in both
  profiles (HYK-96 Scope C)

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
