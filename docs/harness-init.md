# Harness Init

## Purpose

Phase 7 packages the HARNESSENGINEERING rules into a draft opt-in asset for
future projects.

The package must not automatically modify new repositories. It should help a
human or orchestrator install the harness only after an explicit request.

Status:

```text
draft / unvalidated
```

Reason:

- Phase 0-6 design documents exist and are committed.
- The package has not yet been validated on a separate target project.
- No global `harness-init` skill has been installed from this repository.

## Package Contents

Local package path:

```text
templates/harness-init/
```

Contents:

- `README.md`: package usage guide
- `AGENTS.append.md`: project instruction snippet
- `task-contract.template.md`: task contract template
- `non-loop-evidence.template.md`: non-loop evidence packet template
- `harness-records.template.md`: Linear outage fallback record template
- `harness-progress.template.md`: long-running progress template
- `harness-metrics.template.md`: evaluation metric template
- `claude-orchestrator-prompt.template.md`: Claude Code Orchestrator startup prompt
- `codex-verifier-prompt.template.md`: Codex Verifier startup prompt
- `codex-reviewer-prompt.template.md`: Codex Reviewer startup prompt
- `handoff-packet.template.md`: Claude-to-Codex handoff format
- `skill/SKILL.md`: draft skill instructions for a future `harness-init` skill

## Opt-In Rule

Harness init runs only when the user explicitly asks for it.

Valid triggers:

- "Install harness in this project."
- "Apply harness-init here."
- "Create the harness task contract and records for this repository."

Invalid triggers:

- opening a new repository
- starting a normal coding task
- detecting that `AGENTS.md` is missing
- detecting that `LOOP.md` is missing

Missing harness files mean:

```text
harness not applied yet
```

They do not mean the repository is broken.

## Installation Procedure

1. Read the target repository `AGENTS.md` if it exists.
2. Determine the Linear project name from `Linear-Project:` or repository name.
3. Ask before creating a Linear project if it does not exist.
4. Show the files that would be created or appended.
5. Ask for explicit approval to apply the harness.
6. Append `AGENTS.append.md` content only when the target project does not
   already define equivalent harness rules.
7. Copy templates only when they do not overwrite existing project files.
8. Record what was installed in Linear.
9. Leave loop profile uninstalled unless the user separately requests
   `$loop-init` or explicit loop installation.

## Default Target Files

Suggested target layout:

```text
AGENTS.md
docs/task-contract.md
docs/harness-records.md
docs/harness-progress.md
docs/harness-metrics.md
docs/non-loop-evidence.md
```

These files are suggestions, not mandatory global paths. A target repository may
choose different paths if the Task Contract records them.

## Loop Profile Boundary

Harness init does not install the loop profile by default.

Loop profile remains separate:

- `LOOP.md`
- `METRICS.md`
- `scripts/verify.sh`
- `scripts/check-cases.mjs`
- `.gitattributes`

Install loop only when:

- the task can be judged by one command returning PASS/FAIL
- the user explicitly approves loop installation
- the target repository accepts the loop assets

If `LOOP.md` is absent, treat it as:

```text
loop profile not applied
```

Do not treat it as a harness failure.

## Linear Integration

Harness init should preserve the global Linear rule:

- use the project named by `Linear-Project:`
- do not create a new Linear project without asking
- create or connect an issue before work starts
- move AI-managed work only to In Review
- never move an issue to Done

If Linear is unavailable:

- report the outage immediately
- use `docs/harness-records.md` only if work continues
- include the outage in the final report

## Notion Integration

Notion is optional.

Use Notion only when the Task Contract names it as:

- source of truth
- publication target
- external record location

If Notion is unavailable, report it and keep a Linear or repository fallback
record.

## Global Asset Backup Guide

Before changing global Codex assets, record:

- exact source path
- exact destination path
- timestamp
- reason for change
- rollback path

Global assets include:

- `~/.codex/AGENTS.md`
- `~/.codex/skills/`
- `~/.codex/agents/`

Harness init should not change these paths in draft mode.

## Validation Plan

Before calling this package stable:

1. Choose a separate target repository.
2. Start Claude Code as Orchestrator using
   `claude-orchestrator-prompt.template.md`.
3. Apply harness init with explicit approval.
4. Create one non-loop Task Contract.
5. Run one task to In Review.
6. Send one handoff packet from Claude Orchestrator to Codex Reviewer.
7. Record a metric using `harness-metrics.template.md`.
8. Confirm no loop files were installed unless explicitly requested.
9. Confirm the target repository can remove the harness files cleanly.

Stable status requires evidence from a real target project.

## Phase 7 Completion

Phase 7 is complete when:

- draft harness-init package exists in `templates/harness-init/`
- opt-in rule is explicit
- loop profile remains optional and separate
- Linear and Notion rules are documented
- global asset changes are forbidden in draft mode
- validation plan exists
- package status is clearly marked draft or stable
