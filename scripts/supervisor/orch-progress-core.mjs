// HYK-185 B (coder-task.md §5-B) -- ORCH 무진행(선언 후 정지) 판정 코어.
//
// 배경(coder-task.md §1): ORCH가 "다음에 X를 하겠다"고 적고 턴을 끝내면
// 진행이 0인데 어떤 기계 신호도 나지 않는다. 워커의 무진행은 여러 장치가
// 겨냥하지만(HYK-173·HYK-171) ORCH 자신의 무진행은 어느 장치도 보지
// 않았고, 지금까지 발견은 전부 사람의 눈이었다(HYK-185 이슈 §실사례
// 2026-07-30, coder-task.md §A). 이 파일은 그 판정부다.
//
// 이 코어가 증명하는 것 / 증명하지 않는 것 (S11 필수, 문구 그대로):
// - **증명하지 않는다**: "진행"을 산출물의 존재·시각으로 근사한다. 생각만
//   하고 산출물이 없는 정당한 구간(설계 숙고)은 무진행과 구별되지 않을 수
//   있다(HYK-185 정직 한계 2).
// - **약속을 기록하지 않으면 검사 대상이 아니다** -- 자기 신고 의존이
//   완전히 사라지지 않는다. 줄어드는 것은 "신고했는데 그 뒤 아무 일도
//   없었다" 구간이다(HYK-185 정직 한계 1). `pledges`가 빈 배열이면 이
//   코어는 `PROGRESSING`(사유 `NO_PLEDGES_RECORDED`)을 낸다 -- 이것은
//   "실제로 진행 중"이라는 관측이 아니라 "검사할 약속이 없다"는 뜻이며,
//   그 구분을 감추지 않는다(gap 표에도 등재).
// - **감시자 자신이 멈추면 아무도 감시하지 않는다**(감시자의 감시자
//   문제) -- 이 조각의 범위 밖이다(HYK-185 정직 한계 3).
// - **아직 아무도 이 코어(와 진입점)를 주기적으로 부르지 않는다** -- 부를
//   수 있는 것과 불리고 있는 것은 다르다. 주기 실행 결선은 별도 승인
//   대상이다(coder-task.md §1 범위 조정, §5-D (h)).
// - `orca`를 호출하지 않는다 -- 명령 문자열 조립도 하지 않는다. 화면
//   문자열·컨텍스트 %를 판정 근거로 쓰지 않는다(coder-task.md §2-2, 좌석
//   마커 필터가 같은 방식으로 오탐을 반복한 전례).
//
// 비타협(coder-task.md §2):
// - I/O 0 -- fs·child_process·네트워크·`orca` 호출 0. import가 없다(이
//   파일 자신이 구조적으로 I/O 표면이 없다). 현재 시각도 `now` 인자로만
//   받는다(`Date.now()`/`new Date()` 호출 0).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, verdict, reasonCode, details}`를 반환한다.
// - `verdict`는 항상 `PROGRESSING`/`STALLED`/`WAITING_HUMAN_GATE`/
//   `UNDECIDABLE` 4상태 중 하나다 -- 제3의 값·`null`이 없다(§3-b). 호출
//   자체가 plain object가 아닐 때만 `ok:false`이며 그때도 `verdict`는
//   `UNDECIDABLE`이다(판정 불가를 "괜찮음"으로 접지 않는다, §3-c).
// - 관측이 결손·형식위반이면 그 약속은 `UNDECIDABLE`로 닫히고
//   `PROGRESSING`으로 새지 않는다(§3-c, fail-closed).
//
// 어휘 신규 도입 선언(coder-task.md §2-6, §5-A): 저장소에 "약속 레코드"
// 개념이 기존에 없었다. 아래 4가지를 이 조각이 새로 도입한다:
// 1. `ARTIFACT_KIND`(4종) -- 실제로 진입점이 저장소 파일 시스템 + git만으로
//    모을 수 있는 관측 형태를 그대로 어휘화했다(coder-task.md §7-1 실측
//    표, `.harness/coder.md` §관측 가능 필드 표 참조). 파일 mtime
//    (`FILE_EXISTS_AFTER`) · `.harness/*-task.md`의 `dropped_at` 헤더
//    (`TASK_FILE_DROPPED_AFTER`) · 결과 파일 mtime
//    (`RESULT_FILE_APPEARS_AFTER`) · 원격 ref의 커밋 포함 여부
//    (`REMOTE_REF_CONTAINS_COMMIT`, `git merge-base --is-ancestor`, 로컬
//    git 객체만 -- `git fetch` 없음, 네트워크 0) -- HYK-185 §6 실제 정지
//    4건의 각기 다른 형태에서 역산됐다(아래 STALLED_REASON_BY_KIND 매핑).
// 2. `PLEDGE_RESOLUTION_STATUS`(3종, `OPEN`/`RESOLVED`/`HUMAN_GATE`) --
//    HYK-185 §범위 A "사람 게이트 대기를 표현하려면 그 사유가 명시
//    등록돼야 한다"를 고정 어휘로 옮겼다. `HUMAN_GATE`는 `reason`
//    (비어있지 않은 문자열)이 있어야만 구조적으로 유효하다 -- 사유 없는
//    "대기 중"은 이 어휘에 들어오지 못하고 `OPEN`으로만 표현 가능하므로
//    자동으로 `STALLED` 쪽 경로를 탄다(§3-b 요구 그대로).
// - 기본 임계값(§5-B "기본값을 둘 거면 헤더에 근거를 적어라"): 진입점이
//   `--threshold-s`를 생략하면 `DEFAULT_THRESHOLD_SECONDS`(600초=10분)를
//   쓴다. 근거 = HYK-185 §6에 기록된 실제 정지 4건 중 가장 짧은 것이
//   18분(1,080초)이었다 -- 10분을 기본으로 두면 그 최소 사례도 여유
//   있게 잡히면서(§3-d), 정상 진행 중인 약속(방금 기록한 약속 등)이
//   10분 안에 산출물을 못 내는 흔한 경우까지 정지로 오탐하지 않도록
//   완충을 둔다. 호출자는 언제든 다른 값을 넘겨 이 기본값을 무시할 수
//   있다(하드코딩이 아니라 "생략 시 낙하값").

