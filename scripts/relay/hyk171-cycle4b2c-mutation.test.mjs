import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTerminalShow,
  TERMINAL_SHOW_REASON,
} from "./adapters/terminal-show-adapter.mjs";
import { normalizeDispatchShow } from "./adapters/dispatch-correlation-adapter.mjs";
import {
  judgeDispatchBoundSeatProof,
  SEAT_PROOF,
  SEAT_PROOF_REASON,
} from "./dispatch-bound-seat-proof.mjs";
import {
  rawTerminalShowP1,
  rawDispatchShowP2,
  rawTerminalShowN1StaleHandle,
  rawTerminalShowN2NonexistentHandle,
  rawTerminalShowN3MalformedHandle,
  rawTerminalListRowDisguisedAsShow,
  expectedMatchingP1P2,
} from "./hyk171-cycle4b2c-fixtures.mjs";

// HYK-171 사이클4b-2c (coder-task.md §2-D/§3) -- 배정 결속 좌석 증명
// 타당성 계약의 mutation 원장. 전부 프로덕션 진입점(normalizeTerminalShow /
// normalizeDispatchShow / judgeDispatchBoundSeatProof)을 직접 구동한다.
// "실제 RED 재현"(프로덕션 파일 변조 -> 이 스위트 재실행 -> RED 확인 ->
// git checkout --으로 원복 -> git diff --exit-code 확인) 절차와 각 항목의
// fail 수/RED 테스트 이름/측정 명령은 .harness/coder.md의 G7 표에 별도
// 기록한다 -- 이 파일 자체는 각 위협 시나리오의 정답(green) 계약만 담는다.

// ---------------------------------------------------------------------------
// schema lock -- P1/P2/오류 응답 fixture의 정확한 키 집합을 고정한다. 벤더가
// 스키마를 바꾸면(키 추가/삭제/타입 변경) 여기가 깨지는 것이 의도된 동작
// 이다(coder-task.md §2-C).
// ---------------------------------------------------------------------------
test("schema lock: P1 top-level envelope has exactly 4 keys (id, ok, result, _meta)", () => {
  const raw = rawTerminalShowP1();
  assert.deepEqual(Object.keys(raw).sort(), ["_meta", "id", "ok", "result"]);
});

test("schema lock: P1 result.terminal has exactly the 14 measured keys", () => {
  const raw = rawTerminalShowP1();
  assert.deepEqual(
    Object.keys(raw.result.terminal).sort(),
    [
      "branch",
      "connected",
      "handle",
      "lastOutputAt",
      "leafId",
      "paneRuntimeId",
      "preview",
      "ptyId",
      "rendererGraphEpoch",
      "tabId",
      "title",
      "worktreeId",
      "worktreePath",
      "writable",
    ].sort(),
  );
});

test("schema lock: P2 top-level envelope has exactly 4 keys (id, ok, result, _meta)", () => {
  const raw = rawDispatchShowP2();
  assert.deepEqual(Object.keys(raw).sort(), ["_meta", "id", "ok", "result"]);
});

test("schema lock: P2 result.dispatch has exactly the 11 measured keys", () => {
  const raw = rawDispatchShowP2();
  assert.deepEqual(
    Object.keys(raw.result.dispatch).sort(),
    [
      "id",
      "task_id",
      "assignee_handle",
      "assignee_pane_key",
      "status",
      "failure_count",
      "last_failure",
      "dispatched_at",
      "completed_at",
      "created_at",
      "last_heartbeat_at",
    ].sort(),
  );
});

// 재작업1 수정: error 키집합은 실측으로 {code, message}임이 확인됐다
// (이전 버전은 서술만 보고 {code} 단일 키로 재구성했다 -- 그 재구성이
// 틀린 형태를 lock으로 고정하고 있었다, fixtures.mjs 파일 헤더 참조).
// id 값은 요청마다 다르므로(N1/N2/N3가 서로 다른 id를 씀) 여기서는 키
// 존재와 typeof string만 확인하고 값은 고정하지 않는다.
test("schema lock: N1/N2/N3 error envelope has exactly the key set {id, ok, error, _meta} and error has exactly {code, message} -- id's VALUE is not locked (it varies per request), only its key+type", () => {
  const raw = rawTerminalShowN1StaleHandle();
  assert.deepEqual(Object.keys(raw).sort(), ["_meta", "error", "id", "ok"]);
  assert.deepEqual(Object.keys(raw.error).sort(), ["code", "message"]);
  assert.equal(typeof raw.id, "string");
});

