# Question Packet

Use this packet when Coder, Verifier, Reviewer, or Spec Auditor needs an answer
from Claude Orchestrator before work starts or before continuing.

Post the packet in the active Linear issue comment thread. If Linear is
unavailable and work must continue, record it in the Task Contract fallback
path.

```yaml
question_packet:
  issue: "LINEAR_OR_LOCAL_TASK_ID"
  question_id: "Q-YYYYMMDD-NN"
  from_role: "Coder | Verifier | Reviewer | Spec Auditor"
  from_engine: "Claude Code | Codex"
  to: "Claude Orchestrator"
  status: "blocking | non_blocking | answered | escalated"
  related_contract_field: "goal | profile | acceptance | write_scope | protected_artifacts | loop_installation | freeze_point | evidence | other"
  question: "ONE_CLEAR_QUESTION"
  why_it_matters: "WHAT_CAN_GO_WRONG_IF_NOT_ANSWERED"
  proposed_safe_assumption: "ASSUMPTION_OR_NONE"
  needed_before: "before_coding | before_verification | before_review | before_in_review"
  orchestrator_answer: "ANSWER_OR_EMPTY_UNTIL_ANSWERED"
  escalated_to_human: "yes | no"
```

Blocking questions stop the asking role. Non-blocking questions may proceed only
when the proposed safe assumption is recorded.

