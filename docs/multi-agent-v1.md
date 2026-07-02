# Multi-Agent v1

## Purpose

Multi-Agent v1 splits harness execution into explicit roles after the Task
Contract, loop profile contract, and non-loop profiles are stable.

This phase defines role boundaries and handoff rules. It does not implement
parallel scheduling, background workers, lock management, or long-running task
resumption. Those belong to Phase 5.

The v1 goal is simple:

- one task
- one Task Contract
- one active owner per stage
- explicit evidence before In Review

## Inputs

Multi-Agent v1 consumes:

- `AGENTS.md`
- `docs/task-contract.md`
- `docs/harness-core-mvp.md`
- `docs/loop-profile-contract.md`
- `docs/non-loop-profiles.md`
- `docs/model-orchestration.md`
- the active Linear issue
- the user's latest request

## Outputs

Each multi-agent task must leave:

- a Task Contract or equivalent Linear comment
- role assignment record
- handoff notes between roles
- question packets when a role needs clarification before work
- verification or review evidence matching the selected profile
- final In Review transition record

## Roles

### Orchestrator

Owns the task contract and routing.

Responsibilities:

- determine the Linear project and issue
- ensure only one issue is In Progress for this session
- write or update the Task Contract
- choose exactly one profile: `loop`, `non-loop`, or `none`
- choose the non-loop subtype when `profile = non-loop`
- declare loop test freeze point when `profile = loop`
- assign the next role
- answer or escalate pre-work questions from assigned roles
- collect handoff artifacts
- decide whether evidence is sufficient to move to In Review

Allowed changes:

- Task Contract
- Linear issue and comments
- repository planning documents when the task scope allows it

Must not:

- silently change completion conditions after work starts
- install the loop profile without human approval
- move Linear issues to Done
- treat missing evidence as success
- let a role continue while its blocking question is unresolved

### Coder

Owns implementation or artifact production within the declared write scope.

Responsibilities:

- read the Task Contract before changing files
- change only files listed in `artifacts.expected_changes`
- respect protected artifacts
- for loop tasks, write or strengthen tests before freeze when needed
- stop when scope, ownership, or acceptance criteria become unclear
- ask the Orchestrator a question packet before work when the uncertainty is
  blocking
- produce a handoff note for Verifier or Reviewer

Allowed changes:

- files explicitly listed in the task write scope
- tests before freeze when the contract allows them
- implementation files needed by the contract
- non-loop artifacts assigned to the Worker/Coder role

Must not:

- edit protected artifacts after freeze
- weaken tests or completion conditions
- expand scope without Orchestrator approval
- claim verifier PASS

### Verifier

Owns command-based verification for loop tasks.

Verifier applies only when `profile = loop`.

Responsibilities:

- run the real verification command from the contract
- ask the Orchestrator before running verification when the command, profile, or
  protected artifacts are unclear
- record the command, exit code, and actual output summary
- compare protected artifact state against the freeze rule when evidence exists
- return PASS or FAIL based only on the command and contract

Allowed changes:

- none by default
- verification log only when the task contract explicitly names a log file

Must not:

- edit code
- edit tests
- edit `scripts/verify.sh`
- reinterpret failing output as success
- verify non-loop work by calling a skipped `verify.sh` run PASS

### Reviewer

Owns scope, risk, and non-loop evidence review.

For loop tasks, Reviewer checks specification and risk but does not replace
Verifier judgment. For non-loop tasks, Reviewer evaluates the evidence packet
against `docs/non-loop-profiles.md`.

Responsibilities:

- check that the work stayed inside scope
- check that required evidence exists
- ask the Orchestrator before review when the source of truth or acceptance rule
  is unclear
- identify gaps, contradictions, and unhandled risks
- for non-loop tasks, mark checklist items as met, gap, or not applicable
- recommend In Review only when unresolved blockers are absent or listed

Allowed changes:

- review comments
- review report artifacts when listed in the contract
- small documentation corrections only when explicitly assigned

Must not:

- replace `verify.sh` for loop tasks
- approve code correctness without verifier evidence
- make subjective product decisions for the human
- expand acceptance criteria after the artifact is produced

### Spec Auditor

