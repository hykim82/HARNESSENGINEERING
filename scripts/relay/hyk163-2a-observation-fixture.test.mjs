import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  judgeLivenessFromReceipt,
  judgePayloadFromReceipt,
} from "./auth-observation-receipt.mjs";
import {
  G6_EXPECTED_TARGET,
  REAL_2A_G6_RECEIPT,
  REAL_2A_G9_RECEIPT,
  REAL_2A_G9_EXPECTED_SPEC,
} from "./hyk163-2a-observation-fixture.mjs";

// HYK-163 사이클3 2단(pm-3 §5 step6, coder-task HYK-163-coder-6): 실 2A
// read-only 관측 receipt를 self-contained immutable fixture(위 import)로
// judgeLivenessFromReceipt/judgePayloadFromReceipt에 먹여 최종 판정을
// 결정적으로 박제한다.
//
// [사이클3 최종] G6-runtime: UNVERIFIED · G9-TUI: FAIL(strict) ·
// live enable: false. 이건 계약 위반이 아니라 계약 준수 결과다(pm-3 §7,
// 2A-관측-receipt.md §0). 뒤집으려면 계약완화 addendum(사람 재서명)이 먼저다.
//
// M1: 이 파일은 실 Orca를 호출하지 않는다(실 orca 접촉 0). fixture는 위
// import 모듈의 self-contained 리터럴뿐이고, 이 파일도 `D:\` 관제실 경로를
// 런타임에 읽지 않는다.

const NOW_MS = Date.parse("2026-07-21T01:17:55+09:00"); // 2A 관측창 끝
const MAX_AGE_MS = 30 * 60 * 1000; // 30분 freshness 창(임의 합리값, 실측과 무관한 소비자 파라미터)

