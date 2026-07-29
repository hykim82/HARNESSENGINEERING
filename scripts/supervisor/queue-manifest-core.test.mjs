import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateQueueManifest,
  QUEUE_CONTRACT_VERSION,
  QUEUE_VERDICT,
  QUEUE_REASON,
} from "./queue-manifest-core.mjs";

// HYK-183 v1 사이클1 (coder-task.md §3-3) -- queue-manifest-core.mjs의
// 판정 계약 테스트. SV-3(보호 브랜치 exact commit)/SV-4(append-only 위반
// 검출) + fail-closed 계열을 덮는다.
//
// 이 계약이 보장하지 않는 것 (상시기준 S11):
// 1. 주장 범위 -- 여기서 만드는 observation은 전부 손으로 조립한 리터럴
//    이다. 실제 git/GitHub 어댑터가 만드는 관측이 이 형태와 일치하는지는
//    여기서 증명하지 않는다(다음 사이클 몫).
// 2. 표본 수와 조건 -- 아래 fixture 전부 SYNTHETIC. 이 파일에서 만든
//    positive fixture 1건 + negative fixture 다수(구체 수는 각 test 이름
//    참조), 모두 손으로 구성한 값이다. 측정치(MEASURED)는 없다.
// 3. 이 검사가 통과해도 여전히 열려 있는 구멍 -- 이 스위트가 100% 통과해도
//    "실제 저장소가 이 계약을 지킨다"를 보증하지 않는다. 순수 함수의 입/
//    출력 계약만 검증한다.

function baseEntry(overrides = {}) {
  return {
    issue_id: "HYK-100",
    ordinal: 1,
    approved_merge_commit: "a".repeat(40),
    enabled: true,
    ...overrides,
  };
}

