// HYK-239-chain-wire-2 (coder-task.md) -- «원장 해시체인 위조 탐지» 축의
// 감시 시점 결선 계약 시험. dispatch-postcheck-wire.test.mjs와 대칭 구조지만
// 이 축은 영수증을 읽는 게 아니라 매번 원장 자체를 재검증한다(§1) -- 그래서
// 각 임시 워크트리에 scripts/check/reject-streak-chain.mjs +
// scripts/check/reject-streak.mjs의 real copy를 심고, 그 워크트리 "자기
// 자신의" CLI를 실제로 스폰한다(§1 헤더 주석 참조: scripts/check/**는
// 무접촉 범위라 이 파일은 그 함수를 import하지 않는다 -- 검증 대상은
// 오직 orch-stall-detect.mjs의 판정/집계 코드다).
//
// §5(합격 기준) 요구대로 프로덕션 진입점(runOrchStallDetect)을 최소 1건
// 구동한다 -- helper만 부르는 시험은 "감지 절단" 변조를 못 잡는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  judgeChainIntegrityAcrossWorktrees,
  runOrchStallDetect,
  CHAIN_WIRE_STATUS,
  CHAIN_SCAN_FAILURE,
  CHAIN_VERDICT,
} from "./orch-stall-detect.mjs";

const REJECT_STREAK_CHAIN_SRC = fileURLToPath(
  new URL("../check/reject-streak-chain.mjs", import.meta.url),
);
const REJECT_STREAK_SRC = fileURLToPath(
  new URL("../check/reject-streak.mjs", import.meta.url),
);

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function initPlainGitRepo(dir) {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  ]);
}
// 워크트리에 그 워크트리 "자기 자신의" reject-streak-chain.mjs/
// reject-streak.mjs 사본을 심는다(무접촉 범위 -- import가 아니라 그
// 워크트리의 실제 파일로 실제 CLI를 스폰하기 위함, 이 파일 헤더 참조).
function seedCheckScripts(dir) {
  const checkDir = join(dir, "scripts", "check");
  mkdirSync(checkDir, { recursive: true });
  copyFileSync(REJECT_STREAK_SRC, join(checkDir, "reject-streak.mjs"));
  copyFileSync(
    REJECT_STREAK_CHAIN_SRC,
    join(checkDir, "reject-streak-chain.mjs"),
  );
}
function writeJson(p, obj) {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// judgeChainIntegrityAcrossWorktrees -- 단일 워크트리 시나리오
// ---------------------------------------------------------------------------

test("judgeChainIntegrityAcrossWorktrees: no ledger file at all -> CLEAN (0 issues checked, not a false alarm)", () => {
  withTempDir("hyk239-chain-", (dir) => {
    initPlainGitRepo(dir);
    seedCheckScripts(dir);
    const r = judgeChainIntegrityAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, CHAIN_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, CHAIN_VERDICT.CLEAN);
    assert.equal(r.totalWorktrees, 1);
  });
});

