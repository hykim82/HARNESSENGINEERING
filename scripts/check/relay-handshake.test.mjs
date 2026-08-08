// HYK-189: CLI 진입점(§171-192 `invokedDirectly` 블록)의 인자 파싱 계약을
// 고정한다.
//
// ⚠️ 현재 동작을 «결함으로 명시하고 고정»하는 것이지 «옳다고 승인»하는
// 것이 아니다. 플래그 모양 인자를 역할 이름으로 받는 것은 결함이며,
// 고치면 이 시험도 함께 바뀌어야 한다(docs/enforcement-known-gaps.md
// gap#73 참조). `relay-handshake.mjs` 소스는 이 이슈 범위에서 수정하지
// 않는다 — 인자 파싱 결함(`--role coder` 같은 플래그 모양 인자를 역할
// 이름 `--role`로, `coder`를 harnessDir로 그대로 받아들이는 것)은 이번에
// 고치지 않고 미수리 결함으로만 등재한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { checkRelayHandshake } from "./relay-handshake.mjs";

// import.meta.url is resolved relative to this file's own location, not the
// process cwd -- unaffected by the cwd axis (repo root vs scripts/check),
// same reasoning as docs/enforcement-known-gaps.md's "cwd 축" note for the
// static relative imports the NC-2 suites use.
const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "relay-handshake.mjs",
);
const USAGE_MESSAGE = "usage: node relay-handshake.mjs <role> [harnessDir]";

