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
import { formatPartialCountSection } from "./partial-count-core.mjs";

export const DEFAULT_WATCH_LOG_PATH =
  "D:/문서관리/하네스-관제실/watch/watch.log";
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
function readPartialCountSection({ readFn, partialCountPath, now }) {
  let fileText = null;
  try {
    fileText = readFn(partialCountPath, "utf8");
  } catch {
    // 파일 없음/읽기 실패 -> fileText는 null 그대로.
  }
  return formatPartialCountSection({
    fileText,
    sourceLabel: partialCountPath,
    nowMs: now,
  });
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
  const partialCountSection = readPartialCountSection({
    readFn,
    partialCountPath,
    now,
  });
  const reportText =
    formatMorningReport({
      entries,
      nowMs: now,
      skipped,
      sourceLabel: watchLogPath,
    }) +
    "\n" +
    partialCountSection.join("\n") +
    "\n";

  const reportDir = path.dirname(reportOutPath);
  if (!existsFn(reportDir)) mkdirFn(reportDir, { recursive: true });
  writeFn(reportOutPath, reportText, "utf8");

  const openAnomalies = computeOpenAnomalies(entries, now);
  const previousState = readStateFile(readFn, statePath);
  const { nextState, toNotify } = decideNotifications({
    previousState,
    openAnomalies,
  });

  let noticePath = null;
  if (toNotify.length > 0) {
    const noticeDir = notifyDir;
    if (!existsFn(noticeDir)) mkdirFn(noticeDir, { recursive: true });
    const noticeText = buildNoticeText({ toNotify, nowMs: now });
    noticePath = path.join(noticeDir, buildNoticeFileName(now));
    writeFn(noticePath, noticeText, "utf8");
  }

  const stateDir = path.dirname(statePath);
  if (!existsFn(stateDir)) mkdirFn(stateDir, { recursive: true });
  writeFn(statePath, JSON.stringify(nextState), "utf8");

  return {
    reportText,
    reportOutPath,
    openAnomalies,
    toNotify,
    noticePath,
    skipped,
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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--watch-log") watchLogPath = argv[++i];
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
