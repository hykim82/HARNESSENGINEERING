// HYK-238-gaps-table-1 -- gaps-master-table-core.mjs 단위 시험.
// 셸 실행·실제 저장소 파일 I/O 0(코어는 zero-import 계약이므로 시험도
// 그 경계를 지킨다) -- 전부 인메모리 fixture로 결정적으로 돈다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MEASUREMENT_MANIFEST,
  EXCLUDED_DESIGN_VALUES,
  extractBoldNumbers,
  findFencedCodeSpans,
  scanOmissions,
  verifyExclusionAnchors,
  renderMarkdownTable,
  computeDerivedValues,
} from "./gaps-master-table-core.mjs";

// ⓐ 표 생성이 결정적인가(같은 입력 -> 같은 표)
test("ⓐ renderMarkdownTable: 같은 rows -> byte-identical 출력(결정적)", () => {
  const rows = [
    {
      id: 1,
      value: 99,
      scope: "표 행 총수",
      command: "grep -c ...",
      output: "99",
    },
    { id: 2, value: 23, scope: "산문 절 수", command: null, output: "23" },
  ];
  const a = renderMarkdownTable(rows);
  const b = renderMarkdownTable(rows.map((r) => ({ ...r })));
  assert.equal(a, b);
  assert.match(a, /\| 1 \| 99 \|/);
});

// ★5R 신설(REVIEW 5R 반려: escapeTablePipes가 파이프 앞 한 글자만 봐서
// 백슬래시 짝수 뒤 raw 파이프를 놓쳤고, 그걸 잡는 시험이 하나도 없어
// "함수를 통째로 지워도 초록"이었다). 아래 4건은 검토가 지정한 경계를
// scope·command·output 세 필드 모두에서 «렌더된 셀 문자열 전체 대조」로
// 고정한다 -- split("\n")[2]가 데이터 행(0=헤더, 1=구분자, 2=행).
// 함수 제거(항등) 또는 홀짝 판정 파기(예전 `(?<!\\)`) 시 ⓕ2·ⓕ3이 RED가
// 된다(직접 변이 확인은 coder.md에 기록).

// ⓕ1 홀수 백슬래시(이미 이스케이프됨) 보존 -- `\|`는 그대로. 과잉
// 이스케이프(`\\|`)로 만들면 이 시험이 RED가 된다.
test("ⓕ escapeTablePipes(홀수 백슬래시 보존): scope·command·output의 `\\|`는 그대로", () => {
  const rows = [
    { id: 1, value: 1, scope: "a\\|b", command: "c\\|d", output: "e\\|f" },
  ];
  const dataRow = renderMarkdownTable(rows).split("\n")[2];
  assert.equal(dataRow, "| 1 | 1 | a\\|b | `c\\|d` | `e\\|f` |");
});

// ⓕ2 짝수 백슬래시 뒤 raw 파이프 -- `\\|`(이스케이프된 백슬래시 + raw
// 파이프)는 `\\\|`로 백슬래시 하나가 추가돼야 한다. 이것이 5R 반려의
// 핵심 경계다. 예전 한 글자 후방탐색은 여기서 파이프를 그냥 뒀다.
test("ⓕ escapeTablePipes(짝수 백슬래시 뒤 추가): scope·command·output의 `\\\\|` → `\\\\\\|`", () => {
  const rows = [
    {
      id: 2,
      value: 2,
      scope: "a\\\\|b",
      command: "c\\\\|d",
      output: "e\\\\|f",
    },
  ];
  const dataRow = renderMarkdownTable(rows).split("\n")[2];
  assert.equal(dataRow, "| 2 | 2 | a\\\\\\|b | `c\\\\\\|d` | `e\\\\\\|f` |");
});

// ⓕ3 연속 raw 파이프 -- 여러 개가 전부 각각 이스케이프돼야 한다(`||` →
// `\|\|`). 함수를 지우면 `||`가 그대로 남아 RED.
test("ⓕ escapeTablePipes(연속 raw 파이프): scope·command·output의 `||` → `\\|\\|`", () => {
  const rows = [
    { id: 3, value: 3, scope: "a||b", command: "c||d", output: "e||f" },
  ];
  const dataRow = renderMarkdownTable(rows).split("\n")[2];
  assert.equal(dataRow, "| 3 | 3 | a\\|\\|b | `c\\|\\|d` | `e\\|\\|f` |");
});

