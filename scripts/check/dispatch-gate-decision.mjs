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
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
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
// HYK-244-receipt-wire-2b2 §3-1: 1R 승인·커밋분(consumption-receipt-
// core.mjs) 판정 로직을 그대로 쓴다(⛔코어 무변경). zero-import 코어라
// 이 import 자체가 어떤 새 전이 의존성도 끌어들이지 않는다(그 파일
// 자신의 zero-import 시험이 그 계약을 고정한다). hyk241-oneb-gate-
// mutation.test.mjs가 이 파일을 고정 4파일 목록으로 격리 clone하므로,
// 그 목록에 이 파일도 추가했다(아래 커밋 diff의 시험 파일 참고) --
// relay-handshake.mjs 쪽(2R-a)이 정적 import를 피한 것과 다른 선택:
// 그쪽은 같은 파일을 격리하는 mutation 시험이 6개나 있어 전부 갱신하는
// 것보다 spawn이 더 저렴했지만, 여기는 격리 시험이 1개뿐이라 그 시험의
// 고정 목록에 한 줄 추가하는 쪽이 더 저렴하고, dispatch-gate-decision.mjs
// 자신이 이미 여러 형제 모듈을 정적 import하는 파일이라(reject-streak.mjs
// 등) 이 파일에서는 애초에 "정적 import 회피"가 기존 관례도 아니다.
import { toConsumptionGateDecision } from "./consumption-receipt-core.mjs";
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
    // HYK-244-receipt-wire-2b2 §3-2: mirrors --ledger/--chain's own
    // arg-with-env-fallback shape (resolveDispatchReceiptPath below reads
    // the env fallback) -- ⛔관제실 절대경로 하드코딩 금지, 경로는
    // 인자/환경으로만 받는다.
    else if (argv[i] === "--dispatch-receipt-path")
      out.dispatchReceiptPath = argv[++i];
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

// ===========================================================================
// HYK-244-receipt-wire-2b2 §3 -- 소비 완료 영수증 축 결선.
//
// ⛔코어(consumption-receipt-core.mjs)의 판정 로직은 건드리지 않는다 --
// 이 섹션 전체는 "이미 벌어진 사실을 코어가 요구하는 facts 모양으로
// 구조화해서 넘기기"만 한다(S8과 같은 원칙, checkOneBPrecondition이
// extractOneBFacts의 결과만 받는 이 파일 자신의 기존 구조와 동일).
//
// «직전 결과가 소비됐는가»의 대상: dispatch-worker.ps1이 이 CLI를 호출하는
// 시점은 NEW task 파일을 쓰기 *전*이므로, 이 시점의 taskPath는 여전히
// 방금 끝난 라운드 자신의 task 파일이다. 그 라운드의 binding(taskId·
// droppedAt)은 taskPath 자체에서, doneAt·resultFingerprint는 같은
// 디렉터리의 형제 결과 파일(`<role>.md`)에서 뽑는다 -- checkRelayHandshake
// 가 성공 판정을 내릴 때 참조하는 바로 그 두 파일이다.
// ===========================================================================

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// taskPath의 파일명 관례(`<role>-task.md`)에서 role을 뽑는다 -- relay-
// handshake.mjs가 이미 매 라운드 이 관례로 파일을 여닫으므로 새 관례가
// 아니다. 매치 실패(예상 밖 파일명)면 null -- 이 축을 적용할 대상이
// 무엇인지조차 모른다는 뜻이므로, 아래 evaluateConsumptionDecision이
// 이 경우 축 자체를 건너뛴다(거부도 허용도 지어내지 않는다).
function deriveRoleFromTaskPath(taskPath) {
  const base = taskPath.replace(/\\/g, "/").split("/").pop() ?? "";
  const m = base.match(/^(.+)-task\.md$/i);
  return m ? m[1] : null;
}

const CONSUMPTION_TASK_ID_RE_G = /^task_id:\s*(\S+)/gim;
const CONSUMPTION_DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
const CONSUMPTION_DONE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;

