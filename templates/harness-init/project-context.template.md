<!-- Installed by default at .harness/PROJECT-CONTEXT.md. `scripts/check/context-inject.mjs`
     reads this exact path (override with --context or HARNESS_CONTEXT_PATH) and injects the
     "## HARD CONSTRAINTS" section below into every new session via the SessionStart hook; a
     UserPromptSubmit hook blocks prompts entirely if this file is missing. See
     docs/enforcement-v1.md ("D6 — project-context injection") for the full mechanism. -->

# Project context — <REPO_PATH>

Profile: <PROFILE>

<Freeform: why this project exists, what it's for, the situation an agent
walking in cold needs to know that isn't obvious from the code. A sentence
or two is enough — this section is for orientation, not full history.>

## HARD CONSTRAINTS

<This is the section that gets mechanically injected at the start of every
session — keep it short, imperative, and non-negotiable. Not a style guide;
only rules whose violation would be a real incident. One example per
profile below — replace with this project's actual constraints.>

- (team-local example) Never commit or push harness tooling
  (`.harness/`, `verify.sh`, local hooks, `scripts/check/`) to
  `<GITHUB_REPO>` — this account does not own that repo, and its personal
  process tooling must not become shared team state.
- <this project's own hard constraint>
