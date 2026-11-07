// HYK-493-memory-reopen-1 (coder-task.md §1 F-2 · §2 product_scope) --
// watch-run.mjs의 새 단계("메모리 재개 재시도 깨움") 계약 시험. 매 tick
// <watchDir>/memory-gate-state.json을 읽어, 게이트가 닫혀 있고(dry_run이
// 아니면) free 메모리 2표본을 재서 threshold_mb+여유를 넘으면 기존 seat
// escalation 통로로 ORCH에게 "memory reopened: gate retry" 1건을 보낸다.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 라이브 실물 -- 이 스위트는 실 `orca` 프로세스를 전혀 접촉하지 않는다
//    (fake execFn만 주입, live_send_ban). 라이브 왕복 검증은 병합 뒤
//    다음 실제 게이트 닫힘 1회에서 ORCH가 재시도 escalation을 받은 시각
//    기록으로 대체한다(coder-task.md §3 완료조건4).
// 2. run-id.json 읽기는 전부 readFn 주입으로 가로챈다(seat-escalation-
//    wire.test.mjs §S11-3과 동일 이유 -- watchDir의 부모는 공유 OS tmp
//    루트라 실 파일을 거기 쓰지 않는다).
// 3. 실 관제실 watch\memory-gate-state.json · watch\memory-reopen-notify-
//    state.json은 전혀 건드리지 않는다 -- 이 시험은 mkdtemp로 격리된
//    watchDir "안"에만 합성 상태 파일을 쓴다(그 파일은 이 시험 전용
//    디렉터리라 실 fs를 써도 안전, seat-escalation-wire.test.mjs §S11-3과
//    동일 원칙).
// 4. 표본 간격 -- 이 스위트는 sleepFn을 항상 주입해 실제 30초를 기다리지
//    않는다(기본값 defaultMemoryReopenSleep은 운영 경로 전용).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { runWatchOnce } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

const NOW_MS = Date.parse("2026-08-03T18:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-mem-reopen-watch-"));
}

function progressingExec() {
  return JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" });
}

// 게이트 상태 파일 합성 -- memory-gate.ps1의 Write-GateState(관제실,
// 읽기만)가 실제로 쓰는 v1 모양 그대로(schema/status/closed_at/
// threshold_mb/round/pending_cmd/dry_run).
function writeGateState(watchDir, overrides = {}) {
  const base = {
    schema: "memory-gate-state/v1",
    status: "closed",
    verdict: "CLOSED_BELOW_THRESHOLD",
    round: "HYK-999-fake-1",
    at: "2026-11-05T20:00:00+09:00",
    closed_at: "2026-11-05T20:00:00+09:00",
    min_free_mb: 2800,
    threshold_mb: 3000,
    mode: "NORMAL",
    role: "CODER",
    worktree: "C:/fake/wt",
    pending_cmd: 'orca-worker-seat.cmd -Role CODER -Worktree "C:/fake/wt"',
    dry_run: false,
  };
  fs.writeFileSync(
    join(watchDir, "memory-gate-state.json"),
    JSON.stringify({ ...base, ...overrides }),
    "utf8",
  );
}

// run-id.json을 실 fs에 쓰지 않고 readFn 주입으로 가로챈다(위 S11-2). 그
// 밖 경로는 전부 실 fs.readFileSync로 위임한다(watchDir 아래 상태 파일은
// mkdtemp로 격리된 이 시험 전용 디렉터리라 실 fs를 써도 안전).
function makeReadFnWithRunId(runIdPath, runIdContent) {
  return (p, enc) => {
    if (p === runIdPath) {
      if (runIdContent === undefined) {
        const err = new Error("no such file");
        err.code = "ENOENT";
        throw err;
      }
      return runIdContent;
    }
    return fs.readFileSync(p, enc);
  };
}

