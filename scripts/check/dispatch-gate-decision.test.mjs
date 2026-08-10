import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
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

test("(반례8) 4R §2 검토 실측 -- 원장 항목의 streak: 1.5(소수) -> REJECT_LEDGER_ENTRY_MALFORMED, gates never spawned", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9023-fractional-1\nbody\n", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        schema_version: 1,
        issues: { "HYK-9023": { streak: 1.5, history: [] } },
      }),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /해석 가능한 형태가 아님/);
    assert.match(r.stderr, /정수/);
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

// HYK-220 2R: rewritten for the git-common-dir-based default resolution
// (1R/2R §2 근거 B fix) -- the CWD-independence guarantee this test asserts
// is now provided by git identity, not by "resolve next to the task file"
// string logic, so both `dir` and the decoy `elsewhereDir` must themselves
// be real git repos (`resolveRepoRoot` needs an actual repo to identify;
// a plain non-git tmpdir now fail-closes with REJECT_LEDGER_PATH_UNRESOLVABLE
// instead of silently degrading to dirname-based lookup -- see test (17)).
test("(15) 2R: no --ledger given, invoking CWD is a DIFFERENT (also real) git repo than the task file's repo -- ledger still resolves from the task file's OWN repo, not from CWD's repo", () => {
  withFixtureDir((dir) => {
    execFileSync("git", ["init", "-q", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    const harnessDir = join(dir, ".harness");
    mkdirSync(harnessDir);
    const taskPath = join(harnessDir, "coder-task.md");
    const envelope = [
      "<!-- reject-streak-envelope",
      "원인 분류: 모델 한계",
      "ORCH 조치:",
      "- 모델 변경: sonnet -> opus 승격",
      "-->",
    ].join("\n");
    writeFileSync(taskPath, `task_id: HYK-9012-cwd-1\n${envelope}\n`, "utf8");
    // The task file's OWN repo ledger says streak=2 WITH an envelope
    // present -> should ALLOW. A DIFFERENT ledger, in a DIFFERENT real git
    // repo (the invoking CWD), says streak=4 (hard-stop, needs a
    // DIAGNOSTIC envelope this task file doesn't carry) -- if the CLI ever
    // resolves the ledger from CWD's repo instead of the task file's own
    // repo, this decoy would be consulted instead and the run would REJECT
    // (diagnostic-gate BLOCK) instead of ALLOW.
    writeLedger(join(harnessDir, "reject-streak.json"), {
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
      execFileSync("git", ["init", "-q", elsewhereDir]);
      execFileSync("git", [
        "-C",
        elsewhereDir,
        "config",
        "user.email",
        "t@t.com",
      ]);
      execFileSync("git", ["-C", elsewhereDir, "config", "user.name", "t"]);
      const elsewhereHarness = join(elsewhereDir, ".harness");
      mkdirSync(elsewhereHarness);
      writeLedger(join(elsewhereHarness, "reject-streak.json"), {
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
      // no --ledger flag at all; cwd is elsewhereDir's repo, a DIFFERENT
      // repo than taskPath's own
      const r = runCli([taskPath], { cwd: elsewhereDir });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /ALLOW/);
    } finally {
      rmSync(elsewhereDir, { recursive: true, force: true });
    }
  });
});

test("(16) 4R §3 TOCTOU -- ledger mutated to streak=0 in the window between the precondition read and gate execution -> still REJECTs (snapshot isolates the gates from the live file)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9600-toctou-1\nno envelope here\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9600": {
          streak: 2,
          history: [
            { task_id: "HYK-9600-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9600-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    // Mirrors the reviewer's own NODE_OPTIONS technique: a --require hook
    // fires at the start of EVERY node process this run launches (this
    // CLI's own process = invocation #1, then the gate/diagnostic-gate
    // subprocesses = #2/#3). Invocation #1 is left alone (the CLI must be
    // allowed to read the real streak=2 ledger first); from invocation #2
    // onward the hook rewrites the LIVE ledger file (never whatever
    // snapshot path the CLI decided to pass down) to streak=0 BEFORE that
    // process's own code runs -- simulating an external actor changing the
    // ledger in the exact window between confirmation and gate execution.
    const counterPath = join(dir, "toctou-counter.txt");
    const mutatorPath = join(dir, "toctou-mutator.cjs");
    writeFileSync(
      mutatorPath,
      [
        "const fs = require('fs');",
        `const counterPath = ${JSON.stringify(counterPath)};`,
        `const liveLedgerPath = ${JSON.stringify(ledgerPath)};`,
        "let count = 0;",
        "try { count = Number(fs.readFileSync(counterPath, 'utf8')); } catch {}",
        "count += 1;",
        "fs.writeFileSync(counterPath, String(count), 'utf8');",
        "if (count >= 2) {",
        "  const ledger = JSON.parse(fs.readFileSync(liveLedgerPath, 'utf8'));",
        "  ledger.issues['HYK-9600'] = { streak: 0, history: [] };",
        "  fs.writeFileSync(liveLedgerPath, JSON.stringify(ledger, null, 2), 'utf8');",
        "}",
      ].join("\n"),
      "utf8",
    );
    const r = runCli([taskPath, "--ledger", ledgerPath], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require ${mutatorPath}`,
      },
    });
    assert.equal(
      r.status,
      1,
      "gate must still reject using the CONFIRMED streak=2, not the mid-flight-mutated streak=0",
    );
    assert.match(r.stderr, /BLOCK\(exit 2\)|streak=2/);
    // The live file WAS mutated (proves the attack scenario actually fired,
    // not that the mutator silently no-op'd).
    const liveLedgerAfter = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(liveLedgerAfter.issues["HYK-9600"].streak, 0);
  });
});

// N=7 normal-state samples total across this file (fresh/streak-1/streak-2-
// envelope/streak-3-envelope/streak-4-diagnostic-envelope/CRLF/no-ledger-
// arg-CWD-independence), each independently ALLOW -- 0/7 false positives.
// Reject-expected samples (streak-2-no-envelope, streak-4-no-diagnostic,
// task-id-missing, task-id-malformed, ledger-missing, ledger-corrupt,
// file-missing, no-argument = 8 total) are counted separately and never
// folded into the N=7 false-positive denominator (2R §4 지적2 요구).

// ---------------------------------------------------------------------------
// HYK-220 2R §2: the six mandatory scenarios the 1R review named by number.
// All six build REAL git repos/worktrees under tmpdir (never touch this
// repo's own .git) -- resolveLedgerPath's new default path is git-identity
// based, so a fixture that wants to exercise it honestly needs a real repo.
// ---------------------------------------------------------------------------

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
}

function commitAll(dir, message) {
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", message]);
}

test("(17) §2-1 정상 링크드 워크트리 -- 메인 정본 원장으로 수렴 (streak 0, fresh) -> ALLOW", () => {
  withFixtureDir((dir) => {
    const mainDir = join(dir, "main");
    mkdirSync(mainDir);
    initGitRepo(mainDir);
    mkdirSync(join(mainDir, ".harness"));
    writeFileSync(join(mainDir, "README.md"), "x\n", "utf8");
    writeLedger(join(mainDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    commitAll(mainDir, "init");
    const wtDir = join(dir, "wt1");
    execFileSync("git", [
      "-C",
      mainDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    // wtDir already checked out .harness/ from HEAD (git worktree add
    // materializes the working tree) -- no mkdir needed.
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9100-fresh-1\nbody\n", "utf8");
    // wt1 has NO local reject-streak.json at all -- must still ALLOW by
    // converging on main's ledger.
    const r = runCli([taskPath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(18) §2-2 ★핵심★ 로컬 원장 streak 리셋 우회가 닫힘 -- 링크드 워크트리에 streak=0 빈 원장을 심어도 정본 streak=2(봉투 없음)를 읽어 REJECT", () => {
  withFixtureDir((dir) => {
    const mainDir = join(dir, "main");
    mkdirSync(mainDir);
    initGitRepo(mainDir);
    mkdirSync(join(mainDir, ".harness"));
    writeFileSync(join(mainDir, "README.md"), "x\n", "utf8");
    writeLedger(join(mainDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9101": {
          streak: 2,
          history: [
            { task_id: "HYK-9101-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9101-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    commitAll(mainDir, "init");
    const wtDir = join(dir, "wt-bypass-attempt");
    execFileSync("git", [
      "-C",
      mainDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    // wtDir already checked out .harness/ (with main's real streak=2
    // ledger) from HEAD -- the writeLedger call below deliberately
    // OVERWRITES that checked-out copy with a local streak-reset decoy.
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    // NO envelope -- if the local, freshly-created ledger below were
    // honored, streak would read as 0 (no entry) and this would ALLOW.
    writeFileSync(taskPath, "task_id: HYK-9101-retry-1\nno envelope\n", "utf8");
    writeLedger(join(wtDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    const r = runCli([taskPath]);
    assert.equal(
      r.status,
      1,
      "must REJECT using main's real streak=2, not the local streak-0 decoy",
    );
    assert.match(r.stderr, /streak=2/);
    assert.match(r.stderr, /BLOCK\(exit 2\)/);
  });
});

test("(19) §2-3 비-git 경로 + 로컬 원장 -- 1R까지는 ALLOW였다(검토 실측), 2R 이후 REJECT(REJECT_LEDGER_PATH_UNRESOLVABLE)", () => {
  withFixtureDir((dir) => {
    // deliberately NOT a git repo
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9102-nongit-1\nbody\n", "utf8");
    // a local ledger sitting right next to the task file, streak 0 -- 1R's
    // dirname(taskPath) default would have read this and ALLOWed.
    writeLedger(join(dir, "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    const r = runCli([taskPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(
      r.stderr,
      /REJECT_LEDGER_PATH_UNRESOLVABLE|저장소를 식별하지 못함/,
    );
    assert.doesNotMatch(
      r.stderr,
      /원장 파일이 존재하지 않음/,
      "must NOT collapse into the ordinary ledger-missing reason (P1-2)",
    );
  });
});

test("(20) §2-4 P1-1 다른 저장소 taskPath -- --expect-repo-root와 실제 소속 저장소가 다르면 REJECT(REJECT_REPO_MISMATCH)", () => {
  withFixtureDir((dir) => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    initGitRepo(repoA);
    initGitRepo(repoB);
    mkdirSync(join(repoA, ".harness"));
    mkdirSync(join(repoB, ".harness"));
    writeFileSync(join(repoA, "a.txt"), "x\n", "utf8");
    writeFileSync(join(repoB, "b.txt"), "x\n", "utf8");
    writeLedger(join(repoA, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {},
    });
    commitAll(repoA, "init");
    commitAll(repoB, "init");
    const taskPath = join(repoA, ".harness", "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9103-wrongrepo-1\nbody\n", "utf8");
    // taskPath truly belongs to repoA, but the caller says it expected repoB
    const r = runCli([taskPath, "--expect-repo-root", repoB]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REJECT_REPO_MISMATCH|기대 저장소.*다름/);
  });
});

test("(21) §2-6 P1-1 후단 -- 명시 --ledger 도 --expect-repo-root 대조를 통과 못 하면 REJECT (이전엔 --ledger가 대조 없이 그대로 우선했다)", () => {
  withFixtureDir((dir) => {
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    mkdirSync(repoA);
    mkdirSync(repoB);
    initGitRepo(repoA);
    initGitRepo(repoB);
    mkdirSync(join(repoA, ".harness"));
    writeFileSync(join(repoA, "a.txt"), "x\n", "utf8");
    writeFileSync(join(repoB, "b.txt"), "x\n", "utf8");
    commitAll(repoA, "init");
    commitAll(repoB, "init");
    const taskPath = join(repoA, ".harness", "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9104-explicitledger-1\nbody\n",
      "utf8",
    );
    // An explicit --ledger that would ALLOW if honored (empty issues, no
    // rejection history) -- but --expect-repo-root names repoB, which does
    // NOT match taskPath's real repo (repoA), so this must still REJECT.
    const explicitLedgerPath = join(dir, "attacker-controlled-ledger.json");
    writeLedger(explicitLedgerPath, { schema_version: 1, issues: {} });
    const r = runCli([
      taskPath,
      "--ledger",
      explicitLedgerPath,
      "--expect-repo-root",
      repoB,
    ]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /REJECT_REPO_MISMATCH|기대 저장소.*다름/);
  });
});

test("(22) §2-5 bare 경계 -- bare 저장소 기반 링크드 워크트리에서도 원장 경로가 bare 디렉터리 자신 밑으로 올바르게 수렴 (검토 실측: dirname()이 한 단계 더 올라가 틀렸었다)", () => {
  withFixtureDir((dir) => {
    const bareDir = join(dir, "repo.git");
    execFileSync("git", ["init", "-q", "--bare", bareDir]);
    const seedDir = join(dir, "seed");
    execFileSync("git", ["clone", "-q", bareDir, seedDir]);
    execFileSync("git", ["-C", seedDir, "config", "user.email", "t@t.com"]);
    execFileSync("git", ["-C", seedDir, "config", "user.name", "t"]);
    writeFileSync(join(seedDir, "a.txt"), "x\n", "utf8");
    commitAll(seedDir, "init");
    execFileSync("git", ["-C", seedDir, "push", "-q", "origin", "HEAD:master"]);
    const wtDir = join(dir, "wt-bare");
    execFileSync("git", [
      "-C",
      bareDir,
      "worktree",
      "add",
      "-q",
      "--detach",
      wtDir,
      "HEAD",
    ]);
    mkdirSync(join(wtDir, ".harness"));
    const taskPath = join(wtDir, ".harness", "coder-task.md");
    writeFileSync(taskPath, "task_id: HYK-9105-bare-1\nno envelope\n", "utf8");
    // ★the resolved root for a bare repo is the bare dir ITSELF (no nested
    // .git) -- if resolveLedgerPath still did plain dirname(--git-common-dir)
    // here, it would look one level too high (dir/, not dir/repo.git/) and
    // find no .harness at all there either -- so this ledger placement is
    // the assertion that the bare-aware root math actually took effect: a
    // streak=2/no-envelope entry placed at the CORRECT (bare-dir-rooted)
    // path must be found and must BLOCK. The bare repo dir has no working
    // tree of its own, so its .harness/ must be created explicitly.
    mkdirSync(join(bareDir, ".harness"));
    writeLedger(join(bareDir, ".harness", "reject-streak.json"), {
      schema_version: 1,
      issues: {
        "HYK-9105": {
          streak: 2,
          history: [
            { task_id: "HYK-9105-coder-1", verdict: "rejected", at: "a" },
            { task_id: "HYK-9105-coder-2", verdict: "rejected", at: "b" },
          ],
        },
      },
    });
    const r = runCli([taskPath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /streak=2/);
    assert.match(r.stderr, /BLOCK\(exit 2\)/);
  });
});
