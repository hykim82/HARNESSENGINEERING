import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-decision-test-"));
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
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// ---------------------------------------------------------------------------
// (1) normal state, no streak history -> ALLOW, exit 0 (no false positive)
// ---------------------------------------------------------------------------
test("(1) streak 0 (empty but present ledger), fresh task file -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9001-fresh-1\nsome body\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    // 2R §2: an empty-but-PRESENT ledger (no issue entries yet) is the
    // normal "no rejections yet" state and must ALLOW -- distinct from a
    // MISSING ledger file, which 2R's stricter precondition now rejects
    // (see the "ledger file absent" test below).
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(2) streak 1 (below envelope threshold) -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9002-streak1-1\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9002": {
          streak: 1,
          history: [
            { task_id: "HYK-9002-coder-1", verdict: "rejected", at: "x" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(3) streak 2 with a complete envelope -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9003-streak2-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9003": {
          streak: 2,
          history: [
            { task_id: "HYK-9003-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9003-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

// N=3 normal-state samples above (fresh/streak-1/streak-2-with-envelope),
// each independently ALLOW -- 0/3 false positives (coder-task §3-1).

// ---------------------------------------------------------------------------
// real incident reproduction: gate BLOCK -> CLI must reject, machine-enforced
// ---------------------------------------------------------------------------
test("(4) streak 2, NO envelope -> reject-streak gate BLOCKs -> CLI REJECT, exit 1", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9004-streak2-noenv-1\nno envelope here\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9004": {
          streak: 2,
          history: [
            { task_id: "HYK-9004-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9004-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT_BLOCKED|BLOCK\(exit 2\)/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(5) streak 4 (hard-stop), ordinary envelope but no diagnostic evidence pointer -> diagnostic-gate BLOCKs -> CLI REJECT", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9005-hardstop-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9005": {
          streak: 4,
          history: [
            { task_id: "HYK-9005-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9005-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9005-coder-3", verdict: "rejected", at: "c" },
            { task_id: "HYK-9005-coder-4", verdict: "rejected", at: "d" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /diagnostic-gate/);
    assert.match(r.stderr, /REJECT --/);
  });
});

// ---------------------------------------------------------------------------
// operational error -- exit 1 never folds to a silent ALLOW
// ---------------------------------------------------------------------------
test("(6) task file missing -> REJECT_OPERATIONAL_ERROR, exit 1, reason visible", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "does-not-exist.md");
    const r = runCli([taskPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /운영 오류/);
    assert.match(r.stderr, /task file not found/);
    assert.match(r.stderr, /REJECT --/);
  });
});

test("(7) no task-path argument at all -> usage error, exit 1 (not a silent allow)", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
});

// ---------------------------------------------------------------------------
// 1R/2R/3R §2 P1-B: fail-closed precondition check -- reject-streak.mjs
// itself treats these inputs as UNJUDGABLE/fail-open, or silently folds them
// (reviewer's live demonstrations across 1R/2R). The gates must NEVER even
// be spawned for these -- each must produce a DISTINCT reason string and
// none may be confused with REJECT_BLOCKED/REJECT_OPERATIONAL_ERROR.
// ---------------------------------------------------------------------------
test("(8) P1-B task_id header entirely absent -> REJECT_TASK_ID_NOT_UNIQUE, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "no task_id line here at all\nbody text\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task_id 줄이 정확히 1개가 아님\(실제 0개\)/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례6) 3R: task_id 줄이 2개(앞=기록없음/뒤=streak 2) -> REJECT_TASK_ID_NOT_UNIQUE, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // Exactly the reviewer's 2R-followup shape: two task_id lines, an
    // unresolvable one first and a resolvable one second -- reject-streak.mjs's
    // own non-global regex would use the FIRST match and silently ignore the
    // second line's real streak.
    writeFileSync(
      taskPath,
      "task_id: HYK-0000-nonexistent-1\ntask_id: HYK-9020-dup-1\nbody\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9020": {
          streak: 2,
          history: [
            { task_id: "HYK-9020-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9020-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /task_id 줄이 정확히 1개가 아님\(실제 2개\)/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례7) 3R: 원장 항목의 streak: null -> REJECT_LEDGER_ENTRY_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9021-nullstreak-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    // Written directly (not via writeLedger+applyOutcome, which would never
    // produce a null streak) -- simulates on-disk corruption of a
    // previously-valid entry.
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-9021": { streak: null, history: [] } },
      }),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /해석 가능한 형태가 아님/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(반례7-b) 3R: 원장 항목의 history가 배열이 아님 -> REJECT_LEDGER_ENTRY_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9022-badhistory-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: {
          "HYK-9022": { streak: 1, history: "not-an-array" },
        },
      }),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /해석 가능한 형태가 아님/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(9) P1-B ⓑ task_id present but not HYK-<digits> -> REJECT_TASK_ID_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: NOT-AN-ISSUE-ID\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /HYK-<digits>.*형식으로 해석되지 않음|형식으로 해석되지 않음/,
    );
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(10) P1-B ⓒ ledger file absent -> REJECT_LEDGER_MISSING, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9006-noledger-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "does-not-exist-reject-streak.json");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /원장 파일이 존재하지 않음/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("(11) P1-B ⓓ ledger present but corrupt (malformed JSON) -> REJECT_LEDGER_CORRUPT, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9007-corrupt-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(ledgerPath, "{ not valid json ][", "utf8");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /원장을 읽거나 파싱할 수 없음/);
    assert.doesNotMatch(r.stderr, /reject-streak gate:/);
    assert.doesNotMatch(r.stderr, /reject-streak diagnostic-gate:/);
  });
});

