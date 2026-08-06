# Task Contract

## Purpose

The Task Contract is the source of truth for a harness task. It must exist
before an orchestrator assigns work to a coder, verifier, reviewer, or future
agent.

The contract answers four questions:

- What is the task?
- Which profile applies?
- What proves completion?
- Which artifacts and decisions are protected?

Agents execute the contract. They do not silently redefine it.

## Profile Choices

Every task must choose exactly one profile.

```text
profile: loop | non-loop | none
```

### loop

Use `loop` when one command can meaningfully judge the result as PASS/FAIL.

Typical examples:

- pure logic implementation
- parser or validator behavior
- command-line behavior
- deterministic API behavior
- test/lint/build/casecheck guarded code work

Required proof:

```text
bash -lc "./scripts/verify.sh"
```

### non-loop

Use `non-loop` when the work is valuable but cannot be meaningfully judged by
`verify.sh`.

Typical examples:

- research synthesis
- design or product judgment
- documentation work without executable checks
- UI review
- ambiguous specification review

Required proof:

- explicit source of truth
- review checklist
- expected artifact location
- human acceptance or a separate check command

### none

Use `none` for conversational clarification, administrative decisions, or
tasks that should not create repository artifacts.

Examples:

- deciding whether to create a Linear project
- answering a conceptual question
- asking the human to choose a direction before work starts

`none` is not a bypass for records or verification. If a task changes repository
files, global assets, product behavior, or durable project records, choose
`loop` or `non-loop` instead. If the discussion belongs to an active issue, keep
the decision in that issue even when the contract profile is `none`.

## Required Fields

```yaml
task_contract:
  id: "<Linear issue id or local task id>"
  project: "<Linear project or repository name>"
  title: "<short task title>"
  goal: "<one sentence>"

  profile:
    type: "loop | non-loop | none"
    non_loop_profile: "research | documentation | ui-review | product-spec-review | none"
    reason: "<why this profile is correct>"

  scope:
    in:
      - "<allowed work>"
    out:
      - "<explicitly excluded work>"

  completion_conditions:
    - "<fixed condition>"

  verification:
    command: "<command or none>"
    source_of_truth:
      - "<document, URL, issue, repo file, or human decision>"
    review_checklist:
      - "<check item for non-loop work>"
    expected_artifact_location:
      - "<where evidence or output should live>"
    human_acceptance_required: true

  loop:
    applies: false
    structured_test_cases: []
    test_freeze:
      pre_freeze_allowed_changes:
        - "<new or strengthened tests for RED>"
      freeze_point: "<after RED confirmation or explicit contract approval>"
      protected_after_freeze:
        - "completion conditions"
        - "verify script"
        - "frozen tests"

  artifacts:
    expected_changes:
      - "<path or area>"
    protected:
      - "<path or artifact>"
    external_records:
      - "Linear"
      - "Notion"
      - "repository docs"

  fallbacks:
    linear_unavailable: "report immediately and record locally"
    notion_unavailable: "report immediately and keep repository note"
    docs_only_no_checks: "do not treat SKIP 0 as PASS"

  roles:
    orchestrator: "<profile choice and contract owner>"
    coder: "<implementation owner or none>"
    verifier: "<verify command owner or none>"
    reviewer: "<spec/risk/acceptance owner>"
    human: "<ambiguity and final Done owner>"
```

## Loop-Specific Fields

When `profile.type` is `loop`, the contract must include structured test cases.

```yaml
loop:
  applies: true
  verification_command: 'bash -lc "./scripts/verify.sh"'
  structured_test_cases:
    - input: "<input>"
      expected_output: "<expected output>"
  test_freeze:
    pre_freeze_allowed_changes:
      - "write or strengthen tests"
      - "confirm RED"
    freeze_point: "after RED confirmation"
    protected_after_freeze:
      - "completion conditions"
      - "scripts/verify.sh"
      - "tests defining accepted behavior"
```

The harness must generate new loop backlog cases in the Phase 2 structured
format:

```text
- 테스트 케이스:
  - 입력: `<input>`
    기대 출력: `<expected output>`
```

## Non-Loop-Specific Fields

When `profile.type` is `non-loop`, the contract must make acceptance explicit.
It must also choose one subtype from `docs/non-loop-profiles.md`.

```yaml
profile:
  type: "non-loop"
  non_loop_profile: "research | documentation | ui-review | product-spec-review"

verification:
  command: "none"
  source_of_truth:
    - "<document, URL, issue, repo file, or human decision>"
  review_checklist:
    - "<what must be checked>"
  expected_artifact_location:
    - "<where the output should live>"
  human_acceptance_required: true
```

