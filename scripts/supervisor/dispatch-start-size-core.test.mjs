import { test } from "node:test";
import assert from "node:assert/strict";
import {
  judgeDispatchStartBySize,
  DISPATCH_START_SIZE_VERDICT,
  DISPATCH_START_SIZE_REASON,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  DEFAULT_SUSTAINED_GROWTH_BYTES,
  DEFAULT_STALL_GRACE_MULTIPLIER,
  MAX_STALL_GRACE_MULTIPLIER,
} from "./dispatch-start-size-core.mjs";

test("judgeDispatchStartBySize: args가 plain object 아니면 UNDECIDABLE/ARGS_INVALID", () => {
  const r = judgeDispatchStartBySize(null);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.ARGS_INVALID);
});

test("judgeDispatchStartBySize: now/dispatchedAtMs 결손 -> UNDECIDABLE", () => {
  const r = judgeDispatchStartBySize({ observations: [] });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
});

test("judgeDispatchStartBySize: observations가 배열이 아니면 UNDECIDABLE/OBSERVATIONS_INVALID", () => {
  const r = judgeDispatchStartBySize({
    observations: "x",
    dispatchedAtMs: 0,
    now: 1000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.OBSERVATIONS_INVALID);
});

test("judgeDispatchStartBySize: 관측 항목 형식 위반(totalBytes 음수) -> UNDECIDABLE/OBSERVATION_MALFORMED", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 100, totalBytes: -1 }],
    dispatchedAtMs: 0,
    now: 1000,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.OBSERVATION_MALFORMED);
});

test("judgeDispatchStartBySize: 관측이 미래 시각이면 UNDECIDABLE/OBSERVATION_IN_FUTURE", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 5000, totalBytes: 10 }],
    dispatchedAtMs: 0,
    now: 1000,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.OBSERVATION_IN_FUTURE);
});

test("★사례1(아예 시작 못 함): 관측 1건뿐이고 아직 타임아웃 전이면 NOT_STARTED로 단정하지 않고 UNDECIDABLE", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 1000, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    timeoutMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
});

test("★사례1(아예 시작 못 함): 타임아웃까지 계속 0에서 안 늘면 NOT_STARTED", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 60000, totalBytes: 0 },
      { observedAtMs: 200000, totalBytes: 0 },
    ],
    dispatchedAtMs: 0,
    now: 200000,
    timeoutMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.NOT_STARTED);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.NO_GROWTH_PAST_TIMEOUT);
});

test("계속 늘고 있으면(마지막 증가가 stallThresholdMs 이내) STARTED", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 100 },
      { observedAtMs: 15000, totalBytes: 5000 },
      { observedAtMs: 30000, totalBytes: 9000 }, // 방금도 늘었다.
    ],
    dispatchedAtMs: 0,
    now: 30000,
    stallThresholdMs: 180000,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.GREW_RECENTLY);
});

// ★★HYK-270-stall-visible-3 핵심 -- 2R REVIEW 반려 원문 그대로의 반례
// 관측열(검토자가 `runDispatchStartConfirm`에 직접 주입한 것과 동일 모양):
// `totalBytes = 0 -> 5000 -> 5000 -> …`(승인창 등으로 시작 후 멈춘 사례 2).
// 마지막 증가(15000ms 시점) 이후 `stallThresholdMs`(여기선 60000ms로
// 축소해 시험을 빠르게)를 넘게 더 안 늘었으면 STALLED_AFTER_START여야
// 한다 -- ★2R 코드(운영 중이던 버전)는 "언젠가 늘었다"만 보고 영구히
// STARTED를 냈다(이 시험이 그 결함의 재현 fixture).
test("★★2R 반례 fixture: 0 -> 5000 -> 5000(그 뒤로도 계속 안 늘어남, 마지막 증가로부터 stallThresholdMs 초과) -> STALLED_AFTER_START(★수리 전엔 STARTED로 영구히 새던 자리)", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 15000, totalBytes: 5000 },
      { observedAtMs: 30000, totalBytes: 5000 },
      { observedAtMs: 90000, totalBytes: 5000 }, // 마지막 증가(15000)로부터 75000ms 경과.
    ],
    dispatchedAtMs: 0,
    now: 90000,
    timeoutMs: 180000,
    stallThresholdMs: 60000, // 참고 실측(ORCH)의 3분을 시험 편의상 1분으로 축소(호출자 덮어쓰기 그대로 실증).
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.STALLED_PAST_THRESHOLD);
  assert.equal(r.details.lastGrowthAtMs, 15000);
});

