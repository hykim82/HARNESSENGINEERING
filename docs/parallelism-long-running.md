# Parallelism and Long-Running Work

## Purpose

Phase 5 allows the harness to handle multiple tasks and interrupted sessions
without weakening the role boundaries defined in `docs/multi-agent-v1.md`.

This phase defines operating rules. It does not implement an automatic scheduler
or background worker runtime.

The goal is controlled concurrency:

- independent work may proceed in parallel
- shared-file conflicts are prevented or escalated
- long-running work can resume from durable artifacts
- verifier, reviewer, coder, orchestrator, and human authority stays separate

## Inputs

Phase 5 consumes:

- `docs/task-contract.md`
- `docs/harness-core-mvp.md`
- `docs/non-loop-profiles.md`
- `docs/multi-agent-v1.md`
- active Linear issues
- repository status
- current worktrees and branches

## Outputs

Each parallel or long-running task must leave:

- ownership record
- write lock record
- progress record
- handoff or resume artifact
- retry and blocked status when relevant
- Linear evidence matching the selected profile

## Concurrency Rule

Parallel work is allowed only when all conditions are true:

- each task has its own Task Contract
- each task has its own Linear issue
- write scopes do not overlap
- protected artifacts do not conflict
- worktree or branch ownership is recorded
- each task has a clear next verifier or reviewer path
- the Orchestrator can name the current owner of each task

If any condition is false, run the tasks sequentially or ask the human to split
scope.

## Worktree Ownership

Each parallel implementation task should use an isolated worktree or equivalent
workspace.

Ownership record:

```yaml
worktree_ownership:
  issue: "<Linear issue id>"
  owner_role: "coder | reviewer | verifier | orchestrator"
  owner_agent: "<agent/session id>"
  branch: "<branch name>"
  worktree_path: "<path>"
  profile: "loop | non-loop"
  write_scope:
    - "<path or module>"
  protected_artifacts:
    - "<path or decision>"
  created_at: "<YYYY-MM-DD HH:mm KST>"
```

Rules:

- one worktree belongs to one active task
- one active task has one primary owner at a time
- verifier work does not need write ownership unless the contract names a log
  file
- reviewer work may share a read-only workspace when no files are changed

If native worktrees are unavailable, the Orchestrator must record the fallback
workspace and the missing isolation risk.

## Write Locks

Write locks prevent two tasks from editing the same area at the same time.

Lock record:

```yaml
write_lock:
  issue: "<Linear issue id>"
  owner: "<role or agent>"
  paths:
    - "<path, module, or glob>"
  mode: "exclusive | shared-read"
  reason: "<why this task needs the lock>"
  expires_when: "<handoff, In Review, canceled, or explicit release>"
```

Default lock policy:

- code files: exclusive
- test files: exclusive after loop freeze
- docs owned by one phase: exclusive
- shared reference docs: exclusive unless the Orchestrator approves a merge
  plan
- generated artifacts: exclusive for the producing task
- read-only review: shared-read

Lock conflicts:

- If two tasks request overlapping exclusive locks, Orchestrator pauses one
  task.
- If overlap is small and intentional, Orchestrator records a merge order.
- If overlap changes completion conditions, human approval is required.

## Parallelism Decision Tree

```text
Do the tasks have separate Linear issues and Task Contracts?
  no  -> do not parallelize
  yes -> Do write scopes overlap?
           yes -> sequential or split scope
           no  -> Do protected artifacts conflict?
                    yes -> sequential or ask human
                    no  -> Can each task be verified or reviewed independently?
                             no  -> sequential
                             yes -> parallel allowed with ownership and locks
```

## Progress Records

Long-running work needs a progress record that can survive interruption.

Default local path when repository progress is required:

```text
docs/harness-progress.md
```

Create or update this file only when the task contract requires local progress
or when Linear is unavailable. Linear remains the primary progress log.

Progress record format:

```yaml
progress_record:
  issue: "<Linear issue id>"
  profile: "loop | non-loop | none"
  current_owner: "<role or agent>"
  state: "not_started | in_progress | waiting_for_verifier | waiting_for_reviewer | blocked | ready_for_review"
  last_completed_step: "<specific step>"
  next_step: "<specific step>"
  open_locks:
    - "<path or none>"
  evidence_so_far:
    - "<command, artifact, checklist result, or none>"
  blockers:
    - "<blocker or none>"
  updated_at: "<YYYY-MM-DD HH:mm KST>"
```

## Handoff Artifact

Every interrupted or delegated task needs a handoff artifact.

