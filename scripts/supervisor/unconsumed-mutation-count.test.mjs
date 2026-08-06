// HYK-185-unconsumed-4 (coder-task.md §R4-3) -- 이 세 파일에 흩어진
// "NC mutation/..." 필수 변이 시험의 건수를 **시험이 직접 세어** 단언한다.
//
// 왜 이 파일이 있는가(REVIEW 4R 반려): 2R 이후 보고서 세 곳이 "mutation 9"
// 라고 손으로 적었는데 실측은 11이었고, 적힌 내역끼리도(8과 11) 서로
// 어긋났다 — 2R 값 9가 그대로 굳어 라운드가 지나도 안 고쳐진 것이다.
// 손으로 숫자를 다시 세서 고치는 것은 같은 사고를 다음 라운드에 또
// 남긴다(한용 명시) -- 그래서 이 시험은 **숫자를 하드코딩하지 않는다**.
// 대신 각 파일 안에서 "NC mutation/<suite> #<n>" 이름이 **1부터 빈틈·
// 중복 없이 연속**하는지를 구조적으로 검사한다. 총 건수는 그 파싱
// 결과를 더한 값이며, 이 파일도 콘솔에 그 값을 그대로 출력한다 --
// 보고서는 이 출력을 그대로 인용한다(손으로 다시 세지 않는다).
//
// ★이 검사가 실제로 잡는 것과 못 잡는 것(REVIEW 5R 반려 수리 -- 아래
// 문장은 검토자가 M0~M3 4가지 시나리오로 직접 재현한 실측과 한 줄씩
// 대응한다, coder.md §R5-1 참조. 검사식은 오직 "정렬한 번호열이 1..k와
// 같은가"뿐이다):
// - **잡는다**: 번호를 건너뛰면(예: #3을 지우고 #4~#6만 남기면 번호열이
//   [1,2,4,5,6]이 되어 1..5와 불일치) -- 실패로 잡힌다(M1 실측).
// - **잡는다**: 번호가 중복되면(예: #2를 #1로 잘못 고쳐 [1,1,3,...]이
//   되면) -- 실패로 잡힌다(M3 실측).
// - ⛔**못 잡는다(사각, 숨기지 않고 명시한다)**: **suite의 "가장 큰
//   번호" 시험을 통째로 지우면** 남은 번호열이 여전히 빈틈 없는
//   `1..(k-1)`이므로 **이 검사는 조용히 통과한다**(M2 실측 -- wire의
//   마지막 시험 #7을 지워도 나머지 [1,2,3,4,5,6]은 여전히 1..6으로
//   연속이라 `pass:true`, `total`만 12→11로 줄어든다). ★이 사각을
//   메우려고 "기대 건수"나 "기준선 숫자"를 이 파일에 하드코딩하지
//   않는다(한용 명시 "숫자를 코드에 박는 방향으로 가지 마라") -- 사각은
//   사각으로 남기고, 이 문단으로 정직하게 적어 두는 것이 현재의 답이다.
//
// 모집단(★세는 방법, coder-task.md §R4-3 "무엇을 모집단으로 셌는지
// 불명확하면 안 된다" 요구): 이 소비("unconsumed") 축·§R3-1(B) 판정
// 축 작업에서 만들어진 세 시험 파일 -- unconsumed-core.test.mjs ·
// unconsumed-wire.test.mjs · header-time-projection-core.test.mjs.
// 그 파일들이 `test("NC mutation/<suite-name> #<n> ...` 형태로 선언한
// 시험의 수를 **정규식으로 소스 텍스트에서 직접** 센다(다른 축
// (seat-liveness/seat-idle/dispatch-start 등)의 mutation 시험은 이
// 모집단에 넣지 않는다 -- 이번 태스크의 변경 범위가 아니다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const MUTATION_TEST_FILES = Object.freeze([
  "unconsumed-core.test.mjs",
  "unconsumed-wire.test.mjs",
  "header-time-projection-core.test.mjs",
]);

// `test("NC mutation/<suite> #<n> ...` 형태만 센다 -- 다른 이름의 test()
// 는 모집단이 아니다. suite 이름은 파일마다 다르므로(unconsumed-core,
// unconsumed-wire, header-time-projection-core) 값 자체는 검사하지
// 않고 그룹핑에만 쓴다.
const MUTATION_TEST_NAME_RE = /test\(\s*"NC mutation\/([a-zA-Z0-9-]+) #(\d+)/g;

// 파일 하나의 소스에서 mutation 시험 이름을 전부 뽑아, suite별로 번호가
// 1..k 로 빈틈·중복 없이 연속하는지 확인한다. 위반이 있으면 그 사유를
// 문자열로 돌려주고(assert 실패 메시지에 그대로 쓴다), 문제 없으면 총
// 건수를 돌려준다.
function countAndVerifyMutationTests(sourceText, fileLabel) {
  const bySuite = new Map();
  for (const m of sourceText.matchAll(MUTATION_TEST_NAME_RE)) {
    const suite = m[1];
    const n = Number(m[2]);
    if (!bySuite.has(suite)) bySuite.set(suite, []);
    bySuite.get(suite).push(n);
  }
  let total = 0;
  const problems = [];
  for (const [suite, numbers] of bySuite) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const expected = sorted.map((_, i) => i + 1);
    const isContiguousFrom1 =
      sorted.length === new Set(sorted).size &&
      JSON.stringify(sorted) === JSON.stringify(expected);
    if (!isContiguousFrom1) {
      problems.push(
        `${fileLabel}/${suite}: numbers found = [${sorted.join(",")}], expected a gap-free 1..${sorted.length} sequence`,
      );
    }
    total += numbers.length;
  }
  return { total, problems, suiteCount: bySuite.size };
}

test("★변이 시험 건수 자체 검증(§R4-3): 세 파일의 'NC mutation/<suite> #<n>' 선언이 각 suite별로 빈틈·중복 없이 1..k 연속이고, 그 합계를 시험이 직접 세어 출력한다 (모집단 3파일)", () => {
  let grandTotal = 0;
  const perFile = [];
  const allProblems = [];
  for (const fileName of MUTATION_TEST_FILES) {
    const src = readFileSync(join(THIS_DIR, fileName), "utf8");
    const { total, problems, suiteCount } = countAndVerifyMutationTests(
      src,
      fileName,
    );
    perFile.push({ fileName, total, suiteCount });
    grandTotal += total;
    allProblems.push(...problems);
  }
  assert.deepEqual(
    allProblems,
    [],
    `mutation test numbering has gaps or duplicates:\n${allProblems.join("\n")}`,
  );
  assert.ok(
    grandTotal > 0,
    "the regex must actually find mutation tests -- 0 means the pattern or file list is stale",
  );
  // ★보고서가 인용하는 숫자의 출처는 이 줄이다(손으로 다시 세지 않는다).
  console.log(
    `[HYK-185-unconsumed-4 변이 건수 실측] total=${grandTotal} perFile=${JSON.stringify(perFile)}`,
  );
});
