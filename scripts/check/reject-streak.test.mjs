import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseReviewOutcome,
  applyOutcome,
  computeRecord,
  loadLedger,
  writeLedger,
  checkEnvelope,
  checkGate,
  formatNowLocal,
  ALLOWED_CAUSES,
  ALLOWED_ACTIONS,
} from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./reject-streak.mjs", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "reject-streak-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], { encoding: "utf8", ...opts });
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const COMPLETE_ENVELOPE = [
  "<!-- reject-streak-envelope",
  "원인 분류: 모델 한계",
  "ORCH 조치:",
  "- 모델 변경: sonnet -> opus 승격",
  "-->",
].join("\n");

// ---------------------------------------------------------------------------
// parseReviewOutcome
// ---------------------------------------------------------------------------

test("(1) parseReviewOutcome: 'for:' line rejected -> issue id derived", () => {
  const result = parseReviewOutcome("for: HYK-133-coder-2\ntask_id: HYK-133-review-2\nverdict: rejected\n");
  assert.deepEqual(result, { ok: true, taskId: "HYK-133-coder-2", issueId: "HYK-133", verdict: "rejected" });
});

test("(2) parseReviewOutcome: 'for:' absent -> falls back to 'task_id:'", () => {
  const result = parseReviewOutcome("task_id: HYK-133-review-2\nverdict: approved\n");
  assert.deepEqual(result, { ok: true, taskId: "HYK-133-review-2", issueId: "HYK-133", verdict: "approved" });
});

test("(3) parseReviewOutcome: neither 'for:' nor 'task_id:' -> ok:false", () => {
  const result = parseReviewOutcome("verdict: rejected\n");
  assert.equal(result.ok, false);
});

test("(4) parseReviewOutcome: task id not HYK-shaped -> ok:false", () => {
  const result = parseReviewOutcome("for: NOTANID\nverdict: rejected\n");
  assert.equal(result.ok, false);
});

test("(5) parseReviewOutcome: missing verdict line -> ok:false", () => {
  const result = parseReviewOutcome("for: HYK-133-coder-2\n");
  assert.equal(result.ok, false);
});

test("(6) parseReviewOutcome: verdict is case-insensitive, normalized lowercase", () => {
  const result = parseReviewOutcome("for: HYK-133-coder-2\nverdict: APPROVED\n");
  assert.equal(result.ok, true);
  assert.equal(result.verdict, "approved");
});

