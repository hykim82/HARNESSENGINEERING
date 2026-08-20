// HYK-185 gap#69 (coder-task.md §5-C) -- 스케줄러가 실제로 부르는 러너.
//
// 하는 일 = orch-stall-detect.mjs를 **감싸서**(§2-3 비타협 -- 그 파일은
// 읽기 전용 계약이라 고치지 않는다) 실행 -> 결과를 로그 한 줄로 append
// -> 생존 기록(`last-run.json`)을 갱신한다. 그뿐이다.
//
// S11 필수(coder-task.md §5-E, 문구 그대로):
// 1. **증명한다**: 등록되면 이 감지는 ORCH 세션·에이전트와 무관하게 OS가
//    부른다 -- 이 파일은 `node`(자식 프로세스 spawn 포함)만으로 실행되며
//    에이전트 런타임 훅 호출이 없다. ★HYK-173-push-wire 갱신(§5-F "주장-구현
//    일치" -- 이 갱신 전에도 이미 부정확했다, seatLiveness 축이 이미
//    간접 orca 호출을 했다): 이 파일 자신은 orca를 spawn하지 않지만, 이
//    파일이 감싸 부르는 자식 프로세스(orch-stall-detect.mjs)는
//    seatLiveness/escalation 두 축에서 `orca-adapter.mjs`를 통해
//    간접적으로 `orca` CLI(터미널 조회·`orchestration check --peek`)를
//    부른다(G9, `orca-cli-boundary.mjs`가 "orca 문자열 리터럴 spawn은
//    adapter 안에서만" 강제 -- 이 파일도 그 자식 프로세스도 spawn 호출
//    자체는 adapter 밖에 없다). "Orca API 호출이 없다"는 더 이상 사실이
//    아니므로 이 줄을 고쳐 적는다.
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
  appendFileSync,
  renameSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { runReachOnce, DEFAULT_NOTIFY_DIR } from "./reach-report.mjs";
// HYK-255-watch-wire-1 (coder-task.md §1) -- 부분 계수 보고 «실파일» 생성을
// 감시 실행에 잇는다. 계수 로직은 새로 쓰지 않는다 -- 병합된 프로덕션 API
// (runPartialCountOnce)를 그대로 호출해 그 출력을 파일로 쓸 뿐이다.
import { runPartialCountOnce } from "./partial-count-report.mjs";
import { readConcurrencyCap } from "./concurrency-cap-adapter.mjs";
import { judgeConcurrency } from "./concurrency-core.mjs";
// HYK-173-push-wire (coder-task.md §5-D) -- shouldNotify는 이 러너가
// 부른다(orch-stall-detect.mjs가 아니다 -- 그 파일은 §2-3 비타협에 따라
// 부작용 0을 유지해야 하는데 dedupe는 상태 파일 쓰기가 필요하다). 판단
// 로직(escalation-state.mjs)은 여기서도 재구현하지 않고 그대로 부른다.
import { shouldNotify } from "../relay/escalation-state.mjs";
// HYK-228 (coder-task.md §2 항1) -- admission sweep의 "발동 주체"를 이
// 기존 주기 사이클에 얹는다(admission-sweep-wire.mjs 헤더의 설계 선택
// 근거 참조). ★opt-in만: `admissionSweep`을 호출자가 명시적으로 주지
// 않으면(기본값 null) 이 단계는 아예 실행되지 않는다 -- 기존 호출자
// (기존 시험 포함)는 아무 것도 바뀌지 않는다(§6/§7 회귀 0, notifyDir
// 패턴과 동일 원칙).
import { runAdmissionSweepTrigger } from "./admission-sweep-wire.mjs";
// HYK-270 (coder-task.md §5) -- 한도 정지 감지+통지 결선을 이 기존 주기
// 사이클에 얹는다(admission sweep과 동일한 opt-in 재량 -- notifyDir이
// 없으면 이 단계는 실행되지 않는다, §7 "새 알림 채널 0 -- 기존 통지
// 경로 재사용"). 판정 로직 자체는 재구현하지 않고 이미 만든
// rate-limit-stall-wire.mjs의 runRateLimitStallOnce를 그대로 부른다.
import { runRateLimitStallOnce } from "./rate-limit-stall-wire.mjs";
// HYK-285-always-1 (coder-task.md §1 "같은 자리에 같은 방식으로 붙인다") --
// 어제 병합된 각성 배선(wake-wire.mjs, HYK-285-wake-*)의 발동 주체를
// admissionSweep과 같은 opt-in 원칙으로 이 기존 주기에 얹는다. 판정·전송·
// 영수증·쿨다운 로직은 재구현하지 않고 wake-wire.mjs가 이미 내보내는
// runWakeOnce를 그대로 부른다(§2 비타협 1).
import { runWakeOnce, buildFakeExecFn } from "./wake-wire.mjs";
// activeRoundCount의 유일한 출처(§2-B 비타협 "상수·추정 금지") -- 이미
// admissionSweep 단계가 쓰는 원장 스토어/코어를 그대로 재사용한다(재구현
// 0). 쓰기는 하지 않는다(읽기 전용 -- withLedgerLock을 거치지 않는다,
// admission-sweep-wire.mjs의 CLI `status` 서브커맨드와 동일한 재량).
import { readLedgerUnlocked } from "./admission-ledger-store.mjs";
import { countActive, isWellFormedLedger } from "./admission-ledger-core.mjs";
// 실 좌석 전송(운영 --wake-live, 가짜 exec 시험 seam이 없을 때)에만
// 쓰인다 -- orca 문자열 리터럴 spawn은 이 adapter 안에서만 일어난다(G9).
import { createOrcaExecFn } from "../relay/adapters/orca-adapter.mjs";

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
    seatLivenessStatus: pickString(seatLiveness, "status"),
    seatLivenessVerdict: pickString(seatLiveness, "verdict"),
    seatLivenessWorstCount: pickNumber(seatLiveness, "worstCount"),
    seatLivenessTotalWorktrees: pickNumber(seatLiveness, "totalWorktrees"),
    // HYK-210-human-log-1: HYK-207이 correlation.partialFailures로 보존한
    // 좌석별 실패 사유를 buildLogLine이 로그 줄에 실을 수 있도록 평탄화해
    // 함께 옮긴다(§1 "마지막 한 조각").
    seatLivenessPartialFailures: collectPartialFailures(seatLiveness),
    // HYK-265-observe-split-1 (coder-task.md §3-1 항2): judgeSeatLivenessForRepo
    // 가 COLLECTION_FAILED일 때 이미 만드는 observationReason/reason(위
    // orch-stall-detect.mjs 수정으로 이제 top-level까지 올라온다)을 이
    // 러너가 로그 줄까지 옮긴다 -- "수집이 왜 실패했는지"가 사람이 보는
    // 기록(watch.log -> reach-report)까지 닿게 하는 것이 이 조각의 핵심.
    seatLivenessObservationReason: pickString(
      seatLiveness,
      "observationReason",
    ),
    seatLivenessReason: pickString(seatLiveness, "reason"),
  };
}

// HYK-185-seat-idle-1 (coder-task.md §2-1-3) -- «유휴 방치 좌석» 축의
// 필드도 로그 줄에 옮겨 적는다. seatLiveness와 이름이 구별되도록
// `seatIdle*` 접두를 쓴다(§2-1-1 "구별되는 이름" 비타협).
function extractSeatIdleFields(seatIdle) {
  return {
    seatIdleStatus: pickString(seatIdle, "status"),
    seatIdleVerdict: pickString(seatIdle, "verdict"),
    seatIdleWorstCount: pickNumber(seatIdle, "worstCount"),
    seatIdleTotalWorktrees: pickNumber(seatIdle, "totalWorktrees"),
    // HYK-265-observe-split-1: seatLiveness와 동일 이유(§3-1 항2).
    seatIdleObservationReason: pickString(seatIdle, "observationReason"),
    seatIdleReason: pickString(seatIdle, "reason"),
  };
}

// HYK-185-startcheck-wire (coder-task.md §2-1) -- «배달 후 시작됐는가»
// 축(orch-stall-detect.mjs의 dispatchStart, judgeDispatchStart 실호출
// 결과)도 로그 줄에 옮겨 적는다. 기존 두 축(`seat_*`/`idle_*`)과 구별되게
// `start_*` 접두를 쓴다(§2-1-1 "구별되는 이름" 비타협).
function extractDispatchStartFields(dispatchStart) {
  return {
    startStatus: pickString(dispatchStart, "status"),
    startVerdict: pickString(dispatchStart, "verdict"),
    startWorstCount: pickNumber(dispatchStart, "worstCount"),
    startTotalWorktrees: pickNumber(dispatchStart, "totalWorktrees"),
    // HYK-210-human-log-1: seatLiveness와 동일 이유 -- dispatchStart 축도
    // resolveObservationWithDeliveredSeatFallback을 거치므로 같은 모양의
    // correlation.partialFailures를 가질 수 있다(orch-stall-detect.mjs
    // judgeDispatchStartForRepo 참조).
    startPartialFailures: collectPartialFailures(dispatchStart),
    // HYK-265-observe-split-1: seatLiveness와 동일 이유(§3-1 항2).
    startObservationReason: pickString(dispatchStart, "observationReason"),
    startReason: pickString(dispatchStart, "reason"),
  };
}

