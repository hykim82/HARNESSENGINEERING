// HYK-186 2R §4/§6 -- wire layer for the (B) trust-boundary audit
// (inbox-time-audit-core.mjs). Reads real files, extracts header/filename
// times, calls the pure judge, and prints a HUMAN-READABLE report. Never
// exits non-zero for a MISMATCH -- (B) is audit-only, it never blocks
// (§4-2 ①). The one non-zero exit this CLI has is a genuine usage/read
// error, never a judgment outcome.
//
// ★도달 경로(§6-3, HYK-186 3R P1-3 갱신): stdout만으로는 "로그에만 남는
//것" (독립 검토 실측: durable artifact 0 · watcher 소비 0 · reach-notify 0
// · 알림 0)이라 완료조건8의 도달 요건 미충족 판정을 받았다. 이 라운드가
// 추가한 것은 **오래 남는 파일**(`--report <path>`, 기본 append) -- 사람이
// 나중에 열어 실행 이력을 그대로 읽을 수 있다. 여전히 (B) 성격은 그대로:
// exit은 항상 0(막지 않음), 릴레이를 멈추지 않음, `AXES`에는 등재하지
// 않음(아래 이유 그대로 유효 -- 독립 검토가 코드로 성립한다고 인정한
// 사유라 다시 만들지 않는다). AXES는 watch-run.mjs의 주기적 per-worktree
// seat-liveness 이상 스트림(seat/idle/start/unconsumed/cap/escalation) 전용
// -- 이 판정기는 1회성/파일별 감사라 그 틀에 억지로 끼우면 §4-1이 금지한
// "이름만 다른 (A)"가 되고, (B)를 escalation 트리거로 만들어 §4-2 ①을
// 어기게 된다(`escalation-axis-wire.test.mjs`가 그 3번째 축 추가를 잠가
// 뒀다). durable 파일은 그 대신 "사람이 직접 열어 보는" 도달 경로다.

import {
  readdirSync,
  statSync,
  readFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  judgeInboxTimeAudit,
  INBOX_AUDIT_VERDICT,
  groupByFilenameMinute,
} from "./inbox-time-audit-core.mjs";

// Filename convention observed in the two known trap samples (coder-task.md
// §4-3): a leading 4-digit HHMM token, e.g. "0104-..." / "0303-...".
const FILENAME_HHMM_RE = /^(\d{2})(\d{2})/;
// Body header convention: a standalone line like "시각: 01:04" or a bare
// "01:04" near the top -- kept loose (HH:MM anywhere in the first line) since
// this is (B), audit-only; a header this loose parser can't find is reported
// UNDECIDABLE, never guessed.
const HEADER_HHMM_RE = /(\d{1,2}):(\d{2})/;

function minutesToMsOfDay(hh, mm) {
  return (hh * 60 + mm) * 60 * 1000;
}

// dayAnchorMs: the caller-supplied "which calendar day" the HH:MM tokens are
// relative to (this module does not itself know the file's actual date --
// callers pass the date they already resolved, e.g. from the file's own
// stat, keeping this function pure and testable without a real clock).
function extractFilenameTimeMs(basename, dayAnchorMs) {
  const m = basename.match(FILENAME_HHMM_RE);
  if (!m) return null;
  return dayAnchorMs + minutesToMsOfDay(Number(m[1]), Number(m[2]));
}

function extractHeaderTimeMs(content, dayAnchorMs) {
  if (typeof content !== "string") return null;
  const firstLines = content.split(/\r?\n/, 5).join("\n");
  const m = firstLines.match(HEADER_HHMM_RE);
  if (!m) return null;
  return dayAnchorMs + minutesToMsOfDay(Number(m[1]), Number(m[2]));
}