// relay-handshake.mjs의 resolveResultTaskId/resolveResultDoneMatch와
// 동일한 "유일한 매치 하나만 채택, 0개·2개 이상이면 지어내지 않고
// undefined로 물러난다" 규칙을 그대로 복제한다(그 두 함수는 export되지
// 않는다 -- 그리고 어차피 이 축이 필요한 것은 값 하나뿐, 그 파일의
// 전체 handshake 판정이 아니다).
function extractSoleMatch(text, reG) {
  const matches = [...text.matchAll(reG)];
  return matches.length === 1 ? matches[0][1].trim() : undefined;
}

// §2 조각2 지정과 동일: resultFingerprint = 결과 파일 내용의 SHA-256(hex).
// consumption-receipt-writer.mjs의 computeResultFingerprint와 알고리즘이
// 같아야 생산 쪽과 소비(게이트) 쪽이 같은 지문을 계산한다 -- 다른
// 알고리즘을 고르면 실제로는 동일한 결과 파일인데도 지문이 달라져
// bindingEqual이 영원히 불일치로 떨어진다(그 자체가 새 결함이므로
// 반드시 같은 알고리즘이어야 한다).
function computeConsumptionResultFingerprint(resultContent) {
  return createHash("sha256").update(resultContent, "utf8").digest("hex");
}

// §3-2 지정: dispatchId 출처 = 배달 영수증(dispatch-receipts.jsonl).
// ⛔관제실 절대경로 하드코딩 금지 -- args(--dispatch-receipt-path)나
// env(DISPATCH_RECEIPT_PATH, dispatch-receipt-cli.mjs가 이미 쓰는 바로 그
// 이름)로만 받는다.
function resolveDispatchReceiptPath(args, env) {
  if (isNonEmptyString(args.dispatchReceiptPath))
    return args.dispatchReceiptPath;
  if (isNonEmptyString(env.DISPATCH_RECEIPT_PATH))
    return env.DISPATCH_RECEIPT_PATH;
  return null;
}

// lookupDispatchId에서 분리(quality-check: eslint complexity 상한 유지
// 목적, 동작 변경 없음) -- append-only JSONL 원문에서 role+
// harnessTaskLabel이 일치하는 "마지막" 레코드를 고른다(먼저 나온 매치가
// 아니라 마지막 -- append-only 로그이므로 그게 최신이다). 손상된 줄은
// 건너뛴다(부분쓰기 가능성, §참조 아래 lookupDispatchId 헤더).
function findLatestReceiptMatch(raw, role, harnessTaskLabel) {
  let match = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof rec.role === "string" &&
      rec.role.toUpperCase() === role.toUpperCase() &&
      rec.harness_task_label === harnessTaskLabel
    ) {
      match = rec;
    }
  }
  return match;
}

// ⛔"조회하지 못했다"(ok:false)와 "정말 없다"(ok:true, found:false)를
// 구별한다 -- 어느 쪽이든 dispatchId를 지어내지 않는다(2R-a 계약 유지).
// role 비교는 대소문자 무관(dispatch-receipts.jsonl 표본은 "CODER"/
// "REVIEW" 대문자, 이 CLI의 role은 파일명 관례상 소문자 "coder"/
// "review" -- 실측: dispatch-receipt-cli.mjs 44행 USAGE 문자열과
// 관제실 dispatch-receipts.jsonl 실제 샘플 라인을 직접 대조).
function lookupDispatchId({ role, harnessTaskLabel, receiptPath }) {
  if (!isNonEmptyString(receiptPath)) {
    return {
      ok: false,
      found: false,
      reason:
        "dispatch receipt path 없음(--dispatch-receipt-path/DISPATCH_RECEIPT_PATH 둘 다 미설정)",
    };
  }
  if (!isNonEmptyString(harnessTaskLabel)) {
    return {
      ok: false,
      found: false,
      reason:
        "조회할 harness_task_label 없음(task 파일의 task_id: 줄이 없거나 모호함)",
    };
  }
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      found: false,
      reason: `dispatch receipt 파일을 읽을 수 없음('${receiptPath}': ${err.message})`,
    };
  }
  const match = findLatestReceiptMatch(raw, role, harnessTaskLabel);
  if (!match) return { ok: true, found: false };
  if (typeof match.dispatch_id !== "string" || match.dispatch_id.length === 0) {
    return {
      ok: false,
      found: false,
      reason: `role=${role} label=${harnessTaskLabel}로 찾은 영수증 항목에 dispatch_id 필드가 없음`,
    };
  }
  return { ok: true, found: true, dispatchId: match.dispatch_id };
}

