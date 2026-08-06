// HYK-185-unconsumed-3 (coder-task.md §R3-1(B)) -- «task 파일 헤더가 그
// 파일 자신의 실제 fs mtime보다 미래를 주장한다» 순수 판정 코어.
//
// ★이 이름공간은 소비("consumed"/"unconsumed") 판정과 의도적으로 완전히
// 분리돼 있다(한용 명시, coder-task.md §R3-1(B) 비타협 -- "이름부터
// 분리하라... 소비/unconsumed 어휘를 쓰지 마라"). 이 코어는 소비 판정
// 함수(unconsumed-core.mjs의 judgeUnconsumed, orch-stall-detect.mjs의
// buildUnconsumedSignals/judgeUnconsumedForRepo)에서 **호출되지 않는다**
// -- 어떤 경로로도 소비 여부 판정에 기여하지 않는다. 이 파일 자신도 그
// 모듈들을 import하지 않는다(순환·결합 자체가 없다).
//
// 배경(coder-task.md §R3-0): 2R에서 도입한 헤더/실물 대조(현재는 삭제된
// `taskFileHeaderMatchesMtime`)는 «60초 대칭 창»을 썼는데, 실물 저장소
// 4개에서 실측한 헤더-실물 편차가 +68·+118·+103초로 그 창을 넘어 **판정
// 도달 0건**을 냈다(REVIEW 3R 반려 P1-3). 원인은 방향을 잘못 골랐다 --
// 정상 운용에서 편차는 항상 "mtime이 헤더보다 늦다"(양의 방향)이고 그
// 크기에는 상한이 없다(처리 지연). 이상 신호는 **그 반대 방향**(mtime이
// 헤더보다 이르다, 즉 헤더가 아직 오지 않은 미래를 주장한다)에서만
// 뜻이 있다.
//
// ★이 신호가 뜻하는 것: 헤더가 반드시 "위조"라는 뜻은 아니다. ORCH의
// «시각 투영»(실제 시계를 읽지 않고 미래 시각을 헤더에 적는 실수)이
// 실제로 여러 번 있었던 기지 결함이다. 그래서 이 코어의 어휘는 중립적
// 이다("헤더와 실물이 어긋났다") -- "위조 확정"으로 단정하지 않는다.
//
// 비교 눈금의 유도(임의 허용 폭이 아니다, coder-task.md §R3-1(B) 요구
// 그대로 여기 근거를 남긴다): 헤더는 분(minute) 단위까지만 적힌다
// (`DROPPED_AT_RE`가 초를 파싱하지 않고 `:00`으로 고정한다 -- 즉 헤더가
// 담는 값은 "진짜 결정 순간을 그 분의 시작으로 floor한 값"이다). 정상
// 운용에서는 그 floor된 순간과 실제 파일 mtime 사이에 처리 지연만 있고
// (지연의 상한은 없다 -- 그래서 위쪽은 열어 둔다), floor 자체가 초 정보를
// 버렸을 뿐이므로 실제 mtime은 그 floor 값보다 항상 "크거나 같다". 그러므로
// 이상 신호의 판정식은 정확히 `taskFileMtimeMs < headerFloorMs`이며, 이
// 부등식은 헤더의 형식(분 단위, 초 버림) 자체에서 직접 유도된다 -- 새로
// 고른 허용 폭 상수가 아니다(그런 상수는 이 코어에 없다).
//
// 이 코어가 증명한다 / 증명하지 않는다:
// - **관측은 호출자가 준다** -- 이 코어는 파일도 git도 읽지 않는다.
// - **판정할 수 없으면 조용히 "정상"으로 접지 않는다** -- 입력이
//   구조적으로 이상하면(형식 위반) 항상 `UNDECIDABLE`이다.
// - I/O 0 -- import 없음(이 파일 자신이 구조적으로 I/O 표면이 없다).
//   `Date.now()`/`new Date()`(인자 없이) 호출 0.
// - throw로 판정을 대신하지 않는다 -- 예외 없이 항상
//   `{ok, verdict, reasonCode, details}`를 반환한다.

export const HEADER_TIME_PROJECTION_VERDICT = Object.freeze({
  NORMAL: "NORMAL",
  PROJECTED_FUTURE: "PROJECTED_FUTURE",
  UNDECIDABLE: "UNDECIDABLE",
});

export const HEADER_TIME_PROJECTION_REASON = Object.freeze({
  ARGS_INVALID: "ARGS_INVALID",
  HEADER_FLOOR_MS_INVALID: "HEADER_FLOOR_MS_INVALID",
  TASK_FILE_MTIME_MS_INVALID: "TASK_FILE_MTIME_MS_INVALID",
  MTIME_AT_OR_AFTER_HEADER: "MTIME_AT_OR_AFTER_HEADER",
  MTIME_BEFORE_HEADER: "MTIME_BEFORE_HEADER",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function undecidable(reasonCode) {
  return {
    ok: true,
    verdict: HEADER_TIME_PROJECTION_VERDICT.UNDECIDABLE,
    reasonCode,
    details: null,
  };
}

// judgeHeaderTimeProjection({headerFloorMs, taskFileMtimeMs}) ->
// {ok, verdict, reasonCode, details}
//
// - `headerFloorMs` = task 파일 `dropped_at` 헤더가 담는 시각(epoch ms,
//   이미 분 단위로 floor된 값 -- 호출자가 파싱해 넘긴다).
// - `taskFileMtimeMs` = 그 task 파일 자신의 실제 fs mtime(epoch ms).
export function judgeHeaderTimeProjection(args) {
  if (!isPlainObject(args)) {
    return undecidable(HEADER_TIME_PROJECTION_REASON.ARGS_INVALID);
  }
  const { headerFloorMs, taskFileMtimeMs } = args;
  if (!isFiniteNumber(headerFloorMs)) {
    return undecidable(HEADER_TIME_PROJECTION_REASON.HEADER_FLOOR_MS_INVALID);
  }
  if (!isFiniteNumber(taskFileMtimeMs)) {
    return undecidable(
      HEADER_TIME_PROJECTION_REASON.TASK_FILE_MTIME_MS_INVALID,
    );
  }
  if (taskFileMtimeMs < headerFloorMs) {
    return {
      ok: true,
      verdict: HEADER_TIME_PROJECTION_VERDICT.PROJECTED_FUTURE,
      reasonCode: HEADER_TIME_PROJECTION_REASON.MTIME_BEFORE_HEADER,
      details: { headerFloorMs, taskFileMtimeMs },
    };
  }
  return {
    ok: true,
    verdict: HEADER_TIME_PROJECTION_VERDICT.NORMAL,
    reasonCode: HEADER_TIME_PROJECTION_REASON.MTIME_AT_OR_AFTER_HEADER,
    details: { headerFloorMs, taskFileMtimeMs },
  };
}