export const ORCH_PROGRESS_VERDICT = Object.freeze({
  PROGRESSING: "PROGRESSING",
  STALLED: "STALLED",
  WAITING_HUMAN_GATE: "WAITING_HUMAN_GATE",
  UNDECIDABLE: "UNDECIDABLE",
});

export const PLEDGE_RESOLUTION_STATUS = Object.freeze({
  OPEN: "OPEN",
  RESOLVED: "RESOLVED",
  HUMAN_GATE: "HUMAN_GATE",
});

export const ARTIFACT_KIND = Object.freeze({
  FILE_EXISTS_AFTER: "FILE_EXISTS_AFTER",
  TASK_FILE_DROPPED_AFTER: "TASK_FILE_DROPPED_AFTER",
  RESULT_FILE_APPEARS_AFTER: "RESULT_FILE_APPEARS_AFTER",
  REMOTE_REF_CONTAINS_COMMIT: "REMOTE_REF_CONTAINS_COMMIT",
});

const ARTIFACT_KIND_VALUES = Object.freeze(Object.values(ARTIFACT_KIND));
const RESOLUTION_STATUS_VALUES = Object.freeze(
  Object.values(PLEDGE_RESOLUTION_STATUS),
);

export const ORCH_PROGRESS_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  NOW_INVALID: "NOW_INVALID",
  PLEDGES_INVALID: "PLEDGES_INVALID",
  OBSERVATION_INVALID: "OBSERVATION_INVALID",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
  NO_PLEDGES_RECORDED: "NO_PLEDGES_RECORDED",
  PLEDGE_INVALID: "PLEDGE_INVALID",
  PLEDGE_RESOLVED: "PLEDGE_RESOLVED",
  HUMAN_GATE_REGISTERED: "HUMAN_GATE_REGISTERED",
  OBSERVATION_MISSING_FOR_PLEDGE: "OBSERVATION_MISSING_FOR_PLEDGE",
  OBSERVATION_MALFORMED_FOR_PLEDGE: "OBSERVATION_MALFORMED_FOR_PLEDGE",
  ARTIFACT_OBSERVED: "ARTIFACT_OBSERVED",
  WITHIN_THRESHOLD: "WITHIN_THRESHOLD",
  STALLED_ARTIFACT_NEVER_APPEARED: "STALLED_ARTIFACT_NEVER_APPEARED",
  STALLED_RESULT_NOT_CONSUMED: "STALLED_RESULT_NOT_CONSUMED",
  STALLED_RESULT_FILE_MISSING: "STALLED_RESULT_FILE_MISSING",
  STALLED_REMOTE_ARTIFACT_MISSING: "STALLED_REMOTE_ARTIFACT_MISSING",
});

