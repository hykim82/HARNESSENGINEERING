# Harness Operating Rules

Harness is opt-in for this repository.

## Project

Linear-Project: PROJECT_NAME

## Task Contract

Before durable work starts, create or reference a Task Contract.

Each task chooses exactly one profile:

- `loop`: one command can judge PASS/FAIL
- `non-loop`: review checklist and evidence are required
- `none`: clarification or administration with no durable artifact

## Loop Boundary

Loop profile is not installed automatically.

If `LOOP.md` or `scripts/verify.sh` is absent, treat the repository as:

```text
loop profile not applied
```

Install loop only after explicit approval.

## Records

Linear is the primary work log. If Linear is unavailable, report the outage and
use repository fallback records only if work continues.

AI-managed work stops at In Review. Done is a human action.
