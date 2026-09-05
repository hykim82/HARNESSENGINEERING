import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueSubGrant, REASON } from "./grant-issuer.mjs";
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
// HYK-431 6R (coder-task.md §4-2) -- **구조 불변식 시험**.
//
// 이 파일이 재는 것은 "이번에 관측된 공격 한 형태가 막히는가"가 아니다.
// 그건 1R~5R이 매 라운드 했던 일이고, 매번 다음 형태가 나왔다. 여기서
// 재는 것은 세 프로덕션 export의 **구조적 성질** 하나다:
//
//   ★ 「검증기가 관측한 값」 == 「소비자가 쓴 값」
//
// 측정 방법(이게 핵심이다): 입력의 한 지점을 **호출마다 다른 값을 주는
// getter**로 만들고, 그 getter가 돌려준 값을 전부 기록한다. 그러면
//   ⒜ 기록된 관측 횟수가 정확히 1이어야 하고(같은 지점을 두 번 읽지 않는다),
//   ⒝ 판정 결과·발급물·evidence에 남은 값이 **그 유일한 관측값과 같아야**
//      한다(검증을 통과한 그 값이 그대로 소비됐다는 뜻).
// 둘 중 하나라도 깨지면 그 export는 "두 독자에게 다른 얼굴을 보일 수 있는
// 입력"을 여전히 받고 있는 것이다.
//
// ⛔여기서 Proxy를 쓰지 않는 것은 의도적이다. plain-snapshot.mjs는 Proxy를
// 명시적으로 거부하므로, Proxy만으로 시험하면 "한 형태를 막는다"밖에
// 증명하지 못한다(coder-task.md §4-2가 그것으로는 부족하다고 못박았다).
// 아래 입력은 전부 **순정 객체·순정 배열 + 접근자(getter)** 다 -- 거부
// 대상이 아니라 그대로 받아들여지는 입력이며, 그런데도 판정이 흔들리지
// 않는다는 것이 이 시험의 주장이다.
// ---------------------------------------------------------------------------