test("schema lock: N1/N2/N3 top-level ids are measured-distinct (id is per-request, never a fixed contract value)", () => {
  const idN1 = rawTerminalShowN1StaleHandle().id;
  const idN2 = rawTerminalShowN2NonexistentHandle().id;
  const idN3 = rawTerminalShowN3MalformedHandle().id;
  assert.notEqual(idN1, idN2);
  assert.notEqual(idN2, idN3);
  assert.notEqual(idN1, idN3);
});

// ---------------------------------------------------------------------------
// 타입 축 (재작업2, review-1 P1-1) -- 기존 schema lock은
// `Object.keys().sort()` deepEqual로 "키 축"만 잠갔다. REVIEW가 직접
// 재현: `error.message`를 `"terminal_handle_stale"` -> `null`로 바꿔도
// 키 집합은 그대로라 45 pass/0 fail로 통과해버렸다(원래 45개 그대로
// 통과 -- 타입이 바뀌어도 lock이 안 깨졌다). 타입이 바뀌어도 안 깨지는
// lock은 "벤더가 응답 형식을 바꾸면 깨진다"는 존재 이유를 잃는다.
//
// 아래는 각 원시 fixture의 모든 필드에 대해 typeof(또는 null)를 개별
// test()로 잠근다(필드마다 별도 테스트 -- 깨지면 테스트 이름으로 바로
// 어느 필드인지 알 수 있다). 값 자체는 잠그지 않는다 -- 예외 2종만:
// `ok`(P1/P2=true, N1/N2/N3=false)와 `error.code`(=
// "terminal_handle_stale", 세 fixture가 같은 코드라는 것이 이 사이클의
// 핵심 계약). `id`(요청마다 다름)와 `preview`/`title`(S8, 화면 문자열)는
// 타입만 잠근다.
// ---------------------------------------------------------------------------

const P1_TERMINAL_FIELD_TYPES = {
  branch: "string",
  connected: "boolean",
  handle: "string",
  lastOutputAt: "number",
  leafId: "string",
  paneRuntimeId: "number",
  preview: "string", // 값 미고정(S8) -- 타입만
  ptyId: "string",
  rendererGraphEpoch: "number",
  tabId: "string",
  title: "string", // 값 미고정(S8) -- 타입만
  worktreeId: "string",
  worktreePath: "string",
  writable: "boolean",
};
for (const [field, type] of Object.entries(P1_TERMINAL_FIELD_TYPES)) {
  test(`type lock: P1 result.terminal.${field} is typeof ${type}`, () => {
    const raw = rawTerminalShowP1();
    assert.equal(typeof raw.result.terminal[field], type);
  });
}

test("type lock: P1 top-level id is typeof non-empty string (value not locked -- varies per request)", () => {
  const raw = rawTerminalShowP1();
  assert.equal(typeof raw.id, "string");
  assert.ok(raw.id.length > 0);
});
test("type lock: P1 top-level ok is exactly boolean true (value-locked exception)", () => {
  const raw = rawTerminalShowP1();
  assert.equal(raw.ok, true);
  assert.equal(typeof raw.ok, "boolean");
});
test("type lock: P1 _meta.runtimeId is typeof string", () => {
  const raw = rawTerminalShowP1();
  assert.equal(typeof raw._meta.runtimeId, "string");
});

const P2_DISPATCH_FIELD_TYPES = {
  id: "string",
  task_id: "string",
  assignee_handle: "string",
  assignee_pane_key: "string",
  status: "string",
  failure_count: "number",
  dispatched_at: "string",
  completed_at: "string",
  created_at: "string",
};
for (const [field, type] of Object.entries(P2_DISPATCH_FIELD_TYPES)) {
  test(`type lock: P2 result.dispatch.${field} is typeof ${type}`, () => {
    const raw = rawDispatchShowP2();
    assert.equal(typeof raw.result.dispatch[field], type);
  });
}
// null이 의미 있는 관측값이다(§1-1 실측) -- "null이어야 함"을 잠근다.
// 문자열로 바뀌면(예: 아래 probe3의 "none") 여기서 걸린다.
const P2_DISPATCH_NULL_FIELDS = ["last_failure", "last_heartbeat_at"];
for (const field of P2_DISPATCH_NULL_FIELDS) {
  test(`type lock: P2 result.dispatch.${field} is exactly null (measured null, meaningful absence)`, () => {
    const raw = rawDispatchShowP2();
    assert.equal(raw.result.dispatch[field], null);
  });
}

