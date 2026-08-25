// HYK-289 (coder-task.md §2-1): this file is a "시험·점검 진입점" that is
// run directly (`node scripts/check/selfcheck-smoke.mjs`), NEVER via
// `node --test` -- so admission-completion-adapter.mjs's own
// NODE_TEST_CONTEXT-based guard (see that file's persistentFallbackAllowed)
// cannot see this invocation at all. ORCH measured the exact leak this
// import closes: smokeRelayHandshake() below spawns relay-handshake.mjs's
// CLI without an ADMISSION_LEDGER_PATH override, which (when its own
// checkRelayHandshake spawn reaches ok:true) spawns
// admission-completion-adapter.mjs as a further child that inherits this
// process's env AND cwd -- with neither var set, that grandchild resolves
// the REAL control-room ledger pointer file and durably appends a
// RESERVATION_NOT_FOUND line to its real `.completion-failures.jsonl`
// side file. Importing sweep-ledger-isolation.mjs here runs its top-level
// side effect (set ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH to a
// disposable tmp-dir path, only if unset) before any smoke* function below
// ever spawns a child -- every runNode() call defaults its `env` option to
// `process.env`, so every spawned child (and any grandchild it spawns)
// inherits this isolated default for free, with zero changes to
// relay-handshake.mjs or admission-completion-adapter.mjs's call sites.
import "./sweep-ledger-isolation.mjs";
import { spawnSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  utimesSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkReviewGate } from "./review-gate.mjs";
import { parseStatusOpenIssues, diffSync } from "./linear-sync.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

