import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
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
// HYK-359 ambient-env regression (coder-task.md §2): the child probes this
// file forks below took ledgerPath/lockPath via argv but no explicit `env`
// option, so they silently inherited a floating ADMISSION_LEDGER_PATH/
// ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH from the invoking shell.
// admission-ledger-store.mjs/admission-ledger-core.mjs never read those
// three keys from process.env (grepped -- zero hits), so the child does
// not need any of them re-set explicitly; isolatedChildEnv() (strip-only,
// no isolatedChildEnvWithLedger) is the correct choice here.
import { isolatedChildEnv } from "../check/admission-ledger-env-isolation.mjs";

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
  env: extraEnv = {},
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
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: isolatedChildEnv(extraEnv),
      },
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

// ===========================================================================
// ★HYK-463 -- HYK-346 ①의 대조 경합을 «부하»가 아니라 «IPC 체크포인트»로
// 결정적으로 만든다. CI 실증(PR #271 attempt 3): n=24 난사에서
// {lostUpdates:0,duplicateSeen:[],okCount:24} -- 24개 전원 성공, 즉 경합
// 자체가 한 번도 안 일어났다(CPU 기아로 사실상 직렬 실행됨). 난사로 «경합이
// 일어나길 기다리는» 구조 대신, 자식 2개를 정확한 교차 지점(reclaim 판정
// 직후)까지 파일 기반 체크포인트로 몰아 놓고 부모가 순서를 강제한다.
//
// 기전(admission-ledger-store.mjs § HYK-346 헤더 실측 기록과 동일):
//   자식A, 자식B 모두 «죽은 소유자» 락(씨앗)을 보고 회수를 결정한다
//   (owner 스냅샷은 아직 둘 다 그 죽은 락 그대로) -> A 를 먼저 풀어준다 ->
//   A 가 unlink+wx 로 「살아 있는」 새 락을 얻어 임계구역에 들어간다(CP2
//   도달로 확인) -> 그제서야 B 를 풀어준다 -> ⛔변이(토큰 재확인 제거)는
//   B 가 «자기가 봤던 죽은 락 스냅샷»만 근거로 A 의 «살아 있는» 락을
//   무조건 지운다 -> 둘 다 같은 seen 을 읽고 동시에 임계구역 -> 갱신 유실.
//   정상 구현은 B 가 지우기 직전 토큰을 다시 확인해 「지금 이 파일은
//   내가 봤던 그 죽은 락이 아니다」를 보고 지우지 않는다 -> B 는 정상
//   대기열로 돌아가 A 가 끝난 뒤에야 잡는다 -> 갱신 유실 0.
//
// ⛔격리: 체크포인트 훅은 `HYK463_CKPT_DIR` 환경변수가 있을 때만 동작한다
// (기본 없음 = no-op). 실 파일(admission-ledger-store.mjs) 은 건드리지
// 않는다 -- 매번 mkdtemp 안 사본에만 문자열 삽입한다(기존 writeMutatedStore
// 와 같은 원칙).
// ===========================================================================

