// HYK-311-retire-1 §2 -- 은퇴 기록 생산자 시험.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  nextRetirementFileName,
  writeRetirementRecord,
} from "./retirement-record-writer.mjs";
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
} from "./retirement-record-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER_PATH = join(HERE, "retirement-record-writer.mjs");

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "retirement-record-writer-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("nextRetirementFileName: no existing files -> r1", () => {
  assert.equal(nextRetirementFileName("coder", []), "coder-retire-r1.json");
});

test("nextRetirementFileName: existing r1/r2 -> next is r3", () => {
  assert.equal(
    nextRetirementFileName("coder", [
      "coder-retire-r1.json",
      "coder-retire-r2.json",
    ]),
    "coder-retire-r3.json",
  );
});

test("nextRetirementFileName: case-insensitive count (HYK-269-style collision defense)", () => {
  assert.equal(
    nextRetirementFileName("coder", ["CODER-retire-r1.json"]),
    "coder-retire-r2.json",
  );
});

test("writeRetirementRecord: writes JSON that checkRetirementRecord's own facts contract accepts as RETIRED once independently corroborated", () => {
  withFixtureDir((dir) => {
    const outcome = writeRetirementRecord({
      role: "CODER",
      harnessDir: dir,
      harnessTaskLabel: "HYK-1-blocked",
      archivePath: "rounds/CODER-r1.md",
      archiveFingerprintClaimed: "fp-archive-1",
      blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      successorLabel: "HYK-1-blocked-next",
      recordedAt: "2026-08-19 01:00:00 KST",
      evidence: "test",
    });
    assert.equal(outcome.ok, true, outcome.reason);
    const written = JSON.parse(
      readFileSync(join(dir, "retirements", "CODER-retire-r1.json"), "utf8"),
    );
    assert.equal(written.role, "CODER");
    assert.equal(written.harnessTaskLabel, "HYK-1-blocked");
    assert.equal(written.successorLabel, "HYK-1-blocked-next");

    const verdict = checkRetirementRecord({
      role: "CODER",
      harnessTaskLabel: "HYK-1-blocked",
      candidates: [
        {
          record: written,
          archiveExists: true,
          archiveFingerprintMatches: true,
          liveFingerprintMatches: true,
          blockReasonConfirmed: true,
        },
      ],
    });
    assert.equal(verdict.state, RETIREMENT_RECORD_STATE.RETIRED);
  });
});

test("writeRetirementRecord: role missing -> ok:false, no file written", () => {
  withFixtureDir((dir) => {
    const outcome = writeRetirementRecord({ harnessDir: dir });
    assert.equal(outcome.ok, false);
    assert.throws(() => readdirSync(join(dir, "retirements")));
  });
});

test("writeRetirementRecord: refuses case-insensitive filename collision (Windows-safe, mirrors abort-record-writer.mjs)", () => {
  withFixtureDir((dir) => {
    mkdirSync(join(dir, "retirements"), { recursive: true });
    writeFileSync(
      join(dir, "retirements", "coder-retire-r1.json"),
      "{}",
      "utf8",
    );
    const outcome = writeRetirementRecord({
      role: "coder",
      harnessDir: dir,
      harnessTaskLabel: "HYK-2",
      archivePath: "rounds/coder-r1.md",
      archiveFingerprintClaimed: "fp-2",
      blockReasonCode: "DONE_TIMESTAMP_NOT_PARSEABLE",
      successorLabel: "HYK-2-next",
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(readdirSync(join(dir, "retirements")).sort(), [
      "coder-retire-r1.json",
      "coder-retire-r2.json",
    ]);
  });
});

test("CLI: writes the record and exits 0", () => {
  withFixtureDir((dir) => {
    const payload = JSON.stringify({
      role: "REVIEW",
      harnessTaskLabel: "HYK-3-blocked",
      archivePath: "rounds/REVIEW-r1.md",
      archiveFingerprintClaimed: "fp-3",
      blockReasonCode: "TASK_CONTRACT_PROHIBITS_REPAIR",
      successorLabel: "HYK-3-blocked-next",
      recordedAt: "2026-08-19 01:00:00 KST",
      evidence: "cli test",
    });
    const out = execFileSync("node", [WRITER_PATH, dir, payload], {
      encoding: "utf8",
    });
    assert.match(out, /retirement-record-writer:/);
    const written = JSON.parse(
      readFileSync(join(dir, "retirements", "REVIEW-retire-r1.json"), "utf8"),
    );
    assert.equal(written.harnessTaskLabel, "HYK-3-blocked");
  });
});

test("CLI: missing args -> usage message, exit 1", () => {
  assert.throws(() =>
    execFileSync("node", [WRITER_PATH], { encoding: "utf8" }),
  );
});
