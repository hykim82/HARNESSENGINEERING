import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueSubGrant, consumeDelegationTx, REASON } from "./grant-issuer.mjs";
import {
  judgeSeatReclaim,
  judgeReclaimAnomaly,
  SEAT_ELIGIBILITY,
  SEAT_REASON,
  ANOMALY_STATUS,
  ANOMALY_REASON,
} from "./seat-reclaim-core.mjs";
import {
  judgeTeardown,
  judgePostConditions,
  ELIGIBILITY,
  EXECUTION,
  REASON as TEARDOWN_REASON,
} from "./teardown-core.mjs";
import {
  makeFakeDelegation,
  DELEGATION_TASK_HASH,
  DELEGATION_IN_WINDOW_NOW,
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
} from "./hyk171-cycle3a-fixtures.mjs";

// ---------------------------------------------------------------------------
// HYK-447 1R (coder-task.md §4-3) -- **구조 불변식 시험**.
//
// 재는 것은 "이번에 관측된 공격 한 형태가 막히는가"가 아니다. 그건 1R~6R이
// 매 라운드 했던 일이고 매번 다음 형태가 나왔다. 여기서 재는 것은 세
// 프로덕션 export의 **구조적 성질** 하나다:
//
//   ★ 「검사기가 관측한 값」 == 「소비자가 쓴 값」
//
// 그 성질은 이제 **두 방향**에서 측정된다 -- 둘 다 있어야 주장이 성립한다.
//
//   ⑴ **받아들인 입력에 대해**(positive): 평범한 자료를 넣고, 판정·발급물·
//      evidence에 남은 값이 **입력의 그 값과 같은지**, 그리고 판정이 끝난
//      뒤 원본을 흔들어도 그 산출물이 **따라 변하지 않는지**를 잰다.
//      (거부만 시험하면 "아무것도 안 받는 경계"도 만점을 받는다 --
//      coder-task.md §4-3이 금지한 형태다.)
//   ⑵ **두 얼굴을 가질 수 있는 입력에 대해**(fail-closed): 읽을 때마다 값이
//      바뀌는 **접근자**와 **Proxy** 둘 다 넣는다. 접근자 축에서는 판정이
//      막히는 것만이 아니라 ★**그 접근자가 한 번도 불리지 않았음**과
//      ★**형제 입력이 변하지 않았음**까지 잰다 -- 검토 7R P1-ⓑ가 정확히
//      "getter가 한 번 불리는 그 순간 형제가 바뀐다"였기 때문이다.
//
// ⚠️ 6R과 달라진 계약: 접근자 입력은 "한 번만 읽히는" 것이 아니라 거부된다.
// 한 번이라도 부르면 그 한 번 안에서 형제가 바뀐다(P1-ⓑ). 아래 축들은 그
// 새 계약을 프로덕션 export로 직접 잰다.
// ---------------------------------------------------------------------------

// 호출될 때마다 values를 차례로 내주는 접근자를 obj[key]에 심고, 실제로
// 관측된 값의 기록(log)을 돌려준다. 새 계약에서 이 log는 **항상 비어
// 있어야** 한다 -- 경계가 값을 꺼내지 않고 거부하기 때문이다.
function volatileAccessor(obj, key, values) {
  const log = [];
  Object.defineProperty(obj, key, {
    get() {
      const v = values[Math.min(log.length, values.length - 1)];
      log.push(v);
      return v;
    },
    enumerable: true,
    configurable: true,
  });
  return log;
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk431-invariant-"));
}

// ---- 축 1: grant-issuer.issueSubGrant ------------------------------------

