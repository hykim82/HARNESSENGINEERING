// install-net-closure.test.mjs -- HYK-209-install-closure-1 §2 ⓑ.
//
// install-copylist-closure.test.mjs's own header already names its limit:
// its RELATIVE_IMPORT_RE walk only sees a static `import`/`export ... from`
// specifier. It is blind to a RUNTIME reference -- a `spawnSync`/
// `execFileSync` call that names a sibling file by path, or a module-top-
// level `readFileSync` of a fixture -- which is exactly the shape this
// round's own real measurement found still broken on a freshly-installed
// target (coder.md §2 ⓑ 표, 〔직접〕 실측): scripts/check/
// seat-proof-wrapper-canonical.json, scripts/check/hyk400-receiver-probe-
// runner.mjs + its scripts/check/fixtures/hyk400-*.mjs.txt siblings,
// scripts/check/reject-streak-defect-sample.json, and scripts/check/
// abort-record-writer.mjs (spawned by relay-handshake.mjs, degrades
// silently rather than crashing -- see install.mjs's own
// ENFORCEMENT_CHECK_FILES comment on it). docs/enforcement-v1.md was tried
// too and REVERTED this same round -- copying it verbatim leaks THIS
// machine's own real control-room path (10+ worked examples embedded in
// the doc's own text) into every installed target, a real portability
// regression the full-runner's own CI-canonical sweep caught live
// (harness-init-install-portability.test.mjs (1)). See install.mjs's own
// comment at that reverted call site, and reject-streak.test.mjs's entry
// in INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS below for why its two doc-code-
// contract subtests stay unfixed this round.
//
// This file is the machine-checked net for that whole class of gap: real
// installer (not --dry-run) -> real `git init` target outside this
// worktree -> commit the installed tree (so self-checks that compare disk
// against `git show HEAD:...`, e.g. relay-handshake.test.mjs, see a
// consistent repo, not "staged but uncommitted") -> actually RUN every
// installed `.test.mjs` file there via `node --test`, one file at a time
// (simpler, unambiguous per-file attribution than parsing one combined TAP
// stream for which file a given `not ok` belongs to).
//
// 완결(실행까지 vs 로드만) 선택 근거 〔직접〕: 로드(import)만 보면 이
// 라운드가 찾은 실제 결함의 절반을 못 잡는다 -- hyk400-receiver-probe-
// runner.mjs/각 fixture는 정적 import가 아니라 "테스트 바디 안의
// spawnSync/copyFileSync 호출"에서만 참조되므로, 그 테스트가 실제로
// *실행*돼야 ENOENT가 드러난다(실측: import()만으로는 이 파일들이 전부
// 조용히 통과한다). 러너 시간: 파일마다 별도 `node --test` 프로세스를 띄워
// (약 46개) 매 실행에 수십~수백 ms의 시작 비용이 더 붙지만, 한 번에
// 합쳐 돌리는 쪽은 "어느 파일이 실패했는가"를 TAP 중첩 구조에서 다시
// 파싱해야 해서 더 깨지기 쉽다(이 라운드가 손으로 그 파싱을 하다가 실제로
// 겪은 혼란 -- coder.md 참조) -- 단순함을 시간보다 우선했다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENFORCEMENT_CHECK_FILES,
  INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS,
} from "./install.mjs";
import {
  LOAD_RETRY_FREE_THRESHOLD_MB,
  UNDER_FULL_RUNNER_TIMEOUT_MS,
  attemptWithRetryGate,
  evaluateRetryGate,
  formatRetryGateDiagnostic,
  measureFreeMemSignal,
} from "./install-retry-gate.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALLER_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);

// Same shape install-g1-adapter-list.test.mjs's own installerArgsFor uses
// (ⓒ above: "로직을 새로 발명하지 않는다") -- duplicated, not imported
// (this repo's own convention, see e.g. runner-receipt-writer.mjs's header
// on why consumer/producer modules stay un-coupled by import).
function installerArgsFor(base, targetRepoPath) {
  return [
    "--profile",
    "solo-full",
    "--repo-path",
    targetRepoPath,
    "--control-room-path",
    path.join(base, "fake-control-room"),
    "--github-repo",
    "someorg/somerepo",
    "--bot-account",
    "bot-x",
    "--verify-cmd",
    "npm test",
    "--notify-dir",
    path.join(base, "notify"),
    "--approver-login",
    "approver-x",
    "--approver-id",
    "1",
    "--workspaces-root",
    path.join(base, "workspaces"),
    "--main-repo-path",
    path.join(base, "main-repo"),
  ];
}

// HYK-209 §2 ⓑ 실측: a plain `mkdtempSync(path.join(tmpdir(), ...))` can
// come back under Windows' 8.3 short-name form (this machine, live:
// `tmpdir()` itself returned `C:\Users\ADMINI~1\...`), which then makes
// quality-check.test.mjs's own CLI-invocation path construction (a `file://
// URL -> .pathname` conversion somewhere in that test, undecoded) turn the
// literal "~" into "%7E" and MODULE_NOT_FOUND -- the exact same class of
// gap isolated-suite-runner.mjs's own longFormTmpdir() already exists to
// avoid (see that file's header). Resolving to the real (long) form before
// using it avoids tripping that PRE-EXISTING, unrelated test-harness quirk
// -- this round's own product_scope does not include quality-check.mjs/
// .test.mjs, so this round doesn't fix that quirk, it just doesn't let an
// unrelated artifact of THIS test's own temp-dir choice masquerade as an
// install-list gap.
function longFormTmpdir() {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    return tmpdir();
  }
}