test("type lock: P2 top-level id is typeof non-empty string (value not locked)", () => {
  const raw = rawDispatchShowP2();
  assert.equal(typeof raw.id, "string");
  assert.ok(raw.id.length > 0);
});
test("type lock: P2 top-level ok is exactly boolean true (value-locked exception)", () => {
  const raw = rawDispatchShowP2();
  assert.equal(raw.ok, true);
  assert.equal(typeof raw.ok, "boolean");
});
test("type lock: P2 _meta.runtimeId is typeof string", () => {
  const raw = rawDispatchShowP2();
  assert.equal(typeof raw._meta.runtimeId, "string");
});

test("type lock: N1/N2/N3 top-level ok is exactly boolean false (value-locked exception)", () => {
  for (const raw of [
    rawTerminalShowN1StaleHandle(),
    rawTerminalShowN2NonexistentHandle(),
    rawTerminalShowN3MalformedHandle(),
  ]) {
    assert.equal(raw.ok, false);
    assert.equal(typeof raw.ok, "boolean");
  }
});
test('type lock: N1/N2/N3 error.code is exactly "terminal_handle_stale" (value-locked exception -- the shared code IS the core contract)', () => {
  for (const raw of [
    rawTerminalShowN1StaleHandle(),
    rawTerminalShowN2NonexistentHandle(),
    rawTerminalShowN3MalformedHandle(),
  ]) {
    assert.equal(raw.error.code, "terminal_handle_stale");
  }
});
test("type lock: N1/N2/N3 error.message is typeof string (THIS is the exact gap review-1 found -- message:null previously left mutation suite green)", () => {
  for (const raw of [
    rawTerminalShowN1StaleHandle(),
    rawTerminalShowN2NonexistentHandle(),
    rawTerminalShowN3MalformedHandle(),
  ]) {
    assert.equal(typeof raw.error.message, "string");
  }
});
test("type lock: N1/N2/N3 _meta.runtimeId is typeof string", () => {
  const raw = rawTerminalShowN1StaleHandle();
  assert.equal(typeof raw._meta.runtimeId, "string");
});

// ---------------------------------------------------------------------------
// P1/P2 결속점 재확인 -- assignee_pane_key === `${tabId}:${leafId}`.
// ---------------------------------------------------------------------------
test("P1/P2 fixtures reproduce the measured binding point: assignee_pane_key equals P1's tabId:leafId", () => {
  const p1 = rawTerminalShowP1();
  const p2 = rawDispatchShowP2();
  const composite = `${p1.result.terminal.tabId}:${p1.result.terminal.leafId}`;
  assert.equal(p2.result.dispatch.assignee_pane_key, composite);
});

