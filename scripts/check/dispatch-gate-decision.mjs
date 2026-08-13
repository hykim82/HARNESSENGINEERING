// HYK-217-dispatch-gate-1 (coder-task.md) -- CLI shell around
// dispatch-gate-decision-core.mjs. This is the thing the delivery tool
// (관제실 `dispatch-worker.ps1`, patched per coder.md's patch text, not this
// repo) is meant to call BEFORE injecting a task: it runs BOTH
// `reject-streak.mjs gate` and `reject-streak.mjs diagnostic-gate` against
// the about-to-be-dropped task file, feeds their exit codes through the pure
// core, prints one human-readable line per gate PLUS one aggregate verdict
// line, and exits 0 (deliver) or 1 (do not deliver) -- deliberately its OWN
// exit-code contract, distinct from the underlying gates' {0,1,2}, so a
// caller never has to remember two different meanings for "1".
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  decideFromGateExit,
  combineGateDecisions,
  checkGatePreconditions,
  checkLedgerEntryShape,
  checkLedgerPathResolution,
  checkOneBPrecondition,
  DISPATCH_GATE_STATE,
} from "./dispatch-gate-decision-core.mjs";
import { loadLedger, writeLedger } from "./reject-streak.mjs";
// HYK-239: reject-streak-chain.mjs's tamper-detection engine has existed
// since HYK-218 with zero production callers (§0 실측). This is the wiring
// -- NOT reject-streak.mjs/relay-handshake.mjs/review-gate.mjs, which the
// 9 mutation tests reject-streak-chain.mjs's own header comment names copy
// those three files into isolated tmpdirs that do not include this sidecar
// module (a sibling import there breaks all 9 with MODULE_NOT_FOUND).
// dispatch-gate-decision.mjs is never copied by any of those tests (every
// test that touches it imports the real file by URL, see
// dispatch-gate-decision.test.mjs/activation-dependency-core.test.mjs) and
// it already runs on EVERY dispatch (관제실 dispatch-worker.ps1 calls this
// CLI before injecting a task, see file header) -- the one place a chain
// check both runs every round and cannot be starved by the mutation-test
// copy mechanics.
import {
  loadChainLedger,
  catchUpCheckpoints,
  writeChainLedger,
  checkAppendOnly,
} from "./reject-streak-chain.mjs";

const REJECT_STREAK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "reject-streak.mjs",
);

// 2R/3R §2: the SAME structural facts checkGatePreconditions needs,
// extracted here (I/O + regex on the task file's own text) so the pure core
// never has to touch a filesystem. Mirrors reject-streak.mjs's own
// TASK_ID_LINE_RE/ISSUE_ID_RE *shape* (a task_id header line, an
// HYK-<digits> prefix) without importing them -- reject-streak.mjs does not
// export those regexes and 2R/3R §1/§6 forbid editing it to add an export;
// this is INPUT validation on the task file (a precondition check), not a
// reimplementation of reject-streak.mjs's own gate/envelope DECISION logic,
// which stays untouched and unduplicated.
//
// 3R: uses a GLOBAL match (matchAll) instead of 2R's single `.match()` --
// 2R only asked "is there a task_id line;" 3R's confirmative model requires
// "is there EXACTLY ONE" (반례 6: reject-streak.mjs's own non-global regex
// silently uses the FIRST match when there are two, ignoring the second
// line's streak-relevant content -- this CLI must see the true count to
// reject that ambiguity instead of inheriting the sub-gate's leniency).
const TASK_ID_LINE_RE_G = /^task_id:\s*(\S+)/gim;
const ISSUE_ID_PREFIX_RE = /^HYK-\d+/;
const ISSUE_ID_CAPTURE_RE = /^(HYK-\d+)/;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

