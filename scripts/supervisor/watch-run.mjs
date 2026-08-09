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
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { runReachOnce, DEFAULT_NOTIFY_DIR } from "./reach-report.mjs";
import { readConcurrencyCap } from "./concurrency-cap-adapter.mjs";
import { judgeConcurrency } from "./concurrency-core.mjs";

export const MAX_LOG_LINES = 5000;

function defaultExec(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// HYK-210-human-log-1 (coder-task.md §1-§2): HYK-207이 seatLiveness/
// dispatchStart 두 축의 워크트리별 판정에 실어 보내는 `correlation.
// partialFailures`(orca-adapter.mjs 단일 출처, §5 비타협 -- 여기서는
// 소비만 하고 생성부는 고치지 않는다)를 한 줄 로그에 옮겨 적기 위해
// 워크트리 배열 전체에서 모아 평탄화한다. 축 자체가 COLLECTION_FAILED
// 등으로 `worktrees`가 없거나 형식이 다르면 조용히 빈 배열([])을
// 낸다 -- 이 축의 실패 자체는 이미 status/verdict로 표면화되므로, 이
// 부가 정보 추출 실패가 로그 줄 조립 전체를 막아서는 안 된다.
function collectPartialFailures(axisRaw) {
  if (!isPlainObject(axisRaw) || !Array.isArray(axisRaw.worktrees)) return [];
  const collected = [];
  for (const wt of axisRaw.worktrees) {
    if (!isPlainObject(wt) || !isPlainObject(wt.correlation)) continue;
    const failures = wt.correlation.partialFailures;
    if (!Array.isArray(failures)) continue;
    for (const f of failures) {
      if (isPlainObject(f)) collected.push(f);
    }
  }
  return collected;
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
    // HYK-210-human-log-1: HYK-207이 correlation.partialFailures로 보존한
    // 좌석별 실패 사유를 buildLogLine이 로그 줄에 실을 수 있도록 평탄화해
    // 함께 옮긴다(§1 "마지막 한 조각").
    seatLivenessPartialFailures: collectPartialFailures(seatLiveness),
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
    // HYK-210-human-log-1: seatLiveness와 동일 이유 -- dispatchStart 축도
    // resolveObservationWithDeliveredSeatFallback을 거치므로 같은 모양의
    // correlation.partialFailures를 가질 수 있다(orch-stall-detect.mjs
    // judgeDispatchStartForRepo 참조).
    startPartialFailures: collectPartialFailures(dispatchStart),
  };
}

