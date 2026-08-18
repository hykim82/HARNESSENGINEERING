import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CONTRACT_VERSION,
  SEAT_PROOF,
  SEAT_PROOF_REASON,
  TERMINAL_SHOW_RAW_FIELD_TYPES,
  DISPATCH_SHOW_RAW_FIELD_TYPES,
  DISPATCH_SHOW_NULLABLE_FIELDS,
  DISPATCH_SHOW_CONSUMED_FIELDS,
  NEGATIVE_CONTROLS,
  SEAM,
} from "./contracts/seat-proof-contract-v1.mjs";

import {
  judgeDispatchBoundSeatProof,
  SEAT_PROOF as SOURCE_SEAT_PROOF,
  SEAT_PROOF_REASON as SOURCE_SEAT_PROOF_REASON,
} from "./dispatch-bound-seat-proof.mjs";
import { normalizeTerminalShow } from "./adapters/terminal-show-adapter.mjs";
import { normalizeDispatchShow } from "./adapters/dispatch-correlation-adapter.mjs";
import {
  rawTerminalShowP1,
  rawDispatchShowP2,
  rawTerminalListRowDisguisedAsShow,
  expectedMatchingP1P2,
} from "./hyk171-cycle4b2c-fixtures.mjs";

import {
  judgeDispatchCorrelation,
  CORRELATION,
  REASON as CORRELATION_REASON,
} from "./dispatch-correlation-core.mjs";
import {
  seatRecord,
  dispatchShow,
  observed,
} from "./hyk171-cycle4b2b2-axisA-fixtures.mjs";

import {
  parseRegistryText,
  recordSeatDispatch,
  SEAT_DISPATCH_REASON,
  SCHEMA_VERSION,
} from "./seat-registry.mjs";
import {
  stableSeatRecord,
  registryWith,
} from "./hyk171-cycle4b2b4-fixtures.mjs";

// HYK-171 사이클4b-2d (coder-task.md §2-C) -- 배정 결속 좌석 증명 계약
// freeze의 동결/타입/카탈로그 테스트. CI 정본 명령(`node --test
// scripts/check/*.test.mjs scripts/relay/*.test.mjs
// scripts/relay/adapters/*.test.mjs`)의 `scripts/relay/*.test.mjs` glob에
// 걸리도록 이 파일을 scripts/relay/ 바로 아래에 둔다 -- 실제 계약 표면은
// scripts/relay/contracts/seat-proof-contract-v1.mjs에 있다(그 경로는 glob
// 밖이라 CI가 그 파일 자체를 직접 실행하지 않는다, coder-task.md §3 참조).

function validDS(overrides = {}) {
  return normalizeDispatchShow(rawDispatchShowP2(overrides));
}
function validTS(overrides = {}) {
  return normalizeTerminalShow(rawTerminalShowP1(overrides));
}
function validExpected(overrides = {}) {
  return expectedMatchingP1P2(overrides);
}

// ---------------------------------------------------------------------------
// 1. 동결 테스트 -- 결과·사유코드 키 집합 고정(추가·삭제·개명 시 RED).
// ---------------------------------------------------------------------------
test("freeze: CONTRACT_VERSION is the fixed string seat-proof/v1", () => {
  assert.equal(CONTRACT_VERSION, "seat-proof/v1");
});

test("freeze: SEAT_PROOF key set is exactly {PROVEN, UNPROVEN}", () => {
  assert.deepEqual(Object.keys(SEAT_PROOF).sort(), ["PROVEN", "UNPROVEN"]);
});

test("freeze: SEAT_PROOF_REASON key set is exactly the 9 measured reason codes", () => {
  assert.deepEqual(
    Object.keys(SEAT_PROOF_REASON).sort(),
    [
      "DISPATCH_SHOW_INVALID",
      "TERMINAL_SHOW_INVALID",
      "EXPECTED_FIELDS_MISSING",
      "PANE_KEY_MISMATCH",
      "HANDLE_MISMATCH",
      "TASK_ID_MISMATCH",
      "DISPATCH_ID_MISMATCH",
      "WORKTREE_MISMATCH",
      "PROVEN",
    ].sort(),
  );
});

