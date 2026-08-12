#!/usr/bin/env node
// HYK-238-gaps-table-1 -- CLI 래퍼. gaps-master-table-core.mjs의 순수
// 함수는 셸을 모른다; 이 파일이 매니페스트의 각 명령을 실제로 실행하고
// (§3 규칙3: 옮겨 적지 않고 실행한다 -- 재현성을 보장하기 위해, 대신
// 매 실행마다 CI 러너(수십 초)까지 도는 비용을 진다는 트레이드오프를
// §6에 기록), 두 원본 문서(split-design.md, index-schema-draft.md)를
// 읽어 굵게 강조된 측정값이 전부 표에 반영됐는지 검사한 뒤, 생성된 표를
// docs/known-gaps-master-table.generated.md에 쓴다.
//
// 사람이 칠 한 줄(북극성 1-B 요건 ①):
//   node scripts/check/generate-gaps-master-table.mjs
//
// 실행 위치 무관 -- 저장소 루트를 스스로 찾는다(§ placeholder 0 요건).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { format, resolveConfig } from "prettier";
import {
  MEASUREMENT_MANIFEST,
  EXCLUDED_DESIGN_VALUES,
  scanOmissions,
  verifyExclusionAnchors,
  renderMarkdownTable,
  computeDerivedValues,
} from "./gaps-master-table-core.mjs";

function repoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}

// bash 경로를 자기발견형으로 찾는다(placeholder 0 요건 -- Windows에서
// node의 기본 셸은 cmd.exe라 이 스크립트의 파이프 구문(git grep -E ...
// | grep -o ... | sort -u)이 그대로 안 돈다). $SHELL 먼저 보고, 흔한
// Git Bash 설치 경로들을 순서대로 실측 -- 하나도 없으면 조용히 넘어가지
// 않고 던진다(어떤 셸을 썼는지 불명확한 채로 수를 내면 §0-1 계약 위반).
function resolveBashPath() {
  const candidates = [
    process.env.SHELL,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "/usr/bin/bash",
    "/bin/bash",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `resolveBashPath: bash 실행 파일을 못 찾음(시도: ${candidates.join(", ")}) -- $SHELL을 Git Bash 경로로 지정하거나 수동 확인 필요`,
  );
}

const BASH_PATH = resolveBashPath();

// 셸 명령을 저장소 루트에서 실행하고 출력 마지막 줄의 마지막 정수
// 토큰을 뽑는다(git grep -c 출력이 "path:99" 형태이거나, wc -l이
// "  99"처럼 앞에 공백을 붙이는 방언 차이를 흡수하기 위함). 정수를 못
// 찾으면 던진다 -- 조용히 0으로 접지 않는다(vacuous pass 방지, 이
// 저장소의 다른 core들과 동일 원칙).
function runAndExtractInt(command, cwd) {
  const stdout = execSync(command, { cwd, encoding: "utf8", shell: BASH_PATH });
  const lastLine = stdout.trim().split("\n").pop() ?? "";
  const match = lastLine.match(/(-?\d+)\s*$/);
  if (!match) {
    throw new Error(
      `runAndExtractInt: 명령 출력에서 정수를 못 찾음 -- command="${command}" stdout="${stdout}"`,
    );
  }
  return { value: Number(match[1]), rawOutput: stdout.trim() };
}

