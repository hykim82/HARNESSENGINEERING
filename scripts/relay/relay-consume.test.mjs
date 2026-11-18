// HYK-390-auth-shadow-2 (판정 2026-11-17 17:05 ④ · 21:04 ③): 새 relay 쪽 소비
// 입구(relay-consume.mjs)의 시험.
//
// 입구가 하는 일은 둘뿐이다: ⑴ 실 Orca 조회(createDispatchAuthLookup)를 그림자
// 기본값으로 «결선» ⑵ 지금 CLI 와 같은 소비 함수(runRelayHandshakeCli)를 부른다.
// 그래서 이 시험은 ⓐ 결선된 조회가 소비(checkRelayHandshake 프로덕션 진입점)
// 안에서 판정 값으로 남는지(진짜 · 위조 의심 · 조회 실패 각 1건) ⓑ 새 입구와 옛
// CLI 의 종료 코드 · 표준 출력 · 표준 오류가 같은 합성 입력에서 같은지 ⓒ 조회가
// 던지거나 · 시간 초과이거나 · 비동기여도 소비 결과가 무변인지를 본다.
//
// 모두 합성 원장(mkdtemp) + 주입 spawnSyncFn(실 orca 0). 자식 프로세스를 띄우는
// 시험도 PATH 에서 orca 가 있는 디렉터리를 뺀 환경으로 띄운다 -- 실 orca 실행 0.
// ⛔`import()` 는 «시험 안에서만» 쓴다(입구가 없는 base 위에서 시험마다 따로
// 빨갛게 되도록 · 입구 소스 자체의 동적 import 금지는 소스 스캔 시험이 고정).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkRelayHandshake,
  configureAuthShadowDefaults,
  AUTH_SHADOW_DEFAULT_TIMEOUT_MS,
} from "../check/relay-handshake.mjs";
import { isolatedChildEnv } from "../check/admission-ledger-env-isolation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY_PATH = join(HERE, "relay-consume.mjs");
const OLD_CLI_PATH = join(HERE, "..", "check", "relay-handshake.mjs");
const SHADOW_SUFFIX = ".auth-shadow.jsonl";

const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), "hyk390-consume-"));
after(() => rmSync(SCRATCH_ROOT, { recursive: true, force: true }));

const LABEL = "HYK-390-C";
const RUNTIME_ID = "task_cccccccccccc";
const DISPATCH_ID = "ctx_consume_1";
const PANE =
  "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";
const NOW_MS = Date.now();
const DROPPED_MS = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000;
const DONE_MS = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000;

function kst(ms, withSeconds) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