function makeSyntheticTarget(prefix) {
  const base = mkdtempSync(path.join(longFormTmpdir(), prefix));
  const targetRepo = path.join(base, "target-repo");
  mkdirSync(targetRepo, { recursive: true });
  execFileSync("git", ["-C", targetRepo, "init", "-q"]);
  execFileSync("git", ["-C", targetRepo, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", targetRepo, "config", "user.name", "t"]);
  return { base, targetRepo };
}

function runRealInstall(base, targetRepoPath) {
  return execFileSync(
    "node",
    [INSTALLER_PATH, ...installerArgsFor(base, targetRepoPath)],
    { encoding: "utf8" },
  );
}

// HYK-209 §2 ⓑ 실측: relay-handshake.test.mjs's own module-top-level logic
// does `git show HEAD:scripts/check/relay-handshake.mjs` and throws at
// import time if that fails ("exists on disk, but not in 'HEAD'") -- the
// installer only writes files, it never commits them (correctly: that is
// a human/CI decision, not this tool's). Without a commit here, that one
// file's failure would be indistinguishable from a real install-list gap.
// `--no-verify`: this target's own installed commit-msg/pre-commit hooks
// (review-gate.mjs etc.) are themselves designed to block an unreviewed
// commit -- this is a throwaway smoke-test tree, not a tracked project, so
// bypassing them here is the synthetic-fixture equivalent of "a human
// committed the bootstrap once by hand", not a real enforcement bypass.
function commitInstalledTree(targetRepoPath) {
  execFileSync("git", ["-C", targetRepoPath, "add", "-A"]);
  execFileSync("git", [
    "-C",
    targetRepoPath,
    "commit",
    "--no-verify",
    "-q",
    "-m",
    "synthetic: installed harness files (smoke-test fixture, not a real project)",
  ]);
}

// HYK-209-net-closure-timeout-1-r3 ⓒ: every cleanup `finally` block below
// used a bare `rmSync(base, { recursive: true, force: true })` -- `force`
// only silences ENOENT (target already gone), it does NOT retry a real
// Windows file lock. HYK-464 작성 1R run3 실측(〔직접〕 coder.md §4, 같은
// cleanup 자리): `EPERM, Permission denied: rmSync ...\hyk209-install-net-…`
// -- a one-shot EPERM/EBUSY on an OS that has not yet released a just-closed
// child process's handle on the temp tree stops this round's own correctly-
// behaving run cold.
//
// HYK-209-net-closure-timeout-1-r4 (review-3R §2 ⓒ⑹, this round's own ⓐ
// baseline repro against a real open-handle Windows lock, both 〔직접〕):
// 3R's own premise above -- "`maxRetries`/`retryDelay` are Node's OWN
// built-in `fs.rmSync` retry mechanism ... delegates" -- is FALSE on Node
// 26.2.0 (the version this round's own local full-runner actually runs,
// `runner-receipt.json`'s `node_version`): a real transient lock (open
// handle released after 600 ms, or 250 ms) still throws `EPERM` in 0 ms
// with those two options supplied, zero retries. Node 20.20.2 gets the same
// lock as `EBUSY` and DOES retry through that option -- the built-in
// mechanism's behavior is version-dependent, which this wrapper can no
// longer rely on silently. So this wrapper no longer delegates retry to
// `fs.rmSync` at all: the real `rmSync` call below passes ONLY
// `recursive`/`force` (no `maxRetries`/`retryDelay` -- those two option
// keys mean nothing to `fs.rmSync` once it decides not to act on them, per
// the above). Retry now lives in THIS function, in JS, gated on the error
// `code`: only `EPERM`/`EBUSY`/`ENOTEMPTY` (the shapes a transient
// lock/delete-race on Windows actually produces) are retried, up to a
// finite budget; any other code (e.g. `EACCES` -- a real permission
// problem, not a transient lock) throws on the very first attempt, and the
// LAST attempt's failure (whatever its code) is always re-thrown, never
// swallowed (ⓒ 반대 방향 칸 below, both directions). `maxRetries`/
// `retryDelay` keep the exact same meaning and default values 3R gave the
// (then-unused) Node option, now consumed by this function's own loop
// instead: `retryDelay=100` ms is still Node's own documented default for
// that option name; `maxRetries=5` is still "5 retries after the first
// attempt" (6 total attempts, same as Node's own `fs.rmSync` semantics for
// that option), with the same linear backoff (`retryDelay * attempt
// number`) Node's own built-in mechanism used, so the worst-case total
// added wait is the same 100+200+300+400+500 = 1500 ms 3R already
// justified against the 60s/180s test-file timeouts -- only WHO runs that
// backoff changed (this function, not `fs.rmSync`), not the budget. The
// wait itself (`sleepMs` below) uses `Atomics.wait`, not a busy
// `while (Date.now() < ...)` spin -- Node's main thread permits a
// synchronous `Atomics.wait` (unlike a browser main thread), and a
// throwaway `Int32Array`/`SharedArrayBuffer` is all it needs; nothing in
// this file does other work during that wait, so a spin would only burn
// CPU for no benefit.
const CLEANUP_RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

function sleepMs(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeSyntheticTarget(
  base,
  { maxRetries = 5, retryDelay = 100, rmSyncImpl = rmSync } = {},
) {
  let attempt = 0;
  for (;;) {
    try {
      // Only recursive/force -- no maxRetries/retryDelay forwarded, see
      // the header comment above on why this wrapper stopped delegating.
      rmSyncImpl(base, { recursive: true, force: true });
      return;
    } catch (err) {
      attempt += 1;
      // ⛔not retryable, or retry budget exhausted -- re-throw as-is, never
      // swallowed (ⓒ 반대 방향 칸 below, both directions).
      if (!CLEANUP_RETRYABLE_CODES.has(err.code) || attempt > maxRetries) {
        throw err;
      }
      sleepMs(retryDelay * attempt);
    }
  }
}

// Same ambient-env stripping as install-g1-adapter-list.test.mjs's
// ledgerIsolatedEnv (duplicated, same non-coupling convention) -- both the
// admission-ledger env keys (a floating value from the invoking shell must
// not leak into the child) and NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (this
// file is itself running under `node --test`; without stripping these, the
// installed target's own child `node --test` sees itself as a "recursive"
// call and silently skips running -- a false "0 failures" that is actually
// "0 tests ran at all").
function isolatedEnv() {
  const env = { ...process.env };
  delete env.ADMISSION_LEDGER_PATH;
  delete env.ADMISSION_LOCK_PATH;
  delete env.DISPATCH_RECEIPT_PATH;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

// Non-recursive listing under each of the three installed script roots --
// mirrors isolated-suite-runner.mjs's own TEST_DIRS shape (scripts/check,
// scripts/relay, scripts/relay/adapters, scripts/supervisor) minus the
// adapters entry (this installer never copies scripts/relay/adapters/*,
// see INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS's own header) -- just the two
// directories this installer actually populates with `.test.mjs` files.
const INSTALLED_TEST_DIRS = ["scripts/check", "scripts/relay"];

function collectInstalledTestFiles(targetRepoPath) {
  const files = [];
  for (const dir of INSTALLED_TEST_DIRS) {
    const abs = path.join(targetRepoPath, ...dir.split("/"));
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
      if (statSync(path.join(abs, name)).isFile()) {
        files.push(`${dir}/${name}`);
      }
    }
  }
  return files;
}

// HYK-209-net-closure-timeout-1 ⓐ 실측(이 자식 하나를 node --test로 직접
// 돌려 쟀다, N=3 한가 / N=5 부하): 한가할 때 38928/38677/39454 ms. 부하
// 중(isolated-suite-runner.mjs가 이 24코어 머신에서 실제로 쓰는
// resolveConcurrency() = floor(24/2) = 12와 같은 동시성으로 다른 .test.mjs
// 12개를 같이 돌리며 측정) 끝까지 완주시킨 두 번은 95975 ms, 139124 ms --
// 둘 다 지금 고정된 60000 ms보다 길다(나머지 세 번은 90000 ms 외부 래퍼에
// 막혀 완주 못 함 1회, 59533 ms, 38416 ms -- 부하 lane이 꺼져가던 끝자락).
// 이 자식(relay-handshake-g1-dispatch-check.test.mjs) 자신은 내부에 node
// --test 하위 일꾼을 띄우지 않는다(execFileSync로 CLI만 호출, 동시성 값
// 없음, 소스 확인) -- 그래서 ⓐ 후보(HARNESS_TEST_CONCURRENCY를
// --test-concurrency로 전달)는 이 호출 모양에서 할 일이 없다: 이 spawnSync는
// 이미 파일 1개만 돌리므로 node --test에는 병렬화할 형제 파일이 없다.
// 택한 수리(ⓑ): isolated-suite-runner.mjs가 실제 전체 러너 호출마다
// 무조건 심어주는 신호(NESTED_CONCURRENCY_ENV_VAR = "HARNESS_TEST_CONCURRENCY",
// 그 파일 132/558행 -- 이 파일을 포함해 그 러너가 동시에 돌리는 모든 형제
// 파일의 process.env에 그 가중치 값이 박힌다, 이 파일 자신도 그 TEST_DIRS의
// "templates/harness-init" 아래라 예외가 아니다)가 있으면 "지금 부하가 걸릴
// 수 있는 real 전체 러너 안"이라는 뜻이므로 더 긴, 그래도 유한한 시한을
// 쓴다; 없으면(이 파일을 단독으로 돌릴 때, 위 한가 측정과 같은 모양) 원래
// 60000 ms를 그대로 쓴다 -- 이 라운드가 문제를 재현하지 못한 경로의 동작은
// 바꾸지 않는다. 리터럴 "HARNESS_TEST_CONCURRENCY"는 isolated-suite-
// runner.mjs에서 import하지 않고 그대로 중복 적는다(이 파일 자신의
// isolatedEnv() 헤더가 이미 쓰는 이 저장소의 consumer/producer 비결합
// 관례와 같음).
// HYK-464 H7b-r4 (책임자 판정 2026-10-24 23:45 §2 ⓑ⑵): 60000 ms was already
// too tight even in the "standalone, no artificial load" shape this constant
// is meant to cover -- 검토 1R 실측(REVIEW-r1.md §4) = 평시 단독 61.4초, 이
// 라운드 자신의 재실측(〔직접〕, 이 워크트리에서 relay-handshake-g1-dispatch-
// check.test.mjs를 node --test로 직접 4회 연속 실행, 인위적 부하 0, ambient
// free 3401~3555MB): 62920 / 61219 / 64766 / 68201 ms (최대 68201 ms, 측정
// 시각은 결과 파일 §2 ⓑ 표에 값으로). 새 값 = 그 최대 실측값의 1.3배 이상,
// 깨끗한 수 하나로 올림: 68201 * 1.3 = 88661.3 -> 90000 ms. 근거 배수(1.3배)는
// 이 파일 자신의 UNDER_FULL_RUNNER_TIMEOUT_MS 선택(아래, 1.29배)과 같은
// 자릿수 -- 이 라운드가 새로 발명한 배수가 아니다. 상한: 90000 ms는 여전히
// UNDER_FULL_RUNNER_TIMEOUT_MS(180000 ms)의 절반이라 "표준 단독 시한이 부하
// 재시도 시한을 넘어선다" 역전이 생기지 않는다(⛔무한대 금지 · ⛔근거 없는
// 큰 값 금지 모두 충족).
const STANDALONE_TIMEOUT_MS = 90000;
// UNDER_FULL_RUNNER_TIMEOUT_MS (180000 ms, 실측 최대 완주값 139124 ms의
// 1.29배 이상) and LOAD_RETRY_FREE_THRESHOLD_MB (3,072 MB) now both live in
// the shared gate module (install-retry-gate.mjs, imported above) -- HYK-464
// H7c moved them there so this file and install-g1-adapter-list.test.mjs
// share the exact same retry ceiling and free-memory threshold rather than
// each keeping its own copy that could silently drift.

// measureLoadOnTimeout (H7b, free-memory-only) moved into the shared
// install-retry-gate.mjs as measureFreeMemSignal, now one of three signals
// evaluateRetryGate combines (HYK-464 H7c) -- see that module's own header.

// 부하 신호(HARNESS_TEST_CONCURRENCY)가 유효한 양의 정수로 있으면 더 긴
// 유한 시한, 없거나 값이 깨졌으면 원래 시한 -- isolated-suite-runner.mjs의
// resolveNestedConcurrency와 같은 "결정 실패 시 원래 동작으로" 규칙.
function resolveInstalledTestTimeoutMs(env) {
  const raw = env.HARNESS_TEST_CONCURRENCY;
  if (raw == null || raw === "") return STANDALONE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return STANDALONE_TIMEOUT_MS;
  return UNDER_FULL_RUNNER_TIMEOUT_MS;
}

// HYK-464 H7b (책임자 판정 2026-10-24 07:45 §2 ⓑ): "부하 탓 시한 초과"와
// "자식이 진짜로 멈춤"을 가르는 신호. 선택한 방향 = "시한을 부하 보정"
// (지시서가 허용하는 두 방향 중 하나) -- freemem 임계값으로 자기 신고하는
// 대신, 첫 시도가 타임아웃이면 "이미 이 파일 안에 있는, 이미 실측으로
// 근거를 둔" UNDER_FULL_RUNNER_TIMEOUT_MS(180000ms) 한도로 정확히 1회만
// 재시도한다(child-probe-timeout-policy.mjs의 RETRY_ON_TIMEOUT=1과 같은
// 정책 -- "무응답에서만, 정확히 1회만", import하지 않고 이 파일 314행
// 근처 관례대로 독립적으로 둔다). ⛔무조건 상향 금지: 재시도 한도가
// 이미 존재하는 180000ms(실측 최대 완주값의 1.29배, 319행 근거)를 절대
// 넘지 않는다 -- 새 숫자를 발명하지 않는다.
//
// 이 설계가 freemem 임계값보다 더 안전한 이유(〔직접〕 이 워크트리
// 반복 실측): 이 머신의 ambient free는 2.2~2.9GB로, 부하를 전혀 더하지
// 않아도 이미 "저메모리" 선 근방/미달이다(다른 병렬 좌석들의 실제
// 메모리 사용 때문 -- parallel_rule). freemem 임계값 하나로 판정했다면
// 진짜로 멈추는 자식도 "부하 탓"으로 잘못 자기 신고될 위험이 있었다
// (§2ⓒ가 금지하는 거짓 초록). 재시도는 그 위험이 없다: 진짜로 멈추는
// 합성 자식은 재시도에서도 결정론적으로 다시 타임아웃되어 그대로 RED로
// 떨어지고(아래, ⛔시한 초과를 통과로 삼키기 금지), 부하 탓으로 한 번
// 늦었을 뿐인 자식만 연장된 한도 안에서 실제로 끝나 정상 판정을 받는다.
//
// isSpawnTimeout also moved into install-retry-gate.mjs (shared, imported
// above) -- result.error.code === "ETIMEDOUT" detection is identical for
// both call sites, no reason to keep two copies.

// One `node --test` child per file -- unambiguous per-file pass/fail
// attribution (see this file's own header for why over one combined run).
// `timeoutMs` override: test-only escape hatch (ⓒ 반대 방향 칸이 180000 ms
// 짜리 진짜 시한을 기다리지 않고도 "시한을 넘으면 ETIMEDOUT으로 잡힌다"는
// 메커니즘 자체를 빠르게 검증하게 한다) -- 382행의 실제 생산 호출은 이
// 옵션을 넘기지 않으므로 거기선 항상 resolveInstalledTestTimeoutMs의 실제
// 판단이 그대로 쓰인다.
// `spawnSync` 옵션(HYK-209-net-closure-timeout-1-r2, 검토 1R P2-1 수리):
// 마찬가지로 테스트 전용 주입 지점이다 -- 기본값이 진짜 node:child_process의
// spawnSync라서 382행의 실제 생산 호출(이 옵션도 넘기지 않음)은 동작이 전혀
// 바뀌지 않는다. 아래 "timeout ⓑ fix" 칸이 이 지점으로 가짜 spawnSync를
// 꽂아, 실제로 생성되는 자식 프로세스 없이 "우회 인자 없이 부르면 그 호출의
// timeout 옵션이 resolveInstalledTestTimeoutMs(env)와 같다"는 생산 결선
// 자체를 구조로 단언한다(env 주입만으로는 결정값 숫자가 맞는지 이 파일이
// 그 계산을 또 베껴야 해서 대신 호출 인자를 직접 가로챈다).
function runOneInstalledTestFile(
  targetRepoPath,
  rel,
  { timeoutMs, spawnSync: spawnSyncImpl = spawnSync } = {},
) {
  const env = isolatedEnv();
  return spawnSyncImpl(
    process.execPath,
    ["--test", "--test-reporter=tap", rel],
    {
      cwd: targetRepoPath,
      encoding: "utf8",
      env,
      timeout: timeoutMs ?? resolveInstalledTestTimeoutMs(env),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

// HYK-464 H7c (coder-task.md §2ⓐ, 공용 게이트 함수): the retry DECISION
// itself (first attempt -> ETIMEDOUT? -> evaluate 3 signals -> open on ANY
// one -> at most 1 retry) now lives in install-retry-gate.mjs's
// attemptWithRetryGate, shared verbatim with install-g1-adapter-list.test
// .mjs's own wrapper (see that file). This function keeps only what is
// genuinely LOCAL to this file: the two spawnSync call shapes (first
// attempt at resolveInstalledTestTimeoutMs(env)'s own decision, retry at
// the shared UNDER_FULL_RUNNER_TIMEOUT_MS ceiling -- both still via
// runOneInstalledTestFile, unchanged call shape).
//
// Extracted into its own function (rather than left inline in the main test
// below) SOLELY so this round's own unit tests further down can drive it
// with a fake spawnSync AND a fake freememImpl/env/countNodeProcesses -- a
// real child never actually spawns and no real memory/CPU pressure is
// needed, so the gated-retry branching is verified in milliseconds, not by
// waiting out a real 60s/180s/180s timeout under real machine load.
//
// `result.error === undefined` on the retry is the ONLY signal read as
// "load-caused, not a real defect" -- a genuinely-hanging installed test
// (synthetic `setInterval`-forever shape, see this file's own ⓒ unit test
// above runOneInstalledTestFile's sibling tests) times out AGAIN on the
// retry just as deterministically as on the first attempt, so `result`
// returned here is still an ETIMEDOUT error and the caller's unchanged hard
// assertion on `result.error` still goes RED (⛔시한 초과를 통과로 삼키기
// 금지) -- retrying never becomes a way to pass a real hang.
function runInstalledTestFileWithLoadRetry(
  targetRepoPath,
  rel,
  {
    spawnSync: spawnSyncImpl = spawnSync,
    freemem,
    env,
    countNodeProcesses,
  } = {},
) {
  return attemptWithRetryGate(
    () =>
      runOneInstalledTestFile(targetRepoPath, rel, {
        spawnSync: spawnSyncImpl,
      }),
    () =>
      runOneInstalledTestFile(targetRepoPath, rel, {
        timeoutMs: UNDER_FULL_RUNNER_TIMEOUT_MS,
        spawnSync: spawnSyncImpl,
      }),
    { freemem, env, countNodeProcesses },
  );
}

test("install-net-closure: every INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS entry names a file this installer actually ships (no stale exception for a file that was removed/renamed)", () => {
  for (const { file } of INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS) {
    assert.match(
      file,
      /^scripts\/(check|relay)\/[A-Za-z0-9._-]+\.test\.mjs$/,
      `exception entry '${file}' is not a scripts/check or scripts/relay .test.mjs path -- this test's own file collection would never find it`,
    );
  }
});

// HYK-209-install-closure-1 2R P2-3 (검토 1R 지적 -- 예외가 "파일 단위"면 그
// 파일 안의 새 실패가 안 보인다): INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS의 모든
// 항목이 이제 `expectedFailCount`를 가진다는 것 자체를 강제한다 -- 새 예외를
// 추가하면서 이 필드를 깜빡하면 그 항목은 다시 "파일 단위" 뒷문이 된다.
test("install-net-closure: every INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS entry declares expectedFailCount (no new 'whole-file' exception without a fixed failure count, P2-3)", () => {
  for (const entry of INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS) {
    assert.equal(
      typeof entry.expectedFailCount,
      "number",
      `exception entry '${entry.file}' has no numeric expectedFailCount -- P2-3 requires every exception to fix a failure count, not just a file name`,
    );
  }
});

// HYK-209 H4-2 (⑭, H41-P3-c, REVIEW-r2.md(H4-1) §3 P3-c): the old single
// first-match regex could be hijacked by a subtest printing its own "fail
// N"-shaped line (which node's tap reporter escapes to column 0 as
// "# fail N", same leak mechanism as runner-receipt-writer.mjs's
// parseTapSummaryCounts / this round's ⑦⑧) if one ever appeared before the
// real top-level summary. Read the LAST complete tests->pass->fail->skipped
// block instead (same shape as parseTapSummaryCounts, duplicated here --
// coder-task.md §2 ⑭/⑦ "공통 모듈 신설 없이 각 파일"), with the same
// truncated-tail guard (a dangling orphan "# tests N" after the last
// complete block means 판정 불가, not "use the block before it").
const TAP_SKIPPABLE_FIELD_LINE =
  "(?:# (?:suites|cancelled|todo) \\d+|# duration_ms [\\d.]+)\\r?\\n";
const LAST_TAP_FAIL_BLOCK_RE = new RegExp(
  "^# tests \\d+\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# pass \\d+\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# fail (\\d+)\\r?\\n" +
    `(?:${TAP_SKIPPABLE_FIELD_LINE})*?` +
    "# skipped \\d+\\r?$",
  "gm",
);
function parseTapFailCount(tapText) {
  const t = tapText ?? "";
  const blocks = [...t.matchAll(LAST_TAP_FAIL_BLOCK_RE)];
  if (blocks.length === 0) return null;
  const last = blocks[blocks.length - 1];
  const tail = t.slice(last.index + last[0].length);
  if (/^# tests \d+/m.test(tail)) return null;
  return Number(last[1]);
}

function notOkLines(tapText) {
  return (tapText ?? "").split(/\r?\n/).filter((l) => /^not ok \d+ /.test(l));
}

test("parseTapFailCount mutation guard (⑭, H41-P3-c): a subtest leaking its own 'fail 0'-shaped line (escaped to '# fail 0' by node's tap reporter) before the real top-level summary must not be read as the real fail count", () => {
  const leakedFakeFailLineFirst =
    "# Subtest: a prior subtest whose own console output happens to look like a summary\n" +
    "ok 1 - a prior subtest whose own console output happens to look like a summary\n" +
    "# fail 0\n" +
    "1..1\n" +
    "# tests 1\n" +
    "# suites 0\n" +
    "# pass 0\n" +
    "# fail 1\n" +
    "# cancelled 0\n" +
    "# skipped 0\n" +
    "# todo 0\n" +
    "# duration_ms 12.3\n";
  assert.equal(
    parseTapFailCount(leakedFakeFailLineFirst),
    1,
    "expected the LAST complete block's fail count (1, the real failure), not the leaked fake '# fail 0' line that happens to appear earlier in the output",
  );
});

// HYK-209-install-closure-1 2R P2-3: checks one exception entry's own fixed
// expectations against a real failing run's actual TAP/stderr text. Returns
// a (possibly empty) array of human-readable mismatch descriptions -- a
// non-empty result means this exception no longer matches its real shape
// and must NOT be silently absorbed (extracted out of the main test below
// purely to keep that test's own complexity/line-count under this repo's
// quality gate, same reasoning as runIsolatedSuite's own small extractions).
function exceptionShapeMismatches(entry, result) {
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const mismatches = [];
  const actualFailCount = parseTapFailCount(result.stdout);
  if (
    typeof entry.expectedFailCount === "number" &&
    actualFailCount !== entry.expectedFailCount
  ) {
    mismatches.push(
      `expectedFailCount=${entry.expectedFailCount} but TAP's own '# fail N' line says ${actualFailCount}`,
    );
  }
  if (entry.expectedMissingAdapterFile) {
    // The ERR_MODULE_NOT_FOUND message's path separator comes out as "/" or
    // an escaped "\\\\" depending on OS/node version (실측,
    // probe-exceptions.mjs) -- match on the bare filename inside the
    // "Cannot find module '...'" line instead of pinning the full path shape.
    const escaped = entry.expectedMissingAdapterFile.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    const re = new RegExp(`Cannot find module '[^']*${escaped}'`);
    if (!re.test(combined)) {
      mismatches.push(
        `expectedMissingAdapterFile '${entry.expectedMissingAdapterFile}' not found in a "Cannot find module '...'" line -- the missing module changed`,
      );
    }
  }
  if (entry.expectedFailingSubtestTitles) {
    const lines = notOkLines(result.stdout);
    for (const title of entry.expectedFailingSubtestTitles) {
      const matchingLines = lines.filter((l) => l.includes(title));
      if (matchingLines.length !== 1) {
        mismatches.push(
          `expected exactly one 'not ok' line containing '${title}', found ${matchingLines.length}`,
        );
      }
    }
  }
  return mismatches;
}

// HYK-464 H7c (P2-2 수리, REVIEW-r2.md §7 원문 "고친다면 단언 문구에
// measuredNoLoad 값을 넣는 쪽"): H7b-r4's version pushed its diagnostic
// evidence into arrays the MAIN TEST's loop only read AFTER the loop fully
// finished -- but the very next line's hard `assert.equal(result.error,
// undefined, ...)` throws immediately on ANY unretried ETIMEDOUT, which
// unwinds out of the loop before it ever reaches that post-loop code. So
// the old post-loop t.diagnostic() calls were unreachable exactly when
// they would have mattered most (a real timeout). Fixed here by passing
// `t` in and calling t.diagnostic() with the full retry-gate reading
// (formatRetryGateDiagnostic) RIGHT HERE, before the assertion that can
// throw -- this line always runs whenever a first-attempt ETIMEDOUT
// occurred (gate !== null), retried or not, pass or fail.
function classifyInstalledTestFileRun(t, targetRepo, rel, exceptionsByFile) {
  const { result, gate, retried } = runInstalledTestFileWithLoadRetry(
    targetRepo,
    rel,
  );
  if (gate) {
    t.diagnostic(formatRetryGateDiagnostic({ rel, gate, retried }));
  }
  assert.equal(
    result.error,
    undefined,
    `spawnSync itself failed running ${rel}${gate ? ` (retry-gate opened=${gate.opened}, openedBy=${JSON.stringify(gate.openedBy)}, retried=${retried})` : ""} -- error: ${result.error?.message}, signal: ${result.signal}, status: ${result.status}`,
  );
  if (result.status === 0) {
    return { gate, retried, outcome: "passed" };
  }
  const entry = exceptionsByFile.get(rel);
  if (!entry) {
    return {
      gate,
      retried,
      outcome: "unexpected",
      tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500),
    };
  }
  const mismatches = exceptionShapeMismatches(entry, result);
  if (mismatches.length > 0) {
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return {
      gate,
      retried,
      outcome: "unexpected",
      tail: `exception '${rel}' no longer matches its fixed shape (P2-3):\n${mismatches.join("\n")}\n\n${combined.slice(-1500)}`,
    };
  }
  return { gate, retried, outcome: "exception-matched" };
}

test("install-net-closure: real installer -> real git target -> every installed .test.mjs actually RUNS (not just imports) with 0 failures, except the named, reasoned exceptions", (t) => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-install-net-");
  try {
    runRealInstall(base, targetRepo);
    commitInstalledTree(targetRepo);
    const files = collectInstalledTestFiles(targetRepo);
    // Fail-closed (same posture as isolated-suite-runner.mjs's
    // collectTestFiles): if the installer's own output shape changes such
    // that nothing is found here, that is this test finding NOTHING to
    // check, not proof everything passed.
    assert.ok(
      files.length >= 40,
      `expected at least 40 installed .test.mjs files (sanity floor against a broken collection, got ${files.length}): ${files.join(", ")}`,
    );

    const exceptionsByFile = new Map(
      INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS.map((e) => [e.file, e]),
    );
    const unexpectedFailures = [];
    const exceptionsSeen = new Set();
    // HYK-464 H7c (P2-2 수리): per-file retry-gate diagnostics are now
    // emitted INSIDE classifyInstalledTestFileRun, immediately after the
    // gate is evaluated and before the hard assertion that can throw (see
    // that function's own header) -- reachable even when a later file in
    // this same loop has an unretried ETIMEDOUT and the loop never reaches
    // this point. retriedCount/gateOpenedCount below are purely an
    // end-of-run informational summary (only reachable on a fully green
    // loop, which is fine -- it adds nothing a reader needs when the run
    // already failed and threw with its own diagnostic line attached).
    let gateOpenedCount = 0;
    let retriedCount = 0;
    // HYK-209-install-closure-1 2R P2-3: a shape mismatch against the
    // exception's own fixed expectations (fail count changed, a new/missing
    // subtest, a different missing module) is pushed into unexpectedFailures
    // too -- it is NOT silently absorbed just because the file name matches.
    for (const rel of files) {
      const { gate, retried, outcome, tail } = classifyInstalledTestFileRun(
        t,
        targetRepo,
        rel,
        exceptionsByFile,
      );
      if (gate?.opened) gateOpenedCount += 1;
      if (retried) retriedCount += 1;
      if (outcome === "unexpected") {
        unexpectedFailures.push({ rel, tail });
      } else if (outcome === "exception-matched") {
        exceptionsSeen.add(rel);
      }
    }

    // Purely informational end-of-run summary -- the retry's own real
    // result already flowed through the normal pass/fail bookkeeping above
    // (per-file diagnostics already fired inside the loop), so this never
    // changes what the assertions below decide.
    if (gateOpenedCount > 0) {
      t.diagnostic(
        `retry-gate summary (HYK-464 H7c): opened for ${gateOpenedCount} installed test file(s), ${retriedCount} resolved cleanly on the single retry (LOAD_RETRY_FREE_THRESHOLD_MB=${LOAD_RETRY_FREE_THRESHOLD_MB}, UNDER_FULL_RUNNER_TIMEOUT_MS=${UNDER_FULL_RUNNER_TIMEOUT_MS})`,
      );
    }

    assert.deepEqual(
      unexpectedFailures.map((f) => f.rel),
      [],
      `installed test file(s) failed that are NOT in INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS -- either fix the install list (ⓑ 편입) or add a reasoned exception:\n${unexpectedFailures
        .map((f) => `--- ${f.rel} ---\n${f.tail}`)
        .join("\n\n")}`,
    );
    // Every exception is real/still-reproducing -- an exception that
    // stopped failing (e.g. once the adapters layer is eventually
    // assembled) should be REMOVED from the list, not left as a stale
    // skip that quietly stops meaning anything.
    assert.deepEqual(
      [...exceptionsSeen].sort(),
      INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS.map((e) => e.file)
        .slice()
        .sort(),
      "every INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS entry must still actually fail on a fresh install -- an entry that now passes is stale and should be deleted from the list, not kept as a no-op skip",
    );
  } finally {
    removeSyntheticTarget(base);
  }
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1 ⓑ: resolveInstalledTestTimeoutMs's own
// decision table, unit-level (no real spawn -- just the env-reading logic
// above runOneInstalledTestFile).
// ---------------------------------------------------------------------------
test("install-net-closure timeout ⓑ (HYK-464 H7b-r4, STANDALONE_TIMEOUT_MS 재근거): resolveInstalledTestTimeoutMs returns the rebased 90000 ms when HARNESS_TEST_CONCURRENCY is absent/empty/invalid (standalone run)", () => {
  assert.equal(resolveInstalledTestTimeoutMs({}), STANDALONE_TIMEOUT_MS);
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "" }),
    STANDALONE_TIMEOUT_MS,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "not-a-number" }),
    STANDALONE_TIMEOUT_MS,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "0" }),
    STANDALONE_TIMEOUT_MS,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "-3" }),
    STANDALONE_TIMEOUT_MS,
  );
});

