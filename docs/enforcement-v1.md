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