// HYK-185-unconsumed-1 (coder-task.md §2-3) -- «워커 결과가 소비됐는가»
// 축의 필드도 로그 줄에 옮겨 적는다. 기존 세 축(`seat_*`/`idle_*`/
// `start_*`)과 구별되게 `unconsumed_*` 접두를 쓴다(§2-1-1과 동일 "구별되는
// 이름" 원칙).
function extractUnconsumedFields(unconsumed) {
  return {
    unconsumedStatus:
      unconsumed && typeof unconsumed.status === "string"
        ? unconsumed.status
        : null,
    unconsumedVerdict:
      unconsumed && typeof unconsumed.verdict === "string"
        ? unconsumed.verdict
        : null,
    unconsumedWorstCount:
      unconsumed && typeof unconsumed.worstCount === "number"
        ? unconsumed.worstCount
        : null,
    unconsumedTotalWorktrees:
      unconsumed && typeof unconsumed.totalWorktrees === "number"
        ? unconsumed.totalWorktrees
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
    const unconsumed = isPlainObject(parsed.unconsumed)
      ? parsed.unconsumed
      : null;
    return {
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : null,
      reasonCode:
        typeof parsed.reasonCode === "string" ? parsed.reasonCode : null,
      ...extractSeatLivenessFields(seatLiveness),
      ...extractSeatIdleFields(seatIdle),
      ...extractDispatchStartFields(dispatchStart),
      ...extractUnconsumedFields(unconsumed),
    };
  } catch {
    return {
      verdict: null,
      reasonCode: null,
      seatLivenessStatus: null,
      seatLivenessVerdict: null,
      seatLivenessWorstCount: null,
      seatLivenessTotalWorktrees: null,
      seatLivenessPartialFailures: [],
      seatIdleStatus: null,
      seatIdleVerdict: null,
      seatIdleWorstCount: null,
      seatIdleTotalWorktrees: null,
      startStatus: null,
      startVerdict: null,
      startWorstCount: null,
      startTotalWorktrees: null,
      startPartialFailures: [],
      unconsumedStatus: null,
      unconsumedVerdict: null,
      unconsumedWorstCount: null,
      unconsumedTotalWorktrees: null,
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

// HYK-198-capwire-1 (coder-task.md §3) -- 값 파일(concurrency-cap.json,
// `readConcurrencyCap` 경유)과 판정 코어(`judgeConcurrency`)를 잇는 관측
// 전용 단계. §5 범위 밖(admission-core/HYK-195 미결) 때문에 이 감시기는
// "지금 몇 건이 진행 중인지" 담는 실행 장부를 아직 갖고 있지 않다
// (concurrency-core.mjs 헤더가 이미 선언: "실행 상태 장부의 위치·형식은
// 미정"). 그래서 `requested`/`inFlight` 기본값은 **감시기가 실제로 아는
// 것 = 0개**(지어낸 숫자가 아니라 이 관측 지점이 후보/진행중 항목을 하나도
// 들고 있지 않다는 구조적으로 참인 사실)로 고정한다 -- `policy.maxConcurrent`
// 도 이 라운드에서 별도로 관측된 값이 없으므로 방금 읽은 전역 상한 자체를
// 그대로 쓴다(코어가 이미 `min(policy.maxConcurrent, globalCap)`로 다시
// clamp하므로 이중으로 지어낸 제약을 얹지 않는다).
// `requested`/`inFlight`/`maxConcurrent`는 시험이 "값을 바꿔 넣으면 판정이
// 따라 움직이는가"(coder-task.md §4)를 코어 호출 지점에서 직접 증명할 수
// 있도록 주입 가능하게 열어 둔다 -- 운영 호출부(`runWatchOnce`)는 위 이유로
// 기본값(빈 배열)만 쓴다.
export function runCapObservationStep({
  capPath,
  readFn,
  requested = [],
  inFlight = [],
  maxConcurrent,
}) {
  const capResult = readConcurrencyCap({ capPath, readFn });
  if (!capResult.ok) {
    return {
      status: "CAP_READ_FAILED",
      verdict: capResult.reason,
      value: null,
      source: capPath,
    };
  }
  // HYK-198-capwire-2 §3(검토자 7번째 mutation) -- 이 기본값(`?? capResult.cap`)은
  // `decisions`로는 **원천적으로 관측 불가능**하다: 기본값이 항상
  // `capResult.cap`(=`globalCap`)과 같으므로 `effectiveCap =
  // min(policy.maxConcurrent, globalCap)`는 기본값이 무엇이든(999로
  // 바꿔도) `globalCap`으로 수렴한다 -- 이 clamp는 언제나 항등이다.
  // 그래서 실제로 어떤 값이 `judgeConcurrency`에 들어갔는지를
  // `appliedMaxConcurrent`로 직접 노출한다(값 추종 결과가 아니라 인자
  // 자체를 시험이 단언할 수 있게). 로그(`capLogSegment`)에는 싣지
  // 않는다 -- 프로덕션에서는 `value`(=cap)와 항상 같아 중복·소음이다.
  const appliedMaxConcurrent = maxConcurrent ?? capResult.cap;
  const judged = judgeConcurrency({
    requested,
    inFlight,
    policy: { maxConcurrent: appliedMaxConcurrent },
    globalCap: capResult.cap,
  });
  return {
    status: judged.ok ? "OK" : "CORE_REJECTED",
    verdict: judged.reasonCode,
    value: capResult.cap,
    source: capPath,
    decisions: judged.decisions,
    appliedMaxConcurrent,
  };
}

// HYK-210-human-log-1 (coder-task.md §2) -- 좌석별 실패 사유를 한 줄
// 로그에 사람이 읽을 수 있는 형태로 싣는다. 원문 사유(orca-adapter.mjs가
// 만드는 자유 텍스트, 공백·줄바꿈 포함 가능)를 그대로 실으면 ⓐ한 줄
// 로그의 필드 토큰 파서(reach-report-core.mjs parseFieldTokens, 공백
// 기준 분리)를 깨고 ⓑ여러 건이면 줄이 폭발한다(§2 비타협). 그래서
// 공백을 밑줄로 접고, 길이·건수를 상한(MAX_PARTIAL_FAILURE_REASON_CHARS/
// MAX_PARTIAL_FAILURE_ITEMS)으로 자른다 -- 잘린 나머지는 "+N_more"로
// 건수만 남긴다(원문을 지어내지 않는다).
const MAX_PARTIAL_FAILURE_ITEMS = 2;
const MAX_PARTIAL_FAILURE_REASON_CHARS = 60;

// ★"사람이 읽을 수 있는가"가 계약이다(coder-task.md §2/§4) -- reason이
// 문자열이 아니면(예: 원시 객체) `String(...)`으로 무심코 이어붙이면
// "[object Object]"가 찍힌다. typeof 가드로 그 경로 자체를 막고 대신
// 읽을 수 있는 대체 문구를 낸다.
function sanitizeFailureToken(raw, fallback) {
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  return raw.trim().replace(/\s+/g, "_");
}

function truncateToken(token, maxLen) {
  return token.length > maxLen ? `${token.slice(0, maxLen)}...` : token;
}

function formatPartialFailureEntry(failure) {
  const handle = sanitizeFailureToken(
    isPlainObject(failure) ? failure.handle : null,
    "unknown_handle",
  );
  const reason = truncateToken(
    sanitizeFailureToken(
      isPlainObject(failure) ? failure.reason : null,
      "reason_unavailable",
    ),
    MAX_PARTIAL_FAILURE_REASON_CHARS,
  );
  return `${handle}:${reason}`;
}

// failures가 비어 있으면(가장 흔한 경우 -- 좌석 조회가 전부 성공) 이
// 축의 로그 줄에 아무 것도 더하지 않는다(null -- buildLogLine이 걸러
// 낸다). 기존 정상 로그 줄 형식을 건드리지 않기 위함이다.
function failureLogSegment(prefix, failures) {
  if (!Array.isArray(failures) || failures.length === 0) return null;
  const shown = failures
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map(formatPartialFailureEntry);
  const omitted = failures.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `${prefix}_partial_failures=${failures.length} ${prefix}_partial_failure_detail=${detail}`;
}

// buildLogLine에서 분리(axisLogSegment와 같은 4필드 shape 관례 재사용,
// coder-task.md §1 "기존 axisLogSegment 관례를 따르고").
function capLogSegment(capResult) {
  const s = capResult.status ?? "NONE";
  const v = capResult.verdict ?? "NONE";
  const val = capResult.value ?? "NONE";
  const src = capResult.source ?? "NONE";
  return `cap_status=${s} cap_verdict=${v} cap_value=${val} cap_source=${src}`;
}

// runWatchOnce에서 분리(§6 eslint max-complexity 상한 준수) -- §5-4 계약
// 보존: 이 단계 자신의 실패(예: readFn이 예상외로 던짐)가 감시기 전체를
// 죽이면 안 된다. readConcurrencyCap/judgeConcurrency는 둘 다 throw로
// 판정을 대신하지 않는 fail-closed 계약이라 이 catch는 정상 경로에서는
// 도달하지 않지만, 방어적으로 감싼다(runDetector/runReachStep과 동일 원칙).
// 기본 capPath 계산도 별도 함수로 뺀다(§6 eslint max-complexity 상한 준수
// -- default parameter/`??`는 그 자체로 AssignmentPattern/LogicalExpression
// 분기로 잡혀 runWatchOnce의 복잡도에 더해진다, ESLint complexity.js 실측).
function resolveCapPath(repoRoot, capPath) {
  return (
    capPath ??
    path.join(repoRoot, "scripts", "supervisor", "concurrency-cap.json")
  );
}

function computeCapResult({ repoRoot, capPath, capReadFn }) {
  const resolvedCapPath = resolveCapPath(repoRoot, capPath);
  try {
    return runCapObservationStep({
      capPath: resolvedCapPath,
      readFn: capReadFn,
    });
  } catch (err) {
    return {
      status: "CAP_STEP_FAILURE",
      verdict: "UNDECIDABLE",
      value: null,
      source: resolvedCapPath,
      message: err && err.message ? err.message : String(err),
    };
  }
}

export function buildLogLine({ nowIso, detectorResult, capResult }) {
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
  const seatFailureSegment = failureLogSegment(
    "seat",
    detectorResult.seatLivenessPartialFailures,
  );
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
  const startFailureSegment = failureLogSegment(
    "start",
    detectorResult.startPartialFailures,
  );
  const unconsumedSegment = axisLogSegment("unconsumed", {
    status: detectorResult.unconsumedStatus,
    verdict: detectorResult.unconsumedVerdict,
    worstCount: detectorResult.unconsumedWorstCount,
    totalWorktrees: detectorResult.unconsumedTotalWorktrees,
  });
  const capSegment = capLogSegment(capResult ?? {});
  // HYK-210-human-log-1: 실패 세그먼트는 있을 때만 끼운다(filter(Boolean))
  // -- 정상 실행(실패 0건)의 로그 줄 모양은 이 라운드 전과 바이트 단위로
  // 동일하다(기존 소비자 회귀 0, coder-task.md §2-2).
  return [
    nowIso,
    `exit=${detectorResult.exitCode}`,
    `verdict=${verdict}`,
    `reason=${reason}`,
    seatSegment,
    seatFailureSegment,
    idleSegment,
    startSegment,
    startFailureSegment,
    unconsumedSegment,
    capSegment,
  ]
    .filter(Boolean)
    .join(" ");
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

// HYK-191-reach-1 -- watch.log/last-run.json을 다 쓴 다음, "사람에게
// 도달시키는" 축(reach-report.mjs)을 감싸서 부른다(§2-3과 동일 "감싸고
// 고치지 않는다" 원칙 재사용 -- reach-report.mjs 자신은 이 파일이 새로
// 만든 것이지만, 4축 판정 로직에는 손대지 않는다). ★notifyDir이 없으면
// (호출자가 명시적으로 주지 않으면) 이 단계는 아예 실행되지 않는다 --
// 기존 호출자(기존 시험 포함)는 아무 것도 바뀌지 않는다(회귀 0). reach
// 단계 자신의 실패(예: 받는함 경로 쓰기 실패)는 이 러너의 계약(로그
// 한 줄 + 생존 기록)을 절대 깨서는 안 되므로 여기서 삼킨다 -- v1은
// 로그만(§2-3 비타협)이라는 기존 원칙과 동일하게, reach 실패도 감시
// 자체를 멈추지 않는다.
function runReachStep({
  notifyDir,
  watchDir,
  now,
  readFn,
  writeFn,
  mkdirFn,
  existsFn,
  logPath,
}) {
  // ★"notRun"(이 단계가 아예 실행 안 됨) vs runReachOnce가 돌려주는
  // `skipped`(파싱 못한 로그 줄 수, 숫자)는 다른 이름공간이다 -- 이름
  // 충돌로 실행 여부 판정이 새는 것을 막는다.
  if (!notifyDir) return { notRun: true };
  try {
    return runReachOnce({
      watchLogPath: logPath,
      reportOutPath: path.join(watchDir, "morning-report.md"),
      statePath: path.join(watchDir, "reach-notify-state.json"),
      notifyDir,
      now,
      readFn,
      writeFn,
      mkdirFn,
      existsFn,
    });
  } catch (err) {
    return {
      notRun: false,
      failed: true,
      message: err && err.message ? err.message : String(err),
    };
  }
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
  existsFn = existsSync,
  notifyDir = null,
  capPath,
  capReadFn,
}) {
  mkdirFn(watchDir, { recursive: true });
  const detectorResult = runDetector({
    execFn,
    nodePath,
    detectorPath,
    repoRoot,
  });
  const capResult = computeCapResult({ repoRoot, capPath, capReadFn });
  const nowIso = new Date(now).toISOString();
  const logPath = path.join(watchDir, "watch.log");
  const aliveRecordPath = path.join(watchDir, "last-run.json");
  const line = buildLogLine({ nowIso, detectorResult, capResult });
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
  const reachResult = runReachStep({
    notifyDir,
    watchDir,
    now,
    readFn,
    writeFn,
    mkdirFn,
    existsFn,
    logPath,
  });
  return {
    logPath,
    aliveRecordPath,
    line,
    detectorResult,
    reachResult,
    capResult,
  };
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
  // HYK-191-reach-1: `--notify-dir`를 생략하면 실 통역 받는함(§CLI 기본값,
  // reach-report.mjs와 동일한 재량 -- 직접 실행할 때만 적용되는 기본값)을
  // 쓴다. `--no-reach`를 주면 reach 단계 자체를 끈다(기존 운영 결선을
  // 그대로 유지하고 싶을 때의 탈출구).
  let notifyDir = DEFAULT_NOTIFY_DIR;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--watch-dir") watchDir = argv[++i];
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
    else if (argv[i] === "--no-reach") notifyDir = null;
  }
  if (!repoRoot || !watchDir) {
    console.error("usage: watch-run.mjs --repo-root <path> --watch-dir <path>");
    process.exit(1);
  }
  const result = runWatchOnce({ repoRoot, watchDir, notifyDir });
  process.exit(result.detectorResult.runnerFailure ? 1 : 0);
}