// HYK-244 2R-b3 결함1 수리: 게이트는 배달 "전"에 돈다 -- 이 시점에는
// taskPath(`<role>-task.md`)가 이미 "다음에 보낼" 새 라운드로 덮여 있다
// (ORCH 실측: dropped_at이 새 라운드 값이었다). "직전 라운드가
// 소비됐는가"를 판정하려면 결속의 모든 성분이 직전 라운드 자신에게서
// 와야 하는데, droppedAt만은 resultText(직전 라운드가 남긴 결과 파일)
// 자체에는 없다(프로토콜상 결과 파일은 task_id만 에코하고 dropped_at은
// 에코하지 않는다). 그 직전 라운드가 완료될 때 envelope-archive.mjs의
// archiveRoundTaskFile이 자기 task 파일을 `.harness/rounds/
// <role>-task-r<N>.md`에 원문 그대로 보존해 둔 사본이 유일하게 남은
// 출처다 -- harnessTaskLabel과 일치하는 사본을 찾아 그 안의 dropped_at을
// 그대로 쓴다(못 찾으면 undefined -- 지어내지 않는다, 1R 코어가
// 안전측으로 거부한다). role 비교는 대소문자 무관(결함3과 같은 이유 --
// 아카이브 파일명은 실제 생산 경로가 쓴 그대로의 대소문자를 담고 있어
// 파일명 관례상 소문자인 이 함수의 role 인자와 다를 수 있다).
function findArchivedDroppedAt(harnessDir, role, harnessTaskLabel) {
  const archiveDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(archiveDir);
  } catch {
    return undefined;
  }
  const pattern = new RegExp(`^${role}-task-r(\\d+)\\.md$`, "i");
  let bestRound = -1;
  let bestDroppedAt;
  for (const name of names) {
    const m = pattern.exec(name);
    if (!m) continue;
    let content;
    try {
      content = readFileSync(join(archiveDir, name), "utf8");
    } catch {
      continue;
    }
    if (
      extractSoleMatch(content, CONSUMPTION_TASK_ID_RE_G) !== harnessTaskLabel
    )
      continue;
    const droppedMatch = content.match(CONSUMPTION_DROPPED_AT_RE);
    if (!droppedMatch) continue;
    const roundNum = Number(m[1]);
    if (roundNum > bestRound) {
      bestRound = roundNum;
      bestDroppedAt = droppedMatch[1].trim();
    }
  }
  return bestDroppedAt;
}

// HYK-244 2R-b3 결함2 수리 (필수 부속): 실물 생산 경로(relay-handshake.mjs
// -> consumption-receipt-writer.mjs)는 완료 시점에 자기 dispatchId를 알
// 방법이 없다(관제실 dispatch-receipts.jsonl에 그 라운드의 항목이 남는
// 것은 그 라운드가 "다음 라운드로" 배달됐을 때이지, 자기 자신이 끝날 때가
// 아니다 -- ORCH 실측 원문 그대로: 실제 생산된 영수증에 dispatchId
// 키가 아예 없다). ⇒ 후보(candidate) 쪽도 currentBinding과 **같은
// 출처(dispatch-receipts.jsonl)에서 같은 방식으로** dispatchId를
// 보강하지 않으면, 6성분 엄격 비교(§3 결함2 원문)가 "실물이 만든 후보는
// dispatchId가 영원히 undefined, currentBinding은 실제 문자열"이라는
// 비대칭 때문에 항상 불일치로 떨어진다 -- 코어(consumption-receipt-
// core.mjs, ⛔수정 금지)를 바꾸지 않고 이 비대칭을 없앨 수 있는 유일한
// 지점이 여기(게이트가 후보를 읽는 지점)다. 이미 찾은 값이 있으면(이론상
// 미래에 생산 경로가 직접 채우게 되더라도) 덮어쓰지 않는다.
function enrichCandidateDispatchId(candidate, receiptPath) {
  if (isNonEmptyString(candidate?.binding?.dispatchId)) return candidate;
  const role = candidate?.binding?.role;
  const harnessTaskLabel = candidate?.binding?.taskId;
  if (!isNonEmptyString(role) || !isNonEmptyString(harnessTaskLabel))
    return candidate;
  const lookup = lookupDispatchId({ role, harnessTaskLabel, receiptPath });
  if (!lookup.ok || !lookup.found) return candidate;
  return {
    ...candidate,
    binding: { ...candidate.binding, dispatchId: lookup.dispatchId },
  };
}