Docs-only work is not considered verified by a skipped `verify.sh` run. If the
task has no executable check and no review checklist, the contract is incomplete.

## None-Specific Fields

When `profile.type` is `none`, the contract must explain why no work profile is
needed.

```yaml
  profile:
    type: "none"
    non_loop_profile: "none"
    reason: "No repository artifact, runtime change, or durable external record is being changed."

verification:
  command: "none"
  source_of_truth:
    - "<current conversation or active issue>"
  review_checklist: []
  expected_artifact_location:
    - "<active issue comment or none>"
  human_acceptance_required: false

artifacts:
  expected_changes:
    - "none"
```

If the task later requires a durable artifact, the orchestrator must stop and
reclassify it as `loop` or `non-loop` before work continues.

## State Flow

```text
Draft contract
  -> profile selected
  -> scope and completion conditions fixed
  -> work begins
  -> evidence collected
  -> reviewer/verifier records result
  -> In Review
  -> human decides Done
```

For loop tasks:

```text
Draft contract
  -> tests written or strengthened
  -> RED confirmed
  -> test freeze
  -> implementation
  -> verifier runs verify.sh
  -> PASS/FAIL recorded
```

For non-loop tasks:

```text
Draft contract
  -> source of truth fixed
  -> checklist fixed
  -> artifact produced
  -> reviewer checks checklist
  -> human accepts or requests changes
```

## Role Boundaries

Phase 4 expands these boundaries in `docs/multi-agent-v1.md`. The Task Contract
remains the authority that each role reads before acting.

### Orchestrator

- owns the task contract
- chooses profile
- fixes scope and completion conditions
- declares test freeze point for loop tasks
- routes records to Linear, Notion, and repository files

### Coder

- changes only the agreed write scope
- writes or strengthens tests before freeze for loop tasks
- does not weaken completion conditions

### Verifier

- applies only to loop tasks
- runs the real verification command
- records real exit code and output
- does not edit code or tests

### Reviewer

- checks specification, risk, product intent, and non-loop acceptance
- does not replace verifier judgment for loop tasks
- reports unknowns instead of converting them into PASS

### Human

- decides ambiguous intent
- approves irreversible actions
- accepts visual/product/document quality when no command can judge it
- moves Linear issues to Done

**Engine independence:** role requirements and gates in this contract (e.g.
"coder," "reviewer") must be satisfiable by role, not by a specific engine or
model — a role check must pass the same way no matter which engine currently
fills that role, and this contract's own wording must not name one. A dated,
explicitly time-boxed record of which engine actually filled a role during a
specific window (see `docs/enforcement-known-gaps.md`) is not an exemption
from this — it states a past fact, not a standing requirement, and must not
be read as one.

## Standing Acceptance Criteria

These two criteria apply to every task regardless of profile. They exist
because an artifact's claim about itself can be false even when it compiles
and all tests pass — a checker that only looks at form, not at whether the
claim is true, will not catch it. Two incidents on the same day motivated
this section:

- 2026-08-06, correlation-parser header: the header claimed that consecutive
  `..` and leading/trailing `/` in a branch name are rejected automatically.
  They were not — a reviewer injected `(branch ..)`, `(branch /main)`, and
  `(branch main/)` and all three were selected through to the end. No test
  covered the claim.
- 2026-08-06, fixture provenance: a fixture's `_provenance` field stated
  "346 total / 345 excluded." The measured values were 352 / 351.

### Standing-A: every claim needs a test that turns red when the claim is false

If a produced artifact's header, comment, or report asserts that something
"is rejected," "is blocked," "is guaranteed," or "is always" true, there must
be a test that fails when an input breaking that claim is supplied. If no
such test exists, do one of two things: add the test, or remove the claim.
Leaving an untested claim in place is the worst option, because a reader will
treat it as fact.

### Standing-B: verifiable numbers in descriptive text are asserted by a test that recomputes them from source

Counts, byte sizes, hashes, and similar values written into a fixture's
`_provenance` field or into a report must not be hand-typed; a test must
recompute them from the source data and compare. When a value cannot be
recomputed (e.g., a wall-clock measurement), state the time and method of
measurement and label it explicitly as a point-in-time value.

### Standing-C: a reviewer injects counter-examples, not just reruns the verification command

Rerunning `verification.command` proves the check still runs; it does not
prove the check catches a specific false claim. Before accepting a claim of
the form "X is rejected/blocked/guaranteed" (Standing-A), a reviewer must
construct at least one input designed to defeat that claim and observe
whether the artifact actually catches it — not only rerun the stated
command. This is Standing-A's counterpart on the review side: Standing-A
requires the artifact carry a test; this requires the reviewer to
independently try to break it. 2026-08-06: four rejections in one review
cycle were each found this way — the artifact's own claim looked fine on
inspection and only failed once a reviewer fed it a constructed
counter-example. When the reviewer role happens to run on the same
underlying engine as the role that produced the artifact, shared blind
spots can make a claim look defeat-tested when it is not — this requirement
matters more, not less, in that case, independent of which engines are
involved (see the engine-independence note under Role Boundaries).

