// HYK-390 + HYK-392 (판정 2026-11-17 14:05 ②③④): 영수증 «진위 그림자 판정».
// 소비(checkRelayHandshake)가 387 존재 축을 통과한 뒤 · G1 대조 앞에서 그
// 영수증 줄이 진짜 배달 기록인지 «판정만 기록»한다. 그림자는 소비의 ok · 사유
// · 반환값 · 종료 코드를 한 글자도 바꾸지 않는다(차단 0).
//
// 모든 시험 = 프로덕션 소비 진입점(checkRelayHandshake 함수 또는 실 CLI) 구동 +
// 합성 원장(mkdtemp) + 주입 stub(실 orca 0). 각 시험은 두 단언을 함께 건다:
// ⓐ 그림자 기록 값 ⓑ 소비 결과(ok · 사유)가 그림자 없는 소비와 같다.
//
// ⛔이 파일은 일부러 relay-handshake.mjs 의 checkRelayHandshake «만» import
// 한다 -- 그림자 모듈이 아직 없는 base 위에서도 로드되어 «그림자 기록이
// 없음»으로 빨갛게 되도록(RED 먼저). 그림자 파일 경로는 문자열 규칙으로
// 직접 계산한다(원장 경로 + ".auth-shadow.jsonl", 원장 경로가 없으면
// <harnessDir>/dispatch-receipt-auth-shadow.jsonl).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SHADOW_SUFFIX = ".auth-shadow.jsonl";
const SHADOW_FALLBACK_NAME = "dispatch-receipt-auth-shadow.jsonl";

const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "hyk390-shadow-"));
after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function formatKst(ms) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}
function formatKstSec(ms) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${formatKst(ms)}:${p2(d.getUTCSeconds())} KST`;
}

const NOW_MS = Date.now();
const DROPPED_MS = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000;
const DONE_MS = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000;
const RECORDED_MS = DROPPED_MS + 60 * 1000;

const LABEL = "HYK-390-T";
const RUNTIME_ID = "task_aaaaaaaaaaaa";
const DISPATCH_ID = "ctx_real_1";
const PANE =
  "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";
const OTHER_PANE =
  "99999999-9999-9999-9999-999999999999:88888888-8888-8888-8888-888888888888";

const V = {
  AUTHENTIC: "AUTHENTIC",
  UNAUTHENTIC: "DISPATCH_RECORD_UNAUTHENTIC",
  LOOKUP_FAILED: "DISPATCH_AUTH_LOOKUP_FAILED",
  POINTER_MISMATCH: "DISPATCH_LEDGER_POINTER_MISMATCH",
  POINTER_ABSENT: "LEDGER_POINTER_ABSENT",
  HAND_CORRECTION: "HAND_CORRECTION_EXISTING",
};

// 합성 «좌석 워크트리»: <wt>/.harness 가 harnessDir, 진짜 원장은 워크트리 «밖»
// <root>/ctrl/ 에 둔다(관제실 모사). 합성 경로만 쓴다.
function makeWorld(prefix, { role = "coder" } = {}) {
  const root = mkdtempSync(join(SCRATCH_ROOT, prefix));
  const wt = join(root, "wt");
  const harnessDir = join(wt, ".harness");
  const ctrl = join(root, "ctrl");
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(ctrl, { recursive: true });
  return {
    root,
    wt,
    harnessDir,
    ctrl,
    ledgerPath: join(ctrl, "receipts.jsonl"),
    role,
  };
}

function g1Block({ runtimeId = RUNTIME_ID, pane = PANE } = {}) {
  return `dispatch_verified: yes\ntask_id_from_dispatch: ${runtimeId}\npane_match: ${pane} == ${pane} ? 일치\n`;
}

function writeRound(
  w,
  { g1 = g1Block(), prefix = "coder", roleName = "CODER" } = {},
) {
  writeFileSync(
    join(w.harnessDir, `${prefix}-task.md`),
    `task_id: ${LABEL}\ndropped_at: ${formatKst(DROPPED_MS)} KST\n`,
    "utf8",
  );
  writeFileSync(
    join(w.harnessDir, `${prefix}.md`),
    `task_id: ${LABEL}\n${g1}\n>>> DONE: ${roleName} @ ${formatKstSec(DONE_MS)}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function receipt(over = {}) {
  return {
    recorded_at: new Date(RECORDED_MS).toISOString(),
    runtime_task_id: RUNTIME_ID,
    dispatch_id: DISPATCH_ID,
    assignee_pane_key: PANE,
    dispatch_timestamp_utc: new Date(DROPPED_MS).toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role: "coder",
    harness_task_label: LABEL,
    ...over,
  };
}

