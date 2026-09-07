import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fork } from "node:child_process";
import {
  withLedgerLock,
  readLedgerUnlocked,
  STORE_REASON,
} from "./admission-ledger-store.mjs";
import {
  createEmptyLedger,
  admitReservation,
} from "./admission-ledger-core.mjs";

function tmpPaths() {
  const dir = mkdtempSync(join(tmpdir(), "admission-ledger-store-test-"));
  return {
    dir,
    ledger: join(dir, "ledger.json"),
    lock: join(dir, "ledger.lock"),
  };
}

test("readLedgerUnlocked fails closed with LEDGER_MISSING when the file does not exist (RED-c: not 0-active)", () => {
  const { dir, ledger } = tmpPaths();
  try {
    const result = readLedgerUnlocked(ledger);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, STORE_REASON.LEDGER_MISSING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readLedgerUnlocked fails closed with LEDGER_MALFORMED_JSON on corrupt content", () => {
  const { dir, ledger } = tmpPaths();
  try {
    writeFileSync(ledger, "{not json");
    const result = readLedgerUnlocked(ledger);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, STORE_REASON.LEDGER_MALFORMED_JSON);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock writes the ledger atomically (rename, no partial file left behind) and releases the lock", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    const outcome = withLedgerLock(ledger, lock, () => {
      return {
        result: { ok: true },
        nextLedger: createEmptyLedger("2026-08-11T00:00:00.000Z"),
      };
    });
    assert.equal(outcome.ok, true);
    assert.equal(existsSync(ledger), true);
    assert.equal(existsSync(lock), false);
    const read = readLedgerUnlocked(ledger);
    assert.equal(read.ok, true);
    assert.equal(read.ledger.epoch, "2026-08-11T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock passes the MISSING read result through to transition instead of hiding it (init-cutover needs to see this)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    let seenReasonCode = null;
    withLedgerLock(ledger, lock, (readResult) => {
      seenReasonCode = readResult.ok ? null : readResult.reasonCode;
      return { result: {}, nextLedger: null };
    });
    assert.equal(seenReasonCode, STORE_REASON.LEDGER_MISSING);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-224-3R §1 (REVIEW 2R 반려, 재현됨): 2R force-cleared a pid-less lock
// purely by mtime age -- that fallback was itself a TOCTOU hole (module
// header explains the exact mechanism). 한용 확정: "폴백 제거". This test
// replaces the old "reclaims a stale lock file" test (which asserted
// EXACTLY the behavior 3R removes) -- a pid-less lock, however old its
// mtime, is now NEVER auto-reclaimed; it fails closed with a DISTINCT
// reasonCode and a message naming the exact file + remedy (coder-task §1:
// "사람이 그 상황을 알아채고 풀 수 있는 경로").
// RED ⓔ: removing this fail-closed behavior (i.e. restoring the mtime
// fallback) flips this test red -- see admission-cli.test.mjs's RED-ⓔ
// mutation reproduction for the full round-trip proof.
test("HYK-224-3R §1: a pid-less lock is NEVER reclaimed, however old -- fails closed with an actionable manual-release message", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    writeFileSync(lock, ""); // pid-less content (legacy/corrupted shape)
    const past = new Date(Date.now() - 5000);
    utimesSync(lock, past, past); // far older than staleLockMs below
    const outcome = withLedgerLock(
      ledger,
      lock,
      () => ({
        result: { ok: true },
        nextLedger: createEmptyLedger("2026-08-11T00:00:00.000Z"),
      }),
      { lockTimeoutMs: 200, staleLockMs: 1000, pollMs: 10 },
    );
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.reasonCode,
      STORE_REASON.LOCK_PIDLESS_MANUAL_RELEASE_REQUIRED,
    );
    assert.match(
      outcome.detail,
      new RegExp(lock.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(outcome.detail, /delete it to release/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("withLedgerLock times out with the generic LOCK_TIMEOUT reason when the lock is held by a confirmed-ALIVE owner (this process's own pid)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    // A lock recording THIS test process's own (genuinely alive) pid --
    // distinguishes "ordinary contention against a live holder" from the
    // pid-less case above, which now gets a different reasonCode entirely.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }),
    );
    const outcome = withLedgerLock(
      ledger,
      lock,
      () => ({ result: { ok: true }, nextLedger: null }),
      { lockTimeoutMs: 100, staleLockMs: 60_000, pollMs: 10 },
    );
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, STORE_REASON.LOCK_TIMEOUT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transition that returns nextLedger:null never writes (BLOCKED decisions leave the ledger untouched)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    withLedgerLock(ledger, lock, () => ({
      result: {},
      nextLedger: createEmptyLedger("2026-08-11T00:00:00.000Z"),
    }));
    const before = readLedgerUnlocked(ledger).ledger;
    withLedgerLock(ledger, lock, (readResult) => {
      const admit = admitReservation(readResult.ledger, {
        reservationId: "r1",
        cap: 0,
        now: "2026-08-11T00:00:01.000Z",
      });
      return {
        result: { decision: admit.decision },
        nextLedger: admit.decision === "BLOCKED" ? null : admit.ledger,
      };
    });
    const after = readLedgerUnlocked(ledger).ledger;
    assert.deepEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// ★HYK-346 -- 원장 잠금 경합. ORCH 재현 프로브(v4)를 시험으로 옮긴 것.
//
// ⛔판별 방식은 «시각»이 아니라 «결과»다(v4 가 v3 에서 옮겨온 교훈):
//   각 자식이 임계구역 안에서 counter 를 읽고 +1 해서 쓴다.
//   상호배제가 지켜지면 «최종 counter == 임계구역 성공 수» 여야 한다.
//   최종값이 더 작으면 갱신이 덮여 사라진 것 = 상호배제 파탄(결과 증거).
//
// ⚠️★프로브 1판(폐기본)의 함정을 반복하지 않는다: 1판은 배리어 없이 fork
// 만 해서 자식들이 사실상 순차적으로 출발했고, 그래서 경합 자체가 생기지
// 않아 양성 대조가 발화하지 않았다. 여기서는 모든 자식이 ready 를 보고할
// 때까지 부모가 기다렸다가 한꺼번에 go 를 보낸다(★배리어).
// 그리고 음성 대조(n=8)를 함께 둔다 -- 그쪽이 0 이 나와야 «이 시험이 무조건
// 빨간 것»이 아님이 증명된다.
//
// ⛔격리: 픽스처는 전부 mkdtemp 안. 전역 원장/락 접촉 0.
// ===========================================================================

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REAL_STORE_URL = pathToFileURL(
  join(THIS_DIR, "admission-ledger-store.mjs"),
).href;

// 자식 프로세스 본문을 별도 파일로 만든다(이 파일 자신을 fork 하면
// node --test 러너가 재진입한다). storeUrl 을 바꾸면 «변이된 store» 로도
// 같은 파도를 돌릴 수 있다 -- 아래 변이 시험들이 그렇게 쓴다.
function writeChildScript(dir, storeUrl) {
  const p = join(dir, "child.mjs");
  writeFileSync(
    p,
    [
      "import { withLedgerLock } from " + JSON.stringify(storeUrl) + ";",
      "const [ledgerPath, lockPath, holdMs, timeoutMs] = process.argv.slice(2);",
      "process.send({ ready: true });",
      'await new Promise((res) => process.on("message", (m) => m && m.go && res()));',
      "let seen = null;",
      "const startedAt = Date.now();",
      "const r = withLedgerLock(",
      "  ledgerPath,",
      "  lockPath,",
      "  (read) => {",
      "    const led = read.ledger ?? { counter: 0 };",
      "    seen = led.counter ?? 0;",
      "    const until = Date.now() + Number(holdMs);",
      "    while (Date.now() < until) {}",
      "    return { result: { seen }, nextLedger: { ...led, counter: seen + 1 } };",
      "  },",
      "  { lockTimeoutMs: Number(timeoutMs) },",
      ");",
      "process.send({",
      "  done: true,",
      "  ok: r.ok,",
      "  reasonCode: r.reasonCode ?? null,",
      "  seen,",
      "  waitedMs: Date.now() - startedAt,",
      "});",
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
  return p;
}

async function runWave({
  dir,
  storeUrl,
  n,
  holdMs,
  timeoutMs = 10_000,
  seedDeadOwnerLock = false,
}) {
  const ledgerPath = join(dir, "ledger.json");
  const lockPath = join(dir, "ledger.lock");
  writeFileSync(ledgerPath, JSON.stringify({ counter: 0 }), "utf8");
  // ★HYK-346: 변이 시험을 «결정론적»으로 만들기 위한 씨앗. 잃어버린 갱신은
  // «죽은 소유자의 락» 이 존재해야 reclaim 갈래가 돌면서 생긴다. 그 전제를
  // 타이밍 운에 맡기면 시험이 들쎄날은다 -- 미리 깔아 둔다.
  if (seedDeadOwnerLock) {
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999_999,
        token: "seeded-dead-owner",
        acquired_at: new Date().toISOString(),
      }),
      "utf8",
    );
  }
  const child = writeChildScript(dir, storeUrl);
  const kids = [];
  const readyP = [];
  const doneP = [];
  const results = [];
  for (let i = 0; i < n; i += 1) {
    const c = fork(
      child,
      [ledgerPath, lockPath, String(holdMs), String(timeoutMs)],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    kids.push(c);
    readyP.push(new Promise((res) => c.once("message", res)));
    doneP.push(
      new Promise((res) =>
        c.on("message", (m) => {
          if (m && m.done) {
            results.push(m);
            res();
          }
        }),
      ),
    );
  }
  await Promise.all(readyP); // ★배리어: 전원이 준비될 때까지 아무도 출발 안 함
  for (const c of kids) c.send({ go: true });
  await Promise.all(doneP);
  const finalCounter = JSON.parse(readFileSync(ledgerPath, "utf8")).counter;
  const okRs = results.filter((r) => r.ok);
  const seenCounts = {};
  for (const r of okRs) seenCounts[r.seen] = (seenCounts[r.seen] ?? 0) + 1;
  return {
    results,
    okCount: okRs.length,
    finalCounter,
    lostUpdates: okRs.length - finalCounter,
    duplicateSeen: Object.entries(seenCounts).filter(([, c]) => c > 1),
  };
}

// 변이 store 를 임시 폴더에 만든다. 실 소스를 문자열 치환한 «복사본»이며
// ⛔실 파일은 건드리지 않는다. 형제 모듈 import 가 깨지지 않도록 상대
// 지정자를 실제 폴더의 절대 file:// URL 로 고쳐 쓴다.
function writeMutatedStore(dir, find, replacement) {
  const src = readFileSync(
    join(THIS_DIR, "admission-ledger-store.mjs"),
    "utf8",
  );
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target must appear exactly once in the real source, got ${count}`,
  );
  const dirUrl = pathToFileURL(THIS_DIR + "/").href;
  const mutated = src
    .replace(find, replacement)
    .split('from "./')
    .join('from "' + dirUrl)
    .split('from "../')
    .join('from "' + dirUrl + "../");
  const p = join(dir, "mutant-store.mjs");
  writeFileSync(p, mutated, "utf8");
  return pathToFileURL(p).href;
}

test("★HYK-346 ⑴ 음성 대조 -- 낮은 부하(n=8, hold=50ms)에서는 잃어버린 갱신이 0 이다(이 시험이 무조건 빨간 것이 아님을 먼저 증명한다)", async () => {
  const { dir } = tmpPaths();
  try {
    const w = await runWave({
      dir,
      storeUrl: REAL_STORE_URL,
      n: 8,
      holdMs: 50,
    });
    assert.equal(w.lostUpdates, 0, JSON.stringify(w.duplicateSeen));
    assert.deepEqual(w.duplicateSeen, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346 ⑵ 상호배제 -- 중부하(n=24, hold=300ms)에서 잃어버린 갱신 0 · 같은 값을 읽은 프로세스 0 (수리 전 같은 부하에서 8~15건이 사라졌다)", async () => {
  const { dir } = tmpPaths();
  try {
    const w = await runWave({
      dir,
      storeUrl: REAL_STORE_URL,
      n: 24,
      holdMs: 300,
    });
    assert.equal(w.lostUpdates, 0, JSON.stringify(w.duplicateSeen));
    assert.deepEqual(w.duplicateSeen, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346 변이 ① -- reclaim 의 «토큰 재확인»을 빼면 RED (죽은 소유자를 근거로 판정한 뒤 살아 있는 락을 지워 잃어버린 갱신이 되살아난다)", async () => {
  const { dir } = tmpPaths();
  try {
    const mutantUrl = writeMutatedStore(
      dir,
      "      if (lockFileStillHasToken(lockPath, owner.token)) {",
      "      if (true) {",
    );
    const w = await runWave({
      dir,
      storeUrl: mutantUrl,
      n: 24,
      holdMs: 300,
      seedDeadOwnerLock: true,
    });
    assert.ok(
      w.lostUpdates > 0 || w.duplicateSeen.length > 0,
      `mutant must lose updates (RED signal). got ${JSON.stringify({
        lostUpdates: w.lostUpdates,
        duplicateSeen: w.duplicateSeen,
        okCount: w.okCount,
      })}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★HYK-346 확정 B -- «기다린 적 없는 시간초과».
// `EEXIST` 가 아닌 OS 오류를 만나면 예전 코드는 재시도 없이 즉시
// `LOCK_TIMEOUT` 을 돌려줬다(실측: 한도 10000ms 인데 635ms 에 발화).
// ⛔양방향으로 고정한다: 그런 오류는 «시간초과»로 불리면 안 되고, 진짜로
// 남이 쥐고 있어서 한도가 다한 경우는 여전히 `LOCK_TIMEOUT` 이어야 한다.
//
// 결정론적으로 «EEXIST 아닌 오류»를 만드는 방법: 존재하지 않는 폴더 밑의
// 락 경로를 준다 -> `openSync(...,"wx")` 가 ENOENT 로 실패한다(EEXIST 아님).
// ---------------------------------------------------------------------------

test("★★HYK-346 ⑶ EEXIST 가 아닌 오류는 «시간초과»로 보고되지 않는다 -- 구별되는 LOCK_OS_CONTENTION 이고, 한도를 실제로 기다린다", () => {
  const { dir } = tmpPaths();
  try {
    const ledger = join(dir, "ledger.json");
    writeFileSync(ledger, JSON.stringify(createEmptyLedger("2026-01-01")));
    // 부모 폴더가 없는 락 경로 -> wx 가 ENOENT(=EEXIST 아님)로 실패한다.
    const lock = join(dir, "no-such-dir", "ledger.lock");
    const startedAt = Date.now();
    const res = withLedgerLock(ledger, lock, () => ({ result: 1 }), {
      lockTimeoutMs: 300,
      pollMs: 25,
    });
    const waitedMs = Date.now() - startedAt;
    assert.equal(res.ok, false);
    assert.equal(
      res.reasonCode,
      STORE_REASON.LOCK_OS_CONTENTION,
      "EEXIST 아닌 오류를 LOCK_TIMEOUT 으로 부르면 안 된다",
    );
    assert.notEqual(res.reasonCode, STORE_REASON.LOCK_TIMEOUT);
    assert.ok(
      waitedMs >= 250,
      `한도(300ms)를 실제로 기다려야 한다 -- 실측 ${waitedMs}ms (수리 전에는 0ms 에 즉시 반환했다)`,
    );
    assert.match(res.detail, /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★HYK-346 ⑶-대조 진짜 시간초과는 여전히 LOCK_TIMEOUT 이다(살아 있는 소유자가 쥐고 있을 때)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    writeFileSync(ledger, JSON.stringify(createEmptyLedger("2026-01-01")));
    // 이 프로세스 자신의 pid = 확실히 살아 있는 소유자 -> 회수 금지 대상.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        token: "held-by-a-live-owner",
        acquired_at: new Date().toISOString(),
      }),
    );
    const res = withLedgerLock(ledger, lock, () => ({ result: 1 }), {
      lockTimeoutMs: 120,
      pollMs: 20,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reasonCode, STORE_REASON.LOCK_TIMEOUT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★HYK-346 «영구 누수 없음» 회귀 -- 소유자 pid 가 확실히 죽었으면 락은 여전히 즉시 회수된다(수리가 회수 자체를 막지 않았다)", () => {
  const { dir, ledger, lock } = tmpPaths();
  try {
    writeFileSync(ledger, JSON.stringify(createEmptyLedger("2026-01-01")));
    // 존재하지 않는 pid(=죽음) + 토큰이 있는 락 파일.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: 999_999_999,
        token: "dead-owner-token",
        acquired_at: new Date().toISOString(),
      }),
    );
    const res = withLedgerLock(ledger, lock, () => ({ result: "acquired" }), {
      lockTimeoutMs: 500,
      pollMs: 20,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.result, "acquired");
    assert.equal(existsSync(lock), false, "해제까지 정상적으로 끝나야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346 변이 ② -- 「EEXIST 아닌 오류 = 경합」 을 되돌리면 RED (즉시 LOCK_TIMEOUT 으로 새어 «기다린 적 없는 시간초과» 가 부활한다)", async () => {
  const { dir } = tmpPaths();
  try {
    const mutantUrl = writeMutatedStore(
      dir,
      "    if (claimed.transient) lastTransient = claimed;",
      "    if (claimed.transient)\n      return {\n        ok: false,\n        reasonCode: STORE_REASON.LOCK_TIMEOUT,\n        detail: claimed.detail,\n      };",
    );
    const mod = await import(mutantUrl);
    const ledger = join(dir, "ledger.json");
    writeFileSync(ledger, JSON.stringify(createEmptyLedger("2026-01-01")));
    const lock = join(dir, "no-such-dir", "ledger.lock");
    const startedAt = Date.now();
    const res = mod.withLedgerLock(ledger, lock, () => ({ result: 1 }), {
      lockTimeoutMs: 400,
      pollMs: 25,
    });
    const waitedMs = Date.now() - startedAt;
    assert.equal(
      res.reasonCode,
      STORE_REASON.LOCK_TIMEOUT,
      "mutant must mislabel a non-EEXIST error as a timeout (RED signal)",
    );
    assert.ok(
      waitedMs < 200,
      `mutant must NOT have waited the limit -- got ${waitedMs}ms (that is the "timeout that never waited")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346 변이 ③ -- 락 내용의 token 을 빼면 RED (죽은 소유자의 락을 더 이상 회수하지 못해 원장이 영구히 막힌다)", async () => {
  const { dir } = tmpPaths();
  try {
    // 획득 시 token 을 안 적는다 = 회수 직전 재확인이 영원히 실패한다.
    const mutantUrl = writeMutatedStore(
      dir,
      "        pid: process.pid,\n        token,\n        acquired_at: new Date().toISOString(),",
      "        pid: process.pid,\n        acquired_at: new Date().toISOString(),",
    );
    const mod = await import(mutantUrl);
    const ledger = join(dir, "ledger.json");
    writeFileSync(ledger, JSON.stringify(createEmptyLedger("2026-01-01")));
    const lock = join(dir, "ledger.lock");
    // 죽은 소유자 + token 없음(변이된 store 가 만들었을 모양 그대로).
    writeFileSync(
      lock,
      JSON.stringify({
        pid: 999_999_999,
        acquired_at: new Date().toISOString(),
      }),
    );
    const res = mod.withLedgerLock(ledger, lock, () => ({ result: "x" }), {
      lockTimeoutMs: 250,
      pollMs: 20,
    });
    assert.equal(
      res.ok,
      false,
      "mutant must fail to reclaim a dead owner's lock (RED signal: the no-permanent-leak property is what the token preserves)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
