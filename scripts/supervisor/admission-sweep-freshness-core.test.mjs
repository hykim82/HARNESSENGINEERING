// HYK-228 coder-r2 rejection-2 (review-r1.md §B) --
// admission-sweep-freshness-core.mjs 계약 시험.
//
// 이 시험이 보장하지 않는 것(S11):
// 1. "watch-run이 실제로 last-run.json을 정확히 남긴다"를 증명하지 않는다
//    -- 이 코어는 주입된 `lastRun`만 판정한다. 실제 watch-run 사이클을
//    돌려 이 필드가 진짜로 그 모양으로 나오는지는 admission-sweep-wire.
//    test.mjs의 통합 시험(§SURVIVAL-GUARANTEE-2)이 맡는다.
// 2. 표본 수 -- 각 test 이름에 분모를 명시한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  judgeAdmissionSweepFreshness,
  ADMISSION_SWEEP_FRESHNESS_VERDICT,
  ADMISSION_SWEEP_FRESHNESS_REASON,
} from "./admission-sweep-freshness-core.mjs";
import {
  WATCH_FRESHNESS_VERDICT,
  WATCH_FRESHNESS_REASON,
} from "./watch-freshness-core.mjs";

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

const STALE_AFTER_S = 900;

// ---------------------------------------------------------------------------
// (a) 사이클 자체가 죽은 경우(STALE) -- 기존 judgeWatchFreshness 경로를
// 그대로 통과시키는지 확인하는 sanity check일 뿐(이 축의 RED는 이미
// watch-freshness-core.test.mjs가 1R에서 증명했다, 여기서 다시 증명하지
// 않는다 -- 패스스루가 실제로 패스스루인지만 본다).
// ---------------------------------------------------------------------------
test("(a) cycle-dead passthrough (1/1): STALE cycle stays STALE regardless of any `sweep` field", () => {
  const now = Date.parse("2026-08-12T18:00:00+09:00");
  const recordedAtMs = now - 7 * 60 * 60 * 1000; // 7시간 전 -- STALE_AFTER_S(900s)를 한참 넘김
  const result = judgeAdmissionSweepFreshness({
    lastRun: {
      recordedAtMs,
      sweep: {
        ran: true,
        ok: false,
        status: "SWEEP_TRIGGER_STATE_UNAVAILABLE",
        reasonCode: "LEDGER_MISSING",
      },
    },
    now,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.STALE);
  assert.equal(result.reasonCode, WATCH_FRESHNESS_REASON.PAST_STALE_WINDOW);
});

// ---------------------------------------------------------------------------
// (b) 사이클은 살아있는데(ALIVE) sweep 자신이 실패 -- RED (coder-r2
// rejection-2의 핵심 요구, review-r1.md §B가 재현한 정확한 시나리오).
// ---------------------------------------------------------------------------
test("(b) cycle-alive + sweep ok:false -> RED (SWEEP_FAILED, 1/1): reproduces review-r1.md §B's exact repro (missing ledger -> SWEEP_TRIGGER_STATE_UNAVAILABLE) but composed judgment now flags it", () => {
  const now = Date.parse("2026-08-12T18:00:00+09:00");
  const recordedAtMs = now - 1000; // 방금 돌았다 -- 기존 코어라면 ALIVE
  const result = judgeAdmissionSweepFreshness({
    lastRun: {
      recordedAtMs,
      sweep: {
        ran: true,
        ok: false,
        status: "SWEEP_TRIGGER_STATE_UNAVAILABLE",
        reasonCode: "LEDGER_MISSING",
      },
    },
    now,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(
    result.verdict,
    ADMISSION_SWEEP_FRESHNESS_VERDICT.SWEEP_FAILED,
    "RED: a cycle that ran fine but whose sweep sub-step failed must NOT read as ALIVE",
  );
  assert.notEqual(result.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
  assert.equal(
    result.reasonCode,
    ADMISSION_SWEEP_FRESHNESS_REASON.SWEEP_STEP_FAILED,
  );
  assert.equal(result.underlyingStatus, "SWEEP_TRIGGER_STATE_UNAVAILABLE");
  assert.equal(result.underlyingReasonCode, "LEDGER_MISSING");
});

// ---------------------------------------------------------------------------
// (c) 사이클은 살아있고 sweep도 성공, changed:[] -- "조용히 할 일이
// 없었다"는 반드시 ALIVE로 남아야 한다(새 거짓 경보 금지, coder-r2 명시
// 경고). 1R에서 이미 만든 "ok:true changed:[] vs ok:false changed:null"
// 구별(admission-sweep-wire.test.mjs (c) FAIL-CLOSED)을 이 신선도 계층
// 에서도 지킨다.
// ---------------------------------------------------------------------------
test("(c) cycle-alive + sweep ok:true changedCount:0 -> stays ALIVE (1/1): the quiet-0-recovered case must NOT be a new false alarm", () => {
  const now = Date.parse("2026-08-12T18:00:00+09:00");
  const recordedAtMs = now - 1000;
  const result = judgeAdmissionSweepFreshness({
    lastRun: {
      recordedAtMs,
      sweep: {
        ran: true,
        ok: true,
        status: "SWEEP_TRIGGER_SWEPT",
        reasonCode: "OK",
        changedCount: 0,
      },
    },
    now,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
  assert.equal(result.reasonCode, WATCH_FRESHNESS_REASON.WITHIN_STALE_WINDOW);
});

// ---------------------------------------------------------------------------
// (d) 사이클은 살아있지만 sweep이 아예 설정 안 됨(opt-out, admissionSweep
// 파라미터를 안 주는 기존 대다수 호출자) -- ALIVE, 완전 무회귀.
// ---------------------------------------------------------------------------
test("(d) cycle-alive + sweep not configured (`{ran:false}`) -> stays ALIVE, unaffected (1/1): callers not using admission sweep at all see zero behavior change", () => {
  const now = Date.parse("2026-08-12T18:00:00+09:00");
  const recordedAtMs = now - 1000;
  const result = judgeAdmissionSweepFreshness({
    lastRun: { recordedAtMs, sweep: { ran: false } },
    now,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
});

test("(d-2) cycle-alive + no `sweep` field at all (pre-HYK-228 record shape) -> stays ALIVE (1/1): backward compatible with last-run.json records that predate this field", () => {
  const now = Date.parse("2026-08-12T18:00:00+09:00");
  const recordedAtMs = now - 1000;
  const result = judgeAdmissionSweepFreshness({
    lastRun: { recordedAtMs },
    now,
    staleAfterSeconds: STALE_AFTER_S,
  });
  assert.equal(result.verdict, WATCH_FRESHNESS_VERDICT.ALIVE);
});

test("never throws regardless of input shape (doesNotThrow, 4/4)", () => {
  for (const bad of [null, undefined, 42, []]) {
    assert.doesNotThrow(() => judgeAdmissionSweepFreshness(bad));
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
    "admission-sweep-freshness-core.test.mjs must leave the real worktree exactly as it found it",
  );
});