// ---------------------------------------------------------------------------
// G6 -- 실측 receipt -> liveness:false
// ---------------------------------------------------------------------------
test("G6: real 2A observation receipt -> liveness false (no decisive signal, fail-closed)", () => {
  const result = judgeLivenessFromReceipt({
    receipt: REAL_2A_G6_RECEIPT,
    expectedTarget: G6_EXPECTED_TARGET,
    nowMs: NOW_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.liveness, false);
  // 죽이는 변이: consumer가 liveness_signal=false를 무시하고 아무 값이나
  // true로 승격하면(예: 리팩터 실수로 존재 여부만 검사) 이 assert가 깨진다.
  assert.match(result.reason, /liveness_signal/);
});

// [causal control, 헛시험 금지] 같은 fixture를 반사실로 채우면(6조건 전부
// 충족) liveness:true가 되어야 한다 -- 위 false가 consumer 결함이 아니라
// "Orca가 그런 신호를 안 준다"는 실측 사실 때문임을 증명한다.
test("G6: causal control -- flipping liveness_signal/lifecycle_distinguished true (all 6 pm-3 §3.3 conditions) on the SAME real fixture -> liveness true", () => {
  const counterfactual = {
    ...REAL_2A_G6_RECEIPT,
    liveness_signal: true,
    lifecycle_distinguished: true,
  };
  const result = judgeLivenessFromReceipt({
    receipt: counterfactual,
    expectedTarget: G6_EXPECTED_TARGET,
    nowMs: NOW_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.liveness, true);
  // 죽이는 변이: causal control이 실제로는 아무것도 안 바꾸면(예: 원본
  // receipt를 그대로 재사용하는 실수) 위 test와 이 test가 같은 결과를 내
  // "인과"를 증명하지 못한다 -- 아래로 서로 다른 결과임을 명시적으로 대조.
  const original = judgeLivenessFromReceipt({
    receipt: REAL_2A_G6_RECEIPT,
    expectedTarget: G6_EXPECTED_TARGET,
    nowMs: NOW_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.notEqual(result.liveness, original.liveness);
});

// [agent_instance 부재 branch] Orca 실측 스키마엔 agent_instance에 해당하는
// 필드 자체가 없다(2A-관측-receipt.md §2) -- placeholder 없이 진짜로 그
// 필드가 빠지면 구조 검사(target shape) 단계에서 곧바로 fail-closed됨을
// 별도로 증명한다("agent_instance 부재 또는 liveness_signal=false ... ->
// fail-closed"의 나머지 절반).
test("G6: with agent_instance field truly absent from observed_target (as real Orca schema has none) -> still liveness false", () => {
  const observedWithoutAgentInstance = {
    ...REAL_2A_G6_RECEIPT.observed_target,
  };
  delete observedWithoutAgentInstance.agent_instance;
  const receiptWithoutAgentInstance = {
    ...REAL_2A_G6_RECEIPT,
    observed_target: observedWithoutAgentInstance,
  };
  const result = judgeLivenessFromReceipt({
    receipt: receiptWithoutAgentInstance,
    expectedTarget: G6_EXPECTED_TARGET,
    nowMs: NOW_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  assert.equal(result.liveness, false);
  assert.match(result.reason, /observed_target/);
});

// ---------------------------------------------------------------------------
// G9 -- 실측 receipt -> FAIL
// ---------------------------------------------------------------------------
test("G9: real 2A captured payload (preamble + TASK block) -> FAIL (extra content beyond exact spec)", () => {
  const result = judgePayloadFromReceipt({
    receipt: REAL_2A_G9_RECEIPT,
    expectedSpec: REAL_2A_G9_EXPECTED_SPEC,
  });
  assert.equal(result.verdict, "FAIL");
  // 죽이는 변이: consumer가 부분일치/포함(includes)으로 완화되면(예: startsWith
  // 나 endsWith로 잘못 리팩터) 이 assert가 잘못 PASS를 통과시켜 실패한다.
  assert.match(result.reason, /!=/);
});

// [causal control, 헛시험 금지] captured_payload만 정확히 exact spec으로
// 바꾸면 PASS가 되어야 한다 -- FAIL의 원인이 preamble이지 테스트/consumer
// 결함이 아님을 증명한다.
test("G9: causal control -- captured_payload set to exactly the expected spec (same fixture, one field changed) -> PASS", () => {
  const counterfactual = {
    ...REAL_2A_G9_RECEIPT,
    captured_payload: REAL_2A_G9_EXPECTED_SPEC,
  };
  const result = judgePayloadFromReceipt({
    receipt: counterfactual,
    expectedSpec: REAL_2A_G9_EXPECTED_SPEC,
  });
  assert.equal(result.verdict, "PASS");
});

test("G9: causal control -- payload_complete=false on the same real fixture -> UNVERIFIED (capture unproven, not FAIL)", () => {
  const counterfactual = { ...REAL_2A_G9_RECEIPT, payload_complete: false };
  const result = judgePayloadFromReceipt({
    receipt: counterfactual,
    expectedSpec: REAL_2A_G9_EXPECTED_SPEC,
  });
  assert.equal(result.verdict, "UNVERIFIED");
});

// ---------------------------------------------------------------------------
// [최종 판정 박제] 사이클3 최종: G6 UNVERIFIED · G9 FAIL · live=false.
// 뒤집으려면 계약완화 addendum.
// ---------------------------------------------------------------------------
test("final: real 2A fixtures decisively fix G6=UNVERIFIED, G9=FAIL for this observation window", () => {
  const g6 = judgeLivenessFromReceipt({
    receipt: REAL_2A_G6_RECEIPT,
    expectedTarget: G6_EXPECTED_TARGET,
    nowMs: NOW_MS,
    maxAgeMs: MAX_AGE_MS,
  });
  const g9 = judgePayloadFromReceipt({
    receipt: REAL_2A_G9_RECEIPT,
    expectedSpec: REAL_2A_G9_EXPECTED_SPEC,
  });
  // g6.liveness===false는 이 관측 window에서 "G6-runtime: UNVERIFIED"의
  // 근거다(권위 신호 부재 -- pm-3 §3.3, PASS 조건은 liveness:true인 적이
  // 한 번도 없어야 UNVERIFIED가 유지된다는 뜻은 아니고, 이 receipt가 그
  // PASS 조건을 만족한 적이 없다는 뜻).
  assert.equal(g6.liveness, false, "G6-runtime must remain UNVERIFIED");
  assert.equal(g9.verdict, "FAIL", "G9-TUI must remain FAIL(strict)");
});

// 코드베이스에 live-enable-true로 가는 경로 자체가 없음을 구조적으로 단언
// (관측값이 보안 권위/자동 enable 스위치가 되지 않는다는 하드 제약의 정적
// 증거). 죽이는 변이: 누군가 `liveEnable = true` 같은 스위치를 추가하면
// 이 스캔이 그 문자열을 실제로 잡아야 한다 -- 아래에서 poison 문자열을 한 번
// 실제로 매치시켜 패턴 자체가 죽은 정규식이 아님을 자체 검증한다.
const LIVE_ENABLE_TRUE_PATTERN =
  /live[_-]?enable\s*[:=]\s*true|enableLive\s*\(\s*true|setLiveEnable\s*\(\s*true/i;

test("LIVE_ENABLE_TRUE_PATTERN sanity: the pattern itself actually matches an obvious violation (not a dead regex)", () => {
  assert.match("liveEnable: true", LIVE_ENABLE_TRUE_PATTERN);
  assert.match("live_enable = true", LIVE_ENABLE_TRUE_PATTERN);
  assert.match("enableLive(true)", LIVE_ENABLE_TRUE_PATTERN);
  assert.doesNotMatch("liveEnable: false", LIVE_ENABLE_TRUE_PATTERN);
});

// 이 테스트 파일 자체는 스캔 대상에서 뺀다 -- 바로 위 sanity test가 패턴
// 회귀 방지용으로 "liveEnable: true" 같은 poison 문자열을 의도적으로 담고
// 있어(패턴이 실제로 매치하는지 자체 검증), 자기 자신을 스캔하면 그 문자열
// 때문에 항상 거짓 실패한다.
const SCANNED_MODULES_FOR_LIVE_ENABLE = [
  "./auth-observation-receipt.mjs",
  "./auth-dispatch-runner.mjs",
  "./auth-grant-gate.mjs",
  "./auth-grant-liveness.mjs",
  "./hyk163-2a-observation-fixture.mjs",
];
for (const modulePath of SCANNED_MODULES_FOR_LIVE_ENABLE) {
  test(`structural: '${modulePath}' has zero live-enable-true switches`, () => {
    // 전체 문자열 패턴 매칭(줄 분할/line-anchor 없음)이라 CRLF checkout과
    // 무관하다(coder-4 review-2 반려 교훈 -- split("\n")+line-anchor 조합만
    // CRLF 취약이었고, 이 패턴은 그 조합을 쓰지 않는다).
    const src = readFileSync(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(src, LIVE_ENABLE_TRUE_PATTERN);
  });
}
