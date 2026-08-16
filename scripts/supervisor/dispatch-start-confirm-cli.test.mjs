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

// ★3R 신규: STALLED_AFTER_START 경로도 실제 CLI 프로세스로 spawn해 종료
// 코드 3 + «좌석 확인» 문구 통지 파일이 실제로 생기는지 확인한다. 실제
// 세션 로그가 폴링 도중(=관측 창 «안»에서) 한 번 커졌다가 멈추는 모양을
// 그대로 재현해야 하므로(그래야 "관측 시작 전부터 이미 컸다"와 구별되는
// 진짜 성장 신호가 잡힌다) 짧은 실제 대기(수백ms) 하나를 쓴다 -- 시험
// 전체 길이에 영향이 없는 범위(<2초)로만.
test("CLI end-to-end(spawn): 폴링 도중 한 번 커졌다가 멈추면 종료코드 3 + notifyDir에 «좌석 확인» 문구 통지 파일이 실제로 생긴다", async () => {
  await withTempDir("dsc-notify-stalled-", async (notifyDir) => {
    await withTempDir("dsc-home-stalled-", async (fakeHome) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { deriveClaudeProjectDirName } =
        await import("./rate-limit-stall-adapter.mjs");
      const repoRoot = "C:\\wt\\hyk270-stalled-demo";
      const projectDir = join(
        fakeHome,
        ".claude",
        "projects",
        deriveClaudeProjectDirName(repoRoot),
      );
      mkdirSync(projectDir, { recursive: true });
      const logPath = join(projectDir, "s.jsonl");
      writeFileSync(logPath, "", "utf8"); // 배달 직후, 아직 아무것도 없음.

      // 짧은 지연 뒤 딱 한 번 커지게 한다(=관측 창 «안»에서의 진짜 성장),
      // 그 뒤로는 더 안 건드린다(=승인창 등으로 멈춘 것과 동형).
      setTimeout(() => writeFileSync(logPath, "x".repeat(5000), "utf8"), 150);

      const child = execFileAsync(
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
          "HYK-TEST-stalled",
          "--timeout-ms",
          "1500",
          "--stall-threshold-ms",
          "500",
          "--poll-interval-ms",
          "80",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        },
      );

      let threw = null;
      let stderr = "";
      try {
        await child;
      } catch (err) {
        threw = err;
        stderr = err.stderr || "";
      }
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
  });
});