test("freeze: the frozen SEAT_PROOF/SEAT_PROOF_REASON values are byte-identical to the source module's (module-load assertion already throws on drift; this re-checks post-load)", () => {
  assert.deepEqual(
    Object.entries(SEAT_PROOF).sort(),
    Object.entries(SOURCE_SEAT_PROOF).sort(),
  );
  assert.deepEqual(
    Object.entries(SEAT_PROOF_REASON).sort(),
    Object.entries(SOURCE_SEAT_PROOF_REASON).sort(),
  );
});

// ---------------------------------------------------------------------------
// 2. 타입 축 -- 원시 키 맵의 타입이 fixture 실측값과 정확히 일치하는지.
// 타입이 바뀌면(예: null <-> string) 여기가 깨진다.
// ---------------------------------------------------------------------------
test("type axis: every TERMINAL_SHOW_RAW_FIELD_TYPES entry matches the measured P1 fixture's runtime typeof", () => {
  const raw = rawTerminalShowP1();
  for (const [field, type] of Object.entries(TERMINAL_SHOW_RAW_FIELD_TYPES)) {
    assert.equal(
      typeof raw.result.terminal[field],
      type,
      `field ${field} expected typeof ${type}`,
    );
  }
});

test("type axis: TERMINAL_SHOW_RAW_FIELD_TYPES key set matches the measured P1 fixture's key set exactly (no drift either direction)", () => {
  const raw = rawTerminalShowP1();
  assert.deepEqual(
    Object.keys(TERMINAL_SHOW_RAW_FIELD_TYPES).sort(),
    Object.keys(raw.result.terminal).sort(),
  );
});

test("type axis: every DISPATCH_SHOW_RAW_FIELD_TYPES entry matches the measured P2 fixture's runtime typeof", () => {
  const raw = rawDispatchShowP2();
  for (const [field, type] of Object.entries(DISPATCH_SHOW_RAW_FIELD_TYPES)) {
    assert.equal(
      typeof raw.result.dispatch[field],
      type,
      `field ${field} expected typeof ${type}`,
    );
  }
});

test("type axis: DISPATCH_SHOW_NULLABLE_FIELDS are measured exactly null in the P2 fixture", () => {
  const raw = rawDispatchShowP2();
  for (const field of DISPATCH_SHOW_NULLABLE_FIELDS) {
    assert.equal(raw.result.dispatch[field], null);
  }
});

test("type axis: DISPATCH_SHOW_RAW_FIELD_TYPES + DISPATCH_SHOW_NULLABLE_FIELDS together cover the P2 fixture's key set exactly (no drift either direction)", () => {
  const raw = rawDispatchShowP2();
  const declared = [
    ...Object.keys(DISPATCH_SHOW_RAW_FIELD_TYPES),
    ...DISPATCH_SHOW_NULLABLE_FIELDS,
  ].sort();
  assert.deepEqual(declared, Object.keys(raw.result.dispatch).sort());
});

// ---------------------------------------------------------------------------
// 3. 카탈로그 완전성 -- §2-B의 8개 ID가 전부 있어야 한다(★HYK-294로
// WRONG_HANDLE/ROTATED_HANDLE 2개를 뺐다 -- 이유는
// contracts/seat-proof-contract-v1.mjs의 NEGATIVE_CONTROLS 머리 주석,
// 그 회전-관용 동작 자체는 아래 §6-b의 행동 테스트가 커버한다).
// ---------------------------------------------------------------------------
const REQUIRED_CATALOG_IDS = [
  "STALE_HANDLE",
  "WRONG_PANE",
  "WRONG_WORKTREE",
  "BEFORE_AFTER_TERMINATION",
  "LIST_SHOW_MISMATCH",
  "RECORD_TAMPERED",
  "RECORD_FIELD_MISSING",
  "DUPLICATE_PANE",
];

test("catalog completeness: NEGATIVE_CONTROLS has exactly the 8 required IDs, no more, no fewer", () => {
  assert.deepEqual(
    NEGATIVE_CONTROLS.map((c) => c.id).sort(),
    [...REQUIRED_CATALOG_IDS].sort(),
  );
});

test("catalog completeness: every entry declares description/sourceModule/sourceJudge/expectedOutcome", () => {
  for (const entry of NEGATIVE_CONTROLS) {
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0, `${entry.id}: empty description`);
    assert.equal(typeof entry.sourceModule, "string");
    assert.equal(typeof entry.sourceJudge, "string");
    assert.equal(typeof entry.expectedOutcome, "string");
  }
});

