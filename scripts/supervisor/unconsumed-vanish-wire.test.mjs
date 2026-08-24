// HYK-341-vanished-unresolved (coder-task.md §4) -- «사라진 미소비 의심
// 대상»이 조용히 지워지지 않고 명시 상태(VANISHED_UNRESOLVED)로
// 기록·통지되는지 확인하는 결선 계약 시험.
//
// §0 M2 재현: 직전 tick에 SUSPECTED_UNCONSUMED로 worst였던 워크트리가
// 다음 tick에 (소비 흔적 없이) 아예 사라지면 -- 조용히 worstCount만
// 줄어드는 것이 아니라 watch.log에 VANISHED_UNRESOLVED가 남고,
// last-run.json에도 전체 목록이 남고, reach 축(§4 요구6)으로도 도달해야
// 한다.
//
// 이 계약이 보장하지 않는 것(S11):
// 1. judgeUnconsumedAcrossWorktrees 자신의 판정(무엇이 SUSPECTED인가)은
//    unconsumed-wire.test.mjs/unconsumed-receipt-signal.test.mjs가
//    전담한다 -- 여기는 execFn으로 그 출력을 직접 합성해 "사라짐 추적"
//    결선만 본다(watch-run-reach.test.mjs의 idleAbandonedExec와 동일
//    패턴 -- 실 orch-stall-detect.mjs 스폰은 이 시험의 대상이 아니다).
// 2. 실제 git worktree remove는 만들지 않는다 -- existsFn을 주입해
//    "그 경로가 이제 없다"는 사실만 결정적으로 재현한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runWatchOnce, computeVanishedUnconsumedPaths } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-08-24T00:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-unconsumed-vanish-"));
}

// existsSync를 그대로 위임하되, missingPaths에 있는 경로만 강제로 false를
// 낸다 -- runWatchOnce 내부의 다른 모든 existsFn 사용(watchDir/watch.log
// 등 실경로 확인)은 건드리지 않는다.
function makeExistsFn(missingPaths) {
  const missing = new Set(missingPaths);
  return (p) => {
    if (missing.has(p)) return false;
    return existsSync(p);
  };
}

function suspectedExec(worstPaths) {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    unconsumed: {
      status: "UNCONSUMED_JUDGED",
      verdict: "SUSPECTED_UNCONSUMED",
      worstCount: worstPaths.length,
      totalWorktrees: worstPaths.length,
      worstWorktreePaths: worstPaths,
    },
  });
}

function consumedExec() {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    unconsumed: {
      status: "UNCONSUMED_JUDGED",
      verdict: "CONSUMED",
      worstCount: 0,
      totalWorktrees: 1,
      worstWorktreePaths: [],
    },
  });
}

