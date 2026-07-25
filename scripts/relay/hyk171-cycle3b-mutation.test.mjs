import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptLaunch, REASON as LAUNCH_REASON } from "./launch-seam.mjs";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";
import { scanRepoForOrcaExecCalls } from "../check/orca-cli-boundary.mjs";
import { issueSubGrant } from "./grant-issuer.mjs";
import { computeStableIntentId, INTENT_STATUS } from "./stable-intent.mjs";
import {
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
  makeStableIntentFields,
  makeFakeDelegation,
  DELEGATION_TASK_HASH,
  DELEGATION_IN_WINDOW_NOW,
  makeArmGrant,
  makeSinkSpy,
  makeHumanReceipt,
  makeIssuedIntent,
  makeSubGrantEnvelopeFields,
  ARM_GRANT_CYCLE_ID,
  ARM_GRANT_IN_WINDOW_NOW,
} from "./hyk171-cycle3b-fixtures.mjs";

// HYK-171 사이클3B (coder-task.md §6) -- launch-seam/running-receipt/
// stable-intent 확장(RUNNING) end-to-end mutation 원장. "vacuous-pass
// 금지": 각 테스트는 최종 상태가 아니라 [launch acceptance(RUNNING
// receipt) 수 · 실 sink 호출 수(spy) · completion 판정 수 · intent 상태
// trace · 사람 receipt 검사 통과 수]를 정확히 센다.
//
// 기법(hyk171-cycle3a-mutation.test.mjs와 동일 방식 그대로 계승, coder-task.md
// 지시: "git history를 literal revert할 수 없으니 그 파일의 실제 패턴을
// 따른다"): 코드를 실제로 손상시키지 않는다. 대신 **현재(고정된) 프로덕션
// launch-seam.mjs를, 그 가드가 정확히 막도록 설계된 반사실 입력**으로
// 직접 구동해 sink 계수가 여전히 정확함을 증명하고, 각 테스트 주석에 "이
// 결과가 나오려면 launch-seam.mjs의 정확히 어느 가드 줄이 살아있어야
// 하는지"(= 그 줄을 지우면 이 테스트가 RED로 뒤집힌다는 것)를 명시한다.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk171-cycle3b-mutation-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function readIntentStatus(intentDir, stableIntentId) {
  return JSON.parse(
    readFileSync(
      join(intentDir, `intent-${stableIntentId}.claim.json`),
      "utf8",
    ),
  ).status;
}
function countRunningReceipts(receiptDir) {
  return readdirSync(receiptDir).filter((f) => f.startsWith("running-receipt-"))
    .length;
}
function setupIssuedIntent(intentDir, overrides = {}) {
  const stableIntentId = computeStableIntentId(makeStableIntentFields());
  makeIssuedIntent(intentDir, stableIntentId);
  const envelope = makeSubGrantEnvelopeFields(stableIntentId, overrides);
  return { stableIntentId, envelope };
}
function pipelineFixture(bundleDir) {
  const { pinPath } = writePullAdmissionBundle(bundleDir);
  return {
    pullAdmission: pullAdmissionInput(bundleDir, pinPath),
    gates: makeAllowGates(),
  };
}
function fullyValidGateInputs(bundleDir) {
  const { pullAdmission, gates } = pipelineFixture(bundleDir);
  return {
    requiredBindings: { taskHash: "task-hash-3b-1", role: "CODER" },
    armGrant: makeArmGrant(),
    expectedCycleId: ARM_GRANT_CYCLE_ID,
    nowMs: ARM_GRANT_IN_WINDOW_NOW,
    humanReceipt: makeHumanReceipt(),
    pullAdmission,
    gates,
  };
}

// ---- known-bad #1 (가장 중요): armed=false인데 실 sink 호출됨 ----
// 이 결과가 성립하려면 launch-seam.mjs의 `const armed = inp.armed === true;`
// + `if (!armed) { return ...; }`(sink 호출부보다 먼저 반환) 두 줄이 살아
// 있어야 한다 -- 이 중 하나라도 지워지면(예: armed를 truthy로 강제하거나
// !armed 분기를 삭제) 아래 assert.equal(sink.calls.length, 0)이 RED로
// 뒤집힌다.
test("known-bad #1: armed=false (default) -- sink call count must be 0 even when every other gate input is fully valid", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        // armed intentionally omitted -- production default.
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
      });
      assert.equal(result.ok, true);
      assert.equal(result.launched, false);
      assert.equal(sink.calls.length, 0, "sink must be 0 when armed=false");
      assert.equal(countRunningReceipts(receiptDir), 1);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- known-bad #2: armed=true·사람 receipt 부재인데 sink 호출됨 ----
