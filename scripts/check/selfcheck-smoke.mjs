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
