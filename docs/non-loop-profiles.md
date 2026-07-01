# Non-Loop Profiles

## Purpose

Non-loop profiles cover valuable work that cannot be judged by one command
returning PASS/FAIL.

They exist so the harness does not force research, documentation, UI judgment,
or product/spec review through the loop profile. A skipped `verify.sh` run is
not evidence for these tasks.

Non-loop work is still accountable. It must define:

- source of truth
- review checklist
- expected artifact location
- acceptance rule
- unresolved gaps or risks

## Relationship to the Task Contract

`docs/task-contract.md` defines the common `non-loop` fields. This document
defines concrete profile templates that fill those fields.

Use exactly one non-loop subtype:

```text
non_loop_profile: research | documentation | ui-review | product-spec-review
```

If a task can be judged by `bash -lc "./scripts/verify.sh"`, use the loop
profile instead. If a task changes code, runtime behavior, tests, or command
output, reclassify it before continuing.

## Common Evidence Format

Every non-loop task should leave evidence in this shape, either in Linear, a
repository document, or the artifact named by the task contract.

```yaml
non_loop_evidence:
  profile: "research | documentation | ui-review | product-spec-review"
  source_of_truth:
    - "<document, URL, issue, screenshot, code file, or human decision>"
  artifact:
    location: "<path, Linear comment, Notion page, Figma link, or screenshot folder>"
    type: "<brief, document, review report, annotated screenshots, spec review>"
  checklist_results:
    - item: "<checklist item>"
      result: "met | gap | not_applicable"
      evidence: "<short concrete evidence>"
  unresolved_gaps:
    - "<gap, risk, ambiguity, or none>"
  acceptance:
    required_by: "human | reviewer | explicit check command"
    status: "ready_for_review | needs_changes | blocked"
```

Avoid using `PASS` for non-loop work unless the contract defines a separate
check command. The default result is a review state, not a verifier result.

## Profile Selection

Use this selection order:

1. Use `research` when the main output is synthesized knowledge.
2. Use `documentation` when the main output is a durable document update.
3. Use `ui-review` when the main output is visual or interaction judgment.
4. Use `product-spec-review` when the main output is evaluating intent, scope,
   acceptance criteria, or product risk.

If two profiles seem to apply, choose the one that matches the final artifact.
For example, a report about UI screenshots is `ui-review`, not `documentation`,
because the document is only the container for visual judgment.

## Research Profile

Use for:

- external or internal research synthesis
- comparison reports
- technical option analysis
- current-state investigation
- Notion or repository knowledge review

Source of truth:

- named source documents or URLs
- repository files being investigated
- current date when facts may be time-sensitive
- explicit human assumptions

Required artifact:

- research brief
- Linear comment
- repository document
- Notion page when requested by the task contract

Checklist:

- The research question is stated in one sentence.
- Sources are named and linked when links exist.
- Time-sensitive claims include the checked date.
- Direct quotes are short and used only when needed.
- Facts, inferences, and recommendations are separated.
- Conflicting evidence is reported instead of hidden.
- Unknowns are listed as unknowns.
- The final recommendation is tied to the evidence.

Acceptance rule:

- Human acceptance is required when the recommendation affects architecture,
  budget, legal/medical/financial judgment, or irreversible direction.
- Reviewer acceptance is enough for low-risk internal summaries when the task
  contract says so.

Failure conditions:

- No named sources.
- Recommendation appears without evidence.
- Time-sensitive facts are treated as stable without verification.
- The artifact cannot be found at the expected location.

## Documentation Profile

Use for:

- design documents
- operating rules
- README or setup guide updates
- phase reports
- process documentation
- migration notes

Source of truth:

- existing repository documents
- Linear issue description or comments
- user decisions in the current thread
- relevant code or configuration files if the document describes behavior

Required artifact:

- markdown document
- Linear comment
- Notion page when requested
- updated repository guide

Checklist:

- The document has a clear purpose and audience.
- It does not contradict existing higher-priority docs.
- It states scope and out-of-scope items.
- It has no unresolved placeholder markers.
- It distinguishes current behavior from planned behavior.
- It names where future agents should find source material.
- If it describes verification, it does not call docs-only SKIP 0 a PASS.
- If it changes an operating rule, the change is recorded in Linear.

Acceptance rule:

- Human acceptance is required for policy, workflow, or project-direction docs.
- Reviewer acceptance is enough for mechanical documentation updates when the
  source behavior is already fixed and unambiguous.

Failure conditions:

- The document conflicts with the task contract.
- The target artifact is missing.
- The document describes desired future behavior as if it already exists.
- Placeholders remain in the final artifact.

## UI Review Profile

Use for:

- design QA
- screenshot review
- prototype review
- responsive layout inspection
- visual regression assessment when no automated visual test exists
- accessibility and interaction notes that require judgment

Source of truth:

- screenshots
- local or deployed URL
- Figma file or prototype
- product requirements
- target viewport list
- design system rules when available

Required artifact:

- review report
- annotated screenshots
- Linear comment with findings
- Figma or Notion artifact when requested

Checklist:

- The reviewed target and capture method are named.
- Desktop and mobile viewports are checked when relevant.
- Text overflow, clipping, overlap, and unreadable contrast are checked.
- Primary user flows are inspected, not only the first screen.
- Interactive states are checked when they affect the task.
- Accessibility risks are called out separately from visual polish.
- Findings include severity and concrete location.
- Subjective judgment is labeled as judgment, not objective failure.

Acceptance rule:

- Human acceptance is required for final visual taste, brand fit, and product
  direction.
- Reviewer acceptance can mark the issue ready for human review when findings
  are complete and evidence is attached.

Failure conditions:

- No screenshot, URL, prototype, or visible target is named.
- Only one viewport is checked when responsiveness is part of the task.
- Findings are vague and cannot be acted on.
- Visual acceptance is claimed without human review when the contract requires
  it.

## Product/Spec Review Profile

Use for:

- PRD review
- phase-plan review
- acceptance criteria review
- product risk review
- scope and dependency review
- multi-agent handoff readiness review

Source of truth:

- PRD or spec document
- roadmap
- Linear issue
- user-stated goal
- existing architecture or process documents
- relevant implementation constraints

Required artifact:

- spec review report
- Linear comment
- repository decision document
- change request list

Checklist:

- The user goal is stated and preserved.
- In-scope and out-of-scope work are explicit.
- Acceptance criteria are testable or reviewable.
- Dependencies and blockers are named.
- Risky assumptions are called out.
- The spec does not mix current state with future state.
- The next owner can act without reading the entire chat history.
- Multi-agent handoff boundaries are explicit when agents are involved.

Acceptance rule:

- Human acceptance is required when the review changes product direction,
  phase order, or role ownership.
- Reviewer acceptance is enough to move the issue to In Review when the report
  only summarizes risks and does not decide them.

Failure conditions:

- Acceptance criteria remain ambiguous.
- The review silently changes the user's goal.
- The artifact lacks a concrete recommendation or blocker list.
- The next phase cannot start from the report.

## Docs-Only Guardrail

Docs-only work must not be treated as loop success because executable checks
were skipped.

For docs-only tasks:

- `verify.sh` SKIP with exit code 0 is not a meaningful PASS.
- A placeholder scan is useful evidence but not sufficient by itself.
- The task contract must name source of truth, checklist, artifact, and
  acceptance rule.
- If a markdown lint or link check exists, it can be added as an extra command,
  but it does not replace human or reviewer acceptance for judgment-heavy docs.

Minimum acceptable docs-only evidence:

```text
source of truth: <named docs or issue>
artifact: <path or external record>
checklist: <items checked>
gaps: <none or listed>
acceptance: <ready_for_review | needs_changes | blocked>
```

## Reviewer Boundary

For non-loop tasks, the reviewer or spec auditor checks the evidence packet.

Reviewer may:

- mark checklist items as met, gap, or not applicable
- request missing sources or screenshots
- report contradictions
- recommend In Review when evidence is complete

Reviewer must not:

- call non-loop work `PASS` without an explicit check command
- replace human acceptance for subjective product or visual decisions
- reinterpret loop verifier output
- approve changes outside the task contract scope

## Phase 4 Handoff

Phase 4 multi-agent design can use these boundaries:

- Orchestrator selects the non-loop subtype and fixes the checklist.
- Worker produces the artifact.
- Reviewer or Spec Auditor evaluates the artifact against this document.
- Human resolves subjective acceptance and final Done.

The first multi-agent version should support one non-loop reviewer role before
adding parallel reviewers.

## Completion Checklist

Phase 3 is complete when:

- research, documentation, UI review, and product/spec review profiles exist
- each profile defines source of truth, checklist, artifact, and acceptance
- docs-only SKIP 0 is explicitly rejected as proof
- reviewer boundaries are explicit for Phase 4
- `docs/task-contract.md` and `docs/harness-core-mvp.md` can reference this
  document without contradiction
