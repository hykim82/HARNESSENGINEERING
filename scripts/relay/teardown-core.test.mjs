import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeTeardown,
  judgePostConditions,
  judgeArchiveEligibility,
  OBSERVATION,
  ELIGIBILITY,
  EXECUTION,
  REASON,
  TEARDOWN_SCHEMA_VERSION,
} from "./teardown-core.mjs";

// HYK-171 사이클4b-1 -- teardown-core.mjs 단위시험. 순수 함수라 fake
// execFn/gitFn/existsFn조차 필요 없다(입력 봉투를 직접 손으로 만든다).
//
// HYK-171 사이클4b-1 재작업3(사람 게이트 결정, coder-task.md §2-B): 대부분의
// 시험은 정책에 `dispatchCorrelationProven: true`를 명시해야 한다 -- 이
// 값이 없으면(프로덕션 기본) 그 자체로 항상 차단되므로, "다른 축을
// 독립적으로 시험"하려는 baseline들이 전부 이 새 축에서 먼저 막힌다.
// 전용 시험(맨 아래 §dispatchCorrelationProven)만 이 값을 일부러 뺀다.

function baseInventory(overrides = {}) {
  return {
    schemaVersion: TEARDOWN_SCHEMA_VERSION,
    target: {
      canonicalPathDigest: "digest-a",
      worktreeId: "wt-1",
      repoId: null,
    },
    layers: { git: "present", orca: "present", dir: "present" },
    activeReferences: { count: 0, tokens: [], observable: true },
    workingTree: {
      dirty: false,
      untracked: false,
      unmerged: false,
      observable: true,
    },
    observationQuality: {
      git: "ok",
      orca: "ok",
      dir: "ok",
      activeReferences: "ok",
      workingTree: "ok",
      degraded: [],
    },
    ...overrides,
  };
}

// ---- HYK-431 8R 계약 변경 --------------------------------------------
// 「파괴해도 된다」(ELIGIBLE)는 적극적 판정이므로, 그 판정이 기대는 축마다
// 근거가 **주어졌을 때만** 낼 수 있다(teardown-core.mjs의
// ELIGIBILITY_PREMISES 주석). 부재는 통과가 아니라 판정 불가다. 그래서
// 「통과」를 재는 시험은 이제 완전한 정책을 넘겨야 한다 -- 아래 헬퍼가
// 그 완전한 정책이고, 각 시험은 자기가 재려는 축만 덮어쓴다.
// ⚠️부분 정책이 막히는 것 자체는 별도 시험(§ premise 시험군)이 잰다.
function fullPolicy(overrides = {}) {
  return {
    protectedTargets: [],
    expectedWorktreeId: "wt-1",
    requireDurableEvidence: false,
    dispatchCorrelationProven: true,
    ...overrides,
  };
}

test("judgeTeardown: fully consistent-present + eligible -- allowSink true", () => {
  const r = judgeTeardown({
    inventory: baseInventory(),
    policy: fullPolicy(),
  });
  assert.equal(r.observation, OBSERVATION.CONSISTENT_PRESENT);
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.execution, EXECUTION.NOT_ATTEMPTED);
  assert.equal(r.allowSink, true);
  assert.equal(r.reason, REASON.ELIGIBLE);
});

test("judgeTeardown: protected target wins over an otherwise-eligible consistent-present inventory", () => {
  const inv = baseInventory();
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [inv.target.canonicalPathDigest] },
  });
  assert.equal(r.eligibility, ELIGIBILITY.PROTECTED);
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.PROTECTED_TARGET);
  assert.equal(r.evidence.ruleId, REASON.PROTECTED_TARGET);
});