// §6 실제 정지 4건 -> ARTIFACT_KIND 매핑(각기 다른 경로, coder-task.md
// §6 "요구" 그대로). 순서를 바꾸지 마라 -- gap 표·fixture 주석이 이
// 매핑을 그대로 인용한다.
const STALLED_REASON_BY_KIND = Object.freeze({
  [ARTIFACT_KIND.FILE_EXISTS_AFTER]:
    ORCH_PROGRESS_REASON.STALLED_ARTIFACT_NEVER_APPEARED,
  [ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER]:
    ORCH_PROGRESS_REASON.STALLED_RESULT_NOT_CONSUMED,
  [ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER]:
    ORCH_PROGRESS_REASON.STALLED_RESULT_FILE_MISSING,
  [ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT]:
    ORCH_PROGRESS_REASON.STALLED_REMOTE_ARTIFACT_MISSING,
});

export const DEFAULT_THRESHOLD_SECONDS = 600;

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

function isValidExpectedArtifact(ea) {
  if (!isPlainObject(ea)) return false;
  if (!ARTIFACT_KIND_VALUES.includes(ea.kind)) return false;
  if (ea.kind === ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT) {
    return isNonEmptyString(ea.remoteRef) && isNonEmptyString(ea.commitSha);
  }
  return isNonEmptyString(ea.path);
}

function isValidResolution(res) {
  if (!isPlainObject(res)) return false;
  if (!RESOLUTION_STATUS_VALUES.includes(res.status)) return false;
  if (res.status === PLEDGE_RESOLUTION_STATUS.HUMAN_GATE) {
    return isNonEmptyString(res.reason);
  }
  return true;
}

function parseRecordedAtMs(recordedAt, now) {
  if (!isNonEmptyString(recordedAt)) return null;
  const t = Date.parse(recordedAt);
  if (Number.isNaN(t) || t > now) return null;
  return t;
}

// 구조 전제조건(coder-task.md §5-A 최소 필드 그대로) -- 하나라도 어긋나면
// 그 약속은 해석하지 않는다(§3-c fail-closed).
function isWellFormedPledge(pledge, now) {
  if (!isPlainObject(pledge)) return false;
  if (!isNonEmptyString(pledge.pledgeId)) return false;
  if (!isNonEmptyString(pledge.content)) return false;
  if (!isValidExpectedArtifact(pledge.expectedArtifact)) return false;
  if (parseRecordedAtMs(pledge.recordedAt, now) === null) return false;
  return isValidResolution(pledge.resolution);
}

// 관측 항목 구조 검사(kind별 형태) -- §관측 가능 필드 표에 없는 필드는
// 여기 없다.
function isValidObservationEntry(kind, entry) {
  if (!isPlainObject(entry) || entry.collected !== true) return false;
  if (kind === ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT) {
    return isBoolean(entry.contains);
  }
  if (kind === ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER) {
    if (!isBoolean(entry.taskFileExists)) return false;
    return entry.taskFileExists
      ? isFiniteNumber(entry.droppedAtMs)
      : entry.droppedAtMs === null;
  }
  // FILE_EXISTS_AFTER / RESULT_FILE_APPEARS_AFTER
  if (!isBoolean(entry.exists)) return false;
  return entry.exists ? isFiniteNumber(entry.mtimeMs) : entry.mtimeMs === null;
}

