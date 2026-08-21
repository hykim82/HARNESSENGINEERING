// HYK-335-rule-anchor-1 (coder-task.md §3-5) -- does the applied
// worker-dispatch-rule.md fixture ACTUALLY carry the §3-c contract (the
// `ask`-forbidden + two-step replacement assembly the 2026-08-21 latency
// measurement forced), not just "a section titled 3-c exists"?
//
// Four separate, independently-checkable claims (coder-task.md §3-5 1-4),
// each its own named assertion against a real substring read out of the
// committed applied fixture -- not a paraphrase of the task instructions:
//   1. `ask` is explicitly forbidden
//   2. both replacement steps are present -- send the question
//      (decision_gate shape) AND wait for the answer (check --wait shape)
//   3. the orphaned-question / lost-answer contract is spelled out (the
//      question survives the 30s cut, a late answer is silently dropped)
//   4. a failed question converges on §3-b's stop-report path instead of
//      inventing a new report shape
//
// ★Anti-vacuity (coder-task.md §3-5 헛시험 방지): for each of the 4 claims,
// a paired test takes an IN-MEMORY COPY of the fixture text, deletes the
// exact sentence that claim depends on, and asserts the same check goes
// RED on the mutated copy. This proves each assertion can actually fail --
// none of them are checking something structurally guaranteed to be true.
// The fixture FILE itself is never touched (coder-task.md §3-5 explicit
// prohibition) -- only string variables inside this test.
//
// ⚠️HYK-335-rule-anchor-2 (검토 1R P2-1 수리) -- 정직 한계: 위 4개 claim은
// 전부 저장소에 커밋된 applied fixture 문자열에 대한 검사이고, 관제실의
// 살아 있는 worker-dispatch-rule.md는 이 시험 어디서도 읽지 않는다.
// 그래서 라이브 파일에서 §3-c가 나중에 지워지거나 바뀌어도 이 시험은
// 그 변화를 관측할 수 없고 계속 초록으로 남는다 -- CI는 라이브 드리프트를
// 잡지 못한다(검토 1R이 관제실 live 파일만 바꾼 뒤 재실행해 9/9가 그대로
// 통과함을 재현했다). 이 시험이 실제로 막는 사정거리는 "저장소 안"의
// 계약 문면 변경뿐이다: applied fixture(또는 그 fixture를 재생산하는
// 패치 문서)에서 §3-c의 이 4개 문장 중 하나라도 지우면 이 시험이
// 빨간불을 낸다. 관제실 live 파일이 fixture와 계속 같은 값을 유지하는
// 것은 이 시험의 책임 밖이며, 그 동기화는 사람/ORCH가 patch-apply
// 절차로 수행한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APPLIED_PATH = fileURLToPath(
  new URL(
    "./fixtures/control-room-worker-dispatch-rule-2026-08-21-hyk335-applied.md.txt",
    import.meta.url,
  ),
);

function loadApplied() {
  return readFileSync(APPLIED_PATH, "utf8");
}

// ---- claim 1: `ask` is explicitly forbidden -------------------------------
const ASK_FORBIDDEN_SNIPPET = "⛔**`orca orchestration ask` 금지.**";
function hasAskForbidden(text) {
  return text.includes(ASK_FORBIDDEN_SNIPPET);
}

// ---- claim 2: both replacement steps are present ---------------------------
const SEND_STEP_SNIPPET = '--type decision_gate --subject "<한 줄 질문 제목>"';
const WAIT_STEP_SNIPPET =
  "orca orchestration check --terminal <자기 handle> --wait --types status --timeout-ms 600000 --json";
function hasSendStep(text) {
  return text.includes(SEND_STEP_SNIPPET);
}
function hasWaitStep(text) {
  return text.includes(WAIT_STEP_SNIPPET);
}

// ---- claim 3: orphaned question / lost answer contract ---------------------
const QUESTION_SURVIVES_SNIPPET = "질문 메시지는 원장에 그대로 남는다";
const ANSWER_DROPPED_SNIPPET = "조용히 버려진다";
function hasOrphanContract(text) {
  return (
    text.includes(QUESTION_SURVIVES_SNIPPET) &&
    text.includes(ANSWER_DROPPED_SNIPPET)
  );
}

