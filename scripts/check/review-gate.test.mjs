import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkReviewGate } from "./review-gate.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(a) no HYK tag -> ok", () => {
  const result = checkReviewGate({ message: "chore: tidy up README" });
  assert.equal(result.ok, true);
});

test("(b) HYK tag + missing review file -> blocked", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, false);
  });
});

test("(c) HYK tag + approved review evidence -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    writeFileSync(reviewPath, "for: HYK-999\nverdict: approved\n", "utf8");
    const result = checkReviewGate({
      message: "feat: add thing (HYK-999)",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(d) skip-review token with reason -> ok", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix: hotfix (HYK-999) [skip-review: prod outage, approved out-of-band]",
      reviewPath,
    });
    assert.equal(result.ok, true);
  });
});

test("(e) skip-review token with empty reason -> blocked", () => {
  withFixtureDir((dir) => {
    const reviewPath = join(dir, "review.md");
    const result = checkReviewGate({
      message: "fix: hotfix (HYK-999) [skip-review: ]",
      reviewPath,
    });
    assert.equal(result.ok, false);
  });
});
