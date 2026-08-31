// HYK-271-preflight-2 (2R, review P1-2 fix): measures whether the
// axis-heartbeat-absence backstop this issue's proposal doc
// (docs/control-room-patches/HYK-271-preflight-preview-marker.md) leans on
// actually catches the axis-orca-query-preview truncation false negative
// 1R measured (hyk271-axis-preview-marker-synthetic.test.mjs's
// "modal-truncated-marker-split-mid-word (KNOWN MISS)" sample).
//
// 1R asserted "heartbeat absence eventually catches it" without a single
// line of code observing heartbeats, judging absence, or firing an alert --
// review correctly called this a hope, not a conclusion (coder-task.md §1
// P1-2). This file does not fix that by inventing new production wiring
// (coder-task.md §2 forbids new axis code / control-room changes this
// round) -- it measures the honest, narrower claim that IS checkable today.
//
// Ground truth (실측, grep against this repo, 2026-08-31): zero production
// call sites read `last_heartbeat_at` (from `orca orchestration dispatch-show`)
// and pass it through any staleness judgment. `grep -rln "last_heartbeat_at"
// scripts | grep -v test` returns only a schema declaration
// (scripts/relay/contracts/seat-proof-contract-v1.mjs, a nullable-field
// list) and fixture/sample JSON -- no judge, no caller.
//
// So: axis-heartbeat-absence, AS IT EXISTS TODAY, catches nothing (there is
// no observer to catch with). What this file measures instead is a
// conditional: IF a heartbeat-absence judge were built by reusing this
// repo's own existing generic freshness primitive
// (scripts/supervisor/watch-freshness-core.mjs's judgeWatchFreshness --
// already merged, already used for a different self-liveness axis,
// deliberately NOT reimplemented here per coder-task.md's "재구현 금지"
// precedent) with `recordedAtMs` fed from `last_heartbeat_at`, what is the
// EXACT size of the window in which neither axis has fired yet? That size
// is not a guess -- it is read directly off judgeWatchFreshness's own
// ALIVE/STALE boundary, which this file exercises at the boundary itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  judgeWatchFreshness,
  WATCH_FRESHNESS_VERDICT,
} from "../supervisor/watch-freshness-core.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Candidate thresholds -- NOT a repo decision, both are explicitly-sourced
// assumptions (추론), stated as such rather than presented as one true
// number:
//   300s: worker-dispatch-rule.md's own stated heartbeat cadence ("5분
//         주기") taken at face value -- the earliest a single missed beat
//         could even be noticed.
//   900s: this repo's OWN existing convention for a structurally identical
//         self-liveness judgment (scripts/supervisor/schedule-wire.mjs's
//         DEFAULT_STALE_AFTER_SECONDS = 900, commented there as "15분(등록
//         주기의 여러 배)") -- reused here only as an existing precedent for
//         "how many cycles of grace this repo already tolerates elsewhere,"
//         not because it was chosen for THIS axis.
const CANDIDATE_THRESHOLDS_SECONDS = Object.freeze([300, 900]);

// The 1R truncation-miss scenario, restated as a timeline: the seat's last
// heartbeat lands at t=0 (recordedAtMs=0), then a modal blocks it and the
// preview-marker check (axis-orca-query-preview) misses the modal because
// its marker text is truncated by redraw (1R's measured false negative).
// From that instant, only a heartbeat-absence judge could still catch the
// stall -- and only once `now - 0 > staleAfterSeconds`.
const LAST_HEARTBEAT_AT_MS = 0;

