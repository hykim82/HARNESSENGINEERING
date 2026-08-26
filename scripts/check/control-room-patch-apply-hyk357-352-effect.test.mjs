// HYK-357-352-rule-anchor-2 (coder-task.md §2-C, 두 이슈 공통 완료조건 2)
// -- ★근본 계약 시험: does the format the applied worker-dispatch-rule.md
// fixture PROMISES actually match what the REAL production parsers
// accept/reject? Not "does the string exist in the file" (coder-task.md
// §2-C explicitly calls that insufficient) -- this file drives the actual
// production entry points with synthetic input shaped exactly like the
// document's promise, on both sides of the promised boundary:
//
//   ⓐ HYK-352 (DONE seconds precision): relay-handshake.mjs's exported
//      `hasDoneSecondsPrecision`/`parseKstTimestamp` -- doc says seconds
//      required, so a seconds-bearing value must pass and a minute-only
//      value must fail.
//   ⓑ HYK-357 (`for:`/`task_id:`/`verdict:` value spec): reject-streak.mjs's
//      exported `parseReviewOutcome` -- doc says `for:` holds the CODER
//      round's harness task_id (not a role name) and `verdict:` is
//      approved|rejected only, so shapes matching the promise must pass
//      and shapes violating it must fail.
//
// ★변이 검사 (coder-task.md §2-C, 두 방향 모두): after asserting the
// applied fixture PROMISES each format rule (string-presence, exactly like
// HYK-335's effect test), each promise-presence check is proven capable of
// going RED by deleting the promise sentence from an IN-MEMORY copy of the
// fixture text (never the file itself) and reasserting -- then restoring
// the original text and reasserting GREEN again. This is the "역방향까지"
// requirement: red on deletion, green on restore, both checked explicitly
// in the same test.
//
// ⚠️정직 한계 (HYK-335 선례와 동일 형태): 이 시험은 저장소에 커밋된
// applied fixture 문자열과 저장소 안의 실제 프로덕션 파서(relay-
// handshake.mjs / reject-streak.mjs)만 구동한다. 관제실의 살아 있는
// worker-dispatch-rule.md는 이 시험 어디서도 읽지 않는다. 그래서 라이브
// 파일에서 이 값 규격이 나중에 지워지거나 바뀌어도 이 시험은 그 변화를
// 관측할 수 없고 계속 초록으로 남는다 -- CI는 라이브 드리프트를 잡지
// 못한다. 이 시험이 실제로 막는 사정거리는 "저장소 안"의 계약 문면
// 변경뿐이다: applied fixture(또는 그 fixture를 재생산하는 패치 문서)에서
// 이 값 규격 문장을 지우면 이 시험이 빨간불을 낸다. 관제실 live 파일이
// fixture와 계속 같은 값을 유지하는 것은 이 시험의 책임 밖이며, 그
// 동기화는 사람/ORCH가 patch-apply 절차로 수행한다. 이 축은 selfcheck의
// sha256 드리프트 감시(enforcement-inventory.json의
// control-room-live-baseline 항목)가 별도로 맡는다 -- 이 시험과 그
// 감시를 합쳐야 "문서↔코드 일치"가 성립한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasDoneSecondsPrecision,
  parseKstTimestamp,
} from "./relay-handshake.mjs";
import { parseReviewOutcome } from "./reject-streak.mjs";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-26-hyk357-352-applied.md.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- doc-promise-presence checks (mutation-testable, string-level) --------
const SECONDS_PROMISE_SNIPPET =
  "★DONE 줄의 시각은 **`YYYY-MM-DD HH:MM:SS KST`**(초 단위까지) 형식이어야 한다";
const SECONDS_REJECT_PROMISE_SNIPPET = "분 단위(초 생략)는 **거부**된다";
const FINALIZE_DONE_PROMISE_SNIPPET =
  "정본 기록 도구는 **`finalize-done`**이다";
const FOR_VALUE_PROMISE_SNIPPET =
  "`for:` = **검토자가 판정하는 CODER 라운드의 harness task_id**";