// §2 비타협 #8(coder-task.md): 자식 프로세스 실패(spawn 실패·시그널 종료·
// status===null)는 CLI 계약 위반과 다른 종류의 실패다 -- fail-closed로
// 처리하되 "계약 위반"으로 세지 않는다. 여기서는 spawn 자체가 깨지면
// assert.fail로 그 사실을 명시하고, 정상적으로 끝난 프로세스만 그 exit
// code/stderr를 CLI 계약 단언에 넘긴다.
function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    ...opts,
  });
  if (res.error) {
    assert.fail(
      `child process failed to spawn (infra failure, not a CLI contract violation): ${res.error.message}`,
    );
  }
  if (res.status === null) {
    assert.fail(
      `child process terminated by signal ${res.signal} (infra failure, not a CLI contract violation)`,
    );
  }
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function writeValidFixture(dir, role, taskId) {
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-03 06:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: ${role.toUpperCase()} @ 2026-08-03 06:10 KST\n`,
    "utf8",
  );
}

function withFixtureDirCli(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-cli-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

test("(a) task_id matches + DONE after dropped_at -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(b) task_id mismatch -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-2\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /handshake mismatch/);
  });
});

test("(c) result missing task_id echo -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "no id line here\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id echo/);
  });
});

test("(d) task missing task_id header -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "dropped_at: 2026-07-05 06:00 KST\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing task_id header/);
  });
});

test("(e) result file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /result file not found/);
  });
});

test("(f) task file not found -> blocked", () => {
  withFixtureDir((dir) => {
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task file not found/);
  });
});

test("(g) stale: DONE timestamp predates dropped_at -> blocked", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:10 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:00 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

test("(h) id matches but result has no DONE line -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nsome report body, no DONE line\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing ">>> DONE/);
    assert.equal(
      result.state,
      "PENDING",
      "genuine no-marker-at-all absence must resolve to the distinct PENDING state, not just ok:false",
    );
  });
});

test("(i) id matches but task is missing dropped_at -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /missing dropped_at/);
  });
});

test("(j) id matches but dropped_at is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: yesterday\n");
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});

test("(k) id matches but DONE timestamp is not parseable -> blocked (fail-closed)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /DONE timestamp not parseable/);
  });
});

// --- HYK-142 6A: DONE parser `HH:MM(:SS)?` contract frozen --
// dropped_at/DONE timestamps observed in real STATUS/task files sometimes
// carry seconds (e.g. hooks that stamp `HH:MM:SS`) and sometimes don't --
// both forms must parse identically; anything else must still fail-closed.

test("(l) frozen: dropped_at with HH:MM:SS form -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00:15 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(m) frozen: DONE with HH:MM:SS form -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:45 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(n) frozen: both dropped_at and DONE carry HH:MM:SS -> ok, and seconds are honored for staleness ordering", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:10:30 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10:29 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale result/);
  });
});

// --- HYK-180 사이클1: mid-line task_id echo distinguished from genuine
// absence (사이클0 증거 -- REVIEW's `for: X / task_id: Y / role: Z` shape
// previously fell through to "missing echo", pending forever) --------

test("(p) known-bad: actual review.md shape -- G1 header + mid-line 'for: X / task_id: Y / role: Z' echo + DONE -> distinct reason, NOT 'missing task_id echo'", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "review",
      "task_id: HYK-167\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "review",
      "dispatch_verified: yes\ntask_id_from_dispatch: HYK-167-review-2\npane_match: 일치\n\nfor: HYK-167 / task_id: HYK-167-review-2 / role: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task_id echo not at line start/);
    assert.doesNotMatch(result.reason, /^result missing task_id echo/);
  });
});

test("(q) paired good: same content, task_id moved to a standalone column-0 line -> ok", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "review",
      "task_id: HYK-167-review-2\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "review",
      "dispatch_verified: yes\ntask_id_from_dispatch: HYK-167-review-2\npane_match: 일치\ntask_id: HYK-167-review-2\n\nfor: HYK-167 / role: REVIEW-CODEX\n\n>>> DONE: REVIEW-CODEX @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "review", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

test("(r) genuine absence: no task_id token anywhere -> still 'missing task_id echo', unchanged from (c)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "no id token in this file at all\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /^result missing task_id echo/);
  });
});

test("(o) frozen: malformed seconds (single digit) still rejected", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00:5 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.match(result.reason, /dropped_at not parseable/);
  });
});
// ---------------------------------------------------------------------------
// HYK-173-escalation-1 §2: 결과 파일 상태 확장 -- 「막혔다」와 「아직
// 진행 중(pending)」을 판정기가 서로 다른 값으로 낸다. 4종 합성 결과
// 파일(정상 DONE / 막힘 상태 / DONE도 막힘도 없음(진짜 pending) / 형식이
// 깨진 막힘 표기)을 고정한다. 정상 DONE은 위 (a)가 이미 고정하므로
// (result.state는 그 경로에서 세팅되지 않는다 -- 회귀 0), 여기서는 나머지
// 3종 + 정상 DONE에 BLOCKED 마커가 섞여도 무시된다는 회귀 보강만 추가한다.
// ---------------------------------------------------------------------------

test("HYK-173-escalation-1 (s) explicit BLOCKED marker, no DONE line -> state=BLOCKED, distinct from PENDING", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nreproduce 실패, 재현 조건 불명\n\n>>> BLOCKED: 재현 실패 -- 조건 불명\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(
      result.reason,
      /worker reported BLOCKED: 재현 실패 -- 조건 불명/,
    );
  });
});

test("HYK-173-escalation-1 (t) explicit NEEDS_INPUT marker, no DONE line -> state=NEEDS_INPUT, distinct from PENDING and from BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nQUESTION: 어느 방향으로 갈지 결정 필요\n\n>>> NEEDS_INPUT: 게이트 신호 대기 중\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "NEEDS_INPUT");
    assert.match(
      result.reason,
      /worker reported NEEDS_INPUT: 게이트 신호 대기 중/,
    );
  });
});

test("HYK-173-escalation-1 (u) no DONE and no BLOCKED/NEEDS_INPUT marker -> state=PENDING (genuinely still in progress, not blocked)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 중, 아직 보고 없음\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "PENDING");
  });
});

test("HYK-173-escalation-1 (v) malformed blocked marker (mid-line, not column-0) -> state=MALFORMED_BLOCKED, fail-closed (NOT silently folded into PENDING or accepted as ok)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nstatus note: >>> BLOCKED: mid-line, not a standalone marker\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
    assert.notEqual(
      result.state,
      "PENDING",
      "a malformed blocked marker must not silently fall back to plain pending",
    );
  });
});

test("HYK-173-escalation-1 (w) malformed blocked marker (empty reason after colon) -> state=MALFORMED_BLOCKED, fail-closed", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> BLOCKED:   \n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
  });
});

test("HYK-173-escalation-1 (x) two BLOCKED lines -> state=AMBIGUOUS_BLOCKED, not silently resolved to either", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: first reason\n>>> BLOCKED: second reason\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "AMBIGUOUS_BLOCKED");
  });
});

test("HYK-173-escalation-1 (y) regression: a normal DONE result with an incidental '>>> BLOCKED:' string still resolves ok=true (DONE path untouched, blocked check never runs when DONE resolves)", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-07-05 06:00 KST\n",
    );
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nearlier round note: >>> BLOCKED: old, resolved already\n\n>>> DONE: CODER @ 2026-07-05 06:10 KST\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (a): 인자 없음 -> exit 1, stderr가 usage 문자열과
// 정확히 일치, 프로세스 실행 실패 0건. 느슨한 "exit !== 0" 단언은
// exit 2/시그널/spawn 실패까지 통과시키므로 여기서는 정확한 exit 1과
// stderr 정확 일치를 함께 단언한다.
// ---------------------------------------------------------------------------
test("HYK-189 (a) CLI: no args -> exit exactly 1, stderr exactly matches the usage string (strict, not loose 'exit !== 0')", () => {
  const { exit, stdout, stderr } = runCli([]);
  assert.equal(exit, 1, "must exit with exactly code 1, not merely non-zero");
  assert.equal(
    stderr.trim(),
    USAGE_MESSAGE,
    "stderr must exactly equal the usage string, not just contain/match it loosely",
  );
  assert.equal(stdout, "", "no-arg failure must not print anything to stdout");
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (b)+(d): 정상 위치 인자 coder/review/verify 3건을
// 분모로 고정하고 오탐 0/3을 산출 명령과 함께 제시한다. 각 role에 대해
// mkdtemp 픽스처 안에 유효한 <role>-task.md/<role>.md 쌍을 만들고, 첫
// 위치 인자가 그 role로, 두 번째 위치 인자가 harnessDir로 올바르게
// 파싱되어 exit 0(정상 판정)이 나오는지 확인한다.
// ---------------------------------------------------------------------------
test("HYK-189 (b)+(d) CLI: positional args coder/review/verify (denominator 3/3) -> role/harnessDir parsed correctly, false-positive rate 0/3", () => {
  const roles = ["coder", "review", "verify"];
  const falsePositives = [];
  for (const role of roles) {
    withFixtureDirCli((dir) => {
      writeValidFixture(dir, role, `HYK-189-${role}-fixture`);
      const { exit, stderr } = runCli([role, dir]);
      if (exit !== 0) {
        falsePositives.push({ role, exit, stderr });
      }
    });
  }
  assert.deepEqual(
    falsePositives,
    [],
    `positional-arg parsing must accept all ${roles.length}/${roles.length} well-formed invocations; false positives: ${JSON.stringify(falsePositives)}`,
  );
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (c): 플래그 모양 인자의 «현재» 의미 계약을 고정한다
// (결함으로 명시 -- 위 파일 헤더 참조). `node relay-handshake.mjs --role
// coder --harness-dir .harness` 호출에서 process.argv[2] === "--role"가
// 그대로 role로, process.argv[3] === "coder"가 그대로 harnessDir로 쓰이고
// 나머지 인자(--harness-dir .harness)는 완전히 무시된다. 경로 단언은
// 구분자 무관(`coder[/\\]--role-task.md`)으로 한다(HYK-185 리눅스 CI
// 회귀 전례, coder-task.md §2 비타협 #9).
// ---------------------------------------------------------------------------
test("HYK-189 (c) CLI: flag-shaped args -- role becomes literal '--role', harnessDir becomes 'coder', trailing args ignored, exit 1, path assertion separator-agnostic", () => {
  const { exit, stderr } = runCli([
    "--role",
    "coder",
    "--harness-dir",
    ".harness",
  ]);
  assert.equal(exit, 1);
  assert.match(
    stderr.trim(),
    /^task file not found: coder[/\\]--role-task\.md$/,
    "must resolve to harnessDir='coder', role='--role' (trailing '--harness-dir .harness' ignored), path separator-agnostic",
  );
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (e): 판별력 자동화 -- mutation 3종. 사본은 반드시
// `<tmp>/scripts/check/relay-handshake.mjs` 경로에 만든다(직접 실행
// 감지가 경로 suffix를 보므로, 아무 이름으로 두면 CLI 블록이 아예 안
// 돌아 「거짓 RED」가 된다 -- coder-task.md §2 비타협 #4). 치환이 정확히
// 1회 매치됨을 먼저 단언한다(0회·2회 이상은 skip이 아니라 실패 --
// §2 비타협 #5). 작성 시점부터 skip 0(§2 비타협 #6): 이 파일은 이미
// 추적본에 있는 relay-handshake.mjs를 변조하므로 커밋 후 해제에
// 의존하지 않는다.
// ---------------------------------------------------------------------------
const RELAY_HANDSHAKE_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/relay-handshake.mjs"],
  { encoding: "utf8" },
);

// HYK-183: relay-handshake.mjs now imports "./reject-streak.mjs" (the
// auto-record wiring), so a mutant written ALONE into a fresh scripts/check
// dir fails to even load (MODULE_NOT_FOUND) -- these M1-M3 mutations exist
// to probe relay-handshake.mjs's own CLI arg-parsing/exit-code contract,
// not reject-streak.mjs, so the real (unmutated) sibling module is copied
// alongside every mutant to keep the relative import resolvable.
const REJECT_STREAK_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/reject-streak.mjs"],
  { encoding: "utf8" },
);

// HYK-204: relay-handshake.mjs now also imports "./envelope-archive.mjs"
// (round preservation) -- same MODULE_NOT_FOUND risk reject-streak.mjs's
// comment above already documents, now for a second sibling.
const ENVELOPE_ARCHIVE_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/envelope-archive.mjs"],
  { encoding: "utf8" },
);

