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
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// 정본을 첫 자리에 -- 나머지 셋과 항상 이 값을 대조한다.
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

// STRUCTURAL_LINE_RE 상수 선언의 우변(정규식 리터럴) 텍스트를 그대로
// 뽑는다 -- 파일마다 그 앞뒤 주석/줄번호가 달라도 이 우변만 대조한다.
function extractStructuralLineRe(src) {
  const m = src.match(/^const STRUCTURAL_LINE_RE = (.+);\s*$/m);
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
// 결과를 대조하고, 하나라도 다르면 던진다.
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

function readAllCopies() {
  return COPY_PATHS.map((c) => ({ ...c, src: readFileSync(c.path, "utf8") }));
}

test("GREEN: 네 벌(정본 + 독자 3) 전부 STRUCTURAL_LINE_RE 정규식이 정본과 바이트 동일하다", () => {
  const copies = readAllCopies();
  const values = assertAllByteIdentical(
    copies,
    extractStructuralLineRe,
    "STRUCTURAL_LINE_RE",
  );
  console.log(
    "HYK-468 3R §2-2 STRUCTURAL_LINE_RE 대조:",
    JSON.stringify(values, null, 2),
  );
});

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
// 되돌림 변이 4/4 (coder-task.md §3 요구4, §2-2 자신의 요구): 사본
// «하나»에 한 글자만 넣어도(정본과 갈라지면) «위 GREEN 시험과 같은
// 대조 함수(assertAllByteIdentical)»가 RED여야 한다. 실 소스 파일은
// 한 번도 건드리지 않는다 -- 읽은 문자열만 메모리에서 치환해 sources
// 배열에 끼워 넣는다(파일 I/O 자체가 없으니 "원복"할 것도 없다).
// -----------------------------------------------------------------------
test("RED(변이 4/4, 필수, §2-2 자신의 요구): 사본 한 벌의 STRUCTURAL_LINE_RE에 정본에 없는 대안을 더하면(P1-2 표적 2의 정확한 재현) 드리프트 시험이 RED가 된다", () => {
  const copies = readAllCopies();
  const relay = copies.find((c) => c.path.endsWith("relay-handshake.mjs"));
  const target = "const STRUCTURAL_LINE_RE = /^[A-Za-z_][\\w-]*:|^>>>/;";
  const occurrences = relay.src.split(target).length - 1;
  assert.equal(
    occurrences,
    1,
    `mutation anchor must appear exactly once in relay-handshake.mjs (found ${occurrences})`,
  );
  const mutatedCopies = copies.map((c) =>
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
      assertAllByteIdentical(
        mutatedCopies,
        extractStructuralLineRe,
        "STRUCTURAL_LINE_RE",
      ),
    /relay-handshake\.mjs의 STRUCTURAL_LINE_RE이 정본과 다르다/,
    "RED: relay 사본에 정본에 없는 `|^<!--` 대안을 다시 얹으면 위와 똑같은 GREEN 시험 로직이 던져야 한다",
  );

  // 실 파일이 실제로는 손대지 않았음을 확인 -- mutatedCopies는 메모리
  // 문자열 배열일 뿐, readFileSync를 다시 해도 원본 그대로다.
  const afterSource = readFileSync(relay.path, "utf8");
  assert.equal(
    afterSource,
    relay.src,
    "원복 증명: 실 소스 파일은 바이트 동일하다(애초에 쓰지 않았다)",
  );
});

test("RED(변이 4/4-b, 필수): 사본 한 벌의 hasStructuralPredecessor 본문 한 글자를 바꾸면(빈 줄 판정 반전) 드리프트 시험이 RED가 된다", () => {
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
