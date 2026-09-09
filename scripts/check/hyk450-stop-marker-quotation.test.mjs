// HYK-450 1R -- 정지 표지 축의 「주장 vs 인용」.
//
// 이 축은 «어디에 있든 센다»가 안전 성질 그 자체다(HYK-333: 규칙을 지킨
// 워커의 정지 표지가 조용히 유실된 사고). 그래서 HYK-449 의 인용 마스킹은
// 이 축에 «의도적으로» 적용되지 않았고, 그 결과 이 축을 정직하게 «설명하는»
// 보고서가 소비 불능이 됐다(HYK-449 워커의 결과 파일 92행).
//
// ⇒ HYK-450 의 답: 인용을 «추정»하지 않고 «선언»으로 받는다. 작성자가
// 명시적으로 선언한 구간 안에서만, 그리고 «깨진 표지 흔적»에 한해서만
// 면제한다. 형식이 온전한 진짜 정지 표지는 선언 안이라도 여전히 채택된다.
//
// ⚠️이 파일에는 표지 문자열이 «문자 그대로» 들어간다 -- 시험 파일은 결과
// 파일이 아니므로 그것이 정상이다(coder-task.md §0.7 ⓒ).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveResultBlockedState,
  RESULT_BLOCK_STATE,
} from "./relay-handshake.mjs";

// ⛔픽스처는 «이 파일 안»에 둔다. 처음에는 `.harness/evidence-450/` 의 파일을
// 읽었는데, 이 저장소의 CI-canonical 격리 스윕은 **`scripts/` 만** 임시 루트로
// 복사하므로 그 경로가 없어 5건이 ENOENT 로 죽었다(전체 러너 2회차가 잡았다).
// ⇒ 시험은 «복사되는 나무 안»에서 자족해야 한다. `.harness/evidence-450/` 의
// 같은 내용 사본은 사람이 읽을 증거로 남겨 두되, 시험은 그것에 의존하지 않는다.
const NL = String.fromCharCode(10);
const ARROWS = ">".repeat(3);
const BT = String.fromCharCode(96);

// ⓐ 실물 형태 -- 앞 라운드 결과 파일이 축을 «설명하다» 거부당한 그 문장.
const MENTION_BODY = [
  "task_id: HYK-449-marker-count-fence-1",
  "role: CODER",
  "",
  "### 1-4. BLOCKED 축은 손대지 않았다",
  "",
  BT +
    ARROWS +
    " BLOCKED:" +
    BT +
    "/" +
    BT +
    "NEEDS_INPUT:" +
    BT +
    " 축의 「어디에 있든 센다」는 의도된",
  "fail-closed 다. 그 축은 원문을 그대로 읽는다.",
  "",
  ARROWS + " DONE: CODER @ 2026-09-06 22:20:12 KST",
  "done_stamped_by: finalize-done",
  "",
];
const DECLARE_BEGIN = "<!-- quoted-stop-marker: begin -->";
const DECLARE_END = "<!-- quoted-stop-marker: end -->";

const fixtures = {
  // 선언 없음 -- 예전 그대로 fail-closed 여야 한다.
  mentionUndeclared: MENTION_BODY.join(NL),
  // 같은 문장 + 인용 선언 -- 소비를 막지 않아야 한다.
  mentionDeclared: [
    ...MENTION_BODY.slice(0, 5),
    DECLARE_BEGIN,
    ...MENTION_BODY.slice(5, 7),
    DECLARE_END,
    ...MENTION_BODY.slice(7),
  ].join(NL),
  // 선언 «안»의 형식이 온전한 정지 표지 -- 여전히 채택돼야 한다.
  assertionInsideDeclaration: [
    "task_id: HYK-450-EVIDENCE-1",
    "role: CODER",
    "",
    DECLARE_BEGIN,
    ARROWS +
      " BLOCKED: 이것은 «인용 선언» 안이지만 형식이 온전한 진짜 정지 표지다",
    DECLARE_END,
    "",
  ].join(NL),
  // 닫히지 않은 선언 -- 면제 0.
  declarationUnclosed: [
    "task_id: HYK-450-EVIDENCE-2",
    "role: CODER",
    "",
    DECLARE_BEGIN,
    BT + ARROWS + " BLOCKED:" + BT + " 를 인용했지만 선언을 닫지 않았다",
    "",
  ].join(NL),
  // 실물 «주장» -- 아카이브의 검토 1R 중단 표지와 같은 형태.
  assertionReal: [
    "task_id: HYK-449-marker-count-review-1",
    "role: REVIEW",
    "",
    "superseded by b4ff56d; stale target, ORCH cut the round.",
    ARROWS +
      " BLOCKED: superseded by b4ff56d (stale target, ORCH cut the round)",
    "",
  ].join(NL),
};

