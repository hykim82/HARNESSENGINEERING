// HYK-292 I1 (coder-task.md §3, §3-1) -- live STATUS.md가 커밋된 예산
// (docs-budget-config.json의 status_budget_bytes)을 넘지 않는지, 그리고
// 역할별 상태 행이 정확히 6개(사람/ORCH/PM/CODER/REVIEW/VERIFY)인지
// 판정하는 순수 코어. I/O 0 -- 바이트 수와 텍스트는 호출부
// (status-budget-check.mjs)가 넘긴다.
//
// PM 사람이 칠 명령(PM-r9.md I1)을 그대로 판정 로직으로 옮긴 것:
//   bytes=$b role_rows=$r; if($b -gt 65536 -or $r -ne 6){exit 1}
// role_rows는 `^\|\s*(사람|ORCH|PM|CODER|REVIEW|VERIFY)\s*\|` 매칭 줄 수.
//
// 2R 수리 2 (review-r1.md 축3 재측정 -- STATUS 387행의 과거/정책 표
// `| PM | DONE ... |`가 같은 정규식에 잡혀 전체 파일 계수가 7이 된다):
// role_rows는 이제 **파일 전체**가 아니라 **살아 있는 §1 표 범위**
// 안에서만 센다.
//
// §1 표 범위 식별 근거(실물 STATUS.md 실측) -- §1 표는 "|"로만 이어지는
// 연속 블록이 **아니다**: 헤더 행(`| 역할 | ... |`) 바로 다음 줄부터
// 트림 규약 주석(`<!-- ... -->`)과 역할별 "(이전)" 과거값을 접은 HTML
// 주석 줄이 실제 역할 행들 «사이사이에» 끼어든다(예: 실물 14행 = 주석,
// 16~28행 = 접힌 과거 ORCH 행 여럿, 그 사이 29~33행에 살아 있는
// CODER/REVIEW/VERIFY/PM/사람 행). 그래서 "첫 «|»로 시작하지 않는 줄에서
// 끊는다"는 규칙은 실물에서 헤더 바로 다음 주석 줄에 걸려 실제 행을
// 하나도 못 센다. 대신 STATUS.md 자체의 절 구조(`## A. 즉답`
// 아래 `### 1) 다음 행동`에 §1 표가 있고, 다음 소제목 `### 2) ...`가
// §1 끝을 표시한다는 마크다운 헤딩 규약)를 근거로, **헤더 행부터
// 다음 마크다운 헤딩(`#`로 시작하는 줄) 직전까지**를 §1 표 범위로
// 잡는다 -- 주석·빈 줄은 그 범위 안에 있어도 되고(役할행 정규식이
// `^\|`만 매칭하므로 `<!-- | ORCH | ... | -->` 형태의 접힌 과거 행은
// "|"로 시작하지 않아 애초에 안 잡힌다), 387행의 과거 표는 여러 헤딩
// 경계 밖에 있으므로 자동으로 제외된다. 헤더 행 자체를 못 찾으면
// 조용히 "전체 파일"로 되돌아가지 않고 fail-closed(sectionFound:false)로
// 알린다.
export const ROLE_ROW_RE = /^\|\s*(사람|ORCH|PM|CODER|REVIEW|VERIFY)\s*\|/gim;
export const REQUIRED_ROLE_ROW_COUNT = 6;
const SECTION1_HEADER_RE = /^\|\s*역할\s*\|/m;
const MARKDOWN_HEADING_RE = /^#/;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// extractSection1Table(statusText) -> 표 블록 텍스트 | null(못 찾음)
//
// "| 역할 | ... |" 헤더 행을 찾아, 그 행부터 다음 마크다운 헤딩(`#...`)
// 직전까지를 §1 표 범위로 취급한다(파일의 첫 번째 그런 헤더만 -- §1은
// 문서 맨 위 "### 1) 다음 행동" 아래에 있다는 STATUS.md 자체의 절
// 구조를 근거로 한다. 위 헤더 주석 참조).
export function extractSection1Table(statusText) {
  const text = normalizeNewlines(statusText);
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) => SECTION1_HEADER_RE.test(line));
  if (headerIndex === -1) return null;

  const blockLines = [];
  for (let i = headerIndex; i < lines.length; i++) {
    if (i > headerIndex && MARKDOWN_HEADING_RE.test(lines[i])) break;
    blockLines.push(lines[i]);
  }
  return blockLines.join("\n");
}

// countRoleRows -- 6개 역할 각각 정확히 한 줄씩을 기대한다(중복/누락 모두
// role_rows !== 6으로 드러난다 -- 특정 역할이 어떤 것인지는 이 함수의
// 반환값만으로는 구분하지 않는다, PM 원문 명령과 동일한 관측 단위).
// ⚠️입력은 이미 §1 표 범위로 좁혀진 텍스트여야 한다(checkStatusBudget이
// extractSection1Table을 거쳐 넘긴다) -- 이 함수 자체는 여전히 순수하게
// "주어진 텍스트에서 역할행 개수"만 센다(단위 시험 편의를 위해 범위
// 판단과 분리해 둔다).
export function countRoleRows(statusText) {
  const text = normalizeNewlines(statusText);
  const matches = [...text.matchAll(ROLE_ROW_RE)];
  return matches.length;
}

// checkStatusBudget({statusText, byteLength, statusBudgetBytes}) ->
//   {ok, bytes, roleRows, reasons, sectionFound}
//
// byteLength: 호출부가 파일의 «실제 바이트 크기»를 넘긴다(문자열 길이가
// 아니다 -- UTF-8/한글 혼용 문서는 문자 수 != 바이트 수이므로 반드시
// Buffer.byteLength 또는 fs.statSync(...).size로 잰 값이어야 한다).
//
// sectionFound === false -- §1 표를 못 찾았다(fail-closed). 이 경우
// roleRows는 null이고 ok는 항상 false다 -- 호출부(CLI)는 이걸 "예산
// 초과"(exit 1)가 아니라 "판정 불가"(exit 2)로 구분해야 한다.
export function checkStatusBudget({
  statusText,
  byteLength,
  statusBudgetBytes,
}) {
  const section1Text = extractSection1Table(statusText);
  if (section1Text === null) {
    return {
      ok: false,
      sectionFound: false,
      bytes: byteLength,
      roleRows: null,
      reasons: [
        "status-budget: §1 표(«| 역할 |» 헤더 행)를 찾지 못함 -- fail-closed",
      ],
    };
  }

  const roleRows = countRoleRows(section1Text);
  const reasons = [];

  if (byteLength > statusBudgetBytes) {
    reasons.push(
      `status-budget: bytes=${byteLength}가 예산 ${statusBudgetBytes}를 초과함`,
    );
  }
  if (roleRows !== REQUIRED_ROLE_ROW_COUNT) {
    reasons.push(
      `status-budget: role_rows=${roleRows}이 요구값 ${REQUIRED_ROLE_ROW_COUNT}와 다름`,
    );
  }

  return {
    ok: reasons.length === 0,
    sectionFound: true,
    bytes: byteLength,
    roleRows,
    reasons,
  };
}
