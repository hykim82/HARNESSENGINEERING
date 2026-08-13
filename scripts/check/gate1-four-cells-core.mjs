// HYK-241 §2 조각3: 게이트 1 상신 문서에 «후보마다» S16 네 칸이 있는지
// 확인하는 순수 판정 코어. I/O 0(다른 *-decision-core.mjs와 동일 계약) --
// 호출부(gate1-four-cells-check.mjs)가 상신 파일을 읽어 텍스트만 넘긴다.
//
// ⚠️정직 한계(§3-2 셋째 항목): 이 코어는 «게이트 1 상신 문서»의 형식을
// 이번에 새로 정의한다 -- 기존에 통용되던 형식이 없었다(저장소 안에서
// "S16"/"사분면"/"게이트 1 상신" 어느 것도 선례를 찾지 못함, 결과 파일에
// 실측 기재). 아래 네 칸(질문1/질문2/사분면/Linear-또는-미등재)은 이
// 트랙이 처음 도입하는 표기 규약이며, 실제 상신 문서(저장소 밖)가 이
// 규약을 따를지는 이 트랙 밖의 결정이다.
//
// 문서 형식(이 트랙이 정의):
//   ## 후보: <제목>            <- 후보 하나의 시작(레벨 2~3 헤딩)
//   질문1: <서술>              <- 북극성에 심각한가
//   질문2: <서술>              <- 미루면 비용이 커지는가
//   사분면: <1|2|3|4>          <- 1~4순위
//   Linear: <HYK-숫자 또는 "미등재"/"등재 요청" 문구>
//
// 후보 블록은 다음 `## 후보:`/`### 후보:` 헤딩 전까지, 또는 EOF까지다.

const CANDIDATE_HEADING_RE = /^#{2,3}\s*후보\s*[:：]\s*(.+)$/gim;
const Q1_RE = /^질문\s*1\s*[:：]\s*(\S.*)$/im;
const Q2_RE = /^질문\s*2\s*[:：]\s*(\S.*)$/im;
const QUADRANT_RE = /^사분면\s*[:：]\s*(\S.*)$/im;
const LINEAR_RE = /^Linear\s*[:：]\s*(\S.*)$/im;
const VALID_QUADRANT_VALUES = new Set(["1", "2", "3", "4"]);
const LINEAR_ISSUE_RE = /^HYK-\d+/i;
const LINEAR_UNREGISTERED_RE = /(미등재|등재\s*요청)/;

function normalizeNewlines(text) {
  return (text ?? "").replace(/\r\n/g, "\n");
}

// Splits the document into candidate blocks by CANDIDATE_HEADING_RE --
// each block runs from its heading to the next heading (or EOF). Zero
// headings found -> zero blocks (caller treats that as its own failure,
// not silently "nothing to check").
export function parseCandidateBlocks(docText) {
  const text = normalizeNewlines(docText);
  const headings = [...text.matchAll(CANDIDATE_HEADING_RE)];
  const blocks = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index;
    const end = i + 1 < headings.length ? headings[i + 1].index : text.length;
    blocks.push({
      title: headings[i][1].trim(),
      body: text.slice(start, end),
    });
  }
  return blocks;
}

// Checks ONE candidate block for the four cells. Returns
// { ok, missingCells, invalidCells } -- missingCells names cells whose
// marker line is entirely absent; invalidCells names cells whose marker
// line IS present but its value fails validation (currently only 사분면's
// {1,2,3,4} closed set).
export function checkCandidateCells(block) {
  const missingCells = [];
  const invalidCells = [];
  const body = block.body;

  const q1 = body.match(Q1_RE);
  if (!q1) missingCells.push("질문1");

  const q2 = body.match(Q2_RE);
  if (!q2) missingCells.push("질문2");

  const quadrant = body.match(QUADRANT_RE);
  if (!quadrant) {
    missingCells.push("사분면");
  } else if (!VALID_QUADRANT_VALUES.has(quadrant[1].trim())) {
    invalidCells.push(
      `사분면(값 '${quadrant[1].trim()}'은 1~4 중 하나가 아님)`,
    );
  }

  const linear = body.match(LINEAR_RE);
  if (!linear) {
    missingCells.push("Linear");
  } else {
    const value = linear[1].trim();
    const isIssueRef = LINEAR_ISSUE_RE.test(value);
    const isUnregisteredNote = LINEAR_UNREGISTERED_RE.test(value);
    if (!isIssueRef && !isUnregisteredNote) {
      invalidCells.push(
        `Linear(값 '${value}'이 HYK-<숫자>도 아니고 '미등재'/'등재 요청' 문구도 아님)`,
      );
    }
  }

  return {
    ok: missingCells.length === 0 && invalidCells.length === 0,
    missingCells,
    invalidCells,
  };
}

// Top-level judgment over a whole gate-1 proposal document. Zero candidates
// found is itself a failure (fail-closed -- an empty/malformed document is
// never silently "nothing to flag").
export function checkGate1FourCells(docText) {
  const blocks = parseCandidateBlocks(docText);
  if (blocks.length === 0) {
    return {
      ok: false,
      candidates: [],
      reasons: [
        "gate1-four-cells: 문서에서 '## 후보: <제목>' 헤딩을 하나도 찾지 못함 -> 판정 불가(안전측 기본값, 빈 문서를 '통과'로 접지 않는다)",
      ],
    };
  }
  const candidates = blocks.map((block) => {
    const cells = checkCandidateCells(block);
    return { title: block.title, ...cells };
  });
  const reasons = candidates
    .filter((c) => !c.ok)
    .map((c) => {
      const parts = [];
      if (c.missingCells.length > 0) {
        parts.push(`누락: ${c.missingCells.join(", ")}`);
      }
      if (c.invalidCells.length > 0) {
        parts.push(`무효: ${c.invalidCells.join(", ")}`);
      }
      return `gate1-four-cells: 후보 '${c.title}' -- ${parts.join(" / ")}`;
    });
  return {
    ok: candidates.every((c) => c.ok),
    candidates,
    reasons,
  };
}