function extractTaskIdFacts(taskText) {
  const text = normalizeNewlines(taskText);
  const matches = [...text.matchAll(TASK_ID_LINE_RE_G)];
  const taskIdMatchCount = matches.length;
  const soleValue = taskIdMatchCount === 1 ? matches[0][1] : null;
  const taskIdFormatValid =
    soleValue !== null && ISSUE_ID_PREFIX_RE.test(soleValue);
  const issueIdMatch =
    soleValue !== null ? soleValue.match(ISSUE_ID_CAPTURE_RE) : null;
  return {
    taskIdMatchCount,
    taskIdFormatValid,
    issueId: issueIdMatch ? issueIdMatch[1] : null,
  };
}

// HYK-241 §2 조각2: same normalize/regex idiom as extractTaskIdFacts above --
// input validation on the task packet's own text, never a reimplementation
// of another module's decision logic. Anchored `^...$` column-0 lines,
// mirroring `task_id:`/`dropped_at:` throughout this codebase. Kept as a
// SEPARATE extraction (not folded into extractTaskIdFacts) so that
// function's existing return shape stays untouched.
const ONE_B_EXEC_RE = /^1b_exec_line:\s*(\S.*)$/im;
const ONE_B_SHOWN_RE = /^1b_shown:\s*(\S.*)$/im;
const ONE_B_REACH_RE = /^1b_reach_path:\s*(\S.*)$/im;
const ONE_B_PREREQ_RE = /^1b_prerequisite_for:\s*(\S.*)$/im;
// ⛔"아무 문장이나 있으면 통과"를 막기 위한 최소 서술 길이(코더-task §2 조각2
// 비타협). 정확한 값 자체는 판단이므로, 이 상수 하나로 좁혀 결과 파일에서
// 근거를 밝힌다.
const ONE_B_PREREQ_MIN_LEN = 10;

function extractOneBFacts(taskText) {
  const text = normalizeNewlines(taskText);
  const missingA = [];
  if (!ONE_B_EXEC_RE.test(text)) missingA.push("1b_exec_line");
  if (!ONE_B_SHOWN_RE.test(text)) missingA.push("1b_shown");
  if (!ONE_B_REACH_RE.test(text)) missingA.push("1b_reach_path");
  const prereqMatch = text.match(ONE_B_PREREQ_RE);
  const prereqValue = prereqMatch ? prereqMatch[1].trim() : null;
  return {
    aComplete: missingA.length === 0,
    missingA,
    bDeclared: prereqValue !== null,
    bValid: prereqValue !== null && prereqValue.length >= ONE_B_PREREQ_MIN_LEN,
  };
}

function runGateSubcommand(sub, taskPath, ledgerArgs) {
  try {
    const stdout = execFileSync(
      "node",
      [REJECT_STREAK_PATH, sub, taskPath, ...ledgerArgs],
      { encoding: "utf8" },
    );
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      // execFileSync throws on non-zero exit; err.status carries the real
      // code, err.status===undefined/null when the child died by signal
      // rather than exiting -- decideFromGateExit's REJECT_UNKNOWN_EXIT
      // branch is exactly for that case, so we pass it through as-is
      // rather than coercing it to a number.
      exitCode: err.status ?? null,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message ?? ""),
    };
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ledger") out.ledger = argv[++i];
    else if (argv[i] === "--expect-repo-root") out.expectRepoRoot = argv[++i];
    else if (argv[i] === "--chain") out.chain = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

// HYK-239: mirrors reject-streak-chain.mjs's own CLI default (sidecar lives
// next to the ledger, same basename swap) -- `--chain` is an explicit
// override for tests/tooling, same shape as `--ledger`'s own override.
function resolveChainPath(args, ledgerPath) {
  return args.chain || join(dirname(ledgerPath), "reject-streak-chain.json");
}

function firstNonEmptyErrorText(err) {
  const text = String(err?.stderr ?? err?.message ?? err ?? "").trim();
  return text.length > 0 ? text : "(no detail)";
}