// 이 결과가 성립하려면 launch-seam.mjs의 checkHumanReceipt guard clause(및
// acceptLaunch의 게이트 체이닝에서 그 함수가 빠지지 않고 호출되는 것)가
// 살아 있어야 한다 -- checkHumanReceipt를 체이닝(`??`)에서 제거하면 이
// 테스트는 sink.calls.length가 1로 뒤집혀 RED가 된다.
test("known-bad #2: armed=true + all other gates positive but humanReceipt absent -- sink call count must be 0", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const inputs = fullyValidGateInputs(bundleDir);
      delete inputs.humanReceipt;
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...inputs,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, LAUNCH_REASON.HUMAN_RECEIPT_MISSING);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- known-bad #3: 발급 시점 ALLOW -> sink 시점 조건 변화인데 2차
// admission 안 하고 sink ----
// 이 결과가 성립하려면 launch-seam.mjs의 checkSecondAdmission guard(및 그
// 함수가 게이트 체이닝에서 빠지지 않는 것)가 살아 있어야 한다 --
// checkSecondAdmission을 제거하면(즉 발급 시점 admission ALLOW 하나만
// 믿고 그 뒤 상태 변화를 재검하지 않으면) 아래 시나리오(발급 시점엔
// ALLOW, sink 시점엔 hard-stop으로 변함)에서 sink.calls.length가 1로
// 뒤집혀 RED.
test("known-bad #3: admission ALLOW at issue time, but conditions changed by sink time (hard-stop set) -- sink call count must be 0 (second admission re-check required)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    const receiptDir = freshDir();
    try {
      // ① 발급 시점: admission ALLOW로 issueSubGrant가 성공한다(3A 진입점,
      // 재사용).
      const { pullAdmission, gates: allowGates } = pipelineFixture(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const issued = issueSubGrant({
        delegation: makeFakeDelegation(),
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        pullAdmission,
        gates: allowGates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t1",
      });
      assert.equal(issued.ok, true, JSON.stringify(issued));
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.ISSUED,
      );

      // ② sink 시점: 조건이 바뀌었다(hard-stop=true) -- 발급 시점의 ALLOW를
      // 재사용하지 않고 launch-seam이 스스로 재판정해야 한다.
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: issued.envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t2",
        requiredBindings: { taskHash: DELEGATION_TASK_HASH, role: "CODER" },
        armGrant: makeArmGrant(),
        expectedCycleId: ARM_GRANT_CYCLE_ID,
        nowMs: ARM_GRANT_IN_WINDOW_NOW,
        humanReceipt: makeHumanReceipt(),
        pullAdmission,
        gates: makeAllowGates({ hardStop: true }),
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, LAUNCH_REASON.ADMISSION_DENIED);
      assert.equal(sink.calls.length, 0);
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
      cleanup(receiptDir);
    }
  });
});