test("install-net-closure timeout ⓑ: resolveInstalledTestTimeoutMs returns the longer, still-finite 180000 ms when isolated-suite-runner.mjs's own concurrency signal is present (real full-runner shape)", () => {
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "12" }),
    180000,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "1" }),
    180000,
  );
  assert.ok(
    Number.isFinite(
      resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "24" }),
    ),
  );
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1 ⓒ 반대 방향 칸(필수): a synthetic installed
// test file that never finishes (endless setInterval -- never resolves,
// never calls node:test's own done/return) must still be caught by
// runOneInstalledTestFile's real spawnSync timeout path, not silently hang
// the whole suite. Probed on this platform first (coder.md 증거): Node's
// spawnSync({timeout}) kill on an infinite-loop child sets
// result.error.code === "ETIMEDOUT" (result.signal "SIGTERM", result.status
// null) -- asserted on that structural shape, not on any message text
// (HYK-262 posture, same as isolated-suite-runner.mjs's own classifier).
// Uses the `timeoutMs` test-only override (tiny, so this test itself stays
// fast) -- the mechanism under test (spawnSync's own `timeout` option
// actually kills a real hung child) is identical regardless of which
// finite number is passed; only resolveInstalledTestTimeoutMs's own choice
// of THAT number is covered separately above.
// ---------------------------------------------------------------------------
test("install-net-closure ⓒ: a truly-hung installed test file (infinite setInterval) is still caught as ETIMEDOUT by the real runOneInstalledTestFile path after the ⓑ fix (detection not traded away for throughput)", () => {
  const base = mkdtempSync(
    path.join(longFormTmpdir(), "hyk209-install-net-hang-"),
  );
  try {
    const checkDir = path.join(base, "scripts", "check");
    mkdirSync(checkDir, { recursive: true });
    const hangFile = "scripts/check/hyk209-synthetic-hang.test.mjs";
    writeFileSync(
      path.join(base, hangFile),
      // Never resolves, never lets `node --test` reach a completion line --
      // the exact "really hung, not just slow" shape ⓓ below also exercises.
      "setInterval(() => {}, 1000);\n",
      "utf8",
    );
    const startedAtMs = Date.now();
    const result = runOneInstalledTestFile(base, hangFile, { timeoutMs: 2000 });
    const elapsedMs = Date.now() - startedAtMs;
    assert.equal(
      result.error?.code,
      "ETIMEDOUT",
      `expected spawnSync's own timeout kill (result.error.code === "ETIMEDOUT"), got: ${JSON.stringify({ error: result.error && { code: result.error.code, message: result.error.message }, signal: result.signal, status: result.status })}`,
    );
    // HYK-209-net-closure-timeout-1-r5: `status` itself is platform-shaped,
    // not a fixed value -- on Windows a timeout-killed spawnSync reports
    // status === null (verified on this platform, this round's coder.md
    // §2 ⓐ). On Linux (CI, run 765 log, 책임자 판독), spawnSync's own
    // `timeout` kill sends SIGTERM to the immediate child (`node --test`)
    // only; that child's process then reports back to ITS parent with a
    // real POSIX exit status (observed: 1) instead of null. Both shapes are
    // "this spawnSync call did not report a clean exit" -- accept either,
    // without branching on process.platform: a clean `status === 0` would
    // mean the child actually finished normally, which contradicts a real
    // timeout kill on any OS, so excluding exactly that value (rather than
    // allow-listing POSIX exit codes under a platform check) is both
    // simpler and already covers the "ETIMEDOUT + 0" regression ⑶ below on
    // every platform, not just POSIX ones.
    assert.ok(
      result.status === null ||
        (typeof result.status === "number" && result.status !== 0),
      `expected a timeout-killed spawnSync to report status === null or a non-zero exit code, not a clean 0 (platform: ${process.platform}, status: ${JSON.stringify(result.status)}, signal: ${JSON.stringify(result.signal)}, killed: ${JSON.stringify(result.killed)})`,
    );
    assert.ok(
      elapsedMs < 10000,
      `expected the kill to land close to the 2000 ms override, not hang indefinitely (got ${elapsedMs} ms)`,
    );
  } finally {
    removeSyntheticTarget(base);
  }
});