function lastLine(watchDir) {
  const text = fs.readFileSync(join(watchDir, "watch.log"), "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines[lines.length - 1];
}
function lastRun(watchDir) {
  return JSON.parse(fs.readFileSync(join(watchDir, "last-run.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// (0) 순수 함수 단위 시험.
// ---------------------------------------------------------------------------
test("computeVanishedUnconsumedPaths: 존재하는 경로는 제외, 존재하지 않는 경로만 vanished로 남는다 (1/1)", () => {
  const existsFn = (p) => p === "still-here";
  const result = computeVanishedUnconsumedPaths({
    previousSuspectedPaths: ["still-here", "gone-now"],
    existsFn,
  });
  assert.deepEqual(result, ["gone-now"]);
});

test("computeVanishedUnconsumedPaths: existsFn이 던지면 '사라졌다'로 단정하지 않는다(보수적으로 '아직 있다') (1/1)", () => {
  const existsFn = () => {
    throw new Error("EPERM");
  };
  const result = computeVanishedUnconsumedPaths({
    previousSuspectedPaths: ["maybe-gone"],
    existsFn,
  });
  assert.deepEqual(result, []);
});

test("computeVanishedUnconsumedPaths: previousSuspectedPaths가 비었거나 잘못된 값이면 항상 빈 배열 (1/1)", () => {
  assert.deepEqual(
    computeVanishedUnconsumedPaths({
      previousSuspectedPaths: [],
      existsFn: () => false,
    }),
    [],
  );
  assert.deepEqual(
    computeVanishedUnconsumedPaths({
      previousSuspectedPaths: null,
      existsFn: () => false,
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// (1) §0 M2 재현 e2e: tick1 SUSPECTED(worst=1) -> tick2 그 경로가 사라짐
// -> watch.log에 VANISHED_UNRESOLVED, last-run.json에 전체 목록.
// ---------------------------------------------------------------------------
test("HYK-341: 직전 tick에 SUSPECTED_UNCONSUMED였던 워크트리가 다음 tick에 사라지면 -- unconsumed_verdict=VANISHED_UNRESOLVED가 watch.log에 남고 last-run.json에도 전체 경로가 남는다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  const fakePath = join(watchDir, "fake-worktree-a");
  fs.mkdirSync(fakePath, { recursive: true }); // tick1 시점엔 "존재"해야 한다.
  try {
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => suspectedExec([fakePath]),
    });
    const line1 = lastLine(watchDir);
    assert.match(line1, /unconsumed_verdict=SUSPECTED_UNCONSUMED/, line1);
    assert.doesNotMatch(line1, /VANISHED_UNRESOLVED/, line1);

    // tick2: 이 경로가 이제 없다(existsFn 주입으로 결정적 재현).
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 60_000,
      execFn: () => consumedExec(),
      existsFn: makeExistsFn([fakePath]),
    });
    const line2 = lastLine(watchDir);
    assert.match(line2, /unconsumed_verdict=VANISHED_UNRESOLVED/, line2);
    assert.match(
      line2,
      /unconsumed_vanished_worktrees=1 unconsumed_vanished_worktree_detail=fake-worktree-a/,
      line2,
    );

    const record = lastRun(watchDir);
    assert.deepEqual(record.unconsumedVanishedWorktrees, [fakePath]);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (2) 오탐 0: 정상 소비(CONSUMED, 애초에 worst 목록에 오른 적 없음) 후
// 워크트리가 사라져도 VANISHED_UNRESOLVED가 발화하지 않는다 (§4 요구4).
// ---------------------------------------------------------------------------
test("HYK-341 오탐0: 애초에 SUSPECTED였던 적 없는(정상 CONSUMED) 워크트리가 사라져도 VANISHED_UNRESOLVED는 발화하지 않는다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  const fakePath = join(watchDir, "fake-worktree-ok");
  fs.mkdirSync(fakePath, { recursive: true });
  try {
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 60_000,
      execFn: () => consumedExec(),
      existsFn: makeExistsFn([fakePath]),
    });
    const line2 = lastLine(watchDir);
    assert.doesNotMatch(line2, /VANISHED_UNRESOLVED/, line2);
    assert.doesNotMatch(line2, /unconsumed_vanished_worktrees=/, line2);
    const record = lastRun(watchDir);
    assert.deepEqual(record.unconsumedVanishedWorktrees, []);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (3) 상시 발화 금지: 사라진 뒤 다음 tick에는(상태가 이미 vanished 목록을
// 소비해 다시 빈 목록을 저장했으므로) 같은 사라짐을 또 발화하지 않는다.
// ---------------------------------------------------------------------------
test("HYK-341 상시발화 금지: 한 번 VANISHED_UNRESOLVED가 찍힌 다음 tick(같은 조건 유지)에는 다시 발화하지 않는다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  const fakePath = join(watchDir, "fake-worktree-b");
  fs.mkdirSync(fakePath, { recursive: true });
  try {
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => suspectedExec([fakePath]),
    });
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 60_000,
      execFn: () => consumedExec(),
      existsFn: makeExistsFn([fakePath]),
    });
    assert.match(lastLine(watchDir), /VANISHED_UNRESOLVED/);

    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 120_000,
      execFn: () => consumedExec(),
      existsFn: makeExistsFn([fakePath]),
    });
    const line3 = lastLine(watchDir);
    assert.doesNotMatch(line3, /VANISHED_UNRESOLVED/, line3);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (4) §4 요구6 실증: VANISHED_UNRESOLVED가 기존 reach 축(§0 "새 축 금지")을
// 통해 실제로 통지 파일 + 아침 보고에 도달한다(HYK-240 §4c와 동일 패턴,
// 프로덕션 진입점 그대로).
// ---------------------------------------------------------------------------
test("HYK-341 §4 요구6: VANISHED_UNRESOLVED가 기존 reach 축을 통해 통지 파일 + 아침 보고에 도달한다 (2/2)", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = join(watchDir, "받는함-테스트");
  const fakePath = join(watchDir, "fake-worktree-c");
  fs.mkdirSync(fakePath, { recursive: true });
  try {
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => suspectedExec([fakePath]),
    });
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 60_000,
      execFn: () => consumedExec(),
      existsFn: makeExistsFn([fakePath]),
      notifyDir,
    });
    assert.ok(
      result.reachResult.noticePath,
      "a transition notice must be written when VANISHED_UNRESOLVED newly opens",
    );
    assert.ok(fs.existsSync(result.reachResult.noticePath));
    const report = fs.readFileSync(join(watchDir, "morning-report.md"), "utf8");
    assert.match(report, /워커 결과 미소비/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-341 2R P1-2 (검토 원문): 상태 파일 누락·파손·읽기 실패를 구분하고,
// 파손·읽기 실패는 표면화한다("없음"과 "모름"을 가른다).
// ---------------------------------------------------------------------------

// (P1-2-a) 검토자 probe 그대로 재현: 상태 파일이 파손돼 있으면(직전
// tick의 진짜 의심 목록을 알 수 없음) vanishedPaths는 복구할 수 없지만
// (구조적 한계, 정직 기재), 그 파손 자체는 이제 조용히 넘어가지 않고
// unconsumed_status에 표면화된다.
test("HYK-341 2R P1-2: 상태 파일이 파손(JSON 파싱 불가)돼 있으면 -- vanishedPaths는 복구 못 해도 unconsumed_status=UNCONSUMED_VANISH_STATE_CORRUPTED로 표면화된다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      "{ not valid json",
      "utf8",
    );
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    assert.match(
      line,
      /unconsumed_status=UNCONSUMED_VANISH_STATE_CORRUPTED/,
      line,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-b) 형식 위반(파싱은 되지만 suspectedPaths가 배열이 아님)도 같은
// "파손" 취급이다 -- JSON.parse 성공 여부 하나만으로 판정을 좁히지
// 않는다.
test("HYK-341 2R P1-2: 상태 파일이 파싱은 되지만 형식 위반(suspectedPaths가 배열이 아님)이면 -- 역시 CORRUPTED로 표면화된다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      JSON.stringify({ suspectedPaths: "not-an-array" }),
      "utf8",
    );
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    assert.match(line, /unconsumed_status=UNCONSUMED_VANISH_STATE_CORRUPTED/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-c) 대조군 -- "파일이 아직 없음"(첫 tick, 정상)은 CORRUPTED로
// 표면화되지 않는다(§2 "누락과 파손은 다르다").
test("HYK-341 2R P1-2 대조군: 상태 파일이 아예 없음(첫 tick, 정상)은 CORRUPTED로 표면화되지 않는다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    assert.doesNotMatch(line, /UNCONSUMED_VANISH_STATE_CORRUPTED/, line);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-d) 쓰기 실패도 조용히 삼키지 않는다 -- writeFn을 주입해 저장
// 실패를 결정적으로 재현한다.
test("HYK-341 2R P1-2: 상태 파일 쓰기(write) 자체가 실패해도 -- 조용히 삼켜지지 않고 표면화된다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const failingWriteFn = (p, ...rest) => {
      if (String(p).endsWith("unconsumed-vanish-state.json")) {
        throw new Error("simulated disk full");
      }
      return fs.writeFileSync(p, ...rest);
    };
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
      writeFn: failingWriteFn,
    });
    assert.match(line, /unconsumed_status=UNCONSUMED_VANISH_STATE_CORRUPTED/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-e) §4 요구6과 동일 원칙: 파손 표면화도 기존 reach 축(badStatuses)
// 을 타고 사람에게 도달한다.
test("HYK-341 2R P1-2: 상태 파일 파손이 reach 축(badStatuses)을 통해 통지 파일까지 도달한다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = join(watchDir, "받는함-테스트");
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      "{ not valid json",
      "utf8",
    );
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
      notifyDir,
    });
    assert.ok(
      result.reachResult.noticePath,
      "vanish-state corruption must fire a reach notice",
    );
    assert.ok(fs.existsSync(result.reachResult.noticePath));
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-341 3R P1-2 (검토 원문): suspectedPaths 배열 원소까지 닫힌 스키마로
// 검증한다 -- 배열 자체는 유효해도 그 안의 비문자 원소는 이제 조용히
// 필터링되지 않고 배열째로 CORRUPTED다.
// ---------------------------------------------------------------------------

// (P1-2-f) §0 검토자 2R probe 그대로 재현: `{"suspectedPaths":[42]}`.
test("HYK-341 3R P1-2: 검토자 probe 재현 -- suspectedPaths=[42](비문자 원소)는 조용히 필터링되지 않고 CORRUPTED로 드러난다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      JSON.stringify({ suspectedPaths: [42] }),
      "utf8",
    );
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    assert.match(line, /unconsumed_status=UNCONSUMED_VANISH_STATE_CORRUPTED/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-g) 혼합 배열(문자열 + 비문자)도 부분 필터링 없이 통째로
// CORRUPTED다 -- "일부는 살리고 일부만 버리는" 조용한 부분 성공이
// 없어야 한다(검토자 지적 "조용히 필터링" 자체를 없앤다).
test("HYK-341 3R P1-2: suspectedPaths에 문자열과 비문자가 섞여 있어도(부분 필터링 없이) 배열째로 CORRUPTED다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      JSON.stringify({ suspectedPaths: ["a-real-path", 42, null] }),
      "utf8",
    );
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    assert.match(line, /unconsumed_status=UNCONSUMED_VANISH_STATE_CORRUPTED/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-h) 대조군: 빈 배열은 정상이다(§2 "빈 배열은 정상" 요구) --
// CORRUPTED로 표면화되지 않는다.
test("HYK-341 3R P1-2 대조군: suspectedPaths=[](빈 배열, 의심 대상이 없던 틱)는 정상이다 -- CORRUPTED로 표면화되지 않는다 (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      JSON.stringify({ suspectedPaths: [] }),
      "utf8",
    );
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
    });
    assert.doesNotMatch(line, /UNCONSUMED_VANISH_STATE_CORRUPTED/, line);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// (P1-2-i) 정상 배열(전부 유효한 문자열)이 이전 tick에 저장돼 있으면
// 그대로 vanish 계산에 쓰인다 -- 스키마 강화가 정상 경로를 막지 않는다
// (오탐0 회귀 확인).
test("HYK-341 3R P1-2 회귀: 전부 유효한 문자열인 suspectedPaths는 그대로 vanish 판정에 쓰인다(스키마 강화가 정상 경로를 막지 않는다) (1/1)", () => {
  const watchDir = tmpWatchDir();
  const fakePath = join(watchDir, "fake-worktree-schema-ok");
  try {
    fs.mkdirSync(fakePath, { recursive: true });
    fs.mkdirSync(watchDir, { recursive: true });
    fs.writeFileSync(
      join(watchDir, "unconsumed-vanish-state.json"),
      JSON.stringify({ suspectedPaths: [fakePath] }),
      "utf8",
    );
    const line = lastLineAfterRun(watchDir, {
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => consumedExec(),
      existsFn: makeExistsFn([fakePath]),
    });
    assert.match(line, /unconsumed_verdict=VANISHED_UNRESOLVED/, line);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

function lastLineAfterRun(watchDir, runArgs) {
  runWatchOnce(runArgs);
  return lastLine(watchDir);
}