const FOR_NOT_ROLE_PROMISE_SNIPPET = "역할명·사람 이름을 적는 칸이 아니다";
const TASK_ID_VALUE_PROMISE_SNIPPET =
  "`task_id:` = **자기 라운드 자신의 `harness_label`**";
const VERDICT_VALUE_PROMISE_SNIPPET =
  "`verdict:` = **`approved` 또는 `rejected` 둘 중 하나만** 적는다";

function hasSecondsPromise(text) {
  return (
    text.includes(SECONDS_PROMISE_SNIPPET) &&
    text.includes(SECONDS_REJECT_PROMISE_SNIPPET)
  );
}
function hasFinalizeDonePromise(text) {
  return text.includes(FINALIZE_DONE_PROMISE_SNIPPET);
}
function hasForValuePromise(text) {
  return (
    text.includes(FOR_VALUE_PROMISE_SNIPPET) &&
    text.includes(FOR_NOT_ROLE_PROMISE_SNIPPET)
  );
}
function hasTaskIdValuePromise(text) {
  return text.includes(TASK_ID_VALUE_PROMISE_SNIPPET);
}
function hasVerdictValuePromise(text) {
  return text.includes(VERDICT_VALUE_PROMISE_SNIPPET);
}

test("ⓐ claim: applied fixture promises DONE seconds-precision + rejects minute-only", () => {
  assert.equal(hasSecondsPromise(loadApplied()), true);
});
test("ⓐ claim: applied fixture names finalize-done as the canonical DONE-stamping tool", () => {
  assert.equal(hasFinalizeDonePromise(loadApplied()), true);
});
test("ⓑ claim: applied fixture promises for: holds the CODER round's harness task_id, not a role name", () => {
  assert.equal(hasForValuePromise(loadApplied()), true);
});
test("ⓑ claim: applied fixture promises task_id: is the round's own harness_label", () => {
  assert.equal(hasTaskIdValuePromise(loadApplied()), true);
});
test("ⓑ claim: applied fixture promises verdict: is approved|rejected only", () => {
  assert.equal(hasVerdictValuePromise(loadApplied()), true);
});

// ---- ★anti-vacuity, both directions: RED on deletion, GREEN on restore ----

test("★anti-vacuity ⓐ (양방향): deleting the seconds-precision promise flips the check RED, the untouched original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(SECONDS_PROMISE_SNIPPET, "");
  assert.equal(
    hasSecondsPromise(mutatedRed),
    false,
    "RED direction: promise sentence deleted -> claim must fail",
  );
  assert.equal(
    hasSecondsPromise(original),
    true,
    "GREEN direction: the untouched original (fixture file itself, never mutated) must still pass",
  );
});

test("★anti-vacuity ⓐ-finalize (양방향): deleting the finalize-done promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(FINALIZE_DONE_PROMISE_SNIPPET, "");
  assert.equal(hasFinalizeDonePromise(mutatedRed), false);
  assert.equal(hasFinalizeDonePromise(original), true);
});

test("★anti-vacuity ⓑ (양방향): deleting either half of the for: value promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const withoutValueSentence = original.replace(FOR_VALUE_PROMISE_SNIPPET, "");
  assert.equal(hasForValuePromise(withoutValueSentence), false);
  const withoutNotRole = original.replace(FOR_NOT_ROLE_PROMISE_SNIPPET, "");
  assert.equal(hasForValuePromise(withoutNotRole), false);
  assert.equal(hasForValuePromise(original), true);
});

test("★anti-vacuity ⓑ-task_id (양방향): deleting the task_id: value promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(TASK_ID_VALUE_PROMISE_SNIPPET, "");
  assert.equal(hasTaskIdValuePromise(mutatedRed), false);
  assert.equal(hasTaskIdValuePromise(original), true);
});

test("★anti-vacuity ⓑ-verdict (양방향): deleting the verdict: value promise flips RED, original stays GREEN", () => {
  const original = loadApplied();
  const mutatedRed = original.replace(VERDICT_VALUE_PROMISE_SNIPPET, "");
  assert.equal(hasVerdictValuePromise(mutatedRed), false);
  assert.equal(hasVerdictValuePromise(original), true);
});

