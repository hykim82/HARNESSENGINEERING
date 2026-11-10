// HYK-153 engine-split-1 (coder-task.md §2 (a)) -- tests for the read-only
// engine-split-rounds aggregation CLI. Boundary coverage (strict vs loose,
// threshold exit 1, mixed exit 1, multi-review-per-author, unpaired review
// labels) runs against a synthetic fixture ledger/registry under
// scripts/check/fixtures/engine-split-rounds/. The CLI itself is invoked
// as a real child process (production entrypoint), not re-implemented or
// copy-imported, for the end-to-end assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  classifyPair,
  joinRounds,
  summarize,
  parseLedgerText,
  parseRegistryJsonl,
  deriveTranscriptFolderName,
  crossCheckSessions,
  runCli,
} from "./engine-split-rounds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "engine-split-rounds.mjs");
const FIXTURE_DIR = path.join(HERE, "fixtures", "engine-split-rounds");
const FIXTURE_LEDGER = path.join(FIXTURE_DIR, "ledger.json");
const FIXTURE_REGISTRY = path.join(FIXTURE_DIR, "registry.jsonl");

function loadFixture() {
  const ledgerText = fs.readFileSync(FIXTURE_LEDGER, "utf8");
  const registryText = fs.readFileSync(FIXTURE_REGISTRY, "utf8");
  const ledgerParsed = parseLedgerText(ledgerText);
  assert.ok(ledgerParsed.ok, ledgerParsed.reason);
  const { byPaneKey, skippedLines } = parseRegistryJsonl(registryText);
  return { reservations: ledgerParsed.reservations, byPaneKey, skippedLines };
}

// ---- unit coverage: classification boundaries ----

test("classifyPair: strict requires sonnet author + opus review + both COMPLETED + no completion_reason", () => {
  const byPaneKey = new Map([
    ["a", { model: "claude-sonnet-5" }],
    ["r", { model: "claude-opus-5-5" }],
  ]);
  const author = { status: "COMPLETED", seat_key: "a" };
  const review = { status: "COMPLETED", seat_key: "r" };
  const row = classifyPair("X-review-1", review, "X", author, byPaneKey);
  assert.equal(row.strict, true);
  assert.equal(row.loose, true);
});

test("classifyPair: a completion_reason on either side drops strict but keeps loose", () => {
  const byPaneKey = new Map([
    ["a", { model: "claude-sonnet-5" }],
    ["r", { model: "claude-opus-5-5" }],
  ]);
  const author = {
    status: "COMPLETED",
    seat_key: "a",
    completion_reason: "RETIREMENT_RELEASED",
  };
  const review = { status: "COMPLETED", seat_key: "r" };
  const row = classifyPair("X-review-1", review, "X", author, byPaneKey);
  assert.equal(row.strict, false);
  assert.equal(row.loose, true);
});

test("classifyPair: family mismatch (author not sonnet, or review not opus) drops both", () => {
  const byPaneKey = new Map([
    ["a", { model: "claude-opus-5" }],
    ["r", { model: "claude-opus-5-5" }],
  ]);
  const author = { status: "COMPLETED", seat_key: "a" };
  const review = { status: "COMPLETED", seat_key: "r" };
  const row = classifyPair("X-review-1", review, "X", author, byPaneKey);
  assert.equal(row.strict, false);
  assert.equal(row.loose, false);
});

test("classifyPair: either side not COMPLETED drops both", () => {
  const byPaneKey = new Map([
    ["a", { model: "claude-sonnet-5" }],
    ["r", { model: "claude-opus-5-5" }],
  ]);
  const author = { status: "ACTIVE", seat_key: "a" };
  const review = { status: "COMPLETED", seat_key: "r" };
  const row = classifyPair("X-review-1", review, "X", author, byPaneKey);
  assert.equal(row.strict, false);
  assert.equal(row.loose, false);
});