Spec Auditor is a specialized Reviewer for product/spec/research-heavy tasks.

Use when:

- the main risk is ambiguous intent
- the source of truth is scattered across documents
- the next phase depends on acceptance criteria quality
- role boundaries or handoffs are being designed

Responsibilities:

- preserve the user's stated goal
- separate current state from future plan
- confirm scope, out-of-scope, dependencies, and blockers
- verify that the next owner can act without reading the full chat history

Spec Auditor has the same prohibitions as Reviewer.

### Human

Owns final acceptance and irreversible decisions.

Responsibilities:

- resolve ambiguous intent
- approve loop profile installation
- approve destructive or irreversible actions
- accept subjective visual, product, or document quality
- move Linear issues to Done

Must not be bypassed for:

- final Done state
- product direction changes
- policy changes that affect future projects
- operations requiring explicit approval

## Role Assignment Record

The Orchestrator should record role assignment in Linear before delegating.

```yaml
role_assignment:
  task_id: "<Linear issue id>"
  profile: "loop | non-loop | none"
  non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
  orchestrator: "<session or agent>"
  coder: "<agent or none>"
  verifier: "<agent or none>"
  reviewer: "<agent, spec auditor, or none>"
  human: "한용"
  write_scope:
    - "<path or none>"
  protected_artifacts:
    - "<path or decision>"
  freeze_point: "<loop freeze point or none>"
```

## VSCode Tool Mapping

When the user chooses Claude Code as Orchestrator, use this mapping:

| Terminal | Tool | Harness role |
| --- | --- | --- |
| `[ORCH-CLAUDE]` | Claude Code | Orchestrator |
| `[CODER-CLAUDE]` | Claude Code | Coder |
| `[VERIFY-CODEX]` | Codex | Verifier |
| `[REVIEW-CODEX]` | Codex | Reviewer or Spec Auditor |

The Orchestrator role may be implemented by Claude Code, but the authority
rules do not change. Claude Orchestrator still stops at In Review and must not
claim verifier PASS without Codex Verifier evidence.

Model-level routing details live in `docs/model-orchestration.md`.
Claude Orchestrator handoff details live in
`docs/claude-orchestrator-handoff.md`.

## Handoff Note

Every role handoff should use a short durable note.

```yaml
handoff:
  from: "<role>"
  to: "<role>"
  task_id: "<Linear issue id>"
  profile: "loop | non-loop | none"
  summary: "<what changed or was checked>"
  changed_artifacts:
    - "<path, Linear comment, or external artifact>"
  evidence:
    - "<command output summary, checklist result, screenshot, or review note>"
  blockers:
    - "<blocker or none>"
  next_action: "<specific next role action>"
```

Handoff notes belong in Linear first. If Linear is unavailable, use
`docs/harness-records.md` as the fallback path defined by Harness Core MVP.

## Question Packet

Any role may ask the Orchestrator a pre-work question when the Task Contract or
handoff packet is not enough to proceed.

Question packets belong in Linear first. If Linear is unavailable, use the
fallback path named in the Task Contract.

Use `templates/harness-init/question-packet.template.md`.

Blocking questions stop the asking role until Orchestrator answers or escalates.
Non-blocking questions may continue with a recorded assumption.

## Loop Task Flow

Use this flow when `profile = loop`.

```text
Orchestrator
  -> writes contract
  -> confirms loop profile is installed or asks human before loop-init
  -> declares structured test cases and freeze rule

Coder
  -> writes or strengthens tests when allowed
  -> confirms RED when applicable
  -> stops at freeze point
  -> implements within write scope
  -> hands off to Verifier

Verifier
  -> runs bash -lc "./scripts/verify.sh"
  -> records real exit code and output summary
  -> returns PASS or FAIL

Reviewer
  -> checks scope, protected artifacts, and residual risk
  -> does not override verifier result

Orchestrator
  -> moves issue to In Review only if verifier PASS and reviewer blockers are absent or listed
```

Loop task hard rules:

- Verifier cannot edit code or tests.
- Reviewer cannot replace `verify.sh`.
- Coder cannot change frozen tests or completion conditions after freeze.
- Orchestrator cannot skip freeze declaration when tests define acceptance.

