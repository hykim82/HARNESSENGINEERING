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

// replaceAnchorOnce -- string-surgery helper shared by writeRaceFixtureStore
// and writeMutatedStore's spirit: asserts `anchor` appears exactly once (so
// a future edit to admission-ledger-store.mjs that moves/removes it fails
// loudly here instead of silently no-op'ing the instrumentation) and splices
// `replacement` in its place.
function replaceAnchorOnce(src, anchor, replacement, label) {
  const count = src.split(anchor).length - 1;
  assert.equal(
    count,
    1,
    `${label} anchor must appear exactly once, got ${count}`,
  );
  return src.split(anchor).join(replacement);
}

// HYK-463: test-only instrumentation appended to every fixture copy, no-op
// for every real caller (dispatch-worker.ps1 never sets these env vars).
// __HYK463_reclaimCheckpoint__ is the IPC-checkpoint pause the deterministic
// crossover harness uses. __HYK463_reclaimWinCheckpoint__ is the 2R
// "sufficient contention" signal: how many DISTINCT processes actually WON
// the lock immediately after taking the reclaim branch. Two or more such
// wins is a direct, mechanism-grounded proof of double critical-section
// entry (the module header's documented TOCTOU, observed directly) -- not a
// proxy count of how many merely glimpsed the same stale snapshot (1R's
// rejected metric). A re-read-right-before-unlink alternative was ALSO
// measured and rejected (coder.md §2-1): it misses losses when several
// processes still share the same not-yet-replaced dead snapshot at unlink
// time.
const HYK463_INSTRUMENTATION_FOOTER = [
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
  "    // deliberately synchronous, so a checkpoint pause must be too.",
  "  }",
  "}",
  "",
  "function __HYK463_reclaimWinCheckpoint__(attemptedReclaim) {",
  "  if (!attemptedReclaim) return;",
  "  const logPath = process.env.HYK463_RECLAIM_WIN_LOG;",
  "  if (!logPath) return;",
  "  try { appendFileSync(logPath, `${process.pid}\\n`); } catch {}",
  "}",
  "",
].join("\n");

