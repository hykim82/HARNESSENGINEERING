// HYK-198-capwire-1 (coder-task.md §3, §4) -- 값 파일(concurrency-cap.json)
// -> `readConcurrencyCap` -> `judgeConcurrency` 결선을 감시기 관측 단계로
// 증명하는 시험.
//
// 이 스위트가 증명하는 것: (1) 값 파일을 바꿔 넣으면 `runCapObservationStep`이
// 부르는 `judgeConcurrency`의 판정이 그 값을 실제로 따라 움직인다(코어
// 호출이 진짜라는 행동 증명 -- 소스 문자열 검사가 아니다) (2) `watch-run.mjs`의
// 프로덕션 진입점(`runWatchOnce`)이 이 단계를 실제로 타고 로그 줄에
// `cap_status=`/`cap_verdict=`/`cap_value=`/`cap_source=`가 기존
// `axisLogSegment` 관례와 같은 모양으로 남는다 (3) 값 파일 부재·손상·
// schema 불일치 -> 어떤 숫자로도 판정하지 않고 실패 사유가 그대로
// 표면화된다(fail-closed) (4) 이 단계가 실패해도 나머지 네 축은 계속
// 돈다(감시기 계약 보존).
//
// 이 스위트가 증명하지 않는 것: 프로덕션 호출부가 실제 실행 장부
// (requested/inFlight)를 관측한다는 것 -- 아직 그 장부가 없다(coder-task.md
// §5, admission-core/HYK-195 미결). 프로덕션 호출부는 `requested: []`,
// `inFlight: []`를 쓴다(watch-run.mjs 주석 참조) -- 그래서 `runWatchOnce`
// 경유 시험은 항상 `decisions`가 비어 있다는 것만 확인하고, "cap이 결정을
// 어떻게 바꾸는가"는 `runCapObservationStep`을 직접 불러 requested를
// 주입하는 시험으로 증명한다.
//
// 모든 경로는 mkdtemp(실물 concurrency-cap.json·watch\ 폴더 미접촉).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runWatchOnce,
  buildLogLine,
  runCapObservationStep,
} from "./watch-run.mjs";
import { CONCURRENCY_CAP_REASON } from "./concurrency-cap-adapter.mjs";
import { CONCURRENCY_DECISION } from "./concurrency-core.mjs";

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
const NOW_MS = Date.parse("2026-08-07T20:00:00+09:00");

function tmpDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-cap-"));
}

