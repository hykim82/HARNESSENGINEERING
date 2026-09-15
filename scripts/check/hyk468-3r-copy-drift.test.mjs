// HYK-468 3R §2-2 -- P1-2의 진짜 수리. header-task-id-shared.mjs(정본)이
// 자기 헤더에서 이미 설명하듯, task_id 구조적 선행 맥락 규칙은 「네 벌
// (정본 + 실제 독자 3)이 갈라지면 회귀」라는 계약으로 유지된다 -- 그런데
// 2R까지는 그 바이트 동일성을 «기계로» 단정하는 시험이 하나도 없었다
// (검토자 REVIEW-r27.md 표적 2: relay는 정본에 없는 `|^<!--` 대안이 더
// 있었고, admission은 이 규칙 자체가 없었다 -- 지정 시험선 54/54 PASS가
// 이 드리프트를 하나도 잡지 못했다). ⇒ 이 파일은 STRUCTURAL_LINE_RE
// 정규식과 hasStructuralPredecessor 함수 본문 «둘 다»가 정본과 네 벌
// 전부 바이트 동일함을 단정하고, «같은 대조 함수»로 한 벌이라도 한 글자
// 달라지면(되돌림 변이) RED가 됨을 직접 보인다.
//
// 정본이 이 네 벌을 "하나를 import하게" 만들지 않는 이유(정본 헤더
// 그대로): 세 독자 모두 각자 별도의 mutation 시험이 고정 sibling 파일
// 목록으로 격리 clone하므로, 새 import를 추가하면 MODULE_NOT_FOUND로
// 깨진다(admission-completion-worktree-isolation.test.mjs·
// hyk396-open-axis.test.mjs, 2R 실측) -- 그래서 "같은 함수를 쓰게
// 한다"가 아니라 "네 벌을 바이트 동일하게 유지하고 그 동일성을 기계로
// 지킨다"가 이 계약의 실제 형태다.
//
// HYK-468 4R §2-1 (P1, 검토자 REVIEW-r28.md 반려 재수리) -- 3R까지의
// 위 STRUCTURAL_LINE_RE 전용 GREEN 시험은 «손으로 고른 비교 항목 하나»였다.
// relay-handshake.mjs 507행의 task_id 줄 정규식(정본에서는 TASK_ID_LINE_RE
// 라는 이름의 규칙 상수지만, 세 독자 모두 이름 없이 인라인으로만 있었다)은
// 그 손으로 고른 목록에 애초에 오를 자리가 없었고, 그래서 `\s*`로 갈라져
// NBSP·전각공백·EM공백·VT·FF에 대해 fail-open이 나도록 회귀했는데도 이
// 시험은 계속 GREEN이었다. 이 라운드는 "STRUCTURAL_LINE_RE 항목을 하나
// 더 늘리는" 대신 "정본이 export하는 규칙 상수 객체(RULE_CONSTANTS)를
// «순회»해서, 그 안의 모든 항목을 이름으로 찾아 대조"하도록 구조를
// 바꾼다 -- 정본이 세 번째 규칙 상수를 export에 추가하면, 이 시험 파일을
// 한 글자도 고치지 않아도 그 항목이 자동으로 대조 대상이 된다(아래
// "순회 증명(합성)" 시험이 실제로 그 성질만 떼어 기계로 보인다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RULE_CONSTANTS } from "./header-task-id-shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 정본을 첫 자리에 -- 함수 본문 축(아래 GREEN 두 번째 시험)은 여전히
// "네 벌(정본 포함) 소스 텍스트를 서로 대조"하는 3R 방식 그대로다(정본이
// hasStructuralPredecessor 함수 자체를 export하지 않으므로 -- coder-
// task.md §2-1 "함수 본문 축의 기존 대조는 유지한다").
const COPY_PATHS = [
  {
    name: "header-task-id-shared.mjs (정본)",
    path: join(HERE, "header-task-id-shared.mjs"),
  },
  { name: "relay-handshake.mjs", path: join(HERE, "relay-handshake.mjs") },
  {
    name: "dispatch-gate-decision.mjs",
    path: join(HERE, "dispatch-gate-decision.mjs"),
  },
  {
    name: "admission-completion-adapter.mjs",
    path: join(HERE, "admission-completion-adapter.mjs"),
  },
];

