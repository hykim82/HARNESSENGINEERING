# Status board (start here when you return)

**Updated: <YYYY-MM-DD HH:MM KST>**
**Profile: <PROFILE>** (`solo-full` | `team-local`)

## Where I am

- <current phase / position in one or two lines>
- Just did: <last concrete action>

## Human's next action (pick one)

1. <action, e.g. move HYK-XX to Done in Linear>
2. <action, e.g. start a new session with the boot line>

## Issue states

- Done: <ids>
- In Review: <ids>
- Todo / In Progress: <ids>

## Relay rules

Read these once; do not re-derive them after a `/clear`.

1. **Role assignment is the Orchestrator's call.** The Orchestrator decides
   which role or terminal a task goes to. Do not ask the human to confirm
   "where should this run" — the human relays messages, they do not route
   them.
2. **Task handoff = file drop.** The Orchestrator writes the next task to
   `.harness/<role>-task.md` in the target repository, including the target
   repo path, exact commands, prohibitions, and required output format. Do
   not hand a role pasted text instead of a task file.
3. **Trigger word = "go".** The human types `go` in a role's terminal; that
   role reads `.harness/<role>-task.md` and executes it.
4. **Result = file + DONE line.** The role writes its result to
   `.harness/<role>.md` and ends with exactly
   `>>> DONE: <role> @ <YYYY-MM-DD HH:MM>` (get the timestamp from a real
   command; do not guess it).
5. **Self-report, same turn.** The role that just finished updates its own
   row on this board — the moment it writes its result file, in the same
   turn, before anything else. The Orchestrator does not write a worker's
   row for it; the Orchestrator only updates its own row and the
   decision/state sections. The human still relays completion ("<role>
   done"), not board content — the human never pastes file contents in.
   (If this board lives outside the repository root, a role-boundary guard
   scoped to the repo does not restrict this write — see
   `docs/enforcement-v1.md`'s role-guard section.)
6. **Target repository and role definitions.** State explicitly which
   repository each kind of work belongs to when a project spans more than
   one (do not assume a single repo). Roles: CODER = implementation or
   writing (write access within declared scope), VERIFY = runs the
   verification command and reports the real exit code (loop tasks only),
   REVIEW = independent read-only review, Human = final acceptance (Done).

## Profile-specific rules

- **If `<PROFILE>` = `solo-full`:** landing on `<REPO_PATH>`'s protected
  branch is `branch -> push (as <BOT_ACCOUNT>) -> open PR -> enforce CI
  green -> human approval -> merge`. Direct pushes to the protected branch
  are rejected server-side; do not attempt one as a shortcut. Verification
  runs `<VERIFY_CMD>` locally before a PR is opened, and the same checks
  re-run in CI as the external anchor.
- **If `<PROFILE>` = `team-local`:** this account has no branch-protection
  or CI authority over `<GITHUB_REPO>` (team-owned, shared with other
  contributors) — do not add or attempt server-side gates. Enforcement here
  is local only: the installed git hooks and `<VERIFY_CMD>` run before a
  commit; landing anywhere shared still goes through a feature branch and an
  upstream PR reviewed by the team's own process, not this harness.
