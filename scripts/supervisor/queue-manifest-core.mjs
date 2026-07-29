// HYK-183 v1 사이클1 (coder-task.md §3-1) -- supervisor v1 큐 검증 판정 코어
// (SV-3 · SV-4).
//
// 배경(coder-task.md §1): supervisor는 "한용이 큐에 넣은 이슈를 순서대로
// 완주"시키는 프로그램이다. 그 큐가 위조·변조·오독되면 supervisor가 사람이
// 승인하지 않은 일을 자동으로 시작한다. 이 파일은 그 큐가 (a) 보호 브랜치의
// exact commit인지 (b) blob 해시가 일치하는지 (c) issue/ordinal이 유일한지
// (d) 이전 승인본 대비 append-only인지 (e) dirty/alternate checkout이 아닌지
// 판정만 한다(패킷 PKT-20260728-SUPERVISOR-V1 §2-C).
//
// 이 계약이 보장하지 않는 것 (상시기준 S11):
// 1. 주장 범위 -- 이 코어는 "주어진 observation 객체가 내적으로 일관되고
//    append-only 규약을 지키는가"만 증명한다. observation 자체가 실제 git
//    저장소·GitHub 보호 브랜치·실제 blob에서 왔는지는 증명하지 않는다 --
//    그건 증거를 수집하는 어댑터(다음 사이클)의 몫이다. 이 코어는 I/O가
//    0이므로 호출자가 거짓 observation을 넣으면 그대로 속는다(설계상 그렇다
//    -- 판정과 수집을 분리하는 것이 이 사이클의 목적이다).
// 2. 표본 수와 조건 -- 이 파일 자체는 표본을 만들지 않는다. 표본은 전부
//    queue-manifest-core.test.mjs에 있고, 전부 SYNTHETIC(합성)이다. 실제
//    git 저장소·실제 protected branch·실제 PR에서 측정한 값이 아니다.
// 3. 이 검사가 통과해도 여전히 열려 있는 구멍 -- `human_approved` 필드의
//    권위 있는 출처가 아직 없다(누가·어떻게 이 값을 채우는지는 다음
//    사이클 몫). 이 코어가 START_ALLOWED를 반환해도, 그 observation을
//    누가 어떻게 만들었는지에 대한 보증은 이 파일 밖에 있다.
//
// 비타협(coder-task.md §3-1):
// - I/O 0 -- fs·child_process·네트워크·process.env 읽기 전부 금지.
// - `orca` 문자열 호출 0(SV-12/G9 경계).
// - throw로 판정을 대신하지 않는다 -- 입력이 망가져도 START_BLOCKED를
//   반환한다.
//
// 판정 순서 설계 메모(coder-task.md §3 표와의 정합): coder-task.md §3-1의
// QUEUE_REASON 표는 ENTRY_MALFORMED(항목 필드 완전성)를 ORDINAL_DUPLICATE/
// ORDINAL_NOT_MONOTONIC/ISSUE_DUPLICATE **뒤에** 둔다. 이 코어는 그 순서를
// 문자 그대로 따른다 -- OBSERVATION_MALFORMED 단계에서는 manifest.entries가
// 배열이고 각 원소가 null/undefined가 아님만 확인한다(접근 시 크래시
// 방지). ordinal/issue_id 중복·단조성 검사는 필드가 없거나 타입이 달라도
// (undefined는 Set/비교 연산에서 크래시 없이 안전하게 처리된다) 죽지 않고
// 돌아간다. 각 항목의 4필드 완전성/타입 검사(ENTRY_MALFORMED)는 그 다음에야
// 수행한다 -- 이렇게 해야 표의 위치가 실제로 도달 가능한 코드 경로가 되고
// (죽은 방어선을 만들지 않는다), mutation 원장에서 "제거하면 RED"를
// 실측으로 보일 수 있다. (표 원문은 "6필드"라 적혀 있으나 §3-2 관측
// 스키마에 명시된 entry 필드는 issue_id/ordinal/approved_merge_commit/
// enabled 4개뿐이다 -- 이 코어는 §3-2의 명시적 스키마를 따른다. 완료
// 보고서 §7에 이 불일치를 기록한다.)

export const QUEUE_CONTRACT_VERSION = "queue-manifest/v1";

