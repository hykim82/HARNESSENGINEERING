// HYK-241 §2 조각2 §3-1: «지워도 초록» 금지 -- 1-B 검문 지점을 지우거나
// 무력화한 변이본에서 시험이 실제로 실패(RED)함을 증명한다.
//
// ⛔합성 표적에서만 변이한다 -- 이 파일은 현재 작업트리의
// dispatch-gate-decision.mjs 소스를 문자열 치환으로 임시 사본에만 적용하고,
// 그 사본만 별도 tmpdir에서 CLI로 실행한다. 원본 파일은 절대 건드리지
// 않는다(§2-2와 동일한 비타협).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { writeLedger } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DISPATCH_GATE_DECISION_PATH = join(HERE, "dispatch-gate-decision.mjs");
const CORE_PATH = join(HERE, "dispatch-gate-decision-core.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const REJECT_STREAK_CHAIN_PATH = join(HERE, "reject-streak-chain.mjs");
// HYK-244-receipt-wire-2b2 §3-1: dispatch-gate-decision.mjs now statically
// imports consumption-receipt-core.mjs (the approved 1R core) -- this
// isolated fixture's dependency list must mirror that or the mutant module
// fails to load at all (MODULE_NOT_FOUND), which would break every mutation
// test in this file, not just ones related to the new axis.
const CONSUMPTION_RECEIPT_CORE_PATH = join(
  HERE,
  "consumption-receipt-core.mjs",
);
// HYK-257-done-stamp-2 §2 범위2 / HYK-257-done-stamp-lint-1 (경로 수정):
// dispatch-gate-decision.mjs now statically imports
// scripts/check/dropped-at-stamp-core.mjs's stampDroppedAt (the best-effort
// dropped_at machine-stamp step; moved from scripts/relay/stamp-dropped-at.mjs
// to fix a scripts/check -> scripts/relay ESLint import-direction
// violation) -- this isolated fixture's staged tree must include it at the
// SAME relative path (`./` from scripts/check/) or the mutant module fails
// to load (MODULE_NOT_FOUND), breaking every mutation test in this file,
// not just ones touching the new step (mirrors the
// CONSUMPTION_RECEIPT_CORE_PATH addition's own reasoning above).
const DROPPED_AT_STAMP_CORE_PATH = join(HERE, "dropped-at-stamp-core.mjs");
// HYK-298-abort-record-1 §2-2: dispatch-gate-decision.mjs now statically
// imports scripts/check/abort-record-core.mjs (the new zero-import abort
// record core) -- this isolated fixture's staged tree must include it or
// the mutant module fails to load (MODULE_NOT_FOUND), same reasoning as
// CONSUMPTION_RECEIPT_CORE_PATH/DROPPED_AT_STAMP_CORE_PATH above.
const ABORT_RECORD_CORE_PATH = join(HERE, "abort-record-core.mjs");
// HYK-307-order-1 §1: dispatch-gate-decision.mjs now statically imports
// scripts/check/envelope-archive.mjs (the delivery-time round-task
// snapshot, archiveRoundTaskFileIfNew) -- this isolated fixture's staged
// tree must include it or the mutant module fails to load
// (MODULE_NOT_FOUND), same reasoning as CONSUMPTION_RECEIPT_CORE_PATH/
// DROPPED_AT_STAMP_CORE_PATH/ABORT_RECORD_CORE_PATH above.
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Stages an isolated scripts/check/ copy so a mutated dispatch-gate-
// decision.mjs can `import "./dispatch-gate-decision-core.mjs"` etc. by
// relative path without touching the real repo tree.
function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "dispatch-gate-decision.mjs": readFileSync(
      DISPATCH_GATE_DECISION_PATH,
      "utf8",
    ),
    "dispatch-gate-decision-core.mjs": readFileSync(CORE_PATH, "utf8"),
    "reject-streak.mjs": readFileSync(REJECT_STREAK_PATH, "utf8"),
    "reject-streak-chain.mjs": readFileSync(REJECT_STREAK_CHAIN_PATH, "utf8"),
    "consumption-receipt-core.mjs": readFileSync(
      CONSUMPTION_RECEIPT_CORE_PATH,
      "utf8",
    ),
    "dropped-at-stamp-core.mjs": readFileSync(
      DROPPED_AT_STAMP_CORE_PATH,
      "utf8",
    ),
    "abort-record-core.mjs": readFileSync(ABORT_RECORD_CORE_PATH, "utf8"),
    "envelope-archive.mjs": readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

function runCli(scriptsCheckDir, args) {
  try {
    const stdout = execFileSync(
      "node",
      [join(scriptsCheckDir, "dispatch-gate-decision.mjs"), ...args],
      { encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// A task packet with NO 1-B declaration at all, and everything ELSE (task_id,
// ledger) valid -- production must REJECT this. Any mutation that makes it
// ALLOW is the exact silent-bypass this track exists to close.
function writeMissingOneBFixture(dir) {
  const taskPath = join(dir, "coder-task.md");
  writeFileSync(taskPath, "task_id: HYK-9500-mutation-1\nbody\n", "utf8");
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });
  return { taskPath, ledgerPath };
}

// ---------------------------------------------------------------------------
// mutation ⓐ (필수): the call site (`if (oneBDecision) decisions.push(...)`)
// removed from dispatch-gate-decision.mjs's runDispatchGateDecision -> the
// 1-B check is computed but its verdict never reaches the delivery decision.
// ---------------------------------------------------------------------------

test("mutation ⓐ (필수): 1-B call site removed from runDispatchGateDecision -> a task packet with NO 1-B declaration silently ALLOWs -> RED", () => {
  const src = readFileSync(DISPATCH_GATE_DECISION_PATH, "utf8");
  const target = "        if (oneBDecision) decisions.push(oneBDecision);\n";
  assertExactlyOneMatch(src, target, "1-B decision push call site");
  const mutated = src.replace(target, "");

  withTempDir("hyk241-oneb-mut-a-", (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const fixtureDir = mkdtempSync(join(tmpdir(), "hyk241-oneb-mut-a-fix-"));
    try {
      const { taskPath, ledgerPath } = writeMissingOneBFixture(fixtureDir);
      const r = runCli(scriptsCheckDir, [taskPath, "--ledger", ledgerPath]);
      assert.equal(
        r.status,
        0,
        "RED-setup: without the wiring, a packet missing BOTH ⓐ and ⓑ silently ALLOWs -- exactly the silent bypass §2 조각2 exists to close",
      );
      assert.match(r.stdout, /ALLOW/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mutation ⓑ (필수): checkOneBPrecondition's default-reject direction
// flipped -- `if (aComplete === true) return null;` mutated to always
// return null (i.e. the axis never rejects, no matter the facts).
// ---------------------------------------------------------------------------

test("mutation ⓑ (필수): checkOneBPrecondition hardcoded to always return null (never rejects) -> RED", () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = "  if (aComplete === true) return null;\n";
  assertExactlyOneMatch(src, target, "checkOneBPrecondition aComplete branch");
  const mutated = src.replace(
    target,
    "  if (aComplete === true) return null;\n  return null;\n",
  );

  withTempDir("hyk241-oneb-mut-b-", (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision-core.mjs": mutated,
    });
    const fixtureDir = mkdtempSync(join(tmpdir(), "hyk241-oneb-mut-b-fix-"));
    try {
      const { taskPath, ledgerPath } = writeMissingOneBFixture(fixtureDir);
      const r = runCli(scriptsCheckDir, [taskPath, "--ledger", ledgerPath]);
      assert.equal(
        r.status,
        0,
        "RED-setup: with the axis neutered to always pass, the same missing-1-B packet now ALLOWs",
      );
      assert.match(r.stdout, /ALLOW/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mutation ⓒ (자유 선택): ⓑ's min-length guard removed -- ANY non-empty
// '1b_prerequisite_for:' value (including a 1-character placeholder) is
// accepted, exactly the "아무 문장이나 있으면 통과" shape §2 조각2 forbids.
// ---------------------------------------------------------------------------

test("mutation ⓒ (자유 선택): ⓑ's min-length guard removed -> a 1-character placeholder prerequisite declaration wrongly ALLOWs -> RED", () => {
  const src = readFileSync(DISPATCH_GATE_DECISION_PATH, "utf8");
  const target =
    "    bValid: prereqValue !== null && prereqValue.length >= ONE_B_PREREQ_MIN_LEN,\n";
  assertExactlyOneMatch(src, target, "ⓑ min-length guard");
  const mutated = src.replace(target, "    bValid: prereqValue !== null,\n");

  withTempDir("hyk241-oneb-mut-c-", (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const fixtureDir = mkdtempSync(join(tmpdir(), "hyk241-oneb-mut-c-fix-"));
    try {
      const taskPath = join(fixtureDir, "coder-task.md");
      writeFileSync(
        taskPath,
        "task_id: HYK-9501-placeholder-1\n1b_prerequisite_for: x\n",
        "utf8",
      );
      const ledgerPath = join(fixtureDir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const r = runCli(scriptsCheckDir, [taskPath, "--ledger", ledgerPath]);
      assert.equal(
        r.status,
        0,
        "RED-setup: a 1-character placeholder ('x') wrongly satisfies ⓑ once the length guard is gone",
      );
      assert.match(r.stdout, /ALLOW/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