function writeLedger(path, records) {
  writeFileSync(
    path,
    records.map((r) => JSON.stringify(r) + "\n").join(""),
    "utf8",
  );
}

function writePointer(w, value) {
  writeFileSync(join(w.harnessDir, "dispatch-receipt-path.txt"), value, "utf8");
}

// 합성 Orca 응답 stub 들(모두 주입 -- 실 orca 0).
const found = (over = {}) => ({
  ok: true,
  found: true,
  dispatch: {
    id: DISPATCH_ID,
    task_id: RUNTIME_ID,
    assignee_pane_key: PANE,
    ...(over.dispatch ?? {}),
  },
  ...(over.top ?? {}),
});
function recordingStub(response) {
  const calls = [];
  const fn = (arg) => {
    calls.push(arg);
    return typeof response === "function" ? response(arg) : response;
  };
  fn.calls = calls;
  return fn;
}

function consume(w, opts = {}) {
  // 주의: `explicitLedger: undefined` 는 «명시 인자 없음»이어야 한다(구조분해
  // 기본값은 undefined 를 덮어쓰므로 `in` 으로 갈라 본다).
  const { explicitLedger: given, ...rest } = opts;
  const explicitLedger = "explicitLedger" in opts ? given : w.ledgerPath;
  return checkRelayHandshake({
    role: "coder",
    harnessDir: w.harnessDir,
    now: NOW_MS,
    ...(explicitLedger ? { dispatchLedgerPath: explicitLedger } : {}),
    ...rest,
  });
}

function readShadow(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}
const shadowPathOf = (ledgerPath) => ledgerPath + SHADOW_SUFFIX;

const OK_RESULT = { ok: true, reason: `relay handshake ok for ${LABEL}` };

// ---------------------------------------------------------------------------
// T2 정상 줄 + 일치 stub -> AUTHENTIC · 소비 무변(무회귀)
// ---------------------------------------------------------------------------
test("(T2) 정상 줄 + 일치 stub -> 그림자 AUTHENTIC · 소비 ok:true 무변", () => {
  const w = makeWorld("t2-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  const stub = recordingStub(found());
  const res = consume(w, { orcaDispatchLookup: stub });
  assert.deepEqual(res, OK_RESULT, "소비 결과 무변");
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 1, "그림자 기록 1줄");
  assert.equal(rows[0].verdict, V.AUTHENTIC);
  assert.equal(rows[0].role, "coder");
  assert.equal(rows[0].label, LABEL);
  assert.equal(rows[0].dispatch_id, DISPATCH_ID);
  assert.deepEqual(rows[0].mismatch_keys, []);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].runtimeTaskId, RUNTIME_ID);
  assert.equal(stub.calls[0].dispatchId, DISPATCH_ID);
});

// ---------------------------------------------------------------------------
// T1 지어낸 dispatch_id 줄(uuid 모양 위조 · Orca 에 없음) -> UNAUTHENTIC 기록,
// 소비는 «지금과 똑같이» ok:true(그림자는 차단하지 않는다 -- 이슈 증상 그대로)
// ---------------------------------------------------------------------------
test("(T1) 위조 줄(Orca 에 없는 dispatch) -> UNAUTHENTIC 기록 · 소비는 그대로 ok:true", () => {
  const w = makeWorld("t1-");
  writeRound(w);
  writeLedger(w.ledgerPath, [
    receipt({ dispatch_id: "forged-never-dispatched" }),
  ]);
  const stub = recordingStub({ ok: true, found: false });
  const res = consume(w, { orcaDispatchLookup: stub });
  assert.deepEqual(res, OK_RESULT, "위조 줄도 소비는 지금과 같다(차단 0)");
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.UNAUTHENTIC);
  assert.ok(rows[0].mismatch_keys.includes("dispatch_id"));
  assert.equal(rows[0].dispatch_id, "forged-never-dispatched");
});

