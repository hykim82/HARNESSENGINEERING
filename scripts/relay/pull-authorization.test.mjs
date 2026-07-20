import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalizeAuthorization } from "./pull-authorization.mjs";

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// M1 격리: 합성 fixture, 실 task-file/authorization 경로 참조 0.
const GOOD_FIELDS = Object.freeze({
  schema_version: 1,
  arm_id: "arm-test-1",
  cycle_id: "cycle-test-1",
  task_id: "HYK-999-coder-1",
  resolved_task_path: "C:\\fake\\.harness\\coder-task.md",
  task_header_id: "HYK-999-coder-1",
  task_header_sha256: sha256("synthetic-task-file-content"),
  lane: "CODER",
  cwd: "C:\\fake\\repo",
  worktree: "C:\\fake\\repo",
  launch_profile_sha256: sha256("synthetic-launch-profile"),
  person_approval_ref: "PKT-TEST-1:승인:OK:2026-07-21",
  publish_allowed: false,
  retry_allowed: false,
  on_question: "pause",
  on_error: "pause",
});

test("canonicalizeAuthorization: known-good fields produce ok:true with a sha256 hash", () => {
  const result = canonicalizeAuthorization(GOOD_FIELDS);
  assert.equal(result.ok, true, result.reason);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("canonicalizeAuthorization: field order in the input does not change the hash", () => {
  const reordered = {
    on_error: GOOD_FIELDS.on_error,
    on_question: GOOD_FIELDS.on_question,
    retry_allowed: GOOD_FIELDS.retry_allowed,
    publish_allowed: GOOD_FIELDS.publish_allowed,
    person_approval_ref: GOOD_FIELDS.person_approval_ref,
    launch_profile_sha256: GOOD_FIELDS.launch_profile_sha256,
    worktree: GOOD_FIELDS.worktree,
    cwd: GOOD_FIELDS.cwd,
    lane: GOOD_FIELDS.lane,
    task_header_sha256: GOOD_FIELDS.task_header_sha256,
    task_header_id: GOOD_FIELDS.task_header_id,
    resolved_task_path: GOOD_FIELDS.resolved_task_path,
    task_id: GOOD_FIELDS.task_id,
    cycle_id: GOOD_FIELDS.cycle_id,
    arm_id: GOOD_FIELDS.arm_id,
    schema_version: GOOD_FIELDS.schema_version,
  };
  const a = canonicalizeAuthorization(GOOD_FIELDS);
  const b = canonicalizeAuthorization(reordered);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.sha256, b.sha256);
});

test("canonicalizeAuthorization: rejects non-plain-object input", () => {
  const result = canonicalizeAuthorization("not-an-object");
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a plain object/);
});

test("canonicalizeAuthorization: rejects malformed task_header_sha256", () => {
  const result = canonicalizeAuthorization({
    ...GOOD_FIELDS,
    task_header_sha256: "not-a-hash",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /task_header_sha256/);
});

test("canonicalizeAuthorization: rejects malformed launch_profile_sha256", () => {
  const result = canonicalizeAuthorization({
    ...GOOD_FIELDS,
    launch_profile_sha256: "not-a-hash",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /launch_profile_sha256/);
});

// 불변경계 고정값 -- publish/retry는 정확히 boolean false, on_question/
// on_error는 정확히 "pause"만 통과한다. truthy-but-not-exact 값(1, "false",
// "no" 등)도 전부 거부해야 한다(느슨한 강제변환으로 새는 회귀 방지).
const POLICY_MUTATIONS = [
  ["publish_allowed", true],
  ["publish_allowed", 0],
  ["publish_allowed", "false"],
  ["retry_allowed", true],
  ["retry_allowed", 1],
  ["on_question", "auto"],
  ["on_question", "resume"],
  ["on_error", "retry"],
  ["on_error", "ignore"],
];
for (const [field, value] of POLICY_MUTATIONS) {
  test(`canonicalizeAuthorization: rejects ${field}=${JSON.stringify(value)}`, () => {
    const result = canonicalizeAuthorization({
      ...GOOD_FIELDS,
      [field]: value,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, new RegExp(field));
  });
}

// authorization 필드 하나만 바뀌어도 해시가 달라져야 한다 -- P10 "authorization
// 불변 필드 불일치 -> claim 0"의 실제 메커니즘 실증. 이 테스트가 죽이는 변이:
// buildCanonicalFields가 필드 하나를 빠뜨리면(리팩터링 실수) 그 필드를
// 바꿔도 해시가 그대로라 여기서 실패한다.
const FIELD_MUTATIONS = [
  ["arm_id", "arm-other"],
  ["cycle_id", "cycle-other"],
  ["task_id", "HYK-OTHER"],
  ["resolved_task_path", "C:\\other\\path.md"],
  ["task_header_id", "HYK-OTHER"],
  ["task_header_sha256", sha256("mutated-task")],
  ["lane", "REVIEW"],
  ["cwd", "C:\\other\\cwd"],
  ["worktree", "C:\\other\\worktree"],
  ["launch_profile_sha256", sha256("mutated-launch-profile")],
  ["person_approval_ref", "PKT-OTHER"],
];
for (const [field, value] of FIELD_MUTATIONS) {
  test(`canonicalizeAuthorization: mutating '${field}' changes the canonical hash`, () => {
    const a = canonicalizeAuthorization(GOOD_FIELDS);
    const b = canonicalizeAuthorization({ ...GOOD_FIELDS, [field]: value });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, b.reason);
    assert.notEqual(a.sha256, b.sha256, field);
  });
}

// 필드 개별 결측 -- 전부 독립적으로 거부돼야 한다.
for (const field of [
  "schema_version",
  "arm_id",
  "cycle_id",
  "task_id",
  "resolved_task_path",
  "task_header_id",
  "task_header_sha256",
  "lane",
  "cwd",
  "worktree",
  "launch_profile_sha256",
  "person_approval_ref",
  "publish_allowed",
  "retry_allowed",
  "on_question",
  "on_error",
]) {
  test(`canonicalizeAuthorization: rejects missing field '${field}'`, () => {
    const broken = { ...GOOD_FIELDS };
    delete broken[field];
    const result = canonicalizeAuthorization(broken);
    assert.equal(result.ok, false);
  });
}
