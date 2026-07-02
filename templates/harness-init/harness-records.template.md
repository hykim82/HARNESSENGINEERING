# Harness Records

Use this file only when Linear is unavailable or when the Task Contract requires
a repository-local record.

```yaml
harness_record:
  issue: "LINEAR_OR_LOCAL_TASK_ID"
  attempted_linear_action: "ACTION"
  failure_reason: "FAILURE_POINT"
  fallback_recorded_at: "YYYY-MM-DD HH:mm KST"
  profile: "loop | non-loop | none"
  evidence_that_would_have_been_posted:
    - "EVIDENCE"
  backfill_required: true
```
