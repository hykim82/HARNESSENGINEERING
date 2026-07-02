---
name: harness-init
description: Draft skill for explicitly applying HARNESSENGINEERING rules and templates to a target repository without automatic file pollution.
---

# Harness Init

Use this draft skill only when the user explicitly asks to apply the harness to
the current repository.

## Hard Rules

- Do not run automatically when a repository is opened.
- Do not overwrite existing files.
- Do not install loop profile by default.
- Do not create a Linear project without asking.
- Do not edit global Codex assets in draft mode.

## Procedure

1. Read target `AGENTS.md` if it exists.
2. Determine the Linear project from `Linear-Project:` or repository name.
3. Check whether the Linear project exists.
4. Ask before creating a missing Linear project.
5. Inspect whether harness files already exist.
6. Show the files that would be created or appended.
7. Ask for explicit approval.
8. Append project instructions only if equivalent rules are missing.
9. Copy selected templates without overwriting files.
10. Record installed paths in Linear.
11. Report that loop profile remains uninstalled unless separately requested.
12. If Claude Code is the Orchestrator, provide
    `claude-orchestrator-prompt.template.md` and require handoff packets before
    Codex verifier or reviewer work.
13. Provide `model-routing.template.md` and
    `question-packet.template.md` so each role can choose the right engine and
    ask the Orchestrator before work when scope is unclear.

## Template Source

Use templates from:

```text
templates/harness-init/
```

## Completion Report

Report:

- installed files
- skipped existing files
- Linear issue used
- loop profile status
- question channel location
- any fallback records
