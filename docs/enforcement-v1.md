# Enforcement v1

## Purpose

HYK-80 found that the harness had conventions but no enforcement: every rule
assumed a disciplined agent would follow it, so a forgetful agent or an
ambiguous human trigger could break the process without anything catching it.
This document records the enforcement design and the first real
implementation (D2, delivered under HYK-81).

## Substrate decision

Enforcement checks run as **local git hooks backed by plain Node scripts
under `scripts/check/`**, not as agent-followed conventions and not as a
hosted CI service.

Reasons:

- **Outside agent control by design.** A hook fires on the git operation
  itself (e.g. `commit-msg`), so it runs whether or not the agent that made
  the commit remembered the rule. This mirrors the loop profile's
  `scripts/verify.sh` (HYK-72), which already proved that a small local
  script the agent cannot silently skip is enough to make a check real.
- **No new infra.** A solo operator with a local git repo already has hooks
  and Node available; no CI service, server, or account is required.
- **D4 is the one exception.** Comparing `STATUS.md` against Linear needs a
  network call, so that check runs as an orchestrator-invoked script rather
  than a pure local hook (see the table below).

## Defect-by-defect enforcement table

Source: HYK-80 design comment (2026-07-03, human-approved).

| Defect | Problem | Enforcement mechanism | Status |
| --- | --- | --- | --- |
| D1 | Boot reads state but not procedure, so a post-`/clear` session re-derives (and misremembers) the rules. | Boot-line pointer to `docs/claude-orchestrator-handoff.md` in the prompt template, `harness-init.md`, and `phase-handoff.template.md`. | Done (HYK-79) |
| D2 | Orchestrator can skip the contract's required independent review and self-certify. | `commit-msg` git hook (`hooks/commit-msg` → `scripts/check/review-gate.mjs`): an issue-tagged commit is blocked unless `.harness/review.md` carries matching `for: <id>` + `verdict: approved` + an independent-reviewer `role: REVIEW-*` marker, or the message carries an audited `skip-review: <reason>` trailer line. | Implemented this issue (v2, HYK-81), see below |
| D3 | Relay has no task identity or acknowledgment, so a stale `<role>-task.md` can run under an ambiguous "go". | `<role>-task.md` carries `task_id:` + `dropped_at:` headers; `<role>.md` must echo the same `task_id:` and end with `>>> DONE: ... @ <time KST>`; `scripts/check/relay-handshake.mjs` diffs the two and rejects a mismatched id or a DONE timestamp that predates the drop. | Implemented this issue (HYK-82), see below |
| D4 | `STATUS.md` drifts from the real Linear issue state and poisons the next boot. | Script diffs Linear against `STATUS.md`; run at boot and at commit time (needs network access, so it is orchestrator-invoked rather than a local-only hook). | Design only in this issue |
| D5 | The Task Contract can silently contradict a governing document (e.g. role split in `multi-agent-v1.md`). | Contract-vs-governing-document contradiction flag, to be promoted from a checklist item to a lint check. | Design only in this issue |

D1 is already live. D2 (HYK-81) and D3 (HYK-82) are real implementations. D4
and D5 are recorded here as committed enforcement design, not yet built.

## D2 review gate — detailed spec

### Rule

Given a commit message and a review-evidence file:

1. If the message carries no `HYK-<digits>` tag, the commit is not issue work
   and passes unconditionally.
