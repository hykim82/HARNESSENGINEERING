# Claude Code Orchestrator Handoff

## Purpose

This document prepares Claude Code to act as the primary Orchestrator in a
VSCode multi-terminal workflow.

Read this together with:

- `docs/multi-agent-v1.md`
- `docs/model-orchestration.md`
- `templates/harness-init/claude-orchestrator-prompt.template.md`
- `templates/harness-init/handoff-packet.template.md`
- `templates/harness-init/question-packet.template.md`

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

For model-level routing, use `docs/model-orchestration.md`. In short:

- Claude Code owns orchestration and primary implementation.
- Codex owns independent verification and review.
- use the strongest available model for Orchestrator, Verifier, and high-risk
  Reviewer work.
- use faster models only for low-risk secondary checks.

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
- answer or escalate pre-work question packets
- move AI-managed work only to In Review
- write `.harness/PHASE-HANDOFF.md` at each phase boundary and end phase-end
  reports with an "open a new session" boot line
- end every response with an `— YYYY-MM-DD HH:MM KST` timestamp

Claude Orchestrator must not:

- move Linear issues to Done
- call `verify.sh` PASS without an independent verifier run
- install loop profile without human approval
- let Coder edit outside write scope
- hide reviewer gaps or verifier failures
- let a role continue while its blocking question is open

## Pre-Work Questions

Coder, Verifier, Reviewer, and Spec Auditor may ask Claude Orchestrator a
question before starting their assigned work.

Use `templates/harness-init/question-packet.template.md`.

Questions must be treated as blocking when they affect:

- scope
- profile
- acceptance criteria
- write scope
- protected artifacts
- loop installation
- test freeze
- irreversible action

Claude Orchestrator answers in the Linear issue comment thread when possible.
If Linear is unavailable, use the fallback record path named in the Task
Contract. If the answer requires product direction or final acceptance, Claude
Orchestrator escalates to Human.

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

The canonical handoff format is `templates/harness-init/handoff-packet.template.md`.
This section mirrors it for convenience; if the two ever differ, the template
wins.

```yaml
handoff_packet:
  issue: "<Linear issue id>"
  from: "Claude Orchestrator"
  to: "Codex Verifier | Codex Reviewer"
  profile: "loop | non-loop | none"
  non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
  goal: "<one sentence>"
  task_contract_location: "<path or Linear comment>"
  write_scope:
    - "<path or none>"
  protected_artifacts:
    - "<path or decision>"
  changed_artifacts:
    - "<path or Linear comment>"
  evidence_so_far:
    - "<command, checklist, artifact, or none>"
  assumptions:
    - "<assumption or none>"
  open_questions:
    - "<question id or none>"
  blocking_questions:
    - "<question id or none>"
  question_channel: "<Linear issue comment thread or fallback path>"
  requested_action: "<verify | review | spec-audit>"
  known_gaps:
    - "<gap or none>"
  decision_needed_by: "ORCHESTRATOR | HUMAN | NONE"
  confidence: "high | medium | low"
  next_owner_after_response: "Claude Orchestrator"
```

## Windows Headless Execution

These rules were validated in HYK-69 on Windows:

- Coder can run as a headless Claude Code session: pipe the prompt file into
  `claude -p --permission-mode acceptEdits --allowedTools "Bash(git:*)"` with
  the target repository as working directory.
- Verifier and Reviewer can run as headless Codex: pipe the prompt into
  `codex exec --sandbox read-only -C <repo> -`. Always pipe stdin; launching
  `codex exec` detached without closing stdin hangs on "Reading additional
  input from stdin".
- The Codex read-only sandbox may intermittently fail to launch processes
  (`CreateProcessAsUserW failed: 5`). The reviewer must substitute equivalent
  read-only evidence and state the limitation instead of guessing.
- Subagent spawning via the OMC plugin requires WSL + tmux on Windows; headless
  CLI sessions are the validated fallback.
- Monitor live output by opening the background output file or
  `Get-Content <output-file> -Wait`.
- These headless sessions keep the same role boundaries; the launcher
  (Orchestrator) does not gain the launched role's authority.
- Codex on Windows may run its shell under WSL2 (Linux), where the Windows
  Node install is reachable only as `node.exe` via `/mnt/c/...` and not as
  bare `node`. Loop verify scripts must resolve a node runner (`node` or
  `node.exe`) rather than assume `node` is on PATH.
