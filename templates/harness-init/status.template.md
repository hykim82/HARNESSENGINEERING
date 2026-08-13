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

## /clear safety (reconciliation attestation)

Before declaring 🟢 "safe to `/clear`" anywhere on this board, reconcile this
session's goals/intent/hard-constraint delta into `PROJECT-CONTEXT.md` (the
`/capture-context` skill drafts that delta; a human still approves it), then
record the result right next to the 🟢 declaration with this exact marker:

```
<!-- clear-safe-attest: reconciled=<YYYY-MM-DD HH:MM KST | none> delta=<none|applied|deferred> -->
```

Fill `reconciled=` with the real timestamp you did the reconciliation at (or
the literal `none` if there was nothing to reconcile this session — not a
blank). `scripts/check/clear-safe-check.mjs`, wired to a `Stop` hook, reminds
(non-blocking, `exit 1`) when a 🟢 declaration appears without this marker
filled in. It cannot intercept `/clear` itself and cannot verify the
attestation's _content_ — only that the marker is present and non-empty. See
`docs/enforcement-v1.md` ("Scope B") for why this can only ever be a soft
reminder, not a hard gate.

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
3. **Trigger word = "go", with the task id.** The human types
   `go <task_id>` (not bare `go`) -- `<task_id>` is the header value at the
   top of `.harness/<role>-task.md`. That role reads the task file and
   executes it. Including the id lets the role notice a stale or mismatched
   task file instead of silently re-running whatever happens to be sitting
   there (a real incident this rule closes, coder-11).
4. **Result = file + DONE line.** The role writes its result to
   `.harness/<role>.md` and ends with exactly
   `>>> DONE: <role> @ <YYYY-MM-DD HH:MM:SS>` (get the timestamp from a real
   command; do not guess it). Seconds are required (HYK-244) --
   `relay-handshake.mjs` rejects a minute-only DONE line.
5. **Self-report, twice, one per event.** The role that just received "go"
   updates its own row on this board immediately, before starting work, to
   something like `working: <task_id>`. The role that just finished updates
   its own row again — the moment it writes its result file, in the same
   turn, before anything else — to something like `reporting to
orchestrator`. The Orchestrator does not write a worker's row for either
   event; it only updates its own row and the decision/state sections. The
   human still relays completion ("<role> done"), not board content — the
   human never pastes file contents in. (If this board lives outside the
   repository root, a role-boundary guard scoped to the repo does not
   restrict this write — see `docs/enforcement-v1.md`'s role-guard
   section.) Skipping the first of these two reports is what lets a board
   still showing `IDLE` be misread as "nothing is happening" when a role is
   actually mid-task.
6. **No retry loops on infrastructure errors.** If a tool or infrastructure
   error repeats at the same point two or three times, regardless of cause,
   stop immediately instead of retrying again — report it in a
   `question_packet` and wait for the Orchestrator to confirm how to
   proceed. Blind retries burn time and tokens without fixing a failure the
   role does not control.
7. **Target repository and role definitions.** State explicitly which
   repository each kind of work belongs to when a project spans more than
   one (do not assume a single repo). Roles: CODER = implementation or
   writing (write access within declared scope), VERIFY = runs the
   verification command and reports the real exit code (loop tasks only),
   REVIEW = independent read-only review, Human = final acceptance (Done).
8. **The board is a snapshot, not a log.** Overwrite your row/section on
   each update; never accumulate history inline (no "(previous) … <br>"
   chains). Session history belongs in the phase-handoff note, the
   tracker, and git — not on this board. A bloated board defeats its
   purpose as a fast dashboard and costs tokens on every boot read.

## Profile-specific rules

- **Under the `solo-full` profile:** landing on `<REPO_PATH>`'s protected
  branch is `branch -> push (as <BOT_ACCOUNT>) -> open PR -> enforce CI
green -> human approval -> merge`. Direct pushes to the protected branch
  are rejected server-side; do not attempt one as a shortcut. Verification
  runs `<VERIFY_CMD>` locally before a PR is opened, and the same checks
  re-run in CI as the external anchor.
- **Under the `team-local` profile:** this account has no branch-protection
  or CI authority over `<GITHUB_REPO>` (team-owned, shared with other
  contributors) — do not add or attempt server-side gates. Enforcement here
  is local only: the installed git hooks and `<VERIFY_CMD>` run before a
  commit; landing anywhere shared still goes through a feature branch and an
  upstream PR reviewed by the team's own process, not this harness.
