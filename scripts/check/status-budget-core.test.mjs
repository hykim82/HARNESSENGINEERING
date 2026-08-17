import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStatusBudget,
  countRoleRows,
  extractSection1Table,
  REQUIRED_ROLE_ROW_COUNT,
} from "./status-budget-core.mjs";

const SIX_ROLE_ROWS = [
  "| 역할 | 상태 |",
  "| 사람 | 대기 |",
  "| ORCH | 진행 |",
  "| PM | 완료 |",
  "| CODER | 진행 |",
  "| REVIEW | 대기 |",
  "| VERIFY | 대기 |",
].join("\n");

test("countRoleRows: exactly 6 role rows counted", () => {
  assert.equal(countRoleRows(SIX_ROLE_ROWS), REQUIRED_ROLE_ROW_COUNT);
});

test("countRoleRows: role row lines with CRLF still match (normalized)", () => {
  assert.equal(
    countRoleRows(SIX_ROLE_ROWS.replace(/\n/g, "\r\n")),
    REQUIRED_ROLE_ROW_COUNT,
  );
});

test("countRoleRows: a non-role table row (e.g. header) is not counted", () => {
  const text = "| 역할 | 상태 |\n| 기타 | 무관 |\n";
  assert.equal(countRoleRows(text), 0);
});

test("countRoleRows: zero rows on an empty document", () => {
  assert.equal(countRoleRows(""), 0);
});

// ---------------------------------------------------------------------------
// 되돌리면 RED -- 예산 안/밖, role_rows 있음/없음 양쪽을 모두 보인다
// (coder-task.md §3-1 요건 8).
// ---------------------------------------------------------------------------
test("checkStatusBudget: within budget + exactly 6 role rows -> ok:true", () => {
  const result = checkStatusBudget({
    statusText: SIX_ROLE_ROWS,
    byteLength: 1000,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 1000);
  assert.equal(result.roleRows, 6);
  assert.deepEqual(result.reasons, []);
});

test("checkStatusBudget: bytes exactly at the budget boundary -> ok (inclusive), matches PM's `-gt` semantics", () => {
  const result = checkStatusBudget({
    statusText: SIX_ROLE_ROWS,
    byteLength: 65536,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.ok, true);
});

test("checkStatusBudget: bytes over budget -> ok:false with a reason", () => {
  const result = checkStatusBudget({
    statusText: SIX_ROLE_ROWS,
    byteLength: 304044,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.ok, false);
  assert.equal(result.bytes, 304044);
  assert.ok(result.reasons.some((r) => r.includes("bytes=304044")));
});

test("checkStatusBudget: role rows count wrong (missing a role) -> ok:false even when bytes are within budget", () => {
  const missingOne = SIX_ROLE_ROWS.split("\n").slice(0, -1).join("\n");
  const result = checkStatusBudget({
    statusText: missingOne,
    byteLength: 1000,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.ok, false);
  assert.equal(result.roleRows, 5);
  assert.ok(result.reasons.some((r) => r.includes("role_rows=5")));
});

test("checkStatusBudget: role rows count wrong (duplicate role) -> ok:false", () => {
  const dup = SIX_ROLE_ROWS + "\n| 사람 | 중복 |";
  const result = checkStatusBudget({
    statusText: dup,
    byteLength: 1000,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.ok, false);
  assert.equal(result.roleRows, 7);
});

test("checkStatusBudget: both over budget and wrong role-row count -> both reasons present", () => {
  const missingTwo = SIX_ROLE_ROWS.split("\n").slice(0, -2).join("\n");
  const result = checkStatusBudget({
    statusText: missingTwo,
    byteLength: 999999,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 2);
});

// ---------------------------------------------------------------------------
// 2R 수리 2 (coder-task.md §2 수리 2 · review-r1.md 축3 재측정) --
// role_rows는 파일 전체가 아니라 살아 있는 §1 표 범위 안에서만 센다.
// ---------------------------------------------------------------------------
test("extractSection1Table: header row not found -> null", () => {
  assert.equal(extractSection1Table("이 문서엔 §1 표가 없다."), null);
});

test("extractSection1Table: block runs from the header row up to (not including) the next markdown heading", () => {
  const text = [
    SIX_ROLE_ROWS,
    "### 2) 한 줄 상태",
    "| PM | DONE (§1 밖 과거 표) |",
  ].join("\n");
  const block = extractSection1Table(text);
  assert.ok(block.includes("| 역할 | 상태 |"));
  assert.ok(block.includes("| VERIFY | 대기 |"));
  assert.ok(!block.includes("DONE (§1 밖 과거 표)"));
});

test("extractSection1Table: HTML comment lines interspersed between role rows stay inside the block but do not themselves count as role rows (real STATUS.md shape)", () => {
  const text = [
    "| 역할 | 상태 |",
    "|---|---|",
    "<!-- 트림 규약 주석 -->",
    "| ORCH | 진행 |",
    "<!-- | ORCH | (접힌 과거 행, 사람이 아니라 기계가 읽는 형식) | -->",
    "| CODER | 진행 |",
    "| REVIEW | 대기 |",
    "| VERIFY | 대기 |",
    "| PM | 완료 |",
    "| 사람 | 대기 |",
  ].join("\n");
  const result = checkStatusBudget({
    statusText: text,
    byteLength: 1000,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.sectionFound, true);
  assert.equal(result.roleRows, 6);
});

// ⓐ §1 6행 + 파일 뒤쪽에 과거 표 행 -> role_rows=6
test("checkStatusBudget: §1 has exactly 6 rows + a historical table row past the next heading -> role_rows=6 (history not counted)", () => {
  const text = [
    SIX_ROLE_ROWS,
    "### 2) 한 줄 상태",
    "| PM | DONE (§1 밖 과거 표) |",
  ].join("\n");
  const result = checkStatusBudget({
    statusText: text,
    byteLength: 1000,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.sectionFound, true);
  assert.equal(result.roleRows, 6);
  assert.equal(result.ok, true);
});

// ⓑ §1 자체에 중복이 있는 픽스처 -> 7로 잡힌다
test("checkStatusBudget: duplicate role row inside §1 itself is still counted (7)", () => {
  const text = SIX_ROLE_ROWS + "\n| 사람 | 중복 |";
  const result = checkStatusBudget({
    statusText: text,
    byteLength: 1000,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.sectionFound, true);
  assert.equal(result.roleRows, 7);
  assert.equal(result.ok, false);
});

// ⓒ §1 표를 못 찾는 픽스처 -> fail-closed
test("checkStatusBudget: §1 header row not found -> fail-closed (sectionFound:false, ok:false, roleRows:null)", () => {
  const result = checkStatusBudget({
    statusText: "이 문서엔 §1 표가 없다. 그냥 산문.",
    byteLength: 100,
    statusBudgetBytes: 65536,
  });
  assert.equal(result.sectionFound, false);
  assert.equal(result.ok, false);
  assert.equal(result.roleRows, null);
  assert.ok(result.reasons.some((r) => r.includes("§1 표")));
});
