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
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
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
const STANDALONE_TIMEOUT_MS = 60000;
// 180000 ms: 실측 최대 완주값(139124 ms)의 1.29배 이상, 한가 평균
// (~39020 ms)의 4.6배 이상 -- 값을 올렸을 뿐 무한대는 아니다(⛔무한대 금지).
const UNDER_FULL_RUNNER_TIMEOUT_MS = 180000;

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

function parseTapFailCount(tapText) {
  const m = /^# fail (\d+)\r?$/m.exec(tapText ?? "");
  return m ? Number(m[1]) : null;
}

function notOkLines(tapText) {
  return (tapText ?? "").split(/\r?\n/).filter((l) => /^not ok \d+ /.test(l));
}

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

test("install-net-closure: real installer -> real git target -> every installed .test.mjs actually RUNS (not just imports) with 0 failures, except the named, reasoned exceptions", () => {
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
    // HYK-209-install-closure-1 2R P2-3: a shape mismatch against the
    // exception's own fixed expectations (fail count changed, a new/missing
    // subtest, a different missing module) is pushed into unexpectedFailures
    // too -- it is NOT silently absorbed just because the file name matches.
    for (const rel of files) {
      const result = runOneInstalledTestFile(targetRepo, rel);
      assert.equal(
        result.error,
        undefined,
        `spawnSync itself failed running ${rel} -- error: ${result.error?.message}, signal: ${result.signal}, status: ${result.status}`,
      );
      const passed = result.status === 0;
      if (passed) continue;
      const entry = exceptionsByFile.get(rel);
      if (!entry) {
        unexpectedFailures.push({
          rel,
          tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500),
        });
        continue;
      }
      const mismatches = exceptionShapeMismatches(entry, result);
      if (mismatches.length > 0) {
        const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        unexpectedFailures.push({
          rel,
          tail: `exception '${rel}' no longer matches its fixed shape (P2-3):\n${mismatches.join("\n")}\n\n${combined.slice(-1500)}`,
        });
        continue;
      }
      exceptionsSeen.add(rel);
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
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-209-net-closure-timeout-1 ⓑ: resolveInstalledTestTimeoutMs's own
// decision table, unit-level (no real spawn -- just the env-reading logic
// above runOneInstalledTestFile).
// ---------------------------------------------------------------------------
test("install-net-closure timeout ⓑ: resolveInstalledTestTimeoutMs returns the original 60000 ms when HARNESS_TEST_CONCURRENCY is absent/empty/invalid (standalone run, unchanged behavior)", () => {
  assert.equal(resolveInstalledTestTimeoutMs({}), 60000);
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "" }),
    60000,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "not-a-number" }),
    60000,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "0" }),
    60000,
  );
  assert.equal(
    resolveInstalledTestTimeoutMs({ HARNESS_TEST_CONCURRENCY: "-3" }),
    60000,
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
    assert.equal(
      result.status,
      null,
      "a timeout-killed spawnSync must not also report a real exit status",
    );
    assert.ok(
      elapsedMs < 10000,
      `expected the kill to land close to the 2000 ms override, not hang indefinitely (got ${elapsedMs} ms)`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
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
  assert.equal(standaloneOpts.timeout, 60000);

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
    rmSync(base, { recursive: true, force: true });
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
    rmSync(base, { recursive: true, force: true });
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
