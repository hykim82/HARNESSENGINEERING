// HYK-171 사이클4b-2d (coder-task.md §2-A) -- 배정 결속 좌석 증명(dispatch-
// bound seat proof) 계약의 얼린 표면(seat-proof/v1).
//
// 왜 이 파일이 필요한가(coder-task.md §1): 계약의 실체(dispatch-bound-
// seat-proof.mjs / terminal-show-adapter.mjs / dispatch-correlation-core.mjs
// 등)는 이미 master에 있지만 코드 여기저기에 흩어져 있고 "무엇이 계약인지"
// 가 명시돼 있지 않다. supervisor v1이 여기에 결선하려면 얼린 표면이
// 필요하다 -- 이 파일은 그 표면이다.
//
// ★증명 범위(원본 dispatch-bound-seat-proof.mjs 헤더 그대로 승계): 이
// 계약은 "우리가 이 좌석을 만들었다"를 증명하지 않는다. 증명하는 것은
// "Orca가 이 task/dispatch를 이 좌석에 배정했고, 그 좌석의 pty/worktree가
// 이것이다"뿐이다.
//
// ★프로덕션 결선 0: 이 파일은 판정 함수를 호출하지도, 재노출(re-export)
// 하지도 않는다. 재노출만으로는 "얼렸다"가 되지 않는다 -- 원본이 값을
// 바꾸면 이 파일의 재선언과 어긋나야 하므로, 아래 값들은 원본에서 복사해
// 다시 선언하고 모듈 로드 시점에 원본과 런타임 대조한다(불일치 시 throw).

import {
  SEAT_PROOF as SOURCE_SEAT_PROOF,
  SEAT_PROOF_REASON as SOURCE_SEAT_PROOF_REASON,
} from "../dispatch-bound-seat-proof.mjs";

export const CONTRACT_VERSION = "seat-proof/v1";

// ---------------------------------------------------------------------------
// 1. 판정 결과·사유코드 전량 열거 (재선언 -- re-export 아님).
// ---------------------------------------------------------------------------
export const SEAT_PROOF = Object.freeze({
  PROVEN: "PROVEN",
  UNPROVEN: "UNPROVEN",
});

export const SEAT_PROOF_REASON = Object.freeze({
  DISPATCH_SHOW_INVALID: "DISPATCH_SHOW_INVALID",
  TERMINAL_SHOW_INVALID: "TERMINAL_SHOW_INVALID",
  EXPECTED_FIELDS_MISSING: "EXPECTED_FIELDS_MISSING",
  PANE_KEY_MISMATCH: "PANE_KEY_MISMATCH",
  HANDLE_MISMATCH: "HANDLE_MISMATCH",
  TASK_ID_MISMATCH: "TASK_ID_MISMATCH",
  DISPATCH_ID_MISMATCH: "DISPATCH_ID_MISMATCH",
  WORKTREE_MISMATCH: "WORKTREE_MISMATCH",
  PROVEN: "PROVEN",
});

function sortedEntries(obj) {
  return Object.keys(obj)
    .sort()
    .map((k) => [k, obj[k]]);
}

// 원본과 이 파일의 재선언이 키 집합·값 둘 다 정확히 같은지 대조한다.
// 원본이 키를 추가/삭제/개명하거나 값을 바꾸면 여기가 즉시 throw한다(모듈
// import 시점 -- 이 파일을 쓰는 어떤 코드도 조용히 드리프트를 통과시키지
// 못한다).
function assertFrozenMatchesSource(name, frozen, source) {
  const frozenEntries = JSON.stringify(sortedEntries(frozen));
  const sourceEntries = JSON.stringify(sortedEntries(source));
  if (frozenEntries !== sourceEntries) {
    throw new Error(
      `seat-proof-contract-v1: frozen ${name} has drifted from ` +
        `dispatch-bound-seat-proof.mjs's ${name} -- frozen=${frozenEntries} ` +
        `source=${sourceEntries}`,
    );
  }
}

assertFrozenMatchesSource("SEAT_PROOF", SEAT_PROOF, SOURCE_SEAT_PROOF);
assertFrozenMatchesSource(
  "SEAT_PROOF_REASON",
  SEAT_PROOF_REASON,
  SOURCE_SEAT_PROOF_REASON,
);

// ---------------------------------------------------------------------------
// 2. 원시 응답 필수 키·타입 맵 (hyk171-cycle4b2c-mutation.test.mjs의 schema
// lock 값을 정본으로 재선언 -- 그 실측 원문은
// scripts/relay/hyk171-cycle4b2c-fixtures.mjs P1/P2 참조).
// ---------------------------------------------------------------------------

