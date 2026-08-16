// HYK-270-stall-visible-2/-3 (coder-task.md §4) -- dispatch-start-confirm-cli.mjs
// 결선 시험. 실제 대기 0(sleepFn을 즉시 반환하는 가짜로 주입) -- 실
// ~/.claude·실 관제실 무접촉.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runDispatchStartConfirm,
  DISPATCH_START_CONFIRM_STATUS,
  DISPATCH_START_CONFIRM_EXIT_CODE,
} from "./dispatch-start-confirm-cli.mjs";

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeClock(startMs, stepMs) {
  let t = startMs;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}
const instantSleep = async () => {};
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(THIS_DIR, "dispatch-start-confirm-cli.mjs");

test("★사례2(계속 진행): 매 폴링마다 늘어나면, 전체 관측 창 끝까지 폴링한 뒤 STARTED로 확정한다(2R처럼 두 번째 관측에서 조기 종료하지 않는다)", async () => {
  let call = 0;
  const collectFn = () => {
    call++;
    return { ok: true, totalBytes: call * 1000 }; // 매번 늘어난다.
  };
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    stallThresholdMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.STARTED);
  // 60000ms 창을 15000ms 간격으로 다 채워야 확정되므로 4회 이상 폴링했다
  // (조기 종료 0 -- 2R 회귀 가드).
  assert.ok(
    result.observations.length >= 4,
    `observations.length=${result.observations.length}`,
  );
});

test("★사례1(아예 시작 못 함): 타임아웃까지 계속 0 -> NOT_STARTED", async () => {
  const collectFn = () => ({ ok: true, totalBytes: 0 });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    stallThresholdMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.NOT_STARTED);
});

// ★★HYK-270-stall-visible-3 핵심 -- 2R REVIEW 반려가 직접 지목한 관측열을
// CLI 폴링 루프 레벨에서 그대로 재현한다: totalBytes = 0 -> 5000 -> 5000 -> …
// (배달 후 시작했다가 승인창 등으로 멈춘 사례 2). ★2R은 이 시나리오를
// `STARTED`로 즉시 종료했다(검토자 실측 원문 그대로) -- 이 시험이 그
// 결함의 회귀 가드다.
test("★★2R 반례: 한 번만 늘고(0->5000) 그 뒤 계속 그대로면(승인창 정지 동형) STALLED_AFTER_START -- 2R처럼 STARTED로 새지 않는다", async () => {
  let call = 0;
  const sizes = [0, 5000]; // 2번째 이후로는 계속 5000(무증가)만 반환.
  const collectFn = () => ({
    ok: true,
    totalBytes: sizes[Math.min(call++, sizes.length - 1)],
  });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 300000,
    stallThresholdMs: 60000, // ORCH 참고 실측(3분)을 시험 편의상 1분으로 축소.
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(
    result.status,
    DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START,
  );
  assert.equal(result.details.lastGrowthAtMs, 15000);
});

test("관측 수집 자체가 실패하면 즉시 COLLECTION_FAILED로 멈춘다(조용히 STARTED로 접지 않는다)", async () => {
  const collectFn = () => ({
    ok: false,
    reasonCode: "BOOM",
    detail: "disk error",
  });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.COLLECTION_FAILED);
});

test("«아예 시작 못 함»과 «시작 후 멈춤»은 종료코드가 다르다(사람 조치가 다르므로)", () => {
  assert.notEqual(
    DISPATCH_START_CONFIRM_EXIT_CODE[DISPATCH_START_CONFIRM_STATUS.NOT_STARTED],
    DISPATCH_START_CONFIRM_EXIT_CODE[
      DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START
    ],
  );
  assert.equal(
    DISPATCH_START_CONFIRM_EXIT_CODE[DISPATCH_START_CONFIRM_STATUS.STARTED],
    0,
  );
  assert.notEqual(
    DISPATCH_START_CONFIRM_EXIT_CODE[DISPATCH_START_CONFIRM_STATUS.NOT_STARTED],
    0,
  );
  assert.notEqual(
    DISPATCH_START_CONFIRM_EXIT_CODE[
      DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START
    ],
    0,
  );
});