// 규칙 상수 순회 축(§2-1 신설)은 «실제 독자 셋»만 본다 -- 정본은 이제
// RULE_CONSTANTS를 직접 import해 살아있는 값으로 쓰므로, 정본 자신을
// 소스 텍스트로 다시 추출해 대조할 필요가 없다(같은 바인딩이라 갈라질
// 수 없다).
const READER_PATHS = [
  { name: "relay-handshake.mjs", path: join(HERE, "relay-handshake.mjs") },
  {
    name: "dispatch-gate-decision.mjs",
    path: join(HERE, "dispatch-gate-decision.mjs"),
  },
  {
    name: "admission-completion-adapter.mjs",
    path: join(HERE, "admission-completion-adapter.mjs"),
  },
];

// 사본에 정본과 «같은 이름»의 규칙 상수가 없는 경우를 위한 명시적 예외
// 목록(coder-task.md §2-1 요구: "없음은 통과가 아니라 실패"). 오늘은
// 0건이다 -- 정본이 export하는 두 상수(TASK_ID_LINE_RE, STRUCTURAL_LINE_RE)
// 모두 이 라운드에서 세 독자 전부에 같은 이름으로 옮겨졌다("<독자 파일명>::
// <상수 이름>" 꼴 문자열을 추가하고 사유를 반드시 주석으로 남겨라).
const MISSING_COPY_EXCEPTIONS = new Set([]);

// `const <name> = <값>;` 선언의 우변을 그대로 뽑는다 -- 파일마다 그 앞뒤
// 주석/줄번호가 달라도, 그리고 상수 «이름»이 달라도 이 한 함수로 어느
// 이름이든 뽑는다(3R의 extractStructuralLineRe를 이름 파라미터화한 것 --
// 이름을 하드코딩하지 않는 것이 "목록이 아니라 순회"의 실제 구현이다).
function extractNamedConst(src, name) {
  const re = new RegExp(`^const ${name} = (.+);\\s*$`, "m");
  const m = src.match(re);
  if (!m) return null;
  return m[1];
}

// hasStructuralPredecessor 함수 «본문»(정의 첫 줄부터 짝이 맞는 닫는
// 중괄호까지)을 중괄호 균형으로 직접 뽑는다 -- 정규식 기반 비탐욕 매치는
// 내부에 `{`/`}`가 하나라도 늘면 조용히 잘못된 경계를 잡을 수 있어서,
// 이 축(드리프트 검사 그 자체)만큼은 문자열 스캔으로 정확히 짠다.
function extractHasStructuralPredecessor(src) {
  const marker = "function hasStructuralPredecessor(lines, idx) {";
  const start = src.indexOf(marker);
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return src.slice(start, i);
}

// GREEN·RED 양쪽이 «같은» 대조 함수를 쓴다 -- 이 함수 자체가 시험의
// 판정 지점이다: sources[0]을 정본으로 삼아 나머지 전부와 extractor
// 결과를 대조하고, 하나라도 다르면 던진다. (함수 본문 축 전용, 3R 그대로.)
function assertAllByteIdentical(sources, extractor, axisLabel) {
  const values = sources.map((s) => ({
    name: s.name,
    value: extractor(s.src),
  }));
  const canonical = values[0].value;
  assert.ok(
    canonical,
    `정본 ${axisLabel}을 찾지 못했다 -- 시험 앵커 자체가 깨졌다`,
  );
  for (const v of values) {
    assert.equal(
      v.value,
      canonical,
      `${v.name}의 ${axisLabel}이 정본과 다르다: "${v.value}" !== "${canonical}"`,
    );
  }
  return values;
}

