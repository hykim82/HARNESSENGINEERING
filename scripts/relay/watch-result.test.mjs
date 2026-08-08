import { test } from "node:test";
import assert from "node:assert/strict";
import {
  watchResult,
  DEFAULT_INTERVAL_S,
  DEFAULT_KEEPALIVE_S,
  EXIT_DONE,
  EXIT_TICK,
  EXIT_CONFIG_INVALID,
  EXIT_UNJUDGABLE,
  EXIT_BLOCKED,
  classifyWatchFailure,
  isBlockedFamilyState,
  parseWatchArgs,
} from "./watch-result.mjs";
import { RESULT_BLOCK_STATE } from "../check/relay-handshake.mjs";

// Fake clock: sleepFn advances a shared counter by intervalS*1000 and
// resolves immediately (no real timer), nowFn reads that counter -- this
// lets every test run in milliseconds of wall time while still exercising
// the loop's elapsed-time arithmetic exactly as the real setTimeout-backed
// path would.
function fakeClock(intervalS) {
  let t = 0;
  let sleepCalls = 0;
  return {
    nowFn: () => t,
    sleepFn: async () => {
      sleepCalls++;
      t += intervalS * 1000;
    },
    sleepCallCount: () => sleepCalls,
  };
}

function checkSequence(results) {
  let i = 0;
  return () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return r;
  };
}

test("(1) already done on the first check -> immediate done, no sleep", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: true, reason: "relay handshake ok for X" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(result.elapsedS, 0);
  assert.equal(sleepCallCount(), 0);
});

test("(2) done after 3 ticks -> done, sleepFn called exactly 3 times", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    { ok: true, reason: "relay handshake ok for X" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 3);
  assert.equal(result.elapsedS, 180);
});

test("(3) maxWaitS reached while still not done -> tick", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
  ]);
  const result = await watchResult({
    role: "review",
    intervalS: 60,
    maxWaitS: 180,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "tick");
  assert.equal(result.elapsedS, 180);
  assert.equal(sleepCallCount(), 3);
  assert.match(result.reason, /not done after 180s \(keep-alive tick\)/);
});

test("(4) maxWaitS: 0 (plain mode) -> ignores keep-alive, keeps polling until done", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  // 10 ticks of not-done, well past what DEFAULT_KEEPALIVE_S (240s = 4
  // ticks at 60s) would have tick'd at, then done on the 11th check.
  const notDone = Array(10).fill({
    ok: false,
    reason: "result file not found (worker not done?): /x/coder.md",
  });
  const checkFn = checkSequence([
    ...notDone,
    { ok: true, reason: "relay handshake ok for X" },
  ]);
  const result = await watchResult({
    role: "verify",
    intervalS: 60,
    maxWaitS: 0,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 10);
});

test("(5) checkFn throws -> treated as not done, loop continues instead of crashing", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  let calls = 0;
  const checkFn = () => {
    calls++;
    if (calls < 3) throw new Error("transient read error");
    return { ok: true, reason: "relay handshake ok for X" };
  };
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 2);
});

test("(6) exported constants are fixed at 60/240, exit codes at 0/3", () => {
  assert.equal(DEFAULT_INTERVAL_S, 60);
  assert.equal(DEFAULT_KEEPALIVE_S, 240);
  assert.equal(EXIT_DONE, 0);
  assert.equal(EXIT_TICK, 3);
});

// --- HYK-136: config/pending classification ---------------------------

test("(7) classifyWatchFailure: known CONFIG reasons classified config", () => {
  assert.equal(
    classifyWatchFailure("task file not found: /x/coder-task.md"),
    "config",
  );
  assert.equal(
    classifyWatchFailure("task file missing task_id header"),
    "config",
  );
  assert.equal(
    classifyWatchFailure(
      "task file missing dropped_at header (required for staleness check)",
    ),
    "config",
  );
  assert.equal(
    classifyWatchFailure("task dropped_at not parseable: 'garbage'"),
    "config",
  );
});

test("(8) classifyWatchFailure: known PENDING reasons classified pending", () => {
  assert.equal(
    classifyWatchFailure(
      "result file not found (worker not done?): /x/coder.md",
    ),
    "pending",
  );
  assert.equal(
    classifyWatchFailure(
      "handshake mismatch: task dropped 'X' but result echoes 'Y' (stale or wrong task)",
    ),
    "pending",
  );
  assert.equal(
    classifyWatchFailure(
      'result missing ">>> DONE: ... @ <time KST>" line (required)',
    ),
    "pending",
  );
  assert.equal(
    classifyWatchFailure("stale result: DONE (...) predates task drop (...)"),
    "pending",
  );
  // HYK-172 결함5: task_id 에코 이전 "쓰는 중" 결과파일은 ">>> DONE 없음"
  // (위 케이스)과 대칭인 미완결 substate -- pending으로 폴링 유지되어야
  // unjudgable(exit 5)로 감시가 조기 종료되지 않는다.
  assert.equal(
    classifyWatchFailure(
      "result missing task_id echo (need a `task_id: <id>` line)",
    ),
    "pending",
  );
});

