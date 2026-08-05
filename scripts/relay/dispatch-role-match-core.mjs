// HYK-186 (coder-task.md §2) -- 배정(spec)과 좌석(role)이 어긋난 채 기동되는
// 것을 막는 순수 판정 코어. I/O 0 · `orca` 호출 0 · 네트워크 0.
//
// 배경(coder-task.md §1): 2026-08-05 05:2x, ORCH가 REVIEW 태스크를 CODER
// 좌석에 화면 제목 문자열로 잘못 배달했다. pane key 위조 차단(기존
// dispatch-correlation-core.mjs)은 "배정이 실제로 그 좌석 앞으로 나갔는가"만
// 보므로 정상 통과했다 -- ORCH의 오배송 자체는 그 검사가 볼 수 있는 축이
// 아니다. 이 파일은 그 사각을 메우는 두 번째 축이다: `task-create` 때 ORCH가
// spec에 실은 역할(런타임 `task-list --json`의 `spec` 필드 -- 권위 있는
// 출처, ORCH 실측)과 이 좌석 자신의 역할을 대조한다.
//
// 비타협(coder-task.md §2-2/§3):
// - 역할을 spec 문자열에서 "추측"하지 않는다 -- 라벨에 `review`가 들어
//   있어도 명시 `role:` 필드가 없으면 판정 불가로 닫는다(이름 규칙 의존
//   금지, ...-review-1 같은 이름이 바뀌는 순간 조용히 깨지는 것을 피한다).
// - 판정 불가(spec에 역할 없음 / 좌석 역할 없음)를 "허용"으로 접지 않는다
//   -- gap#61/#75/#77과 같은 계열의 실패(수집 실패를 조용함으로 접는 것)를
//   반복하지 않는다. UNDECIDABLE도 ok:false다(허용은 MATCH뿐).
//
// S6 경계: 이 파일은 `orca` CLI를 모른다 -- 호출자가 이미 `task-list --json`
// 응답에서 뽑아 온 `spec` 문자열(원문)과, 이 좌석의 role 문자열만 받는다.

export const ROLE_MATCH_VERDICT = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  UNDECIDABLE: "UNDECIDABLE",
});

export const ROLE_MATCH_REASON = Object.freeze({
  SEAT_ROLE_MISSING: "SEAT_ROLE_MISSING",
  SPEC_ROLE_MISSING: "SPEC_ROLE_MISSING",
  ROLE_MISMATCH: "ROLE_MISMATCH",
  ROLE_MATCH: "ROLE_MATCH",
});

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// 명시 필드만 읽는다 -- `^role:\s*(\S+)`(대소문자 무시, 각 줄의 처음).
// 오늘 실제 spec 형태(`go <라벨>` + `role: CODER` + 안내문 + `worktree:`
// 줄, ORCH 실측)와 공존한다. 라벨 문자열(`go HYK-9001-review-1` 등)이나
// 본문 어디에 "review"/"coder" 단어가 등장하는지는 절대 보지 않는다 --
// 이 줄의 시작이 정확히 `role:`이어야만 후보가 된다.
const SPEC_ROLE_LINE_RE = /^role:\s*(\S+)/im;
export function extractRoleFromSpec(specText) {
  if (typeof specText !== "string") return null;
  const m = specText.match(SPEC_ROLE_LINE_RE);
  return m ? m[1] : null;
}

function verdict(kind, reasonCode, details) {
  return {
    ok: kind === ROLE_MATCH_VERDICT.MATCH,
    verdict: kind,
    reasonCode,
    details,
  };
}

// judgeDispatchRoleMatch({ specText, seatRole }) -> MATCH(허용) /
// MISMATCH(거부) / UNDECIDABLE(판정 불가, 거부와 같은 ok:false지만 사유가
// 다르다 -- 호출자가 MISMATCH는 거부로, UNDECIDABLE은 별도 처리(예: 사람
// 에스컬레이션)로 가를 수 있게 구분된 verdict를 낸다).
export function judgeDispatchRoleMatch({ specText, seatRole } = {}) {
  if (!isNonEmptyString(seatRole)) {
    return verdict(
      ROLE_MATCH_VERDICT.UNDECIDABLE,
      ROLE_MATCH_REASON.SEAT_ROLE_MISSING,
      "dispatch-role-match: seatRole is missing/empty -- cannot judge",
    );
  }
  const specRole = extractRoleFromSpec(specText);
  if (!specRole) {
    return verdict(
      ROLE_MATCH_VERDICT.UNDECIDABLE,
      ROLE_MATCH_REASON.SPEC_ROLE_MISSING,
      "dispatch-role-match: spec has no explicit 'role:' field -- refusing to guess from the label",
    );
  }
  if (specRole.trim().toUpperCase() !== seatRole.trim().toUpperCase()) {
    return verdict(
      ROLE_MATCH_VERDICT.MISMATCH,
      ROLE_MATCH_REASON.ROLE_MISMATCH,
      `dispatch-role-match: spec role '${specRole}' != seat role '${seatRole}'`,
    );
  }
  return verdict(
    ROLE_MATCH_VERDICT.MATCH,
    ROLE_MATCH_REASON.ROLE_MATCH,
    `dispatch-role-match: spec role '${specRole}' matches seat role '${seatRole}'`,
  );
}