// ---------------------------------------------------------------------------
// T3 pane · task_id · dispatch id 각각 불일치(불일치 stub 필수)
// ---------------------------------------------------------------------------
for (const [name, dispatchOver, key] of [
  ["pane", { assignee_pane_key: OTHER_PANE }, "assignee_pane_key"],
  ["task_id", { task_id: "task_bbbbbbbbbbbb" }, "runtime_task_id"],
  ["dispatch id", { id: "ctx_other_9" }, "dispatch_id"],
]) {
  test(`(T3-${name}) Orca 기록과 ${name} 불일치 -> UNAUTHENTIC + 불일치 키 이름 · 소비 무변`, () => {
    const w = makeWorld("t3-");
    writeRound(w);
    writeLedger(w.ledgerPath, [receipt()]);
    const res = consume(w, {
      orcaDispatchLookup: recordingStub(found({ dispatch: dispatchOver })),
    });
    assert.deepEqual(res, OK_RESULT);
    const rows = readShadow(shadowPathOf(w.ledgerPath));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, V.UNAUTHENTIC);
    assert.deepEqual(rows[0].mismatch_keys, [key]);
  });
}

// ---------------------------------------------------------------------------
// T4 재생: 다른 라운드의 «진짜» id 를 베낌 -- Orca 에는 있고 값도 맞지만 task
// 본문에 이 라운드 라벨이 없다 -> UNAUTHENTIC(harness_task_label)
// ---------------------------------------------------------------------------
test("(T4) 재생 줄(진짜 id 인데 task 본문에 이 라벨이 없음) -> UNAUTHENTIC(harness_task_label) · 소비 무변", () => {
  const w = makeWorld("t4-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  const res = consume(w, {
    orcaDispatchLookup: recordingStub(
      found({ top: { taskText: "go HYK-111-other-round\n본문 ..." } }),
    ),
  });
  assert.deepEqual(res, OK_RESULT);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows[0].verdict, V.UNAUTHENTIC);
  assert.deepEqual(rows[0].mismatch_keys, ["harness_task_label"]);
});

test("(T4b) task 본문에 이 라벨이 있으면 AUTHENTIC · 좌석 worktree 가 다르면 UNAUTHENTIC(worktree)", () => {
  const w = makeWorld("t4b-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  const ok = consume(w, {
    orcaDispatchLookup: recordingStub(
      found({
        top: { taskText: `HYK 라벨 ${LABEL} 본문`, worktreePath: w.wt },
      }),
    ),
  });
  assert.deepEqual(ok, OK_RESULT);
  const bad = consume(w, {
    orcaDispatchLookup: recordingStub(
      found({ top: { worktreePath: join(w.root, "elsewhere") } }),
    ),
  });
  assert.deepEqual(bad, OK_RESULT);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].verdict, V.AUTHENTIC);
  assert.equal(rows[1].verdict, V.UNAUTHENTIC);
  assert.deepEqual(rows[1].mismatch_keys, ["worktree"]);
});

// ---------------------------------------------------------------------------
// T5 포인터 우회: 원장 경로 « 명시 인자 ≠ 워커 포인터 » 와, 포인터가 워크트리
// 안 위조 원장을 가리킴
// ---------------------------------------------------------------------------
test("(T5a) 명시 원장 경로와 워커 포인터가 다르다 -> POINTER_MISMATCH · 소비 무변(차단 0)", () => {
  const w = makeWorld("t5a-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  writePointer(w, join(w.wt, "my-own-ledger.jsonl"));
  const stub = recordingStub(found());
  const res = consume(w, { orcaDispatchLookup: stub });
  assert.deepEqual(res, OK_RESULT, "포인터가 달라도 소비는 지금과 같다");
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.POINTER_MISMATCH);
  assert.ok(rows[0].mismatch_keys.includes("ledger_pointer"));
});

