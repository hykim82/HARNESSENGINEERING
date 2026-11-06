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
  readdirSync,
} from "node:fs";
import path from "node:path";
// HYK-493-memory-reopen-1 (coder-task.md §1 "ORCH 관측" · §2 product_scope ⓘ):
// free 메모리 재측 기본 seam의 유일한 출처(os.freemem()를 MB로 환산). PM
// 설계 2026-10-31 (b)④ 원문: Windows에서 os.freemem()은 libuv ullAvailPhys,
// memory-gate.ps1의 \Memory\Available MBytes와 같은 축으로 설계됐다 --
// ★다른 축일 가능성은 한계 문단에 적는다(§3 완료조건4), NEEDS_INPUT 아님.
import os from "node:os";
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
// HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ②) --
// seat 축이 새로 열릴 때 보내는 orchestration escalation 메시지의 argv
// 조립. 실행(orca spawn)은 여전히 createOrcaExecFn()(위)을 통해서만
// 나간다 -- 이 파일 자신은 orca를 spawn하지 않는다(G9, orca-cli-boundary
// 정적 검사가 이 파일 밖에서 "orca" 리터럴 spawn 0건을 확인한다).
import { buildSeatEscalationSendCommand } from "../relay/adapters/orca-adapter.mjs";
// HYK-464-teardown-shadow-1 (coder-task.md §2 product_scope ①③) -- 축C가
// 그림자로 구동하는 아카이브 판정 코어 + 그 관측 어댑터. ⛔이것은 위
// "절대 import하지 않는다" 경계(orch-stall-detect.mjs 전용)와 무관하다 --
// teardown-core.mjs/teardown-inventory-adapter.mjs는 relay/* 이고, 그
// 경계는 orch-stall-detect.mjs 하나만 가리킨다(이 파일 §재사용 주석
// 참조). 미소비(ⓑ) 판정은 이 두 모듈 어느 쪽도 하지 않는다 -- 이미 이
// 러너가 child process로 받는 detectorResult.unconsumedWorstWorktrees
// (HYK-328, HYK-185)를 그대로 재사용한다(새 재구현 0).
import {
  judgeArchiveEligibility,
  ELIGIBILITY,
} from "../relay/teardown-core.mjs";
import {
  observeArchiveInventory,
  computeCanonicalPathDigest,
  observeTeardownInventory,
  observeSeatCount,
  buildGitRevParseAbbrevRefCommand,
  // HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P1-1 수리) --
  // 제거 직전 working tree가 clean한지 확인하는 argv. HYK-171 축의
  // observeWorkingTree(비공개)가 이미 같은 argv로 dirty/untracked/unmerged를
  // 읽는다 -- 이 축은 그 판정 로직을 다시 구현하지 않고 argv 빌더만
  // 재사용한다(판정은 checkWorkingTreeCleanForArm, 아래).
  buildGitStatusCommand,
} from "../relay/adapters/teardown-inventory-adapter.mjs";
// HYK-491-teardown-arm-1 (coder-task.md §2 product_scope ① "teardown 실행
// 경로") -- 무장(armed) 실행의 유일한 orca 호출 지점(G9: orca 문자열
// spawn은 adapter 안에서만). 이 함수는 armed!==true면 guardedExec을
// 전혀 타지 않는다(위 orca-adapter.mjs §주석) -- 이 파일은 그 게이트를
// 다시 구현하지 않는다.
import { removeArchivedWorktree } from "../relay/adapters/orca-adapter.mjs";
import { createHash } from "node:crypto";
// HYK-464-followup-1 축C (coder-task.md §1 축C) -- 자원 잔재 «보고» 축이
// 재사용하는 기존 함수. detectOrphans는 재구현하지 않는다(§재사용) --
// 좌석 "배정 0" 후보를 이미 판별하는 도구(HYK-464 이전 라운드 산출물).
// ⚠️collectGitWorktrees/collectDroppedTaskFileEvidence(orch-stall-
// detect.mjs)는 «재사용하지 않는다» -- 처음엔 그럴 계획이었으나 실
// 러너(1R run1, coder.md §시험)가 orch-stall-detect.test.mjs의 기존
// 경계 시험 2건("static: no PRODUCTION code imports orch-stall-
// detect.mjs yet" 등)을 RED로 되돌리는 걸 실측했다: 이 저장소는 이미
// "watch-run.mjs는 orch-stall-detect.mjs를 자식 프로세스로만 부르고
// 절대 import하지 않는다"는 아키텍처 경계를 세워 뒀다(이 파일 상단
// "왜 새로 만들었나" 주석과 대칭 -- runDetector가 정본 결합 지점).
// 그래서 아래 두 함수(워크트리 열거·dropped_at 헤더 검사)는 작고
// 자기완결적인 로직만 로컬로 다시 짠다(각 15줄 안팎) -- 그 경계를
// 깨는 비용이 이 정도 중복보다 크다는 판단.
import { detectOrphans } from "../check/seat-orphan-detect.mjs";

export const MAX_LOG_LINES = 5000;

// HYK-493-memory-reopen-1 (coder-task.md §2 product_scope ⓘ "여유(여유 =
// 이름 붙은 상수 1개 · 기본 200MB · 근거 1줄)"): 게이트 자신의 재측정
// 안정성 상한(memory-gate.ps1 161행 근처 "range -gt 300" -- 표본 간 흔들림
// 300MB까지는 "안정됨"으로 본다)보다 작게 둔다 -- 문턱을 겨우 넘겼다가
// 게이트 자신의 재측정에서 바로 다시 닫히는 거짓 재개 통지를 줄이기
// 위함이다.
export const MEMORY_REOPEN_MARGIN_MB = 200;

// HYK-493-memory-reopen-1 (coder-task.md §2 product_scope ⓘ "표본 간격
// seam · 기본 간격 = 근거 1줄"): memory-gate.ps1 자신의 step2 A/B 재확인
// 간격(174행 근처 `Start-Sleep -Seconds 30`)과 동일한 리듬을 재사용한다 --
// 새 측정 리듬을 지어내지 않는다.
export const MEMORY_REOPEN_SAMPLE_INTERVAL_MS = 30000;

// HYK-493-memory-reopen-1 (coder-task.md §1 "상태 파일의 생산자"): 관제실
// memory-gate.ps1의 Write-GateState(53행 근처)가 쓰는 스키마 식별자 그대로.
const MEMORY_GATE_SCHEMA_V1 = "memory-gate-state/v1";

function defaultExec(cmd, args, opts) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
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

// ★HYK-464-watch-collection-1 3R P1-3(판정 §1 ⑶ · 검토 1R §2 ⓑ⑵ "조용한
// 제외 금지"는 last-run.json·watch.log까지 닿아야 성립): collectPartialFailures
// 와 동일한 평탄화 관례 -- orch-stall-detect.mjs의 judgeSeatLivenessFor
// Worktree/judgeSeatIdleForWorktree/judgeDispatchStartForWorktree(세 축
// 전부, 그 함수들 헤더 참조)가 이미 워크트리별로 싣는
// `excludedUndeliveredTaskFiles`를 전체 워크트리에서 모아 평탄화한다.
// 축 자체가 COLLECTION_FAILED 등으로 `worktrees`가 없으면 조용히 빈
// 배열([])을 낸다(collectPartialFailures와 동일 원칙 -- 이 부가 정보
// 추출 실패가 로그 줄 조립 전체를 막아서는 안 된다).
function collectExcludedUndeliveredTaskFiles(axisRaw) {
  if (!isPlainObject(axisRaw) || !Array.isArray(axisRaw.worktrees)) return [];
  const collected = [];
  for (const wt of axisRaw.worktrees) {
    if (!isPlainObject(wt) || !Array.isArray(wt.excludedUndeliveredTaskFiles)) {
      continue;
    }
    for (const item of wt.excludedUndeliveredTaskFiles) {
      if (isPlainObject(item)) collected.push(item);
    }
  }
  return collected;
}

// ★HYK-464-watch-start-axis-1 ⓒ(판정 §1 ⑷/§2 ⓒ, P3-2): start 축의
// 워크트리별 판정(orch-stall-detect.mjs persistAndJudgeDispatchStart)이
// 이번 회차 "집 관측 불가"(sizeObservationReasonCode, 예:
// DISPATCH_START_SIZE_OBSERVATION_UNAVAILABLE)를 실으면 그 사실을 모아
// 산출물(watch.log/last-run.json)까지 올린다 -- collectExcludedUndeliveredTaskFiles
// 와 동일한 평탄화 관례(축 자체가 worktrees 배열을 안 주면 조용히 빈
// 배열, 이 부가 정보 추출 실패가 로그 줄 조립 전체를 막지 않는다).
function collectSizeObservationUnavailable(axisRaw) {
  if (!isPlainObject(axisRaw) || !Array.isArray(axisRaw.worktrees)) return [];
  const collected = [];
  for (const wt of axisRaw.worktrees) {
    if (!isPlainObject(wt)) continue;
    if (
      typeof wt.sizeObservationReasonCode === "string" &&
      wt.sizeObservationReasonCode.trim().length > 0
    ) {
      collected.push({
        worktreePath: wt.worktreePath ?? null,
        reasonCode: wt.sizeObservationReasonCode,
      });
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
    // HYK-421 1R (결함 2): "가장 나쁜 것" 대표값과 독립적인 "실제로
    // 판정까지 간 활성 배달이 있었는가" 요약(orch-stall-detect.mjs
    // summarizeLiveDispatchVerdict 참조) -- 대표 status/verdict가
    // NOT_APPLICABLE/NO_SEAT여도 이 값으로 "정상 판정된 배달이 실제로
    // 있었는지"를 구별할 수 있다.
    seatLivenessLiveDispatchJudgedCount: pickNumber(
      seatLiveness,
      "liveDispatchJudgedCount",
    ),
    seatLivenessLiveDispatchVerdict: pickString(
      seatLiveness,
      "liveDispatchVerdict",
    ),
    // HYK-464-watch-collection-1 3R P1-3: collectPartialFailures와 동일
    // 이유로 이 축의 excludedUndeliveredTaskFiles도 로그 줄·last-run.json
    // 까지 옮긴다(위 collectExcludedUndeliveredTaskFiles 헤더 참조).
    seatLivenessExcludedUndeliveredTaskFiles:
      collectExcludedUndeliveredTaskFiles(seatLiveness),
    // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①③):
    // escalation 메시지 body와 watch.log seat_detail·reach-notify/아침
    // 보고가 전부 필요로 하는 좌석 식별(handle·배달 라벨·무출력 분·마지막
    // 출력 시각)을 한 곳에서 뽑는다(extractSeatIdentity 참조) -- SUSPECTED_
    // UNRESPONSIVE가 아니면 null(정상/판정불가에는 신원 상세가 필요 없다).
    seatLivenessIdentity: extractSeatIdentity(seatLiveness),
  };
}

// HYK-433-seat-escalation-push-1 (coder-task.md §2 ⓐ): judgeSeatLivenessAcrossWorktrees
// (orch-stall-detect.mjs)는 "가장 나쁜" worktree의 status/verdict/details/
// worktreePath만 top-level로 올리고, 그 worktree의 handle(correlation.handle)
// ·배달 라벨(dispatch.dispatchId)은 `worktrees[]` 배열 안에만 남겨둔다
// (실측: judgeSeatLivenessAcrossWorktrees 반환문, orch-stall-detect.mjs
// 1392-1414행 근처 -- 이 라운드는 그 파일을 고치지 않는다, product_scope
// 밖). 그래서 top-level worktreePath로 `worktrees[]`에서 같은 항목을 다시
// 찾아 handle/dispatchLabel을 꺼낸다 -- 새 판정이 아니라 이미 있는 값을
// 한 곳에 모을 뿐이다.
//
// ★정직 한계(결과 파일에도 적는다): `dispatch.dispatchId`는 "HYK-xxx" 형
// 하네스 라벨이 아니라 그 활성 배달의 task 파일 경로(예:
// ".harness/coder-task.md")다 -- 진짜 하네스 라벨(active.taskId)은
// judgeSeatLivenessForRepo(orch-stall-detect.mjs) 안에서 계산되지만
// dispatch 객체에 실리지 않고 버려진다(그 함수를 고치는 것은 product_scope
// 밖). "배달 라벨" 칸에는 이 dispatchId(파일 경로)를 쓴다 -- 사람이 어느
// 배달인지 식별할 수 있는 가장 가까운 기존 값이기 때문이다.
//
// ★또 다른 한계: worstCount>1(여러 워크트리가 동시에 SUSPECTED_UNRESPONSIVE)
// 이어도 이 함수는 "대표(worst-wins) worktree" 하나만 본다 -- 이 축의
// status/verdict 대표값 자체가 이미 그 설계(judgeSeatLivenessAcrossWorktrees
// 헤더 주석)이고, reach-report-core.mjs의 "열려 있는 이상" 집계도 축마다
// latest.axes[axis.key] 하나만 쓰는 동일한 대표값 원칙이라(computeOpenByPredicate
// 참조) 새 비일관성이 아니다.
function pickFiniteNumber(obj, key) {
  return obj && typeof obj[key] === "number" && Number.isFinite(obj[key])
    ? obj[key]
    : null;
}

function findSeatWorktreeEntry(seatLiveness, worktreePath) {
  if (!Array.isArray(seatLiveness.worktrees)) return null;
  return (
    seatLiveness.worktrees.find(
      (wt) => isPlainObject(wt) && wt.worktreePath === worktreePath,
    ) ?? null
  );
}

function extractSeatIdentity(seatLiveness) {
  if (!isPlainObject(seatLiveness)) return null;
  if (seatLiveness.verdict !== "SUSPECTED_UNRESPONSIVE") return null;
  const worktreePath = pickString(seatLiveness, "worktreePath");
  if (!worktreePath) return null;
  const wtEntry = findSeatWorktreeEntry(seatLiveness, worktreePath);
  const correlation = wtEntry ? wtEntry.correlation : null;
  const dispatch = wtEntry ? wtEntry.dispatch : null;
  const details = seatLiveness.details;
  return {
    worktreePath,
    handle: pickString(correlation, "handle"),
    dispatchLabel: pickString(dispatch, "dispatchId"),
    elapsedMs: pickFiniteNumber(details, "elapsedMs"),
    referencePointMs: pickFiniteNumber(details, "referencePointMs"),
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
    // HYK-464-watch-collection-1 3R P1-3: seatLiveness와 동일 이유.
    seatIdleExcludedUndeliveredTaskFiles:
      collectExcludedUndeliveredTaskFiles(seatIdle),
    // HYK-464-idle-stop-reason-1 (coder-task.md §2ⓔ): unconsumedWorstWorktrees
    // (HYK-328)와 동일 이유 -- worstCount 하나만으로는 "어느 워크트리"가
    // 사라진다. 정상 회차(orch-stall-detect.mjs judgeSeatIdleAcrossWorktrees
    // 참조)에는 빈 배열이라 pickStringArray가 []를 돌려준다.
    seatIdleWorstWorktrees: pickStringArray(seatIdle, "worstWorktreePaths"),
    // HYK-464-idle-stop-reason-1 (§2ⓒ): 열린 정지 사유가 덮어 "사유 있는
    // 존치"로 갈린 워크트리 수·경로·사유 id.
    seatIdleParkedCount: pickNumber(seatIdle, "parkedCount"),
    seatIdleParkedWorktrees: pickStringArray(seatIdle, "parkedWorktreePaths"),
    seatIdleParkedReasonIds: pickStringArray(seatIdle, "parkedReasonIds"),
    // HYK-464-idle-stop-reason-1 (§2ⓓ): 정지 사유 파일 자체의 상태(부재/
    // 있음/있는데 읽기·파싱·형식 실패) -- 조용한 낙하 금지.
    seatIdleStopReasonsStatus: pickString(seatIdle, "stopReasonsStatus"),
    seatIdleStopReasonsDetail: pickString(seatIdle, "stopReasonsDetail"),
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
    // HYK-464-watch-collection-1 3R P1-3: seatLiveness와 동일 이유.
    startExcludedUndeliveredTaskFiles:
      collectExcludedUndeliveredTaskFiles(dispatchStart),
    // HYK-464-watch-start-axis-1 ⓒ: 위 collectSizeObservationUnavailable
    // 헤더 참조 -- "관측 불가 회차"를 산출물까지 옮긴다.
    startSizeObservationUnavailable:
      collectSizeObservationUnavailable(dispatchStart),
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
    // HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑷ P1-3 수리, 검토 1R
    // 실측): worstWorktreePaths(위)만 보면 억제(HYK-452)·등급 가림·
    // 워크트리별 수집 실패가 전부 "미소비 0"으로 접힌다(발화 «대표값»
    // 투영일 뿐 HYK-185 판정 그 자체가 아니다). 그림자 teardown 축은 이
    // 워크트리별 전체 항목(status/verdict/resultFile.path)을 그대로
    // 옮겨 적는다 -- HYK-185 자신의 판정은 한 글자도 다시 하지 않는다
    // (아래 pickUnconsumedWorktreeEntries 참조).
    unconsumedWorktreeEntries: pickUnconsumedWorktreeEntries(unconsumed),
  };
}

// 문자열이 아니거나 형태가 어긋난 원소는 조용히 버린다(pickStringArray와
// 동일 원칙) -- 이 배열은 teardown-shadow 축(아래 deriveUnconsumedRounds
// ForWorktree)만 읽는다, 다른 네 축의 기존 동작은 전혀 바뀌지 않는다.
function pickUnconsumedWorktreeEntries(unconsumed) {
  if (!unconsumed || !Array.isArray(unconsumed.worktrees)) return null;
  return unconsumed.worktrees
    .filter((w) => isPlainObject(w) && isNonEmptyString(w.worktreePath))
    .map((w) => ({
      worktreePath: w.worktreePath,
      status: typeof w.status === "string" ? w.status : null,
      verdict: typeof w.verdict === "string" ? w.verdict : null,
      resultFilePath:
        isPlainObject(w.resultFile) && typeof w.resultFile.path === "string"
          ? w.resultFile.path
          : null,
    }));
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
    seatLivenessLiveDispatchJudgedCount: null,
    seatLivenessLiveDispatchVerdict: null,
    seatLivenessExcludedUndeliveredTaskFiles: [],
    seatLivenessIdentity: null,
    seatIdleStatus: null,
    seatIdleVerdict: null,
    seatIdleWorstCount: null,
    seatIdleTotalWorktrees: null,
    seatIdleObservationReason: null,
    seatIdleReason: null,
    seatIdleExcludedUndeliveredTaskFiles: [],
    seatIdleWorstWorktrees: null,
    seatIdleParkedCount: null,
    seatIdleParkedWorktrees: null,
    seatIdleParkedReasonIds: null,
    seatIdleStopReasonsStatus: null,
    seatIdleStopReasonsDetail: null,
    startStatus: null,
    startVerdict: null,
    startWorstCount: null,
    startTotalWorktrees: null,
    startPartialFailures: [],
    startObservationReason: null,
    startReason: null,
    startExcludedUndeliveredTaskFiles: [],
    unconsumedStatus: null,
    unconsumedVerdict: null,
    unconsumedWorstCount: null,
    unconsumedTotalWorktrees: null,
    unconsumedReason: null,
    unconsumedWorktreePath: null,
    unconsumedWorstWorktrees: null,
    unconsumedWorktreeEntries: null,
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

// HYK-467 (coder-task.md §B) -- 2026-09-10 ORCH 자인: GitHub check_runs
// API가 한도 소진으로 키 자체를 안 주는데 `rs = d.get('check_runs') or []`
// 로 접으면 "아직 안 뜸"(NO_RUNS_YET)으로 조용히 둔갑한다. 같은 병이 이
// 감시기에도 있다 -- 검토 실측: `runDetector`가 감지기 서브프로세스가
// «떴지만 비정상 종료»했을 때(execFn이 numeric err.status로 던짐) 그
// stdout(대개 빈 문자열이거나 스택트레이스 조각)을 그대로
// `parseDetectorStdout`에 넘기고, 그게 파싱 실패하면 이 함수가 조용히
// `emptyDetectorFields()`(verdict:null)를 돌려줬다 -- buildLogLine의
// `detectorResult.verdict ?? "UNKNOWN"` 이 그 null을 "UNKNOWN"으로 접어,
// 실제 감지기 크래시가 이 감시기가 정상적으로 판단할 수 있는 다른
// 상태들과 구별 안 되는 문자열로 뭉개졌다(orch-stall-detect.mjs의 진짜
// verdict 어휘 -- PROGRESSING/WAITING_HUMAN_GATE/UNDECIDABLE/STALLED --
// 에는 "UNKNOWN"이 없다는 것 자체는 검토 확인했지만, reasonCode 쪽은
// 둘 다 "NONE"으로 겹쳐 사람이 grep으로 구별할 수 없었다).
// ⛔이 상수를 REASON_CODE.NONE("정상, 사유 없음")과 절대 겹치지 않게
// 고른다 -- 겹치면 이 수리가 고치려는 바로 그 혼동을 다른 이름으로
// 재생산한다.
export const DETECTOR_STDOUT_UNPARSEABLE_VERDICT =
  "DETECTOR_STDOUT_UNPARSEABLE";

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
    // HYK-467: distinct from every real verdict this detector can emit,
    // and distinct from the "NONE" reasonCode used for genuinely
    // nothing-to-report ticks -- see the constant's own header comment.
    return {
      ...emptyDetectorFields(),
      verdict: DETECTOR_STDOUT_UNPARSEABLE_VERDICT,
      reasonCode: DETECTOR_STDOUT_UNPARSEABLE_VERDICT,
    };
  }
}

