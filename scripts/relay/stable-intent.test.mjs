import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  claimIntentTx,
  computeStableIntentId,
  STABLE_INTENT_FIELDS,
} from "./stable-intent.mjs";
import { makeStableIntentFields } from "./hyk171-cycle3a-fixtures.mjs";

// M1: 전부 mkdtempSync 임시 디렉터리 + 합성 문자열만 참조.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "stable-intent-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function countClaimFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith(".claim.json")).length;
}

test("computeStableIntentId: same six axes -> same id; any single axis changed -> different id", () => {
  const base = makeStableIntentFields();
  const a = computeStableIntentId(base);
  const b = computeStableIntentId({ ...base });
  assert.equal(a, b);
  for (const field of STABLE_INTENT_FIELDS) {
    const mutated = { ...base, [field]: `${base[field]}-mutated` };
    assert.notEqual(
      computeStableIntentId(mutated),
      a,
      `mutating '${field}' must change the stable intent id`,
    );
  }
});

test("computeStableIntentId: crucially, differs by axes NOT by jti/arm_id/grant_digest (those never appear in the input)", () => {
  const base = makeStableIntentFields();
  const id1 = computeStableIntentId(base);
  // grant 식별자(jti/arm_id/grant_digest)를 흉내내는 필드를 얹어도 이
  // 함수 시그니처엔 그 필드가 없으므로 결과에 영향이 없다 -- 즉 이
  // 값은 grant 발급 前부터 계산 가능하다는 계약을 입력 형태 수준에서
  // 증명한다.
  const id2 = computeStableIntentId({ ...base, jti: "jti-should-be-ignored" });
  assert.equal(id1, id2);
});

test("computeStableIntentId: missing/empty axis -> throws TypeError (fail-closed)", () => {
  const base = makeStableIntentFields();
  for (const field of STABLE_INTENT_FIELDS) {
    const bad = { ...base };
    delete bad[field];
    assert.throws(() => computeStableIntentId(bad), TypeError);
    assert.throws(
      () => computeStableIntentId({ ...base, [field]: "" }),
      TypeError,
    );
  }
});

test("claimIntentTx: known-good first claim succeeds, writes exactly one record", () => {
  const dir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const result = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-a", arm_id: "arm-a" },
      at: "t1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.claimed, true);
    assert.equal(existsSync(result.path), true);
    assert.equal(countClaimFiles(dir), 1);
    const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(onDisk.stable_intent_id, stableIntentId);
    assert.deepEqual(onDisk.winner, { jti: "jti-a", arm_id: "arm-a" });
  } finally {
    cleanup(dir);
  }
});

// [§6 mutation #1 -- "이게 RED 아니면 헛시험"] 같은 stall intent에 서로
// 다른 jti/arm_id를 실은 valid grant 후보 2개가 각각 claim을 시도해도
// 총 승자 수는 1이어야 한다.
test("claimIntentTx: SAME stable intent, two DIFFERENT jti/arm_id winners -> total claimed count = 1 (mutation #1)", () => {
  const dir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const first = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-alpha", arm_id: "arm-alpha" },
      at: "t1",
    });
    const second = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-beta", arm_id: "arm-beta" },
      at: "t2",
    });
    const claims = [first, second].filter((r) => r.claimed === true);
    assert.equal(
      claims.length,
      1,
      `expected exactly 1 total claimed, got ${JSON.stringify([first, second])}`,
    );
    assert.equal(second.ok, false);
    assert.equal(second.duplicate, true);
    assert.equal(countClaimFiles(dir), 1);
    // 원 레코드가 두 번째 시도의 winner로 덮어써지지 않았는지 확인.
    const onDisk = JSON.parse(readFileSync(first.path, "utf8"));
    assert.deepEqual(onDisk.winner, { jti: "jti-alpha", arm_id: "arm-alpha" });
  } finally {
    cleanup(dir);
  }
});

// [§6 mutation #3] 같은 jti, 다른 grant_digest를 실은 winner 페이로드로
// claim해도(=같은 stableIntentId) 두 번째는 거부.
test("claimIntentTx: same jti, different grant_digest under the SAME stable intent -> total = 1 (mutation #3)", () => {
  const dir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const first = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-shared", grant_digest: "digest-1" },
      at: "t1",
    });
    const second = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-shared", grant_digest: "digest-2" },
      at: "t2",
    });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.duplicate, true);
    assert.equal(countClaimFiles(dir), 1);
  } finally {
    cleanup(dir);
  }
});

// [§6 mutation #4] "다른 state dir/inbox로 복사" 시뮬레이션: 호출자가
// armDir/inbox 같은 무관한 컨텍스트 값을 들고 있어도, claimIntentTx
// 시그니처엔 그 필드가 없다(오직 고정 intentDir만 본다) -- 그래서 같은
// intentDir(공통 intent root)을 넘기는 한 두 번째 소비는 막힌다.
test("claimIntentTx: grant 'copied' into a different state dir/inbox context, same fixed intent root -> total = 1 (mutation #4)", () => {
  const intentDir = freshDir();
  const inboxA = { stateDir: freshDir(), label: "inbox-a" };
  const inboxB = { stateDir: freshDir(), label: "inbox-b" };
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const claimFrom = (ctx, winnerId, at) =>
      // ctx(inboxA/B)는 claimIntentTx로 전혀 전달되지 않는다 -- intentDir만
      // 고정 신뢰 config에서 온다는 설계를 시그니처 수준에서 증명한다.
      claimIntentTx({
        intentDir,
        stableIntentId,
        winner: { jti: winnerId },
        at,
      });
    const first = claimFrom(inboxA, "jti-inbox-a", "t1");
    const second = claimFrom(inboxB, "jti-inbox-b", "t2");
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.duplicate, true);
    assert.equal(countClaimFiles(intentDir), 1);
  } finally {
    cleanup(intentDir);
    cleanup(inboxA.stateDir);
    cleanup(inboxB.stateDir);
  }
});

