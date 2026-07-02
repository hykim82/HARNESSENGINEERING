# Claude Code Orchestrator Handoff

## Purpose

This document prepares Claude Code to act as the primary Orchestrator in a
VSCode multi-terminal workflow.

The harness roles do not change. Only the tool assignment changes:

- Claude Code becomes the primary Orchestrator.
- Claude Code or another implementation session may act as Coder.
- Codex is preferred for Verifier and Reviewer.
- Human keeps final Done authority.

## Recommended VSCode Terminals

```text
[ORCH-CLAUDE]   Claude Code, Orchestrator
[CODER-CLAUDE]  Claude Code, Coder
[VERIFY-CODEX]  Codex, Verifier
[REVIEW-CODEX]  Codex, Reviewer or Spec Auditor
```

Use terminal names consistently. Do not let one terminal silently change roles.

## Role Mapping

| Harness role | Preferred tool | Reason |
| --- | --- | --- |
| Orchestrator | Claude Code | User-selected command center for vibe coding in VSCode |
| Coder | Claude Code | Strong fit for implementation in the active editor |
| Verifier | Codex | Keeps verification independent from the coder/orchestrator |
| Reviewer | Codex | Independent scope, risk, and evidence review |
| Human | User | Final Done, ambiguous intent, irreversible decisions |

Claude may review only when Codex is unavailable or when the Task Contract names
Claude as reviewer. Claude must not review its own implementation as the only
review evidence.

## Claude Orchestrator Duties

Claude Orchestrator must:

- read `AGENTS.md`
- identify the Linear project
- create or connect the Linear issue
- write the Task Contract
- choose exactly one profile: `loop`, `non-loop`, or `none`
- choose the non-loop subtype when needed
- declare write scope and protected artifacts
- assign Coder, Verifier, Reviewer, and Human roles
- produce handoff packets between terminals
- move AI-managed work only to In Review

Claude Orchestrator must not:

- move Linear issues to Done
- call `verify.sh` PASS without an independent verifier run
- install loop profile without human approval
- let Coder edit outside write scope
- hide reviewer gaps or verifier failures

## Codex Verifier Duties

Codex Verifier applies only to loop tasks.

Codex Verifier must:

- read the Task Contract and handoff packet
- run the real verification command
- record command, exit code, and output summary
- return PASS or FAIL based on actual output

Codex Verifier must not:

- edit code
- edit tests
- edit `scripts/verify.sh`
- convert non-loop work into a fake loop PASS

## Codex Reviewer Duties

Codex Reviewer checks:

- scope adherence
- protected artifacts
- missing evidence
- non-loop profile checklist
- risk, ambiguity, and handoff quality

Codex Reviewer must not:

- replace `verify.sh` for loop tasks
- make final Human acceptance decisions
- approve work outside the Task Contract

## Claude-to-Codex Handoff

Before asking Codex to verify or review, Claude should provide:

```yaml
handoff_packet:
  issue: "<Linear issue id>"
  from: "Claude Orchestrator"
  to: "Codex Verifier | Codex Reviewer"
  profile: "loop | non-loop | none"
  non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
  goal: "<one sentence>"
  write_scope:
    - "<path or none>"
  protected_artifacts:
    - "<path or decision>"
  changed_artifacts:
    - "<path or Linear comment>"
  evidence_so_far:
    - "<command, checklist, artifact, or none>"
  requested_action: "<verify | review | spec-audit>"
  known_gaps:
    - "<gap or none>"
```

## Session Start Checklist

Claude Orchestrator should run this checklist at the beginning of each task:

1. Confirm the target repository.
2. Read `AGENTS.md`.
3. Confirm Linear project.
4. Check if any In Progress issue already exists.
5. Create or connect the issue.
6. Write the Task Contract.
7. Choose profile and non-loop subtype if needed.
8. Assign terminal roles.
9. Post role assignment in Linear.
10. Start Coder only after scope is fixed.

## Completion Checklist

Claude Orchestrator can move work to In Review when:

- Task Contract exists
- profile evidence exists
- Codex verifier PASS exists for loop tasks
- Codex reviewer or spec auditor evidence exists for non-loop tasks
- gaps are resolved or explicitly listed
- Linear has a completion comment

Claude Orchestrator must stop at In Review. Human moves Done.

## First Validation Scenario

Use this scenario before calling the Claude Orchestrator setup stable:

1. Pick a separate target repository.
2. Start `[ORCH-CLAUDE]`.
3. Apply harness-init draft with explicit approval.
4. Create one small non-loop documentation task.
5. Have `[CODER-CLAUDE]` produce the artifact.
6. Send a handoff packet to `[REVIEW-CODEX]`.
7. Record review evidence in Linear.
8. Move issue to In Review.
9. Record one harness metric.

Do not test with a large feature first.
