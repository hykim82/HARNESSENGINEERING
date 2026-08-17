// HYK-257 ⓑⓒ: relay-handshake.mjs's timezone-mislabel diagnostic (a value
// off by ~exactly the KST/UTC 9h offset from authority now is flagged as a
// suspected UTC-value-labeled-KST mistake, not silently treated as a
// generic future/stale value) + "고치는 법" fix-hint text on every rejected
// timestamp shape this file touches.
//
// 실사례 재현 대상(coder-task.md §1 추기 2026-08-16): 레인 F(HYK-265) 1R
// 결과 파일의 완료 표시가 `2026-08-15 23:36 KST`(실제는 2026-08-16 08:36
// KST -- UTC 값에 KST 라벨을 그대로 붙인 것, 9시간 차). 그 라운드는 마침
// 초 단위가 빠져 다른 사유로 걸렸지만, "초를 채웠더라도 통과했을 것"이라는
// 게 이슈 원문의 지적이다 -- 이 시험은 초를 채운 채로 같은 9시간 오차를
// 넣어 새 검사가 실제로 잡는지를 직접 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import {
  KST_OFFSET_MS,
  TZ_MISLABEL_TOLERANCE_MS,
  isSuspectedTimezoneMislabel,
} from "./time-authority.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk257-tz-mislabel-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

function isoKst(ms) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(kst.getUTCSeconds())} KST`;
}

const FIXED_NOW = Date.parse("2026-08-16T23:36:00Z"); // 2026-08-17 08:36 KST

test("HYK-257 (실사례 재현): DONE labeled KST but actually UTC (9h behind, seconds present) -> ok:false, state=SUSPECTED_TZ_MISLABEL_DONE, not a bare stale/future verdict", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-265\ndropped_at: 2026-08-16 08:00 KST\n",
    );
    // literal instant `FIXED_NOW` formatted WITHOUT the +9h KST conversion
    // (i.e. the UTC clock digits themselves), then hand-labeled "KST" --
    // this is exactly the 실사례 shape.
    const utcAsKstLabel = "2026-08-16 23:36:00 KST";
    writeResult(
      dir,
      "coder",
      `task_id: HYK-265\n\n>>> DONE: CODER @ ${utcAsKstLabel}\n`,
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "SUSPECTED_TZ_MISLABEL_DONE");
    assert.match(result.reason, /suspiciously close to exactly 9 hours/);
    assert.match(result.reason, /고치는 법/);
    // corrected suggestion must be the +9h value (what was actually meant).
    assert.match(result.reason, /2026-08-17 08:36:00 KST/);
  });
});

test("HYK-257: dropped_at 9h mislabel (minute precision) is also caught, state=SUSPECTED_TZ_MISLABEL_DROPPED_AT", () => {
  withFixtureDir((dir) => {
    // dropped_at labeled KST but actually the UTC digits (9h behind real now,
    // i.e. FIXED_NOW's own KST-formatted digits minus 9h -> "2026-08-16
    // 23:36 KST", per FIXED_NOW=2026-08-17 08:36 KST).
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-16 23:36 KST\n",
    );
    writeResult(
      dir,
      "coder",
      `task_id: HYK-1\n\n>>> DONE: CODER @ ${isoKst(FIXED_NOW)}\n`,
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "SUSPECTED_TZ_MISLABEL_DROPPED_AT");
    assert.match(result.reason, /고치는 법/);
  });
});

test("HYK-257 (오탐 0): normal control battery near typical completion offsets never trips the 9h-mislabel diagnostic, denominator=6", () => {
  const NORMAL_SAMPLES = [
    { label: "just now", doneOffsetMs: 0 },
    { label: "1 minute ago", doneOffsetMs: -60_000 },
    { label: "1 hour ago", doneOffsetMs: -60 * 60 * 1000 },
    { label: "4 hours ago", doneOffsetMs: -4 * 60 * 60 * 1000 },
    {
      label: "just inside the future skew allowance",
      doneOffsetMs: 4 * 60 * 1000,
    },
    {
      label: "30 days ago (archived-style)",
      doneOffsetMs: -30 * 24 * 60 * 60 * 1000,
    },
  ];
  let falsePositives = 0;
  for (const sample of NORMAL_SAMPLES) {
    withFixtureDir((dir) => {
      writeTask(
        dir,
        "coder",
        "task_id: HYK-1\ndropped_at: 2026-01-01 00:00 KST\n",
      );
      writeResult(
        dir,
        "coder",
        `task_id: HYK-1\n\n>>> DONE: CODER @ ${isoKst(FIXED_NOW + sample.doneOffsetMs)}\n`,
      );
      const result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW,
      });
      if (!result.ok) {
        falsePositives += 1;
        assert.fail(
          `false positive on sample '${sample.label}': ${result.reason}`,
        );
      }
    });
  }
  assert.equal(
    falsePositives,
    0,
    `오탐 ${falsePositives}/${NORMAL_SAMPLES.length}`,
  );
});

test("HYK-257 ⓒ: not-parseable DONE/dropped_at rejections carry a correct-format example + fix-tool pointer, not just a bare reason", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", "task_id: HYK-1\ndropped_at: not-a-time\n");
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const droppedResult = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(droppedResult.ok, false);
    assert.match(droppedResult.reason, /dropped_at not parseable/);
    assert.match(droppedResult.reason, /YYYY-MM-DD HH:MM KST/);
    assert.match(droppedResult.reason, /stamp-dropped-at\.mjs/);
  });

  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-16 08:00 KST\n",
    );
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> DONE: CODER @ soon\n");
    const doneResult = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(doneResult.ok, false);
    assert.match(doneResult.reason, /DONE timestamp not parseable/);
    assert.match(doneResult.reason, /YYYY-MM-DD HH:MM:SS KST/);
    assert.match(doneResult.reason, /finalize-done\.mjs/);
  });
});

test("HYK-257 ⓒ: future-skew rejection (non-9h-shaped) also carries a fix hint, not just the bare skew number", () => {
  withFixtureDir((dir) => {
    writeTask(
      dir,
      "coder",
      "task_id: HYK-1\ndropped_at: 2026-08-16 08:00 KST\n",
    );
    // 20 minutes in the future -- beyond MAX_FUTURE_SKEW_MS (5min) but far
    // from the 9h mislabel window, so this must reach the plain
    // future-skew path, not the mislabel path.
    writeResult(
      dir,
      "coder",
      `task_id: HYK-1\n\n>>> DONE: CODER @ ${isoKst(FIXED_NOW + 20 * 60 * 1000)}\n`,
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "FUTURE_DONE");
    assert.match(result.reason, /ahead of authority now/);
    assert.match(result.reason, /고치는 법/);
  });
});

test("isSuspectedTimezoneMislabel: boundary -- exactly at tolerance edge is IN, one unit past is OUT (denominator=2)", () => {
  const now = FIXED_NOW;
  const atEdge = now - (KST_OFFSET_MS - TZ_MISLABEL_TOLERANCE_MS);
  const pastEdge = now - (KST_OFFSET_MS - TZ_MISLABEL_TOLERANCE_MS - 1);
  assert.equal(isSuspectedTimezoneMislabel(atEdge, now), true);
  assert.equal(isSuspectedTimezoneMislabel(pastEdge, now), false);
});