test("CLI end-to-end(spawn): NOT_STARTED면 종료코드 1 + notifyDir에 «재배달» 문구 통지 파일이 실제로 생긴다", async () => {
  await withTempDir("dsc-notify-notstarted-", async (notifyDir) => {
    const { execFileSync } = await import("node:child_process");
    let threw = null;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          "--repo-root",
          "C:\\definitely-not-a-real-worktree-zzz",
          "--dispatched-at-ms",
          String(Date.now() - 10 * 60 * 1000),
          "--notify-dir",
          notifyDir,
          "--task-id",
          "HYK-TEST-e2e",
          "--timeout-ms",
          "1",
          "--stall-threshold-ms",
          "1",
          "--poll-interval-ms",
          "1",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      threw = err;
      stderr = err.stderr || "";
    }
    assert.ok(threw, "NOT_STARTED는 비0 종료코드여야 한다");
    assert.equal(threw.status, 1);
    assert.match(stderr, /NOT_STARTED/);
    assert.match(stderr, /재배달/);
    const files = readdirSync(notifyDir);
    assert.equal(files.length, 1);
    const text = readFileSync(join(notifyDir, files[0]), "utf8");
    assert.match(text, /아예 시작 못 함/);
    assert.match(text, /재배달/);
    assert.match(text, /HYK-TEST-e2e/);
  });
});

// ★4R 수리(coder-task.md §2, REVIEW 3R 반려 그대로): 이전 버전은 "150ms
// 뒤 딱 한 번" 파일을 키우는 `setTimeout` 하나에 기대고 있었다. 부하가
// 큰 전체 스윕에서는 자식 프로세스의 «첫 관측» 자체가 150ms보다 늦게
// 일어날 수 있고, 그러면 그 한 번의 쓰기가 첫 관측 «전에» 이미 반영돼
// 버려 growth가 전혀 감지되지 않는다(검토자가 동일 조건을 직접 주입해
// `NOT_STARTED`로 재현했다). ⛔"대기 시간을 늘리는 것"은 해법이 아니다
// (부하가 더 크면 또 깨진다).
//
// ★수리 방법(동기화 -- 시간 예약이 아니라 "계속 자라는 상태") -- 한 번의
// 정밀한 타이밍에 기대는 대신, 자식이 살아 있는 동안 **짧은 간격으로
// 계속 키우다가 멈춘다.** 이러면 자식이 자신의 «첫 관측»을 정확히
// 언제 하든(부하로 늦어지든 빠르든) 그 순간의 크기가 무엇이든, **그
// 뒤에 최소 한 번은 더 큰 값을 보게 된다**(계속 자라는 동안 관측하는
// 한, 자식이 최소 2회 폴링만 하면 성립 -- 특정 시각 정렬에 기대지
// 않는다). 성장 창(`GROWTH_WINDOW_MS`)이 끝나면 더는 안 건드려
// "승인창 등으로 멈춤"과 동형이 되고, 그 뒤 `stallThresholdMs`가
// 지나면 결정적으로 STALLED_AFTER_START가 된다.
const GROWTH_WINDOW_MS = 900; // 이 창이 끝날 때까지 자식이 최소 2회는 폴링한다(poll-interval 40ms 기준 넉넉한 여유).
const GROWTH_TICK_MS = 20;

function growContinuously(logPath, windowMs, tickMs, writeFileSync) {
  let elapsed = 0;
  let chunk = 0;
  const timer = setInterval(() => {
    elapsed += tickMs;
    chunk += 1;
    writeFileSync(logPath, "x".repeat(chunk * 200), "utf8");
    if (elapsed >= windowMs) clearInterval(timer);
  }, tickMs);
  return () => clearInterval(timer);
}

async function runStalledAfterStartOnce({ label }) {
  return withTempDir(`dsc-notify-stalled-${label}-`, async (notifyDir) => {
    return withTempDir(`dsc-home-stalled-${label}-`, async (fakeHome) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { deriveClaudeProjectDirName } =
        await import("./rate-limit-stall-adapter.mjs");
      const repoRoot = `C:\\wt\\hyk270-stalled-demo-${label}`;
      const projectDir = join(
        fakeHome,
        ".claude",
        "projects",
        deriveClaudeProjectDirName(repoRoot),
      );
      mkdirSync(projectDir, { recursive: true });
      const logPath = join(projectDir, "s.jsonl");
      writeFileSync(logPath, "", "utf8"); // 배달 직후, 아직 아무것도 없음.

      const stopGrowing = growContinuously(
        logPath,
        GROWTH_WINDOW_MS,
        GROWTH_TICK_MS,
        writeFileSync,
      );

      let threw = null;
      let stderr = "";
      try {
        await execFileAsync(
          process.execPath,
          [
            CLI_PATH,
            "--repo-root",
            repoRoot,
            "--dispatched-at-ms",
            String(Date.now()),
            "--notify-dir",
            notifyDir,
            "--task-id",
            `HYK-TEST-stalled-${label}`,
            // ★부하 여유: 이 세 값은 타이밍을 "맞추기" 위한 것이 아니라
            // "growth 창이 끝난 뒤에도 자식이 stallThreshold 도달을 볼
            // 시간이 있다"는 여유만 준다 -- 정밀 정렬은 growContinuously
            // 쪽 로직(계속 자람)이 담당한다.
            "--timeout-ms",
            "4000",
            "--stall-threshold-ms",
            "1200",
            "--poll-interval-ms",
            "40",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
          },
        );
      } catch (err) {
        threw = err;
        stderr = err.stderr || "";
      } finally {
        stopGrowing();
      }
      return { threw, stderr, notifyDir };
    });
  });
}

