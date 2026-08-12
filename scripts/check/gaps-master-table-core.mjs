// HYK-238-gaps-table-1 -- HYK-231 5회 반려 트랙의 인수 작업: "손으로 채우는
// 마스터 표"를 없애고 스크립트가 문서를 읽어 표를 만들게 한다.
//
// 5R 반려 사유(REVIEW 5R, .harness archive) 재현: 스냅샷(rounds/coder-r5.md)
// 에는 있던 ID 28 행이 결과 정본(.harness/coder.md)으로 «손 복사»되지
// 않아 빠졌고, `known-gaps-split-design.md` §1-5의 실측값 100(번호
// 최댓값)이 표 밖에 남아 있었다. 두 결손 모두 "사람이 표를 손으로
// 채운다"는 공정 자체의 실패다 -- 이 모듈은 그 공정을 없앤다.
//
// zero-import 코어 계약(activation-dependency-core.mjs와 동일 이유): 이
// 파일은 fs·child_process를 전혀 부르지 않는다. 명령 실행은 CLI 래퍼
// (generate-gaps-master-table.mjs)가 하고, 그 출력을 이 모듈의 순수
// 함수에 넣는다 -- 그래야 단위 시험이 실제 셸 명령 없이 결정적으로 돈다.

// ── 측정 매니페스트 ─────────────────────────────────────────────────
// 각 항목은 "무엇을 셌는지(scope)"와 "그 수를 내는 명령(command)"을
// 함께 갖는다(§0-1 계약 강화 조항 승계). command는 사람이 그대로 복사
// 실행해도 되고, CLI 래퍼가 그대로 실행해 output을 채운다 -- 옮겨 적지
// 않는다(§3 규칙3: 실행해야 재현성이 보장된다, 옮기면 검증이 안 된다).
// derive 항목은 이미 채워진 다른 ID들로부터 산식으로 계산한다(명령 없음
// -- 산식 자체가 재현 수단).
export const MEASUREMENT_MANIFEST = Object.freeze([
  {
    id: 1,
    scope: "대상 파일(docs/enforcement-known-gaps.md) 바이트 크기",
    shell: "bash",
    command: "stat -c%s docs/enforcement-known-gaps.md",
  },
  {
    id: 2,
    scope: "표 행(`| N | ... |`) 총수",
    shell: "bash",
    command:
      "git grep -c -E '^\\| *#?[0-9]+ *\\|' -- docs/enforcement-known-gaps.md | cut -d: -f2",
  },
  {
    id: 3,
    scope: "표 행 고유 번호 수",
    shell: "bash",
    command:
      "git grep -o -h -E '^\\| *#?[0-9]+ *\\|' -- docs/enforcement-known-gaps.md | grep -o -E '[0-9]+' | sort -u | wc -l",
  },
  { id: 4, scope: "표 행 중복 수(=ID2-ID3)", derive: (v) => v[2] - v[3] },
  {
    id: 5,
    scope: "표 행에서 #94 매치 수(결번 확인)",
    shell: "bash",
    command:
      "git grep -o -h -E '^\\| *#?[0-9]+ *\\|' -- docs/enforcement-known-gaps.md | grep -o -E '[0-9]+' | grep -c '^94$' || true",
  },
  {
    id: 6,
    scope: "산문 절 헤더(`^## ... gap#NN`) 줄 수",
    shell: "bash",
    command:
      "git grep -c -E '^## .*gap ?#[0-9]+' -- docs/enforcement-known-gaps.md | cut -d: -f2",
  },
  {
    id: 7,
    scope: "gap#93 헤더 줄 기준 등장 수",
    shell: "bash",
    command:
      "git grep -c -E '^## .*gap#93' -- docs/enforcement-known-gaps.md | cut -d: -f2",
  },
  {
    id: 8,
    scope: "gap#93 매치 줄 수(rg -c, 같은 줄 중복은 1로)",
    shell: "bash",
    command: "rg -c 'gap#93' docs/enforcement-known-gaps.md",
  },
  {
    id: 9,
    scope: "gap#93 총 등장 토큰 수(같은 줄 중복도 개별 계산)",
    shell: "bash",
    command: "rg -o -n 'gap#93' docs/enforcement-known-gaps.md | wc -l",
  },
  {
    id: 10,
    scope: "표 행 분류 열 `KNOWN GAP` 매치 줄 수",
    shell: "bash",
    command: 'grep -c "KNOWN GAP" docs/enforcement-known-gaps.md',
  },
  {
    id: 11,
    scope: "표 행 분류 열 `NEW DEFECT` 매치 줄 수",
    shell: "bash",
    command: 'grep -c "NEW DEFECT" docs/enforcement-known-gaps.md',
  },
  {
    id: 12,
    scope: "표 행 분류 열 `BLOCKED(` 매치 줄 수",
    shell: "bash",
    command: 'grep -c "BLOCKED(" docs/enforcement-known-gaps.md',
  },
  { id: 13, scope: "ID10+ID11(실제 gap 근사치)", derive: (v) => v[10] + v[11] },
  {
    id: 14,
    scope: "ID2-ID12(BLOCKED #10 제외한 계수)",
    derive: (v) => v[2] - v[12],
  },
  {
    id: 15,
    scope: "ID14-ID13(미해소 어긋남, 그대로 보고)",
    derive: (v) => v[14] - v[13],
  },
  {
    id: 16,
    scope:
      "`enforcement-known-gaps.md` 경로 문자열을 참조하는 파일 수(저장소 전체)",
    shell: "bash",
    command: 'git grep -l "enforcement-known-gaps.md" -- . | wc -l',
  },
  {
    id: 17,
    scope: "위 경로 문자열의 저장소 전체 매치 수",
    shell: "bash",
    command: 'git grep -o "enforcement-known-gaps.md" -- . | wc -l',
  },
  {
    id: 18,
    scope: "`enforcement-v1.md` 경로 문자열을 참조하는 파일 수",
    shell: "bash",
    command: 'git grep -l "enforcement-v1.md" -- . | wc -l',
  },
  {
    id: 19,
    scope: "위 경로 문자열의 저장소 전체 매치 수",
    shell: "bash",
    command: 'git grep -o "enforcement-v1.md" -- . | wc -l',
  },
  {
    id: 20,
    scope: '느슨한 단어 "known-gaps"(확장자 없이)를 참조하는 파일 수',
    shell: "bash",
    command: 'git grep -l "known-gaps" -- . | wc -l',
  },
  {
    id: 21,
    scope: "위 느슨한 단어의 저장소 전체 매치 수",
    shell: "bash",
    command: 'git grep -o "known-gaps" -- . | wc -l',
  },
  {
    id: 22,
    scope: "정본 CI 총 시험 수(node scripts/check/isolated-suite-runner.mjs)",
    shell: "ci",
    ciField: "tests",
  },
  { id: 23, scope: "정본 CI pass 수", shell: "ci", ciField: "pass" },
  { id: 24, scope: "정본 CI fail 수", shell: "ci", ciField: "fail" },
  { id: 25, scope: "정본 CI skip 수", shell: "ci", ciField: "skipped" },
  {
    id: 26,
    scope: "표 행 번호 최댓값(1~N 범위의 상한)",
    shell: "bash",
    command:
      "git grep -o -h -E '^\\| *#?[0-9]+ *\\|' -- docs/enforcement-known-gaps.md | grep -o -E '[0-9]+' | sort -n | tail -1",
  },
]);

