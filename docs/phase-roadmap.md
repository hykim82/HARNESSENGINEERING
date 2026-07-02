# HARNESSENGINEERING Phase Roadmap

## Phase 0: Basis

Goal:

- Fix the conceptual basis before implementation.

Outputs:

- harness basis document
- loop profile contract
- phase roadmap

Completion criteria:

- harness, loop profile, and multi-agent layers are separated
- loopEngineering Phase 1/2 is consumed as a loop profile contract
- multi-agent implementation is explicitly deferred

## Phase 1: Task Contract

Goal:

- Define the contract every harness task must use before work starts.

Required fields:

- Linear issue and project
- goal
- scope in and scope out
- profile applies: loop / non-loop / none
- reason for profile choice
- verification command or review checklist
- completion conditions
- structured test cases when loop applies
- test freeze point when loop applies
- protected artifacts
- expected changed files
- fallback record policy

Completion criteria:

- a task can be classified before any agent begins work
- loop and non-loop work are not confused
- the contract is specific enough for orchestrator, coder, verifier, reviewer,
  and human roles

## Phase 2: Harness Core MVP

Goal:

- Make the harness usable without multi-agent scheduling.

Scope:

- one orchestrator procedure
- task contract creation
- profile selection
- record routing to Linear and local files
- fallback reporting

Completion criteria:

- one real task can run through the harness using a written contract
- loop profile is applied only when suitable
- non-loop work has a documented acceptance path

## Phase 3: Non-Loop Profiles

Goal:

- Define verification paths for work that `verify.sh` cannot judge.

Profiles:

- research profile
- document profile
- UI review profile
- product/spec review profile

Completion criteria:

- docs-only SKIP 0 is not treated as PASS
- each non-loop profile has source-of-truth, checklist, artifact, and human
  acceptance rules

## Phase 4: Multi-Agent v1

Goal:

- Split execution roles after contracts are stable.

Roles:

- Orchestrator
- Coder
- Verifier
- Reviewer or Spec Auditor
- Human

Completion criteria:

- verifier cannot edit code
- reviewer cannot replace `verify.sh`
- orchestrator declares profile and freeze point
- coder works within explicit write scope

Output:

- `docs/multi-agent-v1.md`

## Phase 5: Parallelism and Long-Running Work

Goal:

- Allow multiple tasks while preserving ownership and handoff quality.

Scope:

- worktree ownership
- write locks by path or module
- retry limits
- blocked policy
- handoff artifact
- progress file

Completion criteria:

- independent work can run in parallel
- shared-file conflicts are prevented or escalated
- interrupted sessions can resume from durable artifacts

Output:

- `docs/parallelism-long-running.md`

## Phase 6: Harness Evaluation Loop

Goal:

- Make the harness itself improve through measurement.

Metrics:

- task success rate
- verifier failure rate
- retry count
- human escalation rate
- docs-only rejected count
- Linear or Notion fallback count
- cost per successful task
- repeated failure categories

Completion criteria:

- repeated failures become backlog items
- harness changes are measured before and after
- no change is called an improvement without evidence

Output:

- `docs/harness-evaluation-loop.md`

## Phase 7: Harness Init

Goal:

- Package the stable harness for future projects.

Possible form:

- `harness-init` skill
- task contract template
- optional loop profile install
- non-loop profile templates
- global asset backup guide
- Linear and Notion integration guide

Completion criteria:

- new projects can opt into the harness without automatic file pollution
- loop profile remains explicit and optional
- setup records where contracts and runtime assets live

Output:

- `docs/harness-init.md`
- `templates/harness-init/`

## Current Status

Phase 0 through Phase 7 have local design artifacts. They define the basis,
Task Contract, Harness Core MVP, non-loop profiles, Multi-Agent v1 role
boundaries, controlled parallelism/long-running work rules, and the harness
evaluation loop. Phase 7 adds a draft harness-init package for future projects.

The harness-init package is draft and unvalidated until it is applied to a
separate target project with explicit approval. Do not install global skills or
modify future repositories automatically. New projects must explicitly opt in.

The next practical sequence is:

1. Validate the draft package on a separate target project
2. Record metrics from that validation
3. Promote or revise the package based on evidence