test("불변식(grant-issuer) ⑴: 평범한 delegation -- 발급된 봉투(메모리·디스크)의 값 == 검증기가 본 그 값이고, 발급 뒤 원본을 바꿔도 따라가지 않는다", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  const intentDir = freshDir();
  try {
    const delegation = makeFakeDelegation();
    delegation.delegation_id = "deleg-observation-1";
    delegation.allowed_task_hashes = [DELEGATION_TASK_HASH];

    const result = withTempDir((bundleDir) => {
      const { pinPath } = writePullAdmissionBundle(bundleDir);
      return issueSubGrant({
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId: "hyk431-invariant-grant",
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "invariant-t1",
        intentDir,
        pullAdmission: pullAdmissionInput(bundleDir, pinPath),
        gates: makeAllowGates(),
        consumptionDir,
        outDir,
      });
    });

    assert.equal(result.reason, REASON.ISSUED, JSON.stringify(result));
    // 검증기가 본 값 == 소비자(봉투 · 봉투 경로 · 디스크 사본)가 쓴 값.
    assert.equal(result.envelope.delegation_id, "deleg-observation-1");
    assert.equal(result.envelope.task_hash, DELEGATION_TASK_HASH);
    const onDisk = JSON.parse(readFileSync(result.envelopePath, "utf8"));
    assert.equal(onDisk.delegation_id, "deleg-observation-1");
    assert.match(result.envelopePath, /deleg-observation-1/);

    // 발급이 끝난 뒤 원본을 흔들어도 산출물은 그대로다(경계가 만든 사본은
    // 원본과 분리돼 있다).
    delegation.delegation_id = "MUTATED-AFTER-ISSUE";
    delegation.allowed_task_hashes[0] = "MUTATED";
    assert.equal(result.envelope.delegation_id, "deleg-observation-1");
    assert.equal(result.envelope.task_hash, DELEGATION_TASK_HASH);
  } finally {
    rmSync(consumptionDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(intentDir, { recursive: true, force: true });
  }
});

test("불변식(grant-issuer) ⑵: 호출마다 값이 바뀌는 접근자를 심은 delegation -- 발급 거부, 접근자는 한 번도 불리지 않는다", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  const intentDir = freshDir();
  try {
    const delegation = makeFakeDelegation();
    const idLog = volatileAccessor(delegation, "delegation_id", [
      "deleg-observation-1",
      "deleg-observation-2-MUTATED",
    ]);
    const hashes = [DELEGATION_TASK_HASH];
    const hashLog = volatileAccessor(hashes, 0, [
      DELEGATION_TASK_HASH,
      "MUTATED-AFTER-VALIDATION",
    ]);
    delegation.allowed_task_hashes = hashes;

    const result = withTempDir((bundleDir) => {
      const { pinPath } = writePullAdmissionBundle(bundleDir);
      return issueSubGrant({
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId: "hyk431-invariant-grant-accessor",
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "invariant-t1",
        intentDir,
        pullAdmission: pullAdmissionInput(bundleDir, pinPath),
        gates: makeAllowGates(),
        consumptionDir,
        outDir,
      });
    });

    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.issued, false);
    assert.equal(result.reason, REASON.DELEGATION_INVALID);
    assert.deepEqual(idLog, [], "접근자는 한 번도 불리면 안 된다");
    assert.deepEqual(hashLog, []);
  } finally {
    rmSync(consumptionDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(intentDir, { recursive: true, force: true });
  }
});

// ★완료조건 5(검토 7R "추가 계약 관찰"): `consumeDelegationTx`도 export
// 진입점이다. 6R은 `issueSubGrant`만 경계를 거치게 해 두고 "모든 export
// 진입점"이라고 적었다 -- 문자 그대로는 참이 아니었다. 이제 이 export도
// 같은 경계를 거친다.
test("불변식(consumeDelegationTx): 접근자를 심은 입력은 소비되지 않는다 -- 접근자는 불리지 않는다", () => {
  const consumptionDir = freshDir();
  try {
    const input = {
      consumptionDir,
      taskHash: DELEGATION_TASK_HASH,
      role: "CODER",
      at: "t1",
    };
    const idLog = volatileAccessor(input, "delegationId", [
      "deleg-1",
      "deleg-2-MUTATED",
    ]);
    const r = consumeDelegationTx(input);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.claimed, false);
    assert.match(r.reason, /could not be fixed as plain data/);
    assert.deepEqual(idLog, []);
  } finally {
    rmSync(consumptionDir, { recursive: true, force: true });
  }
});