// 설계 제안값(측정 아님) -- §2 규칙4: 이 값들은 문서가 "잰 것"이 아니라
// "제안한 것"이라 재현 명령이 없고 있을 수도 없다(아직 구현되지 않은
// 설계이므로). 조용히 빼지 않고 이 목록 자체를 리포트에 낸다(5R이
// 정확히 이 자리 -- 값 100 -- 에서 반려됐으므로, "제외"와 "누락"을
// 헷갈리지 않도록 제외 목록을 코드로 고정한다).
//
// ★2R 수리(REVIEW 1R D 반려 -- global_exclusion_probe_for_bold_1 재현):
// 1R은 `excludedValues`를 "값 문자열만의 Set"으로 scanOmissions에 넘겨,
// 두 문서 어디서든 굵게 강조된 `**1**`·`**200**`·`**204800**`이 새로
// 생기면 출처와 무관하게 조용히 삼켰다(검토자가 빈 measuredValues +
// 합성 `**1**`로 직접 재현). ★근본 원인: 이 세 값의 "제안값 자리"는
// 전부 펜스 코드 블록 안(jsonc 스니펫) 또는 굵게-강조가 아닌 평문
// ("200KiB")이라, `extractBoldNumbers`가 애초에 그 자리를 절대 추출
// 하지 않는다(펜스 스킵 로직, 위 §마크다운 파싱). 즉 굵게 추출된 값이
// 제안값과 같은 문자열이면, 그건 **구조적으로 항상 제안값의 그 자리가
// 아니라 다른 자리의 새 값**이다 -- 값만으로 거르는 것 자체가 처음부터
// 틀린 필터였다.
//
// 수리(§3 규칙: 「제외를 값이 아니라 그 값이 그 자리에 있는 것에
// 묶어라」): 각 항목에 path·anchor(그 문서에서 실제로 찾아야 하는 리터럴
// 문자열)를 추가하고, `verifyExclusionAnchors`가 그 앵커가 선언된 문서에
// 실제로 존재하는지 확인한다(제외 근거가 아직 유효한지 실측 검증 --
// 문서가 바뀌어 앵커가 사라지면 그 자체를 실패로 다룬다, 조용히 "아직도
// 맞겠지"로 넘어가지 않는다). `scanOmissions`는 더 이상 값으로 굵게-매치
// 를 거르지 않는다(아래 함수 주석 참조) -- 제외는 "그 앵커가 존재한다"는
// 사실 확인용으로만 쓰이고, 굵게 추출된 값은 전부 measuredValues 하나만
// 놓고 판단한다.
export const EXCLUDED_DESIGN_VALUES = Object.freeze([
  {
    value: "1",
    source: "docs/known-gaps-index-schema-draft.md §2-2",
    reason: "schemaVersion 제안값(아직 존재하지 않는 인덱스 파일의 필드)",
    path: "docs/known-gaps-index-schema-draft.md",
    anchor: '"schemaVersion": 1,',
  },
  {
    value: "204800",
    source: "docs/known-gaps-index-schema-draft.md §2-2",
    reason: "shardByteLimit 제안값(바이트, = 200KiB)",
    path: "docs/known-gaps-index-schema-draft.md",
    anchor: '"shardByteLimit": 204800,',
  },
  {
    value: "200",
    source: "docs/known-gaps-split-design.md §2-3",
    reason: "shard 상한 예시(KiB 단위 표기, 204800과 동일 제안값의 다른 표기)",
    path: "docs/known-gaps-split-design.md",
    anchor: "상한(예: 200KiB",
  },
]);

