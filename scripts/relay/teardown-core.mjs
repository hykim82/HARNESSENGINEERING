// HYK-171 사이클4b-1 (coder-task.md §2-B) -- teardown 3축 판정 순수 코어.
// 부작용 0 · 시각/랜덤/fs/network 0. 입력은 teardown-inventory-adapter.mjs가
// 만든 관측 봉투(inventory)와 정책(policy)뿐이다. 이 파일은 `orca` 문자열도,
// vendor 이름도, pane key/PID도 전혀 모른다(G9 -- 그런 것들은 어댑터에만
// 있다).
//
// judgeTeardown이 내는 판정은 "지금 파괴해도 되는가"(allowSink)뿐이다.
// 파괴 자체(close/rm)는 이 파일이 절대 실행하지 않는다 -- execution은 이
// 단계에서 항상 NOT_ATTEMPTED다(judgePostConditions만 실행 후 사후 관측을
// SUCCEEDED/FAILED_*로 판정한다).

export const TEARDOWN_SCHEMA_VERSION = 1;

export const OBSERVATION = Object.freeze({
  CONSISTENT_PRESENT: "CONSISTENT_PRESENT",
  CONSISTENT_ABSENT: "CONSISTENT_ABSENT",
  SPLIT_STATE: "SPLIT_STATE",
  UNOBSERVABLE: "UNOBSERVABLE",
});

export const ELIGIBILITY = Object.freeze({
  PROTECTED: "PROTECTED",
  ACTIVE_REFERENCE: "ACTIVE_REFERENCE",
  DIRTY_OR_UNMERGED: "DIRTY_OR_UNMERGED",
  EVIDENCE_NOT_DURABLE: "EVIDENCE_NOT_DURABLE",
  ELIGIBLE: "ELIGIBLE",
});

export const EXECUTION = Object.freeze({
  NOT_ATTEMPTED: "NOT_ATTEMPTED",
  SUCCEEDED: "SUCCEEDED",
  FAILED_UNCHANGED: "FAILED_UNCHANGED",
  FAILED_SPLIT: "FAILED_SPLIT",
});

// judgeTeardown/judgePostConditions의 reason 코드 -- evidence.ruleId도 이
// 집합에서만 나온다(mutation #1이 요구하는 "위반 규칙 id" 대조 대상).
export const REASON = Object.freeze({
  SCHEMA_INVALID: "TEARDOWN_SCHEMA_INVALID",
  PROTECTED_TARGET: "TEARDOWN_PROTECTED_TARGET",
  ACTIVE_REFERENCE: "TEARDOWN_ACTIVE_REFERENCE",
  DIRTY_WORKING_TREE: "TEARDOWN_DIRTY_WORKING_TREE",
  UNMERGED_WORKING_TREE: "TEARDOWN_UNMERGED_WORKING_TREE",
  EVIDENCE_NOT_DURABLE: "TEARDOWN_EVIDENCE_NOT_DURABLE",
  TARGET_IDENTITY_MISMATCH: "TEARDOWN_TARGET_IDENTITY_MISMATCH",
  UNOBSERVABLE_LAYER: "TEARDOWN_UNOBSERVABLE_LAYER",
  SPLIT_STATE: "TEARDOWN_SPLIT_STATE",
  CONSISTENT_ABSENT: "TEARDOWN_CONSISTENT_ABSENT",
  ELIGIBLE: "TEARDOWN_ELIGIBLE",
});