// HYK-220 1R->2R: 1R's dirname(taskPath) default (2R 검토 실측이 고친 CWD
// 기반보다는 나았다) still ties the ledger to THIS worktree's OWN
// `.harness/`, so a linked worktree with its own (e.g. freshly-created,
// streak-reset) local ledger file silently wins over the real, shared
// history -- that is the 2R 검토 P1 근거 B 우회. This resolves the ledger by
// asking git itself where the CURRENT repo's shared (`--git-common-dir`)
// storage lives, which is identical across every worktree of the same
// repo (main or linked) -- so the ledger converges on one file per repo
// regardless of which worktree a task was dropped into.
//
// P1-3 (bare 경계, 검토 실측): a linked worktree off a BARE repo has
// `--git-common-dir` return the bare repo's OWN directory (e.g.
// `.../repo.git`), not a nested `.git` folder -- `dirname()` on that value
// silently lands one level too high. `--is-bare-repository` (run with
// `--git-dir` pointed at the resolved common dir, so it asks about THAT
// repository regardless of the caller's own CWD) distinguishes the two
// shapes: bare -> the common dir itself is the root; non-bare -> its parent
// is the root (this repo, HARNESSENGINEERING, is the non-bare shape).
// HYK-221 축1 (검토 실측): execFileSync's stderr is, by Node's own default,
// piped to the PARENT process's real stderr in addition to being captured
// on the thrown error object -- so a git failure here (e.g. "not a git
// repository") used to leak raw git text onto this CLI's own stderr stream,
// ahead of and separate from the clean, single-reason-per-line contract the
// rest of this module promises. `stdio: ["ignore", "pipe", "pipe"]` keeps
// the capture (still available via `err.stderr` for firstNonEmptyErrorText)
// while suppressing that inherited passthrough -- this call becomes visible
// far more often once resolveLedgerPath (below) starts probing taskPath's
// repo even on the `--ledger`-only path, so a failure here is no longer a
// rare edge case this leak could stay hidden behind.
function resolveRepoRoot(dir) {
  const stdio = ["ignore", "pipe", "pipe"];
  let commonDir;
  try {
    commonDir = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio },
    ).trim();
  } catch (err) {
    return { root: null, detail: firstNonEmptyErrorText(err) };
  }
  let isBare;
  try {
    isBare = execFileSync(
      "git",
      ["--git-dir", commonDir, "rev-parse", "--is-bare-repository"],
      { encoding: "utf8", stdio },
    ).trim();
  } catch (err) {
    return { root: null, detail: firstNonEmptyErrorText(err) };
  }
  return {
    root: isBare === "true" ? commonDir : dirname(commonDir),
    detail: null,
  };
}

