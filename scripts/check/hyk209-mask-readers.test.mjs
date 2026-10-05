// HYK-209 mask-readers (2026-10-06): ⓐ exit-claim 가림을 닫히지 않은 HTML 주석
// 여는 표지까지 fail-closed 로 넓힌다 · ⓑ dropped_at 첫 매치를 가림 뒤로 통일한다.
// 시험은 두 방향을 모두 고정한다: 진짜 표지는 「보인다」, 닫힌 인용 안 예시는
// 「안 보인다」(과차단 금지).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resultClaimsRunnerResults,
  countRunnerExitClaims,
  __probeResolveDroppedAt,
} from "./relay-handshake.mjs";
import { __probeFindArchivedRoundMeta } from "./dispatch-gate-decision.mjs";
import { droppedAtScanText } from "./reject-streak.mjs";
import {
  __probeDroppedAtScanTextLocal,
  __probeReadTaskDroppedAtRaw,
} from "./admission-completion-adapter.mjs";

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

// ⓒ 배선 자리 ----------------------------------------------------------------
// M-A·M-B·M-C 는 「그 자리만 원문 매치로 되돌리면 빨갛다」를 고정한다. 되돌림 변이 셋을
// 눈으로 재현해(본문 교체 후 sha256 복원) 각 시험이 실제로 빨개지는지 확인했다.
// 예시 시각(2020)을 진짜 시각(2026-10-06)보다 앞에 둔다 -- 원문 매치는 예시를 집는다.

const WIRING_NOW = Date.parse("2026-10-06T03:00:00+09:00");
const WIRING_TASK = `\`\`\`\n${EXAMPLE_LINE}\n\`\`\`\n${TRUE_LINE}\n`;

test("M-A GREEN: resolveDroppedAt 은 가림 뒤 첫 매치(진짜 시각)를 읽는다 -- relay-handshake.mjs 배선", () => {
  const r = __probeResolveDroppedAt(WIRING_TASK, WIRING_NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.droppedMatch[1].trim(), TRUE_AT);
});

test("M-B GREEN: findArchivedRoundMeta 는 archive 사본의 가림 뒤 첫 매치(진짜 시각)를 읽는다 -- dispatch-gate-decision.mjs 배선", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk209-mb-"));
  try {
    mkdirSync(join(dir, "rounds"));
    writeFileSync(
      join(dir, "rounds", "CODER-task-r1.md"),
      `task_id: HYK-209-wiring-1\n\n${WIRING_TASK}`,
    );
    const meta = __probeFindArchivedRoundMeta(
      dir,
      "CODER",
      "HYK-209-wiring-1",
      undefined,
    );
    assert.equal(meta.droppedAt, TRUE_AT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M-C GREEN: 은퇴 판독의 낙하 시각은 가림 뒤 첫 매치다 -- admission-completion-adapter.mjs 헬퍼 본문", () => {
  assert.equal(__probeReadTaskDroppedAtRaw(WIRING_TASK), TRUE_AT);
});

test("M-C' GREEN(배선 고정): verifyRetirementEvidence 의 호출 자리는 헬퍼만 부른다 -- 원문 RETIREMENT_DROPPED_AT_RE 직접 호출로 되돌리면 빨갛다", () => {
  const src = readFileSync(
    new URL("./admission-completion-adapter.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /droppedAtRaw = readTaskDroppedAtRaw\(readFileSync\(taskPath, "utf8"\)\);/,
    "은퇴 판독 호출 자리가 헬퍼를 거치지 않는다(가림 뒤 첫 매치 배선 이탈)",
  );
});
