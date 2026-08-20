// HYK-319-argcheck-1 (coder-task.md §2-2) -- dispatch-arg-contract-*의
// 결속 시험 중 scripts/relay/* CLI 2개(dispatch-receipt-cli.mjs,
// dispatch-worker-seat-proof-gate.mjs) 몫만 이 파일에 있다. scripts/check
// 쪽의 나머지 3개(dispatch-gate-decision/admission-cli/dispatch-start-
// confirm-cli)는 scripts/check/dispatch-arg-contract-binding.test.mjs에
// 있다 -- 이 저장소의 ESLint 아키텍처 규칙(A3 inventory, HYK-148: "실제
// 의존 방향은 relay -> check만 허용, check가 relay를 import하면 안 됨")
// 때문에 scripts/check/* 파일은 scripts/relay/* 모듈(dispatch-receipt-
// cli.mjs·dispatch-worker-seat-proof-gate.mjs·hyk171-cycle4b2c-fixtures.mjs)
// 을 import할 수 없다 -- 이 파일이 그 반대 방향(relay -> check)이라
// dispatch-arg-contract-registry.mjs를 그대로 재사용할 수 있다.
//
// hard=true 선언: 빼면 실제로 죽는다(아래에서 직접 증명). 이 두 CLI는
// 레지스트리에서 둘 다 필수 인자 전부 hard=true다(헛선언 없음).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_CONTRACTS } from "../check/dispatch-arg-contract-registry.mjs";
import { runDispatchReceiptCli } from "./dispatch-receipt-cli.mjs";
import { runGate, GATE_REASON } from "./dispatch-worker-seat-proof-gate.mjs";
import {
  rawTerminalShowP1,
  rawDispatchShowP2,
  expectedMatchingP1P2,
} from "./hyk171-cycle4b2c-fixtures.mjs";

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function contractOf(id) {
  const c = CLI_CONTRACTS.find((x) => x.id === id);
  assert.ok(c, `registry has no contract '${id}' -- test/registry drifted`);
  return c;
}

function requiredFlagsOf(cli) {
  // 이 파일은 대표 플래그 하나만 쓴다(anyOf 항목은 flags[0] -- 이 두 CLI는
  // anyOf 항목이 없다).
  return cli.requiredArgs.map((r) => r.flags[0]);
}

// ---------------------------------------------------------------------------
// (C) dispatch-receipt-cli.mjs -- 3개 전부 hard.
// ---------------------------------------------------------------------------
const RECEIPT_CLI = contractOf("dispatch-receipt-cli");

function validReceiptResponse() {
  return JSON.stringify({
    result: {
      dispatch: {
        id: "ctx_argcheck1",
        task_id: "task_argcheck1",
        assignee_pane_key: "pane:argcheck",
        dispatched_at: "2026-08-20 01:00:00",
      },
    },
  });
}

test("(C-baseline) dispatch-receipt-cli: 필수 3개 전부 있으면 ok:true", () => {
  withFixtureDir("hyk319-receipt-", (dir) => {
    const receiptPath = join(dir, "receipts.jsonl");
    const result = runDispatchReceiptCli(
      [
        "--role",
        "CODER",
        "--task-label",
        "HYK-9319-argcheck-1",
        "--receipt-path",
        receiptPath,
      ],
      { stdinText: validReceiptResponse() },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

for (const flag of requiredFlagsOf(RECEIPT_CLI)) {
  test(`(C-hard) dispatch-receipt-cli: --${flag.slice(2)} 빠지면 ok:false(missing required field)`, () => {
    withFixtureDir("hyk319-receipt-", (dir) => {
      const receiptPath = join(dir, "receipts.jsonl");
      const full = [
        "--role",
        "CODER",
        "--task-label",
        "HYK-9319-argcheck-1",
        "--receipt-path",
        receiptPath,
      ];
      const idx = full.indexOf(flag);
      const withoutFlag = [...full.slice(0, idx), ...full.slice(idx + 2)];
      const result = runDispatchReceiptCli(withoutFlag, {
        stdinText: validReceiptResponse(),
      });
      assert.equal(result.ok, false);
      assert.match(result.reason, /missing required field/);
    });
  });
}

// ---------------------------------------------------------------------------
// (D) dispatch-worker-seat-proof-gate.mjs -- 7개 전부 hard.
// ---------------------------------------------------------------------------
const SEAT_PROOF_CLI = contractOf("dispatch-worker-seat-proof-gate");

function fakeReadFileFn(files) {
  return (path) => {
    if (!(path in files)) {
      const err = new Error(`ENOENT: no such file '${path}'`);
      err.code = "ENOENT";
      throw err;
    }
    return files[path];
  };
}

function seatProofBaseFiles() {
  return {
    "/ds.json": JSON.stringify(rawDispatchShowP2()),
    "/ts.json": JSON.stringify(rawTerminalShowP1()),
  };
}

function seatProofArgs(exp) {
  return [
    "--dispatch-show",
    "/ds.json",
    "--terminal-show",
    "/ts.json",
    "--harness-task-id",
    exp.harnessTaskId,
    "--runtime-task-id",
    exp.runtimeTaskId,
    "--dispatch-id",
    exp.dispatchId,
    "--worktree-id",
    exp.worktreeId,
    "--worktree-path",
    exp.worktreePath,
  ];
}

test("(D-baseline) seat-proof-gate: 7개 전부 있으면 PROVEN, exit 0", () => {
  const files = seatProofBaseFiles();
  const exp = expectedMatchingP1P2();
  const result = runGate(seatProofArgs(exp), {
    readFileFn: fakeReadFileFn(files),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.reasonCode, "PROVEN");
});

for (const flag of requiredFlagsOf(SEAT_PROOF_CLI)) {
  test(`(D-hard) seat-proof-gate: --${flag.slice(2)} 빠지면 GATE_ARGS_MISSING, exit 2`, () => {
    const files = seatProofBaseFiles();
    const exp = expectedMatchingP1P2();
    const full = seatProofArgs(exp);
    const idx = full.indexOf(flag);
    const withoutFlag = [...full.slice(0, idx), ...full.slice(idx + 2)];
    const result = runGate(withoutFlag, { readFileFn: fakeReadFileFn(files) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.reasonCode, GATE_REASON.ARGS_MISSING);
  });
}