// 규칙 상수 순회 축의 판정 지점 -- GREEN 시험과 아래 "순회 증명(합성)" RED
// 시험이 «같은» 이 함수를 쓴다(3R의 assertAllByteIdentical과 같은 원칙:
// 판정 로직 자체가 시험 대상이므로 GREEN·RED가 그 로직을 공유해야 증거가
// 된다). `ruleConstants`는 { 이름: RegExp } 객체 -- 이름을 하드코딩하지
// 않고 `Object.entries`로 순회하는 것이 "목록이 아니라 순회"의 실물이다.
function assertRuleConstantsAcrossReaders(ruleConstants, readers, exceptions) {
  const report = {};
  for (const [name, canonicalValue] of Object.entries(ruleConstants)) {
    const canonicalText = canonicalValue.toString();
    report[name] = { canonical: canonicalText };
    for (const reader of readers) {
      const exceptionKey = `${reader.name}::${name}`;
      const value = extractNamedConst(reader.src, name);
      if (value === null) {
        assert.ok(
          exceptions.has(exceptionKey),
          `${reader.name}에 정본 규칙 상수 ${name}과 같은 이름이 없다 -- ` +
            `없음은 통과가 아니라 실패다(예외가 정당하면 ` +
            `MISSING_COPY_EXCEPTIONS에 "${exceptionKey}"를 사유와 함께 ` +
            `명시적으로 올려라)`,
        );
        report[name][reader.name] = "(exempted: no same-named constant)";
        continue;
      }
      assert.equal(
        value,
        canonicalText,
        `${reader.name}의 ${name}이 정본과 다르다: "${value}" !== "${canonicalText}"`,
      );
      report[name][reader.name] = value;
    }
  }
  return report;
}

function readAllCopies() {
  return COPY_PATHS.map((c) => ({ ...c, src: readFileSync(c.path, "utf8") }));
}

function readAllReaders() {
  return READER_PATHS.map((c) => ({
    ...c,
    src: readFileSync(c.path, "utf8"),
  }));
}

test(
  "GREEN(순회): 정본이 export하는 RULE_CONSTANTS의 모든 항목을 순회해 " +
    "세 독자(정본 아님) 각각에서 같은 이름의 상수를 찾아 바이트 동일함을 " +
    "확인한다 -- 정본에 규칙 상수가 하나 더 생기면 이 시험은 코드 수정 " +
    "없이 그것도 자동으로 대조한다",
  () => {
    const readers = readAllReaders();
    const ruleNames = Object.keys(RULE_CONSTANTS);
    assert.ok(
      ruleNames.length >= 2,
      "정본이 export하는 규칙 상수가 예상보다 적다 -- 시험 앵커 자체가 깨졌다",
    );
    const report = assertRuleConstantsAcrossReaders(
      RULE_CONSTANTS,
      readers,
      MISSING_COPY_EXCEPTIONS,
    );
    console.log(
      "HYK-468 4R §2-1 규칙 상수 순회 대조(정본 RULE_CONSTANTS 전 항목):",
      JSON.stringify(report, null, 2),
    );
  },
);

test("GREEN: 네 벌(정본 + 독자 3) 전부 hasStructuralPredecessor 본문이 정본과 바이트 동일하다", () => {
  const copies = readAllCopies();
  const values = assertAllByteIdentical(
    copies,
    extractHasStructuralPredecessor,
    "hasStructuralPredecessor 본문",
  );
  console.log(
    "HYK-468 3R §2-2 hasStructuralPredecessor 본문 대조:",
    JSON.stringify(values, null, 2),
  );
});

