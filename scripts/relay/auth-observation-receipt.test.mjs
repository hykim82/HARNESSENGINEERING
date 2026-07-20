import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  validateReceiptShape,
  judgeReceipt,
  judgeLivenessFromReceipt,
  judgePayloadFromReceipt,
  RECEIPT_VERDICT,
  PAYLOAD_VERDICT,
  HOOK_RESULT,
  RECEIPT_REQUIRED_FIELDS,
} from "./auth-observation-receipt.mjs";

// M1: 이 파일 전체가 합성 receipt fixture만 다룬다 -- 실 Orca 접촉·실 canary
// 산출물 참조 0(사이클3 1단 범위 그대로, 2A/2B는 사람 북극성 게이트 뒤).

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const EXPECTED_TARGET = Object.freeze({
  handle: "canary-terminal",
  worktree: "worktree-canary",
  agent_instance: "agent-canary-1",
});

const GOOD_RECEIPT = Object.freeze({
  canary_id: "canary-001",
  target: EXPECTED_TARGET,
  raw_sha256: sha256("synthetic-raw-orca-output"),
  byte_length: 42,
  orca_version: "orca-0.0.0-synthetic",
  collected_at: "2026-07-21T00:00:00.000Z",
  exit_code: 0,
  positive_control: true,
  hook_result: HOOK_RESULT.HIT,
});

// ---------------------------------------------------------------------------
// validateReceiptShape / judgeReceipt
// ---------------------------------------------------------------------------
test("judgeReceipt: known-good receipt -> PASS", () => {
  const result = judgeReceipt(GOOD_RECEIPT);
  assert.equal(result.verdict, RECEIPT_VERDICT.PASS);
});

test("judgeReceipt: positive_control=false -> FAIL (armed-check itself failed)", () => {
  const result = judgeReceipt({ ...GOOD_RECEIPT, positive_control: false });
  assert.equal(result.verdict, RECEIPT_VERDICT.FAIL);
});

test("judgeReceipt: malformed receipt (not a plain object) never throws -> UNVERIFIED", () => {
  for (const bad of [null, undefined, "string", 42, []]) {
    assert.doesNotThrow(() => {
      const result = judgeReceipt(bad);
      assert.equal(result.verdict, RECEIPT_VERDICT.UNVERIFIED);
    });
  }
});

// [비권위 반사실] hook_result를 HIT<->MISS로 뒤집어도 judgeReceipt의 verdict은
// 불변이어야 한다 -- hook 관측값은 receipt 신뢰도 판정의 권위가 아니다.
test("judgeReceipt: flipping hook_result HIT<->MISS does not change the verdict (non-authority)", () => {
  const hit = judgeReceipt({ ...GOOD_RECEIPT, hook_result: HOOK_RESULT.HIT });
  const miss = judgeReceipt({ ...GOOD_RECEIPT, hook_result: HOOK_RESULT.MISS });
  const unjudgable = judgeReceipt({
    ...GOOD_RECEIPT,
    hook_result: HOOK_RESULT.UNJUDGABLE,
  });
  assert.equal(hit.verdict, RECEIPT_VERDICT.PASS);
  assert.equal(miss.verdict, RECEIPT_VERDICT.PASS);
  assert.equal(unjudgable.verdict, RECEIPT_VERDICT.PASS);
});

test("judgeReceipt: hook_result outside the enum -> UNVERIFIED (structural, still non-authoritative content)", () => {
  const result = judgeReceipt({
    ...GOOD_RECEIPT,
    hook_result: "TOTALLY_MADE_UP",
  });
  assert.equal(result.verdict, RECEIPT_VERDICT.UNVERIFIED);
});

// [필수 필드 단일 결손/변조 전건 UNVERIFIED] -- 죽이는 변이: validateReceiptShape가
// 이 필드 중 하나라도 실제로 검사하지 않으면(리팩터 실수로 체크 누락) 그
// 필드만 결손된 이 테스트가 잘못 PASS를 내 실패한다.
for (const field of RECEIPT_REQUIRED_FIELDS) {
  test(`judgeReceipt: missing required field '${field}' -> UNVERIFIED`, () => {
    const broken = { ...GOOD_RECEIPT };
    delete broken[field];
    const result = judgeReceipt(broken);
    assert.equal(result.verdict, RECEIPT_VERDICT.UNVERIFIED);
    assert.match(result.reason, new RegExp(field.split(".")[0]));
  });
}