// ── 마크다운 파싱 ────────────────────────────────────────────────────

// 펜스 코드 블록(```...```) 구간을 [start,end) 쌍으로 찾는다. 코드
// 블록 안의 예시 명령·JSON 스니펫에 나오는 숫자(포트 번호, wc -l 같은
// 명령 텍스트 안 숫자 등)를 "측정값 강조"로 오인하지 않기 위함 --
// extractBoldNumbers가 이 구간 안의 매치를 걸러낼 때 쓴다.
export function findFencedCodeSpans(text) {
  const spans = [];
  const fenceRe = /^```.*$/gm;
  const fenceLines = [];
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    fenceLines.push(m.index);
  }
  for (let i = 0; i + 1 < fenceLines.length; i += 2) {
    spans.push([fenceLines[i], fenceLines[i + 1]]);
  }
  return spans;
}

function isInsideAnySpan(index, spans) {
  return spans.some(([start, end]) => index >= start && index < end);
}

// 이 두 문서(split-design.md, index-schema-draft.md)의 서술 관행 --
// "**99**", "**23개**"처럼 측정값을 굵게 강조 -- 를 "표에 실려야 할
// 수"의 기계 판독 가능한 표식으로 채택한다(§3 규칙1: 사람이 확인하는
// 게 아니라 기계가 목록을 만든다). 순수 숫자(쉼표 허용)만 굵게 감싼
// 경우만 잡는다 -- "**3R 정정**"처럼 숫자+문구가 섞인 굵게는 측정값
// 강조가 아니라 라운드 라벨이므로 제외한다(정규식이 저절로 배제:
// `**` 안쪽이 [0-9,]만이어야 매치).
const BOLD_NUMBER_RE = /\*\*([0-9][0-9,]*)\*\*/g;

export function extractBoldNumbers(text) {
  const spans = findFencedCodeSpans(text);
  const values = [];
  let m;
  const re = new RegExp(BOLD_NUMBER_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (isInsideAnySpan(m.index, spans)) continue;
    values.push(m[1].replace(/,/g, ""));
  }
  return values;
}

// ── 설계 제외 앵커 검증 ──────────────────────────────────────────────
// EXCLUDED_DESIGN_VALUES의 각 항목이 선언한 문서(path)에 선언한 리터럴
// 문자열(anchor)이 실제로 존재하는지 확인한다 -- "이 제외가 아직도
// 유효한 근거를 가리키고 있는가"의 실측. 앵커가 사라졌다면(문서가
// 바뀜) 그 제외는 더 이상 무엇을 가리키는지 불명확해진 것이므로 조용히
// "예전처럼 맞겠지"로 넘어가지 않고 결측 목록으로 반환한다(호출부가
// fail-closed로 다룬다).
export function verifyExclusionAnchors(docs, excludedEntries) {
  const byPath = new Map(docs.map((d) => [d.path, d.text]));
  const missing = [];
  for (const entry of excludedEntries) {
    const text = byPath.get(entry.path);
    if (typeof text !== "string" || !text.includes(entry.anchor)) {
      missing.push(entry);
    }
  }
  return missing;
}

// ── 누락(omission) 탐지 ─────────────────────────────────────────────
// 문서 본문에 굵게 강조된 측정 수 중 표(measuredValues)에 없는 것을
// "누락"으로 리포트한다. §3 규칙1 요구대로 조용히 빠지지 않는다 -- 0건
// 이어도 "0건"을 명시적 결과로 반환한다(호출부가 빈 배열을 "안 돌았다"
// 와 구별하도록).
//
// ★2R: 설계 제외값을 여기서 "값으로" 거르지 않는다(REVIEW 1R D 반려
// 원인). EXCLUDED_DESIGN_VALUES의 실제 자리(펜스 코드 블록 안 또는
// 굵게-강조가 아닌 평문)는 extractBoldNumbers가 애초에 절대 추출하지
// 않는 자리다(위 findFencedCodeSpans/BOLD_NUMBER_RE) -- 그래서 여기서
// 굵게 추출된 값이 제외 목록의 숫자와 우연히 같더라도, 그건 구조적으로
// 항상 "제외 목록이 가리키는 그 자리가 아닌 다른 자리"의 새 값이다.
// 값으로 거르면(1R의 버그) 그 다른 자리의 진짜 측정값까지 삼킨다 --
// 그래서 여기서는 measuredValues 하나만으로 판단하고, 제외 목록의
// "그 자리에 정말 있는가"는 별도로 verifyExclusionAnchors가 검증한다.
export function scanOmissions({ docs, measuredValues }) {
  if (!Array.isArray(docs)) {
    throw new Error("scanOmissions: docs는 [{path, text}] 배열이어야 함");
  }
  const measured = new Set(measuredValues);
  const omissions = [];
  for (const doc of docs) {
    const found = extractBoldNumbers(doc.text);
    const seenInDoc = new Set();
    for (const value of found) {
      if (measured.has(value)) continue;
      const key = `${doc.path}:${value}`;
      if (seenInDoc.has(key)) continue;
      seenInDoc.add(key);
      omissions.push({ path: doc.path, value });
    }
  }
  return omissions;
}

// ── 표 렌더링 ────────────────────────────────────────────────────────
// rows: [{ id, value, scope, command, output }] -- 순서 그대로 출력한다
// (id 오름차순은 호출부가 이미 보장, 여기서 재정렬하지 않음 -- 재정렬은
// "표시 순서가 실행 순서와 다를 수 있다"는 또 다른 혼선을 만든다).
// 표 셀 코드 스팬 안의 파이프는 GFM 규칙대로 이스케이프한다(review-r4:
// `\|`는 코드 스팬 안에서도 화면에 `|`로 렌더되는 올바른 표기 -- raw `|`는
// 열 구분자로 오독돼 표를 깨뜨린다).
//
// ★5R 수리(REVIEW 5R 반려): 예전 `/(?<!\\)\|/g`는 파이프 «바로 앞 한
// 글자」만 봐서, 백슬래시가 «짝수 개」 붙은 뒤의 파이프(`\\|` = 이스케이프된
// 백슬래시 + raw 파이프)를 «이미 이스케이프됨»으로 오인해 그냥 뒀다 --
// Prettier가 그 raw 파이프를 열 구분자로 읽어 표를 분해했다(코드포인트
// 92,92,124 재현). 올바른 판정은 «파이프 직전 연속 백슬래시 개수의 홀짝»
// 이다: 백슬래시 하나가 «다음 문자」를 이스케이프하므로,
//   - 홀수 개(`\|`, `\\\|`, ...) => 마지막 백슬래시가 파이프를 이스케이프한
//     것 => 이미 이스케이프됨 => 보존.
//   - 짝수 개(0 포함: `|`, `\\|`, `\\\\|`, ...) => 백슬래시들이 자기들끼리
//     짝을 이뤄 소진되고 파이프는 raw => 백슬래시 하나를 추가한다.
// `(\\*)\|`로 파이프 직전의 연속 백슬래시 런을 통째로 잡아 그 길이의 홀짝
// 으로 판정한다(음의 후방탐색은 한 글자만 보므로 이 홀짝을 표현할 수 없다).
function escapeTablePipes(text) {
  return text.replace(/(\\*)\|/g, (_match, backslashes) =>
    backslashes.length % 2 === 0 ? `${backslashes}\\|` : `${backslashes}|`,
  );
}

export function renderMarkdownTable(rows) {
  const header = "| ID | 수 | 범위·정의 | 명령 | 출력 |";
  const sep = "|---|---|---|---|---|";
  const lines = [header, sep];
  for (const row of rows) {
    const cmd = row.command ? `\`${escapeTablePipes(row.command)}\`` : "(산식)";
    lines.push(
      `| ${row.id} | ${row.value} | ${escapeTablePipes(row.scope)} | ${cmd} | \`${escapeTablePipes(String(row.output))}\` |`,
    );
  }
  return lines.join("\n");
}

// ── 산식(derive) 계산 ────────────────────────────────────────────────
// v: { [id]: number } -- 셸 실행으로 채워진 값들. derive 항목이 참조하는
// id가 아직 없으면 그 자체가 매니페스트 순서 오류이므로 던진다(조용히
// NaN을 만들지 않는다).
export function computeDerivedValues(manifest, valuesById) {
  const v = { ...valuesById };
  for (const entry of manifest) {
    if (typeof entry.derive !== "function") continue;
    v[entry.id] = entry.derive(v);
    if (!Number.isFinite(v[entry.id])) {
      throw new Error(
        `computeDerivedValues: ID ${entry.id} derive 결과가 유한수가 아님(${v[entry.id]}) -- 선행 ID 누락 가능성`,
      );
    }
  }
  return v;
}
