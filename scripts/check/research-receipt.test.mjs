import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildReceiptEntry,
  appendReceipt,
  checkResearchReceipt,
  checkPriorArtField,
  checkResearchGate,
  formatNowLocal,
  isValidTimestamp,
} from "./research-receipt.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./research-receipt.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "research-receipt-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts = {}) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      ...opts,
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

const B0_REQUEST_WITH_PRIOR_ART = [
  "## B0 사전 비평 요청",
  "b0_id: HYK-160-b0-1",
  "대상 결정: 결정적 분해",
  "선행 사례: 락 라이브러리 A/B 비교(출처: ...)",
  "트리거: 2번",
].join("\n");

const B0_REQUEST_NO_PRIOR_ART = [
  "## B0 사전 비평 요청",
  "b0_id: HYK-160-b0-1",
  "대상 결정: 결정적 분해",
  "트리거: 2번",
].join("\n");

// ---------------------------------------------------------------------------
// buildReceiptEntry / appendReceipt
// ---------------------------------------------------------------------------

test("(1) buildReceiptEntry: WebSearch call -> entry with query", () => {
  const entry = buildReceiptEntry({
    toolName: "WebSearch",
    toolInput: { query: "node file lock library" },
    now: "2026-07-18 18:00 KST",
  });
  assert.deepEqual(entry, {
    tool: "WebSearch",
    query: "node file lock library",
    at: "2026-07-18 18:00 KST",
  });
});

test("(2) buildReceiptEntry: WebFetch call -> entry with url as query", () => {
  const entry = buildReceiptEntry({
    toolName: "WebFetch",
    toolInput: { url: "https://example.com/locks" },
    now: "2026-07-18 18:00 KST",
  });
  assert.deepEqual(entry, {
    tool: "WebFetch",
    query: "https://example.com/locks",
    at: "2026-07-18 18:00 KST",
  });
});

test("(3) buildReceiptEntry: non-WebSearch/WebFetch tool -> null (out of scope)", () => {
  assert.equal(
    buildReceiptEntry({
      toolName: "Read",
      toolInput: { file_path: "x" },
      now: "now",
    }),
    null,
  );
  assert.equal(
    buildReceiptEntry({
      toolName: "Bash",
      toolInput: { command: "ls" },
      now: "now",
    }),
    null,
  );
});

test("(4) appendReceipt: creates a new log file when none exists", () => {
  withFixtureDir((dir) => {
    const logPath = join(dir, "research-log.json");
    const log = appendReceipt({
      logPath,
      entry: { tool: "WebSearch", query: "x", at: "now" },
    });
    assert.equal(log.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(logPath, "utf8")), log);
  });
});

test("(5) appendReceipt: append-only -- second call keeps the first entry", () => {
  withFixtureDir((dir) => {
    const logPath = join(dir, "research-log.json");
    appendReceipt({
      logPath,
      entry: { tool: "WebSearch", query: "first", at: "2026-07-18 10:00 KST" },
    });
    const log = appendReceipt({
      logPath,
      entry: { tool: "WebFetch", query: "second", at: "2026-07-18 10:05 KST" },
    });
    assert.equal(log.length, 2);
    assert.equal(log[0].query, "first");
    assert.equal(log[1].query, "second");
  });
});

test("(6) appendReceipt: malformed existing file -> replaced with a fresh array containing this entry (never crashes)", () => {
  withFixtureDir((dir) => {
    const logPath = join(dir, "research-log.json");
    writeFileSync(logPath, "{not valid json", "utf8");
    const log = appendReceipt({
      logPath,
      entry: { tool: "WebSearch", query: "x", at: "now" },
    });
    assert.equal(log.length, 1);
  });
});

// ---------------------------------------------------------------------------
// checkResearchReceipt -- known-bad / paired-good matrix (RESEARCH_RECEIPT_REQUIRED)
// ---------------------------------------------------------------------------

test("(7) streak<2 -> PASS regardless of log contents", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-160": { streak: 1, history: [] } },
  };
  const result = checkResearchReceipt({
    taskText: "task_id: HYK-160-coder-2\n",
    ledger,
    log: [],
  });
  assert.equal(result.status, "PASS");
});