// `orca terminal show --json` result.terminal (14키 실측).
export const TERMINAL_SHOW_RAW_FIELD_TYPES = Object.freeze({
  branch: "string",
  connected: "boolean",
  handle: "string",
  lastOutputAt: "number",
  leafId: "string",
  paneRuntimeId: "number", // 실측값 -1 -- 식별자로 쓰지 않는다.
  preview: "string", // S8: 값은 계약이 아니다(화면 문자열), 타입만 계약.
  ptyId: "string",
  rendererGraphEpoch: "number", // 실측값 0 -- 식별자로 쓰지 않는다.
  tabId: "string",
  title: "string", // S8: 값은 계약이 아니다(화면 문자열), 타입만 계약.
  worktreeId: "string",
  worktreePath: "string",
  writable: "boolean",
});

// 배정 결속 좌석 증명이 실제로 읽는 부분집합(dispatch-bound-seat-
// proof.mjs / terminal-show-adapter.mjs REQUIRED_FIELDS).
export const TERMINAL_SHOW_CONSUMED_FIELDS = Object.freeze([
  "handle",
  "ptyId",
  "worktreeId",
  "worktreePath",
  "tabId",
  "leafId",
]);

// `orca orchestration dispatch-show --json` result.dispatch (11키 실측).
export const DISPATCH_SHOW_RAW_FIELD_TYPES = Object.freeze({
  id: "string",
  task_id: "string",
  assignee_handle: "string",
  assignee_pane_key: "string",
  status: "string",
  failure_count: "number",
  dispatched_at: "string",
  completed_at: "string",
  created_at: "string",
});

// null이 의미 있는 관측값인 필드(값 자체가 계약 -- 문자열로 바뀌면 위반,
// hyk171-cycle4b2c-mutation.test.mjs P2_DISPATCH_NULL_FIELDS 참조).
export const DISPATCH_SHOW_NULLABLE_FIELDS = Object.freeze([
  "last_failure",
  "last_heartbeat_at",
]);

// 배정 결속 좌석 증명이 실제로 읽는 부분집합(dispatch-bound-seat-
// proof.mjs가 normalizeDispatchShow를 거쳐 읽는 4개 raw 필드 -- `id`는
// dispatchId로 정규화돼 DISPATCH_ID_MISMATCH 비교에 쓰인다. 재작업1(REVIEW
// P1) 이전 버전은 이 `id`를 빠뜨린 채로 있었다 -- 아래 §2-C의 행동 기반
// 연결성 테스트가 그 누락 자체를 RED로 잡아낸다). status/failure_count/
// dispatched_at/completed_at/created_at/last_failure/last_heartbeat_at은
// normalizeDispatchShow가 애초에 정규화 결과에 옮기지 않으므로 판정에
// 도달조차 하지 않는다(§2-C 반대 방향 테스트가 이 사실을 실측한다).
export const DISPATCH_SHOW_CONSUMED_FIELDS = Object.freeze([
  "id",
  "task_id",
  "assignee_handle",
  "assignee_pane_key",
]);