// HYK-185-unconsumed-1 (coder-task.md §2-3) -- «워커 결과가 소비됐는가»
// 축의 필드도 로그 줄에 옮겨 적는다. 기존 세 축(`seat_*`/`idle_*`/
// `start_*`)과 구별되게 `unconsumed_*` 접두를 쓴다(§2-1-1과 동일 "구별되는
// 이름" 원칙).
function extractUnconsumedFields(unconsumed) {
  return {
    unconsumedStatus: pickString(unconsumed, "status"),
    unconsumedVerdict: pickString(unconsumed, "verdict"),
    unconsumedWorstCount: pickNumber(unconsumed, "worstCount"),
    unconsumedTotalWorktrees: pickNumber(unconsumed, "totalWorktrees"),
    // HYK-265-observe-split-1 (coder-task.md §3-1 항2): 이 축은
    // observationReason이 없고(judgeUnconsumedForRepo 참조) reason(자유
    // 텍스트)만 만든다.
    unconsumedReason: pickString(unconsumed, "reason"),
    // HYK-328-receipt-name-1 (coder-task.md §3): chain/bindingWorktreePath와
    // 같은 모양 -- 가장 나쁜 워크트리 하나의 경로(orch-stall-detect.mjs
    // judgeUnconsumedAcrossWorktrees의 worktreePath 그대로).
    unconsumedWorktreePath: pickString(unconsumed, "worktreePath"),
    // HYK-328-receipt-name-1: worstCount가 1보다 클 때(오늘 실측 2) 첫
    // 번째 하나만으로는 "어느 워크트리들 전부"인지 알 수 없었다 -- worst
    // 등급 워크트리 이름 전부(orch-stall-detect.mjs가 이미 계산해 두는
    // worstWorktreePaths, 위 코어 주석 참조). 배열이 아니면(구버전 감지기
    // stdout 등) null -- 필드 자체는 항상 존재한다(emptyDetectorFields도
    // 동일 키를 null로 둔다).
    unconsumedWorstWorktrees: pickStringArray(unconsumed, "worstWorktreePaths"),
  };
}

// HYK-328-receipt-name-1: pickString/pickNumber와 동일한 "형태가 아니면
// null" 원칙의 배열판 -- 문자열이 아닌 원소는 조용히 걸러낸다(사람이 읽는
// 로그 줄에 "[object Object]" 같은 게 새지 않게, sanitizeFailureToken과
// 동일 방어선의 앞단).
function pickStringArray(obj, key) {
  if (!obj || !Array.isArray(obj[key])) return null;
  return obj[key].filter((v) => typeof v === "string");
}

// HYK-173-push-wire (coder-task.md §4 요건2) -- escalation 축 필드도
// 기존 세 축과 동일한 4필드 관례로 옮겨 적는다. `scopes`(dedupeKey/
// transitionId/wakeHuman 등 원본 배열, orch-stall-detect.mjs
// judgeEscalationForRepo 참조)는 로그 문자열 필드로 직접 실리지 않고
// runEscalationDedupeStep(아래)의 입력으로만 쓰인다 -- watch.log 파서
// (reach-report-core.mjs parseFieldTokens)는 공백으로 분리된 key=value
// 토큰만 읽으므로 배열을 그 형식에 그대로 실을 수 없다(§4 요건2 "기존
// 필드·형식·파서는 불변" 비타협과 충돌하지 않기 위한 설계 선택).
function extractEscalationFields(escalation) {
  return {
    escalationStatus:
      escalation && typeof escalation.status === "string"
        ? escalation.status
        : null,
    escalationVerdict:
      escalation && typeof escalation.verdict === "string"
        ? escalation.verdict
        : null,
    escalationWorstCount:
      escalation && typeof escalation.worstCount === "number"
        ? escalation.worstCount
        : null,
    escalationTotalWorktrees:
      escalation && typeof escalation.totalWorktrees === "number"
        ? escalation.totalWorktrees
        : null,
    escalationScopes:
      escalation && Array.isArray(escalation.scopes) ? escalation.scopes : [],
  };
}

function pickString(obj, key) {
  return obj && typeof obj[key] === "string" ? obj[key] : null;
}
function pickNumber(obj, key) {
  return obj && typeof obj[key] === "number" ? obj[key] : null;
}

// HYK-212-postcheck-1 (coder-task.md §2/§4) -- «배달 직후 재조회
// 사후검증» 축 필드도 기존 관례(4필드)로 옮겨 적는다. 이 축은 §4 요건2
// (사유가 사람이 읽을 수 있게)를 만족시키려면 runtimeTaskId/harnessTaskId/
// worktreePath도 함께 옮겨야 한다(buildLogLine의 postcheckDetailSegment가
// 이 셋으로 사람이 읽는 상세 줄을 만든다).
function extractPostcheckFields(postcheck) {
  return {
    postcheckStatus: pickString(postcheck, "status"),
    postcheckVerdict: pickString(postcheck, "verdict"),
    postcheckWorstCount: pickNumber(postcheck, "worstCount"),
    postcheckTotalWorktrees: pickNumber(postcheck, "totalWorktrees"),
    postcheckRuntimeTaskId: pickString(postcheck, "runtimeTaskId"),
    postcheckHarnessTaskId: pickString(postcheck, "harnessTaskId"),
    postcheckWorktreePath: pickString(postcheck, "worktreePath"),
  };
}

// HYK-239-chain-wire-2 (coder-task.md §1) -- 원장 해시체인 위조 탐지 축
// 필드도 같은 4필드 관례로 옮겨 적는다. 위조가 확인됐을 때(TAMPER_DETECTED)
// 사람이 읽는 상세(어느 이슈·무슨 사유)를 위해 issueId/reason도 함께
// 옮긴다(postcheck의 runtimeTaskId/harnessTaskId/worktreePath와 같은 이유).
function extractChainFields(chain) {
  return {
    chainStatus: pickString(chain, "status"),
    chainVerdict: pickString(chain, "verdict"),
    chainWorstCount: pickNumber(chain, "worstCount"),
    chainTotalWorktrees: pickNumber(chain, "totalWorktrees"),
    chainIssueId: pickString(chain, "issueId"),
    chainReason: pickString(chain, "reason"),
    chainWorktreePath: pickString(chain, "worktreePath"),
  };
}

// HYK-240 요건3 (coder-task.md §3) -- 승인<->코드지문 결속 위반 축도 같은
// 4필드 관례로 옮겨 적는다. MISMATCH일 때 사람이 읽는 상세(어느 워크트리,
// 무슨 사유)를 위해 reason/worktreePath도 함께 옮긴다(chain의
// issueId/reason/worktreePath와 같은 이유 -- 이 축엔 issueId가 없다,
// review-approval-binding.mjs --explain은 이슈 단위가 아니라 워크트리
// 단위로 판정한다).
function extractBindingFields(binding) {
  return {
    bindingStatus: pickString(binding, "status"),
    bindingVerdict: pickString(binding, "verdict"),
    bindingWorstCount: pickNumber(binding, "worstCount"),
    bindingTotalWorktrees: pickNumber(binding, "totalWorktrees"),
    bindingReason: pickString(binding, "reason"),
    bindingWorktreePath: pickString(binding, "worktreePath"),
  };
}

