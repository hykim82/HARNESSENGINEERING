// HYK-226-activation-invariant-1 (coder-task.md) -- 「커밋된 런타임
// 배포·활성화 불변식」의 판단(코어).
//
// 실사고(coder-task.md §0, 2026-08-11): 관제실 배달기
// dispatch-worker.ps1이 대상 워크트리 기준으로 저장소 스크립트
// (scripts/supervisor/admission-cli.mjs 등)를 참조한다. 그 스크립트가
// "어떤 브랜치에도 병합돼 있지 않고 한 워크트리에 스테이징 상태로만"
// 존재했던 시점에, 그 워크트리 밖 모든 배달이 ADMISSION_CLI_MISSING으로
// fail-closed 거부됐다 -- 안전측 거부 자체는 옳았지만, "안전한 거부가
// 전 신규 배달의 가용성 장애가 됐다"(PM 원문). 이 모듈은 그 사고의 형태
// (작업트리·인덱스 존재 != 커밋된 ref 존재)를 미리 판정하는 순수 함수다.
//
// ★닫힌 상태집합(확증식, 열거식 금지) -- coder-task.md §1-1:
//
// | 상태 | 뜻 | exit |
// |---|---|---|
// | ALLOW | 추출된 참조가 1개 이상이고 전부 지정 ref에 존재함을 확인 | 0 |
// | REJECT_UNMERGED_DEPENDENCY | 하나라도 지정 ref에 없다 | 2 |
// | REJECT_UNJUDGABLE | 판정 불가 -- 조회 실패·ref 부재·입력 결손·참조
//   0개 추출·추출기 예외 | 2 |
//
// REJECT_UNJUDGABLE은 ALLOW로도 REJECT_UNMERGED_DEPENDENCY로도 접히지
// 않는다 -- "조회 실패 = 이상 없음"은 이 저장소가 반복해 잡아온 형태다
// (HYK-212 QUERY_FAILED 선례). 참조 0개 추출도 "막을 게 없으니 통과"가
// 아니라 UNJUDGABLE이다(vacuous pass 방지).
//
// zero-import 코어 계약(dispatch-gate-decision-core.mjs와 동일 이유):
// I/O, child_process, fs 직접 호출 0. ref 조회기(checkRefPathExists)는
// 호출부(activation-dependency-check.mjs)가 인자로 주입한다 -- 이 모듈은
// 판단 로직만, 조회 방법은 전혀 모른다.
export const ACTIVATION_DEPENDENCY_STATE = Object.freeze({
  ALLOW: "ALLOW",
  REJECT_UNMERGED_DEPENDENCY: "REJECT_UNMERGED_DEPENDENCY",
  REJECT_UNJUDGABLE: "REJECT_UNJUDGABLE",
});