// ---------------------------------------------------------------------------
// HYK-464 H7c (§2ⓓ, coder-task.md): runInstalledTestFileWithLoadRetry's own
// decision table through the SHARED install-retry-gate.mjs, driven with a
// fake spawnSync AND fake freemem/env/countNodeProcesses (no real child, no
// real 60s/180s/180s wait, no real memory/CPU pressure) -- the real-install
// test further up this file already exercises the real spawnSync path end
// to end; these four cells pin the gated RETRY branching itself
// deterministically, in milliseconds: 신호 0 + ETIMEDOUT -> 재시도 0 · RED;
// 신호 1개(여기서는 free) + ETIMEDOUT -> 재시도 1 · 성공 시 진단; 재시도도
// ETIMEDOUT -> RED; ENOENT -> 재시도 0. The OTHER two signals
// (concurrency/nodeCount) are held at their own "측정 없음" default (no env
// var, fake countNodeProcesses returning a non-integer) throughout this
// block so only the free signal is actually driving these four cells --
// install-g1-adapter-list.test.mjs's own fake-spawn cells (§2ⓓ "두 칸
// 각각") exercise the concurrency/nodeCount signals in turn instead of
// duplicating all three combinations in both files.
// ---------------------------------------------------------------------------
function noSignalGateOpts(overrides = {}) {
  return {
    env: {},
    countNodeProcesses: () => null,
    ...overrides,
  };
}