Handoff artifact format:

```yaml
handoff_artifact:
  issue: "<Linear issue id>"
  from_owner: "<role or agent>"
  to_owner: "<role or agent>"
  reason: "role_handoff | interruption | blocked | review_request"
  changed_files:
    - "<path or none>"
  uncommitted_changes:
    status: "none | present"
    summary: "<short summary>"
  commands_run:
    - command: "<command>"
      result: "<exit code and summary>"
  decisions:
    - "<decision or none>"
  risks:
    - "<risk or none>"
  next_action: "<specific next action>"
```

Handoff artifacts should be recorded in Linear first. If Linear is unavailable,
use the repository progress file and report the outage to the human.

## Retry Limits

Retry limits protect the harness from silent loops.

Default policy:

- loop task verifier FAIL: maximum 2 coder retries per cycle
- non-loop reviewer gap: maximum 2 revision attempts before human escalation
- tool outage: retry once after checking configuration, then report as outage
- merge conflict: retry once after rebase or manual merge plan, then escalate

Retry record:

```yaml
retry_record:
  issue: "<Linear issue id>"
  attempt: 1
  max_attempts: 2
  reason: "<verifier fail, reviewer gap, tool outage, conflict>"
  evidence: "<actual output or review gap>"
  next_action: "<specific retry action or escalation>"
```

Retries must use the real failure evidence. Do not rewrite the task as a new
success path to avoid the retry count.

## Blocked Policy

A task is blocked when progress depends on unavailable information, unavailable
tools, conflicting ownership, or human approval.

Blocked record:

```yaml
blocked_record:
  issue: "<Linear issue id>"
  blocker_type: "human_decision | tool_outage | lock_conflict | missing_source | verifier_fail | reviewer_gap"
  blocker: "<specific blocker>"
  attempted_resolution:
    - "<what was tried>"
  owner: "<who can unblock>"
  fallback: "<local record, sequential execution, or none>"
```

Rules:

- blocked work must not be reported as complete
- blocked work must release locks when no active change is in progress
- if a lock cannot be released safely, Orchestrator records why
- if the same blocker repeats across three resumed turns, mark the goal or task
  blocked instead of continuing to report progress

## Resume Procedure

When a session resumes, the Orchestrator should:

1. Read `AGENTS.md`.
2. Confirm the Linear project.
3. Check active In Progress issues.
4. Read the relevant Task Contract.
5. Read the latest Linear comments.
6. Read `docs/harness-progress.md` if it exists.
7. Confirm repository status and active worktree ownership.
8. Reconstruct current owner, locks, blockers, and next action.
9. Continue only if the next action is unambiguous.

If the next action is ambiguous, ask the human or write a clarification comment
before changing files.

## Merge and Conflict Policy

Parallel branches should merge only when:

- each branch has profile-matching evidence
- each branch has released or transferred locks
- shared files were merged in the order recorded by Orchestrator
- verifier or reviewer evidence still applies after merge

If a merge changes files covered by a frozen loop test, rerun verifier before
In Review.

If a merge changes a non-loop artifact after review, rerun the relevant review
checklist before In Review.

## Linear Record Requirements

For parallel or long-running tasks, Linear should record:

- profile decision
- ownership record
- write locks
- progress updates
- handoff artifacts
- retry attempts
- blocked records
- lock release
- final evidence
- In Review transition

If Linear is unavailable, the Orchestrator reports the outage immediately and
uses the repository fallback record defined by Harness Core MVP.

## Phase 6 Measurement Handoff

Phase 6 should measure:

- number of parallel tasks started
- number of lock conflicts
- number of tasks forced back to sequential execution
- retry count by reason
- blocked count by blocker type
- interrupted sessions resumed successfully
- handoff artifacts missing or incomplete
- verifier failures after merge
- reviewer gaps after merge

Phase 5 defines the records. Phase 6 decides how to calculate trends and turn
repeated failures into backlog items.

## Out of Scope

Phase 5 does not implement:

- an automatic scheduler
- a task queue
- automatic worktree creation
- automatic lock enforcement
- automatic merge conflict resolution
- background worker lifecycle management
- harness metrics dashboards
- reusable harness-init packaging

Those can be implemented after the operating rules prove stable.

## Completion Checklist

Phase 5 is complete when:

- parallelism has explicit allow and deny conditions
- worktree ownership is recorded
- write lock rules exist
- retry limits exist
- blocked policy exists
- progress and handoff artifact formats exist
- resume procedure exists
- merge conflict policy exists
- Phase 6 metrics handoff is defined