// parseDetectorStdout에서 분리(§6 eslint max-lines-per-function 상한 준수 --
// HYK-240이 binding 필드를 추가하며 넘긴 만큼, 실패 시 반환하는 고정
// 기본값 뭉치를 그 함수 밖으로 뽑는다. 판정 로직은 없다 -- 파싱 실패를
// "축이 전부 관측 안 됨"으로 표현하는 상수 모양뿐이다.
function emptyDetectorFields() {
  return {
    verdict: null,
    reasonCode: null,
    seatLivenessStatus: null,
    seatLivenessVerdict: null,
    seatLivenessWorstCount: null,
    seatLivenessTotalWorktrees: null,
    seatLivenessPartialFailures: [],
    seatLivenessObservationReason: null,
    seatLivenessReason: null,
    seatIdleStatus: null,
    seatIdleVerdict: null,
    seatIdleWorstCount: null,
    seatIdleTotalWorktrees: null,
    seatIdleObservationReason: null,
    seatIdleReason: null,
    startStatus: null,
    startVerdict: null,
    startWorstCount: null,
    startTotalWorktrees: null,
    startPartialFailures: [],
    startObservationReason: null,
    startReason: null,
    unconsumedStatus: null,
    unconsumedVerdict: null,
    unconsumedWorstCount: null,
    unconsumedTotalWorktrees: null,
    unconsumedReason: null,
    unconsumedWorktreePath: null,
    unconsumedWorstWorktrees: null,
    escalationStatus: null,
    escalationVerdict: null,
    escalationWorstCount: null,
    escalationTotalWorktrees: null,
    escalationScopes: [],
    postcheckStatus: null,
    postcheckVerdict: null,
    postcheckWorstCount: null,
    postcheckTotalWorktrees: null,
    postcheckRuntimeTaskId: null,
    postcheckHarnessTaskId: null,
    postcheckWorktreePath: null,
    chainStatus: null,
    chainVerdict: null,
    chainWorstCount: null,
    chainTotalWorktrees: null,
    chainIssueId: null,
    chainReason: null,
    chainWorktreePath: null,
    bindingStatus: null,
    bindingVerdict: null,
    bindingWorstCount: null,
    bindingTotalWorktrees: null,
    bindingReason: null,
    bindingWorktreePath: null,
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
    const escalation = isPlainObject(parsed.escalation)
      ? parsed.escalation
      : null;
    const postcheck = isPlainObject(parsed.postcheck) ? parsed.postcheck : null;
    const chain = isPlainObject(parsed.chain) ? parsed.chain : null;
    const binding = isPlainObject(parsed.binding) ? parsed.binding : null;
    return {
      verdict: typeof parsed.verdict === "string" ? parsed.verdict : null,
      reasonCode:
        typeof parsed.reasonCode === "string" ? parsed.reasonCode : null,
      ...extractSeatLivenessFields(seatLiveness),
      ...extractSeatIdleFields(seatIdle),
      ...extractDispatchStartFields(dispatchStart),
      ...extractUnconsumedFields(unconsumed),
      ...extractEscalationFields(escalation),
      ...extractPostcheckFields(postcheck),
      ...extractChainFields(chain),
      ...extractBindingFields(binding),
    };
  } catch {
    return emptyDetectorFields();
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

// HYK-265-observe-split-1 (coder-task.md §3-1 항2, §4 완료조건2): 이 축이
// "수집 실패"(COLLECTION_FAILED -- observationReason/reason이 실제로
// 채워지는 유일한 status, orch-stall-detect.mjs의 judge*ForRepo 참조)일
// 때만 사람이 읽는 상세를 덧붙인다(chainDetailSegment/bindingDetailSegment
// 와 동일 원칙 -- 정상/판정불가는 4필드 세그먼트만으로 충분, 소음 최소화).
// observationReason(있으면, seat/idle/start만)과 reason을 함께 실어
// "왜 실패했는지"가 사람이 보는 기록까지 닿게 한다(HYK-265 배경 §2 실측:
// 이 값들이 지금까지 로그에 아예 실리지 않았다).
function reasonDetailSegment(
  prefix,
  collectionFailedStatus,
  { status, observationReason, reason },
) {
  if (status !== collectionFailedStatus) return null;
  const obsPart =
    typeof observationReason === "string" && observationReason.trim().length > 0
      ? `${sanitizeFailureToken(observationReason, "unknown_observation_reason")}:`
      : "";
  const why = truncateToken(
    sanitizeFailureToken(reason, "reason_unavailable"),
    MAX_PARTIAL_FAILURE_REASON_CHARS,
  );
  return `${prefix}_reason_detail=${obsPart}${why}`;
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

// ---- HYK-173-push-wire (coder-task.md §5-D) -- escalation dedupe ----
//
// shouldNotify(escalation-state.mjs)는 priorNotified를 호출자가 공급해야
// 하는 순수 함수인데, watch-run은 매 회차 새 프로세스라 메모리 집합이
// 회차를 못 넘는다 -- reach-notify-state.json과 같은 패턴(별도 상태
// 파일)을 재사용한다. 키 재료는 S1 실측 그대로 dedupeKey(taskId:
// dispatchId:state) + transitionId(id/sequence) -- shouldNotify 자신이
// 이 둘을 합쳐 키를 만든다(escalation-state.mjs를 고치지 않는다).
//
// computeEscalationNotifications: 순수 함수(시험 용이성) -- scopes(축
// 원본 배열) + priorNotifiedKeys(Set 또는 배열) -> {newlyNotified,
// nextKeys}. wakeHuman이 아닌 스코프는 애초에 통지 후보가 아니다(§4
// 요건3은 "wakeHuman인데 도달 안 됨"만 문제 삼는다 -- wake가 아닌 것을
// 통지하지 않는 것은 결함이 아니다).
export function computeEscalationNotifications({ scopes, priorNotifiedKeys }) {
  const priorSet =
    priorNotifiedKeys instanceof Set
      ? priorNotifiedKeys
      : new Set(Array.isArray(priorNotifiedKeys) ? priorNotifiedKeys : []);
  const nextKeys = new Set(priorSet);
  const newlyNotified = [];
  for (const s of Array.isArray(scopes) ? scopes : []) {
    if (!s || s.wakeHuman !== true) continue;
    const { notify, key } = shouldNotify(s.dedupeKey, s.transitionId, priorSet);
    if (notify && key) {
      newlyNotified.push(s);
      nextKeys.add(key);
    }
  }
  return { newlyNotified, nextKeys };
}

function readEscalationNotifyState(readFn, statePath) {
  try {
    const text = readFn(statePath, "utf8");
    const parsed = JSON.parse(text);
    return {
      keys: Array.isArray(parsed?.notifiedKeys) ? parsed.notifiedKeys : [],
      stateMissing: false,
    };
  } catch {
    // fail-open(§5-D 비타협): 상태 파일이 없거나 못 읽으면 "직전 상태
    // 없음"으로 접어 전부 재통지 후보로 취급한다 -- fail-closed는 침묵
    // 쪽 실패라 이 트랙이 잡으려는 실패를 dedupe 층에서 재생산한다.
    // 단 조용히 접지 않는다: stateMissing=true를 호출자에게 돌려주고,
    // 호출자(아래 runEscalationDedupeStep)가 로그 상세에 그 사실을
    // 남긴다.
    return { keys: [], stateMissing: true };
  }
}

// 이 축의 인박스는 저장소당이 아니라 ORCH 세션당 1개이므로 dedupe 상태도
// watchDir 하나에 저장한다(reach-notify-state.json과 나란히).
function runEscalationDedupeStep({
  scopes,
  watchDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  const statePath = path.join(watchDir, "escalation-notify-state.json");
  const prior = readEscalationNotifyState(readFn, statePath);
  const { newlyNotified, nextKeys } = computeEscalationNotifications({
    scopes,
    priorNotifiedKeys: prior.keys,
  });
  try {
    if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
    writeFn(
      statePath,
      JSON.stringify({ notifiedKeys: Array.from(nextKeys) }),
      "utf8",
    );
  } catch {
    // 상태 저장 자체의 실패는 이 러너의 계약(로그 한 줄 + 생존 기록)을
    // 깨서는 안 된다(§2-3과 동일 원칙, runReachStep과 대칭) -- 저장이
    // 안 되면 다음 회차에 fail-open으로 다시 전부 재통지될 뿐이다.
  }
  return { newlyNotified, stateMissing: prior.stateMissing };
}

// escalation 축의 사람이 읽는 사유(§4 요건2 "막힌 워커가 있으면 사유가
// 사람이 읽을 수 있게 실려야 한다", HYK-210 전례와 동일 형식 -- 공백
// 치환·길이 상한·건수 상한+N_more). wakeHuman 스코프 전부(새 것이든
// 이미 통지된 것이든)를 보여준다 -- "지금도 열려 있다"는 사실 자체가
// 사람에게 유용하다(reach-report-core.mjs의 "지금 열려 있는 이상"과
// 같은 원칙). newlyNotified에 포함된 항목은 NEW: 접두를 붙인다.
function formatEscalationEntry(scope, isNew) {
  const taskId = sanitizeFailureToken(scope?.scope?.taskId, "unknown_task");
  const dispatchId = sanitizeFailureToken(
    scope?.scope?.dispatchId,
    "unknown_dispatch",
  );
  const reasonRaw = scope?.sampleSubject || scope?.sampleBody;
  const reason = truncateToken(
    sanitizeFailureToken(reasonRaw, "reason_unavailable"),
    MAX_PARTIAL_FAILURE_REASON_CHARS,
  );
  const prefix = isNew ? "NEW:" : "";
  return `${prefix}${taskId}/${dispatchId}:${reason}`;
}

// HYK-212-postcheck-1 (coder-task.md §4 요건2 "코드값만 찍고 끝내지
// 마라 -- 어느 태스크·어느 좌석인지 포함") -- RECORD_MISSING일 때만
// 사람이 읽는 상세를 덧붙인다(정상/판단대상아님/조회실패는 4필드
// 세그먼트만으로 충분 -- 소음 최소화, HYK-210 escalationDetailSegment와
// 동일 원칙).
function postcheckDetailSegment({
  verdict,
  runtimeTaskId,
  harnessTaskId,
  worktreePath,
}) {
  if (verdict !== "RECORD_MISSING") return null;
  const task = sanitizeFailureToken(harnessTaskId, "unknown_task");
  const runtime = sanitizeFailureToken(runtimeTaskId, "unknown_runtime_task");
  const wt = sanitizeFailureToken(worktreePath, "unknown_worktree");
  return `postcheck_detail=${task}/${runtime}@${wt}`;
}

// buildLogLine에서 분리(§6 eslint max-lines-per-function 상한 준수 --
// escalation 세그먼트 조립과 대칭 위치를 이 함수 하나로 옮긴다).
function buildPostcheckSegments(detectorResult) {
  return {
    postcheckSegment: axisLogSegment("postcheck", {
      status: detectorResult.postcheckStatus,
      verdict: detectorResult.postcheckVerdict,
      worstCount: detectorResult.postcheckWorstCount,
      totalWorktrees: detectorResult.postcheckTotalWorktrees,
    }),
    postcheckDetail: postcheckDetailSegment({
      verdict: detectorResult.postcheckVerdict,
      runtimeTaskId: detectorResult.postcheckRuntimeTaskId,
      harnessTaskId: detectorResult.postcheckHarnessTaskId,
      worktreePath: detectorResult.postcheckWorktreePath,
    }),
  };
}

// HYK-239-chain-wire-2 (coder-task.md §1 요건2 "코드값만 찍고 끝내지
// 마라") -- TAMPER_DETECTED일 때만 사람이 읽는 상세를 덧붙인다(postcheck의
// postcheckDetailSegment와 동일 원칙 -- 정상/판정불가는 4필드 세그먼트만
// 으로 충분, 소음 최소화).
function chainDetailSegment({ verdict, issueId, reason, worktreePath }) {
  if (verdict !== "TAMPER_DETECTED") return null;
  const issue = sanitizeFailureToken(issueId, "unknown_issue");
  const why = truncateToken(
    sanitizeFailureToken(reason, "reason_unavailable"),
    MAX_PARTIAL_FAILURE_REASON_CHARS,
  );
  const wt = sanitizeFailureToken(worktreePath, "unknown_worktree");
  return `chain_detail=${issue}@${wt}:${why}`;
}

// buildLogLine에서 분리(postcheck와 동일 위치/이유).
function buildChainSegments(detectorResult) {
  return {
    chainSegment: axisLogSegment("chain", {
      status: detectorResult.chainStatus,
      verdict: detectorResult.chainVerdict,
      worstCount: detectorResult.chainWorstCount,
      totalWorktrees: detectorResult.chainTotalWorktrees,
    }),
    chainDetail: chainDetailSegment({
      verdict: detectorResult.chainVerdict,
      issueId: detectorResult.chainIssueId,
      reason: detectorResult.chainReason,
      worktreePath: detectorResult.chainWorktreePath,
    }),
  };
}

// HYK-240 요건3 (coder-task.md §3 "코드값만 찍고 끝내지 마라") -- MISMATCH일
// 때만 사람이 읽는 상세를 덧붙인다(chainDetailSegment와 동일 원칙).
function bindingDetailSegment({ verdict, reason, worktreePath }) {
  if (verdict !== "MISMATCH") return null;
  const why = truncateToken(
    sanitizeFailureToken(reason, "reason_unavailable"),
    MAX_PARTIAL_FAILURE_REASON_CHARS,
  );
  const wt = sanitizeFailureToken(worktreePath, "unknown_worktree");
  return `binding_detail=${wt}:${why}`;
}

// buildLogLine에서 분리(chain과 동일 위치/이유).
function buildBindingSegments(detectorResult) {
  return {
    bindingSegment: axisLogSegment("binding", {
      status: detectorResult.bindingStatus,
      verdict: detectorResult.bindingVerdict,
      worstCount: detectorResult.bindingWorstCount,
      totalWorktrees: detectorResult.bindingTotalWorktrees,
    }),
    bindingDetail: bindingDetailSegment({
      verdict: detectorResult.bindingVerdict,
      reason: detectorResult.bindingReason,
      worktreePath: detectorResult.bindingWorktreePath,
    }),
  };
}

function escalationDetailSegment({ wakeScopes, newlyNotified, stateMissing }) {
  if (!Array.isArray(wakeScopes) || wakeScopes.length === 0) return null;
  const newKeys = new Set(
    (Array.isArray(newlyNotified) ? newlyNotified : []).map((s) => s.dedupeKey),
  );
  const shown = wakeScopes
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map((s) => formatEscalationEntry(s, newKeys.has(s.dedupeKey)));
  const omitted = wakeScopes.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  // §5-D 비타협: 상태 파일 읽기 실패 자체를 조용히 접지 않는다 -- dedupe
  // 상태가 없어 전부 재통지 후보로 취급됐을 수 있음을 사람이 읽는 상세
  // 문면에 명시한다.
  const dedupeNote = stateMissing ? " escalation_dedupe_state=MISSING" : "";
  return `escalation_open=${wakeScopes.length} escalation_detail=${detail}${dedupeNote}`;
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

// HYK-228 4R (coder-task.md §1 항3/§2): buildLogLine에서 세그먼트 조립부만
// 추출(max-lines-per-function 수리) -- 각 세그먼트의 축·필드·순서·값은
// 원문 그대로, 호출 순서만 옮겼다(동작 무변경, node --test 수치로 증명).
// HYK-265-observe-split-1 (§6 eslint max-lines-per-function 상한 준수 --
// buildAxisLogSegments가 seat/idle/start/unconsumed 네 축에 reasonDetail을
// 추가하며 상한을 넘겼다) -- seat+idle 두 축의 4필드 세그먼트 +
// partial-failure 세그먼트(seat만) + reasonDetail 세그먼트 조립을 여기로
// 뽑는다. 세그먼트의 필드·순서·값은 원문 그대로(동작 무변경).
function buildSeatIdleSegments(detectorResult) {
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
  const seatReasonDetail = reasonDetailSegment(
    "seat",
    "SEAT_LIVENESS_COLLECTION_FAILED",
    {
      status: detectorResult.seatLivenessStatus,
      observationReason: detectorResult.seatLivenessObservationReason,
      reason: detectorResult.seatLivenessReason,
    },
  );
  const idleSegment = axisLogSegment("idle", {
    status: detectorResult.seatIdleStatus,
    verdict: detectorResult.seatIdleVerdict,
    worstCount: detectorResult.seatIdleWorstCount,
    totalWorktrees: detectorResult.seatIdleTotalWorktrees,
  });
  const idleReasonDetail = reasonDetailSegment(
    "idle",
    "SEAT_IDLE_COLLECTION_FAILED",
    {
      status: detectorResult.seatIdleStatus,
      observationReason: detectorResult.seatIdleObservationReason,
      reason: detectorResult.seatIdleReason,
    },
  );
  return {
    seatSegment,
    seatFailureSegment,
    seatReasonDetail,
    idleSegment,
    idleReasonDetail,
  };
}

// buildSeatIdleSegments와 대칭(start+unconsumed 두 축, §6 상한 준수를
// 위해 같은 이유로 분리).
function buildStartUnconsumedSegments(detectorResult) {
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
  const startReasonDetail = reasonDetailSegment(
    "start",
    "DISPATCH_START_COLLECTION_FAILED",
    {
      status: detectorResult.startStatus,
      observationReason: detectorResult.startObservationReason,
      reason: detectorResult.startReason,
    },
  );
  const unconsumedSegment = axisLogSegment("unconsumed", {
    status: detectorResult.unconsumedStatus,
    verdict: detectorResult.unconsumedVerdict,
    worstCount: detectorResult.unconsumedWorstCount,
    totalWorktrees: detectorResult.unconsumedTotalWorktrees,
  });
  const unconsumedReasonDetail = reasonDetailSegment(
    "unconsumed",
    "UNCONSUMED_COLLECTION_FAILED",
    {
      status: detectorResult.unconsumedStatus,
      observationReason: null,
      reason: detectorResult.unconsumedReason,
    },
  );
  const unconsumedWorstDetail = unconsumedWorstSegment(
    detectorResult.unconsumedWorstWorktrees,
  );
  return {
    startSegment,
    startFailureSegment,
    startReasonDetail,
    unconsumedSegment,
    unconsumedReasonDetail,
    unconsumedWorstDetail,
  };
}

// HYK-328-receipt-name-1 (coder-task.md §3 항2) -- failureLogSegment/
// escalationDetailSegment와 동일한 "상한 + N_more" 관례(이 파일 안의 기존
// 전례를 그대로 재사용, 새 형식을 발명하지 않는다). worst 등급 워크트리가
// 없으면(빈 배열/미제공) 세그먼트 자체를 안 붙인다 -- 정상 상태의 로그
// 줄을 조용히 유지하는 기존 원칙(§2-3)과 동일.
function unconsumedWorstSegment(worstWorktrees) {
  if (!Array.isArray(worstWorktrees) || worstWorktrees.length === 0) {
    return null;
  }
  const shown = worstWorktrees
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map(worktreeShortName);
  const omitted = worstWorktrees.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `unconsumed_worst_worktrees=${worstWorktrees.length} unconsumed_worst_worktree_detail=${detail}`;
}

// 사람이 워크트리를 특정할 수 있으면서도 로그 줄을 폭발시키지 않도록
// 전체 경로가 아니라 마지막 폴더명만 쓴다(전체 경로는 last-run.json의
// unconsumedWorstWorktrees/unconsumedWorktreePath에 이미 그대로 남는다 --
// 로그 줄은 사람이 훑어보는 요약, JSON은 기계가 읽는 정본이라는 기존
// 역할 분담과 동일).
function worktreeShortName(rawPath) {
  const token = sanitizeFailureToken(rawPath, "unknown_worktree");
  const parts = token.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : token;
}

function buildSeatIdleStartUnconsumedSegments(detectorResult) {
  return {
    ...buildSeatIdleSegments(detectorResult),
    ...buildStartUnconsumedSegments(detectorResult),
  };
}

function buildAxisLogSegments(detectorResult, capResult, escalationDedupe) {
  const {
    seatSegment,
    seatFailureSegment,
    seatReasonDetail,
    idleSegment,
    idleReasonDetail,
    startSegment,
    startFailureSegment,
    startReasonDetail,
    unconsumedSegment,
    unconsumedReasonDetail,
    unconsumedWorstDetail,
  } = buildSeatIdleStartUnconsumedSegments(detectorResult);
  const capSegment = capLogSegment(capResult ?? {});
  // HYK-173-push-wire (coder-task.md §4 요건2): escalation 축도 기존
  // 4필드 관례 그대로(escalation_status/escalation_verdict/
  // escalation_worst_count/escalation_worktrees) -- 새 축이지만 새
  // 형식은 만들지 않는다(§5-E, 기존 세 축과 동형). wakeScopes가 있으면
  // 사람이 읽는 상세(escalation_open/escalation_detail)도 덧붙인다(§4
  // 요건2 "사유가 사람이 읽을 수 있게").
  const escalationSegment = axisLogSegment("escalation", {
    status: detectorResult.escalationStatus,
    verdict: detectorResult.escalationVerdict,
    worstCount: detectorResult.escalationWorstCount,
    totalWorktrees: detectorResult.escalationTotalWorktrees,
  });
  const wakeScopes = (detectorResult.escalationScopes ?? []).filter(
    (s) => s && s.wakeHuman === true,
  );
  const escalationDetail = escalationDetailSegment({
    wakeScopes,
    newlyNotified: escalationDedupe?.newlyNotified ?? [],
    stateMissing: escalationDedupe?.stateMissing ?? false,
  });
  // HYK-212-postcheck-1: 새 축은 언제나 맨 끝에 붙는다(기존 여섯
  // 세그먼트의 필드·순서·값 불변, §7-7/§6 기존 축 회귀 0).
  const { postcheckSegment, postcheckDetail } =
    buildPostcheckSegments(detectorResult);
  // HYK-239-chain-wire-2: 새 축은 언제나 맨 끝에 붙는다(§1 설계 제약 3 --
  // 기존 여섯+postcheck+sweep 세그먼트의 필드·순서·값 불변).
  const { chainSegment, chainDetail } = buildChainSegments(detectorResult);
  // HYK-240 요건3: 새 축은 언제나 맨 끝에 붙는다(§1 설계 제약 3 -- 기존
  // 여섯+postcheck+chain 세그먼트의 필드·순서·값 불변).
  const { bindingSegment, bindingDetail } =
    buildBindingSegments(detectorResult);
  return {
    seatSegment,
    seatFailureSegment,
    seatReasonDetail,
    idleSegment,
    idleReasonDetail,
    startSegment,
    startFailureSegment,
    startReasonDetail,
    unconsumedSegment,
    unconsumedReasonDetail,
    unconsumedWorstDetail,
    capSegment,
    escalationSegment,
    escalationDetail,
    postcheckSegment,
    postcheckDetail,
    chainSegment,
    chainDetail,
    bindingSegment,
    bindingDetail,
  };
}

// wakeLogSegment -- HYK-285-always-1 (coder-task.md §2-C): sweepLogSegment/
// chainSegment와 동일한 "이번 회차에 실제로 돌았을 때만 세그먼트를
// 더한다" 원칙. 필드 이름은 §2-C 원문 그대로(wake_status=/wake_verdict=/
// wake_sent=) -- 기존 필드 이름·순서·값 표현은 건드리지 않고 맨 끝에
// 추가만 한다(§2-C 비타협).
function wakeLogSegment(wakeResult) {
  if (!wakeResult || wakeResult.notRun) return null;
  const status = wakeResult.status ?? "NONE";
  const verdict = wakeResult.verdict ?? "NONE";
  const sent = wakeResult.sent === true ? "true" : "false";
  return `wake_status=${status} wake_verdict=${verdict} wake_sent=${sent}`;
}

export function buildLogLine({
  nowIso,
  detectorResult,
  capResult,
  escalationDedupe,
  sweepResult,
  wakeResult,
}) {
  if (detectorResult.runnerFailure) {
    return `${nowIso} RUNNER_FAILURE message=${detectorResult.message}`;
  }
  const verdict = detectorResult.verdict ?? "UNKNOWN";
  const reason = detectorResult.reasonCode ?? "NONE";
  const segments = buildAxisLogSegments(
    detectorResult,
    capResult,
    escalationDedupe,
  );
  // HYK-228 (coder-task.md §2 항1): 새 축은 언제나 맨 끝에 붙는다(기존
  // 여섯+postcheck 세그먼트의 필드·순서·값 불변, §7 기존 축 회귀 0) --
  // admissionSweep이 주어지지 않은 기존 호출자는 sweepLogSegment가 null을
  // 돌려주므로(filter(Boolean)) 로그 줄이 한 글자도 달라지지 않는다.
  return [
    nowIso,
    `exit=${detectorResult.exitCode}`,
    `verdict=${verdict}`,
    `reason=${reason}`,
    segments.seatSegment,
    segments.seatFailureSegment,
    segments.seatReasonDetail,
    segments.idleSegment,
    segments.idleReasonDetail,
    segments.startSegment,
    segments.startFailureSegment,
    segments.startReasonDetail,
    segments.unconsumedSegment,
    segments.unconsumedReasonDetail,
    segments.unconsumedWorstDetail,
    segments.capSegment,
    segments.escalationSegment,
    segments.escalationDetail,
    segments.postcheckSegment,
    segments.postcheckDetail,
    sweepLogSegment(sweepResult),
    // HYK-239-chain-wire-2 (coder-task.md §1 설계 제약 3): 이 축은 지금
    // 이 시점의 맨 끝이다 -- 앞선 모든 세그먼트의 필드·순서·값은 이
    // 라운드가 손대지 않았다(§4-3 무회귀로 실증).
    segments.chainSegment,
    segments.chainDetail,
    // HYK-240 요건3 (coder-task.md §3 설계 제약 3): 이 축은 지금 이
    // 시점의 맨 끝이다 -- 앞선 모든 세그먼트의 필드·순서·값은 이
    // 라운드가 손대지 않았다.
    segments.bindingSegment,
    segments.bindingDetail,
    // HYK-285-always-1 (coder-task.md §1 설계 제약과 동일 원칙): 이 축은
    // 지금 이 시점의 맨 끝이다 -- 앞선 모든 세그먼트의 필드·순서·값은
    // 이 라운드가 손대지 않았다. wake가 opt-in으로 주어지지 않은 기존
    // 호출자는 wakeLogSegment가 null을 돌려주므로(filter(Boolean)) 로그
    // 줄이 한 글자도 달라지지 않는다(§2-A 회귀 0).
    wakeLogSegment(wakeResult),
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

// HYK-270 (coder-task.md §5) -- 한도 정지 감지+통지 단계.
// runReachStep과 대칭: `notifyDir`이 없으면 아예 실행하지 않는다(opt-in,
// §7 "새 알림 채널 0" -- 기존 notifyDir을 그대로 재사용할 때만 동작).
// 이 단계 자신의 실패(예외)는 감시 사이클 전체를 죽이지 않는다 -- 다른
// 축이 이미 이 원칙을 쓰고 있다(runReachStep과 동일 catch 형태).
function runRateLimitStallStep({
  repoRoot,
  notifyDir,
  watchDir,
  now,
  readFn,
  writeFn,
  mkdirFn,
  existsFn,
}) {
  if (!notifyDir) return { notRun: true };
  try {
    return runRateLimitStallOnce({
      repoRoot,
      watchDir,
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

// HYK-255-watch-wire-1 (coder-task.md §1 항1) -- 부분 계수 보고 파일 생성
// 단계. runWatchOnce/runWatchOnceCore(동기 계약 -- 다수 기존 호출자·기존
// 시험이 동기 반환을 기대한다, §2 비타협3 회귀 0)와 같은 함수 안에 넣지
// 않는다: runPartialCountOnce는 GitHub REST 조회(ㄱ-4)가 있어 비동기다.
// 그래서 이 단계는 별도 함수로 분리해 CLI 진입점에서만 await한다.
//
// ⛔관제실 절대경로를 코드에 박지 않는다(§1 항1) -- 출력 경로는 호출자가
// 주는 `watchDir`에서 파생한다(기본값 = watchDir/partial-count-report.md,
// reach-report.mjs의 partialCountPath 기본값과 동일한 상대 위치).
//
// ⛔조용한 생략 금지(§1 항2) -- 생성 실패는 ⓐ감시 로그(`logPath`가 주어지면
// watch.log)에 한 줄로 남고 ⓑ파일을 쓰지 않으므로 아침 보고는 여전히
// UNKNOWN이며(reach-report.mjs readPartialCountSection이 이미 그렇게
// 처리한다 -- 숫자를 지어내지 않는다) ⓒ이 단계 자신의 실패가 감시 실행
// 전체를 죽이지 않는다(throw하지 않고 항상 결과 객체를 반환, runReachStep과
// 동일 원칙).
// HYK-255-watch-wire-3 (coder-task.md §1) -- eslint complexity(상한 12)
// 위반 수리. `runPartialCountStep`의 실측 복잡도 15는 실행 분기가 아니라
// **기본 파라미터 8개**가 대부분이었다(ESLint complexity.js는 기본
// 파라미터 각각을 분기 하나로 센다 -- 위 `resolveWatchOnceFsFns`의
// HYK-228 5R 주석과 동일 실측). 그래서 그 8개의 기본값 해석만 이 함수로
// 뽑는다 -- 로직·순서·값은 원문과 완전히 동일하고, `undefined`일 때만
// 기본값을 쓰는 것도 그대로다(`??`는 `null`도 기본값으로 바꿔버려 의미가
// 달라진다 -- `resolveWatchOnceFsFns`와 같은 이유로 피한다).
function resolvePartialCountStepDefaults({
  watchDir,
  partialCountOut,
  runPartialCountOnceFn,
  writeFn,
  readFn,
  mkdirFn,
  existsFn,
  maxLogLines,
  options,
}) {
  return {
    partialCountOut:
      partialCountOut === undefined
        ? path.join(watchDir, "partial-count-report.md")
        : partialCountOut,
    runPartialCountOnceFn:
      runPartialCountOnceFn === undefined
        ? runPartialCountOnce
        : runPartialCountOnceFn,
    writeFn: writeFn === undefined ? writeFileSync : writeFn,
    readFn: readFn === undefined ? readFileSync : readFn,
    mkdirFn: mkdirFn === undefined ? mkdirSync : mkdirFn,
    existsFn: existsFn === undefined ? existsSync : existsFn,
    maxLogLines: maxLogLines === undefined ? MAX_LOG_LINES : maxLogLines,
    options: options === undefined ? {} : options,
  };
}

// runPartialCountStepCore -- 원래 `runPartialCountStep`의 본문 그 자체
// (기본값 해석을 뺀 나머지, HYK-255-watch-wire-3). 모든 파라미터는 이미
// 해석된 값이며 기본값을 갖지 않는다(complexity를 늘리지 않는다) --
// 로직·순서·값·반환 모양(`{ran, ok, message}`)·실패 로그 문면
// (`PARTIAL_COUNT_STEP_FAILED`)은 원문 그대로.
async function runPartialCountStepCore({
  now,
  partialCountOut,
  runPartialCountOnceFn,
  writeFn,
  readFn,
  mkdirFn,
  existsFn,
  logPath,
  maxLogLines,
  options,
}) {
  try {
    const result = await runPartialCountOnceFn({ now, ...options });
    const dir = path.dirname(partialCountOut);
    if (!existsFn(dir)) mkdirFn(dir, { recursive: true });
    writeFn(partialCountOut, result.reportText, "utf8");
    return { ran: true, ok: true, partialCountOut };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (logPath) {
      try {
        appendLogWithRotation({
          readFn,
          writeFn,
          logPath,
          line: `${new Date(now).toISOString()} PARTIAL_COUNT_STEP_FAILED message=${message}`,
          maxLines: maxLogLines,
        });
      } catch {
        // 로그 실패는 이 단계 계약을 깨지 않는다(runReachStep과 동일 원칙).
      }
    }
    return { ran: true, ok: false, message };
  }
}

export async function runPartialCountStep({
  watchDir,
  now,
  partialCountOut,
  runPartialCountOnceFn,
  writeFn,
  readFn,
  mkdirFn,
  existsFn,
  logPath,
  maxLogLines,
  options,
}) {
  const resolved = resolvePartialCountStepDefaults({
    watchDir,
    partialCountOut,
    runPartialCountOnceFn,
    writeFn,
    readFn,
    mkdirFn,
    existsFn,
    maxLogLines,
    options,
  });
  return runPartialCountStepCore({ now, logPath, ...resolved });
}

// runSweepStep -- admission sweep 트리거 단계(coder-task §2 항1). 이
// 단계 자신의 실패가 이 러너의 계약(로그 한 줄 + 생존 기록)을 깨서는
// 안 된다(runReachStep/computeCapResult와 동일 원칙 -- v1은 로그만).
// `admissionSweep`이 없으면(기본값, 대부분의 호출자) 아예 실행하지
// 않고 `{notRun:true}`를 돌려준다 -- 로그 줄에 아무 세그먼트도 더하지
// 않는다(회귀 0).
function runSweepStep({ admissionSweep, sweepExecFn, now }) {
  if (
    !admissionSweep ||
    !admissionSweep.ledgerPath ||
    !admissionSweep.lockPath
  ) {
    return { notRun: true };
  }
  try {
    const result = runAdmissionSweepTrigger({
      ledgerPath: admissionSweep.ledgerPath,
      lockPath: admissionSweep.lockPath,
      staleAfterMs: admissionSweep.staleAfterMs,
      recoveryGraceMs: admissionSweep.recoveryGraceMs,
      execFn: sweepExecFn,
      now: new Date(now).toISOString(),
    });
    return { notRun: false, ...result };
  } catch (err) {
    return {
      notRun: false,
      ok: false,
      status: "SWEEP_TRIGGER_RUNNER_FAILURE",
      reasonCode: "RUNNER_THREW",
      message: err && err.message ? err.message : String(err),
    };
  }
}

// sweepLogSegment -- admissionSweep이 이 회차에 실제로 돌았을 때만 로그
// 줄에 한 세그먼트를 더한다(기존 세그먼트와 동일한 "사람이 읽는 사유"
// 원칙 -- status/reasonCode/회수 건수).
function sweepLogSegment(sweepResult) {
  if (!sweepResult || sweepResult.notRun) return null;
  const status = sweepResult.status ?? "NONE";
  const reason = sweepResult.reasonCode ?? "NONE";
  const recovered = Array.isArray(sweepResult.changed)
    ? sweepResult.changed.length
    : "NONE";
  return `sweep_status=${status} sweep_reason=${reason} sweep_recovered=${recovered}`;
}

// sweepRecordField -- coder-r2 rejection-2 (review-r1.md §B): watch.log의
// 로그 줄만으로는 "사이클은 돌았지만 수거 단계 자신이 죽었다"를 last-run.
// json 소비자(신선도 판정)가 알 수 없었다 -- 로그는 사람이 읽는 트레일일
// 뿐, judgeWatchFreshness는 last-run.json만 본다. 그래서 이 필드를
// `record`(last-run.json에 그대로 쓰이는 객체)에도 심는다.
//
// `watch-freshness-core.mjs`의 계약은 건드리지 않는다(coder-r2 지시 그대로)
// -- `isValidLastRun`은 `recordedAtMs`만 검사하므로(그 파일 §57-60 참조)
// 이 형제 필드는 그 함수에 아무 영향도 주지 않는다(실측: 아래 새 코어의
// 시험이 기존 watch-freshness-core.test.mjs 스위트와 별개로 이를 재확인).
//
// 모양은 admission-sweep-freshness-core.mjs가 기대하는 것과 1:1로
// 맞춘다: `{ran:false}`(sweep 미설정, 기존 호출자 대다수) 또는
// `{ran:true, ok, status, reasonCode}`(sweep이 이 회차에 실제로 돌았음 --
// ok:false는 수거 자체의 실패, ok:true + 아래 changedCount:0은 "할 일이
// 없어 조용히 0건"과 구별하지 않는다 -- 그 구별은 이미 sweepResult.changed
// 자체가 갖고 있으므로 이 필드는 changedCount도 함께 싣는다).
function sweepRecordField(sweepResult) {
  if (!sweepResult || sweepResult.notRun) {
    return { ran: false };
  }
  return {
    ran: true,
    ok: sweepResult.ok === true,
    status: sweepResult.status ?? null,
    reasonCode: sweepResult.reasonCode ?? null,
    changedCount: Array.isArray(sweepResult.changed)
      ? sweepResult.changed.length
      : null,
  };
}

// computeWakeActiveRoundCount -- HYK-285-always-1 (coder-task.md §2-B):
// activeRoundCount의 유일한 출처는 실제 예약 원장(admissionSweep이
// 이미 갖고 있는 ledgerPath -- 새 경로를 만들지 않는다, §1 원문 "그 값을
// 쓴다")이다. ⛔상수·추정 금지 -- 못 읽으면(원장 미설정·미존재·손상·
// 스키마 불일치) null을 돌려줘 decideWake가 UNDECIDABLE(ACTIVE_ROUNDS_
// UNKNOWN)로 접게 한다(조용히 "활성 라운드 0"으로 접지 않는다 -- 그건
// "관측 안 됨"과 "관측된 0건"을 혼동해 오탐 억제를 무너뜨린다).
function computeWakeActiveRoundCount({ admissionSweep }) {
  if (!admissionSweep || !admissionSweep.ledgerPath) return null;
  let readResult;
  try {
    readResult = readLedgerUnlocked(admissionSweep.ledgerPath);
  } catch {
    return null;
  }
  if (!readResult || !readResult.ok || !isWellFormedLedger(readResult.ledger)) {
    return null;
  }
  return countActive(readResult.ledger);
}

// runWakeStep -- HYK-285-always-1 (coder-task.md §1/§2 전체) 발동 주체의
// 몸통. admissionSweep과 완전히 같은 opt-in 계약: `wake`을 호출자가
// 명시적으로 주지 않으면(기본값 null) 이 단계는 아예 실행되지 않는다 --
// 기존 호출자·기존 시험은 회귀 0(runSweepStep과 동일 원칙).
//
// ⛔§2-B 비타협: orchHandle을 여기서 넘기지 않는다 -- 좌석 후보 조회는
// wake-wire.mjs(runWakeOnce -> resolveOrchHandle)가 스스로 하고, 후보가
// 0개거나 2개 이상이면 그 안에서 이미 fail-closed(exit 2)한다. 이 함수가
// 그 판단을 대신하거나 추측하지 않는다.
//
// watchLogPath는 "이번 tick이 append되기 전" 상태를 가리킨다(runWatchOnceCore
// 호출 지점 참조) -- 그래서 이번 판정은 이전까지 기록된 연속성만 본다.
// 다음 주기가 돌 때 이번 tick의 결과가 그 다음 판정의 재료가 된다(15분
// 주기 대비 오차 1 tick -- wake-decide-core.mjs의 sustainTicks 자체가
// 이미 "몇 tick 연속"을 요구하므로 실질적인 각성 지연에 영향을 주지
// 않는다). 이 설계 선택 덕분에 이 단계는 detectorResult(이번 tick의 실
// 판정)와 완전히 독립적으로 시험할 수 있다 -- watch.log에 미리 심어둔
// 이력만으로 WAKE/HOLD/UNDECIDABLE을 결정적으로 재현 가능하다(§2-E
// "헛시험 방지" 요구를 프로덕션 진입점 자식 프로세스 실행으로 충족하기
// 위한 핵심 설계 선택).
function runWakeStep({
  wake,
  admissionSweep,
  watchLogPath,
  now,
  readFn,
  writeFn,
  appendFn,
  existsFn,
  mkdirFn,
}) {
  if (!wake) return { notRun: true };
  const activeRoundCount = computeWakeActiveRoundCount({ admissionSweep });
  try {
    const result = runWakeOnce({
      watchLogPath,
      statePath: wake.statePath,
      wakeLogPath: wake.wakeLogPath,
      activeRoundCount,
      live: wake.live === true,
      execMode: wake.execMode ?? null,
      injectedSeams: Array.isArray(wake.injectedSeams)
        ? wake.injectedSeams
        : [],
      execFn: wake.execFn,
      nowMs: now,
      readFn,
      writeFn,
      appendFn,
      existsFn,
      mkdirFn,
    });
    return { notRun: false, ...result };
  } catch (err) {
    // 이 단계 자신의 실패가 감시 사이클 전체를 죽이면 안 된다
    // (runSweepStep/computeCapResult와 동일 원칙 -- v1은 로그만).
    return {
      notRun: false,
      status: "WAKE_STEP_RUNNER_FAILURE",
      detail: err && err.message ? err.message : String(err),
      verdict: null,
      reasonCode: null,
      sent: false,
      receipt: null,
    };
  }
}

// HYK-228 4R (coder-task.md §1 항4): fs 계열 주입 함수 5개의 기본값
// 해석만 떼어낸다(runWatchOnce의 complexity 수리 -- 기본 파라미터 각각이
// 분기 하나로 잡히므로, 여기로 옮긴 5개만큼 runWatchOnce 자신의 complexity
// 가 줄어든다).
// HYK-228 5R(coder-task.md §1, review-r3.md 반려 수리): ⛔`??` 금지 --
// 원래 기본 파라미터(`readFn = readFileSync` 형태)는 값이 **`undefined`
// 일 때만** 기본값을 쓴다. `??`는 `null`도 기본값으로 바꿔버려, 호출자가
// 의도적으로 `readFn: null`을 주입하는 경우의 의미가 달라진다(검토가
// 실측 재현: 기존 로그가 있는 상태에서 `readFn: null`로 돌리면 2R 원본은
// appendLogWithRotation에 null이 그대로 전달돼 예외 → 기존 로그를 빈
// 값으로 처리했는데, `??`로 바꾼 뒤에는 기존 로그가 보존돼 동작이
// 달라졌다). 아래는 `value === undefined ? default : value` -- 원래
// 기본 파라미터와 동형, `null`은 그대로 통과시킨다.
function resolveWatchOnceFsFns({
  readFn,
  writeFn,
  renameFn,
  mkdirFn,
  existsFn,
  appendFn,
}) {
  return {
    readFn: readFn === undefined ? readFileSync : readFn,
    writeFn: writeFn === undefined ? writeFileSync : writeFn,
    renameFn: renameFn === undefined ? renameSync : renameFn,
    mkdirFn: mkdirFn === undefined ? mkdirSync : mkdirFn,
    existsFn: existsFn === undefined ? existsSync : existsFn,
    // HYK-285-always-1 (coder-task.md §2-E): wake의 영수증(JSONL)은
    // append-only로 쓴다(wake-wire.mjs runWakeOnce의 기본 IO와 동일한
    // 함수 모양) -- 기존 다섯 함수와 동일한 "undefined일 때만 기본값"
    // 규칙(`??` 대신 `=== undefined` -- 위 함수 헤더 주석과 동일 이유).
    appendFn: appendFn === undefined ? appendFileSync : appendFn,
  };
}

// runWatchOnceCore(...) -- runWatchOnce 본문 그 자체(HYK-228 4R,
// max-lines-per-function 수리를 위해 얇은 기본값 래퍼 runWatchOnce에서
// 추출). 모든 파라미터는 이미 해석된 값이며, 이 함수 자신은 기본값을
// 갖지 않는다(complexity를 늘리지 않는다) -- 로직·순서·값은 원문 그대로.
// HYK-228 4R (coder-task.md §1 항4): runWatchOnceCore에서 "로그 줄 조립 +
// 생존 기록 쓰기 + reach 알림" 꼬리만 한 번 더 추출한다(prettier가 되돌린
// 줄바꿈으로 84줄까지 다시 늘어난 것을 수리) -- 순서·값·부작용 모두 원문
// 그대로, 이름과 위치만 옮겼다.
function finalizeWatchOnceCycle({
  repoRoot,
  watchDir,
  now,
  readFn,
  writeFn,
  renameFn,
  mkdirFn,
  existsFn,
  maxLogLines,
  notifyDir,
  detectorResult,
  capResult,
  escalationDedupe,
  sweepResult,
  wakeResult,
}) {
  const nowIso = new Date(now).toISOString();
  const logPath = path.join(watchDir, "watch.log");
  const aliveRecordPath = path.join(watchDir, "last-run.json");
  const line = buildLogLine({
    nowIso,
    detectorResult,
    capResult,
    escalationDedupe,
    sweepResult,
    wakeResult,
  });
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
    // HYK-228 coder-r2 rejection-2 (review-r1.md §B): `sweep`을 형제
    // 필드로 심는다 -- `...detectorResult` 뒤에 와서 detectorResult가
    // 우연히 `sweep` 키를 갖더라도(현재는 갖지 않는다) 이 필드가 이긴다.
    // `recordedAtMs`는 여전히 유일한 신선도 판정 입력이라
    // (watch-freshness-core.mjs 계약 불변) 기존 소비자는 이 새 형제
    // 필드를 무시해도 완전히 무회귀다.
    record: {
      recordedAtMs: now,
      ...detectorResult,
      sweep: sweepRecordField(sweepResult),
    },
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
  const rateLimitStallResult = runRateLimitStallStep({
    repoRoot,
    notifyDir,
    watchDir,
    now,
    readFn,
    writeFn,
    mkdirFn,
    existsFn,
  });
  return {
    logPath,
    aliveRecordPath,
    line,
    detectorResult,
    reachResult,
    rateLimitStallResult,
    capResult,
    escalationDedupe,
    sweepResult,
    wakeResult,
  };
}

function runWatchOnceCore({
  repoRoot,
  watchDir,
  nodePath,
  detectorPath,
  execFn,
  now,
  maxLogLines,
  readFn,
  writeFn,
  renameFn,
  mkdirFn,
  existsFn,
  appendFn,
  notifyDir,
  capPath,
  capReadFn,
  admissionSweep,
  sweepExecFn,
  wake,
}) {
  mkdirFn(watchDir, { recursive: true });
  const detectorResult = runDetector({
    execFn,
    nodePath,
    detectorPath,
    repoRoot,
  });
  const capResult = computeCapResult({ repoRoot, capPath, capReadFn });
  // HYK-173-push-wire (coder-task.md §5-D): dedupe는 로그 줄을 만들기
  // *전에* 계산한다 -- escalation_detail의 NEW: 표시가 이번 회차 통지
  // 결과를 반영해야 한다(runReachStep과 달리, dedupe는 로그 줄 자체의
  // 내용에 영향을 준다).
  const escalationDedupe = runEscalationDedupeStep({
    scopes: detectorResult.escalationScopes,
    watchDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
  });
  const sweepResult = runSweepStep({ admissionSweep, sweepExecFn, now });
  // HYK-285-always-1 (coder-task.md §1/§2): wake도 sweep과 동일한 지점
  // (로그 줄 조립 *전*)에서 계산한다 -- runWakeStep 헤더 주석 참조("이번
  // tick이 append되기 전" watch.log를 읽는 설계 선택 이유).
  const wakeResult = runWakeStep({
    wake,
    admissionSweep,
    watchLogPath: path.join(watchDir, "watch.log"),
    now,
    readFn,
    writeFn,
    appendFn,
    existsFn,
    mkdirFn,
  });
  return finalizeWatchOnceCycle({
    repoRoot,
    watchDir,
    now,
    readFn,
    writeFn,
    renameFn,
    mkdirFn,
    existsFn,
    maxLogLines,
    notifyDir,
    detectorResult,
    capResult,
    escalationDedupe,
    sweepResult,
    wakeResult,
  });
}

// runWatchOnce(...) -- 한 번의 실행 사이클. 모든 I/O는 주입 가능(시험이
// 실제 fs/child_process를 건드리지 않고 스파이로 검증할 수 있게). 이
// 함수 자신은 기본값 해석 + runWatchOnceCore 호출만 한다(HYK-228 4R,
// coder-task.md §1 항4 -- max-lines-per-function/complexity 수리, 공개
// 시그니처·기본값·호출 순서·반환값은 원문과 완전히 동일).
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
  readFn,
  writeFn,
  renameFn,
  mkdirFn,
  existsFn,
  appendFn,
  notifyDir = null,
  capPath,
  capReadFn,
  admissionSweep = null,
  sweepExecFn,
  // HYK-285-always-1 (coder-task.md §2-A "opt-in -- 기본은 꺼짐"):
  // admissionSweep과 동일한 기본값 null -- 호출자가 명시적으로 주지
  // 않으면 wake 단계는 아예 실행되지 않는다(회귀 0).
  wake = null,
}) {
  const fsFns = resolveWatchOnceFsFns({
    readFn,
    writeFn,
    renameFn,
    mkdirFn,
    existsFn,
    appendFn,
  });
  return runWatchOnceCore({
    repoRoot,
    watchDir,
    nodePath,
    detectorPath,
    execFn,
    now,
    maxLogLines,
    ...fsFns,
    notifyDir,
    capPath,
    capReadFn,
    admissionSweep,
    sweepExecFn,
    wake,
  });
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
  // HYK-228 (coder-task.md §2 항1): 사람이 이 CLI를 직접(또는 등록된
  // schtasks 명령줄에 추가해) 부를 때만 admission sweep 단계가 켜진다 --
  // 생략하면(기본값) 이 저장소의 어떤 기존 호출자도 바뀌지 않는다(회귀
  // 0). ★실제 스케줄러 등록 명령줄에 이 두 플래그를 추가하는 것은 사람
  // 손이다(schedule-wire.mjs의 `--confirm` 게이트와 동일한 재량 -- 이
  // 라운드는 코드 경로만 잇는다, CODER 보고서 §5 참조).
  let admissionSweepLedger = null;
  let admissionSweepLock = null;
  // HYK-255-watch-wire-1 (coder-task.md §1 항1): 부분 계수 보고 파일 생성은
  // 기본으로 켜져 있다(notifyDir/admissionSweep과 달리 opt-in이 아니다 --
  // 이 라운드의 목표 자체가 "아무도 그 파일을 안 만든다"는 결손을 닫는
  // 것이다). `--no-partial-count`는 기존 운영 결선을 그대로 유지하고 싶을
  // 때의 탈출구(다른 `--no-*` 플래그와 동일한 재량).
  let noPartialCount = false;
  // HYK-285-always-1 (coder-task.md §1 "같은 자리에 같은 방식으로 붙인다",
  // §2-A "opt-in -- 기본은 꺼짐"): `--wake`를 명시적으로 주지 않으면
  // (기본값) 이 단계는 아예 실행되지 않는다(admissionSweep과 동일 원칙 --
  // 기존 호출자·기존 시험은 회귀 0). `--wake-live` 없이는 실 전송을 절대
  // 하지 않는다(wake-wire.mjs 자신의 §2 비타협 5를 runWakeOnce가 그대로
  // 지킨다 -- 이 CLI는 그 게이트를 다시 구현하지 않는다). `--wake-fake-
  // exec-*`는 wake-wire.mjs CLI와 동일한 이름·의미의 시험 전용 주입구
  // (buildFakeExecFn을 그대로 재사용 -- 재구현 0).
  let wakeEnabled = false;
  let wakeState = null;
  let wakeLog = null;
  let wakeLive = false;
  let wakeFakeExecLog = null;
  let wakeFakeExecFail = false;
  let wakeFakeExecFailSubmit = false;
  let wakeFakeTerminalListJson = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--watch-dir") watchDir = argv[++i];
    else if (argv[i] === "--notify-dir") notifyDir = argv[++i];
    else if (argv[i] === "--no-reach") notifyDir = null;
    else if (argv[i] === "--admission-sweep-ledger")
      admissionSweepLedger = argv[++i];
    else if (argv[i] === "--admission-sweep-lock")
      admissionSweepLock = argv[++i];
    else if (argv[i] === "--no-partial-count") noPartialCount = true;
    else if (argv[i] === "--wake") wakeEnabled = true;
    else if (argv[i] === "--wake-state") wakeState = argv[++i];
    else if (argv[i] === "--wake-log") wakeLog = argv[++i];
    else if (argv[i] === "--wake-live") wakeLive = true;
    else if (argv[i] === "--wake-fake-exec-log") wakeFakeExecLog = argv[++i];
    else if (argv[i] === "--wake-fake-exec-fail") wakeFakeExecFail = true;
    else if (argv[i] === "--wake-fake-exec-fail-submit")
      wakeFakeExecFailSubmit = true;
    else if (argv[i] === "--wake-fake-terminal-list-json")
      wakeFakeTerminalListJson = argv[++i];
  }
  if (!repoRoot || !watchDir) {
    console.error("usage: watch-run.mjs --repo-root <path> --watch-dir <path>");
    process.exit(1);
  }
  // HYK-285-always-1 (coder-task.md §1 "그 값을 쓴다"): 게이트를
  // ledgerPath 단독으로 완화한다 -- lockPath까지 있어야 실제로 도는
  // runSweepStep 자신의 가드(`!admissionSweep.lockPath` -> notRun)는
  // 그대로다(§7-A 회귀 0: 기존 호출은 언제나 둘 다 준다). 이 완화가
  // 여는 것은 딱 하나 -- ledger 경로만 주고 lock은 안 줘서 "sweep은
  // 끄고 wake의 activeRoundCount 읽기만 켠다"는 조합(실 orca 호출을
  // 만드는 sweep 트리거를 켜지 않고도 원장을 읽을 수 있어야 한다, §2-B).
  const admissionSweep = admissionSweepLedger
    ? { ledgerPath: admissionSweepLedger, lockPath: admissionSweepLock }
    : null;
  // §1-B(wake-wire.mjs 원문 그대로 상속): 영수증이 "운영"과 "시험"을
  // 구별할 수 있게, 가짜 exec을 썼는지를 execMode에 싣는다(fakeExecLog
  // 유무가 유일한 판정 기준). live가 아니면 항상 null(비-live).
  const wakeExecMode = !wakeLive ? null : wakeFakeExecLog ? "fake" : "live";
  // HYK-285-wake-4와 동일 원칙: "어떤 주입구가 쓰였는지"를 영수증에
  // 남긴다 -- fake exec가 실제로 살아 있을 때(execMode==="fake")만
  // 의미가 있다(안 쓴 주입구는 목록에 없다 -- 거짓 양성 방지).
  const wakeInjectedSeams = [];
  if (wakeExecMode === "fake") {
    wakeInjectedSeams.push("fake-exec-log");
    if (wakeFakeTerminalListJson)
      wakeInjectedSeams.push("fake-terminal-list-json");
    if (wakeFakeExecFailSubmit) wakeInjectedSeams.push("fake-exec-fail-submit");
    if (wakeFakeExecFail) wakeInjectedSeams.push("fake-exec-fail");
  }
  // 실행 구성(운영 execFn vs 가짜 execFn)은 live가 아니면 아예 만들지
  // 않는다 -- runWakeOnce 자신이 `!live`일 때 execFn을 부르지 않으므로
  // undefined로 둬도 안전하지만, "라이브 아닌 실행에 execFn을 만들지
  // 않는다"를 이 조립부에서도 명시적으로 지킨다(§2 비타협 5와 동일
  // 정신 -- 기본 발화 금지 경로에는 실 orca 핸들도 만들지 않는다).
  const wakeExecFn = !wakeLive
    ? undefined
    : wakeFakeExecLog
      ? buildFakeExecFn(wakeFakeExecLog, {
          failAll: wakeFakeExecFail,
          failSubmitOnly: wakeFakeExecFailSubmit,
          terminalListResponse: wakeFakeTerminalListJson
            ? {
                ok: true,
                result: { terminals: JSON.parse(wakeFakeTerminalListJson) },
              }
            : null,
        })
      : createOrcaExecFn();
  // HYK-285-always-1 (coder-task.md §2-C "영수증(JSONL)은... watch-dir
  // 아래로 둔다", §2-D-3 "쿨다운 상태 파일이 주기 실행 사이에 유지되는지"):
  // 상태·영수증 경로 둘 다 기본으로 watchDir 아래 -- 같은 watchDir로
  // 매 주기 다시 호출되므로 쿨다운 상태가 자연히 사이클 간에 유지된다.
  const wake = wakeEnabled
    ? {
        statePath: wakeState || path.join(watchDir, "wake-state.json"),
        wakeLogPath: wakeLog || path.join(watchDir, "wake-receipts.jsonl"),
        live: wakeLive,
        execMode: wakeExecMode,
        injectedSeams: wakeInjectedSeams,
        execFn: wakeExecFn,
      }
    : null;
  const cliNow = Date.now();
  const result = runWatchOnce({
    repoRoot,
    watchDir,
    notifyDir,
    admissionSweep,
    wake,
    now: cliNow,
  });
  if (!noPartialCount) {
    // HYK-255-watch-wire-1 (coder-task.md §1 항2): 실패는 감시 로그 줄로
    // 시끄럽게 남고, 감시 실행 자체(위 result/process.exit)는 이 단계와
    // 무관하게 계속된다 -- runPartialCountStep은 절대 throw하지 않는다.
    await runPartialCountStep({
      watchDir,
      now: cliNow,
      logPath: result.logPath,
      options: {
        repoRoot,
        watchLogPath: result.logPath,
      },
    });
  }
  // HYK-270 (coder-task.md §9-8 "전부 실행 출력으로 보여라") -- 한도
  // 정지 단계 결과를 사람이 읽는 한 줄로 찍는다(watch.log 줄 형식은
  // 다른 시험이 이미 정확히 고정하고 있어 건드리지 않는다, §6/§7 회귀 0
  // -- 이 줄은 그 로그 줄과 별개의 stdout 한 줄이다).
  const rl = result.rateLimitStallResult;
  if (rl && rl.notRun !== true) {
    console.log(
      `rate-limit-stall: ${rl.failed ? "FAILED" : rl.status}` +
        `${rl.verdict ? ` verdict=${rl.verdict}` : ""}` +
        `${rl.noticePath ? ` notice=${rl.noticePath}` : ""}` +
        `${rl.alreadyNotified ? " (already notified)" : ""}` +
        `${rl.message ? ` -- ${rl.message}` : ""}`,
    );
  }
  // HYK-285-always-1 (coder-task.md §2-C, HYK-270과 동일 관례 "전부 실행
  // 출력으로 보여라") -- wake 단계 결과를 사람이 읽는 한 줄로 찍는다.
  // watch.log 줄 형식은 건드리지 않는다(§6/§7 회귀 0) -- 이 줄은 그
  // 로그 줄과 별개의 stdout 한 줄이다.
  const wk = result.wakeResult;
  if (wk && wk.notRun !== true) {
    console.log(
      `wake: status=${wk.status ?? "NONE"} verdict=${wk.verdict ?? "NONE"}` +
        ` reason=${wk.reasonCode ?? "NONE"} sent=${wk.sent === true}` +
        `${wk.detail ? ` -- ${wk.detail}` : ""}`,
    );
  }
  process.exit(result.detectorResult.runnerFailure ? 1 : 0);
}