// 감지기를 감싸 실행한다(§2-3 -- 고치지 않고 감싼다). 감지기 자신의
// 실패(STALLED/UNDECIDABLE 등)와 러너 자신의 실패(스폰 자체 실패, 예:
// node 경로가 잘못됨)를 구별한다 -- 후자는 `runnerFailure: true`.
// ★HYK-452 «억제» 층: 감지기에 자신의 «발신 기억» 파일 경로를 넘긴다
// (watchDir 안, unconsumed-vanish-state.json 과 나란히 -- 같은 side-channel
// 관례). ⛔이 파일은 감지기가 «자기 발신 기록»으로만 쓰며 판정 근거가
// 아니다(orch-stall-detect.mjs 의 §0.1 정합 논증 주석 참조).
function runDetector({ execFn, nodePath, detectorPath, repoRoot, watchDir }) {
  const noticeStateArgs = watchDir
    ? [
        "--unconsumed-notice-state",
        path.join(watchDir, "unconsumed-notice-state.json"),
      ]
    : [];
  try {
    const stdout = execFn(
      nodePath,
      [detectorPath, "--repo-root", repoRoot, "--json", ...noticeStateArgs],
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

// HYK-464-watch-collection-1 3R P1-3: failureLogSegment와 동일한 "상한 +
// N_more" 관례(§4 요구6류, 새 형식 발명 금지) -- 제외된 항목이 없으면
// (가장 흔한 경우) 이 축의 로그 줄에 아무 것도 더하지 않는다(null).
function formatExcludedUndeliveredEntry(item) {
  const taskId = sanitizeFailureToken(
    isPlainObject(item) ? item.taskId : null,
    "unknown_task",
  );
  const role = sanitizeFailureToken(
    isPlainObject(item) ? item.role : null,
    "unknown_role",
  );
  return `${taskId}:${role}`;
}

function excludedUndeliveredLogSegment(prefix, items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const shown = items
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map(formatExcludedUndeliveredEntry);
  const omitted = items.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `${prefix}_excluded_undelivered=${items.length} ${prefix}_excluded_undelivered_detail=${detail}`;
}

// HYK-421 1R (결함 2, coder-task.md §5 "결과 파일 규약" 완료 조건3) --
// 대표(worst-wins) status/verdict와 별도로 "실제로 판정된 활성 배달이
// 있었는가"를 로그 줄에 싣는다. judgedCount가 없으면(=orch-stall-
// detect.mjs가 아직 이 필드를 안 주는 옛 stdout -- 파싱 실패든 이
// 라운드 전 stdout이든) null을 돌려 filter(Boolean)로 걸러진다 --
// 기존 로그 줄 형식(byte-identical 회귀 시험, watch-run.test.mjs)을
// 건드리지 않는다.
function seatLiveDispatchLogSegment(detectorResult) {
  const judgedCount = detectorResult.seatLivenessLiveDispatchJudgedCount;
  if (judgedCount === null || judgedCount === undefined) return null;
  const verdict = detectorResult.seatLivenessLiveDispatchVerdict ?? "NONE";
  return `seat_live_judged_count=${judgedCount} seat_live_verdict=${verdict}`;
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

// ---- HYK-341-vanished-unresolved (coder-task.md §4) -- 사라진 미소비
// 의심 대상 추적 ----
//
// 왜 필요한가(coder-task.md §0 M2 재현, orch-stall-detect.mjs 헤더
// 주석과 동일 근거): `judgeUnconsumedAcrossWorktrees`는 매 tick
// `git worktree list`로 대상을 새로 열거하고 이전 tick의 판정을 전혀
// 기억하지 않는다 -- 의심(SUSPECTED_UNCONSUMED)이던 워크트리가 다음
// tick에 목록에서 아예 사라지면(예: `git worktree remove`) 그 판정은
// 그냥 조용히 없던 일이 된다(worstCount가 줄 뿐, "누가 왜 사라졌는지"는
// 어디에도 안 남는다). watch-run.mjs는 새 프로세스로 매 tick 다시
// 뜨므로 메모리로는 "직전 tick에 뭘 의심했는지"를 못 들고 다닌다 --
// escalation-notify-state.json/reach-notify-state.json과 동일한
// per-watchDir 상태 파일로 그 기억을 옮긴다(§4 "새 패턴을 발명하지
// 마라").
//
// "사라짐"의 정의: 직전 tick에 unconsumed 축의 worst(=SUSPECTED_UNCONSUMED)
// 워크트리였던 경로 중, 이번 tick에 그 디렉터리 자체가 더 이상 존재하지
// 않는 것(existsFn). 340 수리 이후에는 진짜로 소비된 뒤 워크트리를
// 정리한 경우 애초에 worst 목록에 오르지 않으므로(§5 요구4 오탐0), 그런
// 정상 정리는 이 집합에 들어오지 않는다 -- verdict만 CONSUMED로 바뀌고
// 디렉터리는 그대로 있는 정상 사례도 existsFn이 true이므로 걸리지 않는다.
// HYK-341-vanished-unresolved 2R P1-2 (검토 원문): 1R은 상태 파일 누락·
// 파손·읽기 실패를 전부 `{suspectedPaths:[], stateMissing:true}`로
// 뭉뚱그렸다 -- "파일이 아직 없다"(첫 tick, 정상)와 "있는데 못 읽는다"
// (파손, 표면화 대상)를 구별하지 않으면, 상태가 파손된 tick에 진짜
// vanish가 있어도 조용히 빈 목록으로 접혀 VANISHED_UNRESOLVED가 영영
// 안 뜬다(검토자 직접 재현: probe에서 `containsVanish=false` + 상태
// 파일이 `{"suspectedPaths":[]}`로 덮여씀). `stateKind`로 넷을 구별한다:
// - "MISSING" -- ENOENT(첫 tick 등, 정상 -- 표면화하지 않는다).
// - "READ_FAILED" -- ENOENT가 아닌 다른 이유로 못 읽음(권한 등).
// - "CORRUPTED" -- 읽혔지만 JSON 파싱 실패, 또는 파싱은 됐지만
//   `suspectedPaths` 필드가 배열이 아닌 형식 위반.
// - "OK" -- 정상.
// READ_FAILED/CORRUPTED 둘 다 "못 읽음"(파손 계열)이라 호출자(§4)가
// 로그·reach 축에 표면화한다 -- MISSING만 조용하다.
//
// HYK-341-vanished-unresolved 3R P1-2(검토 2R 반려, 배열 원소 스키마
// 검증 우회 재현 수리): 2R까지는 `suspectedPaths`가 배열이기만 하면
// 통과시키고, 그 안의 비문자 원소는 `.filter(...)`로 **조용히** 걸러
// 냈다 -- 검토자 probe(`{"suspectedPaths":[42]}`)가 재현한 대로, 그러면
// 파손된 상태가 `CORRUPTED`로 드러나지 않고 진짜 의심 경로만 조용히
// 사라진다(그 42가 필터링되며 원래 있던 문자열 경로까지 함께 있었어도
// 배열 자체는 "유효"로 통과해 부분 파손이 은폐된다). 이제 배열의 **원소
// 전부**가 비어있지 않은 문자열이어야 유효하다 -- 하나라도 아니면
// 배열째로 CORRUPTED(부분 필터링 금지, 조용히 걸러내지 않는다). 빈
// 배열은 `.every(...)`가 공허하게 참이라 그대로 OK(§2 "빈 배열은
// 정상" 요구 그대로 -- 별도 분기 불필요).
function isValidSuspectedPathsArray(arr) {
  return arr.every((p) => typeof p === "string" && p.length > 0);
}

function readUnconsumedVanishState(readFn, statePath) {
  let text;
  try {
    text = readFn(statePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { suspectedPaths: [], stateKind: "MISSING" };
    }
    return { suspectedPaths: [], stateKind: "READ_FAILED" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { suspectedPaths: [], stateKind: "CORRUPTED" };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.suspectedPaths)) {
    return { suspectedPaths: [], stateKind: "CORRUPTED" };
  }
  if (!isValidSuspectedPathsArray(parsed.suspectedPaths)) {
    return { suspectedPaths: [], stateKind: "CORRUPTED" };
  }
  return {
    suspectedPaths: parsed.suspectedPaths,
    stateKind: "OK",
  };
}

// stateKind 넷 중 "표면화 대상"(파손 계열)인 둘을 하나의 술어로 묶는다
// (§4 요구 "부재/파손/읽기 실패가 구분되고 파손은 표면화된다" -- MISSING
// 은 여기 안 낀다).
function isVanishStateSurfaceable(stateKind) {
  return stateKind === "CORRUPTED" || stateKind === "READ_FAILED";
}

// 순수 함수(시험 용이성, computeEscalationNotifications와 동일 스타일).
export function computeVanishedUnconsumedPaths({
  previousSuspectedPaths,
  existsFn,
}) {
  return (
    Array.isArray(previousSuspectedPaths) ? previousSuspectedPaths : []
  ).filter(
    (p) => typeof p === "string" && p.length > 0 && !safeExists(p, existsFn),
  );
}

function safeExists(p, existsFn) {
  try {
    return existsFn(p);
  } catch {
    // 존재 확인 자체가 던지면(권한 등) "사라졌다"로 단정하지 않는다 --
    // 이 축은 과소통지(놓침)보다 과대통지(오탐)가 더 위험한 쪽으로 이미
    // 기울어 있으므로("정상 상태에서 계속 울리면 그것 자체가 실패형",
    // §4 요구4), 확인 불가는 "아직 있다"로 보수적으로 취급한다.
    return true;
  }
}

// watchDir 하나에 저장(reach-notify-state.json과 나란히) -- runWatchOnceCore
// 안에서 detectorResult 계산 직후(로그 줄 조립 전)에 부른다, runEscalation
// DedupeStep과 동일한 시점(§4-D 원칙 재사용).
function runUnconsumedVanishStep({
  detectorResult,
  watchDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  const statePath = path.join(watchDir, "unconsumed-vanish-state.json");
  const prior = readUnconsumedVanishState(readFn, statePath);
  const vanishedPaths = computeVanishedUnconsumedPaths({
    previousSuspectedPaths: prior.suspectedPaths,
    existsFn,
  });
  const nextSuspectedPaths = Array.isArray(
    detectorResult.unconsumedWorstWorktrees,
  )
    ? detectorResult.unconsumedWorstWorktrees
    : [];
  // HYK-341-vanished-unresolved 2R P1-2: 쓰기(mkdir/write) 실패도 더 이상
  // 조용한 빈 catch가 아니다 -- 이 러너의 계약(로그 한 줄 + 생존 기록)은
  // 여전히 깨지 않지만(throw하지 않는다, runEscalationDedupeStep과 동일
  // 원칙), 실패했다는 사실 자체는 `writeFailed`로 호출자에게 돌려줘
  // 표면화 대상이 된다(다음 tick에 이번 tick의 suspectedPaths가 반영되지
  // 않았다는 뜻이므로 "쓰기 실패=CORRUPTED과 동급"으로 취급한다).
  let writeFailed = false;
  try {
    if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
    writeFn(
      statePath,
      JSON.stringify({ suspectedPaths: nextSuspectedPaths }),
      "utf8",
    );
  } catch {
    writeFailed = true;
  }
  return {
    vanishedPaths,
    stateKind: prior.stateKind,
    writeFailed,
    surfaced: isVanishStateSurfaceable(prior.stateKind) || writeFailed,
  };
}

// ---- HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①) --
// seat 축이 SUSPECTED_UNRESPONSIVE로 "새로 열릴" 때(전이 1회)만 Run
// coordinator에게 escalation 메시지 1건을 보낸다 ----
//
// dedupe 상태 파일 패턴은 escalation-notify-state.json/unconsumed-vanish-
// state.json과 동일하게 재사용한다(§2 사전확인 ⓐ⑴/§2 비타협 "기존 전이
// 판정·상태 파일 패턴 재사용") -- 다만 그 둘과 달리 이 축은 이미 "대표
// (worst-wins) worktree 하나"만 판정한다(judgeSeatLivenessAcrossWorktrees
// 자신의 설계, extractSeatIdentity 헤더 참조)이므로, 추적 대상도 Set이
// 아니라 "지금 열려 있는 대표 worktreePath 하나"(string|null)면 충분하다.
function readSeatEscalationNotifyState(readFn, statePath) {
  try {
    const text = readFn(statePath, "utf8");
    const parsed = JSON.parse(text);
    return {
      openWorktreePath:
        typeof parsed?.openWorktreePath === "string"
          ? parsed.openWorktreePath
          : null,
      stateMissing: false,
    };
  } catch {
    // fail-open(runEscalationDedupeStep과 동일 원칙, §2 product_scope ①
    // "미설정이면 보내기 생략 ... 받는함 통지는 그대로"의 자매 규칙 --
    // dedupe 상태를 못 읽으면 "직전엔 닫혀 있었다"로 접어 전송 후보로
    // 취급한다. fail-closed(조용히 억제)는 이 트랙이 잡으려는 실패
    // (방치된 좌석을 아무도 못 봄)를 dedupe 층에서 재생산하기 때문이다.
    return { openWorktreePath: null, stateMissing: true };
  }
}

// 순수 함수(시험 용이성, computeEscalationNotifications와 동일 스타일) --
// 이번 tick의 대표 SUSPECTED_UNRESPONSIVE worktreePath(없으면 null)와
// 직전 tick의 값을 비교해 "새로 열렸는가"만 답한다. 같은 worktree가
// 계속 열려 있으면(현재와 직전이 같은 non-null 문자열) false -- 반복
// 회차 재통지 금지(§2 product_scope ① "같은 이상이 이어지는 회차는
// 0건"). 닫혔다가 나중에 다시 열리면(현재 != 직전, 둘 다 non-null이어도)
// true -- 이것도 "새로 열림"이다.
export function isSeatUnresponsiveNewlyOpened({
  currentOpenWorktreePath,
  priorOpenWorktreePath,
}) {
  if (
    typeof currentOpenWorktreePath !== "string" ||
    currentOpenWorktreePath.length === 0
  ) {
    return false;
  }
  return currentOpenWorktreePath !== priorOpenWorktreePath;
}

// ⓐ⑶ Run id 후보 중 "관제실 파일"을 택했다(결과 파일 §2ⓐ⑶ 근거 참조) --
// stop-reasons.json(orch-stall-detect.mjs resolveStopReasonsPathFromCli)과
// 동일한 위치(watchDir의 부모 = CONTROL_ROOM_PATH, 예약 작업이 늘 쓰는
// `${CONTROL_ROOM_PATH}/watch`)에 사람/ORCH가 두는 설정 파일이다. 없거나
// 형식이 틀리면 null(=NO_RUN_CONFIGURED, 호출부가 그 사유로 보내기를
// 생략한다) -- ⛔예약 작업 정의(schedule-plan-core.mjs)는 이 라운드가
// 건드리지 않는다(product_scope 밖), 그래서 이 파일은 새 CLI 인자 없이
// 이미 받는 watchDir에서 유도된다(resolveStopReasonsPathFromCli와 동일
// 관례).
function readRunIdConfig(readFn, runIdPath) {
  try {
    const text = readFn(runIdPath, "utf8");
    const parsed = JSON.parse(text);
    return typeof parsed?.runId === "string" && parsed.runId.length > 0
      ? parsed.runId
      : null;
  } catch {
    return null;
  }
}

// escalation 메시지 body 조립 -- 요구된 5칸(좌석 handle·워크트리·배달
// 라벨·무출력 분·마지막 출력 시각)을 한 줄로 낸다. extractSeatIdentity가
// 이미 좌석 식별 4값+referencePointMs를 모아놨으므로 여기서는 포맷만
// 한다(재구현 0, seatDetailSegment와 같은 재료를 사람이 읽는 다른 모양
// 으로 한 번 더 쓸 뿐).
export function buildSeatEscalationBody(identity) {
  const minutes =
    typeof identity.elapsedMs === "number" &&
    Number.isFinite(identity.elapsedMs)
      ? Math.floor(identity.elapsedMs / 60000)
      : "NONE";
  const lastOutput =
    typeof identity.referencePointMs === "number" &&
    Number.isFinite(identity.referencePointMs)
      ? new Date(identity.referencePointMs).toISOString()
      : "NONE";
  return (
    `seat=${identity.handle ?? "NONE"} worktree=${identity.worktreePath ?? "NONE"} ` +
    `dispatch=${identity.dispatchLabel ?? "NONE"} no_output_min=${minutes} ` +
    `last_output=${lastOutput}`
  );
}

// runSeatEscalationStep({identity, watchDir, readFn, writeFn, existsFn,
// mkdirFn, execFn}) -- computePreLogDedupeSteps가 로그 줄 조립 *전*에
// 부른다(escalationDedupe/unconsumedVanish와 동일 지점·동일 원칙).
// `identity`는 extractSeatIdentity(seatLiveness)의 결과(SUSPECTED_
// UNRESPONSIVE가 아니면 null)다.
//
// 반환 `{attempted, sent, reason, handle, worktreePath, stateMissing}` --
// attempted=false면 이번 tick에 보낼 거리가 아예 없었다(닫혀 있거나
// 계속 같은 이상이 열려 있음, 재통지 억제). attempted=true인데 sent=false
// 면 NO_RUN_CONFIGURED 또는 SEND_FAILED:<사유> -- 어느 쪽이든 §2
// product_scope ① 비타협대로 **이 함수 자신은 throw하지 않는다**(runReach
// Step/runEscalationDedupeStep과 동일 "이 단계 자신의 실패가 감시기
// 전체를 죽이면 안 된다" 원칙) -- 받는함 통지(reach 단계)는 이 단계와
// 완전히 분리된 호출이라 이 단계의 실패와 무관하게 그대로 실행된다
// (fail-open, §2 product_scope ① "보내기 실패는 받는함 통지를 막지
// 않는다").
// runSeatEscalationStep에서 분리(§6 eslint max-lines-per-function 상한
// 준수) -- "새로 열렸다"가 확정된 뒤의 실제 전송 시도(run id 조회 + send +
// 성공/실패 분류)만 담당한다. 로직·값은 원문 그대로, 자리만 옮겼다.
// wake-wire.mjs:214/227(sendTextThenSubmit)과 같은 모양 -- orca의 일반
// 오류(비0 종료 + `{"ok":false,...}`)는 throw가 아니라 반환값으로 온다
// (createOrcaExecFn, orca-adapter.mjs:4001). `result.error.code`가 가장
// 사람이 읽기 좋은 사유이므로 우선하고, 없으면 `result.reason`(orca-
// adapter.mjs의 JSON-parse-실패 경로), 둘 다 없으면 원문 JSON을 그대로
// 보여준다(지어내지 않는다).
function extractSendFailureReason(result) {
  if (isPlainObject(result)) {
    if (isPlainObject(result.error) && typeof result.error.code === "string") {
      return result.error.code;
    }
    if (typeof result.reason === "string") return result.reason;
  }
  return JSON.stringify(result);
}

function attemptSeatEscalationSend({ identity, readFn, runIdPath, execFn }) {
  const runId = readRunIdConfig(readFn, runIdPath);
  if (!runId) {
    return {
      attempted: true,
      sent: false,
      reason: "NO_RUN_CONFIGURED",
      handle: identity.handle,
      worktreePath: identity.worktreePath,
    };
  }
  const subject = `seat unresponsive: ${identity.handle ?? identity.worktreePath}`;
  const body = buildSeatEscalationBody(identity);
  try {
    const result = execFn(
      buildSeatEscalationSendCommand({ runId, subject, body }),
    );
    if (!isPlainObject(result) || result.ok !== true) {
      return {
        attempted: true,
        sent: false,
        reason: `SEND_FAILED:${truncateToken(
          sanitizeFailureToken(extractSendFailureReason(result), "send_failed"),
          MAX_PARTIAL_FAILURE_REASON_CHARS,
        )}`,
        handle: identity.handle,
        worktreePath: identity.worktreePath,
      };
    }
    return {
      attempted: true,
      sent: true,
      reason: null,
      handle: identity.handle,
      worktreePath: identity.worktreePath,
    };
  } catch (err) {
    return {
      attempted: true,
      sent: false,
      reason: `SEND_FAILED:${truncateToken(
        sanitizeFailureToken(
          err && err.message ? err.message : String(err),
          "send_failed",
        ),
        MAX_PARTIAL_FAILURE_REASON_CHARS,
      )}`,
      handle: identity.handle,
      worktreePath: identity.worktreePath,
    };
  }
}

function runSeatEscalationStep({
  identity,
  watchDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
  execFn,
}) {
  const statePath = path.join(watchDir, "seat-escalation-notify-state.json");
  const prior = readSeatEscalationNotifyState(readFn, statePath);
  const currentOpenWorktreePath = isPlainObject(identity)
    ? identity.worktreePath
    : null;
  const newlyOpened = isSeatUnresponsiveNewlyOpened({
    currentOpenWorktreePath,
    priorOpenWorktreePath: prior.openWorktreePath,
  });
  // 상태는 전송 성공 여부와 무관하게 "지금 열려 있는가"로 항상 갱신한다
  // (escalationDedupe의 전이 추적과 동일 원칙 -- 전송 실패를 재시도하는
  // 것은 이 라운드의 계약 밖이다, 아래 §한계 참조). 쓰기 실패는 조용히
  // 접지 않지만(runUnconsumedVanishStep과 동일 원칙) 이 단계의 반환값을
  // 막지 않는다 -- 다음 tick에 fail-open으로 다시 전부 재통지 후보가
  // 될 뿐이다.
  try {
    if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
    writeFn(
      statePath,
      JSON.stringify({ openWorktreePath: currentOpenWorktreePath }),
      "utf8",
    );
  } catch {
    // fail-open, 다음 tick 재시도(위 주석).
  }
  if (!newlyOpened) {
    return {
      attempted: false,
      sent: false,
      reason: null,
      handle: null,
      worktreePath: null,
      stateMissing: prior.stateMissing,
    };
  }
  const runIdPath = path.join(path.dirname(watchDir), "run-id.json");
  return {
    ...attemptSeatEscalationSend({ identity, readFn, runIdPath, execFn }),
    stateMissing: prior.stateMissing,
  };
}

// ---- HYK-493-memory-reopen-1 (coder-task.md §1 F-2 · §2 product_scope) --
// 게이트 닫힘 뒤 메모리 재개 재시도 깨움 ----
//
// 이 단계는 "재고 알릴" 뿐이다 -- 좌석·러너·게이트는 이 단계가 절대
// 띄우지 않는다(ORCH가 그 판단을 다시 한다, §3 완료조건4 한계 문단 참조).
// 상태 파일의 유일한 생산자는 관제실 memory-gate.ps1(Write-GateState)이고
// 이 단계는 그 파일을 읽기만 한다(§1 비타협 -- 그 스크립트를 고치지
// 않는다).

// readMemoryGateState -- <watchDir>/memory-gate-state.json을 읽어 v1
// 스키마인지 확인한다. 파일 없음/JSON 파싱 실패/스키마 불일치는 모두
// "판정 불가"로 접는다(throw하지 않는다 -- runDetector/runReachStep과
// 동일 "이 단계 자신의 실패가 감시기 전체를 죽이면 안 된다" 원칙).
function readMemoryGateState(readFn, statePath) {
  let text;
  try {
    text = readFn(statePath, "utf8");
  } catch {
    return { ok: false, reasonToken: "MEMORY_REOPEN_STATE_MISSING" };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reasonToken: "MEMORY_REOPEN_STATE_INVALID_JSON" };
  }
  if (!isPlainObject(parsed) || parsed.schema !== MEMORY_GATE_SCHEMA_V1) {
    return { ok: false, reasonToken: "MEMORY_REOPEN_SCHEMA_MISMATCH" };
  }
  return {
    ok: true,
    status: pickString(parsed, "status"),
    dryRun: parsed.dry_run === true,
    thresholdMb:
      typeof parsed.threshold_mb === "number" ? parsed.threshold_mb : null,
    closedAt: pickString(parsed, "closed_at"),
    round: pickString(parsed, "round"),
    pendingCmd: pickString(parsed, "pending_cmd"),
  };
}

// readMemoryReopenNotifyState -- dedupe 상태(통지한 closed_at 1개, seat
// escalation의 openWorktreePath와 동일한 "직전 값 하나만" 모양). 읽기
// 실패는 fail-open(runEscalationDedupeStep과 동일 원칙) -- "직전엔 통지
// 안 됨"으로 접어 전송 후보로 취급한다.
function readMemoryReopenNotifyState(readFn, statePath) {
  try {
    const text = readFn(statePath, "utf8");
    const parsed = JSON.parse(text);
    return {
      notifiedClosedAt:
        typeof parsed?.notifiedClosedAt === "string"
          ? parsed.notifiedClosedAt
          : null,
      stateMissing: false,
    };
  } catch {
    return { notifiedClosedAt: null, stateMissing: true };
  }
}

// buildMemoryReopenBody -- 요구된 5칸(round·threshold·두 표본·closed_at·
// pending_cmd)을 한 줄로 낸다(buildSeatEscalationBody와 동일한 "사람이
// 읽는 본문 조립" 원칙). 이 문자열은 watch.log 줄이 아니라 orchestration
// send의 --body 인자 하나이므로(배열 원소 그대로 전달, 쉘 재해석 없음)
// 토큰 공백 치환이 필요 없다(sanitizeFailureToken은 watch.log 필드 전용).
function buildMemoryReopenBody({
  round,
  thresholdMb,
  freeSamples,
  closedAt,
  pendingCmd,
}) {
  const samplesText = Array.isArray(freeSamples)
    ? freeSamples.join(",")
    : "NONE";
  return (
    `round=${round ?? "NONE"} threshold_mb=${thresholdMb ?? "NONE"} ` +
    `free_samples_mb=${samplesText} closed_at=${closedAt ?? "NONE"} ` +
    `pending_cmd=${pendingCmd ?? "NONE"}`
  );
}

// attemptMemoryReopenSend -- attemptSeatEscalationSend과 동일한 모양으로
// "기존 통로"를 그대로 재사용한다(§2 product_scope ⓘ "buildSeatEscalation
// SendCommand와 같은 ... run id = 기존 run-id.json 읽기 함수 재사용") --
// 새 adapter 명령 모양을 만들지 않는다(deviation_rule 비타협).
function attemptMemoryReopenSend({ readFn, runIdPath, execFn, subject, body }) {
  const runId = readRunIdConfig(readFn, runIdPath);
  if (!runId) {
    return {
      attempted: true,
      sent: false,
      reasonToken: "MEMORY_REOPEN_NO_RUN_CONFIGURED",
    };
  }
  try {
    const result = execFn(
      buildSeatEscalationSendCommand({ runId, subject, body }),
    );
    if (!isPlainObject(result) || result.ok !== true) {
      return {
        attempted: true,
        sent: false,
        reasonToken: `MEMORY_REOPEN_SEND_FAILED:${truncateToken(
          sanitizeFailureToken(extractSendFailureReason(result), "send_failed"),
          MAX_PARTIAL_FAILURE_REASON_CHARS,
        )}`,
      };
    }
    return { attempted: true, sent: true, reasonToken: null };
  } catch (err) {
    return {
      attempted: true,
      sent: false,
      reasonToken: `MEMORY_REOPEN_SEND_FAILED:${truncateToken(
        sanitizeFailureToken(
          err && err.message ? err.message : String(err),
          "send_failed",
        ),
        MAX_PARTIAL_FAILURE_REASON_CHARS,
      )}`,
    };
  }
}

// finishMemoryReopenEligible -- runMemoryReopenStep에서 분리(§6 eslint
// max-lines-per-function 상한 준수). 두 표본이 이미 문턱+여유를 넘긴
// 뒤에만 불린다: dedupe(같은 closed_at 재통지 금지) -> 전송 시도 ->
// 성공했을 때만 상태 기록(실패는 다음 tick 재시도, seat escalation 단계와
// 동일 원칙).
function finishMemoryReopenEligible({
  gate,
  freeSamples,
  watchDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
  execFn,
}) {
  const statePath = path.join(watchDir, "memory-reopen-notify-state.json");
  const prior = readMemoryReopenNotifyState(readFn, statePath);
  if (prior.notifiedClosedAt === gate.closedAt) {
    return {
      sampled: true,
      sent: false,
      freeSamples,
      reasonToken: "MEMORY_REOPEN_ALREADY_NOTIFIED",
      stateMissing: prior.stateMissing,
    };
  }
  const subject = "memory reopened: gate retry";
  const body = buildMemoryReopenBody({
    round: gate.round,
    thresholdMb: gate.thresholdMb,
    freeSamples,
    closedAt: gate.closedAt,
    pendingCmd: gate.pendingCmd,
  });
  const runIdPath = path.join(path.dirname(watchDir), "run-id.json");
  const sendResult = attemptMemoryReopenSend({
    readFn,
    runIdPath,
    execFn,
    subject,
    body,
  });
  if (sendResult.sent) {
    try {
      if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
      writeFn(
        statePath,
        JSON.stringify({ notifiedClosedAt: gate.closedAt }),
        "utf8",
      );
    } catch {
      // fail-open(runSeatEscalationStep과 동일 원칙) -- 다음 tick 재시도.
    }
  }
  return {
    sampled: true,
    sent: sendResult.sent,
    freeSamples,
    reasonToken: sendResult.reasonToken,
    stateMissing: prior.stateMissing,
  };
}

// defaultMemoryReopenFreeSampleMb -- 주입 가능한 seam의 기본값(§2
// product_scope ⓘ "기본 = os.freemem()를 MB로"). 시험은 항상 다른
// sampleFn을 주입한다(§2 비타협 "라이브 측정 0").
function defaultMemoryReopenFreeSampleMb() {
  return Math.floor(os.freemem() / (1024 * 1024));
}

// defaultMemoryReopenSleep -- isolated-suite-runner.mjs의 defaultSleepSync
// (305행 근처)와 동일한 관례: Atomics.wait로 실제로 블록한다(바쁜 대기
// 아님). 시험은 항상 sleepFn을 주입해 이 기본값을 쓰지 않는다(§2 비타협
// "라이브 간격 0" -- 시험이 실제로 30초씩 느려지는 것을 막기 위함).
function defaultMemoryReopenSleep(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, Math.max(0, Number(ms) || 0));
}

// runMemoryReopenStep -- computePreLogDedupeSteps가 로그 줄 조립 *전*에
// 부른다(seatEscalation과 동일 지점·동일 "opt-in 아님, watchDir만 있으면
// 항상 돈다" 원칙). status==="closed"이고 dry_run이 아닐 때만 두 표본을
// 재고, 두 표본 모두 threshold_mb+여유를 넘을 때만 dedupe+전송으로 넘어간다
// (finishMemoryReopenEligible). 그 밖의 모든 경로는 sampleFn/execFn을 호출
// 하지 않고 사유 토큰만 돌려준다(§2ⓒ⑸ "재측 seam 호출 0").
function runMemoryReopenStep({
  watchDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
  execFn,
  sampleFn,
  sleepFn,
}) {
  const gateStatePath = path.join(watchDir, "memory-gate-state.json");
  const gate = readMemoryGateState(readFn, gateStatePath);
  if (!gate.ok) {
    return { sampled: false, sent: false, reasonToken: gate.reasonToken };
  }
  if (gate.status !== "closed") {
    return {
      sampled: false,
      sent: false,
      reasonToken: "MEMORY_REOPEN_STATUS_NOT_CLOSED",
    };
  }
  if (gate.dryRun) {
    return {
      sampled: false,
      sent: false,
      reasonToken: "MEMORY_REOPEN_DRY_RUN",
    };
  }
  const sample1 = sampleFn();
  sleepFn(MEMORY_REOPEN_SAMPLE_INTERVAL_MS);
  const sample2 = sampleFn();
  const freeSamples = [sample1, sample2];
  const requiredMb = (gate.thresholdMb ?? 0) + MEMORY_REOPEN_MARGIN_MB;
  const meetsLine = freeSamples.every(
    (s) => typeof s === "number" && Number.isFinite(s) && s >= requiredMb,
  );
  if (!meetsLine) {
    return {
      sampled: true,
      sent: false,
      freeSamples,
      reasonToken: "MEMORY_REOPEN_BELOW_LINE",
    };
  }
  return finishMemoryReopenEligible({
    gate,
    freeSamples,
    watchDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
    execFn,
  });
}

// memoryReopenLogSegment -- capLogSegment와 같은 "항상 있음" 원칙(§2ⓒ⑸
// "로그 꼬리 사유 토큰 원문" -- 미달/전송 실패뿐 아니라 판정 불가 경로도
// 전부 사유 토큰을 남긴다). memoryReopen이 주어지지 않은(기존 buildLogLine
// 직접 호출자, opt-in 아님이지만 기존 단위 시험 호출자는 이 인자를 안 줄
// 수 있다) 경우만 null -- 그 경우 로그 줄이 한 글자도 달라지지 않는다.
function memoryReopenLogSegment(memoryReopen) {
  if (!isPlainObject(memoryReopen)) return null;
  const sent = memoryReopen.sent === true ? "true" : "false";
  const reason = memoryReopen.reasonToken ?? "NONE";
  return `memory_reopen_sent=${sent} memory_reopen_reason=${reason}`;
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

// HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①): seat
// 축이 새로 열릴 때 보낸(또는 보내지 못한) escalation 메시지 1건의 결과를
// 사람이 읽는 상세로 남긴다 -- escalationDetailSegment와 같은 "이번 tick에
// 실제로 뭔가 있었을 때만 세그먼트를 더한다" 원칙(attempted=false면 null).
function formatSeatEscalationEntry(result) {
  const handle = sanitizeFailureToken(result.handle, "unknown_handle");
  const wt = sanitizeFailureToken(result.worktreePath, "unknown_worktree");
  const outcome = result.sent
    ? "SENT"
    : `SKIP:${sanitizeFailureToken(result.reason, "unknown_reason")}`;
  return `${handle}@${wt}:${outcome}`;
}

function seatEscalationDetailSegment(seatEscalation) {
  if (!isPlainObject(seatEscalation) || seatEscalation.attempted !== true) {
    return null;
  }
  const detail = formatSeatEscalationEntry(seatEscalation);
  const dedupeNote = seatEscalation.stateMissing
    ? " seat_escalation_dedupe_state=MISSING"
    : "";
  return `seat_escalation_attempted=1 seat_escalation_detail=${detail}${dedupeNote}`;
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

// HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①③):
// chainDetailSegment/bindingDetailSegment와 동일한 "verdict가 그 축의
// 나쁜 값일 때만 상세를 붙인다" 원칙 -- identity가 null이면(정상/판정불가/
// SUSPECTED_UNRESPONSIVE가 아님) 아무 것도 더하지 않는다(buildLogLine이
// filter(Boolean)으로 걸러낸다, 기존 정상 로그 줄 형식 불변).
// ★토큰 형식(공백 금지 -- reach-report-core.mjs의 LOG_LINE_RE/parseFieldTokens
// 가 `/\s+/`로 토큰을 가르므로, 값 안에 raw whitespace가 있으면 다음 필드
// 파싱이 깨진다): sanitizeFailureToken이 내부 공백을 밑줄로 접는다(기존
// chainDetailSegment 등과 동일 관례) -- 콜론·`@`은 안전하다(parseFieldTokens
// 는 첫 `=`만 분리점으로 쓴다).
function seatDetailSegment(identity) {
  if (!isPlainObject(identity)) return null;
  const handle = sanitizeFailureToken(identity.handle, "unknown_handle");
  const wt = sanitizeFailureToken(identity.worktreePath, "unknown_worktree");
  const label = sanitizeFailureToken(
    identity.dispatchLabel,
    "unknown_dispatch",
  );
  const minutes =
    typeof identity.elapsedMs === "number" &&
    Number.isFinite(identity.elapsedMs)
      ? Math.floor(identity.elapsedMs / 60000)
      : "NONE";
  const lastOutput =
    typeof identity.referencePointMs === "number" &&
    Number.isFinite(identity.referencePointMs)
      ? new Date(identity.referencePointMs).toISOString()
      : "NONE";
  return `seat_detail=${handle}@${wt}:${label}:${minutes}m:${lastOutput}`;
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
  // HYK-464-watch-collection-1 3R P1-3: 같은 두 축(seat/idle)의 제외 상세도
  // 여기서 함께 조립한다(위 excludedUndeliveredLogSegment 헤더 참조) --
  // 새 축이 아니라 기존 두 축에 상세 세그먼트를 하나 더하는 것뿐이다.
  const seatExcludedUndeliveredDetail = excludedUndeliveredLogSegment(
    "seat",
    detectorResult.seatLivenessExcludedUndeliveredTaskFiles,
  );
  const idleExcludedUndeliveredDetail = excludedUndeliveredLogSegment(
    "idle",
    detectorResult.seatIdleExcludedUndeliveredTaskFiles,
  );
  // HYK-464-idle-stop-reason-1 (coder-task.md §2ⓒⓔ): 세 세그먼트 모두
  // "지금 이 시점의 맨 끝"에 붙는다(buildLogLine 참조) -- 이 세 줄은 그
  // 값만 조립하고, 자리는 buildLogLine이 정한다.
  const idleWorstDetail = idleWorstSegment(
    detectorResult.seatIdleWorstWorktrees,
  );
  const idleParkedDetail = idleParkedSegment(
    detectorResult.seatIdleParkedWorktrees,
    detectorResult.seatIdleParkedReasonIds,
  );
  const idleStopReasonsDetail = idleStopReasonsSegment(
    detectorResult.seatIdleStopReasonsStatus,
    detectorResult.seatIdleStopReasonsDetail,
  );
  // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①③):
  // SUSPECTED_UNRESPONSIVE일 때만 좌석 식별 상세를 덧붙인다(chainDetailSegment/
  // bindingDetailSegment와 동일 원칙 -- 정상/판정불가는 4필드 세그먼트만으로
  // 충분, 소음 최소화). reach-report-core.mjs가 이 `seat_detail` 필드를
  // 읽어 받는함/아침 보고의 "좌석 무응답" 행에 그대로 옮겨 적는다(wire ③).
  const seatDetail = seatDetailSegment(detectorResult.seatLivenessIdentity);
  return {
    seatSegment,
    seatFailureSegment,
    seatReasonDetail,
    seatExcludedUndeliveredDetail,
    seatDetail,
    idleSegment,
    idleReasonDetail,
    idleExcludedUndeliveredDetail,
    idleWorstDetail,
    idleParkedDetail,
    idleStopReasonsDetail,
  };
}

// buildSeatIdleSegments와 대칭(start+unconsumed 두 축, §6 상한 준수를
// 위해 같은 이유로 분리).
//
// HYK-341-vanished-unresolved (coder-task.md §4 요구6 "새 상태가 사람에게
// 도달하는지 확인하고, 안 가면 그 결선까지 포함"): `unconsumedVanish`가
// 주어지고(runUnconsumedVanishStep의 결과) vanishedPaths가 있으면, 이번
// tick의 unconsumed 축 verdict를 그대로 두지 않고 "VANISHED_UNRESOLVED"로
// 덮어써서 로그에 남긴다 -- ★새 축을 만드는 것이 아니라(reach-report-
// core.mjs AXES가 unconsumed 하나를 이미 갖고 있고, escalation-axis-
// wire.test.mjs가 그 배열에 세 번째 항목이 조용히 늘어나지 않음을
// 고정한다) 그 축의 verdict 필드가 취할 수 있는 값을 하나 늘리는
// 것뿐이다(reach-report-core.mjs의 unconsumed axis badVerdicts를 그
// 값까지 포함하도록 확장 -- 같은 파일). unconsumedVanish가 없는(기존)
// 호출자는 이 분기를 타지 않으므로 unconsumedSegment는 byte-identical
// (회귀 0).
function buildStartUnconsumedSegments(detectorResult, unconsumedVanish) {
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
  const vanishedPaths = unconsumedVanish?.vanishedPaths ?? [];
  const effectiveUnconsumedVerdict =
    vanishedPaths.length > 0
      ? "VANISHED_UNRESOLVED"
      : detectorResult.unconsumedVerdict;
  // HYK-341-vanished-unresolved 2R P1-2 (검토 원문 요구2 "그 사실을
  // 로그·통지 축에 표면화하라"): vanish 상태 파일이 파손됐거나(§4 상단
  // isVanishStateSurfaceable) 이번 tick의 쓰기 자체가 실패했으면, verdict
  // 와 같은 자리(기존 "unconsumed" 축의 기존 필드)의 status 값을 덮어써
  // reach 축(badStatuses)까지 닿게 한다 -- verdict 덮어쓰기와 정확히
  // 같은 기법(새 필드/새 축이 아니라 기존 필드가 취할 수 있는 값을
  // 하나 늘린다). unconsumedVanish가 없거나 surfaced가 아니면(기존
  // 호출자·정상 tick) byte-identical(회귀 0).
  const effectiveUnconsumedStatus = unconsumedVanish?.surfaced
    ? "UNCONSUMED_VANISH_STATE_CORRUPTED"
    : detectorResult.unconsumedStatus;
  const unconsumedSegment = axisLogSegment("unconsumed", {
    status: effectiveUnconsumedStatus,
    verdict: effectiveUnconsumedVerdict,
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
  const unconsumedVanishedDetail = unconsumedVanishedSegment(vanishedPaths);
  // HYK-464-watch-collection-1 3R P1-3: start 축의 제외 상세도 여기서
  // 함께 조립한다(seat/idle과 동일 이유, buildSeatIdleSegments 참조).
  const startExcludedUndeliveredDetail = excludedUndeliveredLogSegment(
    "start",
    detectorResult.startExcludedUndeliveredTaskFiles,
  );
  // HYK-464-watch-start-axis-1 ⓒ: 위 sizeObservationUnavailableLogSegment
  // 헤더 참조 -- start 축에만 붙는 새 상세(관측 불가 사유 코드).
  const startSizeObservationUnavailableDetail =
    sizeObservationUnavailableLogSegment(
      detectorResult.startSizeObservationUnavailable,
    );
  return {
    startSegment,
    startFailureSegment,
    startReasonDetail,
    startExcludedUndeliveredDetail,
    startSizeObservationUnavailableDetail,
    unconsumedSegment,
    unconsumedReasonDetail,
    unconsumedWorstDetail,
    unconsumedVanishedDetail,
  };
}

// unconsumedWorstSegment와 동일한 "상한 + N_more" 관례(§4 요구6, 새 형식
// 발명 금지). vanishedPaths가 비어 있으면(정상, 대부분의 tick) 세그먼트
// 자체를 안 붙인다.
function unconsumedVanishedSegment(vanishedPaths) {
  if (!Array.isArray(vanishedPaths) || vanishedPaths.length === 0) {
    return null;
  }
  const shown = vanishedPaths
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map(worktreeShortName);
  const omitted = vanishedPaths.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `unconsumed_vanished_worktrees=${vanishedPaths.length} unconsumed_vanished_worktree_detail=${detail}`;
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

// HYK-464-idle-stop-reason-1 (coder-task.md §2ⓔ) -- unconsumedWorstSegment와
// 동일한 "상한 + N_more" 관례(새 형식 발명 0). 유휴 축 가장 나쁜(worst)
// 워크트리가 없으면(정상 회차, orch-stall-detect.mjs judgeSeatIdleAcrossWorktrees
// 참조) 세그먼트 자체를 안 붙인다 -- "정상 상태의 로그 줄을 조용히
// 유지"(§2-3 비타협)와 동일.
function idleWorstSegment(worstWorktrees) {
  if (!Array.isArray(worstWorktrees) || worstWorktrees.length === 0) {
    return null;
  }
  const shown = worstWorktrees
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map(worktreeShortName);
  const omitted = worstWorktrees.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `idle_worst_worktrees=${worstWorktrees.length} idle_worst_worktree_detail=${detail}`;
}

// HYK-464-idle-stop-reason-1 (coder-task.md §2ⓒ) -- 동일한 "상한 +
// N_more" 관례. 각 워크트리 이름 뒤에 그 워크트리를 덮은 정지 사유 id를
// 붙인다(사유 id가 줄에 보여야 한다, coder-task.md §1 1b_shown 원문).
// 사유 있는 존치 워크트리가 없으면(가장 흔한 정상 회차) 세그먼트 자체를
// 안 붙인다.
function idleParkedSegment(parkedWorktrees, parkedReasonIds) {
  if (!Array.isArray(parkedWorktrees) || parkedWorktrees.length === 0) {
    return null;
  }
  const shown = parkedWorktrees
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map((p, i) => {
      const name = worktreeShortName(p);
      const reasonId = Array.isArray(parkedReasonIds)
        ? parkedReasonIds[i]
        : null;
      return reasonId
        ? `${name}:${sanitizeFailureToken(reasonId, "unknown_reason")}`
        : name;
    });
  const omitted = parkedWorktrees.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `idle_parked=${parkedWorktrees.length} idle_parked_detail=${detail}`;
}

// HYK-464-idle-stop-reason-1 (coder-task.md §2ⓓ) -- 정지 사유 파일 자체의
// 상태(부재/있음/있는데 읽기·파싱·형식 실패)를 조용한 낙하 없이 로그
// 줄까지 옮긴다. status가 없으면(구버전 감지기 stdout 등) 세그먼트 자체를
// 안 붙인다 -- 기존 호출자 회귀 0.
function idleStopReasonsSegment(status, detail) {
  if (typeof status !== "string" || status.length === 0) return null;
  const detailToken = truncateToken(
    sanitizeFailureToken(detail, "none"),
    MAX_PARTIAL_FAILURE_REASON_CHARS,
  );
  return `idle_stop_reasons_status=${status} idle_stop_reasons_detail=${detailToken}`;
}

// ★HYK-464-watch-start-axis-1 ⓒ: excludedUndeliveredLogSegment와 동일한
// "상한 + N_more" 관례(새 형식 발명 0) -- 관측 불가 항목이 없으면(가장
// 흔한 정상 회차) 이 축의 로그 줄에 아무 것도 더하지 않는다(null).
function formatSizeObservationUnavailableEntry(item) {
  const worktree = worktreeShortName(
    isPlainObject(item) ? item.worktreePath : null,
  );
  const code = sanitizeFailureToken(
    isPlainObject(item) ? item.reasonCode : null,
    "unknown_reason",
  );
  return `${worktree}:${code}`;
}

function sizeObservationUnavailableLogSegment(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const shown = items
    .slice(0, MAX_PARTIAL_FAILURE_ITEMS)
    .map(formatSizeObservationUnavailableEntry);
  const omitted = items.length - shown.length;
  const detail =
    omitted > 0 ? `${shown.join("|")}|+${omitted}_more` : shown.join("|");
  return `start_size_observation_unavailable=${items.length} start_size_observation_unavailable_detail=${detail}`;
}

function buildSeatIdleStartUnconsumedSegments(
  detectorResult,
  unconsumedVanish,
) {
  return {
    ...buildSeatIdleSegments(detectorResult),
    ...buildStartUnconsumedSegments(detectorResult, unconsumedVanish),
  };
}

// buildAxisLogSegments에서 분리(§6 eslint max-lines-per-function 상한
// 준수) -- escalation/postcheck/chain/binding/seatEscalation 다섯 "맨 끝에
// 붙는" 세그먼트 조립만 모은다. 로직·값·순서는 원문 그대로, 자리만 옮겼다.
function buildTailAxisSegments(
  detectorResult,
  escalationDedupe,
  seatEscalation,
) {
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
  // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①): 새
  // 축은 언제나 맨 끝에 붙는다(기존 모든 세그먼트의 필드·순서·값 불변,
  // 지금까지의 모든 라운드와 동일한 설계 제약). seatEscalation이 주어지지
  // 않은(기존 호출자, opt-in 아님이지만 기존 단위 시험은 이 인자를 안 줄
  // 수 있다) 경우 seatEscalationDetailSegment가 null을 돌려주므로
  // (filter(Boolean)) 로그 줄이 한 글자도 달라지지 않는다.
  const seatEscalationDetail = seatEscalationDetailSegment(seatEscalation);
  return {
    escalationSegment,
    escalationDetail,
    postcheckSegment,
    postcheckDetail,
    chainSegment,
    chainDetail,
    bindingSegment,
    bindingDetail,
    seatEscalationDetail,
  };
}

function buildAxisLogSegments(
  detectorResult,
  capResult,
  escalationDedupe,
  unconsumedVanish,
  seatEscalation,
) {
  const {
    seatSegment,
    seatFailureSegment,
    seatReasonDetail,
    seatExcludedUndeliveredDetail,
    seatDetail,
    idleSegment,
    idleReasonDetail,
    idleExcludedUndeliveredDetail,
    idleWorstDetail,
    idleParkedDetail,
    idleStopReasonsDetail,
    startSegment,
    startFailureSegment,
    startReasonDetail,
    startExcludedUndeliveredDetail,
    startSizeObservationUnavailableDetail,
    unconsumedSegment,
    unconsumedReasonDetail,
    unconsumedWorstDetail,
    unconsumedVanishedDetail,
  } = buildSeatIdleStartUnconsumedSegments(detectorResult, unconsumedVanish);
  const capSegment = capLogSegment(capResult ?? {});
  const {
    escalationSegment,
    escalationDetail,
    postcheckSegment,
    postcheckDetail,
    chainSegment,
    chainDetail,
    bindingSegment,
    bindingDetail,
    seatEscalationDetail,
  } = buildTailAxisSegments(detectorResult, escalationDedupe, seatEscalation);
  return {
    seatSegment,
    seatFailureSegment,
    seatReasonDetail,
    seatExcludedUndeliveredDetail,
    seatDetail,
    seatEscalationDetail,
    idleSegment,
    idleReasonDetail,
    idleExcludedUndeliveredDetail,
    idleWorstDetail,
    idleParkedDetail,
    idleStopReasonsDetail,
    startSegment,
    startFailureSegment,
    startReasonDetail,
    startExcludedUndeliveredDetail,
    startSizeObservationUnavailableDetail,
    unconsumedSegment,
    unconsumedReasonDetail,
    unconsumedWorstDetail,
    unconsumedVanishedDetail,
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
  blockedTerminationResult,
  // HYK-341-vanished-unresolved (coder-task.md §4): 기존 호출자 전부는
  // 이 인자를 안 주므로 undefined -> buildStartUnconsumedSegments의
  // vanishedPaths는 빈 배열 -> unconsumedSegment/unconsumedVanishedDetail
  // 둘 다 byte-identical(회귀 0).
  unconsumedVanish,
  // HYK-464-followup-1 축C: 기존 호출자 전부는 이 인자를 안 주므로
  // undefined -> resourceResidueLogSegment가 null을 돌려주므로
  // (filter(Boolean)) 로그 줄이 한 글자도 달라지지 않는다(회귀 0).
  resourceResidueResult,
  // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①):
  // 기존 호출자 전부는 이 인자를 안 주므로 undefined ->
  // seatEscalationDetailSegment가 null을 돌려주므로(filter(Boolean)) 로그
  // 줄이 한 글자도 달라지지 않는다(회귀 0). seatDetail(segments 안)은
  // detectorResult.seatLivenessIdentity가 없으면(구버전 stdout 등) 역시
  // null이다.
  seatEscalation,
  // HYK-493-memory-reopen-1 (coder-task.md §2 product_scope): 기존 호출자
  // 전부는 이 인자를 안 주므로 undefined -> memoryReopenLogSegment가
  // null을 돌려주므로(filter(Boolean)) 로그 줄이 한 글자도 달라지지
  // 않는다(회귀 0).
  memoryReopen,
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
    unconsumedVanish,
    seatEscalation,
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
    // HYK-342/HYK-249 §4 요구7: 이 축도 지금 이 시점의 맨 끝이다 -- 앞선
    // 모든 세그먼트의 필드·순서·값은 이 라운드가 손대지 않았다.
    // blockedTerminationScan이 opt-in으로 주어지지 않은 기존 호출자는
    // blockedTerminationLogSegment가 null을 돌려주므로(filter(Boolean))
    // 로그 줄이 한 글자도 달라지지 않는다(회귀 0).
    blockedTerminationLogSegment(blockedTerminationResult),
    // HYK-341-vanished-unresolved (coder-task.md §4 설계 제약과 동일
    // 원칙): 이 축도 지금 이 시점의 맨 끝이다 -- 앞선 모든 세그먼트의
    // 필드·순서·값은 이 라운드가 손대지 않았다(unconsumedSegment 자신의
    // verdict 값이 vanish가 있을 때 "VANISHED_UNRESOLVED"로 바뀌는 것은
    // 예외 -- 새 세그먼트가 아니라 기존 unconsumed 축 verdict 필드가
    // 취할 수 있는 값이 하나 느는 것뿐이다, buildStartUnconsumedSegments
    // 주석 참조). unconsumedVanish가 주어지지 않은(opt-in 아님, 다만
    // 기존 단위 시험 호출자는 안 줄 수 있다) 경우
    // unconsumedVanishedDetail은 null -> filter(Boolean)로 로그 줄이
    // 한 글자도 달라지지 않는다.
    segments.unconsumedVanishedDetail,
    // HYK-421 1R (결함 2): 이 축도 지금 이 시점의 맨 끝이다 -- 앞선 모든
    // 세그먼트의 필드·순서·값은 이 라운드가 손대지 않았다. 기존 호출자가
    // 이 필드를 안 주는 detectorResult를 넘기면(과거 stdout 등)
    // seatLiveDispatchLogSegment가 null을 돌려주므로(filter(Boolean))
    // 로그 줄이 한 글자도 달라지지 않는다.
    seatLiveDispatchLogSegment(detectorResult),
    // HYK-464-followup-1 축C: 이 축도 지금 이 시점의 맨 끝이다 -- 앞선
    // 모든 세그먼트의 필드·순서·값은 이 라운드가 손대지 않았다.
    // resourceResidue가 opt-in으로 주어지지 않은 기존 호출자는
    // resourceResidueLogSegment가 null을 돌려주므로(filter(Boolean)) 로그
    // 줄이 한 글자도 달라지지 않는다(회귀 0).
    resourceResidueLogSegment(resourceResidueResult),
    // HYK-464-watch-collection-1 3R P1-3(판정 §1 ⑶): 이 세 세그먼트도
    // 지금 이 시점의 맨 끝이다 -- 앞선 모든 세그먼트의 필드·순서·값은
    // 이 라운드가 손대지 않았다. 제외된 항목이 없는(가장 흔한) 호출자는
    // excludedUndeliveredLogSegment가 null을 돌려주므로(filter(Boolean))
    // 로그 줄이 한 글자도 달라지지 않는다(회귀 0).
    segments.seatExcludedUndeliveredDetail,
    segments.idleExcludedUndeliveredDetail,
    segments.startExcludedUndeliveredDetail,
    // HYK-464-watch-start-axis-1 ⓒ: 이 세그먼트도 지금 이 시점의 맨 끝이다
    // -- 앞선 모든 세그먼트의 필드·순서·값은 이 라운드가 손대지 않았다.
    // 관측 불가 항목이 없는(가장 흔한) 호출자는
    // sizeObservationUnavailableLogSegment가 null을 돌려주므로
    // (filter(Boolean)) 로그 줄이 한 글자도 달라지지 않는다(회귀 0).
    segments.startSizeObservationUnavailableDetail,
    // HYK-464-idle-stop-reason-1 (coder-task.md §2ⓒⓔ): 이 세 세그먼트도
    // 지금 이 시점의 맨 끝이다 -- 앞선 모든 세그먼트의 필드·순서·값은 이
    // 라운드가 손대지 않았다. worst/parked 목록이 비어 있는(가장 흔한
    // 정상 회차) 호출자는 idleWorstSegment/idleParkedSegment가 null을
    // 돌려주므로(filter(Boolean)) 로그 줄이 한 글자도 달라지지 않는다
    // (회귀 0). idleStopReasonsDetail은 seatIdleStopReasonsStatus가 없는
    // (구버전 감지기 stdout 등) 호출자에서만 null이다.
    segments.idleWorstDetail,
    segments.idleParkedDetail,
    segments.idleStopReasonsDetail,
    // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①③):
    // 이 두 세그먼트도 지금 이 시점의 맨 끝이다 -- 앞선 모든 세그먼트의
    // 필드·순서·값은 이 라운드가 손대지 않았다. SUSPECTED_UNRESPONSIVE가
    // 아니거나(seatDetail) 이번 tick에 전송 시도가 없었던(seatEscalationDetail)
    // 가장 흔한 회차는 둘 다 null을 돌려주므로(filter(Boolean)) 로그 줄이
    // 한 글자도 달라지지 않는다(회귀 0).
    segments.seatDetail,
    segments.seatEscalationDetail,
    // HYK-464-teardown-shadow-1: 이 세그먼트도 지금 이 시점의 맨 끝이다 --
    // 앞선 모든 세그먼트의 필드·순서·값은 이 라운드가 손대지 않았다.
    // resourceResidue.teardownShadow가 opt-in으로 주어지지 않은(기존
    // 호출자 전부) 회차는 teardownShadowLogSegment가 null을 돌려주므로
    // (filter(Boolean)) 로그 줄이 한 글자도 달라지지 않는다(회귀 0).
    teardownShadowLogSegment(resourceResidueResult?.teardownShadowResult),
    // HYK-493-memory-reopen-1 (coder-task.md §2 product_scope "로그 줄
    // 꼬리 칸 1"): 이 세그먼트도 지금 이 시점의 맨 끝이다 -- 앞선 모든
    // 세그먼트의 필드·순서·값은 이 라운드가 손대지 않았다. memoryReopen이
    // 주어지지 않은(기존 buildLogLine 직접 호출자) 경우만
    // memoryReopenLogSegment가 null을 돌려주므로(filter(Boolean)) 로그
    // 줄이 한 글자도 달라지지 않는다(회귀 0).
    memoryReopenLogSegment(memoryReopen),
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

// HYK-255-relay-aux-1 (coder-task.md product_scope ③ · PM 설계 §(e)) --
// "ㄴ 후보 K 또는 형식 오류 E가 바뀔 때만 받는함 통지 1개"(그림자
// teardown 통지 :3362·:3426 모양 · 상태 파일 · --notify-dir 기본값
// :4415 준용). relayResult가 없거나(미결선) known!==true(폴더 없음·
// 읍기 실패)면 "판단 불가"를 "변화 없음"으로 접지 않고 시도 자체를
// 건너뛴다(fail-open -- 다음 회차에 다시 평가한다).
const RELAY_LEDGER_NOTIFY_STATE_FILENAME = "relay-ledger-notify-state.json";

function readRelayLedgerNotifyState(readFn, statePath) {
  try {
    const parsed = JSON.parse(readFn(statePath, "utf8"));
    return {
      candidateCount:
        typeof parsed?.candidateCount === "number"
          ? parsed.candidateCount
          : null,
      formatErrorCount:
        typeof parsed?.formatErrorCount === "number"
          ? parsed.formatErrorCount
          : null,
    };
  } catch {
    // fail-open(teardown-shadow와 동일 원칙): 직전 통지가 없었다로 접어
    // 재통지 후보로 둔다 -- 과소통지보다 과대통지가 안전.
    return { candidateCount: null, formatErrorCount: null };
  }
}

// P2-1 -- 전달 파일 "개별" 읽기 실패가 있으면 통지에도 그 건수를
// 보이고, "대응 없음(ㄴ 후보)" 값이 확정으로 읽히지 않게 괄호 문구를
// 붙인다(partial-count-core.mjs renderRelayLedgerAuxLines의 보조 관측
// 줄과 같은 문구 · 검토 1R P2-1).
function buildRelayLedgerNoticeText({ relayResult, nowMs }) {
  const readFailureCount = Array.isArray(relayResult.relayReadFailures)
    ? relayResult.relayReadFailures.length
    : 0;
  const candidateNote =
    readFailureCount > 0 ? "(전달 파일 읽기 실패로 불확실)" : "";
  const readFailureNote =
    readFailureCount > 0 ? ` · 읽기 실패 ${readFailureCount}건` : "";
  // P2-1(2R) ⓘⓘ · 게이트 2 판정 A(HYK-255-relay-aux-4) -- 보조 관측
  // 줄(partial-count-core.mjs renderRelayLedgerAuxLines)과 같은 두
  // 사유를 통지 문면에도 낸다: "없는 번호를 가리킴"(짝 없는 번호
  // 토큰) · "시각 미정"(정규식 밖 줄의 own 시각을 못 정함). 0건이면
  // 줄 자체를 내지 않는다(다른 보조 칸과 같은 관례).
  const numberMismatchLine =
    typeof relayResult.numberMismatchCandidateCount === "number" &&
    relayResult.numberMismatchCandidateCount > 0
      ? [`- 없는 번호를 가리킴: ${relayResult.numberMismatchCandidateCount}건`]
      : [];
  const undeterminedLine =
    typeof relayResult.undeterminedCount === "number" &&
    relayResult.undeterminedCount > 0
      ? [`- 시각 미정: ${relayResult.undeterminedCount}건`]
      : [];
  const lines = [
    `# 전달 파일 대조 보조 관측 변화 (${new Date(nowMs).toISOString()})`,
    "",
    "이 통지는 참고용입니다 -- 독립 계수에 미산입" +
      "(ORCH-writeable 보조 관측, HYK-255-relay-aux-1).",
    "",
    `- 대응 없음(ㄴ 후보): ${relayResult.candidateCount}건${candidateNote}${readFailureNote}`,
    ...numberMismatchLine,
    `- 형식 오류: ${relayResult.formatErrorCount}건`,
    ...undeterminedLine,
    `- ㄱ-7 기록 누락: ${relayResult.gate7MissingCount}건`,
    `- 출처 한용 발화: ${relayResult.sourceUtteranceCount}건 · ` +
      `전달 항목 대응: ${relayResult.matchedCount}건`,
  ];
  return lines.join("\n") + "\n";
}

function buildRelayLedgerNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `relay-ledger-notify-${iso}.md`;
}

function persistRelayLedgerNotifyState({
  relayResult,
  watchDir,
  statePath,
  existsFn,
  mkdirFn,
  writeFn,
}) {
  try {
    if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
    writeFn(
      statePath,
      JSON.stringify({
        candidateCount: relayResult.candidateCount,
        formatErrorCount: relayResult.formatErrorCount,
      }),
      "utf8",
    );
  } catch {
    // 상태 저장 실패는 이 단계 계약을 깨지 않는다(fail-open,
    // runTeardownShadowNotifyStep과 동일 원칙).
  }
}

// 변이⑥의 표적 -- 이 "unchanged" 분기 자체가 "매시 같은 통지"를 막는
// 유일한 장치다. 이 분기를 지우면(상태 파일을 무시하면) 값이 같아도
// 매 회차 통지가 나간다.
function runRelayLedgerNotifyStep({
  relayResult,
  watchDir,
  notifyDir,
  now,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  if (!notifyDir || !relayResult || relayResult.known !== true) {
    return { attempted: false };
  }
  const statePath = path.join(watchDir, RELAY_LEDGER_NOTIFY_STATE_FILENAME);
  const prior = readRelayLedgerNotifyState(readFn, statePath);
  const unchanged =
    prior.candidateCount === relayResult.candidateCount &&
    prior.formatErrorCount === relayResult.formatErrorCount;
  const persist = () =>
    persistRelayLedgerNotifyState({
      relayResult,
      watchDir,
      statePath,
      existsFn,
      mkdirFn,
      writeFn,
    });
  if (unchanged) {
    persist();
    return { attempted: false, suppressed: true };
  }
  try {
    if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
    const noticePath = path.join(
      notifyDir,
      buildRelayLedgerNoticeFileName(now),
    );
    writeFn(
      noticePath,
      buildRelayLedgerNoticeText({ relayResult, nowMs: now }),
      "utf8",
    );
    persist();
    return { attempted: true, sent: true, noticePath };
  } catch (err) {
    return {
      attempted: true,
      sent: false,
      reason: err && err.message ? err.message : String(err),
    };
  }
}

// runPartialCountStepCore -- 원래 `runPartialCountStep`의 본문 그 자체
// (기본값 해석을 뺀 나머지, HYK-255-watch-wire-3). 모든 파라미터는 이미
// 해석된 값이며 기본값을 갖지 않는다(complexity를 늘리지 않는다) --
// 로직·순서·값·반환 모양(`{ran, ok, message}`)·실패 로그 문면
// (`PARTIAL_COUNT_STEP_FAILED`)은 원문 그대로.
async function runPartialCountStepCore({
  now,
  watchDir,
  partialCountOut,
  runPartialCountOnceFn,
  writeFn,
  readFn,
  mkdirFn,
  existsFn,
  logPath,
  maxLogLines,
  options,
  notifyDir,
}) {
  try {
    const result = await runPartialCountOnceFn({ now, ...options });
    const dir = path.dirname(partialCountOut);
    if (!existsFn(dir)) mkdirFn(dir, { recursive: true });
    writeFn(partialCountOut, result.reportText, "utf8");
    const relayNotify = runRelayLedgerNotifyStep({
      relayResult: result.relayResult,
      watchDir,
      notifyDir,
      now,
      readFn,
      writeFn,
      existsFn,
      mkdirFn,
    });
    return { ran: true, ok: true, partialCountOut, relayNotify };
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
  notifyDir,
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
  return runPartialCountStepCore({
    now,
    watchDir,
    logPath,
    notifyDir,
    ...resolved,
  });
}

// HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓑ · product_scope ⓓ) -- CLI
// 인자 --outbox-dir를 runPartialCountStep 옵션으로 넘기는 "1곳"을 이름
// 붙은 함수로 뽑는다. 이유 1줄: 이 전달 자체(invokedDirectly 블록의
// 평범한 객체 리터럴)는 그 블록 전체(runWatchOnce -- ㄱ-4 GitHub 조회를
// 타는 실제 CLI 종단 실행)를 돌려야만 깨지는지 알 수 있는데, 그 종단
// 실행은 금지 축(api.github.com 0회)과 겹쳐 단위 시험이 못쟀다
// (REVIEW-r1 P2-3 ⑽). 뽑아내면 그 종단 실행 없이 "전달 1곳"만 단위
// 시험으로 고정할 수 있다(변이 10).
// HYK-255-relay-aux-1 (coder-task.md product_scope ③ ":2494") -- 두 인자
// (--relay-glob · --inbox-dir)를 같은 "전달 1곳"에 더한다. outboxDir과
// 동일한 opt-in 관례(둘 다 생략하면 relayGlob/inboxDir은 undefined ->
// resolveValueOptions가 null로 정규화 -> collectRelayLedger 자체를
// 건너뛴다, 회귀 0).
export function buildPartialCountStepOptions({
  repoRoot,
  watchLogPath,
  outboxDir,
  relayGlob,
  inboxDir,
}) {
  return { repoRoot, watchLogPath, outboxDir, relayGlob, inboxDir };
}

// HYK-255-outbox-aux-1-r3 (coder-task.md §2 ⓐ · REVIEW-r2 ⓑ "고치는 길"
// 그대로) -- P1-1 수리. buildPartialCountStepOptions 단독 단위 시험은
// 그 함수를 "직접" 호출하는 헬퍼일 뿐이라, invokedDirectly 블록의 argv
// 분기(--outbox-dir)나 이 호출부의 outboxDir 전달 줄이 지워져도 그
// 시험은 계속 초록이었다(REVIEW-r2 P1-1). 이 함수는 그 둘("argv 해석" +
// "호출부 전달")을 "그대로" 옮겨 와, argv 배열을 받아 실제로 해석하고
// 그 결과를 runPartialCountStepFn(기본값 runPartialCountStep, 시험에서
// 주입 가능)에 넘긴다 -- runWatchOnce(ㄱ-4 GitHub 조회)는 거치지 않고도
// argv 삭제·호출부 삭제 두 변이 모두 단위 시험으로 RED가 된다.
// HYK-255-relay-aux-1 -- argv에서 --relay-glob/--inbox-dir도 같은 방식
// (이름 붙은 플래그 하나당 변수 하나)으로 뽑는다. eslint complexity
// 예산 때문에 그 파싱만 떼어낸다(로직은 --outbox-dir과 완전히 동일).
function parseRelayLedgerArgv(argv) {
  let relayGlob = null;
  let inboxDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--relay-glob") relayGlob = argv[++i];
    else if (argv[i] === "--inbox-dir") inboxDir = argv[++i];
  }
  return { relayGlob, inboxDir };
}

export async function runWatchCliPartialCountStep({
  argv,
  repoRoot,
  watchDir,
  now,
  result,
  notifyDir,
  runPartialCountStepFn,
}) {
  let outboxDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--outbox-dir") outboxDir = argv[++i];
  }
  const { relayGlob, inboxDir } = parseRelayLedgerArgv(argv);
  const stepFn =
    runPartialCountStepFn === undefined
      ? runPartialCountStep
      : runPartialCountStepFn;
  return stepFn({
    watchDir,
    now,
    notifyDir,
    logPath: result.logPath,
    options: buildPartialCountStepOptions({
      repoRoot,
      watchLogPath: result.logPath,
      outboxDir,
      relayGlob,
      inboxDir,
    }),
  });
}

// HYK-439 §2 ⓒ: thin wrapper around the invokedDirectly block's own call
// to runWatchCliPartialCountStep below -- unit tests inject a stub via
// runWatchCliPartialCountStepFn to assert the entry point's OWN real argv
// (not a stand-in like []) is what actually gets forwarded, without
// driving runWatchOnce's real GitHub-querying end-to-end path. No behavior
// change: the default forwards to the real runWatchCliPartialCountStep
// exactly as the inline call this replaces did.
export function forwardArgvToPartialCountStep({
  argv,
  repoRoot,
  watchDir,
  now,
  result,
  notifyDir,
  runWatchCliPartialCountStepFn = runWatchCliPartialCountStep,
}) {
  return runWatchCliPartialCountStepFn({
    argv,
    repoRoot,
    watchDir,
    now,
    result,
    notifyDir,
  });
}

// HYK-481 (coder-task.md §2) -- "ledger는 있는데 lock이 없다"를 가리키는
// 명시 사유 코드. "미설정"(admissionSweep 자체가 없음)과 값으로 구별
// 되는 것이 이 라운드의 목적이므로 별도 상수로 뽑는다.
const SWEEP_SKIP_REASON_CONFIGURED_WITHOUT_LOCK =
  "SWEEP_CONFIGURED_WITHOUT_LOCK";

// runSweepStep -- admission sweep 트리거 단계(coder-task §2 항1). 이
// 단계 자신의 실패가 이 러너의 계약(로그 한 줄 + 생존 기록)을 깨서는
// 안 된다(runReachStep/computeCapResult와 동일 원칙 -- v1은 로그만).
// `admissionSweep`이 아예 없으면(기본값, 대부분의 호출자) 실행하지 않고
// `{notRun:true}`를 돌려준다 -- 로그 줄에 아무 세그먼트도 더하지 않는다
// (회귀 0, HYK-481 범위 밖 -- 이 케이스는 손대지 않는다).
//
// HYK-481 (coder-task.md §2) -- `ledgerPath`는 있는데 `lockPath`가
// 없는 조합(§2-B가 의도적으로 여는 "sweep은 끄고 wake의 원장 읽기만
// 켠다" 조합, 아래 CLI 조립부 주석 참조)은 위 "아예 미설정"과 같은
// `{notRun:true}`로 뭉뚱그리지 않는다 -- `skipReason`을 함께 실어
// sweepLogSegment/sweepRecordField가 "미설정"과 다른 문장을 남기게
// 한다(2026-08-12~09-16 사고: 예약 작업이 lock 플래그를 빠뜨려도
// `ran:false`가 "정상 미설정"과 똑같아 보여 한 달 넘게 아무도 못 봤다).
function runSweepStep({ admissionSweep, sweepExecFn, now }) {
  if (!admissionSweep || !admissionSweep.ledgerPath) {
    return { notRun: true };
  }
  if (!admissionSweep.lockPath) {
    return {
      notRun: true,
      skipReason: SWEEP_SKIP_REASON_CONFIGURED_WITHOUT_LOCK,
    };
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
// HYK-342/HYK-249 §4 요구7 (task 머리말 1b_reach_path, "이 상태가 사람에게
// 도달하는 경로가 없으면 그 경로를 만든다") -- relay-handshake.mjs가
// BLOCKED/NEEDS_INPUT 라운드에서 남기는 중단 기록(`<harnessDir>/aborts/
// <role>-abort-r<N>.json`, evidence.source ===
// "relay-handshake-blocked-termination")을 사람이 읽는 감시 로그로
// 끌어올린다. 이전에는 watch-run.mjs가 checkRelayHandshake(relay-
// handshake.mjs)를 아예 호출/참조하지 않아(ORCH 실측, 이 라운드 착수 전
// grep 0건) 이 상태에 도달하는 경로 자체가 없었다.
//
// readAbortRecordFiles(dispatch-gate-decision.mjs)와 같은 디렉터리·같은
// 파일명 관례(`<role>-abort-r<N>.json`, 대소문자 무관)를 읽지만, 그 축의
// 판정 로직(checkAbortRecord)은 조금도 재구현하지 않는다 -- 이 함수는
// 순전히 "사람이 볼 수 있게 표면화"만 한다(판정은 여전히 그 게이트가
// 한다). 손상/미완성 쓰기는 그 파일만 건너뛴다(readAbortRecordFiles와
// 동일 원칙 -- 손상된 기록 하나가 전체 스캔을 막지 않는다).
// scanBlockedTerminationRecords 자신의 eslint complexity 상한을 지키려고
// 파일 1개 처리를 뽑았다(판정/문구는 조금도 바뀌지 않는다) -- 손상/미완성
// 쓰기(파싱 실패)나 이름 패턴이 안 맞으면 null(건너뛴다), 이 축이 찾는
// 출처(relay-handshake-blocked-termination)가 아니면도 null이다.
function readBlockedTerminationRecord(abortsDir, name, readFileFn) {
  if (!/-abort-r\d+\.json$/i.test(name)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileFn(path.join(abortsDir, name), "utf8"));
  } catch {
    return null;
  }
  if (parsed?.evidence?.source !== "relay-handshake-blocked-termination") {
    return null;
  }
  return {
    file: name,
    role: parsed.role ?? null,
    taskId: parsed.harnessTaskLabel ?? null,
    state: parsed.evidence?.state ?? null,
    recordedAt: parsed.recordedAt ?? null,
  };
}

export function scanBlockedTerminationRecords({
  harnessDir,
  readdirFn = readdirSync,
  readFileFn = readFileSync,
}) {
  const abortsDir = path.join(harnessDir, "aborts");
  let names;
  try {
    names = readdirFn(abortsDir);
  } catch {
    return { status: "NONE", count: 0, records: [] };
  }
  const records = names
    .map((name) => readBlockedTerminationRecord(abortsDir, name, readFileFn))
    .filter(Boolean);
  return {
    status: records.length > 0 ? "FOUND" : "NONE",
    count: records.length,
    records,
  };
}

// HYK-342/HYK-249: opt-in axis step -- mirrors runSweepStep/runWakeStep's own
// "notRun unless the caller explicitly configures it" shape (admissionSweep/
// wake 관례 그대로). `blockedTerminationScan` is null by default, so every
// pre-existing caller/test is byte-for-byte unaffected (§7 회귀 0).
// HYK-342 2R P1-3 (검토 원문 "1-B 도달 경로가 운영상 기본 결선되지
// 않았다" -- watch-run.mjs를 평소 돌리는 방식 그대로, 추가 인자 없이,
// 실행했을 때 이 축이 돌아야 한다): resolveCapPath(바로 위 cap 축)와
// 정확히 같은 모양 -- `blockedTerminationScan?.harnessDir`이 명시로
// 주어지면 그 값(시험/재정의용), 없으면 `repoRoot`에서 스스로 파생한다.
// ⛔더 이상 opt-in이 아니다 -- null 가드가 없다, 이 축은 항상 돈다(다른
// 상시 축인 cap/detector/escalation과 같은 자리). 대상이 없을 때(정지
// 라운드가 없을 때) 시끄러워지지 않는 이유는 scanBlockedTerminationRecords
// 자신이 이미 그렇다 -- `.harness/aborts/`가 없거나 비어 있으면
// status=NONE/count=0을 반환할 뿐 던지거나 알림을 만들지 않는다(§3
// "정상 상태에서 상시 발화" 금지 요건은 애초에 "로그 필드 하나가
// 항상 보인다"와는 다른 축이다 -- cap_status=NONE이 이미 그 전례다).
function resolveBlockedTerminationHarnessDir(repoRoot, blockedTerminationScan) {
  return blockedTerminationScan?.harnessDir ?? path.join(repoRoot, ".harness");
}

function runBlockedTerminationScanStep({
  repoRoot,
  blockedTerminationScan,
  readdirFn = readdirSync,
  readFileFn = readFileSync,
}) {
  const harnessDir = resolveBlockedTerminationHarnessDir(
    repoRoot,
    blockedTerminationScan,
  );
  return {
    notRun: false,
    ...scanBlockedTerminationRecords({ harnessDir, readdirFn, readFileFn }),
  };
}

// blockedTerminationLogSegment -- 이 축이 실제로(opt-in) 켜졌을 때만 로그
// 줄에 한 세그먼트를 더한다(capLogSegment/sweepLogSegment와 동일한 "사람이
// 읽는 사유" 원칙 -- status/count/source).
function blockedTerminationLogSegment(result) {
  if (!result || result.notRun) return null;
  const status = result.status ?? "NONE";
  const count = typeof result.count === "number" ? result.count : "NONE";
  return `blocked_termination_status=${status} blocked_termination_count=${count} blocked_termination_source=harness/aborts`;
}

// ---------------------------------------------------------------------------
// HYK-464-followup-1 축C (coder-task.md §1 축C) -- 자원 잔재 «보고».
//
// 한용 확정 규율(§11-4) = "쓸 일 끝난 워크트리·좌석·node 잔재는 그때
// 그때 끈다" -- 지금은 문서 규약일 뿐 기계가 안 본다. 이 축은 그 규약을
// 기계로 «보고»만 한다. ⛔자동 제거·자동 종료 기능은 절대 만들지 않는다
// (처분은 사람/ORCH 판단 -- seat-orphan-detect.mjs가 이미 세운 것과 동일
// 원칙, 아래 재사용 부분 참고).
//
// opt-in(admissionSweep/wake와 동일 계약, coder-task.md §1 축C 요구):
// `resourceResidue`를 호출자가 명시적으로 주지 않으면(기본값 null) 이
// 단계는 아예 실행되지 않는다 -- 기존 호출자(기존 시험 포함) 회귀 0.
// 이 축은 (idle-seat 판별 시) orca `terminal list`를, (node 잔재 판별
// 시) OS 프로세스 열거를 부를 수 있어 admissionSweep/wake와 같은 "부가
// I/O가 있는 opt-in" 계열이다(blockedTerminationScan처럼 로컬 파일만
// 읽는 "항상 켜짐" 계열과는 다르다).
// ---------------------------------------------------------------------------

// ⓐ 사유 파일 없는 워크트리. "사유 파일"의 정의(coder-task.md §1 축C:
// "형식은 네가 정하고 근거를 적어라"): 이 저장소가 이미 "이 워크트리가
// 배달 대상이었다"는 증거로 인정하는 유일한 기계 신호는
// `.harness/*-task.md`의 `dropped_at:` 헤더다(seatLiveness/seatIdle/
// dispatchStart 세 축이 orch-stall-detect.mjs 안에서 "활성 배달"의
// 근거로 쓰는 바로 그 신호와 같은 판별 기준 -- 다만 이 파일은 그 함수를
// import하지 않는다, 위 import 블록의 "왜 로컬로 다시 짜는가" 참고).
// 그 헤더가 있는 `*-task.md`가 하나도 없으면(그리고 `.harness` 자체가
// 읽기 실패도 아니면) 이 워크트리가 왜 존재하는지를 이 저장소 안에서
// 설명할 근거가 없다 -- NO_REASON_FILE로 보고한다. `.harness` 읽기 자체가
// 실패하면(권한 등) 거짓 확신을 만들지 않고 UNDETERMINED로 보고한다
// (§요구 "없으면 «판별 불가»로 두고 거짓 확신 금지").
function classifyWorktreeReasonFile(worktreePath, collectEvidenceFn) {
  const evidence = collectEvidenceFn(worktreePath);
  if (evidence.failed) {
    return { worktreePath, status: "UNDETERMINED" };
  }
  if (!Array.isArray(evidence.items) || evidence.items.length === 0) {
    return { worktreePath, status: "NO_REASON_FILE" };
  }
  return null; // 사유 있음 -- 잔재 아님, 보고하지 않는다(잔재 0일 때 조용함).
}

export function computeWorktreeReasonResidue({
  worktreePaths,
  collectEvidenceFn,
}) {
  const entries = (Array.isArray(worktreePaths) ? worktreePaths : [])
    .map((wt) => classifyWorktreeReasonFile(wt, collectEvidenceFn))
    .filter(Boolean);
  return {
    noReasonFile: entries.filter((e) => e.status === "NO_REASON_FILE"),
    undetermined: entries.filter((e) => e.status === "UNDETERMINED"),
  };
}

// HYK-464-followup-1 축C 로컬 재구현(위 import 블록 "왜 로컬로 다시
// 짜는가" 참고) -- orch-stall-detect.mjs의 DROPPED_AT_RE와 동일 정규식
// (`^dropped_at:\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\s*$`)을 그대로
// 옮겨 쓴다. 이 함수는 "그런 헤더가 하나라도 있는가"만 답한다(collect
// EvidenceFn 계약: `{items, failed}` -- items는 있음/없음만 신호하는
// 자리표시자, dropped_at 값 자체는 이 축이 쓰지 않는다).
// HYK-209 깊이 방어: `\s*` → `[ \t]*` (orch-stall-detect.mjs DROPPED_AT_RE 와 같은 모양).
const RESIDUE_DROPPED_AT_RE =
  /^dropped_at:[ \t]*\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST[ \t]*$/im;

function collectDroppedAtTaskFileEvidenceLocal(worktreePath) {
  const harnessDir = path.join(worktreePath, ".harness");
  let names;
  try {
    names = readdirSync(harnessDir).filter((n) => n.endsWith("-task.md"));
  } catch (err) {
    if (err && err.code === "ENOENT") return { items: [], failed: false };
    return { items: [], failed: true };
  }
  const items = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(path.join(harnessDir, name), "utf8");
    } catch {
      return { items: [], failed: true };
    }
    if (RESIDUE_DROPPED_AT_RE.test(text)) {
      items.push({ path: `.harness/${name}` });
    }
  }
  return { items, failed: false };
}

// orch-stall-detect.mjs의 parseWorktreeListPorcelain/collectGitWorktrees와
// 동일한 파싱(`git worktree list --porcelain`의 `worktree <path>` 줄만
// 뽑는다) -- 위 import 블록 주석과 같은 이유로 로컬 재구현.
function parseGitWorktreeListPorcelainLocal(stdout) {
  const paths = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^worktree\s+(.+)$/);
    if (m) paths.push(m[1].trim());
  }
  return paths;
}

function collectGitWorktreesLocal(repoRoot) {
  try {
    const stdout = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, worktrees: parseGitWorktreeListPorcelainLocal(stdout) };
  } catch (err) {
    return {
      ok: false,
      worktrees: [],
      detail: err && err.message ? err.message : String(err),
    };
  }
}

// ⓑ 배정 0인 유휴 좌석 -- seat-orphan-detect.mjs의 detectOrphans를
// 그대로 재사용한다(재구현 0, §재사용). registryPath가 없으면(설정
// 안 됨) 판별 불가 -- 거짓으로 "0건"이라 단정하지 않는다.
export function computeIdleSeatResidue({ terminals, registryPath }) {
  if (!registryPath) {
    return { status: "UNDETERMINED", orphanCandidates: [] };
  }
  const result = detectOrphans({ terminals, registryPath });
  return { status: "OK", orphanCandidates: result.orphanCandidates };
}

// ⓒ 러너가 끝났는데 남은 node 잔재. 이 러너 자신(watch-run.mjs)이 감싸
// 부르는 감지기(orch-stall-detect.mjs)는 execFileSync로 동기 spawn되므로
// (runDetector) 정상 흐름에서는 이 판정 시점에 그 자식 프로세스가 이미
// 끝나 있어야 한다 -- 그런데도 같은 감시 스크립트를 가리키는 node
// 프로세스가(자기 자신의 pid 제외) 살아있다면 그 자체가 잔재(과거 실행이
// 멈춰 죽지 않은 것)다. 순수 판정(processRows는 이미 수집된 값)과 실제
// OS 프로세스 열거(아래 defaultListNodeProcessRows)를 분리한다(시험
// 용이성 -- 다른 축들과 동일한 "collect vs judge" 원칙).
export const DEFAULT_RESIDUE_SCRIPT_MARKERS = Object.freeze([
  "orch-stall-detect.mjs",
  "watch-run.mjs",
]);

export function computeNodeProcessResidue({
  processRows,
  selfPid,
  scriptMarkers = DEFAULT_RESIDUE_SCRIPT_MARKERS,
}) {
  if (!Array.isArray(processRows)) {
    return { status: "UNDETERMINED", residue: [] };
  }
  const residue = processRows.filter((row) => {
    if (!row || typeof row.commandLine !== "string") return false;
    if (typeof selfPid === "number" && row.pid === selfPid) return false;
    return scriptMarkers.some((marker) => row.commandLine.includes(marker));
  });
  return { status: "OK", residue };
}

// 실 OS 프로세스 열거(Windows 전용 -- 이 하네스 전체가 win32에서만
// 돈다, 시스템 프롬프트 Platform 참조). PowerShell Get-CimInstance로
// node.exe의 전체 커맨드라인을 얻는다(tasklist는 기본으로 커맨드라인을
// 안 준다). 조회 자체가 실패하면(PowerShell 없음 등) null을 돌려
// computeNodeProcessResidue가 UNDETERMINED로 접게 한다 -- "잔재 없음"으로
// 지어내지 않는다.
function defaultListNodeProcessRows(execFn) {
  try {
    const out = execFn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
      ],
      {},
    );
    const parsed = JSON.parse(out && out.trim().length > 0 ? out : "[]");
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        pid: typeof r.ProcessId === "number" ? r.ProcessId : null,
        commandLine: typeof r.CommandLine === "string" ? r.CommandLine : "",
      }));
  } catch {
    return null;
  }
}

