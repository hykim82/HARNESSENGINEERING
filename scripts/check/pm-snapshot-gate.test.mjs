import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parsePmType, checkPmSnapshotEnvelope, checkPmSnapshotEcho } from "./pm-snapshot-gate.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./pm-snapshot-gate.mjs", import.meta.url));

const FULL_SNAPSHOT_BLOCK = [
  "<!-- pm-snapshot",
  "snapshot_id: SNAP-20260712-2114",
  "captured_at: 2026-07-12 21:14 KST",
  "issue_ids: HYK-128, HYK-125",
  'issue HYK-128: state=Todo; excerpt="ORCH 릴레이 충실도 ..."',
  'issue HYK-125: state=Todo; excerpt="sol-PM 기계 규율 ..."',
  "omitted_fields: none",
  "unknown: none",
  "-->",
].join("\n");

function b2TaskWith(snapshotBlock) {
  return "task_id: HYK-128-pm-1\ntype: B2 진단·개선안\n" + (snapshotBlock ? snapshotBlock + "\n" : "");
}

function withFieldRemoved(block, field) {
  return block
    .split("\n")
    .filter((line) => !new RegExp(`^${field}\\s*:`).test(line))
    .join("\n");
}

function withFieldsFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pm-snapshot-gate-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(1) parsePmType: extracts B1/B2/B3 from type header", () => {
  assert.equal(parsePmType("type: B1 역질문\n"), "B1");
  assert.equal(parsePmType("type: B2 진단·개선안\n"), "B2");
  assert.equal(parsePmType("type: B3 시스템검증\n"), "B3");
});

test("(2) parsePmType: missing header -> null", () => {
  assert.equal(parsePmType("task_id: X\n"), null);
});

test("(2b) parsePmType: uppercase 'TYPE:' header -> B1 (review-3 repro)", () => {
  assert.equal(parsePmType("TYPE: B1 질문\n"), "B1");
});

test("(2c) parsePmType: leading whitespace before 'type' -> B1 (review-3 repro)", () => {
  assert.equal(parsePmType("  type: B1 질문\n"), "B1");
});

test("(2d) parsePmType: space before colon ('type :') -> B1 (review-3 repro)", () => {
  assert.equal(parsePmType("type : B1 질문\n"), "B1");
});

test("(2e) parsePmType: lowercase value 'b1' normalizes to 'B1' (review-3 repro)", () => {
  assert.equal(parsePmType("type: b1 질문\n"), "B1");
});

test("(2f) checkPmSnapshotEnvelope: 'TYPE: B1' variant skips envelope requirement (G5 regression from review-3)", () => {
  const result = checkPmSnapshotEnvelope("TYPE: B1 질문\n");
  assert.equal(result.ok, true);
  assert.match(result.reason, /skip/);
});

test("(2g) checkPmSnapshotEnvelope: lowercase 'type: b1' variant skips envelope requirement", () => {
  const result = checkPmSnapshotEnvelope("type: b1 질문\n");
  assert.equal(result.ok, true);
  assert.match(result.reason, /skip/);
});

test("(3) G5: B1 task -> skip ok regardless of envelope", () => {
  const result = checkPmSnapshotEnvelope("type: B1 역질문\n");
  assert.equal(result.ok, true);
  assert.match(result.reason, /skip/);
});

test("(4) G5: linear_evidence: none -> skip ok even for B2", () => {
  const text = "type: B2 진단·개선안\nlinear_evidence: none\n";
  const result = checkPmSnapshotEnvelope(text);
  assert.equal(result.ok, true);
  assert.match(result.reason, /skip/);
});

test("(5) G5: B2 task with complete envelope -> ok", () => {
  const result = checkPmSnapshotEnvelope(b2TaskWith(FULL_SNAPSHOT_BLOCK));
  assert.equal(result.ok, true);
  assert.match(result.reason, /envelope complete/);
});

test("(6) G5: B2 task with no envelope block at all -> ok:false", () => {
  const result = checkPmSnapshotEnvelope(b2TaskWith(null));
  assert.equal(result.ok, false);
  assert.match(result.reason, /no pm-snapshot envelope block/);
});

test("(7) G5: B3 task also requires the envelope", () => {
  const text = "task_id: X\ntype: B3 시스템검증\n";
  const result = checkPmSnapshotEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no pm-snapshot envelope block/);
});