function artifactAppeared(kind, entry, recordedAtMs) {
  if (kind === ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT) {
    return entry.contains === true;
  }
  if (kind === ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER) {
    return entry.taskFileExists === true && entry.droppedAtMs >= recordedAtMs;
  }
  return entry.exists === true && entry.mtimeMs >= recordedAtMs;
}

function pledgeResult(pledgeId, verdict, reasonCode) {
  return { pledgeId, verdict, reasonCode };
}

// §HUMAN_GATE 구별(§3-b 비타협) -- 사유 등록된 사람 게이트 대기만
// WAITING_HUMAN_GATE. RESOLVED는 더 볼 것이 없으므로 PROGRESSING.
// 둘 다 아니면(OPEN) null을 돌려줘 호출자가 관측 판정으로 넘어가게 한다.
function judgeResolutionShortcut(pledge) {
  if (pledge.resolution.status === PLEDGE_RESOLUTION_STATUS.RESOLVED) {
    return pledgeResult(
      pledge.pledgeId,
      ORCH_PROGRESS_VERDICT.PROGRESSING,
      ORCH_PROGRESS_REASON.PLEDGE_RESOLVED,
    );
  }
  if (pledge.resolution.status === PLEDGE_RESOLUTION_STATUS.HUMAN_GATE) {
    return pledgeResult(
      pledge.pledgeId,
      ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE,
      ORCH_PROGRESS_REASON.HUMAN_GATE_REGISTERED,
    );
  }
  return null;
}

// §관측 결손 fail-closed(§3-c 비타협) -- 관측이 없거나 형식이 어긋나면
// UNDECIDABLE로 닫는다. 통과한 뒤에만 §기대 산출물 확인으로 넘어간다.
function judgeOpenPledge(pledge, observation, now, thresholdMs) {
  const kind = pledge.expectedArtifact.kind;
  const entry = observation[pledge.pledgeId];
  if (entry === undefined) {
    return pledgeResult(
      pledge.pledgeId,
      ORCH_PROGRESS_VERDICT.UNDECIDABLE,
      ORCH_PROGRESS_REASON.OBSERVATION_MISSING_FOR_PLEDGE,
    );
  }
  if (!isValidObservationEntry(kind, entry)) {
    return pledgeResult(
      pledge.pledgeId,
      ORCH_PROGRESS_VERDICT.UNDECIDABLE,
      ORCH_PROGRESS_REASON.OBSERVATION_MALFORMED_FOR_PLEDGE,
    );
  }
  const recordedAtMs = parseRecordedAtMs(pledge.recordedAt, now);
  // §기대 산출물 확인(비타협) -- appeared === true인 경우에만 진행으로
  // 본다. 산출물이 없으면(appeared===false) §경과 임계 검사로 넘어간다.
  if (artifactAppeared(kind, entry, recordedAtMs)) {
    return pledgeResult(
      pledge.pledgeId,
      ORCH_PROGRESS_VERDICT.PROGRESSING,
      ORCH_PROGRESS_REASON.ARTIFACT_OBSERVED,
    );
  }
  // §경과 임계 검사(비타협) -- 방금 한 약속(elapsed<=threshold)은 아직
  // STALLED로 보지 않는다.
  if (now - recordedAtMs <= thresholdMs) {
    return pledgeResult(
      pledge.pledgeId,
      ORCH_PROGRESS_VERDICT.PROGRESSING,
      ORCH_PROGRESS_REASON.WITHIN_THRESHOLD,
    );
  }
  return pledgeResult(
    pledge.pledgeId,
    ORCH_PROGRESS_VERDICT.STALLED,
    STALLED_REASON_BY_KIND[kind],
  );
}

function judgeSinglePledge(pledge, observation, now, thresholdMs) {
  if (!isWellFormedPledge(pledge, now)) {
    return pledgeResult(
      isPlainObject(pledge) && isNonEmptyString(pledge.pledgeId)
        ? pledge.pledgeId
        : null,
      ORCH_PROGRESS_VERDICT.UNDECIDABLE,
      ORCH_PROGRESS_REASON.PLEDGE_INVALID,
    );
  }
  const shortcut = judgeResolutionShortcut(pledge);
  if (shortcut) return shortcut;
  return judgeOpenPledge(pledge, observation, now, thresholdMs);
}

