# Task Contract

```yaml
task_contract:
  id: "LINEAR_OR_LOCAL_TASK_ID"
  project: "PROJECT_NAME"
  title: "SHORT_TITLE"
  goal: "ONE_SENTENCE_GOAL"

  profile:
    type: "loop | non-loop | none"
    non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
    reason: "WHY_THIS_PROFILE_IS_CORRECT"

  scope:
    in:
      - "ALLOWED_WORK"
    out:
      - "EXCLUDED_WORK"

  completion_conditions:
    - "FIXED_CONDITION"

  # Observability standard (HYK-102): for a task that builds or changes a
  # screen/feature, (1) run the machine check (./observe.sh, or a
  # task-specified command) and report its real cmd + exit code, (2) report
  # anything the machine cannot confirm (rendering, interaction, etc.)
  # honestly in the final report's "limitations" section -- never claim
  # "verified" for something only a human eye could actually confirm.
  verification:
    command: "COMMAND_OR_NONE"
    source_of_truth:
      - "DOCUMENT_ISSUE_FILE_OR_HUMAN_DECISION"
    review_checklist:
      - "CHECK_ITEM"
    expected_artifact_location:
      - "PATH_OR_EXTERNAL_RECORD"
    human_acceptance_required: true

  loop:
    applies: false
    structured_test_cases: []
    test_freeze:
      pre_freeze_allowed_changes:
        - "NEW_OR_STRENGTHENED_TESTS_FOR_RED"
      freeze_point: "AFTER_RED_OR_EXPLICIT_APPROVAL"
      protected_after_freeze:
        - "completion conditions"
        - "verify script"
        - "frozen tests"

  artifacts:
    expected_changes:
      - "PATH_OR_AREA"
    protected:
      - "PATH_OR_DECISION"
    external_records:
      - "Linear"

  fallbacks:
    linear_unavailable: "report immediately and record locally if work continues"
    notion_unavailable: "report immediately and keep Linear or repository note"
    docs_only_no_checks: "do not treat SKIP 0 as PASS"
    # HYK-112: a real incident lost 30 minutes and ~20K tokens to a worker
    # retrying the same failing push 10+ times against a down infra
    # dependency instead of stopping. This applies to every role reading
    # this contract (Coder, Verifier, Reviewer) -- one shared entry here
    # instead of duplicating the line into each role's own prompt template.
    infra_error_repeat: "same command or access failing with the same error 2-3 times in a row: stop immediately regardless of cause, report what is done + exactly where it is stuck (command, error, attempt count) via question_packet, and wait for Orchestrator confirmation before any further retry. A retry after a real fix is progress (fine); repeating the identical attempt is a loop (stop)."

  roles:
    orchestrator: "CONTRACT_AND_PROFILE_OWNER"
    coder: "IMPLEMENTATION_OR_ARTIFACT_OWNER"
    verifier: "LOOP_COMMAND_OWNER_OR_NONE"
    reviewer: "RISK_AND_ACCEPTANCE_OWNER"
    human: "AMBIGUITY_AND_DONE_OWNER"
```