test("judgeChainIntegrityAcrossWorktrees: real checkpoint history that still matches the primary ledger -> JUDGED/CLEAN", () => {
  withTempDir("hyk239-chain-", (dir) => {
    initPlainGitRepo(dir);
    seedCheckScripts(dir);
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    writeJson(join(harnessDir, "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9400": {
          streak: 2,
          history: [
            { task_id: "HYK-9400-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9400-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    // reject-streak-chain.mjs checkpoint로 실제 체크포인트 생성(같은
    // 워크트리의 real CLI -- 이 시험 파일이 해시를 손으로 계산하지 않는다).
    execFileSync(
      "node",
      [
        join(dir, "scripts", "check", "reject-streak-chain.mjs"),
        "checkpoint",
        "--issue",
        "HYK-9400",
        "--ledger",
        join(harnessDir, "reject-streak.json"),
        "--chain",
        join(harnessDir, "reject-streak-chain.json"),
      ],
      { encoding: "utf8" },
    );
    const r = judgeChainIntegrityAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, CHAIN_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, CHAIN_VERDICT.CLEAN);
  });
});

test("judgeChainIntegrityAcrossWorktrees: ★핵심★ post-checkpoint tamper (primary ledger edited, sidecar untouched) -> JUDGED/TAMPER_DETECTED, names the issue", () => {
  withTempDir("hyk239-chain-", (dir) => {
    initPlainGitRepo(dir);
    seedCheckScripts(dir);
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    const ledgerPath = join(harnessDir, "reject-streak.json");
    writeJson(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9401": {
          streak: 2,
          history: [
            { task_id: "HYK-9401-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9401-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    execFileSync(
      "node",
      [
        join(dir, "scripts", "check", "reject-streak-chain.mjs"),
        "checkpoint",
        "--issue",
        "HYK-9401",
        "--ledger",
        ledgerPath,
        "--chain",
        join(harnessDir, "reject-streak-chain.json"),
      ],
      { encoding: "utf8" },
    );
    // 자기기만 시나리오: 원장만 사후에 손댐(사이드카는 그대로).
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.issues["HYK-9401"].history[1].task_id = "HYK-9401-coder-2-TAMPERED";
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const r = judgeChainIntegrityAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, CHAIN_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, CHAIN_VERDICT.TAMPER_DETECTED);
    assert.equal(r.issueId, "HYK-9401");
    assert.match(r.reason, /no longer matches checkpoint/);
  });
});

test("judgeChainIntegrityAcrossWorktrees: corrupt chain sidecar JSON -> CHAIN_QUERY_FAILED, never folded into CLEAN or TAMPER_DETECTED", () => {
  withTempDir("hyk239-chain-", (dir) => {
    initPlainGitRepo(dir);
    seedCheckScripts(dir);
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    writeJson(join(harnessDir, "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    writeFileSync(
      join(harnessDir, "reject-streak-chain.json"),
      "{ not valid json ][",
      "utf8",
    );
    const r = judgeChainIntegrityAcrossWorktrees({ repoRoot: dir });
    assert.equal(r.status, CHAIN_WIRE_STATUS.QUERY_FAILED);
    assert.notEqual(r.verdict, CHAIN_VERDICT.TAMPER_DETECTED);
    assert.notEqual(r.verdict, CHAIN_VERDICT.CLEAN);
  });
});

test("judgeChainIntegrityAcrossWorktrees: git worktree list itself fails -> WORKTREE_LIST_FAILED, worktrees:[]", () => {
  const r = judgeChainIntegrityAcrossWorktrees(
    { repoRoot: "C:/does/not/exist" },
    {
      gitWorktreeListExecFn: () => {
        throw new Error("boom");
      },
    },
  );
  assert.equal(r.status, CHAIN_SCAN_FAILURE.WORKTREE_LIST_FAILED);
  assert.deepEqual(r.worktrees, []);
});

// ---------------------------------------------------------------------------
// runOrchStallDetect -- 프로덕션 진입점을 실제로 구동해 result.chain이
// 채워지는지 확인한다(§5 "helper가 아니라 진입점" 요구).
// ---------------------------------------------------------------------------
test("runOrchStallDetect: result.chain is populated end-to-end via the real CLI-callable entry point, with a real tamper", () => {
  withTempDir("hyk239-chain-e2e-", (dir) => {
    initPlainGitRepo(dir);
    seedCheckScripts(dir);
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir, { recursive: true });
    const ledgerPath = join(harnessDir, "reject-streak.json");
    writeJson(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9402": {
          streak: 2,
          history: [
            { task_id: "HYK-9402-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9402-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    execFileSync(
      "node",
      [
        join(dir, "scripts", "check", "reject-streak-chain.mjs"),
        "checkpoint",
        "--issue",
        "HYK-9402",
        "--ledger",
        ledgerPath,
        "--chain",
        join(harnessDir, "reject-streak-chain.json"),
      ],
      { encoding: "utf8" },
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.issues["HYK-9402"].history[1].task_id = "HYK-9402-coder-2-TAMPERED";
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

    const { result } = runOrchStallDetect([
      "--repo-root",
      dir,
      "--now",
      "2026-08-12T10:00:00+09:00",
      "--json",
    ]);
    assert.equal(typeof result.chain, "object");
    assert.equal(result.chain.status, CHAIN_WIRE_STATUS.JUDGED);
    assert.equal(result.chain.verdict, CHAIN_VERDICT.TAMPER_DETECTED);
    assert.equal(result.chain.issueId, "HYK-9402");
  });
});