// ---------------------------------------------------------------------------
// 4. 카탈로그 연결성 -- 각 ID가 실제 프로덕션 판정 함수를 그 시나리오
// fixture로 구동한 실행 결과와 정확히 일치함을 증명한다. "문자열이
// 존재한다" 수준이 아니라, 실제로 그 판정 함수를 호출해 나온 verdict를
// 카탈로그의 expectedOutcome과 대조한다 -- CONNECTIVITY에 10개 키가 모두
// 있어야 하고(catalog ID 누락 감지), 각 실행 결과가 어긋나면 RED다.
// ---------------------------------------------------------------------------
function outcome(verdict, reason) {
  return `${verdict}/${reason}`;
}

const CONNECTIVITY = {
  STALE_HANDLE() {
    const v = judgeDispatchBoundSeatProof({
      dispatchShow: validDS(),
      terminalShow: normalizeTerminalShow(
        // N1 스타일 실측 응답 형태 -- 낡은 handle 오류가 이 형태로 옴.
        {
          id: "req-stale",
          ok: false,
          error: {
            code: "terminal_handle_stale",
            message: "terminal_handle_stale",
          },
          _meta: { runtimeId: "runtimeMain" },
        },
      ),
      expected: validExpected(),
    });
    return outcome(v.verdict, v.reasonCode);
  },
  WRONG_PANE() {
    const ts = validTS({
      leafId: "baba3a4b-05b3-42e9-ba76-93ad0ba9e070", // 마지막 글자만 다름
    });
    assert.notEqual(ts.paneKeyFromShow, validDS().assigneePaneKey);
    const v = judgeDispatchBoundSeatProof({
      dispatchShow: validDS(),
      terminalShow: ts,
      expected: validExpected(),
    });
    return outcome(v.verdict, v.reasonCode);
  },
  WRONG_WORKTREE() {
    const ts = validTS({
      worktreeId: "f0000000-…::C:/Users/…/other-lane",
      worktreePath: "C:/Users/…/other-lane",
    });
    const ds = validDS();
    assert.equal(ds.assigneePaneKey, ts.paneKeyFromShow);
    assert.equal(ds.assigneeHandle, ts.handle);
    const v = judgeDispatchBoundSeatProof({
      dispatchShow: ds,
      terminalShow: ts,
      expected: validExpected(),
    });
    return outcome(v.verdict, v.reasonCode);
  },
  BEFORE_AFTER_TERMINATION() {
    const r = judgeDispatchCorrelation({
      seatRecord: seatRecord({ taskId: "taskOld", dispatchId: "dispatchOld" }),
      dispatchShow: dispatchShow(),
      observed: observed(),
    });
    assert.equal(r.verdict, CORRELATION.MISMATCH);
    assert.equal(r.reason, CORRELATION_REASON.INCARNATION_MISMATCH);
    return outcome(r.verdict, r.reason);
  },
  LIST_SHOW_MISMATCH() {
    const v = judgeDispatchBoundSeatProof({
      dispatchShow: validDS(),
      terminalShow: normalizeTerminalShow(rawTerminalListRowDisguisedAsShow()),
      expected: validExpected(),
    });
    return outcome(v.verdict, v.reasonCode);
  },
  RECORD_TAMPERED() {
    const r = parseRegistryText("{not valid json at all");
    return `ok:${r.ok}/${r.reason}`;
  },
  RECORD_FIELD_MISSING() {
    const r = parseRegistryText(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION }), // seats 배열 결손
    );
    return `ok:${r.ok}/${r.reason}`;
  },
  DUPLICATE_PANE() {
    const registry = registryWith(
      stableSeatRecord({ ptyId: "ptyA", handle: "termA" }),
      stableSeatRecord({ ptyId: "ptyB", handle: "termB" }), // 같은 worktreePath
    );
    const r = recordSeatDispatch(registry, {
      worktreePath: "C:/seatMain/path",
      assigneePaneKey: "seatMain-tab:seatMain-leaf",
      harnessTaskId: "h1",
      runtimeTaskId: "task1",
      dispatchId: "dispatch1",
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, SEAT_DISPATCH_REASON.AMBIGUOUS_TARGET);
    return `ok:${r.ok}/${r.reason}`;
  },
};

