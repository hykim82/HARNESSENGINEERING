// HYK-183 A-3 (coder-task.md §5-3, §6, §3) -- budget-core.mjs 계약 시험
// (SV-6: 한도 오류 시 WAIT_BUDGET 전환, UNAVAILABLE을 "충분함"으로 해석
// 0).
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 주장 범위 -- 여기서 만드는 `observation`은 전부 손으로 조립한
//    SYNTHETIC 리터럴이다. 실제 Claude 계정 한도 조회 표면은 2026-07-28
//    확정대로 존재하지 않으므로, 실제 운영에서 이 형태의 관측이 어떻게
//    수집되는지는 이 시험의 범위 밖이다.
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
// 3. 이 스위트가 100% 통과해도 "지금 한도가 얼마나 남았는지"를 증명하지
//    않는다 -- judgeBudget 자신의 헤더 주석과 동일한 한계가 그대로
//    적용된다.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { judgeBudget, BUDGET_REASON, BUDGET_DECISION } from "./budget-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();

// §2 비타협 #6 -- 원상복구 단언 준비(concurrency-core.test.mjs 선례 그대로).
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
// (d) 관측이 "여유 있음"을 명시할 때만 PROCEED.
// ---------------------------------------------------------------------------
test("(d) observation.status='OK' -> ok:true, PROCEED, BUDGET_OK", () => {
  const result = judgeBudget({ observation: { status: "OK" }, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.decision, BUDGET_DECISION.PROCEED);
  assert.equal(result.reasonCode, BUDGET_REASON.BUDGET_OK);
});

// ---------------------------------------------------------------------------
// (d) 관측이 "한도 소진"을 명시할 때도 WAIT_BUDGET.
// ---------------------------------------------------------------------------
test("(d) observation.status='EXHAUSTED' -> WAIT_BUDGET, BUDGET_EXHAUSTED (not PROCEED)", () => {
  const result = judgeBudget({
    observation: { status: "EXHAUSTED" },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, BUDGET_DECISION.WAIT_BUDGET);
  assert.equal(result.reasonCode, BUDGET_REASON.BUDGET_EXHAUSTED);
});

// ---------------------------------------------------------------------------
// (b)(c) 한도 오류(조회 실패·형식 이상·예외)를 넣어도 전건 WAIT_BUDGET이며
// PROCEED가 나오지 않음 -- "모름"을 "충분함"으로 접지 않는다.
// ---------------------------------------------------------------------------
const throwingObservation = {
  get status() {
    throw new Error("synthetic read failure from a hostile observation");
  },
};

const ERROR_OBSERVATION_FIXTURES = [
  { label: "null", observation: null },
  { label: "undefined", observation: undefined },
  { label: "a string", observation: "OK" },
  { label: "a number", observation: 1 },
  { label: "an empty object", observation: {} },
  { label: "an array", observation: [] },
  {
    label: "status is UNAVAILABLE",
    observation: { status: "UNAVAILABLE" },
  },
  {
    label: "status is an unknown value (typo)",
    observation: { status: "ok" },
  },
  { label: "status is missing", observation: { note: "no status field" } },
  { label: "status is null", observation: { status: null } },
  { label: "status is a number", observation: { status: 100 } },
  {
    label: "status throws when read",
    observation: throwingObservation,
  },
];
for (const { label, observation } of ERROR_OBSERVATION_FIXTURES) {
  test(`(b)(c) observation is an error/unavailable/malformed shape (${label}) -> WAIT_BUDGET, never PROCEED (denominator: ${ERROR_OBSERVATION_FIXTURES.length})`, () => {
    const result = judgeBudget({ observation, now: NOW });
    assert.equal(result.decision, BUDGET_DECISION.WAIT_BUDGET);
    assert.notEqual(result.reasonCode, BUDGET_REASON.BUDGET_OK);
  });
}

test("false-positive count is 0 across all error/unavailable/malformed fixtures above (every one produced WAIT_BUDGET, denominator with the OK/EXHAUSTED positives excluded)", () => {
  const falsePositives = ERROR_OBSERVATION_FIXTURES.filter(
    ({ observation }) => {
      const result = judgeBudget({ observation, now: NOW });
      return result.decision === BUDGET_DECISION.PROCEED;
    },
  );
  assert.deepEqual(
    falsePositives.map((f) => f.label),
    [],
    `denominator=${ERROR_OBSERVATION_FIXTURES.length}, false positives=${falsePositives.length}`,
  );
});

// ---------------------------------------------------------------------------
// (b) UNAVAILABLE은 별도의 정확한 사유 코드(BUDGET_UNAVAILABLE)를 받는다 --
// BUDGET_OK와 같은 갈래로 접히지 않는다는 것을 사유 코드 수준에서도 확인.
// ---------------------------------------------------------------------------
test("(b) observation.status='UNAVAILABLE' -> WAIT_BUDGET with BUDGET_UNAVAILABLE specifically (not folded into BUDGET_OK or BUDGET_MALFORMED)", () => {
  const result = judgeBudget({
    observation: { status: "UNAVAILABLE" },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, BUDGET_DECISION.WAIT_BUDGET);
  assert.equal(result.reasonCode, BUDGET_REASON.BUDGET_UNAVAILABLE);
});

test("(b) a structurally malformed observation (not a plain object) -> WAIT_BUDGET with BUDGET_UNAVAILABLE (cannot even read status)", () => {
  const result = judgeBudget({ observation: "not-an-object", now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, BUDGET_REASON.BUDGET_UNAVAILABLE);
});

test("(b) an unknown status value on an otherwise well-formed object -> WAIT_BUDGET with BUDGET_MALFORMED specifically", () => {
  const result = judgeBudget({
    observation: { status: "SOMETHING_ELSE" },
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, BUDGET_REASON.BUDGET_MALFORMED);
});

// ---------------------------------------------------------------------------
// (a) 순수 함수 -- 결정적, 예외 없음.
// ---------------------------------------------------------------------------
test("(a) same input twice -> identical decision and reasonCode (deterministic, no crash)", () => {
  const input = { observation: { status: "OK" }, now: NOW };
  const first = judgeBudget(input);
  const second = judgeBudget(input);
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// fail-closed / INVALID_ARGUMENTS -- 최상위 인자가 이상하면 예외 없이
// ok:false + WAIT_BUDGET(never PROCEED even on invalid shape).
// ---------------------------------------------------------------------------
for (const badArgs of [null, undefined, "observation", 42, [], true]) {
  test(`fail-closed: judgeBudget(${JSON.stringify(badArgs)}) -> ok:false, WAIT_BUDGET, INVALID_ARGUMENTS`, () => {
    const result = judgeBudget(badArgs);
    assert.equal(result.ok, false);
    assert.equal(result.decision, BUDGET_DECISION.WAIT_BUDGET);
    assert.equal(result.reasonCode, BUDGET_REASON.INVALID_ARGUMENTS);
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
  test(`fail-closed: now=${JSON.stringify(badNow)} -> ok:false, WAIT_BUDGET, INVALID_ARGUMENTS`, () => {
    const result = judgeBudget({ observation: { status: "OK" }, now: badNow });
    assert.equal(result.ok, false);
    assert.equal(result.decision, BUDGET_DECISION.WAIT_BUDGET);
    assert.equal(result.reasonCode, BUDGET_REASON.INVALID_ARGUMENTS);
  });
}

// ---------------------------------------------------------------------------
// purity -- 입력을 변형하지 않는다.
// ---------------------------------------------------------------------------
test("purity: judgeBudget does not mutate its input observation", () => {
  const input = { observation: { status: "OK" }, now: NOW };
  const clone = JSON.parse(JSON.stringify(input));
  judgeBudget(input);
  assert.deepEqual(input, clone);
});

// ---------------------------------------------------------------------------
// (a) 부작용 0 -- 주입된 감시자(spy)로 fs/child_process/네트워크 호출
// 횟수가 0임을 단언한다("안 했다"는 서술이 아니라 호출되지 않았음의
// 단언, concurrency-core.test.mjs 선례 그대로).
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
        throw new Error(`unexpected fs.${name} call from judgeBudget`);
      }),
    );
  try {
    judgeBudget({ observation: { status: "OK" }, now: NOW });
    judgeBudget({ observation: { status: "EXHAUSTED" }, now: NOW });
    judgeBudget({ observation: { status: "UNAVAILABLE" }, now: NOW });
    judgeBudget({ observation: null, now: NOW });
    judgeBudget({ observation: throwingObservation, now: NOW });
    judgeBudget(null);
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
          `unexpected child_process.${name} call from judgeBudget`,
        );
      }),
    );
  try {
    judgeBudget({ observation: { status: "OK" }, now: NOW });
    judgeBudget({ observation: { status: "UNAVAILABLE" }, now: NOW });
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
        throw new Error("unexpected fetch call from judgeBudget");
      })
    : null;
  try {
    judgeBudget({ observation: { status: "OK" }, now: NOW });
    judgeBudget({ observation: { status: "EXHAUSTED" }, now: NOW });
    if (fetchMock) {
      assert.equal(fetchMock.mock.calls.length, 0);
    }
  } finally {
    if (fetchMock) fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// §3(f) 판별력 자동화 -- copy-and-mutate 층(concurrency-core.test.mjs 선례
// 재사용). 추적본(git show HEAD:)에서 소스를 읽어 mkdtemp에 변조 사본을
// 쓰고 동적 import()로 불러온다. 신규 파일이라 아직 HEAD에 없으면 명시적
// 사유로 skip한다(커밋 후 자동 실행 -- no-op 아님).
// ---------------------------------------------------------------------------
let BUDGET_CORE_SRC = null;
try {
  BUDGET_CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/budget-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  BUDGET_CORE_SRC = null;
}
const SRC_COMMITTED = BUDGET_CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "budget-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본(이 시험이 `git show HEAD:`로 읽는 스냅샷)에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-budget-core-mutant-"));
  const mutated = mutate(BUDGET_CORE_SRC);
  const filePath = join(dir, "budget-core.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/budget-core #1: removing the structural isPlainObject guard ('형식 이상(비-plain-object 관측) 처리 제거') -> RED (an array carrying an injected status='OK' property -- which the real guard rejects on shape alone -- now yields PROCEED instead of WAIT_BUDGET)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "    if (!isPlainObject(observation)) {\n      return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);\n    }\n",
        "",
      ),
    );
    const hostileObservation = Object.assign([], { status: "OK" });
    const result = mutant.judgeBudget({
      observation: hostileObservation,
      now: NOW,
    });
    assert.equal(
      result.decision,
      "PROCEED",
      "mutant must let a structurally-invalid (array-shaped) observation with an injected status='OK' fall through to PROCEED (RED signal for the mutation; proves the isPlainObject structural guard is load-bearing, not merely redundant)",
    );
  },
);