test("install-net-closure load-retry ⓑ⑶ (신호 0 + ETIMEDOUT): a first-attempt ETIMEDOUT with NO signal loaded does not retry at all, and the caller still sees the original ETIMEDOUT (RED) -- a bare timeout is read as a real hang, not load", () => {
  let calls = 0;
  const fakeSpawn = () => {
    calls += 1;
    return {
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      signal: "SIGTERM",
      status: null,
      stdout: "",
      stderr: "",
    };
  };
  const { result, gate, retried } = runInstalledTestFileWithLoadRetry(
    "/fake/target",
    "scripts/check/fake-no-load.test.mjs",
    noSignalGateOpts({
      spawnSync: fakeSpawn,
      freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    }),
  );
  assert.equal(
    calls,
    1,
    "a first-attempt ETIMEDOUT with no signal loaded must NOT trigger a retry",
  );
  assert.equal(
    gate.opened,
    false,
    "no signal was loaded -- gate must stay closed",
  );
  assert.equal(retried, false);
  assert.equal(result.error?.code, "ETIMEDOUT");
  const freeSignal = gate.signals.find((s) => s.signal === "free");
  assert.equal(freeSignal.measured, true);
  assert.equal(freeSignal.value, LOAD_RETRY_FREE_THRESHOLD_MB + 1000);
  assert.equal(freeSignal.loaded, false);
});

test("install-net-closure load-retry ⓑ⑶ (free 신호 + ETIMEDOUT): a first-attempt ETIMEDOUT WITH the free signal loaded (on the spot, below the threshold) retries exactly once, and a clean retry is reported with the CALLER seeing the retry's own result", () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push(opts.timeout);
    if (calls.length === 1) {
      return {
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        signal: "SIGTERM",
        status: null,
        stdout: "",
        stderr: "",
      };
    }
    return {
      error: undefined,
      signal: null,
      status: 0,
      stdout: "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n",
      stderr: "",
    };
  };
  const { result, gate, retried } = runInstalledTestFileWithLoadRetry(
    "/fake/target",
    "scripts/check/fake.test.mjs",
    noSignalGateOpts({
      spawnSync: fakeSpawn,
      freemem: () => 777 * 1024 * 1024,
    }),
  );
  assert.equal(
    calls.length,
    2,
    "expected exactly 2 spawn calls (first attempt + exactly 1 retry)",
  );
  assert.equal(
    calls[1],
    UNDER_FULL_RUNNER_TIMEOUT_MS,
    `expected the retry's own timeout option to be the existing, already-reasoned UNDER_FULL_RUNNER_TIMEOUT_MS (${UNDER_FULL_RUNNER_TIMEOUT_MS}), not a new number`,
  );
  assert.equal(
    result.error,
    undefined,
    "expected the retry's clean result to be what the caller sees",
  );
  assert.equal(result.status, 0);
  assert.equal(gate.opened, true);
  assert.deepEqual(gate.openedBy, ["free"]);
  assert.equal(retried, true);
  const freeSignal = gate.signals.find((s) => s.signal === "free");
  assert.equal(freeSignal.value, 777);
});

test("install-net-closure load-retry ⓑ⑶ (재시도도 ETIMEDOUT, 거짓 초록 금지): a loaded signal opens the retry, but a SECOND ETIMEDOUT on that retry (the genuinely-hung-child shape) is NOT swallowed -- the caller still sees an ETIMEDOUT result", () => {
  let calls = 0;
  const fakeSpawn = () => {
    calls += 1;
    return {
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      signal: "SIGTERM",
      status: null,
      stdout: "",
      stderr: "",
    };
  };
  const { result, gate, retried } = runInstalledTestFileWithLoadRetry(
    "/fake/target",
    "scripts/check/fake-hang.test.mjs",
    noSignalGateOpts({
      spawnSync: fakeSpawn,
      freemem: () => 500 * 1024 * 1024,
    }),
  );
  assert.equal(
    calls,
    2,
    "expected exactly 2 spawn calls -- a loaded-signal hang gets ONE retry, never more (bounded)",
  );
  assert.equal(gate.opened, true);
  assert.equal(
    retried,
    false,
    "a persistent timeout on the retry must NOT be reported as retried:true",
  );
  assert.equal(
    result.error?.code,
    "ETIMEDOUT",
    "the caller's own hard assertion on result.error must still see ETIMEDOUT -- a real hang is never swallowed as a pass (⛔시한 초과를 통과로 삼키기 금지)",
  );
});

test("install-net-closure load-retry ⓑ⑶ (ENOENT): a non-timeout spawn error is never retried, regardless of any loaded signal -- only ETIMEDOUT triggers the retry-gate path at all", () => {
  let calls = 0;
  const fakeSpawn = () => {
    calls += 1;
    return {
      error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
      signal: null,
      status: null,
      stdout: "",
      stderr: "",
    };
  };
  const { result, gate, retried } = runInstalledTestFileWithLoadRetry(
    "/fake/target",
    "scripts/check/fake-enoent.test.mjs",
    noSignalGateOpts({
      spawnSync: fakeSpawn,
      freemem: () => 500 * 1024 * 1024,
    }),
  );
  assert.equal(
    calls,
    1,
    "a non-timeout spawn failure must not trigger a retry at all, even with a loaded signal",
  );
  assert.equal(
    gate,
    null,
    "no ETIMEDOUT occurred -- the gate must never even be evaluated",
  );
  assert.equal(retried, false);
  assert.equal(result.error?.code, "ENOENT");
});

