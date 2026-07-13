import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { REPORT_SECTIONS, summarizeInventory, buildDriftRows, buildReport, writeReport } from "./selfcheck-report.mjs";

const SAMPLE_MANIFEST_BY_ID = {
  "clear-safe-check": { substrate: "claude-stop", owner: "ORCH", install_targets: [{ location: "repo-settings" }], expected_good: "exit 0" },
  "pre-commit-gitleaks": { substrate: "git", owner: "human", install_targets: [], expected_good: "exit 0", known_drift_note: "known" },
};

const SAMPLE_INVENTORY = [
  { id: "clear-safe-check", status: "ALIVE", evidence: ["wired", "canary fresh"] },
  { id: "pre-commit-gitleaks", status: "NOT_INSTALLED", evidence: ["not installed"] },
];

const SAMPLE_SMOKE = [
  { id: "clear-safe-check", variant: "bad", expectedExit: 2, actualExit: 2, pass: true },
  { id: "clear-safe-check", variant: "good", expectedExit: 0, actualExit: 0, pass: true },
];

test("(1) summarizeInventory: tallies all 5 states, zero for absent ones", () => {
  const summary = summarizeInventory(SAMPLE_INVENTORY);
  assert.deepEqual(summary, { ALIVE: 1, SILENT_BROKEN: 0, DRIFT: 0, UNJUDGABLE: 0, NOT_INSTALLED: 1 });
});

test("(2) buildDriftRows: only non-ALIVE entries become drift rows, owner pulled from manifest", () => {
  const rows = buildDriftRows(SAMPLE_INVENTORY, SAMPLE_MANIFEST_BY_ID);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "pre-commit-gitleaks");
  assert.equal(rows[0].severity, "NOT_INSTALLED");
  assert.equal(rows[0].owner, "human");
  assert.match(rows[0].repair, /not installed/);
});

test("(3) buildDriftRows: a known_drift_note entry is due '이월(사이클3)', others 'due 다음 selfcheck 실행 전'", () => {
  const rows = buildDriftRows(SAMPLE_INVENTORY, SAMPLE_MANIFEST_BY_ID);
  assert.equal(rows[0].due, "이월(사이클3)");
});

test("(4) buildReport: every required §7 section appears (schema test, G10)", () => {
  const text = buildReport({
    runId: "run-1",
    taskId: "HYK-129-coder-1",
    capturedAt: "2026-07-13 15:00 KST",
    repoHead: "abc123",
    runtimeVersions: "node v20",
    nextDue: "2026-07-20",
    manifestById: SAMPLE_MANIFEST_BY_ID,
    inventoryResults: SAMPLE_INVENTORY,
    smokeCases: SAMPLE_SMOKE,
    limitations: ["Claude-only checks judged UNJUDGABLE without a canary receipt"],
    receipts: ["static: enforcement-inventory.json@abc123"],
  });
  for (const section of REPORT_SECTIONS) {
    if (section === "run_id") {
      assert.match(text, /run_id: run-1/);
      continue;
    }
    assert.match(text, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing section: ${section}`);
  }
});

test("(5) buildReport: 5-state summary line reflects summarizeInventory exactly", () => {
  const text = buildReport({
    runId: "run-1",
    taskId: "t",
    capturedAt: "now",
    repoHead: "x",
    runtimeVersions: "y",
    nextDue: "z",
    manifestById: SAMPLE_MANIFEST_BY_ID,
    inventoryResults: SAMPLE_INVENTORY,
    smokeCases: [],
    limitations: [],
    receipts: [],
  });
  assert.match(text, /ALIVE 1 · SILENT_BROKEN 0 · DRIFT 0 · UNJUDGABLE 0 · NOT_INSTALLED 1/);
});

test("(6) buildReport: drift table empty when everything is ALIVE -> explicit '없음', not a blank table", () => {
  const text = buildReport({
    runId: "r",
    taskId: "t",
    capturedAt: "now",
    repoHead: "x",
    runtimeVersions: "y",
    nextDue: "z",
    manifestById: SAMPLE_MANIFEST_BY_ID,
    inventoryResults: [{ id: "clear-safe-check", status: "ALIVE", evidence: ["ok"] }],
    smokeCases: [],
    limitations: [],
    receipts: [],
  });
  assert.match(text, /없음 -- 이번 실행에서 전 항목 ALIVE/);
});

test("(7) buildReport: limitations/receipts render as bullet lists, '(없음)' when empty", () => {
  const text = buildReport({
    runId: "r",
    taskId: "t",
    capturedAt: "now",
    repoHead: "x",
    runtimeVersions: "y",
    nextDue: "z",
    manifestById: {},
    inventoryResults: [],
    smokeCases: [],
    limitations: [],
    receipts: [],
  });
  const limSection = text.split("## 한계·판정불가")[1].split("## 영수증")[0];
  assert.match(limSection, /- \(없음\)/);
});

test("(8) writeReport: writes the given text verbatim to the given path", () => {
  const dir = mkdtempSync(join(tmpdir(), "selfcheck-report-test-"));
  try {
    const path = join(dir, "report.md");
    writeReport(path, "hello report\n");
    assert.equal(readFileSync(path, "utf8"), "hello report\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
