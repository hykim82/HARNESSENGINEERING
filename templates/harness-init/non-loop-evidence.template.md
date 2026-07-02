# Non-Loop Evidence

```yaml
non_loop_evidence:
  issue: "LINEAR_OR_LOCAL_TASK_ID"
  profile: "research | documentation | ui-review | product-spec-review"
  source_of_truth:
    - "DOCUMENT_URL_ISSUE_SCREENSHOT_CODE_OR_HUMAN_DECISION"
  artifact:
    location: "PATH_LINEAR_COMMENT_NOTION_PAGE_OR_SCREENSHOT_FOLDER"
    type: "BRIEF_DOCUMENT_REVIEW_REPORT_OR_SPEC_REVIEW"
  checklist_results:
    - item: "CHECKLIST_ITEM"
      result: "met | gap | not_applicable"
      evidence: "CONCRETE_EVIDENCE"
  unresolved_gaps:
    - "GAP_RISK_AMBIGUITY_OR_NONE"
  acceptance:
    required_by: "human | reviewer | explicit check command"
    status: "ready_for_review | needs_changes | blocked"
```
