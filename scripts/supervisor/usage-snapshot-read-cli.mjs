// HYK-406-wk-gate-1 (조각 B · 저장소 몫) -- 주간 사용량 «읽기 전용» 스냅샷 CLI.
//
// 좌석 기동 직전에 관제실 memory-gate 가 한 번 부르는 읽기 도구다
// (docs/control-room-patches/HYK-406-memory-gate-wk.md). 조각 A 의 HUD 읽기 함수
// (usage-threshold-wire.mjs `readHudSnapshots` · usage-threshold-core.mjs `judgeWeekly`)를
// 그대로 재사용한다 -- 읽기 규칙이 둘이 되지 않게 한다.
//
// 출력 = stdout 한 줄 JSON `{seven_day, at, ageMin, status, role, reason}` · 종료 코드 항상 0.
//   status = "ok"          값이 있고 60분 안(STALE_AFTER_MS 와 같은 기준)
//          | "stale"       값은 있으나 60분보다 오래됨(seven_day 는 참고용으로만 싣는다)
//          | "unavailable" 읽을 수 없음 -- seven_day · at · ageMin · role 전부 null
// ⛔모르는 값을 0% 로 접지 않는다 -- unavailable 의 seven_day 는 null 이다(0 이 아니다).
// ⛔HUD 에 쓰지 않는다 · 세션 jsonl(대화 기록)을 읽지 않는다 · 던지지 않는다(어떤 실패도
//   unavailable + 사유로 접는다 -- 호출 쪽이 fail-open 으로 읽는다).
//
// ⛔OBSERVER · 앵커 아님: HUD 파일은 ORCH 도 같은 사용자 권한으로 덮어쓸 수 있다
// (usage-threshold-core.mjs 머리 정직 한계 1항). 낡음 기준 60분 · wk 는 «값이 있는 가장
// 신선한 파일»(어느 좌석 값인지 구별되지 않는다).
//
// 사용: node usage-snapshot-read-cli.mjs [--hud-dir <dir>] [--now <ISO 또는 epoch ms>]
//   --hud-dir 생략 = 홈의 .claude/hud (defaultHudDir) · --now 생략 = 지금(시험 주입용).
//
// Node 20 호환 -- ESM 표준 API 만.
import { readFileSync, readdirSync } from "node:fs";
import { readHudSnapshots, defaultHudDir } from "./usage-threshold-wire.mjs";
import { judgeWeekly, KIND, STALE_AFTER_MS } from "./usage-threshold-core.mjs";

export const SNAPSHOT_STATUS = Object.freeze({
  OK: "ok",
  STALE: "stale",
  UNAVAILABLE: "unavailable",
});

function unavailable(reason) {
  return {
    seven_day: null,
    at: null,
    ageMin: null,
    status: SNAPSHOT_STATUS.UNAVAILABLE,
    role: null,
    reason,
  };
}

// 순수 -- 시계는 now 인자. I/O 는 주입 가능(기본 = node:fs).
export function readUsageSnapshot({
  hudDir,
  now,
  readFn = readFileSync,
  readdirFn = readdirSync,
}) {
  const snaps = readHudSnapshots({ hudDir, readFn, readdirFn });
  const wk = judgeWeekly({ snaps, nowMs: now });
  if (wk.kind !== KIND.OBSERVED) {
    return unavailable(wk.reason);
  }
  const ageMin = Math.max(0, Math.round(wk.ageMs / 60000));
  const base = {
    seven_day: wk.value,
    at: new Date(wk.atMs).toISOString(),
    ageMin,
    role: wk.role,
  };
  if (wk.ageMs > STALE_AFTER_MS) {
    return {
      ...base,
      status: SNAPSHOT_STATUS.STALE,
      reason: `값이 낡음 -- 마지막 갱신 ${ageMin}분 전(기준 ${Math.round(STALE_AFTER_MS / 60000)}분) · 지금 주간 사용량을 모름`,
    };
  }
  return { ...base, status: SNAPSHOT_STATUS.OK, reason: null };
}

function parseNow(text) {
  const ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

// 인자 -> {hudDir, now} 또는 {error}. 마지막 값이 이긴다.
export function parseArgs(argv) {
  const out = { hudDir: undefined, now: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hud-dir") {
      if (i + 1 >= argv.length) return { error: "--hud-dir 에 값이 없다" };
      out.hudDir = argv[++i];
    } else if (a === "--now") {
      if (i + 1 >= argv.length) return { error: "--now 에 값이 없다" };
      const ms = parseNow(argv[++i]);
      if (ms === null) return { error: "--now 값을 시각으로 읽을 수 없다" };
      out.now = ms;
    } else {
      return { error: `알 수 없는 인자: ${a}` };
    }
  }
  return out;
}

// 시간 판정 진입점(now 기본값 = 지금) -- scripts/check/time-judgment-now-injection.mjs 에 등록.
export function runUsageSnapshotCli(argv, { now = Date.now() } = {}) {
  try {
    const args = parseArgs(argv);
    if (args.error) return unavailable(`인자 오류: ${args.error}`);
    return readUsageSnapshot({
      hudDir: args.hudDir ?? defaultHudDir(),
      now: args.now ?? now,
    });
  } catch (err) {
    return unavailable(
      `예외: ${err && err.message ? err.message : String(err)}`,
    );
  }
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("/usage-snapshot-read-cli.mjs");
if (invokedDirectly) {
  process.stdout.write(
    `${JSON.stringify(runUsageSnapshotCli(process.argv.slice(2)))}\n`,
  );
  process.exitCode = 0;
}
