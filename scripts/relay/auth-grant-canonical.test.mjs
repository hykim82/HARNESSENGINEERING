import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalizeGrant,
  canonicalStringify,
} from "./auth-grant-canonical.mjs";

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// 실 자격 경로와 완전 격리된 합성 fixture -- 임의 문자열을 해시했을 뿐, 실제
// packet/addendum/authorization/task 파일을 참조하지 않는다.
const GOOD_FIELDS = Object.freeze({
  schema_version: 1,
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
  }),
  audience: "CODER",
  channel: "orca-dispatch",
  arm_id: "arm-test-1",
  cycle_id: "cycle-test-1",
  expires_at: "2026-07-20T23:59:00.000Z",
  budget: Object.freeze({ max_starts_total: 1 }),
  jti: "jti-test-1",
});

test("canonicalizeGrant: known-good fields produce ok:true with canonical bytes", () => {
  const result = canonicalizeGrant(GOOD_FIELDS);
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.canonicalBytes));
  assert.equal(typeof result.canonicalJson, "string");
});

test("canonicalizeGrant: field order in the input does not change canonical bytes", () => {
  // 죽이는 변이: canonicalStringify가 입력 키 순서를 그대로 따른다면(정렬 누락),
  // 이 테스트는 두 바이트열이 달라져 실패한다 -- 서명자/검증자가 다른 순서로
  // 객체를 만들면 서명이 항상 깨지는 회귀를 잡는다.
  const reordered = {
    jti: GOOD_FIELDS.jti,
    budget: { max_starts_total: 1 },
    expires_at: GOOD_FIELDS.expires_at,
    cycle_id: GOOD_FIELDS.cycle_id,
    arm_id: GOOD_FIELDS.arm_id,
    channel: GOOD_FIELDS.channel,
    audience: GOOD_FIELDS.audience,
    target: {
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
  const a = canonicalizeGrant(GOOD_FIELDS);
  const b = canonicalizeGrant(reordered);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.canonicalJson, b.canonicalJson);
  assert.deepEqual(a.canonicalBytes, b.canonicalBytes);
});

test("canonicalStringify: sorts nested object keys deterministically", () => {
  assert.equal(
    canonicalStringify({ b: 1, a: { d: 2, c: 3 } }),
    '{"a":{"c":3,"d":2},"b":1}',
  );
});

test("canonicalizeGrant: rejects non-plain-object input", () => {
  const result = canonicalizeGrant(null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a plain object/);
});

test("canonicalizeGrant: budget.max_starts_total must be exactly 1", () => {
  const result = canonicalizeGrant({
    ...GOOD_FIELDS,
    budget: { max_starts_total: 2 },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /budget/);
});

test("canonicalizeGrant: rejects malformed sha256 fields", () => {
  const result = canonicalizeGrant({
    ...GOOD_FIELDS,
    packet_sha256: "not-a-hash",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /packet_sha256/);
});

test("canonicalizeGrant: rejects target missing agent_instance", () => {
  const result = canonicalizeGrant({
    ...GOOD_FIELDS,
    target: { handle: "h", fingerprint: "f" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /target/);
});

test("canonicalizeGrant: rejects non-ISO expires_at", () => {
  const result = canonicalizeGrant({
    ...GOOD_FIELDS,
    expires_at: "not-a-date",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /expires_at/);
});

// G2 전 필드 개별 결측 -- 각각 독립적으로 CANONICAL_INVALID을 내야 한다(하나
// 빠져도 canonicalizeGrant가 "필드 없어도 통과"하는 회귀를 잡는다).
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
  "expires_at",
  "budget",
  "jti",
]) {
  test(`canonicalizeGrant: rejects missing field '${field}'`, () => {
    const broken = { ...GOOD_FIELDS };
    delete broken[field];
    const result = canonicalizeGrant(broken);
    assert.equal(result.ok, false);
  });
}