test("classifyPair: a seat_key with no registry record yields a null model, not a crash", () => {
  const byPaneKey = new Map();
  const author = { status: "COMPLETED", seat_key: "unknown-pane" };
  const review = { status: "COMPLETED", seat_key: "also-unknown" };
  const row = classifyPair("X-review-1", review, "X", author, byPaneKey);
  assert.equal(row.authorModel, null);
  assert.equal(row.reviewModel, null);
  assert.equal(row.strict, false);
});

test("classifyPair: returns null when there is no author reservation to pair with", () => {
  const review = { status: "COMPLETED", seat_key: "r" };
  const row = classifyPair("X-review-1", review, "X", undefined, new Map());
  assert.equal(row, null);
});

test("joinRounds: an unpaired review label (no matching author key) is skipped entirely", () => {
  const reservations = {
    "X-review-1": { status: "COMPLETED", role: "REVIEW", seat_key: "r" },
  };
  const rows = joinRounds(reservations, new Map());
  assert.deepEqual(rows, []);
});

test("joinRounds: a plain (non-review-labeled) reservation is not itself joined", () => {
  const reservations = {
    "X-1": { status: "COMPLETED", role: "CODER", seat_key: "a" },
  };
  const rows = joinRounds(reservations, new Map());
  assert.deepEqual(rows, []);
});

// ---- unit coverage: tally/summarize (top-issue exclusion, distinct authors) ----

test("summarize: distinct author rounds, distinct issues, and top-issue exclusion", () => {
  const rows = [
    {
      reviewLabel: "HYK-1-a-review-1",
      authorLabel: "HYK-1-a",
      issue: "HYK-1",
      strict: true,
      loose: true,
      authorModel: "claude-sonnet-5",
      reviewModel: "claude-opus-5-5",
    },
    {
      reviewLabel: "HYK-1-a-review-2",
      authorLabel: "HYK-1-a",
      issue: "HYK-1",
      strict: true,
      loose: true,
      authorModel: "claude-sonnet-5",
      reviewModel: "claude-opus-5-5",
    },
    {
      reviewLabel: "HYK-1-a-review-3",
      authorLabel: "HYK-1-a",
      issue: "HYK-1",
      strict: true,
      loose: true,
      authorModel: "claude-sonnet-5",
      reviewModel: "claude-opus-5-5",
    },
    {
      reviewLabel: "HYK-6-b-review-1",
      authorLabel: "HYK-6-b",
      issue: "HYK-6",
      strict: true,
      loose: true,
      authorModel: "claude-sonnet-5",
      reviewModel: "claude-opus-5-5",
    },
  ];
  const summary = summarize(rows);
  assert.equal(summary.strict.n, 4);
  assert.equal(summary.strict.distinctAuthorRounds, 2);
  assert.equal(summary.strict.distinctIssues, 2);
  assert.equal(summary.strict.topIssue, "HYK-1");
  assert.equal(summary.strict.topIssueCount, 3);
  assert.equal(summary.strict.nExcludingTopIssue, 1);
});

// ---- parseRegistryJsonl: malformed-line fail-soft ----

test("parseRegistryJsonl: malformed JSON lines and empty-paneKey lines are skipped, not thrown", () => {
  const { skippedLines } = loadFixture();
  // line 8 = "this-line-is-not-json", line 9 = valid JSON but paneKey:"".
  assert.deepEqual(skippedLines, [8, 9]);
});

// ---- end-to-end: full fixture through joinRounds/summarize matches by hand ----