test("(T5b) 포인터가 워크트리 «안» 위조 원장을 가리킨다(명시 인자 없음) -> POINTER_MISMATCH · 소비 무변", () => {
  const w = makeWorld("t5b-");
  writeRound(w);
  const forged = join(w.wt, "forged-ledger.jsonl");
  writeLedger(forged, [receipt({ dispatch_id: "forged-never-dispatched" })]);
  writePointer(w, forged);
  const res = consume(w, {
    explicitLedger: undefined,
    orcaDispatchLookup: recordingStub({ ok: true, found: false }),
  });
  assert.deepEqual(res, OK_RESULT, "위조 원장 포인터도 소비는 지금과 같다");
  const rows = readShadow(shadowPathOf(forged));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.POINTER_MISMATCH);
  assert.ok(rows[0].mismatch_keys.includes("ledger_pointer"));
});

test("(T5c) 포인터가 관제실 쪽(워크트리 밖)을 가리키고 명시 인자와 같으면 POINTER_MISMATCH 가 아니다", () => {
  const w = makeWorld("t5c-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  writePointer(w, w.ledgerPath);
  const res = consume(w, { orcaDispatchLookup: recordingStub(found()) });
  assert.deepEqual(res, OK_RESULT);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows[0].verdict, V.AUTHENTIC);
});

// ---------------------------------------------------------------------------
// T6 Orca 조회 실패 / 예외 / 시한 초과 = LOOKUP_FAILED(UNAUTHENTIC 아님) · 소비 무변
// ---------------------------------------------------------------------------
for (const [name, stub, evidenceKey] of [
  [
    "ok:false 응답",
    () => ({ ok: false, reason: "runtime unavailable" }),
    "not_ok",
  ],
  [
    "예외",
    () => {
      throw new Error("spawn orca ENOENT");
    },
    "threw",
  ],
  [
    "ETIMEDOUT 예외",
    () => {
      const e = new Error("spawnSync orca ETIMEDOUT");
      e.code = "ETIMEDOUT";
      throw e;
    },
    "timeout",
  ],
  ["객체가 아닌 응답", () => "garbage", "malformed"],
]) {
  test(`(T6-${name}) Orca 조회 ${name} -> LOOKUP_FAILED · 소비 무변`, () => {
    const w = makeWorld("t6-");
    writeRound(w);
    writeLedger(w.ledgerPath, [receipt()]);
    const res = consume(w, { orcaDispatchLookup: recordingStub(stub) });
    assert.deepEqual(res, OK_RESULT, "조회가 실패해도 소비는 지금과 같다");
    const rows = readShadow(shadowPathOf(w.ledgerPath));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict, V.LOOKUP_FAILED);
    assert.equal(rows[0].evidence.lookup_failure, evidenceKey);
  });
}

test("(T6-시한) 조회가 시한(timeoutMs)을 넘기면(주입 시계) LOOKUP_FAILED(timeout) · 소비 무변", () => {
  const w = makeWorld("t6t-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  let t = 1_000;
  const res = consume(w, {
    orcaDispatchLookup: recordingStub(found()), // 응답은 «맞지만» 늦었다
    authShadowOptions: {
      timeoutMs: 10,
      nowMsFn: () => (t += 50),
    },
  });
  assert.deepEqual(res, OK_RESULT);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows[0].verdict, V.LOOKUP_FAILED);
  assert.equal(rows[0].evidence.lookup_failure, "timeout");
});

test("(T6-미결선) 조회 함수를 안 주면 LOOKUP_FAILED(lookup_not_wired) · 소비 무변", () => {
  const w = makeWorld("t6n-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  const res = consume(w);
  assert.deepEqual(res, OK_RESULT);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows[0].verdict, V.LOOKUP_FAILED);
  assert.equal(rows[0].evidence.lookup_failure, "lookup_not_wired");
});