// ---- known-bad #4: 같은 stable intent 2 supervisor 동시 launch 수락 ----
// RUNNING receipt 합계 1 · sink 합계 <=1. 이 결과가 성립하려면
// running-receipt.mjs의 create-new-only(wx) 유일성 + stable-intent.mjs의
// updateIntentStatusTx expectedFrom=ISSUED 엄격 대조(둘 다 launch-seam.mjs
// 의 recordLaunchAcceptance가 순서대로 호출) 둘 중 하나라도 살아있으면
// 이 테스트는 그린이다 -- 둘 다 제거된 상태에서만(예: 유일성 검사를 지우고
// 무조건 write) RUNNING/sink 합계가 2로 뒤집혀 RED.
test("known-bad #4: SAME stable intent, two 'concurrent supervisor' acceptLaunch calls (both armed=true, both fully valid) -- RUNNING total=1, sink total<=1", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { stableIntentId, envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const gateInputs = fullyValidGateInputs(bundleDir);

      const supervisorA = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...gateInputs,
      });
      const supervisorB = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t2",
        ...gateInputs,
      });

      assert.equal(
        countRunningReceipts(receiptDir),
        1,
        "RUNNING receipt total must be exactly 1",
      );
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.RUNNING,
        "intent must have transitioned to RUNNING exactly once",
      );
      assert.ok(
        sink.calls.length <= 1,
        `sink total must be <= 1, got ${sink.calls.length}`,
      );
      assert.equal(
        [supervisorA, supervisorB].filter((r) => r.ok === true).length,
        1,
        "exactly one supervisor wins",
      );
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- known-bad #5: RUNNING receipt 기록 뒤 sink 전 crash -> 재시작 후
// 자동 재발사 0 ----
// 이 결과가 성립하려면 stable-intent.mjs의 updateIntentStatusTx가
// expectedFrom=ISSUED를 엄격히 요구하는 것(그래서 RUNNING에서 재호출하면
// 항상 거부)이 살아 있어야 한다 -- "재시작 시 자동 재실행" 루프가 코드
// 어디에도 없다는 사실은 launch-seam.mjs/stable-intent.mjs에
// setTimeout/재귀 재시도가 0건이라는 정적 사실과 결합된다(아래 별도
// static assert). expectedFrom 대조가 제거되면 재시작 재호출이 새
// ISSUED->RUNNING 전이를 또 성공시켜 sink가 다시 호출될 수 있어 RED.
test("known-bad #5: RUNNING recorded, sink denied by a gate (crash-before-sink), then a full 'process restart' re-call must NOT reach sink -- no auto-respawn", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const gateInputs = fullyValidGateInputs(bundleDir);

      // "crash-before-sink": RUNNING gets recorded, but a gate (admission)
      // denies before the sink call.
      const crashLike = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...gateInputs,
        gates: makeAllowGates({ hardStop: true }),
      });
      assert.equal(crashLike.ok, false);
      assert.equal(crashLike.running, true);
      assert.equal(sink.calls.length, 0);

      // "restart": a subsequent, fully-valid re-call for the same intent.
      const restart = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t2",
        ...gateInputs,
      });
      assert.equal(restart.ok, false);
      assert.equal(restart.reason, LAUNCH_REASON.INTENT_TRANSITION_DENIED);
      assert.equal(sink.calls.length, 0, "no automatic respawn after restart");
      assert.equal(countRunningReceipts(receiptDir), 1);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

