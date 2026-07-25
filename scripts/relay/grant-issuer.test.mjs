import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { issueSubGrant, consumeDelegationTx, REASON } from "./grant-issuer.mjs";
import {
  makeFakeDelegation,
  DELEGATION_TASK_HASH,
  DELEGATION_IN_WINDOW_NOW,
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
} from "./hyk171-cycle3a-fixtures.mjs";

function freshDir() {
  return mkdtempSync(join(tmpdir(), "grant-issuer-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
function countSubGrantFiles(dir) {
  return readdirSync(dir).filter((f) => f.startsWith("sub-grant-")).length;
}
let stableIntentSeq = 0;
function nextStableIntentId() {
  stableIntentSeq += 1;
  return `stable-intent-fixture-${stableIntentSeq}`;
}

function baseRequest(overrides = {}) {
  return {
    delegation: makeFakeDelegation(),
    taskHash: DELEGATION_TASK_HASH,
    role: "CODER",
    startBudgetRequested: 1,
    stableIntentId: nextStableIntentId(),
    nowMs: DELEGATION_IN_WINDOW_NOW,
    at: "t1",
    ...overrides,
  };
}

// P1-1 (review-1 반려): 이 파일의 delegation-scope 테스트(taskHash/role/
// budget/expiry/schema)는 issueSubGrant의 ①형식검증 ②scope 체크 단계에서
// 걸리므로 pullAdmission/gates/intentDir 없이도 여전히 유효하다(그 체크는
// admission/claim보다 먼저 실행된다). 하지만 "실제로 발급까지 가야 하는"
// 테스트(paired-good/store write 실패류)는 admission ALLOW + intent claim이
// 반드시 필요하다 -- 이 헬퍼가 그 fixture 세트를 한 번에 만든다.
function withFullPipelineRequest(overrides, fn) {
  return withTempDir((bundleDir) => {
    const intentDir = freshDir();
    try {
      const { pinPath } = writePullAdmissionBundle(bundleDir);
      const request = baseRequest({
        intentDir,
        pullAdmission: pullAdmissionInput(bundleDir, pinPath),
        gates: makeAllowGates(),
        ...overrides,
      });
      return fn(request);
    } finally {
      cleanup(intentDir);
    }
  });
}

// ---- paired-good: 완전히 유효한 delegation·범위·요청 -> 정확히 1개 발급 ----
test("issueSubGrant: fully valid delegation + in-scope request + admission ALLOW + intent claim -> exactly 1 issued (paired-good)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    withFullPipelineRequest({ consumptionDir, outDir }, (request) => {
      const result = issueSubGrant(request);
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.issued, true);
      assert.equal(result.reason, REASON.ISSUED);
      assert.equal(countSubGrantFiles(outDir), 1);
      const onDisk = JSON.parse(readFileSync(result.envelopePath, "utf8"));
      assert.equal(onDisk.task_hash, DELEGATION_TASK_HASH);
      assert.equal(onDisk.signature, null);
      assert.match(onDisk.signature_note, /fake\/test delegation/);
    });
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #8: 서명범위 이탈(task hash/role/budget 밖) -> grant 0 ----
test("issueSubGrant: task_hash outside delegation.allowed_task_hashes -> DENY, 0 issued (mutation #8 a)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({ consumptionDir, outDir, taskHash: "sha256-not-in-scope" }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DELEGATION_TASK_HASH_OUT_OF_SCOPE);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

test("issueSubGrant: role outside delegation.role -> DENY, 0 issued (mutation #8 b)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({ consumptionDir, outDir, role: "PM" }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DELEGATION_ROLE_MISMATCH);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

test("issueSubGrant: requested start budget exceeds delegation.max_start_budget -> DENY, 0 issued (mutation #8 c)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({ consumptionDir, outDir, startBudgetRequested: 2 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DELEGATION_BUDGET_EXCEEDED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

test("issueSubGrant: delegation already expired at nowMs -> DENY DELEGATION_EXPIRED, 0 issued", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({
        consumptionDir,
        outDir,
        nowMs: Date.parse("2099-01-01T00:00:00.000Z"),
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DELEGATION_EXPIRED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #10: 스키마/버전 불일치 -> 확정 발급 0, fail-closed ----
test("issueSubGrant: delegation.schema_version mismatch -> DENY DELEGATION_INVALID, 0 issued (mutation #10 a)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({
        consumptionDir,
        outDir,
        delegation: makeFakeDelegation({ schema_version: 2 }),
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DELEGATION_INVALID);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

for (const field of [
  "delegation_id",
  "scope_issue_id",
  "role",
  "allowed_task_hashes",
  "max_start_budget",
  "expires_at",
  "max_consecutive_rejections",
  "excludes_north_star",
  "excludes_hard_stop",
]) {
  test(`issueSubGrant: delegation missing/invalid '${field}' -> DENY DELEGATION_INVALID, 0 issued`, () => {
    const consumptionDir = freshDir();
    const outDir = freshDir();
    try {
      const delegation = makeFakeDelegation();
      delete delegation[field];
      const result = issueSubGrant(
        baseRequest({ consumptionDir, outDir, delegation }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.DELEGATION_INVALID);
      assert.equal(countSubGrantFiles(outDir), 0);
    } finally {
      cleanup(consumptionDir);
      cleanup(outDir);
    }
  });
}

// ---- P1-1 (review-1 반려 핵심 결함, 직접 재현): 프로덕션 발급 진입점은
// admission ALLOW 증거·stable-intent 단일승자 claim 없이는 절대 진입하지
// 않는다. 이 그룹은 REVIEW가 grant-issuer.mjs:436/461/468을 직접 두 번
// 호출해 grant 2개를 만들었던 그 재현을 그대로 테스트로 옮긴 것이다. ----
test("issueSubGrant: missing stableIntentId -> DENY INTENT_CLAIM_REQUIRED, 0 issued (P1-1)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({ consumptionDir, outDir, stableIntentId: undefined }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.INTENT_CLAIM_REQUIRED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

test("issueSubGrant: missing intentDir -> DENY INTENT_CLAIM_DENIED (claim cannot be attempted without a trusted intentDir), 0 issued (P1-1)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(baseRequest({ consumptionDir, outDir }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.INTENT_CLAIM_DENIED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

test("issueSubGrant: missing pullAdmission/gates -> DENY ADMISSION_DENIED (admission is not optional even once the intent is won), 0 issued (P1-1)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  const intentDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({ consumptionDir, outDir, intentDir }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ADMISSION_DENIED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
    cleanup(intentDir);
  }
});

test("issueSubGrant: deny-gates (hardStop/newIssueBoundary/consecutiveRejections=2) block direct issuance EVEN WITH a malformed pullAdmission passed alongside -> DENY ADMISSION_DENIED, 0 issued (P1-1, exact review repro)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  const intentDir = freshDir();
  try {
    const result = issueSubGrant(
      baseRequest({
        consumptionDir,
        outDir,
        intentDir,
        pullAdmission: {},
        gates: {
          hardStop: true,
          newIssueBoundary: true,
          consecutiveRejections: 2,
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ADMISSION_DENIED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
    cleanup(intentDir);
  }
});

test("issueSubGrant: SAME stableIntentId, two direct calls with DIFFERENT delegation_id -> total issued = 1 (P1-1, exact review repro of the rejected defect)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    withFullPipelineRequest({ consumptionDir, outDir }, (request) => {
      const first = issueSubGrant({
        ...request,
        delegation: makeFakeDelegation({
          delegation_id: "review-delegation-a",
        }),
      });
      const second = issueSubGrant({
        ...request,
        delegation: makeFakeDelegation({
          delegation_id: "review-delegation-b",
        }),
      });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(second.ok, false, JSON.stringify(second));
      assert.equal(second.reason, REASON.INTENT_CLAIM_DENIED);
      assert.equal(
        countSubGrantFiles(outDir),
        1,
        "on-disk sub-grant file count must be exactly 1, not 2",
      );
    });
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- P1-3 (review-1 반려): 손상된 소비 레코드가 하나라도 있으면 그
// consumptionDir(store) 전체에서 다른 delegation_id 발급도 막는다. ----
test("issueSubGrant: a corrupted consumption record for a DIFFERENT delegation_id in the same store blocks issuance too (store-wide degraded, P1-3)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    withFullPipelineRequest({ consumptionDir, outDir }, (request) => {
      writeFileSync(
        join(consumptionDir, "delegation-consume-corrupted.json"),
        "{not-json",
        "utf8",
      );
      const result = issueSubGrant(request);
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.CONSUMPTION_STORE_DEGRADED);
      assert.equal(countSubGrantFiles(outDir), 0);
    });
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #10 b: store write 실패 -> 확정 발급 0, fail-closed ----
test("issueSubGrant: consumption store write failure -> DENY, 0 issued (fail-closed)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    withFullPipelineRequest({ consumptionDir, outDir }, (request) => {
      const result = issueSubGrant(request, {
        writeFileFn: (path, content, opts) => {
          if (path.includes(consumptionDir)) {
            throw new Error("injected consumption store failure");
          }
          writeFileSync(path, content, opts);
        },
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASON.DELEGATION_CONSUME_FAILED);
      assert.equal(countSubGrantFiles(outDir), 0);
    });
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #10 c / P2-1: envelope write 실패(발급 파일 쓰기 실패)
// -> 0 issued, delegation은 이미 소비된 채로 남고 intent는 PAUSED가 된다
// (사람이 판단해야 하는 degraded 상태). 정상 재호출(resumeHumanRef 없음)은
// claim 단계에서 막히고(우회 불가, P1-1), resumeHumanRef로 명시 재개해도
// delegation은 이미 소비된 채라 여전히 0 issued로 끝난다(honesty 한계:
// 같은 task_hash로는 다시 발급될 수 없다). ----
test("issueSubGrant: envelope write failure after delegation consumed -> 0 issued this attempt, intent PAUSED, and NEITHER a plain retry NOR a human-resumed retry can double-issue (mutation #6 equivalent)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    withFullPipelineRequest({ consumptionDir, outDir }, (request) => {
      const failing = issueSubGrant(request, {
        writeFileFn: (path, content, opts) => {
          // consumeDelegationTx의 saveStoreAtomic(consumptionDir 내부 경로)과
          // intent claim 기록(intentDir 내부 경로)은 그대로 성공시키고,
          // sub-grant envelope(outDir 내부 경로) 쓰기만 실패시킨다 --
          // "claim·delegation 소비는 커밋됐지만 grant 발급까지는 못 갔다"는
          // crash 시점을 정확히 재현한다.
          if (path.includes(outDir)) {
            throw new Error("injected envelope write failure");
          }
          writeFileSync(path, content, opts);
        },
      });
      assert.equal(failing.ok, false);
      assert.equal(failing.reason, REASON.ENVELOPE_WRITE_FAILED);
      assert.equal(
        countSubGrantFiles(outDir),
        0,
        "0 issued on the failed attempt",
      );

      // 자동 재시도 0 + 우회 0(P1-1): 정상 deps로 같은 stableIntentId를
      // 재호출해도(resumeHumanRef 없음) claim 단계에서 duplicate로 막힌다 --
      // PAUSED에서도 정상 발급 API는 claim을 우회하지 못한다.
      const plainRetry = issueSubGrant({ ...request });
      assert.equal(plainRetry.ok, false);
      assert.equal(plainRetry.reason, REASON.INTENT_CLAIM_DENIED);
      assert.equal(countSubGrantFiles(outDir), 0, "plain retry must not issue");

      // 사람이 명시적으로 재개해도(resumeHumanRef) delegation은 이미
      // consumeDelegationTx에서 소비된 채라 두 번째 발급 자체가 거부된다
      // (같은 delegation_id+task_hash로는 정확히 0~1개만 나온다는 계약
      // 유지 -- resume은 claim을 되살릴 뿐 소비된 delegation을 되살리지
      // 않는다).
      const resumedRetry = issueSubGrant({
        ...request,
        resumeHumanRef: "human-ack-ref-1",
      });
      assert.equal(resumedRetry.ok, false);
      assert.equal(resumedRetry.reason, REASON.DELEGATION_ALREADY_CONSUMED);
      assert.equal(
        countSubGrantFiles(outDir),
        0,
        "resumed retry must not silently issue a grant after a crash",
      );
    });
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #2: 같은 signed bundle을 2개 supervisor가 동시 소비 ->
// 합계 1. auth-grant-ledger.test.mjs의 barrier-synchronized worker 경합
// 패턴을 delegation 소비에 재사용. ----
const MODULE_URL = new URL("./grant-issuer.mjs", import.meta.url).href;
const BARRIER_WAIT_SRC = `
function barrierWait(sab, total) {
  const arr = new Int32Array(sab);
  Atomics.add(arr, 0, 1);
  if (Atomics.load(arr, 0) >= total) {
    Atomics.notify(arr, 0);
    return;
  }
  for (;;) {
    const v = Atomics.load(arr, 0);
    if (v >= total) return;
    Atomics.wait(arr, 0, v);
  }
}
`;
const CONSUME_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${BARRIER_WAIT_SRC}
(async () => {
  try {
    const mod = await import(workerData.modulePath);
    barrierWait(workerData.barrierBuffer, workerData.barrierCount);
    const result = mod.consumeDelegationTx({
      consumptionDir: workerData.consumptionDir,
      delegationId: workerData.delegationId,
      taskHash: workerData.taskHash,
      role: workerData.role,
      at: workerData.at,
    });
    parentPort.postMessage({ ok: result.ok === true, claimed: result.claimed === true, duplicate: result.duplicate === true });
  } catch (err) {
    parentPort.postMessage({ workerThrew: (err && typeof err.message === "string") ? err.message : String(err) });
  }
})();
`;
function runInWorker(source, workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData });
    worker.once("message", (msg) => {
      worker.terminate().then(() => resolve(msg));
    });
    worker.once("error", reject);
  });
}
function consumeInWorker(
  consumptionDir,
  delegationId,
  taskHash,
  role,
  at,
  barrierBuffer,
) {
  return runInWorker(CONSUME_WORKER_SRC, {
    modulePath: MODULE_URL,
    consumptionDir,
    delegationId,
    taskHash,
    role,
    at,
    barrierBuffer,
    barrierCount: 2,
  });
}

test("consumeDelegationTx: real barrier-synchronized concurrent consumption of the SAME signed bundle by two supervisors -- exactly one wins (mutation #2)", async () => {
  const consumptionDir = freshDir();
  try {
    const barrierBuffer = new SharedArrayBuffer(4);
    const [a, b] = await Promise.all([
      consumeInWorker(
        consumptionDir,
        "delegation-race-1",
        DELEGATION_TASK_HASH,
        "CODER",
        "t-race",
        barrierBuffer,
      ),
      consumeInWorker(
        consumptionDir,
        "delegation-race-1",
        DELEGATION_TASK_HASH,
        "CODER",
        "t-race",
        barrierBuffer,
      ),
    ]);
    const wins = [a, b].filter((r) => r.claimed);
    const losers = [a, b].filter((r) => r.duplicate);
    assert.equal(
      wins.length,
      1,
      `expected exactly one winner, got ${JSON.stringify([a, b])}`,
    );
    assert.equal(
      losers.length,
      1,
      `expected exactly one duplicate loser, got ${JSON.stringify([a, b])}`,
    );
  } finally {
    cleanup(consumptionDir);
  }
});

// ---- consumeDelegationTx 단독 계약(auth-grant-ledger.mjs와 동일 형태) ----
test("consumeDelegationTx: consumptionDir missing -> fail-closed reject", () => {
  const result = consumeDelegationTx({
    consumptionDir: "",
    delegationId: "d-1",
    taskHash: DELEGATION_TASK_HASH,
    role: "CODER",
    at: "t1",
  });
  assert.equal(result.ok, false);
  assert.equal(result.claimed, false);
});