test("(8) known-bad: streak>=2, no receipt in log at all -> RESEARCH_RECEIPT_REQUIRED", () => {
  const ledger = {
    schema_version: 1,
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const result = checkResearchReceipt({
    taskText: "task_id: HYK-160-coder-3\n",
    ledger,
    log: [],
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^RESEARCH_RECEIPT_REQUIRED/);
});

test("(9) known-bad: streak>=2, receipt exists but BEFORE the last reject -> RESEARCH_RECEIPT_REQUIRED (time-boundary single variable)", () => {
  const ledger = {
    schema_version: 1,
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [{ tool: "WebSearch", query: "x", at: "2026-07-18 09:00 KST" }];
  const result = checkResearchReceipt({
    taskText: "task_id: HYK-160-coder-3\n",
    ledger,
    log,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^RESEARCH_RECEIPT_REQUIRED/);
});

test("(10) paired good: same ledger/task, receipt timestamp moved to AFTER the last reject -> PASS (single variable: time)", () => {
  const ledger = {
    schema_version: 1,
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [{ tool: "WebSearch", query: "x", at: "2026-07-18 10:30 KST" }];
  const result = checkResearchReceipt({
    taskText: "task_id: HYK-160-coder-3\n",
    ledger,
    log,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(11) WebFetch receipt also counts, not just WebSearch", () => {
  const ledger = {
    schema_version: 1,
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [
    { tool: "WebFetch", query: "https://x", at: "2026-07-18 10:30 KST" },
  ];
  const result = checkResearchReceipt({
    taskText: "task_id: HYK-160-coder-3\n",
    ledger,
    log,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(12) UNJUDGABLE: task file has no task_id header -> fail-open", () => {
  const result = checkResearchReceipt({
    taskText: "no header\n",
    ledger: {},
    log: [],
  });
  assert.equal(result.status, "UNJUDGABLE");
});

test("(13) no ledger entry for issue -> treated as streak 0 -> PASS", () => {
  const result = checkResearchReceipt({
    taskText: "task_id: HYK-999-coder-1\n",
    ledger: { schema_version: 1, issues: {} },
    log: [],
  });
  assert.equal(result.status, "PASS");
});

// ---------------------------------------------------------------------------
// checkPriorArtField -- known-bad / paired-good matrix (PRIOR_ART_FIELD_REQUIRED)
// ---------------------------------------------------------------------------

test("(14) no B0 request block at all -> PASS (not this gate's concern, b0-gate owns classification)", () => {
  const result = checkPriorArtField("# task\n\nno B0 block here\n");
  assert.equal(result.status, "PASS");
});

test("(15) known-bad: B0 request block present but missing '선행 사례:' field -> PRIOR_ART_FIELD_REQUIRED", () => {
  const result = checkPriorArtField(`# task\n\n${B0_REQUEST_NO_PRIOR_ART}\n`);
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^PRIOR_ART_FIELD_REQUIRED/);
});

test("(16) paired good: same block, '선행 사례:' field added -> PASS (single-variable fix)", () => {
  const result = checkPriorArtField(`# task\n\n${B0_REQUEST_WITH_PRIOR_ART}\n`);
  assert.equal(result.status, "PASS", result.reason);
});

test("(17) known-bad: '선행 사례:' field present but empty -> PRIOR_ART_FIELD_REQUIRED", () => {
  const emptyField = B0_REQUEST_NO_PRIOR_ART + "\n선행 사례: ";
  const result = checkPriorArtField(`# task\n\n${emptyField}\n`);
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^PRIOR_ART_FIELD_REQUIRED/);
});

// ---------------------------------------------------------------------------
// checkResearchGate -- combined, two isolated fixtures (G6: 결손 2종 분리)
// ---------------------------------------------------------------------------

test("(18) checkResearchGate: RESEARCH_RECEIPT_REQUIRED fires independently of prior-art (no B0 block involved)", () => {
  const ledger = {
    schema_version: 1,
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const result = checkResearchGate({
    taskText: "task_id: HYK-160-coder-3\n",
    ledger,
    log: [],
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^RESEARCH_RECEIPT_REQUIRED/);
});

test("(19) checkResearchGate: PRIOR_ART_FIELD_REQUIRED fires independently of receipt (streak<2, receipt not required)", () => {
  const ledger = {
    schema_version: 1,
    issues: { "HYK-160": { streak: 0, history: [] } },
  };
  const result = checkResearchGate({
    taskText: `task_id: HYK-160-coder-1\n\n${B0_REQUEST_NO_PRIOR_ART}\n`,
    ledger,
    log: [],
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^PRIOR_ART_FIELD_REQUIRED/);
});

test("(20) checkResearchGate: both conditions clean -> PASS, reason mentions both", () => {
  const ledger = {
    schema_version: 1,
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [{ tool: "WebSearch", query: "x", at: "2026-07-18 10:30 KST" }];
  const result = checkResearchGate({
    taskText: `task_id: HYK-160-coder-3\n\n${B0_REQUEST_WITH_PRIOR_ART}\n`,
    ledger,
    log,
  });
  assert.equal(result.status, "PASS", result.reason);
});

// ---------------------------------------------------------------------------
// formatNowLocal
// ---------------------------------------------------------------------------

test("(21) formatNowLocal: shape 'YYYY-MM-DD HH:MM KST'", () => {
  assert.match(
    formatNowLocal(new Date(2026, 6, 18, 18, 5)),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/,
  );
});

// ---------------------------------------------------------------------------
// CLI: record (PostToolUse, never blocks)
// ---------------------------------------------------------------------------

test("(22) CLI record: WebSearch payload -> log written, exit 0", () => {
  withFixtureDir((dir) => {
    const logPath = join(dir, "research-log.json");
    const payload = JSON.stringify({
      tool_name: "WebSearch",
      tool_input: { query: "atomic file rename" },
    });
    const { status } = runCli(["record", "--log", logPath], { input: payload });
    assert.equal(status, 0);
    const log = JSON.parse(readFileSync(logPath, "utf8"));
    assert.equal(log.length, 1);
    assert.equal(log[0].tool, "WebSearch");
  });
});

test("(23) CLI record: non-WebSearch/WebFetch tool -> exit 0, no log file created", () => {
  withFixtureDir((dir) => {
    const logPath = join(dir, "research-log.json");
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "x" },
    });
    const { status } = runCli(["record", "--log", logPath], { input: payload });
    assert.equal(status, 0);
    assert.equal(existsSync(logPath), false);
  });
});

test("(24) CLI record: malformed JSON payload -> exit 0, never blocks the tool call", () => {
  const { status } = runCli(["record"], { input: "not json" });
  assert.equal(status, 0);
});

// ---------------------------------------------------------------------------
// CLI: gate
// ---------------------------------------------------------------------------

test("(25) CLI gate: end-to-end -- streak>=2 no receipt blocks, adding a receipt after the reject passes", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    const logPath = join(dir, "research-log.json");

    writeFileSync(
      taskPath,
      "task_id: HYK-160-coder-3\ndropped_at: 2026-07-18 18:10 KST\n",
      "utf8",
    );
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: {
          "HYK-160": {
            streak: 2,
            history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
          },
        },
      }),
      "utf8",
    );

    const blocked = runCli([
      "gate",
      taskPath,
      "--ledger",
      ledgerPath,
      "--log",
      logPath,
    ]);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /RESEARCH_RECEIPT_REQUIRED/);

    writeFileSync(
      logPath,
      JSON.stringify([
        { tool: "WebSearch", query: "x", at: "2026-07-18 10:30 KST" },
      ]),
      "utf8",
    );
    const passed = runCli([
      "gate",
      taskPath,
      "--ledger",
      ledgerPath,
      "--log",
      logPath,
    ]);
    assert.equal(passed.status, 0);
  });
});

test("(26) CLI gate: missing task file -> exit 1 (operator error, not a judgment)", () => {
  withFixtureDir((dir) => {
    const { status } = runCli(["gate", join(dir, "does-not-exist.md")]);
    assert.equal(status, 1);
  });
});

test("(27) CLI gate: corrupted ledger -> UNJUDGABLE, exit 0 (fail-open, ledger read-only never mutated)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(taskPath, "task_id: HYK-160-coder-3\n", "utf8");
    writeFileSync(ledgerPath, "{not valid json", "utf8");
    const { status, stdout } = runCli([
      "gate",
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /UNJUDGABLE/);
  });
});

