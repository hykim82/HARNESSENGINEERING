# Harness Core MVP

## Purpose

Harness Core MVP defines the minimum operating procedure for HARNESSENGINEERING
before multi-agent scheduling exists.

The MVP must allow one orchestrator, human or AI-assisted, to start a task,
classify it, route records, collect evidence, and move the work to In Review
without confusing loop and non-loop work.

This document is procedural. It does not implement a CLI, skill, or multi-agent
runtime.

## Inputs

Harness Core MVP consumes:

- `AGENTS.md`
- `docs/phase0-harness-basis.md`
- `docs/loop-profile-contract.md`
- `docs/task-contract.md`
- `docs/non-loop-profiles.md`
- `docs/multi-agent-v1.md` after Phase 4
- `docs/parallelism-long-running.md` after Phase 5
- `docs/harness-evaluation-loop.md` after Phase 6
- `docs/harness-init.md` after Phase 7
- current Linear issue or project
- user request

## Outputs

For each task, the MVP should produce:

- a Linear issue or comment
- a task contract
- profile decision: `loop`, `non-loop`, or `none`
- progress records
- evidence record
- final In Review transition when work is complete

Repository files are optional outputs. If the task is pure discussion or an
administrative decision, the output may be only a Linear record.

## MVP Roles

### Orchestrator

In the MVP, the active Codex session acts as orchestrator.

Responsibilities:

- read project instructions
- identify or create the Linear issue
- write or update the task contract
- choose the profile
- route work to the right path
- keep user-visible progress concise
- record progress in Linear
- decide when evidence is sufficient for In Review

### Worker

In the MVP, the same Codex session may also perform worker duties for document
or code changes. This is acceptable only because multi-agent execution is not
implemented yet.

Worker responsibilities:

- stay inside the contract scope
- avoid changing protected artifacts
- collect the required evidence

### Verifier

Verifier is used only for loop tasks.

In MVP:

- if loop profile is not installed, do not invent a loop run
- if loop profile applies and exists, verifier runs the real command
- if loop profile applies but is absent, orchestrator must ask whether to apply
  loop-init before proceeding

### Reviewer

Reviewer responsibility exists even before a separate reviewer agent exists.

In MVP:

- for loop tasks, reviewer checks scope, risk, and spec gaps but does not
  override verifier PASS/FAIL
- for non-loop tasks, reviewer checks the review checklist and source of truth

### Human

Human remains responsible for:

- ambiguous intent
- final Done state
- visual or product acceptance when no command can judge it
- approving loop profile installation
- approving destructive or irreversible actions

## Task Start Procedure

1. Read `AGENTS.md`.
2. Identify the Linear project from `Linear-Project`.
3. Find an existing issue for the task or create one.
4. Move exactly one issue to `In Progress`.
5. Draft the task contract.
6. Choose exactly one profile.
7. Record the profile decision in Linear.
8. Begin work only after scope and completion conditions are fixed.

## Profile Selection Decision Tree

```text
Can one command meaningfully judge PASS/FAIL?
  yes -> loop
  no  -> Is there a source of truth plus checklist or human acceptance?
           yes -> non-loop
           no  -> Is this only clarification or administration with no durable artifact?
                    yes -> none
                    no  -> contract incomplete; ask human or define acceptance criteria
```

## Loop Path

Use when `profile.type = loop`.

Procedure:

1. Confirm `LOOP.md` and `scripts/verify.sh` exist.
2. If absent, treat the project as loop profile not applied.
3. Ask the human before installing loop profile.
4. Ensure structured test cases are in the contract.
5. Write or strengthen tests.
6. Confirm RED when applicable.
7. Freeze tests and completion conditions.
8. Implement within scope.
9. Run verifier path with:

```text
bash -lc "./scripts/verify.sh"
```

10. Record real output and exit code.
11. Move to In Review only on verifier PASS and no unresolved reviewer blockers.

Loop path must not be used for docs-only work without explicit document checks.

## Non-Loop Path

Use when `profile.type = non-loop`.

Procedure:

1. Choose one subtype from `docs/non-loop-profiles.md`.
2. Fix source of truth.
3. Fix review checklist.
4. Fix expected artifact location.
5. Produce or inspect the artifact.
6. Check every review item.
7. Record evidence and gaps.
8. Ask human for acceptance when the contract requires it.
9. Move to In Review when checklist evidence is recorded and no known blocker
   remains.

Non-loop work must not claim `verify.sh` PASS as proof unless a separate check
command is explicitly part of the contract.

## None Path

Use when `profile.type = none`.