// ---- claim 4: question failure converges on §3-b's stop-report path -------
const CONVERGE_SNIPPET =
  "질문 실패는 별도 신고 형식을 만들지 않는다 — §3-b 하나로 떨어진다.";
function hasConvergeToSectionB(text) {
  return text.includes(CONVERGE_SNIPPET);
}

test("claim 1: applied fixture explicitly forbids `orca orchestration ask`", () => {
  assert.equal(hasAskForbidden(loadApplied()), true);
});

test("claim 2: applied fixture spells out BOTH replacement steps -- send (decision_gate) and wait (check --wait)", () => {
  const text = loadApplied();
  assert.equal(hasSendStep(text), true);
  assert.equal(hasWaitStep(text), true);
});

test("claim 3: applied fixture states the orphaned-question / lost-answer contract", () => {
  assert.equal(hasOrphanContract(loadApplied()), true);
});

test("claim 4: applied fixture converges question-failure stop-reporting onto §3-b (no new report shape)", () => {
  assert.equal(hasConvergeToSectionB(loadApplied()), true);
});

// ---- anti-vacuity: each check above can actually go RED --------------------

test("★anti-vacuity: deleting the forbidding sentence flips claim 1's check to false (in-memory copy only, fixture file untouched)", () => {
  const mutated = loadApplied().replace(ASK_FORBIDDEN_SNIPPET, "");
  assert.equal(hasAskForbidden(mutated), false);
});

test("★anti-vacuity: deleting either replacement-step sentence flips claim 2's check to false (in-memory copy only, fixture file untouched)", () => {
  const withoutSend = loadApplied().replace(SEND_STEP_SNIPPET, "");
  assert.equal(hasSendStep(withoutSend), false);
  assert.equal(
    hasWaitStep(withoutSend),
    true,
    "unrelated snippet must survive the targeted deletion",
  );

  const withoutWait = loadApplied().replace(WAIT_STEP_SNIPPET, "");
  assert.equal(hasWaitStep(withoutWait), false);
  assert.equal(
    hasSendStep(withoutWait),
    true,
    "unrelated snippet must survive the targeted deletion",
  );
});

test("★anti-vacuity: deleting either half of the orphan contract flips claim 3's check to false (in-memory copy only, fixture file untouched)", () => {
  const withoutSurvives = loadApplied().replace(QUESTION_SURVIVES_SNIPPET, "");
  assert.equal(hasOrphanContract(withoutSurvives), false);

  const withoutDropped = loadApplied().replace(ANSWER_DROPPED_SNIPPET, "");
  assert.equal(hasOrphanContract(withoutDropped), false);
});

test("★anti-vacuity: deleting the convergence sentence flips claim 4's check to false (in-memory copy only, fixture file untouched)", () => {
  const mutated = loadApplied().replace(CONVERGE_SNIPPET, "");
  assert.equal(hasConvergeToSectionB(mutated), false);
});

test("★anti-vacuity, whole-clause: deleting the entire §3-c section flips ALL FOUR claims to false at once (in-memory copy only, fixture file untouched)", () => {
  const text = loadApplied();
  const sectionStart = text.indexOf("## 3-c.");
  assert.ok(
    sectionStart !== -1,
    "fixture must contain a §3-c heading for this test to be meaningful",
  );
  const nextSectionStart = text.indexOf("\n## ", sectionStart + 1);
  const sectionEnd = nextSectionStart === -1 ? text.length : nextSectionStart;
  const withoutSection = text.slice(0, sectionStart) + text.slice(sectionEnd);

  assert.equal(hasAskForbidden(withoutSection), false);
  assert.equal(hasSendStep(withoutSection), false);
  assert.equal(hasWaitStep(withoutSection), false);
  assert.equal(hasOrphanContract(withoutSection), false);
  assert.equal(hasConvergeToSectionB(withoutSection), false);
});
