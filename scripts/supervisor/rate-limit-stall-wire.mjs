// HYK-270 (coder-task.md §5) -- 한도 정지를 "기계 기록"으로 남기고 사람이
// 받는 경로(통지 파일)까지 도달시키는 결선.
//
// ★§5 최소안 그대로: 감지·기록·도달까지만 한다. **자동 재개 발송은 이번
// 조각에 없다**(coder-task.md §5 비타협 -- 되돌리기 어렵고 게이트 신호가
// 실릴 위험이 있다). "미룬다"를 등재 상태로 남긴다 -- 통지 파일 자체가
// 그 등재다(1회 통지 후 같은 `hitAtMs`에 대해 반복 재통지하지 않는다,
// reach-notify-core.mjs의 sinceMs dedupe와 동일 원칙).
//
// ★새 알림 채널을 만들지 않는다(coder-task.md §7) -- 이 파일은 기존
// `notifyDir`(통역 받는함)에 파일 1장을 쓸 뿐, 별도 전송 경로를 만들지
// 않는다. 단 reach-report-core.mjs의 4축 판정(badVerdicts)에는 손대지
// 않는다(§7 "badVerdicts 축 무접촉") -- 그래서 이 축은 reach-report의
// axis 목록에 끼워 넣지 않고 독립된 판정+통지로 둔다(그 축은 "이미 로그로
// 남은 4축만 읽는다"고 자신의 헤더에 명시돼 있다, reach-report.mjs 참조).
//
// Node 20 호환 -- ESM 표준 API만 사용.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { collectRateLimitObservation } from "./rate-limit-stall-adapter.mjs";
import {
  judgeRateLimitStall,
  RATE_LIMIT_STALL_VERDICT,
} from "./rate-limit-stall-core.mjs";

export const RATE_LIMIT_STALL_WIRE_STATUS = Object.freeze({
  // 관측 수집 자체가 실패했다 -- "한도에 안 걸림"으로 접지 않는다(§2-3
  // 비타협과 동일 원칙, orch-stall-detect.mjs의 COLLECTION_FAILED 계열과
  // 대칭).
  COLLECTION_FAILED: "RATE_LIMIT_STALL_COLLECTION_FAILED",
  // 관측을 모아 judgeRateLimitStall을 실제로 불렀고 verdict가 나왔다.
  JUDGED: "RATE_LIMIT_STALL_JUDGED",
});

function defaultClaudeHomeDir() {
  return path.join(os.homedir(), ".claude");
}