function writeCap(dir, content) {
  const p = join(dir, "concurrency-cap.json");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

function progressingExec() {
  return JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" });
}

// ---------------------------------------------------------------------------
// §4 행동 증명: 값 파일의 global_hard_cap을 0·1·2·4·9로 바꿔 넣으면
// judgeConcurrency의 판정(START로 넘어가는 후보 수)이 그 값을 따라
// 움직인다. requested는 5개 후보를 주입해 cap이 병목이 되는 구간(0~4)과
// requested.length가 병목이 되는 구간(9)을 모두 관찰한다.
// ---------------------------------------------------------------------------
for (const [cap, expectedStarts] of [
  [0, 0],
  [1, 1],
  [2, 2],
  [4, 4],
  [9, 5], // requested.length(5) < cap -- 후보 수가 병목.
]) {
  test(`runCapObservationStep: global_hard_cap=${cap} in the value file drives judgeConcurrency's START count to ${expectedStarts} (1/1)`, () => {
    const dir = tmpDir();
    try {
      const capPath = writeCap(
        dir,
        JSON.stringify({
          schema_version: "concurrency-cap/v1",
          global_hard_cap: cap,
        }),
      );
      const requested = Array.from({ length: 5 }, (_, i) => ({
        issueId: `ISSUE-${i}`,
      }));
      const result = runCapObservationStep({
        capPath,
        requested,
        inFlight: [],
        maxConcurrent: 9,
      });
      assert.equal(result.status, "OK");
      assert.equal(result.verdict, "DECIDED");
      assert.equal(result.value, cap);
      const starts = result.decisions.filter(
        (d) => d.decision === CONCURRENCY_DECISION.START,
      ).length;
      assert.equal(
        starts,
        expectedStarts,
        `cap=${cap} must yield ${expectedStarts} START decisions, got ${starts}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("runCapObservationStep: inFlight already occupying slots reduces available starts as globalCap follows the file (1/1)", () => {
  const dir = tmpDir();
  try {
    const capPath = writeCap(
      dir,
      JSON.stringify({
        schema_version: "concurrency-cap/v1",
        global_hard_cap: 2,
      }),
    );
    const result = runCapObservationStep({
      capPath,
      requested: [{ issueId: "A" }, { issueId: "B" }],
      inFlight: [{ issueId: "ALREADY-RUNNING" }],
      maxConcurrent: 2,
    });
    assert.equal(result.status, "OK");
    const starts = result.decisions.filter(
      (d) => d.decision === CONCURRENCY_DECISION.START,
    ).length;
    assert.equal(
      starts,
      1,
      "1 slot already occupied out of cap=2 -> only 1 more start",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-198-capwire-2 §3(검토자 7번째 mutation 발견, 목록 밖) -- 이 호출부가
// `maxConcurrent`를 생략했을 때 실제로 주입하는 기본값(`?? capResult.cap`)
// 자체를 봉인한다. `decisions`로는 이 기본값을 관측할 수 없다(기본값이
// 항상 `globalCap`과 같아 clamp가 항등이라 999로 바꿔도 decisions가
// 똑같이 나온다 -- 위 값-추종 시험 5건이 전부 `maxConcurrent`를 명시
// 주입해 이 분기를 우회했던 이유가 이것이다). 그래서 실제로 주입된 값
// 자체(`appliedMaxConcurrent`)를 직접 단언한다.
// ---------------------------------------------------------------------------
test("runCapObservationStep: maxConcurrent omitted -> the value actually applied to judgeConcurrency equals the cap just read (seals HYK-198-capwire-2 §3 gap) (1/1)", () => {
  const dir = tmpDir();
  try {
    const capPath = writeCap(
      dir,
      JSON.stringify({
        schema_version: "concurrency-cap/v1",
        global_hard_cap: 3,
      }),
    );
    const result = runCapObservationStep({ capPath });
    assert.equal(
      result.appliedMaxConcurrent,
      3,
      "must equal the cap just read from the file, not any other default",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// fail-closed: 값 파일 부재·손상·schema 불일치 -> 어떤 숫자로도 판정하지
// 않는다(judgeConcurrency 자체를 부르지 않고 어댑터 실패 사유를 그대로
// 표면화).
// ---------------------------------------------------------------------------
test("runCapObservationStep: missing value file surfaces FILE_UNREADABLE, never guesses a number (1/1)", () => {
  const dir = tmpDir();
  try {
    const result = runCapObservationStep({
      capPath: join(dir, "does-not-exist.json"),
    });
    assert.equal(result.status, "CAP_READ_FAILED");
    assert.equal(result.verdict, CONCURRENCY_CAP_REASON.FILE_UNREADABLE);
    assert.equal(result.value, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runCapObservationStep: malformed JSON surfaces MALFORMED_JSON, never guesses a number (1/1)", () => {
  const dir = tmpDir();
  try {
    const capPath = writeCap(dir, "{ not json");
    const result = runCapObservationStep({ capPath });
    assert.equal(result.status, "CAP_READ_FAILED");
    assert.equal(result.verdict, CONCURRENCY_CAP_REASON.MALFORMED_JSON);
    assert.equal(result.value, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runCapObservationStep: schema mismatch (wrong schema_version) surfaces SCHEMA_MISMATCH, never guesses a number (1/1)", () => {
  const dir = tmpDir();
  try {
    const capPath = writeCap(
      dir,
      JSON.stringify({
        schema_version: "concurrency-cap/v0",
        global_hard_cap: 2,
      }),
    );
    const result = runCapObservationStep({ capPath });
    assert.equal(result.status, "CAP_READ_FAILED");
    assert.equal(result.verdict, CONCURRENCY_CAP_REASON.SCHEMA_MISMATCH);
    assert.equal(result.value, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// buildLogLine: axisLogSegment와 같은 4필드 shape.
// ---------------------------------------------------------------------------
test("buildLogLine: cap segment follows axisLogSegment's 4-field shape and defaults to NONE when capResult is omitted (2/2)", () => {
  const withCap = buildLogLine({
    nowIso: "2026-08-07T20:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
    },
    capResult: {
      status: "OK",
      verdict: "DECIDED",
      value: 2,
      source: "/x/concurrency-cap.json",
    },
  });
  assert.match(
    withCap,
    /cap_status=OK cap_verdict=DECIDED cap_value=2 cap_source=\/x\/concurrency-cap\.json/,
  );
  const withoutCap = buildLogLine({
    nowIso: "2026-08-07T20:00:00.000Z",
    detectorResult: {
      runnerFailure: false,
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
    },
  });
  assert.match(
    withoutCap,
    /cap_status=NONE cap_verdict=NONE cap_value=NONE cap_source=NONE/,
  );
});

// ---------------------------------------------------------------------------
// runWatchOnce 결선: 프로덕션 진입점이 이 단계를 실제로 탄다. capPath를
// mkdtemp로 명시 주입(실물 concurrency-cap.json 미접촉).
// ---------------------------------------------------------------------------
test("runWatchOnce: value file swapped between runs -> watch.log cap segment follows it (production entry point wiring) (1/1)", () => {
  const watchDir = tmpDir();
  const capDir = tmpDir();
  try {
    const capPath = writeCap(
      capDir,
      JSON.stringify({
        schema_version: "concurrency-cap/v1",
        global_hard_cap: 4,
      }),
    );
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
      capPath,
    });
    assert.equal(result.capResult.status, "OK");
    assert.equal(result.capResult.value, 4);
    assert.deepEqual(result.capResult.decisions, []);
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /cap_status=OK cap_verdict=DECIDED cap_value=4 cap_source=/,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(capDir, { recursive: true, force: true });
  }
});

test("runWatchOnce: value file missing -> watch.log cap segment reports CAP_READ_FAILED, and the other four axes still run (fail-closed, no crash) (1/1)", () => {
  const watchDir = tmpDir();
  const capDir = tmpDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({
          verdict: "PROGRESSING",
          reasonCode: "OK",
          seatLiveness: { status: "SEAT_LIVENESS_NOT_APPLICABLE" },
        }),
      capPath: join(capDir, "missing-concurrency-cap.json"),
    });
    assert.equal(result.capResult.status, "CAP_READ_FAILED");
    assert.equal(
      result.capResult.verdict,
      CONCURRENCY_CAP_REASON.FILE_UNREADABLE,
    );
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(
      logText,
      /cap_status=CAP_READ_FAILED cap_verdict=FILE_UNREADABLE cap_value=NONE/,
    );
    assert.match(logText, /seat_status=SEAT_LIVENESS_NOT_APPLICABLE/);
    assert.match(logText, /verdict=PROGRESSING reason=OK/);
    const record = JSON.parse(fs.readFileSync(result.aliveRecordPath, "utf8"));
    assert.equal(record.verdict, "PROGRESSING");
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
    fs.rmSync(capDir, { recursive: true, force: true });
  }
});

test("runWatchOnce: default capPath (no override) reads the real committed concurrency-cap.json read-only and does not throw (1/1)", () => {
  const watchDir = tmpDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => progressingExec(),
    });
    assert.equal(result.capResult.status, "OK");
    assert.equal(typeof result.capResult.value, "number");
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §3-3 "시험은 실물에 쓰지 마라") -- mkdtemp만
// 썼고, 실물 concurrency-cap.json은 읽기만 했다(위 마지막 시험).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "watch-run-cap.test.mjs must leave the real worktree exactly as it found it",
  );
});