// Windows paths differ only by drive-letter case / slash direction /
// trailing slash between two calls that both, in fact, name the same repo
// root -- normalize before comparing so those never register as a mismatch.
function normalizeRootForCompare(root) {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// HYK-220 2R: replaces 1R's plain string-returning resolveLedgerPath.
// Returns `{ path, state: null }` on success (state:null tells the caller
// "proceed") or `{ path: null, state: <REJECT_*>, reason }` on failure --
// the caller (runDispatchGateDecision) routes a non-null state straight to
// checkLedgerPathResolution and NEVER reaches checkGatePreconditions /
// spawns either gate, same short-circuit shape as the existing
// taskPath-not-found branch.
//
// P1-1 (결속 미증명 + `--ledger` 우회): git succeeding only proves taskPath
// belongs to SOME repo, not the repo the caller intended. `--expect-repo-root`
// is an OPTIONAL caller-supplied fact (dispatch-worker.ps1 already knows
// which worktree it dispatched to); when given, taskPath's OWN resolved
// repo root must match it OR this rejects -- including when `--ledger` is
// ALSO given, so an explicit `--ledger` can no longer walk around the
// membership check by skipping repo resolution entirely (2R 검토 실측: 이전
// 설계에서 `--ledger`는 대조 없이 그대로 우선했다). When
// `--expect-repo-root` is NOT given, this check does not run at all -- an
// additive axis (S11 헤더 ③ 패턴), not a new mandatory requirement on every
// existing caller/test that never passed it. Symmetric with that: an
// explicit `--ledger` WITHOUT `--expect-repo-root` fully bypasses git
// resolution too (zero git calls, byte-identical to 1R/pre-2R behavior) --
// there is nothing to identify taskPath's repo FOR when no default needs
// computing and no expected repo was named to compare against. This keeps
// every existing fixture-based test (plain non-git tmpdirs + explicit
// `--ledger`) working unchanged; only the NO-`--ledger` default-resolution
// path and the `--expect-repo-root` membership check touch git at all.
// HYK-221 축1: an explicit `--ledger` WITHOUT `--expect-repo-root` used to
// return here unconditionally -- zero git calls, zero binding check, the
// ledger path was trusted as-is no matter which repo it actually belonged
// to. That is the exact gap this task's §1 축1 names: a caller (or a
// misconfigured delivery tool) can point `--ledger` at a stale/wrong-repo
// file and this precondition would happily proceed to ALLOW off of it.
// Fix, scoped to avoid the HYK-217 gap#97 shape (a blanket new check
// breaking every existing non-git-tmpdir fixture that never had a real repo
// to bind against): only run the membership check when taskPath itself CAN
// be resolved to a real repo. When it cannot (e.g. every existing
// fixture-based test's plain `mkdtempSync(tmpdir())` directory, which is
// deliberately not a git repo), there is no "current repo" to compare the
// ledger against, so behavior is unchanged -- byte-identical to before this
// fix. In real operation the task file always lives inside a real git
// worktree, so this check is live exactly where the gap actually mattered.
function resolveLedgerPath(args, taskPath) {
  if (args.ledger && !args.expectRepoRoot) {
    const taskRepoForLedger = resolveRepoRoot(dirname(taskPath));
    if (taskRepoForLedger.root === null) {
      return { path: args.ledger, state: null };
    }
    const ledgerRepo = resolveRepoRoot(dirname(args.ledger));
    if (
      ledgerRepo.root === null ||
      normalizeRootForCompare(ledgerRepo.root) !==
        normalizeRootForCompare(taskRepoForLedger.root)
    ) {
      return {
        path: null,
        state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
        reason: `dispatch-gate-decision precondition: --ledger(${args.ledger})가 taskPath가 속한 저장소(${taskRepoForLedger.root})에 속하지 않음(${ledgerRepo.root === null ? `원인: ${ledgerRepo.detail}` : `실제: ${ledgerRepo.root}`}) -> 배달 거부(안전측 기본값 -- --expect-repo-root 없이 --ledger 만 주어졌다고 결속을 건너뛰지 않는다). 조치: --ledger가 taskPath와 같은 저장소를 가리키는지, 또는 --expect-repo-root를 함께 넘기는지 확인하라`,
      };
    }
    return { path: args.ledger, state: null };
  }
  const taskRepo = resolveRepoRoot(dirname(taskPath));
  if (taskRepo.root === null) {
    return {
      path: null,
      state: DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
      reason: `dispatch-gate-decision precondition: taskPath가 속한 git 저장소를 식별하지 못함(대상 디렉터리: ${dirname(taskPath)}) -> 배달 거부(안전측 기본값 -- 원장 "부재"와는 다른 원인: 원장을 찾을 저장소 자체를 확정 못 했다). 원인: ${taskRepo.detail}. 조치: taskPath가 git 워크트리 안에 있는지, git 실행파일을 호출할 수 있는지 확인하라`,
    };
  }
  if (args.expectRepoRoot) {
    const expectedRepo = resolveRepoRoot(args.expectRepoRoot);
    if (expectedRepo.root === null) {
      return {
        path: null,
        state: DISPATCH_GATE_STATE.REJECT_LEDGER_PATH_UNRESOLVABLE,
        reason: `dispatch-gate-decision precondition: --expect-repo-root(${args.expectRepoRoot})가 속한 git 저장소를 식별하지 못함 -> 배달 거부(안전측 기본값). 원인: ${expectedRepo.detail}. 조치: --expect-repo-root 값이 실제 git 워크트리 경로인지 확인하라`,
      };
    }
    if (
      normalizeRootForCompare(expectedRepo.root) !==
      normalizeRootForCompare(taskRepo.root)
    ) {
      return {
        path: null,
        state: DISPATCH_GATE_STATE.REJECT_REPO_MISMATCH,
        reason: `dispatch-gate-decision precondition: taskPath가 속한 저장소(${taskRepo.root})가 기대 저장소(--expect-repo-root -> ${expectedRepo.root})와 다름 -> 배달 거부(안전측 기본값 -- --ledger 를 명시로 넘겼어도 이 대조를 건너뛰지 않는다). 조치: 배달 도구가 지금 조작 중인 워크트리 경로를 --expect-repo-root로 넘기는지 확인하라`,
      };
    }
  }
  return {
    path: args.ledger || join(taskRepo.root, ".harness", "reject-streak.json"),
    state: null,
  };
}

// 2R/3R §2 (P1-B / confirmative redesign): fail-closed precondition check
// BEFORE spawning either gate subprocess -- if this fails, the real gates
// are never called at all (checkGatePreconditions' reason is the ONLY
// decision). Extracted from runDispatchGateDecision to keep that function
// under the repo's ESLint complexity/line-count ceiling (quality-check).
function evaluatePrecondition(taskPath, ledgerPath) {
  const taskText = readFileSync(taskPath, "utf8");
  const { taskIdMatchCount, taskIdFormatValid, issueId } =
    extractTaskIdFacts(taskText);
  const ledgerExists = existsSync(ledgerPath);
  const loaded = ledgerExists ? loadLedger(ledgerPath) : null;
  // 3R 반례 7: only meaningful once ledger loaded AND issueId uniquely
  // resolved -- if either is false, a higher-priority check in
  // checkGatePreconditions (task_id/ledger-readability) already rejects
  // before this fact is ever consulted, so an "invalid" placeholder here is
  // inert, never itself the deciding reason.
  const entryShape =
    loaded?.ok === true && issueId !== null
      ? checkLedgerEntryShape(loaded.ledger, issueId)
      : { valid: false, reason: "(전제조건 미충족, 이 확인은 도달하지 않음)" };
  const precondition = checkGatePreconditions({
    taskIdMatchCount,
    taskIdFormatValid,
    ledgerExists,
    ledgerLoadOk: loaded?.ok ?? false,
    ledgerLoadReason: loaded?.reason,
    ledgerEntryShapeValid: entryShape.valid,
    ledgerEntryShapeReason: entryShape.reason,
  });
  return { precondition, loaded, issueId };
}

// HYK-239: the wiring. Runs once per dispatch, after the precondition check
// and the two reject-streak.mjs gate subprocesses have already confirmed
// this task is well-formed and the primary ledger is readable --
// `primaryLedger`/`issueId` here are the SAME values `runGatesAgainstSnapshot`
// just judged, not a second independent read (no new TOCTOU window).
//
// Two-step, same order the hash-chain literature uses: verify what is
// ALREADY checkpointed first (that is where tamper detection lives -- see
// checkAppendOnly), THEN extend the sidecar to cover whatever the primary
// ledger grew to since the last time this ran (catchUpCheckpoints, pure --
// only appends, never rewrites an already-verified entry). Extending AFTER
// verifying means a checkpoint can only ever be added for an entry that was
// itself just cross-checked as live-consistent one line above.
//
// §2 requirement 2 (판정 불가 ≠ 정상): a chain sidecar that exists but is
// unreadable/corrupt is fail-closed here (REJECT_CHAIN_UNJUDGABLE, its OWN
// state -- never folded into REJECT_CHAIN_TAMPER_DETECTED's "content is bad"
// meaning, nor into ALLOW). This diverges from reject-streak-chain.mjs's own
// CLI (which fail-OPENs on the same load failure, exit 0, matching
// reject-streak.mjs's convention) because THIS module's surrounding contract
// (dispatch-gate-decision-core.mjs's documented default-reject stance,
// checkGatePreconditions's five confirmations) is fail-closed throughout --
// an ambiguous sidecar is exactly the kind of "cannot confirm" case that
// stance already treats as REJECT, not a special exception carved out for
// this one axis.
// Split out of evaluateChainDecision below purely to keep that function's
// own cyclomatic complexity under the repo's ESLint ceiling (same reason
// reject-streak-chain.mjs/reject-streak.mjs extract their own helpers) --
// no behavior change, same order, same values.
function extendChainCheckpoints(chainPath, primaryLedger, chain, issueId) {
  const before = chain?.issues?.[issueId]?.entries?.length ?? 0;
  const nextChain = catchUpCheckpoints(primaryLedger, chain, issueId);
  const after = nextChain.issues?.[issueId]?.entries?.length ?? 0;
  if (after !== before) {
    writeChainLedger(chainPath, nextChain);
  }
  return { before, after };
}

function evaluateChainDecision({ chainPath, primaryLedger, issueId }) {
  const loadedChain = loadChainLedger(chainPath);
  if (!loadedChain.ok) {
    return {
      state: DISPATCH_GATE_STATE.REJECT_CHAIN_UNJUDGABLE,
      allow: false,
      reason: `dispatch-gate-decision chain: ${loadedChain.reason} -> 배달 거부(안전측 기본값 -- 사이드카 판정 불가는 "정상"으로 접지 않는다). 조치: 사이드카(${chainPath})를 복구하거나, 손상이 확실하면 별도 판단으로 재구축하라`,
    };
  }
  const verify = checkAppendOnly({
    primaryLedger,
    chain: loadedChain.chain,
    issueId,
  });
  if (verify.status === "BLOCK") {
    return {
      state: DISPATCH_GATE_STATE.REJECT_CHAIN_TAMPER_DETECTED,
      allow: false,
      reason: `dispatch-gate-decision chain: BLOCK -> 배달 거부 -- ${verify.reason}`,
    };
  }
  const { before, after } = extendChainCheckpoints(
    chainPath,
    primaryLedger,
    loadedChain.chain,
    issueId,
  );
  return {
    state: DISPATCH_GATE_STATE.ALLOW,
    allow: true,
    reason: `dispatch-gate-decision chain: PASS -> 배달 허용 -- ${verify.reason} (checkpoint ${before} -> ${after})`,
  };
}

// 4R §3 (TOCTOU): checkGatePreconditions already judged `loadedLedger` --
// the in-memory object from THIS process's single read of ledgerPath. The
// two gate subcommands below are SEPARATE processes that would otherwise
// re-read the SAME live ledgerPath themselves; if the file on disk changes
// in the window between our read and their read (검토 실측: `streak`
// rewritten to 0 mid-flight via NODE_OPTIONS), the precondition's
// confirmation and the gates' actual verdict would be judging two
// DIFFERENT ledger states. Fix (한용 지시 "단일 읽기" 선택): materialize the
// ALREADY-VALIDATED in-memory ledger to a private, freshly-created
// snapshot file, and point BOTH gate subcommands at that snapshot instead
// of the live path -- they still "re-read" (separate processes,
// unavoidable), but what they read is now the frozen content this process
// already confirmed, not whatever the live file happens to contain at that
// moment. This closes the window between confirmation and gate execution;
// it does NOT (and cannot) close the earlier window between this
// process's OWN read of the live ledger and a concurrent writer's
// non-atomic write to that same file -- reject-streak.mjs's writeLedger()
// uses a plain writeFileSync, not an atomic rename, and this track cannot
// touch that file (§1/§6). A snapshotDir cleanup failure is logged, never
// allowed to change the verdict already decided from the (already-
// executed) gate results.
function runGatesAgainstSnapshot(taskPath, loadedLedger) {
  const snapshotDir = mkdtempSync(
    join(tmpdir(), "dispatch-gate-decision-snapshot-"),
  );
  const snapshotLedgerPath = join(snapshotDir, "reject-streak.json");
  writeLedger(snapshotLedgerPath, loadedLedger);
  const snapshotLedgerArgs = ["--ledger", snapshotLedgerPath];
  try {
    const gateResult = runGateSubcommand("gate", taskPath, snapshotLedgerArgs);
    const diagResult = runGateSubcommand(
      "diagnostic-gate",
      taskPath,
      snapshotLedgerArgs,
    );
    return [
      decideFromGateExit({ ...gateResult, label: "reject-streak gate" }),
      decideFromGateExit({
        ...diagResult,
        label: "reject-streak diagnostic-gate",
      }),
    ];
  } finally {
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch (err) {
      console.error(
        `dispatch-gate-decision: snapshot cleanup failed (non-fatal, verdict already decided): ${err.message}`,
      );
    }
  }
}

export function runDispatchGateDecision(argv) {
  const args = parseArgs(argv);
  const taskPath = args._[0];
  if (!taskPath) {
    return {
      allow: false,
      lines: [
        "dispatch-gate-decision: usage: node dispatch-gate-decision.mjs <task-path> [--ledger <path>] [--expect-repo-root <path>]",
      ],
    };
  }
  const decisions = [];
  if (!existsSync(taskPath)) {
    // Routed through the SAME decideFromGateExit the spawned gates use
    // (exitCode:1, matching reject-streak.mjs's own "task file not found"
    // exit-1 contract) rather than a bespoke early-return -- so this path
    // and the spawned-gate exit-1 path share one mutation point (coder-task
    // §4-2's RED reproduction covers both by covering the core function).
    decisions.push(
      decideFromGateExit({
        exitCode: 1,
        stdout: "",
        stderr: `task file not found: ${taskPath}`,
        label: "dispatch-gate-decision (task file check)",
      }),
    );
  } else {
    const ledgerResolution = resolveLedgerPath(args, taskPath);
    const pathDecision = checkLedgerPathResolution(ledgerResolution);
    if (pathDecision) {
      // HYK-220 2R: mirrors the taskPath-not-found branch above -- a
      // failure to even IDENTIFY the ledger's repo short-circuits before
      // checkGatePreconditions/either gate subprocess is ever reached.
      decisions.push(pathDecision);
    } else {
      const { precondition, loaded, issueId } = evaluatePrecondition(
        taskPath,
        ledgerResolution.path,
      );
      if (precondition) {
        decisions.push(precondition);
      } else {
        decisions.push(...runGatesAgainstSnapshot(taskPath, loaded.ledger));
        decisions.push(
          evaluateChainDecision({
            chainPath: resolveChainPath(args, ledgerResolution.path),
            primaryLedger: loaded.ledger,
            issueId,
          }),
        );
        // HYK-241 §2 조각2: placed LAST (after both gates + chain), not
        // ahead of them like checkGatePreconditions/checkLedgerPathResolution
        // -- an earlier placement would short-circuit before the gates ever
        // run, which changes the "gates never spawned" assertions every
        // existing precondition-reject test in dispatch-gate-decision.test.mjs
        // already makes about task_id/ledger shapes. Running last means the
        // OUTCOME (delivery blocked) is identical either way when 1-B is
        // missing; only ALLOW-bound fixtures need a 1-B declaration added.
        // checkOneBPrecondition returns null on success -- nothing is pushed
        // then, same convention checkGatePreconditions/
        // checkLedgerPathResolution already follow (no positive confirmation
        // line, only the final combined ALLOW/REJECT line covers it).
        const oneBDecision = checkOneBPrecondition(
          extractOneBFacts(readFileSync(taskPath, "utf8")),
        );
        if (oneBDecision) decisions.push(oneBDecision);
      }
    }
  }
  const combined = combineGateDecisions(decisions);

  const lines = [...combined.reasons];
  lines.push(
    combined.allow
      ? "dispatch-gate-decision: ALLOW -- 두 게이트 모두 통과, 배달 진행"
      : "dispatch-gate-decision: REJECT -- 위 사유로 배달 거부, 원인 확인 후 재시도하라",
  );
  return { allow: combined.allow, lines };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/dispatch-gate-decision.mjs");
if (invokedDirectly) {
  const { allow, lines } = runDispatchGateDecision(process.argv.slice(2));
  for (const line of lines) {
    if (allow) console.log(line);
    else console.error(line);
  }
  process.exit(allow ? 0 : 1);
}