test("(7) parseReviewOutcome: verdict value outside approved/rejected -> ok:false", () => {
  const result = parseReviewOutcome("for: HYK-133-coder-2\nverdict: maybe\n");
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// applyOutcome / computeRecord
// ---------------------------------------------------------------------------

test("(8) applyOutcome: rejected on empty ledger -> streak=1", () => {
  const ledger = applyOutcome({ schema_version: 1, issues: {} }, { issueId: "HYK-133", taskId: "HYK-133-coder-1", verdict: "rejected", at: "t1" });
  assert.equal(ledger.issues["HYK-133"].streak, 1);
  assert.deepEqual(ledger.issues["HYK-133"].history, [{ task_id: "HYK-133-coder-1", verdict: "rejected", at: "t1" }]);
});

test("(9) applyOutcome: two consecutive rejected -> streak=2, history length 2", () => {
  let ledger = { schema_version: 1, issues: {} };
  ledger = applyOutcome(ledger, { issueId: "HYK-133", taskId: "HYK-133-coder-1", verdict: "rejected", at: "t1" });
  ledger = applyOutcome(ledger, { issueId: "HYK-133", taskId: "HYK-133-coder-2", verdict: "rejected", at: "t2" });
  assert.equal(ledger.issues["HYK-133"].streak, 2);
  assert.equal(ledger.issues["HYK-133"].history.length, 2);
});

test("(10) applyOutcome: approved resets streak to 0 but keeps history", () => {
  let ledger = { schema_version: 1, issues: {} };
  ledger = applyOutcome(ledger, { issueId: "HYK-133", taskId: "HYK-133-coder-1", verdict: "rejected", at: "t1" });
  ledger = applyOutcome(ledger, { issueId: "HYK-133", taskId: "HYK-133-coder-2", verdict: "rejected", at: "t2" });
  ledger = applyOutcome(ledger, { issueId: "HYK-133", taskId: "HYK-133-coder-3", verdict: "approved", at: "t3" });
  assert.equal(ledger.issues["HYK-133"].streak, 0);
  assert.equal(ledger.issues["HYK-133"].history.length, 3);
});

test("(11) applyOutcome: two issues tracked independently", () => {
  let ledger = { schema_version: 1, issues: {} };
  ledger = applyOutcome(ledger, { issueId: "HYK-129", taskId: "HYK-129-coder-1", verdict: "rejected", at: "t1" });
  ledger = applyOutcome(ledger, { issueId: "HYK-133", taskId: "HYK-133-coder-1", verdict: "rejected", at: "t2" });
  ledger = applyOutcome(ledger, { issueId: "HYK-129", taskId: "HYK-129-coder-2", verdict: "rejected", at: "t3" });
  assert.equal(ledger.issues["HYK-129"].streak, 2);
  assert.equal(ledger.issues["HYK-133"].streak, 1);
});

test("(12) computeRecord: composes parse + apply, returns resulting streak", () => {
  const result = computeRecord({ reviewText: "for: HYK-133-coder-1\nverdict: rejected\n", ledger: { schema_version: 1, issues: {} }, at: "t1" });
  assert.equal(result.ok, true);
  assert.equal(result.issueId, "HYK-133");
  assert.equal(result.streak, 1);
});

test("(13) computeRecord: malformed review text -> ok:false, no ledger mutation attempted", () => {
  const result = computeRecord({ reviewText: "nothing useful here\n", ledger: { schema_version: 1, issues: {} }, at: "t1" });
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// loadLedger / writeLedger
// ---------------------------------------------------------------------------

test("(14) loadLedger: missing file -> ok:true, existed:false, empty issues (streak 0 baseline)", () => {
  withFixtureDir((dir) => {
    const result = loadLedger(join(dir, "reject-streak.json"));
    assert.equal(result.ok, true);
    assert.equal(result.existed, false);
    assert.deepEqual(result.ledger.issues, {});
  });
});

test("(15) loadLedger: valid JSON -> ok:true, existed:true", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, JSON.stringify({ schema_version: 1, issues: { "HYK-1": { streak: 3, history: [] } } }), "utf8");
    const result = loadLedger(p);
    assert.equal(result.ok, true);
    assert.equal(result.ledger.issues["HYK-1"].streak, 3);
  });
});

test("(16) loadLedger: invalid JSON -> ok:false (UNJUDGABLE reason)", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, "{ not valid json", "utf8");
    const result = loadLedger(p);
    assert.equal(result.ok, false);
    assert.match(result.reason, /UNJUDGABLE/);
  });
});

test("(17) loadLedger: valid JSON but missing 'issues' object -> ok:false (UNJUDGABLE)", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    writeFileSync(p, JSON.stringify({ schema_version: 1 }), "utf8");
    const result = loadLedger(p);
    assert.equal(result.ok, false);
  });
});

test("(18) writeLedger + loadLedger round-trip", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "reject-streak.json");
    const ledger = { schema_version: 1, issues: { "HYK-9": { streak: 1, history: [{ task_id: "HYK-9-coder-1", verdict: "rejected", at: "t" }] } } };
    writeLedger(p, ledger);
    const reloaded = loadLedger(p);
    assert.equal(reloaded.ok, true);
    assert.deepEqual(reloaded.ledger, ledger);
  });
});

// ---------------------------------------------------------------------------
// checkEnvelope
// ---------------------------------------------------------------------------

test("(19) checkEnvelope: complete envelope -> ok:true", () => {
  const result = checkEnvelope(`# task\n\n${COMPLETE_ENVELOPE}\n`);
  assert.equal(result.ok, true);
});

test("(20) checkEnvelope: no envelope block at all -> ok:false", () => {
  const result = checkEnvelope("# task\n\nno envelope here.\n");
  assert.equal(result.ok, false);
});

test("(21) checkEnvelope: cause only, no ORCH 조치 header -> ok:false (ⓑ)", () => {
  const text = ["<!-- reject-streak-envelope", "원인 분류: 모델 한계", "-->"].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /ORCH 조치/);
});

test("(22) checkEnvelope: ORCH 조치 only, no cause -> ok:false (ⓑ)", () => {
  const text = ["<!-- reject-streak-envelope", "ORCH 조치:", "- 모델 변경: opus로", "-->"].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
  assert.match(result.reason, /원인 분류/);
});