// 정본 CI 러너는 한 번만 돈다(수십 초 소요) -- ID22~25 네 값을 그
// 하나의 실행 출력에서 파싱한다. 별도로 4번 돌리면 4배 느려질 뿐 아니라
// 러너 자체가 비결정적 타이밍에 좌우될 여지도 늘어난다.
function runCiOnce(cwd) {
  let stdout;
  try {
    stdout = execSync("node scripts/check/isolated-suite-runner.mjs 2>&1", {
      cwd,
      encoding: "utf8",
      shell: BASH_PATH,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // 러너 자체가 비0 종료해도(fail>0 등) 출력은 이미 존재 -- 그 출력에서
    // 그대로 파싱한다(§5 "어긋나면 그대로 보고", 여기서 멈추지 않는다).
    stdout = err.stdout ?? "";
  }
  const fields = {};
  for (const field of ["tests", "pass", "fail", "skipped"]) {
    const re = new RegExp(`^ℹ ${field} (-?\\d+)\\s*$`, "m");
    const m = stdout.match(re);
    if (!m) {
      throw new Error(
        `runCiOnce: 출력에서 '${field}' 필드를 못 찾음 -- isolated-suite-runner.mjs 출력 형식이 바뀌었을 수 있음`,
      );
    }
    fields[field] = Number(m[1]);
  }
  return { fields, rawOutput: stdout };
}

// MEASUREMENT_MANIFEST를 두 패스로 훑어 valuesById/outputById/derived를
// 채운다(1차: ci·shell 명령 실행, 2차: derive 함수). main()에서 그대로
// 뽑아낸 것 -- 동작은 바꾸지 않았다(§3 비타협).
function measureAll(cwd) {
  const valuesById = {};
  const outputById = {};

  let ci = null;
  for (const entry of MEASUREMENT_MANIFEST) {
    if (typeof entry.derive === "function") continue; // 2차 패스에서 채움
    if (entry.shell === "ci") {
      if (!ci) ci = runCiOnce(cwd);
      valuesById[entry.id] = ci.fields[entry.ciField];
      outputById[entry.id] = String(ci.fields[entry.ciField]);
      continue;
    }
    const { value, rawOutput } = runAndExtractInt(entry.command, cwd);
    valuesById[entry.id] = value;
    outputById[entry.id] = rawOutput;
  }

  const derived = computeDerivedValues(MEASUREMENT_MANIFEST, valuesById);
  for (const entry of MEASUREMENT_MANIFEST) {
    if (typeof entry.derive !== "function") continue;
    outputById[entry.id] = String(derived[entry.id]);
  }

  return { outputById, derived };
}

function buildRows(derived, outputById) {
  return MEASUREMENT_MANIFEST.map((entry) => ({
    id: entry.id,
    value: derived[entry.id],
    scope: entry.scope,
    command: entry.command ?? null,
    output: outputById[entry.id],
  }));
}

function loadDesignDocs(cwd) {
  const docPaths = [
    "docs/known-gaps-split-design.md",
    "docs/known-gaps-index-schema-draft.md",
  ];
  return docPaths.map((p) => ({
    path: p,
    text: readFileSync(join(cwd, p), "utf8"),
  }));
}

// 2R 수리(REVIEW 1R D): 제외는 더 이상 값으로 굵게-매치를 거르지
// 않는다(gaps-master-table-core.mjs scanOmissions 주석 참조) -- 대신
// 제외 목록이 가리키는 자리(anchor)가 그 문서에 실제로 있는지 먼저
// 검증한다. 앵커가 사라졌으면 제외 근거 자체가 무효화된 것이므로
// fail-closed로 던진다(조용히 "예전처럼 맞겠지"로 넘어가지 않음).
function assertExclusionAnchors(docs) {
  const missingAnchors = verifyExclusionAnchors(docs, EXCLUDED_DESIGN_VALUES);
  if (missingAnchors.length > 0) {
    throw new Error(
      `generate-gaps-master-table: 설계 제외 앵커 검증 실패 -- ${missingAnchors
        .map((e) => `\`${e.value}\`(${e.path})`)
        .join(
          ", ",
        )}의 근거 문구가 더 이상 문서에 없음. 문서가 바뀌었으면 EXCLUDED_DESIGN_VALUES의 anchor를 갱신해야 함.`,
    );
  }
}

// main()의 리포트 조립부를 그대로 옮긴 것 -- 문자열/순서/조건 전부
// 동일(§3 비타협: 동작을 바꾸지 않는다).
function buildReportLines({
  targetFile,
  table,
  measuredRowCount,
  excludedCount,
  omissions,
}) {
  const reportLines = [];
  reportLines.push("# known-gaps 마스터 표 (기계 생성)");
  reportLines.push("");
  reportLines.push(
    `생성기: \`node scripts/check/generate-gaps-master-table.mjs\` · 대상: \`${targetFile}\` · 생성 시각은 이 파일 자체에 기록하지 않는다(§2-2 index-schema-draft.md 주의사항과 동일 이유 -- 판정 로직이 타임스탬프에 의존하면 안 되므로, 재실행마다 diff가 나는 필드를 산출물에 넣지 않는다).`,
  );
  reportLines.push("");
  reportLines.push("## 마스터 표");
  reportLines.push("");
  reportLines.push(table);
  reportLines.push("");
  reportLines.push("## 메타 수(코드로 계산, 손으로 세지 않음)");
  reportLines.push("");
  reportLines.push(`- 표에 실린 측정 행 수: **${measuredRowCount}**`);
  reportLines.push(`- 설계 제외 값 수: **${excludedCount}**`);
  reportLines.push("");
  reportLines.push("## 설계 제외 목록(측정 아님, §2 규칙4)");
  reportLines.push("");
  reportLines.push(
    `앵커 검증(그 근거 문구가 선언된 문서에 실제로 있는지): **${excludedCount}/${excludedCount} 확인**(2R, 값이 아니라 자리로 묶음 -- §2R 참조).`,
  );
  reportLines.push("");
  if (excludedCount === 0) {
    reportLines.push("(없음)");
  } else {
    for (const ex of EXCLUDED_DESIGN_VALUES) {
      reportLines.push(
        `- \`${ex.value}\` -- ${ex.source} -- ${ex.reason} -- 앵커: \`${ex.anchor}\`(${ex.path})`,
      );
    }
  }
  reportLines.push("");
  reportLines.push("## 누락 리포트(문서 본문 강조 수 vs 표)");
  reportLines.push("");
  reportLines.push(
    "정의: `docs/known-gaps-split-design.md`·`docs/known-gaps-index-schema-draft.md`에서 " +
      '펜스 코드 블록 밖에 `**N**` 형태로 굵게 강조된 순수 숫자를 "표에 실려야 할 측정값"으로 ' +
      "간주한다(두 문서의 실제 서술 관행). 표에 없으면 누락으로 리포트한다 -- ★2R: 설계 제외 목록은 " +
      "더 이상 이 판단을 거르지 않는다(위 앵커 검증으로만 쓰임, REVIEW 1R D 반려 수리). " +
      "오탐 주장 범위: fixture 3건 + 현재 실문서 2건에서 오탐 0(일반적인 오탐률 0 주장 아님).",
  );
  reportLines.push("");
  if (omissions.length === 0) {
    reportLines.push("누락 0건.");
  } else {
    for (const o of omissions) {
      reportLines.push(
        `- **RED** \`${o.value}\` -- ${o.path}에 강조돼 있으나 표·제외 목록 어디에도 없음`,
      );
    }
  }
  reportLines.push("");
  return reportLines;
}

// 생성기 출력을 prettier 포맷터에 직접 통과시켜 확정한다(§2 (나) --
// review-r4 수리: 파이프 이스케이프만으로는 열 너비 정렬까지 맞출 수
// 없어 `prettier --check`가 계속 실패했다. 정렬을 손으로 재구현하는
// 대신, 같은 prettier 엔진을 파이프라인 안에서 그대로 불러 «prettier가
// 원하는 바이트」와 항상 바이트 단위로 같게 만든다 -- 그 결과 결정성
// 계약이 «생성기 원문 지문」에서 «prettier 통과 후 지문」으로 옮겨간다).
async function formatGeneratedMarkdown(raw, outPath) {
  const config = (await resolveConfig(outPath)) ?? {};
  return format(raw, { ...config, filepath: outPath });
}

async function main() {
  const cwd = repoRoot();
  const targetFile = "docs/enforcement-known-gaps.md";

  const { outputById, derived } = measureAll(cwd);
  const rows = buildRows(derived, outputById);

  // 메타 수(표 자신의 크기·제외 개수)는 코드가 rows 배열 길이를 세어
  // 계산한다 -- 5R이 실패한 지점(사람이 "6개"를 손으로 세다가 "5개"와
  // 모순)이 구조적으로 다시 일어날 수 없다: rows.length는 셀 필요가
  // 없다, 배열 자체의 속성이다.
  const measuredRowCount = rows.length;
  const excludedCount = EXCLUDED_DESIGN_VALUES.length;

  const measuredValues = new Set(rows.map((r) => String(r.value)));

  const docs = loadDesignDocs(cwd);
  assertExclusionAnchors(docs);

  const omissions = scanOmissions({ docs, measuredValues });

  const table = renderMarkdownTable(rows);

  const reportLines = buildReportLines({
    targetFile,
    table,
    measuredRowCount,
    excludedCount,
    omissions,
  });

  const outPath = join(cwd, "docs/known-gaps-master-table.generated.md");
  const formatted = await formatGeneratedMarkdown(
    reportLines.join("\n") + "\n",
    outPath,
  );
  writeFileSync(outPath, formatted, "utf8");

  console.log(formatted);
  console.log(`\n(생성 파일: docs/known-gaps-master-table.generated.md)`);

  if (omissions.length > 0) {
    console.error(
      `\ngenerate-gaps-master-table: RED -- 누락 ${omissions.length}건(위 참조). 도달 경로: 현재 이 CLI의 비0 종료 코드뿐이다 -- CI/훅 결선은 없다(§ 북극성 1-B 요건③, 정직 기록).`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/generate-gaps-master-table.mjs");
if (invokedDirectly) {
  await main();
}

export { runAndExtractInt, runCiOnce };
