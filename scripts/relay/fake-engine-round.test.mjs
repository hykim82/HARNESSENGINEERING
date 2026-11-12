// HYK-153-fake-engine-1 (coder-task.md §2, piece C of HYK-153, on top of
// piece D's engine->adapter registry). Proves the end of PM's five-line
// summary: registering a fake engine in a COPIED config is enough to make
// the repository's own entry point (run-step.mjs's runStepCli) pick a
// synthetic relay adapter that drives a real CODER->REVIEW round through
// the real production consumption path (checkRelayHandshake's full check
// list, admission return, consumption-receipt write, reject-streak record)
// -- receipts land, and the real global ledger/control-room state is
// untouched.
//
// ⛔ Every ledger/lock/dispatch-receipt path this file uses is a mkdtemp
// fixture. This file never writes to the real admission ledger, the real
// dispatch-receipts.jsonl, this worktree's own real `.harness/`, or the
// live `scripts/check/engine-profiles.json` -- it only ever makes a BYTE
// COPY of the live config (adding one synthetic engine) and points
// HARNESS_ENGINE_PROFILES_PATH at that copy.
//
// ⛔ Static import discipline (coder-task.md §2 product_scope ⓘⓘ): this
// file never statically imports run-step.mjs, engine-adapter-registry.mjs,
// or ../check/engine-profile.mjs -- all three are reached only through
// `await import(...)` AFTER HARNESS_ENGINE_PROFILES_PATH is set (see
// before() below), so the env injection genuinely drives which config
// engine-profile.mjs's module-level DEFAULT_CONFIG_PATH captures. The first
// of the three "정적 단언" tests below asserts this textually against this
// file's own source.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter as PATH_DELIMITER } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";
import { runDispatchReceiptCli } from "./dispatch-receipt-cli.mjs";
import { scanForOrcaExecCalls } from "../check/orca-cli-boundary.mjs";
import { fingerprintDir } from "../check/live-harness-fingerprint.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
const RELAY_DIR = dirname(THIS_FILE);
const REPO_ROOT = execSync("git rev-parse --show-toplevel", {
  cwd: RELAY_DIR,
  encoding: "utf8",
}).trim();
const RUN_STEP_PATH = join(RELAY_DIR, "run-step.mjs");
const ADAPTER_PATH = join(
  RELAY_DIR,
  "adapters",
  "fake-engine-relay-adapter.mjs",
);
const LIVE_ENGINE_PROFILES_PATH = join(
  REPO_ROOT,
  "scripts",
  "check",
  "engine-profiles.json",
);
const FAKE_ADAPTER_MODULE_REL =
  "scripts/relay/adapters/fake-engine-relay-adapter.mjs";
const FAKE_ENGINE_NAME = "hyk153c-fake-0";

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
function sha256File(path) {
  return sha256Text(readFileSync(path, "utf8"));
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function uniqueTmpPath(prefix) {
  return join(tmpdir(), `${prefix}${randomBytes(6).toString("hex")}`);
}

function gitInit(dir) {
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "hyk153c-fake@example.invalid"', {
    cwd: dir,
  });
  execSync('git config user.name "hyk153c-fake"', { cwd: dir });
}