// auditFile: pure-ish (only readFileSync/statSync as injected deps) --
// resolves one file's audit inputs and returns the judge's verdict plus a
// human-readable line.
//
// HYK-186 3R P2 (독립 검토 조건 "디렉터리·읽기/stat 실패"): a bare
// `statFn`/`readFileFn` call with no try/catch means one unreadable entry
// (a subdirectory readdirSync also returns, a permissions error, a file
// deleted between readdir and stat) throws OUT of auditFile entirely --
// which auditDirectory does not catch either, so the WHOLE run crashes.
// That directly violates (B)'s own "never blocks, always exit 0" contract
// (§4-2 ①) -- a crash is a harder failure than a non-zero exit. Wrapped
// here so a single bad entry degrades to its own UNDECIDABLE verdict
// (fail-closed, not a guess) instead of taking every other entry in the
// same directory down with it.
export function auditFile({
  filePath,
  basename,
  readFileFn = (p) => readFileSync(p, "utf8"),
  statFn = statSync,
}) {
  let stat;
  let content;
  try {
    stat = statFn(filePath);
    content = readFileFn(filePath);
  } catch (err) {
    return {
      filePath,
      basename,
      ok: true,
      verdict: INBOX_AUDIT_VERDICT.UNDECIDABLE,
      reasonCode: "READ_OR_STAT_FAILED",
      details: { error: err.message },
    };
  }
  // CreationTime is birthtimeMs where the platform/filesystem tracks it;
  // this module never fabricates one. mtimeMs (LastWriteTime) is read too,
  // but stays advisory-only all the way through (never fed to the judge as
  // creationTimeMs).
  const creationTimeMs =
    Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
      ? stat.birthtimeMs
      : null;
  const lastWriteTimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  const dayAnchorMs = dayAnchorOfLocalDate(
    creationTimeMs ?? lastWriteTimeMs ?? Date.now(),
  );

  const headerTimeMs = extractHeaderTimeMs(content, dayAnchorMs);
  const filenameTimeMs = extractFilenameTimeMs(basename, dayAnchorMs);

  const verdict = judgeInboxTimeAudit({
    headerTimeMs,
    creationTimeMs,
    lastWriteTimeMs,
    filenameTimeMs,
  });

  return { filePath, basename, ...verdict };
}

