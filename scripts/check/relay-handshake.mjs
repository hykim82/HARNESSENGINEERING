import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";
import { recordRejectStreakFromResultText } from "./reject-streak.mjs";
import { archiveRoundEnvelope } from "./envelope-archive.mjs";
import {
  TIME_FIELD,
  TIME_AUTHORITY_STATE,
  MAX_FUTURE_SKEW_MS,
  isBeyondFutureSkew,
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
const DONE_RE = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;
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
// file's task_id echo into either a match or one of two distinct
// diagnoses for the anchored-miss case (see TASK_ID_ANYWHERE_RE above).
function resolveResultTaskId(resultContent) {
  const resultIdMatches = [...resultContent.matchAll(TASK_ID_RE_G)];
  if (resultIdMatches.length > 1) {
    return {
      ok: false,
      reason: `result has ${resultIdMatches.length} standalone 'task_id:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve)`,
    };
  }
  if (resultIdMatches.length === 1) {
    return { ok: true, id: resultIdMatches[0][1] };
  }
  if (TASK_ID_ANYWHERE_RE.test(resultContent)) {
    return {
      ok: false,
      reason:
        "result task_id echo not at line start (must be a standalone `task_id: <id>` line at column 0, found mid-line)",
    };
  }
  return {
    ok: false,
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
  if (matches.length === 1) {
    if (anywhereCount > matches.length) {
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
  if (anywhereCount > 0) {
    return {
      state: RESULT_BLOCK_STATE.MALFORMED_BLOCKED,
      reason:
        "result has a '>>> BLOCKED:'/'>>> NEEDS_INPUT:'-shaped marker that doesn't match the required column-0, single-line '>>> BLOCKED: <reason>' / '>>> NEEDS_INPUT: <reason>' form (fail-closed -- not treated as pending)",
    };
  }
  return { state: RESULT_BLOCK_STATE.NONE };
}

// Extracted from checkRelayHandshake (quality-check: keeps its own
// complexity/line-count under the repo's ESLint ceiling) -- called only
// when resolveResultDoneMatch already confirmed genuine absence
// (`resultDone.missing`, i.e. not the separate ambiguous-DONE case above).
// Turns resolveResultBlockedState's 5-way state into the handshake's
// final ok:false return shape for this branch.
function resolveMissingDoneOutcome(resultContent, resultDoneReason) {
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
  // blocked.state === NONE -- genuinely still in progress, not blocked.
  return { ok: false, state: "PENDING", reason: resultDoneReason };
}

// Extracted from checkRelayHandshake (same ESLint-ceiling reason as its
// siblings above) -- wraps resolveResultDoneMatch's ok:false outcome,
// routing the genuine-absence case through resolveMissingDoneOutcome and
// leaving the ambiguous-DONE case's existing reason untouched.
function resolveResultDoneOutcome(resultContent, resultDone) {
  if (resultDone.missing) {
    return resolveMissingDoneOutcome(resultContent, resultDone.reason);
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
function autoArchiveRoundEnvelope({ role, resultContent, harnessDir }) {
  const outcome = archiveRoundEnvelope({ role, resultContent, harnessDir });
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
}

function autoRecordRejectStreak({ role, resultContent }) {
  const autoRecord = recordRejectStreakFromResultText({
    role,
    resultText: resultContent,
    ledgerPath: join(mainRepoRoot(), ".harness", "reject-streak.json"),
  });
  if (!autoRecord.attempted) return;
  if (autoRecord.ok) {
    console.log(autoRecord.reason);
  } else {
    console.error(autoRecord.reason);
  }
}

function parseKstTimestamp(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// HYK-186 §2 완료조건2: `now` is the ONLY caller-injectable clock in this
// function, and it exists purely for test determinism (mirroring
// pull-admission.mjs's `nowMs` convention) -- the production CLI entry point
// at the bottom of this file never passes it, so every real invocation uses
// the machine clock. This is what "production `now`는 caller 자기신고가
// 아니어야 한다" means in practice: the *candidate* timestamps (dropped_at,
// DONE) are caller-supplied (they come from files workers/ORCH write), but
// the *authority clock* they are judged against is not.
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
        )}s ahead of authority now (${new Date(now).toISOString()}), which exceeds the allowed skew of ${MAX_FUTURE_SKEW_MS}ms`;
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
      reason: `task dropped_at not parseable: '${droppedMatch[1].trim()}' (need YYYY-MM-DD HH:MM KST)`,
    };
  }
  const droppedFuture = checkFutureSkew({
    candidateDate: droppedAt,
    rawText: droppedMatch[1],
    field: TIME_FIELD.TASK_DROPPED_AT,
    now,
  });
  if (droppedFuture) return droppedFuture;
  return { ok: true, droppedAt, droppedMatch };
}

// Extracted from checkRelayHandshake (same ESLint-ceiling reason as
// resolveDroppedAt above) -- resolves the result file's '>>> DONE:' line
// into a parsed Date, applying the HYK-186 future-skew check as part of
// that resolution. ★PM 실측 재현 대상: before this fix, a DONE line dated
// 2099-01-01 passed silently ({"ok":true, reason:"relay handshake ok for
// FUTURE-1"}) -- checkRelayHandshake had exactly one time comparison
// (`doneAt < droppedAt`) and zero comparisons against `now`. This function
// is the fix: reject a DONE timestamp beyond authority-clock skew before it
// can ever reach the staleness/ok:true path in checkRelayHandshake.
function resolveDoneAt(resultContent, now) {
  const resultDone = resolveResultDoneMatch(resultContent);
  if (!resultDone.ok) {
    // HYK-173-escalation-1 (§2): only the genuine-absence case (no
    // '>>> DONE:' line anywhere -- `missing`) is eligible to be
    // reclassified as an explicit BLOCKED/NEEDS_INPUT state. The
    // ambiguous-DONE case above keeps its existing reason/behavior
    // untouched (regression 0 on the `>>> DONE:` path).
    return resolveResultDoneOutcome(resultContent, resultDone);
  }
  const doneMatch = resultDone.match;
  const doneAt = parseKstTimestamp(doneMatch[1]);
  if (!doneAt) {
    return {
      ok: false,
      reason: `result DONE timestamp not parseable: '${doneMatch[1].trim()}'`,
    };
  }
  const doneFuture = checkFutureSkew({
    candidateDate: doneAt,
    rawText: doneMatch[1],
    field: TIME_FIELD.RESULT_DONE_AT,
    now,
  });
  if (doneFuture) return doneFuture;
  return { ok: true, doneAt, doneMatch };
}

export function checkRelayHandshake({
  role,
  harnessDir = join(repoRoot(), ".harness"),
  now = Date.now(),
}) {
  const taskPath = join(harnessDir, `${role}-task.md`);
  const resultPath = join(harnessDir, `${role}.md`);

  if (!existsSync(taskPath)) {
    return { ok: false, reason: `task file not found: ${taskPath}` };
  }
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      reason: `result file not found (worker not done?): ${resultPath}`,
    };
  }

  const taskContent = readFileSync(taskPath, "utf8");
  const resultContent = readFileSync(resultPath, "utf8");

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

  const droppedResolved = resolveDroppedAt(taskContent, now);
  if (!droppedResolved.ok) return droppedResolved;
  const { droppedAt, droppedMatch } = droppedResolved;

  const doneResolved = resolveDoneAt(resultContent, now);
  if (!doneResolved.ok) return doneResolved;
  const { doneAt, doneMatch } = doneResolved;

  if (doneAt < droppedAt) {
    return {
      ok: false,
      reason: `stale result: DONE (${doneMatch[1].trim()}) predates task drop (${droppedMatch[1].trim()})`,
    };
  }

  // HYK-183 §2: the moment this function confirms a REVIEW-family result
  // file is COMPLETE (every prior check above already passed) is the one
  // moment the reject-streak ledger should be updated -- record's whole
  // job (reject-streak.mjs) is "did the LATEST, non-stale round on this
  // issue get rejected or approved", and everything above this line is
  // exactly the staleness/ambiguity resolution that answers that. Wired
  // here (inside the shared decision function, not only the CLI block) so
  // every caller -- the CLI AND in-process callers like relay-core.mjs --
  // gets it; §1's original gap was that NOTHING called `record` anywhere.
  // Never mutates this function's own return value or the CLI's exit code
  // (§2-1 R5) -- purely a side effect layered on top of an already-decided
  // PASS. Failure/duplicate/skip are never swallowed (§2-1 R4) --
  // autoRecordRejectStreak surfaces every branch via console.log/error.
  // HYK-204: the moment this function confirms a round's result file is
  // COMPLETE (every check above already passed) is also the last moment
  // before ORCH drops the next round's task file and this same
  // `<role>.md` slot gets overwritten -- the exact loss point the 2026-08-08
  // 실사례 hit. Archived here (not left to the worker to remember) for the
  // same reason autoRecordRejectStreak lives here: every caller -- CLI and
  // in-process alike -- gets it, with no new notification device.
  autoArchiveRoundEnvelope({ role, resultContent, harnessDir });
  autoRecordRejectStreak({ role, resultContent });

  return { ok: true, reason: `relay handshake ok for ${taskId}` };
}

// HYK-224-2R §3 옵션3 -- CLI-only, best-effort spawn of the neutral
// admission-completion executor (scripts/check/admission-completion-
// adapter.mjs). Deliberately NOT a module-level import (see that file's own
// header for why: an import here reintroduces the exact failure 1R hit --
// 6 mutation test files' stageTree()/checkFiles isolate relay-handshake.mjs
// with a small fixed dependency list, and importing a file outside that
// list breaks module resolution at LOAD time, before any test assertion
// even runs). A subprocess spawn only fails at CALL time (this function),
// which the try/catch below absorbs -- so an isolated fixture missing the
// adapter file degrades to a silent no-op here, never to a load error.
// Runs ONLY after checkRelayHandshake already returned ok:true (dispatch
// binding independently verified) -- never changes this CLI's own exit
// code either way (S11: this is best-effort bookkeeping, not part of the
// handshake verdict).
function spawnAdmissionCompletion(taskId) {
  try {
    const adapterPath = join(
      dirname(fileURLToPath(new URL(import.meta.url))),
      "admission-completion-adapter.mjs",
    );
    const out = execFileSync("node", [adapterPath, taskId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    console.log(out.trim());
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
    console.error(
      `relay-handshake: admission-completion spawn skipped/failed (non-fatal to this handshake's own exit code, HYK-224-3R §3 reasoning above): ${err.stderr ?? err.message}`,
    );
  }
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
  const harnessDirArg = process.argv[3];
  const result = harnessDirArg
    ? checkRelayHandshake({ role, harnessDir: harnessDirArg })
    : checkRelayHandshake({ role });
  const okTaskId = result.ok
    ? (result.reason.match(/relay handshake ok for (\S+)/) ?? [])[1]
    : undefined;
  if (okTaskId) spawnAdmissionCompletion(okTaskId);
  if (result.ok) {
    process.exit(0);
  } else {
    console.error(result.reason);
    process.exit(1);
  }
}