// ---- 축 2: seat-reclaim-core.judgeSeatReclaim ----------------------------
function seatInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    seat: { paneKey: "pane-1" },
    dispatch: { completedAt: "2026-09-01T00:00:00.000Z", observable: true },
    activity: { idleMs: 3600000, observable: true },
    ...overrides,
  };
}
const SEAT_NOW = Date.parse("2026-09-02T00:00:00.000Z");

test("불변식(seat-reclaim) ⑴: 평범한 입력 -- 보호 판정에 쓰인 목록 == evidence에 남은 목록이고, 판정 뒤 원본을 바꿔도 따라가지 않는다", () => {
  const protectedSeats = ["pane-1"];
  const inventory = seatInventory();
  const result = judgeSeatReclaim({
    inventory,
    policy: { protectedSeats, minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });

  assert.equal(result.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(result.reason, SEAT_REASON.PROTECTED_SEAT);
  assert.equal(result.reclaimEligible, false);
  assert.deepEqual(result.evidence.protectedSeats, ["pane-1"]);

  protectedSeats[0] = "some-other-seat";
  inventory.seat.paneKey = "pane-mutated";
  assert.deepEqual(result.evidence.protectedSeats, ["pane-1"]);
  assert.equal(Object.isFrozen(result.evidence.dispatch), true);
});

test("불변식(seat-reclaim) ⑵: 보호 목록 원소가 접근자면 -- 회수 금지(SCHEMA_INVALID)이고 접근자는 불리지 않는다", () => {
  const protectedSeats = ["pane-1"];
  const seatLog = volatileAccessor(protectedSeats, 0, [
    "pane-1",
    "some-other-seat",
  ]);

  const result = judgeSeatReclaim({
    inventory: seatInventory(),
    policy: { protectedSeats, minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });

  assert.deepEqual(seatLog, []);
  assert.equal(result.reclaimEligible, false);
  assert.equal(result.reason, SEAT_REASON.SCHEMA_INVALID);
  assert.match(result.evidence.snapshotReason, /accessor property/);
});

test("불변식(seat-reclaim) ⑵: completedAt이 접근자면 -- 회수 금지이고 접근자는 불리지 않는다", () => {
  const dispatch = { observable: true };
  const completedLog = volatileAccessor(dispatch, "completedAt", [
    "2026-09-01T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z",
  ]);

  const result = judgeSeatReclaim({
    inventory: seatInventory({ dispatch }),
    policy: { protectedSeats: ["other-seat"], minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });

  assert.deepEqual(completedLog, []);
  assert.equal(result.reclaimEligible, false);
  assert.equal(result.reason, SEAT_REASON.SCHEMA_INVALID);
});

// ★검토 7R P1-ⓑ 그 자체 -- 프로덕션 export로 잰다. seat의 paneKey 접근자가
// 읽히는 순간 **형제**인 policy.protectedSeats를 비운다. 6R 경계는 그
// 접근자를 (한 번) 실행했고, 그래서 보호 목록이 비워진 뒤의 상태로 판정해
// RECLAIM_ELIGIBLE을 냈다. 지금은 접근자가 아예 불리지 않으므로 형제가
// 변할 수 없다 -- 관찰이 입력 전체에 대해 한 시점이라는 뜻이다.
test("불변식(seat-reclaim) ⑵ 원자성: 접근자가 형제(보호 목록)를 비우려 해도 -- 목록은 그대로이고 회수는 금지된다", () => {
  const protectedSeats = ["pane-1"];
  const seat = {};
  let getterCalls = 0;
  Object.defineProperty(seat, "paneKey", {
    get() {
      getterCalls += 1;
      protectedSeats.length = 0; // 아직 읽지 않은 형제를 비운다
      return "pane-1";
    },
    enumerable: true,
    configurable: true,
  });

  const result = judgeSeatReclaim({
    inventory: seatInventory({ seat }),
    policy: { protectedSeats, minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });

  assert.equal(getterCalls, 0);
  assert.deepEqual(protectedSeats, ["pane-1"], "형제가 변하면 안 된다");
  assert.equal(result.reclaimEligible, false);
  assert.equal(result.eligibility, SEAT_ELIGIBILITY.UNOBSERVABLE);
  assert.equal(result.reason, SEAT_REASON.SCHEMA_INVALID);
});

test("불변식(judgeReclaimAnomaly) ⑵: 가용 메모리가 접근자면 -- 이 축의 방향대로 ANOMALY로 접히고 접근자는 불리지 않는다", () => {
  const systemPressure = { observable: true };
  const memLog = volatileAccessor(
    systemPressure,
    "availableMemoryBytes",
    [100, 999_999_999],
  );

  const result = judgeReclaimAnomaly(
    { eligibleUnreclaimedCount: 3, systemPressure },
    { memoryFloorBytes: 1000 },
  );

  assert.deepEqual(memLog, []);
  assert.equal(result.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(result.reason, ANOMALY_REASON.INPUT_INVALID);
});

test("불변식(judgeReclaimAnomaly) ⑴: 평범한 입력 -- 바닥 대조에 쓰인 값 == evidence에 남은 값", () => {
  const systemPressure = { observable: true, availableMemoryBytes: 100 };
  const result = judgeReclaimAnomaly(
    { eligibleUnreclaimedCount: 3, systemPressure },
    { memoryFloorBytes: 1000 },
  );

  assert.equal(result.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(result.reason, ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR);
  assert.equal(result.evidence.availableMemoryBytes, 100);

  systemPressure.availableMemoryBytes = 999_999_999;
  assert.equal(result.evidence.availableMemoryBytes, 100);
});

// ---- 축 3: teardown-core -------------------------------------------------
function teardownInventory(overrides = {}) {
  return {
    schemaVersion: 1,
    target: {
      canonicalPathDigest: "digest-protected",
      worktreeId: "wt-1",
      repoId: "repo-1",
    },
    layers: { git: "present", orca: "present", dir: "present" },
    activeReferences: { count: 0, tokens: [], observable: true },
    workingTree: {
      dirty: false,
      untracked: false,
      unmerged: false,
      observable: true,
    },
    observationQuality: { note: "invariant-fixture" },
    ...overrides,
  };
}

test("불변식(teardown) ⑴: 평범한 입력 -- 보호 대조에 쓰인 목록 == evidence의 목록이고, 판정 뒤 원본을 바꿔도 따라가지 않는다", () => {
  const protectedTargets = ["digest-protected"];
  const result = judgeTeardown({
    inventory: teardownInventory(),
    policy: { protectedTargets, dispatchCorrelationProven: true },
  });

  assert.equal(result.eligibility, ELIGIBILITY.PROTECTED);
  assert.equal(result.reason, TEARDOWN_REASON.PROTECTED_TARGET);
  assert.equal(result.allowSink, false);
  assert.deepEqual(result.evidence.protectedTargets, ["digest-protected"]);

  protectedTargets[0] = "digest-something-else";
  assert.deepEqual(result.evidence.protectedTargets, ["digest-protected"]);
});

test("불변식(teardown) ⑵: 표적 digest가 접근자면 -- 파괴 금지(SCHEMA_INVALID)이고 접근자는 불리지 않는다", () => {
  const target = { worktreeId: "wt-1", repoId: "repo-1" };
  const digestLog = volatileAccessor(target, "canonicalPathDigest", [
    "digest-protected",
    "digest-something-else",
  ]);

  const result = judgeTeardown({
    inventory: teardownInventory({ target }),
    policy: {
      protectedTargets: ["digest-protected"],
      dispatchCorrelationProven: true,
    },
  });

  assert.deepEqual(digestLog, []);
  assert.equal(result.allowSink, false);
  assert.equal(result.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

test("불변식(teardown) ⑵: 보호 목록 원소가 접근자면 -- 파괴 금지이고 접근자는 불리지 않는다", () => {
  const protectedTargets = ["digest-protected"];
  const listLog = volatileAccessor(protectedTargets, 0, [
    "digest-protected",
    "digest-something-else",
  ]);

  const result = judgeTeardown({
    inventory: teardownInventory(),
    policy: { protectedTargets, dispatchCorrelationProven: true },
  });

  assert.deepEqual(listLog, []);
  assert.equal(result.allowSink, false);
  assert.equal(result.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

// ★검토 7R P1-ⓐ 그 자체 -- 프로덕션 export로 잰다. 6R에서는 이 네 입력이
// 전부 `{}`(또는 빈 목록처럼 보이는 순정 객체)로 접혀 `allowSink:true`까지
// 갔다. 지금은 앞의 셋이 경계에서 거부되고, 넷째(배열을 흉내 낸 순정
// 객체)는 경계가 구별할 수 없으므로 teardown 정책 스키마가 거부한다.
test("불변식(teardown) ⑵ P1-ⓐ: Date/Map/Set/length 객체 정책은 빈 껍데기로 접히지 않고 파괴가 금지된다", () => {
  const cases = [
    ["date", new Date("2026-09-06T00:00:00.000Z")],
    ["map", new Map([["digest-protected", true]])],
    ["set", new Set(["digest-protected"])],
    ["lengthObject", { 0: "digest-protected", length: 0 }],
  ];
  for (const [label, protectedTargets] of cases) {
    const result = judgeTeardown({
      inventory: teardownInventory(),
      policy: { protectedTargets, dispatchCorrelationProven: true },
    });
    assert.equal(result.allowSink, false, label);
    assert.equal(result.reason, TEARDOWN_REASON.SCHEMA_INVALID, label);
  }

  // requireDurableEvidence를 Date로 주어 "요구"를 끄려는 시도도 막힌다.
  const durable = judgeTeardown({
    inventory: teardownInventory({
      target: {
        canonicalPathDigest: "digest-x",
        worktreeId: null,
        repoId: "repo-1",
      },
    }),
    policy: {
      protectedTargets: [],
      requireDurableEvidence: new Date("2026-09-06T00:00:00.000Z"),
      dispatchCorrelationProven: true,
    },
  });
  assert.equal(durable.allowSink, false);
  assert.equal(durable.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

// ★경계가 구별할 수 없는 자리(정직 한계)를 소비자 스키마가 받는다는 것을
// 잰다. 아래 두 값은 **평범한 자료**라 경계를 통과한다 -- 그런데 그 자리에
// 오면 안 되는 모양이고, 형이 틀리면 안전장치가 **꺼지는** 필드다(요구가
// 사라지거나 결속 검사가 건너뛰어진다). 그래서 정책 스키마가 거부한다.
test("불변식(teardown) ⑵ 정책 형 강제: 안전장치를 끄는 방향으로 형이 틀린 정책 값은 판정 자체를 막는다", () => {
  // requireDurableEvidence가 boolean이 아니면 "durable 요구"가 조용히 꺼진다.
  const durable = judgeTeardown({
    inventory: teardownInventory({
      target: {
        canonicalPathDigest: "digest-x",
        worktreeId: null,
        repoId: "repo-1",
      },
    }),
    policy: {
      protectedTargets: [],
      requireDurableEvidence: {},
      dispatchCorrelationProven: true,
    },
  });
  assert.equal(durable.allowSink, false);
  assert.equal(durable.reason, TEARDOWN_REASON.SCHEMA_INVALID);

  // expectedWorktreeId가 문자열이 아니면 표적 결속 검사가 통째로 건너뛰어진다.
  const identity = judgeTeardown({
    inventory: teardownInventory(),
    policy: {
      protectedTargets: [],
      expectedWorktreeId: 42,
      dispatchCorrelationProven: true,
    },
  });
  assert.equal(identity.allowSink, false);
  assert.equal(identity.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

// ---------------------------------------------------------------------------
// ★HYK-447 2R -- 검토 1R P1 축: 「보이지 않는 own 속성」.
// 여기서도 재는 것은 같은 불변식이다 -- «검사기가 관측한 값 == 소비자가 쓴 값».
// 숨겨진 필드가 있는 입력에서는 그 등식이 **성립할 수 없다**(검사기는 그
// 필드를 못 보고, 그 값은 산출물에도 없다). 그래서 유일한 정답은 «그런
// 입력은 통과시키지 않는다»이고, 아래 축이 그것을 프로덕션 export 로 잰다.
// ⛔이름을 특별 취급하지 않음을 함께 잰다(계약에 없는 지어낸 필드도 같은 결과).
// ---------------------------------------------------------------------------
function hiddenProp(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return obj;
}

test("불변식(teardown) ⑵ 2R: 숨겨진(비열거) 보호 목록은 사라지지 않는다 -- 파괴가 허가되지 않는다", () => {
  const policy = hiddenProp(
    { dispatchCorrelationProven: true },
    "protectedTargets",
    ["digest-protected"],
  );
  const result = judgeTeardown({ inventory: teardownInventory(), policy });
  assert.equal(result.allowSink, false);
  assert.equal(result.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

test("불변식(teardown) ⑵ 2R: 숨겨진 requireDurableEvidence(+worktreeId:null)도 파괴가 허가되지 않는다", () => {
  const policy = hiddenProp(
    { protectedTargets: [], dispatchCorrelationProven: true },
    "requireDurableEvidence",
    true,
  );
  const result = judgeTeardown({
    inventory: teardownInventory({
      target: {
        canonicalPathDigest: "digest-x",
        worktreeId: null,
        repoId: "repo-1",
      },
    }),
    policy,
  });
  assert.equal(result.allowSink, false);
  assert.equal(result.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

test("불변식(teardown) ⑵ 2R: 숨겨진 getter는 호출도 0이고 사라지지도 않는다 · 지어낸 이름의 숨은 필드·심볼 키도 같은 결과(허용 목록 아님)", () => {
  let calls = 0;
  const policy = { dispatchCorrelationProven: true };
  Object.defineProperty(policy, "protectedTargets", {
    get() {
      calls += 1;
      return ["digest-protected"];
    },
    enumerable: false,
    configurable: true,
  });
  const getterResult = judgeTeardown({
    inventory: teardownInventory(),
    policy,
  });
  assert.equal(calls, 0);
  assert.equal(getterResult.allowSink, false);
  assert.equal(getterResult.reason, TEARDOWN_REASON.SCHEMA_INVALID);

  const invented = judgeTeardown({
    inventory: teardownInventory(),
    policy: hiddenProp(
      { protectedTargets: [], dispatchCorrelationProven: true },
      "totallyMadeUpFieldNobodyDeclared",
      { anything: true },
    ),
  });
  assert.equal(invented.allowSink, false);
  assert.equal(invented.reason, TEARDOWN_REASON.SCHEMA_INVALID);

  const symbolPolicy = {
    protectedTargets: [],
    dispatchCorrelationProven: true,
  };
  symbolPolicy[Symbol("hidden-policy")] = ["digest-protected"];
  const symbolResult = judgeTeardown({
    inventory: teardownInventory(),
    policy: symbolPolicy,
  });
  assert.equal(symbolResult.allowSink, false);
  assert.equal(symbolResult.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

test("불변식(seat-reclaim) ⑵ 2R: 숨겨진 보호 좌석 목록도 사라지지 않는다 -- 회수가 허가되지 않는다", () => {
  const policy = hiddenProp({ minIdleMs: 1000 }, "protectedSeats", ["pane-1"]);
  const result = judgeSeatReclaim({
    inventory: seatInventory(),
    policy,
    nowMs: SEAT_NOW,
  });
  assert.equal(result.reclaimEligible, false);
  assert.equal(result.reason, SEAT_REASON.SCHEMA_INVALID);
  assert.match(result.evidence.snapshotReason, /non-enumerable own property/);
});

test("불변식(judgePostConditions) ⑵: 층 값이 접근자면 -- 성공으로 세지 않는다(FAILED_SPLIT), 접근자는 불리지 않는다", () => {
  const layers = { orca: "absent", dir: "absent" };
  const gitLog = volatileAccessor(layers, "git", ["absent", "present"]);

  const execution = judgePostConditions({ after: { layers } });

  assert.deepEqual(gitLog, []);
  assert.equal(execution, EXECUTION.FAILED_SPLIT);
});

test("불변식(judgePostConditions) ⑴: 평범한 입력 -- 세 층 관측 하나로 판정이 정해진다", () => {
  const layers = { git: "present", orca: "present", dir: "present" };
  const after = { layers };
  const execution = judgePostConditions({ after });
  assert.equal(execution, EXECUTION.FAILED_UNCHANGED);

  layers.git = "absent";
  assert.equal(judgePostConditions({ after }), EXECUTION.FAILED_SPLIT);
});

// ---- 검토 6R이 재현한 그 공격 자체의 저장소 안 회귀 ---------------------
// (.harness/attack-proxy-hidden-length.mjs는 사람이 한 줄로 돌려 보는
// 실증용이고 전체 러너에는 들어가지 않는다 -- 같은 공격을 저장소 시험으로
// 도 고정해 둔다. 위 불변식 시험들과 달리 이건 "한 형태"의 회귀 시험이다.)
function hidingProxy(realElements, reportedLength) {
  const target = realElements.slice();
  return new Proxy(target, {
    get: (t, prop, receiver) =>
      prop === "length" ? reportedLength : Reflect.get(t, prop, receiver),
  });
}

test("회귀(검토 6R): length를 위조한 Proxy는 세 export 전부에서 거부된다", () => {
  const forgedHashes = hidingProxy([DELEGATION_TASK_HASH, null], 1);
  assert.equal(Array.isArray(forgedHashes), true);
  const grant = issueSubGrant({
    delegation: makeFakeDelegation({ allowed_task_hashes: forgedHashes }),
    taskHash: DELEGATION_TASK_HASH,
    role: "CODER",
    nowMs: DELEGATION_IN_WINDOW_NOW,
    outDir: "unused-because-it-never-gets-that-far",
  });
  assert.equal(grant.ok, false);
  assert.equal(grant.reason, REASON.DELEGATION_INVALID);

  const seat = judgeSeatReclaim({
    inventory: seatInventory(),
    policy: { protectedSeats: hidingProxy(["pane-1", null], 0), minIdleMs: 1 },
    nowMs: SEAT_NOW,
  });
  assert.equal(seat.reclaimEligible, false);
  assert.equal(seat.reason, SEAT_REASON.SCHEMA_INVALID);

  const teardown = judgeTeardown({
    inventory: teardownInventory(),
    policy: {
      protectedTargets: hidingProxy(["digest-protected", null], 0),
      dispatchCorrelationProven: true,
    },
  });
  assert.equal(teardown.allowSink, false);
  assert.equal(teardown.reason, TEARDOWN_REASON.SCHEMA_INVALID);
});

// ---- ⒞ 고정 이후에는 아무것도 판정에 관여할 수 없다 ----------------------
test("불변식(⒞): 판정이 끝난 뒤 원본 입력을 바꿔도 이미 나온 evidence는 따라 변하지 않는다", () => {
  const inventory = seatInventory();
  const result = judgeSeatReclaim({
    inventory,
    policy: { protectedSeats: ["other-seat"], minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });
  assert.equal(result.reclaimEligible, true);

  inventory.dispatch.completedAt = "2099-01-01T00:00:00.000Z";
  inventory.activity.idleMs = 0;

  assert.equal(
    result.evidence.dispatch.completedAt,
    "2026-09-01T00:00:00.000Z",
  );
  assert.equal(result.evidence.activity.idleMs, 3600000);
  assert.equal(Object.isFrozen(result.evidence.dispatch), true);
});
