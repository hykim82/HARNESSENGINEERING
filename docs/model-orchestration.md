# Model Orchestration

## Purpose

This document maps Claude Code and Codex Pro-capable sessions to the harness
roles used in a VSCode multi-terminal workflow.

Source snapshot:

- Date checked: 2026-07-02
- Claude Code overview: `https://code.claude.com/docs/en/overview`
- Claude model selection: `https://platform.claude.com/docs/en/about-claude/models/choosing-a-model`
- Codex in ChatGPT: `https://help.openai.com/en/articles/11369540-codex-in-chatgpt`
- Codex models: `https://developers.openai.com/codex/models`
- Codex app features: `https://developers.openai.com/codex/app/features`

Model names and availability can change by account, surface, region, and
rollout. If the UI exposes a newer equivalent model, keep the role boundary and
choose the closest model by capability class.

## Current Model Notes

Claude routing should follow capability class rather than a fixed model string:

- Opus-class Claude: use for high-risk orchestration, architecture decisions,
  ambiguous product intent, and autonomous multi-step coding.
- Sonnet-class Claude: use as the default Coder and normal Orchestrator model
  when speed and capability both matter.
- Haiku-class Claude: use only for small, mechanical, low-risk subtasks when it
  is available.

Codex routing can be more explicit because the Codex model selector exposes
Codex-specific model names:

- `gpt-5.5`: preferred for independent verification, high-risk review, and
  complex coding or research workflows.
- `gpt-5.4`: strong fallback for professional coding, reasoning, and tool use.
- `gpt-5.4-mini`: use for fast, low-risk secondary checks.
- `gpt-5.3-codex-spark`: use for near-instant real-time coding iteration when
  available, not as the sole authority for PASS or high-risk review.

## Engine Strengths

### Claude Code

Claude Code is strongest as the active VSCode command center when the task needs
continuous context management, terminal coordination, file edits, and
implementation judgment in the editor.

Use Claude Code for:

- Orchestrator work that needs multi-terminal coordination
- Coder work inside the active repository
- interpreting broad product intent before splitting work
- maintaining the Task Contract and handoff packets
- deciding whether a task is `loop`, `non-loop`, or `none`

Do not use Claude Code as the only reviewer of its own implementation. The
harness needs independent verification or review evidence.

### Codex

Codex is strongest as an independent verification and review lane because it can
operate in a separate terminal, read the repository, run commands, inspect
outputs, and produce evidence without sharing the coder's assumptions.

Use Codex for:

- loop Verifier work
- independent Reviewer or Spec Auditor work
- command-based evidence capture
- scope and artifact checks
- fast secondary reads of docs, diffs, and terminal output

Do not use Codex Verifier to edit code, tests, or `scripts/verify.sh`.

## Recommended Model Routing

| Role | Preferred engine | Preferred model class | Use when |
| --- | --- | --- | --- |
| Orchestrator | Claude Code | Most capable Claude available, prefer Opus-class for high-risk work and Sonnet-class for normal work | The task needs contract writing, routing, role control, and user-intent preservation |
| Coder | Claude Code | Sonnet-class by default, Opus-class for hard architecture, Haiku-class only for small mechanical changes | The task needs direct implementation in VSCode |
| Verifier | Codex | `gpt-5.5` when available, `gpt-5.4` fallback | The task has a real PASS/FAIL command or loop profile |
| Reviewer | Codex | `gpt-5.5` for high-risk review, `gpt-5.4` for normal review | The task needs independent scope, risk, and evidence assessment |
| Fast checker | Codex | `gpt-5.4-mini` or `gpt-5.3-codex-spark` when available | The task is a quick read, diff scan, or low-risk secondary check |
| Human | User | Not applicable | The task requires final Done, product direction, subjective acceptance, or irreversible approval |

Routing rules:

- Use Claude Code as `[ORCH-CLAUDE]` because the user selected Claude as the
  Orchestrator.
- Use Claude Code as `[CODER-CLAUDE]` for implementation unless the Task
  Contract explicitly assigns coding to Codex.
- Use Codex as `[VERIFY-CODEX]` for loop verification so the verifier is
  independent from the coder.
- Use Codex as `[REVIEW-CODEX]` for reviewer or spec-auditor work so the review
  is independent from the orchestrator and coder.
- Use smaller or faster models only for non-authoritative checks. Final
  verifier PASS and high-risk review should use the strongest available Codex
  model.

## Objective Handoff Assessment

The current Claude Orchestrator handoff package is understandable enough for a
careful Claude Code session to start.

It is not sufficient by itself for reliable multi-agent operation unless the
following gaps are closed:

- model-specific routing criteria
- a pre-work question channel
- blocking versus non-blocking question status
- explicit assumptions in handoff packets
- confidence level for handoff quality
- escalation rules when Orchestrator cannot answer

Without these fields, Claude Code can still understand the intended role, but
it may proceed on assumptions when the correct behavior is to ask the
Orchestrator or Human first.

## Pre-Work Question Channel

Every role may ask the Orchestrator a question before work starts.

Primary channel:

- Linear issue comments

Fallback channel:

- `docs/harness-records.md` when Linear is unavailable and work must continue
- direct chat with the Human when the decision is urgent or subjective

Blocking rule:

- If a question affects scope, profile, acceptance criteria, write scope,
  protected artifacts, loop installation, test freeze, or irreversible action,
  the role must stop until Orchestrator answers or escalates to Human.

Non-blocking rule:

- If a question only improves context and the Task Contract already permits a
  safe path, the role may proceed after recording the assumption.

Question statuses:

- `blocking`: work must stop for the asking role
- `non_blocking`: work may continue with a recorded assumption
- `answered`: Orchestrator answered and the role can proceed
- `escalated`: Human or external owner must decide

Use `templates/harness-init/question-packet.template.md` for the durable format.

## Orchestrator Response Rule

The Orchestrator must answer each blocking question with one of:

- a direct decision
- a narrowed write scope
- a revised Task Contract
- an escalation to Human
- cancellation or split of the task

The Orchestrator must not ask Coder, Verifier, or Reviewer to continue while a
blocking question is open for that role.
