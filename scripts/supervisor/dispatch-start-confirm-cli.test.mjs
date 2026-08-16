// HYK-270-stall-visible-2 (coder-task.md §4) -- dispatch-start-confirm-cli.mjs
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

test("★사례2(시작 후 진행): 두 번째 폴링에서 크기가 늘면 STARTED, 폴링을 멈춘다", async () => {
  const sizes = [0, 500, 5000]; // 3번째 호출까지 갈 필요 없이 2번째에서 성장 감지.
  let call = 0;
  const collectFn = () => ({
    ok: true,
    totalBytes: sizes[Math.min(call++, sizes.length - 1)],
  });

  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 180000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.STARTED);
  assert.equal(result.observations.length, 2);
});

test("★사례1(아예 시작 못 함): 타임아웃까지 계속 0 -> NOT_STARTED", async () => {
  const collectFn = () => ({ ok: true, totalBytes: 0 });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.NOT_STARTED);
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

test("CLI end-to-end(spawn): NOT_STARTED면 종료코드 1 + notifyDir에 통지 파일이 실제로 생긴다", async () => {
  await withTempDir("dsc-notify-", async (notifyDir) => {
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
          String(Date.now() - 10 * 60 * 1000), // 10분 전 -- 이미 타임아웃 지남.
          "--notify-dir",
          notifyDir,
          "--task-id",
          "HYK-TEST-e2e",
          "--timeout-ms",
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
    const files = readdirSync(notifyDir);
    assert.equal(files.length, 1);
    const text = readFileSync(join(notifyDir, files[0]), "utf8");
    assert.match(text, /배달 후 착수 확인 실패/);
    assert.match(text, /HYK-TEST-e2e/);
  });
});
