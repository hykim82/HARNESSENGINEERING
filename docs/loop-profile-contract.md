# Loop Profile Contract

## Purpose

This document describes how HARNESSENGINEERING consumes loopEngineering Phase 1
and Phase 2. It is not a replacement for loopEngineering. It is the contract the
harness uses when deciding whether and how to apply the loop profile.

## Applicability Rule

Apply the loop profile only when the task result can be judged by one command
returning PASS/FAIL.

Default command for loop tasks:

```text
bash -lc "./scripts/verify.sh"
```

If that command cannot meaningfully judge the work, the task needs another
profile.

## Installation Rule

The loop profile is not installed automatically.

Valid installation triggers:

- the human invokes `$loop-init`
- the human explicitly asks to install the loop verification environment
- a future harness task contract says loop profile applies and the human
  approves installation

If `LOOP.md` is absent, treat it as:

```text
loop profile not applied yet
```

Do not treat absence as an error by itself.

## Task Contract Fields for Loop Tasks

```text
Issue:
- Linear issue: <id or unavailable>
- Project: <Linear project or repository name>

Goal:
- <one sentence>

Loop Profile:
- Applies: yes
- Reason: <why one command can judge this task>
- Verification command: bash -lc "./scripts/verify.sh"

Completion Conditions:
- <fixed conditions>

Test Cases:
- 입력: <input>
  기대 출력: <expected output>

Test Freeze:
- Pre-freeze allowed changes: <new or strengthened tests for RED>
- Freeze point: <after RED confirmation or explicit contract approval>
- Protected after freeze: <completion conditions, verify script, frozen tests>

Artifacts:
- Files expected to change: <paths or areas>
- External records: <Linear, Notion, global ~/.codex assets>

Fallbacks:
- Linear unavailable: report immediately and record locally.
- Notion unavailable: report immediately and keep repository note.
- Docs-only/no executable stack: do not call SKIP 0 a meaningful PASS unless
  document checks are defined.
```

## Structured Test Case Format

New loop backlog items should use the Phase 2 structured format:

```text
- [ ] `<task>`: <description>
  - 테스트 케이스:
    - 입력: `<input>`
      기대 출력: `<expected output>`
```

Compatibility remains for older loop projects:

- `테스트 케이스: <input> -> <expected output>`
- `테스트는 ... 케이스를 포함한다`

New harness-generated loop tasks must prefer the structured format.

## Casecheck Expectations

`scripts/check-cases.mjs` is a lightweight keyword safety check. It is not a
runtime correctness proof.

It should fail when:

- structured `입력` has no `기대 출력`
- inline `테스트 케이스: <input>` has no expected output separator
- required input or expected-output keywords are missing from test files

Runtime behavior still belongs to the real test suite.

## Test Freeze

Test freeze does not mean tests can never be edited.

Allowed before freeze:

- writing new tests
- strengthening weak tests
- reproducing RED
- clarifying expected outputs

Protected after freeze:

- completion conditions
- `scripts/verify.sh`
- frozen tests that define the accepted behavior

Verifier should fail only when tests or completion conditions are weakened,
deleted, or silently changed after freeze.

## Docs-Only Policy

Docs-only work is not a meaningful loop PASS merely because executable phases
were skipped and `verify.sh` exited 0.

Minimum docs-only contract:

- explicit document target
- review checklist
- source-of-truth links
- expected update location
- human acceptance or separate document check command

If those are absent, the verifier should report no meaningful verification
criteria instead of treating SKIP 0 as PASS.

## Verifier Record Format

Loop verifier attempts should use this one-line format:

```text
<YYYY-MM-DD HH:mm KST> / <issue or task id> / <PASS|FAIL>: 명령 `bash -lc "./scripts/verify.sh"`, 종료 코드 <code>. <actual output summary>
```

Rules:

- use the real command
- use the real exit code
- summarize only output that actually appeared
- do not infer root causes beyond the output

## Harness Boundary

The harness may route work to the loop profile. It must not reinterpret
`verify.sh` output or let a reviewer replace verifier judgment.

Role boundary:

- Orchestrator decides whether loop applies.
- Coder writes tests and implementation within scope.
- Verifier runs `verify.sh` and records PASS/FAIL from real output.
- Reviewer checks specification, risk, product intent, and non-command-judged
  quality.
- Human resolves ambiguity and final Done.
