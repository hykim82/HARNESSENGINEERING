// HYK-185 gap#69 (coder-task.md §5-C) -- 스케줄러가 실제로 부르는 러너.
//
// 하는 일 = orch-stall-detect.mjs를 **감싸서**(§2-3 비타협 -- 그 파일은
// 읽기 전용 계약이라 고치지 않는다) 실행 -> 결과를 로그 한 줄로 append
// -> 생존 기록(`last-run.json`)을 갱신한다. 그뿐이다.
//
// S11 필수(coder-task.md §5-E, 문구 그대로):
// 1. **증명한다**: 등록되면 이 감지는 ORCH 세션·에이전트와 무관하게 OS가
//    부른다 -- 이 파일은 `node`만으로 실행되며 Claude 훅·Orca API 호출이
//    없다.
// 2. **증명하지 않는다**: 이 조각만으로는 아무것도 돌지 않는다 -- 실제
//    등록은 사람 손이며, 등록됐는지 여부는 저장소 밖이라 우리 기계
//    검사가 볼 수 없다.
// 3. ★**오탐이 나면**: 로그에 한 줄이 남을 뿐이고 **알림은 없다**(전송·
//    자동 조치 0). 이유 = 시끄러운 감시는 꺼지게 되고, 꺼진 감시는 없는
//    것과 같다(한용 문장). 이 파일에는 네트워크 호출·Slack/이메일 전송·
//    프로세스 재시작 코드가 한 줄도 없다.
// 4. ★**자기 생존을 알리지 못하는 감시자는 감시자가 아니다** -- 그래서
//    매 실행이 `last-run.json`(생존 기록)을 남긴다. 단 이 러너 자신이
//    죽으면(스케줄러가 아예 못 부르거나, 부른 프로세스가 기록을 남기기
//    전에 죽으면) 이 기록도 갱신되지 않는다 -- "감시자의 감시자" 문제는
//    여전히 남는다.
// 5. **로그온했을 때만 돈다**(비밀번호를 저장하지 않기 위한 선택) --
//    로그아웃 상태에서는 감시가 없다(schedule-plan-core.mjs가 등록
//    계획에 강제하는 실행 계정 방식, 이 러너 자신은 계정 방식을 모른다).
//
// HYK-185 seat-wire 갱신: orch-stall-detect.mjs가 이제 `seatLiveness`
// 필드를 채우면(seat-liveness-core.mjs의 judgeSeatLiveness 실호출 결과)
// 이 러너는 그 `status`/`verdict`를 로그 줄에 그대로 옮겨 적을 뿐이다
// (`seat_status=`/`seat_verdict=`, buildLogLine 참조) -- v1은 로그만(§2-3
// 비타협 그대로), 이 값으로 재시도·알림 분기를 만들지 않는다.
//
// 로그 상한(coder-task.md §5-C "로그 상한/회전"): 파일을 **줄 수 기준**
// 으로 캡핑한다 -- 매 실행마다 기존 로그를 읽어 줄 배열로 쪼개고, 새
// 줄을 추가한 뒤 `MAX_LOG_LINES`(아래)를 넘으면 앞에서부터 잘라낸다.
// 실행마다 O(로그 크기) 읽기 비용이 들지만, 대상이 "몇 분마다 한 줄"인
// 저빈도 워크로드라 회전 방식보다 단순함을 택했다(신규 도입 선언).
//
// 부작용(coder-task.md §5-C, §2-1): 이 파일은 **의도적으로** I/O를 한다
// (child_process 실행 + 로그/생존 기록 파일 쓰기) -- schedule-plan-core.mjs/
// watch-freshness-core.mjs와 달리 "코어"가 아니라 "러너"다. 실제
// 스케줄러 등록·해제 명령은 실행하지 않는다(그 실행 명령은 orch-stall-
// detect.mjs가 아니라 schedule-wire.mjs의 register/unregister에만 있다).
//
// Node 20 호환(ESM 표준 API만 사용).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";

export const MAX_LOG_LINES = 5000;

