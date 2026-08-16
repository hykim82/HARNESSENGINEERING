// HYK-272/HYK-270-stall-visible-2/-3 (coder-task.md §4) -- 배달 직후
// "착수" 확인 CLI. ps1(관제실 dispatch-worker.ps1, ★이 저장소가 직접
// 고치지 않는다)이 배달 직후 이 한 줄을 불러 확인한다:
//
//   node scripts/supervisor/dispatch-start-confirm-cli.mjs \
//     --repo-root <워크트리 절대경로> --dispatched-at-ms <배달 시각 epoch ms> \
//     --watch-dir <D:\문서관리\하네스-관제실\watch> \
//     --notify-dir <D:\문서관리\통역\받는함> \
//     --task-id <하네스 라벨>
//
// 종료코드(★3R부터 3상태 -- coder-task.md §2 항4 "값을 뭉개지 마라"):
// - 0 = 착수 확인(STARTED).
// - 1 = **아예 시작 못 함**(NOT_STARTED, 타임아웃까지 세션 기록 파일 총
//   바이트 수가 한 번도 늘지 않음) -- 사람 조치: **재배달**.
// - 3 = **시작 후 멈춤**(STALLED_AFTER_START, 한 번은 늘었지만 그 마지막
//   증가로부터 `stallThresholdMs`가 지나도록 더 안 늚 -- 오늘 21시 승인창
//   정지 사고와 동형) -- 사람 조치: **좌석 상태 확인**(재배달이 아니다,
//   이미 뭔가는 하고 있었으므로).
// - 2 = 판정 불가(관측 수집 자체가 실패 -- 조용히 "착수함"으로 접지
//   않는다, §2-3 계열 원칙).
// 1·3 둘 다 사람이 읽는 한 줄이 stderr에 찍히고 notifyDir에 통지 파일
// 1장이 남는다(§3 "새 알림 채널 0" -- 기존 notifyDir 재사용). 통지 문구는
// 두 상태마다 다르다(조치가 다르므로).
//
// ★신호 선택 근거(coder-task.md §4-1 항1 요구, §3 실측 인용):
// - 화면(`orca terminal read`)은 이 조각 자신의 실측(coder.md 관측 지연
//   절)에서 76초가 지나도록 자기 마커를 반영하지 않는 경우가 나왔다 --
//   상한이 없다. 그래서 이 CLI는 화면을 전혀 읽지 않는다(orca 호출 0).
// - mtime은 ORCH 실측(§3-2)에서 "크기는 느는데 mtime은 그대로"인 구간이
//   있었다 -- 그래서 "크기"(dispatch-start-size-adapter.mjs)만 쓴다.
//
// ★HYK-270-stall-visible-3 (2R REVIEW 반려 수리, coder-task.md §1-§2):
// 2R은 관측 두 번째(=최초 증가)에서 즉시 STARTED로 폴링을 끝냈다 -- 그
// 뒤로 안 늘어도 다시 안 본다. 검토자 실측 원문: "totalBytes=0 → 5000 →
// 5000 → …"(승인창 등으로 멈춘 사례 2)가 `STARTED`로 종료돼 사례 2를
// 구조적으로 못 잡았다. ★수리: STARTED는 더 이상 "한 번이라도 늘면
// 즉시" 확정되지 않는다 -- 이 루프는 `timeoutMs`(배달 시각 기준, 기존과
// 동일한 전체 관측 창) 끝까지 계속 폴링하고, 그 시점에 코어가 최종
// 판정한다: 그 창 안에서 계속(=마지막 증가가 `stallThresholdMs` 이내)
// 늘고 있었으면 STARTED, 늘다가 멈췄으면(마지막 증가로부터
// `stallThresholdMs` 초과) STALLED_AFTER_START. ★단 STALLED_AFTER_START나
// NOT_STARTED가 먼저 확정되면(더 기다려도 뒤집힐 수 없는 나쁜 소식) 그
// 즉시 폴링을 멈추고 시끄럽게 실패한다 -- 나쁜 소식을 기다리게 하지
// 않는다.
//
// ★사례 1·2 커버리지(coder-task.md §4-2/§2 요구, ★3R 갱신):
// - 사례 1(메뉴 잔류로 아예 시작 못 함): 세션 로그 총 바이트 수가
//   `timeoutMs`까지 한 번도 안 늘어남 -> `NOT_STARTED`.
// - 사례 2(시작은 했으나 승인창 등으로 멈춤): 어느 정도 커지다가 그
//   마지막 증가로부터 `stallThresholdMs`를 넘게 더 안 늘어남 ->
//   `STALLED_AFTER_START`(★3R부터 실제로 잡는다 -- 2R은 이 경우를
//   `STARTED`로 잘못 종료했다).
// ⚠️**한계(2R부터 유지, 여전히 유효)**: 이 CLI는 "배달 직후 1회" 확인용
// 이라 `timeoutMs` 창을 넘어선 뒤에(예: 10분 진행하다 멈춤) 일어나는
// 정지는 혼자서 못 잡는다 -- 그건 이미 결선된 주기 감시(watch-run.mjs의
// dispatch-start 축, HYK-201)의 몫이다.
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
  DEFAULT_STALL_THRESHOLD_MS,
} from "./dispatch-start-size-core.mjs";