for (const field of ["snapshot_id", "issue_ids", "omitted_fields", "unknown"]) {
  test(`(8-${field}) G5: envelope missing '${field}' -> ok:false naming it`, () => {
    const block = withFieldRemoved(FULL_SNAPSHOT_BLOCK, field);
    const result = checkPmSnapshotEnvelope(b2TaskWith(block));
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(field));
  });
}

test("(9) G5: envelope missing captured_at -> ok:false naming it", () => {
  const block = withFieldRemoved(FULL_SNAPSHOT_BLOCK, "captured_at");
  const result = checkPmSnapshotEnvelope(b2TaskWith(block));
  assert.equal(result.ok, false);
  assert.match(result.reason, /captured_at/);
});

test("(10) G5: envelope with no 'issue <ID>: state=...' line -> ok:false naming it", () => {
  const block = FULL_SNAPSHOT_BLOCK.split("\n")
    .filter((line) => !line.startsWith("issue "))
    .join("\n");
  const result = checkPmSnapshotEnvelope(b2TaskWith(block));
  assert.equal(result.ok, false);
  assert.match(result.reason, /issue <ID>: state=/);
});

test("(11) G5: captured_at with seconds included -> ok:false, invalid format", () => {
  const block = FULL_SNAPSHOT_BLOCK.replace("captured_at: 2026-07-12 21:14 KST", "captured_at: 2026-07-12 21:14:00 KST");
  const result = checkPmSnapshotEnvelope(b2TaskWith(block));
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid format/);
});

test("(12) G5: captured_at missing KST suffix -> ok:false, invalid format", () => {
  const block = FULL_SNAPSHOT_BLOCK.replace("captured_at: 2026-07-12 21:14 KST", "captured_at: 2026-07-12 21:14");
  const result = checkPmSnapshotEnvelope(b2TaskWith(block));
  assert.equal(result.ok, false);
  assert.match(result.reason, /invalid format/);
});

test("(13) G6: result echoes matching snapshot_id -> ok", () => {
  const taskText = b2TaskWith(FULL_SNAPSHOT_BLOCK);
  const resultText = "task_id: HYK-128-pm-1\nsnapshot_id: SNAP-20260712-2114\n요약...\n>>> DONE: PM @ 2026-07-12 21:30 KST\n";
  const result = checkPmSnapshotEcho(taskText, resultText);
  assert.equal(result.ok, true);
  assert.match(result.reason, /echoed correctly/);
});

test("(14) G6: result missing snapshot_id echo -> ok:false", () => {
  const taskText = b2TaskWith(FULL_SNAPSHOT_BLOCK);
  const resultText = "task_id: HYK-128-pm-1\n요약...\n>>> DONE: PM @ 2026-07-12 21:30 KST\n";
  const result = checkPmSnapshotEcho(taskText, resultText);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing snapshot_id echo/);
});

test("(15) G6: result echoes a different snapshot_id -> ok:false, expected vs actual", () => {
  const taskText = b2TaskWith(FULL_SNAPSHOT_BLOCK);
  const resultText = "snapshot_id: SNAP-WRONG-ID\n";
  const result = checkPmSnapshotEcho(taskText, resultText);
  assert.equal(result.ok, false);
  assert.match(result.reason, /SNAP-20260712-2114/);
  assert.match(result.reason, /SNAP-WRONG-ID/);
});

test("(16) G6: task has no snapshot_id (e.g. B1) -> echo check skipped, ok", () => {
  const taskText = "type: B1 역질문\n";
  const result = checkPmSnapshotEcho(taskText, "anything\n");
  assert.equal(result.ok, true);
  assert.match(result.reason, /skipped/);
});

test("(17) CLI: --task only, complete envelope -> exit 0", () => {
  withFieldsFile((dir) => {
    const taskPath = join(dir, "pm-task.md");
    writeFileSync(taskPath, b2TaskWith(FULL_SNAPSHOT_BLOCK), "utf8");
    execFileSync("node", [SCRIPT_PATH, "--task", taskPath], { encoding: "utf8" });
  });
});

test("(18) CLI: --task only, missing envelope -> non-zero exit", () => {
  withFieldsFile((dir) => {
    const taskPath = join(dir, "pm-task.md");
    writeFileSync(taskPath, b2TaskWith(null), "utf8");
    assert.throws(() => execFileSync("node", [SCRIPT_PATH, "--task", taskPath], { encoding: "utf8" }));
  });
});