// Local-day anchor (not the placeholder above -- kept as the one real
// implementation so tests can still import extractFilenameTimeMs/
// extractHeaderTimeMs with an explicit dayAnchorMs without depending on this
// function's Date.now()-derived behavior).
function dayAnchorOfLocalDate(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function fmt(ms) {
  return ms === null || ms === undefined
    ? "(없음)"
    : new Date(ms).toISOString();
}

// §6-2 요구: "이 파일의 헤더 시각이 파일명과/실제와 N분 어긋난다 · 근거는
// 무엇이고 mtime은 보조로만 봤다"가 사람 말로 보여야 한다 -- 코드값만
// 찍지 않는다.
export function formatAuditLine(entry) {
  const minutes = (ms) => (ms === null ? null : Math.round(ms / 60000));
  if (entry.verdict === INBOX_AUDIT_VERDICT.UNDECIDABLE) {
    return `UNDECIDABLE ${entry.basename}: ${entry.reasonCode} -- 판정 불가(증거 부족), 정상으로 접지 않음`;
  }
  const d = entry.details;
  const deltaMin = minutes(d.deltaMs);
  const lastWriteMin =
    d.lastWriteDeltaMs === null || d.lastWriteDeltaMs === undefined
      ? null
      : minutes(d.lastWriteDeltaMs);
  const evidenceLabel =
    d.evidence === "creationTime" ? "실제 CreationTime" : "파일명 시각";
  const base =
    entry.verdict === INBOX_AUDIT_VERDICT.NORMAL
      ? `NORMAL ${entry.basename}: 본문 헤더 시각이 ${evidenceLabel}와 ${Math.abs(deltaMin)}분 이내로 일치 (근거: ${evidenceLabel})`
      : `MISMATCH ${entry.basename}: 본문 헤더 시각이 ${evidenceLabel}와 ${Math.abs(deltaMin)}분 어긋남 (근거: ${evidenceLabel}, header=${fmt(d.headerTimeMs)})`;
  const advisory =
    lastWriteMin === null
      ? ""
      : ` [mtime은 보조로만 봄: LastWriteTime이 헤더 대비 ${lastWriteMin}분 차이 -- verdict에는 미반영]`;
  return base + advisory;
}

// auditDirectory: enumerates files in `dir`, audits each, returns
// {entries, groups} -- `groups` demonstrates the 동일 분 충돌 policy
// (groupByFilenameMinute never collapses).
export function auditDirectory({
  dir,
  readdirFn = readdirSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  statFn = statSync,
}) {
  const names = readdirFn(dir);
  const entries = names.map((basename) =>
    auditFile({
      filePath: join(dir, basename),
      basename,
      readFileFn,
      statFn,
    }),
  );
  const groups = groupByFilenameMinute(
    entries.map((e) => ({
      minuteKey: e.basename.match(FILENAME_HHMM_RE)?.[0] ?? e.basename,
      ...e,
    })),
  );
  return { entries, groups };
}

// buildAuditReportBatch: pure -- one run's durable text block. Each run gets
// its own "## Audit run <ISO-with-ms>" header (millisecond precision, not
// just minute) specifically so two runs inside the SAME MINUTE stay
// distinguishable batches rather than colliding -- same "never silently
// collapse" principle groupByFilenameMinute already applies to same-minute
// inbox files, applied here to same-minute audit RUNS.
export function buildAuditReportBatch({ entries, runAtMs, dir }) {
  const header = `## Audit run ${new Date(runAtMs).toISOString()} (dir: ${dir})`;
  const lines = entries.map((e) => `- ${formatAuditLine(e)}`);
  const body = lines.length > 0 ? lines.join("\n") : "- (no files found)";
  return `${header}\n${body}\n\n`;
}

// writeAuditReport: ★정책 = APPEND, never overwrite/truncate. (B)는 감사
// 기록이다 -- 이전 실행 결과를 조용히 지우면(overwrite) "언제 무엇을
// 봤는지"가 사라진다(judgeAuditValidityAfterChange의 INVALIDATED-not-
// re-stamp 결정과 같은 원칙, inbox-time-audit-core.mjs 참고). 같은 분
// 안에 두 번 실행돼도(§3 요구) 두 배치 모두 파일에 남는다 -- 병합·대표
// 선정 없음, groupByFilenameMinute의 정책과 동형.
export function writeAuditReport({
  reportPath,
  batchText,
  appendFileFn = appendFileSync,
  existsFn = existsSync,
}) {
  const alreadyExists = existsFn(reportPath);
  const prefix = alreadyExists
    ? ""
    : "# inbox-time-audit durable report (append-only -- never overwritten, never truncated)\n\n";
  appendFileFn(reportPath, prefix + batchText, "utf8");
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/inbox-time-audit.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const dir = args[0];
  const reportFlagIdx = args.indexOf("--report");
  const reportPath = reportFlagIdx >= 0 ? args[reportFlagIdx + 1] : undefined;
  if (!dir || (reportFlagIdx >= 0 && !reportPath)) {
    console.error(
      "usage: node inbox-time-audit.mjs <inboxDir> [--report <reportPath>]",
    );
    process.exit(1);
  }
  let result;
  try {
    result = auditDirectory({ dir });
  } catch (err) {
    console.error(`inbox-time-audit: could not read '${dir}': ${err.message}`);
    process.exit(1);
  }
  for (const entry of result.entries) {
    console.log(formatAuditLine(entry));
  }
  if (reportPath) {
    const batchText = buildAuditReportBatch({
      entries: result.entries,
      runAtMs: Date.now(),
      dir,
    });
    try {
      writeAuditReport({ reportPath, batchText });
      console.log(`(durable report appended: ${reportPath})`);
    } catch (err) {
      // §4-2 ①: (B) never blocks -- a report-write failure is surfaced on
      // stderr but must not turn this run's exit non-zero either.
      console.error(
        `inbox-time-audit: could not append durable report '${reportPath}': ${err.message}`,
      );
    }
  }
  // (B)는 절대 exit을 비0으로 만들지 않는다 -- MISMATCH/UNDECIDABLE이나
  // 리포트 쓰기 실패가 있어도 exit 0. 이 CLI가 비정상 종료하는 유일한
  // 경우는 위의 inboxDir read 실패뿐(사용법 오류와 같은 급).
  process.exit(0);
}