function validObservation(overrides = {}) {
  return {
    schema_version: "queue-observation/v1",
    repo: {
      head_commit: "c".repeat(40),
      head_branch_name: "master",
      protected_branch_name: "master",
      is_dirty: false,
      is_alternate_checkout: false,
    },
    manifest_commit: {
      sha: "c".repeat(40),
      is_merge_commit: true,
      human_approved: true,
    },
    manifest_blob: {
      sha256: "b".repeat(64),
      expected_sha256: "b".repeat(64),
      bytes: 512,
    },
    manifest: {
      schema_version: "queue-manifest/v1",
      queue_epoch: 3,
      entries: [
        baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
        baseEntry({ issue_id: "HYK-101", ordinal: 2, enabled: false }),
        baseEntry({ issue_id: "HYK-102", ordinal: 3 }),
      ],
    },
    previous_approved: {
      queue_epoch: 2,
      entries: [
        baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
        baseEntry({ issue_id: "HYK-101", ordinal: 2, enabled: false }),
      ],
    },
    ...overrides,
  };
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

// ---------------------------------------------------------------------------
// 관측 스키마 lock -- 키 축 + 타입 축(4b-2c 전례를 따라 둘 다 잠근다).
// ---------------------------------------------------------------------------
test("schema lock: observation top-level has exactly the 6 contracted keys", () => {
  const o = validObservation();
  assert.deepEqual(
    Object.keys(o).sort(),
    [
      "schema_version",
      "repo",
      "manifest_commit",
      "manifest_blob",
      "manifest",
      "previous_approved",
    ].sort(),
  );
});
test("schema lock: repo section has exactly the 5 contracted keys", () => {
  const o = validObservation();
  assert.deepEqual(
    Object.keys(o.repo).sort(),
    [
      "head_commit",
      "head_branch_name",
      "protected_branch_name",
      "is_dirty",
      "is_alternate_checkout",
    ].sort(),
  );
});
test("schema lock: manifest_commit section has exactly the 3 contracted keys", () => {
  const o = validObservation();
  assert.deepEqual(
    Object.keys(o.manifest_commit).sort(),
    ["sha", "is_merge_commit", "human_approved"].sort(),
  );
});
test("schema lock: manifest_blob section has exactly the 3 contracted keys", () => {
  const o = validObservation();
  assert.deepEqual(
    Object.keys(o.manifest_blob).sort(),
    ["sha256", "expected_sha256", "bytes"].sort(),
  );
});
test("schema lock: manifest section has exactly the 3 contracted keys", () => {
  const o = validObservation();
  assert.deepEqual(
    Object.keys(o.manifest).sort(),
    ["schema_version", "queue_epoch", "entries"].sort(),
  );
});
test("schema lock: entry has exactly the 4 contracted keys", () => {
  const o = validObservation();
  assert.deepEqual(
    Object.keys(o.manifest.entries[0]).sort(),
    ["issue_id", "ordinal", "approved_merge_commit", "enabled"].sort(),
  );
});

const OBSERVATION_FIELD_TYPES = {
  schema_version: "string",
};
for (const [field, type] of Object.entries(OBSERVATION_FIELD_TYPES)) {
  test(`type lock: observation.${field} is typeof ${type}`, () => {
    const o = validObservation();
    assert.equal(typeof o[field], type);
  });
}
const REPO_FIELD_TYPES = {
  head_commit: "string",
  head_branch_name: "string",
  protected_branch_name: "string",
  is_dirty: "boolean",
  is_alternate_checkout: "boolean",
};
for (const [field, type] of Object.entries(REPO_FIELD_TYPES)) {
  test(`type lock: observation.repo.${field} is typeof ${type}`, () => {
    const o = validObservation();
    assert.equal(typeof o.repo[field], type);
  });
}
const ENTRY_FIELD_TYPES = {
  issue_id: "string",
  ordinal: "number",
  approved_merge_commit: "string",
  enabled: "boolean",
};
for (const [field, type] of Object.entries(ENTRY_FIELD_TYPES)) {
  test(`type lock: entry.${field} is typeof ${type}`, () => {
    const o = validObservation();
    assert.equal(typeof o.manifest.entries[0][field], type);
  });
}

// ---------------------------------------------------------------------------
// 계약 상수
// ---------------------------------------------------------------------------
test("QUEUE_CONTRACT_VERSION is the fixed literal 'queue-manifest/v1'", () => {
  assert.equal(QUEUE_CONTRACT_VERSION, "queue-manifest/v1");
});

// ---------------------------------------------------------------------------
// 긍정 대조군 -- 전부 정상 -> START_ALLOWED + entries 내용 정확성(개수뿐
// 아니라 issue_id/ordinal 값·순서, enabled:false 제외 여부까지).
// ---------------------------------------------------------------------------
test("positive: fully valid observation -> START_ALLOWED with exact entries content (order, values, enabled:false excluded)", () => {
  const result = evaluateQueueManifest(validObservation());
  assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
  assert.equal(result.reason, QUEUE_REASON.OK);
  assert.deepEqual(result.entries, [
    {
      issue_id: "HYK-100",
      ordinal: 1,
      approved_merge_commit: "a".repeat(40),
      enabled: true,
    },
    {
      issue_id: "HYK-102",
      ordinal: 3,
      approved_merge_commit: "a".repeat(40),
      enabled: true,
    },
  ]);
});

test("positive: entries with ordinal gaps (1, 5, 10) still return in exact ascending order (sort is not assumed to be a no-op)", () => {
  const o = validObservation();
  o.manifest.entries = [
    baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
    baseEntry({ issue_id: "HYK-101", ordinal: 5, enabled: false }),
    baseEntry({ issue_id: "HYK-102", ordinal: 10 }),
  ];
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
  assert.deepEqual(
    result.entries.map((e) => e.issue_id),
    ["HYK-100", "HYK-102"],
  );
});
// Note: a manifest array whose elements are out of ordinal order (e.g.
// [3, 1, 2]) is itself rejected by ORDINAL_NOT_MONOTONIC (SV-4 below) --
// the array read order IS the ordinal order by contract (§3 판정 순서).
// So "input unordered -> output re-sorted" is not a reachable positive
// case; the .sort() in the implementation exists only as a defensive
// second guarantee alongside the monotonic gate, not as the primary sort.

// ---------------------------------------------------------------------------
// fail-closed 계열 -- null/undefined/문자열/빈 객체/필수 절 누락/타입
// 뒤바뀜 -> 전건 START_BLOCKED. entries는 항상 빈 배열.
// ---------------------------------------------------------------------------
for (const badInput of [null, undefined, "queue", 42, [], true]) {
  test(`fail-closed: evaluateQueueManifest(${JSON.stringify(badInput)}) -> START_BLOCKED/OBSERVATION_MISSING`, () => {
    const result = evaluateQueueManifest(badInput);
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MISSING);
    assert.deepEqual(result.entries, []);
  });
}
test("fail-closed: {} (empty object) -> START_BLOCKED/OBSERVATION_MALFORMED", () => {
  const result = evaluateQueueManifest({});
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
  assert.deepEqual(result.entries, []);
});
for (const section of [
  "repo",
  "manifest_commit",
  "manifest_blob",
  "manifest",
]) {
  test(`fail-closed: missing required section '${section}' -> START_BLOCKED/OBSERVATION_MALFORMED`, () => {
    const o = validObservation();
    delete o[section];
    const result = evaluateQueueManifest(o);
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
    assert.deepEqual(result.entries, []);
  });
}
test("fail-closed: previous_approved key entirely absent -> START_BLOCKED/OBSERVATION_MALFORMED (no default-null)", () => {
  const o = validObservation();
  delete o.previous_approved;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});
