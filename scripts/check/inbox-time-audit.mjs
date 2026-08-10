// HYK-186 2R §4/§6 -- wire layer for the (B) trust-boundary audit
// (inbox-time-audit-core.mjs). Reads real files, extracts header/filename
// times, calls the pure judge, and prints a HUMAN-READABLE report. Never
// exits non-zero for a MISMATCH -- (B) is audit-only, it never blocks
// (§4-2 ①). The one non-zero exit this CLI has is a genuine usage/read
// error, never a judgment outcome.
//
// ★도달 경로(§6-3, HYK-186 3R P1-3 갱신 · 4R §2 합격 기준 확정): stdout만으로는
// "로그에만 남는 것"(독립 검토 실측: durable artifact 0 · watcher 소비 0 ·
// reach-notify 0 · 알림 0)이라 완료조건8의 도달 요건 미충족 판정을 받았다
// (3R). 3R의 `--report <path>`는 opt-in이라 아무도 플래그를 주지 않으면
// 운영상 stdout-only와 동일하다는 재반려(2R/3R 연속반려 게이트2)를 받아,
// 4R이 **기본 활성화**로 승격했다 -- 플래그 없이 돌려도 고정 기본 경로
// (`DEFAULT_REPORT_BASENAME`, inboxDir 하위)에 항상 남는다. 끄는 방법은
// 명시적 `--no-report` 하나뿐(암묵적 끄기 없음). 여전히 (B) 성격은 그대로:
// exit은 항상 0(막지 않음, 리포트 쓰기 실패도 포함), 릴레이를 멈추지 않음,
// `AXES`에는 등재하지 않음(아래 이유 그대로 유효 -- 독립 검토가 코드로
// 성립한다고 인정한 사유라 다시 만들지 않는다). AXES는 watch-run.mjs의
// 주기적 per-worktree seat-liveness 이상 스트림(seat/idle/start/unconsumed/
// cap/escalation) 전용 -- 이 판정기는 1회성/파일별 감사라 그 틀에 억지로
// 끼우면 §4-1이 금지한 "이름만 다른 (A)"가 되고, (B)를 escalation
// 트리거로 만들어 §4-2 ①을 어기게 된다(`escalation-axis-wire.test.mjs`가
// 그 3번째 축 추가를 잠가 뒀다). durable 파일은 그 대신 "사람이 직접 열어
// 보는" 도달 경로다.
//
// ★정직 한계(HYK-186 4R §3, 한용 확정): 이 라운드가 보장하는 것은 "이
// 명령을 돌리면 반드시 기록이 남는다"까지다. "누가·언제·어떤 주기로
// 실제 받는함을 감사하는가"(실제 호출자 결선, ⓑ)는 이 이슈 밖으로 별건
// 분리됐다 -- 이 CLI를 정기적으로 도는 감사기가 아직 없다.

import {
  readdirSync,
  statSync,
  readFileSync,
  appendFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, resolve, basename as pathBasename } from "node:path";
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

// HYK-186 6R §2 -- 5R's exclusion compared raw strings (separator-only
// normalization) -- an independent review reproduced 4 alias shapes that
// defeat a string comparison while still pointing at the exact same file:
// case changes, `.`/`..` segments, and a junction/symlink hop. This
// canonicalizes a path for comparison in two cheap-first, fs-only-if-needed
// steps.
//
// ★대소문자 판단(§2 요구): 무조건 무시하지 않는다 -- 리눅스는 대소문자를
// 구별하므로 `Report.md`/`report.md`가 서로 다른 실제 파일일 수 있다.
// **플랫폼 기준**으로 결정한다: win32/darwin은 기본 파일시스템이 대소문자
// 비구별(NTFS/APFS 기본 설정)이므로 소문자로 접어 비교하고, 그 외
// (linux 등)는 원문 그대로 구별한다. ⚠️정직 한계: 이것은 휴리스틱이다 --
// NTFS도 case-sensitive 모드로 마운트될 수 있고 Linux도 case-insensitive
// 파일시스템(exFAT 등)을 마운트할 수 있다. 실제 파일시스템 대소문자
// 정책을 질의하는 표준 API가 Node에 없어, "플랫폼 기본값"을 근사로 쓴다.
const FS_IS_CASE_INSENSITIVE_BY_DEFAULT =
  process.platform === "win32" || process.platform === "darwin";