// ---------------------------------------------------------------------------
// N-a/N-b/N-c -- 세 가지 다른 실패(낡은 handle/존재하지 않는 handle/형식
// 오류 handle)가 어댑터를 거쳐도 여전히 구별 불가하게 같은 단일 사유
// 코드를 낸다는 계약을 고정한다. 세 갈래로 분리하는 변조가 있다면 이 세
// 테스트 중 최소 하나가 값이 달라져 RED가 나야 한다.
// ---------------------------------------------------------------------------
test("N-a: stale handle error response normalizes to ok:false with a single reason code", () => {
  const normalized = normalizeTerminalShow(rawTerminalShowN1StaleHandle());
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.NOT_OK);
});
test("N-b: nonexistent handle error response normalizes to the SAME reason code as N-a", () => {
  const normalized = normalizeTerminalShow(
    rawTerminalShowN2NonexistentHandle(),
  );
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.NOT_OK);
});
test("N-c: malformed handle-string error response normalizes to the SAME reason code as N-a/N-b", () => {
  const normalized = normalizeTerminalShow(rawTerminalShowN3MalformedHandle());
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.NOT_OK);
});
test("N-a/b/c fold to byte-identical normalized output -- no invented distinction between the three failure causes", () => {
  const a = normalizeTerminalShow(rawTerminalShowN1StaleHandle());
  const b = normalizeTerminalShow(rawTerminalShowN2NonexistentHandle());
  const c = normalizeTerminalShow(rawTerminalShowN3MalformedHandle());
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

// ---------------------------------------------------------------------------
// N-g -- `terminal list` 봉투(result.terminals, 복수)를 terminalShow 자리에
// 통째로 넣으면 result.terminal(단수)이 없어 구조 자체로 거부된다.
// ---------------------------------------------------------------------------
test("N-g: a terminal-list envelope (result.terminals) is rejected wholesale -- never mistaken for a terminal-show response", () => {
  const normalized = normalizeTerminalShow(rawTerminalListRowDisguisedAsShow());
  assert.equal(normalized.ok, false);
  assert.equal(
    normalized.reasonCode,
    TERMINAL_SHOW_REASON.NO_TERMINAL_ENVELOPE,
  );
});

// ---------------------------------------------------------------------------
// N-h -- 폴백 형태(tabId===leafId, 또는 하나가 `pty:...@@...` 형태). 두 개의
// 독립 분기가 있으므로 각각 단독으로 걸리는 fixture를 둔다(죽은 방어선
// 방지 -- 4b-2b-3 M7/M7b와 같은 원칙).
// ---------------------------------------------------------------------------
test("N-h(1): tabId === leafId (non-fallback-form value) is rejected by the equality guard alone", () => {
  const normalized = normalizeTerminalShow(
    rawTerminalShowP1({ tabId: "same-value-both", leafId: "same-value-both" }),
  );
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});
test("N-h(2) (load-bearing proof, SYNTHETIC): tabId is list-fallback form but tabId !== leafId -- only the fallback-form check (not the equality check) can catch this", () => {
  const raw = rawTerminalShowP1({
    tabId: "pty:e841ec57-…::C:/Users/…/some-lane@@deadbeef",
    leafId: "distinct-non-fallback-leaf",
  });
  assert.notEqual(raw.result.terminal.tabId, raw.result.terminal.leafId);
  const normalized = normalizeTerminalShow(raw);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});
test("N-h(3) (load-bearing proof, SYNTHETIC): leafId alone is @@-fallback form -- isolates the leafId branch of the fallback check", () => {
  const raw = rawTerminalShowP1({
    tabId: "distinct-non-fallback-tab",
    leafId: "e841ec57-…::C:/Users/…/some-lane@@deadbeef",
  });
  assert.notEqual(raw.result.terminal.tabId, raw.result.terminal.leafId);
  const normalized = normalizeTerminalShow(raw);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});

// ---------------------------------------------------------------------------
// N-j -- result.terminal의 필수 필드 하나씩 결손/빈문자/타입오류.
// ---------------------------------------------------------------------------
const REQUIRED_TERMINAL_FIELDS = [
  "handle",
  "ptyId",
  "worktreeId",
  "worktreePath",
  "tabId",
  "leafId",
];
for (const field of REQUIRED_TERMINAL_FIELDS) {
  test(`N-j: empty-string ${field} is rejected as FIELDS_INCOMPLETE`, () => {
    const normalized = normalizeTerminalShow(
      rawTerminalShowP1({ [field]: "" }),
    );
    assert.equal(normalized.ok, false);
    assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FIELDS_INCOMPLETE);
  });
  test(`N-j: non-string (type error) ${field} is rejected as FIELDS_INCOMPLETE`, () => {
    const normalized = normalizeTerminalShow(
      rawTerminalShowP1({ [field]: 42 }),
    );
    assert.equal(normalized.ok, false);
    assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FIELDS_INCOMPLETE);
  });
}

// ---------------------------------------------------------------------------
// S8 -- title/preview 변조는 판정에 영향을 주지 않고, 결과 객체에도 그
// 필드들이 아예 나타나지 않는다.
// ---------------------------------------------------------------------------
test("S8: tampering title/preview never changes the normalized result, and those keys never appear in the output", () => {
  const base = normalizeTerminalShow(rawTerminalShowP1());
  const tampered = normalizeTerminalShow(
    rawTerminalShowP1({
      title: "[SPOOFED] totally different agent",
      preview: "gpt-9.9 / ? for shortcuts / bypass permissions",
    }),
  );
  assert.equal(base.ok, true);
  assert.equal(tampered.ok, true);
  assert.equal(tampered.paneKeyFromShow, base.paneKeyFromShow);
  assert.equal(Object.prototype.hasOwnProperty.call(tampered, "title"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(tampered, "preview"),
    false,
  );
});

// ---------------------------------------------------------------------------
// paneRuntimeId/rendererGraphEpoch -- 절대 식별자로 쓰이지 않는다(결과
// 객체에 나타나지 않는다).
// ---------------------------------------------------------------------------
test("paneRuntimeId/rendererGraphEpoch never appear in the normalized output (not used as identifiers)", () => {
  const normalized = normalizeTerminalShow(rawTerminalShowP1());
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized, "paneRuntimeId"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized, "rendererGraphEpoch"),
    false,
  );
});

