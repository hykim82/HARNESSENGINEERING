// HYK-406 조각 A (HYK-406-usage-watch-1) -- 예약 감시(watch-run) 회차가 HUD 사용량
// 파일을 읽어 «띠에 들어설 때만» 책임자 받는함에 통지 1장을 쓰는 결선.
//
// ⛔⭐OBSERVER · 앵커 아님 -- usage-threshold-core.mjs 머리의 정직 한계 7항과
// 같다. 이 축이 읽는 파일은 ORCH 도 쓸 수 있는 파일이다(위조 차단 0).
//
// 읽기 원천 = `<HUD 디렉터리>/ratelimit-<역할>.json` (harness-hud.mjs 가 쓴다 ·
// 키: at · role · ctx · five_hour · seven_day). 세션 jsonl(대화 기록)은 읽지
// 않는다. HUD 디렉터리 기본값 = os.homedir()/.claude/hud (harness-hud.mjs:142 와
// 같은 자리 · 사용자 절대 경로 하드코딩 0).
//
// 새 알림 채널을 만들지 않는다 -- 기존 notifyDir(통역 받는함)에 파일 1장을 쓸
// 뿐이다(rate-limit-stall-wire.mjs 와 같은 결선 원칙). 상태 파일 =
// watchDir/usage-threshold-notify-state.json.
//
// Node 20 호환 -- ESM 표준 API 만 사용.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ORCH_ROLE,
  parseSnapshot,
  judgeOrchCtx,
  judgeWeekly,
  judgeFiveHour,
  norolePresence,
  decideTransitions,
  buildNoticeText,
  buildLogSegment,
} from "./usage-threshold-core.mjs";

export const USAGE_THRESHOLD_STATE_FILE = "usage-threshold-notify-state.json";
const SNAPSHOT_FILE_RE = /^ratelimit-([A-Za-z0-9_-]+)\.json$/;

export function defaultHudDir() {
  return path.join(os.homedir(), ".claude", "hud");
}

function errToken(err) {
  const code = err && err.code ? err.code : "ERR";
  return code === "ENOENT" ? "파일 없음" : `읽기 실패(${code})`;
}

// HUD 디렉터리의 표본을 전부 읽는다. ORCH 파일은 목록에 없어도 직접 읽어
// «없음» 을 사유와 함께 돌려준다. 디렉터리 자체를 못 읽어도 던지지 않는다.
export function readHudSnapshots({ hudDir, readFn, readdirFn }) {
  const roles = new Set([ORCH_ROLE]);
  let dirReason = null;
  try {
    for (const name of readdirFn(hudDir)) {
      const m = SNAPSHOT_FILE_RE.exec(String(name));
      if (m) roles.add(m[1]);
    }
  } catch (err) {
    dirReason = `HUD 디렉터리를 읽을 수 없음(${err && err.code ? err.code : "ERR"})`;
  }
  const snaps = [...roles].sort().map((role) => {
    const file = path.join(hudDir, `ratelimit-${role}.json`);
    try {
      return parseSnapshot({
        role,
        raw: readFn(file, "utf8"),
        readError: null,
      });
    } catch (err) {
      return parseSnapshot({
        role,
        raw: null,
        readError: dirReason ?? errToken(err),
      });
    }
  });
  return snaps;
}

function parseState(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // 상태가 없거나 못 읽으면 «직전 통지 없음» -- 과소통지보다 과대통지가
    // 안전하다(rate-limit-stall-wire.mjs 와 같은 원칙).
    return {};
  }
}

function noticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `usage-threshold-notify-${iso}.md`;
}

// runUsageThresholdOnce -- 한 회차. 모든 I/O 는 주입 가능(시험이 mkdtemp 경로만
// 넘긴다). 통지 파일을 먼저 쓰고 상태 파일을 나중에 쓴다 -- 통지 쓰기가
// 실패하면 상태가 전진하지 않아 다음 회차에 다시 시도한다.
export function runUsageThresholdOnce({
  hudDir = defaultHudDir(),
  watchDir,
  notifyDir,
  now = Date.now(),
  readFn = readFileSync,
  writeFn = writeFileSync,
  mkdirFn = mkdirSync,
  existsFn = existsSync,
  readdirFn = readdirSync,
}) {
  const snaps = readHudSnapshots({ hudDir, readFn, readdirFn });
  const orch = snaps.find((s) => s.role === ORCH_ROLE);
  const ctx = judgeOrchCtx({ orch, nowMs: now });
  const wk = judgeWeekly({ snaps, nowMs: now });
  const fiveHour = judgeFiveHour({ snaps, nowMs: now });
  const norole = norolePresence({ snaps, orch });

  const statePath = path.join(watchDir, USAGE_THRESHOLD_STATE_FILE);
  const prevText = safeRead(readFn, statePath);
  const { state, events, descents } = decideTransitions({
    prevState: parseState(prevText),
    ctx,
    wk,
    fiveHour,
    norole,
  });
  const { noticePath, stateChanged } = persistOutcome({
    events,
    state,
    prevText,
    statePath,
    watchDir,
    notifyDir,
    now,
    writeFn,
    mkdirFn,
    existsFn,
  });
  return {
    notRun: false,
    ctx,
    wk,
    fiveHour,
    events,
    descents,
    noticePath,
    stateChanged,
    segment: buildLogSegment({ ctx, wk, fiveHour, events, descents }),
  };
}

// 통지 파일을 먼저 쓰고 상태 파일을 나중에 쓴다(위 헤더 참조). 상태가 그대로면
// 다시 쓰지 않는다.
function persistOutcome({
  events,
  state,
  prevText,
  statePath,
  watchDir,
  notifyDir,
  now,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  let noticePath = null;
  if (events.length > 0) {
    if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
    noticePath = path.join(notifyDir, noticeFileName(now));
    writeFn(noticePath, buildNoticeText({ events, nowMs: now }), "utf8");
  }
  const nextText = JSON.stringify(state);
  const stateChanged = nextText !== prevText;
  if (stateChanged) {
    if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
    writeFn(statePath, nextText, "utf8");
  }
  return { noticePath, stateChanged };
}

function safeRead(readFn, p) {
  try {
    return readFn(p, "utf8");
  } catch {
    return null;
  }
}