// ---------------------------------------------------------------------------
// HYK-464 H7c (§2ⓐ): measureFreeMemSignal's own decision table, unit-level
// (no spawn at all -- just the freemem-reading logic, now in
// install-retry-gate.mjs and imported above). Kept here (rather than moved
// wholesale into a shared test file) because product_scope limits this
// round's new files to the one support module, not a shared *test* file.
// ---------------------------------------------------------------------------
test("install-net-closure measureFreeMemSignal: free memory at/above the threshold is measured, not loaded", () => {
  assert.deepEqual(
    measureFreeMemSignal(
      () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1) * 1024 * 1024,
    ),
    {
      signal: "free",
      measured: true,
      value: LOAD_RETRY_FREE_THRESHOLD_MB + 1,
      thresholdDesc: `<${LOAD_RETRY_FREE_THRESHOLD_MB}`,
      loaded: false,
    },
  );
});

test("install-net-closure measureFreeMemSignal: free memory below the threshold is measured AND loaded", () => {
  assert.deepEqual(
    measureFreeMemSignal(
      () => (LOAD_RETRY_FREE_THRESHOLD_MB - 1) * 1024 * 1024,
    ),
    {
      signal: "free",
      measured: true,
      value: LOAD_RETRY_FREE_THRESHOLD_MB - 1,
      thresholdDesc: `<${LOAD_RETRY_FREE_THRESHOLD_MB}`,
      loaded: true,
    },
  );
});

test("install-net-closure measureFreeMemSignal (측정 실패 = 측정 없음): a throwing freememImpl is measured:false, never loaded", () => {
  assert.deepEqual(
    measureFreeMemSignal(() => {
      throw new Error("no such metric on this platform");
    }),
    { signal: "free", measured: false },
  );
});

// ---------------------------------------------------------------------------
// HYK-464 H7c (§2ⓐ ⑵⑶, 신규 신호): evaluateRetryGate's own OR-combination
// across all three signals, unit-level -- each cell below holds the OTHER
// two signals at "측정 없음"/"넉넉함" so exactly one signal is doing the
// work, proving each one independently opens the gate (same shape as the
// mutation table's ⑴⑵⑶ rows below, but as a permanent regression test
// rather than a one-off in-place mutation).
// ---------------------------------------------------------------------------
test("install-net-closure evaluateRetryGate: concurrency signal alone (>= threshold) opens the gate", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    env: { HARNESS_TEST_CONCURRENCY: "12" },
    countNodeProcesses: () => null,
  });
  assert.equal(gate.opened, true);
  assert.deepEqual(gate.openedBy, ["concurrency"]);
});

test("install-net-closure evaluateRetryGate: concurrency signal below threshold (standalone, concurrency=1) does NOT open the gate by itself", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    env: { HARNESS_TEST_CONCURRENCY: "1" },
    countNodeProcesses: () => null,
  });
  assert.equal(gate.opened, false);
});

test("install-net-closure evaluateRetryGate: a missing HARNESS_TEST_CONCURRENCY is measured:false, never read as loaded", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    env: {},
    countNodeProcesses: () => null,
  });
  const concurrencySignal = gate.signals.find(
    (s) => s.signal === "concurrency",
  );
  assert.equal(concurrencySignal.measured, false);
  assert.equal(gate.opened, false);
});

test("install-net-closure evaluateRetryGate: node-count signal alone (>= threshold) opens the gate", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    env: {},
    countNodeProcesses: () => 8,
  });
  assert.equal(gate.opened, true);
  assert.deepEqual(gate.openedBy, ["nodeCount"]);
});

test("install-net-closure evaluateRetryGate: node-count below threshold does NOT open the gate by itself", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    env: {},
    countNodeProcesses: () => 7,
  });
  assert.equal(gate.opened, false);
});

test("install-net-closure evaluateRetryGate: a non-integer node-count measurement (sampler failure) is measured:false, never loaded", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB + 1000) * 1024 * 1024,
    env: {},
    countNodeProcesses: () => null,
  });
  const nodeCountSignal = gate.signals.find((s) => s.signal === "nodeCount");
  assert.equal(nodeCountSignal.measured, false);
});