2. Else, if the commit message's trailer block — the last paragraph, after
   stripping any code fences (` ``` `) — contains a line whose first
   non-whitespace text is `skip-review: <reason>` (case-insensitive) with a
   non-empty `<reason>`, the commit passes — this is an audited escape hatch,
   not a silent bypass (the reason stays in git history for later audit). An
   empty reason (`skip-review: ` with nothing after it) is rejected. A
   `skip-review:` line that sits outside the trailer block (an earlier
   paragraph followed by more prose), or that appears only inside a code
   fence (for example, in a commit that documents this very rule), is not
   recognized as a skip directive at all — it falls through to the
   review-evidence check in step 3.
3. Else, the review-evidence file (default `.harness/review.md`, resolved
   from the repository root) must exist and satisfy all three of (v2,
   HYK-81):
   - a `for: <id>` line matching the message's issue id;
   - an approval verdict line `verdict: approved`. A bare `ready_for_review`
     declaration **no longer counts on its own** — that string is what a
     role writes about its *own* work (e.g. Coder's `coder.md`), so accepting
     it let a role self-certify;
   - an independent-reviewer marker `role: REVIEW...` (case-insensitive,
     e.g. `role: REVIEW-CODEX`). Without it, an approval with no reviewer
     identity, or an approval attributed to a non-`REVIEW-*` role (such as
     the Orchestrator approving its own work), is treated as
     self-certification and blocked.

   All three must hold for the commit to pass. Otherwise it is blocked, and
   the reason names which piece is missing (`for:`, `verdict: approved`, or
   the independent-reviewer marker) so a blocked commit's stderr says exactly
   what evidence is absent.

### Known limitation (v2, honesty note)

The hook only pattern-matches the literal `role:` string inside
`.harness/review.md`; it has no cryptographic or process-level way to verify
that the named reviewer was actually an independent process. Whoever writes
`review.md` (a careless agent, or an operator with shell access) can still
type `role: REVIEW-CODEX` by hand without a real independent review having
happened. This is the same class of unresolved gap as "the hook runs locally
and can be bypassed by anyone with shell access to `.git/hooks`" — v2 raises
the cost of self-certification (a reviewer marker must be deliberately
fabricated, which is a stronger tell than a bare `verdict: approved`) without
making it cryptographically impossible. Closing that gap needs a signed or
CI-anchored review record, which is out of scope for this local-hook
substrate and is left for a future revision.

### Implementation

- `scripts/check/review-gate.mjs` exports the pure function
  `checkReviewGate({ message, reviewPath }) -> { ok, reason }` implementing
  the rule above, plus a CLI entry point: `node review-gate.mjs
  <commit-msg-file>` exits `0` when `ok` and exits `1` with `reason` on
  stderr otherwise. When `reviewPath` is not supplied, the default resolves
  to `.harness/review.md` under the **repository root** (`git rev-parse
  --show-toplevel`, falling back to `process.cwd()` outside a git repo), not
  the process's current working directory — this keeps the check correct
  regardless of where the calling hook happens to run from. The evidence
  check (rule step 3) tests `for:`, `verdict: approved`, and the
  independent-reviewer `role: REVIEW...` marker as three separate gates, each
  returning its own `reason` string when it fails.
- `scripts/check/review-gate.test.mjs` is a fixture-based test suite (node's
  built-in test runner), currently 16 cases, covering: no HYK tag; a tagged
  commit with no review evidence; a tagged commit with full independent
  review evidence (`for:` + `verdict: approved` + `role: REVIEW-*`); the
  skip-review trailer with a reason and with an empty reason; a
  `skip-review` mention inside inline brackets, mid-message (outside the
  trailer paragraph), or inside a code fence — each confirmed to fall
  through to the evidence check rather than being treated as a skip
  directive; a HYK tag present only in body prose (not the subject line);
  and the three self-certification cases that must still be blocked —
  approved with no reviewer marker, approved with a non-`REVIEW-*` role, and
  a bare `ready_for_review` with no `verdict: approved`. Fixtures live under
  a temp directory created per test; no real repository state is touched.
- `hooks/commit-msg` is a thin wrapper (`#!/usr/bin/env sh`) that resolves
  the repository root itself before calling the script:

  ```sh
  #!/usr/bin/env sh
  root=$(git rev-parse --show-toplevel) || exit 1
  script="$root/scripts/check/review-gate.mjs"
  msg="$1"
  if command -v node >/dev/null 2>&1; then
    NODE=node
  elif command -v node.exe >/dev/null 2>&1; then
    NODE=node.exe
    # node.exe is a Windows binary. Under WSL the paths above are POSIX
    # (/mnt/c/...) which Windows node reads as C:\mnt\c\... and fails to
    # resolve. Translate the paths we hand it back into Windows form.
    if command -v wslpath >/dev/null 2>&1; then
      script=$(wslpath -w "$script")
      [ -n "$msg" ] && msg=$(wslpath -w "$msg")
    fi
  else
    echo "commit-msg hook: node runtime not found (need 'node' or 'node.exe' on PATH)" >&2
    exit 1
  fi
  exec "$NODE" "$script" "$msg"
  ```

  Resolving `$root` via `git rev-parse --show-toplevel` (rather than
  `dirname "$0"`) matters because the wrapper is copied or symlinked into
  `.git/hooks/` to be installed (see below). A `dirname "$0"`-relative path
  breaks once the script runs from `.git/hooks/commit-msg`, since
  `../scripts/check` then resolves under `.git/scripts`, not the repository's
  real `scripts/check`. `git rev-parse --show-toplevel` returns the real
  repository root regardless of which path git invoked the hook from, so the
  wrapper keeps working after installation. The wrapper is version-controlled
  in the repository; git only runs hooks from `.git/hooks/`, which is never
  checked in.

  The wrapper does not call `node` directly — a plain `node "$root/..."` call
  failed with exit 127 ("node: not found") under WSL-native bash, where PATH
  carries no Linux `node` binary, only Windows' `node.exe`. Instead the hook
  probes for a runner in order: `node` first, then `node.exe`. If neither is
  on `PATH`, the hook fails loudly with an explicit
  `node runtime not found (need 'node' or 'node.exe' on PATH)` message on
  stderr and exit `1`, instead of a silent/confusing 127.

  Finding `node.exe` is necessary but not sufficient under WSL. `git rev-parse
  --show-toplevel` there returns a POSIX path (`/mnt/c/...`), and handing that
  to Windows' `node.exe` fails: Windows node reads `/mnt/c/...` as
  `C:\mnt\c\...` and throws `MODULE_NOT_FOUND` for the script — so even a
  no-tag commit that should pass would fail with exit `1` for the wrong
  reason. When the chosen runner is `node.exe` and `wslpath` is available
  (i.e. we are under WSL), the hook therefore translates both the script path
  and the commit-message-file argument (`$1`) to Windows form via
  `wslpath -w` before invoking node. `wslpath -w` resolves relative arguments
  (git normally passes `.git/COMMIT_EDITMSG`) against the current directory,
  so both absolute and relative message paths work. In Git-for-Windows sh the
  `node` branch is taken and `wslpath` is absent, so no translation happens
  and paths are already Windows-native — the wrapper works unchanged there.
  The final call uses `exec` so the hook's own exit code is exactly
  `review-gate.mjs`'s exit code, not a wrapper-introduced pass-through.

  This was verified directly in WSL-native bash (Ubuntu, WSL2): `node` absent,
  `node.exe` resolved from `/mnt/c/Program Files/nodejs/`; a no-tag message
  exits `0`; an HYK-tagged message with no evidence reaches review-gate's own
  missing-evidence rejection (exit `1`) rather than `MODULE_NOT_FOUND`; and
  removing both runners from `PATH` produces the explicit not-found error.

### Installing the hook

Git does not read hooks from a version-controlled path automatically. Install
by copying or symlinking the versioned file into `.git/hooks/`:

```sh
# copy (simplest, needs re-copying after hook changes)
cp hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg

# or symlink (stays in sync with the versioned file automatically)
ln -sf ../../hooks/commit-msg .git/hooks/commit-msg
```

This installation step is manual and per-clone, matching git's own hook
model; it is not run automatically by any script in this repository. Because
the wrapper resolves `$root` at run time instead of assuming its own file
location, both the copy and the symlink install methods work correctly.

If you installed the hook via `cp` before the node-runner-search change
above landed, `.git/hooks/commit-msg` is a stale copy and must be
re-copied (`cp hooks/commit-msg .git/hooks/commit-msg`) to pick up the
`node`/`node.exe` fallback; a symlink install picks up the change
automatically since it never copies the file's contents.

## D3 relay handshake — detailed spec

### Problem restated

Relay v2 uses a single `<role>-task.md` slot plus an ambiguous human "go".
The original bug: the Orchestrator overwrites the slot with a new task, but a
stale "go" already in flight runs the *old* task — nothing mechanically
checks "which task is this go for" or "did the worker actually pick up the
task the Orchestrator intended." Until now, only the Orchestrator's own eyes
compared `task_id:`/`for:` by convention, which is exactly the kind of
convention-only gap this document exists to close.

### Rule

Given a `role` (e.g. `coder`) and a harness directory (default
`.harness/` under the repository root):

1. `taskPath = <harnessDir>/<role>-task.md`, `resultPath = <harnessDir>/<role>.md`.
2. If `taskPath` does not exist, blocked: `task file not found: <path>`.
3. If `resultPath` does not exist, blocked: `result file not found (worker not done?): <path>`.
4. Extract `task_id:` from the task file (`/^task_id:\s*(\S+)/im`). Missing → blocked: `task file missing task_id header`.
5. Extract the echoed `task_id:` from the result file (same pattern). Missing → blocked: `result missing task_id echo (need a` `task_id: <id>` `line)`.
6. If the two ids differ, blocked: `handshake mismatch: task dropped '<taskId>' but result echoes '<resultId>' (stale or wrong task)`.
7. Staleness is **fail-closed**: timing evidence is required, not optional.
   - If the task file has no `dropped_at:` header, blocked: `task file missing dropped_at header (required for staleness check)`.
   - If `dropped_at:` does not parse as a KST timestamp (`YYYY-MM-DD HH:MM KST`), blocked: `task dropped_at not parseable: '<raw>' (need YYYY-MM-DD HH:MM KST)`.
   - If the result file has no `>>> DONE: ... @ <time>` line, blocked: `result missing ">>> DONE: ... @ <time KST>" line (required)`.
   - If that DONE timestamp does not parse, blocked: `result DONE timestamp not parseable: '<raw>'`.
   - If both parse and the DONE time is earlier than the drop time, blocked: `stale result: DONE (<doneAt>) predates task drop (<droppedAt>)`.
   Missing or unparseable timing evidence is a rejection, not a skip — a
   revision of this rule briefly let missing/unparseable timestamps skip the
   staleness check and pass on id match alone; that was fail-*open* (a stale
   same-id result with no or garbled timing evidence slipped through) and has
   been replaced by the fail-closed version above.
8. Otherwise, ok: `relay handshake ok for <taskId>`.

### Known limitation (honesty note)

Unlike the D2 review gate, this check is **not a git hook** — nothing forces
it to run. It is a script the Orchestrator (an agent) is expected to invoke
itself (`node scripts/check/relay-handshake.mjs <role>`) before trusting a
worker's result. If the Orchestrator forgets, or an agent decides the check
is inconvenient, it simply doesn't run. This is weaker than D2, which fires
on every commit regardless of agent cooperation. It sits in the same
unresolved-limitation family as D2's "`role:` string can be typed by hand
without a real review" — here, an agent could likewise skip running the
check, or hand-edit `task_id:`/`dropped_at:`/`>>> DONE: ... @` values to make
a stale result look fresh. Making this actually unbypassable would need an
external process or daemon that watches the relay files independently of the
Orchestrator's own goodwill — left for a future revision.

### Implementation

- `scripts/check/relay-handshake.mjs` follows `review-gate.mjs`'s shape:
  ESM, a `repoRoot()` helper (`git rev-parse --show-toplevel`, falling back
  to `process.cwd()`), a pure exported function
  `checkRelayHandshake({ role, harnessDir }) -> { ok, reason }`, and a direct
  CLI block. `harnessDir` defaults to `.harness` under the repository root
  (same root-resolution rationale as D2's `reviewPath`).
  `node relay-handshake.mjs <role> [harnessDir]` exits `0` when `ok` and
  exits `1` with `reason` on stderr otherwise.
- `parseKstTimestamp(str)` strips a trailing ` KST`, requires the remainder
  to match `YYYY-MM-DD HH:MM` (space or `T` separator), and constructs a
  `Date` with an explicit `+09:00` offset; anything that doesn't match that
  shape returns `null` rather than throwing (it never crashes the caller).
  The caller is what changed in this revision: `null` from either timestamp
  now means "reject", not "skip the check" — see Rule step 7.
- `scripts/check/relay-handshake.test.mjs` is a fixture-based test suite
  (node's built-in test runner, `withFixtureDir` pattern from
  `review-gate.test.mjs`), 11 cases: id match with DONE after the drop
  (passes); id mismatch; missing task_id echo; missing task_id header;
  missing result file; missing task file; a DONE timestamp that predates
  `dropped_at` (stale, blocked); and the four fail-closed timing-evidence
  cases — a matching id with no DONE line at all, a task with no
  `dropped_at:` header, an unparseable `dropped_at:`, and an unparseable DONE
  timestamp (all four blocked). Fixtures live under a temp directory per
  test; no real `.harness/` state is touched.

## Not over-engineered / solo-operable

This is one hook, one pure-function script, and one fixture test file — no
server, no CI account, no database, no scheduling system. The default
reviewPath and verdict format are plain text conventions an operator can
satisfy by hand: write `for: HYK-80`, `verdict: approved`, and `role:
REVIEW-CODEX` (or another `REVIEW-*` role) into `.harness/review.md` once an
independent review has actually happened, or add a `skip-review: <reason>`
trailer line at the end of the commit message when review genuinely does not
apply. Nothing here requires a second person to *operate* the mechanics, but
the `role: REVIEW-*` marker only means something if whoever writes it is
telling the truth about a review having happened — see "Known limitation"
above. What this design actually guarantees is narrower: skipping review, or
self-certifying without an independent-reviewer marker, leaves a visible,
audited trace instead of silently vanishing, which is the actual gap HYK-80
identified.

## D-CI external anchor — server-side enforcement (HYK-87 / B1)

Everything above (D2 commit-msg gate, D3 handshake) runs *locally* and depends
on agent cooperation — an agent can `--no-verify`, edit the hook, or skip the
handshake. The external anchor moves the authority off the agent's machine:

- **`.github/workflows/enforce.yml`** re-runs `review-gate.test.mjs`,
  `relay-handshake.test.mjs`, and `sh -n hooks/commit-msg` on every pull
  request and push to `master` (GitHub-hosted runner). The agent cannot skip
  or fake this.
- **`master` branch protection** requires a pull request, the `enforce` status
  check passing, and (B1) at least one approving review, with `enforce_admins`
  on so even repo admins go through it. Direct pushes to `master` are rejected
  (`GH006 ... Changes must be made through a pull request`).
- **Identity separation (B1):** the acting agent operates as a **Write-only**
  bot collaborator, so it cannot disable branch protection; the independent
  approval comes from the repo owner (a human, outside the agent). This closes
  the "agent holds an admin token and could just turn the protection off" gap.

Landing anything on `master` is therefore: `branch → push (as the bot) → open
PR → enforce CI green → human approval → merge`. Local hooks remain as fast
feedback, but authority now lives server-side.

Residual: fully removing the human from the loop would need a separate
automated reviewer identity the acting agent does not control — deferred.

## D — role-boundary guard (role-guard PreToolUse hook, HYK-86)

### Problem restated

In a prior session the Orchestrator misread "코더 됐어" (worker acknowledgment)
as a cue to activate the CODER role itself, and directly edited source and
overwrote `coder.md` — a role-boundary violation the harness had no
mechanical check for. HYK-86 had four branches; A (re-onboarding on resume),
B (answer format), and C (signal words) are handled by convention/docs
already. This section is **D: a local guard that mechanically blocks a
role's agent from writing files outside that role's lane**, catching the same
mistake in the moment instead of relying on the agent remembering.

Honesty note up front: this is a **PreToolUse hook in the same execution
environment as the agent it's guarding**. It stops accidental/confused
writes; it is not airtight against an adversarial agent that edits or removes
the hook config itself — that requires the external anchors already in
place, the CI checks in `enforce.yml` (HYK-87/88) and (later) an isolated
runner (HYK-89). This guard and the CI anchors are defense-in-depth, not
substitutes for each other.

### Rule

Given a `role` (from the `HARNESS_ROLE` environment variable) and a file
path a write-family tool is about to touch, resolved relative to the repo
root — paths outside the repo root are never regulated (e.g. the control
room under `D:\...` stays freely editable by ORCH):

| Role | Allowed to write (inside repo root) | Everything else |
| --- | --- | --- |
| `ORCH` | `.harness/<anything>-task.md` (dropping a task) | denied |
| `CODER` | anything, **except** `.harness/review.md`, `.harness/verify.md`, `.harness/*-task.md` | denied |
| `REVIEW` | `.harness/review.md` only | denied |
| `VERIFY` | `.harness/verify.md` only | denied |
| unset / unrecognized | everything (unrestricted) | — but a warning is emitted so a silently-inactive guard is visible |

### Implementation

- `scripts/check/role-guard.mjs` follows the same shape as
  `review-gate.mjs`/`relay-handshake.mjs`: a pure exported function
  `checkRoleWrite({ role, filePath, repoRoot }) -> { ok, reason, warn? }`
  plus a CLI entry point. Path normalization
  (`normalizeToRepoRelative`) lower-cases nothing but converts backslashes to
  forward slashes and matches drive-letter or POSIX absolute forms, so a
  Windows-style, WSL-style, or already-relative path all compare correctly
  against the repo root; anything that doesn't resolve under the repo root is
  reported as `insideRepo: false` and the write is unconditionally allowed.
- The CLI block implements the **Claude Code PreToolUse hook contract**: it
  reads the hook's JSON payload from stdin (`tool_name`,
  `tool_input.file_path` for `Edit`/`Write`/`MultiEdit`,
  `tool_input.notebook_path` for `NotebookEdit`), passes through
  unconditionally (`exit 0`) for any other tool name or a missing/malformed
  payload, and otherwise calls `checkRoleWrite` with `HARNESS_ROLE` and the
  repo root (`git rev-parse --show-toplevel`, same helper as the other two
  checks). The contract chosen is the **exit-code form**: `exit 0` to allow,
  `exit 2` with the reason on stderr to block — this is fed back to the
  calling agent as the reason it was stopped, mirroring how `commit-msg`
  already reports a D2 rejection. A warning branch (unset/unrecognized role)
  still exits `0` but prints the warning to stderr, so a mis-set
  `HARNESS_ROLE` is visible instead of silently disabling the guard.
- `scripts/check/role-guard.test.mjs` is a fixture-free, pure-function test
  suite (node's built-in test runner), 28 cases covering the full role ×
  path-type matrix: each role against a source file, its own result file,
  another role's result file, and a task file; an unset role and an
  unrecognized role string (both allow-with-warning); a repo-external path
  for ORCH (control room); backslash-path normalization; an absolute in-repo
  path resolving the same as its relative form; an absolute path on a
  different drive letter being treated as outside the repo; and (round 2,
  below) `.`/`..` traversal and WSL/Git-Bash path-scheme bypasses.

**Round 2 fix (independent review caught two bypasses):** the first cut of
`normalizeToRepoRelative` compared paths as strings without resolving `.`/`..`
segments or reconciling path schemes, so `.harness/foo/../review.md` matched
neither the literal `.harness/review.md` deny-rule nor got blocked, and a
WSL-style `/mnt/c/...` path was misjudged as outside a `C:/...`-form repo
root — both let a regulated write through. The fix normalizes drive schemes
first (`toDriveStyle`: `/mnt/<drive>/...` and `/<drive>/...` → `<DRIVE>:/...`)
and then resolves `.`/`..` via `node:path`'s `posix.normalize` before the
repo-relative comparison, so matching happens on the fully-resolved path, not
the literal string the tool reported.

### Local installation (not version-controlled)

Unlike `hooks/commit-msg`, this hook is wired through Claude Code's own
settings, not git. `.claude/settings.local.json` is untracked (like
`.harness/`), so the connection is per-clone/per-operator; only the script
itself is version-controlled. Register it under `hooks.PreToolUse`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/scripts/check/role-guard.mjs"
          }
        ]
      }
    ]
  }
}
```

And before starting a role's terminal/session, export the role it is acting
as, e.g. `export HARNESS_ROLE=CODER` (or `ORCH`, `REVIEW`, `VERIFY`) — the
guard reads this once per invocation from the environment, so it must be set
in the shell the agent's tool calls actually run in.

### Known limitation (honesty note)

Same environment, same trust boundary as the agent it watches: an agent that
edits `.claude/settings.local.json` to remove the hook, or unsets/rewrites
`HARNESS_ROLE`, defeats this guard entirely, and nothing here detects that
tampering. It is a guardrail against a confused or careless agent repeating
this session's mistake, not a barrier against an adversarial one. The
CI-anchored checks in `enforce.yml` (HYK-87/88, server-side, outside agent
control) and a future isolated runner (HYK-89) are what make the harness's
founding claim — verification outside agent control — actually true; this
guard narrows the window in which the D2/D3 kind of mistake can happen
locally, in the moment, before it ever reaches a commit.

## Secret scanning ② — gitleaks CI + engine-agnostic git hook (HYK-90)

### Relationship to ① (GitHub secret scanning / push protection)

This repo already has GitHub's native **Secret Scanning + Push Protection**
(①) live on the public repo — free, and it blocks a push containing a
recognized *provider* credential pattern (AWS, Stripe, GitHub tokens, and
similar well-known shapes) before it ever lands. Its gap: **generic
high-entropy secrets, custom formats, and full-history/PR-diff scanning with
a configurable ruleset are GitHub Advanced Security features**, which are not
enabled here (paid). ② closes that gap for free with
[gitleaks](https://github.com/gitleaks/gitleaks), applied at two points:

- **CI (`enforce` job, server-side, authoritative):** every `push` to
  `master` and every `pull_request` is scanned; a finding fails the job and
  blocks the merge (branch protection already requires `enforce` green).
- **`hooks/pre-commit` (local, git-native, fast feedback):** every `git
  commit`, by anyone or anything invoking git directly — Claude via a shell
  tool call, Codex, or a human at the terminal — runs through this hook
  first, unlike Claude Code's own `PreToolUse` hooks (see the role-guard
  section above), which only ever see Claude's own tool calls and are blind
  to Codex or a manual `git commit`. This is the concrete "Codex coverage"
  gap ② closes that a Claude-only mechanism structurally cannot.

### Pin and provenance

CI installs a specific, checksum-verified gitleaks release rather than a
floating tag or a third-party Action, per an explicit human decision (Option
A over Option B, `gitleaks/gitleaks-action`, recorded against HYK-90 — the
choice to add *any* externally-sourced binary that executes in CI is a
supply-chain decision this harness treats as requiring a human sign-off
naming the specific dependency, not something an agent decides unilaterally
mid-task):

```yaml
env:
  GITLEAKS_VERSION: "8.30.1"
  GITLEAKS_SHA256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"