// ---------------------------------------------------------------------------
// 예외 주입: 그림자 «기록» 자체가 예외를 내도(기록 경로가 디렉터리) 소비는 같다.
// 그림자 판정 함수 안쪽이 아니라 «소비 호출부의 삼킴»이 이걸 막는다.
// ---------------------------------------------------------------------------
test("(예외) 그림자 기록 쓰기가 예외를 내도(기록 경로가 디렉터리) 소비 결과·사유 무변", () => {
  const w = makeWorld("tx-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  mkdirSync(shadowPathOf(w.ledgerPath)); // appendFileSync -> EISDIR
  let res;
  assert.doesNotThrow(() => {
    res = consume(w, { orcaDispatchLookup: recordingStub(found()) });
  });
  assert.deepEqual(res, OK_RESULT);
});

test("(예외) 그림자가 예외를 내는 위치가 «거부» 소비 경로여도 거부 사유 무변(G1 불일치)", () => {
  const w = makeWorld("tx2-");
  writeRound(w, { g1: g1Block({ pane: OTHER_PANE }) });
  writeLedger(w.ledgerPath, [receipt()]);
  mkdirSync(shadowPathOf(w.ledgerPath));
  const withBroken = consume(w, { orcaDispatchLookup: recordingStub(found()) });
  rmSync(shadowPathOf(w.ledgerPath), { recursive: true, force: true });
  const withShadowOk = consume(w, {
    orcaDispatchLookup: recordingStub(found()),
  });
  assert.equal(withBroken.ok, false);
  assert.match(withBroken.reason, /G1 cross-check failed \(HYK-434\)/);
  assert.deepEqual(
    withBroken,
    withShadowOk,
    "그림자 성패와 무관하게 거부 결과 동일",
  );
});

// ---------------------------------------------------------------------------
// T7 기존 손 정정 줄(correction* 키) -- 오탐으로 세지 않고 따로 표기
// ---------------------------------------------------------------------------
test("(T7) 최신 매칭 줄이 손 정정 줄(correction* 키) -> HAND_CORRECTION_EXISTING 별도 표기 · Orca 조회 0 · 소비 무변", () => {
  const w = makeWorld("t7-");
  writeRound(w);
  writeLedger(w.ledgerPath, [
    receipt({
      correction: true,
      correction_authority: "hand",
      correction_reason: "x",
    }),
  ]);
  const stub = recordingStub({ ok: true, found: false }); // 불일치 stub: 조회됐다면 UNAUTHENTIC
  const res = consume(w, { orcaDispatchLookup: stub });
  assert.deepEqual(res, OK_RESULT);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.HAND_CORRECTION);
  assert.notEqual(rows[0].verdict, V.UNAUTHENTIC, "오탐으로 세지 않는다");
  assert.deepEqual(
    rows[0].evidence.correction_keys.sort(),
    ["correction", "correction_authority", "correction_reason"],
    "키 «이름»만 적는다(값 0)",
  );
  assert.equal(
    JSON.stringify(rows[0]).includes('"hand"'),
    false,
    "정정 줄 값은 옮기지 않는다",
  );
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// HYK-392 원장 포인터 부재(fail-open 자리) -> LEDGER_POINTER_ABSENT
// ---------------------------------------------------------------------------
test("(392) 원장 경로가 전혀 없다(명시 0 · 포인터 0 = 존재·G1 축이 skip 되는 자리) -> LEDGER_POINTER_ABSENT · 소비 무변", () => {
  const w = makeWorld("t392-");
  writeRound(w);
  const stub = recordingStub(found());
  const res = consume(w, {
    explicitLedger: undefined,
    orcaDispatchLookup: stub,
  });
  assert.deepEqual(res, OK_RESULT, "skip 되는 소비도 지금과 같다");
  const rows = readShadow(join(w.harnessDir, SHADOW_FALLBACK_NAME));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.POINTER_ABSENT);
  assert.equal(stub.calls.length, 0, "대조할 원장 줄이 없으니 조회 0");
});

// ---------------------------------------------------------------------------
// 순서: 387 존재 축 «뒤», G1 대조 «앞»
// ---------------------------------------------------------------------------
test("(순서) 387 존재 축이 거부(ABSENT)하면 그림자 기록 0 · 거부 사유 무변", () => {
  const w = makeWorld("tord1-");
  writeRound(w);
  writeLedger(w.ledgerPath, []); // 매칭 줄 없음 -> ABSENT
  const stub = recordingStub(found());
  const res = consume(w, { orcaDispatchLookup: stub });
  assert.equal(res.ok, false);
  assert.match(res.reason, /DISPATCH_RECORD_ABSENT/);
  assert.equal(readShadow(shadowPathOf(w.ledgerPath)).length, 0);
  assert.equal(stub.calls.length, 0);
});

test("(순서) G1 이 거부해도 그 «앞»에서 이미 기록된다 · 거부 사유 무변", () => {
  const w = makeWorld("tord2-");
  writeRound(w, { g1: g1Block({ pane: OTHER_PANE }) }); // G1 거부 유도
  writeLedger(w.ledgerPath, [receipt()]);
  const res = consume(w, { orcaDispatchLookup: recordingStub(found()) });
  assert.equal(res.ok, false);
  assert.match(res.reason, /G1 cross-check failed \(HYK-434\)/);
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.AUTHENTIC);
});

