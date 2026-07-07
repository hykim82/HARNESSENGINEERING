# PHASE HANDOFF — a new session reads this file first

**Written: <YYYY-MM-DD HH:MM KST> (end of Phase <X>)**
**Profile: <PROFILE>** (`solo-full` | `team-local`)

## How to boot a new session (Orchestrator)

Start a new chat with one line:
> "You are the [ORCH-CLAUDE] Orchestrator for <project>. Read
> `.harness/PHASE-HANDOFF.md`, `.harness/STATUS.md`, and only the named Linear
> issues, then continue. Read the rest of the code/docs only when a task needs
> it (save tokens)."

If operating procedure is unclear after that, read
`docs/claude-orchestrator-handoff.md` before proceeding — do not re-derive it
from memory.

## Previous phase result

- <what completed / not done>
- <key issue states, e.g. HYK-XX In Review / Done>

## What changed this phase (changes)

- <concrete artifact or behavior changes made this phase>

## Improvements folded in

- <process / rule / package improvements adopted this phase>

## Unresolved · carried to next phase

1. <backlog item 1>
2. <backlog item 2>

## Next-phase first action (pick one)

- (A) <candidate action A>
- (B) <candidate action B>

## Environment notes (for re-confirmation)

- Repos: <paths>
- Terminals / relay orientation: <state>
- Linear: <team/project>; AI moves work to In Review, Human moves Done.

## Profile-specific handoff notes

- **If `<PROFILE>` = `solo-full`:** `<REPO_PATH>` is public on GitHub
  (`<GITHUB_REPO>`) with its protected branch requiring a PR, green
  `enforce` CI, and one human approval; the acting agent pushes only as the
  Write-only bot `<BOT_ACCOUNT>`, never directly to the protected branch.
  GitHub-side setup (branch protection, bot collaborator, secret scanning)
  is a one-time human step done in the GitHub web UI — do not attempt to
  automate it from a session.
- **If `<PROFILE>` = `team-local`:** `<REPO_PATH>` is a local clone of a
  team-owned repo (`<GITHUB_REPO>`); this account holds no branch-protection
  or CI authority there. Enforcement is local hooks + `<VERIFY_CMD>` only —
  no server-side gate exists or should be added. Work lands via a feature
  branch pushed to this account's own remote/fork and an upstream PR
  reviewed under the team's own process, not this harness's rules.