test("(9) classifyWatchFailure: unrecognized/non-string reason -> unjudgable (fail-open, not guessed)", () => {
  assert.equal(
    classifyWatchFailure("unexpected handshake parser shape"),
    "unjudgable",
  );
  assert.equal(classifyWatchFailure(undefined), "unjudgable");
  assert.equal(classifyWatchFailure(42), "unjudgable");
});

test("(10) known-bad: task file not found (e.g. --harness-dir pointed at an empty dir) -> immediate WATCH_CONFIG_INVALID, zero sleeps, never ticks", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, reason: "task file not found: /empty/coder-task.md" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "config");
  assert.match(result.reason, /^WATCH_CONFIG_INVALID: task file not found/);
  assert.equal(sleepCallCount(), 0);
  assert.equal(result.elapsedS, 0);
});

test("(11) known-bad: task file missing task_id header (header 결손) -> immediate WATCH_CONFIG_INVALID", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, reason: "task file missing task_id header" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "config");
  assert.match(
    result.reason,
    /^WATCH_CONFIG_INVALID: task file missing task_id header/,
  );
  assert.equal(sleepCallCount(), 0);
});

test("(12) paired good: same task file, header restored -> falls to pending (result not yet written), never misclassified as config", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 180,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "tick");
  assert.equal(sleepCallCount(), 3);
});

test("(13) paired good: config cleared mid-loop, then result file appears -> pending->complete transition, no config short-circuit taken", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    { ok: true, reason: "relay handshake ok for HYK-999" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 2);
});

test("(14) config classification wins even after several pending ticks (config surfaces mid-loop, not just on first check)", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    { ok: false, reason: "task file not found: /x/coder-task.md" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "config");
  assert.equal(sleepCallCount(), 1);
});

test("(15) EXIT_CONFIG_INVALID is distinct from EXIT_DONE(0) and EXIT_TICK(3)", () => {
  assert.equal(EXIT_CONFIG_INVALID, 4);
  assert.notEqual(EXIT_CONFIG_INVALID, EXIT_DONE);
  assert.notEqual(EXIT_CONFIG_INVALID, EXIT_TICK);
});

// --- HYK-136: CLI arg parsing (07-14/17 실사고 재현) --------------------

test("(16) known-bad: equals-form '--harness-dir=...' -> config error, unrecognized-flag never silently swallowed", () => {
  const parsed = parseWatchArgs([
    "--role",
    "coder",
    "--harness-dir=/some/path",
  ]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /unsupported '--harness-dir=value' syntax/);
});

test("(17) paired good: same intent, supported space-separated form -> parses harnessDir correctly, starts watching", () => {
  const parsed = parseWatchArgs([
    "--role",
    "coder",
    "--harness-dir",
    "/some/path",
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.role, "coder");
  assert.equal(parsed.harnessDir, "/some/path");
});

test("(18) known-bad: any other '--flag=value' shape (e.g. --role=coder) is rejected the same way, not just --harness-dir", () => {
  const parsed = parseWatchArgs(["--role=coder"]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /unsupported '--role=value' syntax/);
});

test("(19) unrecognized flag (not an =-form, just an unknown flag) is rejected as config-invalid, not silently ignored", () => {
  const parsed = parseWatchArgs(["--role", "coder", "--bogus-flag", "x"]);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /unrecognized flag '--bogus-flag'/);
});

test("(20) parseWatchArgs with no flags at all still defaults intervalS/maxWaitS", () => {
  const parsed = parseWatchArgs(["--role", "review"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.intervalS, DEFAULT_INTERVAL_S);
  assert.equal(parsed.maxWaitS, DEFAULT_KEEPALIVE_S);
});

// --- HYK-160-coder-2 (review-1 결함 1): UNJUDGABLE must terminate, never poll forever ---

test("(21) known-bad: exact review-1 repro -- an unrecognized reason ('unexpected handshake parser shape') with maxWaitS=1 terminates as unjudgable instead of looping forever", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, reason: "unexpected handshake parser shape" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 1,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "unjudgable");
  assert.match(
    result.reason,
    /^WATCH_UNJUDGABLE: unexpected handshake parser shape/,
  );
  assert.equal(sleepCallCount(), 0);
  assert.equal(result.elapsedS, 0);
});