// Runs `node <scriptPath> <args...>` with the given stdin/env/cwd and
// returns { exit, stdout, stderr } regardless of exit code (spawnSync, not
// execFileSync, so a nonzero "expected bad" exit never throws here).
function runNode(scriptPath, args, { input = "", env, cwd } = {}) {
  const res = spawnSync("node", [scriptPath, ...args], {
    input,
    env: env ?? process.env,
    cwd,
    encoding: "utf8",
  });
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function withTmpDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every smoke* function below is self-contained: it creates its own OS-temp
// fixture, runs the real check (via its real CLI where the CLI accepts
// fixture-path overrides, or via its exported pure function where it does
// not -- see each function's own note), and cleans up -- never touches this
// repo or the real control room (G8). Each returns [{ id, variant, expectedExit,
// actualExit, pass, evidence }] for its bad and good case.

export function smokeClearSafeCheck({ scriptPath }) {
  return withTmpDir("selfcheck-smoke-clear-safe-", (dir) => {
    const statusPath = join(dir, "STATUS.md");
    const results = [];
    writeFileSync(
      statusPath,
      "### 3) /clear 안전\n🟢 **전 역할 안전** — /clear 가능.\n<!-- clear-safe-attest: reconciled=2026-07-13 00:00 KST delta=applied -->\n",
      "utf8",
    );
    const bad = runNode(scriptPath, ["--status", statusPath], {
      input: "{}",
      env: { ...process.env, HARNESS_ROLE: "ORCH" },
    });
    results.push({
      id: "clear-safe-check",
      variant: "bad",
      expectedExit: 2,
      actualExit: bad.exit,
      pass: bad.exit === 2,
      evidence: bad.stderr,
    });

    writeFileSync(
      statusPath,
      [
        "### 3) /clear 안전",
        "🟢 **전 역할 안전** — /clear 가능.",
        "<!-- clear-safe-attest: reconciled=2026-07-13 00:00 KST delta=applied -->",
        "<!-- cycle-receipt:",
        "  boundary: cycle",
        "  task_id: selfcheck-smoke",
        "  result_ref: n/a",
        "  issue_ids: HYK-129",
        "  sync_result: ok",
        "  status_updated: yes",
        "  phase_update_needed: no",
        "-->",
        "",
      ].join("\n"),
      "utf8",
    );
    const good = runNode(scriptPath, ["--status", statusPath], {
      input: "{}",
      env: { ...process.env, HARNESS_ROLE: "ORCH" },
    });
    results.push({
      id: "clear-safe-check",
      variant: "good",
      expectedExit: 0,
      actualExit: good.exit,
      pass: good.exit === 0,
      evidence: good.stdout,
    });
    return results;
  });
}

export function smokeControlroomFresh({ scriptPath }) {
  return withTmpDir("selfcheck-smoke-controlroom-", (dir) => {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "smoke@example.com"', { cwd: dir });
    execSync('git config user.name "smoke"', { cwd: dir });
    const statusPath = join(dir, "STATUS.md");
    const handoffPath = join(dir, "PHASE-HANDOFF.md");
    writeFileSync(statusPath, "status\n", "utf8");
    writeFileSync(handoffPath, "handoff\n", "utf8");
    execSync("git add .", { cwd: dir });
    execSync("git commit -q -m init", { cwd: dir });
    const results = [];

    const now = new Date();
    const stale = new Date(now.getTime() - 13 * 60 * 60 * 1000); // > 12h DEFAULT_HANDOFF_THRESHOLD_MS
    utimesSync(statusPath, now, now);
    utimesSync(handoffPath, stale, stale);
    const bad = runNode(scriptPath, ["--control-room", dir], {
      input: "{}",
      env: { ...process.env, HARNESS_ROLE: "ORCH" },
    });
    results.push({
      id: "controlroom-fresh",
      variant: "bad",
      expectedExit: 2,
      actualExit: bad.exit,
      pass: bad.exit === 2,
      evidence: bad.stderr,
    });

    utimesSync(handoffPath, now, now);
    const good = runNode(scriptPath, ["--control-room", dir], {
      input: "{}",
      env: { ...process.env, HARNESS_ROLE: "ORCH" },
    });
    results.push({
      id: "controlroom-fresh",
      variant: "good",
      expectedExit: 0,
      actualExit: good.exit,
      pass: good.exit === 0,
      evidence: good.stdout,
    });
    return results;
  });
}

export function smokeStatusFresh({ scriptPath }) {
  return withTmpDir("selfcheck-smoke-status-fresh-", (dir) => {
    const statusPath = join(dir, "STATUS.md");
    writeFileSync(statusPath, "status\n", "utf8");
    const harnessDir = join(dir, "harness");
    mkdirSync(harnessDir);
    const workFile = join(harnessDir, "coder.md");
    writeFileSync(
      workFile,
      "task_id: X\n>>> DONE: CODER @ 2026-07-13 00:00 KST\n",
      "utf8",
    );
    const results = [];

    const statusMtime = new Date();
    const futureWork = new Date(statusMtime.getTime() + 60 * 60 * 1000); // 1h ahead, past the 5s grace
    utimesSync(statusPath, statusMtime, statusMtime);
    utimesSync(workFile, futureWork, futureWork);
    const bad = runNode(scriptPath, [
      "--status",
      statusPath,
      "--harness-dir",
      harnessDir,
    ]);
    results.push({
      id: "status-fresh",
      variant: "bad",
      expectedExit: 1,
      actualExit: bad.exit,
      pass: bad.exit === 1,
      evidence: bad.stderr,
    });

    utimesSync(workFile, statusMtime, statusMtime);
    const good = runNode(scriptPath, [
      "--status",
      statusPath,
      "--harness-dir",
      harnessDir,
    ]);
    results.push({
      id: "status-fresh",
      variant: "good",
      expectedExit: 0,
      actualExit: good.exit,
      pass: good.exit === 0,
      evidence: good.stdout,
    });
    return results;
  });
}

export function smokeRelayHandshake({ scriptPath }) {
  return withTmpDir("selfcheck-smoke-relay-", (dir) => {
    const results = [];
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: SMOKE-1\ndropped_at: 2026-07-13 00:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: SMOKE-1\n>>> DONE: CODER @ 2026-07-12 23:00:00 KST\n",
      "utf8",
    ); // predates drop
    const bad = runNode(scriptPath, ["coder", dir]);
    results.push({
      id: "relay-handshake",
      variant: "bad",
      expectedExit: 1,
      actualExit: bad.exit,
      pass: bad.exit === 1,
      evidence: bad.stderr,
    });

    // HYK-257-done-stamp-2 §2 범위1: dropped_at must DIFFER from the "bad"
    // variant above, not just the DONE line -- relay-handshake.mjs's new
    // intermediate-rewrite channel (first-observation.mjs) keys its
    // per-round observation on `${taskId}::${dropped_at}` (envelope-
    // archive.test.mjs's own "라운드 2회" fixture is why taskId alone isn't
    // safe -- this repo legitimately reuses task_id across rounds). Reusing
    // the SAME dropped_at for both variants here would make this smoke
    // test's own "bad" DONE line look like an in-round intermediate rewrite
    // once the "good" DONE line is observed next -- a false positive this
    // channel must never produce for two genuinely DIFFERENT rounds. A
    // fresh dropped_at (still before the "good" DONE line, still a valid
    // KST header) makes this unambiguously a second, distinct round.
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: SMOKE-1\ndropped_at: 2026-07-12 00:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: SMOKE-1\n>>> DONE: CODER @ 2026-07-13 01:00:00 KST\n",
      "utf8",
    ); // postdates drop, HYK-244: seconds required
    // HYK-344 3R (진짜 회귀 수리): 이 "good" 변형은 relay-handshake.mjs의
    // CLI를 이 프로세스의 (상단 sweep-ledger-isolation.mjs가 채운) env
    // 그대로 상속해 부른다 -- ADMISSION_LEDGER_PATH는 «설정»돼 있지만
    // 그 경로의 ledger.json 파일 자체는 아직 존재하지 않는다(아무도
    // admit을 부른 적이 없다). 실제 프로덕션에서는 admission-cli admit이
    // 항상 완료보다 먼저 호출되므로(HYK-224) 이 파일이 없는 상태는
    // 진짜 정상 라운드에서는 일어나지 않는 조합이다 -- 그런데도 이
    // 시험은 그 조합을 만들어, admission-completion-adapter.mjs가
    // LEDGER_MISSING(진짜 원장 문제와 같은 reasonCode)으로 완료를
    // 거부하게 만들었고, HYK-344 2R의 exit-3 신호가 그걸 «attempted +
    // 실패»로 정확히 읽어(신호 자체는 옳다) exit 3을 냈다 -- ★이건
    // exit-3 로직의 결함이 아니라 **이 스모크 픽스처가 admit 을 빼먹은
    // 결함**이다(검토자 표의 `ledger-unreadable: exit=3; LEDGER_MISSING`
    // 이 그대로 «맞는» 동작임을 보여준다). 고치는 법 = 실제 프로덕션처럼
    // "good" 라운드 전에 이 taskId로 미리 admit해 둔다 -- 그러면
    // completion이 실제로 COMPLETED로 성공하고 exit 0이 된다(기대값을
    // 3으로 낮추는 게 아니라, 픽스처를 실제 순서에 맞춘다).
    // ⚠️실측: sweep-ledger-isolation.mjs가 채운 경로는 «경로»만 만들고
    // 그 자리의 ledger.json 파일 자체는 만들지 않는다 -- plain `admit`은
    // 이미 존재하는 원장 위에서만 도는 전이라 그 상태 그대로는
    // LEDGER_MISSING으로 거부된다(직접 실행해 확인). 그래서 admit 전에
    // `init-cutover`로 빈 원장을 먼저 만든다(비어 있는 live-seats로 --
    // 이 스모크의 관심사는 진짜 좌석 목록이 아니라 "원장 파일이 있고
    // SMOKE-1을 admit할 수 있는가"뿐이다).
    runAdmissionCli([
      "init-cutover",
      "--ledger",
      process.env.ADMISSION_LEDGER_PATH,
      "--lock",
      process.env.ADMISSION_LOCK_PATH,
      "--live-seats",
      "[]",
    ]);
    runAdmissionCli([
      "admit",
      "--ledger",
      process.env.ADMISSION_LEDGER_PATH,
      "--lock",
      process.env.ADMISSION_LOCK_PATH,
      "--reservation-id",
      "SMOKE-1",
      "--cap",
      "1",
    ]);
    const good = runNode(scriptPath, ["coder", dir]);
    results.push({
      id: "relay-handshake",
      variant: "good",
      expectedExit: 0,
      actualExit: good.exit,
      pass: good.exit === 0,
      evidence: good.stdout,
    });
    return results;
  });
}