test('fail-closed: repo.is_dirty as the STRING "false" (type-swap, not boolean) -> START_BLOCKED/OBSERVATION_MALFORMED, never treated as falsy-pass', () => {
  const o = validObservation();
  o.repo.is_dirty = "false";
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
  assert.deepEqual(result.entries, []);
});
test('fail-closed: repo.is_alternate_checkout as the STRING "false" -> START_BLOCKED/OBSERVATION_MALFORMED', () => {
  const o = validObservation();
  o.repo.is_alternate_checkout = "false";
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});
test("fail-closed: manifest.queue_epoch as a negative number -> START_BLOCKED/OBSERVATION_MALFORMED", () => {
  const o = validObservation();
  o.manifest.queue_epoch = -1;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});
test("fail-closed: manifest.entries is not an array (an object instead) -> START_BLOCKED/OBSERVATION_MALFORMED", () => {
  const o = validObservation();
  o.manifest.entries = { HYK_100: baseEntry() };
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});
test("fail-closed: manifest.entries contains a null element -> START_BLOCKED/OBSERVATION_MALFORMED (no crash)", () => {
  const o = validObservation();
  o.manifest.entries.push(null);
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});

// ---------------------------------------------------------------------------
// OBSERVATION_SCHEMA_UNSUPPORTED / MANIFEST_SCHEMA_UNSUPPORTED
// ---------------------------------------------------------------------------
test("observation.schema_version unsupported value -> START_BLOCKED/OBSERVATION_SCHEMA_UNSUPPORTED", () => {
  const o = validObservation({ schema_version: "queue-observation/v2" });
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_SCHEMA_UNSUPPORTED);
});
test("manifest.schema_version unsupported value -> START_BLOCKED/MANIFEST_SCHEMA_UNSUPPORTED", () => {
  const o = validObservation();
  o.manifest.schema_version = "queue-manifest/v0";
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.MANIFEST_SCHEMA_UNSUPPORTED);
});

// ---------------------------------------------------------------------------
// SV-3 계열 -- dirty checkout · 로컬 수정본(blob mismatch) · 미승인 commit ·
// 보호 브랜치 아님 · merge commit 아님 · HEAD/manifest commit 불일치 ·
// alternate checkout. (패킷 §3의 "3종"은 하한 -- 여기서는 7종 반례.)
// ---------------------------------------------------------------------------
test("SV-3: not on protected branch (head_branch_name !== protected_branch_name) -> START_BLOCKED/NOT_PROTECTED_BRANCH", () => {
  const o = validObservation();
  o.repo.head_branch_name = "feature/whatever";
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.NOT_PROTECTED_BRANCH);
});
test("SV-3: manifest commit is not a merge commit -> START_BLOCKED/NOT_MERGE_COMMIT", () => {
  const o = validObservation();
  o.manifest_commit.is_merge_commit = false;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.NOT_MERGE_COMMIT);
});
test("SV-3: unapproved commit (human_approved: false) -> START_BLOCKED/NOT_HUMAN_APPROVED", () => {
  const o = validObservation();
  o.manifest_commit.human_approved = false;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.NOT_HUMAN_APPROVED);
});
test("SV-3: HEAD commit != manifest commit sha -> START_BLOCKED/COMMIT_MISMATCH", () => {
  const o = validObservation();
  o.repo.head_commit = "d".repeat(40);
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.COMMIT_MISMATCH);
});
test("SV-3: local modification (blob sha256 != expected_sha256) -> START_BLOCKED/BLOB_HASH_MISMATCH", () => {
  const o = validObservation();
  o.manifest_blob.sha256 = "f".repeat(64);
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.BLOB_HASH_MISMATCH);
});
test("SV-3: dirty checkout (is_dirty: true) -> START_BLOCKED/WORKTREE_DIRTY", () => {
  const o = validObservation();
  o.repo.is_dirty = true;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.WORKTREE_DIRTY);
});
test("SV-3: alternate checkout (is_alternate_checkout: true) -> START_BLOCKED/ALTERNATE_CHECKOUT", () => {
  const o = validObservation();
  o.repo.is_alternate_checkout = true;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ALTERNATE_CHECKOUT);
});

