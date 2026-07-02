# Harness Init Draft Package

This directory contains a draft opt-in package for applying HARNESSENGINEERING
rules to a future project.

Status:

```text
draft / unvalidated
```

Use this package only after the target project owner explicitly asks to apply
the harness.

## Files

- `AGENTS.append.md`: append-only project instruction snippet
- `task-contract.template.md`: task contract template
- `non-loop-evidence.template.md`: non-loop evidence template
- `harness-records.template.md`: Linear outage fallback record template
- `harness-progress.template.md`: long-running progress template
- `harness-metrics.template.md`: evaluation metric template
- `claude-orchestrator-prompt.template.md`: Claude Code Orchestrator prompt
- `codex-verifier-prompt.template.md`: Codex Verifier prompt
- `codex-reviewer-prompt.template.md`: Codex Reviewer prompt
- `handoff-packet.template.md`: Claude-to-Codex handoff packet
- `skill/SKILL.md`: draft skill instructions

## Rules

- Do not overwrite existing target files.
- Do not install loop profile by default.
- Do not create Linear projects without asking.
- Do not write global Codex assets in draft mode.
- Record all installed files in Linear.

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