test("judgeReceipt: raw_sha256 malformed (not 64 hex chars) -> UNVERIFIED", () => {
  const result = judgeReceipt({ ...GOOD_RECEIPT, raw_sha256: "not-a-hash" });
  assert.equal(result.verdict, RECEIPT_VERDICT.UNVERIFIED);
});

test("judgeReceipt: byte_length negative or non-integer -> UNVERIFIED", () => {
  for (const bad of [-1, 1.5, "42", Number.NaN]) {
    const result = judgeReceipt({ ...GOOD_RECEIPT, byte_length: bad });
    assert.equal(
      result.verdict,
      RECEIPT_VERDICT.UNVERIFIED,
      JSON.stringify(bad),
    );
  }
});

test("judgeReceipt: target missing a sub-field -> UNVERIFIED", () => {
  for (const key of ["handle", "worktree", "agent_instance"]) {
    const target = { ...EXPECTED_TARGET };
    delete target[key];
    const result = judgeReceipt({ ...GOOD_RECEIPT, target });
    assert.equal(result.verdict, RECEIPT_VERDICT.UNVERIFIED, key);
  }
});

test("validateReceiptShape: known-good passes structurally", () => {
  assert.equal(validateReceiptShape(GOOD_RECEIPT).ok, true);
});

// ---------------------------------------------------------------------------
// G6 fail-closed consumer
// ---------------------------------------------------------------------------
const NOW_MS = Date.parse("2026-07-21T00:00:10.000Z");
const MAX_AGE_MS = 30_000;

const GOOD_G6_RECEIPT = Object.freeze({
  ...GOOD_RECEIPT,
  liveness_signal: true,
  observed_target: EXPECTED_TARGET,
  lifecycle_distinguished: true,
});

function judgeG6(overrides = {}) {
  return judgeLivenessFromReceipt({
    receipt: { ...GOOD_G6_RECEIPT, ...overrides },
    expectedTarget: EXPECTED_TARGET,
    nowMs: NOW_MS,
    maxAgeMs: MAX_AGE_MS,
  });
}

test("judgeLivenessFromReceipt: all six pm-3 §3.3 conditions satisfied -> liveness true", () => {
  const result = judgeG6();
  assert.equal(result.liveness, true);
});

test("judgeLivenessFromReceipt: liveness_signal false/null/missing -> DENY (fail-closed)", () => {
  assert.equal(judgeG6({ liveness_signal: false }).liveness, false);
  assert.equal(judgeG6({ liveness_signal: null }).liveness, false);
  const withoutSignal = { ...GOOD_G6_RECEIPT };
  delete withoutSignal.liveness_signal;
  assert.equal(
    judgeLivenessFromReceipt({
      receipt: withoutSignal,
      expectedTarget: EXPECTED_TARGET,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
    }).liveness,
    false,
  );
});

test("judgeLivenessFromReceipt: observed_target handle/worktree/agent_instance mismatch -> DENY each", () => {
  assert.equal(
    judgeG6({ observed_target: { ...EXPECTED_TARGET, handle: "other" } })
      .liveness,
    false,
  );
  assert.equal(
    judgeG6({ observed_target: { ...EXPECTED_TARGET, worktree: "other" } })
      .liveness,
    false,
  );
  assert.equal(
    judgeG6({
      observed_target: { ...EXPECTED_TARGET, agent_instance: "other" },
    }).liveness,
    false,
  );
});

test("judgeLivenessFromReceipt: lifecycle_distinguished missing/false -> DENY (no live/dead contrast evidence)", () => {
  assert.equal(judgeG6({ lifecycle_distinguished: false }).liveness, false);
  const withoutContrast = { ...GOOD_G6_RECEIPT };
  delete withoutContrast.lifecycle_distinguished;
  assert.equal(
    judgeLivenessFromReceipt({
      receipt: withoutContrast,
      expectedTarget: EXPECTED_TARGET,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
    }).liveness,
    false,
  );
});