// dropped_at is minute precision (DROPPED_AT_RE/parseKstTimestamp,
// relay-handshake.mjs) -- "now - 2 minutes" clears both the future-skew
// gate and the +-9h timezone-mislabel heuristic.
function formatKstMinutes(ms) {
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${p(kst.getUTCMonth() + 1)}-${p(kst.getUTCDate())} ${p(
    kst.getUTCHours(),
  )}:${p(kst.getUTCMinutes())} KST`;
}

// §F (live_send_ban): a hard assertion that fires BEFORE the first child
// process of any round -- every ledger/lock/dispatch-receipt path this file
// ever points production code at must resolve under the OS tmpdir.
function assertUnderTmpdir(label, p) {
  const base = tmpdir();
  assert.ok(
    typeof p === "string" && p.startsWith(base),
    `refusing a non-tmpdir ${label} path: '${p}' (tmpdir='${base}')`,
  );
}

// ---------------------------------------------------------------------------
// Fixture: a synthetic main repo + two linked worktrees (CODER/REVIEW) + a
// synthetic admission ledger -- every one of these lives under mkdtemp.
// ---------------------------------------------------------------------------
function buildFixture() {
  const repo = tmpDir("hyk153c-repo-");
  gitInit(repo);
  mkdirSync(join(repo, ".harness"), { recursive: true });
  writeFileSync(
    join(repo, "README.md"),
    "hyk153c-fake-engine fixture\n",
    "utf8",
  );
  execSync("git add -A", { cwd: repo });
  execSync('git commit -q -m "hyk153c fixture base"', { cwd: repo });
  const baseCommit = execSync("git rev-parse HEAD", {
    cwd: repo,
    encoding: "utf8",
  }).trim();

  const cWt = uniqueTmpPath("hyk153c-cwt-");
  execFileSync("git", ["worktree", "add", "--detach", "-q", cWt, baseCommit], {
    cwd: repo,
  });
  mkdirSync(join(cWt, ".harness"), { recursive: true });

  const rWt = uniqueTmpPath("hyk153c-rwt-");
  execFileSync("git", ["worktree", "add", "--detach", "-q", rWt, baseCommit], {
    cwd: repo,
  });
  mkdirSync(join(rWt, ".harness"), { recursive: true });

  const ledgerDir = tmpDir("hyk153c-ledger-");
  const ledger = join(ledgerDir, "admission-ledger.json");
  const lock = join(ledgerDir, "admission-ledger.lock");
  const dispatchReceiptPath = join(ledgerDir, "dispatch-receipts.jsonl");
  for (const [label, p] of [
    ["ledger", ledger],
    ["lock", lock],
    ["dispatch-receipt", dispatchReceiptPath],
  ]) {
    assertUnderTmpdir(label, p);
  }
  const rc = runAdmissionCli([
    "init-cutover",
    "--ledger",
    ledger,
    "--lock",
    lock,
    "--live-seats",
    "[]",
  ]);
  assert.equal(rc, 0, "admission ledger init-cutover failed");

  return {
    repo,
    cWt,
    rWt,
    ledger,
    lock,
    dispatchReceiptPath,
    ledgerDir,
    baseCommit,
  };
}

function cleanupFixture(fx) {
  for (const wt of [fx.cWt, fx.rWt]) {
    try {
      execFileSync("git", ["worktree", "remove", "--force", wt], {
        cwd: fx.repo,
      });
    } catch {
      // best-effort -- the directory rmSync below still removes the files.
    }
  }
  for (const dir of [fx.repo, fx.cWt, fx.rWt, fx.ledgerDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function admit(fx, reservationId, role, seatKey) {
  const rc = runAdmissionCli([
    "admit",
    "--ledger",
    fx.ledger,
    "--lock",
    fx.lock,
    "--reservation-id",
    reservationId,
    "--cap",
    "5",
    "--role",
    role,
    "--seat-key",
    seatKey,
  ]);
  assert.equal(rc, 0, `admission admit failed for ${reservationId}`);
}

// The ONE production recorder (dispatch-receipt-cli.mjs's own
// runDispatchReceiptCli) writes the dispatch ledger line G1 cross-checks
// against, called in-process exactly as a CLI caller would (same argv
// shape, same stdin-shaped envelope) -- never a hand-assembled ledger line.
function recordDispatch(
  fx,
  { harnessDir, role, label, runtimeTaskId, dispatchId, paneKey },
) {
  const recordedAtMs = Date.now() - 60_000;
  const stdinText = JSON.stringify({
    result: {
      dispatch: {
        task_id: runtimeTaskId,
        id: dispatchId,
        assignee_pane_key: paneKey,
        dispatched_at: new Date(recordedAtMs - 5_000).toISOString(),
      },
    },
  });
  const result = runDispatchReceiptCli(
    [
      "--role",
      role,
      "--task-label",
      label,
      "--receipt-path",
      fx.dispatchReceiptPath,
    ],
    { stdinText, env: {}, nowFn: () => new Date(recordedAtMs) },
  );
  assert.equal(
    result.ok,
    true,
    `dispatch receipt recording failed: ${result.reason}`,
  );
  writeFileSync(
    join(harnessDir, "dispatch-receipt-path.txt"),
    fx.dispatchReceiptPath,
    "utf8",
  );
}

async function withEnvLedger(fx, asyncFn) {
  const overrides = {
    ADMISSION_LEDGER_PATH: fx.ledger,
    ADMISSION_LOCK_PATH: fx.lock,
    DISPATCH_RECEIPT_PATH: fx.dispatchReceiptPath,
  };
  const prior = {};
  for (const key of Object.keys(overrides)) prior[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await asyncFn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

async function withPrependedPath(extraDir, asyncFn) {
  const prior = process.env.PATH;
  process.env.PATH = `${extraDir}${PATH_DELIMITER}${prior ?? ""}`;
  try {
    return await asyncFn();
  } finally {
    process.env.PATH = prior;
  }
}

// HYK-153-fake-engine-2 (coder-task.md §2 product_scope ⓘ "새 주입 seam 0"):
// engine-adapter-registry.mjs no longer accepts any config/import-override
// opts seam, so a test that needs run-step.mjs's module-level
// DEFAULT_CONFIG_PATH to capture a DIFFERENT HARNESS_ENGINE_PROFILES_PATH
// than the one before() already froze into this process's cached
// engine-profile.mjs module (see this file's header -- the env var is only
// ever read once per process, at that module's first import) has no choice
// but a FRESH child process: this probe writes a tiny runner script to
// mkdtemp, spawns `node <runner>` with the desired
// HARNESS_ENGINE_PROFILES_PATH (and any other env overrides) already set
// at spawn time, and the runner's own dynamic import of run-step.mjs is the
// first (and only) time THAT process's engine-profile.mjs module loads --
// genuinely env-driven, not opts-injected. The runner's own execFn is a
// fixed literal (never parameterized from outside, so nothing needs to
// cross the process boundary as a function) that only records whether it
// was ever called -- in every cell this probe is used for, the registry is
// expected to refuse before relayStep ever reaches execFn selection.
function runStepProbe({ argv, env = {} }) {
  const runnerDir = tmpDir("hyk153c2-runstep-probe-");
  const runnerPath = join(runnerDir, "probe.mjs");
  const runStepHref = pathToFileURL(RUN_STEP_PATH).href;
  writeFileSync(
    runnerPath,
    [
      `const mod = await import(${JSON.stringify(runStepHref)});`,
      `let execFnCalled = false;`,
      `const result = await mod.runStepCli(JSON.parse(process.argv[2]), { execFn: () => { execFnCalled = true; return { ok: false, result: null }; } });`,
      `process.stdout.write(JSON.stringify({ ...result, execFnCalled }));`,
      "",
    ].join("\n"),
    "utf8",
  );
  try {
    const out = execFileSync(
      process.execPath,
      [runnerPath, JSON.stringify(argv)],
      { env: { ...process.env, ...env }, encoding: "utf8" },
    );
    return JSON.parse(out.trim());
  } finally {
    rmSync(runnerDir, { recursive: true, force: true });
  }
}

async function captureConsoleError(asyncFn) {
  const lines = [];
  const orig = console.error;
  console.error = (...args) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await asyncFn();
    return { result, lines };
  } finally {
    console.error = orig;
  }
}

// ---------------------------------------------------------------------------
// PATH shims: real executables named exactly "claude"/"codex"/"orca" (+ a
// Windows .cmd twin each) that would run if ANYTHING in this flow actually
// tried to spawn a real engine/orchestration CLI. Each writes a marker file
// and exits 97 -- after() asserts all three marker files are still absent.
// ---------------------------------------------------------------------------
function buildShims() {
  const shimDir = tmpDir("hyk153c-shim-");
  const markerDir = tmpDir("hyk153c-shim-marker-");
  for (const name of ["claude", "codex", "orca"]) {
    const markerPath = join(markerDir, `${name}.hit`).replace(/\\/g, "\\\\");
    writeFileSync(
      join(shimDir, `${name}.cmd`),
      `@echo off\r\necho hit > "${markerPath.replace(/\\\\/g, "\\")}"\r\nexit /b 97\r\n`,
      "utf8",
    );
    const posixPath = join(shimDir, name);
    writeFileSync(
      posixPath,
      `#!/bin/sh\necho hit > "${join(markerDir, `${name}.hit`)}"\nexit 97\n`,
      "utf8",
    );
    try {
      chmodSync(posixPath, 0o755);
    } catch {
      // chmod can no-op on some Windows filesystems -- the .cmd twin above
      // is the one that actually matters on this platform.
    }
  }
  return { shimDir, markerDir };
}