**Limitation:** these three criteria are a documented commitment, not a
mechanical enforcement. Whether they are followed is checked by humans and
reviewers, not by a script.

**Machine-check candidates (not implemented in this pass):** (a) a marker
convention next to each claim (e.g., naming the covering test inline) that a
checker could grep for and cross-reference against the test suite; (b) the
alternative of extracting claims from natural language without such a
marker carries real risk of false positives (flagging hedged or rhetorical
language as a claim) and false negatives (missing claims phrased unusually),
so a marker convention is the safer starting point; (c) running such a check
in CI is hard today because the task files that state most of these claims
(the `.harness/*-task.md` files referenced by this contract) live outside
the repository and are not visible to CI.

## Example: Loop Task

```yaml
task_contract:
  id: "HYK-101"
  project: "HARNESSENGINEERING"
  title: "Add task contract parser"
  goal: "Parse a task contract file and return its selected profile."

  profile:
    type: "loop"
    non_loop_profile: "none"
    reason: "The parser behavior can be judged by unit tests and verify.sh."

  scope:
    in:
      - "parser module"
      - "parser tests"
    out:
      - "multi-agent scheduling"

  completion_conditions:
    - "loop, non-loop, and none profile values are parsed."
    - "invalid profile values fail validation."

  verification:
    command: 'bash -lc "./scripts/verify.sh"'
    source_of_truth:
      - "structured test cases in this contract"
      - "parser tests"
    review_checklist: []
    expected_artifact_location:
      - "verifier output"
    human_acceptance_required: false

  loop:
    applies: true
    structured_test_cases:
      - input: "profile: loop"
        expected_output: "loop"
      - input: "profile: invalid"
        expected_output: "validation error"
    test_freeze:
      pre_freeze_allowed_changes:
        - "add parser tests"
      freeze_point: "after RED confirmation"
      protected_after_freeze:
        - "completion conditions"
        - "scripts/verify.sh"
        - "parser tests"

  artifacts:
    expected_changes:
      - "src/task-contract-parser.*"
      - "tests/task-contract-parser.*"
    protected:
      - "scripts/verify.sh"
    external_records:
      - "Linear"

  fallbacks:
    linear_unavailable: "report immediately and record locally"
    notion_unavailable: "not required"
    docs_only_no_checks: "not applicable"
```

## Example: Non-Loop Task

```yaml
task_contract:
  id: "HYK-102"
  project: "HARNESSENGINEERING"
  title: "Review harness phase plan"
  goal: "Review whether the phase plan matches the intended hierarchy."

  profile:
    type: "non-loop"
    non_loop_profile: "product-spec-review"
    reason: "The work is a design judgment and cannot be judged by verify.sh."

  scope:
    in:
      - "phase roadmap"
      - "loop profile relationship"
    out:
      - "implementation"
      - "multi-agent scheduling"

  completion_conditions:
    - "strengths, weaknesses, and recommended changes are reported."
    - "Linear records the review."

  verification:
    command: "none"
    source_of_truth:
      - "docs/phase-roadmap.md"
      - "docs/phase0-harness-basis.md"
      - "docs/loop-profile-contract.md"
    review_checklist:
      - "loop is a lower-level profile"
      - "multi-agent work is deferred"
      - "non-loop work is not forced through verify.sh"
      - "profile-specific criteria follow docs/non-loop-profiles.md"
    expected_artifact_location:
      - "Linear issue comment"
    human_acceptance_required: true

  loop:
    applies: false
    structured_test_cases: []

  artifacts:
    expected_changes:
      - "none"
    protected:
      - "Phase 0 decisions unless user changes direction"
    external_records:
      - "Linear"

  fallbacks:
    linear_unavailable: "report immediately and record locally"
    notion_unavailable: "not required"
    docs_only_no_checks: "review checklist is the verification path"
```

## Phase 1 Completion Checklist

- Every task has exactly one profile.
- Loop work includes structured test cases and test freeze.
- Non-loop work includes checklist and human acceptance.
- Non-loop work chooses a concrete subtype from `docs/non-loop-profiles.md`.
- Docs-only SKIP 0 is not considered PASS.
- Linear fallback is recorded as an outage path, not silent skip.
- Role boundaries are explicit enough for future multi-agent execution.