test("both-miss gap: for each candidate threshold, judgeWatchFreshness (reused, not reimplemented) reports ALIVE one second before the threshold and STALE one second after -- the gap is ~staleAfterSeconds, measured at the actual boundary, not an estimate", () => {
  for (const staleAfterSeconds of CANDIDATE_THRESHOLDS_SECONDS) {
    const justBeforeMs = staleAfterSeconds * 1000 - 1000;
    const justAfterMs = staleAfterSeconds * 1000 + 1000;

    const stillAlive = judgeWatchFreshness({
      lastRun: { recordedAtMs: LAST_HEARTBEAT_AT_MS },
      now: justBeforeMs,
      staleAfterSeconds,
    });
    assert.equal(
      stillAlive.verdict,
      WATCH_FRESHNESS_VERDICT.ALIVE,
      `threshold ${staleAfterSeconds}s: expected still-ALIVE one second before the boundary (both-miss gap is still open at ${justBeforeMs}ms)`,
    );

    const nowStale = judgeWatchFreshness({
      lastRun: { recordedAtMs: LAST_HEARTBEAT_AT_MS },
      now: justAfterMs,
      staleAfterSeconds,
    });
    assert.equal(
      nowStale.verdict,
      WATCH_FRESHNESS_VERDICT.STALE,
      `threshold ${staleAfterSeconds}s: expected STALE one second after the boundary (this is the earliest instant a heartbeat-absence judge built on this primitive COULD fire)`,
    );
  }
});

test("both-miss gap size is a direct function of the assumed threshold, not a fixed constant -- 300s and 900s produce different measured gaps", () => {
  const gaps = CANDIDATE_THRESHOLDS_SECONDS.map((staleAfterSeconds) => {
    // binary search the exact verdict-flip boundary in whole seconds,
    // rather than trusting the threshold value itself -- this proves the
    // gap size is READ from judgeWatchFreshness's actual behavior, not
    // asserted to equal the threshold by construction.
    let lo = 0;
    let hi = staleAfterSeconds * 2;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const verdict = judgeWatchFreshness({
        lastRun: { recordedAtMs: LAST_HEARTBEAT_AT_MS },
        now: mid * 1000,
        staleAfterSeconds,
      }).verdict;
      if (verdict === WATCH_FRESHNESS_VERDICT.ALIVE) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return { staleAfterSeconds, measuredGapSeconds: lo };
  });
  // judgeWatchFreshness treats ageSeconds<=staleAfterSeconds as ALIVE
  // (inclusive boundary, watch-freshness-core.mjs's own `<=` check) -- so
  // the first STALE second is staleAfterSeconds+1, not staleAfterSeconds
  // itself. Asserting the +1 here (rather than rounding it away) is the
  // point: this file measures judgeWatchFreshness's actual behavior, it
  // does not restate the threshold back at itself.
  assert.deepEqual(
    gaps,
    CANDIDATE_THRESHOLDS_SECONDS.map((staleAfterSeconds) => ({
      staleAfterSeconds,
      measuredGapSeconds: staleAfterSeconds + 1,
    })),
    "expected the measured ALIVE->STALE flip second to equal staleAfterSeconds+1 (inclusive boundary) for every candidate threshold",
  );
});

// Negative control (honesty check on this file itself): confirms the claim
// in this file's header is still true at test time, so this measurement
// cannot silently go stale if a future round adds real heartbeat-absence
// wiring without updating this file's framing.
test("sanity: no production (non-test) file in this repo currently reads last_heartbeat_at and judges staleness with it (grep ground truth this file's header cites)", () => {
  let out;
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "-I", "last_heartbeat_at", "--", "scripts"],
      { encoding: "utf8", cwd: REPO_ROOT },
    );
  } catch (err) {
    // `git grep` exits 1 (not an error) when it finds zero matches --
    // treat that as "no hits" rather than a failure, and only re-throw a
    // genuine tool failure (missing git, not a repo, etc.).
    if (typeof err.status === "number" && err.status === 1) {
      out = "";
    } else {
      throw err;
    }
  }
  const hits = out
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((f) => !f.endsWith(".test.mjs"))
    .filter((f) => !f.includes("fixture"))
    .filter((f) => !f.includes("sample"))
    .filter((f) => !f.endsWith(".json"));
  assert.deepEqual(
    hits,
    ["scripts/relay/contracts/seat-proof-contract-v1.mjs"],
    "expected the ONLY non-test/non-fixture hit to remain the schema declaration -- if this list grows, a real observer may now exist and this file's conditional framing needs re-checking, not silent reuse",
  );
});