// writeRaceFixtureStore -- admission-ledger-store.mjs 의 사본을 만들되,
// (선택) 변이 치환을 적용하고, «reclaim 판정 직후»·«reclaim 승리 직후»
// 지점에 항상 체크포인트 훅을 심는다. 훅은 대응하는 env var 가 안 잡혀
// 있으면 즉시 반환(no-op) -- 그래서 기존 24개 wave 시험(§HYK-346 ⑴⑵)에는
// 아무 영향이 없다.
function writeRaceFixtureStore(
  dir,
  filename,
  { mutationFind, mutationReplace } = {},
) {
  let src = readFileSync(join(THIS_DIR, "admission-ledger-store.mjs"), "utf8");
  if (mutationFind !== undefined) {
    src = replaceAnchorOnce(src, mutationFind, mutationReplace, "mutation");
  }
  src = replaceAnchorOnce(
    src,
    "    if (shouldReclaim(owner)) {",
    "    if (shouldReclaim(owner)) {\n      __HYK463_reclaimCheckpoint__(lockPath, owner);",
    "checkpoint",
  );
  src = replaceAnchorOnce(
    src,
    "  let lastTransient = null;",
    "  let lastTransient = null;\n  let __hyk463CameFromReclaim = false;",
    "lastTransient",
  );
  src = replaceAnchorOnce(
    src,
    "    const claimed = tryClaimLock(lockPath);\n" +
      "    if (claimed.ok) return { ok: true, token: claimed.token };",
    "    const __hyk463AttemptedReclaim = __hyk463CameFromReclaim;\n" +
      "    __hyk463CameFromReclaim = false;\n" +
      "    const claimed = tryClaimLock(lockPath);\n" +
      "    if (claimed.ok) {\n" +
      "      __HYK463_reclaimWinCheckpoint__(__hyk463AttemptedReclaim);\n" +
      "      return { ok: true, token: claimed.token };\n" +
      "    }",
    "claim",
  );
  src = replaceAnchorOnce(
    src,
    "        continue;",
    "        __hyk463CameFromReclaim = true;\n        continue;",
    "continue",
  );
  src = src.replace(
    'import { dirname } from "node:path";',
    'import { dirname, join } from "node:path";',
  );
  src = src.replace(
    '  mkdirSync,\n} from "node:fs";',
    '  mkdirSync,\n  existsSync,\n  appendFileSync,\n} from "node:fs";',
  );
  src += "\n\n" + HYK463_INSTRUMENTATION_FOOTER;
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

// ★HYK-346-ci-determinism-1-r2 (coder-task §2 ⓐⓓ): waitForFiles 하나만으로는
// "자식이 임계구역에 못 들어갔다"와 "체크포인트 자체가 막혔다"를 못 가른다
// -- 어떤 자식이 (예: 한도를 이미 넘긴 상태로) `withLedgerLock`에서 실패해
// 돌아오면, 그 자식은 cs-ready 파일을 영영 안 쓰지만(콜백이 호출되지
// 않았다) IPC `done` 메시지는 정상적으로 보낸다. cs-ready 파일 또는 그
// 자식의 done(IPC) 둘 중 먼저 오는 쪽을 받아야, "정당하게 ok:false 로
// 끝난 자식"과 "진짜로 아무 신호도 안 오는(체크포인트 막힘)" 자식을
// 가를 수 있다.
async function waitForCsReadyOrDone(csReadyPath, donePromise, timeoutMs) {
  let doneArrived = false;
  donePromise.then(() => {
    doneArrived = true;
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(csReadyPath) || doneArrived) return;
    if (Date.now() > deadline) {
      throw new Error(
        `neither cs-ready nor a done IPC message was observed in time: ${csReadyPath}`,
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

// HYK-463 2R (§1-1/§2-1): CI 실증 -- `reclaim 시도=4`(≥2 는 통과)인데도
// 유실이 없었다. 1R 의 «누적 reclaim 시도 횟수 ≥ 2» 문턱은 «몇 명이 죽은
// 락의 스냅샷을 봤는가»만 잰다 -- ORCH §2-1 이 지적한 대로, 그건 «경합
// «기회»의 인원수»일 뿐 «실제 교차가 일어났는가»가 아니다.
//
// ★측정으로 1차 대안(raceWindowHits: unlink 직전 재확인)도 기각했다
// (coder.md §2-1 표) -- n=4 저부하 실험에서 raceWindowHits=0 인데도
// lostUpdates>0 인 사례가 다수 나왔다. 원인: 여러 프로세스가 «아직 아무도
// 안 지운» 같은 죽은 스냅샷을 거의 동시에 보고 있으면, unlink 직전 재확인
// 시점에도 파일 내용이 아직 안 바뀌어 있어(=아직 아무도 안 지웠으므로)
// 「달라짐」이 안 잡힌다 -- 그런데도 그 직후 여러 프로세스가 거의 동시에
// unlink+wx 를 실행해 둘 다 임계구역에 들어갈 수 있다.
//
// ★정본 신호: reclaim 분기를 거쳐 unlink 한 «바로 다음 시도»에서
// tryClaimLock 이 성공한 횟수(`reclaimPathWins`). 이것이 ≥2 라는 것은 —
// «서로 다른 두 프로세스가 각자 «나 혼자 락을 얻었다»고 믿는 상태가 실제로
// 성립했다»는 것 그 자체다(모듈 헤더가 적은 TOCTOU 의 정의 그대로) --
// 파일 내용의 스냅샷 비교가 아니라 «누가 실제로 문을 통과했는가»를 직접
// 센다. §3-메타-변이에서 반복 측정으로 검증했다: n=4/8/24 전 구간에서
// `reclaimPathWins>=2` ⇔ `lostUpdates>0` (24/24 일치, coder.md §2-1 표).
//
// HYK-346-ci-determinism-1 (coder-task.md §2): 위 표의 전제 자체가 이
// 칸의 유일한 남은 결함이었다 -- 24개를 그냥 풀어놓고 «몇 명이 실제로
// 교차했는지»를 세는 구조는, 교차가 «일어나길» CPU 스케줄링 운에 맡긴다.
// CI 의 1~2 코어 러너에서는 그 운이 거의 항상 나오지 않는다(759 초록 ·
// 760 빨강, 동일 트리 -- coder.md §1 ORCH 구조 사실). 아래
// `runGatedReclaimChain` 은 HYK-463 이 이미 만든 같은 파일 체크포인트
// (`__HYK463_reclaimCheckpoint__`)로 24개 «전원»을 reclaim 판정 직후에
// 멈춰 세운다(죽은 씨앗을 전원이 보고 있으므로 아무도 몰래 지나칠 수
// 없다) -- 그 다음 한 명씩만 풀어 매번 «바로 앞 당첨자»와의 교차를
// 강제한다. 동시에 다 풀면 24 난사와 같은 운 문제가 그대로 돌아오므로
// ⛔순차 해제가 핵심이다(동시 해제는 기각 -- 위 코드 리딩으로 확인:
// 동시 해제 시 다수가 동시에 unlink+wx 를 다시 경합해 «몇 명이 이겼는가»
// 가 다시 스케줄링 운이 된다).
//
// ★겹침 고지(coder-task.md §2 ⓑ): 메커니즘은 HYK-463 의
// `runCrossoverRace`(체크포인트로 2개를 정확한 교차 지점에 몬다)와
// 같다 -- 새 체크포인트를 만들지 않았다. 다만 이 칸은 그 메커니즘을
// `runCrossoverRace` 전용 2-프로세스 집계기가 아니라, ⑴⑵(635·651행)
// 음성 대조가 쓰는 것과 «같은» `runWave` 류 24-wide
// ok/lostUpdates/duplicateSeen 집계 구조(`runGatedReclaimChain`, 아래)로
// 통과시킨다 -- 그래서 이 칸이 새로 지키는 것은 «그 공유 집계 하네스 자체가
// 24-wide 교차에서도 결함을 올바르게 RED 로 뒤집는가»이다. 또한 ORCH
// §1 "정본 신호"가 가리키는 reclaimAttempts/reclaimPathWins 진단 카운터를
// 그대로 보존한다. 반대로, 예전 몸통의 5회 재시도형 MEASUREMENT_INCONCLUSIVE
// 탈출구는 더 이상 없다 -- 전원이 끝까지 게이팅되므로 «이번엔 운이
// 없었다»로 재시도할 대상 자체가 사라졌다(ⓓ: 남은 assert.fail 은 체크포인트
// 파일 입출력이 정말로 막혔을 때만 발화하는 구조적 안전망이다).
// ★HYK-346-ci-determinism-1-r2: runGatedReclaimChain 이 "체크포인트가
// 막혔다"고 판단했을 때 공유하는 구조화된 신호 하나. 두 자리(ready 배리어·
// go 사슬)가 같은 모양으로 돌려줘서 judgeGatedReclaimChain 이 어디서
// 막혔는지(stuckPhase)와 무관하게 똑같이 MEASUREMENT_INCONCLUSIVE 로
// 판정할 수 있게 한다.
function buildStuckResult(stuckPhase, err, results) {
  return {
    checkpointStuck: true,
    stuckPhase,
    stuckError: err.message,
    results,
    okCount: results.filter((r) => r.ok).length,
    finalCounter: null,
    lostUpdates: 0,
    duplicateSeen: [],
  };
}

// ★전원이 reclaim 판정 직후 체크포인트에서 멈춘다 -- 아무도 아직 지우지
// 않은 같은 죽은 씨앗을 전원이 보고 있으므로, 이 지점을 몰래 지나칠 수
// 있는 자식은 없다(ⓐ 전제였던 «운»이 구조적으로 제거된다). 던지지 않고
// null(성공) 또는 buildStuckResult(실패)를 돌려준다 -- coder-task §2 ⓑⓓ.
async function awaitAllReadyOrStuck(kids, ckptDir, ckptWaitMs, results) {
  try {
    await waitForFiles(
      kids.map((c) => join(ckptDir, `reclaim-ready-${c.pid}.txt`)),
      ckptWaitMs,
    );
    return null;
  } catch (err) {
    for (const k of kids) k.kill();
    return buildStuckResult("ready", err, results);
  }
}

// ★한 명씩만 풀어 매번 «바로 앞 당첨자»와의 교차를 강제한다(순차 해제 --
// 동시 해제는 모듈 주석의 겹침 고지에서 기각한 대로 운 문제를 되살린다).
// ⛔releaseCount<n(기본값 아님)일 때만: i>=releaseCount 인 자식에게는 go
// 파일을 끝까지 안 쓴다 -- 그 자식은 체크포인트 busy-wait 에서 영영 못
// 빠져나온다(반대 방향 칸 전용, coder-task §2 ⓓ). cs-ready 파일 또는 그
// 자식의 done IPC 둘 중 먼저 오는 쪽을 기다린다(waitForCsReadyOrDone) --
// 이래야 "정당하게 ok:false 로 끝난 자식"(cs-ready 는 영영 안 쓰지만
// done 은 보낸다)과 "진짜 체크포인트 막힘"(둘 다 영영 안 온다)을 가를 수
// 있다.
async function releaseChainOrStuck({
  kids,
  n,
  releaseCount,
  ckptDir,
  doneP,
  ckptWaitMs,
  results,
}) {
  for (let i = 0; i < n; i += 1) {
    const c = kids[i];
    if (i < releaseCount) {
      writeFileSync(join(ckptDir, `reclaim-go-${c.pid}.txt`), "go");
    }
    try {
      await waitForCsReadyOrDone(
        join(ckptDir, `cs-ready-${c.pid}.txt`),
        doneP[i],
        ckptWaitMs,
      );
    } catch (err) {
      for (const k of kids) k.kill();
      return buildStuckResult("go", err, results);
    }
  }
  return null;
}

// ★사슬을 이룰 자식 n 개를 포크하고, 각자의 ready/done IPC 프라미스를
// 만들어 돌려준다(runGatedReclaimChain 에서 떼어냈다 -- 줄 수/복잡도 예산).
// `results` 는 호출자가 만든 배열을 그대로 채운다(참조 공유 -- 호출자가
// 이어서 읽는다).
function spawnChainKids({
  child,
  n,
  ledgerPath,
  lockPath,
  holdMs,
  timeoutMs,
  env,
  results,
}) {
  const kids = [];
  const readyP = [];
  const doneP = [];
  for (let i = 0; i < n; i += 1) {
    const c = fork(
      child,
      [ledgerPath, lockPath, String(holdMs), String(timeoutMs)],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], env },
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
  return { kids, readyP, doneP };
}

// ★HYK-346-ci-determinism-1-r2 (coder-task §2 ⓒ): 예전엔 고정 10_000ms --
// 사슬의 맨 뒤로 풀리는 자식은 자기 체크포인트 대기(busy-wait) 동안에도
// 자기 acquireLock 데드라인이 그대로 돌고 있다(그 데드라인은 함수 진입
// 시점에 한 번 잡히고, busy-wait 는 그 데드라인 검사 코드보다 앞에 있다
// -- admission-ledger-store.mjs 의 `if (shouldReclaim(owner)) { checkpoint;
// ... } if (Date.now() >= deadline) {...}` 순서 그대로). 그래서 맨 뒤
// 자식의 최악 대기는 대략 (n-1)*holdMs(앞선 전원이 순차로 다 끝날 때까지)
// + holdMs(마지막 홀더 하나 더) 다. 고정 10_000ms 는 n=24·holdMs=300
// (이론치 7200ms)에 호스트 부하 지터가 겹치면 부족해질 수 있었다 --
// 1R run2(§9, free≈1460MB 극단 압박)가 바로 그 증상(anyMeasurementNoise)
// 이었다고 보인다(추론). 그래서 n·holdMs 에 정비례한 유한 값(⛔무한 아님)
// + 5000ms 여유(포크·IPC·파일 폴링 오버헤드 몫)로 바꾼다.
async function runGatedReclaimChain({
  dir,
  storeUrl,
  n,
  holdMs,
  timeoutMs = n * holdMs + 5_000,
  // ★같은 조각: 하네스 자신이 체크포인트 파일(ready/cs-ready)을 기다리는
  // 예산은 자식의 잠금 한도(timeoutMs)와 별도로 받는다 -- 기본은 같은
  // 값이지만, 반대 방향 칸(체크포인트가 «진짜로» 영영 안 풀리는 경우)은
  // 훨씬 짧은 값을 따로 줘서 유한 시간 안에 막힘을 감지하게 한다.
  ckptWaitMs = timeoutMs,
  reclaimLog,
  reclaimWinLog,
  // ★반대 방향 칸 전용 손잡이(coder-task §2 ⓓ): n 보다 작으면
  // releaseCount..n-1 번째 자식은 reclaim-go 신호를 끝까지 못 받는다 --
  // 체크포인트가 "진짜로" 영영 안 풀린 상태를 결정적으로 모사한다. 기본값
  // (n, 즉 전원 해제)에서는 이 분기가 전혀 안 밟힌다 -- 기존 동작 그대로.
  releaseCount = n,
}) {
  const ledgerPath = join(dir, "ledger.json");
  const lockPath = join(dir, "ledger.lock");
  const ckptDir = join(dir, "ckpt");
  mkdirSync(ckptDir, { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ counter: 0 }), "utf8");
  // ★HYK-346 씨앗: 죽은 소유자의 락 -- 24개 전원이 이걸 보고 회수를 결정한다.
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
  const env = isolatedChildEnv({
    HYK463_CKPT_DIR: ckptDir,
    HYK463_RECLAIM_LOG: reclaimLog,
    HYK463_RECLAIM_WIN_LOG: reclaimWinLog,
  });
  const results = [];
  const { kids, readyP, doneP } = spawnChainKids({
    child,
    n,
    ledgerPath,
    lockPath,
    holdMs,
    timeoutMs,
    env,
    results,
  });
  await Promise.all(readyP); // IPC 배리어: 전원 준비될 때까지 출발 안 함
  for (const c of kids) c.send({ go: true });
  const readyStuck = await awaitAllReadyOrStuck(
    kids,
    ckptDir,
    ckptWaitMs,
    results,
  );
  if (readyStuck) return readyStuck;
  const releaseStuck = await releaseChainOrStuck({
    kids,
    n,
    releaseCount,
    ckptDir,
    doneP,
    ckptWaitMs,
    results,
  });
  if (releaseStuck) return releaseStuck;
  await Promise.all(doneP);
  const finalCounter = JSON.parse(readFileSync(ledgerPath, "utf8")).counter;
  const okRs = results.filter((r) => r.ok);
  const seenCounts = {};
  for (const r of okRs) seenCounts[r.seen] = (seenCounts[r.seen] ?? 0) + 1;
  return {
    checkpointStuck: false,
    results,
    okCount: okRs.length,
    finalCounter,
    lostUpdates: okRs.length - finalCounter,
    duplicateSeen: Object.entries(seenCounts).filter(([, c]) => c > 1),
  };
}

// ★HYK-346-ci-determinism-1-r2 (coder-task §2 ⓐ): ok:false 자식이 몇 번
// 어떤 reasonCode 로 끝났는지 -- 실패 문구/진단 출력에 그대로 찍을 breakdown.
function failedReasonBreakdown(results) {
  const reasonCounts = {};
  for (const r of results) {
    if (r.ok !== false) continue;
    const code = r.reasonCode ?? "UNKNOWN";
    reasonCounts[code] = (reasonCounts[code] ?? 0) + 1;
  }
  return reasonCounts;
}

function buildInconclusiveMessage(w, ctx) {
  const { reclaimPathWins, reclaimAttempts, dir, minOkForDetection } = ctx;
  const cause = w.checkpointStuck
    ? `체크포인트 파일 체계(${join(dir, "ckpt")}) 자체가 막혔다(단계=${w.stuckPhase ?? "?"}, ${w.stuckError ?? ""}). `
    : `전원을 체크포인트로 게이팅하고 순차 해제했는데도 «충분 경합»이 ` +
      `관측되지 않았다(reclaimPathWins=${reclaimPathWins}, reclaim 시도=${reclaimAttempts}[진단용]). `;
  return (
    `측정 불능(MEASUREMENT_INCONCLUSIVE): ` +
    cause +
    `okCount=${w.okCount}(탐지 최소 ${minOkForDetection} 미달=${w.okCount < minOkForDetection}), ` +
    `ok:false 자식 ${ctx.failedCount}명의 reasonCode 분포=${ctx.reasonBreakdown} -- ` +
    `더 이상 부하 운의 문제가 아니므로, 체크포인트 파일 체계 자체가 막혔거나 ` +
    `경합 자체가 구조적으로 안 섰다는 뜻이다.`
  );
}

function buildRedMessage(
  w,
  { reclaimPathWins, reclaimAttempts, reasonBreakdown, redOk },
) {
  const verdict = redOk
    ? `and the mutant correctly lost updates -- real mutation-detected RED signal.`
    : `but the mutant still did not lose updates -- this IS a real ` +
      `mutation-not-detected RED signal, distinct from measurement-inconclusive.`;
  return (
    `sufficient contention WAS observed (reclaimPathWins=${reclaimPathWins}, ` +
    `reclaim 시도=${reclaimAttempts}, okCount=${w.okCount}, ok:false 자식 ` +
    `reasonCode 분포=${reasonBreakdown}) ` +
    verdict +
    ` got ${JSON.stringify({ lostUpdates: w.lostUpdates, duplicateSeen: w.duplicateSeen, okCount: w.okCount })}`
  );
}

// ★HYK-346-ci-determinism-1-r2 (coder-task §2 ⓐⓑ): mutation ① 칸과 반대
// 방향 칸(아래)이 공유하는 단 하나의 판정 로직. 1R(§9)의 공백을 두 갈래로
// 좁힌다 -- ⑴ `ok:false` 자식이 있어도(okCount 로 따로 세고, reasonCode
// 분포를 breakdown 으로 진단 문구에 찍는다) 그 자체로는 더 이상 측정을
// 무효화하지 않는다(`lostUpdates`/`duplicateSeen` 은 runGatedReclaimChain
// 이 이미 ok 자식만으로 계산해 돌려준다) ⑵ 측정 불능은 "결정적 경합 자체가
// 안 섰을 때"(checkpointStuck 이거나 reclaimPathWins<2) 또는 "유실을 셀
// 수조차 없을 때"(okCount<minOkForDetection, 탐지 최소)로만 좁힌다.
function judgeGatedReclaimChain(
  w,
  { reclaimPathWins, reclaimAttempts, dir, minOkForDetection = 2 },
) {
  const reasonBreakdown = JSON.stringify(failedReasonBreakdown(w.results));
  const failedCount = w.results.filter((r) => r.ok === false).length;
  const contentionStructurallyFailed =
    w.checkpointStuck === true || reclaimPathWins < 2;
  const detectionFloorMet = w.okCount >= minOkForDetection;
  if (contentionStructurallyFailed || !detectionFloorMet) {
    return {
      inconclusive: true,
      message: buildInconclusiveMessage(w, {
        reclaimPathWins,
        reclaimAttempts,
        dir,
        minOkForDetection,
        failedCount,
        reasonBreakdown,
      }),
    };
  }
  const redOk = w.lostUpdates > 0 || w.duplicateSeen.length > 0;
  return {
    inconclusive: false,
    redOk,
    message: buildRedMessage(w, {
      reclaimPathWins,
      reclaimAttempts,
      reasonBreakdown,
      redOk,
    }),
  };
}

test("★★HYK-346 변이 ① (24개, 전원 체크포인트 게이팅 순차 해제) -- «충분 경합»(reclaimPathWins≥2)을 부하 운에 맡기지 않고 시험이 직접 강제해 RED 로 판정한다", async () => {
  const { dir } = tmpPaths();
  const reclaimLog = join(dir, "reclaim-attempts.log");
  const reclaimWinLog = join(dir, "reclaim-wins.log");
  try {
    writeFileSync(reclaimLog, "", "utf8");
    writeFileSync(reclaimWinLog, "", "utf8");
    const mutantUrl = writeRaceFixtureStore(dir, "mutant-wave-store.mjs", {
      mutationFind: "      if (lockFileStillHasToken(lockPath, owner.token)) {",
      mutationReplace: "      if (true) {",
    });
    const w = await runGatedReclaimChain({
      dir,
      storeUrl: mutantUrl,
      n: 24,
      holdMs: 300,
      reclaimLog,
      reclaimWinLog,
    });
    // ★HYK-463 2R 유산 -- reclaimAttempts 는 진단용 보조 수치로만 결과
    // 파일에 인용한다(문턱이 아니다 -- 1R 의 기각된 신호).
    const reclaimAttempts = readFileSync(reclaimLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    // ★HYK-463 2R 유산 -- «충분 경합»의 정본 신호. 전원 게이팅 뒤에는
    // 항상 ≥2(사실상 n-1 근처)여야 한다 -- 운이 아니라 구조로 보장된다.
    const reclaimPathWins = readFileSync(reclaimWinLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    // ★HYK-346-ci-determinism-1-r2 (coder-task §2 ⓑ): 판정을
    // judgeGatedReclaimChain 에 맡긴다 -- ok:false 자식이 있어도(그 자체는
    // 더 이상 측정을 무효화하지 않는다) reclaimPathWins<2 이거나
    // checkpointStuck 일 때만, 또는 okCount<2(탐지 최소 미달)일 때만
    // MEASUREMENT_INCONCLUSIVE 로 떨어진다.
    const judged = judgeGatedReclaimChain(w, {
      reclaimPathWins,
      reclaimAttempts,
      dir,
    });
    if (judged.inconclusive) {
      assert.fail(judged.message);
    }
    assert.ok(judged.redOk, judged.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346-ci-determinism-1-r2 ⑴ ok:false 자식의 reasonCode 가 IPC done 메시지로 그대로 올라온다 -- 강제 주입(방식 근거: 존재하지 않는 폴더 밑 락 경로로 LOCK_OS_CONTENTION 을 타이밍과 무관하게 결정적으로 강제한다, ★★HYK-346 ⑶ 시험과 같은 기법)", async () => {
  const { dir } = tmpPaths();
  try {
    const ledgerPath = join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ counter: 0 }), "utf8");
    // 부모 폴더가 없는 락 경로 -> wx 가 ENOENT(=EEXIST 아님)로 실패 ->
    // LOCK_OS_CONTENTION. 재시도할 "남이 쥔 락"이 없으므로 자식은 1회차
    // 폴링 안에 결정적으로 그 reasonCode 로 끝난다.
    const brokenLockPath = join(dir, "no-such-dir", "ledger.lock");
    const storeUrl = pathToFileURL(
      join(THIS_DIR, "admission-ledger-store.mjs"),
    ).href;
    const child = writeCrossoverChildScript(dir, storeUrl);
    const c = fork(child, [ledgerPath, brokenLockPath, "0", "300"], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: isolatedChildEnv(),
    });
    const msg = await new Promise((resolve) => {
      c.once("message", () => c.send({ go: true }));
      c.on("message", (m) => {
        if (m && m.done) resolve(m);
      });
    });
    assert.equal(
      msg.ok,
      false,
      `강제 주입이 실제로 ok:false 를 냈는지 자가 점검: ${JSON.stringify(msg)}`,
    );
    assert.equal(
      msg.reasonCode,
      STORE_REASON.LOCK_OS_CONTENTION,
      `ok:false 자식의 reasonCode 가 IPC done 메시지로 안 올라오면(runGatedReclaimChain/` +
        `judgeGatedReclaimChain 이 읽는 바로 그 필드) 그 자식이 왜 실패했는지 진단 출력에 ` +
        `영영 안 찍힌다(1R §9 run2 의 공백 그대로) -- 받은 메시지 ${JSON.stringify(msg)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346-ci-determinism-1-r2 ⑷ 완화가 탐지를 깎지 않음 -- 변이①실측 결과에 ok:false 노이즈 2개를 섞어도 okCount≥2·reclaimPathWins≥2 면 RED 유지", async () => {
  const { dir } = tmpPaths();
  const reclaimLog = join(dir, "reclaim-attempts.log");
  const reclaimWinLog = join(dir, "reclaim-wins.log");
  try {
    writeFileSync(reclaimLog, "", "utf8");
    writeFileSync(reclaimWinLog, "", "utf8");
    const mutantUrl = writeRaceFixtureStore(
      dir,
      "mutant-wave-store-noise.mjs",
      {
        mutationFind:
          "      if (lockFileStillHasToken(lockPath, owner.token)) {",
        mutationReplace: "      if (true) {",
      },
    );
    const w = await runGatedReclaimChain({
      dir,
      storeUrl: mutantUrl,
      n: 24,
      holdMs: 300,
      reclaimLog,
      reclaimWinLog,
    });
    const reclaimAttempts = readFileSync(reclaimLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    const reclaimPathWins = readFileSync(reclaimWinLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    // ★방식 근거(〔직접〕실측, scratchpad 확인): 변이①의 "steal"(if(true))
    // 은 토큰 재확인을 건너뛰고 unlink 뒤 즉시 재시도(continue)로 돌아가며,
    // 그 재시도가 성공하면 deadline 검사 코드 자체에 도달하기 전에 ok:true
    // 로 반환한다 -- 그래서 자식의 개별 lockTimeoutMs 를 아무리 줄여도
    // (예: 30ms, holdMs=200 인 사슬에서 늦게 풀린 자식에게 줘 봄) 실패하지
    // 않았다(항상 ok:true, n=4 재현). 자연 발생 ok:false 를 결정적으로
    // 강제할 손잡이가 이 메커니즘 안에는 없다 -- 그래서 이 확인은 실측
    // w.results 에 ok:false 2개(서로 다른 reasonCode)를 합성으로 섞고
    // okCount/lostUpdates 를 "ok 자식만"으로 다시 계산해(judgeGatedReclaimChain
    // 과 완전히 같은 방식) 판정 로직이 그래도 RED 를 지키는지만 단위
    // 수준으로 확인한다. 못쟀다: 라이브 포크 자식의 "자연" ok:false 를
    // 실제로 섞은 변이 실행.
    const noisyResults = [
      ...w.results,
      { done: true, ok: false, reasonCode: "LOCK_TIMEOUT", seen: null },
      { done: true, ok: false, reasonCode: "LOCK_OS_CONTENTION", seen: null },
    ];
    const okRs = noisyResults.filter((r) => r.ok);
    const noisyW = {
      checkpointStuck: false,
      results: noisyResults,
      okCount: okRs.length,
      finalCounter: w.finalCounter,
      lostUpdates: okRs.length - w.finalCounter,
      duplicateSeen: w.duplicateSeen,
    };
    assert.ok(
      noisyW.okCount >= 2,
      `합성이 의도대로 됐는지 자가 점검(okCount>=2 여야 "탐지 최소는 넘지만 노이즈는 있는" ` +
        `시나리오가 된다): okCount=${noisyW.okCount}`,
    );
    const judged = judgeGatedReclaimChain(noisyW, {
      reclaimPathWins,
      reclaimAttempts,
      dir,
    });
    assert.equal(
      judged.inconclusive,
      false,
      `okCount(${noisyW.okCount})>=2 이고 reclaimPathWins(${reclaimPathWins})>=2 인데 ` +
        `노이즈 2개 때문에 불능으로 잘못 떨어지면 완화가 탐지력을 깎은 것이다: ${judged.message}`,
    );
    assert.ok(
      judged.redOk,
      `노이즈가 섞여도 변이①은 여전히 RED 로 잡혀야 한다: ${judged.message}`,
    );
    assert.ok(
      judged.message.includes("LOCK_TIMEOUT") &&
        judged.message.includes("LOCK_OS_CONTENTION"),
      `ok:false 자식들의 reasonCode 가 진단 문구에 찍혀야 한다(ⓐ): ${judged.message}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("★★HYK-346-ci-determinism-1-r2 반대 방향 -- 진짜로 체크포인트가 영영 안 풀리면(일부 자식이 go 신호를 끝까지 못 받음) 유한 시간 안에 정확히 MEASUREMENT_INCONCLUSIVE 로 판정된다(다른 종류의 실패/행 아님)", async () => {
  const { dir } = tmpPaths();
  const reclaimLog = join(dir, "reclaim-attempts.log");
  const reclaimWinLog = join(dir, "reclaim-wins.log");
  try {
    writeFileSync(reclaimLog, "", "utf8");
    writeFileSync(reclaimWinLog, "", "utf8");
    // ★진짜(변이 없는) 코드로 돌린다 -- 체크포인트 막힘은 변이와 무관하게
    // 일어날 수 있는 구조적 안전망이어야 한다(coder-task §2 ⓓ "반대 방향").
    const storeUrl = writeRaceFixtureStore(dir, "stuck-wave-store.mjs", {});
    const startedAt = Date.now();
    const w = await runGatedReclaimChain({
      dir,
      storeUrl,
      n: 4,
      holdMs: 50,
      releaseCount: 2, // ★뒤 2명은 go 신호를 끝까지 못 받는다(진짜 체크포인트 막힘, 결정적 모사)
      ckptWaitMs: 1_500, // ★기본(n*holdMs+5000)과 분리된, 막힘을 빨리 잡는 짧은 예산
      reclaimLog,
      reclaimWinLog,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.ok(
      w.checkpointStuck,
      `체크포인트가 영영 안 풀리면 runGatedReclaimChain은 무한정 걸리거나 막연한 예외를 ` +
        `던지지 않고 구조화된 checkpointStuck 신호를 돌려줘야 한다: ${JSON.stringify(w)}`,
    );
    assert.ok(
      elapsedMs < 10_000,
      `반대 방향 칸은 유한 시간 안에 끝나야 한다(ckptWaitMs=1500 대비 실측 ${elapsedMs}ms)`,
    );
    const reclaimPathWins = readFileSync(reclaimWinLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    const reclaimAttempts = readFileSync(reclaimLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    const judged = judgeGatedReclaimChain(w, {
      reclaimPathWins,
      reclaimAttempts,
      dir,
    });
    assert.ok(
      judged.inconclusive,
      `체크포인트가 막힌 상태는 반드시 측정-불능 분기로만 가야 한다(ok:false 노이즈 류의 ` +
        `"그냥 통과"가 아니다): ${judged.message}`,
    );
    assert.ok(
      judged.message.includes("MEASUREMENT_INCONCLUSIVE"),
      `실패 문구가 정확히 MEASUREMENT_INCONCLUSIVE 를 담아야 한다: ${judged.message}`,
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
