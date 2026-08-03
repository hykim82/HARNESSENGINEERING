// HYK-183 A-4 (coder-task.md §5, §1) -- "태스크 드롭 코어"(지시서 파일
// 드롭 + 덮어쓰기 방어) 판정·실행 코어.
//
// 배경(coder-task.md §1): 무인화 A(실행부 골격)의 네 번째 조각. A-1
// (executor-core.mjs)이 만든 `plan`을 워커가 읽을 "지시서 파일"로 떨어뜨리는
// 손이다. 2026-07-21 실사고(ORCH가 `coder-3` 좌석이 작업 중인데 그 좌석의
// 태스크 파일을 덮어써 진행 중이던 지시가 사라졌다 -- 사람이 눈으로
// 발견했다)가 이 조각의 본체를 "파일을 쓰는 것"이 아니라 "쓰면 안 될 때
// 쓰지 않는 것"으로 정했다(한용 확정 2026-08-03).
//
// 두 기둥(한용 확정 2026-08-03):
// 1. 좌석 방어 -- 대상 좌석이 작업중이 아님을 기계로 확인한다(§5-A, 주입 +
//    막는 쪽 기본값).
// 2. 백업 방어 -- 기존 파일이 있으면 해시 백업 후에만 쓴다(§5-B).
//
// 이 코어가 증명하는 것 / 증명하지 않는 것 (S11 필수, 문구 그대로 -- 헤더
// 주석 4가지):
// - **증명하지 않는다**: 좌석이 실제로 놀고 있었는지 -- 관측은 호출자가
//   준다. 이 코어가 막는 것은 관측이 없거나·낡았거나·바쁨/판정불가일 때
//   쓰는 것까지다. 실제 조회 행위의 결선은 A-5이며 승인 밖이다.
// - **이 코어는 아직 프로덕션 경로 어디에서도 호출되지 않는다** -- 규칙이
//   준비된 것과 그 규칙이 실제로 도는 것은 다르다.
// - **동시 쓰기 경합은 막지 못한다** -- 파일 잠금이 없으므로 두 곳이 같은
//   순간에 같은 경로에 드롭하면 이 방어들은 각자 통과할 수 있다.
// - `orca`를 호출하지 않는다 -- 명령 문자열 조립도 하지 않는다.
//
// 어휘 신규 도입 선언(coder-task.md §2-5, §5-A): 저장소에 "좌석이 바쁜가"를
// 담은 기존 필드가 없다(`terminal-show-adapter.mjs`가 `title`/`preview`를
// 의도적으로 뺀다 -- S8, ORCH 실측). 그래서 아래 `SEAT_OBSERVATION_STATUS`
// (IDLE/BUSY/INDETERMINATE)와 `capture`(최소 `requeryRound`, C-3
// `requery-join-core.mjs`의 채취 정보 관례를 따름 -- 순서 표식이지 시각이
// 아니다)는 이 조각이 새로 도입한 것이다. 벤더 응답 필드가 아니라 호출자가
// 조회할 때마다 스스로 붙이는 기록이다.
//
// 비타협(coder-task.md §2):
// - `orca` 호출 0 -- 명령 문자열 조립도 하지 않는다(이 파일에 child_process
//   import가 없다).
// - throw로 판정을 대신하지 않는다 -- 인자가 무엇이든 예외 없이
//   `{ok, dropped, reasonCode, filePath, backupPath, backupHash}`를
//   반환한다.
// - `ok:false`면 파일 시스템에 흔적 0 -- 모든 구조적·의미적 검사가 전부
//   통과한 뒤에만 파일 시스템에 손을 댄다(백업/쓰기 어느 단계든 실패하면
//   부분 흔적을 남기지 않도록 정리한다).
// - 시간 비교로 회차를 판정하지 않는다 -- `requeryRound`는 순서 표식이며
//   `expectedRequeryRound`와의 일치만 본다(C-3와 같은 축). `dropped_at`의
//   "미래 값 거부"만 시각을 비교한다(그건 회차 판정이 아니라 드롭 시각
//   자체의 형식 요건이다 -- coder-task.md §5-C).
// - 기존 파일을 지우지 않는다 -- 덮어쓰기 전 백업만 한다("복원" 기능 없음).

// 네임스페이스로 import하고 매 호출마다 `fs.xxx(...)`로 참조한다(구조분해
// 금지) -- 시험 파일이 `node:test`의 `mock.method(fs, "readFileSync", ...)`
// 로 백업 검증 실패(§5-B ③)를 재현할 수 있게 하기 위한 의도적 선택이다
// (구조분해 시점에 값을 스냅샷하면 그 mock이 이 파일 내부 호출에 반영되지
// 않는다).
import * as fs from "node:fs";
import { createHash } from "node:crypto";