// ---------------------------------------------------------------------------
// SV-4 계열 -- 항목 삭제 · 순서 변경 · 비승인 추가(=이전본 공통 항목 변조) ·
// ordinal 중복 · ordinal 비단조 · issue_id 중복 · queue_epoch 후퇴.
// ---------------------------------------------------------------------------
test("SV-4: queue_epoch regressed vs previous_approved -> START_BLOCKED/QUEUE_EPOCH_REGRESSED", () => {
  const o = validObservation();
  o.manifest.queue_epoch = 1; // previous_approved.queue_epoch === 2
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.QUEUE_EPOCH_REGRESSED);
});
test("SV-4: duplicate ordinal within manifest entries -> START_BLOCKED/ORDINAL_DUPLICATE", () => {
  const o = validObservation();
  o.manifest.entries[2].ordinal = 1; // collides with entries[0]
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ORDINAL_DUPLICATE);
});
test("SV-4: ordinal not monotonic (array order 1,3,2) -> START_BLOCKED/ORDINAL_NOT_MONOTONIC", () => {
  const o = validObservation();
  o.manifest.entries = [
    baseEntry({ issue_id: "HYK-100", ordinal: 1 }),
    baseEntry({ issue_id: "HYK-102", ordinal: 3 }),
    baseEntry({ issue_id: "HYK-101", ordinal: 2 }),
  ];
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ORDINAL_NOT_MONOTONIC);
});
test("SV-4: duplicate issue_id within manifest entries -> START_BLOCKED/ISSUE_DUPLICATE", () => {
  const o = validObservation();
  o.manifest.entries[2].issue_id = "HYK-100"; // collides with entries[0], ordinals stay distinct/monotonic
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ISSUE_DUPLICATE);
});
test("SV-4 (load-bearing, isolates ENTRY_MALFORMED from the duplicate/monotonic checks above): entry with wrong-typed 'enabled' field, ordinals/issue_ids all unique+monotonic -> START_BLOCKED/ENTRY_MALFORMED", () => {
  const o = validObservation();
  o.manifest.entries[2].enabled = "true"; // string, not boolean
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ENTRY_MALFORMED);
});
test("SV-4 (ENTRY_MALFORMED, missing field): entry missing approved_merge_commit entirely -> START_BLOCKED/ENTRY_MALFORMED", () => {
  const o = validObservation();
  delete o.manifest.entries[2].approved_merge_commit;
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ENTRY_MALFORMED);
});
test("SV-4 (ENTRY_MALFORMED, extra field): entry has an unexpected extra key -> START_BLOCKED/ENTRY_MALFORMED", () => {
  const o = validObservation();
  o.manifest.entries[2].priority = "high"; // no free-value priority (packet contract)
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ENTRY_MALFORMED);
});
test("SV-4: append-only removed -- previous_approved has an issue_id absent from current entries -> START_BLOCKED/APPEND_ONLY_REMOVED", () => {
  const o = validObservation();
  o.manifest.entries = [baseEntry({ issue_id: "HYK-102", ordinal: 1 })]; // HYK-100/HYK-101 both gone
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.APPEND_ONLY_REMOVED);
});
test("SV-4: append-only reordered -- a common issue_id's ordinal changed vs previous_approved -> START_BLOCKED/APPEND_ONLY_REORDERED", () => {
  const o = validObservation();
  o.manifest.entries = [
    baseEntry({ issue_id: "HYK-101", ordinal: 1, enabled: false }),
    baseEntry({ issue_id: "HYK-100", ordinal: 2 }), // was ordinal 1 in previous_approved
    baseEntry({ issue_id: "HYK-102", ordinal: 3 }),
  ];
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.APPEND_ONLY_REORDERED);
});
test("SV-4: append-only mutated -- unapproved addition disguised as an edit to a common entry's approved_merge_commit -> START_BLOCKED/APPEND_ONLY_MUTATED", () => {
  const o = validObservation();
  o.manifest.entries[0].approved_merge_commit = "9".repeat(40); // HYK-100's commit changed
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.APPEND_ONLY_MUTATED);
});
test("SV-4: append-only appended-only (new issue_id/ordinal added, all previous entries untouched) -> START_ALLOWED (this is the allowed shape of a legitimate PR)", () => {
  const o = validObservation();
  o.manifest.entries.push(baseEntry({ issue_id: "HYK-103", ordinal: 4 }));
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
});

