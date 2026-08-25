import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  recordRejectStreakFromResultText,
  isReviewFamilyRole,
  REJECT_STREAK_REASON_CODE,
} from "./reject-streak.mjs";
import {
  archiveRoundEnvelope,
  archiveRoundTaskFileIfNew,
} from "./envelope-archive.mjs";
import {
  TIME_FIELD,
  TIME_AUTHORITY_STATE,
  MAX_FUTURE_SKEW_MS,
  KST_OFFSET_MS,
  isBeyondFutureSkew,
  isSuspectedTimezoneMislabel,
} from "./time-authority.mjs";

export { TIME_AUTHORITY_STATE, MAX_FUTURE_SKEW_MS };

// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). TASK_ID_RE(과거: 첫 매치 채택)와 DONE_RE(과거: 마지막 매치
// 채택)가 서로 반대 방향을 조용히 골랐던 것이 이 수리의 대상이다.
const TASK_ID_RE = /^task_id:\s*(\S+)/im;
const TASK_ID_RE_G = /^task_id:\s*(\S+)/gim;
// HYK-180 사이클1: the anchored TASK_ID_RE only matches a standalone
// `task_id: <id>` line at column 0. When it fails to match, this
// unanchored variant tells apart two very different failure shapes: no
// `task_id:` token anywhere (genuinely absent, worker still writing --
// pending) vs a `task_id:` token that exists but isn't a standalone line
// (e.g. `for: X / task_id: Y / role: Z` -- a structural violation that no
// amount of waiting fixes). Never used to accept a match; only to produce
// a distinct diagnosis for the latter case.
const TASK_ID_ANYWHERE_RE = /task_id:\s*(\S+)/i;
const DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할
// 수 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다 (see the file
// header above for the fuller rationale this constant shares with
// TASK_ID_RE_G).
// ⛔HYK-324/HYK-325: exported so finalize-done.mjs can reuse the EXACT same
// "what counts as a well-formed DONE line" contract (coder-task.md §2-1's
// explicit "재사용하라, 새 기준을 발명하지 마라") instead of inventing its
// own copy that could silently drift from this one.
export const DONE_RE = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;
// HYK-173-escalation-1: 결과 파일이 명시적으로 «막혔다»고 적을 수 있는
// column-0 표지. `>>> DONE:` 관례를 그대로 재사용한다(같은 파일 자리에서
// 같은 눈으로 찾을 수 있게). 이유 텍스트는 필수(빈 이유는 아래
// BLOCKED_ANYWHERE_RE 경로로 새서 MALFORMED로 fail-closed된다 -- "형식이
// 깨졌으면 괜찮다로 접지 않는다" 비타협).
// HYK-173-escalation-2 (REVIEW 반려 (1) 수리): 1R은 `\s*`를 세 자리 모두에
// 썼는데, `\s`는 `\n`을 포함한다 -- `^`/`$`가 column-0·줄-끝을 잡아도 그
// 사이의 `\s*`가 개행을 통째로 삼켜 «>>>\nBLOCKED: split»이나 «>>>
// BLOCKED:\nreason on next line» 같은 다중 행 입력이 "한 줄" 계약을 어기고도
// 정상 매치로 수락됐다(REVIEW 실측 `manual-split-after-arrows`/
// `manual-split-after-colon`). `>>>`와 키워드 사이, 콜론과 이유 사이의
// 공백은 개행을 포함하지 않는 `[ \t]*`로 좁힌다 -- 그 결과 콜론 뒤에 바로
// 개행이 오면 `(\S.*?)`가 그 자리에서 매치할 문자가 없어 이 정규식
// 자체가 매치하지 않고(아래 BLOCKED_ANYWHERE_RE의 near-miss 경로로 새어
// MALFORMED_BLOCKED가 된다), `>>>`와 개행 사이도 마찬가지로 막힌다.
const BLOCKED_RE = /^>>>[ \t]*(BLOCKED|NEEDS_INPUT):[ \t]*(\S.*?)[ \t]*$/gim;
// 위 엄격한 패턴이 매치하지 못했을 때, "애초에 그런 표지가 없다"(진짜
// pending)와 "표지를 쓰려고 한 흔적은 있는데 형식이 깨졌다"(예: column 0이
// 아님·이유 텍스트 없음·줄이 쪼개짐)를 가르는 near-miss 탐지.
// TASK_ID_ANYWHERE_RE와 동일한 역할 -- 매치 채택에는 절대 쓰지 않고 진단
// 구별에만 쓴다. 여기의 `\s*`는 의도적으로 유지한다 -- 바로 이 느슨함이
// «줄이 쪼개진 표지 흔적»까지 near-miss로 잡아내는 지점이다(엄격 패턴을
// 좁힌 것과 반대 방향의 요구).
// HYK-173-escalation-2 (REVIEW 반려 (2) 수리): `g` 플래그를 얹어 "몇 건
// 있는가"까지 셀 수 있게 한다 -- 엄격 매치가 정확히 1개 있어도 그 「옆에」
// 별도의 깨진 표지가 더 있으면(예: 유효 `>>> BLOCKED: valid` 한 줄과
// `status: >>> BLOCKED: midline`이 함께 있는 경우) 조용히 그 1개짜리
// 유효 매치로 확정하지 않고 MALFORMED_BLOCKED 계열로 승격해야 한다
// (REVIEW 실측 `manual-valid-plus-malformed`) -- resolveResultBlockedState
// 아래 참조. `matchAll`은 'g' 플래그가 있어도 원본 정규식의 `lastIndex`를
// 건드리지 않으므로(내부적으로 복제) 이 상수를 여러 곳에서 반복 호출해도
// 안전하다.
const BLOCKED_ANYWHERE_RE = />>>\s*(BLOCKED|NEEDS_INPUT)\b/gi;
// HYK-333: 관제실 워커 규칙 §3-b가 2026-08-21까지 `>>>` 없이 column-0
// `BLOCKED: <사유>` / `NEEDS_INPUT: <사유>` 를 쓰라고 가르쳤다(취소선으로
// 보존된 옛 문면). 그 시기 규칙을 정확히 지킨 워커의 정지 표지는 위
// BLOCKED_ANYWHERE_RE조차 매치하지 못해(둘 다 `>>>`를 요구) NONE으로 조용히
// 유실됐다(ORCH 재현, coder-task.md §1). 이 상수는 그 흔적만 좁게 잡는다 --
// column 0(줄 맨 앞, 선행 공백 0)에서 시작해야 한다. `^`가 줄 시작만
// 고정하므로 §3-2 요구 4가 금지한 "줄 중간의 ... BLOCKED: ..." 는 이
// 패턴에도 매치하지 않는다(무한 확장 방지 -- 오탐 억제는 여기서 끝나지
// 않고 아래 resolveResultBlockedState가 이 매치를 절대 BLOCKED/
// NEEDS_INPUT으로 승격하지 않는 것으로 한 번 더 막는다, 설계 판정 「A」).
// HYK-333 2R (검토 1R P2-1): 콜론 뒤 사유(`\S`)를 요구하지 않는다 --
// `BLOCKED:`(화살표도 사유도 없음) 한 단어만 쓴 줄이 이전에는 이 패턴에도
// 안 걸려 근본적으로 매치되지 않았고, `>>>`가 없으니 BLOCKED_ANYWHERE_RE도
// 못 잡아 결국 아무 near-miss도 안 잡혀 state=NONE(조용한 PENDING)으로
// 묻혔다 -- "빈 사유는 BLOCKED_RE도 거부하니 대칭"이라는 1R의 근거는
// 틀렸다(BLOCKED_RE 쪽은 `>>>`가 있으면 near-miss가 받아 내지만, 여기는
// `>>>`가 없어 애초에 받아 낼 곳이 없었다 -- 대칭이 아니라 사각지대).
// 사유를 요구하지 않도록 넓히면 이제 `>>>` 쪽(BLOCKED_ANYWHERE_RE는
// `>>>\s*(BLOCKED|NEEDS_INPUT)\b` -- 이 역시 콜론/사유를 요구하지 않는다)과
// 동작이 같아진다 -- "사유 없는 표지도 근처-미스로 본다"는 기준이 화살표
// 유무와 무관하게 일관된다.
// ⛔BLOCKED_RE(엄격 채택 기준, 채택에는 사유 필수)는 이 상수와 무관하게
// 그대로다 -- 건드리지 않는다.
const BLOCKED_BARE_COLUMN0_RE = /^(BLOCKED|NEEDS_INPUT):/gim;
// HYK-325 §2-3: the non-column-0 meta line finalize-done.mjs appends right
// after a `>>> DONE:` line it wrote itself (see that file's own
// FINALIZE_DONE_MARKER_LINE). Presence is only ever used for a warning
// (see warnIfMissingFinalizeDoneMarker below) -- absence never blocks
// consumption.
const DONE_STAMPED_BY_MARKER_RE = /^done_stamped_by:\s*finalize-done\s*$/im;

// HYK-325 §2-3: best-effort, non-fatal, console-only -- deliberately does
// NOT return a verdict (unlike every other resolve*/check* helper in this
// file) because this signal must never change checkRelayHandshake's own
// ok/reject decision (승격은 이번 범위 밖, coder-task.md §2-3).
function warnIfMissingFinalizeDoneMarker(resultContent) {
  if (!DONE_STAMPED_BY_MARKER_RE.test(resultContent)) {
    console.error(
      "relay-handshake: warning: DONE line has no finalize-done marker -- 손기입 가능성(HYK-325)",
    );
  }
}

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