test("judgeLivenessFromReceipt: stale snapshot (collected_at outside freshness window) -> DENY", () => {
  const result = judgeLivenessFromReceipt({
    receipt: GOOD_G6_RECEIPT,
    expectedTarget: EXPECTED_TARGET,
    nowMs: NOW_MS + MAX_AGE_MS + 1,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.liveness, false);
});

test("judgeLivenessFromReceipt: parse-failure / invalid nowMs-maxAgeMs -> DENY (never throws)", () => {
  assert.doesNotThrow(() => {
    assert.equal(
      judgeLivenessFromReceipt({
        receipt: GOOD_G6_RECEIPT,
        expectedTarget: EXPECTED_TARGET,
        nowMs: Number.NaN,
        maxAgeMs: MAX_AGE_MS,
      }).liveness,
      false,
    );
  });
});

test("judgeLivenessFromReceipt: underlying receipt structurally invalid -> DENY", () => {
  const broken = { ...GOOD_G6_RECEIPT };
  delete broken.canary_id;
  assert.equal(
    judgeLivenessFromReceipt({
      receipt: broken,
      expectedTarget: EXPECTED_TARGET,
      nowMs: NOW_MS,
      maxAgeMs: MAX_AGE_MS,
    }).liveness,
    false,
  );
});

// [보조 필드 비권위] connected/writable/title/preview/lastOutputAt/heartbeat나
// terminal fingerprint를 receipt에 실어 보내도 이 소비자는 그 필드를 아예
// 읽지 않는다 -- 나쁜 값이어도 다른 6조건이 좋으면 여전히 liveness true.
test("judgeLivenessFromReceipt: advisory-only fields (connected/heartbeat/etc.) never change the verdict", () => {
  const result = judgeG6({
    connected: false,
    writable: false,
    heartbeat: null,
    title: null,
    preview: null,
    lastOutputAt: null,
    terminal_fingerprint: "irrelevant-even-if-matching",
  });
  assert.equal(result.liveness, true);
});

// ---------------------------------------------------------------------------
// G9 exact payload consumer
// ---------------------------------------------------------------------------
const EXPECTED_SPEC = "go HYK-999-coder-1";

const GOOD_G9_RECEIPT = Object.freeze({
  ...GOOD_RECEIPT,
  payload_complete: true,
  captured_payload: EXPECTED_SPEC,
});

test("judgePayloadFromReceipt: exact match -> PASS", () => {
  const result = judgePayloadFromReceipt({
    receipt: GOOD_G9_RECEIPT,
    expectedSpec: EXPECTED_SPEC,
  });
  assert.equal(result.verdict, PAYLOAD_VERDICT.PASS);
});

const EXTRA_PAYLOADS = [
  ["trailing whitespace", `${EXPECTED_SPEC} `],
  ["leading whitespace", ` ${EXPECTED_SPEC}`],
  ["trailing newline", `${EXPECTED_SPEC}\n`],
  ["extra permission phrase", `${EXPECTED_SPEC} --grant-all`],
  [
    "preamble prefixed (harmless content, still FAIL)",
    `You are an orchestrated agent.\n${EXPECTED_SPEC}`,
  ],
];
for (const [label, payload] of EXTRA_PAYLOADS) {
  test(`judgePayloadFromReceipt: ${label} -> FAIL (preamble/extra content, even if harmless)`, () => {
    const result = judgePayloadFromReceipt({
      receipt: { ...GOOD_G9_RECEIPT, captured_payload: payload },
      expectedSpec: EXPECTED_SPEC,
    });
    assert.equal(result.verdict, PAYLOAD_VERDICT.FAIL);
  });
}

test("judgePayloadFromReceipt: payload_complete=false -> UNVERIFIED (not FAIL -- capture itself is unproven)", () => {
  const result = judgePayloadFromReceipt({
    receipt: { ...GOOD_G9_RECEIPT, payload_complete: false },
    expectedSpec: EXPECTED_SPEC,
  });
  assert.equal(result.verdict, PAYLOAD_VERDICT.UNVERIFIED);
});

test("judgePayloadFromReceipt: captured_payload missing -> UNVERIFIED", () => {
  const broken = { ...GOOD_G9_RECEIPT };
  delete broken.captured_payload;
  const result = judgePayloadFromReceipt({
    receipt: broken,
    expectedSpec: EXPECTED_SPEC,
  });
  assert.equal(result.verdict, PAYLOAD_VERDICT.UNVERIFIED);
});

test("judgePayloadFromReceipt: underlying receipt structurally invalid -> UNVERIFIED", () => {
  const broken = { ...GOOD_G9_RECEIPT };
  delete broken.orca_version;
  const result = judgePayloadFromReceipt({
    receipt: broken,
    expectedSpec: EXPECTED_SPEC,
  });
  assert.equal(result.verdict, PAYLOAD_VERDICT.UNVERIFIED);
});

test("judgePayloadFromReceipt: expectedSpec missing/empty -> UNVERIFIED (never throws)", () => {
  for (const bad of ["", null, undefined]) {
    assert.doesNotThrow(() => {
      const result = judgePayloadFromReceipt({
        receipt: GOOD_G9_RECEIPT,
        expectedSpec: bad,
      });
      assert.equal(result.verdict, PAYLOAD_VERDICT.UNVERIFIED);
    });
  }
});