export const QUEUE_VERDICT = Object.freeze({
  START_ALLOWED: "START_ALLOWED",
  START_BLOCKED: "START_BLOCKED",
});

export const QUEUE_REASON = Object.freeze({
  OK: "OK",
  OBSERVATION_MISSING: "OBSERVATION_MISSING",
  OBSERVATION_MALFORMED: "OBSERVATION_MALFORMED",
  OBSERVATION_SCHEMA_UNSUPPORTED: "OBSERVATION_SCHEMA_UNSUPPORTED",
  MANIFEST_SCHEMA_UNSUPPORTED: "MANIFEST_SCHEMA_UNSUPPORTED",
  NOT_PROTECTED_BRANCH: "NOT_PROTECTED_BRANCH",
  NOT_MERGE_COMMIT: "NOT_MERGE_COMMIT",
  NOT_HUMAN_APPROVED: "NOT_HUMAN_APPROVED",
  COMMIT_MISMATCH: "COMMIT_MISMATCH",
  BLOB_HASH_MISMATCH: "BLOB_HASH_MISMATCH",
  WORKTREE_DIRTY: "WORKTREE_DIRTY",
  ALTERNATE_CHECKOUT: "ALTERNATE_CHECKOUT",
  QUEUE_EPOCH_REGRESSED: "QUEUE_EPOCH_REGRESSED",
  ORDINAL_DUPLICATE: "ORDINAL_DUPLICATE",
  ORDINAL_NOT_MONOTONIC: "ORDINAL_NOT_MONOTONIC",
  ISSUE_DUPLICATE: "ISSUE_DUPLICATE",
  ENTRY_MALFORMED: "ENTRY_MALFORMED",
  APPEND_ONLY_REMOVED: "APPEND_ONLY_REMOVED",
  APPEND_ONLY_REORDERED: "APPEND_ONLY_REORDERED",
  APPEND_ONLY_MUTATED: "APPEND_ONLY_MUTATED",
  UNDECIDABLE: "UNDECIDABLE",
});

const SUPPORTED_OBSERVATION_SCHEMAS = Object.freeze(["queue-observation/v1"]);
const SUPPORTED_MANIFEST_SCHEMAS = Object.freeze(["queue-manifest/v1"]);

const ENTRY_FIELDS = Object.freeze([
  "issue_id",
  "ordinal",
  "approved_merge_commit",
  "enabled",
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isBoolean(v) {
  return typeof v === "boolean";
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isNonNegativeInteger(v) {
  return isFiniteNumber(v) && Number.isInteger(v) && v >= 0;
}

function blocked(reason) {
  return { verdict: QUEUE_VERDICT.START_BLOCKED, reason, entries: [] };
}

function isEntryWellFormed(entry) {
  if (!isPlainObject(entry)) return false;
  if (Object.keys(entry).length !== ENTRY_FIELDS.length) return false;
  for (const field of ENTRY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) return false;
  }
  return (
    isNonEmptyString(entry.issue_id) &&
    isNonNegativeInteger(entry.ordinal) &&
    isNonEmptyString(entry.approved_merge_commit) &&
    isBoolean(entry.enabled)
  );
}

function hasRequiredSections(observation) {
  return (
    isPlainObject(observation.repo) &&
    isPlainObject(observation.manifest_commit) &&
    isPlainObject(observation.manifest_blob) &&
    isPlainObject(observation.manifest)
  );
}

function isRepoSectionWellFormed(repo) {
  return (
    isNonEmptyString(repo.head_commit) &&
    isNonEmptyString(repo.head_branch_name) &&
    isNonEmptyString(repo.protected_branch_name) &&
    isBoolean(repo.is_dirty) &&
    isBoolean(repo.is_alternate_checkout)
  );
}

function isManifestCommitSectionWellFormed(manifestCommit) {
  return (
    isNonEmptyString(manifestCommit.sha) &&
    isBoolean(manifestCommit.is_merge_commit) &&
    isBoolean(manifestCommit.human_approved)
  );
}

function isManifestBlobSectionWellFormed(manifestBlob) {
  return (
    isNonEmptyString(manifestBlob.sha256) &&
    isNonEmptyString(manifestBlob.expected_sha256) &&
    isFiniteNumber(manifestBlob.bytes)
  );
}

// 최상위 구조만 확인한다 -- entries의 각 원소는 null/undefined가 아님만
// 검사해 이후 단계에서 .ordinal/.issue_id 접근이 크래시하지 않게 한다.
// 항목별 4필드 완전성/타입은 여기서 검사하지 않는다(ENTRY_MALFORMED가
// 별도로, 뒤에서 검사한다 -- 판정 순서 설계 메모 참조).
function isManifestSectionWellFormed(manifest) {
  if (!isNonEmptyString(manifest.schema_version)) return false;
  if (!isNonNegativeInteger(manifest.queue_epoch)) return false;
  if (!Array.isArray(manifest.entries)) return false;
  for (const entry of manifest.entries) {
    if (entry === null || entry === undefined) return false;
  }
  return true;
}

function isPreviousApprovedWellFormed(previousApproved) {
  if (previousApproved === null) return true;
  if (!isPlainObject(previousApproved)) return false;
  if (!isNonNegativeInteger(previousApproved.queue_epoch)) return false;
  if (!Array.isArray(previousApproved.entries)) return false;
  for (const entry of previousApproved.entries) {
    if (!isEntryWellFormed(entry)) return false;
  }
  return true;
}

function findDuplicateOrdinal(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.ordinal)) return true;
    seen.add(entry.ordinal);
  }
  return false;
}