// HYK-183 §2 R2: the reject-streak ledger must live in ONE place -- the
// main repo -- no matter which worktree relay-handshake.mjs happens to run
// from (a per-worktree ledger silently reads streak=0 forever, per
// reject-streak.mjs's own module header on the 2026-07-26 실측). Mirrors
// hooks/commit-msg's own worktree -> main-clone resolution idiom rather
// than inventing a new one: resolve this cwd's own toplevel, then ask git
// for `--git-common-dir` (absolute when cwd is a linked worktree, relative
// "`.git`" when cwd already IS the main worktree) and strip the trailing
// "/.git" to land back on the main clone's root.
// HYK-183-ledger-fix (축 B): exported so review-gate.mjs (the commit-msg
// hook's script) can resolve the SAME centralized ledger location when it
// records an approval -- see that module's own header for why the approval
// path needs this at all.
export function mainRepoRoot() {
  const root = repoRoot();
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf8",
      cwd: root,
    }).trim();
    const absCommonDir = /^([A-Za-z]:[\\/]|\/)/.test(commonDir)
      ? commonDir
      : join(root, commonDir);
    return absCommonDir.replace(/[\\/]\.git$/, "");
  } catch {
    return root;
  }
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity under the repo's ESLint ceiling) -- resolves the result
// file's task_id echo into either a match or one of three distinct
// diagnoses for the anchored-miss case (see TASK_ID_ANYWHERE_RE above).
// ⛔HYK-332: exported so finalize-done.mjs can reuse this EXACT
// "what counts as a valid task_id header" contract (coder-task.md §2
// 요구5's "정규식을 새로 짓지 말고 재사용하라") instead of a second copy
// that could silently drift. `kind` is additive (existing callers only
// ever read `.ok`/`.reason`) and lets a caller branch on the failure
// shape (missing/ambiguous/mid-line) without string-matching `.reason`.
export function resolveResultTaskId(resultContent) {
  const resultIdMatches = [...resultContent.matchAll(TASK_ID_RE_G)];
  if (resultIdMatches.length > 1) {
    return {
      ok: false,
      kind: "AMBIGUOUS",
      reason: `result has ${resultIdMatches.length} standalone 'task_id:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (resultIdMatches.length === 1) {
    return { ok: true, id: resultIdMatches[0][1] };
  }
  if (TASK_ID_ANYWHERE_RE.test(resultContent)) {
    return {
      ok: false,
      kind: "MID_LINE",
      reason:
        "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
    };
  }
  return {
    ok: false,
    kind: "MISSING",
    reason: "result missing task_id echo (need a `task_id: <id>` line)",
  };
}

// Extracted from checkRelayHandshake (keeps its complexity under the
// repo's ESLint ceiling) -- mirrors resolveResultTaskId's shape: resolves
// the result file's '>>> DONE:' line into either a single match or an
// explicit ambiguity/absence reason, never a silently-chosen one.
function resolveResultDoneMatch(resultContent) {
  const doneMatches = [...resultContent.matchAll(DONE_RE)];
  if (doneMatches.length > 1) {
    return {
      ok: false,
      reason: `result has ${doneMatches.length} '>>> DONE:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (doneMatches.length === 1) {
    return { ok: true, match: doneMatches[0] };
  }
  return {
    ok: false,
    // HYK-173-escalation-1: missing:true marks this specifically as "no
    // DONE line at all" (as opposed to the ambiguous->false branch above)
    // -- checkRelayHandshake uses this flag, not string-matching on
    // `reason`, to decide whether it's worth looking for an explicit
    // BLOCKED/NEEDS_INPUT marker before falling back to plain PENDING.
    missing: true,
    reason: 'result missing ">>> DONE: ... @ <time KST>" line (required)',
  };
}

// HYK-173-escalation-1 (§2 결과파일 상태 확장): resolves the result file's
// explicit "blocked" marker (see BLOCKED_RE above) into one of four
// outcomes -- never silently folded into "still pending". Mirrors
// resolveResultTaskId's ambiguous/malformed/absent three-way split so the
// same fail-closed discipline applies here too.
export const RESULT_BLOCK_STATE = Object.freeze({
  BLOCKED: "BLOCKED",
  NEEDS_INPUT: "NEEDS_INPUT",
  AMBIGUOUS_BLOCKED: "AMBIGUOUS_BLOCKED",
  MALFORMED_BLOCKED: "MALFORMED_BLOCKED",
  NONE: "NONE",
});

function resolveResultBlockedState(resultContent) {
  const matches = [...resultContent.matchAll(BLOCKED_RE)];
  if (matches.length > 1) {
    return {
      state: RESULT_BLOCK_STATE.AMBIGUOUS_BLOCKED,
      reason: `result has ${matches.length} '>>> BLOCKED:'/'>>> NEEDS_INPUT:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  // HYK-173-escalation-2 (REVIEW 반려 (2) 수리): the anywhere-count always
  // includes every well-formed match too (BLOCKED_ANYWHERE_RE's pattern is
  // a strict superset of BLOCKED_RE's), so `anywhereCount > matches.length`
  // means there is at least one marker-shaped occurrence beyond the
  // well-formed one(s) already counted above -- a valid line coexisting
  // with a broken one, previously swallowed silently into the single valid
  // match.
  const anywhereCount = [...resultContent.matchAll(BLOCKED_ANYWHERE_RE)].length;
  // HYK-333: BLOCKED_BARE_COLUMN0_RE matches lines that never start with
  // `>>>` (it anchors on the keyword itself), so it can never overlap with
  // anywhereCount's `>>>`-anchored matches -- summing the two counts every
  // near-miss shape exactly once, no double counting.
  const bareColumn0Count = [...resultContent.matchAll(BLOCKED_BARE_COLUMN0_RE)]
    .length;
  const nearMissCount = anywhereCount + bareColumn0Count;
  if (matches.length === 1) {
    if (nearMissCount > matches.length) {
      return {
        state: RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
        reason:
          "result has a well-formed '>>> BLOCKED:'/'>>> NEEDS_INPUT:' line AND at least one additional malformed '>>> BLOCKED:'/'>>> NEEDS_INPUT:'-shaped marker -- a valid+broken mix is not silently resolved to the valid one (fail-closed)",
      };
    }
    const kind = matches[0][1].toUpperCase();
    const detail = matches[0][2].trim();
    return { state: kind, detail };
  }
  if (nearMissCount > 0) {
    return {
      state: RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
      reason:
        "result has a '>>> BLOCKED:'/'>>> NEEDS_INPUT:'-shaped marker (or a `>>>`-less column-0 'BLOCKED:'/'NEEDS_INPUT:' near-miss, HYK-333) that doesn't match the required column-0, single-line '>>> BLOCKED: <reason>' / '>>> NEEDS_INPUT: <reason>' form (fail-closed -- not treated as pending)",
    };
  }
  return { state: RESULT_BLOCK_STATE.NONE };
}

// HYK-313 §2: how long the round has gone with no observable change to its
// result file. `now`/`resultMtimeMs` are both caller-supplied (mirrors the
// rest of this file's clock-injection convention, see checkRelayHandshake's
// own `now` header comment) -- a missing/unmeasurable mtime (stat failure,
// isolated fixture with no fs access) returns `null`, never a guessed value
// (resolveMissingDoneOutcome treats `null` as "cannot judge age", falling
// back to the pre-HYK-313 unconditional PENDING -- fail-quiet, not
// fail-stalled, per §4-1's "오탐 0" 비타협).
function computePendingAgeMs(now, resultMtimeMs) {
  if (typeof now !== "number" || !Number.isFinite(now)) return null;
  if (typeof resultMtimeMs !== "number" || !Number.isFinite(resultMtimeMs)) {
    return null;
  }
  const ageMs = now - resultMtimeMs;
  return Number.isFinite(ageMs) ? ageMs : null;
}

// HYK-313 §4-1: threshold picked with a documented margin over the longest
// OBSERVED legitimate round in coder-task.md §0 (26 minutes, real incident on
// 2026-08-19) -- 30 minutes give that round ~15% headroom before this axis
// would ever call it stalled. This is the ONLY place §2's invariant trades
// off false positives against detection latency; a round genuinely still
// writing its result file within the last 30 minutes is never reclassified.
export const PENDING_STALL_THRESHOLD_MS = 30 * 60 * 1000;

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- called only
// when resolveResultDoneMatch already confirmed genuine absence
// (`resultDone.missing`, i.e. not the separate ambiguous-DONE case above).
// Turns resolveResultBlockedState's 5-way state into the handshake's
// final ok:false return shape for this branch.
//
// HYK-313 §2/§4-2: `age` is the only new parameter -- BLOCKED/NEEDS_INPUT/
// AMBIGUOUS_BLOCKED/MALFORMED_BLOCKED below are all returned byte-identical
// to before this round (§4-2 비타협). Only the trailing `blocked.state ===
// NONE` branch (the actual "PENDING" case) changes: it now distinguishes a
// freshly-written result file (state stays "PENDING", reason unchanged --
// §4-1 오탐 0, byte-identical to pre-HYK-313 for every round under the
// threshold) from one whose mtime has not moved in
// >= PENDING_STALL_THRESHOLD_MS (a NEW `state: "STALLED_PENDING"`, §2's
// "표면화된 신호" -- still `ok:false`, so §4-2's "기존 ok/state 계약을 깨지
// 마라" is read as "don't touch the other four states", not "PENDING itself
// may never gain a new sibling value").
function resolveMissingDoneOutcome(
  resultContent,
  resultDoneReason,
  { now, resultMtimeMs } = {},
) {
  const blocked = resolveResultBlockedState(resultContent);
  if (
    blocked.state === RESULT_BLOCK_STATE.BLOCKED ||
    blocked.state === RESULT_BLOCK_STATE.NEEDS_INPUT
  ) {
    return {
      ok: false,
      state: blocked.state,
      reason: `worker reported ${blocked.state}: ${blocked.detail}`,
    };
  }
  if (
    blocked.state === RESULT_BLOCK_STATE.AMBIGUOUS_BLOCKED ||
    blocked.state === RESULT_BLOCK_STATE.MALFORMED_BLOCKED
  ) {
    return { ok: false, state: blocked.state, reason: blocked.reason };
  }
  // blocked.state === NONE -- genuinely still in progress or genuinely
  // stalled; computePendingAgeMs (not this function) is where that line is
  // decided.
  const ageMs = computePendingAgeMs(now, resultMtimeMs);
  if (ageMs !== null && ageMs >= PENDING_STALL_THRESHOLD_MS) {
    return {
      ok: false,
      state: "STALLED_PENDING",
      reason: `${resultDoneReason} -- result file has not changed in ${Math.round(
        ageMs / 1000,
      )}s (>= ${PENDING_STALL_THRESHOLD_MS / 1000}s stall threshold, HYK-313): worker may have stopped mid-task without a DONE/BLOCKED/NEEDS_INPUT marker (조용한 무한 대기 방지 -- 오탐 방지 근거는 이 함수 바로 위 PENDING_STALL_THRESHOLD_MS 주석 참조)`,
      ageMs,
    };
  }
  // HYK-313 2R (REVIEW 반려 1 수리): fresh PENDING returns EXACTLY the same
  // shape as the pre-HYK-313 parent commit -- `ageMs` is deliberately never
  // attached here (only the STALLED_PENDING branch above carries it, since
  // that is the new state this round introduces). The task's own "기존과
  // byte-identical" contract for fresh PENDING means the object itself, not
  // just its `state`/`reason` string values.
  return { ok: false, state: "PENDING", reason: resultDoneReason };
}

// Extracted from checkRelayHandshake (same ESLint-ceiling reason as its
// siblings above) -- wraps resolveResultDoneMatch's ok:false outcome,
// routing the genuine-absence case through resolveMissingDoneOutcome and
// leaving the ambiguous-DONE case's existing reason untouched.
function resolveResultDoneOutcome(resultContent, resultDone, ageCtx) {
  if (resultDone.missing) {
    return resolveMissingDoneOutcome(resultContent, resultDone.reason, ageCtx);
  }
  return { ok: false, reason: resultDone.reason };
}

// Extracted from checkRelayHandshake (keeps its complexity under the
// repo's ESLint ceiling) -- surfaces recordRejectStreakFromResultText's
// outcome via console.log/console.error rather than swallowing it (§2-1
// R4). Never touched by tests that assert on checkRelayHandshake's return
// value; this is purely the side-effect wiring described at its call site.
// HYK-204: mirrors autoRecordRejectStreak's shape -- surfaces
// archiveRoundEnvelope's outcome via console.log/console.error rather than
// swallowing it, and never touches this function's own return value.
// HYK-244 2R-a 조각2: return value added (was void) so the receipt-writing
// call site below can know whether this effect actually succeeded --
// logging alone (the pre-existing behavior, kept unchanged above) is
// invisible to a caller that needs a boolean. checkRelayHandshake's OWN
// return value/exit code contract is untouched (§3 금지) -- this return
// value is new surface, not a repurposing of an existing one.
function autoArchiveRoundEnvelope({ role, resultContent, harnessDir }) {
  const outcome = archiveRoundEnvelope({ role, resultContent, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  return outcome.ok;
}

// HYK-241 §2 조각1: archiveRoundEnvelope의 TASK-file 쌍 -- 이 함수가 불리는
// 시점(checkRelayHandshake의 ok:true 분기, 바로 아래)은 이 라운드의 task
// 파일(`<role>-task.md`)이 «다음 라운드가 그 자리를 덮어쓰기 전」 마지막
// 순간이다. §3-3 요건 1의 합격 기준(실패도 한 줄로 보이게)을 그대로
// 만족시키기 위해 autoArchiveRoundEnvelope와 동일하게 성공/실패 모두
// console.log/console.error로 찍는다 -- 조용히 사라지는 실패를 만들지 않는다.
// HYK-307-order-1 §1: archiveRoundTaskFileIfNew instead of the plain
// archiveRoundTaskFile this call used before -- dispatch-gate-decision.mjs
// now ALSO snapshots this same round's task-file text at delivery time
// (before this handshake-time call ever runs, see that file's own
// bestEffortSnapshotRoundTaskFile comment). In the normal ordered flow
// (deliver -> consume, §3 시험 ⓓ) the content here is byte-identical to
// that earlier snapshot, so archiveRoundTaskFile's own next-round-number
// logic would otherwise write a second, redundant copy every single
// round. archiveRoundTaskFileIfNew skips that duplicate (ok:true,
// skipped:true) while still delegating unchanged to archiveRoundTaskFile
// whenever no identical snapshot exists yet (e.g. this axis's own zero-
// import safety net if the new delivery-time hook ever fails/is
// bypassed) -- outcome.ok stays the same true/false either way, so this
// function's own success/failure contract to its caller is unchanged.
function autoArchiveRoundTaskFile({ role, taskContent, harnessDir }) {
  const outcome = archiveRoundTaskFileIfNew({ role, taskContent, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  return outcome.ok;
}

// HYK-244 2R-a 조각2: now returns `{ attempted, ok }` (was void) for the
// same reason as autoArchiveRoundEnvelope above -- REVIEW 계열의
// `ledgerRecorded` 효과를 판단하려면 이 결과가 필요하다. Non-REVIEW roles
// have `attempted:false`, which the receipt-writing call site below reads
// as "이 효과는 이 역할에 해당하지 않는다" (never treated as a failure).
// HYK-262: also carries `reason` through (was discarded after logging) so
// the caller can distinguish WHICH kind of `attempted:true, ok:false`
// this is -- see checkRelayHandshake's own use of it, right below.
function autoRecordRejectStreak({ role, resultContent }) {
  const autoRecord = recordRejectStreakFromResultText({
    role,
    resultText: resultContent,
    ledgerPath: join(mainRepoRoot(), ".harness", "reject-streak.json"),
  });
  if (!autoRecord.attempted) return { attempted: false, ok: false };
  if (autoRecord.ok) {
    console.log(autoRecord.reason);
  } else {
    console.error(autoRecord.reason);
  }
  return {
    attempted: true,
    ok: autoRecord.ok,
    reason: autoRecord.reason,
    reasonCode: autoRecord.reasonCode,
  };
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- HYK-262 §3-1/
// §3-2: ⛔only the AMBIGUOUS-count 표지 줄 계약 violation (`for:`/`task_id:`/
// 판정 줄이 2개 이상이라 «어느 것이 최종인지 결정할 수 없다» --
// reject-streak.mjs:180-185/191/214 원문, all three share this exact
// phrase) rejects consumption. Every OTHER attempted-but-failed shape (no
// verdict line at all, a corrupt/unreadable ledger file) is a pre-existing,
// already-tested "still ok:true, still logs UNJUDGABLE" shape this task's
// scope does NOT touch (§4 완료조건 2: 정상 라운드 회귀 0). Returns null
// when this round is not blocked (the normal case), or the ok:false
// verdict to return immediately otherwise.
// HYK-262 §2 (책임자 확정 2R): the block used to be decided by regex-
// matching the Korean sentence 어느 것이 최종인지 결정할 수 없다 against
// `reason` -- 1R 검토 실측: rewording that sentence by one character
// silently killed the block. This set is the stable, never-reworded
// coupling value instead -- membership check against reject-streak.mjs's
// own REJECT_STREAK_REASON_CODE enum (imported, not re-declared), so the
// two files can never drift out of sync on what "ambiguous cover line"
// means. `reason` (the Korean sentence) is still carried through into this
// function's own return reason below for human readers -- it is read-only
// here now, never matched.
const AMBIGUOUS_COVER_REASON_CODES = new Set([
  REJECT_STREAK_REASON_CODE.AMBIGUOUS_FOR_LINE,
  REJECT_STREAK_REASON_CODE.AMBIGUOUS_TASK_ID_LINE,
  REJECT_STREAK_REASON_CODE.AMBIGUOUS_VERDICT_LINE,
]);

function checkAmbiguousCoverViolation(recordOutcome) {
  const isAmbiguous =
    recordOutcome.attempted &&
    !recordOutcome.ok &&
    AMBIGUOUS_COVER_REASON_CODES.has(recordOutcome.reasonCode);
  if (!isAmbiguous) return null;
  return {
    ok: false,
    reason: `consumption rejected (HYK-262): REVIEW-family result file violates the 표지 줄 계약 (for:/task_id:/판정 줄이 2개 이상 -- ${recordOutcome.reason}) -- envelope/task archiving and consumption receipt are skipped for this round (표지 줄을 고쳐 다시 완료해야 한다)`,
  };
}

// HYK-262 §3 (책임자 확정 2R): the two shapes that reach `attempted:true,
// ok:false` WITHOUT being an ambiguous-cover-line violation (checked above)
// -- e.g. 판정 줄 0개(NO_VERDICT_LINE) or 원장 파일 손상(LEDGER_READ_FAILED/
// LEDGER_INVALID_JSON/LEDGER_INVALID_SHAPE) -- are deliberately NOT blocked
// this round (HYK-266 범위, 착수 금지). But §3의 근거 문장("관측·기록이
// 실패했으면 그 사실이 다음 단계의 「진행 가능 여부」에 반영되어야 한다 --
// 화면 출력만으로는 「반영」이 아니다")은 여전히 지켜야 하므로, 최소한
// «이 경우는 차단하지 않았다»는 사실 자체를 명시적으로 남긴다 -- 기존
// autoRecordRejectStreak의 console.error 한 줄(레코딩 실패 그 자체)과는
// 별개로, «그리고 이건 차단 안 했다»는 판단을 새로 찍는다.
function traceUnblockedRecordFailure(recordOutcome) {
  if (!recordOutcome.attempted || recordOutcome.ok) return;
  const reasonCode = recordOutcome.reasonCode ?? "UNKNOWN_REASON_CODE";
  console.log(
    `relay-handshake: NOT_BLOCKED (HYK-262 §3) -- reject-streak record failed with reasonCode=${reasonCode} but this round is NOT blocked (${recordOutcome.reason}) -- consumption/archiving/receipt proceed normally; HYK-266 (별건) decides whether this reasonCode class should block in future`,
  );
}

// ⛔HYK-324/HYK-325 r2 (REVIEW 반려 P1 수리): exported so finalize-done.mjs
// can reuse this exact parse -- same reason DONE_RE/hasDoneSecondsPrecision
// are exported above. Before this export, finalize-done.mjs's own
// "malformed, eligible for one-time replace" test only checked
// hasDoneSecondsPrecision, never whether the value actually parses --
// so a DONE line with an out-of-range date but seconds-shaped text (e.g.
// '2026-99-99 23:19:01 KST') was "not parseable" here (first observation
// skipped, "can be replaced" told to the caller) but NOT malformed there
// (ALREADY_FINALIZED refused) -- the exact split 검토자가 실측한 것.
export function parseKstTimestamp(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// HYK-324/HYK-325 r2: the ONE place "형식 유효" (format-valid DONE
// timestamp) is defined -- "파싱 가능 + 초 단위", exactly what resolveDoneAt
// below gates on (see its two checks just below this function's call
// sites). finalize-done.mjs's malformedSingle reuses this directly instead
// of re-deriving the same two conditions with its own (previously
// incomplete) copy -- coder-task.md r2 §2-1's explicit "한 곳에서만
// 정의하고 양쪽이 재사용하라".
export function isWellFormedDoneTimestamp(rawText) {
  return (
    parseKstTimestamp(rawText) !== null && hasDoneSecondsPrecision(rawText)
  );
}

// HYK-186 §2 완료조건2: `now` is the ONLY caller-injectable clock in this
// function, and it exists purely for test determinism (mirroring
// pull-admission.mjs's `nowMs` convention) -- the production CLI entry point
// at the bottom of this file never passes it, so every real invocation uses
// the machine clock. This is what "production `now`는 caller 자기신고가
// 아니어야 한다" means in practice: the *candidate* timestamps (dropped_at,
// DONE) are caller-supplied (they come from files workers/ORCH write), but
// the *authority clock* they are judged against is not.
// HYK-257 ⓒ: producer 도구 이름을 필드별로 하나로 고정한다 -- 거부 사유에
// "고치는 법"을 붙일 때마다 매번 다시 조립하지 않도록.
function fixToolHintFor(field) {
  return field === TIME_FIELD.TASK_DROPPED_AT
    ? "node scripts/relay/stamp-dropped-at.mjs (아직 미결선 -- coder-task.md §2 ⓐ 참조)"
    : "node scripts/relay/finalize-done.mjs <role>";
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// dropped_at은 분 단위(초 없음), DONE은 초 단위(HYK-244) -- rawText에 초가
// 있는지로 보정값의 정밀도를 맞춘다(원래 값 형식을 그대로 흉내낸다).
function formatKstLike(ms, rawText) {
  const kst = new Date(ms + KST_OFFSET_MS);
  const base = `${kst.getUTCFullYear()}-${pad2(kst.getUTCMonth() + 1)}-${pad2(
    kst.getUTCDate(),
  )} ${pad2(kst.getUTCHours())}:${pad2(kst.getUTCMinutes())}`;
  const hasSeconds = /\d{2}:\d{2}:\d{2}/.test(rawText);
  return hasSeconds
    ? `${base}:${pad2(kst.getUTCSeconds())} KST`
    : `${base} KST`;
}

// HYK-257 (★새 변종): a value off by ~exactly 9 hours from authority now is
// far more likely a UTC/KST mislabel than a genuine future or genuine
// staleness -- see time-authority.mjs's isSuspectedTimezoneMislabel header
// for why this is a heuristic, not a proof. Checked BEFORE checkFutureSkew
// so a +9h mislabel gets this more specific, correctable diagnosis instead
// of the generic future-skew message.
function checkTimezoneMislabel({ candidateDate, rawText, field, now }) {
  const candidateMs = candidateDate.getTime();
  if (!isSuspectedTimezoneMislabel(candidateMs, now)) return null;
  const state =
    field === TIME_FIELD.TASK_DROPPED_AT
      ? TIME_AUTHORITY_STATE.SUSPECTED_TZ_MISLABEL_DROPPED_AT
      : TIME_AUTHORITY_STATE.SUSPECTED_TZ_MISLABEL_DONE;
  const isAheadOfNow = candidateMs > now;
  const correctedMs = isAheadOfNow
    ? candidateMs - KST_OFFSET_MS
    : candidateMs + KST_OFFSET_MS;
  const corrected = formatKstLike(correctedMs, rawText);
  return {
    ok: false,
    state,
    reason: `'${field}' value '${rawText.trim()}' is suspiciously close to exactly 9 hours ${
      isAheadOfNow ? "ahead of" : "behind"
    } authority now (${new Date(now).toISOString()}) -- looks like a UTC value mislabeled 'KST' (or vice versa), not a genuine ${isAheadOfNow ? "future" : "stale"} value. 고치는 법: 손으로 9시간을 더하거나 빼지 말고 시계를 다시 읽어라 -- 아마 '${corrected}'를 의도했을 것이다. 앞으로는 ${fixToolHintFor(field)} 로 찍어라(손기입 금지).`,
  };
}

function checkFutureSkew({ candidateDate, rawText, field, now }) {
  const beyond = isBeyondFutureSkew(candidateDate.getTime(), now, field);
  if (beyond === false) return null;
  const skewMs = candidateDate.getTime() - now;
  const state =
    field === TIME_FIELD.TASK_DROPPED_AT
      ? TIME_AUTHORITY_STATE.FUTURE_DROPPED_AT
      : TIME_AUTHORITY_STATE.FUTURE_DONE;
  const reason =
    beyond === null
      ? `time-authority registry has no row for '${field}' -- fail-closed, treating '${rawText.trim()}' as a future violation`
      : `'${field}' value '${rawText.trim()}' is ${Math.round(
          skewMs / 1000,
        )}s ahead of authority now (${new Date(now).toISOString()}), which exceeds the allowed skew of ${MAX_FUTURE_SKEW_MS}ms. 고치는 법: 시계를 다시 읽어 지금(now)에 가까운 값으로 고쳐라(미리 적지 마라) -- 앞으로는 ${fixToolHintFor(field)} 로 찍어라.`;
  return { ok: false, state, reason };
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- resolves the
// task file's dropped_at header into a parsed Date, applying the HYK-186
// future-skew check as part of that resolution (a dropped_at that projects
// into the future is a config-shape problem, independent of whether a
// result exists yet at all).
function resolveDroppedAt(taskContent, now) {
  const droppedMatch = taskContent.match(DROPPED_AT_RE);
  if (!droppedMatch) {
    return {
      ok: false,
      reason:
        "task file missing dropped_at header (required for staleness check)",
    };
  }
  const droppedAt = parseKstTimestamp(droppedMatch[1]);
  if (!droppedAt) {
    return {
      ok: false,
      reason: `task dropped_at not parseable: '${droppedMatch[1].trim()}' (need YYYY-MM-DD HH:MM KST format, e.g. '2026-08-17 05:22 KST' -- 앞으로는 ${fixToolHintFor(TIME_FIELD.TASK_DROPPED_AT)} 로 찍어라)`,
    };
  }
  const droppedMislabel = checkTimezoneMislabel({
    candidateDate: droppedAt,
    rawText: droppedMatch[1],
    field: TIME_FIELD.TASK_DROPPED_AT,
    now,
  });
  if (droppedMislabel) return droppedMislabel;
  const droppedFuture = checkFutureSkew({
    candidateDate: droppedAt,
    rawText: droppedMatch[1],
    field: TIME_FIELD.TASK_DROPPED_AT,
    now,
  });
  if (droppedFuture) return droppedFuture;
  return { ok: true, droppedAt, droppedMatch };
}

// HYK-244 2R-a §1/§2 조각1: 저장소가 «분 단위»를 시켰다(templates/
// harness-init/status.template.md의 예전 `>>> DONE: <role> @ <YYYY-MM-DD
// HH:MM>`)는 것이 실측된 뿌리 원인이고, 소비 절차(여기)는 그 형식을 전혀
// 검사하지 않았다(예전 `DONE_RE`는 `.+?`로 뒤 텍스트 전체를 그냥 받았다).
// 한용 확정 문면(coder-task.md §0, 2026-08-14 07:10, 조정 금지) = "«분
// 단위 거부» 문면은 약화 없이 유지" -- «시키는 곳»(템플릿)과 «검사하는
// 곳»(여기) 둘 다 손봐야 실제로 초 단위가 남는다.
//
// 왜 doneAt이 성공적으로 파싱된 «뒤에만» 이 검사를 거는가: `parseKstTimestamp`
// 는 여전히 `HH:MM(:SS)?`(초 선택)를 그대로 받아들인다(HYK-142 6A가 얼린
// 계약, time-authority.mjs 참조) -- 이 함수를 고치면 "형식이 아예 깨진
// 값"(예: `@ soon`)의 기존 "not parseable" 판정까지 건드리게 된다. 대신
// «값은 유효한 KST 시각으로 파싱됐지만 초가 없다»는 경우만 새로 거부하는
// 것이 이번 조각의 정확한 범위다 -- 그래서 파싱 성공 직후, future-skew
// 검사보다 먼저 이 확인을 끼워 넣는다(사유 문자열이 겹치지 않게).
// HYK-244 2R-a: minute-precision timestamps can't distinguish two rounds
// completed in the same minute -- seconds are required, not optional.
// ⛔HYK-324/HYK-325: exported so finalize-done.mjs can reuse this exact
// criterion (see DONE_RE's own export comment above -- same reason).
const DONE_SECONDS_PRECISION_RE = /\d{2}:\d{2}:\d{2}/;

export function hasDoneSecondsPrecision(rawDoneAtText) {
  return DONE_SECONDS_PRECISION_RE.test(rawDoneAtText);
}

// Extracted from checkRelayHandshake (same ESLint-ceiling reason as
// resolveDroppedAt above) -- resolves the result file's '>>> DONE:' line
// into a parsed Date, applying the HYK-244 seconds-precision check and the
// HYK-186 future-skew check as part of that resolution. ★PM 실측 재현
// 대상: before the HYK-186 fix, a DONE line dated 2099-01-01 passed
// silently ({"ok":true, reason:"relay handshake ok for FUTURE-1"}) --
// checkRelayHandshake had exactly one time comparison (`doneAt <
// droppedAt`) and zero comparisons against `now`. That fix rejects a DONE
// timestamp beyond authority-clock skew before it can ever reach the
// staleness/ok:true path in checkRelayHandshake; this HYK-244 addition
// rejects a DONE timestamp that lacks seconds precision, for the same
// "reject loudly before the ok:true path" reason.
// HYK-257-done-stamp-2 §2 범위1: called the MOMENT a well-formed '>>> DONE:'
// line is found -- before the mislabel/future-skew validity checks below,
// and on EVERY call (watch-result.mjs's watchResult polls checkRelayHandshake
// repeatedly, see first-observation.mjs's own header for the real production
// caller this closes the race against). Best-effort, non-fatal: a spawn
// failure here must never block or alter checkRelayHandshake's own verdict
// on its own (mirrors spawnAdmissionCompletion's house style exactly) --
// treated as "no observation available" (rewritten:false), not as a reject.
//
// HYK-324 §2-2: "well-formed" now specifically means format-valid (parses
// AND has seconds precision) -- see resolveDoneAt's call site below. This
// function itself does not decide that; it only records whatever it is
// asked to observe. A format-invalid DONE line is filtered out BEFORE
// reaching this call (never observed at all) because it can never be
// consumed anyway (checkRelayHandshake's own format checks reject it), so
// pinning it as "first observed" would only block finalize-done's one-time
// malformed-replace recovery path (HYK-324/HYK-325) without protecting
// anything -- the HYK-257 race this function guards against is about a
// FORMAT-VALID value being rewritten mid-flight, which is unaffected by
// this change (see resolveDoneAt).
//
// HYK-257-done-stamp-3 §2 범위1 (2R 반려 수리): `taskId`/`droppedAt`은
// 이제 별도 필드로 넘어간다 -- 2R처럼 `${taskId}::${droppedAt}`로 이어붙인
// 문자열 하나를 이 함수의 `taskId` 매개변수 자리에 밀어넣지 않는다(그
// 이어붙이기가 2R 반려 사유였다: 레코드에 진짜 dropped_at 필드가 없었고,
// 분-정밀도 충돌 시 같은 문자열 키가 서로 다른 라운드를 오염시켰다).
function spawnObserveDoneLine({
  taskId,
  droppedAt,
  role,
  harnessDir,
  resultContent,
  doneLineRaw,
}) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "first-observation.mjs",
    );
    const payload = JSON.stringify({
      taskId,
      droppedAt,
      role,
      resultContent,
      doneLineRaw,
    });
    const out = execFileSync("node", [scriptPath, harnessDir, payload], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim());
  } catch (err) {
    console.error(
      `relay-handshake: first-observation spawn skipped/failed (non-fatal, treated as no-observation -- HYK-257-done-stamp-2 §2 범위1): ${err.stderr ?? err.message}`,
    );
    return { rewritten: false, error: "spawn failed" };
  }
}

// HYK-257-done-stamp-3 §2 범위1 (로그 수명): called exactly once, at the
// moment checkRelayHandshake has confirmed this round is fully COMPLETE
// (every check above -- handshake, dropped_at/DONE parsing, mislabel,
// future-skew, staleness, intermediate-rewrite -- has already passed).
// Marks this (taskId, droppedAt) generation as consumed in the
// first-observation log so a LATER round that happens to reuse the same
// key (2R's missed 분-정밀도 충돌 시나리오) starts a clean new generation
// instead of being compared against this already-judged round's value.
// Best-effort, non-fatal -- mirrors spawnObserveDoneLine's own house style
// exactly: a failure here must never change checkRelayHandshake's own
// verdict (the round is already judged complete by this point regardless).
function spawnMarkObservationConsumed({ taskId, droppedAt, role, harnessDir }) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "first-observation.mjs",
    );
    const payload = JSON.stringify({
      taskId,
      droppedAt,
      role,
      action: "markConsumed",
    });
    const out = execFileSync("node", [scriptPath, harnessDir, payload], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out.trim());
  } catch (err) {
    console.error(
      `relay-handshake: first-observation mark-consumed spawn skipped/failed (non-fatal -- HYK-257-done-stamp-3 §2 범위1): ${err.stderr ?? err.message}`,
    );
    return { recorded: false, reason: "spawn failed" };
  }
}

function resolveDoneAt(
  resultContent,
  now,
  { taskId, droppedAtRaw, role, harnessDir, resultMtimeMs } = {},
) {
  const resultDone = resolveResultDoneMatch(resultContent);
  if (!resultDone.ok) {
    // HYK-173-escalation-1 (§2): only the genuine-absence case (no
    // '>>> DONE:' line anywhere -- `missing`) is eligible to be
    // reclassified as an explicit BLOCKED/NEEDS_INPUT state. The
    // ambiguous-DONE case above keeps its existing reason/behavior
    // untouched (regression 0 on the `>>> DONE:` path).
    // HYK-313: `{ now, resultMtimeMs }` only ever reaches
    // resolveMissingDoneOutcome (via resolveResultDoneOutcome) -- the
    // ambiguous-DONE branch inside resolveResultDoneOutcome ignores this
    // 3rd argument entirely, so its own reason/behavior is untouched.
    return resolveResultDoneOutcome(resultContent, resultDone, {
      now,
      resultMtimeMs,
    });
  }
  const doneMatch = resultDone.match;

  // HYK-324 §2-2: format validity (parseable AND seconds-precision) is now
  // checked FIRST, before the first-observation spawn below. A format-
  // invalid DONE line can never be consumed regardless (checkRelayHandshake
  // rejects it here, every time), so recording it as "first observed" would
  // only block finalize-done's one-time malformed-replace recovery path,
  // not protect anything -- see spawnObserveDoneLine's own header for why
  // this is safe. When the format check fails, first observation is
  // skipped entirely (never spawned) and the reason is surfaced on stderr
  // so an operator watching the log sees why no observation was recorded.
  const doneAt = parseKstTimestamp(doneMatch[1]);
  if (!doneAt) {
    console.error(
      `relay-handshake: first-observation skipped: DONE line malformed (not parseable: '${doneMatch[1].trim()}') -- finalize-done 으로 1회 교체할 수 있다`,
    );
    return {
      ok: false,
      reason: `result DONE timestamp not parseable: '${doneMatch[1].trim()}' (need 'YYYY-MM-DD HH:MM:SS KST' format, e.g. '2026-08-17 05:22:47 KST' -- 앞으로는 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 찍어라)`,
    };
  }
  if (!hasDoneSecondsPrecision(doneMatch[1])) {
    console.error(
      `relay-handshake: first-observation skipped: DONE line malformed (minute-precision, seconds required: '${doneMatch[1].trim()}') -- finalize-done 으로 1회 교체할 수 있다`,
    );
    return {
      ok: false,
      reason: `result DONE timestamp is minute-precision, seconds required: '${doneMatch[1].trim()}' (need YYYY-MM-DD HH:MM:SS KST -- HYK-244 2R-a: minute precision cannot distinguish same-minute rounds, and the "분 단위 거부" contract is fixed, not relaxable. 앞으로는 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 찍어라)`,
    };
  }

  // HYK-257-done-stamp-2 §2 범위1: record-then-compare happens here, BEFORE
  // mislabel/future-skew rejection can short-circuit -- an intermediate
  // rewrite (§2 범위1 실사례) must be observed even on a poll whose OWN
  // value would independently fail one of those checks (the real
  // incidents' first-observed value was itself a future/bad stamp, later
  // self-corrected). The reject decision on `observation.rewritten` is
  // only ACTED on at the final judged-ok:true moment in
  // checkRelayHandshake -- see that function's own use of this field.
  // HYK-324 §2-2: this call site moved BELOW the format-validity checks
  // above (was above them before this change) -- see this function's
  // header comment for why that reordering is safe (HYK-257's protection
  // is unaffected: it is about a format-VALID value rewritten mid-flight).
  //
  // HYK-257-done-stamp-3 §2 범위1 (2R 반려 수리): (taskId, droppedAt)을
  // 별도 필드로 first-observation.mjs에 넘긴다 -- 2R처럼 이어붙인 문자열
  // 하나를 taskId 자리에 밀어넣지 않는다. 이 저장소는 같은 task_id를
  // 여러 라운드에 걸쳐 재사용한다(ORCH가 다음 라운드 task 파일을 같은
  // taskId로 다시 덮어쓰는 것이 정상 -- HYK-241의 존재 이유 자체가 그
  // 덮어쓰기), 그래서 (taskId, droppedAt) 둘 다로 라운드를 구별해야
  // 한다. dropped_at은 «분» 정밀도뿐이라(DROPPED_AT_FORMAT_RE) 같은 분
  // 안의 연속 두 라운드는 이 쌍이 우연히 같아질 수 있다 -- 그 충돌은
  // first-observation.mjs의 소비-시(consumed) tombstone 수명 관리가
  // 닫는다(그 파일 자신의 findFirstObservation 헤더 참조): 라운드가
  // 소비 완료되면 그 세대는 tombstone으로 닫히고, 다음 라운드가 같은
  // 키를 재사용해도 이전 세대의 값과 비교되지 않고 새로 관측을
  // 시작한다.
  const observation =
    taskId && droppedAtRaw
      ? spawnObserveDoneLine({
          taskId,
          droppedAt: droppedAtRaw,
          role,
          harnessDir,
          resultContent,
          doneLineRaw: doneMatch[0],
        })
      : { rewritten: false };
  const doneMislabel = checkTimezoneMislabel({
    candidateDate: doneAt,
    rawText: doneMatch[1],
    field: TIME_FIELD.RESULT_DONE_AT,
    now,
  });
  if (doneMislabel) return doneMislabel;
  const doneFuture = checkFutureSkew({
    candidateDate: doneAt,
    rawText: doneMatch[1],
    field: TIME_FIELD.RESULT_DONE_AT,
    now,
  });
  if (doneFuture) return doneFuture;
  return { ok: true, doneAt, doneMatch, observation };
}

// HYK-244 2R-a §2 조각2: `dispatchId`는 ⛔호출자가 명시적으로 넘긴 값만
// 쓴다(추측·유추 금지) -- 기본값 undefined, 넘어오지 않으면 영수증의
// binding에 그대로 undefined로 남아 1R 코어(consumption-receipt-core.mjs)
// 의 checkBindingPreconditions가 "주 열쇠 미확정"으로 거부한다(영수증이
// 있어도 아직 PASS를 못 낸다는 뜻 -- 이 조각의 범위 그대로, §3 정직
// 한계). 어디서 이 값을 넘길지는 2R-b가 결선한다.
// HYK-244 2R-ci-1: 파일 경로에 쓰는 표기와 결속/영수증에 담기는 role
// 값을 분리한다 -- 관제실 dispatch-worker.ps1(166/260행)이 실측으로
// 확인된 실제 관례: 라이브 task/result 파일은 항상 `$Role.ToLower()`로
// 쓴다(`.harness/coder-task.md`/`.harness/coder.md`, 이 워크트리에서
// `ls .harness/*.md`로 직접 확인 -- 전부 소문자). Windows는 파일시스템이
// 대소문자를 구별하지 않아 role이 대문자("CODER")로 와도 그 lowercase
// 파일을 그대로 찾지만, Linux(CI)는 구별해 못 찾는다(PR #152 CI
// `enforce` 잡 실측: "task file not found: .../CODER-task.md"). role
// 자신(바인딩·영수증·isReviewFamilyRole·아카이브 파일명에 쓰이는 값)은
// 검토 승인분이라 그대로 둔다 -- 오직 파일 경로 조립에만 소문자화한
// 별도 값을 쓴다.
//
// ⛔이 함수를 export하는 이유(HYK-244 2R-ci-1 §3): 파일시스템의 대소문자
// 구별 여부에 기대는 시험은 Windows에서 이 결함이 재발해도 절대 못
// 잡는다(오늘 실제로 그랬다 -- 로컬 3자리 전부 통과, CI만 반증). 이
// 함수를 순수 문자열 변환으로 분리해 export하면, "join 결과 문자열이
// 항상 소문자 파일명을 낸다"를 파일 존재 여부와 무관하게, 어느
// OS에서든 assert.equal 하나로 확인할 수 있다.
export function resolveLiveRoundFilePaths(role, harnessDir) {
  const roleForPath = String(role).toLowerCase();
  return {
    taskPath: join(harnessDir, `${roleForPath}-task.md`),
    resultPath: join(harnessDir, `${roleForPath}.md`),
  };
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (pure
// decomposition -- max-lines-per-function/complexity ESLint limits, 동작
// 변경 0) -- resolves the live task/result file paths, confirms both exist,
// and reads their content. Identical checks/return shapes/order to what
// used to be inline at the top of checkRelayHandshake.
function resolveTaskAndResultFiles(role, harnessDir) {
  const { taskPath, resultPath } = resolveLiveRoundFilePaths(role, harnessDir);

  if (!existsSync(taskPath)) {
    return { ok: false, reason: `task file not found: ${taskPath}` };
  }
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      reason: `result file not found (worker not done?): ${resultPath}`,
    };
  }

  // HYK-313 §2: resultPath's own fs mtime is the one age signal this round
  // adds -- engine-agnostic (filesystem-only, no Claude-hook/codex-session
  // dependency, §3 요건) and reflects "언제 이 결과 파일이 마지막으로
  // 쓰였는가" directly, unlike dropped_at (a round can legitimately still be
  // actively writing long after it was dropped -- see resolveMissingDoneOutcome's
  // own header for why dropped_at was rejected as the age basis). Best-effort:
  // a stat failure here must not block the handshake's existing checks, so it
  // degrades to `null` (resolveMissingDoneOutcome then falls back to the
  // pre-HYK-313 unconditional PENDING, never mis-stalls on a measurement gap).
  let resultMtimeMs;
  try {
    resultMtimeMs = statSync(resultPath).mtimeMs;
  } catch {
    resultMtimeMs = null;
  }

  return {
    ok: true,
    taskPath,
    resultPath,
    taskContent: readFileSync(taskPath, "utf8"),
    resultContent: readFileSync(resultPath, "utf8"),
    resultMtimeMs,
  };
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (same
// ESLint-limit reason as resolveTaskAndResultFiles above) -- resolves and
// cross-checks the task file's task_id header against the result file's
// task_id echo. Identical checks/return shapes/order to what used to be
// inline in checkRelayHandshake.
function resolveMatchedTaskId(taskContent, resultContent) {
  const taskIdMatch = taskContent.match(TASK_ID_RE);
  if (!taskIdMatch) {
    return { ok: false, reason: "task file missing task_id header" };
  }
  const taskId = taskIdMatch[1];

  const resultTaskId = resolveResultTaskId(resultContent);
  if (!resultTaskId.ok) {
    return { ok: false, reason: resultTaskId.reason };
  }
  const resultId = resultTaskId.id;

  if (taskId !== resultId) {
    return {
      ok: false,
      reason: `handshake mismatch: task dropped '${taskId}' but result echoes '${resultId}' (stale or wrong task)`,
    };
  }

  return { ok: true, taskId };
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (same
// ESLint-limit reason as above) -- the two checks that sit between
// resolveDoneAt succeeding and the completion side-effects starting:
// intermediate-rewrite rejection (HYK-257-done-stamp-2 §2 범위1) and the
// pre-existing staleness rejection. Returns the ok:false verdict to return
// immediately, or null when neither check rejects (proceed). Comments
// preserved verbatim from their original inline location -- same checks,
// same order, same reasons, only moved.
function checkRewriteAndStaleness({
  observation,
  doneAt,
  droppedAt,
  doneMatch,
  droppedMatch,
}) {
  // HYK-257-done-stamp-2 §2 범위1: this is the "최종 판정 시점" the 반려
  // 사유가 요구한 대조 지점 -- every check above (task_id 결속, dropped_at/
  // DONE 파싱·미래-시각·시간대-착오·staleness) has already passed, so this
  // is the moment checkRelayHandshake is ABOUT TO judge the round complete.
  // ★판정 강도(즉시 거부, 경고-후-통과 아님): 이 저장소는 fail-loud를
  // 일관되게 택해 왔다(HYK-183 결과파일 표지 중복=판정불가, HYK-262 표지
  // 줄 계약 위반=거부 -- "조용히 하나를 고르지 않는다"는 이 파일 맨 위
  // 주석부터의 반복 원칙). 중간 수정이 있었다는 것은 «기계가 판정하기 전
  // 결과 파일이 최소 한 번 더 쓰였다»는 사실 자체가 이미 손기입/시간
  // 착오 재발의 강한 신호이므로(§2 실사례 세 건 모두 자기정정이었지만,
  // 이 채널은 "그 결과가 우연히 옳았는지"를 판단할 수단이 없다 -- 오직
  // «달랐다»만 안다), 경고만 남기고 통과시키면 다음 라운드의 똑같은
  // 손기입을 막을 계기를 잃는다. ⛔정상 라운드 오탐 0은 위 observeDoneLine
  // 의 "처음 관측 = 스스로와 비교"설계로 이미 보장된다(rewritten은 오직
  // 두 번째 이상 서로 다른 관측이 있을 때만 true).
  if (observation?.rewritten) {
    return {
      ok: false,
      state: TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
      reason: `result DONE line was rewritten between first observation and final judgment (HYK-257-done-stamp-2 §2 범위1): first observed '${observation.existing?.doneLineRaw}' (at ${observation.existing?.observedAtMs}ms), now judging '${observation.currentDoneLine}' -- 소비 직전 중간 수정이 감지되어 거부한다(즉시 거부, 경고 아님). 고치는 법: DONE을 다시 손으로 고치지 말고 ${fixToolHintFor(TIME_FIELD.RESULT_DONE_AT)} 로 한 번만 찍어라.`,
    };
  }

  if (doneAt < droppedAt) {
    return {
      ok: false,
      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,
    };
  }

  return null;
}

// HYK-257-done-stamp-lint-1: extracted from checkRelayHandshake (same
// ESLint-limit reason as above) -- runs every completion side-effect for a
// round that has passed every check above (consumed-observation tombstone,
// reject-streak record, envelope/task archiving, admission-completion
// return, consumption-receipt write), in the exact order/comments they used
// to run inline in checkRelayHandshake. Returns the ok:false verdict to
// return immediately for the one side-effect that can still change the
// function's own verdict (HYK-262's ambiguous-cover-line REVIEW rejection),
// or null when every check here still allows the round to complete.
function runCompletionSideEffects({
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
  droppedMatch,
  doneMatch,
  dispatchId,
}) {
  // HYK-257-done-stamp-3 §2 범위1 (로그 수명): this round is now confirmed
  // complete (every prior check passed) -- close out this generation's
  // first-observation entry so a future round cannot be compared against
  // it (see spawnMarkObservationConsumed's own header for why this must
  // happen exactly here, not earlier/later).
  spawnMarkObservationConsumed({
    taskId,
    droppedAt: droppedMatch[1].trim(),
    role,
    harnessDir,
  });

  // HYK-183 §2: the moment this function confirms a REVIEW-family result
  // file is COMPLETE (every prior check above already passed) is the one
  // moment the reject-streak ledger should be updated -- record's whole
  // job (reject-streak.mjs) is "did the LATEST, non-stale round on this
  // issue get rejected or approved", and everything above this line is
  // exactly the staleness/ambiguity resolution that answers that. Wired
  // here (inside the shared decision function, not only the CLI block) so
  // every caller -- the CLI AND in-process callers like relay-core.mjs --
  // gets it; §1's original gap was that NOTHING called `record` anywhere.
  //
  // HYK-262: moved AHEAD of autoArchiveRoundEnvelope/autoArchiveRoundTaskFile
  // (was after both -- see git history) and now DOES mutate this function's
  // own return value/exit code for one specific case: a REVIEW-family
  // result whose ledger record was attempted but failed (`attempted:true,
  // ok:false` -- e.g. a 표지 줄 계약 위반 that reject-streak.mjs itself
  // reports UNJUDGABLE for). Before this change that failure was only ever
  // surfaced via console.error while checkRelayHandshake still returned
  // ok:true -- the round finished silently with the reject-streak ledger
  // permanently missing an entry, disarming 게이트 2 (연속반려) with no
  // trace beyond a log line nobody was watching (실사고 2026-08-14, HYK-262
  // §2). ⛔이 조각의 상설 문장: «관측·기록이 실패했으면 그 사실이 다음
  // 단계의 «진행 가능 여부»에 반영되어야 한다 -- 화면 출력만으로는 «반영»이
  // 아니다.» Placing this check BEFORE the archive calls (rather than after,
  // leaving them unchanged) is a deliberate design choice, not an
  // accident: the completion condition's literal wording is "종료코드 0
  // 아님 · 영수증 미발행 · 보관 미실시" (exit nonzero, no receipt, NO
  // ARCHIVE) -- reordering makes "보관 미실시" literally true (the archive
  // calls are never reached) instead of leaving a half-true state where the
  // round is rejected AFTER its envelope/task file already got copied into
  // `.harness/rounds/`. CODER/VERIFY (isReviewFamilyRole false) are
  // unaffected: `autoRecordRejectStreak` returns `{attempted:false}` for
  // them, so this branch never fires and archiving/completion proceed
  // exactly as before (§3-1 요건, HYK-262 범위 -- REVIEW 계열만 영향).
  const recordOutcome = autoRecordRejectStreak({ role, resultContent });
  const coverViolation = checkAmbiguousCoverViolation(recordOutcome);
  if (coverViolation) return coverViolation;
  traceUnblockedRecordFailure(recordOutcome);
  // HYK-204: the moment this function confirms a round's result file is
  // COMPLETE (every check above already passed) is also the last moment
  // before ORCH drops the next round's task file and this same
  // `<role>.md` slot gets overwritten -- the exact loss point the 2026-08-08
  // 실사례 hit. Archived here (not left to the worker to remember) for the
  // same reason autoRecordRejectStreak lives here: every caller -- CLI and
  // in-process alike -- gets it, with no new notification device.
  const envelopeArchived = autoArchiveRoundEnvelope({
    role,
    resultContent,
    harnessDir,
  });
  const taskArchived = autoArchiveRoundTaskFile({
    role,
    taskContent,
    harnessDir,
  });
  // HYK-227 §2: moved here from the CLI-only `invokedDirectly` block below
  // (was line-local to that block prior to this change) so EVERY caller of
  // checkRelayHandshake -- not only the CLI entry point -- reaches this
  // completion step, exactly mirroring autoArchiveRoundEnvelope/
  // autoRecordRejectStreak immediately above (same call site, same "every
  // caller, CLI and in-process alike, gets it" contract). This is the fix
  // for the HYK-224-2R §3 옵션3 header comment's own documented gap ("in-
  // process callers... don't get this completion wiring -- CLI spawn point
  // only"): spawnAdmissionCompletion itself is unchanged (still a
  // try/catch-wrapped subprocess spawn, never a static import, so the 1R
  // isolated-fixture failure this design avoids stays avoided -- see that
  // function's own header).
  // HYK-312 §1: this local closure captures `harnessDir` (already a
  // parameter of the enclosing runCompletionSideEffects) so the module-level
  // spawnAdmissionCompletionProcess can learn which round directory is
  // actually being consumed, WITHOUT changing this call site's own text --
  // relay-handshake-completion-wire.test.mjs's ⓒ mutation test pins that
  // exact call-site line as its deletion target (see that test's own
  // `target` constant), so the call site itself must stay byte-identical.
  function spawnAdmissionCompletion(taskId) {
    return spawnAdmissionCompletionProcess(taskId, harnessDir);
  }
  const admissionReturned = spawnAdmissionCompletion(taskId);

  // HYK-244 2R-a §2 조각2: the moment every above effect's OWN outcome is
  // known (never before -- §1 실측: 이 셋은 실패해도 로그만 남기고 위
  // ok:true 자체는 바뀌지 않는다) is the one moment a consumption receipt
  // can be honestly issued. ⛔비타협: 후속효과 중 하나라도 실패하면 성공
  // 영수증을 만들지 않는다(§2 조각2 원문) -- writeReceipt below is only
  // ever called when requiredEffectsOk is true.
  autoWriteConsumptionReceipt({
    role,
    harnessDir,
    resultContent,
    taskId,
    droppedAt: droppedMatch[1].trim(),
    dispatchId,
    doneAt: doneMatch[1].trim(),
    envelopeArchived,
    taskArchived,
    admissionReturned,
    recordOutcome,
  });

  return null;
}

// HYK-342/HYK-249 §3 채택 설계 -- «정지 종결(termination)» 후속효과.
//
// coder-task.md §1 기전: relay-handshake.mjs는 BLOCKED/NEEDS_INPUT을
// ok:false로 되돌리고 여기서 멈췄다 -- 라운드를 닫는 후속효과 5종(봉투
// 보관 2종·원장 자리 반납·소비 영수증 발행·첫 관측 기록)이 전부 ok:true
// 가지(runCompletionSideEffects)에만 매달려 있어 정지 라운드는 그 중 어느
// 것도 받지 못했다. HYK-249(자리 미반납)와 HYK-342(다음 배달 영구 거부)는
// 이 하나의 결손의 증상 둘이다.
//
// 이 함수는 그 중 정지 경로에 맞는 세 가지만 붙인다: 봉투 보관 2종(그대로
// 재사용, envelope-archive.mjs는 role/resultContent 또는 taskContent/
// harnessDir만 받는 순수 함수라 ok:true 분기와 똑같이 부를 수 있다) ·
// 원장 자리 반납(단 «완료»가 아니라 «정지 회수» 사유로 -- admission-
// ledger-core.mjs의 completeReservation에 새로 추가된 선택적 reason 인자,
// COMPLETION_REASON.BLOCKED_TERMINATION_RELEASED) · 중단 기록 작성
// (abort-record-writer.mjs를 여기서 프로덕션에 처음 결선한다, HYK-298이
// 만들었지만 프로덕션 호출자가 0이었던 그 문). 소비 영수증(정상 완료
// 전용)과 첫 관측 기록(DONE 라인 전용)은 정지 라운드에 해당하지 않으므로
// 붙이지 않는다.
//
// ⛔모두 best-effort, non-fatal -- 이 함수의 반환값(void)은 checkRelayHandshake
// 자신의 ok:false/reason/state를 조금도 바꾸지 않는다(runCompletionSideEffects의
// ok:true 분기와 동일한 "부수효과는 판정을 바꾸지 않는다" 원칙, S11).
//
// ⛔state가 정확히 "BLOCKED" | "NEEDS_INPUT"일 때만 실행한다(§3 "BLOCKED/
// NEEDS_INPUT 가지" 그대로) -- AMBIGUOUS_BLOCKED/MALFORMED_BLOCKED/PENDING/
// STALLED_PENDING은 "정상적으로 정지를 선언한 라운드"가 아니라 "판정 자체가
// 불확실한" 상태이므로, 그런 상태에서 원장 자리를 반납하거나 중단 기록을
// 남기면 아직 살아있을 수도 있는 라운드의 자리를 성급하게 빼앗는 결과가
// 된다.
function runBlockedTerminationSideEffectsIfApplicable({
  state,
  role,
  harnessDir,
  taskId,
  taskContent,
  resultContent,
  droppedMatch,
  dispatchId,
  resultPath,
  now,
}) {
  if (state !== "BLOCKED" && state !== "NEEDS_INPUT") return;

  // ⚠️인자 순서가 runCompletionSideEffects의 동일 호출과 다르다(의도적 --
  // 동작은 완전히 같지만, envelope-archive-mutation.test.mjs/hyk241-task-
  // archive-mutation.test.mjs의 assertExactlyOneMatch가 정확히 1개의
  // call-site 문자열만 찾도록 요구한다. 두 자리를 byte-identical로
  // 만들면 "어느 자리를 변이할지" 자체가 모호해진다).
  const envelopeArchived = autoArchiveRoundEnvelope({
    role,
    harnessDir,
    resultContent,
  });
  const taskArchived = autoArchiveRoundTaskFile({
    role,
    harnessDir,
    taskContent,
  });
  const abortReleased = spawnAdmissionAbortProcess(taskId, harnessDir, role);

  spawnAbortRecordWriter({
    role: role.toUpperCase(),
    harnessDir,
    harnessTaskLabel: taskId,
    dispatchId,
    droppedAt: droppedMatch[1].trim(),
    leftoverFingerprint: computeResultFingerprint(resultContent),
    leftoverPath: resultPath,
    recordedAt: new Date(now).toISOString(),
    evidence: {
      source: "relay-handshake-blocked-termination",
      state,
      envelopeArchived,
      taskArchived,
      abortReleased,
    },
  });
}

// HYK-257-done-stamp-lint-1: decomposed into resolveTaskAndResultFiles/
// resolveMatchedTaskId/checkRewriteAndStaleness/runCompletionSideEffects
// (all defined immediately above, in the exact original inline order) to
// satisfy ESLint's max-lines-per-function/complexity limits (real
// pre-commit gate, HYK-148) -- 순수 분해, 동작 변경 0: every check, every
// side-effect call, every comment explaining WHY a step exists, is
// unchanged and runs in the exact same order as before. Only the "which
// function's stack frame it runs in" changed.
export function checkRelayHandshake({
  role,
  harnessDir = join(repoRoot(), ".harness"),
  now = Date.now(),
  dispatchId,
}) {
  const filesResolved = resolveTaskAndResultFiles(role, harnessDir);
  if (!filesResolved.ok) return filesResolved;
  const { taskContent, resultContent, resultMtimeMs, resultPath } =
    filesResolved;

  const idResolved = resolveMatchedTaskId(taskContent, resultContent);
  if (!idResolved.ok) return idResolved;
  const { taskId } = idResolved;

  const droppedResolved = resolveDroppedAt(taskContent, now);
  if (!droppedResolved.ok) return droppedResolved;
  const { droppedAt, droppedMatch } = droppedResolved;

  const doneResolved = resolveDoneAt(resultContent, now, {
    taskId,
    droppedAtRaw: droppedMatch[1].trim(),
    role,
    harnessDir,
    resultMtimeMs,
  });
  if (!doneResolved.ok) {
    // HYK-342/HYK-249: BLOCKED/NEEDS_INPUT termination side-effects run
    // here, AFTER doneResolved's own verdict/reason/state are already fixed
    // -- this call never changes `doneResolved` (returned byte-identical
    // right below), it only adds best-effort bookkeeping (see the function's
    // own header for why it's scoped to exactly these two states).
    runBlockedTerminationSideEffectsIfApplicable({
      state: doneResolved.state,
      role,
      harnessDir,
      taskId,
      taskContent,
      resultContent,
      droppedMatch,
      dispatchId,
      resultPath,
      now,
    });
    return doneResolved;
  }
  const { doneAt, doneMatch, observation } = doneResolved;

  // HYK-325 §2-3 (탐지, 거부 아님): a format-valid DONE line that finalize-
  // done.mjs did NOT stamp (no `done_stamped_by: finalize-done` marker
  // line) is very likely a hand-typed one -- warn so an operator watching
  // the log has a signal, but do NOT block consumption on it (existing
  // manual-edit / no-marker rounds must keep working; escalating this to a
  // reject is a separate, out-of-scope decision -- see coder-task.md §2-3).
  warnIfMissingFinalizeDoneMarker(resultContent);

  const rewriteOrStaleVerdict = checkRewriteAndStaleness({
    observation,
    doneAt,
    droppedAt,
    doneMatch,
    droppedMatch,
  });
  if (rewriteOrStaleVerdict) return rewriteOrStaleVerdict;

  const sideEffectVerdict = runCompletionSideEffects({
    role,
    harnessDir,
    taskId,
    taskContent,
    resultContent,
    droppedMatch,
    doneMatch,
    dispatchId,
  });
  if (sideEffectVerdict) return sideEffectVerdict;

  return { ok: true, reason: `relay handshake ok for ${taskId}` };
}

// HYK-224-2R §3 옵션3, rewired HYK-227 §2 -- best-effort spawn of the
// neutral admission-completion executor (scripts/check/admission-
// completion-adapter.mjs), now called from INSIDE checkRelayHandshake's own
// ok:true branch above, so every caller (CLI entry point below AND every
// in-process caller -- relay-core.mjs, watch-result.mjs, seat-signal-
// adapter.mjs, orca-spike-live.mjs, orca-spike-runner.mjs) reaches it, not
// only the CLI. Deliberately NOT a module-level import (see that file's own
// header for why: an import here reintroduces the exact failure 1R hit --
// 6 mutation test files' stageTree()/checkFiles isolate relay-handshake.mjs
// with a small fixed dependency list, and importing a file outside that
// list breaks module resolution at LOAD time, before any test assertion
// even runs). A subprocess spawn only fails at CALL time (this function),
// which the try/catch below absorbs -- so an isolated fixture missing the
// adapter file degrades to a silent no-op here, never to a load error.
// Runs ONLY after checkRelayHandshake has already decided ok:true (dispatch
// binding independently verified) -- never changes checkRelayHandshake's own
// return value or the CLI's exit code either way (S11: this is best-effort
// bookkeeping, not part of the handshake verdict).
// HYK-244 ci-repair-1 §1 묶음C 수리: exit 0만으로 "성공"을 판단하면
// admission-completion-adapter.mjs 자신의 "attempted:false"(원장 경로가
// 아예 안 잡혀 시도조차 안 함, ⛔`admission-completion-adapter.mjs` 자체는
// HYK-250 범위라 수정하지 않음)도 exit 0으로 끝나므로 "시도조차 안 함"이
// "반납 성공"으로 둔갑한다(ORCH 실측, not ok 157 원문). 이 저장소 전체의
// 반복 원칙("부분 성공은 성공이 아니다", HYK-244 2R-a §2)과 정확히 같은
// 결의 결함이라, 그 adapter를 고치지 않고 여기서 stdout을 읽어 구별한다
// -- adapter가 실제로 찍는 안정된 문자열(admission-completion-adapter.mjs
// 293행, 바이트 동일 인용)과 대조한다. 순수 문자열 판별이라 파일시스템/
// 환경(설치기 포인터 파일 유무)과 무관하게 export해 직접 단언할 수 있다
// (HYK-244 2R-ci-1의 resolveLiveRoundFilePaths와 같은 이유 -- 그 환경
// 의존성 자체가 이 저장소 전체를 "로컬 통과가 증거가 아니다"로 만드는
// 근본 원인이므로, 문자열 수준에서 독립적으로 확인 가능해야 한다).
export function wasAdmissionCompletionAttempted(stdout) {
  return !String(stdout ?? "").includes("not attempted");
}

// HYK-344 2R (review-r1-verbatim.md §A P1, orch-measured-r1.md 잰 것1): the
// audit trail (${ledgerPath}.completion-failures.jsonl) HYK-344 1R added has
// ZERO production readers (검토자 rg 확인 + ORCH 독립 재확인, 둘 다 grep 0건)
// -- so "구별해서 기록한다"만으로는 "자동 호출자가 성공으로 오인한다"는 핵심
// 결함이 닫히지 않는다. This module-scoped slot is how that gap closes
// without widening `spawnAdmissionCompletionProcess`'s own return value: the
// boolean `admissionReturned` it returns is pinned byte-for-byte by
// relay-handshake-completion-wire.test.mjs's ⓒ mutation target
// (`"spawnAdmissionCompletion(taskId);"` must appear exactly once, and the
// mutated `undefined;` substitution must stay a valid boolean-shaped
// assignment) AND is threaded into the consumption-receipt `effects` object
// downstream (consumption-receipt-core.mjs expects a boolean there, not an
// object) -- changing its shape would ripple into both. So the richer detail
// (was this genuinely ATTEMPTED-and-FAILED, vs never attempted at all
// because no ledger path resolved) rides this separate slot instead, read
// by the CLI entry point right after `checkRelayHandshake` returns (see
// `invokedDirectly` below). Reset at the top of every call so a call that
// never reaches admission completion this round (REJECTed/BLOCKED rounds,
// which don't invoke this function at all) never sees a PRIOR round's stale
// detail leak through a long-lived in-process caller.
let lastAdmissionCompletionDetail = null;

export function peekLastAdmissionCompletionDetail() {
  return lastAdmissionCompletionDetail;
}

// HYK-312 §1: renamed from `spawnAdmissionCompletion` -- the name
// `spawnAdmissionCompletion` is now the local single-arg closure defined
// inside runCompletionSideEffects (captures harnessDir from that scope), so
// this two-arg implementation function needed a distinct name to avoid
// shadowing confusion. Behavior is otherwise byte-for-byte unchanged.
function spawnAdmissionCompletionProcess(taskId, harnessDir) {
  lastAdmissionCompletionDetail = null;
  try {
    const adapterPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "admission-completion-adapter.mjs",
    );
    // HYK-312 §1: harnessDir is now forwarded so the adapter can tell
    // whether the round directory actually being consumed lives inside a
    // registered git worktree, instead of trusting THIS process's own cwd
    // (see admission-completion-adapter.mjs's isInsideGitWorktree header for
    // the incident this closes). Backward-compatible: an absent harnessDir
    // omits the arg entirely, which the adapter treats exactly as before
    // this round (execFileSync's args array rejects `undefined` elements).
    const args = harnessDir
      ? [adapterPath, taskId, harnessDir]
      : [adapterPath, taskId];
    const out = execFileSync("node", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    const attempted = wasAdmissionCompletionAttempted(out);
    // HYK-344 2R: recorded on the SUCCESS path too (attempted && ok:true, or
    // genuinely not-attempted because no ledger path resolved) -- the CLI
    // reads this slot unconditionally, so a `null` left over from module
    // load (never actually reached this function) must not be
    // indistinguishable from "ran and everything was fine".
    lastAdmissionCompletionDetail = { attempted, ok: true };
    if (!attempted) return false;
    // HYK-244 2R-a 조각2: return value added (was void/undefined) so the
    // receipt-writing call site can know this effect (admissionReturned)
    // actually succeeded. Does not change try/catch structure or any
    // existing log line above/below.
    return true;
  } catch (err) {
    // Missing adapter file (isolated test fixture), non-zero exit
    // (attempted but failed), or any other spawn failure -- all logged,
    // none fatal to the handshake's own verdict/exit code.
    //
    // HYK-224-3R §3 (REVIEW 2R 반려, 판단): a completion-bookkeeping failure
    // here does NOT flip this CLI's own exit code to nonzero, even though
    // §3's requirement literally says "네가 판단하라" on that question.
    // Reasoning: this CLI's exit code is the ROUND's pass/fail signal (did
    // the worker's task_id binding and staleness checks pass) -- conflating
    // it with "did an auxiliary capacity-tracking side effect also succeed"
    // would make every future round's success depend on admission-ledger
    // infra being reachable, which coder-task §4 keeps deliberately
    // env-gated/optional. The failure is instead made LOUD through two
    // durable, independent channels instead: (1) err.stderr now carries the
    // adapter's own detailed reason (3R fix: the adapter used to print
    // failures via console.log, so this branch's `err.stderr` was empty --
    // 검토자 실측 "세부 오류가 비어 있었다"; now console.error, so it's
    // here), and (2) the adapter durably appends a JSON line to
    // `${ledgerPath}.completion-failures.jsonl` BEFORE this process ever
    // sees the failure (coder-task §3: "화면에만 = 도달로 안 침").
    //
    // HYK-344 2R §4 후보ⓐ 채택 (review-r1-verbatim.md §A P1): the "두 통로"
    // above turned out to have zero readers for one of them (audit JSONL,
    // orch-measured-r1.md 잰 것1) -- so THIS CLI's own exit code still needs
    // to distinguish "attempted and genuinely failed" from "not attempted at
    // all" (env not wired -- an expected, harmless gap this repo has always
    // tolerated). The 3R reasoning above (round pass/fail must not depend on
    // admission-ledger reachability) is still honored: exit 0 (full success)
    // and exit 1 (round itself rejected) keep their EXACT pre-existing
    // meaning, untouched. A THIRD, previously-unused value is what an
    // automated caller now sees for this one narrow case (see
    // `lastAdmissionCompletionDetail`/`peekLastAdmissionCompletionDetail`
    // above and the CLI entry point below) -- never conflated with either
    // existing code, so no caller's existing 0-vs-1 branching changes.
    // `err.status` is only a real integer when the adapter process actually
    // ran and exited non-zero (Node's child_process contract) -- a spawn
    // that never started at all (missing adapter file, isolated fixture)
    // has no `.status`, so that harmless no-op case is NOT mistaken for a
    // genuine attempted-and-failed completion here.
    lastAdmissionCompletionDetail = {
      attempted: Number.isInteger(err.status),
      ok: false,
      detail: err.stderr ?? err.message,
    };
    console.error(
      `relay-handshake: admission-completion spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-224-3R §3 reasoning above): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-342/HYK-249: mirrors spawnAdmissionCompletionProcess exactly (same
// subprocess-not-import reasoning, same try/catch/never-throws contract,
// same wasAdmissionCompletionAttempted stdout-string check) -- the one
// difference is the 4th/5th CLI args, which ask admission-completion-
// adapter.mjs to stamp `completion_reason: BLOCKED_TERMINATION_RELEASED`
// (admission-ledger-core.mjs's COMPLETION_REASON) on the released
// reservation instead of leaving it unset (the ok:true path's normal-
// completion shape). HYK-342 2R P1-1: the adapter now REQUIRES `role`
// (5th arg) to independently re-verify this round's own live result file
// before it will accept that reason -- this call always supplies it
// (checkRelayHandshake already confirmed BLOCKED/NEEDS_INPUT on that exact
// file moments ago, so the verification is redundant-but-consistent for a
// genuine call, and is exactly what a forged direct invocation lacks).
// Never changes checkRelayHandshake's own return value/exit code (same S11
// rationale as its sibling).
function spawnAdmissionAbortProcess(taskId, harnessDir, role) {
  try {
    const adapterPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "admission-completion-adapter.mjs",
    );
    const args = harnessDir
      ? [adapterPath, taskId, harnessDir, "BLOCKED_TERMINATION_RELEASED", role]
      : [adapterPath, taskId];
    const out = execFileSync("node", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    return wasAdmissionCompletionAttempted(out);
  } catch (err) {
    console.error(
      `relay-handshake: admission-abort spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-342/HYK-249): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-244 2R-a §2 조각2: resultFingerprint = 결과 파일 내용의 SHA-256(hex)
// -- ⛔지정(coder-task.md §2 원문), 다른 알고리즘을 고르지 않는다. This is
// a small, deliberate duplicate of consumption-receipt-writer.mjs's own
// `computeResultFingerprint` (same reason spawnAdmissionCompletion never
// statically imports its sibling adapter -- see spawnConsumptionReceiptWriter
// below): relay-handshake.mjs itself must stay inside the 4-file fixed
// dependency list the mutation-test isolation fixtures stage, and computing
// the fingerprint here (to decide whether it's even worth spawning the
// writer CLI) does not require importing anything beyond node:crypto
// (already a builtin import above).
function computeResultFingerprint(resultContent) {
  return createHash("sha256").update(resultContent, "utf8").digest("hex");
}

// HYK-244 2R-a §2 조각2: consumption-receipt-core.mjs's checkReviewVerdictLine
// counts exactly this -- REVIEW-family result 파일의 'verdict: approved|
// rejected' 줄 개수. Duplicated from reject-streak.mjs's own (unexported)
// VERDICT_LINE_RE_G (that file's line 26) for the same reason: this file
// needs the RAW count (0/1/2+), not reject-streak.mjs's own collapsed
// ok:false-on-ambiguous shape (`parseReviewOutcome` never exposes the count
// itself).
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;

function countVerdictLines(resultContent) {
  return [...resultContent.matchAll(VERDICT_LINE_RE_G)].length;
}

// HYK-244 2R-a §2 조각2: builds the consumption-receipt-core.mjs candidate
// shape (binding/effects/verdictLineCount) and spawns the writer CLI ONLY
// when every required effect for this role succeeded -- ⛔비타협: 부분
// 성공은 성공 영수증이 아니다(§2 원문). REVIEW 계열(isReviewFamilyRole,
// reject-streak.mjs 385-394행과 동일 규칙)만 ledgerRecorded를 필수로 본다,
// consumption-receipt-core.mjs의 requiredEffectKeysFor와 정확히 같은
// 판별. Never mutates checkRelayHandshake's own return value either way
// (같은 이유로 spawnAdmissionCompletion도 그렇다) -- 실패/스킵 모두
// console.error로만 드러난다.
function autoWriteConsumptionReceipt({
  role,
  harnessDir,
  resultContent,
  taskId,
  droppedAt,
  dispatchId,
  doneAt,
  envelopeArchived,
  taskArchived,
  admissionReturned,
  recordOutcome,
}) {
  const isReview = isReviewFamilyRole(role);
  const ledgerRecorded = isReview ? recordOutcome.ok : undefined;
  const requiredEffectsOk =
    envelopeArchived === true &&
    taskArchived === true &&
    admissionReturned === true &&
    (isReview ? ledgerRecorded === true : true);
  if (!requiredEffectsOk) {
    console.error(
      `relay-handshake: consumption receipt NOT written for ${taskId} -- 필수 후속효과 미확인(envelopeArchived=${envelopeArchived}, taskArchived=${taskArchived}, admissionReturned=${admissionReturned}${isReview ? `, ledgerRecorded=${ledgerRecorded}` : ""}) -- 부분 성공은 성공 영수증이 아니다(HYK-244 2R-a §2)`,
    );
    return;
  }

  // HYK-269 §2-1 조각1: binding.role만 정본 대문자로 굳힌다 -- dispatch-
  // gate-decision.mjs:1074의 currentBinding.role(`role.toUpperCase()`)과
  // 정확히 같은 정규화. 아래 spawnConsumptionReceiptWriter 호출의 최상위
  // `role`(영수증 파일명 조립에 쓰임, consumption-receipt-writer.mjs의
  // nextReceiptFileName)은 손대지 않는다 -- 파일명 관례(소문자)는 그대로
  // 둔다(coder-task.md §2-1 원문 비타협).
  const binding = {
    taskId,
    role: role.toUpperCase(),
    droppedAt,
    resultFingerprint: computeResultFingerprint(resultContent),
    dispatchId,
    doneAt,
  };
  const effects = isReview
    ? { envelopeArchived, taskArchived, admissionReturned, ledgerRecorded }
    : { envelopeArchived, taskArchived, admissionReturned };
  const verdictLineCount = isReview
    ? countVerdictLines(resultContent)
    : undefined;

  spawnConsumptionReceiptWriter({
    role,
    harnessDir,
    binding,
    effects,
    verdictLineCount,
  });
}

// HYK-244 2R-a §2 조각2: mirrors spawnAdmissionCompletion exactly (see that
// function's own header, right above) -- deliberately NOT a static import
// of consumption-receipt-writer.mjs, for the identical reason: the 6
// mutation-test isolation fixtures (hyk186-time-authority-mutation.test.mjs
// 등) stage relay-handshake.mjs inside a fixed 4-file clone (relay-
// handshake.mjs/time-authority.mjs/reject-streak.mjs/envelope-archive.mjs)
// -- a static import of a 5th file breaks module resolution at LOAD time
// for every mutation test in those files, not just the ones this feature
// touches. A subprocess spawn only fails at CALL time, absorbed by the
// try/catch below -- an isolated fixture missing the writer file degrades
// to a silent no-op, never a load error. Never changes checkRelayHandshake's
// own return value or exit code either way (same S11 rationale as
// spawnAdmissionCompletion).
function spawnConsumptionReceiptWriter({
  role,
  harnessDir,
  binding,
  effects,
  verdictLineCount,
}) {
  try {
    const writerPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "consumption-receipt-writer.mjs",
    );
    const payload = JSON.stringify({
      role,
      binding,
      effects,
      verdictLineCount,
    });
    const out = execFileSync("node", [writerPath, harnessDir, payload], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
  } catch (err) {
    // Missing writer file (isolated test fixture), non-zero exit, or any
    // other spawn failure -- all logged, none fatal to the handshake's own
    // verdict/exit code (mirrors spawnAdmissionCompletion's catch exactly).
    console.error(
      `relay-handshake: consumption-receipt-writer spawn skipped/failed (non-fatal to this handshake's own exit code): ${err.stderr ?? err.message}`,
    );
  }
}

// HYK-342/HYK-249: mirrors spawnConsumptionReceiptWriter exactly (same
// subprocess-not-import reasoning -- this file is staged into a small fixed-
// file mutation-test isolation clone, relay-handshake.mjs/time-authority.mjs/
// reject-streak.mjs/envelope-archive.mjs, and a 5th static import of
// abort-record-writer.mjs would break module resolution for every one of
// those tests at LOAD time; a spawn only fails at CALL time, absorbed by the
// try/catch below). Writes `<harnessDir>/aborts/<role>-abort-r<N>.json` via
// abort-record-writer.mjs's own CLI (HYK-298-abort-record-1) -- this is that
// writer's first production caller (its own header documented zero
// production callers before this round). Never changes checkRelayHandshake's
// own return value/exit code (same S11 rationale as its sibling).
function spawnAbortRecordWriter({
  role,
  harnessDir,
  harnessTaskLabel,
  dispatchId,
  droppedAt,
  leftoverFingerprint,
  leftoverPath,
  recordedAt,
  evidence,
}) {
  try {
    const scriptPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "abort-record-writer.mjs",
    );
    const payload = JSON.stringify({
      role,
      harnessTaskLabel,
      dispatchId,
      droppedAt,
      leftoverFingerprint,
      leftoverPath,
      recordedAt,
      evidence,
    });
    const out = execFileSync("node", [scriptPath, harnessDir, payload], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
    return true;
  } catch (err) {
    console.error(
      `relay-handshake: abort-record-writer spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-342/HYK-249): ${err.stderr ?? err.message}`,
    );
    return false;
  }
}

// HYK-269 §2-1 조각2: 소비 CLI 진입점에서 role 인자가 정본 4개(CODER/
// REVIEW/VERIFY/PM) 중 하나인지 대소문자 무관으로 검증하는 허용 목록.
// ⚠️여기서는 role의 표기(대소문자)를 바꾸지 않고 그대로 통과시킨다 --
// resolveLiveRoundFilePaths(라이브 파일 경로)/envelope-archive.mjs(라운드
// 보관 파일명)/consumption-receipt-writer.mjs(영수증 파일명)이 전부 이
// role 문자열을 그대로 파일명 조립에 쓰므로, 여기서 케이스를 바꾸면
// «파일명 관례를 바꾸지 마라»는 비타협을 깬다. 정본 표기 정규화는 결속
// 기록(binding.role) 쪽에서만, 그 필드가 실제로 쓰이는 자리(아래
// autoWriteConsumptionReceipt의 binding 조립부)에서 한다.
const ALLOWED_ROLES = Object.freeze(["CODER", "REVIEW", "VERIFY", "PM"]);

function describeRoleUsage() {
  return `allowed roles: ${ALLOWED_ROLES.join(", ")}\nexample: node relay-handshake.mjs CODER .harness`;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/relay-handshake.mjs");
if (invokedDirectly) {
  const role = process.argv[2];
  if (!role) {
    console.error("usage: node relay-handshake.mjs <role> [harnessDir]");
    process.exit(1);
  }
  if (!ALLOWED_ROLES.includes(role.toUpperCase())) {
    console.error(`unknown role '${role}' -- ${describeRoleUsage()}`);
    process.exit(1);
  }
  // HYK-227 §2: spawnAdmissionCompletion is no longer called here directly
  // -- it now runs INSIDE checkRelayHandshake itself (see that function's
  // own ok:true branch, right before its return), so every caller gets it,
  // not just this CLI block. Calling it again here would double-spawn on
  // every CLI-path completion.
  const harnessDirArg = process.argv[3];
  const result = harnessDirArg
    ? checkRelayHandshake({ role, harnessDir: harnessDirArg })
    : checkRelayHandshake({ role });
  if (result.ok) {
    // HYK-344 2R (review-r1-verbatim.md §A P1): this round genuinely
    // finished (task_id binding + staleness all passed) -- but that is not
    // the same question as "did the admission-ledger reservation for it
    // actually get released". `peekLastAdmissionCompletionDetail()` is set
    // synchronously inside THIS process's own single `checkRelayHandshake`
    // call above (module-scoped slot, see its own header) -- exit 3 only
    // when completion was genuinely ATTEMPTED and FAILED (e.g. a reservation
    // key mismatch), never for the harmless "not attempted" gap (no ledger
    // path resolved), so existing deployments that never wired
    // ADMISSION_LEDGER_PATH keep seeing exit 0 exactly as before.
    const completionDetail = peekLastAdmissionCompletionDetail();
    if (
      completionDetail?.attempted === true &&
      completionDetail?.ok === false
    ) {
      console.error(
        `relay-handshake: round completed but admission-ledger reservation release FAILED (${completionDetail.detail ?? "no detail available"}) -- exiting 3 (distinct from 0=full success / 1=round rejected) so an automated caller cannot mistake this for a clean success (HYK-344 2R)`,
      );
      process.exit(3);
    }
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