function buildFakeConfig({
  brokenModel = false,
  dropAdapterModule = false,
} = {}) {
  const parsed = JSON.parse(readFileSync(LIVE_ENGINE_PROFILES_PATH, "utf8"));
  parsed.engines[FAKE_ENGINE_NAME] = {
    deliveryMode: "inject",
    homeDirName: null,
    modelFamilyPatterns: {},
    agentMarkerWords: [],
    adapterModule: FAKE_ADAPTER_MODULE_REL,
  };
  // P1-2 D 교차 음성 칸 (coder-task.md §2 product_scope ⓘⓘⓘ): drop the
  // *required* adapterModule key itself -- engine-profile.mjs's schema
  // validation (validateEngines) rejects this at load time
  // (CONFIG_SCHEMA_INVALID), before engine-adapter-registry.mjs or
  // relayStep ever run, exactly like any other malformed config shape.
  if (dropAdapterModule) delete parsed.engines[FAKE_ENGINE_NAME].adapterModule;
  const roleProfile = {
    engine: FAKE_ENGINE_NAME,
    model: brokenModel ? " " : "fake-model-0",
    effort: "none",
  };
  parsed.roles = {
    ...parsed.roles,
    CODER: roleProfile,
    REVIEW: { ...roleProfile },
  };
  return parsed;
}

function writeFakeConfigCopy(dir, opts) {
  const path = join(dir, "engine-profiles.json");
  writeFileSync(path, JSON.stringify(buildFakeConfig(opts), null, 2), "utf8");
  return path;
}

