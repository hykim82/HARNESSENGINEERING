// HYK-191-reach-1 (coder-task.md) -- 예약 감시 4축이 이미 잡는 신호를
// 사람에게 도달시키는 진입점(요건1의 "부를 수 있는 한 줄"이 바로 이
// 파일).
//
//   node scripts/supervisor/reach-report.mjs --report
//
// 인자 없이 그냥 `node scripts/supervisor/reach-report.mjs`만 쳐도 똑같이
// 돈다(coder-task.md §1 요건1 "인자 없이도 돌아가는 형태를 우선하라" --
// `--report`는 의도를 분명히 하는 문서화용 플래그일 뿐, 있으나 없으나
// 동작은 같다).
//
// 하는 일 = watch.log(watch-run.mjs가 이미 쌓아 온 것) 전체를 읽어서 ->
// (a) 사람이 읽는 "아침 보고" 문서를 화면에 찍고 고정 경로 파일에도
// 쓰고 -> (b) "지금 열려 있는 이상"이 직전 실행 대비 새로 열렸으면(전이)
// 받는함에 통지 파일 1장을 쓴다. 판정 로직 자체(무엇이 "이상"인가)는
// reach-report-core.mjs/reach-notify-core.mjs의 순수 함수가 갖고 있고,
// 이 파일은 그 둘을 실제 파일시스템에 연결하는 wire일 뿐이다.
//
// ★새 감지 축 금지(coder-task.md §3): 이 파일은 orch-stall-detect.mjs가
// 이미 만들어 watch-run.mjs가 이미 로그로 남긴 4축 결과만 읽는다 -- 새로
// 뭔가를 판정하지 않는다.
//
// 위생(coder-task.md §5): 모든 출력 경로가 인자로 주입 가능하다 --
// 아래 CLI 기본값(D:/문서관리/하네스-관제실/..., D:/문서관리/통역/받는함)은
// **이 파일을 직접 실행할 때만** 적용되고, runReachOnce 자체는 아무
// 기본 경로도 갖지 않는다(호출자가 전부 명시해야 함 -- 시험은 항상
// mkdtemp 경로를 명시적으로 넘긴다).
//
// Node 20 호환 -- ESM 표준 API만 사용.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  parseWatchLog,
  computeOpenAnomalies,
  computeOpenMeasurementFailures,
  formatMorningReport,
} from "./reach-report-core.mjs";
import {
  decideNotifications,
  buildNoticeText,
  buildNoticeFileName,
} from "./reach-notify-core.mjs";
// HYK-255-partial-counter-1 -- 부분 계수 보고(PM 판정 3 규격)를 아침
// 보고에 편입한다(1-B «아침 보고 도달» 축). 판정·렌더링은 전부
// partial-count-core.mjs의 순수 함수 몫이고, 이 wire는 파일 하나를
// 읽어 넘길 뿐이다.
import {
  formatPartialCountSection,
  parseExternalEvidenceCandidateLine,
  parseQualificationLine,
} from "./partial-count-core.mjs";

// HYK-389 조각 2 저장소 몫 -- «ORCH 좌석 직접 쓰기» 한 줄(shim 원장 · OBSERVER).
// 판정·렌더링은 shim-ledger-report-core.mjs 의 순수 함수 몫이고, 이 wire 는 원장
// 파일 하나를 읽어 넘길 뿐이다.
import {
  formatShimLedgerLine,
  summarizeShimLedger,
} from "./shim-ledger-report-core.mjs";

export const DEFAULT_WATCH_LOG_PATH =
  "D:/문서관리/하네스-관제실/watch/watch.log";
// CLI 직접 실행의 기본값(runReachOnce 자체는 기본 경로를 갖지 않는다 -- 아래
// shimLedgerPath 기본 파생 참조).
export const DEFAULT_SHIM_LEDGER_PATH =
  "D:/문서관리/하네스-관제실/orca-direct-ledger.jsonl";