function withWatchDir(fn) {
  const watchDir = tmpWatchDir();
  try {
    fn(watchDir);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
}

// 표본 재측 seam -- 값 목록을 순서대로 돌려주고(마지막 값은 반복), 호출
// 횟수를 센다(§2ⓒ⑸ "재측 seam 호출 0" 단언용).
function makeSampleFn(values) {
  const calls = { count: 0 };
  const fn = () => {
    const v = values[Math.min(calls.count, values.length - 1)];
    calls.count += 1;
    return v;
  };
  return { fn, calls };
}

function noSleep() {
  // 시험은 실제 간격을 기다리지 않는다(위 S11-4).
}

const RUN_ID_CONTENT = JSON.stringify({ runId: "run_live_1" });

test("⑴ RED 먼저(수리 뒤 확인): 닫힘 + 문턱+여유 이상 2표본 -> escalation 1건, 명령 배열 원문 (1/1)", () => {
  withWatchDir((watchDir) => {
    writeGateState(watchDir);
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const { fn: sampleFn, calls } = makeSampleFn([3300, 3300]);
    const sentArgvs = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
      memoryReopenExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
      memoryReopenSampleFn: sampleFn,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(calls.count, 2, "표본 2개를 잰다");
    assert.equal(sentArgvs.length, 1, "통지 1건");
    assert.deepEqual(sentArgvs[0], [
      "orchestration",
      "send",
      "--to",
      "run:run_live_1",
      "--type",
      "status",
      "--subject",
      "memory reopened: gate retry",
      "--body",
      sentArgvs[0][9],
      "--json",
    ]);
    assert.match(sentArgvs[0][9], /round=HYK-999-fake-1/);
    assert.match(sentArgvs[0][9], /threshold_mb=3000/);
    assert.match(sentArgvs[0][9], /free_samples_mb=3300,3300/);
    assert.match(sentArgvs[0][9], /closed_at=2026-11-05T20:00:00\+09:00/);
    assert.match(sentArgvs[0][9], /pending_cmd=orca-worker-seat\.cmd/);
    assert.equal(result.memoryReopen.sent, true);
    assert.match(
      result.line,
      /memory_reopen_sent=true memory_reopen_reason=NONE/,
    );
  });
});

test("⑵ 한 표본만 미달(3,300·3,100, 문턱 3,000+여유 200=3,200줄) -> escalation 0건, 재측은 그대로 2회 (1/1)", () => {
  withWatchDir((watchDir) => {
    writeGateState(watchDir);
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const { fn: sampleFn, calls } = makeSampleFn([3300, 3100]);
    const sentArgvs = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
      memoryReopenExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
      memoryReopenSampleFn: sampleFn,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(calls.count, 2, "미달이어도 두 표본은 잰다(§2ⓒ⑵)");
    assert.equal(sentArgvs.length, 0, "문턱 미달은 보내지 않는다");
    assert.equal(result.memoryReopen.sent, false);
    assert.equal(result.memoryReopen.reasonToken, "MEMORY_REOPEN_BELOW_LINE");
    assert.match(
      result.line,
      /memory_reopen_sent=false memory_reopen_reason=MEMORY_REOPEN_BELOW_LINE/,
    );
  });
});

test("⑶ 같은 closed_at으로 두 tick -> escalation은 1건만(dedupe) (1/1)", () => {
  withWatchDir((watchDir) => {
    writeGateState(watchDir);
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const sentArgvs = [];
    const callOnce = () => {
      const { fn } = makeSampleFn([3300, 3300]);
      return runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        now: NOW_MS,
        execFn: () => progressingExec(),
        readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
        memoryReopenExecFn: (argv) => {
          sentArgvs.push(argv);
          return { ok: true };
        },
        memoryReopenSampleFn: fn,
        memoryReopenSleepFn: noSleep,
      });
    };
    const first = callOnce();
    assert.equal(sentArgvs.length, 1, "첫 tick: 1건");
    assert.equal(first.memoryReopen.sent, true);
    const second = callOnce();
    assert.equal(sentArgvs.length, 1, "둘째 tick(같은 closed_at): 추가 0건");
    assert.equal(second.memoryReopen.sent, false);
    assert.equal(
      second.memoryReopen.reasonToken,
      "MEMORY_REOPEN_ALREADY_NOTIFIED",
    );
  });
});

