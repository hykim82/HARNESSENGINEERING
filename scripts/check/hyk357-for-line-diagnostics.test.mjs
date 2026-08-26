// HYK-357 (coder-task.md §2-B) -- 'for:' 값 규격이 없어 올바른 'task_id:'를
// "이긴" 실사고(2026-08-25, 검토자가 'for: ORCH'를 적어 소비 영수증
// 미작성 + rejected 판정이 원장에 조용히 미기록됨)의 진단 개선.
//
// 설계 선택 = 조용한 폴백 «금지» (coder-task.md §2-B "설계 판단은 네
// 몫이다"): 'for:' 값이 HYK-<숫자>로 시작하지 않으면, 'task_id:'가
// 멀쩡했더라도 그쪽으로 조용히 넘어가지 않는다. 대신
// (a) 별도 reasonCode(FOR_LINE_ISSUE_ID_UNPARSEABLE)로 "for: 때문에
//     막혔다"는 사실 자체가 드러나고,
// (b) reason 문자열에 'task_id:'가 멀쩡했는지(값 포함)를 항상 덧붙여
//     사람이 5초 안에 원인을 알 수 있게 한다.
// 판정 결과(ok:false, 소비/원장 기록 거부) 자체는 바뀌지 않는다 --
// relay-handshake.mjs의 AMBIGUOUS_COVER_REASON_CODES 집합에 이 새
// reasonCode를 추가하지 않았으므로 차단 여부(HYK-262 NOT_BLOCKED 갈래)도
// 그대로다. 이 파일은 그 "판정 불변, 진단만 개선"을 프로덕션 진입점
// parseReviewOutcome을 직접 구동해 증명한다(헬퍼로 대신 검사하지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReviewOutcome,
  REJECT_STREAK_REASON_CODE,
} from "./reject-streak.mjs";

// ---------------------------------------------------------------------------
// 실사고 재현: for: 는 깨졌지만 task_id: 는 멀쩡하다 -- ★조용히 폴백하지
// 않는다(여전히 ok:false), 그러나 reason에 task_id:가 멀쩡했다는 사실과
// 그 값이 드러난다.
// ---------------------------------------------------------------------------
test("★실사고 재현: for: ORCH (깨짐) + task_id: HYK-356-review-1 (멀쩡) -> ok:false 유지, reasonCode=FOR_LINE_ISSUE_ID_UNPARSEABLE, reason에 task_id 값이 드러난다", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-356-review-1\nfor: ORCH\nverdict: rejected\n",
  );
  assert.equal(
    result.ok,
    false,
    "no silent fallback -- verdict is NOT recorded off task_id:",
  );
  assert.equal(
    result.reasonCode,
    REJECT_STREAK_REASON_CODE.FOR_LINE_ISSUE_ID_UNPARSEABLE,
  );
  assert.match(result.reason, /for: ORCH/);
  assert.match(
    result.reason,
    /task_id: 은 멀쩡했다/,
    "diagnostic must surface that task_id: was fine even though we did not use it",
  );
  assert.match(result.reason, /task_id: HYK-356-review-1/);
});

test("for: 도 task_id: 도 둘 다 깨진 경우 -> reason이 'task_id:도 같이 깨졌다'로 구분된다 (task_id:가 멀쩡했다고 거짓 진단하지 않는다)", () => {
  const result = parseReviewOutcome(
    "task_id: NOTANID\nfor: ORCH\nverdict: rejected\n",
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.reasonCode,
    REJECT_STREAK_REASON_CODE.FOR_LINE_ISSUE_ID_UNPARSEABLE,
  );
  assert.match(result.reason, /task_id: 도 같이 깨졌다/);
});

test("for: 깨지고 task_id: 자체가 없는 경우 -> reason이 'task_id: 줄도 없다'로 구분된다", () => {
  const result = parseReviewOutcome("for: ORCH\nverdict: rejected\n");
  assert.equal(result.ok, false);
  assert.equal(
    result.reasonCode,
    REJECT_STREAK_REASON_CODE.FOR_LINE_ISSUE_ID_UNPARSEABLE,
  );
  assert.match(result.reason, /task_id: 줄도 없다/);
});

// ---------------------------------------------------------------------------
// 정당한 거부 회귀 0 (coder-task.md §2-B) -- 진짜 규격 위반은 지금과 똑같이
// 거부돼야 한다.
// ---------------------------------------------------------------------------

test("★회귀 0: 'for:' 표지가 2개 -> 여전히 AMBIGUOUS_FOR_LINE로 거부 (새 reasonCode로 새지 않는다)", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-9-review-1\nfor: HYK-9-coder-1\nfor: HYK-9-coder-2\nverdict: rejected\n",
  );
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, REJECT_STREAK_REASON_CODE.AMBIGUOUS_FOR_LINE);
});

test("★회귀 0: 표지가 아예 없음 -> 여전히 NO_COVER_LINE로 거부", () => {
  const result = parseReviewOutcome("verdict: rejected\n");
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, REJECT_STREAK_REASON_CODE.NO_COVER_LINE);
});

test("★회귀 0: 'for:' 없이 'task_id:'만 있고 그 값이 깨짐 -> 여전히 일반 ISSUE_ID_UNPARSEABLE (FOR_LINE 갈래로 잘못 분류되지 않는다)", () => {
  const result = parseReviewOutcome("task_id: NOTANID\nverdict: rejected\n");
  assert.equal(result.ok, false);
  assert.equal(
    result.reasonCode,
    REJECT_STREAK_REASON_CODE.ISSUE_ID_UNPARSEABLE,
  );
});

test("★회귀 0: 'for:' 값이 올바른 HYK-<숫자> 형태 -> 여전히 정상 성공(ok:true), 진단 변경이 정상 경로를 건드리지 않는다", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-356-review-1\nfor: HYK-356-coder-1\nverdict: rejected\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.issueId, "HYK-356");
  assert.equal(result.taskId, "HYK-356-coder-1");
});

test("★역설 확인 유지: 'for:'를 아예 빼면 여전히 task_id: 폴백으로 성공한다 (coder-task.md §1ⓑ의 '안 쓰는 편이 안전한 필수 필드' 관찰이 이번 변경으로 깨지지 않았다)", () => {
  const result = parseReviewOutcome(
    "task_id: HYK-356-review-1\nverdict: rejected\n",
  );
  assert.equal(result.ok, true);
  assert.equal(result.issueId, "HYK-356");
  assert.equal(result.taskId, "HYK-356-review-1");
});