// ---------------------------------------------------------------------------
// previous_approved === null (최초 큐) -- append-only 3검사는 건너뛴다.
// "이전본이 없으니 무조건 통과"로 새지 않는지 고정한다: queue_epoch는
// 여전히 정수 0 이상이어야 한다.
// ---------------------------------------------------------------------------
test("previous_approved === null: append-only checks are skipped, a fully valid first-ever queue -> START_ALLOWED", () => {
  const o = validObservation();
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
});
test("previous_approved === null: negative queue_epoch is still rejected -- 'no previous means unconditional pass' is NOT the rule -> START_BLOCKED/OBSERVATION_MALFORMED", () => {
  const o = validObservation();
  o.previous_approved = null;
  o.manifest.queue_epoch = -5;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});
test("previous_approved === null: queue_epoch === 0 is accepted (zero is a valid non-negative integer) -> START_ALLOWED", () => {
  const o = validObservation();
  o.previous_approved = null;
  o.manifest.queue_epoch = 0;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
});
test("previous_approved === null: an ordinal/issue_id violation is STILL caught (append-only skip does not disable the other checks) -> START_BLOCKED/ORDINAL_DUPLICATE", () => {
  const o = validObservation();
  o.previous_approved = null;
  o.manifest.entries[2].ordinal = 1;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ORDINAL_DUPLICATE);
});
test("previous_approved malformed (missing queue_epoch) -> START_BLOCKED/OBSERVATION_MALFORMED", () => {
  const o = validObservation();
  delete o.previous_approved.queue_epoch;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.OBSERVATION_MALFORMED);
});

// ---------------------------------------------------------------------------
// enabled:false 항목 -- append-only·유일성 검사 대상에는 포함되고, entries
// 출력에서만 제외된다.
// ---------------------------------------------------------------------------
test("enabled:false entries are still checked for append-only violations (disabling ordinal/issue_id continuity still matters)", () => {
  const o = validObservation();
  // HYK-101 was enabled:false in previous_approved too; mutate its
  // approved_merge_commit while keeping enabled:false -- must still be
  // caught as APPEND_ONLY_MUTATED even though it never appears in output.
  o.manifest.entries[1].approved_merge_commit = "9".repeat(40);
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.APPEND_ONLY_MUTATED);
});
test("enabled:false entries participate in ordinal/issue_id uniqueness checks", () => {
  const o = validObservation();
  o.manifest.entries[1].ordinal = 1; // disabled entry collides with entries[0]'s ordinal
  o.previous_approved = null;
  const result = evaluateQueueManifest(o);
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, QUEUE_REASON.ORDINAL_DUPLICATE);
});
test("enabled:false entries are excluded from the returned entries array even though they pass all checks", () => {
  const result = evaluateQueueManifest(validObservation());
  assert.equal(
    result.entries.some((e) => e.issue_id === "HYK-101"),
    false,
  );
});

// ---------------------------------------------------------------------------
// START_BLOCKED -> entries는 항상 빈 배열(부분 실행 금지) -- 여러 반례에
// 걸쳐 재확인.
// ---------------------------------------------------------------------------
test("every START_BLOCKED verdict across all negative fixtures above returns entries === []", () => {
  const mutators = [
    (o) => {
      o.repo.head_branch_name = "feature/x";
    },
    (o) => {
      o.manifest_commit.is_merge_commit = false;
    },
    (o) => {
      o.repo.is_dirty = true;
    },
    (o) => {
      o.manifest.entries[2].ordinal = 1;
      o.previous_approved = null;
    },
  ];
  for (const mutate of mutators) {
    const o = validObservation();
    mutate(o);
    const result = evaluateQueueManifest(o);
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.deepEqual(result.entries, []);
  }
});

// ---------------------------------------------------------------------------
// 순수성 -- 판정 함수는 입력 observation을 변형하지 않는다(호출자가 같은
// observation을 재사용할 수 있어야 한다).
// ---------------------------------------------------------------------------
test("purity: evaluateQueueManifest does not mutate its input observation", () => {
  const o = validObservation();
  const clone = deepClone(o);
  evaluateQueueManifest(o);
  assert.deepEqual(o, clone);
});
