import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  readFileSync as readFile,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeStableIntentId, INTENT_STATUS } from "./stable-intent.mjs";
import { issueSubGrant, REASON } from "./grant-issuer.mjs";
import {
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
  makeStableIntentFields,
  makeFakeDelegation,
  DELEGATION_TASK_HASH,
  DELEGATION_IN_WINDOW_NOW,
} from "./hyk171-cycle3a-fixtures.mjs";

// HYK-171 사이클3A (review-1 반려 P1-1 수리 후 재작성) -- 세 모듈
// (stable-intent/admission-core/grant-issuer)을 조합한 end-to-end 반사실
// 원장(§6 Q7 mutation, "vacuous-pass 금지": 최종 상태가 아니라 실행의도
// 승자 수·grant 발급 수·adapter/실 sink 호출 수를 정확히 센다). §5
// 완료기준의 "총 실행권위 1개"는 grant-issuer.mjs의 **프로덕션**
// `issueSubGrant`를 직접 구동해 카운트한다 -- 테스트 전용 조립 helper를
// 거치지 않는다(review-1이 정확히 이 지점을 반려했다: 예전 helper는
// claim→admission→issue를 테스트에서만 조립했고, `issueSubGrant`를 직접
// 부르면 그 강제가 전혀 없었다). 이제 그 강제는 `issueSubGrant` 자신
// 안에 있다 -- 이 파일은 그 강제를 직접 구동해 재확인한다.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk171-cycle3a-mutation-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function countSubGrantFiles(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("sub-grant-")).length;
}

// intentDir에서 이 stableIntentId의 claim 레코드를 읽어 status를 반환한다
// (프로덕션 코드가 실제로 디스크에 남긴 산출물을 직접 검사 -- 별도 헬퍼가
// 계산한 값이 아니다).
function readIntentStatus(intentDir, stableIntentId) {
  const path = join(intentDir, `intent-${stableIntentId}.claim.json`);
  return JSON.parse(readFileSync(path, "utf8")).status;
}

// 공통 pull-admission 번들 + ALLOW gates를 만드는 fixture 묶음(claim/admission
// 자체는 issueSubGrant가 내부에서 수행한다 -- 이 헬퍼는 오직 입력 조립만).
function pipelineFixture(bundleDir) {
  const { pinPath } = writePullAdmissionBundle(bundleDir);
  return {
    pullAdmission: pullAdmissionInput(bundleDir, pinPath),
    gates: makeAllowGates(),
  };
}

// ---- §5/§6 mutation #1 (최우선, "이게 RED 아니면 헛시험"): 같은 stall
// episode에서 서로 다른 jti를 가진 valid grant 후보 2개가 각각 **프로덕션
// issueSubGrant를 직접** 호출해도 총 발급 수는 1이어야 한다. 진 후보는
// issueSubGrant 자신의 claim 단계에서 멈춘다(별도 오케스트레이션 helper가
// 걸러주는 게 아니다). ----
test("end-to-end: SAME stable intent, two candidates each call the PRODUCTION issueSubGrant directly -> total issued = 1 (mutation #1, no test helper)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pullAdmission, gates } = pipelineFixture(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const delegation = makeFakeDelegation();

      const candidateA = issueSubGrant({
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        winner: { jti: "jti-candidate-A" },
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t1",
      });
      const candidateB = issueSubGrant({
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        winner: { jti: "jti-candidate-B" },
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t2",
      });

      const totalIssued = [candidateA, candidateB].filter(
        (c) => c.ok === true && c.issued === true,
      ).length;
      assert.equal(
        totalIssued,
        1,
        `expected exactly 1 total issued sub-grant, got ${JSON.stringify([candidateA, candidateB])}`,
      );
      assert.equal(candidateB.reason, REASON.INTENT_CLAIM_DENIED);
      assert.equal(
        countSubGrantFiles(outDir),
        1,
        "on-disk sub-grant file count must be exactly 1",
      );
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
});

