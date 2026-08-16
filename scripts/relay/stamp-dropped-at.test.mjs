// HYK-257 ⓐ: stamp-dropped-at.mjs is the one supported machine-clock
// producer for a task file's `dropped_at` header (mirrors finalize-done.mjs
// -- see that file's own test suite for the sibling contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  stampDroppedAt,
  STAMP_DROPPED_AT_REASON,
} from "./stamp-dropped-at.mjs";

// relay-handshake.mjs's own parseKstTimestamp, duplicated here for a
// round-trip assertion only (avoids importing relay-handshake.mjs's much
// larger dependency surface into this small producer's own test suite).
function parseKstTimestampForTest(str) {
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "stamp-dropped-at.mjs",
);

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
  });
  assert.equal(res.error, undefined);
  assert.notEqual(res.status, null);
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("stampDroppedAt: callerSuppliedAt !== undefined is refused, regardless of value", () => {
  for (const badValue of ["2020-01-01 00:00 KST", 0, new Date(), null, false]) {
    const result = stampDroppedAt({ callerSuppliedAt: badValue });
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      STAMP_DROPPED_AT_REASON.CALLER_SUPPLIED_TIME_REJECTED,
    );
  }
});

test("stampDroppedAt: normal call (no callerSuppliedAt) stamps the injected machine clock, minute precision, KST format", () => {
  const fixedMs = Date.parse("2026-08-09T05:00:00Z"); // 2026-08-09 14:00 KST
  const result = stampDroppedAt({ nowFn: () => fixedMs });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, STAMP_DROPPED_AT_REASON.STAMPED);
  assert.equal(result.value, "2026-08-09 14:00 KST");
});

test("stampDroppedAt: output format is byte-compatible with relay-handshake.mjs's DROPPED_AT_RE + parseKstTimestamp (no seconds, single KST suffix)", () => {
  const fixedMs = Date.parse("2026-01-05T23:07:00Z"); // 2026-01-06 08:07 KST
  const result = stampDroppedAt({ nowFn: () => fixedMs });
  assert.match(result.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/);
  const parsed = parseKstTimestampForTest(result.value);
  assert.notEqual(parsed, null);
  assert.equal(parsed.getTime(), fixedMs);
});

test("CLI (non-Claude engine path): plain `node stamp-dropped-at.mjs` prints a machine-stamped DROPPED_AT line", () => {
  const res = runCli([]);
  assert.equal(res.exit, 0);
  assert.match(res.stdout, /^DROPPED_AT: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\n$/);
});

test("CLI: --at (or any --at=... form) is refused on sight, exit nonzero, nothing printed to stdout", () => {
  const res = runCli(["--at", "2020-01-01 00:00 KST"]);
  assert.notEqual(res.exit, 0);
  assert.match(res.stderr, /rejects caller-supplied timestamps/);
  assert.equal(res.stdout, "");

  const res2 = runCli(["--at=2020-01-01 00:00 KST"]);
  assert.notEqual(res2.exit, 0);
  assert.match(res2.stderr, /rejects caller-supplied timestamps/);
});