// ⓕ4 코드스팬 «밖」 표 구분 파이프 무변경 -- 셀 내용에 파이프가 없을 때,
// renderMarkdownTable이 직접 찍는 열 구분자 `|`는 raw로 남아야 한다(셀
// 내용만 이스케이프 대상이지 표 구조가 아니다). 구조 파이프까지 escape
// 하면(`\|`) 표가 깨진다.
test("ⓕ escapeTablePipes(구조 파이프 무변경): 열 구분자 `|`는 raw로 남는다", () => {
  const rows = [
    {
      id: 4,
      value: 4,
      scope: "no pipes here",
      command: "grep -c x",
      output: "42",
    },
  ];
  const [header, sep, dataRow] = renderMarkdownTable(rows).split("\n");
  assert.equal(header, "| ID | 수 | 범위·정의 | 명령 | 출력 |");
  assert.equal(sep, "|---|---|---|---|---|");
  assert.equal(dataRow, "| 4 | 4 | no pipes here | `grep -c x` | `42` |");
  // 구조 파이프가 이스케이프되지 않았음을 명시적으로도 확인한다.
  assert.ok(!header.includes("\\|"), "헤더 구분자는 raw `|`여야 한다");
  assert.ok(!dataRow.includes("\\|"), "행 구분자는 raw `|`여야 한다");
});

// ⓑ 누락 탐지 -- 본문에 있는데 표에 없는 수를 일부러 만들어 리포트되는지
test("ⓑ scanOmissions: 표에 없는 굵은 수는 누락으로 리포트된다", () => {
  const docs = [
    {
      path: "fixture-a.md",
      text: "측정 결과는 **99**행이었다. 그리고 별도로 **777**도 실측했다.",
    },
  ];
  const measuredValues = new Set(["99"]);
  const omissions = scanOmissions({ docs, measuredValues });
  assert.equal(omissions.length, 1);
  assert.deepEqual(omissions[0], { path: "fixture-a.md", value: "777" });
});

test("ⓑ scanOmissions: 표에 있는 수는 누락으로 잡히지 않는다(정상 케이스)", () => {
  const docs = [{ path: "fixture-b.md", text: "결과는 **23**개였다." }];
  const omissions = scanOmissions({ docs, measuredValues: new Set(["23"]) });
  assert.deepEqual(omissions, []);
});

test("ⓑ scanOmissions: 같은 문서에서 같은 누락 값이 여러 번 나와도 1건으로 합친다", () => {
  const docs = [
    { path: "fixture-c.md", text: "**555**이 나왔다. 다시 봐도 **555**다." },
  ];
  const omissions = scanOmissions({ docs, measuredValues: new Set() });
  assert.equal(omissions.length, 1);
});

// ⓒ 제외 규칙(2R 수리 -- REVIEW 1R D 반려: "값만으로 거르면 다른 자리의
// 진짜 측정값까지 삼킨다"). 이제 제외는 값 기반 필터가 아니라 앵커
// 존재 검증으로만 쓰인다.
test("ⓒ EXCLUDED_DESIGN_VALUES: 각 항목이 근거(source·reason·path·anchor)를 갖고 있다(조용히 빼지 않음)", () => {
  assert.ok(EXCLUDED_DESIGN_VALUES.length > 0);
  for (const entry of EXCLUDED_DESIGN_VALUES) {
    assert.equal(typeof entry.value, "string");
    assert.ok(entry.source.length > 0);
    assert.ok(entry.reason.length > 0);
    assert.ok(entry.path.length > 0);
    assert.ok(entry.anchor.length > 0);
  }
});

test("ⓒ verifyExclusionAnchors: 앵커가 선언된 문서에 실제로 있으면 결측 0건", () => {
  const docs = [
    {
      path: "fixture-anchor.md",
      text: '```jsonc\n{ "schemaVersion": 1, "shardByteLimit": 204800 }\n```\n상한(예: 200KiB 상세)',
    },
  ];
  const excludedEntries = [
    { value: "1", path: "fixture-anchor.md", anchor: '"schemaVersion": 1' },
    {
      value: "204800",
      path: "fixture-anchor.md",
      anchor: '"shardByteLimit": 204800',
    },
    { value: "200", path: "fixture-anchor.md", anchor: "상한(예: 200KiB" },
  ];
  assert.deepEqual(verifyExclusionAnchors(docs, excludedEntries), []);
});