// ★HYK-447 1R 계약 변경: Array 서브클래스 인스턴스는 평범한 자료가 아니라
// 신뢰 경계에서 거부된다 -- 파괴 금지라는 결론은 같고 사유만 SCHEMA_INVALID로
// 앞당겨진다(원형 메서드 차용은 두 번째 층으로 남아 있다).
test("HYK-436 반례: policy.protectedTargets가 includes()를 항상 false로 재정의한 Array 서브클래스 -- 신뢰 경계가 먼저 거부, 파괴 금지", () => {
  class IncludesBypassArray extends Array {
    includes() {
      return false;
    }
  }
  const inv = baseInventory();
  const protectedTargets = new IncludesBypassArray();
  protectedTargets.push(inv.target.canonicalPathDigest);
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets },
  });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

test("judgeTeardown: active reference (count>0) blocks even with all layers present", () => {
  const inv = baseInventory({
    activeReferences: { count: 1, tokens: ["tok-1"], observable: true },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.eligibility, ELIGIBILITY.ACTIVE_REFERENCE);
  assert.equal(r.allowSink, false);
  assert.deepEqual(r.evidence.activeReferenceTokens, ["tok-1"]);
});

test("judgeTeardown: dirty working tree blocks with DIRTY_WORKING_TREE reason", () => {
  const inv = baseInventory({
    workingTree: {
      dirty: true,
      untracked: false,
      unmerged: false,
      observable: true,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.eligibility, ELIGIBILITY.DIRTY_OR_UNMERGED);
  assert.equal(r.reason, REASON.DIRTY_WORKING_TREE);
  assert.equal(r.allowSink, false);
});

test("judgeTeardown: unmerged working tree blocks with a distinct UNMERGED_WORKING_TREE reason", () => {
  const inv = baseInventory({
    workingTree: {
      dirty: false,
      untracked: false,
      unmerged: true,
      observable: true,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.eligibility, ELIGIBILITY.DIRTY_OR_UNMERGED);
  assert.equal(r.reason, REASON.UNMERGED_WORKING_TREE);
  assert.equal(r.allowSink, false);
});

test("judgeTeardown: split state (git present, orca absent, dir present) -- SPLIT_STATE, allowSink false", () => {
  const inv = baseInventory({
    layers: { git: "present", orca: "absent", dir: "present" },
  });
  const r = judgeTeardown({ inventory: inv, policy: fullPolicy() });
  assert.equal(r.observation, OBSERVATION.SPLIT_STATE);
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SPLIT_STATE);
});

test("judgeTeardown: one unobservable layer -- UNOBSERVABLE regardless of the other two layers, allowSink false", () => {
  const inv = baseInventory({
    layers: { git: "unobservable", orca: "present", dir: "present" },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.observation, OBSERVATION.UNOBSERVABLE);
  assert.equal(r.allowSink, false);
});

test("judgeTeardown: activeReferences.observable:false is treated as UNOBSERVABLE, not folded into absent/0", () => {
  const inv = baseInventory({
    activeReferences: { count: 0, tokens: [], observable: false },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.observation, OBSERVATION.UNOBSERVABLE);
  assert.equal(r.allowSink, false);
});

test("judgeTeardown: workingTree.observable:false is treated as UNOBSERVABLE", () => {
  const inv = baseInventory({
    workingTree: {
      dirty: false,
      untracked: false,
      unmerged: false,
      observable: false,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.observation, OBSERVATION.UNOBSERVABLE);
  assert.equal(r.allowSink, false);
});

test("judgeTeardown: consistent-absent (already gone) is not treated as success -- allowSink false, execution stays NOT_ATTEMPTED", () => {
  const inv = baseInventory({
    layers: { git: "absent", orca: "absent", dir: "absent" },
  });
  const r = judgeTeardown({ inventory: inv, policy: fullPolicy() });
  assert.equal(r.observation, OBSERVATION.CONSISTENT_ABSENT);
  assert.equal(r.execution, EXECUTION.NOT_ATTEMPTED);
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.CONSISTENT_ABSENT);
});

test("judgeTeardown: armed/eligible priority -- PROTECTED beats ACTIVE_REFERENCE/DIRTY simultaneously present", () => {
  const inv = baseInventory({
    activeReferences: { count: 3, tokens: ["a", "b", "c"], observable: true },
    workingTree: {
      dirty: true,
      untracked: false,
      unmerged: false,
      observable: true,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [inv.target.canonicalPathDigest] },
  });
  assert.equal(r.eligibility, ELIGIBILITY.PROTECTED);
});

test("judgeTeardown: fail-closed on malformed inventory (missing schemaVersion) -- UNOBSERVABLE + allowSink false", () => {
  const r = judgeTeardown({
    inventory: { target: {}, layers: {} },
    policy: {},
  });
  assert.equal(r.observation, OBSERVATION.UNOBSERVABLE);
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

test("judgeTeardown: fail-closed on schema version mismatch", () => {
  const inv = baseInventory({ schemaVersion: TEARDOWN_SCHEMA_VERSION + 1 });
  const r = judgeTeardown({ inventory: inv, policy: {} });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

// HYK-171 사이클4b-1 재작업(streak 1, REVIEW review-1 P1-2 필수 mutation):
// target.worktreeId/repoId는 키 자체가 반드시 존재해야 하고, 값은 non-empty
// string 또는 명시적 null만 허용한다. 키 부재·잘못된 타입 각각 UNOBSERVABLE
// + allowSink:false여야 한다(수리 전에는 canonicalPathDigest만 검사해 이
// 시험들이 RED였다 -- REVIEW가 실제로 재현한 결함).
test("judgeTeardown: fail-closed when target.worktreeId key is entirely absent (not just null)", () => {
  const inv = baseInventory();
  delete inv.target.worktreeId;
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.observation, OBSERVATION.UNOBSERVABLE);
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

test("judgeTeardown: fail-closed when target.worktreeId has a non-string, non-null type (e.g. a number)", () => {
  const inv = baseInventory({
    target: {
      canonicalPathDigest: "digest-a",
      worktreeId: 12345,
      repoId: null,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

test("judgeTeardown: fail-closed when target.repoId key is entirely absent", () => {
  const inv = baseInventory();
  delete inv.target.repoId;
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

test("judgeTeardown: fail-closed when target.repoId has a non-string, non-null type (e.g. an object)", () => {
  const inv = baseInventory({
    target: {
      canonicalPathDigest: "digest-a",
      worktreeId: "wt-1",
      repoId: { nested: true },
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

// paired-good for the P1-2 fix: explicit null on both id fields (the
// adapter's honest "don't know" signal) is still a **valid envelope** --
// the schema fix only closes key-absence/wrong-type, not the null value.
// ★HYK-431 8R: 봉투가 유효하다는 것과 파괴를 허가한다는 것은 다른 이야기다.
// 검토 8R 이 통과시킨 입력이 정확히 이 형태였다(worktreeId/repoId 가 둘 다
// null 인데 안전장치 필드가 없어서 allowSink:true). 봉투 유효성은 그대로
// 두고(SCHEMA_INVALID 가 아니다), 판정만 fail-closed 로 고정한다.
test("judgeTeardown: explicit null on both target.worktreeId and target.repoId is still a valid envelope, but destruction is not authorised without the premises", () => {
  const inv = baseInventory({
    target: { canonicalPathDigest: "digest-a", worktreeId: null, repoId: null },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.notEqual(r.reason, REASON.SCHEMA_INVALID);
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.PREMISE_UNPROVEN);
});

test("judgeTeardown: fail-closed when a layer value is not one of present/absent/unobservable", () => {
  const inv = baseInventory({
    layers: { git: "PRESENT", orca: "present", dir: "present" },
  });
  const r = judgeTeardown({ inventory: inv, policy: {} });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
});

test("judgeTeardown: expectedWorktreeId mismatch blocks even though the path-derived layers are all consistent-present", () => {
  const inv = baseInventory({
    target: {
      canonicalPathDigest: "digest-a",
      worktreeId: "wt-new",
      repoId: null,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], expectedWorktreeId: "wt-old" },
  });
  assert.equal(r.allowSink, false);
  assert.equal(r.reason, REASON.TARGET_IDENTITY_MISMATCH);
  assert.equal(r.evidence.expectedWorktreeId, "wt-old");
  assert.equal(r.evidence.observedWorktreeId, "wt-new");
});

test("judgeTeardown: expectedWorktreeId matching the observed id is not blocked by identity", () => {
  const inv = baseInventory({
    target: {
      canonicalPathDigest: "digest-a",
      worktreeId: "wt-1",
      repoId: null,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: fullPolicy({ expectedWorktreeId: "wt-1" }),
  });
  assert.equal(r.allowSink, true);
});

test("judgeTeardown: requireDurableEvidence:true blocks a null worktreeId even when all three layers are present (independent of 3-layer classification)", () => {
  const inv = baseInventory({
    target: { canonicalPathDigest: "digest-a", worktreeId: null, repoId: null },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: {
      protectedTargets: [],
      dispatchCorrelationProven: true,
      requireDurableEvidence: true,
    },
  });
  assert.equal(r.observation, OBSERVATION.CONSISTENT_PRESENT);
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.EVIDENCE_NOT_DURABLE);
  assert.equal(r.allowSink, false);
});

test("judgeTeardown: requireDurableEvidence:true with a non-null worktreeId passes that guard", () => {
  const inv = baseInventory();
  const r = judgeTeardown({
    inventory: inv,
    policy: fullPolicy({ requireDurableEvidence: true }),
  });
  assert.equal(r.allowSink, true);
});

test("judgeTeardown: protectedTargets exact match only -- a digest that merely starts with the protected digest does not match", () => {
  const inv = baseInventory({
    target: {
      canonicalPathDigest: "abc123extra",
      worktreeId: "wt-1",
      repoId: null,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: fullPolicy({ protectedTargets: ["abc123"] }),
  });
  assert.notEqual(r.eligibility, ELIGIBILITY.PROTECTED);
  assert.equal(r.allowSink, true);
});

// ---- dispatchCorrelationProven (HYK-171 사이클4b-1 재작업3, 사람 게이트
// 결정, coder-task.md §2-B) -- 배정(dispatch)↔좌석 상관은 증명 불가라
// 명시적 전제조건으로만 표현한다. armed strict와 동형: `=== true`만 통과.
for (const [label, value] of [
  ["omitted", undefined],
  ["false", false],
  ["string 'true'", "true"],
  ["number 1", 1],
]) {
  test(`judgeTeardown: dispatchCorrelationProven ${label} -- blocked with DISPATCH_CORRELATION_UNPROVEN, allowSink false`, () => {
    const inv = baseInventory();
    const policy = { protectedTargets: [] };
    if (value !== undefined) policy.dispatchCorrelationProven = value;
    const r = judgeTeardown({ inventory: inv, policy });
    assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
    assert.equal(r.reason, REASON.DISPATCH_CORRELATION_UNPROVEN);
    assert.equal(r.allowSink, false);
  });
}

test("judgeTeardown: dispatchCorrelationProven:true (strict boolean) passes that guard", () => {
  const inv = baseInventory();
  const r = judgeTeardown({ inventory: inv, policy: fullPolicy() });
  assert.notEqual(r.reason, REASON.DISPATCH_CORRELATION_UNPROVEN);
  assert.equal(r.allowSink, true);
});

test("judgeTeardown: PROTECTED still wins over dispatchCorrelationProven being unproven", () => {
  const inv = baseInventory();
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [inv.target.canonicalPathDigest] },
  });
  assert.equal(r.eligibility, ELIGIBILITY.PROTECTED);
});

// ---- judgePostConditions ----

function layersOnly(git, orca, dir) {
  return { layers: { git, orca, dir } };
}

test("judgePostConditions: all three layers absent -- SUCCEEDED", () => {
  assert.equal(
    judgePostConditions({
      after: layersOnly("absent", "absent", "absent"),
      cliOk: true,
    }),
    EXECUTION.SUCCEEDED,
  );
});

test("judgePostConditions: cliOk:true alone never implies SUCCEEDED -- a still-present layer yields FAILED_SPLIT", () => {
  assert.equal(
    judgePostConditions({
      after: layersOnly("absent", "present", "present"),
      cliOk: true,
    }),
    EXECUTION.FAILED_SPLIT,
  );
});

test("judgePostConditions: all three layers still present -- FAILED_UNCHANGED", () => {
  assert.equal(
    judgePostConditions({
      after: layersOnly("present", "present", "present"),
      cliOk: false,
    }),
    EXECUTION.FAILED_UNCHANGED,
  );
});

test("judgePostConditions: a mixed/split after-state (not all-absent, not all-present) -- FAILED_SPLIT", () => {
  assert.equal(
    judgePostConditions({
      after: layersOnly("absent", "present", "absent"),
      cliOk: true,
    }),
    EXECUTION.FAILED_SPLIT,
  );
});

test("judgePostConditions: an unobservable layer in 'after' is never counted as success -- FAILED_SPLIT (fail-closed)", () => {
  assert.equal(
    judgePostConditions({
      after: layersOnly("absent", "absent", "unobservable"),
      cliOk: true,
    }),
    EXECUTION.FAILED_SPLIT,
  );
});

// ---------------------------------------------------------------------------
// HYK-431 8R -- 「부재」는 「통과」가 아니라 「판정 불가」다 (검토 8R P1).
// 검토자가 통과시킨 입력 그대로: 형태가 유효한 inventory + 깨끗한 작업 트리
// + target.worktreeId:null + target.repoId:null + policy
// {dispatchCorrelationProven:true} -> 예전에는 allowSink:true 였다.
// ⛔이 시험군은 필드 「이름 세 개」를 재는 것이 아니라, 「판정이 기대는 축에
// 근거가 주어졌는가」를 잰다 -- 아래 마지막 두 시험이 그 차이를 고정한다.
// ---------------------------------------------------------------------------

const PREMISE_FIELDS = [
  "protectedTargets",
  "expectedWorktreeId",
  "requireDurableEvidence",
];

test("HYK-431 8R: 안전장치 축의 근거가 하나도 없으면 파괴는 허가되지 않는다(검토 8R 재현 입력 그대로)", () => {
  const inv = baseInventory({
    target: { canonicalPathDigest: "digest-a", worktreeId: null, repoId: null },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { dispatchCorrelationProven: true },
  });
  assert.equal(r.allowSink, false);
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.PREMISE_UNPROVEN);
  assert.deepEqual(r.evidence.unprovenPremises, PREMISE_FIELDS);
});

test("HYK-431 8R: 명시적 undefined 로 주어도 「주지 않은 것」과 같다 · 명시적 null 은 한 겹 앞(형태 검사)에서 막힌다 -- 어느 쪽도 파괴는 허가되지 않는다", () => {
  const explicitUndefined = judgeTeardown({
    inventory: baseInventory(),
    policy: {
      protectedTargets: undefined,
      expectedWorktreeId: undefined,
      requireDurableEvidence: undefined,
      dispatchCorrelationProven: true,
    },
  });
  assert.equal(explicitUndefined.allowSink, false);
  assert.equal(explicitUndefined.reason, REASON.PREMISE_UNPROVEN);

  // ⚠️명시적 null 은 HYK-447 1R 의 정책 형태 검사(isValidPolicyShape)가 먼저
  // 잡는다 -- 사유 코드는 SCHEMA_INVALID 로 다르지만 방향은 같은 fail-closed
  // 다. 두 사유가 다른 것은 감추지 않고 여기 고정해 둔다.
  const explicitNull = judgeTeardown({
    inventory: baseInventory(),
    policy: {
      protectedTargets: null,
      expectedWorktreeId: null,
      requireDurableEvidence: null,
      dispatchCorrelationProven: true,
    },
  });
  assert.equal(explicitNull.allowSink, false);
  assert.equal(explicitNull.reason, REASON.SCHEMA_INVALID);
});

test("HYK-431 8R: 축 하나만 비어도 파괴는 허가되지 않는다(나머지를 아무리 채워도)", () => {
  for (const missing of PREMISE_FIELDS) {
    const policy = fullPolicy();
    delete policy[missing];
    const r = judgeTeardown({ inventory: baseInventory(), policy });
    assert.equal(r.allowSink, false, missing);
    assert.equal(r.reason, REASON.PREMISE_UNPROVEN, missing);
    assert.deepEqual(r.evidence.unprovenPremises, [missing]);
  }
});

test("HYK-431 8R 과차단 0: 정당한 완전 정책은 여전히 통과한다", () => {
  const r = judgeTeardown({ inventory: baseInventory(), policy: fullPolicy() });
  assert.equal(r.allowSink, true);
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.reason, REASON.ELIGIBLE);
});

test("HYK-431 8R: 허용 목록이 아니다 -- 계약에 없는 이름을 채워도 빈 축은 채워지지 않고, 완전 정책에 덧붙여도 판정은 그대로다", () => {
  // ⑴ 지어낸 이름으로는 빈 축을 대신할 수 없다(이름이 아니라 축을 본다).
  const decoy = judgeTeardown({
    inventory: baseInventory(),
    policy: {
      dispatchCorrelationProven: true,
      totallyMadeUpFieldNobodyDeclared: ["digest-a"],
      anotherInventedGuard: true,
    },
  });
  assert.equal(decoy.allowSink, false);
  assert.equal(decoy.reason, REASON.PREMISE_UNPROVEN);
  assert.deepEqual(decoy.evidence.unprovenPremises, PREMISE_FIELDS);

  // ⑵ 반대로, 완전 정책에 지어낸 이름을 덧붙여도 판정은 달라지지 않는다
  //    (판정이 기대지 않는 필드는 요구하지도, 참고하지도 않는다).
  const withExtras = judgeTeardown({
    inventory: baseInventory(),
    policy: fullPolicy({
      totallyMadeUpFieldNobodyDeclared: ["digest-a"],
      anotherInventedGuard: true,
    }),
  });
  assert.equal(withExtras.allowSink, true);
  assert.equal(withExtras.reason, REASON.ELIGIBLE);
});

// ═══════════════════════════════════════════════════════════════════════
// HYK-464-teardown-shadow-1 -- judgeArchiveEligibility(아카이브 전제 축 4개)
// ═══════════════════════════════════════════════════════════════════════
// ⛔judgeTeardown/classifyEligibility와 완전히 독립된 함수다(teardown-
// core.mjs 머리 주석 "왜 섞지 않았는가" 참조) -- 위의 모든 judgeTeardown
// 시험은 이 블록으로 단 하나도 바뀌지 않는다(이미 위에서 58건 전부
// 통과했다, §4 비타협 "기존 시험 무회귀").

// HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑴ B1, 바뀐 계약): 1R에는
// mainCheckout/roundEvidence 두 축이 없었다 -- 그때는 이 헬퍼가 구성하는
// inventory가 "ELIGIBLE 전제조건 전부 충족"의 정의였다. 이제 이 축도
// 충족해야 ELIGIBLE이 난다(본체 아님 + 소비 영수증 1건 이상) -- 전후
// 원문: 이전에는 이 두 필드가 아예 없었고 그래도 ELIGIBLE이 났다(아래
// 모든 ELIGIBLE 기대 시험이 그 사실로 통과했다). 지금은 둘 다 명시해야
// ELIGIBLE이 유지된다(그렇지 않으면 TEARDOWN_MAIN_CHECKOUT_UNKNOWN/
// TEARDOWN_ROUND_EVIDENCE_UNKNOWN으로 거부 -- 아래 새 시험 참조).
function eligibleArchiveInventory(overrides = {}) {
  return {
    mergeStatus: { observable: true, isAncestorOfRemoteMaster: true },
    unconsumedRounds: {
      observable: true,
      count: 0,
      consumedViaRetirement: false,
    },
    keepReason: { observable: true, present: false, firstLine: null },
    archiveManifest: {
      observable: true,
      files: [{ path: ".harness/coder.md", bytes: 42, sha256: "a".repeat(64) }],
    },
    mainCheckout: { observable: true, isMain: false },
    roundEvidence: { observable: true, count: 1 },
    ...overrides,
  };
}

// §1b_exec_line 판정 코어 표 -- 합성 워크트리 5종 + 관측 실패 1종.
test("HYK-464-teardown-shadow-1 판정 코어 표: 병합 완료·미소비 0·사유 없음 -> ELIGIBLE", () => {
  const r = judgeArchiveEligibility({ inventory: eligibleArchiveInventory() });
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.reason, REASON.ARCHIVE_ELIGIBLE);
  assert.equal(r.allowSink, false); // 이 축은 어떤 입력에도 파괴를 허가하지 않는다.
  assert.deepEqual(r.evidence.archiveManifest.files, [
    { path: ".harness/coder.md", bytes: 42, sha256: "a".repeat(64) },
  ]);
});

test("HYK-464-teardown-shadow-1 판정 코어 표: 미병합(브랜치 head가 origin/master 조상 아님) -> 거부", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      mergeStatus: { observable: true, isAncestorOfRemoteMaster: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.NOT_MERGED_TO_MASTER);
  assert.equal(r.allowSink, false);
});

test("HYK-464-teardown-shadow-1 판정 코어 표: 미소비 DONE 있음(은퇴 기록 없음) -> 거부", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      unconsumedRounds: {
        observable: true,
        count: 1,
        consumedViaRetirement: false,
      },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.UNCONSUMED_ROUNDS_PRESENT);
});

test("HYK-464-teardown-shadow-1 판정 코어 표: 미소비지만 은퇴 기록 있음 -> ELIGIBLE(소비됨으로 셈)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      unconsumedRounds: {
        observable: true,
        count: 1,
        consumedViaRetirement: true,
      },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.reason, REASON.ARCHIVE_ELIGIBLE);
});

test("HYK-464-teardown-shadow-1 판정 코어 표: keep-reason.md 있음 -> 거부(사유 첫 줄이 증거에 실린다)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      keepReason: {
        observable: true,
        present: true,
        firstLine: "아직 재현 로그를 더 수집하는 중",
      },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.KEEP_REASON_PRESENT);
  assert.equal(
    r.evidence.keepReasonFirstLine,
    "아직 재현 로그를 더 수집하는 중",
  );
});

test("HYK-464-teardown-shadow-1 판정 코어 표: 관측 실패(ls-remote 등 네트워크 의존 관측 불가) -> 판정 불가(ELIGIBLE 아님)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      mergeStatus: { observable: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.MERGE_STATUS_UNKNOWN);
  assert.notEqual(r.eligibility, ELIGIBILITY.ELIGIBLE);
});

// 그 밖의 "근거가 주어지지 않으면 판정 불가"(필드 자체가 없는 경우 --
// observable:false와는 다른 입력이지만 같은 사유로 떨어져야 한다).
test("HYK-464-teardown-shadow-1: 아카이브 전제 필드 자체가 없으면(undefined) 판정 불가로 떨어진다(지어내지 않는다)", () => {
  const r = judgeArchiveEligibility({
    inventory: {
      unconsumedRounds: {
        observable: true,
        count: 0,
        consumedViaRetirement: false,
      },
      keepReason: { observable: true, present: false, firstLine: null },
      archiveManifest: { observable: true, files: [] },
      // mergeStatus 자체가 없다.
    },
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.MERGE_STATUS_UNKNOWN);
});

test("HYK-464-teardown-shadow-1: 미소비 축 관측 불가 -> 판정 불가", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      unconsumedRounds: { observable: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.UNCONSUMED_ROUNDS_UNKNOWN);
});

test("HYK-464-teardown-shadow-1: keep-reason 관측 불가(있는데 못 읽음 등) -> 판정 불가", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      keepReason: { observable: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.KEEP_REASON_UNKNOWN);
});

test("HYK-464-teardown-shadow-1: 아카이브 목록 관측 불가 -> 판정 불가(복사·삭제는 어차피 이 함수가 절대 하지 않는다)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      archiveManifest: { observable: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.ARCHIVE_MANIFEST_UNAVAILABLE);
});

test("HYK-464-teardown-shadow-1: 스키마 자체가 무너지면(inventory가 plain object가 아님) SCHEMA_INVALID", () => {
  const r = judgeArchiveEligibility({ inventory: "not-an-object" });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.SCHEMA_INVALID);
  assert.equal(r.allowSink, false);
});

// judgeTeardown과의 독립성 재확인 -- dispatchCorrelationProven을 전혀
// 주지 않아도(이 축 자체가 그 필드를 보지 않는다) ELIGIBLE이 난다. 만약
// 이 함수가 classifyEligibility 체인을 통과한다면 이 시험이 실패했을
// 것이다(그 체인은 dispatchCorrelationProven:true가 없으면 항상 막는다).
test("HYK-464-teardown-shadow-1: dispatchCorrelationProven/protectedTargets 등 seat-teardown 축은 전혀 보지 않는다(완전히 독립된 판정)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory(),
    // policy는 아예 주지 않았다 -- judgeTeardown이었다면 이것만으로도
    // DISPATCH_CORRELATION_UNPROVEN으로 항상 막혔을 것이다.
  });
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
});

// ═══════════════════════════════════════════════════════════════════════
// HYK-464-teardown-shadow-2 (REVIEW 1R P1-2, 책임자 판정 1012 B1) --
// 본체(비연결 작업 트리) 제외 + 라운드 증거 0 제외.
// ═══════════════════════════════════════════════════════════════════════

test("HYK-464-teardown-shadow-2 B1: 본체(isMain:true)는 나머지 전제가 전부 깨끗해도 거부된다(TEARDOWN_MAIN_CHECKOUT)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      mainCheckout: { observable: true, isMain: true },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.MAIN_CHECKOUT);
  assert.equal(r.allowSink, false);
});

test("HYK-464-teardown-shadow-2 B1: mainCheckout 관측 불가 -> 판정 불가(본체인지 모르면 ELIGIBLE로 지어내지 않는다)", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      mainCheckout: { observable: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.MAIN_CHECKOUT_UNKNOWN);
});

test("HYK-464-teardown-shadow-2 B1: mainCheckout 필드 자체가 없으면(undefined) 판정 불가로 떨어진다", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({ mainCheckout: undefined }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.MAIN_CHECKOUT_UNKNOWN);
});