// -----------------------------------------------------------------------
// 순회 증명(합성, §3 요구2가 요구하는 "목록이 아니라 순회"의 유일한 증거를
// 영구 자동 시험으로 고정) -- 실 파일도, 정본의 진짜 RULE_CONSTANTS도
// 손대지 않는다. 대신 GREEN 시험과 «같은» 판정 함수
// (assertRuleConstantsAcrossReaders)에 «이 시험만의» 합성 규칙 상수 묶음을
// 넣는다: 그 묶음에는 실제 RULE_CONSTANTS에 없는 새 이름(FAKE_RULE_RE)이
// 하나 있고, 합성 리더 소스 세 벌 중 하나만 그 값을 다르게 해 두었다.
// 판정 함수 자신은 이 이름을 어디에도 하드코딩하지 않으므로(Object.entries
// 로만 순회), 이 시험이 RED가 되는 것은 "정본이 상수를 하나 더 만들면
// 자동으로 그것도 대조된다"는 성질이 실제로 이 판정 로직에 있다는 증거다
// -- 목록(하드코딩된 이름 배열)이었다면 이 새 이름은 애초에 대조되지
// 않았을 것이다.
// -----------------------------------------------------------------------
test(
  "RED(순회 증명, 필수): 합성 규칙 상수 묶음에 실 RULE_CONSTANTS에 없는 " +
    "새 이름을 하나 추가하고 합성 리더 한 벌만 값을 다르게 두면, 시험 " +
    "코드를 전혀 고치지 않은 같은 순회 판정 함수가 RED가 된다",
  () => {
    const FAKE_NAME = "FAKE_RULE_RE";
    assert.ok(
      !(FAKE_NAME in RULE_CONSTANTS),
      "합성 이름이 실제 RULE_CONSTANTS와 우연히 겹친다 -- 시험 전제가 깨졌다",
    );
    // 실 RULE_CONSTANTS를 섞지 않는다 -- 이 묶음은 «순회 메커니즘 자체»만
    // 떼어 증명하려는 것이라, 합성 리더 소스에 없는 실제 이름(TASK_ID_LINE_RE
    // 등)까지 같이 들어오면 그쪽에서 먼저(그리고 엉뚱한 이유로) 던져 버린다.
    const syntheticRuleConstants = {
      [FAKE_NAME]: /synthetic-drift-proof-only/i,
    };
    const matchingConstLine = `const ${FAKE_NAME} = /synthetic-drift-proof-only/i;`;
    const divergedConstLine = `const ${FAKE_NAME} = /synthetic-drift-proof-only-DIVERGED/i;`;
    const syntheticReaders = [
      { name: "synthetic-reader-a.mjs", src: `${matchingConstLine}\n` },
      { name: "synthetic-reader-b.mjs", src: `${matchingConstLine}\n` },
      // 이 사본 하나만 값이 다르다 -- assertAllByteIdentical/
      // assertRuleConstantsAcrossReaders가 4R 3R 원래 RED 시험들과 같은
      // 방식으로 "한 벌만 달라도 던진다"는 계약을 새 이름에도 그대로
      // 지키는지가 이 시험의 핵심.
      {
        name: "synthetic-reader-c.mjs (DIVERGED)",
        src: `${divergedConstLine}\n`,
      },
    ];

    assert.throws(
      () =>
        assertRuleConstantsAcrossReaders(
          syntheticRuleConstants,
          syntheticReaders,
          new Set(),
        ),
      /synthetic-reader-c\.mjs \(DIVERGED\)의 FAKE_RULE_RE이 정본과 다르다/,
      "RED: 실 RULE_CONSTANTS에 없던 새 이름을 하나 추가하고 사본 한 벌만 " +
        "다르게 둬도, 시험 파일을 고치지 않은 같은 순회 판정이 던져야 한다",
    );
  },
);