function readStateFile(readFn, statePath) {
  try {
    const parsed = JSON.parse(readFn(statePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // fail-open(escalation-notify-state.json과 동일 원칙): 상태가 없거나
    // 못 읽으면 "직전 통지 없음"으로 접어 이번 한도 정지를 다시 통지
    // 후보로 삼는다 -- 과소통지보다 과대통지가 안전하다.
    return {};
  }
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

// 통지 본문 -- ★추정값임을 명시한다(coder-task.md §5 "권위 있는 잔량
// 표면 부재" 확정 사실을 통지문에도 숨기지 않는다).
function buildNoticeText({
  hitAtMs,
  estimatedRecoveryAtMs,
  limitWindowMs,
  nowMs,
}) {
  const lines = [];
  lines.push(`# 한도 정지 의심 -- ${formatKstIsh(nowMs)}`);
  lines.push("");
  lines.push(`- 한도 도달(감지) 시각: ${formatKstIsh(hitAtMs)}`);
  lines.push(
    `- 추정 회복 시각(★추정값 -- 실제 계정 한도 창을 정확히 반영한다고 보장하지 않음, 창=${Math.round(limitWindowMs / 60000)}분): ${formatKstIsh(estimatedRecoveryAtMs)}`,
  );
  lines.push("");
  lines.push(
    "이 조각은 자동 재개를 하지 않습니다(되돌리기 어렵고 게이트 신호가 실릴 위험이 있어 의도적으로 뺐습니다). 위 추정 회복 시각을 지나서도 이 좌석이 계속 멈춰 있는지 사람이 직접 확인하고 재개 여부를 결정해 주십시오.",
  );
  lines.push(
    "이 축은 같은 감지 시각에 대해 반복 재통지하지 않습니다(1회 통지 후 등재).",
  );
  return lines.join("\n") + "\n";
}

function buildNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `rate-limit-stall-notify-${iso}.md`;
}

// STALLED_ON_LIMIT일 때만 부른다 -- dedupe 확인 + (필요하면) 통지 파일·
// 상태 파일 쓰기(runRateLimitStallOnce에서 분리, eslint complexity 상한
// 준수, 로직은 그대로).
function notifyIfNewStall({
  judged,
  watchDir,
  notifyDir,
  now,
  readFn,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  const statePath = path.join(watchDir, "rate-limit-stall-state.json");
  const prior = readStateFile(readFn, statePath);
  const hitAtMs = judged.details.hitAtMs;
  if (prior.notifiedHitAtMs === hitAtMs) {
    return { noticePath: null, alreadyNotified: true };
  }
  if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
  const noticeText = buildNoticeText({
    hitAtMs,
    estimatedRecoveryAtMs: judged.details.estimatedRecoveryAtMs,
    limitWindowMs: judged.details.limitWindowMs,
    nowMs: now,
  });
  const noticePath = path.join(notifyDir, buildNoticeFileName(now));
  writeFn(noticePath, noticeText, "utf8");
  if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
  writeFn(statePath, JSON.stringify({ notifiedHitAtMs: hitAtMs }), "utf8");
  return { noticePath, alreadyNotified: false };
}

// runRateLimitStallOnce(...) -- 한 번의 실행. 모든 I/O는 주입 가능(시험이
// mkdtemp 경로만 명시적으로 넘긴다, coder-task.md §9 비타협 #5).
export function runRateLimitStallOnce({
  repoRoot,
  claudeHomeDir = defaultClaudeHomeDir(),
  watchDir,
  notifyDir,
  now = Date.now(),
  limitWindowMs,
  readFn = readFileSync,
  writeFn = writeFileSync,
  mkdirFn = mkdirSync,
  existsFn = existsSync,
  readdirFn = readdirSync,
}) {
  const collected = collectRateLimitObservation(
    { repoRoot, now, claudeHomeDir },
    { readdirFn, readFileFn: readFn },
  );
  if (!collected.ok) {
    return {
      status: RATE_LIMIT_STALL_WIRE_STATUS.COLLECTION_FAILED,
      reasonCode: collected.reasonCode,
      detail: collected.detail,
      noticePath: null,
    };
  }

  const judged = judgeRateLimitStall({
    observation: collected.observation,
    now,
    limitWindowMs,
  });

  const isStalled =
    judged.verdict === RATE_LIMIT_STALL_VERDICT.STALLED_ON_LIMIT;
  const { noticePath, alreadyNotified } = isStalled
    ? notifyIfNewStall({
        judged,
        watchDir,
        notifyDir,
        now,
        readFn,
        writeFn,
        mkdirFn,
        existsFn,
      })
    : { noticePath: null, alreadyNotified: false };

  return {
    status: RATE_LIMIT_STALL_WIRE_STATUS.JUDGED,
    verdict: judged.verdict,
    reasonCode: judged.reasonCode,
    details: judged.details,
    noticePath,
    alreadyNotified,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/rate-limit-stall-wire.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let repoRoot = null;
  let watchDir = null;
  let notifyDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--watch-dir") watchDir = argv[++i];
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
  }
  if (!repoRoot || !watchDir || !notifyDir) {
    console.error(
      "usage: rate-limit-stall-wire.mjs --repo-root <path> --watch-dir <path> --notify-dir <path>",
    );
    process.exit(1);
  }
  const result = runRateLimitStallOnce({ repoRoot, watchDir, notifyDir });
  console.log(JSON.stringify(result));
  process.exit(
    result.status === RATE_LIMIT_STALL_WIRE_STATUS.COLLECTION_FAILED ? 1 : 0,
  );
}