test("(22) known-bad: plain mode (maxWaitS=0) previously had NO terminal path for an unrecognized reason -- now terminates immediately instead of polling forever", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, reason: "unexpected handshake parser shape" },
  ]);
  const result = await watchResult({
    role: "verify",
    intervalS: 60,
    maxWaitS: 0,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "unjudgable");
  assert.equal(sleepCallCount(), 0);
});

test("(23) paired good: same setup, reason swapped to a classified-pending value -> keeps polling (single-variable fix, not a broader relaxation)", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
  ]);
  const result = await watchResult({
    role: "verify",
    intervalS: 60,
    maxWaitS: 1,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "tick");
  assert.equal(sleepCallCount(), 1);
});

test("(24) unjudgable classification wins even mid-loop, after several genuine pending ticks", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason: "result file not found (worker not done?): /x/coder.md",
    },
    { ok: false, reason: "unexpected handshake parser shape" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "unjudgable");
  assert.equal(sleepCallCount(), 1);
});

test("(25) config classification still takes priority over unjudgable when both would apply on separate checks (config surfaces first, no regression from HYK-136)", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, reason: "task file not found: /x/coder-task.md" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "config");
  assert.equal(sleepCallCount(), 0);
});

test("(26) checkFn THROWING (not a clean ok:false reason) still keeps polling, unaffected by the unjudgable-terminates fix (contract from test 5 preserved)", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  let calls = 0;
  const checkFn = () => {
    calls++;
    if (calls < 4)
      throw new Error("transient read error, not a classification target");
    return { ok: true, reason: "relay handshake ok for X" };
  };
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 3);
});

// --- HYK-180 사이클1: mid-line task_id echo classifies config (terminal),
// never pending (would otherwise poll forever on a structural violation
// that no amount of waiting fixes) -------------------------------------

test("(28) classifyWatchFailure: mid-line task_id echo reason classified config, not pending", () => {
  assert.equal(
    classifyWatchFailure(
      "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
    ),
    "config",
  );
});

test("(29) known-bad: mid-line task_id echo -> immediate WATCH_CONFIG_INVALID, zero sleeps, never ticks (사이클0 실사고: 이 사유가 pending으로 새면 무한폴링)", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      reason:
        "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
    },
  ]);
  const result = await watchResult({
    role: "review",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "config");
  assert.match(
    result.reason,
    /^WATCH_CONFIG_INVALID: result task_id echo not at line start/,
  );
  assert.equal(sleepCallCount(), 0);
  assert.equal(result.elapsedS, 0);
});

test("(30) mutation counterfactual: this new reason must NOT be classified pending (reverting the CONFIG_REASON_PATTERNS entry would make this RED)", () => {
  const classification = classifyWatchFailure(
    "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
  );
  assert.notEqual(classification, "pending");
  assert.equal(classification, "config");
});

test("(27) EXIT_UNJUDGABLE is distinct from EXIT_DONE(0)/EXIT_TICK(3)/EXIT_CONFIG_INVALID(4)", () => {
  assert.equal(EXIT_UNJUDGABLE, 5);
  assert.notEqual(EXIT_UNJUDGABLE, EXIT_DONE);
  assert.notEqual(EXIT_UNJUDGABLE, EXIT_TICK);
  assert.notEqual(EXIT_UNJUDGABLE, EXIT_CONFIG_INVALID);
});

// ---------------------------------------------------------------------------
// HYK-173-escalation-2 §2-2: 소비자 결선. REVIEW 반려 (3) -- "판정값을
// 생산 소비자가 별도 상태로 소비하지 않는다"를 닫는다. checkRelayHandshake의
// `result.state`(BLOCKED/NEEDS_INPUT/MALFORMED_BLOCKED/AMBIGUOUS_BLOCKED)가
// 실제로 이 모듈의 종료 상태를 바꾸는지, 그리고 그 상태가 pending/
// unjudgable과 다른 문자열·다른 exit code로 나오는지 고정한다.
// ---------------------------------------------------------------------------

test("(31) isBlockedFamilyState: BLOCKED/NEEDS_INPUT/MALFORMED_BLOCKED/AMBIGUOUS_BLOCKED are all blocked-family, PENDING/NONE and non-string values are not", () => {
  assert.equal(isBlockedFamilyState(RESULT_BLOCK_STATE.BLOCKED), true);
  assert.equal(isBlockedFamilyState(RESULT_BLOCK_STATE.NEEDS_INPUT), true);
  assert.equal(
    isBlockedFamilyState(RESULT_BLOCK_STATE.MALFORMED_BLOCKED),
    true,
  );
  assert.equal(
    isBlockedFamilyState(RESULT_BLOCK_STATE.AMBIGUOUS_BLOCKED),
    true,
  );
  assert.equal(isBlockedFamilyState(RESULT_BLOCK_STATE.NONE), false);
  assert.equal(isBlockedFamilyState("PENDING"), false);
  assert.equal(isBlockedFamilyState(undefined), false);
  assert.equal(isBlockedFamilyState(null), false);
});

