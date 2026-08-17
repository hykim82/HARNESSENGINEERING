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
  (carries a `Profile:` field, v2/HYK-92)
- `status.template.md`: short "where am I" status board (carries a
  `Profile:` field, v2/HYK-92)
- `project-context.template.md`: hard-constraints + goals/intent card
  injected into every session start (HYK-94/96/97); installed to
  `.harness/PROJECT-CONTEXT.md`
- `verify.sh.template`: one-line `exec <VERIFY_CMD>` wrapper (v2, HYK-92)
- `observe.sh.template`: boot-and-check layer — boots the app, polls until
  ready, runs `check_http` route checks (HYK-102); installed to
  `observe.sh`, distinct from `verify.sh`'s build layer
- `gc-task.template.md`: droppable CODER task for a periodic entropy-GC scan
  (find-only, never fixes) across five fixed categories (HYK-103)
- `gate-criteria.template.md`: empty gate-criteria card scaffold a project
  accumulates its own gate rules into over time; installed to
  `.harness/gate-criteria.md` in both profiles (HYK-114)
- `gitignore.append.template`: profile-specific `.gitignore` append block,
  `solo-full` vs `team-local` (v2, HYK-92)
- `install.mjs`: Node installer — reads a profile + 5 parameters, copies the
  matching template/script set into a target repo with placeholder
  substitution, never overwrites an existing file (v2, HYK-92); see
  `docs/harness-init.md` ("Profiles (v2, HYK-92)") for usage
- `skill/SKILL.md`: draft skill instructions for a future `harness-init` skill
- `skill/capture-context/SKILL.md`: `/capture-context` capture-assist skill,
  installed to `.claude/skills/capture-context/SKILL.md` in both profiles
  (HYK-96 Scope C)

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
- Roles end each task with a `>>> DONE: <role>` line (produced by running
  `node scripts/relay/finalize-done.mjs <role> .harness` -- do not
  hand-type it) and a human-next-action line. Full protocol:
  `docs/claude-orchestrator-handoff.md` (Relay Protocol v2).
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
