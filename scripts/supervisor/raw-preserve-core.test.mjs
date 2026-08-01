// HYK-183 C-2 (coder-task.md §6, §3) -- raw-preserve-core.mjs 계약 시험
// (SV-8 전반부: 원시 생성 응답이 "가공 전 형태"로 보존된 경우에만
// PRESERVED, 없음.읽기불가.구조불일치.가공흔적은 전부 NOT_PRESERVED).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 주장 범위 -- 여기서 만드는 `preserved` 원시 텍스트는 전부 손으로
//    조립한 SYNTHETIC 리터럴이다(합성 표적, coder-task.md §2-9). 실제
//    좌석.실제 원장을 이 시험이 접촉하지 않는다.
// 2. 이 스위트가 100% 통과해도 "그 좌석이 정말 그때 그것이었다"를
//    증명하지 않는다 -- judgeRawPreservation 자신의 헤더 주석과 동일한
//    한계가 그대로 적용된다(독립 재조회 join은 C-3, 여기 없다).
// 3. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeRawPreservation,
  RAW_PRESERVATION_VERDICT,
  RAW_PRESERVATION_REASON,
} from "./raw-preserve-core.mjs";

// eslint(no-restricted-imports, HYK-148 A3)가 scripts/relay/* 밖에서 relay를
// import하는 것을 전역으로 막는다(실제 의존 방향은 relay -> 나머지, 반대
// 방향 금지) -- 그래서 seat-proof-contract-v1.mjs를 여기서 import하지
// 않는다. 대신 §3-d(새 어휘 지어내지 않기)를 지키기 위해 그 계약이 고정한
// 필드명.타입을 문자 그대로 복사한다(재선언, re-export 아님 -- 계약 자신도
// dispatch-bound-seat-proof.mjs를 이 방식으로 재선언한다). 정본은
// scripts/relay/contracts/seat-proof-contract-v1.mjs의
// TERMINAL_SHOW_RAW_FIELD_TYPES(14키)·DISPATCH_SHOW_RAW_FIELD_TYPES(9키).
const TERMINAL_SHOW_RAW_FIELD_TYPES = Object.freeze({
  branch: "string",
  connected: "boolean",
  handle: "string",
  lastOutputAt: "number",
  leafId: "string",
  paneRuntimeId: "number",
  preview: "string",
  ptyId: "string",
  rendererGraphEpoch: "number",
  tabId: "string",
  title: "string",
  worktreeId: "string",
  worktreePath: "string",
  writable: "boolean",
});
const DISPATCH_SHOW_RAW_FIELD_TYPES = Object.freeze({
  id: "string",
  task_id: "string",
  assignee_handle: "string",
  assignee_pane_key: "string",
  status: "string",
  failure_count: "number",
  dispatched_at: "string",
  completed_at: "string",
  created_at: "string",
});

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();

// §2 비타협 #6 -- 원상복구 단언 준비(budget-core.test.mjs 선례 그대로).
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

const NOW = 1_770_000_000_000; // 합성 고정 타임스탬프(Date.now() 미사용).

// ---------------------------------------------------------------------------
// §6-1 freeze 계약 열거(표는 .harness/coder.md에) -- 위에서 재선언한
// `TERMINAL_SHOW_RAW_FIELD_TYPES`(14키)와 `DISPATCH_SHOW_RAW_FIELD_TYPES`
// (9키)를 각각 `expected`로 넘겨 두 가지 서로 다른 스키마에서 이 코어가
// 동작함을 함께 확인한다.
// ---------------------------------------------------------------------------
const VALID_TERMINAL_RECORD = {
  branch: "hyk183-c2-raw-preserve",
  connected: true,
  handle: "term_0817fabe-e01a-4cc2-a323-393c3db72409",
  lastOutputAt: 1_769_999_000_000,
  leafId: "69308e19-aa97-40ed-b109-7a3119c0b9d9",
  paneRuntimeId: -1,
  preview: "synthetic screen text",
  ptyId: "pty_synthetic",
  rendererGraphEpoch: 0,
  tabId: "22508fb0-49dc-4bc3-bc01-bc2d4d28399a",
  title: "CODER",
  worktreeId: "wt_synthetic",
  worktreePath: "C:\\synthetic\\worktree",
  writable: true,
};