test("(32) BLOCKED state -> status='blocked', distinct WATCH_BLOCKED reason (carries the worker's reason text), immediate (no sleep), never classified pending or unjudgable", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      state: "BLOCKED",
      reason: "worker reported BLOCKED: 재현 실패 -- 조건 불명",
    },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.state, "BLOCKED");
  assert.match(
    result.reason,
    /^WATCH_BLOCKED: BLOCKED: worker reported BLOCKED: 재현 실패 -- 조건 불명/,
  );
  assert.equal(sleepCallCount(), 0);
});

test("(33) NEEDS_INPUT state -> status='blocked' too, but the state field and reason text stay distinguishable from BLOCKED", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      state: "NEEDS_INPUT",
      reason: "worker reported NEEDS_INPUT: 게이트 신호 대기 중",
    },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.state, "NEEDS_INPUT");
  assert.notEqual(result.reason, "WATCH_BLOCKED: BLOCKED: unrelated");
  assert.match(result.reason, /^WATCH_BLOCKED: NEEDS_INPUT:/);
  assert.equal(sleepCallCount(), 0);
});

async function assertBlockedFamilySurfacesAsBlocked(state) {
  const { nowFn, sleepFn } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: false, state, reason: `synthetic ${state} reason` },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "blocked", `state=${state} must be blocked`);
  assert.notEqual(
    result.status,
    "pending",
    `state=${state} must never be pending`,
  );
}

test("(34a) MALFORMED_BLOCKED surfaces as status='blocked' too -- a broken marker attempt is never silently folded back into pending", async () => {
  await assertBlockedFamilySurfacesAsBlocked("MALFORMED_BLOCKED");
});

test("(34b) AMBIGUOUS_BLOCKED surfaces as status='blocked' too -- an ambiguous marker attempt is never silently folded back into pending", async () => {
  await assertBlockedFamilySurfacesAsBlocked("AMBIGUOUS_BLOCKED");
});

test("(35) a plain PENDING-state result (no marker at all) is completely unaffected by the new consumer wiring -- still classified via the old reason-string path, keeps polling like before", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      state: "PENDING",
      reason: 'result missing ">>> DONE: ... @ <time KST>" line (required)',
    },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 1,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "tick");
  assert.equal(sleepCallCount(), 1);
});

test("(36) DONE still wins unconditionally even if a stray `state` field is somehow present on an ok:true result (1R's DONE-priority invariant is untouched by this wiring)", async () => {
  const { nowFn, sleepFn, sleepCallCount } = fakeClock(60);
  const checkFn = checkSequence([
    { ok: true, state: "BLOCKED", reason: "relay handshake ok for X" },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 240,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.equal(result.status, "done");
  assert.equal(sleepCallCount(), 0);
});

test("(37) EXIT_BLOCKED is distinct from EXIT_DONE(0)/EXIT_TICK(3)/EXIT_CONFIG_INVALID(4)/EXIT_UNJUDGABLE(5)", () => {
  assert.equal(EXIT_BLOCKED, 6);
  assert.notEqual(EXIT_BLOCKED, EXIT_DONE);
  assert.notEqual(EXIT_BLOCKED, EXIT_TICK);
  assert.notEqual(EXIT_BLOCKED, EXIT_CONFIG_INVALID);
  assert.notEqual(EXIT_BLOCKED, EXIT_UNJUDGABLE);
});

test("(38) mutation counterfactual: BLOCKED must NOT be classified the same as an unrecognized/unjudgable reason -- proves the state-first check actually changes behavior, not just adds a dead branch", async () => {
  const { nowFn, sleepFn } = fakeClock(60);
  const checkFn = checkSequence([
    {
      ok: false,
      state: "BLOCKED",
      reason: "worker reported BLOCKED: some reason",
    },
  ]);
  const result = await watchResult({
    role: "coder",
    intervalS: 60,
    maxWaitS: 1,
    checkFn,
    sleepFn,
    nowFn,
  });
  assert.notEqual(
    result.status,
    "unjudgable",
    "before this round's wiring, an unrecognized reason string (which BLOCKED's is) fell through to unjudgable -- this must now be its own 'blocked' status instead",
  );
  assert.equal(result.status, "blocked");
});
