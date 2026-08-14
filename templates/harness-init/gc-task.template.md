<!-- gc-task.template.md (HYK-103) -- a periodic "entropy GC" relay task, ready
     to drop. Recommended cadence: weekly, human-triggered (not automatic --
     see docs/harness-init.md "Entropy GC" for why this stays a person's call).

     Two different placeholder kinds are mixed in this file on purpose --
     know which is which before dropping it:
       - `<REPO_PATH>` / `<GITHUB_REPO>` / `<PROFILE>` -- install.mjs's
         existing five-token convention. These are project-fixed and get
         substituted ONCE, at install time, same as every other template.
       - `REPLACE_ME_*` (HYK-97's plain <UPPER_SNAKE> convention) -- values
         install.mjs cannot know because they change every GC cycle, not
         once per project (which task_id, which timestamp, which scan
         exclusions this run). The Orchestrator fills these in by hand each
         time it copies this file to `.harness/coder-task.md`.

     Usage: copy this file's content (below the "# CODER TASK" line) into
     `.harness/coder-task.md`, fill in the REPLACE_ME_* tokens, and tell the
     human to say "go" in the CODER terminal -- same drop mechanism as every
     other CODER task, per docs/claude-orchestrator-handoff.md's Relay
     Protocol v2 / D3 handshake (scripts/check/relay-handshake.mjs). -->

task_id: REPLACE_ME_TASK_ID
dropped_at: REPLACE_ME_DROPPED_AT_KST
for: REPLACE_ME_LINEAR_ISSUE_ID (entropy GC cycle)
role: CODER (<REPO_PATH>)

# CODER TASK — entropy GC scan (find only, do not fix)

## Background (why this task exists)

Documentation and templates drift from the code they describe, and nothing
catches it until someone stumbles onto the gap by accident. Every entropy bug
this harness has actually found so far (a duplicate `.gitignore` append block,
a template placeholder that gets corrupted by naive substitution, stale
target-file lists) was found by luck during unrelated work, not by a
standing process. This task makes "look for drift" a recurring, structured
scan instead of a lucky accident.

## The one hard rule: find, never fix

This scan **only produces a report.** Any edit to a scanned file other than
writing `.harness/gc-report.md` itself is an out-of-scope violation of this
task and grounds for a REVIEW rejection on its own, independent of whether
the fix would have been correct. Fixing what this scan finds is a separate,
later, human-approved cycle (typically: a new Linear issue per finding, then
a normal CODER task against that issue) — never the same turn as the scan.

## Scope

- Target: REPLACE_ME_SCAN_ROOTS (e.g. `docs/`, `templates/`, `scripts/`, and
  root-level docs of `<REPO_PATH>`). Exclude generated/vendored directories
  (`node_modules/`, build output) and this harness's own relay directory
  (`.harness/`) — the relay files churn every cycle by design and are not
  "entropy" in the sense this scan cares about.
- REPLACE_ME_ADDITIONAL_EXCLUSIONS (e.g. an external control room path that
  is out of this repo's write lane entirely — name it explicitly if one
  exists for this project, or delete this line if not).

## Scan categories (all five, every cycle)

Run all five even if early categories turn up nothing — a category with zero
findings is a real result ("scanned, clean"), not the same as "not scanned."
Report both kinds honestly (see "Report format" below).

1. **Doc↔code mismatch** — does a file, command, or structure a document
   claims exists actually exist? Example checks: `grep` a doc's claimed file
   paths against the real filesystem; run a command a doc says exists
   (`--help`, a dry-run flag) and confirm it doesn't error; diff a doc's
   described directory layout against `ls`/`Glob` reality.
2. **Dead files/templates** — a file nothing else references. Example: for
   each file under a templates/package directory, `grep -rn "<basename>"`
   across the rest of the repo (docs + code) and confirm at least one real
   reference beyond the file's own existence; a file installed by nothing
   and linked from nothing is a candidate (but confirm it isn't a
   deliberately-dormant draft before reporting it as dead — check for an
   explicit "draft"/"not yet installed" label first).
3. **Duplicate blocks (SoT violation)** — the same content maintained in two
   or more places that can silently drift apart. Example: `grep -rn` a
   distinctive phrase or code block across the repo; two-or-more hits in
   different files describing the same fact (not just cross-referencing it)
   is a candidate.
4. **Deprecated references** — a document pointing at a removed feature,
   renamed path, or closed issue as if it were still current. Example: for
   every file path a doc names, confirm it still exists at that path; for
   every Linear issue id a doc cites as open/pending, cross-check its
   current state if available; watch especially for older sections of a doc
   that predate a later rewrite of the same doc and were never reconciled
   with it (a single file can be internally inconsistent, not just
   inconsistent with code).
5. **TODO/FIXME rot** — a marker left behind and never revisited. Example:
   `grep -rn "TODO\|FIXME\|XXX:"` across the scan scope; for each hit, check
   whether the surrounding context or git history suggests it's been sitting
   long enough to be effectively abandoned rather than active work-in-progress.

## Report format (`.harness/gc-report.md`, overwrite — not append)

```markdown
# GC Report — REPLACE_ME_TASK_ID (REPLACE_ME_SCAN_DATE)

## Findings

| Location            | Category         | Evidence                                                                  | Severity          | Suggestion                                   |
| ------------------- | ---------------- | ------------------------------------------------------------------------- | ----------------- | -------------------------------------------- |
| <path:line or path> | <1-5 from above> | <repro cmd + its real output, or an exact quote/citation — never a guess> | <Low/Medium/High> | <what a future fix task should do, one line> |

(one row per finding; if a category found nothing, still say so in prose
above the table, e.g. "Category 5 (TODO/FIXME): scanned, none found.")

## Areas not scanned

<Honest list of anything in scope this cycle didn't actually cover, and
why — a time-boxed scan is expected to have edges; naming them is required,
pretending coverage was total when it wasn't is not.>
```

Evidence must be a real, reproducible command and its real output, or an
exact file:line quote — never "this looks like it might be stale." A finding
without reproducible evidence does not go in the table.

## Verification (this task itself)

1. All five categories attempted and reflected in the report (findings or an
   explicit "scanned, none found" line) — not silently skipped.
2. Every finding's evidence cell is copy-pasteable and was actually run/read
   by the scanner, not inferred.
3. `.harness/gc-report.md` written; no other file touched except that one.

## Prohibited

Editing anything the scan finds. Committing. Touching Linear. Any file
outside `.harness/gc-report.md`. Secrets/token output.

## Result report (D3)

`.harness/coder.md` (or this project's equivalent result path): echo the
`task_id`, a one-line finding-count summary per category, a pointer to
`.harness/gc-report.md` for the detail, and an honest limitations note (scan
coverage depends on the scanning model's own judgment/recall — this is not a
mechanically-guaranteed-complete process, only a structured one). End with
`>>> DONE: CODER @ <real KST timestamp>`. ⛔Once written, do not edit this
result file again — the consumption receipt records its exact fingerprint,
and any later edit (even formatting-only) permanently misjudges an
already-consumed round as unconsumed (HYK-244, real incident).
