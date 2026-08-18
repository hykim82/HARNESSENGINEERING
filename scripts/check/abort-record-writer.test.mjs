// HYK-298-abort-record-1 §2-1 -- 중단 기록 생산자 시험.
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
import { nextAbortFileName, writeAbortRecord } from "./abort-record-writer.mjs";
import { checkAbortRecord, ABORT_RECORD_STATE } from "./abort-record-core.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WRITER_PATH = join(HERE, "abort-record-writer.mjs");

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "abort-record-writer-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("nextAbortFileName: no existing files -> r1", () => {
  assert.equal(nextAbortFileName("review", []), "review-abort-r1.json");
});

test("nextAbortFileName: existing r1/r2 -> next is r3", () => {
  assert.equal(
    nextAbortFileName("review", [
      "review-abort-r1.json",
      "review-abort-r2.json",
    ]),
    "review-abort-r3.json",
  );
});

test("nextAbortFileName: case-insensitive count (HYK-269-style collision defense)", () => {
  assert.equal(
    nextAbortFileName("review", ["REVIEW-abort-r1.json"]),
    "review-abort-r2.json",
  );
});

test("writeAbortRecord: writes JSON that checkAbortRecord's own facts contract accepts as VERIFIED once independently corroborated", () => {
  withFixtureDir((dir) => {
    const outcome = writeAbortRecord({
      role: "REVIEW",
      harnessDir: dir,
      harnessTaskLabel: "HYK-1-dead",
      dispatchId: "ctx_1",
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: "fp-dead-1",
      leftoverPath: "review.md",
      recordedAt: "2026-08-18 01:00:00 KST",
      evidence: "test",
    });
    assert.equal(outcome.ok, true, outcome.reason);
    const written = JSON.parse(
      readFileSync(join(dir, "aborts", "REVIEW-abort-r1.json"), "utf8"),
    );
    assert.equal(written.role, "REVIEW");
    assert.equal(written.harnessTaskLabel, "HYK-1-dead");
    assert.equal(written.leftoverFingerprint, "fp-dead-1");

    const verdict = checkAbortRecord({
      role: "REVIEW",
      liveFingerprint: "fp-dead-1",
      candidates: [
        {
          record: written,
          dispatchIdVerified: true,
          recoveryMarkerVerified: true,
        },
      ],
    });
    assert.equal(verdict.state, ABORT_RECORD_STATE.VERIFIED);
  });
});

test("writeAbortRecord: role missing -> ok:false, no file written", () => {
  withFixtureDir((dir) => {
    const outcome = writeAbortRecord({ harnessDir: dir });
    assert.equal(outcome.ok, false);
    assert.throws(() => readdirSync(join(dir, "aborts")));
  });
});

test("writeAbortRecord: refuses case-insensitive filename collision (Windows-safe, mirrors consumption-receipt-writer.mjs)", () => {
  withFixtureDir((dir) => {
    mkdirSync(join(dir, "aborts"), { recursive: true });
    writeFileSync(join(dir, "aborts", "review-abort-r1.json"), "{}", "utf8");
    // 강제로 다음 후보 이름이 대문자 충돌을 일으키도록 nextAbortFileName의
    // 카운팅을 우회하는 대신, 실제 흐름 그대로 두 번째 기록을 쓰면 정상
    // 번호가 매겨진다는 것을 확인(회귀 없음) + 대소문자 충돌 자체는
    // writeConsumptionReceipt와 동일한 findCaseInsensitiveCollisionLocal
    // 헬퍼가 막는다(그 헬퍼의 존재 자체를 이 파일에서 다시 증명하지
    // 않는다 -- consumption-receipt-writer.test.mjs가 이미 그 로직의
    // 원본을 검증했다. 여기서는 새 이름이 case-insensitive하게 이미
    // 있는 이름과 겹치는지만 대조).
    const outcome = writeAbortRecord({
      role: "review",
      harnessDir: dir,
      harnessTaskLabel: "HYK-2",
      dispatchId: "ctx_2",
      leftoverFingerprint: "fp-2",
    });
    assert.equal(outcome.ok, true);
    assert.deepEqual(readdirSync(join(dir, "aborts")).sort(), [
      "review-abort-r1.json",
      "review-abort-r2.json",
    ]);
  });
});

test("CLI: writes the record and exits 0", () => {
  withFixtureDir((dir) => {
    const payload = JSON.stringify({
      role: "CODER",
      harnessTaskLabel: "HYK-3-dead",
      dispatchId: "ctx_3",
      droppedAt: "2026-08-18 00:00:00 KST",
      leftoverFingerprint: "fp-3",
      leftoverPath: "coder.md",
      recordedAt: "2026-08-18 01:00:00 KST",
      evidence: "cli test",
    });
    const out = execFileSync("node", [WRITER_PATH, dir, payload], {
      encoding: "utf8",
    });
    assert.match(out, /abort-record-writer:/);
    const written = JSON.parse(
      readFileSync(join(dir, "aborts", "CODER-abort-r1.json"), "utf8"),
    );
    assert.equal(written.harnessTaskLabel, "HYK-3-dead");
  });
});

test("CLI: missing args -> usage message, exit 1", () => {
  assert.throws(() =>
    execFileSync("node", [WRITER_PATH], { encoding: "utf8" }),
  );
});