function writeMutantCli(mutatedSrc) {
  const rootDir = mkdtempSync(join(tmpdir(), "relay-handshake-mutant-"));
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const mutantPath = join(scriptsCheckDir, "relay-handshake.mjs");
  writeFileSync(mutantPath, mutatedSrc, "utf8");
  writeFileSync(
    join(scriptsCheckDir, "reject-streak.mjs"),
    REJECT_STREAK_SRC,
    "utf8",
  );
  writeFileSync(
    join(scriptsCheckDir, "envelope-archive.mjs"),
    ENVELOPE_ARCHIVE_SRC,
    "utf8",
  );
  return { rootDir, mutantPath };
}

function runMutantCli(mutantPath, args, opts = {}) {
  const res = spawnSync(process.execPath, [mutantPath, ...args], {
    encoding: "utf8",
    ...opts,
  });
  if (res.error) {
    assert.fail(
      `mutant child process failed to spawn (infra failure, not a mutation signal): ${res.error.message}`,
    );
  }
  if (res.status === null) {
    assert.fail(
      `mutant child process terminated by signal ${res.signal} (infra failure, not a mutation signal)`,
    );
  }
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the source (found ${count}) -- 0 or 2+ is a test failure, not a skip`,
  );
}

// HYK-189 재작업 1R (coder-task.md §9): M1/M2 둘 다 harnessDir을 넘기지
// 않고 checkRelayHandshake({role})만 호출하는 경로를 거친다 -- 그때
// relay-handshake.mjs 자신의 기본값 `join(repoRoot(), ".harness")`가
// 발동하고, `repoRoot()`는 인자 없는 `git rev-parse --show-toplevel`을
// (자식 프로세스 자신의) cwd 기준으로 실행한다. 이 자식 프로세스에
// 명시적 `cwd`를 안 주면 부모(테스트 러너)의 cwd를 물려받아 **이
// 워크트리의 진짜 `.harness/`**를 읽게 된다 -- ORCH가 실측한 바로 그
// flaky의 원인(그 순간 실제 `.harness/coder.md`가 유효한 handshake였다).
// `cwd`를 os 임시 디렉터리 아래 새 mkdtemp 루트로 고정하면 그 루트는
// 어떤 git 워크트리에도 속하지 않으므로 `git rev-parse --show-toplevel`가
// 실패하고 `repoRoot()`는 catch로 그 임시 루트 자체를 반환한다 -- 그
// 결과 "기본값"이 이 시험이 통제하는 `<sandbox>/.harness`가 되어 실제
// 저장소 상태와 완전히 분리된다(§2 비타협 #3 "mkdtemp 안에서만"의 정신).
function makeSandboxRoot({ seedValidDefaultHandshake = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relay-handshake-sandbox-"));
  if (seedValidDefaultHandshake) {
    const harnessDir = join(root, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    writeValidFixture(harnessDir, "coder", "SANDBOX-AMBIENT-DEFAULT");
  }
  return root;
}

test("HYK-189 (e) mutation M1: removing the no-arg usage guard -> the exact usage-string contract breaks (RED signal; proves the guard is load-bearing), hermetic (cwd pinned off the real repo)", () => {
  const target =
    '  if (!role) {\n    console.error("usage: node relay-handshake.mjs <role> [harnessDir]");\n    process.exit(1);\n  }\n';
  assertExactlyOneMatch(RELAY_HANDSHAKE_SRC, target, "M1 usage guard");
  const mutated = RELAY_HANDSHAKE_SRC.replace(target, "");
  const { rootDir, mutantPath } = writeMutantCli(mutated);
  const sandboxRoot = makeSandboxRoot();
  try {
    const { exit, stderr } = runMutantCli(mutantPath, [], {
      cwd: sandboxRoot,
    });
    assert.equal(
      exit,
      1,
      "mutant still exits 1 (falls through to the generic path-not-found branch)",
    );
    assert.notEqual(
      stderr.trim(),
      USAGE_MESSAGE,
      "mutant must NOT produce the exact usage string anymore -- RED signal proving the (a) contract's usage guard is load-bearing",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

// 재작업 1R: 이 시험은 원래 "override 없는 임시 픽스처 + exit !== 0"으로
// M2를 단언했으나, 그 실패 신호가 방어가 아니라 "그 순간 이 워크트리의
// 실제 .harness/에 무엇이 있었는가"에서 나왔다(§9 ORCH 실측 -- 코더가
// 방금 쓴 .harness/coder.md가 유효한 handshake라 mutant가 우연히
// exit 0으로 «성공»해 단언이 깨졌다). 아래는 두 가지로 고쳤다:
// (1) cwd를 makeSandboxRoot()로 고정해 실제 저장소를 절대 건드리지
//     않는다(hermetic). (2) 결과를 "exit !== 0"이라는 느슨한 값이 아니라
//     "override 픽스처를 실제로 읽었는가"라는 더 강한 신호로 바꿨다 --
//     override 픽스처는 의도적으로 mismatch시켜, 올바른 구현이라면 ambient
//     상태와 무관하게 항상 "handshake mismatch"로 exit 1이어야 한다는
//     불변량을 먼저 real(비변조) CLI로 확인한 뒤, mutant가 그 불변량을
//     깨는지 본다. ambient 기본 위치를 "없음"과 "유효한 handshake로
//     시딩"이라는 두 조건 모두에서 반복해, «주변 상태가 있든 없든 같은
//     결함이 드러난다»는 것 자체를 시험으로 고정한다(§9 항목 3).
test("HYK-189 (e) mutation M2: removing the second positional arg (harnessDir override) -> a valid fixture in a custom dir is no longer honored (RED signal; proves passing harnessDirArg is load-bearing), hermetic and invariant across ambient-default state", () => {
  const target =
    "  const harnessDirArg = process.argv[3];\n  const result = harnessDirArg\n    ? checkRelayHandshake({ role, harnessDir: harnessDirArg })\n    : checkRelayHandshake({ role });\n";
  assertExactlyOneMatch(
    RELAY_HANDSHAKE_SRC,
    target,
    "M2 harnessDir passthrough",
  );
  const mutated = RELAY_HANDSHAKE_SRC.replace(
    target,
    "  const result = checkRelayHandshake({ role });\n",
  );
  const { rootDir, mutantPath } = writeMutantCli(mutated);
  try {
    for (const seedAmbient of [false, true]) {
      const sandboxRoot = makeSandboxRoot({
        seedValidDefaultHandshake: seedAmbient,
      });
      try {
        withFixtureDirCli((overrideDir) => {
          // override 픽스처는 의도적으로 mismatch -- 올바르게 override를
          // 읽는 구현이라면 항상 "handshake mismatch"로 exit 1이어야 한다.
          writeFileSync(
            join(overrideDir, "coder-task.md"),
            "task_id: OVERRIDE-REAL\ndropped_at: 2026-08-03 06:00 KST\n",
            "utf8",
          );
          writeFileSync(
            join(overrideDir, "coder.md"),
            "task_id: OVERRIDE-DIFFERENT\n\n>>> DONE: CODER @ 2026-08-03 06:10 KST\n",
            "utf8",
          );

          // 불변량 선확인: 변조 안 된 실제 CLI는 ambient 상태(seedAmbient)와
          // 무관하게 override를 읽어 항상 동일하게 실패해야 한다.
          const real = runCli(["coder", overrideDir], { cwd: sandboxRoot });
          assert.equal(
            real.exit,
            1,
            `real CLI must always honor the override and reject the mismatched fixture regardless of ambient default state (seedAmbient=${seedAmbient})`,
          );
          assert.match(
            real.stderr,
            /handshake mismatch/,
            `real CLI's failure reason must come from the override fixture's mismatch, not ambient state (seedAmbient=${seedAmbient})`,
          );

          // mutant: harnessDirArg를 무시하므로 sandboxRoot/.harness(ambient)를
          // 본다 -- ambient 유무에 따라 다른 이유로 불변량이 깨지는 것 자체가
          // "override가 전혀 읽히지 않았다"는 증거다.
          const mutant = runMutantCli(mutantPath, ["coder", overrideDir], {
            cwd: sandboxRoot,
          });
          if (seedAmbient) {
            assert.equal(
              mutant.exit,
              0,
              `mutant reads the seeded ambient default (a valid, unrelated handshake) instead of the override -- RED signal (seedAmbient=${seedAmbient})`,
            );
          } else {
            assert.equal(
              mutant.exit,
              1,
              `mutant still exits 1 here, but for the wrong reason (seedAmbient=${seedAmbient})`,
            );
            assert.doesNotMatch(
              mutant.stderr,
              /handshake mismatch/,
              `mutant's exit 1 must come from "task file not found" in the absent ambient default, NOT from ever reading the override's mismatch -- proves the override was never consulted (seedAmbient=${seedAmbient})`,
            );
          }
        });
      } finally {
        rmSync(sandboxRoot, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("HYK-189 (e) mutation M3: removing non-zero exit propagation on failure -> a blocked handshake wrongly reports success (RED signal; proves exit-code propagation is load-bearing)", () => {
  const target =
    "  if (result.ok) {\n    process.exit(0);\n  } else {\n    console.error(result.reason);\n    process.exit(1);\n  }\n";
  assertExactlyOneMatch(RELAY_HANDSHAKE_SRC, target, "M3 non-zero propagation");
  const mutated = RELAY_HANDSHAKE_SRC.replace(
    target,
    "  if (result.ok) {\n    process.exit(0);\n  } else {\n    console.error(result.reason);\n    process.exit(0);\n  }\n",
  );
  const { rootDir, mutantPath } = writeMutantCli(mutated);
  try {
    withFixtureDirCli((dir) => {
      // task_id 불일치 -> 실제 CLI라면 exit 1이어야 하는 명백한 계약
      // 위반 사례.
      writeFileSync(
        join(dir, "coder-task.md"),
        "task_id: HYK-189-real\ndropped_at: 2026-08-03 06:00 KST\n",
        "utf8",
      );
      writeFileSync(
        join(dir, "coder.md"),
        "task_id: HYK-189-different\n\n>>> DONE: CODER @ 2026-08-03 06:10 KST\n",
        "utf8",
      );
      const { exit } = runMutantCli(mutantPath, ["coder", dir]);
      assert.equal(
        exit,
        0,
        "mutant wrongly reports success (exit 0) for a blocked handshake -- RED signal proving non-zero exit propagation is load-bearing",
      );
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-189 §완료조건 (h): 자식 프로세스 실패(status===null·spawn error·
// timeout)는 계약 위반과 구별해 fail-closed 처리한다. runCli/runMutantCli
// 둘 다 이미 그 구분을 assert.fail로 명시한다(위 정의 참조) -- 여기서는
// 그 fail-closed 경로가 실제로 발동함을 존재하지 않는 스크립트 경로로
// 직접 확인한다(spawn 자체는 성공하지만 대상 파일이 없어 Node가 즉시
// 비정상 종료하는 경우까지 규정한다).
// ---------------------------------------------------------------------------
test("HYK-189 (h) CLI: spawning a nonexistent script path exits 1 too, but must not be misread as a legitimate handshake failure -- distinguishable only by stderr shape, not exit code", () => {
  const bogusPath = join(tmpdir(), "relay-handshake-does-not-exist.mjs");
  const res = spawnSync(process.execPath, [bogusPath], { encoding: "utf8" });
  assert.equal(
    res.error,
    undefined,
    "spawnSync itself starts node fine here (ENOENT-class spawn failures are the separate res.error/res.status===null case runCli/runMutantCli already fail-close on above)",
  );
  // This is the crux of (h): Node's own 'module not found' failure also
  // exits with status 1 -- textually indistinguishable from the CLI's own
  // legitimate exit(1) by exit code alone. Only the stderr SHAPE tells them
  // apart: Node's loader error never matches the usage string (a) or the
  // relay-handshake `reason` sentences (b)/(c)/(e) assert on. A naive
  // "exit === 1 -> handshake blocked" reading of this process's output
  // would wrongly count "the script wasn't even found" as "the handshake
  // contract was violated."
  assert.equal(
    res.status,
    1,
    "Node's module-not-found failure happens to share the CLI's own exit(1) code",
  );
  assert.doesNotMatch(
    res.stderr,
    /^task file not found|^result file not found|^usage: node relay-handshake\.mjs/m,
    "Node's own loader error must not be confused with any of relay-handshake.mjs's own error/usage strings",
  );
  assert.match(
    res.stderr,
    /Cannot find module|MODULE_NOT_FOUND/,
    "this exit(1) is Node failing to even load the script, not relay-handshake's own contract logic running",
  );
});