// runResourceResidueStep에서 분리(§6 eslint complexity/max-lines-per-function
// 상한 준수 -- 세 잔재 종류 각각을 독립 함수로 뽑는다, 로직·값은 그대로).
function collectWorktreeResidueStep({ resourceResidue, repoRoot }) {
  const worktreeListFn =
    resourceResidue.worktreeListFn ?? collectGitWorktreesLocal;
  const collectEvidenceFn =
    resourceResidue.collectEvidenceFn ?? collectDroppedAtTaskFileEvidenceLocal;
  const worktreeList = worktreeListFn(repoRoot, {});
  return worktreeList.ok
    ? computeWorktreeReasonResidue({
        worktreePaths: worktreeList.worktrees,
        collectEvidenceFn,
      })
    : { noReasonFile: [], undetermined: [], scanFailed: true };
}

function collectIdleSeatResidueStep({ resourceResidue }) {
  if (!resourceResidue.registryPath) {
    return { status: "UNDETERMINED", orphanCandidates: [] };
  }
  const orcaExecFn = resourceResidue.orcaExecFn ?? createOrcaExecFn();
  try {
    const listResponse = orcaExecFn(["terminal", "list", "--json"]);
    if (
      listResponse &&
      listResponse.ok === true &&
      Array.isArray(listResponse.result?.terminals)
    ) {
      return computeIdleSeatResidue({
        terminals: listResponse.result.terminals,
        registryPath: resourceResidue.registryPath,
      });
    }
  } catch {
    // 조회 실패 -- UNDETERMINED로 남긴다(거짓 확신 금지, 아래와 동일 원칙).
  }
  return { status: "UNDETERMINED", orphanCandidates: [] };
}