export function smokePmSnapshotGate({ scriptPath }) {
  return withTmpDir("selfcheck-smoke-pm-snapshot-", (dir) => {
    const results = [];
    const taskPath = join(dir, "pm-task.md");
    writeFileSync(taskPath, "task_id: SMOKE-1\ntype: B2 진단·개선안\n", "utf8"); // no envelope -> G5 fail
    const bad = runNode(scriptPath, ["--task", taskPath]);
    results.push({
      id: "pm-snapshot-gate",
      variant: "bad",
      expectedExit: 1,
      actualExit: bad.exit,
      pass: bad.exit === 1,
      evidence: bad.stderr,
    });

    writeFileSync(taskPath, "task_id: SMOKE-1\ntype: B1 역질문\n", "utf8"); // B1 exempt -> ok
    const good = runNode(scriptPath, ["--task", taskPath]);
    results.push({
      id: "pm-snapshot-gate",
      variant: "good",
      expectedExit: 0,
      actualExit: good.exit,
      pass: good.exit === 0,
      evidence: good.stdout,
    });
    return results;
  });
}

// review-gate.mjs's CLI hardcodes reviewPath to <real repoRoot>/.harness/
// review.md with no fixture-path override -- so this smoke case calls its
// exported pure function directly instead of spawning the CLI. This is still
// the real check logic (not a re-implementation), and it trivially satisfies
// G8 (no real file is ever touched -- `reviewPath` is a temp fixture path
// passed straight into `checkReviewGate`).
export function smokeReviewGate() {
  return withTmpDir("selfcheck-smoke-review-gate-", (dir) => {
    const reviewPath = join(dir, "review.md");
    const results = [];
    writeFileSync(reviewPath, "no relevant evidence here\n", "utf8");
    const bad = checkReviewGate({
      message: "fix(x): HYK-1 something\n",
      reviewPath,
    });
    results.push({
      id: "review-gate",
      variant: "bad",
      expectedOk: false,
      actualOk: bad.ok,
      pass: bad.ok === false,
      evidence: bad.reason,
    });

    writeFileSync(
      reviewPath,
      "for: HYK-1\nverdict: approved\nrole: REVIEW-A\n",
      "utf8",
    );
    const good = checkReviewGate({
      message: "fix(x): HYK-1 something\n",
      reviewPath,
    });
    results.push({
      id: "review-gate",
      variant: "good",
      expectedOk: true,
      actualOk: good.ok,
      pass: good.ok === true,
      evidence: good.reason,
    });
    return results;
  });
}

