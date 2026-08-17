// HYK-292 I3 (coder-task.md §3-1 요건 5) -- "각 규칙 ID에 마지막
// 실행명령·exit·영수증 시각이 없으면 자동으로 «문서 약속» 또는
// «미검증»으로 낮춰야 한다"(PM 원문)를 판정하는 순수 코어. I/O 0 --
// enforcement-inventory.json 항목과 그 항목의 실행 증거는 호출부가
// 읽어서 넘긴다.
//
// 등급 3종(모두 "기계 강제"라고 스스로 주장하지 못하게 막는 닫힌 집합):
//   기계 강제   -- 증거(evidence)에 command·exit·at이 모두 있고 exit===0
//   문서 약속   -- 항목에 script/test는 있지만 증거가 없거나 exit!==0
//   미검증      -- 항목 자체가 이 스캔에서 뭘 판단할 근거조차 없음
//                  (script/test 필드가 없거나 항목이 아예 안 넘어옴)
//
// ⚠️정직 한계: 이 코어는 enforcement-inventory.json 스키마에 실행-증거
// 필드(예: last_verified_command/exit/at)를 아직 추가하지 않은 상태에서
// 만들어졌다 -- 오늘은 어떤 항목에도 evidenceByCheckId가 채워지지 않으므로
// 전수 «문서 약속» 또는 «미검증»으로 나온다(그것이 fail-closed 의도다:
// 증거 배선이 생기기 전까지 «기계 강제»를 참칭하지 않는다). 이 모듈을
// 실제 생성 파이프라인(예: generate-gaps-master-table.mjs 같은 별도
// 스크립트)에 연결하는 일은 이번 라운드 범위 밖이다(§3-0).
//
// ★★미결선 발판(2R 표기 하나, review-r1.md 축0 지적 -- 저장소 다른
// 코드에서 이 모듈을 참조하는 곳이 시험 외에 0건이다): 이 코어는
// 아직 어디에도 결선돼 있지 않다 -- 실행 증거 필드(`last_verified_*`)를
// `enforcement-inventory.json`에 추가하는 **다음 조각**에서 연결된다.
// 이번 조각(HYK-292)의 실제 강제력에는 기여하지 않는다 -- 순수 판정
// 함수와 그 시험만 여기 있다.
export const ENFORCEMENT_GRADE = Object.freeze({
  MACHINE_ENFORCED: "기계 강제",
  DOCUMENTED_PROMISE: "문서 약속",
  UNVERIFIED: "미검증",
});

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// hasValidEvidence -- 증거 3요소가 모두 있고 exit===0이어야 "기계 강제"
// 후보다. 하나라도 빠지면 증거 없음과 동일하게 취급한다(부분 증거로
// 등급을 올리지 않는다).
function hasValidEvidence(evidence) {
  return (
    evidence &&
    isNonEmptyString(evidence.command) &&
    typeof evidence.exit === "number" &&
    isNonEmptyString(evidence.at)
  );
}

// gradeEnforcementEntry(entry, evidence) -> one of ENFORCEMENT_GRADE
// entry: enforcement-inventory.json의 한 원소(또는 undefined -- 항목
// 자체를 못 찾은 경우). evidence: {command, exit, at} | undefined.
export function gradeEnforcementEntry(entry, evidence) {
  if (!entry || !isNonEmptyString(entry.script)) {
    return ENFORCEMENT_GRADE.UNVERIFIED;
  }
  if (hasValidEvidence(evidence) && evidence.exit === 0) {
    return ENFORCEMENT_GRADE.MACHINE_ENFORCED;
  }
  return ENFORCEMENT_GRADE.DOCUMENTED_PROMISE;
}

// gradeEnforcementInventory(entries, evidenceByCheckId) ->
//   [{id, grade}, ...] -- entries 순서를 그대로 보존한다(사람이 표를
//   손으로 다시 정렬할 필요가 없도록).
export function gradeEnforcementInventory(entries, evidenceByCheckId = {}) {
  return entries.map((entry) => ({
    id: entry && entry.id,
    grade: gradeEnforcementEntry(entry, evidenceByCheckId[entry && entry.id]),
  }));
}