test("★anti-vacuity, whole-region (양방향): reverting the ENTIRE 52행/148행 region to the pre-patch (before fixture) text flips ALL FIVE claims to false at once; the committed applied fixture (unmutated) still passes all five", () => {
  const applied = loadApplied();
  const beforePath = fileURLToPath(
    new URL(
      "./fixtures/control-room-worker-dispatch-rule-2026-08-26-hyk357-352-before.md.txt",
      import.meta.url,
    ),
  );
  const before = readFileSync(beforePath, "utf8");

  // Reproduce the OLD (pre-patch) 52행 sentence and the applied fixture's
  // NEW 52행+extra sentence, and swap one for the other in-memory -- this
  // exercises the exact "fixture 문면을 옛 형태로 되돌리면" scenario
  // coder-task.md §2-C describes, using the real committed before-fixture
  // text as the ground truth for "옛 형태" (no hand-retyped duplicate to
  // drift from the source of truth).
  const oldDoneLine =
    "- 미커밋 종료 금지. 완료 시 `.harness/<역할>.md`에 결과 + `>>> DONE: <역할> @ <실제 시각 KST>` 를 쓴다(시각은 그때 직접 읽어서).";
  assert.ok(
    before.includes(oldDoneLine),
    "before fixture must still contain the pre-patch DONE bullet verbatim",
  );
  const newDoneLineStart = applied.indexOf(oldDoneLine);
  assert.notEqual(
    newDoneLineStart,
    -1,
    "applied fixture must still start its DONE bullet with the unchanged prefix",
  );
  const newDoneLineEnd = applied.indexOf("\n", newDoneLineStart);
  const revertedDoneLine =
    applied.slice(0, newDoneLineStart) +
    oldDoneLine +
    applied.slice(newDoneLineEnd);

  // Reproduce the old §5 marker-count sentence with nothing appended after
  // it (148행 이후 추가분 전체 삭제).
  const oldMarkerLine =
    "**`for:` · `role:` · `task_id:` · `verdict:` · `>>> DONE:` 는 결과 파일 전체에서 각각 정확히 1개여야 한다. 재작업 라운드에서 이전 기록을 보존할 때 그 블록에 표지 줄을 남기지 마라**(본문·수치는 보존하되 표지만 뺀다).";
  const markerStart = revertedDoneLine.indexOf(oldMarkerLine);
  assert.notEqual(markerStart, -1);
  const nextHeadingAfterMarker = revertedDoneLine.indexOf(
    "\n\n⚠️ **정직 한계**",
    markerStart,
  );
  assert.notEqual(
    nextHeadingAfterMarker,
    -1,
    "applied fixture must still end with the unchanged trailing 정직 한계 paragraph after §5's marker line",
  );
  const fullyReverted =
    revertedDoneLine.slice(0, markerStart) +
    oldMarkerLine +
    revertedDoneLine.slice(nextHeadingAfterMarker);

  // RED direction: the fully-reverted (옛 형태) text fails every claim.
  assert.equal(hasSecondsPromise(fullyReverted), false);
  assert.equal(hasFinalizeDonePromise(fullyReverted), false);
  assert.equal(hasForValuePromise(fullyReverted), false);
  assert.equal(hasTaskIdValuePromise(fullyReverted), false);
  assert.equal(hasVerdictValuePromise(fullyReverted), false);

  // GREEN direction: the real, unmutated applied fixture still passes all
  // five (원복 확인 -- 파일 자체는 이 시험 전체에서 한 번도 쓰기 대상이
  // 아니었다, `loadApplied()`는 매번 디스크에서 다시 읽는다).
  assert.equal(hasSecondsPromise(applied), true);
  assert.equal(hasFinalizeDonePromise(applied), true);
  assert.equal(hasForValuePromise(applied), true);
  assert.equal(hasTaskIdValuePromise(applied), true);
  assert.equal(hasVerdictValuePromise(applied), true);
});