// ---- paired-good: delegation·게이트·intent 승자 모두 유효한 합성
// positive -> grant 정확히 1(프로덕션 issueSubGrant 직접 호출) ----
test("end-to-end: fully valid delegation + gates + intent winner -> exactly 1 grant, via the PRODUCTION issueSubGrant (paired-good)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pullAdmission, gates } = pipelineFixture(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const delegation = makeFakeDelegation();

      const result = issueSubGrant({
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        winner: { jti: "jti-good" },
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t1",
      });

      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.issued, true);
      assert.equal(result.reason, REASON.ISSUED);
      assert.equal(countSubGrantFiles(outDir), 1);
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.ISSUED,
      );
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
});

// ---- §6 mutation #6 (P2-1 수리 후): intent claim 뒤·grant 발급 前 crash ->
// 0 issued, intent가 durable PAUSED로 남는다(사람 개입 필요). 정상
// issueSubGrant 재호출(resumeHumanRef 없음)은 claim 단계에서 duplicate로
// 막힌다(우회 0, P1-1). 오직 resumeHumanRef를 명시한 호출(사람이 재개를
// 승인했다는 감사 참조)만 PAUSED에서 벗어나 1을 만들 수 있다 -- "자동
// 재시도"는 이 코드 어디에도 없다(claimIntentTx/issueSubGrant 둘 다
// setTimeout/재귀 재시도 루프가 없다는 사실은 아래 정적 grep이 별도로
// 증명한다). ----
test("end-to-end: crash after intent claim commits but before delegation consumption -> 0 issued this round, intent PAUSED; a plain re-call is denied (no bypass), ONLY a human-resumed call reaches 1 (mutation #6)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pullAdmission, gates } = pipelineFixture(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const delegation = makeFakeDelegation();
      const request = {
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        winner: { jti: "jti-crash-after-claim" },
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t1",
      };

      // ① claim은 issueSubGrant 내부에서 커밋되지만(디스크에 남는다),
      // delegation 소비 mutex 획득 자체가 죽는다("intent claim commit 뒤,
      // grant 발급 前"의 가장 이른 crash 지점 -- consumptionDir 경로만
      // 죽이고 intentDir 경로는 살려서 claim은 정상 커밋되게 한다).
      const crashedIssue = issueSubGrant(request, {
        writeFn: (path, content) => {
          if (path.includes(consumptionDir)) {
            throw new Error("injected crash before delegation consume commit");
          }
          writeFileSync(path, content, { flag: "wx" });
        },
      });
      assert.equal(crashedIssue.ok, false);
      assert.equal(crashedIssue.reason, REASON.DELEGATION_CONSUME_FAILED);
      assert.equal(countSubGrantFiles(outDir), 0, "0 issued after the crash");
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.PAUSED,
        "the crash must leave a durable PAUSED marker, not just an in-memory deny",
      );

      // ② 자동 재시도 0 + 우회 0: 사람 개입 없는 정상 재호출은 claim
      // 단계에서 duplicate로 막힌다(PAUSED든 뭐든, 레코드가 있으면 정상
      // issueSubGrant는 그걸 우회하지 못한다).
      const plainRetry = issueSubGrant({ ...request, at: "t2" });
      assert.equal(plainRetry.ok, false);
      assert.equal(plainRetry.reason, REASON.INTENT_CLAIM_DENIED);
      assert.equal(countSubGrantFiles(outDir), 0, "plain retry must not issue");
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.PAUSED,
        "a denied plain retry must not move the intent out of PAUSED",
      );

      // ③ 사람이 명시적으로 재개(resumeHumanRef)해야만 1에 도달한다.
      const humanRetriggered = issueSubGrant({
        ...request,
        at: "t3",
        resumeHumanRef: "human-ack-ref-mutation-6",
      });
      assert.equal(humanRetriggered.ok, true, JSON.stringify(humanRetriggered));
      assert.equal(
        countSubGrantFiles(outDir),
        1,
        "exactly 1 after the human-resumed retry, never more",
      );
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.ISSUED,
      );
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
});