// linear-sync.mjs's CLI requires a live Linear network call to reach its
// drift/clean branches at all -- this task's scope explicitly excludes
// mocking global fetch for a subprocess (see docs/enforcement-v1.md's note
// on this same tradeoff from the HYK-131 round). This smoke case instead
// exercises the same diffSync logic the CLI calls, in-process, over a
// synthetic §6 fixture -- real check logic, zero network, zero repo writes.
export function smokeLinearSync() {
  const results = [];
  const statusText = "### 6) 열린 이슈 (Linear)\n- **HYK-1** 예시 — *Todo*\n";
  const statusIssues = parseStatusOpenIssues(statusText);
  const driftLinear = [
    { id: "HYK-1", stateName: "In Progress", stateType: "started" },
  ];
  const bad = diffSync(statusIssues, driftLinear);
  const badDrifted = bad.stateDrift.length > 0;
  results.push({
    id: "linear-sync",
    variant: "bad",
    expectedOk: false,
    actualOk: !badDrifted,
    pass: badDrifted,
    evidence: JSON.stringify(bad.stateDrift),
  });

  const cleanLinear = [
    { id: "HYK-1", stateName: "Todo", stateType: "unstarted" },
  ];
  const good = diffSync(statusIssues, cleanLinear);
  const goodClean =
    good.stateDrift.length === 0 &&
    good.staleInStatus.length === 0 &&
    good.missingInStatus.length === 0;
  results.push({
    id: "linear-sync",
    variant: "good",
    expectedOk: true,
    actualOk: goodClean,
    pass: goodClean,
    evidence: JSON.stringify(good),
  });
  return results;
}

// G8: OS temp only, zero diff against the real repo/control room. Callers
// pass the *real* repoRoot purely so this can snapshot `git status --short`
// before/after -- no smoke* function above is ever given that path to write
// into.
export function captureGitStatus(repoRoot) {
  try {
    return execSync("git status --short", { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return null;
  }
}

export function runSmokeSuite({ repoRoot }) {
  const before = captureGitStatus(repoRoot);

  const scriptOf = (id) => join(repoRoot, "scripts", "check", `${id}.mjs`);
  const cases = [
    ...smokeClearSafeCheck({ scriptPath: scriptOf("clear-safe-check") }),
    ...smokeControlroomFresh({ scriptPath: scriptOf("controlroom-fresh") }),
    ...smokeStatusFresh({ scriptPath: scriptOf("status-fresh") }),
    ...smokeRelayHandshake({ scriptPath: scriptOf("relay-handshake") }),
    ...smokePmSnapshotGate({ scriptPath: scriptOf("pm-snapshot-gate") }),
    ...smokeReviewGate(),
    ...smokeLinearSync(),
  ];

  const after = captureGitStatus(repoRoot);
  const zeroDiff = before === after;

  return { cases, zeroDiff, before, after };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/selfcheck-smoke.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let repoRootArg;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root") repoRootArg = args[++i];
  }
  const repoRoot =
    repoRootArg ||
    execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const { cases, zeroDiff } = runSmokeSuite({ repoRoot });
  const failed = cases.filter((c) => !c.pass);
  console.log(
    `selfcheck-smoke: ${cases.length} case(s), ${failed.length} failed, repo diff-0=${zeroDiff}`,
  );
  for (const c of cases) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.id}:${c.variant}`);
  }
  process.exit(0);
}