test("P1-B all six precondition-reject shapes produce MUTUALLY DISTINCT reason strings", () => {
  withFixtureDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const missingIdPath = join(dir, "a.md");
    writeFileSync(missingIdPath, "no id\n", "utf8");
    const dupIdPath = join(dir, "a2.md");
    writeFileSync(
      dupIdPath,
      "task_id: HYK-9030-a\ntask_id: HYK-9030-b\n",
      "utf8",
    );
    const malformedIdPath = join(dir, "b.md");
    writeFileSync(malformedIdPath, "task_id: NOT-HYK\n", "utf8");
    const okPath = join(dir, "c.md");
    writeFileSync(okPath, "task_id: HYK-9008-x-1\n", "utf8");
    const noLedgerPath = join(dir, "missing-ledger.json");
    const corruptLedgerPath = join(dir, "corrupt.json");
    writeFileSync(corruptLedgerPath, "not json", "utf8");
    const nullStreakOkPath = join(dir, "d.md");
    writeFileSync(nullStreakOkPath, "task_id: HYK-9031-x-1\n", "utf8");
    const nullStreakLedgerPath = join(dir, "nullstreak.json");
    writeFileSync(
      nullStreakLedgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-9031": { streak: null, history: [] } },
      }),
      "utf8",
    );

    const missing = runCli([missingIdPath, "--ledger", ledgerPath]).stderr;
    const dup = runCli([dupIdPath, "--ledger", ledgerPath]).stderr;
    const malformed = runCli([malformedIdPath, "--ledger", ledgerPath]).stderr;
    const noLedger = runCli([okPath, "--ledger", noLedgerPath]).stderr;
    const corrupt = runCli([okPath, "--ledger", corruptLedgerPath]).stderr;
    const badEntry = runCli([
      nullStreakOkPath,
      "--ledger",
      nullStreakLedgerPath,
    ]).stderr;
    // missing/dup share the SAME state (REJECT_TASK_ID_NOT_UNIQUE, "not
    // exactly one") but still produce DIFFERENT first-line text (count 0
    // vs count 2) -- verified separately below.
    assert.notEqual(
      missing.split("\n")[0],
      dup.split("\n")[0],
      "missing (count 0) and duplicate (count 2) task_id must not collapse to the same reason text",
    );
    const reasons = [missing, dup, malformed, noLedger, corrupt, badEntry];
    const uniqueFirstLines = new Set(reasons.map((r) => r.split("\n")[0]));
    assert.equal(
      uniqueFirstLines.size,
      6,
      "each of the six precondition-reject shapes must produce a distinguishable first reason line",
    );
  });
});