const LAYER_VALUES = Object.freeze(["present", "absent", "unobservable"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isLayerValue(v) {
  return LAYER_VALUES.includes(v);
}

function isValidTarget(target) {
  return isPlainObject(target) && isNonEmptyString(target.canonicalPathDigest);
}
function isValidLayers(layers) {
  return (
    isPlainObject(layers) &&
    isLayerValue(layers.git) &&
    isLayerValue(layers.orca) &&
    isLayerValue(layers.dir)
  );
}
function isValidActiveReferences(refs) {
  return (
    isPlainObject(refs) &&
    Number.isInteger(refs.count) &&
    refs.count >= 0 &&
    Array.isArray(refs.tokens) &&
    typeof refs.observable === "boolean"
  );
}
function isValidWorkingTree(wt) {
  return (
    isPlainObject(wt) &&
    typeof wt.dirty === "boolean" &&
    typeof wt.untracked === "boolean" &&
    typeof wt.unmerged === "boolean" &&
    typeof wt.observable === "boolean"
  );
}

// 스키마/필드 결손/타입 오류를 전부 여기서 잡는다(fail-closed 진입점) --
// 이 함수가 false를 내면 judgeTeardown은 나머지 로직을 전혀 평가하지 않고
// 곧장 UNOBSERVABLE + allowSink:false를 반환한다. 각 하위 검사는 위
// isValid*로 분리했다(복잡도 상한 12 준수).
function isValidInventoryShape(inventory) {
  if (!isPlainObject(inventory)) return false;
  if (inventory.schemaVersion !== TEARDOWN_SCHEMA_VERSION) return false;
  if (!isValidTarget(inventory.target)) return false;
  if (!isValidLayers(inventory.layers)) return false;
  if (!isValidActiveReferences(inventory.activeReferences)) return false;
  if (!isValidWorkingTree(inventory.workingTree)) return false;
  if (!isPlainObject(inventory.observationQuality)) return false;
  return true;
}

// 3층(git/orca/dir) + activeReferences/workingTree의 관측 가능 여부를
// 합쳐 관측 축을 판정한다. 소스 하나라도 unobservable/관측불가면 전체가
// UNOBSERVABLE이다(mutation #5: 빈값/absent로 접지 않는다).
function classifyObservation(inventory) {
  const layers = inventory.layers;
  const values = [layers.git, layers.orca, layers.dir];
  if (
    values.some((v) => v === "unobservable") ||
    inventory.activeReferences.observable !== true ||
    inventory.workingTree.observable !== true
  ) {
    return OBSERVATION.UNOBSERVABLE;
  }
  if (values.every((v) => v === "present"))
    return OBSERVATION.CONSISTENT_PRESENT;
  if (values.every((v) => v === "absent")) return OBSERVATION.CONSISTENT_ABSENT;
  return OBSERVATION.SPLIT_STATE;
}

function isProtectedTarget(inventory, policy) {
  const list = Array.isArray(policy.protectedTargets)
    ? policy.protectedTargets
    : [];
  // exact 대조만(부분일치·정규식 금지, coder-task.md §2-B 비타협).
  return list.includes(inventory.target.canonicalPathDigest);
}

function buildEvidence(inventory, ruleId, extra = {}) {
  return {
    ruleId,
    layers: inventory.layers,
    activeReferenceTokens: inventory.activeReferences.tokens,
    observationQuality: inventory.observationQuality,
    ...extra,
  };
}

// 우선순위 강제(coder-task.md §2-B 비타협): PROTECTED가 다른 모든 자격
// 판정을 이긴다. 각 guard clause는 독립적으로 제거 가능하게 짜여 있다
// (mutation #1/#4/#6이 하나씩 지워 RED를 재현한다).
// mutation #2 (coder-task.md §3): policy.expectedWorktreeId가 주어졌는데
// 관측된 inventory.target.worktreeId와 다르면(경로 문자열은 같아도) 그
// 표적을 신뢰하지 않는다 -- 워크트리가 지워졌다 같은 경로에 다시 만들어진
// 사이 등, "경로는 같지만 실체가 바뀐" 경우를 잡는 결속 검사다. opt-in(
// expectedWorktreeId 미제공 시 건너뜀) -- production 호출자가 이전에
// 관측/기록해둔 id를 넘길 때만 작동한다.
function checkTargetIdentity(inventory, policy) {
  if (!isNonEmptyString(policy.expectedWorktreeId)) return null;
  if (inventory.target.worktreeId === policy.expectedWorktreeId) return null;
  return {
    eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
    reason: REASON.TARGET_IDENTITY_MISMATCH,
    evidence: buildEvidence(inventory, REASON.TARGET_IDENTITY_MISMATCH, {
      expectedWorktreeId: policy.expectedWorktreeId,
      observedWorktreeId: inventory.target.worktreeId,
    }),
  };
}

function classifyEligibility(inventory, policy) {
  if (isProtectedTarget(inventory, policy)) {
    return {
      eligibility: ELIGIBILITY.PROTECTED,
      reason: REASON.PROTECTED_TARGET,
      evidence: buildEvidence(inventory, REASON.PROTECTED_TARGET, {
        protectedTargets: policy.protectedTargets ?? [],
      }),
    };
  }
  const identityMismatch = checkTargetIdentity(inventory, policy);
  if (identityMismatch) return identityMismatch;
  if (
    inventory.activeReferences.observable !== true ||
    inventory.activeReferences.count > 0
  ) {
    return {
      eligibility: ELIGIBILITY.ACTIVE_REFERENCE,
      reason: REASON.ACTIVE_REFERENCE,
      evidence: buildEvidence(inventory, REASON.ACTIVE_REFERENCE, {
        activeReferenceCount: inventory.activeReferences.count,
      }),
    };
  }
  if (inventory.workingTree.observable !== true) {
    return {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: REASON.EVIDENCE_NOT_DURABLE,
      evidence: buildEvidence(inventory, REASON.EVIDENCE_NOT_DURABLE),
    };
  }
  // unmerged를 dirty보다 먼저 본다 -- 충돌(unmerged) 라인은 항상 dirty도
  // true로 만들기 때문에(git status 표에서 conflict도 "변경 있음"으로
  // 집계된다), 순서를 뒤집으면 unmerged 케이스가 절대 자기 고유 사유
  // (UNMERGED_WORKING_TREE)로 보고되지 못한다(mutation #6b가 이 순서를
  // 고정한다).
  if (inventory.workingTree.unmerged) {
    return {
      eligibility: ELIGIBILITY.DIRTY_OR_UNMERGED,
      reason: REASON.UNMERGED_WORKING_TREE,
      evidence: buildEvidence(inventory, REASON.UNMERGED_WORKING_TREE, {
        workingTree: inventory.workingTree,
      }),
    };
  }
  if (inventory.workingTree.dirty) {
    return {
      eligibility: ELIGIBILITY.DIRTY_OR_UNMERGED,
      reason: REASON.DIRTY_WORKING_TREE,
      evidence: buildEvidence(inventory, REASON.DIRTY_WORKING_TREE, {
        workingTree: inventory.workingTree,
      }),
    };
  }
  // mutation #6 (3번째 독립 사유): policy.requireDurableEvidence===true인
  // 정책 아래서는 orca 자신의 등록 id(worktreeId)가 3층 관측을 corroborate
  // 해야 한다 -- 이는 3층 present/absent 판정(classifyObservation)과는
  // 별개 축이다(observation이 이미 CONSISTENT_PRESENT라도, orca가 그
  // 표적에 자기 id를 못 붙였다면 "path 문자열 일치"만으로 삭제를 허가하지
  // 않는다는 추가 안전판).
  if (
    policy.requireDurableEvidence === true &&
    !isNonEmptyString(inventory.target.worktreeId)
  ) {
    return {
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      reason: REASON.EVIDENCE_NOT_DURABLE,
      evidence: buildEvidence(inventory, REASON.EVIDENCE_NOT_DURABLE, {
        worktreeId: inventory.target.worktreeId,
      }),
    };
  }
  return {
    eligibility: ELIGIBILITY.ELIGIBLE,
    reason: REASON.ELIGIBLE,
    evidence: buildEvidence(inventory, REASON.ELIGIBLE),
  };
}

// judgeTeardown({ inventory, policy }) -- policy: { protectedTargets: string[],
// requireDurableEvidence?: boolean }. 순수 판정, 부작용 0.
export function judgeTeardown({ inventory, policy } = {}) {
  const p = isPlainObject(policy) ? policy : {};
  if (!isValidInventoryShape(inventory)) {
    return {
      observation: OBSERVATION.UNOBSERVABLE,
      eligibility: ELIGIBILITY.EVIDENCE_NOT_DURABLE,
      execution: EXECUTION.NOT_ATTEMPTED,
      allowSink: false,
      reason: REASON.SCHEMA_INVALID,
      evidence: { ruleId: REASON.SCHEMA_INVALID, inventory: inventory ?? null },
    };
  }

  const observation = classifyObservation(inventory);
  const {
    eligibility,
    reason: eligibilityReason,
    evidence,
  } = classifyEligibility(inventory, p);

  // observation !== CONSISTENT_PRESENT이면서 eligibility가 ELIGIBLE인
  // 경우(예: 이미 지워진 대상), 보고 사유는 관측 축이 우선한다 -- "이미
  // 없는 표적을 성공으로 세지 않는다"(§2-B CONSISTENT_ABSENT ≠ 성공)와
  // 대칭으로, 여기서도 관측 축이 진짜 차단 사유를 더 정확히 설명한다.
  let reason = eligibilityReason;
  if (
    eligibility === ELIGIBILITY.ELIGIBLE &&
    observation !== OBSERVATION.CONSISTENT_PRESENT
  ) {
    reason =
      observation === OBSERVATION.CONSISTENT_ABSENT
        ? REASON.CONSISTENT_ABSENT
        : observation === OBSERVATION.SPLIT_STATE
          ? REASON.SPLIT_STATE
          : REASON.UNOBSERVABLE_LAYER;
  }

  const allowSink =
    observation === OBSERVATION.CONSISTENT_PRESENT &&
    eligibility === ELIGIBILITY.ELIGIBLE;

  return {
    observation,
    eligibility,
    execution: EXECUTION.NOT_ATTEMPTED,
    allowSink,
    reason,
    evidence,
  };
}

function layersAllAbsent(inv) {
  return (
    isPlainObject(inv) &&
    inv.layers?.git === "absent" &&
    inv.layers?.orca === "absent" &&
    inv.layers?.dir === "absent"
  );
}
function layersAllPresent(inv) {
  return (
    isPlainObject(inv) &&
    inv.layers?.git === "present" &&
    inv.layers?.orca === "present" &&
    inv.layers?.dir === "present"
  );
}

// judgePostConditions({ before, after, cliOk }) -- sink 실행 뒤 사후 3층
// 재관측(after)만으로 성패를 낸다. cliOk(rm 응답의 ok:true)는 절대 단독
// 근거가 아니다(mutation #11: cliOk:true + after가 split이면 FAILED_SPLIT).
// `before`는 이 판정 자체에 쓰이지 않는다(호출자의 로그/증거 보존용으로만
// 함께 넘어온다) -- 성패는 오직 사후 관측(after)만으로 정해진다.
export function judgePostConditions({ after } = {}) {
  if (layersAllAbsent(after)) {
    return EXECUTION.SUCCEEDED;
  }
  if (layersAllPresent(after)) {
    return EXECUTION.FAILED_UNCHANGED;
  }
  return EXECUTION.FAILED_SPLIT;
}