// ---------------------------------------------------------------------------
// 파일 규약: append-only · 원장 옆 새 이름 1개 · 감시 폴더/계수기 무접촉
// ---------------------------------------------------------------------------
test("(파일) append-only: 두 번 소비하면 두 줄, 앞 줄 바이트 불변 · 원장 폴더에 새로 생긴 것은 그림자 파일 1개뿐", () => {
  const w = makeWorld("tfile-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  const before = readdirSync(w.ctrl).sort();
  consume(w, { orcaDispatchLookup: recordingStub(found()) });
  const shadow = shadowPathOf(w.ledgerPath);
  const first = readFileSync(shadow, "utf8");
  consume(w, { orcaDispatchLookup: recordingStub({ ok: true, found: false }) });
  const second = readFileSync(shadow, "utf8");
  assert.ok(second.startsWith(first), "앞 줄 바이트 불변(덧붙이기만)");
  assert.equal(readShadow(shadow).length, 2);
  const after2 = readdirSync(w.ctrl).sort();
  assert.deepEqual(
    after2.filter((n) => !before.includes(n)),
    ["receipts.jsonl" + SHADOW_SUFFIX],
    "새 파일은 그림자 기록 1개",
  );
  for (const n of after2) {
    assert.notEqual(n.toLowerCase(), "watch", "watch 폴더를 만들지 않는다");
  }
});

test("(파일) 기록 한 줄은 칸 6개: 시각 · 역할 · 라벨 · 판정 · 근거 + 식별자 · 본문 0", () => {
  const w = makeWorld("tcols-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  consume(w, {
    orcaDispatchLookup: recordingStub(
      found({ top: { taskText: `SECRET-BODY ${LABEL}` } }),
    ),
  });
  const row = readShadow(shadowPathOf(w.ledgerPath))[0];
  for (const k of [
    "ts",
    "role",
    "label",
    "verdict",
    "mismatch_keys",
    "evidence",
  ]) {
    assert.ok(k in row, `칸 ${k}`);
  }
  assert.ok(Number.isFinite(Date.parse(row.ts)));
  assert.equal(
    JSON.stringify(row).includes("SECRET-BODY"),
    false,
    "task 본문은 기록하지 않는다",
  );
});

