import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalizePullGrant,
  MAX_PULL_GRANT_LIFETIME_MS,
} from "./pull-grant-canonical.mjs";

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// M1 격리: 임의 문자열을 해시했을 뿐 실 packet/addendum/authorization/task
// 파일을 참조하지 않는다(HYK-163 auth-grant-canonical.test.mjs와 동일 원칙).
const ISSUED_AT = "2026-07-21T00:00:00.000Z";
const EXPIRES_AT = "2026-07-21T00:20:00.000Z"; // 20분 -- 30분 상한 안

const GOOD_FIELDS = Object.freeze({
  schema_version: 2,
  policy_version: 1,
  packet_sha256: sha256("synthetic-packet"),
  addendum_sha256: sha256("synthetic-addendum"),
  authorization_sha256: sha256("synthetic-authorization"),
  task_sha256: sha256("synthetic-task"),
  task_id: "HYK-999-coder-1",
  target: Object.freeze({
    handle: "test-terminal",
    fingerprint: "test-fingerprint",
    agent_instance: "test-agent-instance",
    launch_profile_sha256: sha256("synthetic-launch-profile"),
  }),
  audience: "CODER",
  channel: "harness-signed-pull-v1",
  arm_id: "arm-test-1",
  cycle_id: "cycle-test-1",
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
  budget: Object.freeze({ max_starts_total: 1 }),
  jti: "jti-test-1",
});

test("canonicalizePullGrant: known-good fields produce ok:true with canonical bytes", () => {
  const result = canonicalizePullGrant(GOOD_FIELDS);
  assert.equal(result.ok, true, result.reason);
  assert.ok(Buffer.isBuffer(result.canonicalBytes));
  assert.equal(typeof result.canonicalJson, "string");
});

test("canonicalizePullGrant: field order in the input does not change canonical bytes", () => {
  const reordered = {
    jti: GOOD_FIELDS.jti,
    budget: { max_starts_total: 1 },
    expires_at: GOOD_FIELDS.expires_at,
    issued_at: GOOD_FIELDS.issued_at,
    cycle_id: GOOD_FIELDS.cycle_id,
    arm_id: GOOD_FIELDS.arm_id,
    channel: GOOD_FIELDS.channel,
    audience: GOOD_FIELDS.audience,
    target: {
      launch_profile_sha256: GOOD_FIELDS.target.launch_profile_sha256,
      agent_instance: GOOD_FIELDS.target.agent_instance,
      fingerprint: GOOD_FIELDS.target.fingerprint,
      handle: GOOD_FIELDS.target.handle,
    },
    task_id: GOOD_FIELDS.task_id,
    task_sha256: GOOD_FIELDS.task_sha256,
    authorization_sha256: GOOD_FIELDS.authorization_sha256,
    addendum_sha256: GOOD_FIELDS.addendum_sha256,
    packet_sha256: GOOD_FIELDS.packet_sha256,
    policy_version: GOOD_FIELDS.policy_version,
    schema_version: GOOD_FIELDS.schema_version,
  };
  const a = canonicalizePullGrant(GOOD_FIELDS);
  const b = canonicalizePullGrant(reordered);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.canonicalJson, b.canonicalJson);
  assert.deepEqual(a.canonicalBytes, b.canonicalBytes);
});

test("canonicalizePullGrant: rejects non-plain-object input", () => {
  const result = canonicalizePullGrant(null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a plain object/);
});

test("canonicalizePullGrant: budget.max_starts_total must be exactly 1", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    budget: { max_starts_total: 2 },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /budget/);
});

test("canonicalizePullGrant: rejects malformed sha256 fields", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    packet_sha256: "not-a-hash",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /packet_sha256/);
});

test("canonicalizePullGrant: rejects target missing launch_profile_sha256", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    target: {
      handle: "h",
      fingerprint: "f",
      agent_instance: "a",
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /target/);
});

test("canonicalizePullGrant: rejects target with malformed launch_profile_sha256", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    target: { ...GOOD_FIELDS.target, launch_profile_sha256: "not-a-hash" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /target/);
});

test("canonicalizePullGrant: rejects non-ISO issued_at", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    issued_at: "not-a-date",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /issued_at/);
});

test("canonicalizePullGrant: rejects non-ISO expires_at", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    expires_at: "not-a-date",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expires_at/);
});

// [핵심 공백 (ㄱ) 실증] issued_at이 expires_at보다 뒤(또는 같음)면 구조적으로
// 무효 -- "발급이 만료 뒤에 일어났다"는 앞뒤가 안 맞는 grant를 canonical
// 단계에서 이미 거부한다.
test("canonicalizePullGrant: rejects issued_at at or after expires_at", () => {
  for (const issued_at of [
    GOOD_FIELDS.expires_at,
    "2026-07-21T00:25:00.000Z",
  ]) {
    const result = canonicalizePullGrant({ ...GOOD_FIELDS, issued_at });
    assert.equal(result.ok, false, issued_at);
    assert.match(result.reason, /issued_at.*before.*expires_at/);
  }
});

// [TTL>30분 반사실] expires_at-issued_at이 상한을 넘으면 거부.
test("canonicalizePullGrant: rejects lifetime longer than 30 minutes", () => {
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    issued_at: "2026-07-21T00:00:00.000Z",
    expires_at: "2026-07-21T00:30:00.001Z",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /30 minutes/);
});

test("canonicalizePullGrant: lifetime exactly at the 30 minute boundary is allowed", () => {
  const issuedMs = Date.parse("2026-07-21T00:00:00.000Z");
  const result = canonicalizePullGrant({
    ...GOOD_FIELDS,
    issued_at: new Date(issuedMs).toISOString(),
    expires_at: new Date(issuedMs + MAX_PULL_GRANT_LIFETIME_MS).toISOString(),
  });
  assert.equal(result.ok, true, result.reason);
});

// G2 확장 전 필드 개별 결측 -- 하나 빠져도 canonicalizePullGrant가 "필드
// 없어도 통과"하는 회귀를 잡는다.
for (const field of [
  "schema_version",
  "policy_version",
  "packet_sha256",
  "addendum_sha256",
  "authorization_sha256",
  "task_sha256",
  "task_id",
  "target",
  "audience",
  "channel",
  "arm_id",
  "cycle_id",
  "issued_at",
  "expires_at",
  "budget",
  "jti",
]) {
  test(`canonicalizePullGrant: rejects missing field '${field}'`, () => {
    const broken = { ...GOOD_FIELDS };
    delete broken[field];
    const result = canonicalizePullGrant(broken);
    assert.equal(result.ok, false);
  });
}
