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
  DISPATCH_GATE_STATE,
} from "./dispatch-gate-decision-core.mjs";
import { loadLedger, writeLedger } from "./reject-streak.mjs";

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
    else out._.push(argv[i]);
  }
  return out;
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
  return { precondition, loaded };
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
      const { precondition, loaded } = evaluatePrecondition(
        taskPath,
        ledgerResolution.path,
      );
      if (precondition) {
        decisions.push(precondition);
      } else {
        decisions.push(...runGatesAgainstSnapshot(taskPath, loaded.ledger));
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