function collectNodeResidueStep({ resourceResidue, execFn }) {
  const listNodeProcessRowsFn =
    typeof resourceResidue.listNodeProcessRowsFn === "function"
      ? resourceResidue.listNodeProcessRowsFn
      : () => defaultListNodeProcessRows(execFn);
  return computeNodeProcessResidue({
    processRows: listNodeProcessRowsFn(),
    selfPid: process.pid,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// HYK-464-teardown-shadow-1 (coder-task.md §2 product_scope ③) -- 축C가
// (resourceResidue가 켜진 회차에) 아카이브 판정 코어(judgeArchiveEligibility)
// 를 워크트리마다 «그림자»로 구동한다. opt-in 중 opt-in -- resourceResidue.
// teardownShadow가 명시로 주어지지 않으면(기본값, 기존 호출자 전부) 이
// 단계는 아예 실행되지 않는다(notRun:true, 다른 세 잔재 축과 완전히
// 독립 -- resourceResidue가 켜져 있어도 teardownShadow가 없으면 이 축만
// 조용하다). ⛔armed는 어디에도 없다 -- 이 축은 판정만 하고, 실행(close/
// rm)은 절대 하지 않는다(파괴 argv 0건, §2 비타협).
// ---------------------------------------------------------------------------

// 실 git/fs 호출의 기본 구현(시험은 resourceResidue.teardownShadow.*Fn으로
// 전부 주입해 이 기본값을 쓰지 않는다 -- defaultListNodeProcessRows와
// 동일한 "기본값은 실 운용, 시험은 주입"관례).
function defaultArchiveGitFn(argv, worktreePath) {
  return execFileSync("git", argv, {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}
// HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑹ P2-3 수리, 검토 1R
// 실측): 기본 lsRemoteFn이 워크트리마다(N개) `git ls-remote origin
// refs/heads/master`를 다시 불렀다 -- 링크된 워크트리는 전부 같은
// 저장소(같은 .git 객체·remote 설정)를 공유하므로 이 답은 워크트리마다
// 달라지지 않는다. 한 회차(runTeardownShadowStep 한 번의 호출) 동안만
// 유효한 메모를 만들어 실제 ls-remote 호출을 회차당 1회로 줄인다 --
// 실패(네트워크 오류 등)도 그대로 메모해 재시도하지 않는다(그 회차의
// 모든 워크트리가 같은 MERGE_STATUS_UNKNOWN을 공유한다, fail-closed
// 성질은 바뀌지 않는다). 사용자(시험)가 `teardownShadow.lsRemoteFn`을
// 직접 주입한 경우는 이 메모를 전혀 쓰지 않는다(아래 runTeardownShadowStep
// 참조 -- 기본값에만 적용). `underlyingFn`은 실 운용에서는 항상
// `defaultArchiveGitFn`(생략 시 기본값)이고, 시험이 호출 횟수를 셀 수
// 있도록 export해 직접 주입 가능하게 한다(실 git/네트워크 호출 없이
// 메모이즈 로직 자체를 증명한다).
export function createMemoizedDefaultLsRemoteFn(
  underlyingFn = defaultArchiveGitFn,
) {
  let cache = null;
  return (argv, worktreePath) => {
    if (cache === null) {
      try {
        cache = { ok: true, value: underlyingFn(argv, worktreePath) };
      } catch (err) {
        cache = { ok: false, error: err };
      }
    }
    if (cache.ok) return cache.value;
    throw cache.error;
  };
}
// `git merge-base --is-ancestor`는 exit code로만 답한다(stdout 없음) --
// exit 0 = 조상, exit 1 = 조상 아님, 그 밖(128 등) = 진짜 오류(알 수 없는
// 리비전 등) -- execFileSync가 던지는 err.status로 셋을 구별한다. 진짜
// 오류는 다시 던져서 호출자(observeMergeStatus)의 catch가 UNOBSERVABLE로
// 접게 한다("아니다"로 지어내지 않는다).
function defaultIsAncestorFn(headSha, remoteSha, worktreePath) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", headSha, remoteSha], {
      cwd: worktreePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch (err) {
    if (typeof err?.status === "number" && err.status === 1) return false;
    throw err;
  }
}
function defaultArchiveExistsFn(p) {
  return existsSync(p);
}
function defaultArchiveReadFileFn(p) {
  return readFileSync(p, "utf8");
}
// `.harness` 아래 전부(재귀)를 상대경로(`.harness/...`, posix 구분자)로
// 나열한다. ★HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑸ P1-4 수리,
// 검토 1R 실측): `.harness`가 «없는»(ENOENT) 것과 «못 읽는»(디렉터리가
// 아님·권한 없음 등) 것은 다르다 -- 전자만 "비정상이지만 파괴적이지
// 않은 상태 -- 빈 배열"로 접는다(observeArchiveManifest에서 "목록이
// 비었다"로 받는다). 후자는 최상위(root) 호출에서 그대로 다시 던져
// observeArchiveManifest의 catch가 observable:false로 접게 한다(지어낸
// "없음"으로 과대판정하지 않는다). 재귀 하위 디렉터리의 읽기 실패는(최상위
// 존재가 이미 확인된 뒤라 드문 경쟁 상태뿐) 기존과 동일하게 조용히 건너
// 뛴다 -- 이 축이 실측으로 겨냥한 것은 `.harness` 자체의 상태뿐이다.
function defaultListHarnessFiles(worktreePath) {
  const harnessDir = path.join(worktreePath, ".harness");
  const out = [];
  const walk = (dir, relPrefix, isRoot) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot && err && err.code !== "ENOENT") throw err;
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel, false);
      } else if (entry.isFile()) {
        out.push(`.harness/${rel}`);
      }
    }
  };
  walk(harnessDir, "", true);
  return out;
}
function defaultReadHarnessFileBuffer(relPath, worktreePath) {
  return readFileSync(path.join(worktreePath, relPath));
}
// ★HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑵ C1 수리, 책임자 판정
// 1012): 1R은 ⓑ(미소비 라운드 0)의 "은퇴 기록 = 소비됨"을 «파일 존재로만»
// 읽었다(검토 1R P1-5: 옛 회차·다른 역할의 은퇴 기록 1건이 새 회차
// 미소비를 가렸다). 이제 그 파일을 JSON.parse해 그 «미소비 라운드 자신»의
// role·회차(라벨)과 대조한다 -- 일치하는 기록이 하나도 없으면 "소비
// 아님"이다(다른 라운드 은퇴 = 소비 아님). ⛔이것은 412(retirement-
// record-core.mjs)의 전체 재확인(아카이브 존재·지문·기계 재확인 등)을
// 재구현하는 것이 아니다 -- 그림자(판정만, 파괴 0) 축에 맞는 더 가벼운
// 자기완결 대조이고, 412 코드를 이 파일이 import하거나 호출하지 않는다
// (§2 범위 밖 "412 코드 무접촉" 그대로 지킨다).
const RETIREMENT_FILE_RE = /^[a-z0-9_-]+-retire-r\d+\.json$/i;
function defaultRetirementReaddir(worktreePath) {
  return readdirSync(path.join(worktreePath, ".harness", "retirements"));
}