function isOrdinalMonotonic(entries) {
  for (let i = 1; i < entries.length; i++) {
    if (!(entries[i].ordinal > entries[i - 1].ordinal)) return false;
  }
  return true;
}

function findDuplicateIssueId(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.issue_id)) return true;
    seen.add(entry.issue_id);
  }
  return false;
}

function findMalformedEntry(entries) {
  return entries.some((entry) => !isEntryWellFormed(entry));
}

function checkAppendOnly(previousApproved, entries) {
  const byIssueId = new Map(entries.map((e) => [e.issue_id, e]));
  for (const prevEntry of previousApproved.entries) {
    const current = byIssueId.get(prevEntry.issue_id);
    if (!current) return QUEUE_REASON.APPEND_ONLY_REMOVED;
    if (current.ordinal !== prevEntry.ordinal) {
      return QUEUE_REASON.APPEND_ONLY_REORDERED;
    }
    if (
      current.issue_id !== prevEntry.issue_id ||
      current.approved_merge_commit !== prevEntry.approved_merge_commit
    ) {
      return QUEUE_REASON.APPEND_ONLY_MUTATED;
    }
  }
  return null;
}

// 구조 검사(§1) -- 필수 절 존재 + 각 절 내부 필드 완전성/타입 + previous_approved
// 키 존재. 통과하면 null, 실패하면 사유 코드 문자열을 반환한다.
function checkObservationStructure(observation) {
  if (!hasRequiredSections(observation))
    return QUEUE_REASON.OBSERVATION_MALFORMED;
  const {
    repo,
    manifest_commit: manifestCommit,
    manifest_blob: manifestBlob,
    manifest,
  } = observation;
  if (!isRepoSectionWellFormed(repo)) return QUEUE_REASON.OBSERVATION_MALFORMED;
  if (!isManifestCommitSectionWellFormed(manifestCommit)) {
    return QUEUE_REASON.OBSERVATION_MALFORMED;
  }
  if (!isManifestBlobSectionWellFormed(manifestBlob)) {
    return QUEUE_REASON.OBSERVATION_MALFORMED;
  }
  if (!isManifestSectionWellFormed(manifest)) {
    return QUEUE_REASON.OBSERVATION_MALFORMED;
  }
  if (!Object.prototype.hasOwnProperty.call(observation, "previous_approved")) {
    return QUEUE_REASON.OBSERVATION_MALFORMED;
  }
  if (!isPreviousApprovedWellFormed(observation.previous_approved)) {
    return QUEUE_REASON.OBSERVATION_MALFORMED;
  }
  return null;
}

// 스키마 검사(§1) -- observation/manifest 스키마 버전이 지원 목록 안인지.
function checkSchemas(observation) {
  if (observation.schema_version !== "queue-observation/v1") {
    return QUEUE_REASON.OBSERVATION_SCHEMA_UNSUPPORTED;
  }
  if (!SUPPORTED_OBSERVATION_SCHEMAS.includes(observation.schema_version)) {
    return QUEUE_REASON.OBSERVATION_SCHEMA_UNSUPPORTED;
  }
  if (
    !SUPPORTED_MANIFEST_SCHEMAS.includes(observation.manifest.schema_version)
  ) {
    return QUEUE_REASON.MANIFEST_SCHEMA_UNSUPPORTED;
  }
  return null;
}