test("«시작 못 함»과 «시작 후 멈춤»은 절대 같은 verdict 문자열이 아니다(사람 조치가 다르므로 값을 뭉개지 않는다)", () => {
  assert.notEqual(
    DISPATCH_START_SIZE_VERDICT.NOT_STARTED,
    DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START,
  );
});

test("judgeDispatchStartBySize: timeoutMs/stallThresholdMs 생략 시 각각의 기본값(3분) 사용", () => {
  const r1 = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: DEFAULT_TIMEOUT_MS + 1000, totalBytes: 0 },
    ],
    dispatchedAtMs: 0,
    now: DEFAULT_TIMEOUT_MS + 1000,
  });
  assert.equal(r1.verdict, DISPATCH_START_SIZE_VERDICT.NOT_STARTED);

  const r2 = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 1000, totalBytes: 100 },
      { observedAtMs: DEFAULT_STALL_THRESHOLD_MS + 2000, totalBytes: 100 },
    ],
    dispatchedAtMs: 0,
    now: DEFAULT_STALL_THRESHOLD_MS + 2000,
  });
  assert.equal(r2.verdict, DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START);
});

test("judgeDispatchStartBySize: timeoutMs가 0 이하면 UNDECIDABLE/THRESHOLD_INVALID", () => {
  const r = judgeDispatchStartBySize({
    observations: [],
    dispatchedAtMs: 0,
    now: 1000,
    timeoutMs: 0,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

test("judgeDispatchStartBySize: stallThresholdMs가 0 이하면 UNDECIDABLE/THRESHOLD_INVALID", () => {
  const r = judgeDispatchStartBySize({
    observations: [],
    dispatchedAtMs: 0,
    now: 1000,
    stallThresholdMs: -1,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

// ---------------------------------------------------------------------------
// ★HYK-378 사례2 재구성(coder.md §1 첨부 원문
// orch-evidence-sample2-HYK377-2R.md · orch-evidence-live-crosscheck.md의
// 실측 숫자를 관측 시퀀스로 그대로 옮긴 것 -- 발췌 아님, 다음 실측값을
// 그대로 씀):
//   - 배달 시각 06:49:29.000, baseline(=배달 시점 총 바이트) 634067
//   - 마지막(구 축) 증가 06:50:32.646 -> 63646ms 후, totalBytes 709791
//     (diagnostic 원문: baseline=634067 last_observation=709791)
//   - 구 판정이 실제로 경보를 낸 시각 06:53:32.722 (그 3분 임계 지점 근방)
//   - ORCH 교차 확인: 15:55~56 KST(=06:55~56Z)경 709791 -> 791521
//     (delta 81730, 20초 창) -- 실제로는 살아 있었다.
// ⇒ growthSinceStartBytes = 709791-634067 = 75724 >= 기본
//   DEFAULT_SUSTAINED_GROWTH_BYTES(50000) -- 이 축이 켜진다.
test("★HYK-378 사례2 재구성(오늘 실사고, 첨부 원문 수치 그대로): 이미 75,724B 자란 뒤라 구 임계 시점(3분)에서도 STALLED로 새지 않는다", () => {
  const DISPATCHED_AT_MS = 0; // 06:49:29.000
  const OLD_LAST_GROWTH_MS = 63646; // 06:50:32.646
  const OLD_ALERT_MS = 243646; // 06:53:32(옛 판정이 실제로 경보를 낸 지점 근방, OLD_LAST_GROWTH_MS+180000).
  const RESUMED_GROWTH_MS = 326000; // ORCH 교차 확인(15:55~56 KST 대역, 근사).
  const observations = [
    { observedAtMs: DISPATCHED_AT_MS, totalBytes: 634067 },
    { observedAtMs: OLD_LAST_GROWTH_MS, totalBytes: 709791 },
  ];
  // 구 판정이 실제로 경보를 냈던 바로 그 시각에도 -- 이제는 STARTED.
  const atOldAlert = judgeDispatchStartBySize({
    observations,
    dispatchedAtMs: DISPATCHED_AT_MS,
    now: OLD_ALERT_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  });
  assert.equal(atOldAlert.verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
  assert.equal(atOldAlert.details.sustainedGrowthApplied, true);
  assert.equal(
    atOldAlert.details.effectiveStallThresholdMs,
    DEFAULT_STALL_THRESHOLD_MS * DEFAULT_STALL_GRACE_MULTIPLIER,
  );

  // 실제로 자란 순간(ORCH 교차 확인 수치)까지 관측을 이어 붙여도 여전히
  // STARTED다(진짜로 살아 있었으므로).
  const withResumedGrowth = judgeDispatchStartBySize({
    observations: [
      ...observations,
      { observedAtMs: RESUMED_GROWTH_MS, totalBytes: 791521 },
    ],
    dispatchedAtMs: DISPATCHED_AT_MS,
    now: RESUMED_GROWTH_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  });
  assert.equal(withResumedGrowth.verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
  assert.equal(withResumedGrowth.details.lastGrowthAtMs, RESUMED_GROWTH_MS);
});

// ★되돌림 변이(§5 요구) -- 위 표본을 그대로 두고, 이 축만 무력화하면
// (stallGraceMultiplier:1 = 배수를 끔) 구 판정과 동일하게 다시 RED
// (STALLED_AFTER_START)가 됨을 숫자로 보인다 -- 이 축이 진짜로 사례2를
// 구하고 있다는 증거(옆 구멍 우회가 아니라는 확인).
test("★되돌림 변이: stallGraceMultiplier를 1로 끄면(=축 무력화) 사례2 재구성이 다시 STALLED_AFTER_START로 RED가 된다", () => {
  const DISPATCHED_AT_MS = 0;
  const OLD_LAST_GROWTH_MS = 63646;
  const OLD_ALERT_MS = 243647; // OLD_LAST_GROWTH_MS + 180000(1ms 초과 -- "그 이상 경과" 경계를 명확히 넘긴다).
  const mutated = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: DISPATCHED_AT_MS, totalBytes: 634067 },
      { observedAtMs: OLD_LAST_GROWTH_MS, totalBytes: 709791 },
    ],
    dispatchedAtMs: DISPATCHED_AT_MS,
    now: OLD_ALERT_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
    stallGraceMultiplier: 1, // 축 무력화(1배 = 여유 없음).
  });
  assert.equal(
    mutated.verdict,
    DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START,
    "축을 끄면 옛 오탐이 그대로 재현돼야 한다(=이 축이 실제로 사례2를 구했다는 증거)",
  );
});

// ★완료조건2(§3 항2) -- 합성 진짜-정지 표본: 이미 많이 자라 sustained
// 조건을 만족해도(=여유 배수가 켜져도), 그 «상한»(stallThresholdMs *
// stallGraceMultiplier)마저 넘게 무증가면 여전히 STALLED_AFTER_START다
// (B: 무제한 유예가 아니다).
test("★완료조건2(진짜 정지, 숫자로): 많이 자란 뒤라도(sustained 켜짐) 상한(6분)마저 넘게 무증가면 STALLED_AFTER_START", () => {
  const sustainedBytes = DEFAULT_SUSTAINED_GROWTH_BYTES + 10_000; // 조건 확실히 만족.
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 60000, totalBytes: sustainedBytes }, // 크게 자람 -- sustained 켜짐.
      {
        observedAtMs:
          60000 +
          DEFAULT_STALL_THRESHOLD_MS * DEFAULT_STALL_GRACE_MULTIPLIER +
          1000,
        totalBytes: sustainedBytes, // 그 뒤로 상한(6분)마저 넘게 계속 무증가.
      },
    ],
    dispatchedAtMs: 0,
    now:
      60000 +
      DEFAULT_STALL_THRESHOLD_MS * DEFAULT_STALL_GRACE_MULTIPLIER +
      1000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START);
  // ★2R(P1-1 수리) -- 유예 마감은 sustainedAtMs(=60000, 자란 시점)에 고정
  // 되므로 이 시각(60000+상한+1000)엔 이미 마감을 넘겨 sustainedGrowthApplied
  // 는 false로 떨어진다(기본 임계로 되돌아간 뒤에도 STALLED로 잡힌다는
  // 것이 이 시험의 요지 -- "상한이 실제로 상한"이라는 증거).
  assert.equal(r.details.sustainedGrowthApplied, false);
});

// ---------------------------------------------------------------------------
// ★HYK-378 2R(REVIEW P1-1 반려 수리) -- `stallGraceMultiplier`를 timeout·
// stallThreshold와 같은 자리에서 같은 방식으로 검증한다. 검토자 실측
// 재현: 0B -> 50,001B(sustained 켜짐) 뒤 1,000,000,000ms 무증가 관측에
// `stallGraceMultiplier: Infinity`(또는 `NaN`)를 주면 예전엔 STARTED로
// 샜다 -- 이제는 인자 검증 단계에서 거부한다.
test("★HYK-378 2R P1-1 재현+수리: stallGraceMultiplier=Infinity는 거부된다(무증가 10억ms에도 STARTED로 새던 자리)", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 1000, totalBytes: DEFAULT_SUSTAINED_GROWTH_BYTES + 1 },
      {
        observedAtMs: 1000 + 1_000_000_000,
        totalBytes: DEFAULT_SUSTAINED_GROWTH_BYTES + 1,
      },
    ],
    dispatchedAtMs: 0,
    now: 1000 + 1_000_000_000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
    stallGraceMultiplier: Infinity,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.UNDECIDABLE);
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

test("★HYK-378 2R P1-1: stallGraceMultiplier=NaN도 거부된다", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 0, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    stallGraceMultiplier: NaN,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

test(`★HYK-378 2R P1-1: stallGraceMultiplier가 MAX_STALL_GRACE_MULTIPLIER(${MAX_STALL_GRACE_MULTIPLIER})를 넘는 과대 유한값도 거부된다`, () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 0, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    stallGraceMultiplier: MAX_STALL_GRACE_MULTIPLIER + 0.001,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

test("★HYK-378 2R P1-1: stallGraceMultiplier가 1 미만(0·음수)도 거부된다", () => {
  const r1 = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 0, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    stallGraceMultiplier: 0,
  });
  assert.equal(r1.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
  const r2 = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 0, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    stallGraceMultiplier: -1,
  });
  assert.equal(r2.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

test("★HYK-378 2R P1-1: sustainedGrowthBytes가 음수면 거부된다(항상 즉시 '이미 자람'으로 뭉갤 통로)", () => {
  const r = judgeDispatchStartBySize({
    observations: [{ observedAtMs: 0, totalBytes: 0 }],
    dispatchedAtMs: 0,
    now: 1000,
    sustainedGrowthBytes: -1,
  });
  assert.equal(r.reasonCode, DISPATCH_START_SIZE_REASON.THRESHOLD_INVALID);
});

test(`★HYK-378 2R P1-1: MAX_STALL_GRACE_MULTIPLIER(${MAX_STALL_GRACE_MULTIPLIER}) 자체는 유효한 값이다(경계값 포함)`, () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      { observedAtMs: 1000, totalBytes: DEFAULT_SUSTAINED_GROWTH_BYTES + 1 },
    ],
    dispatchedAtMs: 0,
    now: 1000,
    stallGraceMultiplier: MAX_STALL_GRACE_MULTIPLIER,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STARTED);
});

