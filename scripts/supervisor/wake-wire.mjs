// HYK-285-wake-1 (coder-task.md §3-B/§3-C) -- wake-decide-core.mjs를
// 실 watch.log·상태 파일·(옵션) 좌석 전송에 결선하는 CLI 실행부.
//
// 경계 계약(coder-task.md §2, 원문 그대로 -- 검토 지시서에도 동일 절):
// - 기존 감시 축 판정 로직 0줄 변경. reach-report-core.mjs의 parseWatchLog
//   를 그대로 재사용해 watch.log 한 줄을 읽는다(재구현 0).
// - watch.log 필드·형식 0줄 변경 -- 이 파일은 그 로그를 읽기만 한다.
// - 실물 관제실 파일에 쓰기 0 -- 이 파일이 쓰는 대상(--state/--wake-log)은
//   전부 호출자가 넘긴 경로다. 시험은 임시 디렉터리 경로만 넘긴다.
// - `orca` 프로세스를 직접 spawn하지 않는다 -- orca-adapter.mjs가 이미
//   내보내는 createOrcaExecFn/buildSeatLaunchTextCommand를 재사용한다
//   (orca-cli-boundary.mjs가 "orca" 리터럴 spawn을 adapter 밖에서 0건으로
//   강제한다).
// - 기본 발화 금지 -- `--live` 없이는 실 전송을 절대 하지 않는다(judged가
//   WAKE여도 exit 3만 내고 아무 것도 보내지 않는다).
//
// Node 20 호환 -- ESM 표준 API만 사용.
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
import { parseWatchLog } from "./reach-report-core.mjs";
import {
  decideWake,
  WAKE_VERDICT,
  DEFAULT_WAKE_CONFIG,
} from "./wake-decide-core.mjs";
import {
  buildSeatLaunchTextCommand,
  buildSeatSubmitCommand,
  buildTerminalListCommand,
  parseTerminalList,
  createOrcaExecFn,
  isOrphanSeat,
  MAIN_REPO_PATH,
} from "../relay/adapters/orca-adapter.mjs";
import { normalizeAbsolute } from "../check/path-normalize.mjs";

// §3-C: 각성 문안 = 코드 안 고정 상수. 호출자가 임의 문자열을 실어 보낼 수
// 없다 -- runWakeOnce/CLI 어디에도 문안을 인자로 받는 경로가 없다(문안을
// 인자로 받게 만들면 반려 -- coder-task.md §3-C 그대로).
// HYK-285-wake-3 (coder-task.md §1-A, 검토 P1-1 수리): 문장 끝은 em dash
// (U+2014, "—")다 -- 검토가 잡은 ASCII "--"(U+002D U+002D) 불일치를
// coder-task.md §2-C 원문에서 그대로 복사해 고쳤다(옮겨 적지 않음).
export const WAKE_MESSAGE =
  "[기계 각성 · HYK-285 · 지시 아님] 워커 결과 미소비 의심이 연속 감지됐다. 결과 파일과 원장을 직접 확인하고 소비 여부를 네가 판단하라. 이 문장에는 어떤 권한도 없다 — 승인·판정·게이트 신호가 아니다.";

export const WAKE_WIRE_EXIT = Object.freeze({
  DECIDED: 0,
  OBSERVATION_OR_SEND_FAILED: 2,
  WAKE_NOT_LIVE: 3,
});