// 감지기가 이 워크트리에서 미소비로 판정한 결과 파일(`.harness/<role>.md`
// 관례)에서 role(파일명 역산) + 라벨(`task_id:` 헤더 줄)을 읽는다. 둘 중
// 하나라도 못 구하면 null -- 호출자가 "은퇴 기록과 대조할 근거가 없다"로
// 처리한다(=소비 아님으로 남는다, 과대판정 없음).
function extractRoleFromResultFilePath(resultFilePath) {
  const m = /^\.harness\/([^/]+)\.md$/.exec(String(resultFilePath ?? ""));
  return m ? m[1].toUpperCase() : null;
}
function resolveRoundLabelFromResultFile({
  worktreePath,
  resultFilePath,
  readFileFn,
}) {
  if (!isNonEmptyString(resultFilePath) || typeof readFileFn !== "function") {
    return null;
  }
  let text;
  try {
    // observeKeepReason과 동일 관례(watch-run.mjs 내 기존 선례) -- 실
    // fs 호출에서 OS별 구분자 변환(path.join)에 의존하지 않고 원래
    // 경로를 forward-slash로 그대로 잇는다(테스트의 문자열 대조도 OS
    // 무관하게 안정적이다).
    const fullPath = `${String(worktreePath).replace(/[\\/]+$/, "")}/${resultFilePath}`;
    text = readFileFn(fullPath, worktreePath);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  const m = /^task_id:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : null;
}

// 은퇴 디렉터리 안의 파일들을 하나씩 JSON.parse해 role·harnessTaskLabel이
// «그 미소비 라운드 자신»과 정확히 일치하는 기록이 있는지 본다. ★HYK-464-
// teardown-shadow-3(coder-task.md §2 ⓒ P2-C 수리, 검토 2R 지적 판정
// 1012 C1 "깨짐·불일치 = 판정 불가"): 못읽음·깨짐과 "정상 JSON이지만
// 다른 역할/회차"는 더 이상 같은 결론이 아니다 -- 전자는 그 파일이 실제
// 일치였는지 알 수 없으므로 판정 불가(observable:false, 이 축만
// TEARDOWN_UNCONSUMED_ROUNDS_UNKNOWN), 후자는 내용을 끝까지 읽었고
// 정상적으로 다른 라운드임을 확인했으므로 "소비 아님"으로 확정
// (TEARDOWN_UNCONSUMED_ROUNDS_PRESENT, 그대로). ★HYK-491-teardown-arm-1
// (coder-task.md §2 pre-task ⓐ) 문면 정정: 아래 scanRetirementNames의
// 실제 동작은 "전부 깨졌을 때만 UNKNOWN"이 아니다 -- MATCHED가 하나도
// 없는데 BROKEN이 «하나라도» 있으면(다른 파일이 정상적으로 "다른
// 라운드"임을 확인해 줬어도) sawBroken이 그 전체를 BROKEN으로 접는다.
// 즉 "못읽음·깨짐 + 정상(다른 라운드) 혼합"도 PRESENT가 아니라 UNKNOWN
// 이다(실측, 아래 scanRetirementNames 참조) -- PRESENT로 확정되는 것은
// "스캔한 모든 파일이 정상 JSON이고(BROKEN 0건) 그중 하나도 MATCHED가
// 아닐 때"뿐이다. 사유 이름은 그대로 ROUNDS_PRESENT를 쓴다(통일 안 함,
// §2 pre-task ⓑ).
// eslint complexity 상한 회피(§ retirementFileMatchStatus/
// resolveRetirementMatchStatus로 분리 -- retirement-record-writer.mjs류
// 선례와 동일한 이유, 몸통만 쪼갠다). 파일 하나를 읽어 role+
// harnessTaskLabel이 일치하는지만 본다.
const RETIREMENT_MATCH = Object.freeze({
  MATCHED: "matched",
  BROKEN: "broken", // 못 읽음 또는 깨진 JSON -- 판정 불가(이 파일만으로는).
  NOT_MATCHED: "not_matched", // 정상 JSON, 역할/라벨이 다름 -- 소비 아님 확정.
});

function retirementFileMatchStatus({
  worktreePath,
  name,
  targetRole,
  targetLabel,
  readFileFn,
}) {
  const fullPath = `${String(worktreePath).replace(/[\\/]+$/, "")}/.harness/retirements/${name}`;
  let text;
  try {
    text = readFileFn(fullPath, worktreePath);
  } catch {
    return RETIREMENT_MATCH.BROKEN; // 못 읽음 -- 판정 불가.
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return RETIREMENT_MATCH.BROKEN; // 깨짐 -- 동일(판정 불가).
  }
  return isPlainObject(record) &&
    record.role === targetRole &&
    record.harnessTaskLabel === targetLabel
    ? RETIREMENT_MATCH.MATCHED
    : RETIREMENT_MATCH.NOT_MATCHED; // 정상 JSON, 다른 역할/회차 -- 소비 아님 확정.
}

// eslint complexity 상한 회피(resolveRetirementMatchStatus 자신의 분기 수를
// 줄이려고 readdir 처리와 이름별 스캔을 각각 뽑았다 -- 판정/문구는 조금도
// 바뀌지 않는다, 몸통만 쪼갠다, retirement-record-writer.mjs류 선례와
// 동일한 이유).
function resolveRetirementDirNames({ worktreePath, retirementReaddirFn }) {
  try {
    return { names: retirementReaddirFn(worktreePath), broken: false };
  } catch (err) {
    // ENOENT(디렉터리 부재)는 "은퇴 기록 없음"일 뿐, 관측 실패가 아니다.
    // 그 밖의 오류(예: retirements가 디렉터리가 아님)는 판정 불가다.
    return { names: [], broken: !(err && err.code === "ENOENT") };
  }
}

function scanRetirementNames({
  worktreePath,
  names,
  targetRole,
  targetLabel,
  readFileFn,
}) {
  let sawBroken = false;
  for (const name of names) {
    if (typeof name !== "string" || !RETIREMENT_FILE_RE.test(name)) continue;
    const status = retirementFileMatchStatus({
      worktreePath,
      name,
      targetRole,
      targetLabel,
      readFileFn,
    });
    if (status === RETIREMENT_MATCH.MATCHED) return RETIREMENT_MATCH.MATCHED;
    if (status === RETIREMENT_MATCH.BROKEN) sawBroken = true;
  }
  return sawBroken ? RETIREMENT_MATCH.BROKEN : RETIREMENT_MATCH.NOT_MATCHED;
}

function resolveRetirementMatchStatus({
  worktreePath,
  targetRole,
  targetLabel,
  retirementReaddirFn,
  readFileFn,
}) {
  if (!isNonEmptyString(targetRole) || !isNonEmptyString(targetLabel)) {
    return RETIREMENT_MATCH.NOT_MATCHED;
  }
  const dir = resolveRetirementDirNames({ worktreePath, retirementReaddirFn });
  if (dir.broken) return RETIREMENT_MATCH.BROKEN;
  if (!Array.isArray(dir.names) || typeof readFileFn !== "function") {
    return RETIREMENT_MATCH.NOT_MATCHED;
  }
  return scanRetirementNames({
    worktreePath,
    names: dir.names,
    targetRole,
    targetLabel,
    readFileFn,
  });
}

// HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑷ P1-3 수리): worst-list
// (발화 대표값)만 보던 1R을 "이 워크트리 자신의 status/verdict"(위
// pickUnconsumedWorktreeEntries가 옮겨 적은 unconsumedWorktreeEntries)로
// 바꾼다 -- NOT_APPLICABLE(판정 대상 없음)이나 JUDGED+CONSUMED가 아니면
// "있음"이고, 그 밖의 status(COLLECTION_FAILED·TASK_FILE_MTIME_UNAVAILABLE
// 등)는 "판정 불가"다(§재사용: HYK-185 판정 자체는 한 글자도 다시 하지
// 않는다 -- 그 판정이 이미 낸 status/verdict 문자열만 읽는다).
const UNCONSUMED_STATUS_NOT_APPLICABLE = "UNCONSUMED_NOT_APPLICABLE";
const UNCONSUMED_STATUS_JUDGED = "UNCONSUMED_JUDGED";
const UNCONSUMED_VERDICT_CONSUMED = "CONSUMED";

function findUnconsumedEntryForWorktree(entries, worktreePath) {
  const targetDigest = computeCanonicalPathDigest(worktreePath);
  return (
    entries.find(
      (e) =>
        typeof e.worktreePath === "string" &&
        computeCanonicalPathDigest(e.worktreePath) === targetDigest,
    ) ?? null
  );
}

function deriveUnconsumedRoundsForWorktree({
  worktreePath,
  detectorResult,
  retirementReaddirFn,
  readFileFn,
}) {
  const entries = detectorResult?.unconsumedWorktreeEntries;
  if (!Array.isArray(entries)) return { observable: false };
  const entry = findUnconsumedEntryForWorktree(entries, worktreePath);
  if (!entry) return { observable: false };
  if (entry.status === UNCONSUMED_STATUS_NOT_APPLICABLE) {
    return { observable: true, count: 0, consumedViaRetirement: false };
  }
  if (entry.status === UNCONSUMED_STATUS_JUDGED) {
    if (entry.verdict === UNCONSUMED_VERDICT_CONSUMED) {
      return { observable: true, count: 0, consumedViaRetirement: false };
    }
    const targetRole = extractRoleFromResultFilePath(entry.resultFilePath);
    const targetLabel = resolveRoundLabelFromResultFile({
      worktreePath,
      resultFilePath: entry.resultFilePath,
      readFileFn,
    });
    const matchStatus = resolveRetirementMatchStatus({
      worktreePath,
      targetRole,
      targetLabel,
      retirementReaddirFn,
      readFileFn,
    });
    // HYK-464-teardown-shadow-3 P2-C: 못읽음/깨진 은퇴 JSON(전부 BROKEN)은
    // "소비 아님"으로 확정할 수 없다 -- 판정 불가로 접는다(observable:
    // false -> TEARDOWN_UNCONSUMED_ROUNDS_UNKNOWN). 정상 JSON이지만 다른
    // 역할/회차는 그대로 "소비 아님"(PRESENT)이다.
    if (matchStatus === RETIREMENT_MATCH.BROKEN) {
      return { observable: false };
    }
    return {
      observable: true,
      count: 1,
      consumedViaRetirement: matchStatus === RETIREMENT_MATCH.MATCHED,
    };
  }
  // COLLECTION_FAILED/TASK_FILE_MTIME_UNAVAILABLE/그 밖의 알 수 없는
  // status -- 억제·등급 가림·수집 실패를 "0건"으로 접지 않는다(P1-3).
  return { observable: false };
}

// 워크트리 하나에 대해 observeArchiveInventory(ⓐⓒⓓ) + 위 ⓑ + 아래
// B1(본체 제외·라운드 증거 0)을 합쳐 judgeArchiveEligibility를 구동한다.
// 전부 주입 가능(시험은 fake git/fs/retirementReaddir를 명시로 준다,
// 기본값은 위 default*Fn). `isMainCheckout`은 호출자(runTeardownShadowStep,
// 아래)가 워크트리 목록의 인덱스 0인지만 전달한다 -- 이 함수 자신은
// 워크트리 목록 전체를 모른다(단일 워크트리 관측 경계, teardown-
// inventory-adapter.mjs와 동일한 관심사 분리).
function judgeTeardownShadowForWorktree({
  worktreePath,
  detectorResult,
  teardownShadow,
  isMainCheckout,
}) {
  const observeArchiveInventoryFn =
    teardownShadow.observeArchiveInventoryFn ?? observeArchiveInventory;
  const readFileFn = teardownShadow.readFileFn ?? defaultArchiveReadFileFn;
  const archiveInventory = observeArchiveInventoryFn(
    { worktreePath },
    {
      gitFn: teardownShadow.gitFn ?? defaultArchiveGitFn,
      lsRemoteFn: teardownShadow.lsRemoteFn ?? defaultArchiveGitFn,
      isAncestorFn: teardownShadow.isAncestorFn ?? defaultIsAncestorFn,
      existsFn: teardownShadow.existsFn ?? defaultArchiveExistsFn,
      readFileFn,
      listHarnessFilesFn:
        teardownShadow.listHarnessFilesFn ?? defaultListHarnessFiles,
      readFileBufferFn:
        teardownShadow.readFileBufferFn ?? defaultReadHarnessFileBuffer,
    },
  );
  const unconsumedRounds = deriveUnconsumedRoundsForWorktree({
    worktreePath,
    detectorResult,
    retirementReaddirFn:
      teardownShadow.retirementReaddirFn ?? defaultRetirementReaddir,
    readFileFn,
  });
  // B1(책임자 판정 1012) -- 본체는 `isMainCheckout`을 그대로 싣는다(이미
  // 관측된 사실, 재관측 불필요). 라운드 증거는 archiveManifest가 이미
  // 수집한 `.harness` 전체 파일 목록에서 `.harness/receipts/` 하위
  // 개수만 센다(새 fs 호출 0 -- 같은 관측을 재사용한다).
  const mainCheckout = { observable: true, isMain: isMainCheckout === true };
  const roundEvidence =
    archiveInventory.archiveManifest.observable === true
      ? {
          observable: true,
          count: archiveInventory.archiveManifest.files.filter((f) =>
            f.path.startsWith(".harness/receipts/"),
          ).length,
        }
      : { observable: false };
  const judgeArchiveEligibilityFn =
    teardownShadow.judgeArchiveEligibilityFn ?? judgeArchiveEligibility;
  const judged = judgeArchiveEligibilityFn({
    inventory: {
      ...archiveInventory,
      unconsumedRounds,
      mainCheckout,
      roundEvidence,
    },
  });
  return {
    worktreePath,
    eligibility: judged.eligibility,
    reason: judged.reason,
  };
}

const TEARDOWN_SHADOW_STATE_FILENAME = "teardown-shadow-notify-state.json";

function readTeardownShadowNotifyState(readFn, statePath) {
  try {
    const parsed = JSON.parse(readFn(statePath, "utf8"));
    return Array.isArray(parsed?.eligibleDigests) ? parsed.eligibleDigests : [];
  } catch {
    // fail-open(escalation-notify-state.json과 동일 원칙): 직전 통지가
    // 없었다로 접어 재통지 후보로 둔다 -- 과소통지보다 과대통지가 안전.
    return [];
  }
}

// HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑹ P2-2/P2-4 수리):
// ⑴ P2-2 -- `allEntries`(워크트리 전부, ELIGIBLE 여부 무관)를 받아 ELIGIBLE
//    목록 아래에 "그 밖의 판정"(워크트리:사유) 전체를 옮겨 적는다. 로그
//    줄은 요약(건수)만 내고, 워크트리별 전체 상세는 여기(받는함)로만
//    보장한다 -- 60자 절단으로 행이 사라지지 않는다.
// ⑵ P2-4 -- ORCH 초안이 "SHA 선기록"만 적고 "복원" 줄이 없었다(검토 1R
//    P2-4). `orca worktree rm`은 브랜치도 함께 지우므로, 되돌릴 때 쓸
//    `git branch <이름> <SHA>` 복원 줄을 선기록 줄 바로 다음에 더한다
//    (브랜치 이름은 워크트리 디렉터리 이름으로 짐작하지 않는다 -- 사람이
//    실제 브랜치명을 적어 넣을 자리로 `<branch-name>`을 그대로 남긴다).
function buildTeardownShadowNoticeText({ eligibleEntries, allEntries, nowMs }) {
  const lines = [];
  lines.push(
    `# 그림자 teardown 판정 -- 아카이브 후보 ${eligibleEntries.length}건 (${new Date(nowMs).toISOString()})`,
  );
  lines.push("");
  lines.push(
    "이 축은 그림자(판정만)입니다 -- 아무것도 지우지 않았습니다(armed=false 고정, HYK-464-teardown-shadow-1).",
  );
  for (const entry of eligibleEntries) {
    lines.push("");
    lines.push(`## ${entry.worktreePath}`);
    lines.push("- 판정: ELIGIBLE");
    lines.push(
      `- ORCH 초안 3줄(검토 후 손으로 실행 -- ⚠️\`orca worktree rm\`은 브랜치도 함께 지운다):`,
    );
    lines.push(
      `  1. SHA 선기록: \`git -C "${entry.worktreePath}" rev-parse HEAD\``,
    );
    lines.push(
      `  2. 제거: \`orca worktree rm --worktree "${entry.worktreePath}" --json\``,
    );
    lines.push(
      `  3. 복원이 필요하면: \`git branch <branch-name> <위 1에서 선기록한 SHA>\``,
    );
  }
  const rest = (Array.isArray(allEntries) ? allEntries : []).filter(
    (e) => e.eligibility !== ELIGIBILITY.ELIGIBLE,
  );
  if (rest.length > 0) {
    lines.push("");
    lines.push("## 그 밖의 판정(ELIGIBLE 아님, 워크트리별 전체)");
    for (const entry of rest) {
      lines.push(`- ${entry.worktreePath}: ${entry.reason}`);
    }
  }
  return lines.join("\n") + "\n";
}

function buildTeardownShadowNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `teardown-shadow-notify-${iso}.md`;
}