const VALID_DISPATCH_RECORD = {
  id: "ctx_synthetic",
  task_id: "task_synthetic",
  assignee_handle: "term_synthetic",
  assignee_pane_key:
    "22508fb0-49dc-4bc3-bc01-bc2d4d28399a:69308e19-aa97-40ed-b109-7a3119c0b9d9",
  status: "dispatched",
  failure_count: 0,
  dispatched_at: "2026-08-02 07:59:00",
  completed_at: "",
  created_at: "2026-08-02 07:59:00",
};

const VALID_FIXTURES = [
  {
    label: "terminal-show (14 field, TERMINAL_SHOW_RAW_FIELD_TYPES)",
    expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
    text: JSON.stringify(VALID_TERMINAL_RECORD),
  },
  {
    label: "dispatch-show (9 field, DISPATCH_SHOW_RAW_FIELD_TYPES)",
    expected: DISPATCH_SHOW_RAW_FIELD_TYPES,
    text: JSON.stringify(VALID_DISPATCH_RECORD),
  },
];

// ---------------------------------------------------------------------------
// (b)(e) 정상 케이스 -- "가공 전 형태 그대로"인 원시 텍스트만 PRESERVED.
// 오탐(잘못 NOT_PRESERVED로 거부됨) 0을 분모와 함께 확인.
// ---------------------------------------------------------------------------
for (const { label, expected, text } of VALID_FIXTURES) {
  test(`(b) preserved text that is exactly the raw shape (${label}) -> ok:true, PRESERVED, RAW_OK`, () => {
    const result = judgeRawPreservation({
      preserved: text,
      expected,
      now: NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(result.verdict, RAW_PRESERVATION_VERDICT.PRESERVED);
    assert.equal(result.reasonCode, RAW_PRESERVATION_REASON.RAW_OK);
  });
}

test(`(e) false-positive count is 0 across all ${VALID_FIXTURES.length} well-formed raw fixtures above (every one produced PRESERVED, denominator=${VALID_FIXTURES.length})`, () => {
  const falseNegatives = VALID_FIXTURES.filter(({ expected, text }) => {
    const result = judgeRawPreservation({
      preserved: text,
      expected,
      now: NOW,
    });
    return result.verdict !== RAW_PRESERVATION_VERDICT.PRESERVED;
  });
  assert.deepEqual(
    falseNegatives.map((f) => f.label),
    [],
    `denominator=${VALID_FIXTURES.length}, wrongly-rejected=${falseNegatives.length}`,
  );
});

// ---------------------------------------------------------------------------
// (c) 반례 전수 -- 기록 없음.JSON 아님.타입 오류.필드 결손.가공 흔적(키
// 추가.키 삭제) 전부 NOT_PRESERVED이며 정확한 reasonCode를 받는다.
// ---------------------------------------------------------------------------
const TERMINAL_MISSING_FIELD = { ...VALID_TERMINAL_RECORD };
delete TERMINAL_MISSING_FIELD.branch;
const TERMINAL_EXTRA_FIELD = {
  ...VALID_TERMINAL_RECORD,
  normalizedBy: "our-adapter",
};
const TERMINAL_WRONG_TYPE = {
  ...VALID_TERMINAL_RECORD,
  connected: "true", // boolean이어야 하는데 string.
};

const COUNTEREXAMPLE_FIXTURES = [
  {
    label: "no record at all (undefined)",
    preserved: undefined,
    expectedReason: RAW_PRESERVATION_REASON.RAW_MISSING,
  },
  {
    label: "no record at all (null)",
    preserved: null,
    expectedReason: RAW_PRESERVATION_REASON.RAW_MISSING,
  },
  {
    label: "empty string",
    preserved: "",
    expectedReason: RAW_PRESERVATION_REASON.RAW_MISSING,
  },
  {
    label: "record handed as an already-parsed object, not raw text",
    preserved: VALID_TERMINAL_RECORD,
    expectedReason: RAW_PRESERVATION_REASON.RAW_MISSING,
  },
  {
    label: "not JSON (truncated/invalid text)",
    preserved: "{not valid json",
    expectedReason: RAW_PRESERVATION_REASON.RAW_UNREADABLE,
  },
  {
    label: "type error: top-level array instead of object",
    preserved: JSON.stringify(["a", "b", "c"]),
    expectedReason: RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH,
  },
  {
    label: "type error: top-level string instead of object",
    preserved: JSON.stringify("just a string"),
    expectedReason: RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH,
  },
  {
    label: "type error: top-level number instead of object",
    preserved: JSON.stringify(42),
    expectedReason: RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH,
  },
  {
    label: "required field missing (원본 키가 사라짐, dropped 'branch')",
    preserved: JSON.stringify(TERMINAL_MISSING_FIELD),
    expectedReason: RAW_PRESERVATION_REASON.RAW_NORMALIZED,
  },
  {
    label: "extra field added (원본에 없던 키, 'normalizedBy')",
    preserved: JSON.stringify(TERMINAL_EXTRA_FIELD),
    expectedReason: RAW_PRESERVATION_REASON.RAW_NORMALIZED,
  },
  {
    label:
      "field present with wrong type (connected: 'true' string, not boolean)",
    preserved: JSON.stringify(TERMINAL_WRONG_TYPE),
    expectedReason: RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH,
  },
];

for (const { label, preserved, expectedReason } of COUNTEREXAMPLE_FIXTURES) {
  test(`(c) counterexample: ${label} -> NOT_PRESERVED/${expectedReason} (denominator: ${COUNTEREXAMPLE_FIXTURES.length})`, () => {
    const result = judgeRawPreservation({
      preserved,
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    assert.equal(result.verdict, RAW_PRESERVATION_VERDICT.NOT_PRESERVED);
    assert.equal(result.reasonCode, expectedReason);
  });
}

test(`(c) false-positive count is 0 across all ${COUNTEREXAMPLE_FIXTURES.length} counterexamples above (none produced PRESERVED)`, () => {
  const falsePositives = COUNTEREXAMPLE_FIXTURES.filter(({ preserved }) => {
    const result = judgeRawPreservation({
      preserved,
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    return result.verdict === RAW_PRESERVATION_VERDICT.PRESERVED;
  });
  assert.deepEqual(
    falsePositives.map((f) => f.label),
    [],
    `denominator=${COUNTEREXAMPLE_FIXTURES.length}, false positives=${falsePositives.length}`,
  );
});

// ---------------------------------------------------------------------------
// (a) 순수 함수 -- 결정적, 예외 없음, 입력 불변.
// ---------------------------------------------------------------------------
test("(a) same input twice -> identical verdict and reasonCode (deterministic, no crash)", () => {
  const input = {
    preserved: JSON.stringify(VALID_TERMINAL_RECORD),
    expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
    now: NOW,
  };
  const first = judgeRawPreservation(input);
  const second = judgeRawPreservation(input);
  assert.deepEqual(first, second);
});

test("purity: judgeRawPreservation does not mutate its input", () => {
  const input = {
    preserved: JSON.stringify(VALID_TERMINAL_RECORD),
    expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
    now: NOW,
  };
  const clone = JSON.parse(JSON.stringify(input));
  judgeRawPreservation(input);
  assert.deepEqual(input, clone);
});

// ---------------------------------------------------------------------------
// fail-closed / INVALID_ARGUMENTS -- 최상위 인자가 이상하면 예외 없이
// ok:false + NOT_PRESERVED(never PRESERVED even on invalid shape).
// ---------------------------------------------------------------------------
for (const badArgs of [null, undefined, "preserved", 42, [], true]) {
  test(`fail-closed: judgeRawPreservation(${JSON.stringify(badArgs)}) -> ok:false, NOT_PRESERVED, INVALID_ARGUMENTS`, () => {
    const result = judgeRawPreservation(badArgs);
    assert.equal(result.ok, false);
    assert.equal(result.verdict, RAW_PRESERVATION_VERDICT.NOT_PRESERVED);
    assert.equal(result.reasonCode, RAW_PRESERVATION_REASON.INVALID_ARGUMENTS);
  });
}

for (const badNow of [
  null,
  undefined,
  "now",
  NaN,
  Infinity,
  -Infinity,
  [],
  {},
]) {
  test(`fail-closed: now=${JSON.stringify(badNow)} -> ok:false, NOT_PRESERVED, INVALID_ARGUMENTS`, () => {
    const result = judgeRawPreservation({
      preserved: JSON.stringify(VALID_TERMINAL_RECORD),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: badNow,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, RAW_PRESERVATION_REASON.INVALID_ARGUMENTS);
  });
}

for (const badExpected of [
  null,
  undefined,
  "expected",
  42,
  [],
  {},
  { field: "object" }, // 허용 타입 밖("string"|"number"|"boolean"만 허용).
  { field: 1 },
]) {
  test(`fail-closed: expected=${JSON.stringify(badExpected)} -> ok:false, NOT_PRESERVED, INVALID_ARGUMENTS`, () => {
    const result = judgeRawPreservation({
      preserved: JSON.stringify(VALID_TERMINAL_RECORD),
      expected: badExpected,
      now: NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, RAW_PRESERVATION_REASON.INVALID_ARGUMENTS);
  });
}

// ---------------------------------------------------------------------------
// (a) 부작용 0 -- 주입된 감시자(spy)로 fs/child_process/네트워크 호출
// 횟수가 0임을 단언한다("안 했다"는 서술이 아니라 호출되지 않았음의
// 단언, budget-core.test.mjs 선례 그대로).
// ---------------------------------------------------------------------------
test("side effects: fs write-family functions are never invoked while judging any of the above inputs (spied, not merely 'not imported')", () => {
  const watchedFsMethods = [
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
    "appendFile",
    "appendFileSync",
    "unlink",
    "unlinkSync",
    "mkdir",
    "mkdirSync",
    "rm",
    "rmSync",
    "rename",
    "renameSync",
  ];
  const mocks = watchedFsMethods
    .filter((name) => typeof fs[name] === "function")
    .map((name) =>
      mock.method(fs, name, () => {
        throw new Error(`unexpected fs.${name} call from judgeRawPreservation`);
      }),
    );
  try {
    judgeRawPreservation({
      preserved: JSON.stringify(VALID_TERMINAL_RECORD),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    judgeRawPreservation({
      preserved: undefined,
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    judgeRawPreservation({
      preserved: "{not valid json",
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    judgeRawPreservation(null);
    for (const m of mocks) {
      assert.equal(
        m.mock.calls.length,
        0,
        `expected 0 calls, got ${m.mock.calls.length}`,
      );
    }
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});

test("side effects: child_process spawn-family functions are never invoked (covers 'orca' CLI calls too -- orca is always spawned as a child process)", () => {
  const watchedCpMethods = [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
    "fork",
  ];
  const mocks = watchedCpMethods
    .filter((name) => typeof child_process[name] === "function")
    .map((name) =>
      mock.method(child_process, name, () => {
        throw new Error(
          `unexpected child_process.${name} call from judgeRawPreservation`,
        );
      }),
    );
  try {
    judgeRawPreservation({
      preserved: JSON.stringify(VALID_TERMINAL_RECORD),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    judgeRawPreservation({
      preserved: null,
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    for (const m of mocks) {
      assert.equal(
        m.mock.calls.length,
        0,
        `expected 0 calls, got ${m.mock.calls.length}`,
      );
    }
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});

test("side effects: global fetch (network) is never invoked", () => {
  const hasFetch = typeof globalThis.fetch === "function";
  const fetchMock = hasFetch
    ? mock.method(globalThis, "fetch", () => {
        throw new Error("unexpected fetch call from judgeRawPreservation");
      })
    : null;
  try {
    judgeRawPreservation({
      preserved: JSON.stringify(VALID_TERMINAL_RECORD),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    if (fetchMock) {
      assert.equal(fetchMock.mock.calls.length, 0);
    }
  } finally {
    if (fetchMock) fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// §3(f) 판별력 자동화 -- copy-and-mutate 층(budget-core.test.mjs 선례
// 재사용). 추적본(git show HEAD:)에서 소스를 읽어 mkdtemp에 변조 사본을
// 쓰고 동적 import()로 불러온다. 신규 파일이라 아직 HEAD에 없으면 명시적
// 사유로 skip한다(커밋 후 자동 실행 -- no-op 아님).
// ---------------------------------------------------------------------------
let RAW_PRESERVE_CORE_SRC = null;
try {
  RAW_PRESERVE_CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/raw-preserve-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  RAW_PRESERVE_CORE_SRC = null;
}
const SRC_COMMITTED = RAW_PRESERVE_CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "raw-preserve-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본(이 시험이 `git show HEAD:`로 읽는 스냅샷)에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-raw-preserve-core-mutant-"));
  const mutated = mutate(RAW_PRESERVE_CORE_SRC);
  const filePath = join(dir, "raw-preserve-core.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/raw-preserve-core #1: removing RAW_MISSING handling ('RAW_MISSING 처리 제거') -> RED (a missing record now gets misclassified as RAW_UNREADABLE instead of RAW_MISSING -- breaks the fixed-reasonCode contract even though NOT_PRESERVED survives via the downstream JSON.parse failure catching undefined)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (isMissingRawText(preserved)) {\n    return notPreserved(RAW_PRESERVATION_REASON.RAW_MISSING);\n  }\n\n",
        "",
      ),
    );
    const result = mutant.judgeRawPreservation({
      preserved: undefined,
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    assert.notEqual(
      result.reasonCode,
      "RAW_MISSING",
      "mutant must fail to classify a missing record as RAW_MISSING (RED signal for the mutation; proves the dedicated RAW_MISSING guard is load-bearing for the fixed-reasonCode contract in §5, independent of the downstream parse-failure safety net)",
    );
  },
);

test(
  "NC mutation/raw-preserve-core #2: removing the structural shape guard ('구조 검사 제거') -> RED (a top-level array now gets misclassified as RAW_NORMALIZED instead of RAW_SHAPE_MISMATCH -- breaks the fixed-reasonCode contract even though NOT_PRESERVED survives via the downstream key-set mismatch)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (!isPlainObject(parsed)) {\n    return {\n      ok: false,\n      reasonCode: RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH,\n    };\n  }\n  return { ok: true, parsed };\n}",
        "  return { ok: true, parsed };\n}",
      ),
    );
    const result = mutant.judgeRawPreservation({
      preserved: JSON.stringify(["a", "b", "c"]),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    assert.notEqual(
      result.reasonCode,
      "RAW_SHAPE_MISMATCH",
      "mutant must fail to classify a top-level array as RAW_SHAPE_MISMATCH (RED signal for the mutation; proves the isPlainObject structural guard is load-bearing for the fixed-reasonCode contract, independent of the downstream key-set-mismatch safety net)",
    );
  },
);

test(
  "NC mutation/raw-preserve-core #3: removing the normalization-footprint (RAW_NORMALIZED) check ('가공 흔적 검사 제거') -> RED (a record with an extra our-side field now passes as PRESERVED instead of being rejected)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (JSON.stringify(parsedKeys) !== JSON.stringify(expectedKeys)) {\n    return RAW_PRESERVATION_REASON.RAW_NORMALIZED;\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeRawPreservation({
      preserved: JSON.stringify(TERMINAL_EXTRA_FIELD),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    assert.equal(
      result.verdict,
      "PRESERVED",
      "mutant must let a record with an extra our-side field ('normalizedBy') pass as PRESERVED (RED signal for the mutation; proves the exact key-set (RAW_NORMALIZED) check is load-bearing, not merely redundant)",
    );
  },
);

test(
  "NC mutation/raw-preserve-core #4: loosening PRESERVED from 'exact type match' to 'not an error' ('PRESERVED 조건을 «오류 아님»으로 느슨화') -> RED (a field present with the wrong type now passes as PRESERVED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  for (const key of expectedKeys) {\n    if (typeof parsed[key] !== expected[key]) {\n      return RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH;\n    }\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeRawPreservation({
      preserved: JSON.stringify(TERMINAL_WRONG_TYPE),
      expected: TERMINAL_SHOW_RAW_FIELD_TYPES,
      now: NOW,
    });
    assert.equal(
      result.verdict,
      "PRESERVED",
      "mutant must let a field with the wrong type ('connected' as a string, not boolean) pass as PRESERVED (RED signal for the mutation; proves the per-field type-check loop is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언 (§2 비타협 #6).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "raw-preserve-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "raw-preserve-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
