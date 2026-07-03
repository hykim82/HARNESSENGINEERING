# Harness Init Package

This directory contains an opt-in package for applying HARNESSENGINEERING
rules to a future project.

Status:

```text
stable
```

Validated on two separate target repositories (non-loop: Linear HYK-69; loop:
Linear HYK-76). See `docs/harness-init.md` for the full status and evidence.
Use this package only after the target project owner explicitly asks to apply
the harness.

## Files

- `AGENTS.append.md`: append-only project instruction snippet
- `task-contract.template.md`: task contract template
- `non-loop-evidence.template.md`: non-loop evidence template
- `harness-records.template.md`: Linear outage fallback record template
- `harness-progress.template.md`: long-running progress template
- `harness-metrics.template.md`: evaluation metric template
- `model-routing.template.md`: engine and model routing template
- `claude-orchestrator-prompt.template.md`: Claude Code Orchestrator prompt
- `codex-verifier-prompt.template.md`: Codex Verifier prompt
- `codex-reviewer-prompt.template.md`: Codex Reviewer prompt
- `handoff-packet.template.md`: Claude-to-Codex handoff packet
- `question-packet.template.md`: role-to-Orchestrator question packet
- `phase-handoff.template.md`: phase-boundary handoff for session rotation
- `status.template.md`: short "where am I" status board
- `skill/SKILL.md`: draft skill instructions

## Rules

- Do not overwrite existing target files.
- Do not install loop profile by default.
- Do not create Linear projects without asking.
- Do not write global Codex assets.
- Record all installed files in Linear.
- Loop verification commands assume bash; on Windows, Git Bash is required.
- Default installation copies only the target files listed in
  `docs/harness-init.md`; packet and prompt templates are referenced from this
  package unless explicitly requested.
- Role relay uses `.harness/<role>-task.md` (orchestrator to role) and
  `.harness/<role>.md` (role to orchestrator); add `.harness/` to the target
  repo `.gitignore`.
- Roles end each task with `>>> DONE: <role>` and a human-next-action line.
  Full protocol: `docs/claude-orchestrator-handoff.md` (Relay Protocol v2).
- At phase boundaries the Orchestrator writes `.harness/PHASE-HANDOFF.md` and
  keeps `.harness/STATUS.md` current so a fresh session resumes cheaply; the
  Orchestrator ends every response with an `— YYYY-MM-DD HH:MM KST` timestamp.
  Rules: `docs/claude-orchestrator-handoff.md` (Phase Handoff and Session
  Rotation, Orchestrator Timestamp).

## Suggested Install

1. Read the target repository instructions.
2. Confirm the Linear project.
3. Ask the user to approve harness installation.
4. Append `AGENTS.append.md` only if equivalent rules are missing.
5. Copy selected templates into target `docs/`.
6. Record the installed paths.
7. Leave loop profile uninstalled unless explicitly requested.
8. Start Claude Code with `claude-orchestrator-prompt.template.md` when using
   Claude as the primary Orchestrator.
9. Give every role access to `question-packet.template.md` before work starts.
