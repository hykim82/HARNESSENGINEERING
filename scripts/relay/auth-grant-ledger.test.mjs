import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { claimJtiTx, ledgerRecordId } from "./auth-grant-ledger.mjs";

// M1: 실 grant/실 arm 경로 미참조 -- 전부 mkdtempSync 임시 디렉터리 + 합성 문자열.

function freshDir() {
  return mkdtempSync(join(tmpdir(), "auth-grant-ledger-test-"));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

const KEY_ID = "k-good";
const JTI = "jti-fixed-1";
const GRANT_DIGEST = "digest-abc123";

test("ledgerRecordId: same triple -> same id; any single element changed -> different id", () => {
  const a = ledgerRecordId(KEY_ID, JTI, GRANT_DIGEST);
  const b = ledgerRecordId(KEY_ID, JTI, GRANT_DIGEST);
  assert.equal(a, b);
  assert.notEqual(a, ledgerRecordId("k-other", JTI, GRANT_DIGEST));
  assert.notEqual(a, ledgerRecordId(KEY_ID, "jti-other", GRANT_DIGEST));
  assert.notEqual(a, ledgerRecordId(KEY_ID, JTI, "digest-other"));
});

test("ledgerRecordId: rejects non-string/empty inputs (fail-closed, throws TypeError)", () => {
  for (const bad of [null, undefined, "", 42]) {
    assert.throws(() => ledgerRecordId(bad, JTI, GRANT_DIGEST), TypeError);
    assert.throws(() => ledgerRecordId(KEY_ID, bad, GRANT_DIGEST), TypeError);
    assert.throws(() => ledgerRecordId(KEY_ID, JTI, bad), TypeError);
  }
});

test("claimJtiTx: known-good first claim succeeds, writes a record", () => {
  const dir = freshDir();
  try {
    const result = claimJtiTx({
      ledgerDir: dir,
      keyId: KEY_ID,
      jti: JTI,
      grantDigest: GRANT_DIGEST,
      at: "t1",
    });
    assert.equal(result.ok, true);
    assert.equal(result.claimed, true);
    assert.equal(existsSync(result.path), true);
    const onDisk = JSON.parse(readFileSync(result.path, "utf8"));
    assert.equal(onDisk.key_id, KEY_ID);
    assert.equal(onDisk.jti, JTI);
    assert.equal(onDisk.grant_digest, GRANT_DIGEST);
  } finally {
    cleanup(dir);
  }
});

// [순차 2회] C2-2/G5 반증: 같은 (key_id, jti, grant_digest)의 두 번째 시도는
// 반드시 거부된다.
test("claimJtiTx: sequential second claim of the same (key_id,jti,grant_digest) -> duplicate, no re-write", () => {
  const dir = freshDir();
  try {
    const first = claimJtiTx({
      ledgerDir: dir,
      keyId: KEY_ID,
      jti: JTI,
      grantDigest: GRANT_DIGEST,
      at: "t1",
    });
    assert.equal(first.ok, true);

    const second = claimJtiTx({
      ledgerDir: dir,
      keyId: KEY_ID,
      jti: JTI,
      grantDigest: GRANT_DIGEST,
      at: "t2",
    });
    assert.equal(second.ok, false);
    assert.equal(second.claimed, false);
    assert.equal(second.duplicate, true);

    // 원 레코드가 t2로 덮어써지지 않았는지(재작성 0) 확인.
    const onDisk = JSON.parse(readFileSync(first.path, "utf8"));
    assert.equal(onDisk.claimed_at, "t1");
  } finally {
    cleanup(dir);
  }
});

// [다른 jti/다른 digest는 독립] 예산이 jti별로 분리되는지(다른 jti는 별개
// 레코드이자 별개 claim으로 허용됨) 확인 -- exactly-once가 "전역 1회"가 아니라
// "이 composite key당 1회"임을 명확히 한다.
test("claimJtiTx: a different jti under the same key_id is an independent claim (not globally exhausted)", () => {
  const dir = freshDir();
  try {
    const first = claimJtiTx({
      ledgerDir: dir,
      keyId: KEY_ID,
      jti: "jti-a",
      grantDigest: GRANT_DIGEST,
      at: "t1",
    });
    const second = claimJtiTx({
      ledgerDir: dir,
      keyId: KEY_ID,
      jti: "jti-b",
      grantDigest: GRANT_DIGEST,
      at: "t2",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
  } finally {
    cleanup(dir);
  }
});

// [경로 복사 방어] "다른 arm dir로 복사해도 두 번 소비 불가" -- ledgerDir(고정
// 단일 state root)은 armDir/arm_id 같은 실행 lifecycle 경로와 무관한 별도
// 트러스트 config다. 이 함수 시그니처엔 armDir이 아예 없다 -- 즉 호출자가
// 어떤 armDir/arm_id를 쓰든(혹은 grant를 다른 디렉터리에 복사해 재발사를
// 시도하든) 원장 판정은 오직 (ledgerDir, key_id, jti, grant_digest)에만
// 의존한다. 두 개의 "다른 arm 컨텍스트"를 시뮬레이션해도 같은 ledgerDir을
// 넘기면 두 번째는 거부된다.
test("claimJtiTx: grant 'copied' into a different arm context still hits the same fixed ledger root -> second consumption blocked", () => {
  const ledgerDir = freshDir();
  const armContextA = { armDir: freshDir(), armId: "arm-a" };
  const armContextB = { armDir: freshDir(), armId: "arm-b" }; // 공격자가 다른 arm dir로 grant를 복사했다고 가정
  try {
    const claimFromContext = (ctx, at) =>
      // armContextX는 claimJtiTx에 전혀 전달되지 않는다 -- ledgerDir만 고정
      // 신뢰 config에서 온다는 설계를 시그니처 수준에서 증명한다.
      claimJtiTx({
        ledgerDir,
        keyId: KEY_ID,
        jti: JTI,
        grantDigest: GRANT_DIGEST,
        at,
      });
    const first = claimFromContext(armContextA, "t1");
    const second = claimFromContext(armContextB, "t2");
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.duplicate, true);
  } finally {
    cleanup(ledgerDir);
    cleanup(armContextA.armDir);
    cleanup(armContextB.armDir);
  }
});

test("claimJtiTx: ledgerDir missing/empty -> fail-closed reject", () => {
  for (const bad of [undefined, null, ""]) {
    const result = claimJtiTx({
      ledgerDir: bad,
      keyId: KEY_ID,
      jti: JTI,
      grantDigest: GRANT_DIGEST,
      at: "t1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.claimed, false);
  }
});

test("claimJtiTx: keyId/jti/grantDigest missing -> fail-closed reject (never throws)", () => {
  for (const field of ["keyId", "jti", "grantDigest"]) {
    const input = {
      ledgerDir: freshDir(),
      keyId: KEY_ID,
      jti: JTI,
      grantDigest: GRANT_DIGEST,
      at: "t1",
    };
    delete input[field];
    assert.doesNotThrow(() => {
      const result = claimJtiTx(input);
      assert.equal(result.ok, false);
      assert.equal(result.claimed, false);
    });
    cleanup(input.ledgerDir);
  }
});

test("claimJtiTx: existsFn throwing surfaces as a fail-closed error, does not create a record", () => {
  const dir = freshDir();
  try {
    const result = claimJtiTx(
      {
        ledgerDir: dir,
        keyId: KEY_ID,
        jti: JTI,
        grantDigest: GRANT_DIGEST,
        at: "t1",
      },
      {
        existsFn: () => {
          throw new Error("injected existsFn failure");
        },
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.claimed, false);
    assert.match(result.reason, /existsFn threw/);
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// [동시 2회] C2-2/G5 반증: 실제 barrier-synchronized worker_threads 경합(arm-state
// G4-3의 전례를 그대로 재사용 -- claimInWorker 패턴 승계, JS 단일스레드 스케줄링
// 우연이 아니라 실제 node:fs O_EXCL 경합으로 판가름나게 한다).
// ---------------------------------------------------------------------------
const LEDGER_MODULE_URL = new URL("./auth-grant-ledger.mjs", import.meta.url)
  .href;

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
    const result = mod.claimJtiTx({
      ledgerDir: workerData.ledgerDir,
      keyId: workerData.keyId,
      jti: workerData.jti,
      grantDigest: workerData.grantDigest,
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

function claimInWorker(ledgerDir, keyId, jti, grantDigest, at, barrierBuffer) {
  return runInWorker(CLAIM_WORKER_SRC, {
    modulePath: LEDGER_MODULE_URL,
    ledgerDir,
    keyId,
    jti,
    grantDigest,
    at,
    barrierBuffer,
    barrierCount: 2,
  });
}

test("claimJtiTx: real barrier-synchronized concurrent claim race (two worker threads, same composite key) -- exactly one wins", async () => {
  const dir = freshDir();
  try {
    const barrierBuffer = new SharedArrayBuffer(4);
    const [a, b] = await Promise.all([
      claimInWorker(
        dir,
        KEY_ID,
        "jti-race",
        GRANT_DIGEST,
        "t-race",
        barrierBuffer,
      ),
      claimInWorker(
        dir,
        KEY_ID,
        "jti-race",
        GRANT_DIGEST,
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
    cleanup(dir);
  }
});