test("(28) CLI: no subcommand -> usage, exit 1", () => {
  const { status } = runCli([]);
  assert.equal(status, 1);
});

// ---------------------------------------------------------------------------
// HYK-160-coder-6 (review-4 결함 2): timestamp format validation --
// a bad-shaped ledger/receipt 'at' must never be lexically compared as-is.
// ---------------------------------------------------------------------------

test("(29) isValidTimestamp: well-formed 'YYYY-MM-DD HH:MM KST' -> true", () => {
  assert.equal(isValidTimestamp("2026-07-18 10:00 KST"), true);
});

test("(30) isValidTimestamp: well-formed with optional seconds -> true", () => {
  assert.equal(isValidTimestamp("2026-07-18 10:00:05 KST"), true);
});

test("(31) isValidTimestamp: REVIEW's exact repro garbage strings -> false", () => {
  assert.equal(isValidTimestamp("not-a-fixed-width-time"), false);
  assert.equal(isValidTimestamp("zzz"), false);
});

test("(32) isValidTimestamp: missing KST suffix, non-string, empty -> false", () => {
  assert.equal(isValidTimestamp("2026-07-18 10:00"), false);
  assert.equal(isValidTimestamp(undefined), false);
  assert.equal(isValidTimestamp(""), false);
});

test("(33) known-bad: REVIEW's exact repro -- malformed ledger 'at' + malformed receipt 'at' no longer produces a false PASS, now UNJUDGABLE naming the bad ledger field", () => {
  const taskText = "task_id: HYK-160-coder-5";
  const ledger = {
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "not-a-fixed-width-time" }],
      },
    },
  };
  const log = [{ tool: "WebSearch", at: "zzz" }];
  const result = checkResearchReceipt({ taskText, ledger, log });
  assert.equal(
    result.status,
    "UNJUDGABLE",
    `must not silently PASS on malformed timestamps (got ${result.status})`,
  );
  assert.match(result.reason, /^research-receipt: UNJUDGABLE/);
  assert.match(result.reason, /malformed 'at' timestamp/);
  assert.match(result.reason, /not-a-fixed-width-time/);
});

