// HYK-272/HYK-270-stall-visible-2 (coder-task.md §4) -- 배달 직후 "착수"
// 확인 CLI. ps1(관제실 dispatch-worker.ps1, ★이 저장소가 직접 고치지
// 않는다)이 배달 직후 이 한 줄을 불러 확인한다:
//
//   node scripts/supervisor/dispatch-start-confirm-cli.mjs \
//     --repo-root <워크트리 절대경로> --dispatched-at-ms <배달 시각 epoch ms> \
//     --watch-dir <D:\문서관리\하네스-관제실\watch> \
//     --notify-dir <D:\문서관리\통역\받는함> \
//     --task-id <하네스 라벨>
//
// 종료코드: 0 = 착수 확인(STARTED). 1 = 착수 확인 실패(NOT_STARTED,
// 타임아웃까지 세션 기록 파일 총 바이트 수가 한 번도 늘지 않음) -- 사람이
// 읽는 한 줄이 stderr에 찍히고 notifyDir에 통지 파일 1장이 남는다(§7
// "새 알림 채널 0" -- 기존 notifyDir 재사용). 2 = 판정 불가(관측 수집
// 자체가 실패 -- 조용히 "착수함"으로 접지 않는다, §2-3 계열 원칙).
//
// ★신호 선택 근거(coder-task.md §4-1 항1 요구, §3 실측 인용):
// - 화면(`orca terminal read`)은 이 조각 자신의 실측(coder.md 관측 지연
//   절)에서 76초가 지나도록 자기 마커를 반영하지 않는 경우가 나왔다 --
//   상한이 없다. 그래서 이 CLI는 화면을 전혀 읽지 않는다(orca 호출 0).
// - mtime은 ORCH 실측(§3-2)에서 "크기는 느는데 mtime은 그대로"인 구간이
//   있었다 -- 그래서 "크기"(dispatch-start-size-adapter.mjs)만 쓴다.
// - 이 신호는 "아예 시작 못 한 경우"를 잡는다(선택 기준, coder-task.md
//   §4-1 항2): 워커가 세션을 시작하지 못하면 세션 로그 파일 자체가 아예
//   생기지 않으므로 총 바이트 수가 0에서 전혀 늘지 않는다 -- 결과 파일
//   기반 판정과 달리 "표지를 남기려면 이미 시작했어야 한다"는 함정이
//   없다(세션 로그는 워커가 뭘 하기도 전에 Claude Code 자신이 만든다).
//
// ★사례 1·2 커버리지(coder-task.md §4-2 요구):
// - 사례 1(메뉴 잔류로 아예 시작 못 함): 세션 로그 총 바이트 수가 타임아웃
//   까지 0(또는 배달 시점 값)에서 전혀 안 늘어남 -> NOT_STARTED로 잡는다.
// - 사례 2(시작은 했으나 승인창 등으로 멈춤): 세션 로그가 어느 정도
//   커지다가 더 이상 안 늘어남 -> 이 CLI의 폴링 창(기본 3분, ORCH가 실전
//   에서 검증한 값) 안에서 멈추면 NOT_STARTED로 잡는다. ⚠️단 이 CLI는
//   "배달 직후 1회" 확인용이라 폴링 창을 넘어선 뒤에 멈추는 사례(예:
//   10분 진행하다 멈춤)는 이 CLI 혼자로는 못 잡는다 -- 그건 이미 결선된
//   주기 감시(watch-run.mjs의 dispatch-start 축, HYK-201)의 몫이다(한계
//   명시, coder-task.md §4-1 항2 "하나만 잡으면 한계를 명시하라").
//
// Node 20 호환 -- ESM 표준 API만 사용.
import { writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectTotalSessionBytes } from "./dispatch-start-size-adapter.mjs";
import {
  judgeDispatchStartBySize,
  DISPATCH_START_SIZE_VERDICT,
  DEFAULT_TIMEOUT_MS,
} from "./dispatch-start-size-core.mjs";

export const DISPATCH_START_CONFIRM_STATUS = Object.freeze({
  STARTED: "DISPATCH_START_CONFIRM_STARTED",
  NOT_STARTED: "DISPATCH_START_CONFIRM_NOT_STARTED",
  COLLECTION_FAILED: "DISPATCH_START_CONFIRM_COLLECTION_FAILED",
});