// ---------------------------------------------------------------------------
// 2R §4 지적2: expanded control samples the reviewer named by name --
// each is either a normal-ALLOW sample (counted toward N below) or a
// reject-expected sample (counted separately, never mixed into the
// false-positive denominator).
// ---------------------------------------------------------------------------
test("(12) normal: streak 3, complete general envelope -> ALLOW (below hard-stop, diagnostic not required)", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9009-streak3-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9009": {
          streak: 3,
          history: [
            { task_id: "HYK-9009-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9009-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9009-coder-3", verdict: "rejected", at: "c" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(13) normal: streak 4 (hard-stop), complete DIAGNOSTIC envelope (incl. 재현 증거 포인터) -> ALLOW", () => {
  withFixtureDir((dir) => {
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "재현 증거 포인터: review-3.md L12-L40 (동일 mutation 3회 재현)",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9010-hardstop-1\n${envelope}\n`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9010": {
          streak: 4,
          history: [
            { task_id: "HYK-9010-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9010-coder-2", verdict: "rejected", at: "b" },
            { task_id: "HYK-9010-coder-3", verdict: "rejected", at: "c" },
            { task_id: "HYK-9010-coder-4", verdict: "rejected", at: "d" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(14) normal: CRLF-terminated task file (fresh, streak 0) -> ALLOW (precondition regex tolerates CRLF)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9011-crlf-1\r\nbody line\r\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(15) 2R §3-1 실측 회귀: no --ledger given, invoking CWD is a DIFFERENT directory than the task file -- ledger still resolves next to the task file, not from CWD", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    writeFileSync(taskPath, `task_id: HYK-9012-cwd-1\n${envelope}\n`, "utf8");
    // The ledger sibling of the task file says streak=2 WITH an envelope
    // present -> should ALLOW. A DIFFERENT ledger (elsewhere, at the
    // invoking CWD) says streak=2 with NO envelope worth of history -- if
    // the CLI ever again resolves the ledger from CWD instead of from the
    // task file's own directory, this second ledger would be consulted
    // instead and the run would REJECT (BLOCK) instead of ALLOW.
    writeLedger(join(dir, "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9012": {
          streak: 2,
          history: [
            { task_id: "HYK-9012-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9012-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const elsewhereDir = mkdtempSync(join(tmpdir(), "elsewhere-cwd-"));
    try {
      // Same issue id, but THIS ledger has streak=4 (hard-stop tier, needs
      // a DIAGNOSTIC envelope with 재현 증거 포인터) -- the task file above
      // only carries an ordinary envelope, so if the CLI ever resolves the
      // ledger from CWD again, this is the ledger it would read and
      // diagnostic-gate would BLOCK (DIAGNOSTIC_FIELD_MISSING) instead of
      // the correct ALLOW, turning this assertion RED.
      writeLedger(join(elsewhereDir, "reject-streak.json"), {
        schema_version: 1,
        issues: {
          "HYK-9012": {
            streak: 4,
            history: [
              { task_id: "HYK-9012-wrong-1", verdict: "rejected", at: "a" },
              { task_id: "HYK-9012-wrong-2", verdict: "rejected", at: "b" },
              { task_id: "HYK-9012-wrong-3", verdict: "rejected", at: "c" },
              { task_id: "HYK-9012-wrong-4", verdict: "rejected", at: "d" },
            ],
          },
        },
      });
      // no --ledger flag at all; cwd is elsewhereDir, nowhere near taskPath
      const r = runCli([taskPath], { cwd: elsewhereDir });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /ALLOW/);
    } finally {
      rmSync(elsewhereDir, { recursive: true, force: true });
    }
  });
});

// N=7 normal-state samples total across this file (fresh/streak-1/streak-2-
// envelope/streak-3-envelope/streak-4-diagnostic-envelope/CRLF/no-ledger-
// arg-CWD-independence), each independently ALLOW -- 0/7 false positives.
// Reject-expected samples (streak-2-no-envelope, streak-4-no-diagnostic,
// task-id-missing, task-id-malformed, ledger-missing, ledger-corrupt,
// file-missing, no-argument = 8 total) are counted separately and never
// folded into the N=7 false-positive denominator (2R §4 지적2 요구).