test("(23) checkEnvelope: cause value not in allowed set -> ok:false", () => {
  const text = ["<!-- reject-streak-envelope", "원인 분류: 그냥 운이 나빴음", "ORCH 조치:", "- 모델 변경: x", "-->"].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(24) checkEnvelope: ORCH 조치 header present but zero bullets -> ok:false", () => {
  const text = ["<!-- reject-streak-envelope", "원인 분류: 설계 결함", "ORCH 조치:", "", "-->"].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(25) checkEnvelope: ORCH 조치 bullet with unrecognized label -> ok:false", () => {
  const text = ["<!-- reject-streak-envelope", "원인 분류: 설계 결함", "ORCH 조치:", "- 그냥 다시 시도: x", "-->"].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(26) checkEnvelope: all four allowed causes accepted", () => {
  for (const cause of ALLOWED_CAUSES) {
    const text = ["<!-- reject-streak-envelope", `원인 분류: ${cause}`, "ORCH 조치:", "- 재설계 지시: x", "-->"].join("\n");
    assert.equal(checkEnvelope(text).ok, true, `cause '${cause}' should be accepted`);
  }
});

test("(27) checkEnvelope: all five allowed action labels accepted individually", () => {
  for (const action of ALLOWED_ACTIONS) {
    const text = ["<!-- reject-streak-envelope", "원인 분류: 모델 한계", "ORCH 조치:", `- ${action}: x`, "-->"].join("\n");
    assert.equal(checkEnvelope(text).ok, true, `action '${action}' should be accepted`);
  }
});

test("(28) checkEnvelope: 리서치(출처 포함) label form (parenthetical) still accepted (format-only per S4)", () => {
  const text = ["<!-- reject-streak-envelope", "원인 분류: 모델 한계", "ORCH 조치:", "- 리서치(출처 포함): https://example.com 참고", "-->"].join("\n");
  assert.equal(checkEnvelope(text).ok, true);
});

test("(28b) checkEnvelope: CRLF-terminated envelope block still parses (Windows-authored doc/task file, review-1 root-cause repro)", () => {
  const text = ["<!-- reject-streak-envelope", "원인 분류: 모델 한계", "ORCH 조치:", "- 모델 변경: x", "-->"].join("\r\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, true, result.reason);
});

test("(29) checkEnvelope: multiple ORCH 조치 bullets, only one needs to match", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: 환경 차이",
    "ORCH 조치:",
    "- 뭔가 애매한 줄",
    "- 디스코프 제안: 이 태스크는 범위 밖으로",
    "-->",
  ].join("\n");
  assert.equal(checkEnvelope(text).ok, true);
});

// ---------------------------------------------------------------------------
// checkGate (R1-R3 known-bad/good matrix)
// ---------------------------------------------------------------------------

test("(30) ⓓ checkGate: streak=1 (no envelope) -> PASS", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 1, history: [] } } };
  const result = checkGate({ taskText: "task_id: HYK-133-coder-2\n", ledger });
  assert.equal(result.status, "PASS");
});

test("(31) ⓐ checkGate: streak=2, no envelope -> BLOCK", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 2, history: [] } } };
  const result = checkGate({ taskText: "task_id: HYK-133-coder-3\n", ledger });
  assert.equal(result.status, "BLOCK");
});

test("(32) ⓑ checkGate: streak=2, envelope with cause only -> BLOCK", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 2, history: [] } } };
  const text = "task_id: HYK-133-coder-3\n<!-- reject-streak-envelope\n원인 분류: 모델 한계\n-->";
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "BLOCK");
});

test("(32b) ⓑ checkGate: streak=2, envelope with ORCH 조치 only -> BLOCK", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 2, history: [] } } };
  const text = "task_id: HYK-133-coder-3\n<!-- reject-streak-envelope\nORCH 조치:\n- 모델 변경: x\n-->";
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "BLOCK");
});

test("(33) ⓒ checkGate: streak=2, complete envelope -> PASS", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 2, history: [] } } };
  const text = `task_id: HYK-133-coder-3\n${COMPLETE_ENVELOPE}\n`;
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "PASS");
});

test("(34) ⓔ checkGate: streak=0 (post-reset) -> PASS without envelope", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 0, history: [] } } };
  const result = checkGate({ taskText: "task_id: HYK-133-coder-4\n", ledger });
  assert.equal(result.status, "PASS");
});