# ...
      - name: Install gitleaks (pinned, checksum-verified)
        run: |
          set -e
          curl -sSL -o gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
          echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum -c -
          tar -xzf gitleaks.tar.gz gitleaks
          chmod +x gitleaks
          sudo mv gitleaks /usr/local/bin/gitleaks

      - name: gitleaks secret scan
        run: gitleaks detect --source . --redact
```

The `GITLEAKS_SHA256` value is the official checksum published in gitleaks'
own `gitleaks_8.30.1_checksums.txt` release asset; `sha256sum -c` fails the
step (and the job) if the downloaded archive doesn't match byte-for-byte,
so a compromised or substituted download is caught before extraction. The
checkout step also sets `fetch-depth: 0` so `gitleaks detect` (which, run
inside a real git repository, scans the full accessible commit history, not
just the working tree) has that history available in CI, not just the single
shallow commit `actions/checkout` fetches by default.

### `.gitleaks.toml` — ruleset and allowlist policy

```toml
[extend]
useDefault = true
```

extends (does not replace) gitleaks' own default ruleset — every pattern
listed [here](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml)
(AWS/GCP/Stripe/GitHub/generic-api-key/private-key-block/etc., each with its
own entropy threshold) applies unmodified. Two narrow allowlist entries exist
on top of that, each scoped to one exact file *and* one exact literal
substring (never a directory or blanket path exemption):

| File | Exempted literal | Why it's not a secret |
| --- | --- | --- |
| `scripts/check/review-gate.test.mjs` | `[skip-review: ...] token` | Test fixture prose describing the skip-review trailer format, not a credential |
| `templates/harness-init/phase-handoff.template.md` | `(save tokens)` | Refers to LLM context-window tokens, not a credential |

Both were added preemptively per the source task's own examples, not because
a real gitleaks run flagged them — verified directly: running gitleaks
against this repo's full history with *only* `useDefault = true` (no
allowlist at all) already comes back clean (`no leaks found`), because
neither string is quoted-and-assignment-shaped the way gitleaks' `generic-api-key`
rule requires (a `key/token/secret/password`-adjacent word alone, with no
attached random-looking value, doesn't match). The allowlist entries are a
defensive margin against a future gitleaks ruleset update tightening that
rule, not a fix for an observed false positive.

### `hooks/pre-commit` — engine-agnostic local scan

```sh
#!/usr/bin/env sh
root=$(git rev-parse --show-toplevel) || exit 1

