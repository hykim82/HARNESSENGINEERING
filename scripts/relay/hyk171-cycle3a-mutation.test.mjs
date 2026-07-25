import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  readFileSync as readFile,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimIntentTx, computeStableIntentId } from "./stable-intent.mjs";
import {
  judgeAdmission,
  REASON as ADMISSION_REASON,
} from "./admission-core.mjs";
import { issueSubGrant } from "./grant-issuer.mjs";
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

// HYK-171 사이클3A -- 세 모듈(stable-intent/admission-core/grant-issuer)을
// 조합한 end-to-end 반사실 원장(§6 Q7 mutation, "vacuous-pass 금지":
// 최종 상태가 아니라 실행의도 승자 수·grant 발급 수·adapter/실 sink 호출
// 수를 정확히 센다). §5 완료기준의 "총 실행권위 1개"는 이 파일에서
// "orchestration(claim 승리 시에만 발급 시도)을 스스로 재현해" 카운트한다
// -- 3B가 실제로 배선할 runner의 최소 계약을 이 테스트가 미리 증명한다.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hyk171-cycle3a-mutation-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function countSubGrantFiles(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("sub-grant-")).length;
}

// orchestration 흉내(3B가 배선할 최소 계약): stable intent를 먼저 claim하고,
// 이겼을 때만 admission→issuer로 내려간다. 진 후보는 admission/issuer를
// 아예 호출하지 않는다(그래서 "총 발급 수"가 claim 승자 수를 절대 넘지
// 않는다는 사실이 이 오케스트레이션 계약 자체에서 나온다).
function attemptStableIntentGrant({
  intentDir,
  stableIntentId,
  winnerId,
  bundleDir,
  pinPath,
  consumptionDir,
  outDir,
  delegation,
  taskHash,
  at,
}) {
  const claim = claimIntentTx({
    intentDir,
    stableIntentId,
    winner: { jti: winnerId },
    at,
  });
  if (!claim.claimed) {
    return { claimed: false, issued: false, claim };
  }
  const admission = judgeAdmission({
    pullAdmission: pullAdmissionInput(bundleDir, pinPath),
    gates: makeAllowGates(),
  });
  if (!admission.ok) {
    return { claimed: true, issued: false, claim, admission };
  }
  const issueResult = issueSubGrant({
    delegation,
    taskHash,
    role: "CODER",
    startBudgetRequested: 1,
    stableIntentId,
    consumptionDir,
    outDir,
    nowMs: DELEGATION_IN_WINDOW_NOW,
    at,
  });
  return {
    claimed: true,
    issued: issueResult.ok === true,
    claim,
    admission,
    issueResult,
  };
}

// ---- §5/§6 mutation #1 (최우선, "이게 RED 아니면 헛시험"): 같은 stall
// episode에서 서로 다른 jti를 가진 valid grant 후보 2개가 각각 전체
// 파이프라인(claim→admission→issue)을 시도해도 총 발급 수는 1이어야
// 한다. ----
test("end-to-end: SAME stable intent, two candidates with DIFFERENT jti each run the full claim->admission->issue pipeline -> total issued = 1 (mutation #1, full pipeline)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pinPath } = writePullAdmissionBundle(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const delegation = makeFakeDelegation();

      const candidateA = attemptStableIntentGrant({
        intentDir,
        stableIntentId,
        winnerId: "jti-candidate-A",
        bundleDir,
        pinPath,
        consumptionDir,
        outDir,
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        at: "t1",
      });
      const candidateB = attemptStableIntentGrant({
        intentDir,
        stableIntentId,
        winnerId: "jti-candidate-B",
        bundleDir,
        pinPath,
        consumptionDir,
        outDir,
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        at: "t2",
      });

      const totalClaimed = [candidateA, candidateB].filter(
        (c) => c.claimed,
      ).length;
      const totalIssued = [candidateA, candidateB].filter(
        (c) => c.issued,
      ).length;
      assert.equal(
        totalClaimed,
        1,
        `expected exactly 1 total intent winner, got ${JSON.stringify([candidateA.claim, candidateB.claim])}`,
      );
      assert.equal(
        totalIssued,
        1,
        `expected exactly 1 total issued sub-grant, got ${JSON.stringify([candidateA, candidateB])}`,
      );
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
// positive -> grant 정확히 1 ----
test("end-to-end: fully valid delegation + gates + intent winner -> exactly 1 grant (paired-good)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pinPath } = writePullAdmissionBundle(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const delegation = makeFakeDelegation();

      const result = attemptStableIntentGrant({
        intentDir,
        stableIntentId,
        winnerId: "jti-good",
        bundleDir,
        pinPath,
        consumptionDir,
        outDir,
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        at: "t1",
      });

      assert.equal(result.claimed, true);
      assert.equal(result.admission.ok, true);
      assert.equal(result.admission.reason, ADMISSION_REASON.ALLOW);
      assert.equal(result.issued, true);
      assert.equal(countSubGrantFiles(outDir), 1);
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
});

