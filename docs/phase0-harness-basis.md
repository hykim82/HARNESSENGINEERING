# Phase 0 Harness Basis

## Purpose

Phase 0 fixes the starting assumptions for HARNESSENGINEERING before building a
harness runtime or multi-agent workflow.

The goal is to define what the harness is responsible for, how it consumes the
existing loopEngineering work, and what must be true before multi-agent
execution starts.

## Operating Intent

HARNESSENGINEERING exists to make new projects start with a better AI operating
system. It should provide reusable contracts, roles, records, and profile
selection rules that can be applied across different repositories without
polluting them automatically.

The harness is the upper-level operating environment. It decides:

- what the task is
- which profile applies
- which agent role owns each decision
- which artifacts are protected
- where progress and fallback records go
- when human approval is required

loopEngineering is a lower-level verification profile inside the harness. It is
used only when a task can be judged by one command returning PASS/FAIL.

## Layer Model

```text
Multi-agent execution
└─ Harness engineering
   ├─ Task contract
   ├─ Role and permission boundaries
   ├─ Tool and record routing
   ├─ Loop profile selection
   │  └─ loopEngineering profile
   │     ├─ LOOP.md
   │     ├─ scripts/verify.sh
   │     ├─ scripts/check-cases.mjs
   │     ├─ test freeze
   │     ├─ verifier
   │     └─ METRICS.md
   ├─ Non-loop profile selection
   ├─ Handoff and fallback records
   └─ Human approval gates
```

The harness should never treat loop profile installation as automatic. A
project without `LOOP.md` is not broken; it is simply a project where the loop
profile is not applied yet.

## Phase 0 Decisions

### 1. Loop Is a Profile, Not the Whole Harness

The loop profile handles code or verification tasks that have a meaningful
single-command PASS/FAIL gate.

Examples:

- pure functions
- CLI behavior
- testable libraries
- API behavior with deterministic checks
- parser or validation logic

Non-examples:

- research synthesis
- open-ended product thinking
- UI taste review
- document drafting without a check command
- exploratory debugging before a reproducible symptom exists

### 2. Task Contract Comes Before Agents

The harness must define a task contract before assigning work to any role.
Agents are execution units, not the source of truth.

The contract must state whether the loop profile applies and why. Without that
decision, a verifier may be asked to judge work that `verify.sh` cannot actually
judge.

### 3. Multi-Agent Comes After Contracts

The first working harness should be usable by one orchestrator following written
contracts. Multi-agent scheduling, parallel worktrees, and handoff automation
come later.

This keeps early failures attributable to the contract and profile design,
rather than to coordination complexity.

### 4. Human Is Still the Final Policy Boundary

The system should reduce manual code review burden, but it cannot remove human
judgment from:

- ambiguous product decisions
- business logic intent
- visual acceptance
- irreversible actions
- final Done state in Linear

## Minimum Harness Responsibilities

The harness must provide:

- a task contract template
- a profile selection rule
- a loop profile contract
- a non-loop profile contract
- role boundaries for orchestrator, coder, verifier, reviewer, and human
- fallback behavior for Linear, Notion, and docs-only work
- durable records for global `~/.codex` asset changes

## Out of Scope for Phase 0

Phase 0 does not implement:

- a harness CLI
- a new skill
- multi-agent scheduling
- worktree locking
- CI or branch protection
- automatic loop installation

## Completion Checklist

- Harness and loop hierarchy is explicit.
- Loop profile is described as opt-in and command-verifiable.
- Task contract is identified as the next design target.
- Non-loop work is not forced through `verify.sh`.
- Multi-agent work is deferred until contracts are stable.