test("⑷ closed_at이 바뀌면(새 닫힘) 다시 1건 (1/1)", () => {
  withWatchDir((watchDir) => {
    writeGateState(watchDir, { closed_at: "2026-11-05T20:00:00+09:00" });
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const sentArgvs = [];
    const callOnce = () => {
      const { fn } = makeSampleFn([3300, 3300]);
      return runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        now: NOW_MS,
        execFn: () => progressingExec(),
        readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
        memoryReopenExecFn: (argv) => {
          sentArgvs.push(argv);
          return { ok: true };
        },
        memoryReopenSampleFn: fn,
        memoryReopenSleepFn: noSleep,
      });
    };
    callOnce();
    assert.equal(sentArgvs.length, 1, "첫 닫힘: 1건");
    writeGateState(watchDir, { closed_at: "2026-11-05T21:30:00+09:00" });
    callOnce();
    assert.equal(sentArgvs.length, 2, "새 닫힘(closed_at 변경): 다시 1건");
    assert.match(sentArgvs[1][9], /closed_at=2026-11-05T21:30:00\+09:00/);
  });
});

// ---- ⑸ 상태별 "아무것도 안 함" 경로(0건 + 재측 seam 호출 0 + 사유 토큰) ----

function assertNoOpScenario(label, { setup, expectedReasonToken }) {
  withWatchDir((watchDir) => {
    setup(watchDir);
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const { fn: sampleFn, calls } = makeSampleFn([3300, 3300]);
    const sentArgvs = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
      memoryReopenExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
      memoryReopenSampleFn: sampleFn,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(sentArgvs.length, 0, `${label}: escalation 0건`);
    assert.equal(calls.count, 0, `${label}: 재측 seam 호출 0`);
    assert.equal(result.memoryReopen.sent, false);
    assert.equal(result.memoryReopen.reasonToken, expectedReasonToken, label);
    assert.match(
      result.line,
      new RegExp(
        `memory_reopen_sent=false memory_reopen_reason=${expectedReasonToken}`,
      ),
    );
  });
}

test("⑸-a status=open -> 0건, 재측 0, 사유=MEMORY_REOPEN_STATUS_NOT_CLOSED (1/1)", () => {
  assertNoOpScenario("open", {
    setup: (wd) => writeGateState(wd, { status: "open" }),
    expectedReasonToken: "MEMORY_REOPEN_STATUS_NOT_CLOSED",
  });
});

test("⑸-b status=deferred -> 0건, 재측 0, 사유=MEMORY_REOPEN_STATUS_NOT_CLOSED (1/1)", () => {
  assertNoOpScenario("deferred", {
    setup: (wd) => writeGateState(wd, { status: "deferred" }),
    expectedReasonToken: "MEMORY_REOPEN_STATUS_NOT_CLOSED",
  });
});

test("⑸-c status=dryrun-open -> 0건, 재측 0, 사유=MEMORY_REOPEN_STATUS_NOT_CLOSED (1/1)", () => {
  assertNoOpScenario("dryrun-open", {
    setup: (wd) => writeGateState(wd, { status: "dryrun-open" }),
    expectedReasonToken: "MEMORY_REOPEN_STATUS_NOT_CLOSED",
  });
});

test("⑸-d status=closed + dry_run=true -> 0건, 재측 0, 사유=MEMORY_REOPEN_DRY_RUN (1/1)", () => {
  assertNoOpScenario("dry_run", {
    setup: (wd) => writeGateState(wd, { status: "closed", dry_run: true }),
    expectedReasonToken: "MEMORY_REOPEN_DRY_RUN",
  });
});

test("⑸-e 상태 파일 없음 -> 0건, 재측 0, 사유=MEMORY_REOPEN_STATE_MISSING (1/1)", () => {
  assertNoOpScenario("missing", {
    setup: () => {
      // memory-gate-state.json을 쓰지 않는다(§2ⓘ "상태 파일 없음").
    },
    expectedReasonToken: "MEMORY_REOPEN_STATE_MISSING",
  });
});