test("install-net-closure evaluateRetryGate: multiple signals loaded at once still open the gate exactly once, naming every signal that fired", () => {
  const gate = evaluateRetryGate({
    freemem: () => (LOAD_RETRY_FREE_THRESHOLD_MB - 1) * 1024 * 1024,
    env: { HARNESS_TEST_CONCURRENCY: "12" },
    countNodeProcesses: () => 9,
  });
  assert.equal(gate.opened, true);
  assert.deepEqual(gate.openedBy.sort(), ["concurrency", "free", "nodeCount"]);
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r2 (검토 1R P2-1 수리): the ⓒ cell above
// proves the spawnSync-timeout-kill MECHANISM works, but it calls through
// the `timeoutMs` test-only bypass -- it never proved that the real
// production call (382행, no bypass args) actually WIRES that mechanism to
// resolveInstalledTestTimeoutMs's own decision. Deleting the `??
// resolveInstalledTestTimeoutMs(env)` expression at runOneInstalledTestFile's
// own spawnSync call left every cell in this file green (검토 1R §2 ⓒ 표
// ⑴, reproduced again by this round's own coder.md §2 ⓐ) -- a silent
// regression would let a real full-runner lane wait the OS/CI's own
// unbounded default instead of a finite timeout. This cell closes that gap
// without waiting out a real 60s/180s timer: it injects a fake `spawnSync`
// (see that option's own comment above) and asserts the INTERCEPTED call's
// `timeout` option, not a value this test recomputes by hand.
// ---------------------------------------------------------------------------
test("install-net-closure timeout ⓑ fix (P2-1): calling runOneInstalledTestFile WITHOUT the timeoutMs bypass (the real 382행 call shape) wires spawnSync's real timeout option to resolveInstalledTestTimeoutMs(env)'s own decision", () => {
  function captureSpawnOptsUnder(envOverrides) {
    const priorValues = {};
    for (const key of Object.keys(envOverrides))
      priorValues[key] = process.env[key];
    for (const [key, value] of Object.entries(envOverrides))
      process.env[key] = value;
    let capturedOpts;
    try {
      const fakeSpawnSync = (_cmd, _args, opts) => {
        capturedOpts = opts;
        return { status: 0, error: undefined, stdout: "", stderr: "" };
      };
      runOneInstalledTestFile(
        "unused-targetRepoPath",
        "scripts/check/does-not-matter.test.mjs",
        { spawnSync: fakeSpawnSync },
      );
    } finally {
      for (const [key, prior] of Object.entries(priorValues)) {
        if (prior === undefined) delete process.env[key];
        else process.env[key] = prior;
      }
    }
    return capturedOpts;
  }

  const standaloneOpts = captureSpawnOptsUnder({
    HARNESS_TEST_CONCURRENCY: "",
  });
  assert.ok(
    standaloneOpts,
    "fakeSpawnSync was never invoked -- runOneInstalledTestFile is not honoring the injected spawnSync option",
  );
  assert.equal(
    standaloneOpts.timeout,
    resolveInstalledTestTimeoutMs(standaloneOpts.env),
    "no-bypass call must pass resolveInstalledTestTimeoutMs(env) as spawnSync's own timeout option (HARNESS_TEST_CONCURRENCY absent)",
  );
  assert.equal(standaloneOpts.timeout, STANDALONE_TIMEOUT_MS);

  const fullRunnerOpts = captureSpawnOptsUnder({
    HARNESS_TEST_CONCURRENCY: "12",
  });
  assert.ok(
    fullRunnerOpts,
    "fakeSpawnSync was never invoked -- runOneInstalledTestFile is not honoring the injected spawnSync option (full-runner case)",
  );
  assert.equal(
    fullRunnerOpts.timeout,
    resolveInstalledTestTimeoutMs(fullRunnerOpts.env),
    "no-bypass call must pass resolveInstalledTestTimeoutMs(env) as spawnSync's own timeout option (HARNESS_TEST_CONCURRENCY=12, full-runner shape)",
  );
  assert.equal(fullRunnerOpts.timeout, 180000);
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r3 ⓑ: the P2-1 fix cell above proves
// `runOneInstalledTestFile` WIRES its `timeoutMs`/`spawnSync` bypass
// options correctly WHEN GIVEN -- but it calls the function directly with
// its own fabricated args, never through the real production call site
// inside the main test's loop above. Nothing before this round asserted
// THAT call site itself passes none of those bypass args -- a mutation
// appending `{ timeoutMs: 0 }` there left the whole file 10/10 green
// (coder.md §1 ⓐ 실측, 복원 sha256 confirmed unchanged after). This cell
// closes that gap with a source-text assertion.
//
// HYK-464 H7b: the real production call site moved one level up, onto the
// new load-retry wrapper (§2 ⓑ) that now sits between the main loop and
// the lower-level spawnSync caller -- the check below moved with it, onto
// that new real call site. A second check closes the gap this move itself
// could have silently opened: the wrapper's own two internal calls into
// the lower-level function must each forward its own real-by-default
// executor parameter verbatim, never a different, hardcoded one --
// otherwise the wrapper itself could quietly stop running real children
// while the outer call site still looks bare and untouched. (Deliberately
// not quoting either call's literal source text here, same reasoning as
// the original cell below: this comment must never become a spurious
// match against its own source-text scan.)
// 한계 〔직접〕: this is a source-STRING check, not
// a runtime one -- it would miss a mutation that keeps the call site text
// untouched but changes behavior through an entirely different path (e.g.
// redefining an imported binding itself, or editing
// `resolveInstalledTestTimeoutMs`'s own body). The first of those is
// covered structurally by the P2-1 fix cell's own spawnSync interception
// (above) and by this round's own load-retry unit tests; this repo's own
// `quality-check`/review gates, not this test file, are what stand against
// an import-rebinding mutation.
// ---------------------------------------------------------------------------
test("install-net-closure timeout ⓑ binding (r3): the real production call site passes no timeout-overriding arguments to the load-retry wrapper, and the wrapper never swaps in a non-real executor internally (source-text assertion, P2-1 companion)", () => {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const wrapperCallSiteArgs = [
    ...src.matchAll(/runInstalledTestFileWithLoadRetry\(([^)]*)\)/g),
  ].map((m) => m[1].replace(/\s+/g, " ").replace(/,\s*$/, "").trim());
  const productionCallSites = wrapperCallSiteArgs.filter(
    (args) => args === "targetRepo, rel",
  );
  assert.equal(
    productionCallSites.length,
    1,
    `expected exactly one production call site calling runInstalledTestFileWithLoadRetry with its two bare positional args and no extra/overriding options object, found ${productionCallSites.length} (all call sites seen: ${JSON.stringify(wrapperCallSiteArgs)})`,
  );
  const innerCallSiteArgs = [
    ...src.matchAll(/(?<!function )runOneInstalledTestFile\(([^)]*)\)/gs),
  ].map((m) => m[1].replace(/\s+/g, " ").trim());
  const wrapperInnerCalls = innerCallSiteArgs.filter((args) =>
    args.includes("spawnSync: spawnSyncImpl"),
  );
  assert.equal(
    wrapperInnerCalls.length,
    2,
    `expected exactly 2 runOneInstalledTestFile call sites inside the wrapper (first attempt + exactly one retry), each forwarding spawnSyncImpl (the wrapper's own real-by-default parameter) verbatim -- never a different, hardcoded executor -- found ${wrapperInnerCalls.length} (all runOneInstalledTestFile call sites seen: ${JSON.stringify(innerCallSiteArgs)})`,
  );
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r4 ⓑ: removeSyntheticTarget no longer
// forwards maxRetries/retryDelay to the real rmSync call (r3 did -- see the
// header comment above on why that stopped meaning anything on Node 26).
// `rmSyncImpl` injection (same shape as `runOneInstalledTestFile`'s
// `spawnSync` option) lets this cell assert the real call's options
// without touching the filesystem.
// ---------------------------------------------------------------------------
test("install-net-closure cleanup ⓑ: removeSyntheticTarget calls the real rmSync with only recursive/force (no maxRetries/retryDelay -- retry is this wrapper's own JS loop now, not delegated to fs.rmSync)", () => {
  let capturedOpts;
  removeSyntheticTarget("unused-base-path", {
    rmSyncImpl: (_targetPath, opts) => {
      capturedOpts = opts;
    },
  });
  assert.ok(capturedOpts, "rmSyncImpl was never invoked");
  assert.deepEqual(
    capturedOpts,
    { recursive: true, force: true },
    "the underlying rmSync call must receive exactly {recursive, force} -- maxRetries/retryDelay must NOT be forwarded, r4's whole point is that fs.rmSync's own built-in retry is no longer relied on",
  );
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r4 ⓑ: the JS-level retry actually retries a
// transient, whitelisted failure (EBUSY here, same posture as the real
// lock's ⓓ cell below) and succeeds once the underlying call stops failing
// -- proves the loop is live, not just present in source. retryDelay is
// overridden small (this cell's own point is "does it retry", not "is the
// default wait exactly 100ms" -- that is covered by the reverse ⑴ cell
// below, which uses the true defaults).
// ---------------------------------------------------------------------------
test("install-net-closure cleanup ⓑ: removeSyntheticTarget retries a transient EBUSY failure and returns normally once a later attempt succeeds", () => {
  let calls = 0;
  const failTwiceThenSucceed = () => {
    calls += 1;
    if (calls <= 2) {
      const err = new Error(
        "EBUSY, resource busy or locked: synthetic rmSync injection (transient)",
      );
      err.code = "EBUSY";
      throw err;
    }
  };
  removeSyntheticTarget("unused-base-path", {
    retryDelay: 5,
    rmSyncImpl: failTwiceThenSucceed,
  });
  assert.equal(
    calls,
    3,
    "expected 2 failing attempts followed by 1 succeeding attempt (3 total calls)",
  );
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r4 ⓒ 반대 방향 칸 ⑴ (필수, r3의 calls===1
// 단언을 새 재시도와 맞게 바꿈 -- 바꾼 이유: r3는 "Node의 fs.rmSync 자체
// maxRetries 루프"가 전부였으므로 이 래퍼는 정확히 1번만 불렸어야 정상이었다
// (재시도 자체가 Node 내부에 있었다); r4는 재시도 루프 자체가 이 함수 안
// JS로 옮겨왔으므로, 영구히 재시도-대상 코드로 실패하는 경우 이제 이
// 함수가 maxRetries+1번(기본값 6회: 최초 1회 + 재시도 5회, Node의 기존
// maxRetries 옵션과 같은 의미)까지 직접 불러야 정상이다): a cleanup
// failure that survives every retry (a permanently-locked target, error
// code EPERM -- still in the retryable set) must still THROW the last
// failure, not be silently absorbed, AND must have actually exhausted the
// real default retry budget (maxRetries=5, retryDelay=100 defaults, not
// overridden here -- this is the one cell that pins those literal default
// values).
// ---------------------------------------------------------------------------
test("install-net-closure cleanup ⓒ reverse ⑴: a permanently-failing, retryable (EPERM) cleanup exhausts the default retry budget (6 calls) then still throws, not swallowed", () => {
  let calls = 0;
  const alwaysThrowingRmSync = () => {
    calls += 1;
    const err = new Error(
      "EPERM, Permission denied: synthetic rmSync injection (always fails)",
    );
    err.code = "EPERM";
    throw err;
  };
  const startedAtMs = Date.now();
  assert.throws(
    () =>
      removeSyntheticTarget("unused-base-path", {
        rmSyncImpl: alwaysThrowingRmSync,
      }),
    /EPERM/,
    "removeSyntheticTarget must propagate a permanent cleanup failure, not swallow it",
  );
  const elapsedMs = Date.now() - startedAtMs;
  assert.equal(
    calls,
    6,
    "default maxRetries=5 means 1 initial attempt + 5 retries = 6 total calls to rmSyncImpl before giving up",
  );
  assert.ok(
    elapsedMs >= 1400,
    `expected the default linear backoff (100+200+300+400+500 = 1500 ms) to have actually elapsed before giving up, got ${elapsedMs} ms`,
  );
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r4 ⓒ 반대 방향 칸 ⑵ (필수, 신규): a
// NON-retryable error code (anything outside EPERM/EBUSY/ENOTEMPTY -- here
// EACCES, a real/permanent permission problem, not a transient lock) must
// throw on the very first attempt, with zero retry wait -- retrying a code
// that retrying can never fix would just add latency for nothing.
// ---------------------------------------------------------------------------
test("install-net-closure cleanup ⓒ reverse ⑵: a non-retryable error code (EACCES) throws immediately on the first attempt, no retry", () => {
  let calls = 0;
  const alwaysThrowingWrongCode = () => {
    calls += 1;
    const err = new Error(
      "EACCES, permission denied: synthetic rmSync injection (not in the retryable set)",
    );
    err.code = "EACCES";
    throw err;
  };
  const startedAtMs = Date.now();
  assert.throws(
    () =>
      removeSyntheticTarget("unused-base-path", {
        rmSyncImpl: alwaysThrowingWrongCode,
      }),
    /EACCES/,
    "removeSyntheticTarget must propagate a non-retryable failure immediately",
  );
  const elapsedMs = Date.now() - startedAtMs;
  assert.equal(
    calls,
    1,
    "a non-retryable error code must not be retried at all -- exactly 1 call",
  );
  assert.ok(
    elapsedMs < 200,
    `expected no retry wait for a non-retryable code, got ${elapsedMs} ms`,
  );
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1-r4 ⓓ (필수, Windows 전용 실제 잠금 칸,
// 가짜 rmSync 금지): a REAL open file handle (a live pwsh child holding
// FileShare.None, same acquisition method as review-3R's own
// lockprobe.mjs/lockprobe2.mjs, read-only here) held just long enough to
// require more than one real rmSync attempt, then released well inside the
// default retry budget (held 400 ms < worst-case 1500 ms budget) -- proves
// the real production retry loop (real `rmSync`, no injection at all) rides
// out a real transient Windows lock end to end. Linux/macOS skip, reasoned
// (open fds there do not block unlink -- this cell would not be exercising
// real contention, review-3R's own posture for not attempting a portable
// version of this probe).
// ---------------------------------------------------------------------------
function holdRealWindowsFileLock(filePath, holdMs) {
  const ps = `$f=[System.IO.File]::Open('${filePath}','Open','Read','None'); Write-Output LOCKED; Start-Sleep -Milliseconds ${holdMs}; $f.Close()`;
  const child = spawn("pwsh", ["-NoProfile", "-Command", ps], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("LOCKED")) resolve(child);
    });
  });
}

test(
  "install-net-closure ⓓ (Windows only): removeSyntheticTarget's real rmSync call rides out a real, transient open-handle Windows file lock",
  {
    skip:
      process.platform === "win32"
        ? false
        : "실제 파일 잠금은 Windows 전용 의미론(FileShare.None 열린 핸들이 rmSync의 삭제를 막음) -- Linux/macOS 에서는 열린 fd가 있어도 unlink가 막히지 않아 이 칸이 재현하는 경합 자체가 생기지 않는다(review-3R lockprobe 실측과 같은 posture, 이 라운드는 포터블화를 시도하지 않는다)",
  },
  async () => {
    const base = mkdtempSync(
      path.join(longFormTmpdir(), "hyk209-install-net-lock-"),
    );
    const lockedFile = path.join(base, "held.txt");
    writeFileSync(lockedFile, "x");
    const lockHolder = await holdRealWindowsFileLock(lockedFile, 400);
    try {
      const startedAtMs = Date.now();
      // No rmSyncImpl override -- this is the real production call shape.
      removeSyntheticTarget(base);
      const elapsedMs = Date.now() - startedAtMs;
      assert.equal(
        existsSync(base),
        false,
        "the locked target must actually be gone once the real retry loop rides out the lock",
      );
      assert.ok(
        elapsedMs >= 250,
        `expected at least one real retry wait before the 400 ms lock released (not an instant pass-through), got ${elapsedMs} ms`,
      );
      assert.ok(
        elapsedMs < 1500,
        `expected the lock to be ridden out well inside the default worst-case 1500 ms retry budget, got ${elapsedMs} ms`,
      );
    } finally {
      await new Promise((resolve) => lockHolder.on("exit", resolve));
    }
  },
);

// ---------------------------------------------------------------------------
// HYK-209 §2 ⓒ: installAdmissionLedgerPointer's lockPath must match the
// dispatch pipeline's own live convention (installer-lockpath-defect.md,
// 2026-08-12), not the `${ledgerPath}.lock` derivation that produced
// "...admission-ledger.json.lock" instead of "...admission-ledger.lock".
// ---------------------------------------------------------------------------
test("install-net-closure ⓒ: a real install's admission-ledger-path.json pointer names lockPath as a sibling 'admission-ledger.lock' file (not '<ledgerPath>.lock')", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-install-net-c-");
  try {
    runRealInstall(base, targetRepo);
    const pointerPath = path.join(
      targetRepo,
      ".harness",
      "admission-ledger-path.json",
    );
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    assert.equal(
      path.posix.basename(pointer.lockPath),
      "admission-ledger.lock",
      `expected lockPath's own filename to be exactly "admission-ledger.lock" (the dispatch-worker.ps1 convention), got: ${pointer.lockPath}`,
    );
    assert.equal(
      path.posix.dirname(pointer.lockPath),
      path.posix.dirname(pointer.ledgerPath),
      `expected lockPath and ledgerPath to live in the same control-room directory; lockPath=${pointer.lockPath} ledgerPath=${pointer.ledgerPath}`,
    );
  } finally {
    removeSyntheticTarget(base);
  }
});

// ---------------------------------------------------------------------------
// HYK-209 §2 ⓓ: an "archive install" -- REPO_ROOT (this installer's own
// source location) is NOT a git checkout, the shape a tarball/zip
// extraction produces. Before this round: `git -C REPO_ROOT rev-parse HEAD`
// leaked its failing stderr ("fatal: not a git repository ...") straight to
// this process's own stderr, AND the update manifest's `installer` field
// silently became `null` -- indistinguishable from "never even tried".
// ---------------------------------------------------------------------------

// A non-git copy of just enough of this repo for install.mjs to run against
// a target with --update-mismatched (which is the only path that calls
// writeUpdateManifest at all). cpSync (no .git -- genuinely not a checkout).
function makeArchiveCopy(base) {
  const archiveDir = path.join(base, "archive-copy");
  mkdirSync(archiveDir, { recursive: true });
  for (const dir of ["templates", "scripts", "hooks"]) {
    cpSync(path.join(REPO_ROOT, dir), path.join(archiveDir, dir), {
      recursive: true,
    });
  }
  return path.join(archiveDir, "templates", "harness-init", "install.mjs");
}

test("install-net-closure ⓓ: an archive install (REPO_ROOT not a git checkout) leaks no 'fatal:' line to stderr, and the update manifest's installer field is a non-null, explicit '미상(...)' string", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-install-net-d-");
  try {
    // A real install first (so there is at least one installed file to
    // mismatch below -- writeUpdateManifest only runs on a real mismatch +
    // --update-mismatched).
    runRealInstall(base, targetRepo);
    const archiveInstallerPath = makeArchiveCopy(base);
    // Confirm the archive copy really is not a git checkout -- otherwise
    // this test would not be exercising the ⓓ code path at all.
    // HYK-209-install-closure-1 2R P3-1 (검토 1R 지적): `git -C <path>`의
    // <path>는 디렉터리여야 한다 -- 1R은 여기에 install.mjs "파일 경로"를
    // 넘겼고, 그러면 git은 그 자체가 디렉터리가 아니라서 "진짜 git
    // 저장소인가"와 무관하게 항상 비영(非零)으로 끝난다(헛단언, 항상
    // 통과). archiveInstallerPath의 디렉터리로 바꿔야 실제로 "그 디렉터리가
    // git 저장소 밖인가"를 검사한다.
    const probe = spawnSync(
      "git",
      ["-C", path.dirname(archiveInstallerPath), "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    );
    assert.notEqual(
      probe.status,
      0,
      "archive copy must NOT be a git checkout for this test to mean anything",
    );

    const mismatchedFile = path.join(
      targetRepo,
      "scripts",
      "check",
      "role-guard.mjs",
    );
    writeFileSync(
      mismatchedFile,
      readFileSync(mismatchedFile, "utf8") + "\n// deliberate mismatch\n",
      "utf8",
    );

    const result = spawnSync(
      "node",
      [
        archiveInstallerPath,
        ...installerArgsFor(base, targetRepo),
        "--update-mismatched",
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `archive install should still succeed; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(
      !(result.stderr ?? "").includes("fatal:"),
      `no raw 'fatal:' line should leak to stderr; got:\n${result.stderr}`,
    );

    const manifestFiles = readdirSync(path.join(targetRepo, ".harness")).filter(
      (f) => f.startsWith("install-update-") && f.endsWith(".json"),
    );
    assert.ok(
      manifestFiles.length >= 1,
      "expected at least one install-update-*.manifest.json to have been written",
    );
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          targetRepo,
          ".harness",
          manifestFiles[manifestFiles.length - 1],
        ),
        "utf8",
      ),
    );
    assert.notEqual(
      manifest.installer,
      null,
      "manifest.installer must not be null on an archive install",
    );
    assert.match(
      manifest.installer,
      /^미상\(/,
      `expected an explicit "미상(...)" string, got: ${JSON.stringify(manifest.installer)}`,
    );
  } finally {
    removeSyntheticTarget(base);
  }
});

// ---------------------------------------------------------------------------
// HYK-209-install-closure-1 2R P2-2 (검토 1R 지적 -- relay-handshake.mjs가
// BY PATH로 spawn하는 형제 파일은 install-copylist-closure.test.mjs의 정적
// import-closure 정규식이 원래부터 못 보는 종류다; abort-record-writer.mjs
// 편입을 지키는 칸이 1R에는 전혀 없었다, V5 변이가 그물을 그냥 통과했다):
// 그 형제 목록을 손으로 적지 않고 relay-handshake.mjs 소스에서 직접 뽑아,
// ENFORCEMENT_CHECK_FILES에 전부 있는지 단언한다 -- 목록과 코드가 갈라지면
// (새 BY-PATH spawn이 추가되거나, 이 다섯 중 하나가 install 목록에서
// 빠지면) 이 칸이 RED가 된다.
// ---------------------------------------------------------------------------

// relay-handshake.mjs의 모든 BY-PATH spawn 호출이 공유하는 모양(이 파일
// 안에서 실측 확인, 다섯 곳 전부 동일): `join(dirname(fileURLToPath(new
// URL(import.meta.url))), "<이름>.mjs")`. 정적 import가 아니라 이 모양으로
// 조립된 경로만 relay-handshake.mjs 자신이 "스폰되는 형제"로 취급한다.
// HYK-209 H4-2 (⑬, H41-P3-b 한계 기록, 동작 변경 0, REVIEW-r2.md(H4-1) §3
// P3-b): 이 모양 1개·대상 파일 1개(relay-handshake.mjs)로 한정된다 -- 지금은
// 8/8 경로 조립이 이 모양이라 빠진 것이 0이지만, 앞으로 다른 조립 모양
// (예: `new URL("./x.mjs", import.meta.url)`)이나 다른 생산 파일에서
// BY-PATH spawn이 생기면 이 칸은 그것을 보지 못한다(열린 집합 -- 닫혔다고
// 간주하지 않는다).
const BY_PATH_SIBLING_SPAWN_RE =
  /join\(\s*dirname\(fileURLToPath\(new URL\(import\.meta\.url\)\)\),\s*\n?\s*["']([A-Za-z0-9_.-]+\.mjs)["'],?\s*\n?\s*\)/g;

function extractByPathSiblings(relayHandshakeSource) {
  const found = new Set();
  let m;
  BY_PATH_SIBLING_SPAWN_RE.lastIndex = 0;
  while ((m = BY_PATH_SIBLING_SPAWN_RE.exec(relayHandshakeSource))) {
    found.add(m[1]);
  }
  return [...found].sort();
}

test("install-net-closure P2-2: every sibling file relay-handshake.mjs spawns BY PATH (source-extracted, not a hand-written list) is present in ENFORCEMENT_CHECK_FILES", () => {
  const src = readFileSync(
    path.join(REPO_ROOT, "scripts", "check", "relay-handshake.mjs"),
    "utf8",
  );
  const siblings = extractByPathSiblings(src);
  // Sanity floor (같은 posture as collectInstalledTestFiles above): if the
  // extraction regex ever stops matching anything (relay-handshake.mjs's own
  // spawn-path shape changes), this test must fail LOUD, not silently pass
  // with an empty list.
  assert.ok(
    siblings.length >= 5,
    `expected at least 5 BY-PATH-spawned siblings extracted from relay-handshake.mjs (got ${siblings.length}: ${siblings.join(", ")}) -- the extraction regex may be stale`,
  );
  const installed = new Set(ENFORCEMENT_CHECK_FILES);
  const missing = siblings.filter((name) => !installed.has(name));
  assert.deepEqual(
    missing,
    [],
    `relay-handshake.mjs spawns these sibling file(s) BY PATH but they are not in ENFORCEMENT_CHECK_FILES: ${missing.join(", ")} -- either install them (편입) or spell out a reasoned exception`,
  );
});