// ★4R 신규(coder-task.md §2 항2 요구 -- 검토자가 반증에 쓴 그 부하 조건을
// «고치지 않고» fixture로 고정한다): 세션 로그가 자식의 «첫 관측 전에»
// 이미 커져 있으면(=이번 실행의 첫 관측 자체가 그 값을 기준선으로
// 삼는다), 그 뒤로 더 안 늘어도 이 CLI는 `STALLED_AFTER_START`가 아니라
// `NOT_STARTED`를 낸다 -- ★이것은 버그가 아니라 "현재 설계가 구조적으로
// 못 보는" 알려진 한계다(한용 확정: 이번 라운드에서 고치지 않는다, «첫
// 관측 기준선» 근본 수리는 ps1 결선과 함께 다음 조각). 이 시험은 그 한계
// 자체를 고정한다(결정적 -- 실제 시간에 전혀 기대지 않는다, collectFn을
// 호출 순서로만 제어).
test("★4R 알려진 한계 fixture(★고치지 않음, 고정만): 첫 관측 전에 이미 커져 있으면(=growth가 이번 실행의 관측 구간 밖) NOT_STARTED다 -- STALLED_AFTER_START가 아니다", async () => {
  const collectFn = () => ({ ok: true, totalBytes: 5000 }); // 첫 호출부터 이미 5000 -- 이번 실행 안에서는 절대 "늘어난 적"이 없다.
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    stallThresholdMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  // ⚠️의도된 동작 확인(고치는 시험이 아니다) -- «첫 관측이 이미 큰 값»과
  // «전혀 시작 못 함」을 이 설계는 구별하지 못한다. 그 사실을 정직하게
  // 고정한다.
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.NOT_STARTED);
});

// ★3R 신규 / ★4R 수리: STALLED_AFTER_START 경로를 실제 CLI 프로세스로
// spawn해 종료코드 3 + «좌석 확인» 문구 통지 파일이 실제로 생기는지
// 확인한다. ★4R부터 시간 예약(고정 지연 1회) 대신 "계속 자라다가 멈춤"
// 동기화를 쓴다(위 growContinuously/runStalledAfterStartOnce 헤더 주석
// 참조) -- 부하와 무관하게 결정적이어야 한다는 요구를 이 시험 자신이
// 실증한다: 아래 반복 실행 시험이 이 시험을 5회 이상 연속 통과시킨다.
test("CLI end-to-end(spawn, 부하-무관 동기화): 폴링 도중 계속 커지다 멈추면 종료코드 3 + notifyDir에 «좌석 확인» 문구 통지 파일이 실제로 생긴다", async () => {
  const { threw, stderr, notifyDir } = await runStalledAfterStartOnce({
    label: "single",
  });
  assert.ok(threw, "STALLED_AFTER_START도 비0 종료코드여야 한다");
  assert.equal(threw.code, 3);
  assert.match(stderr, /STALLED_AFTER_START/);
  assert.match(stderr, /좌석 확인/);
  const files = readdirSync(notifyDir);
  assert.equal(files.length, 1);
  const text = readFileSync(join(notifyDir, files[0]), "utf8");
  assert.match(text, /시작 후 멈춤/);
  assert.match(text, /좌석 상태를 직접 확인/);
});

// ★4R 완료조건3(coder-task.md §4 항3) -- 같은 시험을 반복 실행해 전건
// 동일 결과임을 실행 출력으로 보인다(최소 5회). withTempDir가 매번 새
// mkdtemp 디렉터리를 쓰므로 라운드끼리 간섭 없음.
test("반복 실행 결정성(5회 연속): 매번 동일하게 STALLED_AFTER_START·종료코드 3 (부하 무관 동기화 실증)", async () => {
  for (let i = 0; i < 5; i++) {
    const { threw, stderr } = await runStalledAfterStartOnce({
      label: `repeat${i}`,
    });
    assert.ok(threw, `round ${i}: 비0 종료코드여야 한다`);
    assert.equal(threw.code, 3, `round ${i}: 종료코드가 3이어야 한다`);
    assert.match(stderr, /STALLED_AFTER_START/, `round ${i}`);
  }
});