// writeRaceFixtureStore -- admission-ledger-store.mjs 의 사본을 만들되,
// (선택) 변이 치환을 적용하고, «reclaim 판정 직후» 지점에 항상 체크포인트
// 훅을 심는다. 훅은 HYK463_CKPT_DIR 이 안 잡혀 있으면 즉시 반환(no-op) --
// 그래서 기존 24개 wave 시험(§HYK-346 ⑴⑵)에는 아무 영향이 없다.
function writeRaceFixtureStore(
  dir,
  filename,
  { mutationFind, mutationReplace } = {},
) {
  let src = readFileSync(join(THIS_DIR, "admission-ledger-store.mjs"), "utf8");
  if (mutationFind !== undefined) {
    const count = src.split(mutationFind).length - 1;
    assert.equal(
      count,
      1,
      `mutation target must appear exactly once in the real source, got ${count}`,
    );
    src = src.split(mutationFind).join(mutationReplace);
  }
  const anchor = "    if (shouldReclaim(owner)) {";
  const anchorCount = src.split(anchor).length - 1;
  assert.equal(
    anchorCount,
    1,
    `checkpoint anchor must appear exactly once, got ${anchorCount}`,
  );
  src = src
    .split(anchor)
    .join(`${anchor}\n      __HYK463_reclaimCheckpoint__(lockPath, owner);`);
  src = src.replace(
    'import { dirname } from "node:path";',
    'import { dirname, join } from "node:path";',
  );
  src = src.replace(
    '  mkdirSync,\n} from "node:fs";',
    '  mkdirSync,\n  existsSync,\n  appendFileSync,\n} from "node:fs";',
  );
  src +=
    "\n\n" +
    [
      "// HYK-463: test-only instrumentation, no-op for every real caller",
      "// (dispatch-worker.ps1 never sets either env var). Two independent",
      "// gates behind two different env vars so the deterministic crossover",
      "// harness and the probabilistic wave harness can each opt in alone.",
      "function __HYK463_reclaimCheckpoint__(lockPath, owner) {",
      "  const logPath = process.env.HYK463_RECLAIM_LOG;",
      "  if (logPath) {",
      "    try { appendFileSync(logPath, `${process.pid}\\n`); } catch {}",
      "  }",
      "  const ckptDir = process.env.HYK463_CKPT_DIR;",
      "  if (!ckptDir) return;",
      "  writeFileSync(join(ckptDir, `reclaim-ready-${process.pid}.txt`), String(Date.now()));",
      "  const goFile = join(ckptDir, `reclaim-go-${process.pid}.txt`);",
      "  while (!existsSync(goFile)) {",
      "    // synchronous busy-poll -- this module's public API is",
      "    // deliberately synchronous (see sleepSync above), so a test",
      "    // checkpoint pause must be too (an async IPC wait would never",
      "    // be observed while this call stack is still running).",
      "  }",
      "}",
      "",
    ].join("\n");
  const dirUrl = pathToFileURL(THIS_DIR + "/").href;
  src = src
    .split('from "./')
    .join('from "' + dirUrl)
    .split('from "../')
    .join('from "' + dirUrl + "../");
  const p = join(dir, filename);
  writeFileSync(p, src, "utf8");
  return pathToFileURL(p).href;
}

