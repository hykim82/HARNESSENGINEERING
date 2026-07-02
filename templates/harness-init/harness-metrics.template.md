# Harness Metrics

Use this template when a task needs a repository-local metric record or Linear
is unavailable.

```yaml
harness_metric:
  issue: "LINEAR_OR_LOCAL_TASK_ID"
  profile: "loop | non-loop | none"
  non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
  outcome: "in_review | blocked | canceled | returned_for_changes"
  task_started_at: "YYYY-MM-DD HH:mm TIMEZONE"
  task_finished_at: "YYYY-MM-DD HH:mm TIMEZONE_OR_NONE"
  verification:
    command: "COMMAND_OR_NONE"
    result: "pass | fail | not_applicable | unavailable"
  review:
    result: "ready_for_review | needs_changes | blocked | not_applicable"
  retries:
    count: 0
    reasons:
      - "REASON_OR_NONE"
  human_escalations:
    count: 0
    reasons:
      - "REASON_OR_NONE"
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
  failure_category: "CATEGORY_OR_NONE"
```