- Before relying on the verifier, run a one-shot pre-check of the real verify
  command inside the verifier's own environment; a spurious FAIL there is an
  environment problem, not a code failure.

## Relay Protocol v2 (File Drop)

Purpose: eliminate copy/paste between the human operator and role terminals.

- The orchestrator writes each role's next task to `.harness/<role>-task.md`
  (roles: coder, verify, review).
- The human types a short trigger `go` in the role terminal; the role reads
  `.harness/<role>-task.md` and executes.
- The role writes its result or handoff to `.harness/<role>.md` (not long
  terminal output) and ends with exactly two lines: `>>> DONE: <role>` and a
  human-next-action line (for example, tell the Orchestrator "<role> 됐어").
- Blocking-question variant: the role writes a question_packet to
  `.harness/<role>.md` and ends with `>>> QUESTION: <role>` plus a
  human-next-action line; the role does not start work.
- The orchestrator reads `.harness/<role>.md` directly (no paste needed) and
  records the result to Linear.
- `.harness/` MUST be gitignored: it holds transient relay state, not project
  code.
- Role terminals do not touch Linear; the orchestrator is the sole Linear
  scribe.
- This keeps role independence: launching or relaying a role's task does not
  grant the launcher that role's authority.

## Phase Handoff and Session Rotation

A long orchestrator session grows expensive and hard to resume. Rotate to a
fresh session at phase boundaries with a cheap, durable handoff instead of
replaying history.

- The Orchestrator cannot open a new window or `/clear` itself; that is a human
  or runtime action. These rules only remove the friction around it.
- At the end of each phase, the Orchestrator writes `.harness/PHASE-HANDOFF.md`
  with, at minimum:
  - previous phase result (done / not done)
  - what changed this phase (changes)
  - improvements folded in (improvements)
  - unresolved problems and backlog carried to the next phase
  - the first action for the next phase
- The Orchestrator also keeps `.harness/STATUS.md` as a short "where am I"
  board (current position, human's next action, issue states, relay rules).
- Every phase-end report ends with an explicit "open a new session" line plus a
  one-line boot prompt the human can paste to resume.
- A new Orchestrator session boots by reading `.harness/PHASE-HANDOFF.md` and
  `.harness/STATUS.md` if present, plus the named Linear issues — nothing else
  until needed. See the boot line in
  `templates/harness-init/claude-orchestrator-prompt.template.md`.
- When booting this way, also compare STATUS issue states against Linear for
  the named issues (see Session Start Checklist). Treat Linear as the source
  of truth on drift and rewrite STATUS before continuing.
- Templates: `phase-handoff.template.md` and `status.template.md` in
  `templates/harness-init/`. Both live under gitignored `.harness/` in the
  target repo, alongside the relay files.

## Orchestrator Timestamp

- The Orchestrator ends every response with its output time as
  `— YYYY-MM-DD HH:MM KST`. This pairs with the `>>> DONE: <role> @ <time>`
  lines so the human can order events across terminals.

## Session Start Checklist

Claude Orchestrator should run this checklist at the beginning of each task:

1. Confirm the target repository.
2. Read `AGENTS.md`. Read `.harness/PHASE-HANDOFF.md` and `.harness/STATUS.md`
   if present, to resume a rotated session cheaply. Compare `STATUS.md` issue
   states against the actual Linear issue states for the named issues; if
   they drift, treat Linear as the source of truth and rewrite `STATUS.md`
   to match before continuing.
3. Confirm Linear project.
4. Check if any In Progress issue already exists.
5. Create or connect the issue.
6. Write the Task Contract.
7. Choose profile and non-loop subtype if needed.
8. Select model routing from `docs/model-orchestration.md`.
9. Assign terminal roles.
10. Post role assignment in Linear.
11. Start Coder only after scope is fixed and blocking questions are closed.

## Completion Checklist

Claude Orchestrator can move work to In Review when:

- Task Contract exists
- profile evidence exists
- blocking questions are answered or escalated
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
7. Send a question packet from `[REVIEW-CODEX]` to `[ORCH-CLAUDE]` and record
   the answer.
8. Record review evidence in Linear.
9. Move issue to In Review.
10. Record one harness metric.

Do not test with a large feature first.