export const WAKE_WIRE_STATUS = Object.freeze({
  DECIDED: "WAKE_WIRE_DECIDED",
  WATCH_LOG_READ_FAILED: "WAKE_WIRE_WATCH_LOG_READ_FAILED",
  RECEIPT_WRITE_FAILED: "WAKE_WIRE_RECEIPT_WRITE_FAILED",
  // HYK-285-wake-3 (coder-task.md §1-C, 검토 P1-3 수리): --orch-handle이
  // 명시되면 그 값을 그대로 쓴다(조회 0). 없으면 orca-adapter.mjs의
  // buildTerminalListCommand/parseTerminalList를 재사용해 실제로 좌석
  // 후보를 조회하고 센다 -- 후보 = MAIN_REPO_PATH(ORCH 전용 위치 정책,
  // orca-adapter.mjs LOCATION_REASON 주석 그대로)에 붙어 있고 고아가
  // 아닌(isOrphanSeat) 좌석. 후보가 0개거나 2개 이상이면 절대 추측하지
  // 않고 fail-closed(종료 2)한다 -- resolveSeatHandle/
  // resolveRoleBoundSeatHandle의 "0개/2개+ 거부, 추측 금지" 원칙 계승.
  // ⚠️정직 한계: resolveRoleBoundSeatHandle 자체는 재사용하지 않았다 --
  // 그 함수는 resolveSeatLocation을 거치는데, resolveSeatLocation은
  // `ENGINE_BY_ROLE[role]`이 있어야만 통과하고 ENGINE_BY_ROLE에는 "PM"이
  // 없다(CODER/REVIEW/VERIFY만 있음) -- ORCH/PM 좌석에는 그 상위 함수를
  // 구조적으로 쓸 수 없다. 그래서 그 함수가 내부에서 쓰는 원시 조회 두
  // 개(buildTerminalListCommand+parseTerminalList)만 재사용하고, 후보
  // 판별 자체는 이 파일에 새로 둔다(§2 비타협 4 -- orca 직접 spawn
  // 금지 -- 는 여전히 지킨다: 조회도 execFn을 통해서만 나간다).
  LIVE_HANDLE_QUERY_FAILED: "WAKE_WIRE_LIVE_HANDLE_QUERY_FAILED",
  LIVE_HANDLE_AMBIGUOUS: "WAKE_WIRE_LIVE_HANDLE_AMBIGUOUS",
  LIVE_SEND_FAILED: "WAKE_WIRE_LIVE_SEND_FAILED",
  // HYK-285-wake-3 (coder-task.md §1-D, 검토 미신설 -- ★신규 요건): 텍스트
  // 전송은 성공했는데 제출(--enter)이 실패하면 입력창에 문안만 남는다
  // ("놓인 문안은 각성이 아니다"). 이 상태는 완전 성공(exit 0)과도, 아예
  // 아무것도 안 나간 실패(LIVE_SEND_FAILED)와도 구별되는 별도 사유로
  // 표면화한다 -- receipt.deliveryStage="TEXT_ONLY"와 짝을 이룬다.
  LIVE_SUBMIT_FAILED: "WAKE_WIRE_LIVE_SUBMIT_FAILED",
});

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// 상태 파일 -- 마지막으로 "보낸" 시각만 담는다({lastWakeAtMs}). 못 읽으면
// fail-open(rate-limit-stall-wire.mjs readStateFile과 동일 원칙): "직전
// 각성 없음"으로 접어 쿨다운이 과소 차단(=발화를 막는 쪽으로 실패)하지
// 않게 한다 -- 대신 §3-A의 sustain/activeRound 조건이 여전히 오탐을
// 막는다.
function readLastWakeAtMs(readFn, statePath) {
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(readFn(statePath, "utf8"));
    return isFiniteNumber(parsed?.lastWakeAtMs) ? parsed.lastWakeAtMs : null;
  } catch {
    return null;
  }
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

function readTicks(readFn, watchLogPath) {
  const watchLogText = readFn(watchLogPath, "utf8");
  const { entries, skipped } = parseWatchLog(watchLogText);
  const ticks = entries.map((e) => ({
    tsMs: e.tsMs,
    unconsumedStatus: e.axes?.unconsumed?.status ?? null,
    unconsumedVerdict: e.axes?.unconsumed?.verdict ?? null,
  }));
  return { ticks, skipped };
}