Procedure:

1. Confirm no repository file, global asset, product behavior, or durable
   external record is being changed.
2. Record the decision in the active issue if it belongs to ongoing work.
3. If durable work emerges, stop and reclassify as `loop` or `non-loop`.

None path does not move implementation work forward. It only resolves direction.

## Record Routing

### Linear

Linear is the primary durable work log when available.

Required records:

- task start
- profile decision
- important progress
- fallback or outage
- completion evidence
- In Review transition

If Linear is unavailable:

- tell the human immediately
- record locally in the repository if work continues
- include the outage in the final report

### Repository

Use repository docs for durable design records and task artifacts.

Default fallback record path:

```text
docs/harness-records.md
```

Create or update this file only when Linear is unavailable or when a task
contract explicitly requires a repository-local record. The fallback record must
include the attempted Linear action, the failure reason, the task id, and the
evidence that would have been posted to Linear.

### Notion

Notion is a source or publication target only when the task contract names it.

If Notion is unavailable:

- report immediately
- keep a repository note or Linear comment
- do not silently drop the record

## Evidence Rules

Evidence must match the selected profile.

Loop evidence:

- verifier command
- exit code
- actual output summary
- protected artifact status

Non-loop evidence:

- non-loop subtype
- source of truth
- checklist result
- artifact location
- human acceptance or explicit unresolved gaps

None evidence:

- decision summary
- why no durable work profile applies

## Failure Rules

### Contract Incomplete

If scope, completion conditions, source of truth, or profile choice is unclear,
stop and ask for clarification.

### Profile Mismatch

If work starts as `none` or `non-loop` but becomes code or verification work,
stop and reclassify.

If work starts as `loop` but cannot be judged by `verify.sh`, stop and
reclassify.

### Tool Outage

Do not silently skip Linear, Notion, or verifier obligations.

If a required tool is unavailable:

- report immediately
- record fallback locally if possible
- mark the affected evidence as unavailable

### Human Decision Required

Escalate to the human for:

- destructive operations
- irreversible external changes
- ambiguous product intent
- missing acceptance criteria
- final Done movement

## In Review Criteria

A task can move to In Review when:

- the task contract exists
- the selected profile has matching evidence
- fallback obligations are recorded
- known blockers are listed or resolved
- the final report explains how to verify the work

Never move a Linear issue to Done. Done remains a human action.

## Phase 2 Example Run

```text
User request:
Review Phase 1 and proceed to Phase 2.

Contract:
profile = non-loop
reason = design document work; verify.sh cannot judge it
source_of_truth = Phase 0 docs, task-contract.md, phase roadmap
review_checklist =
  - Phase 1 does not conflict with Phase 0
  - none profile cannot bypass records
  - non-loop evidence fields are explicit

Execution:
review docs -> patch task-contract.md -> create HYK-57 -> write harness-core-mvp.md

Evidence:
rg checks, document readback, Linear comments, In Review transition
```

## Out of Scope

Harness Core MVP does not include:

- multi-agent scheduling
- background workers
- automatic worktree locking
- automatic task contract parsing
- loop profile installation
- CI or branch protection
- reusable harness-init packaging

## Handoff to Phase 3

Phase 3 should define concrete non-loop profiles:

- research
- documentation
- UI review
- product/spec review

Each profile should turn the generic non-loop path into a more precise checklist
and evidence format.

## Handoff to Phase 4

Phase 4 can split the MVP roles into separate agents only after Phase 3 defines
non-loop evidence clearly.

The first multi-agent split should be:

- Orchestrator
- Coder
- Verifier
- Reviewer or Spec Auditor
- Human

Phase 4 details live in `docs/multi-agent-v1.md`. Harness Core MVP remains the
single-session fallback when separate agents are unavailable.

## Handoff to Phase 5

Phase 5 can add controlled parallelism and long-running resume rules only after
Multi-Agent v1 role boundaries are fixed.

Phase 5 details live in `docs/parallelism-long-running.md`. Harness Core MVP
remains the fallback when work is sequential or when ownership records are not
available.

## Handoff to Phase 6

Phase 6 can evaluate harness quality only after tasks leave durable evidence.

Phase 6 details live in `docs/harness-evaluation-loop.md`. Harness Core MVP
continues to provide the task-level evidence that Phase 6 measures.

## Handoff to Phase 7

Phase 7 can package the harness for future projects only as an explicit opt-in
asset.

Phase 7 details live in `docs/harness-init.md`. Harness Core MVP remains the
runtime fallback for repositories that have not installed a future harness-init
skill.