// "같은 집합이 이어지면 재통지 0"(§2 product_scope ③) -- dedupe 열쇠는
// 지금 ELIGIBLE인 워크트리 경로 다이제스트 집합이다. 집합이 비면(0건)
// 상태를 비워 둔다 -- 그래야 나중에 "사라졌다가 다시 나타난" 같은 집합이
// 다시 발화한다(unconsumed-vanish 축과 동일 원칙, §2 비타협).
function runTeardownShadowNotifyStep({
  eligibleEntries,
  allEntries,
  watchDir,
  notifyDir,
  now,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  if (!notifyDir) return { attempted: false };
  const statePath = path.join(watchDir, TEARDOWN_SHADOW_STATE_FILENAME);
  const currentDigests = eligibleEntries
    .map((e) => computeCanonicalPathDigest(e.worktreePath))
    .sort();
  const priorDigests = readTeardownShadowNotifyState(readFn, statePath);
  const sameSet =
    priorDigests.length === currentDigests.length &&
    priorDigests.every((d, i) => d === currentDigests[i]);
  const persistState = () => {
    try {
      if (!existsFn(watchDir)) mkdirFn(watchDir, { recursive: true });
      writeFn(
        statePath,
        JSON.stringify({ eligibleDigests: currentDigests }),
        "utf8",
      );
    } catch {
      // 상태 저장 실패는 이 단계의 계약을 깨지 않는다(fail-open -- 다음
      // 회차에 다시 재통지될 뿐, runEscalationDedupeStep과 동일 원칙).
    }
  };
  if (eligibleEntries.length === 0 || sameSet) {
    persistState();
    return {
      attempted: false,
      suppressed: sameSet && eligibleEntries.length > 0,
    };
  }
  try {
    if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
    const noticeText = buildTeardownShadowNoticeText({
      eligibleEntries,
      allEntries,
      nowMs: now,
    });
    const noticePath = path.join(
      notifyDir,
      buildTeardownShadowNoticeFileName(now),
    );
    writeFn(noticePath, noticeText, "utf8");
    persistState();
    return { attempted: true, sent: true, noticePath };
  } catch (err) {
    return {
      attempted: true,
      sent: false,
      reason: err && err.message ? err.message : String(err),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HYK-491-teardown-arm-1 (coder-task.md §2 product_scope ⓘ~ⓘⓘⓘⓘ) -- 무장
// (armed) 실행 경로. 기본 off(아래 judgeTeardownArmFlag가 파일 부재를
// off로 읽는다) -- off면 이 구역 전체가 호출되지 않거나(runTeardownShadowStep이
// armed:false를 즉시 받고 attempted:false를 돌린다) 아무 fs/orca 호출도
// 만들지 않는다(§2 비타협 ⓘ "off면 바이트 동작 동일").
//
// 켜는 방법(ⓘ "예약 작업 정의·인자 변경 없이"): 이미 CLI가 받는
// `--watch-dir` 그 디렉터리 안에 아래 플래그 파일이 있으면 그 회차만
// 무장이다(새 CLI 플래그 0, schtasks 인자 변경 0 -- ORCH가 그 파일 하나를
// 만들거나 지우는 것만으로 켜고 끈다). 이 라운드는 그 파일을 만들지
// 않는다(product_scope ⓘⓘⓘⓘ "켜는 주체 = 병합 뒤 책임자 통지로 ORCH").
// ---------------------------------------------------------------------------

// HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P1-2 수리, 검토
// 1R P1-2 실측): 1R은 "파일이 존재하기만 하면 on"이었다 -- 그래서
// `false`/`{"armed":false}`/다른 키/디렉터리까지 전부 on으로 샜다. 2R은
// 파일 이름을 `teardown-arm.json`으로 바꾸고(내용이 있는 파일이라는
// 뜻을 이름에도 반영), 그 내용이 **JSON 객체이고 `armed`가 정확히
// 불리언 `true`**일 때만 on으로 판정한다 -- 그 밖(없음·빈 파일·JSON
// 아님·폴더·문자열/숫자/배열 최상위 값·armed 키 없음·armed:false)은
// 전부 off이고, 각 사유를 서로 다른 토큰으로 구분한다(판정 자체에는
// 쓰지 않는다 -- armed는 오직 위 한 조건으로만 true가 된다).
const TEARDOWN_ARM_FLAG_FILENAME = "teardown-arm.json";

export const TEARDOWN_ARM_FLAG_REASON = Object.freeze({
  ABSENT: "TEARDOWN_ARM_FLAG_ABSENT",
  IS_DIRECTORY: "TEARDOWN_ARM_FLAG_IS_DIRECTORY",
  EMPTY: "TEARDOWN_ARM_FLAG_EMPTY",
  NOT_JSON: "TEARDOWN_ARM_FLAG_NOT_JSON",
  VALUE_IS_ARRAY: "TEARDOWN_ARM_FLAG_VALUE_IS_ARRAY",
  VALUE_IS_STRING: "TEARDOWN_ARM_FLAG_VALUE_IS_STRING",
  VALUE_IS_NUMBER: "TEARDOWN_ARM_FLAG_VALUE_IS_NUMBER",
  NOT_OBJECT: "TEARDOWN_ARM_FLAG_NOT_OBJECT",
  ARMED_KEY_MISSING: "TEARDOWN_ARM_FLAG_ARMED_KEY_MISSING",
  ARMED_NOT_TRUE: "TEARDOWN_ARM_FLAG_ARMED_NOT_TRUE",
});

// confirmedBy/at은 §2 비타협("기록만 -- 판정 불사용")대로 여기서도 armed
// 판정에 전혀 쓰지 않는다 -- 아래에서 읽어서 호출자(runTeardownArmStep ->
// writeTeardownArmNotice)에 그대로 실어 보내기만 한다(받는함에 "기록").
// judgeTeardownArmFlag(아래)에서 분리(복잡도 분산) -- 파일 존재·읽기
// 단계만 맡는다. fail-closed: watchDir/existsFn/readFn이 없거나,
// 존재를 못 읽거나, 없거나, 디렉터리거나, 빈 파일이면 여기서 끝난다.
function readTeardownArmFlagRaw({ watchDir, existsFn, readFn }) {
  if (
    !isNonEmptyString(watchDir) ||
    typeof existsFn !== "function" ||
    typeof readFn !== "function"
  ) {
    return { ok: false, reason: TEARDOWN_ARM_FLAG_REASON.ABSENT };
  }
  const flagPath = path.join(watchDir, TEARDOWN_ARM_FLAG_FILENAME);
  let exists;
  try {
    exists = existsFn(flagPath) === true;
  } catch {
    // fail-closed: 존재 자체를 못 읽으면 무장이 아니다(§2 비타협).
    return { ok: false, reason: TEARDOWN_ARM_FLAG_REASON.ABSENT };
  }
  if (!exists) {
    return { ok: false, reason: TEARDOWN_ARM_FLAG_REASON.ABSENT };
  }
  let raw;
  try {
    raw = readFn(flagPath, "utf8");
  } catch (err) {
    if (err && err.code === "EISDIR") {
      return { ok: false, reason: TEARDOWN_ARM_FLAG_REASON.IS_DIRECTORY };
    }
    return { ok: false, reason: TEARDOWN_ARM_FLAG_REASON.NOT_JSON };
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: TEARDOWN_ARM_FLAG_REASON.EMPTY };
  }
  return { ok: true, raw };
}

// judgeTeardownArmFlag(아래)에서 분리(복잡도 분산) -- 이미 JSON.parse된
// 값의 "모양"만 분류한다. null = armed 판정 통과(그 값이 바로 armed:true
// 객체라는 뜻 -- 호출자가 그 객체에서 confirmed_by/at을 읽는다).
function classifyTeardownArmFlagValue(parsed) {
  if (Array.isArray(parsed)) return TEARDOWN_ARM_FLAG_REASON.VALUE_IS_ARRAY;
  if (typeof parsed === "string")
    return TEARDOWN_ARM_FLAG_REASON.VALUE_IS_STRING;
  if (typeof parsed === "number")
    return TEARDOWN_ARM_FLAG_REASON.VALUE_IS_NUMBER;
  if (parsed === null || typeof parsed !== "object")
    return TEARDOWN_ARM_FLAG_REASON.NOT_OBJECT;
  if (!Object.prototype.hasOwnProperty.call(parsed, "armed"))
    return TEARDOWN_ARM_FLAG_REASON.ARMED_KEY_MISSING;
  if (parsed.armed !== true) return TEARDOWN_ARM_FLAG_REASON.ARMED_NOT_TRUE;
  return null;
}

function judgeTeardownArmFlag({ watchDir, existsFn, readFn }) {
  const read = readTeardownArmFlagRaw({ watchDir, existsFn, readFn });
  if (!read.ok) return { armed: false, reason: read.reason };
  let parsed;
  try {
    parsed = JSON.parse(read.raw);
  } catch {
    return { armed: false, reason: TEARDOWN_ARM_FLAG_REASON.NOT_JSON };
  }
  const badReason = classifyTeardownArmFlagValue(parsed);
  if (badReason) return { armed: false, reason: badReason };
  return {
    armed: true,
    confirmedBy: isNonEmptyString(parsed.confirmed_by)
      ? parsed.confirmed_by
      : null,
    at: isNonEmptyString(parsed.at) ? parsed.at : null,
  };
}

// 워크트리가 지워진 «뒤»에도 쓸 수 있어야 한다(cwd=worktreePath는 그
// 시점에 더는 존재하지 않는다) -- defaultArchiveGitFn(cwd=worktreePath)
// 과 분리된 이유. 복원(branch 재생성)·재관측(rev-parse) 둘 다 이 함수로
// repoRoot에서 돈다.
function defaultRepoRootGitFn(argv, repoRootPath) {
  return execFileSync("git", argv, {
    cwd: repoRootPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// 제어실 아카이브 사본 1개를 실 fs로 쓴다/읽는다(시험은 teardownShadow.
// writeArchiveBufferFn/readArchiveBufferFn으로 전부 대체 가능 -- 쓰기
// 실패·손상 시나리오를 변이로 재현하기 위한 주입구, 다른 default*Fn과
// 동일 관례).
function defaultWriteArchiveBufferFn(destPath, buffer) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, buffer);
}
function defaultReadArchiveBufferFn(destPath) {
  return readFileSync(destPath);
}

// SHA·브랜치 이름 선기록 -- 복원(branch 재생성)의 유일한 근거 파일.
// 이 함수가 던지면(쓰기 실패) 호출자가 그 워크트리를 그 자리에서
// 중단한다(아카이브·제거 어느 것도 더 가지 않는다 -- fail-closed).
function recordTeardownArmSha({
  recordDir,
  worktreePath,
  branch,
  sha,
  now,
  existsFn,
  mkdirFn,
  writeFn,
}) {
  if (!existsFn(recordDir)) mkdirFn(recordDir, { recursive: true });
  const recordPath = path.join(recordDir, "sha-record.json");
  writeFn(
    recordPath,
    JSON.stringify({
      worktreePath,
      branch,
      sha,
      recordedAt: new Date(now).toISOString(),
    }),
    "utf8",
  );
  return recordPath;
}

// `.harness` 아카이브 + 원본·사본 파일별 sha256 대조 IDENTICAL(product_scope
// ⓘⓘ 순서 2/3). 원본은 «다시» 읽는다(판정 시점의 관측 캐시를 그대로
// 믿지 않는다 -- 복사 직전의 실제 바이트와 대조해야 "사본이 원본과
// 같다"는 결론이 그 순간에 대해 참이다). 파일 하나라도 못읽음·못씀·
// 불일치면 그 자리에서 멈춘다(이미 쓴 사본은 그대로 둔다 -- 증거
// 보존, 삭제하지 않는다).
function archiveTeardownHarnessFiles({
  archiveDestDir,
  worktreePath,
  manifestFiles,
  readFileBufferFn,
  writeArchiveBufferFn,
  readArchiveBufferFn,
}) {
  const archivedFiles = [];
  for (const f of manifestFiles) {
    let originalBuffer;
    try {
      originalBuffer = readFileBufferFn(f.path, worktreePath);
    } catch {
      return {
        ok: false,
        reason: `TEARDOWN_ARM_ARCHIVE_READ_FAILED:${f.path}`,
        archivedFiles,
      };
    }
    if (!Buffer.isBuffer(originalBuffer)) {
      return {
        ok: false,
        reason: `TEARDOWN_ARM_ARCHIVE_READ_FAILED:${f.path}`,
        archivedFiles,
      };
    }
    const destPath = path.join(archiveDestDir, f.path);
    try {
      writeArchiveBufferFn(destPath, originalBuffer);
    } catch {
      return {
        ok: false,
        reason: `TEARDOWN_ARM_ARCHIVE_WRITE_FAILED:${f.path}`,
        archivedFiles,
      };
    }
    let copyBuffer;
    try {
      copyBuffer = readArchiveBufferFn(destPath);
    } catch {
      return {
        ok: false,
        reason: `TEARDOWN_ARM_ARCHIVE_COMPARE_READ_FAILED:${f.path}`,
        archivedFiles,
      };
    }
    if (!Buffer.isBuffer(copyBuffer)) {
      return {
        ok: false,
        reason: `TEARDOWN_ARM_ARCHIVE_COMPARE_READ_FAILED:${f.path}`,
        archivedFiles,
      };
    }
    const originalSha = createHash("sha256")
      .update(originalBuffer)
      .digest("hex");
    const copiedSha = createHash("sha256").update(copyBuffer).digest("hex");
    if (originalSha !== copiedSha) {
      return {
        ok: false,
        reason: `TEARDOWN_ARM_ARCHIVE_MISMATCH:${f.path}`,
        archivedFiles,
      };
    }
    archivedFiles.push({
      path: f.path,
      bytes: originalBuffer.length,
      sha256: originalSha,
    });
  }
  return { ok: true, archivedFiles };
}

// 워크트리 하나의 고정 순서 전체(product_scope ⓘⓘ): SHA·브랜치 선기록
// -> 아카이브+sha256 대조 IDENTICAL -> 좌석 0 확인 -> 어댑터로 제거 ->
// 로컬 브랜치 없으면 복원 -> 재관측. 어느 단계든 실패하면 그 자리에서
// 멈춘다(ok:false + step + reason) -- 호출자(runTeardownArmStep)가 "이
// 회차의 남은 워크트리로 더 가지 않는다"를 결정한다(기본 = 전체 중단,
// 설계 메모 §2 ⓘⓘⓘ).
// ⑴ 재관측(그림자 판정 당시 캐시가 아니라 실행 시점에 다시 본다) --
// archiveManifest(목록+원본 sha256) + mergeStatus.headSha + 브랜치
// 이름까지 이 자리에서 새로 읽는다. runArmedRemovalForWorktree에서
// 분리(복잡도 분산 -- 몸통만 쪼갠다, judgeTeardownShadowForWorktree류
// 선례와 동일한 이유).
// 복원에 쓸 브랜치 이름을 관측한다(worktreePath가 지워지기 «전»에만
// 할 수 있다). observeFreshArmInventory에서 분리(복잡도 분산).
function resolveArmBranchName(gitFn, worktreePath) {
  let branchName;
  try {
    branchName = String(
      gitFn(buildGitRevParseAbbrevRefCommand(), worktreePath),
    ).trim();
  } catch {
    return { ok: false, reason: "TEARDOWN_ARM_BRANCH_NAME_UNOBSERVABLE" };
  }
  if (!isNonEmptyString(branchName) || branchName === "HEAD") {
    return { ok: false, reason: "TEARDOWN_ARM_BRANCH_NAME_INVALID" };
  }
  return { ok: true, branchName };
}

function observeFreshArmInventory({
  worktreePath,
  teardownShadow,
  readFileBufferFn,
}) {
  const gitFn = teardownShadow.gitFn ?? defaultArchiveGitFn;
  const observeArchiveInventoryFn =
    teardownShadow.observeArchiveInventoryFn ?? observeArchiveInventory;
  const freshInventory = observeArchiveInventoryFn(
    { worktreePath },
    {
      gitFn,
      lsRemoteFn: teardownShadow.lsRemoteFn ?? gitFn,
      isAncestorFn: teardownShadow.isAncestorFn ?? defaultIsAncestorFn,
      existsFn: teardownShadow.existsFn ?? defaultArchiveExistsFn,
      readFileFn: teardownShadow.readFileFn ?? defaultArchiveReadFileFn,
      listHarnessFilesFn:
        teardownShadow.listHarnessFilesFn ?? defaultListHarnessFiles,
      readFileBufferFn,
    },
  );
  if (
    freshInventory.mergeStatus.observable !== true ||
    !isNonEmptyString(freshInventory.mergeStatus.headSha)
  ) {
    return {
      ok: false,
      step: "SHA_RECORD",
      reason: "TEARDOWN_ARM_SHA_UNOBSERVABLE",
    };
  }
  if (freshInventory.archiveManifest.observable !== true) {
    return {
      ok: false,
      step: "ARCHIVE",
      reason: "TEARDOWN_ARM_ARCHIVE_MANIFEST_UNOBSERVABLE",
    };
  }
  const branch = resolveArmBranchName(gitFn, worktreePath);
  if (!branch.ok) {
    return { ok: false, step: "SHA_RECORD", reason: branch.reason };
  }
  return {
    ok: true,
    headSha: freshInventory.mergeStatus.headSha,
    branchName: branch.branchName,
    archiveManifestFiles: freshInventory.archiveManifest.files,
  };
}

// HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P2-2 수리, 검토
// 1R P2-2 실측): 1R은 `computeCanonicalPathDigest`(32-hex)를 아카이브
// 하위 폴더 이름으로 썼다 -- 사람이 읽을 수 없고, ORCH 손 B-15
// (`<이름>-final`)와도 모양이 다르다. 2R은 워크트리 경로의 마지막
// 세그먼트(이름) + `-final`을 쓴다 -- B-15와 같은 모양이고, "같은
// 경로 -> 항상 같은 폴더 이름"이 그대로 유지돼(P2-3 아래) 재사용 경로
// 충돌도 그대로 걸린다.
function buildArmArchiveFinalName(worktreePath) {
  const trimmed = String(worktreePath).replace(/[\\/]+$/, "");
  const base = path.basename(trimmed);
  return `${base}-final`;
}

// HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P2-2 수리) --
// archiveRoot 기본값. 감시 폴더(watchDir)의 "부모"(관제실)에 `아카이브`
// 폴더를 두고, 그 아래 날짜 자동 폴더 하나(ORCH 손 B-15와 같은 모양,
// "<날짜>-B76-..." 대신 이 축 전용 고정 토큰 "teardown-arm"을 쓴다 --
// 사람 작업(B-15)과 자동 무장 경로를 폴더 이름만으로 구분할 수 있게).
function buildDefaultTeardownArmArchiveRoot(watchDir, now) {
  const dateToken = new Date(now).toISOString().slice(0, 10);
  return path.join(
    path.dirname(watchDir),
    "아카이브",
    `${dateToken}-teardown-arm`,
  );
}

// HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P2-3 수리, 검토
// 1R P2-3 실측): 1R은 같은 경로가 다시 아카이브 대상이 되면 디지스트
// 폴더를 그대로 덮어써 1차·2차 내용이 섞였다. 2R은 recordDir(위 이름
// 그대로)이 이미 있으면(과거에 같은 경로를 아카이브한 적이 있다는 뜻)
// 그 자리에서 멈춘다 -- ORCH 손 B-15의 `if (Test-Path $A) { throw
// 'archive exists' }`와 같은 성질(덮어쓰기 금지), 다만 여기는 throw가
// 아니라 그 워크트리만 건너뛴다(기존 fail-closed 관례 그대로).
function checkArchiveDestAbsentForArm({ recordDir, existsFn }) {
  let exists;
  try {
    exists = existsFn(recordDir) === true;
  } catch {
    return {
      step: "ARCHIVE_EXISTS_CHECK",
      reason: "TEARDOWN_ARM_ARCHIVE_DEST_UNOBSERVABLE",
    };
  }
  if (exists) {
    return {
      step: "ARCHIVE_EXISTS_CHECK",
      reason: "TEARDOWN_ARM_ARCHIVE_ALREADY_EXISTS",
    };
  }
  return null;
}

// ⑵+⑶ SHA·브랜치 선기록 + 아카이브 + sha256 대조 IDENTICAL.
// runArmedRemovalForWorktree에서 분리(복잡도 분산).
function recordShaAndArchive({
  worktreePath,
  archiveRoot,
  now,
  headSha,
  branchName,
  archiveManifestFiles,
  readFileBufferFn,
  writeArchiveBufferFn,
  readArchiveBufferFn,
  existsFn,
  mkdirFn,
  writeFn,
}) {
  const recordDir = path.join(
    archiveRoot,
    buildArmArchiveFinalName(worktreePath),
  );
  const existsFailure = checkArchiveDestAbsentForArm({ recordDir, existsFn });
  if (existsFailure) return existsFailure;
  let recordPath;
  try {
    recordPath = recordTeardownArmSha({
      recordDir,
      worktreePath,
      branch: branchName,
      sha: headSha,
      now,
      existsFn,
      mkdirFn,
      writeFn,
    });
  } catch (err) {
    return {
      ok: false,
      step: "SHA_RECORD",
      reason: `TEARDOWN_ARM_SHA_RECORD_FAILED:${err && err.message ? err.message : String(err)}`,
    };
  }
  const archiveDestDir = path.join(recordDir, "harness-archive");
  const archived = archiveTeardownHarnessFiles({
    archiveDestDir,
    worktreePath,
    manifestFiles: archiveManifestFiles,
    readFileBufferFn,
    writeArchiveBufferFn,
    readArchiveBufferFn,
  });
  if (!archived.ok) {
    return {
      ok: false,
      step: "ARCHIVE",
      reason: archived.reason,
      recordPath,
      archivedFiles: archived.archivedFiles,
    };
  }
  return { ok: true, recordPath, archivedFiles: archived.archivedFiles };
}

// ⑷ 좌석 0 확인(활성 예약/좌석 -- 그림자 ELIGIBLE이 보지 않는 추가
// 안전판, teardown-inventory-adapter.mjs §주석). null = 통과.
function checkSeatZeroForArm({ worktreePath, execFn, teardownShadow }) {
  const observeSeatCountFn =
    teardownShadow.observeSeatCountFn ?? observeSeatCount;
  const seat = observeSeatCountFn(worktreePath, { execFn });
  if (seat.observable !== true) {
    return { step: "SEAT_CHECK", reason: "TEARDOWN_ARM_SEAT_UNOBSERVABLE" };
  }
  if (seat.count > 0) {
    return {
      step: "SEAT_CHECK",
      reason: "TEARDOWN_ARM_SEAT_PRESENT",
      seatCount: seat.count,
    };
  }
  return null;
}

// HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P1-1 수리, 검토
// 1R P1-1 실측): 그림자 판정(judgeArchiveEligibility, 6축)은 working
// tree가 dirty한지 전혀 보지 않는다 -- 그래서 1R은 커밋 안 된 변경이
// 있는 워크트리도 ELIGIBLE이 나면 그대로 force-제거해 그 변경을 영구히
// 잃었다. 이 축은 좌석 확인(위)과 같은 자리에서(제거 직전, ELIGIBLE
// 집합을 "더 좁히기만" 하는 추가 안전판 -- 그림자 조건 자체는 넓히지
// 않는다) `git status --porcelain`이 0줄인지 fail-closed로 확인한다.
// teardown-inventory-adapter.mjs의 observeWorkingTree(비공개, HYK-171
// 축)가 이미 같은 판정(dirty = 줄 수 > 0)을 하므로 그 로직을 다시 짜지
// 않고, argv 빌더(buildGitStatusCommand, 위 import)만 재사용한다 --
// gitFn 호출 관례가 그 함수와 다르다(이 파일의 gitFn은 항상 두 번째
// 인자로 worktreePath를 받는다, defaultArchiveGitFn 참조)는 이유로
// 판정 자체는 이 파일에 독립으로 둔다.
function checkWorkingTreeCleanForArm({ worktreePath, gitFn }) {
  let output;
  try {
    output = gitFn(buildGitStatusCommand(), worktreePath);
  } catch {
    return {
      step: "WORKING_TREE_CHECK",
      reason: "TEARDOWN_ARM_WORKING_TREE_UNOBSERVABLE",
    };
  }
  if (typeof output !== "string") {
    return {
      step: "WORKING_TREE_CHECK",
      reason: "TEARDOWN_ARM_WORKING_TREE_UNOBSERVABLE",
    };
  }
  const dirty = output.split("\n").some((line) => line.length > 0);
  if (dirty) {
    return {
      step: "WORKING_TREE_CHECK",
      reason: "TEARDOWN_ARM_WORKING_TREE_DIRTY",
    };
  }
  return null;
}

// ⑸+⑹ 어댑터로 워크트리 제거(G9 -- orca 호출은 이 함수를 통해서만) +
// 로컬 브랜치 없으면 복원(`orca worktree rm`은 브랜치도 함께 지운다 --
// 선기록 SHA로만 복원한다, 추측 조립 0).
function removeAndRestoreBranch({
  worktreePath,
  repoRoot,
  repoRootGitFn,
  execFn,
  teardownShadow,
  branchName,
  headSha,
}) {
  const removeArchivedWorktreeFn =
    teardownShadow.removeArchivedWorktreeFn ?? removeArchivedWorktree;
  const removed = removeArchivedWorktreeFn(
    { worktreePath, armed: true },
    { execFn },
  );
  if (!removed.ok) {
    return { ok: false, step: "REMOVE", reason: removed.reason };
  }
  let branchExists = true;
  try {
    repoRootGitFn(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
      repoRoot,
    );
  } catch {
    branchExists = false;
  }
  if (branchExists) return { ok: true, branchRestored: false };
  try {
    repoRootGitFn(["branch", branchName, headSha], repoRoot);
  } catch (err) {
    return {
      ok: false,
      step: "BRANCH_RESTORE",
      reason: `TEARDOWN_ARM_BRANCH_RESTORE_FAILED:${err && err.message ? err.message : String(err)}`,
      removed: true,
      branchName,
      sha: headSha,
    };
  }
  return { ok: true, branchRestored: true };
}

// ⑺ 재관측 -- 3층(git/orca/dir) 전부 absent + 브랜치 SHA가 선기록과
// 일치해야 성공이다(observeTeardownInventory 재사용 -- 새 관측 로직을
// 다시 짜지 않는다, §재사용).
function reobserveArmedRemoval({
  worktreePath,
  repoRoot,
  repoRootGitFn,
  execFn,
  existsFn,
  branchName,
  headSha,
}) {
  const after = observeTeardownInventory(
    { worktreePath },
    { execFn, gitFn: (argv) => repoRootGitFn(argv, repoRoot), existsFn },
  );
  const fullyAbsent =
    after.layers.git === "absent" &&
    after.layers.orca === "absent" &&
    after.layers.dir === "absent";
  let branchShaAfter;
  try {
    branchShaAfter = String(
      repoRootGitFn(["rev-parse", branchName], repoRoot),
    ).trim();
  } catch {
    branchShaAfter = null;
  }
  return { ok: fullyAbsent && branchShaAfter === headSha, after };
}

// 워크트리 하나의 고정 순서 전체(product_scope ⓘⓘ): SHA·브랜치 선기록
// -> 아카이브+sha256 대조 IDENTICAL -> 좌석 0 확인 -> 어댑터로 제거 ->
// 로컬 브랜치 없으면 복원 -> 재관측. 어느 단계든 실패하면 그 자리에서
// 멈춘다(ok:false + step + reason) -- 호출자(runTeardownArmStep)가 "이
// 회차의 남은 워크트리로 더 가지 않는다"를 결정한다(기본 = 전체 중단,
// 설계 메모 §2 ⓘⓘⓘ).
// ⑸+⑹+⑺ 어댑터로 제거 -> 브랜치 복원 -> 재관측. runArmedRemovalForWorktree
// 에서 분리(복잡도·줄수 분산) -- recordPath/archivedFiles(⑵+⑶ 결과)를
// 모든 실패 분기에 일관되게 실어 보낸다(수동 복구 근거 보존).
function removeRestoreAndReobserve({
  worktreePath,
  repoRoot,
  repoRootGitFn,
  execFn,
  existsFn,
  teardownShadow,
  branchName,
  headSha,
  recordPath,
  archivedFiles,
}) {
  const removal = removeAndRestoreBranch({
    worktreePath,
    repoRoot,
    repoRootGitFn,
    execFn,
    teardownShadow,
    branchName,
    headSha,
  });
  if (!removal.ok) {
    return { worktreePath, ok: false, ...removal, recordPath, archivedFiles };
  }
  const reobserved = reobserveArmedRemoval({
    worktreePath,
    repoRoot,
    repoRootGitFn,
    execFn,
    existsFn,
    branchName,
    headSha,
  });
  if (!reobserved.ok) {
    return {
      worktreePath,
      ok: false,
      step: "REOBSERVE",
      reason: "TEARDOWN_ARM_POST_CONDITIONS_NOT_MET",
      recordPath,
      archivedFiles,
      removed: true,
      branchName,
      sha: headSha,
      branchRestored: removal.branchRestored,
      after: reobserved.after,
    };
  }
  return {
    worktreePath,
    ok: true,
    step: "DONE",
    recordPath,
    archivedFiles,
    branchName,
    sha: headSha,
    branchRestored: removal.branchRestored,
  };
}

function runArmedRemovalForWorktree({
  worktreePath,
  repoRoot,
  archiveRoot,
  now,
  teardownShadow,
  readFileBufferFn,
  writeArchiveBufferFn,
  readArchiveBufferFn,
  repoRootGitFn,
  existsFn,
  mkdirFn,
  writeFn,
  execFn,
}) {
  const observed = observeFreshArmInventory({
    worktreePath,
    teardownShadow,
    readFileBufferFn,
  });
  if (!observed.ok) return { worktreePath, ok: false, ...observed };

  const recorded = recordShaAndArchive({
    worktreePath,
    archiveRoot,
    now,
    headSha: observed.headSha,
    branchName: observed.branchName,
    archiveManifestFiles: observed.archiveManifestFiles,
    readFileBufferFn,
    writeArchiveBufferFn,
    readArchiveBufferFn,
    existsFn,
    mkdirFn,
    writeFn,
  });
  if (!recorded.ok) return { worktreePath, ok: false, ...recorded };
  const { recordPath, archivedFiles } = recorded;

  const seatFailure = checkSeatZeroForArm({
    worktreePath,
    execFn,
    teardownShadow,
  });
  if (seatFailure) {
    return {
      worktreePath,
      ok: false,
      ...seatFailure,
      recordPath,
      archivedFiles,
    };
  }

  const workingTreeFailure = checkWorkingTreeCleanForArm({
    worktreePath,
    gitFn: teardownShadow.gitFn ?? defaultArchiveGitFn,
  });
  if (workingTreeFailure) {
    return {
      worktreePath,
      ok: false,
      ...workingTreeFailure,
      recordPath,
      archivedFiles,
    };
  }

  return removeRestoreAndReobserve({
    worktreePath,
    repoRoot,
    repoRootGitFn,
    execFn,
    existsFn,
    teardownShadow,
    branchName: observed.branchName,
    headSha: observed.headSha,
    recordPath,
    archivedFiles,
  });
}

// HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P1-2 수리) --
// confirmedBy/at은 §2 비타협대로 판정에 전혀 쓰지 않는다 -- 있으면
// 받는함 머리에 "기록만" 한다(사람이 "누가·언제 확인했다"를 읽을 수
// 있게, armed 여부와 무관).
// buildTeardownArmNoticeText(아래)에서 분리(복잡도 분산) -- 워크트리
// 하나의 상세 블록만 만든다.
function buildTeardownArmNoticeResultLines(r) {
  const lines = [];
  lines.push(`## ${r.worktreePath}`);
  lines.push(`- 결과: ${r.ok ? "제거됨(SUCCEEDED)" : `중단(${r.step})`}`);
  if (!r.ok) lines.push(`- 사유: ${r.reason}`);
  if (isNonEmptyString(r.recordPath)) {
    lines.push(`- SHA 선기록 파일: ${r.recordPath}`);
  }
  if (Array.isArray(r.archivedFiles)) {
    lines.push(`- 아카이브된 파일 수: ${r.archivedFiles.length}`);
  }
  if (isNonEmptyString(r.branchName)) {
    lines.push(
      `- 브랜치: ${r.branchName} @ ${r.sha}${r.branchRestored ? " (복원함)" : ""}`,
    );
  }
  // HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P2-4 수리,
  // 검토 1R P2-4 실측): 브랜치 복원이 실패하면(워크트리는 이미 지워졌다)
  // 선기록 SHA로 사람이 손으로 복원할 수 있는 명령을 그대로 적어 준다
  // -- 1R은 "브랜치: X @ sha"만 적고 "복원하라"는 지시가 없었다.
  if (r.step === "BRANCH_RESTORE" && isNonEmptyString(r.branchName)) {
    lines.push(
      `- 로컬 브랜치 없음 -- 복원 명령: git branch ${r.branchName} ${r.sha}`,
    );
  }
  return lines;
}

function buildTeardownArmNoticeText({ results, now, confirmedBy, at }) {
  const lines = [];
  lines.push(
    `# 무장 teardown 실행 결과 -- 대상 ${results.length}건 (${new Date(now).toISOString()})`,
  );
  if (isNonEmptyString(confirmedBy) || isNonEmptyString(at)) {
    lines.push(
      `- 무장 파일 기록(판정 불사용): confirmed_by=${confirmedBy ?? "(없음)"} at=${at ?? "(없음)"}`,
    );
  }
  lines.push("");
  const aborted = results.length > 0 && !results[results.length - 1].ok;
  lines.push(
    aborted
      ? "이 회차는 중간에 중단됐다 -- 마지막 항목 이후 워크트리는 손대지 않았다(fail-closed, 설계 메모 §2 ⓘⓘⓘ)."
      : "이 회차의 ELIGIBLE 워크트리 전부가 순서대로 처리됐다.",
  );
  for (const r of results) {
    lines.push("");
    lines.push(...buildTeardownArmNoticeResultLines(r));
  }
  return lines.join("\n") + "\n";
}
function buildTeardownArmNoticeFileName(nowMs) {
  const iso = new Date(nowMs).toISOString().replace(/[:.]/g, "-");
  return `teardown-arm-notify-${iso}.md`;
}

// runTeardownArmStep -- armed가 아니면(기본값) 아무 것도 하지 않는다
// (§2 비타협 ⓘ "off면 바이트 동작 동일" -- attempted:false는 로그
// 세그먼트에 한 글자도 더하지 않는다, 아래 teardownShadowLogSegment
// 참조). execFn은 §재사용: collectIdleSeatResidueStep(위, line ~3457)
// 과 동일한 기존 관례 그대로(`resourceResidue.orcaExecFn ?? createOrcaExecFn()`)
// -- 이 축만을 위한 새 주입 이름을 만들지 않는다. 시험은 전부 명시로
// `resourceResidue.orcaExecFn`에 가짜를 준다(기존 관례, 실 orca 호출 0).
// armed가 켜진 회차의 ELIGIBLE 워크트리 전부를 고정 순서로 처리한다.
// runTeardownArmStep에서 분리(복잡도 분산) -- 한 워크트리가 실패하면
// 그 자리에서 멈춘다(기본 = 전체 중단, 설계 메모 §2 ⓘⓘⓘ "한 개 실패가
// 전체를 지우지 않고" 조항의 반대쪽 기본값 -- 다음 회차(다음 tick)에
// 다시 판정·시도된다).
function runArmedRemovalLoop({
  eligibleEntries,
  repoRoot,
  archiveRoot,
  now,
  teardownShadow,
  readFileBufferFn,
  writeArchiveBufferFn,
  readArchiveBufferFn,
  repoRootGitFn,
  existsFn,
  mkdirFn,
  writeFn,
  execFn,
}) {
  const results = [];
  for (const entry of eligibleEntries) {
    const r = runArmedRemovalForWorktree({
      worktreePath: entry.worktreePath,
      repoRoot,
      archiveRoot,
      now,
      teardownShadow,
      readFileBufferFn,
      writeArchiveBufferFn,
      readArchiveBufferFn,
      repoRootGitFn,
      existsFn,
      mkdirFn,
      writeFn,
      execFn,
    });
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

// 받는함 1장을 쓴다(runTeardownArmStep에서 분리).
function writeTeardownArmNotice({
  results,
  now,
  notifyDir,
  existsFn,
  mkdirFn,
  writeFn,
  confirmedBy,
  at,
}) {
  const noticePath = path.join(notifyDir, buildTeardownArmNoticeFileName(now));
  try {
    if (!existsFn(notifyDir)) mkdirFn(notifyDir, { recursive: true });
    writeFn(
      noticePath,
      buildTeardownArmNoticeText({ results, now, confirmedBy, at }),
      "utf8",
    );
  } catch (err) {
    return {
      ok: false,
      reason: err && err.message ? err.message : String(err),
    };
  }
  return { ok: true, noticePath };
}

function runTeardownArmStep({
  armed,
  flagReason,
  confirmedBy,
  at,
  eligibleEntries,
  teardownShadow,
  repoRoot,
  archiveRoot,
  now,
  notifyDir,
  existsFn,
  mkdirFn,
  writeFn,
  execFn,
}) {
  // HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P1-2 수리):
  // flagReason은 off일 때만 실리고(armed:false 공통 경로), §2 비타협
  // "off면 바이트 동작 동일"은 아래 teardownShadowLogSegment가
  // `attempted!==true`면 토큰을 한 글자도 더하지 않는 것으로 계속
  // 지켜진다 -- flagReason은 그 로그 줄이 아니라 이 armResult 값
  // 자체에만 "기록"된다(호출자·시험이 왜 off인지 구분할 수 있게).
  if (!armed) return { armed: false, attempted: false, flagReason };
  if (!Array.isArray(eligibleEntries) || eligibleEntries.length === 0) {
    return { armed: true, attempted: false, results: [] };
  }
  const results = runArmedRemovalLoop({
    eligibleEntries,
    repoRoot,
    archiveRoot,
    now,
    teardownShadow,
    readFileBufferFn:
      teardownShadow.readFileBufferFn ?? defaultReadHarnessFileBuffer,
    writeArchiveBufferFn:
      teardownShadow.writeArchiveBufferFn ?? defaultWriteArchiveBufferFn,
    readArchiveBufferFn:
      teardownShadow.readArchiveBufferFn ?? defaultReadArchiveBufferFn,
    repoRootGitFn: teardownShadow.repoRootGitFn ?? defaultRepoRootGitFn,
    existsFn,
    mkdirFn,
    writeFn,
    execFn,
  });
  const notice = writeTeardownArmNotice({
    results,
    now,
    notifyDir,
    existsFn,
    mkdirFn,
    writeFn,
    confirmedBy,
    at,
  });
  if (!notice.ok) {
    return {
      armed: true,
      attempted: true,
      results,
      noticeError: notice.reason,
    };
  }
  return {
    armed: true,
    attempted: true,
    results,
    noticePath: notice.noticePath,
  };
}

// runTeardownShadowStep -- resourceResidue.teardownShadow가 없으면
// (기본값, 기존 호출자 전부) 아예 실행하지 않는다(notRun:true, 다른 세
// 잔재 축과 독립적인 opt-in). 워크트리 열거는 resourceResidue.worktreeListFn
// 을 그대로 재사용한다(§재사용 -- 새 열거 로직을 만들지 않는다, 이미
// collectWorktreeResidueStep이 쓰는 동일 주입점).
// runTeardownShadowStep(아래)에서 분리(복잡도·줄수 분산) -- 무장 판정
// +실행 한 덩어리만 맡는다. HYK-491-teardown-arm-1 (coder-task.md §2
// product_scope ⓘ): armed가 아니면(기본값, 플래그 파일 부재 -- 또는
// 2R부터는 어떤 형식이든 {armed:true}가 아니면) runTeardownArmStep은
// {armed:false, attempted:false}만 돌리고 fs/orca 호출을 전혀 만들지
// 않는다 -- teardownShadowLogSegment도 그 상태에서는 한 글자도 더하지
// 않는다(§2 비타협 ⓘ "off면 바이트 동작 동일").
function runTeardownArmPhase({
  resourceResidue,
  teardownShadow,
  repoRoot,
  now,
  watchDir,
  notifyDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
  eligibleEntries,
}) {
  const flagResult = judgeTeardownArmFlag({ watchDir, existsFn, readFn });
  const armed = flagResult.armed === true;
  const archiveRoot = isNonEmptyString(teardownShadow.archiveRoot)
    ? teardownShadow.archiveRoot
    : buildDefaultTeardownArmArchiveRoot(watchDir, now);
  return runTeardownArmStep({
    armed,
    flagReason: flagResult.reason ?? null,
    confirmedBy: flagResult.confirmedBy ?? null,
    at: flagResult.at ?? null,
    eligibleEntries,
    teardownShadow,
    repoRoot,
    archiveRoot,
    now,
    notifyDir,
    execFn: resourceResidue.orcaExecFn ?? createOrcaExecFn(),
    existsFn,
    mkdirFn,
    writeFn,
  });
}

function runTeardownShadowStep({
  resourceResidue,
  detectorResult,
  repoRoot,
  now,
  watchDir,
  notifyDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  const teardownShadow = resourceResidue?.teardownShadow;
  if (!teardownShadow) return { notRun: true };
  // P2-3: 기본 lsRemoteFn만 회차당 1회로 메모이즈한다(위 주석) -- 시험이
  // lsRemoteFn을 직접 주입했으면(진실성 검사: 키 존재) 그 주입을 그대로
  // 쓴다(테스트별 호출 추적을 방해하지 않는다).
  const teardownShadowForRun = teardownShadow.lsRemoteFn
    ? teardownShadow
    : { ...teardownShadow, lsRemoteFn: createMemoizedDefaultLsRemoteFn() };
  const worktreeListFn =
    resourceResidue.worktreeListFn ?? collectGitWorktreesLocal;
  const worktreeList = worktreeListFn(repoRoot, {});
  if (!worktreeList.ok) {
    return {
      notRun: false,
      status: "WORKTREE_LIST_FAILED",
      totalWorktrees: 0,
      eligibleCount: 0,
      entries: [],
      notice: { attempted: false },
    };
  }
  // B1(책임자 판정 1012, coder.md §0 실측): `git worktree list
  // --porcelain`은 본체(main working tree)를 항상 인덱스 0에 낸다 --
  // 이 배열은 그 porcelain 출력을 그대로 파싱한 것이다(worktreeListFn
  // 기본값 collectGitWorktreesLocal, 위 parseGitWorktreeListPorcelainLocal
  // 참조). 그래서 인덱스 0만 본체로 싣는다 -- 경로 문자열이나 이름으로
  // 추측하지 않는다.
  const entries = worktreeList.worktrees.map((worktreePath, idx) =>
    judgeTeardownShadowForWorktree({
      worktreePath,
      detectorResult,
      teardownShadow: teardownShadowForRun,
      isMainCheckout: idx === 0,
    }),
  );
  const eligibleEntries = entries.filter(
    (e) => e.eligibility === ELIGIBILITY.ELIGIBLE,
  );
  const notice = runTeardownShadowNotifyStep({
    eligibleEntries,
    allEntries: entries,
    watchDir,
    notifyDir,
    now,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
  });
  const armResult = runTeardownArmPhase({
    resourceResidue,
    teardownShadow: teardownShadowForRun,
    repoRoot,
    now,
    watchDir,
    notifyDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
    eligibleEntries,
  });
  return {
    notRun: false,
    status: "OK",
    totalWorktrees: entries.length,
    eligibleCount: eligibleEntries.length,
    entries,
    notice,
    armResult,
  };
}

// HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑹ P2-2 수리, 검토 1R
// §2ⓔ 실측): 워크트리별 "이름:사유" 목록은 MAX_PARTIAL_FAILURE_REASON_CHARS
// (60자)에서 그대로 잘려 실물 5행 중 1.5행만 보였다. 이름이 아니라
// "사유별 건수" 요약으로 바꾼다 -- 워크트리 수가 늘어도 요약 종류(사유
// 코드 집합)는 작게 유지되므로 잘릴 일이 거의 없다. 워크트리별 전체
// 상세(이름 + 사유)는 runTeardownShadowNotifyStep이 받는함에 적는다
// (아래 buildTeardownShadowNoticeText가 이제 entries 전체를 받는다).
function teardownShadowLogSegment(result) {
  if (!result || result.notRun) return null;
  const entries = Array.isArray(result.entries) ? result.entries : [];
  const counts = new Map();
  for (const e of entries) {
    const key = e.eligibility === ELIGIBILITY.ELIGIBLE ? "ELIGIBLE" : e.reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([key, n]) => `${key}:${n}`)
    .join(",");
  const base =
    `teardown_shadow_status=${result.status} ` +
    `teardown_shadow_total=${result.totalWorktrees} ` +
    `teardown_shadow_eligible=${result.eligibleCount} ` +
    `teardown_shadow_detail=${summary.length > 0 ? summary : "NONE"}`;
  // HYK-491-teardown-arm-1 (coder-task.md §2 product_scope ⓘ "로그 꼬리
  // 칸"): armed가 실제로 시도되지 않았으면(기본값, armed=off 또는
  // eligible 0) 이 칸을 한 글자도 더하지 않는다 -- §2 비타협 "off면
  // 바이트 동작 동일"이 로그 줄에도 그대로 적용된다.
  const arm = result.armResult;
  if (!arm || arm.attempted !== true) return base;
  const results = Array.isArray(arm.results) ? arm.results : [];
  // HYK-491-teardown-arm-2 (coder-task.md §2 product_scope P2-4 수리,
  // 검토 1R P2-4 실측): 브랜치 복원 실패(BRANCH_RESTORE)·재관측 실패
  // (REOBSERVE)는 `ok:false`이지만 워크트리는 "실제로 이미 없어진"
  // 뒤다(removeAndRestoreBranch/reobserveArmedRemoval이 그 경로에
  // `removed:true`를 싣는다) -- 1R은 `ok`만 셌다. 이 칸은 "워크트리가
  // 실제로 없어진 수"를 세야 한다(복원 실패로 중단돼도 지워졌으면
  // 센다).
  const removed = results.filter(
    (r) => r.ok === true || r.removed === true,
  ).length;
  return (
    `${base} ` +
    `teardown_arm_attempted=true ` +
    `teardown_arm_processed=${results.length} ` +
    `teardown_arm_removed=${removed}`
  );
}

// 세 잔재 종류를 한 회차에 모아 보고한다. opt-in(위 헤더 주석) --
// `resourceResidue`가 없으면(기본값, 대부분의 호출자) 실행하지 않는다
// (admissionSweep/wake와 동일 원칙).
// resourceResidue: { registryPath?, orcaExecFn?, listNodeProcessRowsFn?,
//   worktreeListFn?, collectEvidenceFn?, teardownShadow? } -- teardownShadow는
// HYK-464-teardown-shadow-1이 더한 완전히 독립된 opt-in(위 헤더 참조) --
// 나머지 네 필드는 시험 전용 주입구(실 git/실 fs 대신, 이 저장소 자체를
// 대상으로도 결정적으로 시험할 수 있게 -- blockedTerminationScan의
// harnessDir 오버라이드와 동일 재량).
function runResourceResidueStep({
  resourceResidue,
  repoRoot,
  execFn,
  detectorResult,
  now,
  watchDir,
  notifyDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  if (!resourceResidue) return { notRun: true };
  return {
    notRun: false,
    worktreeResidue: collectWorktreeResidueStep({ resourceResidue, repoRoot }),
    idleSeatResidue: collectIdleSeatResidueStep({ resourceResidue }),
    nodeResidue: collectNodeResidueStep({ resourceResidue, execFn }),
    // HYK-464-teardown-shadow-1: 이 필드는 지금 이 시점의 맨 끝이다 --
    // 앞선 세 필드의 이름·값·계산은 이 라운드가 전혀 손대지 않았다(위
    // 셋 다 그대로 재사용, §2 비타협 "기존 보고 칸 변경 0").
    // teardownShadowResult는 resourceResidue.teardownShadow가 opt-in으로
    // 주어지지 않은 기존 호출자에서 {notRun:true}이고, teardownShadowLogSegment
    // 가 null을 돌려주므로(filter(Boolean)) 로그 줄이 한 글자도 달라지지
    // 않는다(회귀 0).
    teardownShadowResult: runTeardownShadowStep({
      resourceResidue,
      detectorResult,
      repoRoot,
      now,
      watchDir,
      notifyDir,
      readFn,
      writeFn,
      existsFn,
      mkdirFn,
    }),
  };
}

// resourceResidueLogSegment -- 이 축이 실제로(opt-in) 켜졌을 때만 로그
// 줄에 한 세그먼트를 더한다(blockedTerminationLogSegment/sweepLogSegment
// 와 동일한 "사람이 읽는 사유" 원칙). 잔재가 0건이면 값 0으로 조용히
// 남는다(거짓 양성 0 -- §2 시험 요구 그대로).
function resourceResidueLogSegment(result) {
  if (!result || result.notRun) return null;
  const noReason = result.worktreeResidue.noReasonFile.length;
  const undetermined = result.worktreeResidue.undetermined.length;
  const idleSeatStatus = result.idleSeatResidue.status;
  const idleSeat =
    idleSeatStatus === "OK"
      ? result.idleSeatResidue.orphanCandidates.length
      : "NONE";
  const nodeStatus = result.nodeResidue.status;
  const node = nodeStatus === "OK" ? result.nodeResidue.residue.length : "NONE";
  return (
    `residue_worktree_no_reason=${noReason} ` +
    `residue_worktree_undetermined=${undetermined} ` +
    `residue_idle_seat_status=${idleSeatStatus} residue_idle_seat=${idleSeat} ` +
    `residue_node_status=${nodeStatus} residue_node=${node}`
  );
}

// HYK-481 (coder-task.md §2/§3 항1) -- "미설정"(skipReason 없음)은
// 그대로 null(세그먼트 0, 회귀 0). "ledger만 주고 lock 없음"
// (skipReason 있음)은 새 세그먼트를 한 줄 더한다 -- sweep이 실제로
// 돈 케이스와 같은 `sweep_status=`/`sweep_reason=` 접두를 쓰되 값은
// `NOT_RUN`/명시 사유 코드로 값 자체가 구별되게 한다.
function sweepLogSegment(sweepResult) {
  if (!sweepResult) return null;
  if (sweepResult.notRun) {
    if (!sweepResult.skipReason) return null;
    return `sweep_status=NOT_RUN sweep_reason=${sweepResult.skipReason} sweep_recovered=NONE`;
  }
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
//
// HYK-481 -- 위 `{ran:false}` 두 케이스("아예 미설정" vs "ledger만 주고
// lock 없음") 자체도 지금까지는 값으로 구별이 안 됐다(같은 `{ran:false}`).
// skipReason이 있을 때만 `reasonCode`를 얹는다 -- `ran`은 그대로 `false`로
// 둔다(judgeAdmissionSweepFreshness는 `sweep.ran !== true`면 무조건
// ALIVE 패스스루라 이 추가 필드는 그 판정에 영향 0, §7-A 회귀 0).
function sweepRecordField(sweepResult) {
  if (!sweepResult || sweepResult.notRun) {
    if (sweepResult && sweepResult.skipReason) {
      return { ran: false, reasonCode: sweepResult.skipReason };
    }
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
  blockedTerminationResult,
  unconsumedVanish,
  resourceResidueResult,
  seatEscalation,
  // HYK-493-memory-reopen-1 (coder-task.md §2 product_scope): 결과를
  // buildLogLine까지 옮기고, 아래 finalizeWatchOnceTail 반환 객체에도
  // 그대로 싣는다(seatEscalation과 동일한 "결과를 직접 단언할 수 있게
  // 노출" 원칙).
  memoryReopen,
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
    blockedTerminationResult,
    unconsumedVanish,
    resourceResidueResult,
    seatEscalation,
    memoryReopen,
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
    // HYK-228 coder-r2 rejection-2: `sweep`은 `...detectorResult` 뒤에 와서
    // 그 필드와 충돌해도 이긴다. `recordedAtMs`가 여전히 유일한 신선도
    // 판정 입력이라(watch-freshness-core.mjs 계약 불변) 기존 소비자는 이
    // 형제 필드를 무시해도 무회귀다.
    // HYK-341-vanished-unresolved (coder-task.md §4): `unconsumedVanished
    // Worktrees`도 unconsumedWorstWorktrees(HYK-328)와 같은 이유로
    // last-run.json에 기계가 읽는 정본으로 남긴다 -- watch.log의
    // unconsumedVanishedDetail은 사람이 훑는 요약(상한+N_more)이라
    // 전체 목록은 여기에만 있다.
    record: {
      recordedAtMs: now,
      ...detectorResult,
      sweep: sweepRecordField(sweepResult),
      unconsumedVanishedWorktrees: unconsumedVanish?.vanishedPaths ?? [],
    },
  });
  return finalizeWatchOnceTail({
    repoRoot,
    watchDir,
    now,
    readFn,
    writeFn,
    mkdirFn,
    existsFn,
    notifyDir,
    logPath,
    aliveRecordPath,
    line,
    detectorResult,
    capResult,
    escalationDedupe,
    sweepResult,
    wakeResult,
    blockedTerminationResult,
    resourceResidueResult,
    seatEscalation,
    memoryReopen,
  });
}

// HYK-342/HYK-249 (max-lines-per-function 수리): finalizeWatchOnceCycle의
// 꼬리(reach 알림 + rate-limit-stall 알림 + 반환 객체 조립)를 뽑았다 --
// 순서·값·부작용 모두 원문 그대로, 이름과 위치만 옮겼다.
function finalizeWatchOnceTail({
  repoRoot,
  watchDir,
  now,
  readFn,
  writeFn,
  mkdirFn,
  existsFn,
  notifyDir,
  logPath,
  aliveRecordPath,
  line,
  detectorResult,
  capResult,
  escalationDedupe,
  sweepResult,
  wakeResult,
  blockedTerminationResult,
  resourceResidueResult,
  seatEscalation,
  memoryReopen,
}) {
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
    blockedTerminationResult,
    resourceResidueResult,
    seatEscalation,
    memoryReopen,
  };
}

// HYK-341-vanished-unresolved (max-lines-per-function 수리): escalation
// dedupe와 unconsumed-vanish 추적은 둘 다 "로그 줄을 만들기 *전에*, watchDir
// 상태 파일 하나를 갱신하는" 같은 모양의 단계라 runWatchOnceCore에서
// 한 번에 뽑는다(로직·순서·값 원문 그대로 -- 이름과 위치만 옮겼다,
// HYK-228 4R의 동일 관례 재사용). HYK-341 쪽은 escalationDedupe와 동일
// 지점(로그 줄 조립 전)에서, watchDir만 있으면 항상 돈다 -- notifyDir/wake
// 처럼 별도 opt-in 인자를 요구하지 않는다(watchDir는 이 함수의 필수
// 인자라 모든 실 운용 호출에서 항상 있다, coder-task.md §5 요구6 "opt-in
// 으로 만들지 마라").
function computePreLogDedupeSteps({
  detectorResult,
  watchDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
  seatEscalationExecFn,
  memoryReopenExecFn,
  memoryReopenSampleFn,
  memoryReopenSleepFn,
}) {
  const escalationDedupe = runEscalationDedupeStep({
    scopes: detectorResult.escalationScopes,
    watchDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
  });
  const unconsumedVanish = runUnconsumedVanishStep({
    detectorResult,
    watchDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
  });
  // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①): 이
  // 단계도 escalationDedupe/unconsumedVanish와 동일 지점(로그 줄 조립 전)
  // ·동일 opt-in 없음 원칙("watchDir만 있으면 항상 돈다") -- 다만 실제
  // 전송 여부는 ⑴ 전이가 새로 열렸는가 ⑵ run-id.json이 있는가 두 내부
  // 게이트가 스스로 가린다(이 라운드가 실제로 보낼 일은 없다, live_send_
  // ban). execFn 기본값은 실 orca 경로와 동일하게 createOrcaExecFn()
  // (운영 호출자가 오버라이드하지 않으면)이다 -- 시험은 전부 fake execFn을
  // 주입한다(§2 비타협 "라이브 실행 0").
  const seatEscalation = runSeatEscalationStep({
    identity: detectorResult.seatLivenessIdentity,
    watchDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
    execFn: seatEscalationExecFn ?? createOrcaExecFn(),
  });
  // HYK-493-memory-reopen-1 (coder-task.md §2 product_scope): seatEscalation
  // 과 동일한 "opt-in 아님, watchDir만 있으면 항상 돈다" 원칙 -- 실제
  // 재측/전송 여부는 runMemoryReopenStep 내부 게이트(상태·dry_run·문턱·
  // dedupe)가 스스로 가린다. execFn 기본값은 실 orca 경로와 동일하게
  // createOrcaExecFn()(운영 호출자가 오버라이드하지 않으면)이다 -- 시험은
  // 전부 fake execFn/sampleFn/sleepFn을 주입한다(§2 비타협 "라이브 실행·
  // 라이브 측정 0").
  const memoryReopen = runMemoryReopenStep({
    watchDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
    execFn: memoryReopenExecFn ?? createOrcaExecFn(),
    sampleFn: memoryReopenSampleFn ?? defaultMemoryReopenFreeSampleMb,
    sleepFn: memoryReopenSleepFn ?? defaultMemoryReopenSleep,
  });
  return { escalationDedupe, unconsumedVanish, seatEscalation, memoryReopen };
}

// runWatchOnceCore에서 분리(§6 eslint max-lines-per-function 상한 준수 --
// HYK-464-followup-1 축C가 resourceResidue 단계를 더하며 넘긴 만큼, 이미
// 로그 줄 조립 전 단계인 blockedTermination과 나란히 "관측만 하고 부작용은
// 없는(파괴적 명령 0)" 스캔 두 개를 이 함수 하나로 묶는다 -- 로직·값·순서는
// 원문 그대로, 자리만 옮겼다).
// runWatchOnceCore에서 분리(같은 이유 -- §6 상한 준수): sweep/wake 두
// 단계는 이미 나란히 붙어 있던 "opt-in, 로그 줄 조립 전" 계열이라 하나로
// 묶는다(로직·값·순서 원문 그대로).
function runSweepAndWakeSteps({
  admissionSweep,
  sweepExecFn,
  now,
  wake,
  watchDir,
  readFn,
  writeFn,
  appendFn,
  existsFn,
  mkdirFn,
}) {
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
  return { sweepResult, wakeResult };
}

function runVisibilityScanSteps({
  repoRoot,
  execFn,
  blockedTerminationScan,
  blockedTerminationReaddirFn,
  blockedTerminationReadFileFn,
  resourceResidue,
  // HYK-464-teardown-shadow-1: 넷 다 resourceResidue.teardownShadow가
  // opt-in으로 주어지지 않으면(기존 호출자 전부) runResourceResidueStep
  // 안의 runTeardownShadowStep이 아예 돌지 않으므로(notRun:true) 이 값들은
  // 쓰이지 않는다(회귀 0).
  detectorResult,
  now,
  watchDir,
  notifyDir,
  readFn,
  writeFn,
  existsFn,
  mkdirFn,
}) {
  const blockedTerminationResult = runBlockedTerminationScanStep({
    repoRoot,
    blockedTerminationScan,
    readdirFn: blockedTerminationReaddirFn,
    readFileFn: blockedTerminationReadFileFn,
  });
  const resourceResidueResult = runResourceResidueStep({
    resourceResidue,
    repoRoot,
    execFn,
    detectorResult,
    now,
    watchDir,
    notifyDir,
    readFn,
    writeFn,
    existsFn,
    mkdirFn,
  });
  return { blockedTerminationResult, resourceResidueResult };
}

// runWatchOnceCore에서 분리(같은 이유 -- §6 상한 준수): sweep/wake/
// blockedTermination/resourceResidue 네 opt-in(또는 항상-켜짐) 단계를
// 한 호출로 묶어 runWatchOnceCore 본문 자체의 줄 수를 줄인다(로직·값·
// 순서 원문 그대로, runSweepAndWakeSteps/runVisibilityScanSteps 재사용).
function runOptionalAxisSteps({
  admissionSweep,
  sweepExecFn,
  now,
  wake,
  watchDir,
  readFn,
  writeFn,
  appendFn,
  existsFn,
  mkdirFn,
  repoRoot,
  execFn,
  blockedTerminationScan,
  blockedTerminationReaddirFn,
  blockedTerminationReadFileFn,
  resourceResidue,
  // HYK-464-teardown-shadow-1: runVisibilityScanSteps -> runResourceResidueStep
  // -> runTeardownShadowStep까지만 흘려보낸다(opt-in, 위 주석과 동일 원칙).
  detectorResult,
  notifyDir,
}) {
  const { sweepResult, wakeResult } = runSweepAndWakeSteps({
    admissionSweep,
    sweepExecFn,
    now,
    wake,
    watchDir,
    readFn,
    writeFn,
    appendFn,
    existsFn,
    mkdirFn,
  });
  const { blockedTerminationResult, resourceResidueResult } =
    runVisibilityScanSteps({
      repoRoot,
      execFn,
      blockedTerminationScan,
      blockedTerminationReaddirFn,
      blockedTerminationReadFileFn,
      resourceResidue,
      detectorResult,
      now,
      watchDir,
      notifyDir,
      readFn,
      writeFn,
      existsFn,
      mkdirFn,
    });
  return {
    sweepResult,
    wakeResult,
    blockedTerminationResult,
    resourceResidueResult,
  };
}

// HYK-464-followup-1 축C (§6 eslint max-lines-per-function 상한 준수): 이
// 함수는 이제 단일 `params` 객체를 받는다(예전에는 그 자리에서 전부
// 구조분해했다) -- runOptionalAxisSteps로 그 객체를 그대로 넘길 수 있게
// (필드를 일일이 다시 나열하지 않고) 자리만 옮긴 것뿐, 기본값·순서·값은
// 원문과 완전히 동일하다(호출부 runWatchOnce도 여전히 명명 인자 객체
// 하나를 넘기므로 공개 계약 불변).
function runWatchOnceCore(params) {
  const {
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
    notifyDir,
    capPath,
    capReadFn,
    // HYK-342 2R P1-3: 더 이상 opt-in이 아니다 -- null이면(기존 호출자
    // 전부) resolveBlockedTerminationHarnessDir이 `repoRoot`에서 기본
    // harnessDir(`<repoRoot>/.harness`)을 스스로 파생한다(resolveCapPath와
    // 같은 자리, cap 축 참조). 시험/재정의가 필요할 때만
    // `{harnessDir: <다른 경로>}`를 명시로 준다.
    blockedTerminationScan = null,
    // HYK-464-followup-1 축C: admissionSweep/wake와 동일한 opt-in 계약 --
    // 기본값 null이면(기존 호출자 전부) 이 단계는 아예 실행되지 않는다.
    resourceResidue = null,
    // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①):
    // opt-in 객체가 아니다(escalationDedupe/unconsumedVanish와 동일 --
    // 항상 돈다) -- 기본값 undefined면 computePreLogDedupeSteps가
    // createOrcaExecFn()(실 orca 경로)로 낙하한다. 시험만 fake execFn을
    // 명시로 준다.
    seatEscalationExecFn,
    // HYK-493-memory-reopen-1 (coder-task.md §2 product_scope): seatEscalation
    // ExecFn과 동일한 계약(opt-in 객체 아님, 기본값 undefined면
    // computePreLogDedupeSteps가 각자의 운영 기본값으로 낙하한다).
    memoryReopenExecFn,
    memoryReopenSampleFn,
    memoryReopenSleepFn,
  } = params;
  mkdirFn(watchDir, { recursive: true });
  const detectorResult = runDetector({
    execFn,
    nodePath,
    detectorPath,
    repoRoot,
    watchDir,
  });
  const capResult = computeCapResult({ repoRoot, capPath, capReadFn });
  const { escalationDedupe, unconsumedVanish, seatEscalation, memoryReopen } =
    computePreLogDedupeSteps({
      detectorResult,
      watchDir,
      readFn,
      writeFn,
      existsFn,
      mkdirFn,
      seatEscalationExecFn,
      memoryReopenExecFn,
      memoryReopenSampleFn,
      memoryReopenSleepFn,
    });
  const {
    sweepResult,
    wakeResult,
    blockedTerminationResult,
    resourceResidueResult,
  } = runOptionalAxisSteps({
    ...params,
    blockedTerminationScan,
    resourceResidue,
    // HYK-464-teardown-shadow-1: detectorResult는 params에 없다(이 함수
    // 본문에서 막 계산된 로컬 값) -- 명시로 더한다. notifyDir은 이미
    // params 안에 있으므로(...params가 포함) 그대로 흘러간다.
    detectorResult,
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
    blockedTerminationResult,
    unconsumedVanish,
    resourceResidueResult,
    seatEscalation,
    memoryReopen,
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
  // HYK-342 2R P1-3: null은 "꺼짐"이 아니라 "기본값을 repoRoot에서 스스로
  // 파생"으로 읽힌다 -- runWatchOnceCore/resolveBlockedTerminationHarnessDir
  // 참조. admissionSweep/wake와 달리 이 축은 항상 돈다.
  blockedTerminationScan = null,
  blockedTerminationReaddirFn,
  blockedTerminationReadFileFn,
  // HYK-464-followup-1 축C: admissionSweep/wake와 동일한 opt-in 계약.
  resourceResidue = null,
  // HYK-433-seat-escalation-push-1 (coder-task.md §2 product_scope ①):
  // 시험이 orca escalation send를 fake execFn으로 대체할 때만 쓴다(§2
  // 비타협 "라이브 실행 0") -- 생략하면 runWatchOnceCore가 createOrcaExecFn()
  // 으로 낙하한다(실 orca 경로, admissionSweep/wake의 opt-in null 계약과는
  // 다르다 -- 이 단계는 escalationDedupe/unconsumedVanish와 같이 항상
  // 돈다, 전송 여부는 내부 게이트(전이·run-id.json)가 가린다).
  seatEscalationExecFn,
  // HYK-493-memory-reopen-1 (coder-task.md §2 product_scope): seatEscalation
  // ExecFn과 동일한 계약 -- 시험이 가짜 exec/free 표본/간격 seam을 주입할
  // 때만 쓴다(§2 비타협 "라이브 실행·라이브 측정 0"). 생략하면 각자의
  // 운영 기본값(createOrcaExecFn()/os.freemem()/Atomics.wait)으로
  // 낙하한다 -- 이 축도 escalationDedupe/unconsumedVanish/seatEscalation과
  // 같이 항상 돈다, 실제 재측·전송 여부는 내부 게이트(상태·dry_run·문턱·
  // dedupe)가 가린다.
  memoryReopenExecFn,
  memoryReopenSampleFn,
  memoryReopenSleepFn,
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
    blockedTerminationScan,
    blockedTerminationReaddirFn,
    blockedTerminationReadFileFn,
    resourceResidue,
    seatEscalationExecFn,
    memoryReopenExecFn,
    memoryReopenSampleFn,
    memoryReopenSleepFn,
  });
}

// HYK-464-teardown-shadow-2 (coder-task.md §2 ⓑ⑴ A1, 책임자 판정 1012):
// CLI 인자(`--resource-residue-registry-path`) -> `resourceResidue` 조립을
// 프로덕션 CLI와 시험이 똑같이 부르는 자리로 뽑는다(1R 검토 P1-1: 결선
// 시험이 `resourceResidue.teardownShadow`를 손으로 넣어서, CLI가 그 값을
// 실제로는 한 번도 싣지 않는 결함을 못 잡았다 -- 이 함수를 export해
// 시험이 "CLI 인자 파싱" 그 자체를 직접 구동할 수 있게 한다).
// ★축 C(레지스트리 경로)가 켜진 회차면 teardownShadow를 기본값(빈 객체
// = judgeTeardownShadowForWorktree가 default*Fn을 쓴다)으로 **항상**
// 싣는다 -- 새 CLI 플래그 0(§2 비타협 "새 CLI 플래그 0"), 축 C가 꺼지면
// (레지스트리 경로 생략, 기본값) resourceResidue 자체가 null이라 그림자도
// 0(옵트인 그대로 유지).
export function buildResourceResidueFromArgv(argv) {
  let resourceResidueRegistryPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--resource-residue-registry-path") {
      resourceResidueRegistryPath = argv[++i];
    }
  }
  return resourceResidueRegistryPath
    ? { registryPath: resourceResidueRegistryPath, teardownShadow: {} }
    : null;
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
  // HYK-342/HYK-249 §4 요구7: `--blocked-termination-harness-dir`을 생략
  //하면(기본값) 이 축은 아예 실행되지 않는다(admissionSweep/wake와 동일한
  // opt-in 관례 -- 기존 호출자·기존 시험은 회귀 0).
  let blockedTerminationHarnessDir = null;
  // HYK-464-followup-1 축C: `--resource-residue-registry-path`를 생략
  // 하면(기본값) 이 축은 아예 실행되지 않는다(admissionSweep/wake와 동일
  // opt-in 관례 -- 기존 호출자·기존 시험은 회귀 0). HYK-464-teardown-
  // shadow-2: 실제 파싱은 buildResourceResidueFromArgv(위)로 옮겼다 --
  // 아래 메인 루프는 이 플래그를 더 추적하지 않는다(중복 파싱 금지).
  // HYK-255-outbox-aux-1 (coder-task.md §2 ⓐ·product_scope ⓓ): 보내는함
  // 경로 argv 해석은 runWatchCliPartialCountStep으로 옮겼다(r3, REVIEW-r2
  // P1-1) -- 그 함수가 이 같은 argv 배열을 받아 "--outbox-dir"를 직접
  // 해석하므로, 여기서 중복으로 변수를 만들지 않는다(생략하면 기본값
  // null이고 runPartialCountOnce가 그 수집기를 건너뛰어 기존 동작과
  // 완전히 같다, 회귀 0).
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo-root") repoRoot = argv[++i];
    else if (argv[i] === "--watch-dir") watchDir = argv[++i];
    else if (argv[i] === "--blocked-termination-harness-dir")
      blockedTerminationHarnessDir = argv[++i];
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
  // HYK-481 실사고(2026-08-12~09-16): 이 "의도된" 조합이 예약 작업
  // 등록에서 lock 플래그가 실수로 빠졌을 때도 똑같이 만들어져,
  // `last-run.json`의 `sweep:{ran:false}`가 "아무것도 설정 안 함"과
  // 구별되지 않아 sweep이 한 달 넘게 죽어 있었던 것을 아무도 못 봤다.
  // 의도(이 조합 자체를 계속 여는 것)는 그대로 두고, runSweepStep이
  // 이제 이 조합에 `skipReason`을 실어 로그/last-run.json 양쪽에서
  // "미설정"과 다른 문장으로 남긴다(sweepLogSegment/sweepRecordField
  // 참조).
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
  const blockedTerminationScan = blockedTerminationHarnessDir
    ? { harnessDir: blockedTerminationHarnessDir }
    : null;
  const resourceResidue = buildResourceResidueFromArgv(argv);
  const result = runWatchOnce({
    repoRoot,
    watchDir,
    notifyDir,
    admissionSweep,
    wake,
    now: cliNow,
    blockedTerminationScan,
    resourceResidue,
  });
  if (!noPartialCount) {
    // HYK-255-watch-wire-1 (coder-task.md §1 항2): 실패는 감시 로그 줄로
    // 시끄럽게 남고, 감시 실행 자체(위 result/process.exit)는 이 단계와
    // 무관하게 계속된다 -- runPartialCountStep은 절대 throw하지 않는다.
    // HYK-255-outbox-aux-1-r3 (REVIEW-r2 P1-1): argv 해석 + 호출부 전달을
    // runWatchCliPartialCountStep으로 옮겼다 -- 이 argv 그대로 넘긴다.
    // HYK-439 §2 ⓒ: forwardArgvToPartialCountStep을 거쳐 이 전달 자체를
    // 단위 시험이 붙들 수 있게 한다(위 함수 헤더 참조).
    await forwardArgvToPartialCountStep({
      argv,
      repoRoot,
      watchDir,
      now: cliNow,
      result,
      notifyDir,
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