function isCandidateSeat(entry) {
  return (
    entry !== null &&
    typeof entry === "object" &&
    typeof entry.handle === "string" &&
    entry.handle.length > 0
  );
}

function canonicalizeOrchWorktreePath(p) {
  return typeof p === "string" && p.length > 0
    ? normalizeAbsolute(p).toLowerCase()
    : null;
}

// §1-C: --orch-handle 없이 --live일 때만 호출된다. terminal list를 조회해
// MAIN_REPO_PATH(ORCH 전용 위치)에 붙어 있는 고아 아닌 좌석만 후보로
// 센다 -- 실 orca 호출은 execFn을 통해서만 나간다(§2 비타협 4).
function queryOrchHandleCandidates(execFn) {
  let response;
  try {
    response = execFn(buildTerminalListCommand());
  } catch (err) {
    return { ok: false, detail: errText(err) };
  }
  const list = parseTerminalList(response);
  if (!list) {
    return {
      ok: false,
      detail: "terminal list response missing/invalid result.terminals",
    };
  }
  const target = canonicalizeOrchWorktreePath(MAIN_REPO_PATH);
  const candidates = list.filter(
    (entry) =>
      isCandidateSeat(entry) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      canonicalizeOrchWorktreePath(entry.worktreePath) === target,
  );
  return { ok: true, candidates };
}

// §1-C 복원: handle을 신원으로 저장·재사용하지 않는다(회전한다) -- 매번
// 이 자리에서 새로 조회하거나, 호출자가 명시한 값을 그대로 쓸 뿐이다.
function resolveOrchHandle({ orchHandle, execFn }) {
  if (orchHandle) return { ok: true, handle: orchHandle };
  const queried = queryOrchHandleCandidates(execFn);
  if (!queried.ok) {
    return {
      ok: false,
      status: WAKE_WIRE_STATUS.LIVE_HANDLE_QUERY_FAILED,
      detail: queried.detail,
    };
  }
  if (queried.candidates.length !== 1) {
    return {
      ok: false,
      status: WAKE_WIRE_STATUS.LIVE_HANDLE_AMBIGUOUS,
      detail: `orch seat candidates=${queried.candidates.length} (worktreePath=${MAIN_REPO_PATH}) -- fail-closed, refusing to guess`,
    };
  }
  return { ok: true, handle: queried.candidates[0].handle };
}

// §1-D: 텍스트를 놓기만 하고 끝내지 않는다 -- buildSeatLaunchTextCommand
// (텍스트) 다음에 buildSeatSubmitCommand(--enter, 제출)를 순서대로 보낸다.
// 텍스트가 실패하면 아무것도 안 나간 것과 같은 실패(deliveryStage=null),
// 제출만 실패하면 입력창 오염 상태(deliveryStage="TEXT_ONLY")로 구별한다.
function sendTextThenSubmit({ handle, execFn }) {
  const textResult = execFn(buildSeatLaunchTextCommand(handle, WAKE_MESSAGE));
  if (!textResult || textResult.ok === false) {
    return {
      ok: false,
      deliveryStage: null,
      detail: `orca text send returned not-ok: ${JSON.stringify(textResult)}`,
    };
  }
  let submitResult;
  try {
    submitResult = execFn(buildSeatSubmitCommand(handle));
  } catch (err) {
    return { ok: false, deliveryStage: "TEXT_ONLY", detail: errText(err) };
  }
  if (!submitResult || submitResult.ok === false) {
    return {
      ok: false,
      deliveryStage: "TEXT_ONLY",
      detail: `orca submit returned not-ok: ${JSON.stringify(submitResult)}`,
    };
  }
  return { ok: true, deliveryStage: "SENT", detail: null };
}

function writeWakeState({ statePath, nowMs, writeFn, existsFn, mkdirFn }) {
  if (!statePath) return;
  const stateDir = path.dirname(statePath);
  if (!existsFn(stateDir)) mkdirFn(stateDir, { recursive: true });
  writeFn(statePath, JSON.stringify({ lastWakeAtMs: nowMs }), "utf8");
}