// ===========================================================================
// judgeDispatchBoundSeatProof -- 전체 파이프라인 계약
// ===========================================================================

function validDS(dispatchOverrides = {}) {
  return normalizeDispatchShow(rawDispatchShowP2(dispatchOverrides));
}
function validTS(terminalOverrides = {}) {
  return normalizeTerminalShow(rawTerminalShowP1(terminalOverrides));
}
function validExpected(overrides = {}) {
  return expectedMatchingP1P2(overrides);
}

test("paired-good: fully valid dispatch-show + terminal-show + matching expected -- PROVEN", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: validTS(),
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.PROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.PROVEN);
});

// ---------------------------------------------------------------------------
// N-a/N-b/N-c through the judge: an invalid (ok:false) terminalShow must
// stop the pipeline at TERMINAL_SHOW_INVALID, never reaching PROVEN.
// ---------------------------------------------------------------------------
test("judge + N1 stale handle: an ok:false terminalShow is UNPROVEN with TERMINAL_SHOW_INVALID", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: normalizeTerminalShow(rawTerminalShowN1StaleHandle()),
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.TERMINAL_SHOW_INVALID);
});

// ---------------------------------------------------------------------------
// N-d -- assignee_pane_key와 show composite가 1글자 불일치. 다른 모든
// 조건(handle 일치 등)은 유지해 PANE_KEY_MISMATCH 단독 발동을 증명한다
// (죽은 방어선 방지).
// ---------------------------------------------------------------------------
test("N-d: a 1-character mismatch between assignee_pane_key and the show composite yields UNPROVEN/PANE_KEY_MISMATCH", () => {
  const ts = validTS({
    leafId: "baba3a4b-05b3-42e9-ba76-93ad0ba9e070", // 마지막 글자만 1 -> 0
  });
  assert.notEqual(ts.paneKeyFromShow, validDS().assigneePaneKey);
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: ts,
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.PANE_KEY_MISMATCH);
});

// ---------------------------------------------------------------------------
// N-e (★HYK-294로 의미가 뒤집혔다) -- assignee_handle과 show.handle
// 불일치, pane key는 일치. handle 회전은 정상 동작이므로(dispatch-bound-
// seat-proof.mjs 파일 머리 주석 참조) 이 경우는 이제 PROVEN이어야 한다 --
// handle 불일치만으로 정당한 배달을 거부하지 않는 것이 이번 판정의 핵심
// (coder-task.md §2-1 항목4 ⓔ).
// ---------------------------------------------------------------------------
test("N-e (HYK-294): assignee_handle mismatches show.handle while the pane key still matches -- PROVEN (handle axis removed, rotation tolerated)", () => {
  const ds = validDS({ assignee_handle: "term_different-handle-0000" });
  const ts = validTS();
  assert.equal(ds.assigneePaneKey, ts.paneKeyFromShow);
  assert.notEqual(ds.assigneeHandle, ts.handle);
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: ds,
    terminalShow: ts,
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.PROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.PROVEN);
});

// ---------------------------------------------------------------------------
// N-e2 (★HYK-294 신규) -- assignee_handle 자체가 결손(회전으로 필드가
// 안 채워짐), pane key는 일치. 결손도 값 불일치와 동일하게 더 이상 판정에
// 관여하지 않아야 한다.
// ---------------------------------------------------------------------------
test("N-e2 (HYK-294): assignee_handle itself is missing while the pane key still matches -- PROVEN", () => {
  const ds = validDS({ assignee_handle: undefined });
  const ts = validTS();
  assert.equal(ds.assigneeHandle, undefined);
  assert.equal(ds.assigneePaneKey, ts.paneKeyFromShow);
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: ds,
    terminalShow: ts,
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.PROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.PROVEN);
});