// writeCrossoverChildScript -- like writeChildScript, but reports reaching
// the in-critical-section point (CP2) via a marker file so the parent can
// tell WHEN this child actually holds the (fresh) lock, instead of guessing
// from wall-clock time.
function writeCrossoverChildScript(dir, storeUrl) {
  const p = join(dir, "child-crossover.mjs");
  writeFileSync(
    p,
    [
      "import { withLedgerLock } from " + JSON.stringify(storeUrl) + ";",
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "const [ledgerPath, lockPath, holdMs, timeoutMs] = process.argv.slice(2);",
      "const ckptDir = process.env.HYK463_CKPT_DIR;",
      "process.send({ ready: true });",
      'await new Promise((res) => process.on("message", (m) => m && m.go && res()));',
      "let seen = null;",
      "const r = withLedgerLock(",
      "  ledgerPath,",
      "  lockPath,",
      "  (read) => {",
      "    const led = read.ledger ?? { counter: 0 };",
      "    seen = led.counter ?? 0;",
      "    if (ckptDir) {",
      "      writeFileSync(join(ckptDir, `cs-ready-${process.pid}.txt`), String(Date.now()));",
      "    }",
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
      "});",
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
  return p;
}

async function waitForFiles(paths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (paths.every((p) => existsSync(p))) return;
    if (Date.now() > deadline) {
      throw new Error(
        `checkpoint files not observed in time: ${paths.join(", ")}`,
      );
    }
    await new Promise((res) => setTimeout(res, 10));
  }
}

// runCrossoverRace -- the deterministic replacement for "throw 24 processes
// at it and hope". Exactly 2 children, herded via file-checkpoints to the
// EXACT crossing point HYK-346's header names (a reclaim decision racing a
// fresh live acquire), released in a controlled order so the interleaving
// happens every time, independent of CPU load.
async function runCrossoverRace({
  dir,
  storeUrl,
  holdMs = 300,
  timeoutMs = 5000,
}) {
  const ledgerPath = join(dir, "ledger.json");
  const lockPath = join(dir, "ledger.lock");
  const ckptDir = join(dir, "ckpt");
  mkdirSync(ckptDir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ counter: 0 }), "utf8");
  // ★HYK-346 씨앗: 죽은 소유자의 락. 두 자식 모두 이걸 보고 회수를 결정한다.
  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: 999_999_999,
      token: "seeded-dead-owner",
      acquired_at: new Date().toISOString(),
    }),
    "utf8",
  );
  const child = writeCrossoverChildScript(dir, storeUrl);
  const env = { ...isolatedChildEnv(), HYK463_CKPT_DIR: ckptDir };
  const kids = [];
  const readyP = [];
  const doneP = [];
  const results = [];
  for (let i = 0; i < 2; i += 1) {
    const c = fork(
      child,
      [ledgerPath, lockPath, String(holdMs), String(timeoutMs)],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env,
      },
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
  await Promise.all(readyP); // 배리어: 둘 다 준비될 때까지 출발 안 함
  for (const c of kids) c.send({ go: true });
  // ★교차 지점으로 몰기: 둘 다 「죽은 소유자」 스냅샷을 보고 회수를 결정한
  // 시점(reclaim 체크포인트)까지 기다린다 -- 아직 아무도 지우지 않았다.
  await waitForFiles(
    kids.map((c) => join(ckptDir, `reclaim-ready-${c.pid}.txt`)),
    timeoutMs,
  );
  const [a, b] = kids;
  // A 를 먼저 풀어준다: unlink+wx 로 「살아 있는」 새 락을 얻고 임계구역으로.
  writeFileSync(join(ckptDir, `reclaim-go-${a.pid}.txt`), "go");
  await waitForFiles([join(ckptDir, `cs-ready-${a.pid}.txt`)], timeoutMs);
  // A 가 임계구역 안(=새 락이 파일에 기록된 뒤)임을 확인한 뒤에만 B 를 푼다.
  writeFileSync(join(ckptDir, `reclaim-go-${b.pid}.txt`), "go");
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

// HYK-463 §2-A: 결정적 교차 재현. 부하(24 난사) 없이, IPC 체크포인트로
// 정확한 교차 지점을 강제한다 -- «부하와 무관하게 난다»는 완료조건 1의
// 증거는 이 시험이다(3회 연속).
for (let attempt = 1; attempt <= 3; attempt += 1) {
  test(`★★★HYK-463 결정적 교차 재현 #${attempt} -- 변이 ① 은 부하와 무관하게 RED (2개 자식을 reclaim 판정 직후까지 몰아 A 를 먼저 임계구역에 넣은 뒤 B 를 푼다)`, async () => {
    const { dir } = tmpPaths();
    try {
      const mutantUrl = writeRaceFixtureStore(
        dir,
        "mutant-crossover-store.mjs",
        {
          mutationFind:
            "      if (lockFileStillHasToken(lockPath, owner.token)) {",
          mutationReplace: "      if (true) {",
        },
      );
      const w = await runCrossoverRace({
        dir,
        storeUrl: mutantUrl,
        holdMs: 300,
      });
      assert.ok(
        w.lostUpdates > 0 || w.duplicateSeen.length > 0,
        `mutant must lose updates (RED signal), deterministically -- not a load artifact. got ${JSON.stringify(
          {
            lostUpdates: w.lostUpdates,
            duplicateSeen: w.duplicateSeen,
            okCount: w.okCount,
          },
        )}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// HYK-463 §3 완료조건 2 (L-7 반대 방향): 같은 결정적 교차를 정상 구현으로
// 돌리면 GREEN 이어야 한다 -- 이 시험이 「항상 빨간 시험」이 아님을 보인다.
// 정상 코드는 B 가 지우기 직전 토큰을 다시 확인해 A 의 살아 있는 락을 보고
// 지우지 않는다 -- B 는 정상 대기열로 돌아가 A 가 끝난 뒤에야 잡는다.
test("★★★HYK-463 결정적 교차 -- 정상 구현(무변이)은 같은 교차 지점에서 GREEN 이다", async () => {
  const { dir } = tmpPaths();
  try {
    const realUrl = writeRaceFixtureStore(dir, "real-crossover-store.mjs");
    const w = await runCrossoverRace({
      dir,
      storeUrl: realUrl,
      holdMs: 200,
      timeoutMs: 5000,
    });
    assert.equal(w.lostUpdates, 0, JSON.stringify(w));
    assert.deepEqual(w.duplicateSeen, []);
    assert.equal(w.okCount, 2, "both children must still eventually succeed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HYK-463 §2-B/§2-C: «경합이 실제로 일어났는가»를 판정과 분리한다. 24개
// 난사(원래 §HYK-346 변이① 시험)는 부하 민감이라 CPU 기아 아래서는 경합
// 자체가 안 일어날 수 있다(CI 실증: okCount:24, lostUpdates:0). 그 경우
// ⛔「변이 미검출」과 같은 문장으로 실패하면 안 된다 -- reclaim 시도 횟수
// (HYK463_RECLAIM_LOG 로 실측)와 타임아웃 등 reasonCode 를 축으로 두 상황을
// 구별하고, 몇 차례 재시도해도 경합이 안 잡히면 「측정 불능」이라고 명시적
// 으로, 다른 문장으로 실패한다(조용히 통과시키지 않는다 -- L-7).
test("★★HYK-346 변이 ① (부하 난사, 24개) -- 경합이 실제로 관측될 때만 RED 로 판정하고, 경합 0 이면 «측정 불능»으로 별개 실패를 낸다", async () => {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const { dir } = tmpPaths();
    const reclaimLog = join(dir, "reclaim-attempts.log");
    try {
      writeFileSync(reclaimLog, "", "utf8");
      const mutantUrl = writeRaceFixtureStore(dir, "mutant-wave-store.mjs", {
        mutationFind:
          "      if (lockFileStillHasToken(lockPath, owner.token)) {",
        mutationReplace: "      if (true) {",
      });
      const w = await runWave({
        dir,
        storeUrl: mutantUrl,
        n: 24,
        holdMs: 300,
        seedDeadOwnerLock: true,
        env: { HYK463_RECLAIM_LOG: reclaimLog },
      });
      const reclaimAttempts = readFileSync(reclaimLog, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0).length;
      // ★HYK-463 §2-C: 잔여 축. LOCK_TIMEOUT 등 ok:false 가 섞여 있으면
      // 이번 실패 원인은 아니어도(§1-1) 측정을 흐린다 -- 측정 불능 쪽으로.
      const anyMeasurementNoise = w.results.some((r) => r.ok === false);
      const contentionObserved = reclaimAttempts >= 2 && !anyMeasurementNoise;
      if (!contentionObserved) {
        if (attempt < MAX_ATTEMPTS) continue; // 재시도 -- 조용히 넘기지 않는다
        assert.fail(
          `측정 불능(MEASUREMENT_INCONCLUSIVE): ${MAX_ATTEMPTS}회 재시도에도 경합이 관측되지 않았다 ` +
            `(reclaim 시도=${reclaimAttempts}, ok:false 존재=${anyMeasurementNoise}) -- ` +
            `이것은 «변이 미검출»이 아니라 «이번 실행에서 부하가 경합을 못 만들었다»는 뜻이다. ` +
            `결정적 증거는 별도의 «HYK-463 결정적 교차 재현» 시험을 보라.`,
        );
      }
      assert.ok(
        w.lostUpdates > 0 || w.duplicateSeen.length > 0,
        `contention WAS observed (reclaim attempts=${reclaimAttempts}) but the mutant still did not lose updates -- this IS a real mutation-not-detected RED signal, distinct from measurement-inconclusive. got ${JSON.stringify(
          {
            lostUpdates: w.lostUpdates,
            duplicateSeen: w.duplicateSeen,
            okCount: w.okCount,
          },
        )}`,
      );
      return; // 관측 성공 + 판정 완료
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