export const DISPATCH_START_CONFIRM_STATUS = Object.freeze({
  STARTED: "DISPATCH_START_CONFIRM_STARTED",
  NOT_STARTED: "DISPATCH_START_CONFIRM_NOT_STARTED",
  STALLED_AFTER_START: "DISPATCH_START_CONFIRM_STALLED_AFTER_START",
  COLLECTION_FAILED: "DISPATCH_START_CONFIRM_COLLECTION_FAILED",
});

// 종료코드(문서 헤더와 동일 값 -- CLI 블록과 시험 양쪽이 이 표를 재사용).
export const DISPATCH_START_CONFIRM_EXIT_CODE = Object.freeze({
  [DISPATCH_START_CONFIRM_STATUS.STARTED]: 0,
  [DISPATCH_START_CONFIRM_STATUS.NOT_STARTED]: 1,
  [DISPATCH_START_CONFIRM_STATUS.COLLECTION_FAILED]: 2,
  [DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START]: 3,
});

function defaultClaudeHomeDir() {
  return path.join(os.homedir(), ".claude");
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

function buildNotStartedNoticeText({
  taskId,
  dispatchedAtMs,
  nowMs,
  observationCount,
}) {
  const lines = [];
  lines.push(
    `# 배달 후 착수 확인 실패 -- 아예 시작 못 함 -- ${formatKstIsh(nowMs)}`,
  );
  lines.push("");
  lines.push(`- 태스크: ${taskId || "(미상)"}`);
  lines.push(`- 배달 시각: ${formatKstIsh(dispatchedAtMs)}`);
  lines.push(
    `- 세션 기록 파일 총 바이트 수가 그 뒤 한 번도 늘지 않았습니다(관측 ${observationCount}회, 화면 미사용 -- 세션 로그 크기 기반).`,
  );
  lines.push("");
  lines.push(
    "이 좌석이 배달을 아예 못 받았을 수 있습니다(메뉴 잔류 등). 자동 재시도는 하지 않습니다 -- 사람이 **재배달** 여부를 결정해 주십시오.",
  );
  return lines.join("\n") + "\n";
}

function buildStalledAfterStartNoticeText({
  taskId,
  dispatchedAtMs,
  nowMs,
  lastGrowthAtMs,
  stallThresholdMs,
}) {
  const lines = [];
  lines.push(
    `# 배달 후 착수 확인 실패 -- 시작 후 멈춤 -- ${formatKstIsh(nowMs)}`,
  );
  lines.push("");
  lines.push(`- 태스크: ${taskId || "(미상)"}`);
  lines.push(`- 배달 시각: ${formatKstIsh(dispatchedAtMs)}`);
  lines.push(
    `- 마지막으로 세션 기록 파일이 커진 시각: ${formatKstIsh(lastGrowthAtMs)}`,
  );
  lines.push(
    `- 그 뒤로 ${Math.round(stallThresholdMs / 60000)}분 넘게 더 늘지 않았습니다(화면 미사용 -- 세션 로그 크기 기반).`,
  );
  lines.push("");
  lines.push(
    "이 좌석은 배달을 받아 시작은 했지만(예: 승인창 등에 걸려) 진행이 멈췄을 수 있습니다. 자동 재시도는 하지 않습니다 -- 사람이 **좌석 상태를 직접 확인**해 주십시오(재배달이 아닙니다 -- 이미 뭔가는 하고 있었습니다).",
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

// 코어가 낸 판정 하나를 이 CLI의 status로 옮긴다(judged.verdict === STARTED
// 지만 아직 전체 관측 창이 안 끝났으면 여기서 status를 정하지 않고 null을
// 돌려준다 -- 호출부가 계속 폴링한다).
function statusFromJudged(judged, nowMs, dispatchedAtMs, timeoutMs) {
  if (judged.verdict === DISPATCH_START_SIZE_VERDICT.STALLED_AFTER_START) {
    return DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START;
  }
  if (judged.verdict === DISPATCH_START_SIZE_VERDICT.NOT_STARTED) {
    return DISPATCH_START_CONFIRM_STATUS.NOT_STARTED;
  }
  if (judged.verdict === DISPATCH_START_SIZE_VERDICT.STARTED) {
    const pastOverallTimeout = nowMs - dispatchedAtMs >= timeoutMs;
    return pastOverallTimeout ? DISPATCH_START_CONFIRM_STATUS.STARTED : null;
  }
  return null; // UNDECIDABLE -- 계속 폴링.
}

// runDispatchStartConfirm(...) -- 폴링 루프 본체. 전부 주입 가능(시험은
// sleepFn을 즉시 반환하는 가짜로 넘겨 실제로 기다리지 않는다).
export async function runDispatchStartConfirm({
  repoRoot,
  dispatchedAtMs,
  claudeHomeDir = defaultClaudeHomeDir(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
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
      stallThresholdMs,
    });

    const status = statusFromJudged(judged, nowMs, dispatchedAtMs, timeoutMs);
    if (status !== null) {
      return {
        status,
        reasonCode: judged.reasonCode,
        details: judged.details,
        observations,
      };
    }
    // 아직 확정 안 됨(UNDECIDABLE, 또는 STARTED지만 전체 관측 창이 안
    // 끝남) -- 계속 폴링한다. ★2R 결함이 정확히 이 지점이었다: "STARTED
    // 처음 보이면 즉시 반환"했었다.
    await sleepFn(pollIntervalMs);
  }
}

function writeFailureNotice({
  result,
  taskId,
  dispatchedAtMs,
  stallThresholdMs,
  notifyDir,
  nowFn,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
  const nowMs = nowFn();
  const text =
    result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED
      ? buildNotStartedNoticeText({
          taskId,
          dispatchedAtMs,
          nowMs,
          observationCount: result.observations.length,
        })
      : buildStalledAfterStartNoticeText({
          taskId,
          dispatchedAtMs,
          nowMs,
          lastGrowthAtMs: result.details?.lastGrowthAtMs ?? null,
          stallThresholdMs,
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
  let stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS;
  let pollIntervalMs = 15000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--dispatched-at-ms")
      dispatchedAtMs = Number(argv[++i]);
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
    else if (argv[i] === "--task-id") taskId = argv[++i];
    else if (argv[i] === "--timeout-ms") timeoutMs = Number(argv[++i]);
    else if (argv[i] === "--stall-threshold-ms")
      stallThresholdMs = Number(argv[++i]);
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
      "usage: dispatch-start-confirm-cli.mjs --repo-root <path> --dispatched-at-ms <epoch-ms> --notify-dir <path> [--task-id <id>] [--timeout-ms <n>] [--stall-threshold-ms <n>] [--poll-interval-ms <n>]",
    );
    process.exit(2);
  }
  const result = await runDispatchStartConfirm({
    repoRoot,
    dispatchedAtMs,
    timeoutMs,
    stallThresholdMs,
    pollIntervalMs,
  });
  if (result.status === DISPATCH_START_CONFIRM_STATUS.STARTED) {
    console.log(`dispatch-start-confirm: STARTED (${result.reasonCode})`);
    process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
  }
  if (
    result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED ||
    result.status === DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START
  ) {
    const noticePath = writeFailureNotice({
      result,
      taskId,
      dispatchedAtMs,
      stallThresholdMs,
      notifyDir,
      nowFn: Date.now,
      writeFn: writeFileSync,
      mkdirFn: mkdirSync,
      existsFn: existsSync,
    });
    const humanLabel =
      result.status === DISPATCH_START_CONFIRM_STATUS.NOT_STARTED
        ? "NOT_STARTED(아예 시작 못 함 -- 재배달 필요)"
        : "STALLED_AFTER_START(시작 후 멈춤 -- 좌석 확인 필요)";
    console.error(
      `dispatch-start-confirm: ${humanLabel} -- ${taskId || "(task)"}. notice=${noticePath}`,
    );
    process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
  }
  console.error(
    `dispatch-start-confirm: COLLECTION_FAILED (${result.reasonCode}) -- ${result.detail}`,
  );
  process.exit(DISPATCH_START_CONFIRM_EXIT_CODE[result.status]);
}
