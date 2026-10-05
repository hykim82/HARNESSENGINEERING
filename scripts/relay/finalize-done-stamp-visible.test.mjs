// HYK-209 (stamp self-check): finalize-done must refuse to stamp a '>>> DONE:'
// line that the CONSUMER's own completion match would not see, and must put the
// file back byte-for-byte when it refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalizeDone, FINALIZE_DONE_REASON } from "./finalize-done.mjs";
import { __probeResolveResultDoneMatch } from "../check/relay-handshake.mjs";

const FIXED_NOW = Date.UTC(2026, 9, 6, 0, 0, 0);

function withResult(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "finalize-done-visible-test-"));
  const resultPath = join(dir, "CODER.md");
  writeFileSync(resultPath, content, "utf8");
  try {
    fn({ dir, resultPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stamp(dir) {
  return finalizeDone({
    role: "CODER",
    harnessDir: dir,
    nowFn: () => FIXED_NOW,
  });
}

function consumerSees(resultPath) {
  return __probeResolveResultDoneMatch(readFileSync(resultPath, "utf8")).ok;
}

test("normal file (no open quote): stamp is written and the consumer sees it", () => {
  withResult("task_id: HYK-999-coder-1\n\nbody\n", ({ dir, resultPath }) => {
    const res = stamp(dir);
    assert.equal(res.ok, true);
    assert.equal(res.reasonCode, FINALIZE_DONE_REASON.FINALIZED);
    assert.equal(consumerSees(resultPath), true);
  });
});

test("CRLF file (no open quote): stamp is written and the consumer sees it", () => {
  withResult(
    "task_id: HYK-999-coder-1\r\n\r\nbody\r\n",
    ({ dir, resultPath }) => {
      const res = stamp(dir);
      assert.equal(res.ok, true);
      assert.equal(consumerSees(resultPath), true);
    },
  );
});

test("unclosed fence above the end: refuses, names the fence line, restores bytes", () => {
  const original = "task_id: HYK-999-coder-1\n```\nexample without a closer\n";
  withResult(original, ({ dir, resultPath }) => {
    const res = stamp(dir);
    assert.equal(res.ok, false);
    assert.equal(res.reasonCode, FINALIZE_DONE_REASON.STAMP_NOT_VISIBLE);
    assert.match(res.reason, /unclosed fence opens at .*CODER\.md:2\b/);
    assert.equal(readFileSync(resultPath, "utf8"), original);
  });
});

test("unclosed fence in a CRLF file: refuses and restores the CRLF bytes exactly", () => {
  const original = "task_id: HYK-999-coder-1\r\n```\r\nexample\r\n";
  withResult(original, ({ dir, resultPath }) => {
    const res = stamp(dir);
    assert.equal(res.ok, false);
    assert.equal(res.reasonCode, FINALIZE_DONE_REASON.STAMP_NOT_VISIBLE);
    assert.match(res.reason, /CODER\.md:2\b/);
    assert.equal(
      readFileSync(resultPath).equals(Buffer.from(original, "utf8")),
      true,
    );
  });
});

test("unclosed HTML comment above the end: refuses, names the comment line, restores bytes", () => {
  const original =
    "task_id: HYK-999-coder-1\n<!-- a note that never closes\nbody\n";
  withResult(original, ({ dir, resultPath }) => {
    const res = stamp(dir);
    assert.equal(res.ok, false);
    assert.equal(res.reasonCode, FINALIZE_DONE_REASON.STAMP_NOT_VISIBLE);
    assert.match(res.reason, /unclosed comment opens at .*CODER\.md:2\b/);
    assert.equal(readFileSync(resultPath, "utf8"), original);
  });
});

test("replace path: malformed stamp below an unclosed fence is not replaced, file restored", () => {
  const original =
    "task_id: HYK-999-coder-1\n```\n>>> DONE: CODER @ 2026-10-06 08:40 KST\n";
  withResult(original, ({ dir, resultPath }) => {
    const res = stamp(dir);
    assert.equal(res.ok, false);
    assert.equal(res.reasonCode, FINALIZE_DONE_REASON.STAMP_NOT_VISIBLE);
    assert.match(res.reason, /CODER\.md:2\b/);
    assert.equal(readFileSync(resultPath, "utf8"), original);
    assert.equal(
      /superseded_done:/.test(readFileSync(resultPath, "utf8")),
      false,
    );
  });
});