test("fixture: strict/loose counts match hand-computed values", () => {
  const { reservations, byPaneKey } = loadFixture();
  const rows = joinRounds(reservations, byPaneKey);
  const summary = summarize(rows);

  assert.equal(summary.strict.n, 4, "HYK-1 x3 + HYK-6 x1");
  assert.equal(summary.strict.distinctAuthorRounds, 2);
  assert.equal(summary.strict.distinctIssues, 2);
  assert.equal(summary.strict.nExcludingTopIssue, 1);

  assert.equal(summary.loose.n, 5, "strict 4 + HYK-2 (completion_reason set)");
  assert.equal(summary.loose.distinctAuthorRounds, 3);
  assert.equal(summary.loose.distinctIssues, 3);

  // HYK-3 (family mismatch) and HYK-4 (author not COMPLETED) contribute to
  // neither bucket; HYK-5 (unpaired review label) never became a row.
  assert.ok(!rows.some((r) => r.authorLabel === "HYK-5-demo-5"));
  const hyk3 = rows.find((r) => r.authorLabel === "HYK-3-demo-3");
  assert.equal(hyk3.strict, false);
  assert.equal(hyk3.loose, false);
  const hyk4 = rows.find((r) => r.authorLabel === "HYK-4-demo-4");
  assert.equal(hyk4.strict, false);
  assert.equal(hyk4.loose, false);
});

// ---- end-to-end: real CLI process (production entrypoint, not a copy) ----