// `<harnessDir>/receipts/<role>-receipt-r<N>.json` 전부를 후보로 읽는다
// (최신 것만 고르지 않는다 -- 1R 코어 자신이 currentBinding과 정확히
// 일치하는 후보를 스스로 골라내므로, 여기서 미리 좁히면 "과거 라운드
// 후보가 섞여 있어도 코어가 올바르게 무시한다"는 1R의 보장을 검증할
// 기회 자체가 사라진다). 개별 파일이 읽기/파싱 실패하면 그 파일만
// 건너뛴다 -- 손상된 영수증 하나가 전체 조회를 막지 않는다(신뢰 못할
// 후보는 코어가 어차피 매치시키지 못해 안전측으로 떨어진다).
function readConsumptionCandidates(harnessDir, role, receiptPath) {
  const receiptsDir = join(harnessDir, "receipts");
  let names;
  try {
    names = readdirSync(receiptsDir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${role}-receipt-r\\d+\\.json$`, "i");
  const candidates = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      const raw = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
      candidates.push(enrichCandidateDispatchId(raw, receiptPath));
    } catch {
      // 손상/미완성 쓰기 -- 건너뛴다(위 함수 헤더 참조).
    }
  }
  return candidates;
}

// HYK-244 2R-b4 §2-1 (한용 조건①): 제도 시행 시점 = commit `16eb377`
// (2R-a, consumption-receipt-writer.mjs 최초 도입)의 커밋 시각. ⛔이
// 브랜치 자신의 "결선(게이트 wiring) 커밋"을 기준으로 삼지 않는다 --
// 그 커밋은 이 라운드가 검토 승인된 *뒤에야* 만들어지므로, 기준이 자기
// 존재를 전제하는 순환이 생긴다(coder-task.md §2-1 원문 그대로 지적).
// `16eb377`은 이미 존재하는 커밋이라 순환이 없고, 그 시각 이전에 완료된
// 라운드는 영수증을 만드는 코드(consumption-receipt-writer.mjs) 자체가
// 저장소에 없었다는 것이 정의상 참이다 -- 그 라운드에 영수증이 없는
// 것은 "미소비"가 아니라 "판정 대상 아님"이 정확한 상태다. 값은 아래
// 명령의 실측 결과를 리터럴로 박아넣은 것이고, 런타임에 git을 조회하지
// 않는다(밖에서 읽는 가변값이 아니다):
//   $ git log -1 --format=%cI 16eb377
//   2026-08-14T08:50:27+09:00
const RECEIPTS_ERA_START_KST = "2026-08-14 08:50:27";

// relay-handshake.mjs의 (export되지 않는) parseKstTimestamp와 동일
// 알고리즘의 로컬 복제 -- 이 파일에 relay-handshake.mjs를 새로 import하면
// mutation-test 격리 픽스처(hyk241-oneb-gate-mutation.test.mjs)가 그
// 전체 의존성 트리(envelope-archive.mjs·time-authority.mjs·
// consumption-receipt-writer.mjs·node:crypto 등)까지 떠안아야 한다 --
// isReviewFamilyRole/REVIEW_ROLE_RE를 zero-import 코어에서 이미 복제해
// 둔 이 저장소의 기존 관례(consumption-receipt-core.mjs 자체 주석 §3-b)
// 그대로 따른다.
function parseKstToMs(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

// HYK-244 2R-b4 §2-2 (한용 확정, 조용한 통과 금지): 직전 라운드의
// doneAt이 제도 시행 시점보다 이전이면, 이 라운드는 애초에 영수증을
// 만들 방법이 없었으므로 "미소비"로 거부하면 안 된다 -- "판정 대상
// 아님"이라는 명시 상태를 사유와 함께 stderr에 찍고 통과시킨다(§2-2
// 원문: "«아무 말 없이 ALLOW»는 실패다"). doneAt/기준값 중 하나라도
// 파싱 불가면 면제하지 않는다(안전측 기본값 -- 판정 대상인지조차 모를
// 때 조용히 통과시키면 §2-3 "면제가 앞으로도 통하는 구멍" 그 자체가
// 된다).
// HYK-244 2R-b4 §2-4 (한용 조건②, 위조 표면 조사에 대한 부분 대응):
// doneAt 하나만으로 면제를 결정하면, 그 값은 워커가 자기 결과 파일에
// 직접 쓰는 값이라 워커가 완료 후에라도 파일을 다시 열어 과거로
// 고쳐 쓰면 언제든 면제를 받을 수 있다(§2-4 조사 결과, 아래 함수
// 헤더에 상세 기재). droppedAt(정확히는 envelope-archive.mjs가 완료
// *직후* 즉시 보존한 아카이브 사본의 droppedAt)은 ORCH가 태스크를
// 드롭할 때 쓰는 값이고, 그 사본은 워커의 사후 편집 창(다음 라운드
// 드롭 전까지 남는 live 결과 파일과 달리) 밖에 있다 -- doneAt 위조만으로는
// 더 이상 면제를 받을 수 없게, **두 값 다** 시행 시점보다 이전이어야
// 면제하도록 강화했다(완전한 차단은 아니다 -- 정직 한계는 checkPredatesReceipts
// 헤더 및 결과 보고 §2-4에 기재).
function checkPredatesReceipts(currentBinding) {
  const doneAtMs = parseKstToMs(currentBinding?.doneAt);
  const droppedAtMs = parseKstToMs(currentBinding?.droppedAt);
  const eraStartMs = parseKstToMs(RECEIPTS_ERA_START_KST);
  if (doneAtMs === null || droppedAtMs === null || eraStartMs === null)
    return false;
  if (doneAtMs >= eraStartMs || droppedAtMs >= eraStartMs) return false;
  console.error(
    `dispatch-gate-decision consumption: PREDATES_RECEIPTS -- 직전 라운드(${currentBinding?.taskId ?? "(라벨 미상)"}, doneAt=${currentBinding?.doneAt}, droppedAt=${currentBinding?.droppedAt})는 영수증 제도 시행 이전이라 판정 대상 아님(기준=${RECEIPTS_ERA_START_KST} KST, commit 16eb377)`,
  );
  return true;
}

// 이 축의 메인 진입점. null 반환 = "이 축을 적용할 대상이 없다"(role을
// 못 뽑거나, 형제 결과 파일이 아예 없어 소비할 직전 라운드 자체가
// 없는 부트스트랩 상황) -- checkOneBPrecondition이 성공 시 null을
// 반환해 decisions 배열에 아무것도 안 쌓는 것과 같은 관례. 그 외에는
// toConsumptionGateDecision(1R 코어)의 반환값을 그대로 내놓는다(PASS면
// null, 아니면 {state, allow:false, reason}) -- 이 함수 자신은 ALLOW/
// REJECT를 스스로 판단하지 않는다.
// HYK-244 2R-ci-1 §C (한용 확정 12:40, 조건 4개): live 결과 파일
// (`<role>.md`)의 지문이 후보와 안 맞아도, 그 라운드가 실제로 소비될
// 때 envelope-archive.mjs가 남긴 보존 사본(`.harness/rounds/<ROLE>-r<N>.md`)
// 의 지문이 영수증과 일치하면 "소비됨"으로 인정한다 -- 소비 완료 *후에*
// live 파일이 한 글자만 손질돼도 영구 미소비가 되는 문제(ORCH 실측: 이
// 워크트리 자신의 커밋 라운드 영수증이 정확히 이 모양으로 걸렸다,
// resultFingerprint만 다름)의 대응.
//
// 보존 사본 헤더 처리(⛔추측 금지, 실측): archiveRoundEnvelope가 남기는
// 사본은 정확히 한 줄의 헤더 `<!-- envelope-archive: role=<ROLE>
// archived_at=<시각> -->\n`를 원문 앞에 덧붙인다(envelope-archive.mjs
// 193행 원문 그대로). 이 워크트리의 실제 rounds/CODER-r15.md로 직접
// 검증: 그 헤더 한 줄만 제거한 나머지가 그 라운드의 실제 영수증
// resultFingerprint(36d83fd8…)와 SHA-256이 정확히 일치했다(coder.md
// §B 참조) -- 그래서 아래는 "그 정확한 헤더 패턴이면 한 줄만 벗기고,
// 아니면(추측 금지) 지문을 계산하지 않고 판정 불가로 물러난다."
const ARCHIVE_ENVELOPE_HEADER_RE =
  /^<!-- envelope-archive: role=\S+ archived_at=.*? -->\n/;

function stripArchiveEnvelopeHeader(content) {
  const match = content.match(ARCHIVE_ENVELOPE_HEADER_RE);
  return match ? content.slice(match[0].length) : content;
}

// 여러 개면 조용히 하나를 고르지 않고 판정 불가로 거부한다(§C 지시
// "어느 사본이 그 라운드의 것인지" 규칙 -- 이 저장소의 확정 방향,
// resolveMatchingCandidate의 ambiguous 처리와 같은 정신). 반환:
// {ok:true, fingerprint, path} | {ok:true, fingerprint:null}(못 찾음,
// 지어내지 않음) | {ok:false, reason}(찾았지만 2개 이상 -- 판정 불가).
function findArchivedResultFingerprint(harnessDir, role, harnessTaskLabel) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return { ok: true, fingerprint: null };
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = stripArchiveEnvelopeHeader(raw);
    if (
      extractSoleMatch(stripped, CONSUMPTION_TASK_ID_RE_G) !== harnessTaskLabel
    )
      continue;
    matches.push({
      path: join("rounds", name),
      fingerprint: computeConsumptionResultFingerprint(stripped),
    });
  }
  if (matches.length === 0) return { ok: true, fingerprint: null };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `보존 사본 후보 ${matches.length}건이 같은 라벨(${harnessTaskLabel})과 일치 -- 어느 것이 그 라운드의 것인지 결정할 수 없다(판정 불가, 조용히 하나를 고르지 않음)`,
    };
  }
  return {
    ok: true,
    fingerprint: matches[0].fingerprint,
    path: matches[0].path,
  };
}