export const DEFAULT_REPORT_OUT_PATH =
  "D:/문서관리/하네스-관제실/watch/morning-report.md";
export const DEFAULT_STATE_PATH =
  "D:/문서관리/하네스-관제실/watch/reach-notify-state.json";
export const DEFAULT_NOTIFY_DIR = "D:/문서관리/통역/받는함";

function readStateFile(readFn, statePath) {
  try {
    const text = readFn(statePath, "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 상태 파일이 아직 없거나(첫 실행) 읽기/파싱이 실패하면 "직전 상태
    // 없음"으로 접는다 -- 그 결과 이번 실행에서 열려 있는 이상은 전부
    // "새 전이"로 통지된다(과소통지보다 과대통지가 안전, coder-task.md
    // §5-C 계열 원칙과 동일 -- 놓치는 것보다 한 번 더 알리는 쪽을 택한다).
    return {};
  }
}

// HYK-255 -- 부분 계수 보고 파일을 읽어 아침 보고용 절로 바꾼다. 파일이
// 없으면(첫 운영 전·아직 안 만든 경우) null을 넘겨 «UNKNOWN — 파일 없음»
// 절이 나온다 -- 조용한 생략 경로는 없다.
function readPartialCountText({ readFn, partialCountPath }) {
  try {
    return readFn(partialCountPath, "utf8");
  } catch {
    // 파일 없음/읽기 실패 -> null (절이 UNKNOWN 을 명시한다).
    return null;
  }
}

function readPartialCountSection({ fileText, partialCountPath, now }) {
  return formatPartialCountSection({
    fileText,
    sourceLabel: partialCountPath,
    nowMs: now,
  });
}

// HYK-255-ln-github-anchor-1 (판정 2026-11-12 19:1x 1ⓑ) -- 부분 계수 보고서
// ㄴ 절 «외부 독립 증거 후보: 확인 N» 의 N 이 «늘 때만» 받는함 통지 1장(기존
// 통지 길 -- 같은 notifyDir · 같은 파일 이름 규칙 · 같은 상태 파일). 이 wire
// 는 수집기를 다시 돌리지 않고 이미 쓰인 보고서 «텍스트»의 그 줄만 읽는다.
// 상태 파일의 아래 키 하나가 직전 N 을 기억한다 -- 이상 전이 키(axisKey)와
// 섞이지 않는 이름이다.
//
// 줄을 못 읽은 회차(수집 실패 · 줄 없음 · 보고서 없음)는 N 변화가 아니다:
// 통지 0장, 직전 N 기억 유지(실패를 사이에 두고 돌아온 같은 N 이 변화로
// 오인되지 않게). 처음 관측은 N=0 이면 기준선(통지 0장), N>0 이면 변화로
// 통지한다(과소통지보다 과대통지 -- 위 readStateFile 과 같은 원칙).
// HYK-255-ln-update-branch-1 -- 이 N(확인)이 이제 ㄴ 분자(외부 독립 증거로 확인된 사건)와
// 같은 값이다(Update branch 클릭 = ㄴ · 한용 확정 2026-11-13). 통지 조건 · 파일 장 수는 무변.
export const EXTERNAL_EVIDENCE_STATE_KEY = "__externalEvidenceCandidates";

//
// HYK-255-g7-key-stale-1 (커밋 3) -- 통지는 확인 «증가» 에만: 처음 관측 N>0 · 직전
// 기준선보다 큰 N. 같은 값 · 감소 · 미조회로 낮게 나온 회차는 통지 0장이다. 상태 키는
// {confirmed, atMs} -- confirmed = 기준선, atMs = 그 값이 «이번 회차 REST 응답으로»
// 마지막 확인된 시각(부분 계수 보고서의 스테일 표시가 읽는다 · 표시 전용, 승인 권위
// 아님). 미조회가 낀 회차(미조회 > 0)에 N 이 기준선보다 낮으면 «미조회 흔들림» 이라
// 기준선 · 시각을 그대로 지킨다(1 -> 0 -> 1 에 매 회차 통지 0). 전부 조회했는데(미조회
// 0) 낮아졌으면 진짜 감소라 기준선을 낮춘다(통지 0 -- 낮아진 뒤 다시 오르면 증가).
function decideExternalEvidenceChange({ previousState, fileText, now }) {
  const prevEntry = previousState[EXTERNAL_EVIDENCE_STATE_KEY];
  const previous =
    prevEntry && Number.isInteger(prevEntry.confirmed)
      ? prevEntry.confirmed
      : null;
  const parsed = parseExternalEvidenceCandidateLine(fileText);
  if (parsed.state !== "count") {
    return { nextEntry: previous === null ? null : prevEntry, change: null };
  }
  const { confirmed, unchecked } = parsed;
  if (previous !== null && confirmed < previous && unchecked > 0) {
    return { nextEntry: prevEntry, change: null };
  }
  const increased = previous === null ? confirmed > 0 : confirmed > previous;
  return {
    nextEntry: confirmed > 0 ? { confirmed, atMs: now } : { confirmed },
    change: increased ? { previous, current: confirmed, unchecked } : null,
  };
}

// HYK-255-p2b-qual-1 (판정 2026-11-15 1804 ③) -- 보고서 «1-C 판정 자격» 줄이 «없음 -> 부분 있음» 으로 바뀐 «첫 회차» 에만 받는함 통지 1장(위와 같은 길 · 같은
// notifyDir · 같은 파일 이름 규칙 · 같은 상태 파일). 상태 키 하나가 직전 상태({state: "none"|"partial"})를 기억한다. 같은 상태가 이어지면 0장 · «부분 있음 -> 없음» 은
// 0장(아침 보고 줄이 알린다). 줄을 못 읽은 회차(줄 없음 · 보고서 없음 · 종류 설정 진단 줄이 있는 회차)는 상태 변화가 아니다 -- 통지 0장 · 직전 상태 기억 유지.
// 처음 관측이 «부분 있음» 이면 이전 = 없음(P2b 이전 보고서는 항상 «없음») 으로 보고 통지한다(과소통지보다 과대통지 -- 위 원칙과 같다).
export const QUALIFICATION_STATE_KEY = "__partialQualification";

function decideQualificationChange({ previousState, fileText }) {
  const prevEntry = previousState[QUALIFICATION_STATE_KEY];
  const previous =
    prevEntry?.state === "none" || prevEntry?.state === "partial"
      ? prevEntry.state
      : null;
  const parsed = parseQualificationLine(fileText);
  if (parsed.state !== "none" && parsed.state !== "partial") {
    return { nextEntry: previous === null ? null : prevEntry, change: null };
  }
  return {
    nextEntry: { state: parsed.state },
    change:
      parsed.state === "partial" && previous !== "partial"
        ? { previous, line: parsed.line }
        : null,
  };
}

// 부분 계수 보고서 «텍스트» 에서 읽는 두 변화(외부 독립 증거 N 증가 · 1-C 판정 자격 전이)를 판정하고 상태 키를 nextState 에 기록한다 -> {externalChange, qualificationChange}.
function decidePartialCountChanges({
  previousState,
  nextState,
  fileText,
  now,
}) {
  const external = decideExternalEvidenceChange({
    previousState,
    fileText,
    now,
  });
  if (external.nextEntry) {
    nextState[EXTERNAL_EVIDENCE_STATE_KEY] = external.nextEntry;
  }
  const qualification = decideQualificationChange({ previousState, fileText });
  if (qualification.nextEntry) {
    nextState[QUALIFICATION_STATE_KEY] = qualification.nextEntry;
  }
  return {
    externalChange: external.change,
    qualificationChange: qualification.change,
  };
}

function qualificationChangeSectionLines(change) {
  const before =
    change.previous === null ? "이전 기록 없음(없음으로 봄)" : "없음";
  return [
    "부분 계수 보고서 «1-C 판정 자격» 줄이 «없음 -> 부분 있음» 으로 처음 바뀌었습니다(같은 상태가 계속되면 다시 오지 않고 «부분 있음 -> 없음» 은 통지하지 않습니다 -- 아침 보고 줄이 알립니다):",
    "",
    `- ${change.line}`,
    `- 이전 상태: ${before}`,
    "- 이 줄은 «ㄴ=0» 판정이 아닙니다 · 1단계 «완료» 선언도 아닙니다(선언 = P6 · 한용). 못 세는 종류의 목록 · 처리는 설정 파일(partial-count-uncountable-kinds.json)이 정하고 «알려진» 종류 수 K 는 하한입니다.",
    "",
  ];
}

// 받는함 통지 1장 -- 새 이상 전이(toNotify) · 외부 독립 증거 후보 N 변화(externalChange) · «1-C 판정 자격» 전이(qualificationChange)는
// «같은 tick 에 겹쳐도 파일 1장»에 함께 싣는다. 모두 없으면 파일도 폴더도 만들지 않고 null.
function writeNoticeFile({
  toNotify,
  externalChange,
  qualificationChange,
  notifyDir,
  now,
  existsFn,
  mkdirFn,
  writeFn,
}) {
  if (toNotify.length === 0 && !externalChange && !qualificationChange) {
    return null;
  }
  if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
  const noticeText = composeNoticeText({
    toNotify,
    externalChange,
    qualificationChange,
    now,
  });
  const noticePath = path.join(notifyDir, buildNoticeFileName(now));
  writeFn(noticePath, noticeText, "utf8");
  return noticePath;
}

// N 변화 절의 줄들 -- 앞뒤 빈 줄은 composeNoticeText 가 맞춘다.
function externalEvidenceChangeSectionLines(change) {
  const before = change.previous === null ? "이전 기록 없음" : change.previous;
  return [
    "부분 계수 보고서 ㄴ 절 «외부 독립 증거 후보» 의 확인 건수가 늘었습니다(같은 값이 계속되거나 줄거나 미조회로 낮게 나온 회차에는 다시 오지 않습니다):",
    "",
    `- **외부 독립 증거 후보(GitHub 웹 Update branch 병합 커밋)** 확인 ${before} -> ${change.current} ` +
      `(미조회 ${change.unchecked} · ㄴ 분자에 반영됩니다 -- 한용 확정 2026-11-13: GitHub 웹 Update branch 클릭 = ㄴ 계획 밖 개입. 미조회는 분자에 넣지 않습니다)`,
    "",
  ];
}

// HYK-255-g-aux-render-1 커밋 3 (D1 검토 P2-4) -- 통지 본문 조립.
// 기존 buildNoticeText(이상 전이 · 측정 불능 절 + 마무리 줄 «이 파일이 정본입니다 …»)
// 는 건드리지 않고 그 결과에 N 변화 절을 «마무리 줄 앞에» 끼운다(마무리 줄 = 본문의
// 마지막 비어 있지 않은 줄). 이상 전이가 하나도 없고 N 변화만 있는 tick 이면 머리
// 문구를 «이상 전이 통지» 로 찍지 않는다(이상이 열린 것이 아니다). 통지 조건 · 파일
// 장 수는 그대로다.
const ANOMALY_NOTICE_HEADER_PHRASE = "이상 전이 통지";
const PARTIAL_COUNT_NOTICE_HEADER_PHRASE = "부분 계수 변화 통지";

function composeNoticeText({
  toNotify,
  externalChange,
  qualificationChange,
  now,
}) {
  const base = buildNoticeText({ toNotify, nowMs: now });
  if (!externalChange && !qualificationChange) return base;
  const lines = base.split("\n");
  let closingIdx = lines.length - 1;
  while (closingIdx > 0 && lines[closingIdx].trim() === "") closingIdx -= 1;
  if (toNotify.length === 0) {
    lines[0] = lines[0].replace(
      ANOMALY_NOTICE_HEADER_PHRASE,
      PARTIAL_COUNT_NOTICE_HEADER_PHRASE,
    );
  }
  lines.splice(
    closingIdx,
    0,
    ...(externalChange
      ? externalEvidenceChangeSectionLines(externalChange)
      : []),
    ...(qualificationChange
      ? qualificationChangeSectionLines(qualificationChange)
      : []),
  );
  return lines.join("\n");
}

// HYK-389 조각 2 -- shim 원장을 읽어 «ORCH 좌석 직접 쓰기» 요약으로 바꾼다. 원장을
// 못 읽으면(없음 · 읽기 실패) text=null 로 넘겨 «관측 불가» 줄이 나온다 -- 0 으로
// 접는 경로는 없다.
function readShimLedgerSummary({ readFn, shimLedgerPath, now }) {
  let text = null;
  let readError = null;
  try {
    text = readFn(shimLedgerPath, "utf8");
  } catch (err) {
    readError = err && err.code ? err.code : String(err && err.message);
  }
  return summarizeShimLedger({ text, readError, nowMs: now });
}

function shimLedgerSection({ summary, shimLedgerPath }) {
  return [
    "## ORCH 좌석 직접 쓰기(shim 원장 · OBSERVER)",
    formatShimLedgerLine(summary, { sourceLabel: shimLedgerPath }),
  ].join("\n");
}

// HYK-389 조각 2 -- shim 원장 위치. 기본값 = 보고 파일 디렉터리(watch/)의 «위»
// 디렉터리의 orca-direct-ledger.jsonl(운영 실경로에선 관제실 루트 = 상수
// DEFAULT_SHIM_LEDGER_PATH 와 같은 곳) -- watch-run.mjs 의 기존 호출을 바꾸지 않고도
// 실 아침 보고에 닿는 이유(partialCountPath 와 같은 파생 방식).
function defaultShimLedgerPath(reportOutPath) {
  return path.join(
    path.dirname(path.dirname(reportOutPath)),
    "orca-direct-ledger.jsonl",
  );
}

// 아침 보고 본문 조립: 기존 보고 + 부분 계수 절 + (HYK-389 조각 2) shim 원장 절.
function composeReportText({
  morningReport,
  partialCountSection,
  shimSection,
}) {
  return `${morningReport}\n${partialCountSection.join("\n")}\n\n${shimSection}\n`;
}

// runReachOnce(...) -- 한 번의 실행. 모든 I/O가 주입 가능(시험이 실제
// fs를 건드리지 않고 mkdtemp 경로만 명시적으로 쓰게 하기 위함,
// coder-task.md §5 비타협).
export function runReachOnce({
  watchLogPath,
  reportOutPath,
  statePath,
  notifyDir,
  // HYK-255 -- 부분 계수 보고 파일의 위치. 기본값 = morning-report.md
  // 옆의 partial-count-report.md(운영 실경로에선 관제실 watch/ 밑이 된다
  // -- watch-run.mjs의 기존 호출을 바꾸지 않고도 실 아침 보고에 닿는
  // 이유). 파일이 없으면 조용히 생략하지 않고 UNKNOWN을 명시한다.
  partialCountPath = path.join(
    path.dirname(reportOutPath),
    "partial-count-report.md",
  ),
  shimLedgerPath = defaultShimLedgerPath(reportOutPath),
  now = Date.now(),
  readFn = readFileSync,
  writeFn = writeFileSync,
  mkdirFn = mkdirSync,
  existsFn = existsSync,
}) {
  let watchLogText;
  try {
    watchLogText = readFn(watchLogPath, "utf8");
  } catch {
    watchLogText = "";
  }
  const { entries, skipped } = parseWatchLog(watchLogText);
  const partialCountText = readPartialCountText({ readFn, partialCountPath });
  const partialCountSection = readPartialCountSection({
    fileText: partialCountText,
    partialCountPath,
    now,
  });
  const shimLedger = readShimLedgerSummary({ readFn, shimLedgerPath, now });
  const reportText = composeReportText({
    morningReport: formatMorningReport({
      entries,
      nowMs: now,
      skipped,
      sourceLabel: watchLogPath,
    }),
    partialCountSection,
    shimSection: shimLedgerSection({ summary: shimLedger, shimLedgerPath }),
  });

  const reportDir = path.dirname(reportOutPath);
  if (!existsFn(reportDir)) mkdirFn(reportDir, { recursive: true });
  writeFn(reportOutPath, reportText, "utf8");

  const openAnomalies = computeOpenAnomalies(entries, now);
  // HYK-265-observe-split-1 (coder-task.md §5 1-B 요건3·§4 완료조건1): 통지
  // (받는함 reach-notify-*.md)도 아침 보고와 같은 원칙을 따른다 -- «측정
  // 불가»(badStatuses)를 조용히 통지에서 빠뜨리지 않는다(이 축도 여전히
  // 사람에게 "관측이 실패하고 있다"는 알려야 한다, §2 실측 배경). 두
  // 배열은 axisKey가 절대 겹치지 않으므로(한 axis, 한 entry가 동시에
  // badVerdicts와 badStatuses를 만족할 수 없다 -- computeOpenByPredicate
  // 주석 참조) 합쳐도 decideNotifications의 per-axis sinceMs 추적이
  // 깨지지 않는다. 각 원소는 kind로 자기 출처를 밝히므로 buildNoticeText
  // 가 다시 두 절로 가른다.
  const openMeasurementFailures = computeOpenMeasurementFailures(entries, now);
  const previousState = readStateFile(readFn, statePath);
  const { nextState, toNotify } = decideNotifications({
    previousState,
    openAnomalies: [...openAnomalies, ...openMeasurementFailures],
  });

  const partialChanges = decidePartialCountChanges({
    previousState,
    nextState,
    fileText: partialCountText,
    now,
  });

  const noticePath = writeNoticeFile({
    toNotify,
    ...partialChanges,
    notifyDir,
    now,
    existsFn,
    mkdirFn,
    writeFn,
  });

  const stateDir = path.dirname(statePath);
  if (!existsFn(stateDir)) mkdirFn(stateDir, { recursive: true });
  writeFn(statePath, JSON.stringify(nextState), "utf8");

  return {
    reportText,
    reportOutPath,
    openAnomalies,
    openMeasurementFailures,
    toNotify,
    noticePath,
    skipped,
    shimLedger,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/reach-report.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let watchLogPath = DEFAULT_WATCH_LOG_PATH;
  let reportOutPath = DEFAULT_REPORT_OUT_PATH;
  let statePath = DEFAULT_STATE_PATH;
  let notifyDir = DEFAULT_NOTIFY_DIR;
  let partialCountPath; // undefined면 runReachOnce 기본값(보고 파일 옆) 사용.
  let shimLedgerPath = DEFAULT_SHIM_LEDGER_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shim-ledger") shimLedgerPath = argv[++i];
    else if (argv[i] === "--watch-log") watchLogPath = argv[++i];
    else if (argv[i] === "--report-out") reportOutPath = argv[++i];
    else if (argv[i] === "--state-path") statePath = argv[++i];
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
    else if (argv[i] === "--partial-count") partialCountPath = argv[++i];
    // `--report`는 의도 문서화용(요건1 문구 그대로) -- 있어도 없어도
    // 동작은 같다(인자 없이도 돌아가야 한다, coder-task.md §1 요건1).
  }
  try {
    const result = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      partialCountPath,
      shimLedgerPath,
    });
    console.log(result.reportText);
    process.exit(0);
  } catch (err) {
    console.error(
      `reach-report: FAILED -- ${err && err.message ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