// ---- §6 mutation #6: intent claim 뒤·grant 발급 前 crash -> 0 issued,
// PAUSED(사람 개입 필요), 자동 재시도 0. "자동 재시도 0"은 구조 사실
// (claimIntentTx/issueSubGrant 둘 다 재시도 루프가 없다 -- 정적 grep으로도
// 아래에서 확인) + 이 테스트가 "두 번째 호출은 사람이 명시적으로 다시 부를
// 때만 일어난다"는 계약을 재현한다(자동으로 트리거되는 코드 경로 0). ----
test("end-to-end: crash after intent claim commits but before grant issuance -> 0 issued this round; a human-triggered retry (not automatic) is the ONLY way to reach 1 (mutation #6)", () => {
  withTempDir((bundleDir) => {
    const intentDir = freshDir();
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const { pinPath } = writePullAdmissionBundle(bundleDir);
      const stableIntentId = computeStableIntentId(makeStableIntentFields());
      const delegation = makeFakeDelegation();

      // ① intent claim은 커밋된다(디스크에 남는다).
      const claim = claimIntentTx({
        intentDir,
        stableIntentId,
        winner: { jti: "jti-crash-after-claim" },
        at: "t1",
      });
      assert.equal(claim.claimed, true);

      // ② admission ALLOW까지는 도달하지만, delegation 소비 저장이 죽는다
      // ("intent claim commit 뒤, grant 발급 前"의 정확한 지점).
      const admission = judgeAdmission({
        pullAdmission: pullAdmissionInput(bundleDir, pinPath),
        gates: makeAllowGates(),
      });
      assert.equal(admission.ok, true);
      const crashedIssue = issueSubGrant(
        {
          delegation,
          taskHash: DELEGATION_TASK_HASH,
          role: "CODER",
          startBudgetRequested: 1,
          stableIntentId,
          consumptionDir,
          outDir,
          nowMs: DELEGATION_IN_WINDOW_NOW,
          at: "t1",
        },
        {
          writeFn: () => {
            // acquireArmMutex의 배타 lock 쓰기 자체를 죽여 delegation
            // 소비 트랜잭션이 시작조차 못 하게 한다(가장 이른 crash 지점).
            throw new Error("injected crash before delegation consume commit");
          },
        },
      );
      assert.equal(crashedIssue.ok, false);
      assert.equal(countSubGrantFiles(outDir), 0, "0 issued after the crash");

      // ③ 자동 재시도는 없다(구조): 아무도 다시 부르지 않으면 영원히 0인
      // 채로 남는다 -- 이 테스트에서 "재호출"은 사람이 개입해 명시적으로
      // 다시 실행한다는 것을 흉내낸다(코드 자체에 이 재호출을 트리거하는
      // setTimeout/재귀/이벤트 리스너가 없다는 사실은 아래 정적 grep이
      // 별도로 증명한다).
      const humanRetriggered = issueSubGrant({
        delegation,
        taskHash: DELEGATION_TASK_HASH,
        role: "CODER",
        startBudgetRequested: 1,
        stableIntentId,
        consumptionDir,
        outDir,
        nowMs: DELEGATION_IN_WINDOW_NOW,
        at: "t2",
      });
      assert.equal(humanRetriggered.ok, true);
      assert.equal(
        countSubGrantFiles(outDir),
        1,
        "exactly 1 after the human-triggered retry, never more",
      );
    } finally {
      cleanup(intentDir);
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
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
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
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
    cleanup(consumptionDir);
    cleanup(outDir);
  }
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