// ---------------------------------------------------------------------------
// ★근본: drive the REAL PRODUCTION PARSERS with synthetic input shaped
// exactly like the promise on both sides of the boundary. This is the part
// coder-task.md §2-C says a string-presence check alone cannot substitute
// for -- these tests import and call the actual exported functions, never a
// test-only reimplementation.
// ---------------------------------------------------------------------------

test("ⓐ★production entry point: relay-handshake.mjs's hasDoneSecondsPrecision/parseKstTimestamp actually enforce what the doc promises -- seconds-bearing DONE value passes, minute-only DONE value fails", () => {
  const secondsValue = "2026-08-26 10:19:42";
  const minuteOnlyValue = "2026-08-26 10:19";

  // doc promise: seconds-bearing value is well-formed
  assert.equal(parseKstTimestamp(secondsValue) !== null, true);
  assert.equal(hasDoneSecondsPrecision(secondsValue), true);

  // doc promise: minute-only value is parseable as a KST timestamp (that
  // part hasn't changed) but FAILS the seconds-precision gate -- exactly
  // the two-step check resolveDoneAt in relay-handshake.mjs performs.
  assert.equal(parseKstTimestamp(minuteOnlyValue) !== null, true);
  assert.equal(
    hasDoneSecondsPrecision(minuteOnlyValue),
    false,
    "doc promises minute-precision DONE values are rejected -- the real gate must actually reject them, not just the document saying so",
  );
});

test("ⓑ★production entry point: reject-streak.mjs's parseReviewOutcome actually enforces what the doc promises -- for: shaped as a CODER-round harness task_id passes, for: shaped as a role name fails (no silent task_id: fallback)", () => {
  // doc promise: for: holds the CODER round's harness task_id (HYK-<n>-...)
  const validForShape = parseReviewOutcome(
    "task_id: HYK-356-review-1\nfor: HYK-356-coder-1\nverdict: rejected\n",
  );
  assert.equal(validForShape.ok, true);
  assert.equal(validForShape.issueId, "HYK-356");
  assert.equal(validForShape.taskId, "HYK-356-coder-1");

  // doc promise: for: is NOT a role name / person name -- the 2026-08-25
  // 실사고 shape (for: ORCH) must still fail even though task_id: is fine,
  // and must not silently resolve off task_id: instead.
  const roleNameForShape = parseReviewOutcome(
    "task_id: HYK-356-review-1\nfor: ORCH\nverdict: rejected\n",
  );
  assert.equal(
    roleNameForShape.ok,
    false,
    "doc promises for: is not a role name -- the real parser must actually reject it, not just the document saying so",
  );
});

test("ⓑ★production entry point: reject-streak.mjs's parseReviewOutcome actually enforces the doc's task_id:/for: distinctness promise -- differing values (normal case) still succeeds", () => {
  // doc promise: for: (the judged CODER round) and task_id: (this review
  // round's own harness_label) are meant to differ -- that must NOT be
  // treated as a contradiction by the real parser.
  const result = parseReviewOutcome(
    "task_id: HYK-357-review-1\nfor: HYK-356-coder-3\nverdict: approved\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "HYK-356-coder-3");
  assert.notEqual(result.taskId, "HYK-357-review-1");
});

test("ⓑ★production entry point: reject-streak.mjs's parseReviewOutcome actually enforces the doc's verdict: approved|rejected-only promise", () => {
  const validVerdict = parseReviewOutcome(
    "task_id: HYK-356-review-1\nfor: HYK-356-coder-1\nverdict: approved\n",
  );
  assert.equal(validVerdict.ok, true);

  const invalidVerdict = parseReviewOutcome(
    "task_id: HYK-356-review-1\nfor: HYK-356-coder-1\nverdict: maybe\n",
  );
  assert.equal(
    invalidVerdict.ok,
    false,
    "doc promises verdict: is approved|rejected only -- the real parser must actually reject any other word",
  );
});
