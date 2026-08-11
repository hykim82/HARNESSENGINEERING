import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync, execFileSync } from "node:child_process";

// HYK-133: a same-issue rejected-review streak has no mechanical memory --
// `.harness/review.md` is a single relay slot overwritten every round, so
// the "this issue has been rejected N times in a row" fact vanished the
// moment the next round's review.md landed. HYK-129 사이클3 hit this exact
// gap (6 consecutive rejects on one spot; the 3-streak model-escalation and
// 5-streak research-escalation moves that actually helped were ORCH's own
// unrecorded judgment calls, not anything the harness remembered). This
// module gives that streak a durable home (`.harness/reject-streak.json`,
// keyed by issue id, surviving every relay-slot overwrite) and a gate that
// blocks a same-spot re-drop once the streak reaches 2 unless the next task
// file carries an escalation envelope (cause + at least one ORCH action).

const ISSUE_ID_RE = /^(HYK-\d+)/;
// HYK-183: 결과 파일에 이 표지가 2개 이상이면 어느 것이 최종인지 결정할 수
// 없으므로 조용히 하나를 고르지 않고 판정 불가로 멈춘다(2026-07-31 거짓
// 기록 사고). `for:`/`verdict:`는 항상 개수부터 세야 하므로 global 버전만
// 남긴다; `task_id:`는 checkGate/checkDiagnosticGate가 단일 매치로도 쓰므로
// non-global과 global 버전을 함께 둔다.
const FOR_LINE_RE_G = /^for:\s*(\S+)/gm;
const TASK_ID_LINE_RE = /^task_id:\s*(\S+)/im;
const TASK_ID_LINE_RE_G = /^task_id:\s*(\S+)/gim;
const VERDICT_LINE_RE_G = /^verdict:\s*(approved|rejected)\s*$/gim;
// HYK-183-ledger-fix (축 A): 결과 파일의 `>>> DONE: ... @ <시각>` 줄에서
// 그 라운드가 실제로 끝난 시각을 뽑는다. `for:`/`task_id:`는 ORCH가 같은
// 이슈의 여러 실제 라운드에 걸쳐 바로 그 이슈 id를 그대로(라운드 구분자
// 없이) 반복해 쓰는 실측 관행이 있어(2026-08-05 원장 표본: `HYK-183`,
// `HYK-186`이 서로 다른 시각의 서로 다른 라운드에 매번 동일 문자열로
// 반복 기록됨) 그 값만으로는 "같은 라운드를 다시 확인한 것"과 "다른
// 라운드가 우연히 같은 문자열을 썼다"를 구분할 수 없다. DONE 시각은
// 라운드마다 실제로 다른 실시각이므로(동일 파일을 재확인하는 진짜
// 재시도만 완전히 같다) 그 구분을 기계적으로 대신한다. DONE 줄이
// 0개·2개 이상(모호)이면 doneAt=null로 물러나 기존(taskId+verdict만
// 보는) 판정으로 fail back한다 -- 새 신호가 없다고 판정 자체가 막히지
// 않는다.
const DONE_LINE_RE_G = /^>>>\s*DONE:.*@\s*(.+?)\s*$/gim;

// The envelope lives inside an HTML comment, same convention as
// pm-snapshot-gate.mjs's `<!-- pm-snapshot ... -->` block -- a form ORCH can
// copy-paste into a task file without it rendering as visible prose.
const ENVELOPE_BLOCK_RE = /<!--\s*reject-streak-envelope([\s\S]*?)-->/i;
const CAUSE_LINE_RE = /^\s*원인\s*분류\s*:\s*(.+?)\s*$/m;
const ACTIONS_HEADER_RE = /^\s*ORCH\s*조치\s*:\s*$/m;

// The ladder's step-2 requirement (게이트-기준.md §HYK-133 R2): exactly these
// four cause labels, exactly these five action labels. A label is accepted
// either as an exact match or as a prefix (so "스펙 오류(ORCH)" -- the label
// this design itself uses -- and a hand-typed "리서치(출처 포함): ..." both
// match without demanding byte-identical punctuation).
export const ALLOWED_CAUSES = [
  "스펙 오류(ORCH)",
  "모델 한계",
  "환경 차이",
  "설계 결함",
];
export const ALLOWED_ACTIONS = [
  "리서치",
  "모델 변경",
  "재설계 지시",
  "디스코프 제안",
  "PM B2 자문 회부",
];