// 우선순위(가장 나쁜 것 우선): UNDECIDABLE > STALLED > WAITING_HUMAN_GATE
// > PROGRESSING. "판정 불가"가 "괜찮음"에 묻히지 않도록 최우선이다.
const VERDICT_PRIORITY = Object.freeze([
  ORCH_PROGRESS_VERDICT.UNDECIDABLE,
  ORCH_PROGRESS_VERDICT.STALLED,
  ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE,
  ORCH_PROGRESS_VERDICT.PROGRESSING,
]);

function aggregate(perPledge) {
  if (perPledge.length === 0) {
    return {
      verdict: ORCH_PROGRESS_VERDICT.PROGRESSING,
      reasonCode: ORCH_PROGRESS_REASON.NO_PLEDGES_RECORDED,
    };
  }
  for (const verdict of VERDICT_PRIORITY) {
    const hit = perPledge.find((p) => p.verdict === verdict);
    if (hit) return { verdict: hit.verdict, reasonCode: hit.reasonCode };
  }
  // 도달 불가(모든 verdict가 VERDICT_PRIORITY 안에 있으므로) -- fail-closed
  // 방어로만 남긴다.
  return {
    verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
    reasonCode: ORCH_PROGRESS_REASON.PLEDGE_INVALID,
  };
}

function undecidableArgError(reasonCode) {
  return {
    ok: true,
    verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

// judgeOrchProgress({pledges, observation, now, thresholdSeconds?})
//   -> {ok, verdict, reasonCode, details}
//
// - `pledges` = 약속 레코드 배열(§5-A 형식). 스키마 검증은 이 코어가 한다.
// - `observation` = pledgeId를 키로 하는 관측 맵({ [pledgeId]:
//   {collected, ...kind별 필드} }) -- 진입점(orch-stall-detect.mjs)이
//   실제로 모을 수 있는 것만 채운다.
// - `now` = 판정 시각(ms epoch, 인자로만 받는다).
// - `thresholdSeconds` = 생략 시 `DEFAULT_THRESHOLD_SECONDS`(헤더 근거
//   참조).
// - `details.perPledge` = 각 약속의 개별 판정(가장 나쁜 것이 전체
//   `verdict`로 집계된다).
export function judgeOrchProgress(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      verdict: ORCH_PROGRESS_VERDICT.UNDECIDABLE,
      reasonCode: ORCH_PROGRESS_REASON.INVALID_ARGUMENTS,
      details: null,
    };
  }
  const { pledges, observation, now, thresholdSeconds } = args;
  if (!isFiniteNumber(now)) {
    return undecidableArgError(ORCH_PROGRESS_REASON.NOW_INVALID);
  }
  if (!Array.isArray(pledges)) {
    return undecidableArgError(ORCH_PROGRESS_REASON.PLEDGES_INVALID);
  }
  if (!isPlainObject(observation)) {
    return undecidableArgError(ORCH_PROGRESS_REASON.OBSERVATION_INVALID);
  }
  const effectiveThresholdSeconds =
    thresholdSeconds === undefined
      ? DEFAULT_THRESHOLD_SECONDS
      : thresholdSeconds;
  if (!isPositiveFiniteNumber(effectiveThresholdSeconds)) {
    return undecidableArgError(ORCH_PROGRESS_REASON.THRESHOLD_INVALID);
  }
  const thresholdMs = effectiveThresholdSeconds * 1000;

  const perPledge = pledges.map((pledge) =>
    judgeSinglePledge(pledge, observation, now, thresholdMs),
  );
  const { verdict, reasonCode } = aggregate(perPledge);

  return {
    ok: true,
    verdict,
    reasonCode,
    details: {
      perPledge,
      thresholdSeconds: effectiveThresholdSeconds,
      now,
    },
  };
}
