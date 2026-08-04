// HYK-185 gap#61 (coder-task.md §5-A) -- "유도된 약속"(derived pledge) 순수
// 판정 코어.
//
// 배경(coder-task.md §1): 직전 사이클(orch-progress-core.mjs)이 판정부는
// 만들었지만 "약속을 기록하지 않으면 검사 대상이 아니다"라는 gap #61이
// 남았다 -- ORCH가 약속 레코드를 성실히 적어야만 성립하는 자기 신고
// 의존이다. 이 파일은 그 잔여를 줄인다: **ORCH가 아무것도 적지 않아도
// 저장소에 이미 남은 흔적(드롭된 태스크 파일의 dropped_at 헤더 · 로컬
// 커밋이 원격 ref에 없는 상태)만으로 약속을 유도**한다.
//
// 이 코어가 증명한다 / 증명하지 않는다 (S11 필수, coder-task.md §5-C 항목
// 그대로):
// - **증명한다**: 저장소에 남은 흔적만으로 약속이 유도되므로, ORCH가
//   약속을 적지 않아도 이 계열(TASK_FILE_DROPPED_AFTER 소비 약속 ·
//   REMOTE_REF_CONTAINS_COMMIT 발행 약속)은 검사 대상이 된다.
// - **증명하지 않는다**: 흔적을 전혀 남기지 않는 선언("이제 X를
//   하겠다"만 말하고 아무것도 안 함)은 여전히 유도할 근거가 없다 --
//   HYK-185 §6 실제 정지 4건 중 유도 가능은 **3건(#1 10h48m·#3 83분·
//   #4 18분)**이고(★재작업 1R -- #3은 처음엔 "유도 불가"로 보고했으나
//   ORCH 지적으로 "유도하지 않기로 한 설계 선택이었다"는 정정을 받아
//   아래 `RESULT_FILE_APPEARS_AFTER` 분기로 범위에 편입했다, 경위는
//   `.harness/coder.md` §4건 판정표 참조), 나머지 **1건(#2 8h35m 선언만·
//   산출물 0)만** 이 코어가 여전히 유도하지 못한다(3/4). "전부 덮인다"고
//   말하지 않는다.
// - **유도 규칙 자체가 사람이 유지하는 목록**이다 -- 새로운 형태의
//   약속(예: "PR 리뷰 코멘트에 답한다")이 생기면 이 파일에 그 evidence
//   형태와 파생 규칙이 추가되지 않는 한 이 코어는 보지 못한다.
// - **아직 아무도 이 코어(와 진입점)를 주기적으로 부르지 않는다** --
//   `orca` 호출 0 · 화면 문자열·컨텍스트 % 판정 0(orch-progress-core.mjs
//   §범위 조정과 동일).
//
// HYK-185-residue-rule-2(coder-task.md §R P1-1, §2 — 1R REVIEW 반려 수리) --
// «잔재»(끝난 사이클의 로컬 흔적)를 «진짜 무진행»과 형식으로 가르는 규칙.
// ★1R은 이 판정을 orch-progress-core.mjs(판정층)에 넣어 새 verdict
// (`WAITING_HUMAN_GATE`)를 반환했는데, 이는 그 코어의 구조적 보장
// ("사유 없는 «대기 중»은 표현 자체가 불가능하다", `judgeResolutionShortcut`
// 참조)을 **우회**하는 결함이었다(REVIEW P1-1 반려, ORCH 실측 확인). 2R은
// 그 판정을 **여기(유도층)로 옮겼다** — 판정층은 원래 4상태 설계를 그대로
// 유지한 채 손대지 않는다.
// 이 조각이 증명한다 / 증명하지 않는다:
// - **증명한다**: (ㄱ) `recordedAt`(=결과 파일 mtime)이 72시간(기본,
//   인자로 조정 가능)보다 오래됐거나 (ㄴ) 진입점이 짝 어긋남(태스크
//   파일과 결과 파일이 서로 다른 `task_id`를 echo, `evidence.
//   droppedTaskFiles[].taskIdMismatch`)을 신호하면, 그 소비 약속을
//   **아예 유도하지 않는다** — `pledges`에 추가하지 않고 대신 `notes`에
//   `RESIDUE_SUSPECTED_NOT_DERIVED` 사유로 남긴다. 판정층(orch-progress-
//   core.mjs)은 애초에 이 약속을 보지 못하므로 `STALLED`도
//   `WAITING_HUMAN_GATE`도 반환할 수 없다(0건) — "조용히 사라짐"이
//   아니라 `notes`를 통해 출력에 그대로 드러난다.
// - **증명하지 않는다**: (1) 이것은 **탐지**이지 **자동 정리**가 아니다 --
//   `notes`에 남을 뿐, 결과 파일을 지우거나 옮기지 않는다. (2) **`consume`
//   계열에만 적용**된다 — `await-result`(결과 대기)·`publish`(발행)
//   계열의 잔재·오탐 형태는 이 조각 밖이며 예전 방식 그대로 판정된다. (3)
//   짝 어긋남(ㄴ) 판단은 결과 파일 경로가 `<role>-task.md` -> `<role>.md`
//   명명 관례를 따를 때만 성립한다 — 관례를 벗어난 파일명 쌍은 이 신호를
//   낼 수 없고, 그 경우 나이(ㄱ) 축에만 의존한다. (4) 나이·짝 어긋남
//   둘 다 없는데도 실제로는 잔재인 경우(예: 청소 도구가 실수로 결과
//   파일에 최신 task_id를 덮어써 짝이 우연히 맞아버린 경우)를 이 규칙은
//   볼 수 없다 — "전부 덮인다"고 말하지 않는다.
//
// 비타협(coder-task.md §2, §9):
// - I/O 0 -- fs·child_process·네트워크·`orca` 호출 0. 증거 수집(fs 읽기·
//   git 실행)은 진입점(orch-stall-detect.mjs)의 몫이며 이 파일은 그
//   결과(`evidence`)를 인자로만 받는다. 현재 시각도 `now` 인자로만
//   받는다(`Date.now()`/`new Date()`(인자 없이) 호출 0 -- `new
//   Date(ms)`처럼 이미 받은 ms를 ISO 문자열로 바꾸는 결정적 변환은 시각을
//   "읽는" 것이 아니므로 허용).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, pledges, reasonCode, notes}`를 반환한다.
// - **없는 약속을 지어내지 않는다**: evidence 항목이 결손·형식위반이면
//   그 항목은 약속을 만들지 않고 `notes`에 사유 코드와 함께 남긴다.
//   "증거가 없다"(형식위반 -- `*_ENTRY_MALFORMED`)와 "약속이 없다"(형식은
//   온전하지만 파생 조건 미충족 -- 예: 결과 파일이 아직 없음·이미 원격에
//   포함됨)를 서로 다른 사유 코드로 구별한다 -- 둘을 조용히 같은 값으로
//   접지 않는다.
// - ★재작업 2R(coder-task.md §11 P1, REVIEW 반려 소비): **"정상적으로
//   없음"(evidence가 진짜로 비어있음)과 "확인 못 함"(수집 자체가
//   실패함)을 반드시 구별한다.** 진입점이 `evidence.collectionFailures`
//   (비어있지 않은 배열)로 후자를 신호하면, 이 코어는 **`ok:false`로
//   닫는다**(개별 항목의 evidence를 부분적으로 신뢰하지 않는다 -- 수집
//   기반 자체가 흔들렸으므로 그 위에서 유도한 어떤 약속도 신뢰할 수
//   없다). 진입점은 이를 `UNDECIDABLE`(exit 3)로 표면화한다 -- 이전에는
//   readdirSync/git 실패가 `catch -> []`(빈 배열)로 접혀 "약속 없음"
//   (`PROGRESSING`)과 구별되지 않았다(REVIEW가 독립 재현한 정확히 그
//   결함). "감시 장치가 자기 눈이 멀었을 때 «괜찮다»고 말하면 가장
//   위험하다"는 것이 이 구별의 근거다.
//
// 어휘 신규 도입 선언(coder-task.md §5-A "어휘를 새로 만들면 헤더에
// 선언"): 이 파일이 새로 도입하는 것은 아래 둘뿐이다 -- `ARTIFACT_KIND`·
// `PLEDGE_RESOLUTION_STATUS`는 **orch-progress-core.mjs에서 그대로
// import해 재사용**하며(기존 코어 수정 0), 새로 만들지 않는다.
// 1. `PLEDGE_SOURCE`(`DERIVED`/`DECLARED`) -- 약속이 이 코어가 유도한
//    것인지, ORCH가 선언한 것인지를 결과에 남기기 위한 어휘(§3-e "출처가
//    구별돼야 한다"). 진입점(orch-stall-detect.mjs)이 선언된 약속에
//    `DECLARED`를 붙이고, 이 코어가 유도한 약속에는 `DERIVED`를 붙인다.
//    `orch-progress-core.mjs`의 `judgeOrchProgress`는 이 필드를 읽지
//    않는다(그 코어의 스키마 검사에 없는 여분 필드 -- 무해하게 통과).
// 2. `evidence.collectionFailures`(★재작업 2R 신규 필드, 문자열 배열) --
//    진입점이 "이 계열(`droppedTaskFiles`/`localVsRemote`)의 수집
//    자체가 실패했다"를 신호하는 채널. 생략 가능(생략 = 실패 없음, 기존
//    호출자와 호환). 배열이 아니면 형식위반으로 `ok:false`(아래
//    `COLLECTION_FAILURES_INVALID`), 배열인데 비어있지 않으면 수집
//    실패로 `ok:false`(아래 `COLLECTION_FAILED`) -- 두 경우 모두 개별
//    항목 처리로 내려가지 않고 즉시 닫는다.
//
// evidence 형태(coder-task.md §7-1 실측 표 그대로 -- 이 표에 없는 필드는
// 여기 없다):
// - `evidence.droppedTaskFiles` = 배열, 각 원소:
//   `{ path, taskId, droppedAtMs, resultFile: { path, exists, mtimeMs } }`
//   (`.harness/*-task.md`의 `dropped_at`·`task_id` 헤더 + 대응 결과
//   파일의 경로·존재/mtime, 진입점이 fs로 수집). 결과 파일이 **아직
//   없으면**(`resultFile.exists !== true`) ★재작업 1R부터 "결과 도착을
//   기다리는" 약속(`RESULT_FILE_APPEARS_AFTER`)을 유도한다 -- 아래
//   `deriveAwaitResultPledge` 참조.
// - `evidence.localVsRemote` = 배열, 각 원소:
//   `{ commitSha, commitTimeMs, remoteRef, contains }`
//   (`contains`는 `git merge-base --is-ancestor`의 결과: true/false/
//   수집 실패 시 null -- 진입점이 git으로 수집).
// - `evidence.droppedTaskFiles[].taskIdMismatch`(선택, boolean,
//   HYK-185-residue-rule-2 신규) -- 진입점이 계산해 넣는다(§2-2-ㄴ). 결손
//   시 `false`(신호 없음)로 취급 -- 형식위반이 아니다.
// - `evidence.collectionFailures` = 문자열 배열(생략 가능, ★재작업 2R) --
//   위 두 계열 중 수집 자체가 실패한 계열의 이름("droppedTaskFiles"/
//   "localVsRemote"). 비어있지 않으면 이 함수는 그 즉시 `ok:false`를
//   반환한다(아래 참조).