// 호출될 때마다 values를 차례로 내주는 접근자를 obj[key]에 심고, 실제로
// 관측된 값의 기록(log)을 돌려준다. values를 다 쓰면 마지막 값을 계속 준다.
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
// delegation_id: 검증기(collectDelegationStringProblems)가 읽고, 소비자
// (consumeDelegationTx의 유일성 키 · buildSubGrantFields · 봉투 경로)가
// 다시 읽는 지점. allowed_task_hashes[0]: 검증기(형식)와 소비자
// (taskHashInScope의 범위 대조)가 각각 읽는 지점.
test("불변식(grant-issuer): 호출마다 값이 바뀌는 delegation을 넘겨도 -- 관측 1회, 그리고 발급된 봉투의 값 == 검증기가 본 그 값", () => {
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

    // ⒜ 각 지점은 정확히 한 번씩만 관측됐다.
    assert.deepEqual(idLog, ["deleg-observation-1"]);
    assert.deepEqual(hashLog, [DELEGATION_TASK_HASH]);

    // ⒝ 검증기가 본 값 그대로 소비됐다 -- 두 번째(위조된) 값은 어디에도
    // 나타나지 않는다. 범위 대조가 첫 관측값으로 이뤄졌다는 사실 자체가
    // ISSUED로 증명된다(두 번째 값이었다면 OUT_OF_SCOPE로 거부됐을 것이다).
    assert.equal(result.reason, REASON.ISSUED, JSON.stringify(result));
    assert.equal(result.envelope.delegation_id, idLog[0]);
    assert.equal(result.envelope.task_hash, hashLog[0]);
    const onDisk = JSON.parse(readFileSync(result.envelopePath, "utf8"));
    assert.equal(onDisk.delegation_id, idLog[0]);
    assert.match(result.envelopePath, /deleg-observation-1/);
    assert.doesNotMatch(result.envelopePath, /MUTATED/);
  } finally {
    rmSync(consumptionDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
    rmSync(intentDir, { recursive: true, force: true });
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

test("불변식(seat-reclaim): 보호 목록 원소가 호출마다 바뀌어도 -- 관측 1회, 그리고 보호 판정이 검증기가 본 그 값으로 이뤄진다", () => {
  const protectedSeats = ["pane-1"];
  // 1회차(검증기): 보호 대상. 2회차 이후(소비자): 다른 좌석 -- 수리 전이면
  // exact 대조가 2회차 값으로 이뤄져 보호가 사라진다.
  const seatLog = volatileAccessor(protectedSeats, 0, [
    "pane-1",
    "some-other-seat",
  ]);

  const result = judgeSeatReclaim({
    inventory: seatInventory(),
    policy: { protectedSeats, minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });

  assert.deepEqual(seatLog, ["pane-1"], "보호 목록 원소는 한 번만 관측된다");
  assert.equal(result.eligibility, SEAT_ELIGIBILITY.PROTECTED);
  assert.equal(result.reason, SEAT_REASON.PROTECTED_SEAT);
  assert.equal(result.reclaimEligible, false);
  // ⒝ evidence에 남은 목록 == 검증기가 관측한 그 목록.
  assert.deepEqual(result.evidence.protectedSeats, [seatLog[0]]);
});

test("불변식(seat-reclaim): completedAt이 호출마다 바뀌어도 -- 관측 1회, 그리고 evidence의 값 == 스키마가 통과시킨 그 값", () => {
  const dispatch = { observable: true };
  // 1회차(스키마 검사): 과거 -> "끝난 배차". 2회차 이후(분류/evidence):
  // 미래 -> 수리 전이면 분류 단계가 미래 값을 봐 판정이 뒤집힌다.
  const completedLog = volatileAccessor(dispatch, "completedAt", [
    "2026-09-01T00:00:00.000Z",
    "2099-01-01T00:00:00.000Z",
  ]);

  const result = judgeSeatReclaim({
    inventory: seatInventory({ dispatch }),
    policy: { protectedSeats: ["other-seat"], minIdleMs: 1000 },
    nowMs: SEAT_NOW,
  });

  assert.deepEqual(completedLog, ["2026-09-01T00:00:00.000Z"]);
  assert.equal(result.evidence.dispatch.completedAt, completedLog[0]);
  assert.equal(result.eligibility, SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE);
  assert.equal(result.reclaimEligible, true);
});

test("불변식(judgeReclaimAnomaly): 가용 메모리가 호출마다 바뀌어도 -- 관측 1회, 그리고 바닥 대조가 그 한 관측으로 이뤄진다", () => {
  const systemPressure = { observable: true };
  // 1회차(isValidAnomalyInput의 유효성 검사): 바닥 아래. 2회차 이후(바닥
  // 대조): 넉넉함 -- 수리 전이면 ANOMALY가 WATCH로 조용히 내려앉는다.
  const memLog = volatileAccessor(
    systemPressure,
    "availableMemoryBytes",
    [100, 999_999_999],
  );

  const result = judgeReclaimAnomaly(
    { eligibleUnreclaimedCount: 3, systemPressure },
    { memoryFloorBytes: 1000 },
  );

  assert.deepEqual(memLog, [100]);
  assert.equal(result.status, ANOMALY_STATUS.ANOMALY);
  assert.equal(result.reason, ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR);
  assert.equal(result.evidence.availableMemoryBytes, memLog[0]);
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

test("불변식(teardown): 표적 digest가 호출마다 바뀌어도 -- 관측 1회, 그리고 보호 대조가 검증기가 본 그 값으로 이뤄진다", () => {
  const target = { worktreeId: "wt-1", repoId: "repo-1" };
  // 1회차(isValidTarget): 보호 목록에 있는 digest. 2회차 이후
  // (isProtectedTarget): 다른 digest -- 수리 전이면 보호가 사라져
  // allowSink:true까지 간다.
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

  assert.deepEqual(digestLog, ["digest-protected"]);
  assert.equal(result.eligibility, ELIGIBILITY.PROTECTED);
  assert.equal(result.reason, TEARDOWN_REASON.PROTECTED_TARGET);
  assert.equal(result.allowSink, false);
});

test("불변식(teardown): 보호 목록 원소가 호출마다 바뀌어도 -- 관측 1회, 그리고 evidence의 목록 == 대조에 쓰인 목록", () => {
  const protectedTargets = ["digest-protected"];
  const listLog = volatileAccessor(protectedTargets, 0, [
    "digest-protected",
    "digest-something-else",
  ]);

  const result = judgeTeardown({
    inventory: teardownInventory(),
    policy: { protectedTargets, dispatchCorrelationProven: true },
  });

  assert.deepEqual(listLog, ["digest-protected"]);
  assert.equal(result.eligibility, ELIGIBILITY.PROTECTED);
  assert.deepEqual(result.evidence.protectedTargets, [listLog[0]]);
});

test("불변식(judgePostConditions): 층 값이 호출마다 바뀌어도 -- 관측 1회, 그리고 사후 판정이 그 한 관측으로 정해진다", () => {
  const layers = { orca: "present", dir: "present" };
  // 수리 전에는 layersAllAbsent가 1회차("present")를, layersAllPresent가
  // 2회차("absent")를 봐서 둘 다 false -> FAILED_SPLIT이 됐다. 관측이
  // 한 번이면 세 층 모두 present이므로 FAILED_UNCHANGED가 정답이다.
  const gitLog = volatileAccessor(layers, "git", ["present", "absent"]);

  const execution = judgePostConditions({ after: { layers } });

  assert.deepEqual(gitLog, ["present"]);
  assert.equal(execution, EXECUTION.FAILED_UNCHANGED);
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
