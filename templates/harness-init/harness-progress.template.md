# Harness Progress

Use this file only when long-running work needs a repository-local progress
record or Linear is unavailable.

```yaml
progress_record:
  issue: "LINEAR_OR_LOCAL_TASK_ID"
  profile: "loop | non-loop | none"
  current_owner: "ROLE_OR_AGENT"
  state: "not_started | in_progress | waiting_for_verifier | waiting_for_reviewer | blocked | ready_for_review"
  last_completed_step: "SPECIFIC_STEP"
  next_step: "SPECIFIC_NEXT_STEP"
  open_locks:
    - "PATH_OR_NONE"
  evidence_so_far:
    - "COMMAND_ARTIFACT_CHECKLIST_RESULT_OR_NONE"
  blockers:
    - "BLOCKER_OR_NONE"
  updated_at: "YYYY-MM-DD HH:mm KST"
```