// ---------------------------------------------------------------------------
// ★HYK-378 2R(REVIEW P1-1 반려 수리, 유예 «총 수명» 상한) -- 검토자 실측
// 재현: `stallGraceMultiplier`는 기본값(2, 유효)인 채로, "359,999ms마다
// 1B씩" 늘어나는 관측열은 1R 구현에서 매번 유예를 다시 시작시켜
// 사실상 무한(약 2시간)이 됐다. ★수리 검증: 유예 마감을 sustainedAtMs
// (=처음 sustained 바를 넘긴 시각)에 고정하면, 그 마감을 넘긴 뒤에는
// "방금도 359,999ms 전에 늘었다"는 사실이 더 이상 유예를 안 준다 --
// 마감 이후엔 기본 임계(3분)만으로 판정하므로, 이 주기(359,999ms > 3분)
// 자체가 매번 STALLED_AFTER_START를 만든다.
test("★HYK-378 2R P1-1 재현+수리(숫자로): 359,999ms 주기 1B 증가도 유예 마감을 넘기면 STALLED_AFTER_START로 잡힌다", () => {
  const SUSTAINED_AT_MS = 1000;
  const PERIOD_MS = 359_999;
  const graceDeadlineMs =
    SUSTAINED_AT_MS +
    DEFAULT_STALL_THRESHOLD_MS * DEFAULT_STALL_GRACE_MULTIPLIER; // 361000
  const secondGrowthAtMs = SUSTAINED_AT_MS + PERIOD_MS; // 360999 -- 마감 이전(아직 유예 안).
  assert.ok(
    secondGrowthAtMs < graceDeadlineMs,
    "이 시험이 재현하려는 조건: 두 번째 증가 자체는 아직 마감 전이어야 한다",
  );
  const observations = [
    { observedAtMs: 0, totalBytes: 0 },
    {
      observedAtMs: SUSTAINED_AT_MS,
      totalBytes: DEFAULT_SUSTAINED_GROWTH_BYTES + 1, // sustained 켜짐(60001B 등가).
    },
    {
      observedAtMs: secondGrowthAtMs,
      totalBytes: DEFAULT_SUSTAINED_GROWTH_BYTES + 2,
    },
  ];
  // 마감을 넘긴 뒤, 그 다음(세 번째) 1B가 오기(=secondGrowthAtMs+PERIOD_MS)
  // «전에» 이미 기본 임계(3분)만으로 STALLED가 확정돼야 한다 -- 1R이라면
  // "방금도(359,999ms 전에) 늘었다"는 유예가 매번 갱신돼 이 시각에도
  // STARTED로 남았을 자리(검토자 실측 원문의 형태 그대로).
  const now = secondGrowthAtMs + DEFAULT_STALL_THRESHOLD_MS + 1; // 마감(361000) 이후 + 기본임계 초과.
  assert.ok(
    now > graceDeadlineMs,
    "이 시험이 재현하려는 조건: 판정 시각이 유예 마감 이후여야 한다",
  );
  const r = judgeDispatchStartBySize({
    observations,
    dispatchedAtMs: 0,
    now,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START);
  assert.equal(r.details.sustainedGrowthApplied, false);
});

// ★완료조건2(§3 항2, 합성 표본 = 증가 0 + 새 축도 죽어 있음) -- 새 축
// (sustained-growth 여유)이 켜질 조건 자체가 없는(증가가 아예 없는)
// 표본에서는 NOT_STARTED(한 번도 안 늘었으므로 STALLED_AFTER_START와는
// 다른 값 -- §2 항4)다. 작게라도 한 번 늘고(sustained 미달) 그 뒤 무증가면
// STALLED_AFTER_START로 잡히는 것은 위 "★★2R 반례" 시험이 이미 숫자로
// 보인다(growth 5000 < DEFAULT_SUSTAINED_GROWTH_BYTES, 축 미적용).
test("★완료조건2(진짜 정지, 합성 표본): 증가 0(=새 축도 못 켜짐)이면 NOT_STARTED", () => {
  const r = judgeDispatchStartBySize({
    observations: [
      { observedAtMs: 0, totalBytes: 0 },
      {
        observedAtMs: DEFAULT_STALL_THRESHOLD_MS + 1000,
        totalBytes: 0,
      },
    ],
    dispatchedAtMs: 0,
    now: DEFAULT_STALL_THRESHOLD_MS + 1000,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  });
  assert.equal(r.verdict, DISPATCH_START_SIZE_VERDICT.NOT_STARTED);
});