// ---------------------------------------------------------------------------
// 1. 실물 2건 -- 완료조건 §2-1 ⓐ/ⓑ
// ---------------------------------------------------------------------------

test("HYK-450 ①-실물: 축을 «설명»한 보고서는 선언 없이는 여전히 fail-closed 다(예전 동작 그대로)", () => {
  const r = resolveResultBlockedState(fixtures.mentionUndeclared);
  assert.equal(r.state, RESULT_BLOCK_STATE.MALFORMED_BLOCKED);
});

test("HYK-450 ①-실물: 같은 문장을 «인용 선언»으로 감싸면 소비를 막지 않는다", () => {
  const r = resolveResultBlockedState(fixtures.mentionDeclared);
  assert.equal(r.state, RESULT_BLOCK_STATE.NONE);
});

// ---------------------------------------------------------------------------
// 2. ★안전 성질 -- 선언은 «진짜 정지»를 숨길 수 없다
// ---------------------------------------------------------------------------

test("HYK-450 ①-안전: 형식이 온전한 정지 표지는 «선언 구간 안»에 있어도 그대로 채택된다", () => {
  const r = resolveResultBlockedState(fixtures.assertionInsideDeclaration);
  assert.equal(r.state, RESULT_BLOCK_STATE.BLOCKED);
  assert.match(r.detail, /형식이 온전한 진짜 정지 표지/);
});

test("HYK-450 ①-안전: 실물 «주장»(검토 1R 중단 표지)은 선언이 없으므로 당연히 그대로 포착된다", () => {
  const r = resolveResultBlockedState(fixtures.assertionReal);
  assert.equal(r.state, RESULT_BLOCK_STATE.BLOCKED);
  assert.match(r.detail, /superseded by b4ff56d/);
});

test("HYK-450 ①-안전: 선언이 깨져 있으면(닫히지 않음) 면제는 «전부» 사라진다", () => {
  const r = resolveResultBlockedState(fixtures.declarationUnclosed);
  assert.equal(r.state, RESULT_BLOCK_STATE.MALFORMED_BLOCKED);
});

test("HYK-450 ①-안전: 짝 없는 end · 중첩 begin 도 면제 0 이다", () => {
  const body = (middle) => ["task_id: X", "", ...middle, ""].join("\n");
  const strayEnd = body([
    "<!-- quoted-stop-marker: end -->",
    "`>>> BLOCKED:` 인용",
  ]);
  assert.equal(
    resolveResultBlockedState(strayEnd).state,
    RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
  );
  const nested = body([
    "<!-- quoted-stop-marker: begin -->",
    "<!-- quoted-stop-marker: begin -->",
    "`>>> BLOCKED:` 인용",
    "<!-- quoted-stop-marker: end -->",
  ]);
  assert.equal(
    resolveResultBlockedState(nested).state,
    RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
  );
});

// ---------------------------------------------------------------------------
// 3. 축이 좁아지지 않았음 -- 선언 «밖»은 한 글자도 안 바뀐다
// ---------------------------------------------------------------------------

test("HYK-450 ①-회귀 0: 선언 밖의 깨진 표지 흔적 5형태는 전부 예전처럼 잡힌다", () => {
  const cases = [
    ["칼럼0 화살표+콜론만", ">>> BLOCKED:"],
    ["선행 공백", "   >>> BLOCKED: 사유"],
    ["화살표 없는 칼럼0", "BLOCKED: 사유"],
    ["글머리표 뒤", "- >>> NEEDS_INPUT: 사유"],
    ["백틱 뒤", "`>>> NEEDS_INPUT: 사유"],
  ];
  for (const [label, line] of cases) {
    const r = resolveResultBlockedState(`task_id: X\n\n${line}\n`);
    assert.equal(r.state, RESULT_BLOCK_STATE.MALFORMED_BLOCKED, label);
  }
});

test("HYK-450 ①-회귀 0: 선언이 하나도 없는 문서의 판정은 이 라운드 전과 같다(문장 중간 언급은 여전히 무시)", () => {
  const midSentence =
    "task_id: X\n\n이 문장은 축을 설명한다 >>> BLOCKED: 처럼 생긴 것도 문장 일부다\n";
  assert.equal(
    resolveResultBlockedState(midSentence).state,
    RESULT_BLOCK_STATE.NONE,
  );
});

test("HYK-450 ①: 선언 구간은 CRLF 파일에서도 동작한다(결과 파일은 실제로 CRLF 다)", () => {
  const crlf = [
    "task_id: X",
    "",
    "<!-- quoted-stop-marker: begin -->",
    "`>>> BLOCKED:` 를 인용한다",
    "<!-- quoted-stop-marker: end -->",
    "",
  ].join("\r\n");
  assert.equal(resolveResultBlockedState(crlf).state, RESULT_BLOCK_STATE.NONE);
});