test("CLI: --json against the fixture reports the hand-computed numbers and exits 0 when thresholds fit", () => {
  const out = execFileSync(
    process.execPath,
    [
      CLI_PATH,
      "--ledger",
      FIXTURE_LEDGER,
      "--registry",
      FIXTURE_REGISTRY,
      "--json",
      "--min-strict",
      "4",
      "--min-strict-excl-top",
      "1",
      "--min-authors",
      "2",
      "--min-issues",
      "2",
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(out);
  assert.equal(result.strict.n, 4);
  assert.equal(result.loose.n, 5);
  assert.equal(result.ok, true);
});

test("CLI: default thresholds are too high for the tiny fixture -- exit 1", () => {
  assert.throws(() => {
    execFileSync(
      process.execPath,
      [
        CLI_PATH,
        "--ledger",
        FIXTURE_LEDGER,
        "--registry",
        FIXTURE_REGISTRY,
        "--json",
      ],
      {
        encoding: "utf8",
      },
    );
  });
});

test("CLI: missing required --ledger/--registry exits 1 with a usage message", () => {
  let threw = false;
  try {
    execFileSync(process.execPath, [CLI_PATH], { encoding: "utf8" });
  } catch (err) {
    threw = true;
    assert.ok(String(err.stdout).includes("--ledger"));
  }
  assert.ok(threw);
});

test("CLI: non-JSON mode prints a human-readable STRICT/LOOSE summary", () => {
  const out = execFileSync(
    process.execPath,
    [
      CLI_PATH,
      "--ledger",
      FIXTURE_LEDGER,
      "--registry",
      FIXTURE_REGISTRY,
      "--min-strict",
      "4",
      "--min-strict-excl-top",
      "1",
      "--min-authors",
      "2",
      "--min-issues",
      "2",
    ],
    { encoding: "utf8" },
  );
  assert.match(out, /STRICT review-rounds=4/);
  assert.match(out, /LOOSE {2}review-rounds=5/);
});

// ---- runCli: mixed-family session cross-check forces exit 1 ----

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-split-rounds-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("crossCheckSessions: a transcript model that contradicts the registry-derived family is reported as mixed", () => {
  withTempDir((transcriptsRoot) => {
    const authorFolder = deriveTranscriptFolderName(
      "C:/fake/worktrees/hyk1-demo",
    );
    const reviewFolder = deriveTranscriptFolderName(
      "C:/fake/worktrees/hyk1-demo-review",
    );
    fs.mkdirSync(path.join(transcriptsRoot, authorFolder), { recursive: true });
    fs.mkdirSync(path.join(transcriptsRoot, reviewFolder), { recursive: true });
    fs.writeFileSync(
      path.join(transcriptsRoot, authorFolder, "session1.jsonl"),
      `${JSON.stringify({ model: "claude-sonnet-5" })}\n`,
    );
    // Review-side transcript actually shows a sonnet session -- contradicts
    // the opus family the registry/ledger join expected.
    fs.writeFileSync(
      path.join(transcriptsRoot, reviewFolder, "session1.jsonl"),
      `${JSON.stringify({ model: "claude-sonnet-5" })}\n`,
    );

    const byPaneKey = new Map([
      ["pane-author-1", { worktree: "C:/fake/worktrees/hyk1-demo" }],
      ["pane-review-1", { worktree: "C:/fake/worktrees/hyk1-demo-review" }],
    ]);
    const rows = [
      {
        reviewLabel: "HYK-1-demo-1-review-1",
        authorSeatKey: "pane-author-1",
        reviewSeatKey: "pane-review-1",
        strict: true,
      },
    ];
    const result = crossCheckSessions(rows, byPaneKey, transcriptsRoot, fs);
    assert.equal(result.checked, 1);
    assert.equal(result.mixed, 1);
    assert.equal(result.confirmed, 0);
  });
});

test("crossCheckSessions: matching transcript models confirm the pair and are not mixed", () => {
  withTempDir((transcriptsRoot) => {
    const authorFolder = deriveTranscriptFolderName(
      "C:/fake/worktrees/hyk1-demo",
    );
    const reviewFolder = deriveTranscriptFolderName(
      "C:/fake/worktrees/hyk1-demo-review",
    );
    fs.mkdirSync(path.join(transcriptsRoot, authorFolder), { recursive: true });
    fs.mkdirSync(path.join(transcriptsRoot, reviewFolder), { recursive: true });
    fs.writeFileSync(
      path.join(transcriptsRoot, authorFolder, "session1.jsonl"),
      `${JSON.stringify({ model: "claude-sonnet-5" })}\n`,
    );
    fs.writeFileSync(
      path.join(transcriptsRoot, reviewFolder, "session1.jsonl"),
      `${JSON.stringify({ model: "claude-opus-5-5" })}\n`,
    );

    const byPaneKey = new Map([
      ["pane-author-1", { worktree: "C:/fake/worktrees/hyk1-demo" }],
      ["pane-review-1", { worktree: "C:/fake/worktrees/hyk1-demo-review" }],
    ]);
    const rows = [
      {
        reviewLabel: "HYK-1-demo-1-review-1",
        authorSeatKey: "pane-author-1",
        reviewSeatKey: "pane-review-1",
        strict: true,
      },
    ];
    const result = crossCheckSessions(rows, byPaneKey, transcriptsRoot, fs);
    assert.equal(result.checked, 1);
    assert.equal(result.confirmed, 1);
    assert.equal(result.mixed, 0);
  });
});

test("runCli: --transcripts with a mixed pair exits 1 even if the count thresholds are met", () => {
  withTempDir((transcriptsRoot) => {
    const authorFolder = deriveTranscriptFolderName(
      "C:/fake/worktrees/hyk1-demo",
    );
    const reviewFolder = deriveTranscriptFolderName(
      "C:/fake/worktrees/hyk1-demo-review",
    );
    fs.mkdirSync(path.join(transcriptsRoot, authorFolder), { recursive: true });
    fs.mkdirSync(path.join(transcriptsRoot, reviewFolder), { recursive: true });
    fs.writeFileSync(
      path.join(transcriptsRoot, authorFolder, "s.jsonl"),
      `${JSON.stringify({ model: "claude-sonnet-5" })}\n`,
    );
    fs.writeFileSync(
      path.join(transcriptsRoot, reviewFolder, "s.jsonl"),
      `${JSON.stringify({ model: "claude-sonnet-5" })}\n`,
    );

    const { rc, output } = runCli(
      [
        "--ledger",
        FIXTURE_LEDGER,
        "--registry",
        FIXTURE_REGISTRY,
        "--transcripts",
        transcriptsRoot,
        "--json",
        "--min-strict",
        "4",
        "--min-strict-excl-top",
        "1",
        "--min-authors",
        "2",
        "--min-issues",
        "2",
        "--min-confirmed",
        "1",
      ],
      fs,
    );
    const result = JSON.parse(output);
    assert.equal(rc, 1);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes("mixed-family")));
  });
});
