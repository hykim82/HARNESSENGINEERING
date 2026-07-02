# Harness Evaluation Loop

## Purpose

Phase 6 makes HARNESSENGINEERING improve through measurement instead of opinion.

No harness change should be called an improvement unless there is before/after
evidence. Repeated failures become backlog items. Missing evidence is treated
as an unknown, not as success.

This phase defines records and decision rules. It does not implement a metrics
dashboard or automatic analytics pipeline.

## Inputs

Phase 6 consumes:

- Task Contracts
- Linear issue state and comments
- verifier records for loop tasks
- non-loop evidence packets
- retry records
- blocked records
- handoff artifacts
- fallback records for Linear or Notion outages
- `docs/parallelism-long-running.md`

## Outputs

Phase 6 produces:

- metric records
- repeated failure categories
- improvement backlog items
- before/after comparison notes
- harness change decision records
- Phase 7 readiness signal

## Metric Record

Each completed or blocked harness task should be summarized in a compact metric
record.

```yaml
harness_metric:
  issue: "<Linear issue id>"
  profile: "loop | non-loop | none"
  non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
  outcome: "in_review | blocked | canceled | returned_for_changes"
  task_started_at: "<YYYY-MM-DD HH:mm KST>"
  task_finished_at: "<YYYY-MM-DD HH:mm KST or none>"
  verification:
    command: "<command or none>"
    result: "pass | fail | not_applicable | unavailable"
  review:
    result: "ready_for_review | needs_changes | blocked | not_applicable"
  retries:
    count: 0
    reasons:
      - "<reason or none>"
  human_escalations:
    count: 0
    reasons:
      - "<reason or none>"
  fallbacks:
    linear_unavailable: false
    notion_unavailable: false
    local_record_used: false
  docs_only:
    rejected_skip_pass: false
  parallelism:
    parallel_task: false
    lock_conflict: false
    resumed_after_interruption: false
  cost:
    tokens: "unknown | number"
    elapsed_minutes: "unknown | number"
  failure_category: "<category or none>"
```

Linear remains the primary place to record the metric. A repository-local metric
file should be created only if the task contract requires it or Linear is
unavailable.

Default local fallback path:

```text
docs/harness-metrics.md
```

## Core Metrics

### Task Success Rate

Definition:

- numerator: tasks moved to In Review with matching profile evidence
- denominator: tasks started under the harness

Exclude:

- pure clarification tasks with `profile = none`
- canceled tasks when the user changed direction before work began

Use this metric to detect whether the harness is helping work reach review.

### Verifier Failure Rate

Definition:

- loop verifier FAIL count divided by loop verifier attempts

Record:

- command
- exit code
- output summary
- whether failure happened before or after merge

Use this metric to find weak test freeze, broken verify scripts, and code
handoff problems.

### Retry Count

Definition:

- number of repeated attempts after verifier FAIL, reviewer gap, tool outage,
  merge conflict, or blocked handoff

Record retry reason exactly. Do not merge different causes into a vague
category such as `misc`.

### Human Escalation Rate

Definition:

- tasks requiring human decision divided by harness-started tasks

Valid escalation reasons:

- ambiguous intent
- product direction
- visual/document quality
- destructive or irreversible action
- loop profile installation
- missing acceptance criteria

High escalation is not automatically bad. It is a signal that contracts may be
underspecified or that the work is genuinely judgment-heavy.

### Docs-Only Rejected Count

Definition:

- count of attempts where docs-only work would have been called PASS because
  `verify.sh` skipped executable checks

Use this metric to ensure the loop profile is not stretched beyond its intended
boundary.

### Linear or Notion Fallback Count

Definition:

- count of tasks where Linear or Notion recording failed and repository-local
  fallback was used

Record:

- attempted action
- failure point
- fallback path
- whether final Linear backfill happened later

### Cost Per Successful Task

Definition:

- approximate token or elapsed-time cost divided by tasks moved to In Review

If exact token count is unavailable, record elapsed minutes and mark tokens as
unknown. Unknown cost is better than invented precision.

### Repeated Failure Categories

Definition:

- recurring failure labels that appear across tasks

Initial categories:

- contract_missing_field
- profile_mismatch
- verifier_fail
- reviewer_gap
- test_freeze_violation
- docs_only_false_pass_attempt
- linear_outage
- notion_outage
- lock_conflict
- handoff_missing
- resume_ambiguous
- human_acceptance_missing
- scope_drift

Categories may be refined in Phase 7 only if the change preserves history or
documents the mapping.

## Improvement Backlog Rule

Create a backlog item when any condition is true:

- the same failure category appears in 3 tasks
- verifier FAIL repeats twice for the same contract pattern
- reviewer gap repeats twice for the same non-loop profile
- Linear or Notion fallback is used in 2 consecutive tasks
- a task resumes ambiguously because handoff artifacts were missing
- human escalation repeats because the same acceptance field is missing
- docs-only false PASS is attempted even once after the guardrail exists

Backlog item format:

```yaml
improvement_backlog_item:
  title: "<failure category and proposed improvement>"
  trigger:
    metric: "<metric name>"
    evidence:
      - "<issue id or record>"
  suspected_cause: "<specific cause or unknown>"
  proposed_change: "<contract, profile, doc, skill, script, or workflow change>"
  success_measure: "<metric expected to improve>"
  risk: "<what could get worse>"
```

Do not create a harness change without naming the metric it is supposed to
improve.

## Before/After Comparison

Before changing the harness:

1. Identify the failure category.
2. Gather at least one concrete evidence record.
3. Record the current metric value or baseline count.
4. Define the proposed change.
5. Define the expected measurement window.

After changing the harness:

1. Run the next comparable tasks using the new rule.
2. Record the same metric.
3. Compare against the baseline.
4. Report improvement, regression, or inconclusive.

Allowed outcomes:

- `improved`: evidence shows the target metric moved in the desired direction
- `regressed`: evidence shows the target metric got worse
- `inconclusive`: not enough comparable evidence

`inconclusive` is a valid result. It is better than claiming improvement from
one anecdote.

## Evidence Rules

Metric evidence must point to real records:

- Linear issue id or comment
- verifier command output
- non-loop checklist result
- handoff artifact
- blocked record
- fallback record
- commit hash when the harness itself changed

Do not use memory of a conversation as the only evidence for a metric. If the
conversation matters, summarize it into Linear or a repository record first.

## Reporting Cadence

Minimum reporting:

- summarize metrics after each phase
- summarize repeated failure categories before Phase 7 packaging
- create backlog items before changing reusable harness assets

For small projects, per-phase reporting is enough. Do not build dashboards
before the records prove useful.

## Phase 7 Readiness

Phase 7 `Harness Init` can start when:

- Phase 0-6 docs are committed
- at least one full harness task has metric evidence
- known repeated failures are either backlog items or explicitly accepted risks
- loop profile remains optional and explicit
- non-loop profiles have acceptance evidence
- Linear fallback policy has been exercised or documented as untested

If no real task metrics exist yet, Phase 7 may still produce a draft package,
but it must be marked as unvalidated.

Phase 7 package details live in `docs/harness-init.md`.

## Out of Scope

Phase 6 does not implement:

- automated telemetry
- metrics dashboards
- cost accounting integration
- Linear API aggregation scripts
- Notion database automation
- harness-init packaging

Those belong to later implementation work after the metric contract is stable.

## Completion Checklist

Phase 6 is complete when:

- core metrics are defined
- metric record format exists
- repeated failure categories exist
- improvement backlog trigger rules exist
- before/after comparison rules exist
- evidence rules exist
- Phase 7 readiness criteria are defined