test("⑸-f 무효 JSON -> 0건, 재측 0, 사유=MEMORY_REOPEN_STATE_INVALID_JSON (1/1)", () => {
  assertNoOpScenario("invalid_json", {
    setup: (wd) =>
      fs.writeFileSync(
        join(wd, "memory-gate-state.json"),
        "{not valid json",
        "utf8",
      ),
    expectedReasonToken: "MEMORY_REOPEN_STATE_INVALID_JSON",
  });
});

test("⑸-g schema 불일치 -> 0건, 재측 0, 사유=MEMORY_REOPEN_SCHEMA_MISMATCH (1/1)", () => {
  assertNoOpScenario("schema_mismatch", {
    setup: (wd) => writeGateState(wd, { schema: "memory-gate-state/v2" }),
    expectedReasonToken: "MEMORY_REOPEN_SCHEMA_MISMATCH",
  });
});

// ---- ⑻ verdict 허용 목록(coder-task.md §2 product_scope ⓘⓘ) -- 허용 3종만
// 깨움 후보가 되고(두 표본 재측까지 간다), 그 밖 닫힘 5종 + verdict 없음은
// 재측 seam 호출 0으로 끝난다(assertNoOpScenario 재사용) ----

function assertWakeEligibleScenario(label, verdict) {
  withWatchDir((watchDir) => {
    writeGateState(watchDir, { verdict });
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const { fn: sampleFn, calls } = makeSampleFn([3300, 3300]);
    const sentArgvs = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
      memoryReopenExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
      memoryReopenSampleFn: sampleFn,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(calls.count, 2, `${label}: 허용 verdict는 두 표본을 잰다`);
    assert.equal(sentArgvs.length, 1, `${label}: 허용 verdict는 통지 1건`);
    assert.equal(result.memoryReopen.sent, true, label);
  });
}

test("⑻-a verdict=CLOSED_BELOW_THRESHOLD(허용 3종 중 1) -> 두 표본 재측 + 통지 1건 (1/1)", () => {
  assertWakeEligibleScenario(
    "CLOSED_BELOW_THRESHOLD",
    "CLOSED_BELOW_THRESHOLD",
  );
});

test("⑻-b verdict=CLOSED_STEP2_BELOW_LINE(허용 3종 중 1) -> 두 표본 재측 + 통지 1건 (1/1)", () => {
  assertWakeEligibleScenario(
    "CLOSED_STEP2_BELOW_LINE",
    "CLOSED_STEP2_BELOW_LINE",
  );
});

test("⑻-c verdict=CLOSED_STEP4B_BELOW_LINE(허용 3종 중 1) -> 두 표본 재측 + 통지 1건 (1/1)", () => {
  assertWakeEligibleScenario(
    "CLOSED_STEP4B_BELOW_LINE",
    "CLOSED_STEP4B_BELOW_LINE",
  );
});

test("⑻-d verdict=CLOSED_UNSTABLE(비허용) -> 0건, 재측 0, 사유=MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE (1/1)", () => {
  assertNoOpScenario("CLOSED_UNSTABLE", {
    setup: (wd) => writeGateState(wd, { verdict: "CLOSED_UNSTABLE" }),
    expectedReasonToken: "MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE",
  });
});

test("⑻-e verdict=CLOSED_GAME_MODE_RUNNER_AXIS(비허용) -> 0건, 재측 0, 사유=MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE (1/1)", () => {
  assertNoOpScenario("CLOSED_GAME_MODE_RUNNER_AXIS", {
    setup: (wd) =>
      writeGateState(wd, { verdict: "CLOSED_GAME_MODE_RUNNER_AXIS" }),
    expectedReasonToken: "MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE",
  });
});

test("⑻-f verdict=CLOSED_VMMEM_RESIDENT(비허용) -> 0건, 재측 0, 사유=MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE (1/1)", () => {
  assertNoOpScenario("CLOSED_VMMEM_RESIDENT", {
    setup: (wd) => writeGateState(wd, { verdict: "CLOSED_VMMEM_RESIDENT" }),
    expectedReasonToken: "MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE",
  });
});