test("HYK-464-teardown-shadow-2 B1: 라운드 증거(소비 영수증) 0건 -> 거부(TEARDOWN_NO_ROUND_EVIDENCE) -- '막 만든 워크트리'를 ELIGIBLE로 지어내지 않는다", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      roundEvidence: { observable: true, count: 0 },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.NO_ROUND_EVIDENCE);
});

test("HYK-464-teardown-shadow-2 B1: 라운드 증거 관측 불가 -> 판정 불가", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      roundEvidence: { observable: false },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.EVIDENCE_NOT_DURABLE);
  assert.equal(r.reason, REASON.ROUND_EVIDENCE_UNKNOWN);
});

test("HYK-464-teardown-shadow-2 B1: 라운드 증거가 1건 이상이면(본체도 아니면) 통과 -- ELIGIBLE", () => {
  const r = judgeArchiveEligibility({
    inventory: eligibleArchiveInventory({
      roundEvidence: { observable: true, count: 3 },
    }),
  });
  assert.equal(r.eligibility, ELIGIBILITY.ELIGIBLE);
  assert.equal(r.reason, REASON.ARCHIVE_ELIGIBLE);
});

// ⓒ⑵/⑶ 변이 대상: ARCHIVE_ELIGIBILITY_CHECKS에서 checkNotMainCheckout/
// checkRoundEvidencePresent를 지우면 위 두 거부 시험이 RED가 된다(coder.md
// §변이 표 참조 -- 이 두 함수가 실제로 체인에 연결돼 있다는 증거).