test(
  "NC mutation/budget-core #2: removing the exception guard around reading observation.status ('예외 처리 제거') -> RED (an observation whose status getter throws now propagates an uncaught exception instead of returning WAIT_BUDGET -- violates the no-throw contract directly)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        '  let status;\n  try {\n    if (!isPlainObject(observation)) {\n      return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);\n    }\n    status = observation.status;\n  } catch {\n    // observation이 getter에서 예외를 던지는 형태일 수 있다 -- 관측\n    // 자체를 읽을 수 없으므로 "판정 불가"로 취급한다.\n    return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);\n  }\n',
        "  let status;\n  if (!isPlainObject(observation)) {\n    return waitFor(BUDGET_REASON.BUDGET_UNAVAILABLE);\n  }\n  status = observation.status;\n",
      ),
    );
    const throwingObservationForMutant = {
      get status() {
        throw new Error("synthetic read failure");
      },
    };
    assert.throws(
      () =>
        mutant.judgeBudget({
          observation: throwingObservationForMutant,
          now: NOW,
        }),
      "mutant must let the status-read exception propagate uncaught instead of returning WAIT_BUDGET (RED signal for the mutation; proves the try/catch exception guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/budget-core #3: removing the exhausted-status branch ('소진 판정 제거') -> RED (an explicit EXHAUSTED observation is no longer classified as BUDGET_EXHAUSTED -- misclassified as BUDGET_MALFORMED, breaking the fixed-reasonCode contract even though decision-level WAIT_BUDGET happens to survive via the fallback)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        '  if (status === "EXHAUSTED") {\n    return waitFor(BUDGET_REASON.BUDGET_EXHAUSTED);\n  }\n',
        "",
      ),
    );
    const result = mutant.judgeBudget({
      observation: { status: "EXHAUSTED" },
      now: NOW,
    });
    assert.notEqual(
      result.reasonCode,
      "BUDGET_EXHAUSTED",
      "mutant must fail to classify an EXHAUSTED observation as BUDGET_EXHAUSTED (RED signal for the mutation; proves the dedicated exhausted-status branch is load-bearing for the fixed-reasonCode contract in §5, independent of the decision-level fallback safety net)",
    );
  },
);

test(
  "NC mutation/budget-core #4: loosening the PROCEED condition from 'explicitly OK' to 'not an error' ('PROCEED 조건을 «명시적 여유»에서 «오류 아님»으로 느슨화') -> RED (an unknown/malformed status now yields PROCEED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  // status가 KNOWN_STATUS 3종(OK/EXHAUSTED/UNAVAILABLE) 밖의 값이면\n  // 형식 이상 -- 오탈자·미지의 값·누락(undefined)을 전부 여기서 막는다.\n  return waitFor(BUDGET_REASON.BUDGET_MALFORMED);\n",
        "  return {\n    ok: true,\n    decision: BUDGET_DECISION.PROCEED,\n    reasonCode: BUDGET_REASON.BUDGET_OK,\n  };\n",
      ),
    );
    const result = mutant.judgeBudget({
      observation: { status: "SOME_TYPO" },
      now: NOW,
    });
    assert.equal(
      result.decision,
      "PROCEED",
      "mutant must let an unknown status value fall through to PROCEED (RED signal for the mutation; proves the explicit-OK-only PROCEED condition is load-bearing)",
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
    "budget-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "budget-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