export const TASK_DROP_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  FILE_PATH_INVALID: "FILE_PATH_INVALID",
  TASK_ID_INVALID: "TASK_ID_INVALID",
  DROPPED_AT_INVALID: "DROPPED_AT_INVALID",
  BODY_INVALID: "BODY_INVALID",
  PLAN_INVALID: "PLAN_INVALID",
  SEAT_OBSERVATION_INVALID: "SEAT_OBSERVATION_INVALID",
  TARGET_PANE_KEY_INVALID: "TARGET_PANE_KEY_INVALID",
  EXPECTED_REQUERY_ROUND_INVALID: "EXPECTED_REQUERY_ROUND_INVALID",
  TASK_ID_ISSUE_MISMATCH: "TASK_ID_ISSUE_MISMATCH",
  DROP_TARGET_SEAT_MISMATCH: "DROP_TARGET_SEAT_MISMATCH",
  SEAT_BUSY: "SEAT_BUSY",
  SEAT_INDETERMINATE: "SEAT_INDETERMINATE",
  REQUERY_ROUND_MISMATCH: "REQUERY_ROUND_MISMATCH",
  COVER_LINE_CONTAMINATION: "COVER_LINE_CONTAMINATION",
  BACKUP_PATH_CONFLICT: "BACKUP_PATH_CONFLICT",
  BACKUP_VERIFY_FAILED: "BACKUP_VERIFY_FAILED",
  WRITE_FAILED: "WRITE_FAILED",
  DROPPED: "DROPPED",
});

// 신규 도입(위 헤더 참조) -- 고정 어휘 3종. 제3의 값·결손은
// SEAT_OBSERVATION_INVALID로 fail-closed(§5-A "판정 불가를 괜찮음으로
// 접지 마라").
export const SEAT_OBSERVATION_STATUS = Object.freeze({
  IDLE: "IDLE",
  BUSY: "BUSY",
  INDETERMINATE: "INDETERMINATE",
});

const SEAT_STATUS_VALUES = Object.freeze(
  Object.values(SEAT_OBSERVATION_STATUS),
);

// scripts/check/relay-handshake.mjs의 TASK_ID_RE(`/^task_id:\s*(\S+)/im`)가
// 요구하는 단일 토큰 형태(공백 없음)를 그대로 맞춘다.
const TASK_ID_TOKEN_RE = /^\S+$/;

// relay-handshake.mjs의 DROPPED_AT_RE + parseKstTimestamp가 받아들이는
// 형식의 부분집합(coder-task.md의 실제 예시 "2026-08-03 14:49 KST"와 동일
// 형태)만 허용한다 -- 더 느슨하게 받아 두 파서가 서로 다른 것을 받아들이는
// 사고를 막는다.
const DROPPED_AT_FORMAT_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) KST$/;