function defaultExec(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// orch-stall-detect.mjs의 stdout(JSON 한 줄)을 파싱한다. 파싱 실패는
// "판정 불가"이지 예외가 아니다(§5-A와 같은 원칙 재사용).
//
// HYK-185 seat-wire: `result.seatLiveness`(orch-stall-detect.mjs가 이제
// 실제로 채우는 필드, judgeSeatLivenessForRepo 참조)도 함께 뽑아 로그
// 줄에 싣는다 -- v1은 로그만(§2-3), 이 값이 있어도 판정·재시도 분기는
// 만들지 않는다.
// HYK-185 seat-scan: 여러 워크트리가 동시에 최악 등급일 수 있다(§2-2) --
// status/verdict 하나만으로는 그 건수가 사라지므로 함께 뽑는다.
// parseDetectorStdout에서 분리(복잡도 분산).
function extractSeatLivenessFields(seatLiveness) {
  return {
    seatLivenessStatus:
      seatLiveness && typeof seatLiveness.status === "string"
        ? seatLiveness.status
        : null,
    seatLivenessVerdict:
      seatLiveness && typeof seatLiveness.verdict === "string"
        ? seatLiveness.verdict
        : null,
    seatLivenessWorstCount:
      seatLiveness && typeof seatLiveness.worstCount === "number"
        ? seatLiveness.worstCount
        : null,
    seatLivenessTotalWorktrees:
      seatLiveness && typeof seatLiveness.totalWorktrees === "number"
        ? seatLiveness.totalWorktrees
        : null,
  };
}

// HYK-185-seat-idle-1 (coder-task.md §2-1-3) -- «유휴 방치 좌석» 축의
// 필드도 로그 줄에 옮겨 적는다. seatLiveness와 이름이 구별되도록
// `seatIdle*` 접두를 쓴다(§2-1-1 "구별되는 이름" 비타협).
function extractSeatIdleFields(seatIdle) {
  return {
    seatIdleStatus:
      seatIdle && typeof seatIdle.status === "string" ? seatIdle.status : null,
    seatIdleVerdict:
      seatIdle && typeof seatIdle.verdict === "string"
        ? seatIdle.verdict
        : null,
    seatIdleWorstCount:
      seatIdle && typeof seatIdle.worstCount === "number"
        ? seatIdle.worstCount
        : null,
    seatIdleTotalWorktrees:
      seatIdle && typeof seatIdle.totalWorktrees === "number"
        ? seatIdle.totalWorktrees
        : null,
  };
}

// HYK-185-startcheck-wire (coder-task.md §2-1) -- «배달 후 시작됐는가»
// 축(orch-stall-detect.mjs의 dispatchStart, judgeDispatchStart 실호출
// 결과)도 로그 줄에 옮겨 적는다. 기존 두 축(`seat_*`/`idle_*`)과 구별되게
// `start_*` 접두를 쓴다(§2-1-1 "구별되는 이름" 비타협).
function extractDispatchStartFields(dispatchStart) {
  return {
    startStatus:
      dispatchStart && typeof dispatchStart.status === "string"
        ? dispatchStart.status
        : null,
    startVerdict:
      dispatchStart && typeof dispatchStart.verdict === "string"
        ? dispatchStart.verdict
        : null,
    startWorstCount:
      dispatchStart && typeof dispatchStart.worstCount === "number"
        ? dispatchStart.worstCount
        : null,
    startTotalWorktrees:
      dispatchStart && typeof dispatchStart.totalWorktrees === "number"
        ? dispatchStart.totalWorktrees
        : null,
  };
}

function parseDetectorStdout(stdout) {
  try {
    const parsed = JSON.parse(String(stdout).trim());
    const seatLiveness = isPlainObject(parsed.seatLiveness)
      ? parsed.seatLiveness
      : null;
    const seatIdle = isPlainObject(parsed.seatIdle) ? parsed.seatIdle : null;
    const dispatchStart = isPlainObject(parsed.dispatchStart)
      ? parsed.dispatchStart
      : null;
    return {
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : null,
      reasonCode:
        typeof parsed.reasonCode === "string" ? parsed.reasonCode : null,
      ...extractSeatLivenessFields(seatLiveness),
      ...extractSeatIdleFields(seatIdle),
      ...extractDispatchStartFields(dispatchStart),
    };
  } catch {
    return {
      verdict: null,
      reasonCode: null,
      seatLivenessStatus: null,
      seatLivenessVerdict: null,
      seatLivenessWorstCount: null,
      seatLivenessTotalWorktrees: null,
      seatIdleStatus: null,
      seatIdleVerdict: null,
      seatIdleWorstCount: null,
      seatIdleTotalWorktrees: null,
      startStatus: null,
      startVerdict: null,
      startWorstCount: null,
      startTotalWorktrees: null,
    };
  }
}

// 감지기를 감싸 실행한다(§2-3 -- 고치지 않고 감싼다). 감지기 자신의
// 실패(STALLED/UNDECIDABLE 등)와 러너 자신의 실패(스폰 자체 실패, 예:
// node 경로가 잘못됨)를 구별한다 -- 후자는 `runnerFailure: true`.
function runDetector({ execFn, nodePath, detectorPath, repoRoot }) {
  try {
    const stdout = execFn(
      nodePath,
      [detectorPath, "--repo-root", repoRoot, "--json"],
      {
        cwd: repoRoot,
      },
    );
    return {
      runnerFailure: false,
      exitCode: 0,
      ...parseDetectorStdout(stdout),
    };
  } catch (err) {
    if (typeof err.status === "number") {
      return {
        runnerFailure: false,
        exitCode: err.status,
        ...parseDetectorStdout(err.stdout ?? ""),
      };
    }
    return {
      runnerFailure: true,
      exitCode: null,
      message: err && err.message ? err.message : String(err),
    };
  }
}

// HYK-185-startcheck-wire: buildLogLine에서 분리(complexity 상한 준수) --
// 세 축(seat_*/idle_*/start_*)이 전부 같은 4필드 shape이므로 접두사만
// 바꿔 재사용한다.
function axisLogSegment(
  prefix,
  { status, verdict, worstCount, totalWorktrees },
) {
  const s = status ?? "NONE";
  const v = verdict ?? "NONE";
  const w = worstCount ?? "NONE";
  const t = totalWorktrees ?? "NONE";
  return `${prefix}_status=${s} ${prefix}_verdict=${v} ${prefix}_worst_count=${w} ${prefix}_worktrees=${t}`;
}

export function buildLogLine({ nowIso, detectorResult }) {
  if (detectorResult.runnerFailure) {
    return `${nowIso} RUNNER_FAILURE message=${detectorResult.message}`;
  }
  const verdict = detectorResult.verdict ?? "UNKNOWN";
  const reason = detectorResult.reasonCode ?? "NONE";
  const seatSegment = axisLogSegment("seat", {
    status: detectorResult.seatLivenessStatus,
    verdict: detectorResult.seatLivenessVerdict,
    worstCount: detectorResult.seatLivenessWorstCount,
    totalWorktrees: detectorResult.seatLivenessTotalWorktrees,
  });
  const idleSegment = axisLogSegment("idle", {
    status: detectorResult.seatIdleStatus,
    verdict: detectorResult.seatIdleVerdict,
    worstCount: detectorResult.seatIdleWorstCount,
    totalWorktrees: detectorResult.seatIdleTotalWorktrees,
  });
  const startSegment = axisLogSegment("start", {
    status: detectorResult.startStatus,
    verdict: detectorResult.startVerdict,
    worstCount: detectorResult.startWorstCount,
    totalWorktrees: detectorResult.startTotalWorktrees,
  });
  return `${nowIso} exit=${detectorResult.exitCode} verdict=${verdict} reason=${reason} ${seatSegment} ${idleSegment} ${startSegment}`;
}

function appendLogWithRotation({ readFn, writeFn, logPath, line, maxLines }) {
  let existing;
  try {
    existing = readFn(logPath, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.length ? existing.split(/\r?\n/).filter(Boolean) : [];
  lines.push(line);
  const kept =
    lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  writeFn(logPath, `${kept.join("\n")}\n`, "utf8");
}

// last-run.json은 원자적으로 쓴다(임시 파일 -> rename) -- 쓰다 죽어도
// 부분 파일이 "생존"으로 오독되지 않게 한다.
function writeAliveRecordAtomic({
  writeFn,
  renameFn,
  aliveRecordPath,
  record,
}) {
  const tmpPath = `${aliveRecordPath}.tmp-${process.pid}`;
  writeFn(tmpPath, JSON.stringify(record), "utf8");
  renameFn(tmpPath, aliveRecordPath);
}

// runWatchOnce(...) -- 한 번의 실행 사이클. 모든 I/O는 주입 가능(시험이
// 실제 fs/child_process를 건드리지 않고 스파이로 검증할 수 있게).
export function runWatchOnce({
  repoRoot,
  watchDir,
  nodePath = process.execPath,
  detectorPath = path.join(
    repoRoot,
    "scripts",
    "supervisor",
    "orch-stall-detect.mjs",
  ),
  execFn = defaultExec,
  now = Date.now(),
  maxLogLines = MAX_LOG_LINES,
  readFn = readFileSync,
  writeFn = writeFileSync,
  renameFn = renameSync,
  mkdirFn = mkdirSync,
}) {
  mkdirFn(watchDir, { recursive: true });
  const detectorResult = runDetector({
    execFn,
    nodePath,
    detectorPath,
    repoRoot,
  });
  const nowIso = new Date(now).toISOString();
  const logPath = path.join(watchDir, "watch.log");
  const aliveRecordPath = path.join(watchDir, "last-run.json");
  const line = buildLogLine({ nowIso, detectorResult });
  appendLogWithRotation({
    readFn,
    writeFn,
    logPath,
    line,
    maxLines: maxLogLines,
  });
  writeAliveRecordAtomic({
    writeFn,
    renameFn,
    aliveRecordPath,
    record: { recordedAtMs: now, ...detectorResult },
  });
  return { logPath, aliveRecordPath, line, detectorResult };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/watch-run.mjs");
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  let repoRoot = null;
  let watchDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--watch-dir") watchDir = argv[++i];
  }
  if (!repoRoot || !watchDir) {
    console.error("usage: watch-run.mjs --repo-root <path> --watch-dir <path>");
    process.exit(1);
  }
  const result = runWatchOnce({ repoRoot, watchDir });
  process.exit(result.detectorResult.runnerFailure ? 1 : 0);
}
