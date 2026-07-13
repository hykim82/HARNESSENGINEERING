import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { checkSelfcheckFreshness, DEFAULT_FRESHNESS_MAX_AGE_MS } from "./selfcheck-freshness.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./selfcheck-freshness.mjs", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "selfcheck-freshness-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(1) checkSelfcheckFreshness: report absent -> fresh:false, names the cause", () => {
  withFixtureDir((dir) => {
    const result = checkSelfcheckFreshness({ reportPath: join(dir, "does-not-exist.md") });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /never been run/);
  });
});

test("(2) checkSelfcheckFreshness: report present, captured_at within 8 days -> fresh:true", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const now = Date.parse("2026-07-13T15:00:00Z");
    writeFileSync(reportPath, `captured_at: ${new Date(now - 3600000).toISOString()}\n`, "utf8");
    const result = checkSelfcheckFreshness({ reportPath, now });
    assert.equal(result.fresh, true);
  });
});

test("(3) checkSelfcheckFreshness: captured_at older than 8 days -> fresh:false", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const now = Date.parse("2026-07-13T15:00:00Z");
    const old = new Date(now - (DEFAULT_FRESHNESS_MAX_AGE_MS + 3600000)).toISOString();
    writeFileSync(reportPath, `captured_at: ${old}\n`, "utf8");
    const result = checkSelfcheckFreshness({ reportPath, now });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /re-run node scripts\/check\/selfcheck\.mjs/);
  });
});

test("(4) checkSelfcheckFreshness: captured_at exactly at the boundary (not over) -> fresh:true, not a false positive", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const now = Date.parse("2026-07-13T15:00:00Z");
    const boundary = new Date(now - DEFAULT_FRESHNESS_MAX_AGE_MS).toISOString();
    writeFileSync(reportPath, `captured_at: ${boundary}\n`, "utf8");
    const result = checkSelfcheckFreshness({ reportPath, now });
    assert.equal(result.fresh, true);
  });
});

// --- review-5 rejected fix: a future captured_at must never read as fresh
// (it would suppress the 8-day warning indefinitely) ---

test("(4b) checkSelfcheckFreshness: captured_at 1 day in the future -> fresh:false, 'in the future' reason (review-5 repro)", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const now = Date.parse("2026-07-13T15:00:00Z");
    const future = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(reportPath, `captured_at: ${future}\n`, "utf8");
    const result = checkSelfcheckFreshness({ reportPath, now });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /in the future/);
  });
});

test("(4c) checkSelfcheckFreshness: captured_at 1 minute in the future -> fresh:false (review-5 repro, tighter boundary)", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const now = Date.parse("2026-07-13T15:00:00Z");
    const future = new Date(now + 60000).toISOString();
    writeFileSync(reportPath, `captured_at: ${future}\n`, "utf8");
    const result = checkSelfcheckFreshness({ reportPath, now });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /in the future/);
  });
});

test("(4d) checkSelfcheckFreshness: captured_at exactly equal to now -> fresh:true (age 0, not 'future')", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const now = Date.parse("2026-07-13T15:00:00Z");
    writeFileSync(reportPath, `captured_at: ${new Date(now).toISOString()}\n`, "utf8");
    const result = checkSelfcheckFreshness({ reportPath, now });
    assert.equal(result.fresh, true);
  });
});

test("(5) checkSelfcheckFreshness: missing captured_at field -> fresh:false, malformed report reason", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    writeFileSync(reportPath, "# no captured_at here\n", "utf8");
    const result = checkSelfcheckFreshness({ reportPath });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /no captured_at field/);
  });
});

test("(6) checkSelfcheckFreshness: unparseable captured_at value -> fresh:false, never throws", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    writeFileSync(reportPath, "captured_at: not-a-real-timestamp\n", "utf8");
    const result = checkSelfcheckFreshness({ reportPath });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /not a parseable timestamp/);
  });
});

test("(7) checkSelfcheckFreshness: read failure (readFileFn throws) -> fresh:false, never propagates the throw", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    writeFileSync(reportPath, "captured_at: 2026-07-13T00:00:00Z\n", "utf8");
    const result = checkSelfcheckFreshness({
      reportPath,
      readFileFn: () => {
        throw new Error("simulated read error");
      },
    });
    assert.equal(result.fresh, false);
    assert.match(result.reason, /simulated read error/);
  });
});

// --- CLI: advisory only, exit 0 always (never blocks SessionStart) ---

test("(8) CLI: missing report -> exit 0, SessionStart additionalContext warning", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "does-not-exist.md");
    const stdout = execFileSync("node", [SCRIPT_PATH, "--report", reportPath], { encoding: "utf8" });
    assert.match(stdout, /hookSpecificOutput/);
    assert.match(stdout, /never been run/);
  });
});

test("(9) CLI: fresh report -> exit 0, plain ok line (no SessionStart block/context payload)", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    writeFileSync(reportPath, `captured_at: ${new Date().toISOString()}\n`, "utf8");
    const stdout = execFileSync("node", [SCRIPT_PATH, "--report", reportPath], { encoding: "utf8" });
    assert.match(stdout, /selfcheck-freshness: selfcheck fresh/);
    assert.doesNotMatch(stdout, /hookSpecificOutput/);
  });
});

test("(10) CLI: stale report -> exit 0 (advisory, never blocks SessionStart)", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const old = new Date(Date.now() - (DEFAULT_FRESHNESS_MAX_AGE_MS + 3600000)).toISOString();
    writeFileSync(reportPath, `captured_at: ${old}\n`, "utf8");
    // execFileSync throws on non-zero exit -- this must NOT throw.
    const stdout = execFileSync("node", [SCRIPT_PATH, "--report", reportPath], { encoding: "utf8" });
    assert.match(stdout, /hookSpecificOutput/);
  });
});

test("(11) CLI: future captured_at (1 day ahead) -> exit 0, additionalContext warning naming it suspect (review-5 repro)", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "selfcheck-report.md");
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(reportPath, `captured_at: ${future}\n`, "utf8");
    const stdout = execFileSync("node", [SCRIPT_PATH, "--report", reportPath], { encoding: "utf8" });
    assert.match(stdout, /hookSpecificOutput/);
    assert.match(stdout, /in the future/);
  });
});