test("⑻-g verdict=CLOSED_STEP2_VMMEM_RESIDENT(비허용) -> 0건, 재측 0, 사유=MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE (1/1)", () => {
  assertNoOpScenario("CLOSED_STEP2_VMMEM_RESIDENT", {
    setup: (wd) =>
      writeGateState(wd, { verdict: "CLOSED_STEP2_VMMEM_RESIDENT" }),
    expectedReasonToken: "MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE",
  });
});

test("⑻-h verdict=CLOSED_STEP4B_VMMEM_RESIDENT(비허용) -> 0건, 재측 0, 사유=MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE (1/1)", () => {
  assertNoOpScenario("CLOSED_STEP4B_VMMEM_RESIDENT", {
    setup: (wd) =>
      writeGateState(wd, { verdict: "CLOSED_STEP4B_VMMEM_RESIDENT" }),
    expectedReasonToken: "MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE",
  });
});

test("⑻-i verdict 없음(필드 자체가 null) -> 0건, 재측 0, 사유=MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE (1/1)", () => {
  assertNoOpScenario("verdict_missing", {
    setup: (wd) => writeGateState(wd, { verdict: null }),
    expectedReasonToken: "MEMORY_REOPEN_VERDICT_NOT_ELIGIBLE",
  });
});

// ---- ⑹ 전송 실패 -> 사유 칸 + 다음 tick 재시도 ----

test("⑹ 전송 실패(fake exec ok:false) -> 사유 칸에 SEND_FAILED, 상태 미기록(다음 tick 재시도 성공) (1/1)", () => {
  withWatchDir((watchDir) => {
    writeGateState(watchDir);
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const { fn: sampleFn1 } = makeSampleFn([3300, 3300]);
    const failing = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
      memoryReopenExecFn: () => ({ ok: false, reason: "orca_down" }),
      memoryReopenSampleFn: sampleFn1,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(failing.memoryReopen.sent, false);
    assert.match(
      failing.memoryReopen.reasonToken,
      /^MEMORY_REOPEN_SEND_FAILED:/,
    );
    assert.match(
      failing.line,
      /memory_reopen_reason=MEMORY_REOPEN_SEND_FAILED:/,
    );

    const sentArgvs = [];
    const { fn: sampleFn2 } = makeSampleFn([3300, 3300]);
    const retried = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 15 * 60000,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, RUN_ID_CONTENT),
      memoryReopenExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
      memoryReopenSampleFn: sampleFn2,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(
      sentArgvs.length,
      1,
      "전송 실패는 상태를 남기지 않아 다음 tick이 재시도한다",
    );
    assert.equal(retried.memoryReopen.sent, true);
  });
});

test("Run id 미설정: run-id.json이 없으면 NO_RUN_CONFIGURED로 보내기를 생략한다 (1/1)", () => {
  withWatchDir((watchDir) => {
    writeGateState(watchDir);
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const { fn: sampleFn } = makeSampleFn([3300, 3300]);
    const sentArgvs = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, undefined),
      memoryReopenExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
      memoryReopenSampleFn: sampleFn,
      memoryReopenSleepFn: noSleep,
    });
    assert.equal(sentArgvs.length, 0);
    assert.equal(
      result.memoryReopen.reasonToken,
      "MEMORY_REOPEN_NO_RUN_CONFIGURED",
    );
  });
});

// ---- ⑺ 무회귀: 다른 축(cap/seat/escalation/sweep/wake 등) 표시는 그대로 ----

test("무회귀: memory-gate-state.json이 전혀 없는 기존 호출 패턴은 다른 축 표시에 영향이 없다 (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      readFn: makeReadFnWithRunId(runIdPath, undefined),
    });
    assert.match(result.line, /verdict=PROGRESSING reason=OK/);
    assert.match(
      result.line,
      /memory_reopen_sent=false memory_reopen_reason=MEMORY_REOPEN_STATE_MISSING/,
    );
  });
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (postStatus !== preStatus || postDiffStat !== preDiffStat) {
    throw new Error(
      "git tree changed during this suite -- synthetic watchDir/run-id.json interception leaked into the real repo",
    );
  }
});