test("(34) paired good: same fixture, ONLY the ledger's malformed 'at' corrected to a valid timestamp -- the malformed receipt 'at' is caught next, still UNJUDGABLE but naming the receipt field this time (single-variable progression, not yet a false PASS)", () => {
  const taskText = "task_id: HYK-160-coder-5";
  const ledger = {
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [{ tool: "WebSearch", at: "zzz" }];
  const result = checkResearchReceipt({ taskText, ledger, log });
  assert.equal(result.status, "UNJUDGABLE");
  assert.match(result.reason, /malformed 'at' timestamp/);
  assert.match(result.reason, /zzz/);
});

test("(35) paired good: both timestamps corrected to valid, well-formed values -- receipt after cutoff -> PASS (the honest, non-garbage outcome REVIEW's repro should have reached)", () => {
  const taskText = "task_id: HYK-160-coder-5";
  const ledger = {
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [{ tool: "WebSearch", at: "2026-07-18 10:30 KST" }];
  const result = checkResearchReceipt({ taskText, ledger, log });
  assert.equal(result.status, "PASS", result.reason);
});

test("(36) known-bad: valid ledger timestamp but a NON-qualifying receipt entry (wrong tool) with a malformed 'at' is correctly ignored -- malformed-format checking only applies to WebSearch/WebFetch candidates", () => {
  const taskText = "task_id: HYK-160-coder-5";
  const ledger = {
    issues: {
      "HYK-160": {
        streak: 2,
        history: [{ verdict: "rejected", at: "2026-07-18 10:00 KST" }],
      },
    },
  };
  const log = [{ tool: "Read", at: "zzz" }];
  const result = checkResearchReceipt({ taskText, ledger, log });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /^RESEARCH_RECEIPT_REQUIRED/);
});

test("(37) mutation-style direct check: TIMESTAMP_RE's shape is actually enforced -- a subtly wrong format (missing leading zero, extra field) is also rejected, not just wildly-off garbage", () => {
  assert.equal(isValidTimestamp("2026-7-18 10:00 KST"), false); // missing zero-pad on month
  assert.equal(isValidTimestamp("2026-07-18 10:00 KST extra"), false); // trailing junk
});