import {
  ARTIFACT_KIND,
  PLEDGE_RESOLUTION_STATUS,
} from "./orch-progress-core.mjs";

export const PLEDGE_SOURCE = Object.freeze({
  DERIVED: "DERIVED",
  DECLARED: "DECLARED",
});

export const PLEDGE_DERIVE_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  NOW_INVALID: "NOW_INVALID",
  EVIDENCE_INVALID: "EVIDENCE_INVALID",
  // ★재작업 2R(§11 P1) -- "확인 못 함"을 "약속 없음"과 다른 값으로 낸다.
  COLLECTION_FAILURES_INVALID: "COLLECTION_FAILURES_INVALID",
  COLLECTION_FAILED: "COLLECTION_FAILED",
  // HYK-185-residue-rule-2 -- 기존 thresholdSeconds 규약과 동일(§2-3
  // "임계는 인자로 받는다").
  RESIDUE_THRESHOLD_INVALID: "RESIDUE_THRESHOLD_INVALID",
  DERIVED: "DERIVED",
});

// HYK-185-residue-rule-2(coder-task.md §2-3 "임계는 인자로 받는다 · 기본값
// 72시간") -- 근거: HYK-185 §6 실제 정지 4건 중 최장(10시간 48분)조차 이
// 임계의 약 15%다(§3-b가 이를 명시적 반례로 요구한다). 72시간을 고른
// 것은 "진짜 무진행"과 "청소되지 않은 옛 사이클 잔재"를 가르는 여유를
// 크게 두기 위함이다 -- 사람이 하루이틀 자리를 비워도 즉시 오분류하지
// 않게.
export const DEFAULT_RESIDUE_THRESHOLD_SECONDS = 72 * 3600;