test("ⓒ verifyExclusionAnchors: 앵커 문구가 사라지면(문서 변경) 결측으로 잡는다(fail-closed)", () => {
  const docs = [
    { path: "fixture-anchor.md", text: "이 문서엔 그 문구가 없다." },
  ];
  const excludedEntries = [
    { value: "1", path: "fixture-anchor.md", anchor: '"schemaVersion": 1' },
  ];
  const missing = verifyExclusionAnchors(docs, excludedEntries);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].value, "1");
});

test("ⓒ verifyExclusionAnchors: 선언된 path의 문서 자체가 docs 목록에 없으면 결측으로 잡는다", () => {
  const docs = [{ path: "other.md", text: '"schemaVersion": 1' }];
  const excludedEntries = [
    { value: "1", path: "fixture-anchor.md", anchor: '"schemaVersion": 1' },
  ];
  assert.equal(verifyExclusionAnchors(docs, excludedEntries).length, 1);
});

// ★2R 신설(REVIEW 1R §3-2 승인 조건: "제외값과 같은 숫자가 다른 자리에
// 진짜 측정값으로 나타나면 누락 리포트+exit1, 원래 설계 제안값 3건은
// 여전히 조용히 통과 -- 둘을 같은 시험에서 대조하라"). 실제
// EXCLUDED_DESIGN_VALUES를 그대로 써서, 그 값들의 진짜 앵커 자리(펜스
// 코드/평문 -- 굵게 아님)는 조용히 통과하고, 같은 숫자가 "다른 자리"에
// 굵게 나타나면 RED가 됨을 한 시험에서 양방향으로 증명한다.
test("ⓓ 경계 시험(양방향 대조): 설계 제외값의 원래 자리는 통과하고, 같은 숫자가 다른 자리에 굵게 나타나면 RED", () => {
  const indexDocText = [
    "```jsonc",
    '{ "schemaVersion": 1, "shardByteLimit": 204800, }',
    "```",
    "",
    "그런데 별도로 gap 번호가 **1**개 늘었다는 새 측정값이 여기 등장했다.",
  ].join("\n");
  const splitDocText =
    "shard 상한(예: 200KiB — 256KiB 한도에 여유 확보)을 넘으면 새 shard.";
  const docs = [
    { path: "docs/known-gaps-index-schema-draft.md", text: indexDocText },
    { path: "docs/known-gaps-split-design.md", text: splitDocText },
  ];

  // 원래 설계 제안값 3건(펜스 안 1·204800, 평문 200KiB)의 자리는
  // extractBoldNumbers가 애초에 추출하지 않으므로 앵커 검증만 통과하면
  // 조용히 넘어간다 -- 값 기반 필터가 전혀 관여하지 않는다.
  const missingAnchors = verifyExclusionAnchors(docs, EXCLUDED_DESIGN_VALUES);
  assert.deepEqual(
    missingAnchors,
    [],
    "설계 제안값 3건의 앵커는 이 fixture에 그대로 있어야 한다",
  );

  // 그런데 이 문서에는 "다른 자리"에 굵은 **1**이 새로 등장한다 --
  // measuredValues가 비어 있으면(=아직 표에 없는 신규 측정값) 이건
  // 반드시 누락(RED)으로 잡혀야 한다. 1R의 버그는 정확히 이 케이스를
  // excludedValues Set(값 "1")으로 조용히 삼켰다.
  const omissions = scanOmissions({ docs, measuredValues: new Set() });
  assert.equal(
    omissions.length,
    1,
    "다른 자리의 굵은 **1**은 RED로 잡혀야 한다(1R 버그 재발 방지)",
  );
  assert.deepEqual(omissions[0], {
    path: "docs/known-gaps-index-schema-draft.md",
    value: "1",
  });

  // 대조군: 그 굵은 **1**이 진짜로 표에 반영되면(measuredValues에 "1"
  // 추가) 더 이상 누락이 아니다 -- 정상 동작(오탐 아님) 확인.
  const afterAddedToTable = scanOmissions({
    docs,
    measuredValues: new Set(["1"]),
  });
  assert.deepEqual(
    afterAddedToTable,
    [],
    "표에 반영되면 더 이상 누락이 아니어야 한다",
  );
});