function defaultClaudeHomeDir() {
  return path.join(os.homedir(), ".claude");
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

function buildNoticeText({ taskId, dispatchedAtMs, nowMs, observationCount }) {
  const lines = [];
  lines.push(`# 배달 후 착수 확인 실패 -- ${formatKstIsh(nowMs)}`);
  lines.push("");
  lines.push(`- 태스크: ${taskId || "(미상)"}`);
  lines.push(`- 배달 시각: ${formatKstIsh(dispatchedAtMs)}`);
  lines.push(
    `- 세션 기록 파일 총 바이트 수가 그 뒤 한 번도 늘지 않았습니다(관측 ${observationCount}회, 화면 미사용 -- 세션 로그 크기 기반).`,
  );
  lines.push("");
  lines.push(
    "이 좌석이 배달을 아예 못 받았거나(메뉴 잔류 등) 시작 직후 멈췄을 수 있습니다(승인창 등). 자동 재시도는 하지 않습니다 -- 사람이 직접 좌석 상태를 확인해 주십시오.",
  );
  return lines.join("\n") + "\n";
}

function buildNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `dispatch-start-confirm-notify-${iso}.md`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// runDispatchStartConfirm(...) -- 폴링 루프 본체. 전부 주입 가능(시험은
// sleepFn을 즉시 반환하는 가짜로 넘겨 실제로 기다리지 않는다).
export async function runDispatchStartConfirm({
  repoRoot,
  dispatchedAtMs,
  claudeHomeDir = defaultClaudeHomeDir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = 15000,
  now = Date.now,
  sleepFn = sleep,
  readdirFn = readdirSync,
  statFn,
  collectFn,
}) {
  const collect = () =>
    (collectFn ?? collectTotalSessionBytes)(
      { repoRoot, claudeHomeDir },
      { readdirFn, statFn },
    );

  const observations = [];
  for (;;) {
    const nowMs = now();
    const snap = collect();
    if (!snap.ok) {
      return {
        status: DISPATCH_START_CONFIRM_STATUS.COLLECTION_FAILED,
        reasonCode: snap.reasonCode,
        detail: snap.detail,
        observations,
      };
    }
    observations.push({ observedAtMs: nowMs, totalBytes: snap.totalBytes });

    const judged = judgeDispatchStartBySize({
      observations,
      dispatchedAtMs,
      now: nowMs,
      timeoutMs,
    });

    if (judged.verdict === DISPATCH_START_SIZE_VERDICT.STARTED) {
      return {
        status: DISPATCH_START_CONFIRM_STATUS.STARTED,
        reasonCode: judged.reasonCode,
        observations,
      };
    }
    if (judged.verdict === DISPATCH_START_SIZE_VERDICT.NOT_STARTED) {
      return {
        status: DISPATCH_START_CONFIRM_STATUS.NOT_STARTED,
        reasonCode: judged.reasonCode,
        observations,
      };
    }
    // UNDECIDABLE(아직 타임아웃 전) -- 계속 폴링한다. 단 다음 폴링이
    // 타임아웃을 넘기면 그 폴링에서 NOT_STARTED로 닫힌다(위 judged 호출이
    // 그때의 now를 다시 판정하므로 여기서 별도 타임아웃 계산을 하지
    // 않는다 -- 판정은 항상 코어 한 곳에서만 한다).
    await sleepFn(pollIntervalMs);
  }
}

function writeNoticeIfNotStarted({
  result,
  taskId,
  dispatchedAtMs,
  notifyDir,
  nowFn,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  if (result.status !== DISPATCH_START_CONFIRM_STATUS.NOT_STARTED) return null;
  if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
  const nowMs = nowFn();
  const text = buildNoticeText({
    taskId,
    dispatchedAtMs,
    nowMs,
    observationCount: result.observations.length,
  });
  const noticePath = path.join(notifyDir, buildNoticeFileName(nowMs));
  writeFn(noticePath, text, "utf8");
  return noticePath;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/dispatch-start-confirm-cli.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let repoRoot = null;
  let dispatchedAtMs = null;
  let notifyDir = null;
  let taskId = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pollIntervalMs = 15000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--dispatched-at-ms")
      dispatchedAtMs = Number(argv[++i]);
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
    else if (argv[i] === "--task-id") taskId = argv[++i];
    else if (argv[i] === "--timeout-ms") timeoutMs = Number(argv[++i]);
    else if (argv[i] === "--poll-interval-ms")
      pollIntervalMs = Number(argv[++i]);
    // --watch-dir accepted for future use/parity but not required by this
    // CLI today (notice writing only needs notifyDir); reserved so ps1's
    // one-liner can pass the same argument set it already threads to the
    // other supervisor CLIs without this one erroring on an unknown flag.
    else if (argv[i] === "--watch-dir") i++; // 예약(수용만) -- 아래 헤더 주석 참조.
  }
  if (!repoRoot || !Number.isFinite(dispatchedAtMs) || !notifyDir) {
    console.error(
      "usage: dispatch-start-confirm-cli.mjs --repo-root <path> --dispatched-at-ms <epoch-ms> --notify-dir <path> [--task-id <id>] [--timeout-ms <n>] [--poll-interval-ms <n>]",
    );
    process.exit(2);
  }
  const result = await runDispatchStartConfirm({
    repoRoot,
    dispatchedAtMs,
    taskId,
    timeoutMs,
    pollIntervalMs,
  });
  if (result.status === DISPATCH_START_CONFIRM_STATUS.STARTED) {
    console.log(`dispatch-start-confirm: STARTED (${result.reasonCode})`);
    process.exit(0);
  }
  if (result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED) {
    const noticePath = writeNoticeIfNotStarted({
      result,
      taskId,
      dispatchedAtMs,
      notifyDir,
      nowFn: Date.now,
      writeFn: writeFileSync,
      mkdirFn: mkdirSync,
      existsFn: existsSync,
    });
    console.error(
      `dispatch-start-confirm: NOT_STARTED -- ${taskId || "(task)"} never showed session-log growth within ${timeoutMs}ms of dispatch. notice=${noticePath}`,
    );
    process.exit(1);
  }
  console.error(
    `dispatch-start-confirm: COLLECTION_FAILED (${result.reasonCode}) -- ${result.detail}`,
  );
  process.exit(2);
}