// 저장소 상대 경로 참조 추출 -- "a/b.ext" 형태(슬래시 최소 1개 + 확장자)만
// 잡는다. dispatch-worker.ps1의 실제 참조 형태(`scripts/check/x.mjs`)와
// 일치하는 최소 형태다.
const REPO_PATH_RE =
  /[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+\.[A-Za-z0-9]+/g;

// URL(`https://host/path.ext`) 오추출 방지 -- "//" 바로 뒤 첫 세그먼트만
// 제외하는 lookbehind로는 "https://host/a/b.mjs" 안쪽의 "a/b.mjs"까지는
// 못 거른다(도메인 뒤 서브패스가 그 자체로 REPO_PATH_RE를 만족하기
// 때문). URL 스팬 전체를 먼저 찾아 그 구간 안에서 시작하는 매치를
// 통째로 버리는 방식으로 그 구멍을 막는다.
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

function findUrlSpans(text) {
  const spans = [];
  for (const m of text.matchAll(URL_RE)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

function startsInsideAnySpan(index, spans) {
  return spans.some(([start, end]) => index >= start && index < end);
}

export function extractRepoPathReferences(patchText) {
  if (typeof patchText !== "string" || patchText.trim().length === 0) {
    return [];
  }
  const urlSpans = findUrlSpans(patchText);
  const seen = new Set();
  const out = [];
  for (const m of patchText.matchAll(REPO_PATH_RE)) {
    if (startsInsideAnySpan(m.index, urlSpans)) continue;
    const value = m[0];
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function unjudgable(detail, references) {
  return {
    state: ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE,
    exitCode: 2,
    ref: null,
    references: references ?? [],
    missing: null,
    reason: `activation-dependency: REJECT_UNJUDGABLE -- ${detail}`,
  };
}

// judgeActivationDependency의 입력 결손/오용 축(ref·patchText·checker
// 자체의 유효성)만 확증한다. quality-check 복잡도 상한을 지키기 위해
// judgeActivationDependency 밖으로 뺐다(reject-streak.mjs류 기존 관례와
// 동일 이유) -- 판단 로직 자체는 옮기지 않았다, 순서만 나눴다.
function validateJudgeInputs({ patchText, ref, checkRefPathExists }) {
  if (typeof ref !== "string" || ref.trim().length === 0) {
    return unjudgable("ref 미지정 또는 빈 문자열(조회 대상 ref 부재)", []);
  }
  if (typeof patchText !== "string" || patchText.trim().length === 0) {
    return unjudgable("patchText 미지정 또는 빈 문자열(판정 입력 결손)", []);
  }
  if (typeof checkRefPathExists !== "function") {
    return unjudgable(
      "checkRefPathExists 미주입(순수 함수 계약 위반, 운영 오류)",
      [],
    );
  }
  return null;
}

// references 전부를 checkRefPathExists(ref, path)로 확증한다. 반환값은
// { missing: string[] }(전부 판정됨) 또는 { unjudgable: <result> }(조회
// 실패/비boolean 응답 -- 그 즉시 나머지 참조는 확인하지 않고 멈춘다,
// 애매하면 기본 거부).
function checkAllReferencesExist(references, ref, checkRefPathExists) {
  const missing = [];
  for (const path of references) {
    let exists;
    try {
      exists = checkRefPathExists(ref, path);
    } catch (err) {
      return {
        unjudgable: unjudgable(
          `조회 실패(경로: ${path}, ref: ${ref}) -- ${err?.message ?? String(err)}`,
          references,
        ),
      };
    }
    if (exists !== true && exists !== false) {
      return {
        unjudgable: unjudgable(
          `조회 결과가 boolean이 아님(경로: ${path}, 실제: ${JSON.stringify(exists)}) -- 애매하면 기본 거부`,
          references,
        ),
      };
    }
    if (exists === false) missing.push(path);
  }
  return { missing };
}

// 이 모듈이 존재하는 이유인 단 하나의 함수. patchText에서 저장소 상대
// 경로 참조를 추출하고, 각각이 지정 ref에 «커밋된 상태로» 존재하는지
// checkRefPathExists(ref, path)로 확증한다. checkRefPathExists는 반드시
// 순수 boolean을 반환해야 한다(true/false 외 값 -- undefined/null/문자열
// 등 -- 은 "명확히 읽어내지 못함"으로 취급해 UNJUDGABLE). 예외를 던지면
// "조회 실패"로 UNJUDGABLE.
export function judgeActivationDependency(args = {}) {
  const { patchText, ref, checkRefPathExists } = args;
  const invalid = validateJudgeInputs(args);
  if (invalid) return invalid;

  const references = extractRepoPathReferences(patchText);
  if (references.length === 0) {
    return unjudgable(
      "저장소 상대 경로 참조 0개 추출 -- 막을 게 없으니 통과가 아니다(vacuous pass 방지)",
      [],
    );
  }

  const { missing, unjudgable: unjudgableResult } = checkAllReferencesExist(
    references,
    ref,
    checkRefPathExists,
  );
  if (unjudgableResult) return unjudgableResult;

  if (missing.length > 0) {
    return {
      state: ACTIVATION_DEPENDENCY_STATE.REJECT_UNMERGED_DEPENDENCY,
      exitCode: 2,
      ref,
      references,
      missing,
      reason: `activation-dependency: REJECT_UNMERGED_DEPENDENCY -- 참조 ${references.length}개 중 ${missing.length}개가 ref(${ref})에 커밋된 상태로 없음: ${missing.join(", ")}`,
    };
  }

  return {
    state: ACTIVATION_DEPENDENCY_STATE.ALLOW,
    exitCode: 0,
    ref,
    references,
    missing: [],
    reason: `activation-dependency: ALLOW -- 참조 ${references.length}개 전부 ref(${ref})에 커밋된 상태로 존재 확인`,
  };
}