test("(19) CLI: --task + --result, matching snapshot_id -> exit 0", () => {
  withFieldsFile((dir) => {
    const taskPath = join(dir, "pm-task.md");
    const resultPath = join(dir, "pm.md");
    writeFileSync(taskPath, b2TaskWith(FULL_SNAPSHOT_BLOCK), "utf8");
    writeFileSync(resultPath, "snapshot_id: SNAP-20260712-2114\n", "utf8");
    execFileSync("node", [SCRIPT_PATH, "--task", taskPath, "--result", resultPath], { encoding: "utf8" });
  });
});

test("(20) CLI: --task + --result, mismatched snapshot_id -> non-zero exit", () => {
  withFieldsFile((dir) => {
    const taskPath = join(dir, "pm-task.md");
    const resultPath = join(dir, "pm.md");
    writeFileSync(taskPath, b2TaskWith(FULL_SNAPSHOT_BLOCK), "utf8");
    writeFileSync(resultPath, "snapshot_id: WRONG\n", "utf8");
    assert.throws(() => execFileSync("node", [SCRIPT_PATH, "--task", taskPath, "--result", resultPath], { encoding: "utf8" }));
  });
});

test("(21) CLI: no --task -> non-zero exit (usage error)", () => {
  assert.throws(() => execFileSync("node", [SCRIPT_PATH], { encoding: "utf8" }));
});

test("(22) G5: a guidance comment prefixed 'pm-snapshot-gate(...)' before the real envelope does not shadow it -> ok (review-6 repro)", () => {
  const text = b2TaskWith(
    "<!-- pm-snapshot-gate(G5)가 파싱하는 스냅샷 증거 봉투 안내 -->\n" + FULL_SNAPSHOT_BLOCK,
  );
  const result = checkPmSnapshotEnvelope(text);
  assert.equal(result.ok, true);
  assert.match(result.reason, /envelope complete/);
});

test("(23) G5: only the guidance-comment prefix present, no real envelope -> ok:false (not falsely satisfied by the guidance text)", () => {
  const text = b2TaskWith("<!-- pm-snapshot-gate(G5)가 파싱하는 스냅샷 증거 봉투 안내 -->");
  const result = checkPmSnapshotEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no pm-snapshot envelope block/);
});

test("(24) parsePmType: ignores a 'type: B2/B3' phrase that appears inside an HTML comment (review-7 repro)", () => {
  const text = "<!-- 안내: type: B2/B3는 필수, B1은 면제 -->\ntask_id: X\n";
  assert.equal(parsePmType(text), null);
});

test("(25) parsePmType: the real pm-task template's raw guidance comment no longer false-matches", () => {
  const text =
    "```\ntask_id: X\ndropped_at: Y\ntype: <REPLACE_ME — B1 역질문 | B2 진단·개선안 | B3 시스템검증 중 하나>\n```\n" +
    "<!-- PM 스냅샷 봉투 안내(G5·B2/B3 필수): 아래 실제 봉투는 pm-snapshot-gate가 파싱한다.\n" +
    "     type: B2/B3는 필수, B1은 면제, `linear_evidence: none`을 태스크에 명시하면 B2/B3여도 면제.\n" +
    "     captured_at은 `YYYY-MM-DD HH:MM KST` 형식 그대로(초 금지). issue 행은 이슈당 최소 1줄. -->\n";
  assert.equal(parsePmType(text), null);
});

test("(26) parsePmType: a real type header outside any comment still parses normally (no over-stripping)", () => {
  assert.equal(parsePmType("type: B2 진단·개선안\n"), "B2");
  assert.equal(parsePmType("<!-- unrelated comment -->\ntype: B3 시스템검증\n"), "B3");
});

test("(27) parsePmType: coder-4's header variants still work after comment-stripping (TYPE:/leading ws/space-before-colon/lowercase)", () => {
  assert.equal(parsePmType("TYPE: B1 질문\n"), "B1");
  assert.equal(parsePmType("  type: B1 질문\n"), "B1");
  assert.equal(parsePmType("type : B1 질문\n"), "B1");
  assert.equal(parsePmType("type: b1 질문\n"), "B1");
});

test("(28) checkPmSnapshotEnvelope: unchanged behavior after parsePmType's comment-stripping -- a real snapshot envelope inside a comment is still found", () => {
  const result = checkPmSnapshotEnvelope(b2TaskWith(FULL_SNAPSHOT_BLOCK));
  assert.equal(result.ok, true);
  assert.match(result.reason, /envelope complete/);
});
