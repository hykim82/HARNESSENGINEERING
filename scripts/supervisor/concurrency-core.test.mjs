// HYK-183 A-2 (coder-task.md §5-2, §6, §11) -- concurrency-core.mjs 계약
// 시험(SV-5: 동시 실행 v1=1 초과 0, 전역 hard cap 2).
//
// HYK-193 1R 갱신 -- S-5는 `PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1`
// 로 개정됐다: "동시 실행이 그때 유효한 상한을 넘지 않는다. 상한은
// 고정 숫자가 아니라 한용이 정한 현재 값이며, supervisor는 그 값을
// 읽어서 쓴다(스스로 정하지 않는다)". `judgeConcurrency`는 이제 그 상한
// 값을 코드 상수가 아니라 호출자가 주입하는 `globalCap` 인자로
// 받는다(값 2는 여전히 «현재 실효값»이지만, 이 시험 파일이 그 값을
// 정하는 것이 아니라 매 호출마다 인자로 주입할 뿐이다 -- 아래
// `CURRENT_GLOBAL_CAP` 참조). S-5 회귀 시험(Standing-A)은 파일 하단
// "S-5 regression" 절 참조.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 주장 범위 -- 여기서 만드는 `inFlight`/`requested`는 전부 손으로
//    조립한 SYNTHETIC 리터럴이다. 실행 상태 장부의 실제 위치·형식은
//    미정(coder-task.md §2-3)이므로, 실제 운영에서 수집된 inFlight 값이
//    이 형태와 일치하는지는 이 시험의 범위 밖이다(다음 사이클 몫).
// 2. 표본 수와 조건 -- 각 test 이름에 분모를 명시한다.
// 3. 이 스위트가 100% 통과해도 "지금 진행 중인 것이 실제로 몇 개인지"를
//    증명하지 않는다 -- judgeConcurrency 자신의 헤더 주석과 동일한
//    한계가 그대로 적용된다.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeConcurrency,
  CONCURRENCY_REASON,
  CONCURRENCY_DECISION,
} from "./concurrency-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

const ROOT = repoRoot();

// §2 비타협 #6 -- 원상복구 단언 준비(executor-core.test.mjs 선례 그대로).
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
function candidate(issueId) {
  return { issueId };
}

function inFlightItem(issueId) {
  return { issueId };
}

const V1_POLICY = Object.freeze({ maxConcurrent: 1 });
// HYK-193 1R -- globalCap은 이제 호출자 주입값이다(concurrency-cap.json의
// 현재 값 2와 같게 둔다, coder-task.md §8-3 "초기 값은 현재 실효값과
// 같게"). 이 시험 파일에서 이 상수를 쓰는 자리는 전부 "기존 v1=1 +
// hard cap 2" 시나리오를 그대로 재현하려는 것뿐 -- 값 자체를 이 시험이
// 정하지 않는다.
const CURRENT_GLOBAL_CAP = 2;

function decisionFor(result, issueId) {
  return result.decisions.find((d) => d.issueId === issueId)?.decision;
}

// ---------------------------------------------------------------------------
// (b) 2건이 동시에 요구될 때 정확히 1건만 START, 나머지는 WAIT.
// ---------------------------------------------------------------------------
test("(b) two candidates requested simultaneously, nothing in flight, v1 policy(maxConcurrent=1) -> exactly 1 START, 1 WAIT", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-100"), candidate("HYK-101")],
    inFlight: [],
    policy: V1_POLICY,
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, CONCURRENCY_REASON.DECIDED);
  const starts = result.decisions.filter(
    (d) => d.decision === CONCURRENCY_DECISION.START,
  );
  const waits = result.decisions.filter(
    (d) => d.decision === CONCURRENCY_DECISION.WAIT,
  );
  assert.equal(starts.length, 1);
  assert.equal(waits.length, 1);
  assert.equal(decisionFor(result, "HYK-100"), CONCURRENCY_DECISION.START);
  assert.equal(decisionFor(result, "HYK-101"), CONCURRENCY_DECISION.WAIT);
});