function applyCaseFold(p) {
  return FS_IS_CASE_INSENSITIVE_BY_DEFAULT ? p.toLowerCase() : p;
}

// Cheap normalize: separators + case-fold + `path.resolve`'s own `.`/`..`
// segment collapsing. Zero filesystem access -- always safe to call on
// every directory entry (this is the O(1)-per-entry cost, no realpath).
function cheapNormalize(p) {
  if (typeof p !== "string") return p;
  return applyCaseFold(resolve(p).replace(/\\/g, "/"));
}

// realpath-canonicalize a single path, tolerating a target that doesn't
// exist yet (§2 요구 2: "리포트 파일은 첫 실행 때는 아직 없다... 실패를
// 그냥 던지면 (B)의 절대 안 멈춘다 계약이 깨진다"). Falls back to the
// cheap normalize on ANY realpathSync failure (ENOENT, permission error,
// broken link, whatever) -- never throws out of this function.
function canonicalizeExisting(p) {
  try {
    return applyCaseFold(realpathSync(p).replace(/\\/g, "/"));
  } catch {
    return cheapNormalize(p);
  }
}

// auditDirectory: enumerates files in `dir`, audits each, returns
// {entries, groups, excluded} -- `groups` demonstrates the 동일 분 충돌
// policy (groupByFilenameMinute never collapses).
//
// HYK-186 5R (검토자 실측, 4R 신규 결함): the durable report's fixed
// default lives INSIDE inboxDir (3R/4R's own deliberate, 검토자가 타당
// 판정한 choice -- moving it out reopens the 08-05 Linux-CI absolute-path
// incident, §1). That means from the SECOND run onward, the report file
// this exact run is about to write to already exists as an ordinary inbox
// entry -- and gets audited as one, misreading its own "## Audit run
// <ISO>" batch header as if it were a genuine time-claiming header. A
// self-referential false MISMATCH then gets appended to the very report
// meant to be a trustworthy record (검토자 실측: 2회차부터 자기 리포트에
// 대한 허위 541분 MISMATCH가 durable 기록에 섞였다).
//
// ★제외 기준 = "이 실행이 쓸 정확한 경로"(exact path match), 파일명
// 문자열 패턴이 아니다. 근거(§2-2 요구 그대로):
// - 파일명 패턴(예: `.inbox-time-audit-report.md`로 시작하는 것 전부, 혹은
//   모든 `.md`)으로 제외하면 §2 변조2("과도하게 넓힘")가 정확히 잡아내는
//   실패 모드가 된다 -- 진짜 감사 대상(예: 우연히 같은 이름 패턴을 가진
//   실제 받는함 파일)까지 조용히 사라진다.
// - `excludePath`는 호출자(CLI)가 `resolveReportPath`로 이미 계산한 **이번
//   실행의 실제 목적지**를 그대로 넘긴다 -- 그 값이 기본 경로든,
//   `--report <path>`로 준 경로든(마침 inboxDir 안이어도), 환경변수 경로든
//   상관없다: "이번 실행이 그 파일에 쓸 것이다"라는 사실 하나만 본다.
// - `--no-report`인 실행은 `excludePath`가 애초에 없다(CLI가 `reportPath`
//   가 null일 때 이 인자를 안 넘긴다) -- 그래서 이전 실행이 남긴 리포트
//   파일이 inboxDir에 남아 있어도 **평범한 파일로 그대로 감사된다**. 조용히
//   숨기면 "실제로 있는 파일을 감사에서 빼는" 또 다른 문제가 된다는 §2-2의
//   경고를 그대로 따른 것 -- 제외는 오직 "이 실행이 지금 쓰려는 그 파일"
//   하나뿐이다.
//
// HYK-186 6R (검토자 실측, 5R 잔여 결함): 5R의 비교는 구분자만 바꿨다 --
// 대소문자·`.`/`..` 세그먼트·junction/symlink 별칭 4형태가 문자열로는
// 달라 보이지만 같은 실제 파일을 가리킬 때 제외에 실패했다. 아래는 두
// 단계로 비교한다:
//   1. **cheap 단계**(파일시스템 접근 0, 모든 항목에 적용) -- 구분자·
//      대소문자(플랫폼 기준)·`.`/`..` 세그먼트까지 `path.resolve`로 접는다.
//      실패 형태 1(대소문자)·2(`.`)·3(`..`)는 이 단계에서 전부 잡힌다.
//   2. **realpath 단계**(§2 요구 3 "성능/부작용": 제외 후보 1개에만 적용
//      -- 감사 대상 전원이 아니다). `excludePath`는 이번 실행에 **정확히
//      하나**뿐이므로 그 값 하나만 `canonicalizeExisting`으로 미리
//      해석해 둔다(실행당 1회). 각 디렉터리 항목은 cheap 비교로 이미
//      일치하면 즉시 제외(가장 흔한 경우, realpath 호출 0). cheap 비교가
//      불일치할 때만, **그 항목의 basename이 exclude 대상의 basename과
//      (같은 대소문자 규칙으로) 일치하는 경우에 한해** 그 항목 하나만
//      추가로 realpath를 부른다 -- junction은 파일명은 그대로 두고
//      디렉터리 경로만 별칭을 태우는 형태(§2 예시 "alias\junction-
//      report.md")이므로, basename 사전 필터가 junction 후보를 놓치지
//      않으면서도 나머지 무관한 항목들에는 realpath를 전혀 부르지 않는다.
export function auditDirectory({
  dir,
  excludePath,
  readdirFn = readdirSync,
  readFileFn = (p) => readFileSync(p, "utf8"),
  statFn = statSync,
}) {
  const names = readdirFn(dir);
  const hasExclude = typeof excludePath === "string";
  const excludeCheap = hasExclude ? cheapNormalize(excludePath) : null;
  const excludeBasenameCheap = hasExclude
    ? applyCaseFold(pathBasename(excludePath))
    : null;
  // realpath 호출은 여기 딱 1번 -- exclude 후보 자신에게만.
  const excludeReal = hasExclude ? canonicalizeExisting(excludePath) : null;

  const excluded = [];
  const entries = [];
  for (const basename of names) {
    const filePath = join(dir, basename);
    if (hasExclude) {
      if (cheapNormalize(filePath) === excludeCheap) {
        excluded.push(basename);
        continue;
      }
      if (
        applyCaseFold(basename) === excludeBasenameCheap &&
        canonicalizeExisting(filePath) === excludeReal
      ) {
        excluded.push(basename);
        continue;
      }
    }
    entries.push(auditFile({ filePath, basename, readFileFn, statFn }));
  }
  const groups = groupByFilenameMinute(
    entries.map((e) => ({
      minuteKey: e.basename.match(FILENAME_HHMM_RE)?.[0] ?? e.basename,
      ...e,
    })),
  );
  return { entries, groups, excluded };
}