test("(35) checkGate: issue absent from ledger entirely -> treated as streak 0 -> PASS", () => {
  const ledger = { schema_version: 1, issues: {} };
  const result = checkGate({ taskText: "task_id: HYK-999-coder-1\n", ledger });
  assert.equal(result.status, "PASS");
});

test("(36) checkGate: streak=4 (deep ladder) still governed by the same envelope rule -> PASS with complete envelope", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 4, history: [] } } };
  const text = `task_id: HYK-133-coder-5\n${COMPLETE_ENVELOPE}\n`;
  const result = checkGate({ taskText: text, ledger });
  assert.equal(result.status, "PASS");
});

test("(37) checkGate: task file with no task_id header -> UNJUDGABLE, fail-open", () => {
  const ledger = { schema_version: 1, issues: { "HYK-133": { streak: 5, history: [] } } };
  const result = checkGate({ taskText: "no header here\n", ledger });
  assert.equal(result.status, "UNJUDGABLE");
  assert.equal(result.ok, true);
});

test("(38) checkGate: task_id not HYK-shaped -> UNJUDGABLE, fail-open", () => {
  const ledger = { schema_version: 1, issues: {} };
  const result = checkGate({ taskText: "task_id: WEIRD-1\n", ledger });
  assert.equal(result.status, "UNJUDGABLE");
});

// ---------------------------------------------------------------------------
// formatNowLocal
// ---------------------------------------------------------------------------

test("(39) formatNowLocal: shape 'YYYY-MM-DD HH:MM KST'", () => {
  const s = formatNowLocal(new Date(2026, 6, 13, 9, 5));
  assert.equal(s, "2026-07-13 09:05 KST");
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

test("(40) CLI record: rejected review -> ledger written with streak=1", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(reviewPath, "for: HYK-133-coder-1\nverdict: rejected\n", "utf8");
    const { status, stdout } = runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
    assert.match(stdout, /streak=1/);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.issues["HYK-133"].streak, 1);
  });
});

test("(41) CLI record: ledger survives across two separate invocations (relay-slot-overwrite simulation)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(reviewPath, "for: HYK-133-coder-1\nverdict: rejected\n", "utf8");
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    // Simulate the relay slot being overwritten by the next round's review.
    writeFileSync(reviewPath, "for: HYK-133-coder-2\nverdict: rejected\n", "utf8");
    const { status, stdout } = runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    assert.equal(status, 0);
    assert.match(stdout, /streak=2/);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(ledger.issues["HYK-133"].streak, 2);
    assert.equal(ledger.issues["HYK-133"].history.length, 2);
  });
});

test("(42) CLI record: review file missing -> UNJUDGABLE, exit 0, no ledger file created", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");
    const { status, stdout } = runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
    assert.equal(existsSync(ledgerPath), false);
  });
});

test("(43) CLI record: malformed review content -> UNJUDGABLE, exit 0, ledger untouched", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(reviewPath, "no useful fields\n", "utf8");
    writeFileSync(ledgerPath, JSON.stringify({ schema_version: 1, issues: { "HYK-1": { streak: 9, history: [] } } }), "utf8");
    const before = readFileSync(ledgerPath, "utf8");
    const { status, stdout } = runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
    assert.equal(readFileSync(ledgerPath, "utf8"), before);
  });
});

test("(44) CLI gate: ⓐ streak=2, no envelope -> exit 2", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-3\n", "utf8");
    writeFileSync(ledgerPath, JSON.stringify({ schema_version: 1, issues: { "HYK-133": { streak: 2, history: [] } } }), "utf8");
    const { status, stderr } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 2);
    assert.match(stderr, /reject-streak gate/);
  });
});

test("(45) CLI gate: ⓒ streak=2, complete envelope -> exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, `task_id: HYK-133-coder-3\n${COMPLETE_ENVELOPE}\n`, "utf8");
    writeFileSync(ledgerPath, JSON.stringify({ schema_version: 1, issues: { "HYK-133": { streak: 2, history: [] } } }), "utf8");
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
  });
});

test("(46) CLI gate: ⓓ streak=1, no envelope -> exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-2\n", "utf8");
    writeFileSync(ledgerPath, JSON.stringify({ schema_version: 1, issues: { "HYK-133": { streak: 1, history: [] } } }), "utf8");
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
  });
});