test("known-bad #5 (static): launch-seam.mjs/stable-intent.mjs/running-receipt.mjs contain zero setTimeout/setInterval/retry-loop constructs (no auto-respawn possible)", () => {
  for (const file of [
    "launch-seam.mjs",
    "stable-intent.mjs",
    "running-receipt.mjs",
  ]) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(
      /setTimeout\(|setInterval\(/.test(src),
      false,
      `${file} must not schedule automatic retries (actual calls, not just prose mentioning the words)`,
    );
  }
});

// ---- known-bad #6: fake sink를 default(실) sink로 교체 -> 코어 테스트가
// 실 CLI import/실행 감지로 RED ----
// 이 결과가 성립하려면 (a) orca-cli-boundary.mjs의 G9 정적 스캔이 계속
// scripts/relay/adapters/orca-adapter.mjs 밖에서 `spawnSync("orca", ...)`
// 리터럴 호출을 0건으로 지키는 것과 (b) launch-seam.mjs 소스 자체가
// orca-adapter.mjs를 import하지 않는 것 둘 다 필요하다 -- 누군가
// launch-seam.mjs/grant-issuer.mjs에 실 sink(createRealLaunchSink/
// createOrcaExecFn)를 기본값으로 결선하면 (b)가 즉시 깨져 아래 첫 assert가
// RED가 되고, 만약 그 결선이 literal spawnSync("orca", ...)를 core 파일에
// 복붙하는 형태라면 (a)의 실 리포지토리 스캔도 별도로 RED가 된다.
test("known-bad #6: launch-seam.mjs never imports the orca adapter, AND the real repo tree has 0 orca exec calls outside the adapter (G9)", () => {
  const src = readFileSync(
    new URL("./launch-seam.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/orca-adapter/i.test(src), false);
  assert.equal(/createRealLaunchSink|createOrcaExecFn/.test(src), false);

  const violations = scanRepoForOrcaExecCalls();
  assert.deepEqual(
    violations,
    [],
    `orca-cli-boundary G9 violations found: ${JSON.stringify(violations)}`,
  );
});

// ---- known-bad #7: RUNNING receipt를 completion으로 오독(handshake
// 없이 완료 판정) -> completion 계수 오증 ----
// 이 결과가 성립하려면 checkRelayHandshake(사이클1 정본, 이 모듈은
// 수정하지 않는다)가 .harness/<role>.md 결과 파일이 없으면 ok:false를
// 내는 것이 살아 있어야 한다 -- 만약 launch-seam.mjs가 RUNNING receipt
// 존재만으로 "완료"라고 스스로 판정하는 코드를 추가한다면(재발명, 비범위
// 위반), 아래 assert(handshake.ok, false)가 RED로 뒤집힌다(completion 판정
// 수가 RUNNING receipt 수(1)와 같아져 버림 -- 이 둘은 반드시 달라야 한다).
test("known-bad #7: RUNNING receipt count (1) must NOT equal completion judgement count (0) -- launch-seam never fabricates completion", () => {
  const intentDir = freshDir();
  const receiptDir = freshDir();
  const harnessDir = freshDir();
  try {
    const { envelope } = setupIssuedIntent(intentDir);
    const sink = makeSinkSpy();
    const result = acceptLaunch({
      subGrantEnvelope: envelope,
      runningReceiptDir: receiptDir,
      intentDir,
      sink,
      at: "t1",
    });
    assert.equal(result.ok, true);
    const runningReceiptCount = countRunningReceipts(receiptDir);
    assert.equal(runningReceiptCount, 1);

    const handshake = checkRelayHandshake({ role: "CODER", harnessDir });
    const completionCount = handshake.ok ? 1 : 0;
    assert.equal(
      completionCount,
      0,
      "no .harness result exists -- completion must be 0",
    );
    assert.notEqual(
      runningReceiptCount,
      completionCount,
      "RUNNING receipt count and completion judgement count must diverge here",
    );

    // launch-seam.mjs never imports checkRelayHandshake -- it does not own
    // or reinvent the completion authority (static confirmation; the source
    // may still *mention* the file in a comment explaining this boundary,
    // so this only rejects an actual import statement).
    const src = readFileSync(
      new URL("./launch-seam.mjs", import.meta.url),
      "utf8",
    );
    assert.equal(
      /from\s+["'][^"']*relay-handshake[^"']*["']/.test(src),
      false,
      "launch-seam.mjs must not import relay-handshake.mjs (module specifier check, not prose)",
    );
  } finally {
    cleanup(intentDir);
    cleanup(receiptDir);
    cleanup(harnessDir);
  }
});

// ---- known-bad #8: armed=true 전 게이트 positive paired-good -> sink
// 정확히 1 (exact-count 하회/상회 = RED) ----
// 이 결과가 성립하려면 acceptLaunch의 6검 체이닝 전부(gate1 armed===true
// strictness, gate2 envelope binding, gate3 arm/cycle/expiry, gate4 human
// receipt, gate5 second admission, gate6 RUNNING uniqueness)가 살아있고,
// sink 호출부가 그 6검 뒤에 정확히 한 번만 존재해야 한다 -- 6검 중 아무거나
// 하나가 빠지면(하회 방향, 예: 어느 한 gate를 제거해 sink가 더 쉽게
// 불림) 이 케이스 자체는 여전히 1로 보일 수 있지만, 위 known-bad #1~#7이
// 각각 그 결여를 개별로 잡는다. 이 테스트는 반대 방향(상회 -- 예: sink 호출
// 라인이 실수로 중복되거나 루프 안에 들어감)을 정확히 잡는다.
test("known-bad #8 (paired-good, exact-count): armed=true + ALL 6 gates positive -> sink called EXACTLY 1 (not 0, not 2+)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const receiptDir = freshDir();
    try {
      const { stableIntentId, envelope } = setupIssuedIntent(intentDir);
      const sink = makeSinkSpy();
      const result = acceptLaunch({
        subGrantEnvelope: envelope,
        armed: true,
        sink,
        runningReceiptDir: receiptDir,
        intentDir,
        at: "t1",
        ...fullyValidGateInputs(bundleDir),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.launched, true);
      assert.equal(
        sink.calls.length,
        1,
        "sink must be called EXACTLY once, no more, no less",
      );
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.RUNNING,
      );
      assert.equal(countRunningReceipts(receiptDir), 1);
    } finally {
      cleanup(intentDir);
      cleanup(receiptDir);
    }
  });
});

// ---- S6 (엔진무관) 재확인: launch-seam/running-receipt는 orca를
// import/호출하지 않는다 ----
test("S6: launch-seam.mjs/running-receipt.mjs source contains no 'orca' reference (case-insensitive)", () => {
  for (const file of ["launch-seam.mjs", "running-receipt.mjs"]) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.equal(/orca/i.test(src), false, `${file} must not reference 'orca'`);
  }
});