// buildAuditReportBatch: pure -- one run's durable text block. Each run gets
// its own "## Audit run <ISO-with-ms>" header (millisecond precision, not
// just minute) specifically so two runs inside the SAME MINUTE stay
// distinguishable batches rather than colliding -- same "never silently
// collapse" principle groupByFilenameMinute already applies to same-minute
// inbox files, applied here to same-minute audit RUNS.
// HYK-186 5R §2-3: the self-exclusion must not be a silent subtraction --
// a reader of either the terminal output or the durable file itself must
// be able to see that a file was deliberately left out (and which one,
// and why), not just notice the entry count is one lower than they
// expected. Surfaced in BOTH places (stdout via the CLI block below, and
// here in the durable batch) since the durable file is the one a human
// reads well after the terminal output is gone -- a note only on stdout
// would itself become "로그에만 남는 것", the exact defect 3R/4R exist to
// close for every other piece of this tool's output.
export function buildAuditReportBatch({
  entries,
  runAtMs,
  dir,
  excluded = [],
}) {
  const header = `## Audit run ${new Date(runAtMs).toISOString()} (dir: ${dir})`;
  const lines = entries.map((e) => `- ${formatAuditLine(e)}`);
  if (excluded.length > 0) {
    lines.push(
      `- (자기 리포트 ${excluded.length}건 감사 대상에서 제외: ${excluded.join(", ")} -- 이 실행이 직접 쓰는 durable 리포트 파일이라 자기 자신을 감사하지 않음)`,
    );
  }
  const body = lines.length > 0 ? lines.join("\n") : "- (no files found)";
  return `${header}\n${body}\n\n`;
}

