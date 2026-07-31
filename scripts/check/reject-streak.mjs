import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

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
  return {
    ok: true,
    taskId: rawTaskId,
    issueId,
    verdict: verdictMatches[0][1].toLowerCase(),
  };
}

// Pure ledger transition: rejected increments that issue's streak, approved
// resets it to 0. An issue absent from the ledger starts at streak 0 (same
// "no ledger entry == streak 0" rule the gate side uses), so record/gate
// agree on what "no history yet" means. Every outcome is appended to that
// issue's history regardless of verdict -- the ladder needs the full
// sequence, not just the current streak, to explain itself later.
export function applyOutcome(ledger, { issueId, taskId, verdict, at }) {
  const issues = { ...(ledger?.issues ?? {}) };
  const prev = issues[issueId] ?? { streak: 0, history: [] };
  const streak = verdict === "rejected" ? (prev.streak ?? 0) + 1 : 0;
  issues[issueId] = {
    streak,
    history: [...(prev.history ?? []), { task_id: taskId, verdict, at }],
  };
  return { schema_version: ledger?.schema_version ?? 1, issues };
}

// Composes parseReviewOutcome + applyOutcome into the one decision `record`
// needs. Never throws; a malformed review text is reported as `ok: false`
// so the CLI can treat it as UNJUDGABLE (fail-open) rather than corrupting
// the ledger with a guessed entry.
export function computeRecord({ reviewText, ledger, at }) {
  const outcome = parseReviewOutcome(reviewText);
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const nextLedger = applyOutcome(ledger, {
    issueId: outcome.issueId,
    taskId: outcome.taskId,
    verdict: outcome.verdict,
    at,
  });
  return {
    ok: true,
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
      args.ledger || join(root, ".harness", "reject-streak.json");

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

    writeLedger(ledgerPath, result.ledger);
    console.log(
      `reject-streak record: ${result.issueId} <- ${result.taskId} verdict=${result.verdict} -> streak=${result.streak}`,
    );
    process.exit(0);
  }

  if (sub === "gate") {
    const taskPath = args._[0] || join(root, ".harness", "coder-task.md");
    const ledgerPath =
      args.ledger || join(root, ".harness", "reject-streak.json");

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
      args.ledger || join(root, ".harness", "reject-streak.json");

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