// ---------------------------------------------------------------------------
// (c) 이미 진행 중인 항목이 있으면 새 시작이 0.
// ---------------------------------------------------------------------------
test("(c) one item already in flight, v1 policy(maxConcurrent=1) -> new starts = 0 (all requested WAIT)", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-102"), candidate("HYK-103")],
    inFlight: [inFlightItem("HYK-100")],
    policy: V1_POLICY,
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  assert.equal(result.reasonCode, CONCURRENCY_REASON.DECIDED);
  const starts = result.decisions.filter(
    (d) => d.decision === CONCURRENCY_DECISION.START,
  );
  assert.equal(starts.length, 0, "no new start while one is already in flight");
});

test("(c-single) single candidate requested while one item already in flight (maxConcurrent=1) -> WAIT, not START", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-200")],
    inFlight: [inFlightItem("HYK-199")],
    policy: V1_POLICY,
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  assert.equal(decisionFor(result, "HYK-200"), CONCURRENCY_DECISION.WAIT);
});

// ---------------------------------------------------------------------------
// (d) 전역 hard cap 2를 넘는 요구는 어떤 경우에도 START가 되지 않음 -- 정책이
// 오설정(또는 공격)돼 hard cap보다 큰 값을 요청해도 이 코어 자신이 2로
// clamp한다.
// ---------------------------------------------------------------------------
test("(d) misconfigured policy requesting maxConcurrent=999, 3 candidates, nothing in flight -> at most 2 STARTs, never 3", () => {
  const result = judgeConcurrency({
    requested: [
      candidate("HYK-300"),
      candidate("HYK-301"),
      candidate("HYK-302"),
    ],
    inFlight: [],
    policy: { maxConcurrent: 999 },
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  const starts = result.decisions.filter(
    (d) => d.decision === CONCURRENCY_DECISION.START,
  );
  assert.equal(
    starts.length,
    2,
    "the injected globalCap (2) must win over an oversized policy value",
  );
});

test("(d) misconfigured policy requesting maxConcurrent=999 with 1 already in flight -> at most 1 new START (2 - 1 in flight), never unlimited", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-303"), candidate("HYK-304")],
    inFlight: [inFlightItem("HYK-299")],
    policy: { maxConcurrent: 999 },
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  const starts = result.decisions.filter(
    (d) => d.decision === CONCURRENCY_DECISION.START,
  );
  assert.equal(starts.length, 1);
});

// ---------------------------------------------------------------------------
// (e) 판정 불가(진행 상태를 읽을 수 없음)일 때 START가 아니라 정지 -- "모름"을
// "비어 있음"으로 접지 않는다.
// ---------------------------------------------------------------------------
const UNREADABLE_IN_FLIGHT_FIXTURES = [
  { label: "null", inFlight: null },
  { label: "undefined", inFlight: undefined },
  { label: "a string", inFlight: "not-an-array" },
  { label: "a plain object", inFlight: {} },
  {
    label: "an array containing null",
    inFlight: [inFlightItem("HYK-1"), null],
  },
  {
    label: "an array containing undefined",
    inFlight: [undefined, inFlightItem("HYK-2")],
  },
];
for (const { label, inFlight } of UNREADABLE_IN_FLIGHT_FIXTURES) {
  test(`(e) inFlight is unreadable (${label}) -> ok:false, decisions:[], IN_FLIGHT_UNREADABLE, no START (denominator: ${UNREADABLE_IN_FLIGHT_FIXTURES.length})`, () => {
    const result = judgeConcurrency({
      requested: [candidate("HYK-400")],
      inFlight,
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.decisions, []);
    assert.equal(result.reasonCode, CONCURRENCY_REASON.IN_FLIGHT_UNREADABLE);
  });
}

test("false-positive count is 0 across all unreadable-inFlight fixtures above (every one produced ok:false)", () => {
  const falsePositives = UNREADABLE_IN_FLIGHT_FIXTURES.filter(
    ({ inFlight }) => {
      const result = judgeConcurrency({
        requested: [candidate("HYK-401")],
        inFlight,
        policy: V1_POLICY,
        globalCap: CURRENT_GLOBAL_CAP,
      });
      return result.ok !== false;
    },
  );
  assert.deepEqual(
    falsePositives.map((f) => f.label),
    [],
    `denominator=${UNREADABLE_IN_FLIGHT_FIXTURES.length}, false positives=${falsePositives.length}`,
  );
});

// ---------------------------------------------------------------------------
// (a) 순수 함수로 분리 -- 없는 요청(requested가 빈 배열)이어도 예외 없이
// 결정적으로 판정한다(파생 확인, §3-a의 "판정이 순수 함수" 요구를 뒷받침).
// ---------------------------------------------------------------------------
test("(a) empty requested list, nothing in flight -> ok:true, decisions:[] (trivially decided, no crash)", () => {
  const result = judgeConcurrency({
    requested: [],
    inFlight: [],
    policy: V1_POLICY,
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.reasonCode, CONCURRENCY_REASON.DECIDED);
});

test("policy.maxConcurrent=0 (deliberately pausing all starts) -> all requested WAIT", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-500")],
    inFlight: [],
    policy: { maxConcurrent: 0 },
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, true);
  assert.equal(decisionFor(result, "HYK-500"), CONCURRENCY_DECISION.WAIT);
});

// ---------------------------------------------------------------------------
// fail-closed / INVALID_ARGUMENTS -- 인자가 이상하면 예외 없이 ok:false +
// decisions:[].
// ---------------------------------------------------------------------------
for (const badArgs of [null, undefined, "requested", 42, [], true]) {
  test(`fail-closed: judgeConcurrency(${JSON.stringify(badArgs)}) -> INVALID_ARGUMENTS`, () => {
    const result = judgeConcurrency(badArgs);
    assert.equal(result.ok, false);
    assert.deepEqual(result.decisions, []);
    assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
  });
}

for (const badRequested of [null, undefined, "x", 1, {}, true]) {
  test(`fail-closed: requested=${JSON.stringify(badRequested)} -> INVALID_ARGUMENTS`, () => {
    const result = judgeConcurrency({
      requested: badRequested,
      inFlight: [],
      policy: V1_POLICY,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
  });
}

test("fail-closed: a malformed candidate (missing issueId) among requested -> INVALID_ARGUMENTS, no crash", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-600"), {}],
    inFlight: [],
    policy: V1_POLICY,
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
});

test("fail-closed: a candidate with non-string issueId -> INVALID_ARGUMENTS, no crash", () => {
  const result = judgeConcurrency({
    requested: [{ issueId: 12345 }],
    inFlight: [],
    policy: V1_POLICY,
    globalCap: CURRENT_GLOBAL_CAP,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
});

for (const badPolicy of [null, undefined, "x", 1, [], true, {}]) {
  test(`fail-closed: policy=${JSON.stringify(badPolicy)} -> INVALID_ARGUMENTS`, () => {
    const result = judgeConcurrency({
      requested: [],
      inFlight: [],
      policy: badPolicy,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
  });
}

for (const badMax of [-1, 1.5, NaN, Infinity, "1", null]) {
  test(`fail-closed: policy.maxConcurrent=${JSON.stringify(badMax)} -> INVALID_ARGUMENTS`, () => {
    const result = judgeConcurrency({
      requested: [],
      inFlight: [],
      policy: { maxConcurrent: badMax },
      globalCap: CURRENT_GLOBAL_CAP,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
  });
}

// ---------------------------------------------------------------------------
// HYK-193 1R (coder-task.md §3, §5) -- globalCap 자체가 fail-closed다.
// ⛔주입이 없거나 형태가 이상해도 이 코어는 어떤 숫자로도(특히 옛
// GLOBAL_HARD_CAP과 같은 2로도) 대신 판정하지 않는다 -- "주입 없음 =
// 판정 불가"가 문자 그대로 거부로 이어지는지를 확인한다(그 폴백 자체가
// 되살아난 코드 상수라는 §3 핵심 판단의 직접 시험).
// ---------------------------------------------------------------------------
test("fail-closed: globalCap key entirely absent from args (not injected at all) -> INVALID_ARGUMENTS, no silent fallback to any default cap", () => {
  const result = judgeConcurrency({
    requested: [candidate("HYK-GC-ABSENT")],
    inFlight: [],
    policy: V1_POLICY,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.decisions, []);
  assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
});

for (const badGlobalCap of [
  undefined,
  null,
  -1,
  1.5,
  NaN,
  Infinity,
  "2",
  [],
  true,
  {},
]) {
  test(`fail-closed: globalCap=${JSON.stringify(badGlobalCap)} -> INVALID_ARGUMENTS (denominator: 10, no fallback to a default cap)`, () => {
    const result = judgeConcurrency({
      requested: [candidate("HYK-GC-BAD")],
      inFlight: [],
      policy: V1_POLICY,
      globalCap: badGlobalCap,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.decisions, []);
    assert.equal(result.reasonCode, CONCURRENCY_REASON.INVALID_ARGUMENTS);
  });
}

// ---------------------------------------------------------------------------
// ok:false -> decisions은 항상 []( 부분 판정 금지) -- 여러 반례에 걸쳐
// 재확인.
// ---------------------------------------------------------------------------
test("every ok:false result across all negative fixtures above returns decisions === []", () => {
  const negativeArgs = [
    null,
    { requested: "x", inFlight: [], policy: V1_POLICY },
    { requested: [], inFlight: null, policy: V1_POLICY },
    { requested: [], inFlight: [], policy: {} },
  ];
  for (const args of negativeArgs) {
    const result = judgeConcurrency(args);
    assert.equal(result.ok, false);
    assert.deepEqual(result.decisions, []);
  }
});

// ---------------------------------------------------------------------------
// purity -- 입력을 변형하지 않는다.
// ---------------------------------------------------------------------------
test("purity: judgeConcurrency does not mutate its input requested/inFlight/policy", () => {
  const input = {
    requested: [candidate("HYK-700"), candidate("HYK-701")],
    inFlight: [inFlightItem("HYK-699")],
    policy: { maxConcurrent: 1 },
    globalCap: CURRENT_GLOBAL_CAP,
  };
  const clone = JSON.parse(JSON.stringify(input));
  judgeConcurrency(input);
  assert.deepEqual(input, clone);
});

// ---------------------------------------------------------------------------
// §3(a) 부작용 0 -- 주입된 감시자(spy)로 fs/child_process/네트워크 호출
// 횟수가 0임을 단언한다("안 했다"는 서술이 아니라 호출되지 않았음의
// 단언, executor-core.test.mjs 선례 그대로).
// ---------------------------------------------------------------------------
test("side effects: fs write-family functions are never invoked while judging any of the above inputs (spied, not merely 'not imported')", () => {
  const watchedFsMethods = [
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
        throw new Error(`unexpected fs.${name} call from judgeConcurrency`);
      }),
    );
  try {
    judgeConcurrency({
      requested: [candidate("HYK-800"), candidate("HYK-801")],
      inFlight: [],
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    judgeConcurrency({
      requested: [candidate("HYK-802")],
      inFlight: [inFlightItem("HYK-799")],
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    judgeConcurrency(null);
    judgeConcurrency({ requested: [], inFlight: null, policy: V1_POLICY });
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
          `unexpected child_process.${name} call from judgeConcurrency`,
        );
      }),
    );
  try {
    judgeConcurrency({
      requested: [candidate("HYK-900")],
      inFlight: [],
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    judgeConcurrency({
      requested: [candidate("HYK-901")],
      inFlight: [inFlightItem("HYK-898")],
      policy: { maxConcurrent: 999 },
      globalCap: CURRENT_GLOBAL_CAP,
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
        throw new Error("unexpected fetch call from judgeConcurrency");
      })
    : null;
  try {
    judgeConcurrency({
      requested: [candidate("HYK-950")],
      inFlight: [],
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    judgeConcurrency({
      requested: [candidate("HYK-951")],
      inFlight: null,
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    if (fetchMock) {
      assert.equal(fetchMock.mock.calls.length, 0);
    }
  } finally {
    if (fetchMock) fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// §11 판별력 자동화 -- copy-and-mutate 층(executor-core.test.mjs /
// nc-review-gate.test.mjs 선례 재사용). 추적본(git show HEAD:)에서 소스를
// 읽어 mkdtemp에 변조 사본을 쓰고 동적 import()로 불러온다. 신규 파일이라
// 아직 HEAD에 없으면 명시적 사유로 skip한다(커밋 후 자동 실행 -- no-op
// 아님).
// ---------------------------------------------------------------------------
let CONCURRENCY_CORE_SRC = null;
try {
  CONCURRENCY_CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/concurrency-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CONCURRENCY_CORE_SRC = null;
}
const SRC_COMMITTED = CONCURRENCY_CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "concurrency-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본(이 시험이 `git show HEAD:`로 읽는 스냅샷)에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

// HYK-193 1R -- 이 파일은 신규가 아니라 이미 커밋된 기존 파일이라
// SRC_COMMITTED는 이미 true지만, git HEAD 추적본은 아직 GLOBAL_HARD_CAP
// 상수를 쓰던 개정 전 버전이다(이 사이클은 커밋하지 않는다, coder-
// task.md §8-1). `globalCap` 식별자를 표적으로 삼는 mutation(#2, #5)은
// 그 문자열이 HEAD 추적본에 아직 없으면 no-op 치환이 되어 오탐(엉뚱한
// 실패)을 낸다 -- 이 조건을 SRC_COMMITTED와 별도로 확인해 그런 경우
// 명시적으로 skip한다(같은 skip 규약: 커밋 후 자동 해제, no-op 아님).
const SRC_HAS_INJECTED_GLOBAL_CAP =
  SRC_COMMITTED &&
  CONCURRENCY_CORE_SRC.includes(
    "const effectiveCap = Math.min(policy.maxConcurrent, globalCap);",
  );
const GLOBALCAP_NOT_COMMITTED_SKIP_REASON =
  "git HEAD 추적본의 concurrency-core.mjs가 아직 HYK-193 개정 전(GLOBAL_HARD_CAP 상수 버전)이라 `globalCap` 식별자를 표적으로 하는 이 mutation의 치환 문자열이 HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_HAS_INJECTED_GLOBAL_CAP이 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-concurrency-core-mutant-"));
  const mutated = mutate(CONCURRENCY_CORE_SRC);
  const filePath = join(dir, "concurrency-core.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/concurrency-core #1: neutralizing the START-count cap ('START 최대 1개 제한 무력화') -> RED (all requested candidates START at once, ignoring policy.maxConcurrent)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  const startsAllowed = Math.min(availableSlots, requested.length);\n",
        "  const startsAllowed = requested.length;\n",
      ),
    );
    const result = mutant.judgeConcurrency({
      requested: [candidate("HYK-M1-A"), candidate("HYK-M1-B")],
      inFlight: [],
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    const starts = result.decisions.filter(
      (d) => d.decision === CONCURRENCY_DECISION.START,
    );
    assert.equal(
      starts.length,
      2,
      "mutant must start both candidates despite policy.maxConcurrent=1 (RED signal for the mutation; proves the START-count cap is load-bearing)",
    );
  },
);

test(
  "NC mutation/concurrency-core #2: removing the injected-globalCap clamp entirely ('전역 상한 clamp 제거') -> RED (a misconfigured policy.maxConcurrent=999 now starts more than globalCap)",
  {
    skip:
      (!SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON) ||
      (!SRC_HAS_INJECTED_GLOBAL_CAP && GLOBALCAP_NOT_COMMITTED_SKIP_REASON),
  },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  const effectiveCap = Math.min(policy.maxConcurrent, globalCap);\n",
        "  const effectiveCap = policy.maxConcurrent;\n",
      ),
    );
    const result = mutant.judgeConcurrency({
      requested: [
        candidate("HYK-M2-A"),
        candidate("HYK-M2-B"),
        candidate("HYK-M2-C"),
      ],
      inFlight: [],
      policy: { maxConcurrent: 999 },
      globalCap: CURRENT_GLOBAL_CAP,
    });
    const starts = result.decisions.filter(
      (d) => d.decision === CONCURRENCY_DECISION.START,
    );
    assert.equal(
      starts.length,
      3,
      "mutant must start more than the injected globalCap (2) candidates (RED signal for the mutation; proves the hard-cap clamp is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// HYK-193 1R §5 -- S-5 회귀 시험(Standing-A): "상한이 코드 상수로
// 되돌아오면 빨간불".
//
// ★어떻게 증명하는가: 소스에 숫자 리터럴이 있는지 문자열로 검사하지
// 않는다(취약함 -- 주석·다른 상수와 충돌할 수 있다, coder-task.md §5).
// 대신 "주입된 값을 바꿔 넣으면 판정이 따라 움직이는가"를 **행동으로**
// 확인한다 -- 같은 requested/inFlight/policy에 서로 다른 globalCap(2와
// 5)을 주입해 START 개수가 그 값을 그대로 따라가는지 본다. 이 값들 중
// 어느 쪽도 이 코어 안의 상수가 아니라 이 시험이 호출 시점에 주입하는
// 인자다.
//
// 이 시험이 보장하는 것: 지금 커밋된 concurrency-core.mjs가 전역 상한을
// `globalCap` 인자에서 읽어 그대로 반영한다(고정된 숫자를 무시하고
// 자체 판단으로 clamp하지 않는다). 누군가 `effectiveCap` 계산을
// `Math.min(policy.maxConcurrent, 2)`처럼 다시 하드코딩하면(globalCap을
// 무시하면) 아래 두 번째 단언(globalCap=5 -> 5 STARTs)이 실패해 이
// 시험이 RED가 된다(Standing-A 요구).
//
// 이 시험이 보장하지 않는 것(⛔전칭 주장 금지):
// 1. 값 파일(`concurrency-cap.json`)이 실제로 이 인자에 결선돼 있는지는
//    이 시험의 범위 밖이다 -- 그 결선은 아직 아무도 하지 않았다
//    (live=false, 호출자 없음). 이 시험은 코어가 "주입받으면 반응한다"
//    만 증명하고, "실제로 파일에서 주입받고 있다"는 증명하지 않는다
//    (그 후자는 concurrency-cap-adapter.test.mjs의 몫이며, 그 시험도
//    파일->숫자 변환까지만 증명하고 그 숫자가 이 코어에 실제로
//    전달되는지는 결선 코드가 없어 증명하지 못한다 -- 세 조각을 이어
//    붙이는 통합 시험은 이 사이클의 범위 밖이다, coder-task.md §7 참조
//    HYK-195와 같은 종류의 "다음 사이클 몫").
// 2. globalCap이 "한용이 정한 올바른 값"인지는 판단하지 않는다 -- 이
//    시험은 "다른 숫자를 넣으면 다른 결과가 나온다"만 보이며, 그 숫자
//    자체가 옳은 값인지는 이 코어의 관심사가 아니다(값의 정합성은 값
//    파일 커밋을 승인하는 사람의 몫).
// 3. 이 한 시험이 "다시는 코드 상수로 되돌아가지 않는다"를 영구히
//    보장하지 않는다 -- 이 시험 자체가 삭제되거나 약화되면(예: 두
//    globalCap 값에 대한 단언 중 하나만 남기면) 이 보호도 사라진다.
//    이 시험이 막는 것은 "이 시험이 그대로 남아 있는 채 코드만
//    바뀌는" 경우로 한정된다.
// ---------------------------------------------------------------------------
test("S-5 regression (Standing-A): changing the injected globalCap changes the decision -- proves the cap is read from an injected value, not re-hardcoded", () => {
  const requested = [
    candidate("HYK-S5-A"),
    candidate("HYK-S5-B"),
    candidate("HYK-S5-C"),
    candidate("HYK-S5-D"),
    candidate("HYK-S5-E"),
  ];
  const policy = { maxConcurrent: 999 };

  const withCap2 = judgeConcurrency({
    requested,
    inFlight: [],
    policy,
    globalCap: 2,
  });
  const withCap5 = judgeConcurrency({
    requested,
    inFlight: [],
    policy,
    globalCap: 5,
  });

  assert.equal(withCap2.ok, true);
  assert.equal(withCap5.ok, true);
  const startsFor = (result) =>
    result.decisions.filter((d) => d.decision === CONCURRENCY_DECISION.START)
      .length;
  assert.equal(
    startsFor(withCap2),
    2,
    "globalCap=2 must allow exactly 2 STARTs",
  );
  assert.equal(
    startsFor(withCap5),
    5,
    "globalCap=5 must allow exactly 5 STARTs -- if this fails while globalCap=2 above still passes, the source has stopped reading the injected value (S-5 regression, Standing-A RED)",
  );
});

test(
  "NC mutation/concurrency-core #5 (Standing-A): re-hardcoding the global cap back into source ('전역 상한을 코드 상수로 되돌림') -> RED (globalCap=5 injected but mutant still caps at 2, ignoring the injection)",
  {
    skip:
      (!SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON) ||
      (!SRC_HAS_INJECTED_GLOBAL_CAP && GLOBALCAP_NOT_COMMITTED_SKIP_REASON),
  },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  const effectiveCap = Math.min(policy.maxConcurrent, globalCap);\n",
        "  const effectiveCap = Math.min(policy.maxConcurrent, 2);\n",
      ),
    );
    const result = mutant.judgeConcurrency({
      requested: [
        candidate("HYK-M5-A"),
        candidate("HYK-M5-B"),
        candidate("HYK-M5-C"),
        candidate("HYK-M5-D"),
        candidate("HYK-M5-E"),
      ],
      inFlight: [],
      policy: { maxConcurrent: 999 },
      globalCap: 5,
    });
    const starts = result.decisions.filter(
      (d) => d.decision === CONCURRENCY_DECISION.START,
    );
    assert.equal(
      starts.length,
      2,
      "mutant must ignore the injected globalCap=5 and cap at the re-hardcoded 2 (RED signal for the mutation; proves the S-5 regression test above is load-bearing -- against the real source it would assert 5, not 2)",
    );
  },
);

test(
  "NC mutation/concurrency-core #3: removing the in-flight unreadable guard so it folds to empty ('inFlight 판정 불가 처리 제거(→ 빈 것으로 취급)') -> RED (a null inFlight now yields ok:true instead of IN_FLIGHT_UNREADABLE)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src
        .replace(
          "  if (!isWellFormedInFlight(inFlight)) return unreadable();\n\n",
          "",
        )
        .replace(
          "  const availableSlots = Math.max(0, effectiveCap - inFlight.length);\n",
          "  const availableSlots = Math.max(0, effectiveCap - (Array.isArray(inFlight) ? inFlight.length : 0));\n",
        ),
    );
    const result = mutant.judgeConcurrency({
      requested: [candidate("HYK-M3")],
      inFlight: null,
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    assert.equal(
      result.ok,
      true,
      "mutant must treat an unreadable (null) inFlight as empty and produce a decision (RED signal for the mutation; proves the unreadable-guard is load-bearing)",
    );
    assert.equal(decisionFor(result, "HYK-M3"), CONCURRENCY_DECISION.START);
  },
);

test(
  "NC mutation/concurrency-core #4: ignoring a non-empty in-flight count ('inFlight 비어있지 않을 때의 차단 제거') -> RED (a legitimate 1-item inFlight no longer blocks a new start)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  const availableSlots = Math.max(0, effectiveCap - inFlight.length);\n",
        "  const availableSlots = effectiveCap;\n",
      ),
    );
    const result = mutant.judgeConcurrency({
      requested: [candidate("HYK-M4")],
      inFlight: [inFlightItem("HYK-ALREADY-RUNNING")],
      policy: V1_POLICY,
      globalCap: CURRENT_GLOBAL_CAP,
    });
    assert.equal(
      decisionFor(result, "HYK-M4"),
      CONCURRENCY_DECISION.START,
      "mutant must start a new item even though one is already in flight (RED signal for the mutation; proves the in-flight block is load-bearing)",
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
    "concurrency-core.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "concurrency-core.test.mjs changed the tracked-file diff state -- must leave whatever diff existed before it ran untouched",
  );
});