// HYK-186 4R §2 -- 합격 기준(2R 검토자 문장의 검증 가능한 절반, 한용 게이트2
// «가» 확정): "고정된 기본 경로로 report를 기본 활성화하고, 끄기는 명시적
// --no-report로만." resolveReportPath는 순수 함수(관측은 호출자가 준다) --
// 우선순위: (1) --no-report -> null(명시적 끄기만 인정, 암묵적 끄기 금지)
// (2) --report <path> -> 그 경로(기존 2R/3R 하위호환) (3) 환경변수 override
// -> 리눅스 CI/다른 배치 위치가 필요할 때 시험/운영이 재정의하는 수단
// (4) 기본값 -- join(dir, DEFAULT_REPORT_BASENAME). ★기본 경로를
// inboxDir 자신의 하위로 고른 이유: 이 CLI가 아는 유일한 "고정된" 위치는
// 호출자가 인자로 준 inboxDir뿐이다 -- 저장소 경로(D:\ 같은 절대경로)를
//하드코딩하면 정확히 08-05 실사고(리눅스 CI가 D:\ 를 못 읽어 깨짐)를
// 재현한다. inboxDir 하위는 (a) 항상 존재가 보장된 디렉터리이고 (b) 시험이
// mkdtemp로 주는 임시 디렉터리에도 자연히 함께 생겨 리눅스에서도 동일하게
// 동작하며 (c) 감사 대상과 감사 결과가 같은 자리에 남아 "어느 받는함의
// 기록인지" 사람이 따로 찾을 필요가 없다.
export const DEFAULT_REPORT_BASENAME = ".inbox-time-audit-report.md";
export const REPORT_PATH_ENV_VAR = "INBOX_TIME_AUDIT_REPORT_PATH";

export function resolveReportPath({
  dir,
  noReport,
  explicitReportPath,
  env = process.env,
}) {
  if (noReport) return null;
  if (typeof explicitReportPath === "string" && explicitReportPath.length > 0) {
    return explicitReportPath;
  }
  const envOverride = env?.[REPORT_PATH_ENV_VAR];
  if (typeof envOverride === "string" && envOverride.length > 0) {
    return envOverride;
  }
  return join(dir, DEFAULT_REPORT_BASENAME);
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
  const explicitReportPath =
    reportFlagIdx >= 0 ? args[reportFlagIdx + 1] : undefined;
  const noReport = args.includes("--no-report");
  if (
    !dir ||
    (reportFlagIdx >= 0 && !explicitReportPath) ||
    (noReport && reportFlagIdx >= 0)
  ) {
    console.error(
      "usage: node inbox-time-audit.mjs <inboxDir> [--report <reportPath> | --no-report]",
    );
    process.exit(1);
  }
  const reportPath = resolveReportPath({ dir, noReport, explicitReportPath });
  let result;
  try {
    result = auditDirectory({ dir, excludePath: reportPath ?? undefined });
  } catch (err) {
    console.error(`inbox-time-audit: could not read '${dir}': ${err.message}`);
    process.exit(1);
  }
  for (const entry of result.entries) {
    console.log(formatAuditLine(entry));
  }
  if (result.excluded.length > 0) {
    console.log(
      `(자기 리포트 ${result.excluded.length}건 감사 대상에서 제외: ${result.excluded.join(", ")})`,
    );
  }
  if (reportPath) {
    const batchText = buildAuditReportBatch({
      entries: result.entries,
      runAtMs: Date.now(),
      dir,
      excluded: result.excluded,
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