// ---------------------------------------------------------------------------
// N-f -- 다른 worktree의 show 응답(pane key는 우연히 그대로 -- tabId/leafId
// 는 안 건드리고 worktreeId/worktreePath만 바꾼다). task/dispatch id는
// expected와 일치시켜 WORKTREE_MISMATCH 단독 발동을 증명한다.
// ---------------------------------------------------------------------------
test("N-f: a show response from a different worktree (pane key coincidentally unchanged) -- UNPROVEN/WORKTREE_MISMATCH", () => {
  const ts = validTS({
    worktreeId: "f000000-…::C:/Users/…/other-lane",
    worktreePath: "C:/Users/…/other-lane",
  });
  const ds = validDS();
  assert.equal(ds.assigneePaneKey, ts.paneKeyFromShow);
  assert.equal(ds.assigneeHandle, ts.handle);
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: ds,
    terminalShow: ts,
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.WORKTREE_MISMATCH);
});

// ---------------------------------------------------------------------------
// task_id/dispatch_id mismatch -- §2-B5 designed checks, isolated (each
// with all other checks passing) so removing either comparison is caught.
// ---------------------------------------------------------------------------
test("expected.runtimeTaskId mismatch (all else matching) -- UNPROVEN/TASK_ID_MISMATCH", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: validTS(),
    expected: validExpected({ runtimeTaskId: "task_totally-different" }),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.TASK_ID_MISMATCH);
});
test("expected.dispatchId mismatch (all else matching) -- UNPROVEN/DISPATCH_ID_MISMATCH", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: validTS(),
    expected: validExpected({ dispatchId: "ctx_totally-different" }),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.DISPATCH_ID_MISMATCH);
});

// ---------------------------------------------------------------------------
// N-i -- expected.* 결손(각 필드 개별) -- 기본값 통과 금지.
// ---------------------------------------------------------------------------
const EXPECTED_REQUIRED_FIELDS = [
  "harnessTaskId",
  "runtimeTaskId",
  "dispatchId",
  "worktreeId",
  "worktreePath",
];
for (const field of EXPECTED_REQUIRED_FIELDS) {
  test(`N-i: expected.${field} missing yields UNPROVEN/EXPECTED_FIELDS_MISSING (no default-pass)`, () => {
    const expected = validExpected();
    delete expected[field];
    const verdict = judgeDispatchBoundSeatProof({
      dispatchShow: validDS(),
      terminalShow: validTS(),
      expected,
    });
    assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
    assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.EXPECTED_FIELDS_MISSING);
  });
}
test("expected omitted entirely (undefined) yields UNPROVEN/EXPECTED_FIELDS_MISSING", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: validTS(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.EXPECTED_FIELDS_MISSING);
});

// ---------------------------------------------------------------------------
// N-g through the judge -- a terminal-list row (rejected upstream by the
// adapter, so its normalized form is ok:false) must never reach PROVEN.
// ---------------------------------------------------------------------------
test("judge + N-g: a terminal-list-derived (ok:false) terminalShow is UNPROVEN/TERMINAL_SHOW_INVALID", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: normalizeTerminalShow(rawTerminalListRowDisguisedAsShow()),
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.TERMINAL_SHOW_INVALID);
});

// ---------------------------------------------------------------------------
// policy 완화 입력 거부 -- 안전장치를 끄는 매개변수를 얹어도(존재하지
// 않는 매개변수라 조용히 무시된다) 판정에 영향이 없다는 것을 증명한다.
// ---------------------------------------------------------------------------
test("an unrecognized 'policy' argument (e.g. minCorroboration) has zero effect on the verdict -- there is no loosening seam to exploit", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: validTS(),
    expected: validExpected(),
    policy: { minCorroboration: 0, allowMismatch: true },
  });
  assert.equal(verdict.verdict, SEAT_PROOF.PROVEN);
});

// ---------------------------------------------------------------------------
// hasValidDispatchShow -- ds.ok !== true는 fail-closed(DISPATCH_SHOW_INVALID).
// ---------------------------------------------------------------------------
test("dispatchShow.ok !== true (e.g. a raw dispatch-show failure normalized) yields UNPROVEN/DISPATCH_SHOW_INVALID", () => {
  const verdict = judgeDispatchBoundSeatProof({
    dispatchShow: { ok: false },
    terminalShow: validTS(),
    expected: validExpected(),
  });
  assert.equal(verdict.verdict, SEAT_PROOF.UNPROVEN);
  assert.equal(verdict.reasonCode, SEAT_PROOF_REASON.DISPATCH_SHOW_INVALID);
});