function receiptsIn(harnessDir) {
  try {
    return readdirSync(join(harnessDir, "receipts"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Module-level fixtures shared by every test (before()/after()).
// ---------------------------------------------------------------------------
let runStepCli;
let shimDir;
let markerDir;
let fakeConfigPath;
let liveHarnessFingerprintBefore;
let liveConfigShaBefore;

const REAL_LEDGER_PATH = "D:\\문서관리\\하네스-관제실\\admission-ledger.json";
const REAL_DISPATCH_RECEIPTS_PATH =
  "D:\\문서관리\\하네스-관제실\\dispatch-receipts.jsonl";
const REAL_COMPLETION_FAILURES_PATH = `${REAL_LEDGER_PATH}.completion-failures.jsonl`;
// P2-2 (coder-task.md §2 product_scope ⓘⓘⓘⓘ 헛시험 수리): the real global
// reject-streak target is the MAIN repo's own .harness/, found via
// `git rev-parse --git-common-dir` -- NOT this linked worktree's own
// REPO_ROOT/.harness (which this worktree never populates, so comparing
// that path before/after was a vacuous null==null pass, review-1 P2-2).
const GIT_COMMON_DIR = execSync("git rev-parse --git-common-dir", {
  cwd: RELAY_DIR,
  encoding: "utf8",
}).trim();
const MAIN_REPO_ROOT = resolve(RELAY_DIR, dirname(GIT_COMMON_DIR));
const MAIN_REPO_REJECT_STREAK_PATH = join(
  MAIN_REPO_ROOT,
  ".harness",
  "reject-streak.json",
);

function readIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

before(async () => {
  liveHarnessFingerprintBefore = fingerprintDir(join(REPO_ROOT, ".harness"));
  liveConfigShaBefore = sha256File(LIVE_ENGINE_PROFILES_PATH);

  ({ shimDir, markerDir } = buildShims());

  const configDir = tmpDir("hyk153c-config-");
  fakeConfigPath = writeFakeConfigCopy(configDir, {});
  assertUnderTmpdir("engine-profiles-copy", fakeConfigPath);

  // §2 ⓘⓘ "주입" -- env set BEFORE the first (and, for this process, only
  // path-driven) dynamic import of run-step.mjs's static import closure,
  // which is what makes engine-profile.mjs's module-level
  // DEFAULT_CONFIG_PATH capture THIS path (see this file's header).
  process.env.HARNESS_ENGINE_PROFILES_PATH = fakeConfigPath;
  const runStepMod = await import(pathToFileURL(RUN_STEP_PATH).href);
  runStepCli = runStepMod.runStepCli;
});

after(() => {
  const liveHarnessFingerprintAfter = fingerprintDir(
    join(REPO_ROOT, ".harness"),
  );
  assert.equal(
    liveHarnessFingerprintAfter,
    liveHarnessFingerprintBefore,
    "live .harness/ fingerprint must be byte-identical before/after this file's run",
  );
  const liveConfigShaAfter = sha256File(LIVE_ENGINE_PROFILES_PATH);
  assert.equal(
    liveConfigShaAfter,
    liveConfigShaBefore,
    "live scripts/check/engine-profiles.json must never be written by this file",
  );
  for (const name of ["claude", "codex", "orca"]) {
    assert.equal(
      existsSync(join(markerDir, `${name}.hit`)),
      false,
      `'${name}' shim must never have been invoked -- no real engine/orchestration process was ever spawned`,
    );
  }
  rmSync(shimDir, { recursive: true, force: true });
  rmSync(markerDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 정적 단언 (≥3, coder-task.md §2 product_scope "정적 단언 ≥3")
// ---------------------------------------------------------------------------

test("정적 단언 ①: 이 시험 파일은 run-step.mjs/engine-adapter-registry.mjs/engine-profile.mjs를 정적으로 import하지 않는다", () => {
  const src = readFileSync(THIS_FILE, "utf8");
  const staticImportRe =
    /^import\b[^;]*from\s+["'][^"']*(run-step\.mjs|engine-adapter-registry\.mjs|check\/engine-profile\.mjs)["']/gm;
  const matches = [...src.matchAll(staticImportRe)];
  assert.deepEqual(
    matches.map((m) => m[0]),
    [],
    "static import of run-step.mjs/engine-adapter-registry.mjs/engine-profile.mjs found",
  );
});

test("정적 단언 ②: fake-engine-relay-adapter.mjs는 실 어댑터 모듈을 정적 import하지 않고, 가짜 엔진 이름 리터럴이 0회다", () => {
  const src = readFileSync(ADAPTER_PATH, "utf8");
  const staticImportRe =
    /^import\b[^;]*from\s+["'][^"']*(orca-adapter\.mjs|claude-adapter\.mjs|codex-adapter\.mjs|orca-relay-adapter\.mjs)["']/gm;
  assert.deepEqual(
    [...src.matchAll(staticImportRe)].map((m) => m[0]),
    [],
  );
  assert.equal(
    src.includes(FAKE_ENGINE_NAME),
    false,
    "the adapter source must never contain this test's own fake engine name literal",
  );
  assert.equal(
    src.includes("receipts/"),
    false,
    "the adapter must never reference the receipts/ directory itself -- only the production receipt writer does",
  );
});

test("정적 단언 ③: G9 스캐너(orca-cli-boundary.mjs의 scanForOrcaExecCalls)로 가짜 어댑터 원문을 직접 돌려도 위반 0", () => {
  const content = readFileSync(ADAPTER_PATH, "utf8");
  const violations = scanForOrcaExecCalls(
    [{ path: "scripts/relay/adapters/fake-engine-relay-adapter.mjs", content }],
    { legacyExempt: [] },
  );
  assert.deepEqual(violations, []);
});

// P2-2 (coder-task.md §2 product_scope ⓘⓘⓘⓘ 헛시험 수리, review-1
// REVIEW-r1.md §1 P2-2, review-2 REVIEW-r1.md §1 P1-A): a direct, permanent
// guard on the constant itself -- the real global reject-streak target
// MUST resolve under the main repo's own checkout (git-common-dir-resolved).
// review-2 found that comparing the raw (unresolved) strings is itself
// broken: on Windows a plain clone (main repo == work tree, exactly the
// runner/CI shape) makes MAIN_REPO_ROOT and REPO_ROOT the SAME directory,
// but one carries git's forward slashes and the other path.resolve's
// native backslashes, so the raw startsWith("must NOT be under REPO_ROOT")
// assertion passed only by separator-mismatch accident -- while on POSIX
// (no separator mismatch) the same raw comparison correctly saw they were
// equal and failed outright. Both paths are now normalized with
// path.resolve before comparing, and the two clone shapes get different
// assertions instead of one blanket "must differ" claim: when the main
// repo IS the work tree (plain clone/runner/CI) assert the target resolves
// under REPO_ROOT (positive branch, not skipped); only in a linked
// worktree (main repo != work tree) assert the target does NOT resolve
// under this worktree's own REPO_ROOT.
test("P2-2: MAIN_REPO_REJECT_STREAK_PATH resolves under the main repo's own checkout (git-common-dir) -- positively under REPO_ROOT in a plain clone/CI where main repo == work tree, and never under this worktree's own REPO_ROOT in a linked worktree where they differ", (t) => {
  const resolvedTarget = resolve(MAIN_REPO_REJECT_STREAK_PATH);
  const resolvedMainRepoRoot = resolve(MAIN_REPO_ROOT);
  const resolvedRepoRoot = resolve(REPO_ROOT);

  assert.ok(resolvedTarget.startsWith(resolvedMainRepoRoot), resolvedTarget);

  if (resolvedMainRepoRoot === resolvedRepoRoot) {
    t?.diagnostic(
      `plain-clone 분기: 본체(git-common-dir 기준, ${resolvedMainRepoRoot}) == 작업 트리(${resolvedRepoRoot}) -- 양성 단언`,
    );
    assert.ok(
      resolvedTarget.startsWith(resolvedRepoRoot),
      `plain clone/runner/CI 에서는 main repo == work tree 이므로 REPO_ROOT(${resolvedRepoRoot}) 밑에 있어야 한다: ${resolvedTarget}`,
    );
  } else {
    t?.diagnostic(
      `linked-worktree 분기: 본체(${resolvedMainRepoRoot}) != 작업 트리(${resolvedRepoRoot}) -- "다르다" 단언`,
    );
    assert.equal(
      resolvedTarget.startsWith(resolvedRepoRoot),
      false,
      `must NOT resolve under this linked worktree's own REPO_ROOT (${resolvedRepoRoot}) -- that is exactly review-1's P2-2 vacuous-pass bug`,
    );
  }
});

// ---------------------------------------------------------------------------
// 양성: CODER -> REVIEW 1라운드, 검사 끔 0.
//
// quality-check's max-lines-per-function ceiling splits this into one
// helper per round + one isolation-assertion helper -- no assertion dropped
// or reordered from a single inline flow, pure extraction.
// ---------------------------------------------------------------------------

function generatePaneKey() {
  const half = () =>
    randomBytes(16)
      .toString("hex")
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, "$1-$2-$3-$4-$5");
  return `${half()}:${half()}`;
}

async function runCoderRoundE2E(fx) {
  const labelC = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-1`;
  const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
  const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
  const paneKey = generatePaneKey();
  const harnessDir = join(fx.cWt, ".harness");

  writeFileSync(
    join(fx.repo, ".harness", "coder-task.md"),
    `task_id: ${labelC}\ndropped_at: ${formatKstMinutes(Date.now() - 2 * 60 * 1000)}\nbase_commit_of_this_round: ${fx.baseCommit}\n`,
    "utf8",
  );
  recordDispatch(fx, {
    harnessDir,
    role: "CODER",
    label: labelC,
    runtimeTaskId,
    dispatchId,
    paneKey,
  });
  admit(fx, labelC, "CODER", paneKey);

  const { result, lines: stderrLines } = await captureConsoleError(() =>
    withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "CODER",
          "--worktree",
          fx.cWt,
          "--task-id",
          labelC,
          "--main-repo-dir",
          fx.repo,
        ],
        { fakeEngineRound: { runtimeTaskId, assigneePaneKey: paneKey } },
      ),
    ),
  );
  assert.equal(result.ok, true, `CODER round failed: ${result.reason}`);
  assert.equal(result.handshake.ok, true);
  assert.equal(
    stderrLines.some((l) =>
      l.includes("G1 dispatch-ledger cross-check skipped"),
    ),
    false,
    "G1 must have actually run for the CODER round, not skipped",
  );

  assert.deepEqual(receiptsIn(harnessDir), ["coder-receipt-r1.json"]);
  const receipt = JSON.parse(
    readFileSync(join(harnessDir, "receipts", "coder-receipt-r1.json"), "utf8"),
  );
  assert.deepEqual(receipt.effects, {
    envelopeArchived: true,
    taskArchived: true,
    admissionReturned: true,
  });
  assert.equal(receipt.binding.taskId, labelC);
  assert.equal(receipt.binding.role, "CODER");
  const resultContent = readFileSync(join(harnessDir, "coder.md"), "utf8");
  assert.equal(receipt.binding.resultFingerprint, sha256Text(resultContent));
  assert.match(
    resultContent,
    new RegExp(
      `engine_profile: engine=${FAKE_ENGINE_NAME} model=fake-model-0 .*adapter_module=${FAKE_ADAPTER_MODULE_REL.replace(/\//g, "\\/")}`,
    ),
  );

  const headCommit = execSync("git rev-parse HEAD", {
    cwd: fx.cWt,
    encoding: "utf8",
  }).trim();
  assert.notEqual(headCommit, fx.baseCommit, "CODER round must have committed");
  return { labelC, headCommit };
}

async function runReviewRoundE2E(fx, { labelC, headCommit }) {
  execFileSync("git", ["checkout", "-q", headCommit], { cwd: fx.rWt });
  const labelR = `${labelC}-review-1`;
  const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
  const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
  const paneKey = generatePaneKey();
  const harnessDir = join(fx.rWt, ".harness");

  writeFileSync(
    join(fx.repo, ".harness", "review-task.md"),
    `task_id: ${labelR}\ndropped_at: ${formatKstMinutes(Date.now() - 2 * 60 * 1000)}\nfor: ${labelC}\nhead_commit: ${headCommit}\nrunner_contract: none\n`,
    "utf8",
  );
  recordDispatch(fx, {
    harnessDir,
    role: "REVIEW",
    label: labelR,
    runtimeTaskId,
    dispatchId,
    paneKey,
  });
  admit(fx, labelR, "REVIEW", paneKey);

  const { result, lines: stderrLines } = await captureConsoleError(() =>
    withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "REVIEW",
          "--worktree",
          fx.rWt,
          "--task-id",
          labelR,
          "--main-repo-dir",
          fx.repo,
        ],
        {
          fakeEngineRound: {
            runtimeTaskId,
            assigneePaneKey: paneKey,
            forTaskId: labelC,
            headCommit,
          },
        },
      ),
    ),
  );
  assert.equal(result.ok, true, `REVIEW round failed: ${result.reason}`);
  assert.equal(result.handshake.ok, true);
  assert.equal(
    stderrLines.some((l) =>
      l.includes("G1 dispatch-ledger cross-check skipped"),
    ),
    false,
  );

  assert.deepEqual(receiptsIn(harnessDir), ["review-receipt-r1.json"]);
  const receipt = JSON.parse(
    readFileSync(
      join(harnessDir, "receipts", "review-receipt-r1.json"),
      "utf8",
    ),
  );
  assert.deepEqual(receipt.effects, {
    envelopeArchived: true,
    taskArchived: true,
    admissionReturned: true,
    ledgerRecorded: true,
  });
  assert.equal(receipt.verdictLineCount, 1);
  const resultContent = readFileSync(join(harnessDir, "review.md"), "utf8");
  assert.equal(receipt.binding.resultFingerprint, sha256Text(resultContent));
  return { labelR };
}

// 합성 원장 기록(§(d)) + 전역 대상 합성 라벨 0 단언.
function assertRoundsIsolatedAndRecorded(fx, { labelC, labelR }, t) {
  const ledgerJson = JSON.parse(readFileSync(fx.ledger, "utf8"));
  for (const label of [labelC, labelR]) {
    assert.equal(ledgerJson.reservations[label].status, "COMPLETED");
    assert.equal(
      Object.hasOwn(ledgerJson.reservations[label], "completion_reason"),
      false,
    );
  }
  const dispatchLines = readFileSync(fx.dispatchReceiptPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  assert.equal(dispatchLines.length, 2);

  const rejectStreak = JSON.parse(
    readFileSync(join(fx.repo, ".harness", "reject-streak.json"), "utf8"),
  );
  assert.equal(
    rejectStreak.issues["HYK-0"].streak,
    0,
    "approved resets the streak to 0",
  );
  const lastEntry = rejectStreak.issues["HYK-0"].history.at(-1);
  assert.equal(lastEntry.verdict, "approved");
  // reject-streak records the issue-identifying 'for:' value (labelC), not
  // the REVIEW round's own 'task_id:' (labelR) -- parseReviewOutcome
  // derives taskId from the 'for:' cover line.
  assert.equal(lastEntry.task_id, labelC);

  for (const text of [
    readIfExists(REAL_LEDGER_PATH),
    readIfExists(REAL_DISPATCH_RECEIPTS_PATH),
    readIfExists(REAL_COMPLETION_FAILURES_PATH),
  ]) {
    if (text === null) continue;
    assert.equal(
      text.includes(labelC),
      false,
      `real control-room ledger must not contain ${labelC}`,
    );
    assert.equal(
      text.includes(labelR),
      false,
      `real control-room ledger must not contain ${labelR}`,
    );
  }
  // P2-2 (coder-task.md §2 product_scope ⓘⓘⓘⓘⓘ 헛시험 수리, review-2
  // REVIEW-r1.md §1 P2-d): the real target is the MAIN repo's own
  // .harness/reject-streak.json (git-common-dir resolved) -- a LIVE file
  // shared with every other seat's dispatch/review traffic on this
  // machine, so a byte-identity comparison before/after this test's own
  // run is flaky by construction: any other seat's legitimate write
  // landing inside this test's run window turns into a false red here,
  // even though nothing this test did was wrong. Replaced with a
  // synthetic-label 0-count check instead -- the same zero-synthetic-label
  // style already used above for the other real control-room files: this
  // test's own synthetic labels (labelC/labelR) must never appear in it.
  // A concurrent legitimate write from another seat never contains this
  // test's own random labels, so it can never flip this assertion red.
  const mainRepoRejectStreakNow = readIfExists(MAIN_REPO_REJECT_STREAK_PATH);
  if (mainRepoRejectStreakNow === null) {
    t?.diagnostic(
      `측정 불가 -- 본 저장소(git-common-dir 기준) reject-streak.json 이 이 기계에 없다: ${MAIN_REPO_REJECT_STREAK_PATH}`,
    );
  } else {
    assert.equal(
      mainRepoRejectStreakNow.includes(labelC),
      false,
      `main-repo reject-streak.json (git-common-dir-resolved) must not contain ${labelC}`,
    );
    assert.equal(
      mainRepoRejectStreakNow.includes(labelR),
      false,
      `main-repo reject-streak.json (git-common-dir-resolved) must not contain ${labelR}`,
    );
  }
}

test("양성: 설정 사본에 등록한 가짜 엔진이 runStepCli(저장소 진입점)로 CODER->REVIEW 1라운드를 완주한다 -- 영수증 2 · fingerprint 결속 · 전역 라벨 0", async (t) => {
  const fx = buildFixture();
  try {
    await withPrependedPath(shimDir, async () => {
      const { labelC, headCommit } = await runCoderRoundE2E(fx);
      const { labelR } = await runReviewRoundE2E(fx, { labelC, headCommit });
      assertRoundsIsolatedAndRecorded(fx, { labelC, labelR }, t);
    });
  } finally {
    cleanupFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// B4 음성: 가짜 설정 model=" " -> CONFIG_SCHEMA_INVALID, relayStep 자체가
// 안 불린다(어댑터 선택이 선행 단계에서 거부됨).
// ---------------------------------------------------------------------------

// HYK-153-fake-engine-2 (coder-task.md §2 product_scope ⓘ "새 주입 seam 0"):
// B4 needs a DIFFERENT config than the one before() already froze into this
// process (see runStepProbe's header) -- the config-override opts seam is
// gone, so a fresh child process (env-driven, not opts-injected) is the only way left
// to exercise a second, broken HARNESS_ENGINE_PROFILES_PATH value.
test("음성(B4): roles.CODER.model=' ' -> CONFIG_SCHEMA_INVALID로 적재 거부, relayStep 미도달 -- 영수증 0 · task 파일 복사 0 · execFn 호출 0", async () => {
  const fx = buildFixture();
  try {
    const brokenConfigDir = tmpDir("hyk153c-broken-config-");
    const brokenConfigPath = writeFakeConfigCopy(brokenConfigDir, {
      brokenModel: true,
    });
    try {
      const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-b4`;
      writeFileSync(
        join(fx.repo, ".harness", "coder-task.md"),
        `task_id: ${label}\ndropped_at: ${formatKstMinutes(Date.now() - 2 * 60 * 1000)}\nbase_commit_of_this_round: ${fx.baseCommit}\n`,
        "utf8",
      );
      const result = await withEnvLedger(fx, () =>
        runStepProbe({
          argv: [
            "--role",
            "CODER",
            "--worktree",
            fx.cWt,
            "--task-id",
            label,
            "--main-repo-dir",
            fx.repo,
          ],
          env: { HARNESS_ENGINE_PROFILES_PATH: brokenConfigPath },
        }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "CONFIG_SCHEMA_INVALID");
      assert.equal(result.execFnCalled, false, "execFn must never be called");
      assert.equal(
        existsSync(join(fx.cWt, ".harness", "coder-task.md")),
        false,
        "relayStep must never have run -- the task file must not have been copied",
      );
      assert.deepEqual(receiptsIn(join(fx.cWt, ".harness")), []);
    } finally {
      rmSync(brokenConfigDir, { recursive: true, force: true });
    }
  } finally {
    cleanupFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// P1-2 / D 교차 음성 칸 (coder-task.md §2 product_scope ⓘⓘⓘ, review-1 REVIEW-r1
// .harness/rounds/REVIEW-r1.md §1 "P1-2"): the config copy's fake engine is
// missing its REQUIRED adapterModule key entirely -- engine-profile.mjs's
// own schema validation (piece B, scripts/check/engine-profile.mjs
// validateEngines) rejects this at load time, before engine-adapter-
// registry.mjs (piece D) or relayStep (piece C) ever run.
// ---------------------------------------------------------------------------

test("음성(D교차/P1-2): 설정 사본에서 engines.<가짜엔진>.adapterModule 제거 -> CONFIG_SCHEMA_INVALID, relayStep 미도달 -- 지시서 복사 0 · 영수증 0 · execFn 호출 0", async () => {
  const fx = buildFixture();
  try {
    const crossConfigDir = tmpDir("hyk153c2-cross-config-");
    const crossConfigPath = writeFakeConfigCopy(crossConfigDir, {
      dropAdapterModule: true,
    });
    try {
      const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-dcross`;
      writeFileSync(
        join(fx.repo, ".harness", "coder-task.md"),
        `task_id: ${label}\ndropped_at: ${formatKstMinutes(Date.now() - 2 * 60 * 1000)}\nbase_commit_of_this_round: ${fx.baseCommit}\n`,
        "utf8",
      );
      const result = await withEnvLedger(fx, () =>
        runStepProbe({
          argv: [
            "--role",
            "CODER",
            "--worktree",
            fx.cWt,
            "--task-id",
            label,
            "--main-repo-dir",
            fx.repo,
          ],
          env: { HARNESS_ENGINE_PROFILES_PATH: crossConfigPath },
        }),
      );
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "CONFIG_SCHEMA_INVALID");
      assert.match(result.reason, /adapterModule is required/);
      assert.equal(result.execFnCalled, false, "execFn must never be called");
      assert.equal(
        existsSync(join(fx.cWt, ".harness", "coder-task.md")),
        false,
        "relayStep must never have run -- the task file must not have been copied",
      );
      assert.deepEqual(receiptsIn(join(fx.cWt, ".harness")), []);
    } finally {
      rmSync(crossConfigDir, { recursive: true, force: true });
    }
  } finally {
    cleanupFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// 음성 ⓐ~ⓔ: 같은 흐름, 검사 하나씩 위반.
// ---------------------------------------------------------------------------

function setUpCoderPrereqs(
  fx,
  { label, runtimeTaskId, dispatchId, paneKeyRecorded, skipAdmission },
) {
  writeFileSync(
    join(fx.repo, ".harness", "coder-task.md"),
    `task_id: ${label}\ndropped_at: ${formatKstMinutes(Date.now() - 2 * 60 * 1000)}\nbase_commit_of_this_round: ${fx.baseCommit}\n`,
    "utf8",
  );
  recordDispatch(fx, {
    harnessDir: join(fx.cWt, ".harness"),
    role: "CODER",
    label,
    runtimeTaskId,
    dispatchId,
    paneKey: paneKeyRecorded,
  });
  if (!skipAdmission) admit(fx, label, "CODER", paneKeyRecorded);
}

test("음성 ⓐ: pane_match 불일치 -- G1이 거부하고 영수증 0", async () => {
  const fx = buildFixture();
  try {
    const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-a`;
    const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
    const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
    const recordedPaneKey =
      "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";
    const wrongPaneKeyWritten =
      "33333333-3333-3333-3333-333333333333:44444444-4444-4444-4444-444444444444";
    setUpCoderPrereqs(fx, {
      label,
      runtimeTaskId,
      dispatchId,
      paneKeyRecorded: recordedPaneKey,
    });
    const result = await withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "CODER",
          "--worktree",
          fx.cWt,
          "--task-id",
          label,
          "--main-repo-dir",
          fx.repo,
        ],
        {
          fakeEngineRound: {
            runtimeTaskId,
            assigneePaneKey: wrongPaneKeyWritten,
          },
        },
      ),
    );
    // relayStep's OWN stages (seat/readiness/deliver) all succeed -- the
    // mismatch is caught by the CONSUMPTION handshake relayStep calls
    // AFTER delivery, which is surfaced as `result.handshake`, not
    // `result.ok` (relayStep's `ok` only reports its own three stages).
    assert.equal(result.ok, true);
    assert.equal(result.handshake.ok, false);
    assert.match(result.handshake.reason, /G1 cross-check failed/);
    assert.deepEqual(receiptsIn(join(fx.cWt, ".harness")), []);
  } finally {
    cleanupFixture(fx);
  }
});

test("음성 ⓑ: DONE을 손으로 찍음(done_stamped_by 마커 없음) -- 거부되고 영수증 0", async () => {
  const fx = buildFixture();
  try {
    const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-b`;
    const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
    const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
    const paneKey =
      "55555555-5555-5555-5555-555555555555:66666666-6666-6666-6666-666666666666";
    setUpCoderPrereqs(fx, {
      label,
      runtimeTaskId,
      dispatchId,
      paneKeyRecorded: paneKey,
    });
    const result = await withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "CODER",
          "--worktree",
          fx.cWt,
          "--task-id",
          label,
          "--main-repo-dir",
          fx.repo,
        ],
        {
          fakeEngineRound: {
            runtimeTaskId,
            assigneePaneKey: paneKey,
            injectFault: "HAND_DONE",
          },
        },
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.handshake.ok, false);
    assert.deepEqual(receiptsIn(join(fx.cWt, ".harness")), []);
  } finally {
    cleanupFixture(fx);
  }
});

test("음성 ⓒ: 예약 없음(admit 생략) -- handshake는 ok:true 유지, admissionReturned 실패로 영수증 0", async () => {
  const fx = buildFixture();
  try {
    const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-c`;
    const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
    const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
    const paneKey =
      "77777777-7777-7777-7777-777777777777:88888888-8888-8888-8888-888888888888";
    setUpCoderPrereqs(fx, {
      label,
      runtimeTaskId,
      dispatchId,
      paneKeyRecorded: paneKey,
      skipAdmission: true,
    });
    const result = await withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "CODER",
          "--worktree",
          fx.cWt,
          "--task-id",
          label,
          "--main-repo-dir",
          fx.repo,
        ],
        { fakeEngineRound: { runtimeTaskId, assigneePaneKey: paneKey } },
      ),
    );
    assert.equal(
      result.ok,
      true,
      "handshake itself must still pass -- admission is a side effect, not a gate for CODER",
    );
    assert.deepEqual(
      receiptsIn(join(fx.cWt, ".harness")),
      [],
      "admissionReturned failed (no reservation to complete) -- no success receipt",
    );
  } finally {
    cleanupFixture(fx);
  }
});

function setUpReviewPrereqs(
  fx,
  { label, forTaskId, headCommit, runtimeTaskId, dispatchId, paneKey },
) {
  execFileSync("git", ["checkout", "-q", headCommit], { cwd: fx.rWt });
  writeFileSync(
    join(fx.repo, ".harness", "review-task.md"),
    `task_id: ${label}\ndropped_at: ${formatKstMinutes(Date.now() - 2 * 60 * 1000)}\nfor: ${forTaskId}\nhead_commit: ${headCommit}\nrunner_contract: none\n`,
    "utf8",
  );
  recordDispatch(fx, {
    harnessDir: join(fx.rWt, ".harness"),
    role: "REVIEW",
    label,
    runtimeTaskId,
    dispatchId,
    paneKey,
  });
  admit(fx, label, "REVIEW", paneKey);
}

test("음성 ⓓ: REVIEW head_commit 불일치(축 ⓐ 지정 대조) -- 거부되고 영수증 0", async () => {
  const fx = buildFixture();
  try {
    execFileSync(
      "git",
      ["commit", "--allow-empty", "-q", "-m", "stand-in CODER commit"],
      {
        cwd: fx.cWt,
      },
    );
    const headCommit = execSync("git rev-parse HEAD", {
      cwd: fx.cWt,
      encoding: "utf8",
    }).trim();
    const wrongHeadCommit = "0".repeat(40);
    const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-d-review-1`;
    const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
    const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
    const paneKey =
      "99999999-9999-9999-9999-999999999999:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    setUpReviewPrereqs(fx, {
      label,
      forTaskId: "HYK-0-fake-engine-stand-in-1",
      headCommit,
      runtimeTaskId,
      dispatchId,
      paneKey,
    });
    const result = await withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "REVIEW",
          "--worktree",
          fx.rWt,
          "--task-id",
          label,
          "--main-repo-dir",
          fx.repo,
        ],
        {
          fakeEngineRound: {
            runtimeTaskId,
            assigneePaneKey: paneKey,
            forTaskId: "HYK-0-fake-engine-stand-in-1",
            headCommit: wrongHeadCommit,
          },
        },
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.handshake.ok, false);
    assert.match(result.handshake.reason, /head_commit mismatch/);
    assert.deepEqual(receiptsIn(join(fx.rWt, ".harness")), []);
  } finally {
    cleanupFixture(fx);
  }
});

test("음성 ⓔ: verdict: 줄이 2개(AMBIGUOUS) -- 거부되고 영수증 0", async () => {
  const fx = buildFixture();
  try {
    execFileSync(
      "git",
      ["commit", "--allow-empty", "-q", "-m", "stand-in CODER commit"],
      {
        cwd: fx.cWt,
      },
    );
    const headCommit = execSync("git rev-parse HEAD", {
      cwd: fx.cWt,
      encoding: "utf8",
    }).trim();
    const label = `HYK-0-fake-engine-${randomBytes(4).toString("hex")}-e-review-1`;
    const runtimeTaskId = `task_${randomBytes(6).toString("hex")}`;
    const dispatchId = `ctx_${randomBytes(6).toString("hex")}`;
    const paneKey =
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:cccccccc-cccc-cccc-cccc-cccccccccccc";
    setUpReviewPrereqs(fx, {
      label,
      forTaskId: "HYK-0-fake-engine-stand-in-2",
      headCommit,
      runtimeTaskId,
      dispatchId,
      paneKey,
    });
    const result = await withEnvLedger(fx, () =>
      runStepCli(
        [
          "--role",
          "REVIEW",
          "--worktree",
          fx.rWt,
          "--task-id",
          label,
          "--main-repo-dir",
          fx.repo,
        ],
        {
          fakeEngineRound: {
            runtimeTaskId,
            assigneePaneKey: paneKey,
            forTaskId: "HYK-0-fake-engine-stand-in-2",
            headCommit,
            injectFault: "VERDICT_TWO_LINES",
          },
        },
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.handshake.ok, false);
    assert.deepEqual(receiptsIn(join(fx.rWt, ".harness")), []);
  } finally {
    cleanupFixture(fx);
  }
});