// HYK-244 2R-ci-1 §C: 1R 코어(⛔수정 금지)를 그대로 두고, live 지문으로
// 실패했을 때만 "그 실패의 유일한 원인이 resultFingerprint였다면" 보존
// 사본 지문으로 한 번 더 시도한다 -- 다른 필드(role/droppedAt/dispatchId/
// doneAt)까지 함께 바뀌는 것은 아니므로, resultFingerprint 하나만 바꾼
// currentBinding으로 같은 코어를 다시 부르는 것은 코어의 판정 로직을
// 조금도 바꾸지 않는다(그 함수를 두 번째로 호출할 뿐).
function tryArchiveFallback({
  role,
  currentBinding,
  candidates,
  harnessDir,
  harnessTaskLabel,
}) {
  const archived = findArchivedResultFingerprint(
    harnessDir,
    role,
    harnessTaskLabel,
  );
  if (!archived.ok) {
    console.error(
      `dispatch-gate-decision consumption: 보관함 대조 판정 불가(안 지어냄) -- ${archived.reason}`,
    );
    return null;
  }
  if (!archived.fingerprint) return null; // 사본 자체가 없음 -- 조용히 물러난다(원래 실패를 그대로 반환).
  if (archived.fingerprint === currentBinding.resultFingerprint) return null; // live와 같음 -- 애초에 실패 원인이 아니었다.

  // ★조건② -- live≠보관함 불일치 관측을 무조건 먼저 찍는다(뒷손질
  // 관측 -- 이 사실 자체는 아래 재시도의 성패와 무관하게 항상 보인다).
  console.error(
    `dispatch-gate-decision consumption: live≠보관함 지문 불일치 관측 -- live=${currentBinding.resultFingerprint} archive(${archived.path})=${archived.fingerprint} (소비 후 결과 파일이 손질됐을 가능성)`,
  );

  const archiveBinding = {
    ...currentBinding,
    resultFingerprint: archived.fingerprint,
  };
  const retry = toConsumptionGateDecision({
    role,
    currentBinding: archiveBinding,
    candidates,
  });
  if (retry !== null) return null; // 보관함 지문으로도 매치 안 됨 -- 원래 실패를 그대로 반환.

  // ★조건① -- 보관함 대조로 인정될 때 사유가 반드시 찍힌다(조용한 통과 0).
  console.error(
    `dispatch-gate-decision consumption: ARCHIVE_MATCH -- live 지문 불일치이나 보존 사본(${archived.path}) 지문이 영수증과 일치 -> 소비 완료로 판정, 허용`,
  );
  return true;
}