if command -v gitleaks >/dev/null 2>&1; then
  GITLEAKS=gitleaks
elif command -v gitleaks.exe >/dev/null 2>&1; then
  GITLEAKS=gitleaks.exe
else
  echo "pre-commit hook: gitleaks not found on PATH ('gitleaks' or 'gitleaks.exe') -- skipping local secret scan for this commit." >&2
  echo "This is fail-open by design: local scanning is fast feedback only. CI (.github/workflows/enforce.yml) runs the authoritative gitleaks scan on every push/PR and will still block a real leak even if it slips past this local hook." >&2
  echo "Install gitleaks for local feedback: https://github.com/gitleaks/gitleaks#installing" >&2
  exit 0
fi

cd "$root" || exit 1
exec "$GITLEAKS" protect --staged --redact
```

Design notes, mirroring `hooks/commit-msg`'s runner-search lesson from
HYK-83: probe `gitleaks` then `gitleaks.exe` (Windows binary reachable from
WSL/Git-Bash) in that order; if neither is found, **fail open** — print a
three-line stderr explanation and `exit 0` rather than blocking every commit
on every machine that hasn't installed gitleaks yet. This is a deliberate
asymmetry with `hooks/commit-msg`'s D2 gate, which fails *closed* (blocks)
when its own dependency (the review-evidence file) is missing: D2's evidence
file is something this harness's own workflow produces, so its absence is
itself meaningful, while a missing *third-party scanner binary* just means
"not installed yet," and CI is the authority regardless. When gitleaks is
found, `gitleaks protect --staged --redact` scans exactly the staged diff (not
the whole tree or history — that's what `detect` does, reserved for CI), and
`exec` passes its exit code straight through: `0` clean, non-zero blocks the
commit with the finding printed (redacted) to the terminal.

### Installing the hook (per-clone, same pattern as `commit-msg`)

```sh
cp hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
# or: ln -sf ../../hooks/pre-commit .git/hooks/pre-commit
```

Git does not read hooks from a version-controlled path automatically (same
caveat as `commit-msg`); this is a manual, per-clone install step.

### Known limitation (honesty note)

The local hook is explicitly **fail-open** on a missing scanner and, like
every other local hook in this document, runs in the same environment as the
agent it watches — an agent (or human) with shell access can edit or delete
`.git/hooks/pre-commit`, or simply `git commit --no-verify`, and nothing
locally stops that. **CI is the actual authority**: `enforce.yml`'s gitleaks
step runs server-side regardless of what happened locally, and branch
protection means a finding there blocks the merge no matter how the commit
was made. This mirrors ①'s own model (push protection is server-side) and
the D-CI external anchor section above — the local hook exists purely for
fast feedback, not as the security boundary.

**Codex vs. Claude coverage, restated:** the `role-guard` PreToolUse hook
above only fires on Claude Code's own tool calls (`Edit`/`Write`/`MultiEdit`/
`NotebookEdit`) and has no visibility into Codex or a manual terminal
`git commit`. `hooks/pre-commit`, being a native git hook, fires on *any*
`git commit` regardless of what produced it — this is what makes ② the
Codex-covering half of the two mechanisms, where role-guard is a
Claude-specific guardrail.

## STATUS freshness — Tier 2 (status-fresh.mjs + Stop hook, HYK-91)

### Relationship to Tier 1

The human-facing status board (`STATUS.md`) has, until now, been kept
current purely by convention (Tier 1): every role is *supposed* to update
its row when it finishes, but nothing checked that it actually happened. A
skipped self-report leaves the board pointing at stale state, which then
poisons whatever reads it next — the human, or a fresh Orchestrator session
after a `/clear`. Tier 2 promotes that convention to a mechanical check:
`scripts/check/status-fresh.mjs` answers "has real work happened since
`STATUS.md` was last touched?" and a non-zero exit is meant to be wired to
Claude Code's `Stop` hook so a turn cannot end silently on a stale board.

### Design: mtime, not the human-readable timestamp string

The board's `**Updated: <YYYY-MM-DD HH:MM KST>**` line is for humans to
read, not for this check to parse. Freshness is judged by comparing file
**mtimes** instead:

- `statusMtime` — the mtime of `STATUS.md` itself.
- `newestWork` — the newest of: every `.harness/*.md` relay file except
  `STATUS.md` and `PHASE-HANDOFF.md` (task/result files — `*-task.md`,
  `coder.md`, `review.md`, `verify.md`, and similar), and the current
  `HEAD` commit's timestamp (`git log -1 --format=%cI`).
- If `newestWork` is later than `statusMtime` by more than a grace window,
  the board is stale: exit `1` with a reason naming which file (or `HEAD
  commit`) is newer and by how much.

This was a deliberate choice over parsing the human-typed timestamp
string, for two reasons: parsing a hand-typed `YYYY-MM-DD HH:MM KST` string
inherits every format-drift risk `relay-handshake.mjs`'s `parseKstTimestamp`
already has to guard against (D3's known limitation), and — the more
important reason — mtime comparison is **purely relative ordering**, so it
never depends on the local clock's absolute accuracy. An earlier revision of
this harness worried the sandbox clock ran ~9h behind real time; a direct
comparison of PowerShell/Git-Bash/WSL/`git commit` timestamps on
2026-07-07 found all four agree with real KST, so that specific fear did not
reproduce — but the mtime design does not need that finding to hold. Even a
sandbox clock that *is* skewed relative to real time still orders two files
written by the same clock correctly relative to each other, which is all
this check needs.

### Grace window

A worker's normal, correct behavior — write its result file, then
self-report its own `STATUS.md` row in the same turn (see the status
template's rule 5) — produces two writes a few hundred milliseconds to a
few seconds apart, with `STATUS.md` written *second* and therefore normally
newer. A grace window absorbs that ordering plus coarse mtime resolution on
some filesystems (up to ~1s on FAT-family volumes) without either masking
real staleness or false-alarming on a normal self-report.
`DEFAULT_GRACE_MS = 5000` (5s): wide enough to cover both effects, narrow
enough that it cannot hide a board that is actually stale — real staleness
means minutes to indefinitely, not single-digit seconds.

### No false positive on Q&A / conversational turns

A turn that only answers a question — no file written under `.harness/`, no
new commit — leaves `newestWork` unchanged from whatever it already was.
Since `STATUS.md` was already at or ahead of that value from the previous
real update, the comparison stays fresh (`ok: true`) and the check does not
fire on turns that never touched durable state. `status-fresh.test.mjs`
covers this directly (test (e)) with a fixture where no file changes between
the initial "fresh" state and the re-check.

### Implementation

- `scripts/check/status-fresh.mjs` follows the same shape as
  `relay-handshake.mjs`/`role-guard.mjs`: a pure exported function
  `checkStatusFresh({ statusPath, harnessDir, graceMs, headTime }) -> {
  ok, reason }` plus a CLI entry point (`node status-fresh.mjs [--status
  <path>] [--harness-dir <path>]`, or the `HARNESS_STATUS_PATH` /
  `HARNESS_DIR` env vars). `headTime` is an explicit injection point — pass
  a `Date` or `null` to bypass the real `git log` call — which is what makes
  `status-fresh.test.mjs` able to exercise the HEAD-comparison branch
  without a real git repository in its fixtures.
- **Path override, required in this repository.** The default `statusPath`
  (`<repoRoot>/.harness/STATUS.md`) assumes the harness-init default layout
  where the board lives inside the target repo. HARNESSENGINEERING's own
  board lives *outside* the repo, at `D:\문서관리\하네스-관제실\STATUS.md`
  (see "Harness control room" in project memory) — so any live invocation
  here must pass `--status "D:\문서관리\하네스-관제실\STATUS.md"` (or set
  `HARNESS_STATUS_PATH`) explicitly; the default path resolves to a file
  that does not exist in this repo.
- `scripts/check/status-fresh.test.mjs` (`node:test`, 11 cases): STATUS
  already newest (fresh); a worker result file newer than STATUS (stale,
  reason names the file); a difference inside the grace window (fresh, not
  a false positive) and just past it (stale); `PHASE-HANDOFF.md` alone being
  newer (excluded, still fresh); the Q&A no-op turn (fresh); a missing
  STATUS file (blocked, not silently ok); `HEAD` newer than STATUS (stale,
  reason names `HEAD commit`); `HEAD` older with no work files (fresh); no
  work files and no HEAD time at all (vacuously fresh); and a `.harness`
  directory that does not exist yet (falls back to HEAD-only comparison).
  All fixtures use `fs.utimesSync` under a temp directory to control mtimes
  directly; no real `.harness/` or repository state is touched.
- `.github/workflows/enforce.yml` runs `status-fresh.test.mjs` alongside the
  other three check suites, as a **regression test only** — the live check
  itself is not a CI gate (see limitation below), so what CI guarantees is
  narrower: that the check's own logic keeps working, not that any given
  commit's `STATUS.md` was actually fresh.

### Known limitations (honesty notes)

- **Claude-only, same as role-guard.** The intended trigger is Claude
  Code's `Stop` hook, which — like the `PreToolUse` role-guard hook — only
  ever sees Claude's own turns. A Codex worker (REVIEW, VERIFY) finishing a
  turn triggers no equivalent check; the same Claude-vs-Codex coverage gap
  documented for role-guard applies here.
- **Not a CI gate.** Unlike D2's commit-msg hook, staleness is not
  something a server-side CI run can meaningfully judge after the fact —
  CI sees a single commit, not the live relay state at the moment a
  particular turn ended. Only the test suite is CI-anchored; the live
  freshness check itself only ever runs locally, on the agent's own
  goodwill to have the Stop hook wired up at all.
- **Stop hook installation is a human, one-time, per-clone step, done here
  only as documentation, not by this task.** Wiring `.claude/settings.local.json`
  is self-modification of the same settings file the role-guard hook lives
  in, which this harness treats as a human action, not something an agent
  does to its own operating constraints mid-task. Install by adding, to
  `.claude/settings.local.json`:

  ```json
  {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node /absolute/path/to/scripts/check/status-fresh.mjs --status \"D:\\문서관리\\하네스-관제실\\STATUS.md\""
            }
          ]
        }
      ]
    }
  }
  ```

  A non-zero exit from this command is what should cause Claude Code to
  surface the Stop hook's block/warning to the operator; the exact
  UX (hard block vs. warning) depends on how Claude Code's `Stop` hook
  contract handles a failing command, which is outside this document's
  scope to define.
- Same trust boundary as every other local check in this document: an
  agent or operator with shell access can remove the Stop hook wiring, or
  simply never install it, and nothing here detects that. This sits in the
  same family as role-guard's and D2/D3's own honesty notes above.

## D6 — project-context injection (context-inject.mjs + SessionStart/UserPromptSubmit hook, HYK-94)

### Relationship to D1

D1 ("boot reads state but not procedure") was closed for the *operating
procedure* by a boot-line pointer to
`docs/claude-orchestrator-handoff.md`. What it never covered is
*project-specific* context — the hard constraints unique to one target repo
(the running example throughout this harness: TEAM10, where committing
harness tooling to the shared team repo would be a real incident, not a
style violation). Until now that knowledge lived in two soft places: a
human pasting a boot line, or an agent choosing to read the control room
unprompted. Both depend on someone remembering, every single time,
including after every `/clear`. D6 moves the *hard constraints* subset of
that knowledge out of memory and into a file a hook reads mechanically.

### What gets injected

Exactly one section of one file: `.harness/PROJECT-CONTEXT.md`'s
`## HARD CONSTRAINTS` heading (exact title, case-insensitive), extracted up
to the next `##` heading or end of file. Everything else in that file
(freeform background prose) is for a human or agent to read manually — only
the constraints section is small and load-bearing enough to justify forcing
it into every session's context automatically.

### Two hooks, one job split each

- **`SessionStart`** (fires on `startup|resume|clear|compact`) — **inject
  only**. This hook type cannot block: even `exit 2` is ignored and the
  session proceeds regardless. So its contract here is unconditional:
  succeed by outputting the constraints as `additionalContext`, or — if the
  context file or its constraints section is missing — output a loud
  warning as `additionalContext` instead. Either way it exits `0`; a
  warning injected into context is the strongest signal this hook type can
  give.
- **`UserPromptSubmit`** (fires before every prompt, including the first
  one after `/clear`) — **gate only, does not re-inject**. If the context
  file exists *and its card is usable* (see "Scope A" below), it passes
  silently (`exit 0`, no output) — this hook does not repeat the injection
  on every turn, which would waste tokens for no benefit once
  `SessionStart` has already done it once per session. It blocks — `exit 2`
  plus a `{"decision":"block","reason":"..."}` JSON payload — under two
  *confirmed* conditions: the file is absent, or the file was read
  successfully and its card is confirmed unusable (empty or unedited
  placeholder). Anything less certain (a read error on a file that does
  exist, an unexpected exception) is **not** treated as confirmed-unusable
  and passes through instead (`exit 0`) — see "fail-open boundary" below.

**Enforcement strength, as decided:** "inject + block when the card is
absent or unusable" — not "inject + block on every turn," and not "warn
only." A project with no constraints card, or a stub card that was
installed but never actually filled in, is stopped cold at the first
prompt; a project with a real, filled-in card gets it injected once per
session start and is otherwise left alone.

### Scope A (HYK-96) — form gate: catching a stub card, not just a missing one

D6 as originally shipped only asked "does `PROJECT-CONTEXT.md` exist?" — a
freshly `install.mjs`-installed card technically exists but still carries
`project-context.template.md`'s own placeholder prose (e.g. the literal
token `<GITHUB_REPO>`) until someone actually edits it. That stub would pass
the original `UserPromptSubmit` gate and get treated as real content by
`SessionStart`, injecting placeholder junk instead of an actual hard
constraint — an unfilled card is functionally the same failure as no card
at all, and D6 v1 didn't catch it. Scope A closes that gap:

- `isUsableCard(contextText)` (in `context-inject.mjs`) composes
  `extractHardConstraints` with one more check: does the extracted body
  still contain an unresolved template token matching `/<[A-Z][A-Z0-9_]*>/`
  (this harness's placeholder convention across every template — status,
  phase-handoff, project-context)? A missing/empty section fails via
  `extractHardConstraints`'s existing reason; a present-but-unedited section
  fails with a `reason` naming the exact leftover token (e.g.
  `unresolved template placeholder <GITHUB_REPO> still present`).
- `UserPromptSubmit` now blocks on `isUsableCard(...).ok === false` in
  addition to file-absence, with the `reason` surfaced in the block payload
  so the person filling in the card knows exactly what's still a stub.
- `SessionStart` now checks the same `isUsableCard` gate before injecting:
  an unusable card produces the same warning-`additionalContext` path as a
  missing one (never injects placeholder text as if it were a real
  constraint), still `exit 0` (this hook type still cannot block).
- **Fail-open boundary, restated for Scope A:** blocking requires the file
  to have been read and its content *confirmed* unusable. A file that
  exists but can't be read (permission error, race condition) is treated as
  uncertain, not confirmed-unusable, and passes through — the same
  fail-open principle D6 v1 already applied to unexpected exceptions, now
  extended to the new content check rather than only the existence check.
- Scope B (a `/clear`-time re-orientation checkpoint) and C (a skill for
  authoring/maintaining the card) are **not** part of Scope A and remain
  open follow-up work. Scope D (splitting the card's freeform background
  from its enforced constraints section) is covered separately below.

### Scope D (HYK-96) — card structure: constraints vs. context

Putting a project's full background, goals, and evolving narrative into
`PROJECT-CONTEXT.md` alongside its hard constraints would make the
`SessionStart` injection payload grow without bound — every session start
would re-inject an ever-longer wall of text, diluting the signal the
injected constraints are supposed to carry. Scope D's fix needed no new
enforcement logic, only a structural convention plus tests that pin it
down:

- `project-context.template.md` now has **two headings**: `## HARD
  CONSTRAINTS` (short, imperative, non-negotiable — the only thing that
  gets injected) followed by `## 목표·의도·맥락` (Goals / Intent / Context —
  freeform, storage-only, never injected, as long as useful).
- This split costs nothing to enforce because `extractHardConstraints`
  (Scope A/D6) already stops at the *next* `##` heading — putting a second
  section after `HARD CONSTRAINTS` was already excluded from injection by
  the extraction logic that existed before this task. Scope D is a
  documentation-and-template change confirmed by test, not a new code path:
  `context-inject.mjs` was not modified for this scope (verified directly —
  see the HYK-96D coder report for the exact confirmation command and
  output).
- `context-inject.test.mjs` pins this down with a two-section fixture card:
  `extractHardConstraints` returns only the `HARD CONSTRAINTS` body (the
  Goals/Intent/Context text is absent from the result), the `SessionStart`
  CLI's `additionalContext` contains the constraints but not the
  goals/intent prose, and `UserPromptSubmit`'s pass/block gate is unaffected
  by the extra section (structure doesn't change gate behavior, only what
  gets carried into every session).
- Forward-looking intent, not built in this scope: a future `/clear`-time
  re-orientation step (Scope B) is expected to append deltas to `## 목표·
  의도·맥락` over time, making it the project's running memory rather than a
  one-time background paragraph written once at install time.

### Scope C (HYK-96) — `/capture-context` capture-assist skill

D6/Scope A close the *injection* half of the capture problem — a session
cannot proceed with a missing or stub `PROJECT-CONTEXT.md`. What they never
address is the *other* half: making a human or agent actually write the
card's content in the first place. Nothing mechanical enforces that a real
goal, intent, or hard constraint that came up mid-conversation ever makes it
into the file — that has always depended on someone remembering to go edit
it. Scope C does not close that gap (see "Honest limits" below — it
cannot be closed mechanically), it lowers the friction of doing it right:

- `.claude/skills/capture-context/SKILL.md` (this repository) and
  `templates/harness-init/skill/capture-context/SKILL.md` (the install
  template, `<PROFILE>`/`<REPO_PATH>`/`<CONTROL_ROOM_PATH>`/`<GITHUB_REPO>`
  parameterized) define a `/capture-context` skill: read the current card,
  scan the conversation for durable facts (as opposed to one-off,
  this-conversation-only details), propose a **delta** — not a full
  rewrite — split across the two Scope D sections, present it to the human
  for edit/approval, then write only the approved delta, and finally
  self-check the result.
- **Card-path resolution matches `context-inject.mjs` exactly.** The skill
  is prose, not code — it cannot import `resolveContextPath` — so it
  restates the same precedence as an explicit procedure: (a) the
  `--context <path>` argument baked into `.claude/settings.local.json`'s
  `SessionStart`/`UserPromptSubmit` hook command for `context-inject.mjs`;
  (b) the `HARNESS_CONTEXT_PATH` environment variable; (c) the default
  `<repo-root>/.harness/PROJECT-CONTEXT.md`. This matters concretely in this
  repository: the active card is the control-room path
  (`D:/문서관리/하네스-관제실/PROJECT-CONTEXT.md`, resolved via (a)), not
  `.harness/PROJECT-CONTEXT.md` under this repo, which does not exist here
  at all — a skill that assumed the repo-local default would silently edit
  or create the wrong file.
- **The skill exists to help pass Scope A's gate, not to bypass it.** Its
  self-check step is literally
  `node scripts/check/context-inject.mjs --mode user-prompt-submit --context <path>`
  exiting `0` — the same `isUsableCard` check `UserPromptSubmit` runs — so
  running the skill to completion is, by construction, a way to turn a stub
  card into one that passes the existing gate.
- **Respects the Scope D section split.** Hard, non-negotiable rules go to
  `## HARD CONSTRAINTS` (kept short, since that section alone is injected
  every session); everything else — background, evolving intent, narrative
  — is appended to `## 목표·의도·맥락`, which is explicitly meant to
  accumulate over time (the running-memory design Scope D already called
  out as a follow-up).
- **`install.mjs` ships the skill to both profiles.** `writeTemplateFile`
  copies `templates/harness-init/skill/capture-context/SKILL.md` to
  `<repo>/.claude/skills/capture-context/SKILL.md` with the same
  five-token substitution as every other template file, skip-and-warn if
  already present, for both `solo-full` and `team-local`.
- **`team-local` gitignore.** The skill file is harness tooling, so
  `gitignore.append.template`'s `team-local` block gained
  `.claude/skills/capture-context/` (narrower than the whole
  `.claude/skills/` directory, so this profile does not hide a team's own,
  unrelated skills that might live alongside it). `solo-full`'s block gets
  no new entry — the skill is a normal repository asset there, committed
  and reviewed like the hook scripts already are (unchanged from that
  block's existing rationale).

#### Honest limits (Scope C)

- **Cannot verify completeness or quality mechanically.** "Did this capture
  everything that mattered" is a judgment call the skill cannot make on its
  own — it surfaces only what the model *noticed* as durable during the
  scan; the human's edit/approval step is the only actual quality gate.
- **Does not see through prior compaction.** If the conversation was already
  summarized before the skill ran, whatever the summary dropped is gone from
  the skill's view too — there is no way to recover it retroactively.
- **Not a hard gate, and not Scope B.** The skill only runs on explicit
  invocation (`/capture-context`); it does not intercept `/clear` and blocks
  nothing by itself. A `/clear`-time re-orientation *checkpoint* is separate
  work, built below as Scope B.
- **Same local trust boundary as every other mechanism in this document.**
  Nothing stops an agent or operator from skipping the skill, or from
  writing a delta that looks plausible but doesn't actually reflect the
  conversation. The self-check step only proves the resulting card's *form*
  passes `isUsableCard` — it says nothing about whether its *content* is
  honest.

### Scope B (HYK-96) — `/clear-safe` reconciliation checkpoint

**Platform limits, stated up front — read this before anything else in this
subsection:**

- **There is no hook that can intercept `/clear` conversationally.**
  `SessionStart`'s `clear|compact` matcher fires *after* `/clear`, in the
  brand-new session — by then the old context is already gone, far too late
  to capture anything from it. Scope B is therefore **structurally
  incapable of being a hard gate** on `/clear` itself; it can only ever be a
  soft, Stop-hook-driven reminder plus a human convention.
- **Silent automatic compaction is not covered at all.** A quiet context
  compaction that happens without an explicit `/clear` gives this mechanism
  no signal to react to.
- **What the machine part actually verifies is form, not content** — the
  same altitude as Scope A's card gate: it can confirm a reconciliation
  *attestation* was filled in, never that the reconciliation was done well
  or even done at all in good faith.

With those limits acknowledged, the actual mechanism:

- **Protocol.** Before writing a 🟢 "safe to `/clear`" declaration anywhere
  on the status board, run `/capture-context` (Scope C) to reconcile this
  session's goals/intent/hard-constraint delta into `PROJECT-CONTEXT.md`,
  then record that a reconciliation pass happened via a marker placed next
  to the 🟢 declaration:

  ```
  <!-- clear-safe-attest: reconciled=<YYYY-MM-DD HH:MM KST | none> delta=<none|applied|deferred> -->
  ```

  `reconciled=` must be either a real timestamp or the literal `none`
  (nothing needed reconciling this session) — never left blank. The
  human-facing 🟢 prose declaration is unchanged and still coexists with
  this marker; the marker is the machine-readable half of the same claim.
- **Soft checker, `Stop` hook.** `scripts/check/clear-safe-check.mjs`
  exports a pure function `checkClearSafe(statusText) -> { ok, reason }`
  following the same text-in/struct-out shape as
  `extractHardConstraints`/`checkStatusFresh`: it looks for a 🟢 declaration
  co-located with the literal text `/clear` within the same `##`/`###`
  heading-bounded section (or an explicit `clear-safe: green` marker as a
  language-neutral escape hatch), and if found, requires the
  `clear-safe-attest` marker to be present with a non-empty `reconciled=`
  value. No green signal at all → `ok: true` (nothing to attest — this
  mirrors Scope C's own "no delta — no update needed" low-friction design).
  Any parsing trouble fails open (`ok: true`) — consistent with every other
  check in this harness treating "uncertain" as "not confirmed unsafe."
  The CLI (`--status <path>`, or `HARNESS_STATUS_PATH`, same convention as
  `status-fresh.mjs`) exits `0` on `ok`, and **`1`, never `2`,** on a
  confirmed-missing attestation — deliberately the same soft, non-blocking
  severity as `status-fresh.mjs`'s own `Stop`-hook contract, not the
  hard-block `exit 2` used by `role-guard.mjs`/D2's `commit-msg` gate. This
  keeps the checker inside the "structurally cannot be a hard gate" limit
  stated above, rather than pretending otherwise.
- **Relationship to A/C/D.** A (form gate) and D (card structure) are what
  make a *filled* `PROJECT-CONTEXT.md` mechanically distinguishable from a
  stub; C (`/capture-context`) is the hand that actually does the
  reconciling and produces the delta. B is the last piece: the protocol
  and reminder that ties a 🟢 `/clear`-safe declaration to that
  reconciliation having actually been invoked, in a way a Stop hook can
  mechanically nudge on without ever being able to force it.
- **Template.** `templates/harness-init/status.template.md` documents the
  marker and protocol under a new "`/clear` safety (reconciliation
  attestation)" section, so a freshly-installed project's board carries the
  same convention from the start. `install.mjs` copies
  `clear-safe-check.mjs`/`.test.mjs` to both profiles alongside the other
  check scripts; wiring the `Stop` hook itself is, like `status-fresh.mjs`'s
  own hook, a human, one-time, per-clone step (self-modifying
  `.claude/settings.local.json` is treated as a human action throughout
  this harness, not something a task automates). Same JSON shape as
  `status-fresh.mjs`'s own `Stop` hook entry:

  ```json
  {
    "hooks": {
      "Stop": [
        {
          "hooks": [
            {
              "type": "command",
              "command": "node /absolute/path/to/scripts/check/clear-safe-check.mjs --status \"/absolute/path/to/STATUS.md\""
            }
          ]
        }
      ]
    }
  }
  ```

  This can sit in the same `Stop` array entry as `status-fresh.mjs`'s
  command (Claude Code's `Stop` hook contract allows multiple commands per
  event) or its own separate entry — either way, both checks read the same
  board and both are non-blocking (`status-fresh.mjs` also warns rather
  than hard-blocks on `Stop`).

### v1 scope: deliberately minimal

`UserPromptSubmit` does not track "have I already injected this session" via
a marker file. The reasoning: `SessionStart`'s trigger list already includes
`clear`, so a `/clear` should already receive a fresh injection through that
hook without `UserPromptSubmit` needing session-scoped state — adding a
marker file here would be solving a problem `SessionStart` is already
supposed to solve, before confirming it doesn't. Whether `SessionStart`
actually fires its `additionalContext` payload on `clear` in practice (as
opposed to on paper) was **not independently reproduced in this task** — see
"Known limitations" below. If it turns out `clear` does not inject
reliably, that is a follow-up issue, not a reason to add marker-file state
to `UserPromptSubmit` pre-emptively (YAGNI, per this task's own explicit
instruction).

### Implementation

- `scripts/check/context-inject.mjs` follows the same shape as
  `role-guard.mjs`/`status-fresh.mjs`: a pure exported function
  `extractHardConstraints(contextText) -> { ok, text | reason }` (file I/O
  and hook-payload handling live only in the CLI block, so the extraction
  logic is testable without touching a filesystem or a hook contract) plus
  a CLI entry point: `node context-inject.mjs --mode
  <session-start|user-prompt-submit> [--context <path>]`, path also
  overridable via `HARNESS_CONTEXT_PATH`. Default context path is
  `<repoRoot>/.harness/PROJECT-CONTEXT.md`, same root-resolution pattern as
  every other check here.
- No exception path can crash either hook. `session-start` catches any
  read/parse failure and falls back to an internal-error warning
  (`additionalContext`, still `exit 0`); `user-prompt-submit` catches any
  failure and falls back to `exit 0` (pass-through) rather than blocking —
  blocking is reserved for the one condition this task specifies
  (the file is confirmed absent), not for "something went wrong while
  checking."
- `scripts/check/context-inject.test.mjs` (`node:test`, 12 cases): 6 cover
  `extractHardConstraints` directly (extraction, stopping at the next `##`
  heading, missing heading, blank section, case/whitespace-insensitive
  heading match, and a heading with extra trailing words correctly *not*
  matching the exact-title requirement); 6 cover the CLI via
  `execFileSync` against a real child process (`session-start` with a
  populated file, with a missing file, and with a file missing the
  constraints section; `user-prompt-submit` with the file present and
  absent; and a malformed-JSON stdin payload confirmed not to crash the
  process — the CLI never actually needs to parse stdin for its own logic,
  so this test guards against a future change that starts parsing it
  unsafely).
- Hook wiring (not installed by this task — see limitations):
  `.claude/settings.local.json`'s `hooks.SessionStart` and
  `hooks.UserPromptSubmit`, each running
  `node ".../scripts/check/context-inject.mjs" --mode <mode> --context "<path>"`.

### Known limitations (honesty notes)

- **Client-side only, by construction.** Unlike D-CI's server-anchored
  gitleaks/branch-protection checks, context injection has no external
  anchor to move to — a `SessionStart`/`UserPromptSubmit` hook is
  inherently a property of the client running the session. This is not a
  gap to close later; it is what this mechanism *is*.
- **Same local trust boundary as role-guard and status-fresh.** An agent or
  operator with shell access can remove the hook wiring from
  `.claude/settings.local.json`, or delete `PROJECT-CONTEXT.md` and route
  around the block by editing the check script itself. Nothing here is
  cryptographically enforced; it raises the cost of skipping the guardrail,
  it does not make skipping impossible.
- **Claude-only.** Both hook types are a Claude Code mechanism; a Codex
  worker session has no equivalent trigger, so REVIEW/VERIFY terminals
  running Codex are not covered by this injection at all — the same
  Claude-vs-Codex split already noted for role-guard and status-fresh.
- **Hook installation is a human, one-time, per-clone step — not done by
  this task.** Same rationale as status-fresh's Stop hook: writing to
  `.claude/settings.local.json` is self-modification of the file the
  role-guard hook itself lives in, which this harness treats as a human
  action. The JSON snippet above is documentation only.
- **`clear`-triggered injection: confirmed live (2026-07-07), superseding
  the HYK-94 open item above.** After the hooks were wired into
  `.claude/settings.local.json`, a real `/clear` was run and the resulting
  session listed its hard constraints without having read the file itself
  — direct evidence that `SessionStart`'s `additionalContext` payload
  actually reaches the new session's visible context on the `clear`
  trigger, not just in the CLI's own simulated-payload output. HYK-94's
  original wording ("not independently verified") is superseded by this
  entry rather than deleted, so the record shows the claim was raised
  honestly first and then closed with real evidence, not asserted from the
  start.