## Non-Loop Task Flow

Use this flow when `profile = non-loop`.

```text
Orchestrator
  -> writes contract
  -> selects non-loop subtype
  -> fixes source of truth, checklist, artifact, and acceptance rule

Coder or Worker
  -> produces the requested artifact
  -> records source material and assumptions
  -> hands off to Reviewer or Spec Auditor

Reviewer or Spec Auditor
  -> checks the profile-specific checklist
  -> records met/gap/not_applicable results
  -> lists unresolved gaps

Human
  -> accepts subjective or directional decisions when required

Orchestrator
  -> moves issue to In Review when evidence is complete and blockers are handled
```

Non-loop task hard rules:

- Do not call skipped `verify.sh` a PASS.
- Do not use Reviewer acceptance as Human acceptance when the contract requires
  the human.
- Do not change profile subtype after artifact production without recording why.
- Do not hide unresolved gaps to make the task look complete.

## None Task Flow

Use this flow when `profile = none`.

```text
Orchestrator
  -> confirms no durable artifact or external state change is needed
  -> records the decision in the active issue when relevant
  -> reclassifies if the discussion becomes durable work
```

No Coder, Verifier, or Reviewer is assigned for pure `none` tasks unless the
task is reclassified.

## Permission Matrix

| Role | Contract | Code | Tests | `verify.sh` | Review artifacts | Linear state |
| --- | --- | --- | --- | --- | --- | --- |
| Orchestrator | edit before delegation, record later changes | no | no | no | route | In Progress, In Review |
| Coder | read | edit within write scope | edit only before freeze when allowed | no | handoff note | comment only |
| Verifier | read | no | no | run only | verification note | comment only |
| Reviewer | read | no | no | no | review note | comment only |
| Spec Auditor | read | no | no | no | spec review note | comment only |
| Human | decide | approve when required | approve when required | no | final acceptance | Done |

Exceptions must be written into the Task Contract before the role acts.

## Failure Handling

### Contract Missing or Ambiguous

Orchestrator stops the task and asks for clarification or writes the missing
contract fields.

### Coder Scope Drift

Reviewer reports the drift. Orchestrator decides whether to narrow, re-scope,
or split the task. Coder does not keep expanding the change.

### Verifier FAIL

Orchestrator returns the task to Coder with the real verifier output. Retry
limits follow the loop rules: failed work gets at most two retries per cycle.

### Reviewer Gap

Orchestrator records the gap and either sends it back to Worker/Coder or moves
to In Review with the gap clearly listed when the contract allows that.

### Tool Outage

Linear, Notion, verifier, or browser outages are reported immediately. If work
continues, fallback records are written according to Harness Core MVP.

## Linear Record Requirements

Every multi-agent task should record:

- task start and selected profile
- role assignment
- freeze point for loop tasks
- handoff notes
- verifier output for loop tasks
- reviewer checklist for non-loop tasks
- unresolved gaps
- completion evidence
- In Review transition

The AI side stops at In Review. Human moves Done.

## Out of Scope for v1

Multi-Agent v1 does not include:

- parallel task execution
- multiple simultaneous In Progress issues in one session
- path locking
- worktree ownership
- background workers
- automatic agent spawning
- task queues
- retry automation
- long-running task resume files

These are Phase 5 concerns.

## Phase 5 Handoff

Phase 5 should add:

- worktree ownership
- write locks by path or module
- durable progress files
- handoff persistence across interrupted sessions
- parallelism rules
- blocked policy
- retry tracking

Phase 5 details live in `docs/parallelism-long-running.md`.

Phase 5 must preserve the v1 role boundaries. It may add concurrency, but it
must not let concurrency blur verifier, reviewer, coder, and human authority.

## Completion Checklist

Phase 4 is complete when:

- Orchestrator, Coder, Verifier, Reviewer, Spec Auditor, and Human roles are
  defined
- Verifier has no code edit authority
- Reviewer cannot replace `verify.sh`
- Orchestrator owns profile and freeze declaration
- Coder is limited to explicit write scope
- loop, non-loop, and none flows are defined
- Linear role assignment and handoff notes are defined
- Phase 5 parallelism and long-running work are explicitly out of scope
