// NC-1 negative-control: review-gate (commit-msg hook).
//
// Every case here calls checkReviewGate({message, reviewPath}) directly with
// synthetic inputs -- no real .git/hooks/*, no real .harness/*.json, no real
// workspace file is ever touched (design doc layer 1: "don't turn the real
// defense off, inject around it"). reviewPath always points at an mkdtemp
// fixture directory that is removed in a finally block.
//
// Classification key: BLOCKED = attack was actually stopped (asserted here,
// and the mutation ledger shows RED with the defense removed). KNOWN GAP =
// gate is passed through and this is an already-documented, intentional
// limitation (still asserted here as current-behavior, so closing it turns
// this test RED and forces the docs to catch up). See
// docs/enforcement-known-gaps.md for the authoritative table.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { checkReviewGate } from "./review-gate.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
// Hotfix 2R (2026-07-30, ORCH requirement correction -- this was ORCH's own
// mistake, not a coder error): requiring `git diff HEAD --stat` to be
// EMPTY always fails while there is uncommitted, in-progress work on
// tracked files -- it doesn't test "this suite left the repo clean," it
// tests "there is nothing checked out that isn't committed yet," which is
// a different and much stronger claim. NC-1's original round happened to
// pass only because every changed file was untracked-new (empty diff
// against HEAD is a coincidence of that specific situation, not something
// this assertion actually verifies). What this suite can honestly promise
// is INVARIANCE: whatever diff existed before this suite ran still exists,
// byte-for-byte, after it ran. Captured here, compared in after() below.
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-review-gate-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Layer 1 attacks: pure injection through checkReviewGate's own args ---

test("NC-1 review-gate/attack: HYK-tagged message + reviewPath pointing at a nonexistent file -> BLOCKED", () => {
  withFixtureDir((dir) => {
    const result = checkReviewGate({
      message: "feat: sneak it in (HYK-9001)",
      reviewPath: join(dir, "does-not-exist.md"),
    });
    assert.equal(
      result.ok,
      false,
      "must block when the review file is simply absent",
    );
  });
});

test("NC-1 review-gate/attack: review file exists but has no 'verdict: approved' -> BLOCKED", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-9001\nrole: REVIEW-CODEX\nnotes: looks fine i guess\n",
      "utf8",
    );
    const result = checkReviewGate({
      message: "feat: x (HYK-9001)",
      reviewPath,
    });
    assert.equal(
      result.ok,
      false,
      "an unmarked review must not count as approval",
    );
  });
});

test("NC-1 review-gate/attack: 'verdict: approved' present but no 'role: REVIEW*' -> BLOCKED (self-certification)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-9001\nverdict: approved\nrole: CODER-CLAUDE\n",
      "utf8",
    );
    const result = checkReviewGate({
      message: "feat: x (HYK-9001)",
      reviewPath,
    });
    assert.equal(
      result.ok,
      false,
      "the CODER itself writing 'approved' must not pass",
    );
    assert.match(result.reason, /independent reviewer|self-certification/);
  });
});

test("NC-1 review-gate/attack: skip-review trailer with an empty reason -> BLOCKED", () => {
  withFixtureDir((dir) => {
    const result = checkReviewGate({
      message: "fix: emergency (HYK-9001)\n\nskip-review: \n",
      reviewPath: join(dir, "unused.md"),
    });
    assert.equal(
      result.ok,
      false,
      "empty skip-review reason must not buy a bypass",
    );
  });
});

test("NC-1 review-gate/attack: code-fenced skip-review text must not count as a real trailer -> BLOCKED (fence-strip lives)", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-0000\nverdict: approved\nrole: REVIEW-CODEX\n",
      "utf8",
    );
    const result = checkReviewGate({
      message:
        "docs: explain the gate (HYK-9001)\n\n```\nskip-review: example only, not real\n```\n",
      reviewPath,
    });
    assert.equal(
      result.ok,
      false,
      "a documentation example inside a fence must not skip review",
    );
  });
});

test("NC-1 review-gate/attack: abbreviated enumeration 'HYK-98, 99' in subject -> BLOCKED", () => {
  withFixtureDir((dir) => {
    const result = checkReviewGate({
      message: "fix(init): batch (HYK-98, 99)",
      reviewPath: join(dir, "unused.md"),
    });
    assert.equal(
      result.ok,
      false,
      "abbreviated enumeration must be rejected regardless of review state",
    );
    assert.match(result.reason, /abbreviated issue list/);
  });
});

test("NC-1 review-gate/defect: message is null -> checkReviewGate throws instead of returning {ok:false} -> NEW DEFECT (exception leak)", () => {
  withFixtureDir((dir) => {
    // §3-1 of the task spec requires "message is null/object/empty string ->
    // zero exception leakage." Measured here: null and a plain object both
    // throw an uncaught TypeError from `message.split(...)` before any
    // ok/reason shape is produced. This was not previously documented
    // anywhere in this repo (review-gate.mjs, its existing test file, and
    // the design doc's known-issue list are all silent on it), so per §5 of
    // the task spec's classification rule ("no prior record -> NEW DEFECT")
    // this is registered as a NEW DEFECT in docs/enforcement-known-gaps.md,
    // not fixed here (out of scope for this track).
    assert.throws(
      () =>
        checkReviewGate({ message: null, reviewPath: join(dir, "unused.md") }),
      /Cannot read properties of null/,
    );
    assert.throws(
      () =>
        checkReviewGate({ message: {}, reviewPath: join(dir, "unused.md") }),
      /message\.split is not a function/,
    );
  });
});

