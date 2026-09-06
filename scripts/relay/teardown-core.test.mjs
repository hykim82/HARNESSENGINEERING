import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeTeardown,
  judgePostConditions,
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

test("judgeTeardown: fully consistent-present + eligible -- allowSink true", () => {
  const r = judgeTeardown({
    inventory: baseInventory(),
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
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
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
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
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
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
// adapter's honest "don't know" signal) is still allowed -- the fix only
// closes key-absence/wrong-type, not the null value itself.
test("judgeTeardown: explicit null on both target.worktreeId and target.repoId is still a valid (allowed) envelope", () => {
  const inv = baseInventory({
    target: { canonicalPathDigest: "digest-a", worktreeId: null, repoId: null },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
  assert.equal(r.allowSink, true);
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
    policy: {
      protectedTargets: [],
      dispatchCorrelationProven: true,
      expectedWorktreeId: "wt-1",
    },
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
    policy: {
      protectedTargets: [],
      dispatchCorrelationProven: true,
      requireDurableEvidence: true,
    },
  });
  assert.equal(r.allowSink, true);
});

test("judgeTeardown: protectedTargets exact match only -- a digest that merely starts with the protected digest does not match", () => {
  const inv = baseInventory({
    target: {
      canonicalPathDigest: "abc123extra",
      worktreeId: null,
      repoId: null,
    },
  });
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: ["abc123"], dispatchCorrelationProven: true },
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
  const r = judgeTeardown({
    inventory: inv,
    policy: { protectedTargets: [], dispatchCorrelationProven: true },
  });
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
