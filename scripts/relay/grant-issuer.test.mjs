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

function baseRequest(overrides = {}) {
  return {
    delegation: makeFakeDelegation(),
    taskHash: DELEGATION_TASK_HASH,
    role: "CODER",
    startBudgetRequested: 1,
    stableIntentId: "stable-intent-fixture-1",
    nowMs: DELEGATION_IN_WINDOW_NOW,
    at: "t1",
    ...overrides,
  };
}

// ---- paired-good: 완전히 유효한 delegation·범위·요청 -> 정확히 1개 발급 ----
test("issueSubGrant: fully valid delegation + in-scope request -> exactly 1 issued (paired-good)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(baseRequest({ consumptionDir, outDir }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.issued, true);
    assert.equal(result.reason, REASON.ISSUED);
    assert.equal(countSubGrantFiles(outDir), 1);
    const onDisk = JSON.parse(readFileSync(result.envelopePath, "utf8"));
    assert.equal(onDisk.task_hash, DELEGATION_TASK_HASH);
    assert.equal(onDisk.signature, null);
    assert.match(onDisk.signature_note, /fake\/test delegation/);
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

// ---- §6 mutation #10 b: store write 실패 -> 확정 발급 0, fail-closed ----
test("issueSubGrant: consumption store write failure -> DENY, 0 issued (fail-closed)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const result = issueSubGrant(baseRequest({ consumptionDir, outDir }), {
      writeFileFn: () => {
        throw new Error("injected consumption store failure");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DELEGATION_CONSUME_FAILED);
    assert.equal(countSubGrantFiles(outDir), 0);
  } finally {
    cleanup(consumptionDir);
    cleanup(outDir);
  }
});

// ---- §6 mutation #10 c: envelope write 실패(발급 파일 쓰기 실패) -> 0 issued,
// 하지만 delegation은 이미 소비된 채로 남는다(사람이 판단해야 하는
// degraded 상태 -- 이 시나리오가 바로 mutation #6 "intent claim 뒤·grant
// 발급 前 crash"의 grant-issuer 층위 등가물이다: 재시도해도 같은
// task_hash로는 다시 발급될 수 없다, 즉 "자동 재시도로 새 grant가 몰래
// 튀어나옴" 0). ----
test("issueSubGrant: envelope write failure after delegation consumed -> 0 issued this attempt, AND delegation is now consumed so a retry cannot silently double-consume (mutation #6 equivalent)", () => {
  const consumptionDir = freshDir();
  const outDir = freshDir();
  try {
    const failing = issueSubGrant(baseRequest({ consumptionDir, outDir }), {
      writeFileFn: (path, content, opts) => {
        // consumeDelegationTx의 saveStoreAtomic(consumptionDir 내부 경로)은
        // 그대로 성공시키고, sub-grant envelope(outDir 내부 경로) 쓰기만
        // 실패시킨다 -- "intent/delegation claim은 커밋됐지만 grant
        // 발급까지는 못 갔다"는 crash 시점을 정확히 재현한다.
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

    // 자동 재시도 0: issueSubGrant 자신은 재시도 루프가 없다(정적으로도
    // 확인됨 -- grant-issuer.mjs grep). "사람이 다시 부른다"를 흉내내
    // 정상 deps로 재호출해도, delegation은 이미 consumeDelegationTx에서
    // 소비된 채라 두 번째 발급 자체가 거부된다(같은 delegation_id+task_hash
    // 로는 정확히 0~1개만 나온다는 계약 유지).
    const retried = issueSubGrant(baseRequest({ consumptionDir, outDir }));
    assert.equal(retried.ok, false);
    assert.equal(retried.reason, REASON.DELEGATION_ALREADY_CONSUMED);
    assert.equal(
      countSubGrantFiles(outDir),
      0,
      "retry must not silently issue a grant after a crash",
    );
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
