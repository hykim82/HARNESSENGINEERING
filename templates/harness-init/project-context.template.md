<!-- Installed by default at .harness/PROJECT-CONTEXT.md. `scripts/check/context-inject.mjs`
     reads this exact path (override with --context or HARNESS_CONTEXT_PATH). Only the
     "## HARD CONSTRAINTS" section below is injected into every new session, via the
     SessionStart hook; extraction stops at the next "##" heading, so everything under
     "## 목표·의도·맥락" below is never injected -- keep that section as long as you want, it
     costs nothing. A UserPromptSubmit hook blocks prompts entirely if this file is missing,
     or if HARD CONSTRAINTS is empty or still has an unedited template placeholder in it. See
     docs/enforcement-v1.md ("D6 — project-context injection", "Scope A", "Scope D") for the
     full mechanism. -->

# Project context — <REPO_PATH>

Profile: <PROFILE>

<One line: what this file is for. Full background goes in "목표·의도·맥락" below,
not here.>

## HARD CONSTRAINTS

<!-- Only this section is auto-injected every session start -- keep it short. -->

<Short, imperative, non-negotiable rules only -- not a style guide, only
rules whose violation would be a real incident. One example per profile
below; replace with this project's actual constraints.>

- (team-local example) Never commit or push harness tooling
  (`.harness/`, `verify.sh`, local hooks, `scripts/check/`) to
  `<GITHUB_REPO>` — this account does not own that repo, and its personal
  process tooling must not become shared team state.
- <this project's own hard constraint>

## 목표·의도·맥락 (Goals / Intent / Context)

<!-- This section is never injected -- it's for storage, not repetition.
     Length costs nothing here. A future /clear-time re-orientation step
     (HYK-96 Scope B) is expected to append deltas to this section over
     time, so treat it as the project's running memory, not a one-time
     background paragraph. -->

<Freeform: why this project exists, what it's for, the situation an agent
walking in cold needs to know that isn't obvious from the code. Put the
project's evolving goals, intent, and background here -- as much as is
useful, since none of it is repeated into every session's context.>