function evaluateConsumptionDecision(taskPath, args, env = process.env) {
  const role = deriveRoleFromTaskPath(taskPath);
  if (!role) return null;

  const harnessDir = dirname(taskPath);
  const resultPath = join(harnessDir, `${role}.md`);
  if (!existsSync(resultPath)) return null; // 부트스트랩: 아직 소비할 직전 라운드가 없다.

  const resultText = readFileSync(resultPath, "utf8");

  // HYK-244 2R-b3 결함1 수리: taskPath(`<role>-task.md`)는 게이트가 도는
  // 이 시점엔 이미 "다음에 보낼" 새 라운드로 덮여 있다 -- 라벨은 아직
  // 다음 라운드가 안 덮어쓴 resultText(직전 라운드 자신의 결과 파일)의
  // task_id 에코에서 뽑는다(taskText를 쓰지 않는다).
  const harnessTaskLabel = extractSoleMatch(
    resultText,
    CONSUMPTION_TASK_ID_RE_G,
  );

  const receiptPath = resolveDispatchReceiptPath(args, env);
  const lookup = lookupDispatchId({ role, harnessTaskLabel, receiptPath });
  if (!lookup.ok) {
    console.error(
      `dispatch-gate-decision consumption: dispatch_id 조회 실패(안 지어냄) -- ${lookup.reason}`,
    );
  } else if (!lookup.found) {
    console.error(
      `dispatch-gate-decision consumption: role=${role} label=${harnessTaskLabel}에 대응하는 배달 영수증을 못 찾음(정말 없음, 안 지어냄)`,
    );
  }

  // 결함1의 나머지 절반: droppedAt도 같은 이유로 taskText가 아니라 그
  // 직전 라운드가 자기 task 파일을 보존해 둔 아카이브 사본에서 온다.
  const droppedAt = findArchivedDroppedAt(harnessDir, role, harnessTaskLabel);

  const currentBinding = {
    taskId: harnessTaskLabel,
    // HYK-244 2R-b3 결함3 수리: 파일명 관례상 role은 소문자("coder")지만,
    // 실제 생산 경로(관제실이 대문자 $Role로 relay-handshake.mjs CLI를
    // 직접 호출)가 만드는 영수증의 role은 대문자("CODER")다(ORCH 실측
    // 원문, coder-task.md §2 결함3). 1R 코어는 6성분을 strict === 로
    // 비교하므로 실제 생산 값의 대소문자에 맞춘다.
    role: role.toUpperCase(),
    droppedAt,
    resultFingerprint: computeConsumptionResultFingerprint(resultText),
    dispatchId: lookup.ok && lookup.found ? lookup.dispatchId : undefined,
    doneAt: extractSoleMatch(resultText, CONSUMPTION_DONE_RE_G),
  };
  if (checkPredatesReceipts(currentBinding)) return null; // ALLOW -- 사유는 위에서 이미 찍었다.

  const candidates = readConsumptionCandidates(harnessDir, role, receiptPath);

  const decision = toConsumptionGateDecision({
    role,
    currentBinding,
    candidates,
  });
  if (decision === null) return null;

  if (
    tryArchiveFallback({
      role,
      currentBinding,
      candidates,
      harnessDir,
      harnessTaskLabel,
    })
  ) {
    return null; // ALLOW -- 사유는 tryArchiveFallback이 이미 찍었다.
  }

  return decision;
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
        // HYK-244-receipt-wire-2b2 §3-1: same placement reasoning as
        // oneBDecision immediately above -- last, after gates+chain+1-B,
        // so this new axis's outcome never changes which existing
        // precondition-reject fixture short-circuits before which gate.
        // Returns null when not applicable (no role derivable, or no
        // prior round's result file exists yet -- bootstrap) or when the
        // 1R core itself says PASS; only a genuine non-PASS verdict is
        // ever pushed.
        const consumptionDecision = evaluateConsumptionDecision(taskPath, args);
        if (consumptionDecision) decisions.push(consumptionDecision);
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