test("(47) CLI gate: ⓔ approved reset then re-drop with no envelope -> exit 0", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(reviewPath, "for: HYK-133-coder-1\nverdict: rejected\n", "utf8");
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    writeFileSync(reviewPath, "for: HYK-133-coder-2\nverdict: rejected\n", "utf8");
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    writeFileSync(reviewPath, "for: HYK-133-coder-3\nverdict: approved\n", "utf8");
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    writeFileSync(taskPath, "task_id: HYK-133-coder-4\n", "utf8");
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
  });
});

test("(48) CLI gate: ⓕ ledger file corrupted -> UNJUDGABLE, exit 0 (fail-open, not silently PASS-as-streak-0)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-3\n", "utf8");
    writeFileSync(ledgerPath, "{ broken", "utf8");
    const { status, stdout } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
  });
});

test("(49) CLI gate: no ledger file at all -> streak 0 baseline -> exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-133-coder-1\n", "utf8");
    const { status } = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(status, 0);
    assert.equal(existsSync(ledgerPath), false, "gate must never create/write the ledger");
  });
});

test("(50) CLI gate: missing task file -> exit 1 (operator error, not a judgment)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "does-not-exist.md");
    const { status } = runCli(["gate", taskPath]);
    assert.equal(status, 1);
  });
});

test("(51) CLI: no subcommand -> usage, exit 1", () => {
  const { status } = runCli([]);
  assert.equal(status, 1);
});

// ---------------------------------------------------------------------------
// Doc-code contract (review-1, HYK-133-coder-1 repro guard): enforcement-v1.md
// §G's envelope template must itself pass the real gate parser verbatim, so
// a future edit that touches the doc's prose without keeping the worked
// example real-valued is caught mechanically, not by a reviewer noticing by
// hand the way review-1 had to.
// ---------------------------------------------------------------------------

function extractEnvelopeTemplateFromDocs() {
  const docPath = fileURLToPath(new URL("../../docs/enforcement-v1.md", import.meta.url));
  const text = readFileSync(docPath, "utf8");
  const m = text.match(/```\r?\n(<!--\s*reject-streak-envelope[\s\S]*?-->)\r?\n```/);
  if (!m) throw new Error("could not find a fenced reject-streak-envelope template block in docs/enforcement-v1.md");
  return m[1];
}

test("(53) doc-code contract: enforcement-v1.md §G envelope template passes checkEnvelope verbatim", () => {
  const block = extractEnvelopeTemplateFromDocs();
  const result = checkEnvelope(block);
  assert.equal(result.ok, true, result.reason);
});

test("(54) doc-code contract: the doc's template also clears the full gate at streak>=2 with no edits", () => {
  const block = extractEnvelopeTemplateFromDocs();
  const ledger = { schema_version: 1, issues: { "HYK-1": { streak: 3, history: [] } } };
  const result = checkGate({ taskText: `task_id: HYK-1-coder-9\n${block}\n`, ledger });
  assert.equal(result.status, "PASS", result.reason);
});

test("(55) sanity: an un-substituted '<...>' placeholder cause is still rejected (the exact review-1 repro shape, kept as a permanent regression guard)", () => {
  const text = [
    "<!-- reject-streak-envelope",
    "원인 분류: <스펙 오류(ORCH) | 모델 한계 | 환경 차이 | 설계 결함 중 하나>",
    "ORCH 조치:",
    "- <분류>: <내용>",
    "-->",
  ].join("\n");
  const result = checkEnvelope(text);
  assert.equal(result.ok, false);
});

test("(52) end-to-end: record 2 rejects then gate without envelope blocks the real ⓐ scenario", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");

    writeFileSync(reviewPath, "for: HYK-133-coder-1\ntask_id: HYK-133-review-1\nrole: REVIEW-CODEX\nverdict: rejected\n", "utf8");
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);
    writeFileSync(reviewPath, "for: HYK-133-coder-2\ntask_id: HYK-133-review-2\nrole: REVIEW-CODEX\nverdict: rejected\n", "utf8");
    runCli(["record", "--review", reviewPath, "--ledger", ledgerPath]);

    writeFileSync(taskPath, "task_id: HYK-133-coder-3\ndropped_at: 2026-07-13 18:00 KST\n\nno envelope in this drop\n", "utf8");
    const blocked = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(blocked.status, 2);

    writeFileSync(taskPath, `task_id: HYK-133-coder-3\ndropped_at: 2026-07-13 18:05 KST\n\n${COMPLETE_ENVELOPE}\n`, "utf8");
    const passed = runCli(["gate", taskPath, "--ledger", ledgerPath]);
    assert.equal(passed.status, 0);
  });
});
