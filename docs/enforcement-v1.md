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
| D2 | Orchestrator can skip the contract's required independent review and self-certify. | `commit-msg` git hook (`hooks/commit-msg` → `scripts/check/review-gate.mjs`): an issue-tagged commit is blocked unless `.harness/review.md` carries matching `for: <id>` + an approved verdict, or the message carries an audited `[skip-review: <reason>]` escape hatch. | Implemented this issue (proof-of-concept), see below |
| D3 | Relay has no task identity or acknowledgment, so a stale `<role>-task.md` can run under an ambiguous "go". | `<role>-task.md` gets a `task_id` + `dropped_at` header; `<role>.md` must echo `for: <id>` as its first line; a script diffs the two and rejects a stale or mismatched echo. | Sub-issue HYK-82 |
| D4 | `STATUS.md` drifts from the real Linear issue state and poisons the next boot. | Script diffs Linear against `STATUS.md`; run at boot and at commit time (needs network access, so it is orchestrator-invoked rather than a local-only hook). | Design only in this issue |
| D5 | The Task Contract can silently contradict a governing document (e.g. role split in `multi-agent-v1.md`). | Contract-vs-governing-document contradiction flag, to be promoted from a checklist item to a lint check. | Design only in this issue |

D1 is already live. D2 is the first real implementation delivered under this
issue (substance tracked in HYK-81). D3 is scoped to its own issue. D4 and D5
are recorded here as committed enforcement design, not yet built.

## D2 review gate — detailed spec

### Rule

Given a commit message and a review-evidence file:

1. If the message carries no `HYK-<digits>` tag, the commit is not issue work
   and passes unconditionally.
2. Else, if the message body contains `[skip-review: <reason>]` with a
   non-empty `<reason>`, the commit passes — this is an audited escape hatch,
   not a silent bypass (the reason stays in git history for later audit). An
   empty reason (`[skip-review: ]`) is rejected.
3. Else, the review-evidence file (default `.harness/review.md`, resolved
   from the repository root) must exist and contain both a `for: <id>` line
   matching the message's issue id and an approval verdict line
   (`verdict: approved` or `ready_for_review`). Only then does the commit
   pass; otherwise it is blocked.

### Implementation

- `scripts/check/review-gate.mjs` exports the pure function
  `checkReviewGate({ message, reviewPath }) -> { ok, reason }` implementing
  the rule above, plus a CLI entry point: `node review-gate.mjs
  <commit-msg-file>` exits `0` when `ok` and exits `1` with `reason` on
  stderr otherwise. When `reviewPath` is not supplied, the default resolves
  to `.harness/review.md` under the **repository root** (`git rev-parse
  --show-toplevel`, falling back to `process.cwd()` outside a git repo), not
  the process's current working directory — this keeps the check correct
  regardless of where the calling hook happens to run from.
- `scripts/check/review-gate.test.mjs` is a fixture-based test suite (node's
  built-in test runner) covering five cases: no tag, tag with no review
  evidence (blocked), tag with approved evidence (passes), the skip-review
  escape hatch with a reason (passes), and the skip-review escape hatch with
  an empty reason (blocked). Fixtures live under a temp directory created per
  test; no real repository state is touched.
- `hooks/commit-msg` is a thin wrapper (`#!/usr/bin/env sh`) that resolves
  the repository root itself before calling the script:

  ```sh
  #!/usr/bin/env sh
  root=$(git rev-parse --show-toplevel) || exit 1
  node "$root/scripts/check/review-gate.mjs" "$1"
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

## Not over-engineered / solo-operable

This is one hook, one pure-function script, and one fixture test file — no
server, no CI account, no database, no scheduling system. The default
reviewPath and verdict format are two plain text conventions a single
operator can satisfy by hand (write `for: HYK-80` and `verdict: approved`
into `.harness/review.md`, or add `[skip-review: <reason>]` when review
genuinely does not apply). Nothing here requires a second person to operate;
it only requires that skipping review leave a visible, audited trace instead
of silently vanishing, which is the actual gap HYK-80 identified.