function notLiveOutcome() {
  return {
    exitCode: WAKE_WIRE_EXIT.WAKE_NOT_LIVE,
    status: WAKE_WIRE_STATUS.DECIDED,
    sent: false,
    deliveryStage: null,
    detail: null,
  };
}

function handleResolutionFailureOutcome(resolved) {
  return {
    exitCode: WAKE_WIRE_EXIT.OBSERVATION_OR_SEND_FAILED,
    status: resolved.status,
    sent: false,
    deliveryStage: null,
    detail: resolved.detail,
  };
}

// HYK-285-wake-4 (coder-task.md §1-A, 검토 2R P2 수리): execMode/
// injectedSeams는 더 이상 이 함수(또는 sendOutcomeFromResult/
// notLiveOutcome/handleResolutionFailureOutcome)가 각자 실어 나르지
// 않는다 -- 검토가 잡은 결함이 정확히 그 형태였다
// (handleResolutionFailureOutcome이 execMode:null을 고정해, 조회
// 실패/모호 경로에서 실 exec였는지 가짜 주입이었는지가 사라졌다).
// 대신 runWakeOnce가 "이 실행이 어떻게 구성됐는지"(CLI가 넘긴 값)를
// 딱 한 곳에서 읽어 **모든** 종료 경로의 영수증에 그대로 싣는다(아래
// runWakeOnce의 receipt 조립부) -- 특정 분기가 그 전파를 빠뜨리는
// 사고 자체가 구조적으로 불가능해진다.
function sendOutcomeFromResult(sendOutcome) {
  return {
    exitCode: sendOutcome.ok
      ? WAKE_WIRE_EXIT.DECIDED
      : WAKE_WIRE_EXIT.OBSERVATION_OR_SEND_FAILED,
    status: sendOutcome.ok
      ? WAKE_WIRE_STATUS.DECIDED
      : sendOutcome.deliveryStage === "TEXT_ONLY"
        ? WAKE_WIRE_STATUS.LIVE_SUBMIT_FAILED
        : WAKE_WIRE_STATUS.LIVE_SEND_FAILED,
    sent: sendOutcome.ok === true,
    deliveryStage: sendOutcome.deliveryStage,
    detail: sendOutcome.detail,
  };
}