// -----------------------------------------------------------------------
// 되돌림 변이(필수, §2-2 자신의 요구 계승): 사본 «하나»에 STRUCTURAL_LINE_RE
// 상수 자체를 정본과 다르게 두면(P1-2 표적 2의 정확한 재현), 위 GREEN(순회)
// 시험과 «같은» 판정 함수(assertRuleConstantsAcrossReaders)가 RED여야
// 한다. 실 소스 파일은 한 번도 건드리지 않는다 -- 읽은 문자열만 메모리에서
// 치환해 reader 배열에 끼워 넣는다(파일 I/O 자체가 없으니 "원복"할 것도
// 없다).
// -----------------------------------------------------------------------
test("RED(변이, 필수): 사본 한 벌의 STRUCTURAL_LINE_RE에 정본에 없는 대안을 더하면(P1-2 표적 2의 정확한 재현) 순회 판정이 RED가 된다", () => {
  const readers = readAllReaders();
  const relay = readers.find((c) => c.path.endsWith("relay-handshake.mjs"));
  const target = "const STRUCTURAL_LINE_RE = /^[A-Za-z_][\\w-]*:|^>>>/;";
  const occurrences = relay.src.split(target).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation anchor must appear exactly once in relay-handshake.mjs (found ${occurrences})`,
  );
  const mutatedReaders = readers.map((c) =>
    c === relay
      ? {
          ...c,
          src: c.src.replace(
            target,
            "const STRUCTURAL_LINE_RE = /^[A-Za-z_][\\w-]*:|^>>>|^<!--/;",
          ),
        }
      : c,
  );

  assert.throws(
    () =>
      assertRuleConstantsAcrossReaders(
        RULE_CONSTANTS,
        mutatedReaders,
        MISSING_COPY_EXCEPTIONS,
      ),
    /relay-handshake\.mjs의 STRUCTURAL_LINE_RE이 정본과 다르다/,
    "RED: relay 사본에 정본에 없는 `|^<!--` 대안을 다시 얹으면 위와 똑같은 GREEN 시험 로직이 던져야 한다",
  );

  const afterSource = readFileSync(relay.path, "utf8");
  assert.equal(
    afterSource,
    relay.src,
    "원복 증명: 실 소스 파일은 바이트 동일하다(애초에 쓰지 않았다)",
  );
});

// -----------------------------------------------------------------------
// 되돌림 변이(필수): 사본 한 벌의 TASK_ID_LINE_RE를 되돌리면(이번 라운드
// P1의 정확한 재현 -- relay 507행이 `\s*`로 갈라졌던 그 모양) 순회 판정이
// RED가 된다. 이 시험이 «이번 반려의 그 정확한 회귀»를 다시 넣어도 잡힌다는
// 직접 증거다.
// -----------------------------------------------------------------------
test("RED(변이, 필수, P1 실증): relay 사본의 TASK_ID_LINE_RE를 `\\s*`로 되돌리면(이번 라운드 반려 사유 그대로) 순회 판정이 RED가 된다", () => {
  const readers = readAllReaders();
  const relay = readers.find((c) => c.path.endsWith("relay-handshake.mjs"));
  const target = "const TASK_ID_LINE_RE = /^task_id:[ \\t]*(\\S+)/i;";
  const occurrences = relay.src.split(target).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation anchor must appear exactly once in relay-handshake.mjs (found ${occurrences})`,
  );
  const mutatedReaders = readers.map((c) =>
    c === relay
      ? {
          ...c,
          src: c.src.replace(
            target,
            "const TASK_ID_LINE_RE = /^task_id:\\s*(\\S+)/i;",
          ),
        }
      : c,
  );

  assert.throws(
    () =>
      assertRuleConstantsAcrossReaders(
        RULE_CONSTANTS,
        mutatedReaders,
        MISSING_COPY_EXCEPTIONS,
      ),
    /relay-handshake\.mjs의 TASK_ID_LINE_RE이 정본과 다르다/,
    "RED: relay 사본을 이번 라운드가 고친 그 정확한 회귀(`\\s*`)로 되돌리면 순회 판정이 던져야 한다",
  );

  const afterSource = readFileSync(relay.path, "utf8");
  assert.equal(
    afterSource,
    relay.src,
    "원복 증명: 실 소스 파일은 바이트 동일하다(애초에 쓰지 않았다)",
  );
});

test("RED(변이, 필수): 사본 한 벌의 hasStructuralPredecessor 본문 한 글자를 바꾸면(빈 줄 판정 반전) 드리프트 시험이 RED가 된다", () => {
  const copies = readAllCopies();
  const dispatch = copies.find((c) =>
    c.path.endsWith("dispatch-gate-decision.mjs"),
  );
  // ⚠️짧은 `lines[i].trim() === ""`만으로는 이 파일 자신의 주석(위
  // hasStructuralPredecessor 헤더가 그 코드를 인용해 설명하는 줄)까지
  // 함께 걸려 "정확히 1개"라는 전제가 깨진다 -- 실제 코드에서만 쓰이는
  // `continue;`까지 포함해 앵커를 유일하게 좁힌다.
  const target = 'if (lines[i].trim() === "") continue;';
  const occurrences = dispatch.src.split(target).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation anchor must appear exactly once in dispatch-gate-decision.mjs (found ${occurrences})`,
  );
  const mutatedCopies = copies.map((c) =>
    c === dispatch
      ? {
          ...c,
          src: c.src.replace(target, 'if (lines[i].trim() !== "") continue;'),
        }
      : c,
  );

  assert.throws(
    () =>
      assertAllByteIdentical(
        mutatedCopies,
        extractHasStructuralPredecessor,
        "hasStructuralPredecessor 본문",
      ),
    /dispatch-gate-decision\.mjs의 hasStructuralPredecessor 본문이 정본과 다르다/,
    "RED: dispatch 사본의 빈 줄 판정 한 글자(=== -> !==)만 바꿔도 위와 똑같은 GREEN 시험 로직이 던져야 한다",
  );

  const afterSource = readFileSync(dispatch.path, "utf8");
  assert.equal(
    afterSource,
    dispatch.src,
    "원복 증명: 실 소스 파일은 바이트 동일하다(애초에 쓰지 않았다)",
  );
});