// [§6 mutation #5] "stable-intent commit 前 crash": saveStoreAtomic이 실제로
// 디스크에 쓰기 전에 실패하도록 writeFileFn을 주입 -- claim이 0이어야
// 하고(레코드 파일이 생기지 않아야 하고), 이후 정상 deps로 재시도(=복구 뒤
// 새 승자 선정)했을 때 정확히 1개만 claim되며, 그 뒤 세 번째(다른 winner)
// 시도는 여전히 duplicate로 막혀 전체 누적 claim이 1을 넘지 않는다.
test("claimIntentTx: crash before commit -> 0 claimed; recovery picks a new winner but total stays capped at 1 (mutation #5)", () => {
  const dir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());

    const crashed = claimIntentTx(
      {
        intentDir: dir,
        stableIntentId,
        winner: { jti: "jti-crashed" },
        at: "t0",
      },
      {
        writeFileFn: () => {
          throw new Error("injected disk failure before commit");
        },
      },
    );
    assert.equal(crashed.ok, false);
    assert.equal(crashed.claimed, false);
    assert.equal(
      countClaimFiles(dir),
      0,
      "no record must exist after a pre-commit crash",
    );

    const recovered = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-recovered-winner" },
      at: "t1",
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.claimed, true);
    assert.equal(countClaimFiles(dir), 1);

    const thirdAttempt = claimIntentTx({
      intentDir: dir,
      stableIntentId,
      winner: { jti: "jti-late-comer" },
      at: "t2",
    });
    assert.equal(thirdAttempt.claimed, false);
    assert.equal(thirdAttempt.duplicate, true);
    assert.equal(
      countClaimFiles(dir),
      1,
      "total claimed count must never exceed 1 even after recovery",
    );
  } finally {
    cleanup(dir);
  }
});

test("claimIntentTx: intentDir missing/empty -> fail-closed reject", () => {
  const stableIntentId = computeStableIntentId(makeStableIntentFields());
  for (const bad of [undefined, null, ""]) {
    const result = claimIntentTx({
      intentDir: bad,
      stableIntentId,
      winner: {},
      at: "t1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.claimed, false);
  }
});

test("claimIntentTx: stableIntentId missing/empty -> fail-closed reject (never throws)", () => {
  const dir = freshDir();
  try {
    for (const bad of [undefined, null, ""]) {
      assert.doesNotThrow(() => {
        const result = claimIntentTx({
          intentDir: dir,
          stableIntentId: bad,
          winner: {},
          at: "t1",
        });
        assert.equal(result.ok, false);
        assert.equal(result.claimed, false);
      });
    }
  } finally {
    cleanup(dir);
  }
});

test("claimIntentTx: existsFn throwing surfaces as a fail-closed error, does not create a record", () => {
  const dir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const result = claimIntentTx(
      { intentDir: dir, stableIntentId, winner: {}, at: "t1" },
      {
        existsFn: () => {
          throw new Error("injected existsFn failure");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.claimed, false);
    assert.match(result.reason, /existsFn threw/);
    assert.equal(countClaimFiles(dir), 0);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// [동시 2회] 실 barrier-synchronized worker_threads 경합(auth-grant-ledger.test.mjs
// G4-3 전례 재사용 -- claimInWorker 패턴 승계).
// ---------------------------------------------------------------------------
const MODULE_URL = new URL("./stable-intent.mjs", import.meta.url).href;

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

const CLAIM_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
${BARRIER_WAIT_SRC}
(async () => {
  try {
    const mod = await import(workerData.modulePath);
    barrierWait(workerData.barrierBuffer, workerData.barrierCount);
    const result = mod.claimIntentTx({
      intentDir: workerData.intentDir,
      stableIntentId: workerData.stableIntentId,
      winner: { jti: workerData.jti },
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

function claimInWorker(intentDir, stableIntentId, jti, at, barrierBuffer) {
  return runInWorker(CLAIM_WORKER_SRC, {
    modulePath: MODULE_URL,
    intentDir,
    stableIntentId,
    jti,
    at,
    barrierBuffer,
    barrierCount: 2,
  });
}

test("claimIntentTx: real barrier-synchronized concurrent claim race (two worker threads, same stable intent, different jti) -- exactly one wins", async () => {
  const dir = freshDir();
  try {
    const stableIntentId = computeStableIntentId(makeStableIntentFields());
    const barrierBuffer = new SharedArrayBuffer(4);
    const [a, b] = await Promise.all([
      claimInWorker(dir, stableIntentId, "jti-race-a", "t-race", barrierBuffer),
      claimInWorker(dir, stableIntentId, "jti-race-b", "t-race", barrierBuffer),
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
    assert.equal(countClaimFiles(dir), 1);
  } finally {
    cleanup(dir);
  }
});