// ---------------------------------------------------------------------------
// 3. 반례 세트 카탈로그(§2-B). 기존 4b-2c/4b-2b 계열이 이미 다루는 7개 +
// 이번 사이클 SV-8 신규 3개 = 10개. 각 항목의 실제 연결(모듈·실행 결과)은
// seat-proof-contract-v1.test.mjs의 카탈로그 연결성 테스트가 이 파일의
// `expectedOutcome` 문자열과 실행 결과를 정확히 대조해 증명한다 -- 문자열
// 존재만으로 연결을 주장하지 않는다.
//
// `expectedOutcome`은 `<verdict>/<reasonCode>` 형태의 사람이 읽는 표기다.
// 전부 fail-closed(판정불가·거부)이며 어떤 항목도 "통과"(PROVEN 계열의
// 성공 verdict)를 기대하지 않는다.
// ---------------------------------------------------------------------------
export const NEGATIVE_CONTROLS = Object.freeze([
  Object.freeze({
    id: "WRONG_HANDLE",
    description:
      "dispatch-show의 assignee_handle이 terminal-show의 handle과 다르다" +
      "(pane key는 일치) -- 다른 좌석의 handle을 자기 것처럼 제시.",
    sourceModule: "scripts/relay/dispatch-bound-seat-proof.mjs",
    sourceJudge: "judgeDispatchBoundSeatProof",
    expectedOutcome: "UNPROVEN/HANDLE_MISMATCH",
  }),
  Object.freeze({
    id: "STALE_HANDLE",
    description:
      "낡은(직전) handle로 terminal show를 호출 -- 벤더 응답이 " +
      "terminal_handle_stale 오류를 낸다(형식 오류·미존재 handle과 " +
      "구별 불가, 단일 사유 코드로 접힌다).",
    sourceModule: "scripts/relay/adapters/terminal-show-adapter.mjs",
    sourceJudge: "normalizeTerminalShow -> judgeDispatchBoundSeatProof",
    expectedOutcome: "UNPROVEN/TERMINAL_SHOW_INVALID",
  }),
  Object.freeze({
    id: "ROTATED_HANDLE",
    description:
      "dispatch-show의 assignee_handle 자체가 결손(회전으로 해당 " +
      "필드가 채워지지 않음) -- WRONG_HANDLE(값이 다름)과 달리 " +
      "'값 자체가 없음' 분기를 단독으로 격리한다.",
    sourceModule: "scripts/relay/dispatch-bound-seat-proof.mjs",
    sourceJudge: "judgeDispatchBoundSeatProof",
    expectedOutcome: "UNPROVEN/HANDLE_MISMATCH",
  }),
  Object.freeze({
    id: "WRONG_PANE",
    description:
      "assignee_pane_key와 terminal-show의 `${tabId}:${leafId}` " +
      "합성값이 1글자라도 다르다.",
    sourceModule: "scripts/relay/dispatch-bound-seat-proof.mjs",
    sourceJudge: "judgeDispatchBoundSeatProof",
    expectedOutcome: "UNPROVEN/PANE_KEY_MISMATCH",
  }),
  Object.freeze({
    id: "WRONG_WORKTREE",
    description:
      "pane key/handle은 일치하지만 terminal-show의 worktreeId/" +
      "worktreePath가 호출자의 expected와 다르다(다른 worktree의 " +
      "응답을 오배정).",
    sourceModule: "scripts/relay/dispatch-bound-seat-proof.mjs",
    sourceJudge: "judgeDispatchBoundSeatProof",
    expectedOutcome: "UNPROVEN/WORKTREE_MISMATCH",
  }),
  Object.freeze({
    id: "BEFORE_AFTER_TERMINATION",
    description:
      "대장(seatRecord)이 과거 세대의 task/dispatch id를 여전히 들고 " +
      "있는데, dispatch-show/관측은 새 세대를 가리킨다(paneKey 리터럴은 " +
      "우연히 같음) -- 종료 전/후 세대가 뒤섞인 stale grant.",
    sourceModule: "scripts/relay/dispatch-correlation-core.mjs",
    sourceJudge: "judgeDispatchCorrelation",
    expectedOutcome: "MISMATCH/INCARNATION_MISMATCH",
  }),
  Object.freeze({
    id: "LIST_SHOW_MISMATCH",
    description:
      "`terminal list` 행(result.terminals, 복수)을 `terminal show` " +
      "자리에 통째로 넣는다 -- 구조 자체가 달라 결속 근거로 쓰일 수 없다.",
    sourceModule: "scripts/relay/adapters/terminal-show-adapter.mjs",
    sourceJudge: "normalizeTerminalShow -> judgeDispatchBoundSeatProof",
    expectedOutcome: "UNPROVEN/TERMINAL_SHOW_INVALID",
  }),
  Object.freeze({
    id: "RECORD_TAMPERED",
    description:
      "보존된 원시 기록 파일(registry)이 유효한 JSON이 아니게 변조됨 " +
      "-- 파싱 자체가 실패한다.",
    sourceModule: "scripts/relay/seat-registry.mjs",
    sourceJudge: "parseRegistryText",
    expectedOutcome: "ok:false/corrupt-json",
  }),
  Object.freeze({
    id: "RECORD_FIELD_MISSING",
    description:
      "보존된 원시 기록의 필수 구조(schemaVersion 일치 + seats 배열)가 " +
      "결손 -- 파싱은 성공하지만 스키마가 기대와 다르다.",
    sourceModule: "scripts/relay/seat-registry.mjs",
    sourceJudge: "parseRegistryText",
    expectedOutcome: "ok:false/schema-mismatch",
  }),
  Object.freeze({
    id: "DUPLICATE_PANE",
    description:
      "같은 worktreePath를 가리키는 안정 레코드가 대장에 2개 이상 " +
      "나타난다 -- 대상을 유일하게 선정할 수 없어 배정 결속을 거부한다.",
    sourceModule: "scripts/relay/seat-registry.mjs",
    sourceJudge: "recordSeatDispatch",
    expectedOutcome: "ok:false/SEAT_DISPATCH_AMBIGUOUS_TARGET",
  }),
]);

// ---------------------------------------------------------------------------
// 4. provider/consumer seam -- 이름과 방향만 선언한다. 함수 결선·호출 0
// (§0 비타협 -- 프로덕션 결선은 supervisor v1 몫이다).
// ---------------------------------------------------------------------------
export const SEAM = Object.freeze({
  provider:
    "scripts/relay/dispatch-bound-seat-proof.mjs#judgeDispatchBoundSeatProof",
  consumer:
    "supervisor-v1 (NOT YET WIRED -- HYK-171 4b-2d 결선은 이번 사이클 범위 " +
    "밖, 이 계약은 그 결선이 참조할 얼린 표면일 뿐이다)",
});
