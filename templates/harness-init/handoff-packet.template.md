# Handoff Packet

Use this packet when Claude Orchestrator hands work to Codex Verifier or Codex
Reviewer.

```yaml
handoff_packet:
  issue: "LINEAR_OR_LOCAL_TASK_ID"
  from: "Claude Orchestrator"
  to: "Codex Verifier | Codex Reviewer"
  profile: "loop | non-loop | none"
  non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
  goal: "ONE_SENTENCE_GOAL"
  task_contract_location: "PATH_OR_LINEAR_COMMENT"
  write_scope:
    - "PATH_OR_NONE"
  protected_artifacts:
    - "PATH_OR_DECISION"
  changed_artifacts:
    - "PATH_OR_LINEAR_COMMENT"
  evidence_so_far:
    - "COMMAND_CHECKLIST_ARTIFACT_OR_NONE"
  requested_action: "verify | review | spec-audit"
  known_gaps:
    - "GAP_OR_NONE"
  next_owner_after_response: "Claude Orchestrator"
```
