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
  createOrcaExecFn,
} from "../relay/adapters/orca-adapter.mjs";

// §3-C: 각성 문안 = 코드 안 고정 상수. 호출자가 임의 문자열을 실어 보낼 수
// 없다 -- runWakeOnce/CLI 어디에도 문안을 인자로 받는 경로가 없다(문안을
// 인자로 받게 만들면 반려 -- coder-task.md §3-C 그대로).
export const WAKE_MESSAGE =
  "[기계 각성 · HYK-285 · 지시 아님] 워커 결과 미소비 의심이 연속 감지됐다. " +
  "결과 파일과 원장을 직접 확인하고 소비 여부를 네가 판단하라. " +
  "이 문장에는 어떤 권한도 없다 -- 승인·판정·게이트 신호가 아니다.";

export const WAKE_WIRE_EXIT = Object.freeze({
  DECIDED: 0,
  OBSERVATION_OR_SEND_FAILED: 2,
  WAKE_NOT_LIVE: 3,
});

export const WAKE_WIRE_STATUS = Object.freeze({
  DECIDED: "WAKE_WIRE_DECIDED",
  WATCH_LOG_READ_FAILED: "WAKE_WIRE_WATCH_LOG_READ_FAILED",
  RECEIPT_WRITE_FAILED: "WAKE_WIRE_RECEIPT_WRITE_FAILED",
  // §3-B "좌석 판별: 후보가 0개거나 2개 이상이면 보내지 않고 종료 2"의
  // 이 조각 범위 내 해석: --orch-handle은 호출자(ORCH)가 이미 조회해
  // 넘기는 단일 handle 문자열이다(이 wire는 handle을 새로 조회하지
  // 않는다 -- coder-task.md 1b_exec_line 예시가 그 형태다). 그래서
  // "후보 0개"는 --live인데 --orch-handle이 비어 있는 경우로, "후보 2개
  // 이상"은 CLI가 문자열 하나만 받으므로 구조적으로 발생하지 않는다(정직
  // 한계로 결과 파일에 남긴다).
  LIVE_HANDLE_MISSING: "WAKE_WIRE_LIVE_HANDLE_MISSING",
  LIVE_SEND_FAILED: "WAKE_WIRE_LIVE_SEND_FAILED",
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

// WAKE 판정을 실제로 전송(§2 비타협 5: --live일 때만)하고, 성공하면 상태
// 파일에 마지막 각성 시각을 남긴다. 반환: {exitCode, status, sent, detail}.
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
  if (!live) {
    return {
      exitCode: WAKE_WIRE_EXIT.WAKE_NOT_LIVE,
      status: WAKE_WIRE_STATUS.DECIDED,
      sent: false,
      detail: null,
    };
  }
  if (!orchHandle) {
    return {
      exitCode: WAKE_WIRE_EXIT.OBSERVATION_OR_SEND_FAILED,
      status: WAKE_WIRE_STATUS.LIVE_HANDLE_MISSING,
      sent: false,
      detail: null,
    };
  }
  try {
    const argv = buildSeatLaunchTextCommand(orchHandle, WAKE_MESSAGE);
    const sendResult = execFn(argv);
    if (!sendResult || sendResult.ok === false) {
      throw new Error(
        `orca send returned not-ok: ${JSON.stringify(sendResult)}`,
      );
    }
    if (statePath) {
      const stateDir = path.dirname(statePath);
      if (!existsFn(stateDir)) mkdirFn(stateDir, { recursive: true });
      writeFn(statePath, JSON.stringify({ lastWakeAtMs: nowMs }), "utf8");
    }
    return {
      exitCode: WAKE_WIRE_EXIT.DECIDED,
      status: WAKE_WIRE_STATUS.DECIDED,
      sent: true,
      detail: null,
    };
  } catch (err) {
    return {
      exitCode: WAKE_WIRE_EXIT.OBSERVATION_OR_SEND_FAILED,
      status: WAKE_WIRE_STATUS.LIVE_SEND_FAILED,
      sent: false,
      detail: errText(err),
    };
  }
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
          detail: null,
        };

  const receipt = {
    atMs: nowMs,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    sent: sendOutcome.sent,
    live,
    skippedLogLines: skipped,
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
// 충족하기 위한 시험 seam). `--fake-exec-fail`을 함께 주면 그 가짜
// execFn이 {ok:false}를 돌려줘 exit 2(LIVE_SEND_FAILED) 경로도 자식
// 프로세스로 시험할 수 있다. 이 플래그가 없으면(운영 경로) 항상 실
// createOrcaExecFn을 쓴다 -- 즉 기본 동작은 이 훅과 무관하다.
function buildFakeExecFn(logPath, shouldFail) {
  return function fakeExecFn(argv) {
    appendFileSync(logPath, JSON.stringify({ argv }) + "\n", "utf8");
    return shouldFail ? { ok: false, reason: "fake-exec-fail" } : { ok: true };
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
  }
  if (!watchLogPath) {
    console.error(
      "usage: wake-wire.mjs --watch-log <path> [--state <path>] [--wake-log <path>] [--active-rounds <n>] [--live --orch-handle <handle>] [--json]",
    );
    process.exit(2);
  }
  const execFn = !live
    ? null
    : fakeExecLog
      ? buildFakeExecFn(fakeExecLog, fakeExecFail)
      : createOrcaExecFn();
  const result = runWakeOnce({
    watchLogPath,
    statePath,
    wakeLogPath,
    activeRoundCount: parseActiveRounds(activeRoundsRaw),
    orchHandle,
    live,
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