// notes[].reasonCode -- "증거 없음"(ENTRY_MALFORMED류)과 "약속 없음"(그
// 밖)을 서로 다른 코드로 구별한다(§3-c, §5-A 비타협).
// ★재작업 1R: `TASK_FILE_RESULT_NOT_YET_PRODUCED`는 폐기했다 -- 결과
// 미도착은 더 이상 "약속 없음"이 아니라 `deriveAwaitResultPledge`가
// 실제 약속을 유도하는 경로이므로 이 사유 코드를 낼 지점이 없다.
export const PLEDGE_DERIVE_NOTE_REASON = Object.freeze({
  DROPPED_TASK_FILES_CATEGORY_MALFORMED:
    "DROPPED_TASK_FILES_CATEGORY_MALFORMED",
  LOCAL_VS_REMOTE_CATEGORY_MALFORMED: "LOCAL_VS_REMOTE_CATEGORY_MALFORMED",
  TASK_FILE_ENTRY_MALFORMED: "TASK_FILE_ENTRY_MALFORMED",
  TASK_FILE_RECORDED_AT_IN_FUTURE: "TASK_FILE_RECORDED_AT_IN_FUTURE",
  COMMIT_ENTRY_MALFORMED: "COMMIT_ENTRY_MALFORMED",
  COMMIT_ALREADY_CONTAINED_NO_DERIVATION_NEEDED:
    "COMMIT_ALREADY_CONTAINED_NO_DERIVATION_NEEDED",
  COMMIT_CONTAINMENT_UNRESOLVED: "COMMIT_CONTAINMENT_UNRESOLVED",
  COMMIT_RECORDED_AT_IN_FUTURE: "COMMIT_RECORDED_AT_IN_FUTURE",
  // HYK-185-residue-rule-2(coder-task.md §R P1-1) -- 잔재 의심(나이 초과
  // 또는 짝 어긋남)이면 소비 약속을 유도하지 않고 이 사유로 남긴다.
  // "약속이 없다" 계열(다른 이유로 유도 조건 미충족)과 같은 성격이지만,
  // 사람이 왜 이 약속이 없는지 바로 알 수 있도록 전용 코드를 쓴다.
  RESIDUE_SUSPECTED_NOT_DERIVED: "RESIDUE_SUSPECTED_NOT_DERIVED",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isBoolean(v) {
  return typeof v === "boolean";
}
function isPositiveFiniteNumber(v) {
  return isFiniteNumber(v) && v > 0;
}

function note(reasonCode, ref) {
  return { reasonCode, ref };
}

function isValidDroppedTaskFileEntry(item) {
  if (!isPlainObject(item)) return false;
  if (!isNonEmptyString(item.path)) return false;
  if (!isNonEmptyString(item.taskId)) return false;
  if (!isFiniteNumber(item.droppedAtMs)) return false;
  const rf = item.resultFile;
  if (!isPlainObject(rf)) return false;
  if (!isNonEmptyString(rf.path)) return false;
  if (!isBoolean(rf.exists)) return false;
  return rf.exists ? isFiniteNumber(rf.mtimeMs) : rf.mtimeMs === null;
}

// HYK-185-residue-rule-2(coder-task.md §2-2, §R P1-1) -- 둘 중 하나라도
// 참이면 잔재 의심: ㄱ. 나이(경과 시간이 임계 초과, 엄격 `>`) ㄴ. 짝
// 어긋남(`item.taskIdMismatch === true`, 진입점이 채운 선택 필드 --
// 결손·비true 값은 안전하게 "신호 없음"으로 취급).
function isResidueSuspected(item, now, recordedAtMs, residueThresholdMs) {
  const isAged = now - recordedAtMs > residueThresholdMs;
  const isPairMismatch = item.taskIdMismatch === true;
  return isAged || isPairMismatch;
}

// 결과가 이미 나온 태스크 파일 -> "소비"(다음 태스크 드롭) 약속 유도.
// ★2R(coder-task.md §R P1-1) -- 잔재 의심이면 이 지점에서 유도를
// 멈춘다(판정층에 새 verdict를 만들지 않는다 -- `notes`로만 보인다).
function deriveConsumePledge(item, now, pledges, notes, residueThresholdMs) {
  const recordedAtMs = item.resultFile.mtimeMs;
  if (recordedAtMs > now) {
    notes.push(
      note(PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_RECORDED_AT_IN_FUTURE, item),
    );
    return;
  }
  if (isResidueSuspected(item, now, recordedAtMs, residueThresholdMs)) {
    notes.push(
      note(PLEDGE_DERIVE_NOTE_REASON.RESIDUE_SUSPECTED_NOT_DERIVED, item),
    );
    return;
  }
  pledges.push({
    pledgeId: `derived:consume:${item.taskId}`,
    content: `유도됨: ${item.path}의 결과가 나왔다 -- 다음 태스크 드롭(소비)을 약속한다.`,
    expectedArtifact: {
      kind: ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
      path: item.path,
    },
    recordedAt: new Date(recordedAtMs).toISOString(),
    resolution: { status: PLEDGE_RESOLUTION_STATUS.OPEN },
    source: PLEDGE_SOURCE.DERIVED,
  });
}

// ★재작업 1R(coder-task.md §10) -- 결과가 아직 안 나온 태스크 파일도
// "지어내기"가 아니라 **이미 실재하는 흔적**(태스크가 떨어졌다는 사실
// 자체)에서 "결과 도착을 기다린다"는 약속을 유도한다. 기존 코어에 이미
// 있는 `ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER`(직전 사이클 B가 83분
// 건 fixture에 쓴 바로 그 종류) 어휘를 그대로 쓴다 -- 새 어휘 도입 아님.
// `recordedAt`은 `droppedAtMs`를 쓴다(결과 파일이 없어 mtime을 쓸 수
// 없다 -- 드롭 시각이 약속 시각이다). `deriveConsumePledge`와 서로
// 배타적(둘 다 같은 `item`에서 동시에 나오지 않는다, §검증에서 시험으로
// 고정).
function deriveAwaitResultPledge(item, now, pledges, notes) {
  const recordedAtMs = item.droppedAtMs;
  if (recordedAtMs > now) {
    notes.push(
      note(PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_RECORDED_AT_IN_FUTURE, item),
    );
    return;
  }
  pledges.push({
    pledgeId: `derived:await-result:${item.taskId}`,
    content: `유도됨: ${item.path}가 드롭됐다 -- 결과 파일(${item.resultFile.path})이 아직 없다 -- 결과 도착을 기다리는 약속(대기).`,
    expectedArtifact: {
      kind: ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER,
      path: item.resultFile.path,
    },
    recordedAt: new Date(recordedAtMs).toISOString(),
    resolution: { status: PLEDGE_RESOLUTION_STATUS.OPEN },
    source: PLEDGE_SOURCE.DERIVED,
  });
}

// 드롭된 태스크 파일 흔적 하나 -> 두 갈래 중 정확히 하나로 유도(배타적).
// 결과가 이미 나왔으면 소비 약속, 아직이면 대기 약속 -- 어느 쪽이든
// "없는 약속을 지어내는" 것이 아니라 evidence에 이미 있는 사실(드롭
// 시각·결과 파일 상태)에서 파생된다.
function deriveFromDroppedTaskFile(
  item,
  now,
  pledges,
  notes,
  residueThresholdMs,
) {
  if (!isValidDroppedTaskFileEntry(item)) {
    notes.push(note(PLEDGE_DERIVE_NOTE_REASON.TASK_FILE_ENTRY_MALFORMED, item));
    return;
  }
  if (item.resultFile.exists === true) {
    deriveConsumePledge(item, now, pledges, notes, residueThresholdMs);
    return;
  }
  deriveAwaitResultPledge(item, now, pledges, notes);
}

function isValidLocalVsRemoteEntry(item) {
  if (!isPlainObject(item)) return false;
  if (!isNonEmptyString(item.commitSha)) return false;
  if (!isNonEmptyString(item.remoteRef)) return false;
  if (!isFiniteNumber(item.commitTimeMs)) return false;
  return isBoolean(item.contains) || item.contains === null;
}

// 로컬 커밋 vs 원격 ref 흔적 하나 -> 발행 약속 유도 시도. 이미 원격에
// 포함돼 있으면(=이미 발행됨) 유도가 필요 없고, 포함 여부를 수집하지
// 못했으면(collected 실패, null) fail-closed로 유도하지 않는다.
function deriveFromLocalVsRemote(item, now, pledges, notes) {
  if (!isValidLocalVsRemoteEntry(item)) {
    notes.push(note(PLEDGE_DERIVE_NOTE_REASON.COMMIT_ENTRY_MALFORMED, item));
    return;
  }
  if (item.contains === null) {
    notes.push(
      note(PLEDGE_DERIVE_NOTE_REASON.COMMIT_CONTAINMENT_UNRESOLVED, item),
    );
    return;
  }
  if (item.contains === true) {
    notes.push(
      note(
        PLEDGE_DERIVE_NOTE_REASON.COMMIT_ALREADY_CONTAINED_NO_DERIVATION_NEEDED,
        item,
      ),
    );
    return;
  }
  const recordedAtMs = item.commitTimeMs;
  if (recordedAtMs > now) {
    notes.push(
      note(PLEDGE_DERIVE_NOTE_REASON.COMMIT_RECORDED_AT_IN_FUTURE, item),
    );
    return;
  }
  pledges.push({
    pledgeId: `derived:publish:${item.commitSha}`,
    content: `유도됨: 로컬 커밋(${item.commitSha.slice(0, 12)})이 ${item.remoteRef}에 아직 없다 -- 발행(push)을 약속한다.`,
    expectedArtifact: {
      kind: ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT,
      remoteRef: item.remoteRef,
      commitSha: item.commitSha,
    },
    recordedAt: new Date(recordedAtMs).toISOString(),
    resolution: { status: PLEDGE_RESOLUTION_STATUS.OPEN },
    source: PLEDGE_SOURCE.DERIVED,
  });
}

function invalidArgs(reasonCode) {
  return { ok: false, pledges: [], reasonCode, notes: [] };
}

// ★재작업 2R(§11 P1) -- "확인 못 함"을 개별 항목 처리보다 먼저 걸러낸다.
// 수집 기반 자체가 흔들렸으면 그 위에서 만든 어떤 약속도 신뢰할 수
// 없으므로, 부분적으로 계속 진행하지 않고 즉시 닫는다(fail-closed
// 전체). `null` = 실패 없음(계속 진행), 아니면 그 자체가 최종 반환값.
function checkCollectionFailures(evidence) {
  if (evidence.collectionFailures === undefined) return null;
  if (!Array.isArray(evidence.collectionFailures)) {
    return invalidArgs(PLEDGE_DERIVE_REASON.COLLECTION_FAILURES_INVALID);
  }
  if (evidence.collectionFailures.length > 0) {
    return invalidArgs(PLEDGE_DERIVE_REASON.COLLECTION_FAILED);
  }
  return null;
}

// HYK-185-residue-rule-3(coder-task.md §R3, 저장소 정본 품질 게이트
// `quality-check`(eslint `complexity`, 최대 12) 수리 -- 순수 리팩터링,
// 동작 변화 0) -- `derivePledges`가 `evidence.droppedTaskFiles`/
// `evidence.localVsRemote` 두 계열에 대해 완전히 같은 모양의 분기(카테고리
// 결손은 정상 · 배열이 아니면 형식위반 노트 · 배열이면 각 항목을 개별
// 파생 함수로 처리)를 반복하던 것을 이 헬퍼로 뽑아낸다 -- `orch-progress-
// core.mjs`의 `judgeResolutionShortcut`·`relay-handshake.mjs`의
// `resolveResultTaskId`가 같은 이유(복잡도 상한)로 분리된 이 저장소의
// 선례를 그대로 따른다. `deriveItem`은 `now`/`pledges`/`notes`(그리고
// 필요하면 `residueThresholdMs`)를 이미 캡처한 클로저이므로, 이 헬퍼는
// 항목 하나가 무엇을 의미하는지 몰라도 된다(카테고리 형태 판단과 개별
// 파생을 분리).
function deriveCategory(categoryItems, malformedReasonCode, notes, deriveItem) {
  if (categoryItems === undefined) {
    // 카테고리 자체가 없음 -- 정당한 빈 상태, 형식위반 아님.
    return;
  }
  if (!Array.isArray(categoryItems)) {
    notes.push(note(malformedReasonCode, categoryItems));
    return;
  }
  for (const item of categoryItems) {
    deriveItem(item);
  }
}

// HYK-185-residue-rule-3 -- `residueThresholdSeconds` 하나를 검증+정규화
// 하는 결정 단위를 `derivePledges` 밖으로 뽑는다(위와 같은 이유, 같은
// 선례). 순수 함수 -- 인자만 쓰고 I/O 0, 추출 전과 완전히 같은 값을
// 같은 조건에서 반환한다(동작 변화 없음).
function resolveResidueThresholdMs(residueThresholdSeconds) {
  const effectiveResidueThresholdSeconds =
    residueThresholdSeconds === undefined
      ? DEFAULT_RESIDUE_THRESHOLD_SECONDS
      : residueThresholdSeconds;
  if (!isPositiveFiniteNumber(effectiveResidueThresholdSeconds)) {
    return { ok: false };
  }
  return { ok: true, ms: effectiveResidueThresholdSeconds * 1000 };
}

// derivePledges({evidence, now, residueThresholdSeconds?})
//   -> {ok, pledges, reasonCode, notes}
//
// - `evidence.droppedTaskFiles`/`evidence.localVsRemote` 둘 다 생략 가능
//   (그 흔적 계열이 저장소에 아예 없는 정당한 상태 -- 결손이 아니다).
//   있는데 배열이 아니면 그 카테고리 전체를 형식위반으로 `notes`에 남기고
//   빈 것으로 취급한다(다른 카테고리는 계속 처리 -- 한 카테고리의 형식
//   위반이 다른 카테고리까지 막지 않는다).
// - `now` = 판정 시각(ms epoch, 인자로만 받는다).
// - `residueThresholdSeconds`(HYK-185-residue-rule-2 신규) = 생략 시
//   `DEFAULT_RESIDUE_THRESHOLD_SECONDS`. `consume` 계열에만 적용되는
//   "잔재 의심" 나이 임계다(§2-3 "임계는 인자로 받는다").
export function derivePledges(args) {
  if (!isPlainObject(args))
    return invalidArgs(PLEDGE_DERIVE_REASON.INVALID_ARGUMENTS);
  const { evidence, now, residueThresholdSeconds } = args;
  if (!isFiniteNumber(now))
    return invalidArgs(PLEDGE_DERIVE_REASON.NOW_INVALID);
  if (!isPlainObject(evidence))
    return invalidArgs(PLEDGE_DERIVE_REASON.EVIDENCE_INVALID);
  const residueThreshold = resolveResidueThresholdMs(residueThresholdSeconds);
  if (!residueThreshold.ok) {
    return invalidArgs(PLEDGE_DERIVE_REASON.RESIDUE_THRESHOLD_INVALID);
  }
  const residueThresholdMs = residueThreshold.ms;

  const collectionFailure = checkCollectionFailures(evidence);
  if (collectionFailure) return collectionFailure;

  const pledges = [];
  const notes = [];

  deriveCategory(
    evidence.droppedTaskFiles,
    PLEDGE_DERIVE_NOTE_REASON.DROPPED_TASK_FILES_CATEGORY_MALFORMED,
    notes,
    (item) =>
      deriveFromDroppedTaskFile(item, now, pledges, notes, residueThresholdMs),
  );

  deriveCategory(
    evidence.localVsRemote,
    PLEDGE_DERIVE_NOTE_REASON.LOCAL_VS_REMOTE_CATEGORY_MALFORMED,
    notes,
    (item) => deriveFromLocalVsRemote(item, now, pledges, notes),
  );

  return { ok: true, pledges, reasonCode: PLEDGE_DERIVE_REASON.DERIVED, notes };
}
