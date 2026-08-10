// HYK-186 2R §4/§6 -- wire layer for the (B) trust-boundary audit
// (inbox-time-audit-core.mjs). Reads real files, extracts header/filename
// times, calls the pure judge, and prints a HUMAN-READABLE report. Never
// exits non-zero for a MISMATCH -- (B) is audit-only, it never blocks
// (§4-2 ①). The one non-zero exit this CLI has is a genuine usage/read
// error, never a judgment outcome.
//
// ★도달 경로(§6-3): this CLI's stdout IS the reach path -- a human (ORCH/PM)
// runs it on demand when auditing 받는함. It is deliberately NOT wired into
// `scripts/supervisor/reach-report-core.mjs`'s `AXES` closed array: AXES is
// for watch-run.mjs's periodic per-worktree seat-liveness anomaly stream
// (seat/idle/start/unconsumed/cap/escalation), each field-prefixed onto one
// watch.log line per tick. This judge is a one-shot, per-file audit with no
// periodic "still open since when" semantics and no watch.log field wiring
// -- forcing it into AXES's shape (worstCount/worktrees columns that don't
// apply to individual inbox files) would be the exact "이름만 다른 (A)"
// mistake §4-1 forbids, and would also silently make (B) an escalation
// trigger, which §4-2 ① explicitly bans. escalation-axis-wire.test.mjs
// already locks AXES against exactly this kind of silent third addition.

import { readdirSync, statSync, readFileSync } from "node:fs";
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
export function auditFile({
  filePath,
  basename,
  readFileFn = (p) => readFileSync(p, "utf8"),
  statFn = statSync,
}) {
  const stat = statFn(filePath);
  // CreationTime is birthtimeMs where the platform/filesystem tracks it;
  // this module never fabricates one. mtimeMs (LastWriteTime) is read too,
  // but stays advisory-only all the way through (never fed to the judge as
  // creationTimeMs).
  const creationTimeMs =
    Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
      ? stat.birthtimeMs
      : null;
  const lastWriteTimeMs = Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  const dayAnchorMs = dayAnchorOfLocalDate(creationTimeMs ?? lastWriteTimeMs ?? Date.now());

  const content = readFileFn(filePath);
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
  return ms === null || ms === undefined ? "(없음)" : new Date(ms).toISOString();
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
  const lastWriteMin = d.lastWriteDeltaMs === null || d.lastWriteDeltaMs === undefined
    ? null
    : minutes(d.lastWriteDeltaMs);
  const evidenceLabel = d.evidence === "creationTime" ? "실제 CreationTime" : "파일명 시각";
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

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/inbox-time-audit.mjs");
if (invokedDirectly) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node inbox-time-audit.mjs <inboxDir>");
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
  // (B)는 절대 exit을 비0으로 만들지 않는다 -- MISMATCH/UNDECIDABLE이
  // 있어도 exit 0. 이 CLI가 비정상 종료하는 유일한 경우는 위의 read 실패뿐.
  process.exit(0);
}