// ---- P1-1 반사실 (review-1 정확 재현): 같은 stableIntentId·같은 taskHash,
// consumption/out dir 공통, delegation_id만 다르게 issueSubGrant를 직접 두
// 번 불러도 총 발급은 1이어야 한다. REVIEW가 grant-issuer.mjs:436/461/468을
// 직접 호출해 발견한 그 결함의 정확한 재현. ----
test("end-to-end: PRODUCTION issueSubGrant called twice with only delegation_id differing (same stableIntentId/taskHash/dirs) -> total issued = 1 (P1-1, exact review repro)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pullAdmission, gates } = pipelineFixture(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());

      const first = issueSubGrant({
        delegation: makeFakeDelegation({
          delegation_id: "review-delegation-a",
        }),
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t1",
      });
      const second = issueSubGrant({
        delegation: makeFakeDelegation({
          delegation_id: "review-delegation-b",
        }),
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t2",
      });

      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(second.ok, false, JSON.stringify(second));
      assert.equal(second.reason, REASON.INTENT_CLAIM_DENIED);
      assert.equal(countSubGrantFiles(outDir), 1);
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
});

// ---- P1-1 반사실: 불량 gates(hard-stop 등)와 불량 pullAdmission을 함께
// 넘겨 PRODUCTION issueSubGrant를 직접 불러도 발급되지 않는다. ----
test("end-to-end: PRODUCTION issueSubGrant with hard-stop/new-issue/streak2 gates AND a malformed pullAdmission -> DENY, 0 issued (P1-1, exact review repro)", () => {
  const intentDir = freshDir();
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const result = issueSubGrant({
      delegation: makeFakeDelegation(),
      taskHash: DELEGATION_TASK_HASH,
      role: "CODER",
      startBudgetRequested: 1,
      stableIntentId,
      intentDir,
      pullAdmission: {},
      gates: {
        hardStop: true,
        newIssueBoundary: true,
        consecutiveRejections: 2,
      },
      consumptionDir,
      outDir,
      nowMs: DELEGATION_IN_WINDOW_NOW,
      at: "t1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ADMISSION_DENIED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(intentDir);
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- P2-2 반사실 (review-2 정확 재현, 재배치 검증): admission이 stable-intent
// claim보다 먼저 검사되므로, admission-deny는 claim 레코드를 디스크에 전혀
// 남기지 않는다(= CLAIMED로 영구 고정되는 stuck intent가 구조적으로
// 불가능). 이어서 같은 stableIntentId로 유효한 admission을 주고 재호출하면
// 정상 claim·발급 1에 도달한다(사람 개입도 필요 없다 --애초에 claim이
// 없었으니 resumeHumanRef 문도 필요 없다). judgeAdmission을 resolveIntentWin
// 뒤로 되돌리는 재배치 mutation 단독으로 이 테스트는 RED여야 한다(claim 파일이
// 생기고, 두 번째 호출이 INTENT_CLAIM_DENIED로 막힌다). ----
test("end-to-end: PRODUCTION issueSubGrant with admission-deny (hard-stop + malformed pullAdmission) -> DENY, 0 issued, AND no intent claim record on disk; a later valid-admission retry on the SAME stableIntentId reaches 1 (P2-2, exact review repro)", () => {
  const intentDir = freshDir();
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const claimPath = join(intentDir, `intent-${stableIntentId}.claim.json`);

    const denied = issueSubGrant({
      delegation: makeFakeDelegation(),
      taskHash: DELEGATION_TASK_HASH,
      role: "CODER",
      startBudgetRequested: 1,
      stableIntentId,
      intentDir,
      pullAdmission: {},
      gates: {
        hardStop: true,
        newIssueBoundary: true,
        consecutiveRejections: 2,
      },
      consumptionDir,
      outDir,
      nowMs: DELEGATION_IN_WINDOW_NOW,
      at: "t1",
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, REASON.ADMISSION_DENIED);
    assert.equal(countSubGrantFiles(outDir), 0);
    assert.equal(
      readdirSync(intentDir).length,
      0,
      "admission-deny must not create ANY intent claim record -- claim happens after admission now",
    );
    assert.throws(
      () => readFileSync(claimPath, "utf8"),
      /ENOENT/,
      "no claim file must exist for this stableIntentId after an admission-deny",
    );

    withTempDir((bundleDir) => {
      const { pullAdmission, gates } = pipelineFixture(bundleDir);
      const recovered = issueSubGrant({
        delegation: makeFakeDelegation(),
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t2",
      });
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(
        countSubGrantFiles(outDir),
        1,
        "a later valid-admission call on the same stableIntentId must reach 1 -- no human resume needed, since no claim was ever stuck",
      );
      assert.equal(
        readIntentStatus(intentDir, stableIntentId),
        INTENT_STATUS.ISSUED,
      );
    });
  } finally {
    cleanup(intentDir);
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #9: 사람 개인키가 supervisor/worker/env/prompt 경로에
// 존재 -> 검출·거부. 정적(grep) + 런타임(poisoned delegation 필드가 산출물
// 로 새지 않는지) 둘 다. ----
const CORE_FILES = [
  "stable-intent.mjs",
  "admission-core.mjs",
  "grant-issuer.mjs",
  "hyk171-cycle3a-fixtures.mjs",
];
const FORBIDDEN_PRIVATE_KEY_PATTERNS = [
  /PRIVATE KEY/,
  /createPrivateKey/,
  /privateKeyPath/i,
  /private_key_pem/i,
];

test("static: none of the 3A core/fixture files reference private-key material or a private-key-path parameter (mutation #9, static)", () => {
  for (const file of CORE_FILES) {
    const content = readFile(
      join(
        new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
        file,
      ),
      "utf8",
    );
    for (const re of FORBIDDEN_PRIVATE_KEY_PATTERNS) {
      assert.equal(
        re.test(content),
        false,
        `${file} must not reference ${re} -- these modules never touch a human private key (coder-task.md non-negotiable)`,
      );
    }
  }
});

test("runtime: a delegation object poisoned with a fake 'PRIVATE KEY' field never leaks into the issued sub-grant envelope (mutation #9, runtime)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pullAdmission, gates } = pipelineFixture(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const poisoned = makeFakeDelegation({
        // 공격자/실수로 delegation 객체에 개인키류 필드가 얹혀도, 이
        // 모듈은 화이트리스트 필드만 골라 담으므로(buildSubGrantFields)
        // 이 값이 산출물에 나타나서는 안 된다.
        human_private_key:
          "-----BEGIN PRIVATE KEY-----\nMFAKEPRIVATEKEYDATA\n-----END PRIVATE KEY-----",
      });
      const result = issueSubGrant({
        delegation: poisoned,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        intentDir,
        pullAdmission,
        gates,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t1",
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const onDisk = readFileSync(result.envelopePath, "utf8");
      assert.equal(
        /PRIVATE KEY/.test(onDisk),
        false,
        "issued envelope must never contain private-key material",
      );
      assert.equal(
        JSON.stringify(result.envelope).includes("human_private_key"),
        false,
      );
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
});

// ---- S6 (엔진무관) 재확인: 이 모듈들은 orca를 import/호출하지 않는다 --
// 정적 grep(orca-cli-boundary.mjs가 별도로 검사하는 spawn/exec 리터럴과
// 다른 축: "orca" 문자열 자체의 부재를 코드 경로에서 확인한다. 주석은
// 이 사이클 지침대로 일반 어휘를 쓰므로 여기엔 등장하지 않는다).
test("S6: stable-intent/admission-core/grant-issuer source contains no 'orca' reference (case-insensitive)", () => {
  for (const file of [
    "stable-intent.mjs",
    "admission-core.mjs",
    "grant-issuer.mjs",
  ]) {
    const content = readFile(
      join(
        new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
        file,
      ),
      "utf8",
    );
    assert.equal(
      /orca/i.test(content),
      false,
      `${file} must not reference 'orca'`,
    );
  }
});