// 합성 «좌석 워크트리»: <wt>/.harness = harnessDir, 원장은 워크트리 밖 ctrl/.
function makeWorld(prefix, { doneLabel = LABEL } = {}) {
  const root = mkdtempSync(join(SCRATCH_ROOT, prefix));
  const harnessDir = join(root, "wt", ".harness");
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(join(root, "ctrl"), { recursive: true });
  const ledgerPath = join(root, "ctrl", "receipts.jsonl");
  writeFileSync(
    join(harnessDir, "coder-task.md"),
    `task_id: ${LABEL}\ndropped_at: ${kst(DROPPED_MS, false)}\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, "coder.md"),
    `task_id: ${doneLabel}\ndispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_ID}\npane_match: ${PANE} == ${PANE} ? 일치\n\n>>> DONE: CODER @ ${kst(DONE_MS, true)}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({
      recorded_at: new Date(DROPPED_MS + 60_000).toISOString(),
      runtime_task_id: RUNTIME_ID,
      dispatch_id: DISPATCH_ID,
      assignee_pane_key: PANE,
      dispatch_timestamp_utc: new Date(DROPPED_MS).toISOString(),
      dispatch_timestamp_source: "response.dispatched_at",
      role: "coder",
      harness_task_label: LABEL,
    })}\n`,
    "utf8",
  );
  writeFileSync(join(harnessDir, "dispatch-receipt-path.txt"), ledgerPath);
  return { root, harnessDir, ledgerPath };
}

function readShadow(ledgerPath) {
  const p = ledgerPath + SHADOW_SUFFIX;
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// dispatch-show 응답을 흉내 내는 주입 spawnSync(실 orca 0).
function fakeSpawnSync(stdoutObject, calls = []) {
  return (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify(stdoutObject),
      stderr: "",
    };
  };
}
const showOk = (over = {}) => ({
  ok: true,
  result: {
    dispatch: {
      id: DISPATCH_ID,
      task_id: RUNTIME_ID,
      assignee_pane_key: PANE,
      status: "dispatched",
      ...over,
    },
  },
});

function consumeInProcess(w) {
  return checkRelayHandshake({
    role: "coder",
    harnessDir: w.harnessDir,
    now: NOW_MS,
    dispatchLedgerPath: w.ledgerPath,
  });
}

// 입구가 결선한 기본값을 시험 뒤 되돌린다(다른 시험에 새지 않게).
async function withWiring(spawnSyncFn, body) {
  const mod = await import("./relay-consume.mjs");
  const previous = mod.wireAuthShadowLookup({ spawnSyncFn });
  try {
    return await body(mod);
  } finally {
    configureAuthShadowDefaults(previous);
  }
}

// --------------------------------------------------------------------------
// ⓐ 결선: 입구가 조회를 이으면 그림자 기록이 «진짜 · 위조 의심 · 조회 실패»
// 판정으로 남고(lookup_not_wired 아님), 소비 결과는 미결선 소비와 같다.
// --------------------------------------------------------------------------
test("(결선-진짜) 입구가 조회를 이으면 정상 줄 -> AUTHENTIC · dispatch-show 읽기 전용 1회 · 소비 무변", async () => {
  const w = makeWorld("wire-ok-");
  const unwired = consumeInProcess(w);
  const calls = [];
  const wired = await withWiring(fakeSpawnSync(showOk(), calls), () =>
    consumeInProcess(w),
  );
  assert.equal(wired.ok, true);
  assert.deepEqual(wired, unwired, "결선 있음/없음 소비 결과 동등");
  const rows = readShadow(w.ledgerPath);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].evidence.lookup_failure, "lookup_not_wired");
  assert.equal(rows[1].verdict, "AUTHENTIC");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "orca");
  assert.deepEqual(calls[0].argv, [
    "orchestration",
    "dispatch-show",
    "--task",
    RUNTIME_ID,
    "--json",
  ]);
});

test("(결선-위조) 입구가 조회를 이으면 Orca 에 없는 dispatch -> DISPATCH_RECORD_UNAUTHENTIC · 소비 무변", async () => {
  const w = makeWorld("wire-forged-");
  const unwired = consumeInProcess(w);
  const wired = await withWiring(
    fakeSpawnSync({ ok: true, result: { dispatch: null } }),
    () => consumeInProcess(w),
  );
  assert.equal(wired.ok, true);
  assert.deepEqual(wired, unwired);
  const last = readShadow(w.ledgerPath).at(-1);
  assert.equal(last.verdict, "DISPATCH_RECORD_UNAUTHENTIC");
  assert.deepEqual(last.mismatch_keys, ["dispatch_id"]);
});

test("(결선-조회실패) 입구가 조회를 이어도 Orca 가 못 답하면 DISPATCH_AUTH_LOOKUP_FAILED(lookup_not_wired 가 아님) · 소비 무변", async () => {
  const w = makeWorld("wire-fail-");
  const unwired = consumeInProcess(w);
  const wired = await withWiring(
    fakeSpawnSync({ ok: false, reason: "runtime unavailable" }),
    () => consumeInProcess(w),
  );
  assert.deepEqual(wired, unwired);
  const last = readShadow(w.ledgerPath).at(-1);
  assert.equal(last.verdict, "DISPATCH_AUTH_LOOKUP_FAILED");
  assert.notEqual(last.evidence.lookup_failure, "lookup_not_wired");
});

// --------------------------------------------------------------------------
// ⓒ 조회가 던지거나 · 시간 초과이거나 · 비동기여도 소비 결과 무변(시험 고정)
// --------------------------------------------------------------------------
for (const [name, spawnSyncFn, failure] of [
  [
    "spawn 이 예외를 던진다",
    () => {
      throw new Error("spawn orca ENOENT");
    },
    "not_ok",
  ],
  [
    "spawnSync 시한 초과(ETIMEDOUT 오류 반환)",
    () => ({
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync orca ETIMEDOUT"), {
        code: "ETIMEDOUT",
      }),
    }),
    "timeout",
  ],
]) {
  test(`(무변) 입구의 조회가 ${name} -> 소비 결과 무변 · 프로세스 안 죽음 · 조회 실패 기록`, async () => {
    const w = makeWorld("inv-");
    const unwired = consumeInProcess(w);
    const wired = await withWiring(spawnSyncFn, () => consumeInProcess(w));
    assert.equal(wired.ok, true);
    assert.deepEqual(wired, unwired);
    const last = readShadow(w.ledgerPath).at(-1);
    assert.equal(last.verdict, "DISPATCH_AUTH_LOOKUP_FAILED");
    assert.equal(last.evidence.lookup_failure, failure);
  });
}

// --------------------------------------------------------------------------
// 조회 대기 상한 = 값 하나(소비 쪽 상수). 입구가 실 조회의 spawn 시한에도
// «같은 값»을 건다(어댑터의 별도 기본값이 아니라).
// --------------------------------------------------------------------------
test("(상한) 입구의 조회는 spawn 시한에 AUTH_SHADOW_DEFAULT_TIMEOUT_MS(10000) 를 건다 -- 값이 한 곳", async () => {
  const w = makeWorld("cap-");
  const calls = [];
  await withWiring(fakeSpawnSync(showOk(), calls), () => consumeInProcess(w));
  assert.equal(AUTH_SHADOW_DEFAULT_TIMEOUT_MS, 10_000);
  assert.equal(calls[0].opts.timeout, AUTH_SHADOW_DEFAULT_TIMEOUT_MS);
});

// --------------------------------------------------------------------------
// ⓑ 옛 CLI 와 새 입구: 같은 합성 입력 -> 종료 코드 · 표준 출력 · 표준 오류 동등.
// 자식은 PATH 에서 orca 를 뺀 환경 -> 실 orca 0 (조회는 «못 답함»으로 끝난다).
// --------------------------------------------------------------------------
function envWithoutOrca() {
  const base = { ...process.env };
  const pathKey =
    Object.keys(base).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const kept = String(base[pathKey] ?? "")
    .split(delimiter)
    .filter(
      (dir) =>
        dir &&
        !["orca", "orca.exe", "orca.cmd", "orca.bat", "orca.ps1"].some((n) =>
          existsSync(join(dir, n)),
        ),
    );
  for (const k of Object.keys(base)) {
    if (k.toLowerCase() === "path") delete base[k];
  }
  return isolatedChildEnv({ [pathKey]: kept.join(delimiter) }, base);
}

function runChild(scriptPath, args) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: envWithoutOrca(),
  });
  assert.equal(r.error, undefined, `spawn failed: ${r.error?.message}`);
  assert.notEqual(r.status, null, `signal ${r.signal}`);
  return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
}

const scrub = (text, root) => text.split(root).join("<ROOT>");

test("(입구=옛CLI) 정상 소비: 종료 코드 · 표준 출력 · 표준 오류가 같고, 그림자 기록만 달라진다(옛 = lookup_not_wired · 새 = 조회 시도)", () => {
  const oldW = makeWorld("cli-old-");
  const newW = makeWorld("cli-new-");
  const oldRun = runChild(OLD_CLI_PATH, ["coder", oldW.harnessDir]);
  const newRun = runChild(ENTRY_PATH, ["coder", newW.harnessDir]);
  assert.equal(oldRun.exit, 0, oldRun.stderr);
  assert.equal(newRun.exit, oldRun.exit);
  assert.equal(
    scrub(newRun.stdout, newW.root),
    scrub(oldRun.stdout, oldW.root),
  );
  assert.equal(
    scrub(newRun.stderr, newW.root),
    scrub(oldRun.stderr, oldW.root),
  );
  const oldRow = readShadow(oldW.ledgerPath).at(-1);
  const newRow = readShadow(newW.ledgerPath).at(-1);
  assert.equal(oldRow.evidence.lookup_failure, "lookup_not_wired");
  assert.equal(newRow.verdict, "DISPATCH_AUTH_LOOKUP_FAILED");
  assert.notEqual(newRow.evidence.lookup_failure, "lookup_not_wired");
});

for (const [name, argvFor, setup] of [
  ["인자 없음(사용법)", () => [], () => {}],
  ["모르는 역할", () => ["nobody"], () => {}],
  [
    "라운드 거부(task_id 불일치 -> 종료 코드 1 · 거부 사유 stderr)",
    (w) => ["coder", w.harnessDir],
    (w) =>
      writeFileSync(
        join(w.harnessDir, "coder.md"),
        "task_id: HYK-OTHER\n\n>>> DONE: CODER @ 2026-01-01 00:00:00 KST\n",
        "utf8",
      ),
  ],
  [
    "task 파일 없음",
    (w) => ["coder", join(w.root, "nowhere", ".harness")],
    () => {},
  ],
]) {
  test(`(입구=옛CLI) ${name}: 종료 코드 · 표준 출력 · 표준 오류 동등`, () => {
    const w = makeWorld("cli-rej-");
    setup(w);
    const oldRun = runChild(OLD_CLI_PATH, argvFor(w));
    const newRun = runChild(ENTRY_PATH, argvFor(w));
    assert.equal(newRun.exit, oldRun.exit);
    assert.notEqual(oldRun.exit, 0, "거부/사용법 경로가 실제로 거부했다");
    assert.equal(scrub(newRun.stdout, w.root), scrub(oldRun.stdout, w.root));
    assert.equal(scrub(newRun.stderr, w.root), scrub(oldRun.stderr, w.root));
  });
}

// --------------------------------------------------------------------------
// 입구 소스 규율: 소비 함수를 «복사하지 않고 불러야» 한다 · orca 를 직접
// 실행하지 않는다(G9) · 동적 import 로 경계를 피하지 않는다 · 한 줄 의미.
// --------------------------------------------------------------------------
test("(소스) 입구는 export 된 소비 함수를 부르고 orca 직접 실행 · 동적 import · 판정 복사를 하지 않는다", () => {
  const src = readFileSync(ENTRY_PATH, "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(code, /runRelayHandshakeCli\s*\(/, "소비 함수 호출");
  assert.match(code, /configureAuthShadowDefaults\s*\(/, "결선 호출");
  assert.match(code, /createDispatchAuthLookup\s*\(/, "실 조회 생성");
  assert.equal(/\bimport\s*\(/.test(code), false, "동적 import 0");
  assert.equal(
    /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/.test(code),
    false,
    "입구 자신은 프로세스를 띄우지 않는다(어댑터의 execFn 만)",
  );
  assert.equal(/["'`]orca["'`]/.test(code), false, "orca 리터럴 0");
  assert.equal(
    /checkRelayHandshake|process\.exit|process\.argv\[[23]\]/.test(code),
    false,
    "CLI 본문(인자 해석 · 종료 코드)을 복사하지 않는다",
  );
});

test("(소스) 입구를 import 만 해서는 아무것도 실행되지 않는다(직접 실행일 때만 소비)", async () => {
  const mod = await import("./relay-consume.mjs");
  assert.equal(typeof mod.runRelayConsume, "function");
  assert.equal(typeof mod.wireAuthShadowLookup, "function");
});