export const ESCALATION_LADDER = {
  2: "봉투 강제 (원인 분류 + ORCH 조치 >=1, 이 게이트가 기계 검사)",
  3: "모델 승격 검토 권장 (관례, 기계 강제 아님)",
  4: "디스코프/PM B2 자문 후보 (관례, 기계 강제 아님 -- HYK-158로 진단 봉투만 기계 강제, 자문 자체는 여전히 관례)",
};

// HYK-158: promotes ladder step 4 ("디스코프/PM B2 자문 후보") from a purely
// advisory checkpoint to a machine-checked "hard-stop" -- the tier where two
// prior real incidents (6A review-2/3, 07-15) were handled by ORCH's own
// unrecorded judgment, exactly the gap that motivated this task (STATUS
// "예행 2회 실증 관례의 승격 관리"). The design report (§3.2) does not name
// a numeric streak threshold; step 4 is the ladder's own existing
// "structurally stuck, needs more than another envelope" tier, so this
// reuses it rather than inventing a new number -- an explicit CODER design
// choice, not a guess, and flagged for REVIEW to confirm.
export const HARD_STOP_STREAK = 4;

// HYK-158 field: extends the existing HYK-133 envelope schema (원인 분류 +
// ORCH 조치) with a third required field for the hard-stop tier only --
// 재현 증거 포인터 (a pointer to reproduction evidence), matching the design
// report's "기존 HYK-133 봉투 스키마 확장" instruction to extend, not
// replace, the same `<!-- reject-streak-envelope ... -->` block.
const EVIDENCE_POINTER_LINE_RE = /^\s*재현\s*증거\s*포인터\s*:\s*(.+?)\s*$/m;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