// ⓔ 오탐 분모 N>=3 -- ★2R: "일반적으로 오탐 0"이 아니라 "이 fixture
// 3건 + 현재 실문서 2건에서 오탐 0"이라는 한정 주장으로만 적는다
// (REVIEW E 판정: 이 분모로 일반 주장은 할 수 없음).
test("ⓔ scanOmissions: fixture 3건에서 오탐 0건(N=3, 한정 주장 -- 일반화 아님)", () => {
  const normalDocs = [
    { path: "normal-1.md", text: "표 행 **99**개, 고유 **99**개." },
    { path: "normal-2.md", text: "산문 절은 **23**개였고 결번은 **0**건." },
    {
      path: "normal-3.md",
      text: "```bash\n# 코드 블록 안의 **가짜강조**는 마크다운으로 렌더 안 되므로 무시\ngrep -c X # **404**\n```\n실제 강조는 **99**뿐이다.",
    },
  ];
  const measuredValues = new Set(["99", "23", "0"]);
  const omissions = scanOmissions({ docs: normalDocs, measuredValues });
  assert.deepEqual(
    omissions,
    [],
    "이 fixture 3건에서는 오탐 없어야 한다(일반화 주장 아님)",
  );
});

// 코드 펜스 안의 굵은 수는 측정값 강조로 오인하지 않는다
test("extractBoldNumbers: 펜스 코드 블록 안의 **N**은 추출하지 않는다", () => {
  const text = [
    "본문 강조 **1** 하나.",
    "```bash",
    "echo **2** # 코드 블록 안, 무시돼야 함",
    "```",
    "다시 본문 강조 **3**.",
  ].join("\n");
  assert.deepEqual(extractBoldNumbers(text), ["1", "3"]);
});

test("extractBoldNumbers: 숫자+문구가 섞인 굵게(라운드 라벨 등)는 제외한다", () => {
  const text = "**3R 정정** 문단 다음에 실제 측정값 **42**가 나온다.";
  assert.deepEqual(extractBoldNumbers(text), ["42"]);
});

test("extractBoldNumbers: 쉼표 포함 숫자는 쉼표를 제거해 정규화한다", () => {
  const text = "바이트 크기는 **347,058**이다.";
  assert.deepEqual(extractBoldNumbers(text), ["347058"]);
});

test("findFencedCodeSpans: 홀수 개의 펜스(닫히지 않은 블록)는 마지막 미완성 구간을 span에 넣지 않는다", () => {
  const text = "```bash\necho hi\n```\n본문\n```bash\n미완성";
  const spans = findFencedCodeSpans(text);
  assert.equal(spans.length, 1);
});

// computeDerivedValues -- 산식 체인(ID13/14/15가 ID10/11/2/12를 참조)
test("computeDerivedValues: derive 항목이 선행 값으로부터 정확히 계산된다", () => {
  const manifest = [
    { id: 10, scope: "a" },
    { id: 11, scope: "b" },
    { id: 12, scope: "c" },
    { id: 13, scope: "10+11", derive: (v) => v[10] + v[11] },
    { id: 14, scope: "2-12", derive: (v) => v[2] - v[12] },
  ];
  const result = computeDerivedValues(manifest, {
    2: 99,
    10: 90,
    11: 5,
    12: 1,
  });
  assert.equal(result[13], 95);
  assert.equal(result[14], 98);
});

test("computeDerivedValues: 선행 ID가 없어 NaN이 나오면 조용히 넘어가지 않고 던진다", () => {
  const manifest = [{ id: 99, scope: "broken", derive: (v) => v[1] + v[2] }];
  assert.throws(() => computeDerivedValues(manifest, {}));
});

// 매니페스트 자체의 구조 불변식 -- id 중복·연속성
test("MEASUREMENT_MANIFEST: id가 중복 없이 오름차순 1..N으로 이어진다", () => {
  const ids = MEASUREMENT_MANIFEST.map((e) => e.id);
  const expected = Array.from({ length: ids.length }, (_, i) => i + 1);
  assert.deepEqual(ids, expected);
});

test("MEASUREMENT_MANIFEST: shell 항목은 command(또는 ci)를, derive 항목은 derive 함수를 갖는다(정확히 하나)", () => {
  for (const entry of MEASUREMENT_MANIFEST) {
    const hasDerive = typeof entry.derive === "function";
    const hasCommand =
      typeof entry.command === "string" || entry.shell === "ci";
    assert.notEqual(
      hasDerive,
      hasCommand,
      `ID ${entry.id}: derive/command 중 정확히 하나만 있어야 함`,
    );
  }
});