// coder-task.md §3-c -- 본문에 섞이면 완료 감지기(relay-handshake.mjs)를
// 깨뜨리는 5가지 표지 형태 전부(칼럼 0 앵커, §0-B와 동일 어휘).
const COVER_LINE_PATTERNS = Object.freeze([
  /^task_id:/im,
  /^dropped_at:/im,
  /^for:/im,
  /^role:/im,
  /^>>>\s*DONE:/im,
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}
function isPositiveInteger(v) {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function isValidDroppedAt(droppedAt, now) {
  if (!isNonEmptyString(droppedAt)) return false;
  const m = droppedAt.match(DROPPED_AT_FORMAT_RE);
  if (!m) return false;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return t <= now;
}

// plan은 executor-core.mjs의 judgeExecutionPlan(ok:true) 출력을 그대로
// 주입받은 것으로 신뢰한다(재구현 금지, coder-task.md §2-2) -- 이 코어가
// 다시 읽는 것은 오배송 차단(§5-C)에 필요한 `issueId`뿐이다.
function isWellFormedPlan(plan) {
  return (
    isPlainObject(plan) &&
    plan.intent === "RUN_ISSUE_CYCLE" &&
    isNonEmptyString(plan.issueId)
  );
}

function isWellFormedSeatObservation(seatObservation) {
  return (
    isPlainObject(seatObservation) &&
    isNonEmptyString(seatObservation.targetPaneKey) &&
    SEAT_STATUS_VALUES.includes(seatObservation.status) &&
    isPlainObject(seatObservation.capture) &&
    isPositiveInteger(seatObservation.capture.requeryRound)
  );
}

function hasCoverLineContamination(bodyText) {
  return COVER_LINE_PATTERNS.some((re) => re.test(bodyText));
}

// coder-task.md §5-C 오배송 차단 -- taskId가 계획 객체의 이슈를 "가리키는"
// 관례(coder-task.md 자신의 `task_id: HYK-183-a4-task-drop-1`처럼
// `<issueId>-<slug>` 또는 issueId 그 자체)를 따른다.
function taskIdMatchesPlanIssue(taskId, issueId) {
  return taskId === issueId || taskId.startsWith(`${issueId}-`);
}

function findFirstFailure(checks) {
  for (const [failed, reasonCode] of checks) {
    if (failed) return reasonCode;
  }
  return null;
}

// 구조적 전제조건(결손·형식 위반) -- 어떤 필드가 무엇이든 예외 없이 판정할
// 수 있도록 각 검사가 독립적으로 안전하다(requery-join-core.mjs의
// buildStructuralFailureChecks 선례와 같은 형태).
function buildStructuralChecks({
  plan,
  seatObservation,
  targetPaneKey,
  filePath,
  taskId,
  droppedAt,
  bodyText,
  now,
  expectedRequeryRound,
}) {
  return [
    [!isFiniteNumber(now), TASK_DROP_REASON.INVALID_ARGUMENTS],
    [!isNonEmptyString(filePath), TASK_DROP_REASON.FILE_PATH_INVALID],
    [
      !isNonEmptyString(taskId) || !TASK_ID_TOKEN_RE.test(taskId),
      TASK_DROP_REASON.TASK_ID_INVALID,
    ],
    [!isValidDroppedAt(droppedAt, now), TASK_DROP_REASON.DROPPED_AT_INVALID],
    [typeof bodyText !== "string", TASK_DROP_REASON.BODY_INVALID],
    [!isWellFormedPlan(plan), TASK_DROP_REASON.PLAN_INVALID],
    [
      !isWellFormedSeatObservation(seatObservation),
      TASK_DROP_REASON.SEAT_OBSERVATION_INVALID,
    ],
    [
      !isNonEmptyString(targetPaneKey),
      TASK_DROP_REASON.TARGET_PANE_KEY_INVALID,
    ],
    [
      !isPositiveInteger(expectedRequeryRound),
      TASK_DROP_REASON.EXPECTED_REQUERY_ROUND_INVALID,
    ],
  ];
}

// 의미적 판정(대상 좌석 일치·바쁨/판정불가·회차 일치·표지 오염) -- 위
// 구조적 전제조건이 전부 통과한 뒤에만 호출된다(그렇지 않으면 예: plan이
// plain object가 아닐 때 plan.issueId 접근이 위험해진다).
function buildSemanticChecks({
  plan,
  seatObservation,
  targetPaneKey,
  taskId,
  expectedRequeryRound,
  bodyText,
}) {
  return [
    [
      !taskIdMatchesPlanIssue(taskId, plan.issueId),
      TASK_DROP_REASON.TASK_ID_ISSUE_MISMATCH,
    ],
    [
      targetPaneKey !== seatObservation.targetPaneKey,
      TASK_DROP_REASON.DROP_TARGET_SEAT_MISMATCH,
    ],
    [
      seatObservation.status === SEAT_OBSERVATION_STATUS.BUSY,
      TASK_DROP_REASON.SEAT_BUSY,
    ],
    [
      seatObservation.status === SEAT_OBSERVATION_STATUS.INDETERMINATE,
      TASK_DROP_REASON.SEAT_INDETERMINATE,
    ],
    [
      seatObservation.capture.requeryRound !== expectedRequeryRound,
      TASK_DROP_REASON.REQUERY_ROUND_MISMATCH,
    ],
    [
      hasCoverLineContamination(bodyText),
      TASK_DROP_REASON.COVER_LINE_CONTAMINATION,
    ],
  ];
}

function invalidResult(reasonCode) {
  return {
    ok: false,
    dropped: false,
    reasonCode,
    filePath: null,
    backupPath: null,
    backupHash: null,
  };
}

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// 머리는 코어가·본문은 호출자가(coder-task.md §5-C 한용 확정) -- 표지
// 두 줄을 칼럼 0 독립 줄로 쓰고, 빈 줄 뒤에 호출자가 준 본문을 그대로
// 넣는다(본문을 지어내지 않는다).
function buildTaskFileContent({ taskId, droppedAt, bodyText }) {
  return `task_id: ${taskId}\ndropped_at: ${droppedAt}\n\n${bodyText}`;
}

// 기존 파일이 있을 때만 호출된다(coder-task.md §5-B) -- ①원본 해시 계산
// →②백업 작성→③백업을 다시 읽어 해시 대조→④일치할 때에만 호출자에게
// 성공을 알린다. 백업 경로는 원본 내용의 해시로 결정적이다(충돌 = 이미
// 다른 내용의 파일이 그 경로를 점유 -- 거부, coder-task.md §5-B "충돌하면
// 거부"). "복원" 기능은 만들지 않는다 -- 이 함수의 범위는 백업까지다.
function backupExistingFile(filePath) {
  const originalBuf = fs.readFileSync(filePath);
  const hash = sha256Hex(originalBuf);
  const backupPath = `${filePath}.bak-${hash.slice(0, 16)}`;

  if (fs.existsSync(backupPath)) {
    return { ok: false, reasonCode: TASK_DROP_REASON.BACKUP_PATH_CONFLICT };
  }

  fs.writeFileSync(backupPath, originalBuf);
  const verifyBuf = fs.readFileSync(backupPath);
  if (sha256Hex(verifyBuf) !== hash) {
    try {
      fs.unlinkSync(backupPath);
    } catch {
      // best-effort cleanup -- the reported failure is the verify mismatch
      // itself, not this cleanup step.
    }
    return { ok: false, reasonCode: TASK_DROP_REASON.BACKUP_VERIFY_FAILED };
  }
  return { ok: true, backupPath, hash };
}

// 부분 쓰기 금지(coder-task.md §2-9) -- 같은 디렉터리에 결정적 임시 파일을
// 먼저 쓰고 rename으로 교체한다(중간에 죽어도 원래 파일이 훼손되지 않는다).
function writeAtomically(filePath, content) {
  const tmpPath = `${filePath}.tmp-${sha256Hex(
    Buffer.from(content, "utf8"),
  ).slice(0, 16)}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

// dropTaskFile({ plan, seatObservation, targetPaneKey, expectedRequeryRound,
// filePath, taskId, droppedAt, bodyText, now })
//   -> { ok, dropped, reasonCode, filePath, backupPath, backupHash }
//
// - `plan` = executor-core.mjs judgeExecutionPlan(ok:true).plan 그대로.
// - `seatObservation` = { targetPaneKey, status, capture: { requeryRound } }
//   -- 호출자가 조회해 만든 기록(§5-A, 신규 도입). `status`는
//   SEAT_OBSERVATION_STATUS 3종만 허용.
// - `targetPaneKey` = 드롭 대상 좌석의 pane 키(호출자가 이미 확인한 값).
//   `seatObservation.targetPaneKey`와 다르면 거부(다른 좌석이 놀고 있다는
//   사실은 이 좌석의 안전을 증명하지 않는다).
// - `expectedRequeryRound` = 이번 소비 회차 번호(1 이상 정수). 관측의
//   `capture.requeryRound`와 정확히 일치해야 통과(시간 비교 금지).
// - `filePath` = 드롭 대상 파일의 전체 경로(위치·형식은 호출자가 정한다 --
//   이 코어는 짓지 않는다, coder-task.md §2-12 (가)와 무관한 별개 개념).
// - `taskId`/`droppedAt`/`bodyText` = 지시서 파일의 머리(코어가 형식
//   검증)와 본문(호출자 제공, 그대로 삽입 -- 표지 오염 시 거부).
// - `now` = 호출 시각(ms epoch) -- `dropped_at`의 미래 값 거부에만 쓰인다.
export function dropTaskFile(args) {
  if (!isPlainObject(args)) {
    return invalidResult(TASK_DROP_REASON.INVALID_ARGUMENTS);
  }
  const {
    plan,
    seatObservation,
    targetPaneKey,
    filePath,
    taskId,
    droppedAt,
    bodyText,
    now,
    expectedRequeryRound,
  } = args;

  const fields = {
    plan,
    seatObservation,
    targetPaneKey,
    filePath,
    taskId,
    droppedAt,
    bodyText,
    now,
    expectedRequeryRound,
  };

  const structuralReason = findFirstFailure(buildStructuralChecks(fields));
  if (structuralReason !== null) return invalidResult(structuralReason);

  const semanticReason = findFirstFailure(buildSemanticChecks(fields));
  if (semanticReason !== null) return invalidResult(semanticReason);

  const content = buildTaskFileContent({ taskId, droppedAt, bodyText });

  let backupPath = null;
  let backupHash = null;
  try {
    if (fs.existsSync(filePath)) {
      const backupResult = backupExistingFile(filePath);
      if (!backupResult.ok) return invalidResult(backupResult.reasonCode);
      backupPath = backupResult.backupPath;
      backupHash = backupResult.hash;
    }
    writeAtomically(filePath, content);
  } catch {
    return invalidResult(TASK_DROP_REASON.WRITE_FAILED);
  }

  return {
    ok: true,
    dropped: true,
    reasonCode: TASK_DROP_REASON.DROPPED,
    filePath,
    backupPath,
    backupHash,
  };
}