test("NC-1 review-gate/attack: message is an empty string -> treated as 'no HYK tag' -> passes (not issue work)", () => {
  withFixtureDir((dir) => {
    const result = checkReviewGate({
      message: "",
      reviewPath: join(dir, "unused.md"),
    });
    assert.equal(
      result.ok,
      true,
      "empty message has no HYK tag, so it is legitimately non-issue-work",
    );
  });
});

// --- KNOWN GAP candidates called out explicitly by the task spec ---

test("NC-1 review-gate/gap: skip-review trailer with ANY non-empty reason always passes -- no reviewer, no ticket, nothing is verified beyond string length -> KNOWN GAP", () => {
  withFixtureDir((dir) => {
    const result = checkReviewGate({
      message: "fix: x (HYK-9001)\n\nskip-review: because I said so\n",
      reviewPath: join(dir, "unused.md"),
    });
    assert.equal(
      result.ok,
      true,
      "current behavior: any non-empty reason string is accepted verbatim",
    );
    // This is registered in docs/enforcement-known-gaps.md as a KNOWN GAP:
    // the gate is an audit trail (the reason gets recorded in git history),
    // not a substantive check. Anyone who can author a commit message can
    // self-authorize a skip.
  });
});

test("NC-1 review-gate/gap: dropping the HYK tag from the commit message entirely bypasses the gate -- BLOCKED becomes a no-op if you just don't tag -> KNOWN GAP", () => {
  withFixtureDir((dir) => {
    const result = checkReviewGate({
      message:
        "feat: add a whole new subsystem, definitely not issue work, nope",
      reviewPath: join(dir, "unused.md"),
    });
    assert.equal(
      result.ok,
      true,
      "current behavior: the gate keys entirely off subject-line HYK-<id> tags; untagged commits are invisible to it",
    );
    // Confirmed by direct inspection of review-gate.mjs: `checkReviewGate`
    // treats "no tag matches" as "not issue work" -> {ok:true}. This is a
    // real bypass path (any commit can dodge review by simply not writing a
    // HYK-<id> tag), registered as a KNOWN GAP rather than a NEW DEFECT
    // because §7 of the design doc (`role-guard` matcher-scope precedent)
    // already treats "gate keys off a self-reported marker" as an accepted
    // family of gap in this repo, and repo docs (review-gate.mjs comments)
    // describe this as intentional scoping to "issue work" -- but it is a
    // real, exploitable bypass and is reported as such below.
  });
});

// --- Layer 2 (copy-and-mutate) mutations: at least 3, per §2 of the task ---
// review-gate.mjs's checkable defenses are all reachable through {message,
// reviewPath} injection (per §2 non-negotiable #2), so no source copy was
// needed to *test* the gate. The mutation ledger below removes defenses by
// making a MODIFIED COPY of review-gate.mjs in a mkdtemp dir and importing
// that copy -- the real scripts/check/review-gate.mjs is never opened for
// writing.
const REVIEW_GATE_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/review-gate.mjs"],
  {
    cwd: ROOT,
    encoding: "utf8",
  },
);

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-review-gate-mutant-"));
  const mutated = mutate(REVIEW_GATE_SRC);
  const filePath = join(dir, "review-gate.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    const mod = await import(`file://${filePath.replace(/\\/g, "/")}`);
    return mod;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NC-1 mutation/review-gate #1: removing the 'verdict: approved' check -> RED (approval requirement is load-bearing)", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      /const hasApproved = \/verdict:\\s\*approved\/i\.test\(content\);\n\s*if \(!hasApproved\) \{[\s\S]*?\n\s*\}\n/,
      "const hasApproved = true;\n",
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "nc-review-gate-mutant-fixture-"));
  try {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-9001\nrole: REVIEW-CODEX\n", "utf8");
    const result = mutant.checkReviewGate({
      message: "feat: x (HYK-9001)",
      reviewPath,
    });
    assert.equal(
      result.ok,
      true,
      "mutant must pass what the real gate blocks (RED signal for the mutation)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-1 mutation/review-gate #2: removing the 'role: REVIEW*' self-certification check -> RED", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(
      /const hasIndependentReviewer = \/role:\\s\*REVIEW\/i\.test\(content\);\n\s*if \(!hasIndependentReviewer\) \{[\s\S]*?\n\s*\}\n/,
      "const hasIndependentReviewer = true;\n",
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), "nc-review-gate-mutant-fixture-"));
  try {
    const reviewPath = join(dir, "review.md");
    writeFileSync(
      reviewPath,
      "for: HYK-9001\nverdict: approved\nrole: CODER-CLAUDE\n",
      "utf8",
    );
    const result = mutant.checkReviewGate({
      message: "feat: x (HYK-9001)",
      reviewPath,
    });
    assert.equal(
      result.ok,
      true,
      "mutant must let self-certification through (RED signal for the mutation)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-1 mutation/review-gate #3: removing the empty-skip-reason check -> RED", async () => {
  const mutant = await importMutatedCopy((src) =>
    src.replace(/if \(skipReason\.length === 0\) \{[\s\S]*?\n\s*\}\n/, ""),
  );
  const dir = mkdtempSync(join(tmpdir(), "nc-review-gate-mutant-fixture-"));
  try {
    const result = mutant.checkReviewGate({
      message: "fix: emergency (HYK-9001)\n\nskip-review: \n",
      reviewPath: join(dir, "unused.md"),
    });
    assert.equal(
      result.ok,
      true,
      "mutant must accept an empty skip-review reason (RED signal for the mutation)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-review-gate.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-review-gate.test.mjs changed the tracked-file diff state -- the suite must leave whatever diff existed before it ran untouched, not force it to empty",
  );
});