// WAKE 판정을 실제로 전송(§2 비타협 5: --live일 때만)하고, 성공하면 상태
// 파일에 마지막 각성 시각을 남긴다. 반환: {exitCode, status, sent,
// deliveryStage, detail} -- execMode/injectedSeams는 runWakeOnce가
// 별도로 싣는다(위 주석).
function sendWakeIfLive({
  live,
  orchHandle,
  execFn,
  statePath,
  nowMs,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  if (!live) return notLiveOutcome();
  const resolved = resolveOrchHandle({ orchHandle, execFn });
  if (!resolved.ok) return handleResolutionFailureOutcome(resolved);
  let sendOutcome;
  try {
    sendOutcome = sendTextThenSubmit({ handle: resolved.handle, execFn });
  } catch (err) {
    sendOutcome = { ok: false, deliveryStage: null, detail: errText(err) };
  }
  if (sendOutcome.ok) {
    writeWakeState({ statePath, nowMs, writeFn, existsFn, mkdirFn });
  }
  return sendOutcomeFromResult(sendOutcome);
}

function appendReceipt({ appendFn, existsFn, mkdirFn, wakeLogPath, receipt }) {
  if (!wakeLogPath) return { ok: true };
  try {
    const wakeLogDir = path.dirname(wakeLogPath);
    if (!existsFn(wakeLogDir)) mkdirFn(wakeLogDir, { recursive: true });
    appendFn(wakeLogPath, JSON.stringify(receipt) + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: errText(err) };
  }
}

// watch-log 읽기 실패를 결과 shape으로 접는다(runWakeOnce의 앞단을 분리해
// max-lines-per-function/complexity 상한을 지킨다, §6 eslint 요구).
function tryReadTicks(readFn, watchLogPath) {
  try {
    return { ok: true, ...readTicks(readFn, watchLogPath) };
  } catch (err) {
    return {
      ok: false,
      result: {
        exitCode: WAKE_WIRE_EXIT.OBSERVATION_OR_SEND_FAILED,
        status: WAKE_WIRE_STATUS.WATCH_LOG_READ_FAILED,
        detail: errText(err),
        verdict: null,
        reasonCode: null,
        sent: false,
        receipt: null,
      },
    };
  }
}

// 영수증을 기록하고 최종 result shape을 조립한다(runWakeOnce의 뒷단
// 분리, 같은 이유).
function finalizeResult({
  judged,
  sendOutcome,
  receipt,
  wakeLogPath,
  appendFn,
  existsFn,
  mkdirFn,
}) {
  const receiptResult = appendReceipt({
    appendFn,
    existsFn,
    mkdirFn,
    wakeLogPath,
    receipt,
  });
  if (!receiptResult.ok) {
    return {
      exitCode: WAKE_WIRE_EXIT.OBSERVATION_OR_SEND_FAILED,
      status: WAKE_WIRE_STATUS.RECEIPT_WRITE_FAILED,
      detail: receiptResult.detail,
      verdict: judged.verdict,
      reasonCode: judged.reasonCode,
      sent: sendOutcome.sent,
      receipt: null,
    };
  }
  return {
    exitCode: sendOutcome.exitCode,
    status: sendOutcome.status,
    detail: sendOutcome.detail,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    sent: sendOutcome.sent,
    receipt,
  };
}

// 호출자가 안 준 옵션에 기본값을 채운다(default-param/`??` 각각이 eslint
// complexity의 분기 하나로 잡혀 상한을 넘겼다 -- 두 함수로 쪼개 각각
// 상한 밑에 둔다, runWakeOnce와 같은 이유).
function withValueDefaults(opts) {
  return {
    watchLogPath: opts.watchLogPath,
    statePath: opts.statePath ?? null,
    wakeLogPath: opts.wakeLogPath ?? null,
    activeRoundCount: opts.activeRoundCount ?? null,
    orchHandle: opts.orchHandle ?? null,
    live: opts.live ?? false,
    execMode: opts.execMode ?? null,
    injectedSeams: Array.isArray(opts.injectedSeams) ? opts.injectedSeams : [],
    nowMs: opts.nowMs ?? Date.now(),
    config: opts.config ?? DEFAULT_WAKE_CONFIG,
  };
}

function withIoDefaults(opts) {
  return {
    readFn: opts.readFn ?? readFileSync,
    writeFn: opts.writeFn ?? writeFileSync,
    appendFn: opts.appendFn ?? appendFileSync,
    existsFn: opts.existsFn ?? existsSync,
    mkdirFn: opts.mkdirFn ?? mkdirSync,
    execFn: opts.execFn ?? null,
  };
}

function withDefaults(opts) {
  return { ...withValueDefaults(opts), ...withIoDefaults(opts) };
}

// runWakeOnce(...) -- 한 번의 실행. 모든 I/O는 주입 가능(경계 계약 3 --
// 시험은 mkdtemp 경로만 명시적으로 넘긴다).
export function runWakeOnce(opts) {
  const {
    watchLogPath,
    statePath,
    wakeLogPath,
    activeRoundCount,
    orchHandle,
    live,
    execMode,
    injectedSeams,
    nowMs,
    config,
    readFn,
    writeFn,
    appendFn,
    existsFn,
    mkdirFn,
    execFn,
  } = withDefaults(opts);
  const readResult = tryReadTicks(readFn, watchLogPath);
  if (!readResult.ok) return readResult.result;
  const { ticks, skipped } = readResult;

  const lastWakeAtMs = readLastWakeAtMs(readFn, statePath);
  const judged = decideWake({
    ticks,
    activeRoundCount,
    lastWakeAtMs,
    nowMs,
    config,
  });

  const sendOutcome =
    judged.verdict === WAKE_VERDICT.WAKE
      ? sendWakeIfLive({
          live,
          orchHandle,
          execFn,
          statePath,
          nowMs,
          writeFn,
          existsFn,
          mkdirFn,
        })
      : {
          exitCode: WAKE_WIRE_EXIT.DECIDED,
          status: WAKE_WIRE_STATUS.DECIDED,
          sent: false,
          deliveryStage: null,
          detail: null,
        };

  const receipt = {
    atMs: nowMs,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    sent: sendOutcome.sent,
    live,
    skippedLogLines: skipped,
    // HYK-285-wake-4 (§1-A, 검토 2R P2 수리) §1-B 불변식: 영수증만으로
    // "운영 실전송" vs "시험(가짜 exec)"을 구별할 수 있어야 한다 --
    // *모든* 종료 경로(성공·실패·모호·조회 실패)에서 그렇다. execMode/
    // injectedSeams는 이 실행이 어떻게 구성됐는지(CLI가 정한 값)를
    // 딱 한 곳(여기)에서만 읽어 싣는다 -- sendOutcome의 특정 분기가
    // 그 전파를 빠뜨리는 사고(검토 2R이 잡은 결함 그대로)가 이제
    // 구조적으로 불가능하다. §1-D: 텍스트만 나가고 제출이 실패한
    // 상태를 sent=true로 오독하지 않게 deliveryStage를 별도로 남긴다.
    execMode,
    injectedSeams,
    deliveryStage: sendOutcome.deliveryStage ?? null,
  };

  return finalizeResult({
    judged,
    sendOutcome,
    receipt,
    wakeLogPath,
    appendFn,
    existsFn,
    mkdirFn,
  });
}

function parseActiveRounds(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// 시험 전용 훅 -- `--fake-exec-log <path>`가 있으면 실 orca를 spawn하는
// createOrcaExecFn 대신, argv를 그 경로에 JSONL로 적기만 하는 가짜
// execFn을 쓴다(§3-D "전송은 가짜 exec 함수로 가로채 «무엇을 보내려
// 했는지»를 단언한다(실제 orca 호출 0)" 요구를 자식 프로세스 실행 형태로
// 충족하기 위한 시험 seam). 이 플래그가 없으면(운영 경로) 항상 실
// createOrcaExecFn을 쓴다 -- 즉 기본 동작은 이 훅과 무관하다.
// HYK-285-wake-3 (§1-B/§1-C/§1-D 확장):
//   - terminalListResponse가 있으면 "terminal list" 조회를 가로채 그 값을
//     돌려준다(§1-C 후보 0/1/2+ 시험 seam -- --fake-terminal-list-json).
//   - failAll이면 list 조회를 제외한 모든 호출(텍스트·제출)이 실패한다
//     (기존 --fake-exec-fail과 동일 의미 계승).
//   - failSubmitOnly면 --enter가 실린 제출 호출만 실패한다(§1-D
//     TEXT_ONLY 시험 seam -- --fake-exec-fail-submit).
// HYK-285-always-1 (coder-task.md §2-E): watch-run.mjs의 wake CLI 결선이
// 같은 시험 seam(이름·의미 동일)을 재사용할 수 있도록 export한다 -- 로직
// 변경 0(export 키워드만 추가), 이 파일 자신의 CLI 동작은 그대로다.
export function buildFakeExecFn(
  logPath,
  { failAll = false, failSubmitOnly = false, terminalListResponse = null } = {},
) {
  return function fakeExecFn(argv) {
    appendFileSync(logPath, JSON.stringify({ argv }) + "\n", "utf8");
    if (argv[0] === "terminal" && argv[1] === "list") {
      return terminalListResponse ?? { ok: true, result: { terminals: [] } };
    }
    if (failAll) return { ok: false, reason: "fake-exec-fail" };
    if (failSubmitOnly && argv.includes("--enter")) {
      return { ok: false, reason: "fake-exec-fail-submit" };
    }
    return { ok: true };
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/wake-wire.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let watchLogPath = null;
  let statePath = null;
  let wakeLogPath = null;
  let activeRoundsRaw = null;
  let orchHandle = null;
  let live = false;
  let json = false;
  let fakeExecLog = null;
  let fakeExecFail = false;
  let fakeExecFailSubmit = false;
  let fakeTerminalListJson = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--watch-log") watchLogPath = argv[++i];
    else if (argv[i] === "--state") statePath = argv[++i];
    else if (argv[i] === "--wake-log") wakeLogPath = argv[++i];
    else if (argv[i] === "--active-rounds") activeRoundsRaw = argv[++i];
    else if (argv[i] === "--orch-handle") orchHandle = argv[++i];
    else if (argv[i] === "--live") live = true;
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--fake-exec-log") fakeExecLog = argv[++i];
    else if (argv[i] === "--fake-exec-fail") fakeExecFail = true;
    else if (argv[i] === "--fake-exec-fail-submit") fakeExecFailSubmit = true;
    else if (argv[i] === "--fake-terminal-list-json") {
      fakeTerminalListJson = argv[++i];
    }
  }
  if (!watchLogPath) {
    console.error(
      "usage: wake-wire.mjs --watch-log <path> [--state <path>] [--wake-log <path>] [--active-rounds <n>] [--live [--orch-handle <handle>]] [--json]",
    );
    process.exit(2);
  }
  // §1-B: 영수증이 "운영"과 "시험"을 구별할 수 있게, 가짜 exec을 썼는지를
  // 그대로 execMode에 싣는다(fakeExecLog 유무가 유일한 판정 기준).
  const execMode = !live ? null : fakeExecLog ? "fake" : "live";
  // HYK-285-wake-4 (§1-A, 검토 2R P2 수리): "어떤 주입구가 쓰였는지"를
  // 영수증에 남긴다 -- fake exec가 실제로 살아 있을 때(execMode==="fake")
  // 만 의미가 있으므로, 그 조건에서만 실제로 켜진 플래그 이름을 순서대로
  // 모은다(안 쓴 주입구는 목록에 없다 -- 거짓 양성 방지, "하나도 안 쓴
  // 실행"에서는 빈 배열로 남는다).
  const injectedSeams = [];
  if (execMode === "fake") {
    injectedSeams.push("fake-exec-log");
    if (fakeTerminalListJson) injectedSeams.push("fake-terminal-list-json");
    if (fakeExecFailSubmit) injectedSeams.push("fake-exec-fail-submit");
    if (fakeExecFail) injectedSeams.push("fake-exec-fail");
  }
  const execFn = !live
    ? null
    : fakeExecLog
      ? buildFakeExecFn(fakeExecLog, {
          failAll: fakeExecFail,
          failSubmitOnly: fakeExecFailSubmit,
          terminalListResponse: fakeTerminalListJson
            ? {
                ok: true,
                result: { terminals: JSON.parse(fakeTerminalListJson) },
              }
            : null,
        })
      : createOrcaExecFn();
  const result = runWakeOnce({
    watchLogPath,
    statePath,
    wakeLogPath,
    activeRoundCount: parseActiveRounds(activeRoundsRaw),
    orchHandle,
    live,
    execMode,
    injectedSeams,
    execFn,
  });
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `wake-wire: verdict=${result.verdict} reason=${result.reasonCode} sent=${result.sent} exit=${result.exitCode}`,
    );
  }
  process.exit(result.exitCode);
}