// SV-3 계열(§1) -- 보호 브랜치 exact commit + blob 해시 + worktree 상태.
function checkRepoAndCommit(observation) {
  const {
    repo,
    manifest_commit: manifestCommit,
    manifest_blob: manifestBlob,
  } = observation;
  if (repo.head_branch_name !== repo.protected_branch_name) {
    return QUEUE_REASON.NOT_PROTECTED_BRANCH;
  }
  if (manifestCommit.is_merge_commit !== true)
    return QUEUE_REASON.NOT_MERGE_COMMIT;
  if (manifestCommit.human_approved !== true)
    return QUEUE_REASON.NOT_HUMAN_APPROVED;
  if (repo.head_commit !== manifestCommit.sha)
    return QUEUE_REASON.COMMIT_MISMATCH;
  if (manifestBlob.sha256 !== manifestBlob.expected_sha256) {
    return QUEUE_REASON.BLOB_HASH_MISMATCH;
  }
  if (repo.is_dirty !== false) return QUEUE_REASON.WORKTREE_DIRTY;
  if (repo.is_alternate_checkout !== false)
    return QUEUE_REASON.ALTERNATE_CHECKOUT;
  return null;
}

// SV-4 계열(§1) -- ordinal/issue_id 유일성·단조성 + 항목 필드 완전성.
// (판정 순서 설계 메모: ENTRY_MALFORMED는 의도적으로 이 검사들 뒤에 온다.)
function checkEntries(entries) {
  if (findDuplicateOrdinal(entries)) return QUEUE_REASON.ORDINAL_DUPLICATE;
  if (!isOrdinalMonotonic(entries)) return QUEUE_REASON.ORDINAL_NOT_MONOTONIC;
  if (findDuplicateIssueId(entries)) return QUEUE_REASON.ISSUE_DUPLICATE;
  if (findMalformedEntry(entries)) return QUEUE_REASON.ENTRY_MALFORMED;
  return null;
}

// evaluateQueueManifest(observation) -> { verdict, reason, entries }
//
// verdict === START_ALLOWED일 때만 reason === 'OK'이고 entries는 실행
// 가능한 항목 배열(enabled === true인 것만, ordinal 오름차순)이다.
// verdict === START_BLOCKED이면 entries는 항상 빈 배열이다(부분 실행 금지).
//
// 판정 순서는 QUEUE_REASON 선언 순서를 따른다(결정적 -- 테스트가 사유
// 코드를 정확히 단언할 수 있어야 한다). previous_approved가 null이면
// append-only 3검사(APPEND_ONLY_*)는 건너뛴다(최초 큐) -- 단
// manifest.queue_epoch는 항상(최초 큐 포함) 정수 0 이상이어야 하며,
// 아니면 OBSERVATION_MALFORMED다.
export function evaluateQueueManifest(observation) {
  if (!isPlainObject(observation)) {
    return blocked(QUEUE_REASON.OBSERVATION_MISSING);
  }

  const structureReason = checkObservationStructure(observation);
  if (structureReason) return blocked(structureReason);

  const schemaReason = checkSchemas(observation);
  if (schemaReason) return blocked(schemaReason);

  const repoReason = checkRepoAndCommit(observation);
  if (repoReason) return blocked(repoReason);

  const { manifest, previous_approved: previousApproved } = observation;
  if (
    previousApproved !== null &&
    manifest.queue_epoch < previousApproved.queue_epoch
  ) {
    return blocked(QUEUE_REASON.QUEUE_EPOCH_REGRESSED);
  }

  const entries = manifest.entries;
  const entriesReason = checkEntries(entries);
  if (entriesReason) return blocked(entriesReason);

  if (previousApproved !== null) {
    const appendOnlyReason = checkAppendOnly(previousApproved, entries);
    if (appendOnlyReason) return blocked(appendOnlyReason);
  }

  const allowedEntries = entries
    .filter((e) => e.enabled === true)
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal);

  return {
    verdict: QUEUE_VERDICT.START_ALLOWED,
    reason: QUEUE_REASON.OK,
    entries: allowedEntries,
  };
}