// HYK-221 축3: the CLI's default LEDGER path only -- review.md/coder-task.md
// defaults stay on repoRoot() (plain --show-toplevel, worktree-local; those
// files are meant to be per-worktree relay slots). The ledger is different:
// dispatch-gate-decision.mjs::resolveRepoRoot (the READING side) already
// resolves the repo via `git rev-parse --git-common-dir` (+ a bare-repo
// check), which converges every linked worktree of the same repo onto ONE
// path. This CLI's own default ledger resolution (the WRITING side, used
// when `record`/`gate`/`diagnostic-gate` are invoked with no `--ledger`) used
// to call plain repoRoot() instead -- `--show-toplevel` returns the CURRENT
// worktree's own root, a DIFFERENT answer in a linked worktree. That mismatch
// is the exact HYK-219 1R incident (§1 축3 of this task): a `record` run
// inside a worktree wrote to that worktree's own `.harness/reject-streak.json`
// while the gate kept reading the main repo's file, so the rejection never
// became visible to the 2-streak gate. Mirroring the read side's exact git
// invocation here (rather than reusing relay-handshake.mjs's mainRepoRoot(),
// which would be a circular import -- relay-handshake.mjs already imports
// FROM this module) closes that gap for every direct CLI invocation.
function ledgerRepoRoot() {
  const fallback = repoRoot();
  let commonDir;
  try {
    commonDir = execFileSync(
      "git",
      [
        "-C",
        fallback,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return fallback;
  }
  let isBare;
  try {
    isBare = execFileSync(
      "git",
      ["--git-dir", commonDir, "rev-parse", "--is-bare-repository"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return fallback;
  }
  return isBare === "true" ? commonDir : dirname(commonDir);
}

function issueIdFrom(taskIdLike) {
  const m =
    typeof taskIdLike === "string" ? taskIdLike.match(ISSUE_ID_RE) : null;
  return m ? m[1] : null;
}

// A source file authored/edited on Windows (this repo's own docs/*.md, seen
// live when review-1's doc-code contract test extracted a CRLF-line block
// straight out of docs/enforcement-v1.md) can carry `\r\n` line endings.
// `.` in a JS regex excludes `\r` (not just `\n`), so a bullet-line pattern
// like `/^\s*-\s*(.+)$/` silently fails to match a CRLF-terminated line --
// not a parse error, just zero bullets found, which is indistinguishable
// from "no bullets written." Normalizing once at every text-parsing entry
// point removes the whole class rather than patching each affected regex.
function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// Reads `.harness/review.md`-shaped text and extracts what `record` needs:
// which task the verdict is about (prefers `for:`, the coder-round id being
// judged; falls back to the review round's own `task_id:` if `for:` is
// absent -- both share the same leading `HYK-<n>` issue prefix) and the
// verdict itself. Returns `{ ok: false, reason }` rather than throwing on
// any missing/malformed piece -- callers treat this as an UNJUDGABLE input,
// never a crash.
export function parseReviewOutcome(reviewText) {
  const text = normalizeNewlines(reviewText);
  const forMatches = [...text.matchAll(FOR_LINE_RE_G)];
  const taskIdMatches = [...text.matchAll(TASK_ID_LINE_RE_G)];

  let rawTaskId = null;
  if (forMatches.length > 1) {
    return {
      ok: false,
      reason: `reject-streak record: UNJUDGABLE -- 'for:' 줄이 ${forMatches.length}개라 어느 것이 최종인지 결정할 수 없다`,
    };
  }
  if (forMatches.length === 1) {
    rawTaskId = forMatches[0][1];
  } else if (taskIdMatches.length > 1) {
    return {
      ok: false,
      reason: `reject-streak record: UNJUDGABLE -- 'task_id:' 줄이 ${taskIdMatches.length}개라 어느 것이 최종인지 결정할 수 없다`,
    };
  } else if (taskIdMatches.length === 1) {
    rawTaskId = taskIdMatches[0][1];
  }
  if (!rawTaskId) {
    return {
      ok: false,
      reason:
        "reject-streak record: no 'for:' or 'task_id:' line found -- cannot resolve which task this verdict is about",
    };
  }
  const issueId = issueIdFrom(rawTaskId);
  if (!issueId) {
    return {
      ok: false,
      reason: `reject-streak record: task id '${rawTaskId}' does not start with HYK-<digits> -- cannot derive issue id`,
    };
  }
  const verdictMatches = [...text.matchAll(VERDICT_LINE_RE_G)];
  if (verdictMatches.length > 1) {
    return {
      ok: false,
      reason: `reject-streak record: UNJUDGABLE -- 판정 줄이 ${verdictMatches.length}개라 어느 것이 최종인지 결정할 수 없다`,
    };
  }
  if (verdictMatches.length === 0) {
    return {
      ok: false,
      reason:
        "reject-streak record: no 'verdict: approved' or 'verdict: rejected' line found",
    };
  }
  // 축 A: DONE 시각은 부가 식별자일 뿐이다 -- 0개(누락)·2개 이상(모호) 다
  // 똑같이 doneAt=null로 물러난다. 여러 개 중 하나를 조용히 고르지
  // 않는다(§0-B 표지 정직성과 같은 원칙); null이면 isDuplicate 판정이
  // task_id+verdict만 보던 예전 동작으로 그대로 되돌아갈 뿐, 판정 자체가
  // 막히지는 않는다.
  const doneMatches = [...text.matchAll(DONE_LINE_RE_G)];
  const doneAt = doneMatches.length === 1 ? doneMatches[0][1] : null;
  return {
    ok: true,
    taskId: rawTaskId,
    issueId,
    verdict: verdictMatches[0][1].toLowerCase(),
    doneAt,
  };
}

// Pure ledger transition: rejected increments that issue's streak, approved
// resets it to 0. An issue absent from the ledger starts at streak 0 (same
// "no ledger entry == streak 0" rule the gate side uses), so record/gate
// agree on what "no history yet" means. Every outcome is appended to that
// issue's history regardless of verdict -- the ladder needs the full
// sequence, not just the current streak, to explain itself later.
export function applyOutcome(ledger, { issueId, taskId, verdict, at, doneAt }) {
  const issues = { ...(ledger?.issues ?? {}) };
  const prev = issues[issueId] ?? { streak: 0, history: [] };
  const streak = verdict === "rejected" ? (prev.streak ?? 0) + 1 : 0;
  const entry = { task_id: taskId, verdict, at };
  // `doneAt` is an opt-in identifier (callers that never derive it, e.g.
  // direct unit tests of this function, keep producing the original
  // 3-field history shape) -- only computeRecord's caller passes it.
  if (doneAt !== undefined) entry.done_at = doneAt;
  issues[issueId] = {
    streak,
    history: [...(prev.history ?? []), entry],
  };
  return { schema_version: ledger?.schema_version ?? 1, issues };
}

// Composes parseReviewOutcome + applyOutcome into the one decision `record`
// needs. Never throws; a malformed review text is reported as `ok: false`
// so the CLI can treat it as UNJUDGABLE (fail-open) rather than corrupting
// the ledger with a guessed entry.
//
// HYK-183 §2-1 R3 (idempotency), 축 A 갱신(HYK-183-ledger-fix): identifies a
// repeat call by comparing against the issue's LAST recorded history entry.
// Originally this compared task_id+verdict alone on the assumption that
// "each round's result file echoes its OWN task_id" -- that assumption does
// NOT hold in production: the 2026-08-05 원장 표본 shows ORCH repeatedly
// writing the bare issue id (no round suffix) into both `for:`/`task_id:`
// across genuinely distinct rounds of the SAME issue (e.g. `HYK-186`
// rejected twice on the same day, both rounds echoing literally `HYK-186`).
// Under the old task_id+verdict-only key, the second real rejection was
// indistinguishable from a retried call on the first, so the gate silently
// swallowed it (§1 축 A: "게이트가 안 걸린다"). `done_at` (each round's own
// `>>> DONE: ... @ <time>` line, present on every valid result file) is
// added as a THIRD component precisely because it is the one thing that
// reliably differs between two genuinely different rounds while staying
// identical for a true retry of the same already-confirmed file. `doneAt`
// missing/ambiguous on either side falls back to the original two-field
// comparison (no new false negatives introduced when the new signal isn't
// available) -- see parseReviewOutcome's own DONE-line handling.
export function computeRecord({ reviewText, ledger, at }) {
  const outcome = parseReviewOutcome(reviewText);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };

  const existing = ledger?.issues?.[outcome.issueId];
  const lastEntry = existing?.history?.[existing.history.length - 1];
  const isDuplicate =
    !!lastEntry &&
    lastEntry.task_id === outcome.taskId &&
    lastEntry.verdict === outcome.verdict &&
    (lastEntry.done_at ?? null) === (outcome.doneAt ?? null);
  if (isDuplicate) {
    return {
      ok: true,
      duplicate: true,
      ledger,
      issueId: outcome.issueId,
      taskId: outcome.taskId,
      verdict: outcome.verdict,
      streak: existing.streak,
    };
  }

  const nextLedger = applyOutcome(ledger, {
    issueId: outcome.issueId,
    taskId: outcome.taskId,
    verdict: outcome.verdict,
    at,
    doneAt: outcome.doneAt,
  });
  return {
    ok: true,
    duplicate: false,
    ledger: nextLedger,
    issueId: outcome.issueId,
    taskId: outcome.taskId,
    verdict: outcome.verdict,
    streak: nextLedger.issues[outcome.issueId].streak,
  };
}

// Extracted from loadLedger (HYK-160 quality-check: keep loadLedger's own
// complexity under the repo's ESLint ceiling) -- true iff `parsed` is a
// plain object with a plain-object (non-array) `issues` field.
function hasValidIssuesShape(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return false;
  return (
    typeof parsed.issues === "object" &&
    parsed.issues !== null &&
    !Array.isArray(parsed.issues)
  );
}

// Loads the ledger, distinguishing "file doesn't exist yet" (a real,
// judgable state -- every issue starts at streak 0) from "file exists but
// is unreadable/malformed" (an UNJUDGABLE state per this task's R3/ⓕ --
// fail-open, never silently treated as streak 0 and never overwritten).
export function loadLedger(
  ledgerPath,
  { readFileFn = (p) => readFileSync(p, "utf8"), existsFn = existsSync } = {},
) {
  if (!existsFn(ledgerPath)) {
    return {
      ok: true,
      existed: false,
      ledger: { schema_version: 1, issues: {} },
    };
  }
  let raw;
  try {
    raw = readFileFn(ledgerPath);
  } catch (err) {
    return {
      ok: false,
      reason: `reject-streak: UNJUDGABLE -- failed to read ledger '${ledgerPath}' (${err.message})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `reject-streak: UNJUDGABLE -- ledger '${ledgerPath}' is not valid JSON (${err.message})`,
    };
  }
  if (!hasValidIssuesShape(parsed)) {
    return {
      ok: false,
      reason: `reject-streak: UNJUDGABLE -- ledger '${ledgerPath}' missing/invalid 'issues' object`,
    };
  }
  return { ok: true, existed: true, ledger: parsed };
}

export function writeLedger(ledgerPath, ledger, writeFileFn = writeFileSync) {
  writeFileFn(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

const REVIEW_ROLE_RE = /^review/i;

// HYK-183 §2: true iff `role` (relay-handshake.mjs's file-prefix role, e.g.
// "review"/"review2"/"coder"/"verify") belongs to the REVIEW family whose
// result file can carry a `verdict: approved|rejected` line. A CODER
// handshake has no verdict to record; `.harness/verify.md` (VERIFY role) is
// never scanned for a verdict line by review-gate.mjs/reject-streak.mjs
// either -- only "review"-prefixed roles are in scope here.
export function isReviewFamilyRole(role) {
  return typeof role === "string" && REVIEW_ROLE_RE.test(role);
}

// HYK-183 §2: composes loadLedger + computeRecord + writeLedger into the
// one call relay-handshake.mjs's auto-wiring needs at the exact moment it
// confirms a REVIEW-family result file is complete. Idempotency is
// computeRecord's job (see its own header); this function's job is failure
// VISIBILITY (§2-1 R4) -- every branch returns a human-readable `reason`,
// never a silent no-op, so a caller that logs it (relay-handshake.mjs's
// CLI and in-process callers alike) surfaces a read/parse/write failure
// instead of folding it into "ledger just wasn't touched, nobody noticed."
export function recordRejectStreakFromResultText({
  role,
  resultText,
  ledgerPath,
  at,
}) {
  if (!isReviewFamilyRole(role)) {
    return {
      attempted: false,
      ok: true,
      reason: `reject-streak auto-record: role '${role}' is not REVIEW-family -- skipped (no verdict to record)`,
    };
  }

  const loaded = loadLedger(ledgerPath);
  if (!loaded.ok) {
    return { attempted: true, ok: false, reason: loaded.reason };
  }

  const computed = computeRecord({
    reviewText: resultText,
    ledger: loaded.ledger,
    at: at || formatNowLocal(),
  });
  if (!computed.ok) {
    return {
      attempted: true,
      ok: false,
      reason: `reject-streak auto-record: UNJUDGABLE -- ${computed.reason} (fail-open, ledger untouched)`,
    };
  }
  if (computed.duplicate) {
    return {
      attempted: true,
      ok: true,
      duplicate: true,
      reason: `reject-streak auto-record: DUPLICATE -- ${computed.issueId} <- ${computed.taskId} verdict=${computed.verdict} already last-recorded (streak=${computed.streak} unchanged), ledger not rewritten`,
    };
  }

  writeLedger(ledgerPath, computed.ledger);
  return {
    attempted: true,
    ok: true,
    duplicate: false,
    reason: `reject-streak auto-record: ${computed.issueId} <- ${computed.taskId} verdict=${computed.verdict} -> streak=${computed.streak}`,
  };
}

// Extracts the ORCH-action bullet lines from the envelope body's "ORCH
// 조치:" section -- every consecutive `- ...` line right after the header,
// stopping at the first blank line (once at least one bullet is captured)
// or the first non-bullet line. Returns null when the header itself is
// absent, [] when the header exists but no bullet followed it.
function extractActionBullets(body) {
  const headerMatch = body.match(ACTIONS_HEADER_RE);
  if (!headerMatch) return null;
  const rest = body.slice(body.indexOf(headerMatch[0]) + headerMatch[0].length);
  const bullets = [];
  for (const line of rest.split("\n")) {
    if (/^\s*$/.test(line)) {
      if (bullets.length > 0) break;
      continue;
    }
    const m = line.match(/^\s*-\s*(.+)$/);
    if (!m) break;
    bullets.push(m[1].trim());
  }
  return bullets;
}

function classifyAction(bulletLine) {
  const idx = bulletLine.indexOf(":");
  const label = (idx === -1 ? bulletLine : bulletLine.slice(0, idx)).trim();
  return (
    ALLOWED_ACTIONS.find(
      (allowed) => label === allowed || label.startsWith(allowed),
    ) ?? null
  );
}

// R2/R4: verifies a dropped task file's escalation envelope is *present and
// shaped correctly* -- honesty note (S4, item 4 of the task contract): this
// checks format only, never whether the stated cause is the real cause or
// whether the ORCH action is actually a good idea. That judgment is left to
// whoever reads the envelope later (review, or a human), same scope limit
// pm-snapshot-gate.mjs already documents for its own envelope.
export function checkEnvelope(taskText) {
  const text = normalizeNewlines(taskText);
  const blockMatch = text.match(ENVELOPE_BLOCK_RE);
  if (!blockMatch) {
    return {
      ok: false,
      reason:
        "reject-streak gate: no escalation envelope found (need '<!-- reject-streak-envelope ... -->' with 원인 분류 + ORCH 조치)",
    };
  }
  const body = blockMatch[1];

  const causeMatch = body.match(CAUSE_LINE_RE);
  const cause = causeMatch ? causeMatch[1].trim() : null;
  if (!cause) {
    return {
      ok: false,
      reason: "reject-streak gate: envelope missing '원인 분류:' field",
    };
  }
  if (!ALLOWED_CAUSES.some((c) => cause === c || cause.startsWith(c))) {
    return {
      ok: false,
      reason: `reject-streak gate: '원인 분류: ${cause}' is not one of ${ALLOWED_CAUSES.join(" | ")}`,
    };
  }

  const bullets = extractActionBullets(body);
  if (bullets === null) {
    return {
      ok: false,
      reason: "reject-streak gate: envelope missing 'ORCH 조치:' header",
    };
  }
  const classified = bullets.map(classifyAction).filter(Boolean);
  if (classified.length === 0) {
    return {
      ok: false,
      reason: `reject-streak gate: 'ORCH 조치' needs >=1 line '- <분류>: <내용>' matching ${ALLOWED_ACTIONS.join(" | ")} (found ${bullets.length} bullet(s), 0 matched)`,
    };
  }

  return {
    ok: true,
    reason: `reject-streak gate: envelope complete (원인 분류=${cause}, ORCH 조치=${classified.join(", ")})`,
  };
}

// R2/R3: the gate decision itself. `ledger` is the already-loaded object
// (loadLedger's corrupted/UNJUDGABLE case is handled by the caller before
// this is ever invoked -- see the CLI block). A task file with no
// resolvable task_id/issue id is UNJUDGABLE+fail-open, not a block --
// unlike the envelope-missing case, "I can't tell which issue this is"
// is never itself a reason to refuse a drop.
export function checkGate({ taskText, ledger }) {
  const text = normalizeNewlines(taskText);
  const taskIdMatch = text.match(TASK_ID_LINE_RE);
  if (!taskIdMatch) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason:
        "reject-streak gate: UNJUDGABLE -- task file has no task_id header, cannot resolve issue id (fail-open)",
    };
  }
  const issueId = issueIdFrom(taskIdMatch[1]);
  if (!issueId) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason: `reject-streak gate: UNJUDGABLE -- task_id '${taskIdMatch[1]}' does not start with HYK-<digits> (fail-open)`,
    };
  }

  const streak = ledger?.issues?.[issueId]?.streak ?? 0;
  if (streak < 2) {
    return {
      status: "PASS",
      ok: true,
      reason: `reject-streak gate: ${issueId} streak=${streak} (<2) -- envelope not required`,
    };
  }

  const envelope = checkEnvelope(text);
  if (!envelope.ok) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak gate: ${issueId} streak=${streak} (>=2) -- ${envelope.reason}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `reject-streak gate: ${issueId} streak=${streak} (>=2) -- ${envelope.reason}`,
  };
}

// HYK-158/G3: the hard-stop diagnostic envelope check -- same block
// (`<!-- reject-streak-envelope ... -->`) and 원인 분류/ORCH 조치 fields as
// checkEnvelope, PLUS the new 재현 증거 포인터 field. Kept as a separate
// function (not a flag bolted onto checkEnvelope) so the streak<2/streak>=2
// gate's existing reason strings -- already asserted by other tests/callers
// -- never shift shape; this is an additive extension, not a rewrite.
//
// Honesty (S4, design §3.2): this checks the envelope's *presence and
// shape* only. It never verifies the diagnosis is actually correct or
// sufficient, and never infers a cause or narrows issue scope on its own --
// that judgment stays with REVIEW/a human.
export function checkDiagnosticEnvelope(taskText) {
  const text = normalizeNewlines(taskText);
  const blockMatch = text.match(ENVELOPE_BLOCK_RE);
  if (!blockMatch) {
    return {
      ok: false,
      reason:
        "DIAGNOSTIC_REQUIRED -- hard-stop streak has no diagnostic envelope (need '<!-- reject-streak-envelope ... -->' with 원인 분류 + 재현 증거 포인터 + ORCH 조치)",
    };
  }
  const body = blockMatch[1];
  const missing = [];

  const causeMatch = body.match(CAUSE_LINE_RE);
  const cause = causeMatch ? causeMatch[1].trim() : null;
  if (!cause) {
    missing.push("원인 분류");
  } else if (!ALLOWED_CAUSES.some((c) => cause === c || cause.startsWith(c))) {
    missing.push(`원인 분류(허용값 아님: '${cause}')`);
  }

  const evidenceMatch = body.match(EVIDENCE_POINTER_LINE_RE);
  const evidencePointer = evidenceMatch ? evidenceMatch[1].trim() : null;
  if (!evidencePointer) {
    missing.push("재현 증거 포인터");
  }

  const bullets = extractActionBullets(body);
  const classifiedActions = (bullets ?? []).map(classifyAction).filter(Boolean);
  if (bullets === null) {
    missing.push("ORCH 조치");
  } else if (classifiedActions.length === 0) {
    missing.push(
      `ORCH 조치(허용 분류 불일치, ${bullets.length}개 불릿 중 0 매치)`,
    );
  }

  if (missing.length) {
    return {
      ok: false,
      reason: `DIAGNOSTIC_FIELD_MISSING -- missing field(s): ${missing.join(", ")}`,
    };
  }

  return {
    ok: true,
    reason: `diagnostic envelope complete (원인 분류=${cause}, 재현 증거 포인터=${evidencePointer}, ORCH 조치=${classifiedActions.join(", ")})`,
  };
}

// HYK-158/G3: the gate decision -- blocks the next coder drop for an issue
// whose streak has reached HARD_STOP_STREAK unless a complete diagnostic
// envelope accompanies it. Below the hard-stop tier this is always PASS
// regardless of the ordinary (streak>=2) envelope requirement checkGate
// already enforces -- the two gates are independent and both apply.
export function checkDiagnosticGate({ taskText, ledger }) {
  const text = normalizeNewlines(taskText);
  const taskIdMatch = text.match(TASK_ID_LINE_RE);
  if (!taskIdMatch) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason:
        "reject-streak diagnostic gate: UNJUDGABLE -- task file has no task_id header, cannot resolve issue id (fail-open)",
    };
  }
  const issueId = issueIdFrom(taskIdMatch[1]);
  if (!issueId) {
    return {
      status: "UNJUDGABLE",
      ok: true,
      reason: `reject-streak diagnostic gate: UNJUDGABLE -- task_id '${taskIdMatch[1]}' does not start with HYK-<digits> (fail-open)`,
    };
  }

  const streak = ledger?.issues?.[issueId]?.streak ?? 0;
  if (streak < HARD_STOP_STREAK) {
    return {
      status: "PASS",
      ok: true,
      reason: `reject-streak diagnostic gate: ${issueId} streak=${streak} (<${HARD_STOP_STREAK}, not hard-stop) -- diagnostic envelope not required`,
    };
  }

  const diag = checkDiagnosticEnvelope(text);
  if (!diag.ok) {
    return {
      status: "BLOCK",
      ok: false,
      reason: `reject-streak diagnostic gate: ${issueId} streak=${streak} (hard-stop) -- ${diag.reason}`,
    };
  }
  return {
    status: "PASS",
    ok: true,
    reason: `reject-streak diagnostic gate: ${issueId} streak=${streak} (hard-stop) -- ${diag.reason}`,
  };
}

export function formatNowLocal(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} KST`;
}

function parseArgs(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--review") out.review = args[++i];
    else if (args[i] === "--ledger") out.ledger = args[++i];
    else if (args[i] === "--at") out.at = args[++i];
    else out._.push(args[i]);
  }
  return out;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/reject-streak.mjs");
if (invokedDirectly) {
  const root = repoRoot();
  const [sub, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (sub === "record") {
    const reviewPath = args.review || join(root, ".harness", "review.md");
    const ledgerPath =
      args.ledger || join(ledgerRepoRoot(), ".harness", "reject-streak.json");

    if (!existsSync(reviewPath)) {
      console.log(
        `reject-streak record: UNJUDGABLE -- review file not found: ${reviewPath} (fail-open, ledger untouched)`,
      );
      process.exit(0);
    }
    const reviewText = readFileSync(reviewPath, "utf8");

    const loaded = loadLedger(ledgerPath);
    if (!loaded.ok) {
      console.log(loaded.reason + " (fail-open, ledger untouched)");
      process.exit(0);
    }

    const result = computeRecord({
      reviewText,
      ledger: loaded.ledger,
      at: args.at || formatNowLocal(),
    });
    if (!result.ok) {
      console.log(
        `reject-streak record: UNJUDGABLE -- ${result.reason} (fail-open, ledger untouched)`,
      );
      process.exit(0);
    }

    if (result.duplicate) {
      console.log(
        `reject-streak record: DUPLICATE -- ${result.issueId} <- ${result.taskId} verdict=${result.verdict} already last-recorded (streak=${result.streak} unchanged), ledger not rewritten`,
      );
      process.exit(0);
    }

    writeLedger(ledgerPath, result.ledger);
    console.log(
      `reject-streak record: ${result.issueId} <- ${result.taskId} verdict=${result.verdict} -> streak=${result.streak}`,
    );
    process.exit(0);
  }

  if (sub === "gate") {
    const taskPath = args._[0] || join(root, ".harness", "coder-task.md");
    const ledgerPath =
      args.ledger || join(ledgerRepoRoot(), ".harness", "reject-streak.json");

    if (!existsSync(taskPath)) {
      console.error(`reject-streak gate: task file not found: ${taskPath}`);
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, "utf8");

    const loaded = loadLedger(ledgerPath);
    if (!loaded.ok) {
      console.log(loaded.reason + " -- exit 0 (fail-open, drop not blocked)");
      process.exit(0);
    }

    const result = checkGate({ taskText, ledger: loaded.ledger });
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  if (sub === "diagnostic-gate") {
    const taskPath = args._[0] || join(root, ".harness", "coder-task.md");
    const ledgerPath =
      args.ledger || join(ledgerRepoRoot(), ".harness", "reject-streak.json");

    if (!existsSync(taskPath)) {
      console.error(
        `reject-streak diagnostic-gate: task file not found: ${taskPath}`,
      );
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, "utf8");

    const loaded = loadLedger(ledgerPath);
    if (!loaded.ok) {
      console.log(loaded.reason + " -- exit 0 (fail-open, drop not blocked)");
      process.exit(0);
    }

    const result = checkDiagnosticGate({ taskText, ledger: loaded.ledger });
    if (result.status === "BLOCK") {
      console.error(result.reason);
      process.exit(2);
    }
    console.log(result.reason);
    process.exit(0);
  }

  console.error(
    "usage: node reject-streak.mjs record --review <path> [--ledger <path>] [--at <'YYYY-MM-DD HH:MM KST'>]",
  );
  console.error(
    "       node reject-streak.mjs gate [<task-path>] [--ledger <path>]",
  );
  console.error(
    "       node reject-streak.mjs diagnostic-gate [<task-path>] [--ledger <path>]",
  );
  process.exit(1);
}