test("(파일) 그림자 구역 소스에 관제실 절대 경로 · watch 폴더 · orca 직접 실행 리터럴이 없다", () => {
  const whole = readFileSync(CLI_PATH, "utf8");
  const begin = whole.indexOf(
    "HYK-390 + HYK-392 영수증 «진위 그림자 판정» BEGIN",
  );
  const end = whole.indexOf("HYK-390 + HYK-392 영수증 «진위 그림자 판정» END");
  assert.ok(begin > 0 && end > begin, "그림자 구역 표지가 있다");
  const src = whole.slice(begin, end).replace(/^\s*\/\/.*$/gm, ""); // 주석 줄 제외
  assert.equal(/하네스-관제실/.test(src), false);
  assert.equal(
    /[A-Za-z]:[\\/]/.test(src),
    false,
    "드라이브 절대 경로 리터럴 0",
  );
  assert.equal(/["'`]watch[\\/]/.test(src), false);
  assert.equal(
    /\borca["'`]\s*,/.test(src),
    false,
    "그림자 구역은 orca 를 직접 실행하지 않는다",
  );
  assert.equal(
    /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(src),
    false,
  );
});

test("(결선) configureAuthShadowDefaults 로 결선한 조회가 쓰이고, 명시 인자가 기본값을 이긴다", async () => {
  const mod = await import("./relay-handshake.mjs");
  const wired = recordingStub({ ok: true, found: false });
  const explicit = recordingStub(found());
  const prev = mod.configureAuthShadowDefaults({ orcaDispatchLookup: wired });
  try {
    const w = makeWorld("twire-");
    writeRound(w);
    writeLedger(w.ledgerPath, [receipt()]);
    assert.deepEqual(consume(w), OK_RESULT);
    assert.deepEqual(consume(w, { orcaDispatchLookup: explicit }), OK_RESULT);
    const rows = readShadow(shadowPathOf(w.ledgerPath));
    assert.deepEqual(
      rows.map((r) => r.verdict),
      [V.UNAUTHENTIC, V.AUTHENTIC],
    );
    assert.equal(wired.calls.length, 1);
    assert.equal(explicit.calls.length, 1);
  } finally {
    mod.configureAuthShadowDefaults(prev);
  }
});

// ---------------------------------------------------------------------------
// 역할 범위: CODER/REVIEW 소비에만. 그 밖 역할(VERIFY)은 기록 0 · 소비 무변.
// ---------------------------------------------------------------------------
test("(역할) VERIFY 소비는 그림자 기록 0 · 소비 무변", () => {
  const w = makeWorld("trole-");
  writeRound(w, { prefix: "verify", roleName: "VERIFY" });
  writeLedger(w.ledgerPath, [receipt({ role: "verify" })]);
  const stub = recordingStub(found());
  const res = checkRelayHandshake({
    role: "verify",
    harnessDir: w.harnessDir,
    now: NOW_MS,
    dispatchLedgerPath: w.ledgerPath,
    orcaDispatchLookup: stub,
  });
  assert.equal(res.ok, true);
  assert.equal(readShadow(shadowPathOf(w.ledgerPath)).length, 0);
  assert.equal(stub.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 실 CLI 진입: 포인터만으로 소비(워커 실사용 모양) · 종료 코드 0 · 조회 미결선 표기
// ---------------------------------------------------------------------------
test("(CLI) 실 CLI 진입 · 종료 코드 0 · stderr 에 그림자가 새지 않음 · 그림자 기록은 LOOKUP_FAILED(lookup_not_wired)", () => {
  const w = makeWorld("tcli-");
  writeRound(w);
  writeLedger(w.ledgerPath, [receipt()]);
  writePointer(w, w.ledgerPath);
  const env = isolatedChildEnv({});
  const r = spawnSync(process.execPath, [CLI_PATH, "coder", w.harnessDir], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, `exit 0 expected, stderr: ${r.stderr}`);
  assert.equal(
    /auth-shadow|AUTHENTIC|LOOKUP_FAILED/.test(r.stderr + r.stdout),
    false,
  );
  const rows = readShadow(shadowPathOf(w.ledgerPath));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, V.LOOKUP_FAILED);
  assert.equal(rows[0].evidence.lookup_failure, "lookup_not_wired");
});