test("catalog connectivity: CONNECTIVITY declares an executable check for exactly the 8 catalog IDs (no ID left unverified)", () => {
  assert.deepEqual(
    Object.keys(CONNECTIVITY).sort(),
    [...REQUIRED_CATALOG_IDS].sort(),
  );
});

for (const entry of NEGATIVE_CONTROLS) {
  test(`catalog connectivity: ${entry.id} -- real judge output matches the declared expectedOutcome ("${entry.expectedOutcome}")`, () => {
    const check = CONNECTIVITY[entry.id];
    assert.equal(
      typeof check,
      "function",
      `no connectivity check for ${entry.id}`,
    );
    const actual = check();
    assert.equal(actual, entry.expectedOutcome);
  });
}

test("catalog: all 8 outcomes are fail-closed -- none is a PROVEN/OWNED/success-shaped verdict", () => {
  const successShapes = ["PROVEN/PROVEN", "OWNED", "ok:true"];
  for (const entry of NEGATIVE_CONTROLS) {
    for (const shape of successShapes) {
      assert.ok(
        !entry.expectedOutcome.startsWith(shape),
        `${entry.id}: expectedOutcome "${entry.expectedOutcome}" looks like a pass, not fail-closed`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4-b (★HYK-294 신규) -- WRONG_HANDLE/ROTATED_HANDLE을 §3 카탈로그에서
// 뺀 만큼, 그 시나리오의 실제 동작(더 이상 반례가 아니라 이번 판정의
// 핵심)을 여기서 직접 단언한다. hyk171-cycle4b2c-mutation.test.mjs의
// N-e/N-e2가 같은 사실을 판정 함수 레벨에서 이미 커버하지만, 이 계약
// 파일 스위트 안에서도 독립적으로 재확인해 "카탈로그에서 뺀 것 = 몰래
// 지운 것"이 아니라는 근거를 남긴다.
// ---------------------------------------------------------------------------
test("HYK-294: assignee_handle differs from terminal-show's handle but paneKey matches -- PROVEN (handle axis removed)", () => {
  const ds = validDS({ assignee_handle: "term_different-handle-0000" });
  const ts = validTS();
  assert.equal(ds.assigneePaneKey, ts.paneKeyFromShow);
  assert.notEqual(ds.assigneeHandle, ts.handle);
  const v = judgeDispatchBoundSeatProof({
    dispatchShow: ds,
    terminalShow: ts,
    expected: validExpected(),
  });
  assert.equal(v.verdict, SEAT_PROOF.PROVEN);
  assert.equal(v.reasonCode, SEAT_PROOF_REASON.PROVEN);
});

test("HYK-294: assignee_handle itself is missing (rotated away) but paneKey matches -- PROVEN", () => {
  const ds = normalizeDispatchShow(
    rawDispatchShowP2({ assignee_handle: undefined }),
  );
  assert.equal(ds.assigneeHandle, undefined);
  const ts = validTS();
  assert.equal(ds.assigneePaneKey, ts.paneKeyFromShow);
  const v = judgeDispatchBoundSeatProof({
    dispatchShow: ds,
    terminalShow: ts,
    expected: validExpected(),
  });
  assert.equal(v.verdict, SEAT_PROOF.PROVEN);
  assert.equal(v.reasonCode, SEAT_PROOF_REASON.PROVEN);
});

// ---------------------------------------------------------------------------
// 5. seam -- 이름/방향만 선언돼 있는지(함수 결선 0 -- 값이 문자열이어야
// 하고, provider/consumer 둘 다 채워져 있어야 한다).
// ---------------------------------------------------------------------------
test("SEAM declares provider/consumer as non-empty strings only (no function wiring)", () => {
  assert.equal(typeof SEAM.provider, "string");
  assert.ok(SEAM.provider.length > 0);
  assert.equal(typeof SEAM.consumer, "string");
  assert.ok(SEAM.consumer.length > 0);
  assert.deepEqual(Object.keys(SEAM).sort(), ["consumer", "provider"]);
});

// ---------------------------------------------------------------------------
// 6. 금지어 검사 -- scripts/relay/contracts/ 아래 파일에 §0 금지어가 0건.
// ---------------------------------------------------------------------------
const BANNED_PHRASES = [
  "생성 영수증",
  "provenance proof",
  "변조 방지",
  "tamper-proof",
  "우리가 만들었다는 증명",
];

function contractsDir() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "contracts");
}

test("banned words: scripts/relay/contracts/ files contain zero occurrences of the banned naming (raw creation response record is the only allowed term)", () => {
  const dir = contractsDir();
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".mjs") || f.endsWith(".md"),
  );
  assert.ok(files.length > 0, "expected at least one file under contracts/");
  for (const file of files) {
    const text = readFileSync(path.join(dir, file), "utf8");
    for (const banned of BANNED_PHRASES) {
      assert.ok(
        !text.includes(banned),
        `${file} contains banned phrase "${banned}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 7 (재작업1, coder-task.md 재작업1 §2, REVIEW P1 대응) --
// DISPATCH_SHOW_CONSUMED_FIELDS를 행동 기반으로 load-bearing하게 만든다.
//
// REVIEW P1이 실측한 문제: 이 export는 선언만 있고 생산 코드/테스트 어느
// 쪽도 참조하지 않아 블록 전체를 지워도 CI가 완전 GREEN이었다(죽은
// 방어선). 정규식/문자열 스캔이 아니라 실제 프로덕션 판정 함수를 구동해
// 양방향으로 대조한다:
//
// 1. (양성) 선언된 각 필드를 변조하면 judgeDispatchBoundSeatProof의
//    실제 verdict가 baseline(PROVEN)에서 벗어나야 한다 -- 그렇지 않으면
//    "이 필드가 소비된다"는 선언이 거짓이다.
// 2. (음성, 반대 방향) 선언에 없는 나머지 raw 필드(status/failure_count/
//    dispatched_at/completed_at/created_at/last_failure/
//    last_heartbeat_at)를 변조해도 verdict가 그대로여야 한다 -- 바뀌면
//    그 필드가 실제로는 소비되는데 목록에서 빠진 것이다.
//
// 이 재작업에서 실제로 잡힌 것: 원래 목록엔 `task_id`/`assignee_handle`/
// `assignee_pane_key` 3개뿐이었고 `id`(-> dispatchId, DISPATCH_ID_MISMATCH
// 비교에 쓰임)가 빠져 있었다 -- 아래 반대 방향 테스트가 그 누락을 그대로
// RED로 잡아냈다(재구성이 아니라 실제 실행으로 발견, §8 보고 참조).
// ---------------------------------------------------------------------------

// 필드마다 baseline(rawDispatchShowP2()의 실측값)과 다른 변조값 -- 문자열
// 필드는 다른 문자열, 숫자 필드는 다른 숫자, null 필드는 non-null 문자열.
const DISPATCH_SHOW_MUTATION_VALUES = Object.freeze({
  id: "ctx_mutated-different",
  task_id: "task_mutated-different",
  assignee_handle: "term_mutated-different",
  assignee_pane_key: "mutated-tab:mutated-leaf",
  status: "mutated-status",
  failure_count: 999,
  dispatched_at: "1999-01-01 00:00:00",
  completed_at: "1999-01-01 00:00:00",
  created_at: "1999-01-01 00:00:00",
  last_failure: "mutated-non-null",
  last_heartbeat_at: "mutated-non-null",
});

function dispatchShowBaselineOutcome() {
  const v = judgeDispatchBoundSeatProof({
    dispatchShow: validDS(),
    terminalShow: validTS(),
    expected: validExpected(),
  });
  return outcome(v.verdict, v.reasonCode);
}

function outcomeWithDispatchShowFieldMutated(field) {
  assert.ok(
    field in DISPATCH_SHOW_MUTATION_VALUES,
    `no mutation value registered for raw dispatch-show field "${field}"`,
  );
  const ds = normalizeDispatchShow(
    rawDispatchShowP2({ [field]: DISPATCH_SHOW_MUTATION_VALUES[field] }),
  );
  const v = judgeDispatchBoundSeatProof({
    dispatchShow: ds,
    terminalShow: validTS(),
    expected: validExpected(),
  });
  return outcome(v.verdict, v.reasonCode);
}

test("sanity: the baseline (unmutated) P1/P2 pairing is PROVEN -- the fixed point every DISPATCH_SHOW_CONSUMED_FIELDS mutation test below diffs against", () => {
  assert.equal(dispatchShowBaselineOutcome(), "PROVEN/PROVEN");
});

for (const field of DISPATCH_SHOW_CONSUMED_FIELDS) {
  test(`DISPATCH_SHOW_CONSUMED_FIELDS positive: mutating declared-consumed raw field "${field}" actually flips judgeDispatchBoundSeatProof's verdict away from PROVEN (proves it is load-bearing, not just declared)`, () => {
    const mutated = outcomeWithDispatchShowFieldMutated(field);
    assert.notEqual(mutated, dispatchShowBaselineOutcome());
  });
}

// 재작업2 (coder-task.md 재작업2 §2 조건B, REVIEW P2 대응) -- 이 목록은
// **파생하지 않고 명시 선언**한다. 이전 버전은
// `ALL_DISPATCH_SHOW_RAW_FIELDS.filter(f => !DISPATCH_SHOW_CONSUMED_FIELDS
// .includes(f))`로 파생했는데, 그러면 아래 완전성 테스트의 등식이
// 구성상(tautologically) 항상 참이 되어 독립 검출력이 0이었다(REVIEW
// P1, HYK-171-cycle4b2d-review-2 rejected 사유). 이 배열이 fixture 실측
// 키와 어긋나면(벤더가 필드를 추가/삭제했는데 여기를 안 고치면) 아래
// 완전성 테스트가 RED가 되어야 한다 -- 그러려면 이 배열 자체가 fixture나
// DISPATCH_SHOW_CONSUMED_FIELDS 어느 쪽에서도 파생되지 않은, 독립적으로
// 손으로 쓴 진실이어야 한다.
// ★HYK-294: `assignee_handle`이 여기 합류했다 -- handle 축이 판정에서
// 빠지면서 이 필드를 변조해도 verdict가 더 이상 바뀌지 않는다(위
// DISPATCH_SHOW_CONSUMED_FIELDS 쪽 HYK-294 주석 참조).
const NOT_CONSUMED_DISPATCH_SHOW_FIELDS = [
  "assignee_handle",
  "status",
  "failure_count",
  "dispatched_at",
  "completed_at",
  "created_at",
  "last_failure",
  "last_heartbeat_at",
];

for (const field of NOT_CONSUMED_DISPATCH_SHOW_FIELDS) {
  test(`DISPATCH_SHOW_CONSUMED_FIELDS reverse-direction: raw field "${field}" is declared NOT consumed, and mutating it truly leaves judgeDispatchBoundSeatProof's verdict unchanged (would catch a genuinely-consumed field missing from the list)`, () => {
    const mutated = outcomeWithDispatchShowFieldMutated(field);
    assert.equal(
      mutated,
      dispatchShowBaselineOutcome(),
      `field "${field}" is declared NOT consumed but mutating it changed the verdict -- it belongs in DISPATCH_SHOW_CONSUMED_FIELDS`,
    );
  });
}

// 재작업2 (coder-task.md 재작업2 §2 조건A, REVIEW P1 대응) -- 비교 기준을
// 계약 타입 맵(DISPATCH_SHOW_RAW_FIELD_TYPES/DISPATCH_SHOW_NULLABLE_FIELDS,
// 계약 파일이 스스로 선언한 값)에서 fixture의 **실측 원시 키 집합**으로
// 옮긴다. `rawDispatchShowP2().result.dispatch`는 ORCH가 실 CLI에서
// 캡처한 원문(hyk171-cycle4b2c-fixtures.mjs 헤더 참조)이므로 계약 파일과
// 독립된 출처다 -- 벤더가 실제로 키를 추가/삭제해 이 fixture가 갱신되면,
// 계약의 CONSUMED/NOT_CONSUMED 선언 두 목록의 합이 그 갱신과 어긋나야
// RED가 난다(더 이상 ALL_DISPATCH_SHOW_RAW_FIELDS라는 계약 파생값과
// 자기 자신을 비교하지 않는다).
test("DISPATCH_SHOW_CONSUMED_FIELDS + explicit NOT_CONSUMED cover the fixture's MEASURED raw dispatch-show key set exactly (comparison basis is the fixture, not the contract's own type map -- drift between contract and vendor reality is what this test exists to catch)", () => {
  const measuredRawFields = Object.keys(rawDispatchShowP2().result.dispatch);
  assert.deepEqual(
    [...DISPATCH_SHOW_CONSUMED_FIELDS, ...NOT_CONSUMED_DISPATCH_SHOW_FIELDS]
      .slice()
      .sort(),
    measuredRawFields.slice().sort(),
  );
});
