// HYK-209 mask-readers (2026-10-06): ⓐ exit-claim 가림을 닫히지 않은 HTML 주석
// 여는 표지까지 fail-closed 로 넓힌다 · ⓑ dropped_at 첫 매치를 가림 뒤로 통일한다.
// 시험은 두 방향을 모두 고정한다: 진짜 표지는 「보인다」, 닫힌 인용 안 예시는
// 「안 보인다」(과차단 금지).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resultClaimsRunnerResults,
  countRunnerExitClaims,
} from "./relay-handshake.mjs";
import { droppedAtScanText } from "./reject-streak.mjs";
import { __probeDroppedAtScanTextLocal } from "./admission-completion-adapter.mjs";

const RAW_DROPPED_AT_RE = /^dropped_at:[ \t]*(\S.*)$/im;
const TRUE_AT = "2026-10-06 02:04 KST";
const EXAMPLE_AT = "2020-01-01 00:00 KST";
const TRUE_LINE = `dropped_at: ${TRUE_AT}`;
const EXAMPLE_LINE = `dropped_at: ${EXAMPLE_AT}`;

function firstDroppedAt(text) {
  const m = text.match(RAW_DROPPED_AT_RE);
  return m ? m[1].trim() : null;
}

// ⓐ ---------------------------------------------------------------------------

test("ⓐ GREEN: 닫히지 않은 HTML 주석 여는 표지 뒤의 진짜 러너 주장은 보인다", () => {
  const text = "# r\n\n<!-- 여는 표지\nexit=0\n";
  assert.equal(resultClaimsRunnerResults(text), true);
  assert.equal(countRunnerExitClaims(text), 1);
});

test("ⓐ GREEN: 같은 모양을 CRLF 로 써도 같은 답을 낸다", () => {
  const text = "# r\r\n\r\n<!-- 여는 표지\r\nexit=0\r\n";
  assert.equal(resultClaimsRunnerResults(text), true);
  assert.equal(countRunnerExitClaims(text), 1);
});

test("ⓐ GREEN(과차단 금지): 닫힌 HTML 주석 안 예시 주장은 계속 안 보인다", () => {
  const text = "# r\n\n<!-- x\nexit=0\n-->\n";
  assert.equal(resultClaimsRunnerResults(text), false);
  assert.equal(countRunnerExitClaims(text), 0);
});

test("ⓐ GREEN(과차단 금지): 닫힌 펜스 안 예시 주장은 계속 안 보인다", () => {
  const text = "# r\n\n```\nexit=0\n```\n";
  assert.equal(resultClaimsRunnerResults(text), false);
  assert.equal(countRunnerExitClaims(text), 0);
});

test("ⓐ GREEN: 닫히지 않은 펜스 뒤의 진짜 주장은 기존처럼 보인다 (무회귀)", () => {
  const text = "# r\n\n```\nsh x\nexit=0\n";
  assert.equal(resultClaimsRunnerResults(text), true);
  assert.equal(countRunnerExitClaims(text), 1);
});

// ⓑ ---------------------------------------------------------------------------

test("ⓑ GREEN: 펜스 안 예시 시각이 앞에 있어도 가림 뒤 첫 매치는 진짜 줄이다", () => {
  const text = `\`\`\`\n${EXAMPLE_LINE}\n\`\`\`\n${TRUE_LINE}\n`;
  assert.equal(firstDroppedAt(text), EXAMPLE_AT, "raw match is the example");
  assert.equal(firstDroppedAt(droppedAtScanText(text)), TRUE_AT);
});

test("ⓑ GREEN: 여러 줄 주석 안 칼럼 0 예시 시각이 앞에 있어도 진짜 줄을 집는다", () => {
  const text = `<!--\n${EXAMPLE_LINE}\n-->\n${TRUE_LINE}\n`;
  assert.equal(firstDroppedAt(text), EXAMPLE_AT, "raw match is the example");
  assert.equal(firstDroppedAt(droppedAtScanText(text)), TRUE_AT);
});

test("ⓑ GREEN(fail-closed): 닫히지 않은 주석 여는 표지 뒤의 진짜 줄은 보인다", () => {
  const text = `<!-- open\n${TRUE_LINE}\n`;
  assert.equal(firstDroppedAt(droppedAtScanText(text)), TRUE_AT);
});

test("ⓑ GREEN(fail-closed): 닫히지 않은 펜스 여는 표지 뒤의 진짜 줄은 보인다", () => {
  const text = `\`\`\`\n${TRUE_LINE}\n`;
  assert.equal(firstDroppedAt(droppedAtScanText(text)), TRUE_AT);
});

test("ⓑ GREEN(CRLF): 펜스 예시가 앞에 있어도 CRLF 에서 진짜 줄을 집는다", () => {
  const text = `\`\`\`\r\n${EXAMPLE_LINE}\r\n\`\`\`\r\n${TRUE_LINE}\r\n`;
  assert.equal(firstDroppedAt(droppedAtScanText(text)), TRUE_AT);
});

test("ⓑ GREEN(admission 사본 동치): 정본과 로컬 복제가 같은 입력에 같은 답", () => {
  const shapes = [
    `${TRUE_LINE}\n\`\`\`\n${EXAMPLE_LINE}\n\`\`\`\n`,
    `\`\`\`\n${EXAMPLE_LINE}\n\`\`\`\n${TRUE_LINE}\n`,
    `<!--\n${EXAMPLE_LINE}\n-->\n${TRUE_LINE}\n`,
    `<!-- open\n${TRUE_LINE}\n`,
    `\`\`\`\n${TRUE_LINE}\n`,
    `\`\`\`\r\n${EXAMPLE_LINE}\r\n\`\`\`\r\n${TRUE_LINE}\r\n`,
  ];
  for (const text of shapes) {
    assert.equal(
      firstDroppedAt(__probeDroppedAtScanTextLocal(text)),
      firstDroppedAt(droppedAtScanText(text)),
      `admission copy diverged on: ${JSON.stringify(text)}`,
    );
  }
});
