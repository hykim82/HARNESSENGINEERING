import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  CI_VERDICT,
  CI_EXIT_CODE,
  CI_REASON_CODE,
  classifyCiStatus,
  fetchCheckRuns as realFetchCheckRuns,
  pollCiStatus as realPollCiStatus,
} from "./ci-status.mjs";

// HYK-467 (coder-task.md §B-3): fetchCheckRuns now consults a SHARED,
// cross-process probe-budget file before every real call (probe-budget.mjs)
// -- this file's ~30 fetchCheckRuns/pollCiStatus calls must never touch the
// real machine-wide default path (that would (a) make this test file
// non-hermetic across repeated runs and (b) risk tripping the real shared
// budget for actual watchers running on this machine). Every call below
// (via the same-named local wrappers, so none of the ~30 existing call
// sites below needed editing) is pointed at a fresh, isolated tmp file
// with an effectively unlimited cap -- this file is not where the budget
// FEATURE itself is tested (that's probe-budget.test.mjs and the
// dedicated "§7 probe budget" section near the end of this file); it only
// needs the feature to be a no-op everywhere else.
const TEST_PROBE_BUDGET_PATH = join(
  mkdtempSync(join(tmpdir(), "ci-status-test-probe-budget-")),
  "budget.json",
);
const TEST_CAP_PER_HOUR = 1_000_000;

function fetchCheckRuns(args) {
  return realFetchCheckRuns({
    probeBudgetPath: TEST_PROBE_BUDGET_PATH,
    capPerHour: TEST_CAP_PER_HOUR,
    ...args,
  });
}
function pollCiStatus(args) {
  return realPollCiStatus({
    probeBudgetPath: TEST_PROBE_BUDGET_PATH,
    capPerHour: TEST_CAP_PER_HOUR,
    ...args,
  });
}

const THIS_FILE = fileURLToPath(import.meta.url);
const SOURCE_FILE = join(dirname(THIS_FILE), "ci-status.mjs");

function jsonResponse(status, bodyObj) {
  const text = JSON.stringify(bodyObj);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

function rawResponse(status, text) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
  };
}

// Fetch API의 실제 Headers는 이름 대소문자를 구분하지 않는다 -- 3R 시험이
// 주입하는 가짜 응답도 같은 계약을 흉내낸다(case-insensitive get).
function jsonResponseWithHeaders(status, bodyObj, headers) {
  const text = JSON.stringify(bodyObj);
  const lower = new Map(
    Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: async () => text,
  };
}

// ---- 1. 전부 completed+success -> GREEN ------------------------------------
test("전부 completed+success -> GREEN", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 2,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "success" },
      ],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.GREEN);
  assert.equal(CI_EXIT_CODE[result.verdict], 0);
});

// ---- 2. 하나 in_progress -> PENDING -----------------------------------------
test("하나 in_progress -> PENDING", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 2,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "in_progress", conclusion: null },
      ],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.PENDING);
  assert.equal(CI_EXIT_CODE[result.verdict], 2);
});

// ---- 3. 하나 failure -> RED --------------------------------------------------
test("하나 failure -> RED", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 2,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
      ],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.RED);
  assert.equal(CI_EXIT_CODE[result.verdict], 1);
});

// ---- 4. HTTP 오류 / 빈 응답 / 깨진 JSON / 예상 필드 없음 -> 각각 UNKNOWN -------
test("HTTP 오류 응답(500) -> UNKNOWN (PENDING 아님)", async () => {
  const fetchFn = async () => rawResponse(500, "");
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("커밋을 못 찾음(404) -> UNKNOWN (PENDING 아님)", async () => {
  const fetchFn = async () => rawResponse(404, '{"message":"Not Found"}');
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "does-not-exist",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("네트워크 요청 실패(fetch 예외) -> UNKNOWN (PENDING 아님)", async () => {
  const fetchFn = async () => {
    throw new Error("ECONNRESET");
  };
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("빈 응답 본문 -> UNKNOWN (PENDING 아님)", async () => {
  const fetchFn = async () => rawResponse(200, "");
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("깨진 JSON -> UNKNOWN (PENDING 아님)", async () => {
  const fetchFn = async () => rawResponse(200, "{not valid json");
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("예상 필드(check_runs) 부재 -> UNKNOWN (PENDING 아님)", async () => {
  const fetchFn = async () => jsonResponse(200, { total_count: 0 });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("check_runs 항목의 status 필드 형식이 예상과 다름 -> UNKNOWN", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 1,
      check_runs: [{ name: "build", status: 123, conclusion: "success" }],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
});

// ---- 2R P1-1 수리: status 허용 목록 밖 값 -> UNKNOWN(⛔PENDING 아님) ---------
test("status: 'mystery'(허용 목록 밖 문자열) -> UNKNOWN, PENDING 아님을 명시 단언", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 1,
      check_runs: [{ name: "build", status: "mystery", conclusion: null }],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

// 회귀 방지: 허용 목록의 각 "아직" 값이 여전히 PENDING인지 값마다 개별 단언.
for (const pendingStatus of [
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]) {
  test(`status: '${pendingStatus}'(허용 목록의 "아직" 값) -> 여전히 PENDING (회귀 방지)`, async () => {
    const fetchFn = async () =>
      jsonResponse(200, {
        total_count: 1,
        check_runs: [
          { name: "build", status: pendingStatus, conclusion: null },
        ],
      });
    const result = await fetchCheckRuns({
      owner: "o",
      repo: "r",
      sha: "abc",
      fetchFn,
    });
    assert.equal(result.verdict, CI_VERDICT.PENDING);
  });
}

// status: "completed" 경로 회귀 0 -- GREEN/RED 판정 불변.
test("status: 'completed' + conclusion: 'success' -> 여전히 GREEN (회귀 방지)", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 1,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
      ],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.GREEN);
});

test("status: 'completed' + conclusion: 'failure' -> 여전히 RED (회귀 방지)", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 1,
      check_runs: [
        { name: "build", status: "completed", conclusion: "failure" },
      ],
    });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.RED);
});

// ---- 3R(도그푸딩 반려 수리): 403 + X-RateLimit-Remaining:0 -> 한도 소진 구별 --
test("403 + X-RateLimit-Remaining:0 -> 한도 소진 상태(reasonCode), 재시도 시각 포함, PENDING 아님", async () => {
  // 도그푸딩 실측 그대로: X-RateLimit-Reset: 1787294363 == 2026-08-21
  // 15:39:23 KST(coder-task.md 3R §1). 시계에 의존하지 않는 고정 값.
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "API rate limit exceeded" },
      { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787294363" },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
  assert.equal(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
  assert.match(result.reason, /15:39:23/);
});

test("403 + X-RateLimit-Remaining:5(한도 남음) -> 일반 확인 불가(한도 소진 아님), PENDING 아님", async () => {
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "Forbidden" },
      { "X-RateLimit-Remaining": "5", "X-RateLimit-Reset": "1787294363" },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
  assert.notEqual(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
});

test("403 + 헤더 없음(한도 무관 접근 거부) -> 일반 확인 불가, PENDING 아님", async () => {
  const fetchFn = async () => rawResponse(403, '{"message":"Forbidden"}');
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
  assert.notEqual(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
});

test("403 + X-RateLimit-Remaining이 숫자가 아님(헤더 깨짐) -> 안전측 일반 확인 불가(한도 소진으로 오인 안 함)", async () => {
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "Forbidden" },
      {
        "X-RateLimit-Remaining": "not-a-number",
        "X-RateLimit-Reset": "1787294363",
      },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
  assert.notEqual(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
});

test("403 + Remaining:0 이지만 Reset이 깨짐(빈 문자열) -> 안전측 일반 확인 불가", async () => {
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "Forbidden" },
      { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "" },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
  assert.notEqual(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
});

// ---- 4R P1-1 수리(검토 3R 반려): 범위 밖 Reset이 예외 없이 일반 UNKNOWN으로 --
test("403 + Remaining:0 + 범위 초과 Reset(24자리 숫자) -> 예외 없이 일반 UNKNOWN, 한도 소진 아님, PENDING 아님", async () => {
  // 검토 3R 재현 그대로: 이전엔 THREW: RangeError: Invalid time value.
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "Forbidden" },
      {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "999999999999999999999999",
      },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
  assert.notEqual(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
});

const BAD_RESET_CASES = [
  ["negative", "-1"], // 음수(부호 문자 포함 -- DIGITS_ONLY_RE가 이미 걸러내지만 예외 없이 안전해야 한다)
  ["huge-finite", "99999999999999999999999999999999999999"], // 매우 큰 값(Number()가 유한하지만 Date 범위 밖)
  ["overflow-to-infinity", "9".repeat(400)], // Number()가 Infinity로 오버플로하는 값
];
for (const [label, badReset] of BAD_RESET_CASES) {
  test(`403 + Remaining:0 + Reset(${label}) -> 예외 없이 안전하게 일반 UNKNOWN`, async () => {
    const fetchFn = async () =>
      jsonResponseWithHeaders(
        403,
        { message: "Forbidden" },
        { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": badReset },
      );
    const result = await fetchCheckRuns({
      owner: "o",
      repo: "r",
      sha: "abc",
      fetchFn,
    });
    assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
    assert.notEqual(result.verdict, CI_VERDICT.PENDING);
    assert.notEqual(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
  });
}

test("403 + Remaining:0 + Reset:'0'(유효 범위 안 최소값) -> 예외 없이 처리(경계값)", async () => {
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "Forbidden" },
      { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "0" },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.notEqual(result.verdict, CI_VERDICT.PENDING);
});

test("403 + Remaining:0 + Reset:'1787294363'(정상 값) -> 회귀 0, 여전히 한도 소진(15:39:23)", async () => {
  const fetchFn = async () =>
    jsonResponseWithHeaders(
      403,
      { message: "Forbidden" },
      { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1787294363" },
    );
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.equal(result.reasonCode, CI_REASON_CODE.RATE_LIMIT_EXHAUSTED);
  assert.match(result.reason, /15:39:23/);
});

test("pollCiStatus: 기본 폴링 간격은 60000ms", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls < 2) {
      return jsonResponse(200, {
        total_count: 1,
        check_runs: [
          { name: "build", status: "in_progress", conclusion: null },
        ],
      });
    }
    return jsonResponse(200, {
      total_count: 1,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
      ],
    });
  };
  const observedIntervals = [];
  const result = await pollCiStatus({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
    // intervalMs 미지정 -- 기본값 검증이 이 시험의 목적.
    sleepFn: async (ms) => observedIntervals.push(ms),
  });
  assert.equal(result.verdict, CI_VERDICT.GREEN);
  assert.deepEqual(observedIntervals, [60000]);
});

// ---- 5. total_count: 0 -> 명시적 판정, ⛔GREEN 아님 --------------------------
test("total_count: 0(체크 없음) -> UNKNOWN, GREEN이 아님을 명시 단언", async () => {
  const fetchFn = async () =>
    jsonResponse(200, { total_count: 0, check_runs: [] });
  const result = await fetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
  });
  assert.notEqual(result.verdict, CI_VERDICT.GREEN);
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
});

// ---- 6. 인증 없이 동작(토큰을 읽지 않음) -------------------------------------
test("소스에 토큰/자격증명 참조가 없다(무인증 경로 고정)", () => {
  const src = readFileSync(SOURCE_FILE, "utf8");
  assert.doesNotMatch(src, /\bBearer\b/);
  assert.doesNotMatch(src, /GITHUB_TOKEN/);
  assert.doesNotMatch(src, /process\.env\./);
  assert.doesNotMatch(src, /bot_pat/i);
});

test("fetchCheckRuns가 호출한 요청에 Authorization 헤더가 없다", async () => {
  let capturedInit;
  const fetchFn = async (_url, init) => {
    capturedInit = init;
    return jsonResponse(200, { total_count: 0, check_runs: [] });
  };
  await fetchCheckRuns({ owner: "o", repo: "r", sha: "abc", fetchFn });
  assert.ok(capturedInit);
  assert.equal(capturedInit.headers.Authorization, undefined);
});

// ---- classifyCiStatus 코어 직접 단언(어댑터 없이) ---------------------------
test("classifyCiStatus: networkError -> UNKNOWN", () => {
  const result = classifyCiStatus({ networkError: true });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
});

test("classifyCiStatus: parseError -> UNKNOWN", () => {
  const result = classifyCiStatus({
    httpOk: true,
    status: 200,
    parseError: true,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
});

test("classifyCiStatus: httpOk=false -> UNKNOWN", () => {
  const result = classifyCiStatus({
    httpOk: false,
    status: 500,
    parsed: undefined,
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
});

// ---- pollCiStatus: 상한 + UNKNOWN 즉시 중단 --------------------------------
test("pollCiStatus: 대기 전 첫 조회가 UNKNOWN이면 대기에 들어가지 않는다(1회로 종료)", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return rawResponse(500, "");
  };
  const result = await pollCiStatus({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
    maxAttempts: 10,
    sleepFn: async () => {
      throw new Error("sleepFn은 호출되면 안 된다 -- 즉시 중단 위반");
    },
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
});

test("pollCiStatus: PENDING이 계속되다 도중에 UNKNOWN이 나오면 즉시 중단한다", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls < 3) {
      return jsonResponse(200, {
        total_count: 1,
        check_runs: [
          { name: "build", status: "in_progress", conclusion: null },
        ],
      });
    }
    return rawResponse(500, "");
  };
  const result = await pollCiStatus({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
    maxAttempts: 100,
    sleepFn: async () => {},
  });
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.equal(calls, 3);
});

test("pollCiStatus: 무한 대기 금지 -- maxAttempts 상한에서 멈춘다", async () => {
  const fetchFn = async () =>
    jsonResponse(200, {
      total_count: 1,
      check_runs: [{ name: "build", status: "in_progress", conclusion: null }],
    });
  const result = await pollCiStatus({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
    maxAttempts: 5,
    sleepFn: async () => {},
  });
  assert.equal(result.verdict, CI_VERDICT.PENDING);
  assert.equal(result.attempts, 5);
});

test("pollCiStatus: GREEN이 되면 즉시 대기를 멈춘다", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls < 2) {
      return jsonResponse(200, {
        total_count: 1,
        check_runs: [
          { name: "build", status: "in_progress", conclusion: null },
        ],
      });
    }
    return jsonResponse(200, {
      total_count: 1,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
      ],
    });
  };
  const result = await pollCiStatus({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
    maxAttempts: 100,
    sleepFn: async () => {},
  });
  assert.equal(result.verdict, CI_VERDICT.GREEN);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// §7 HYK-467 (coder-task.md §B-3/§B-5-4): 공유 프로브 예산이 fetchCheckRuns/
// pollCiStatus 실제 호출 경로에 결선돼 있는지 -- 이 파일의 다른 모든
// 시험은 이 축을 무력화한(TEST_CAP_PER_HOUR=1,000,000) 상태로 도는데,
// 그건 "예산이 존재한다"를 증명하지 않는다. 여기서는 그 무력화를 걷어내고
// (독립적인 tmp 예산 파일 + 실제 사용할 상한) "감시기 2개 이상 동시
// 가동" 시나리오를 이 모듈의 실제 진입점으로 재현한다.
// ---------------------------------------------------------------------------
test("★핵심: 서로 다른 두 fetchCheckRuns 호출자(=두 감시기)가 같은 probeBudgetPath를 공유하면, 실제 GitHub 호출 없이 예산 소진이 발화한다", async () => {
  const isolatedBudgetPath = join(
    dirname(TEST_PROBE_BUDGET_PATH),
    "shared-two-watchers-budget.json",
  );
  let realCallCount = 0;
  const fetchFn = async () => {
    realCallCount += 1;
    return jsonResponse(200, {
      total_count: 1,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
      ],
    });
  };

  // "감시기 A" -- 상한 2, 이 호출자 혼자 보면 1/2로 여유롭다.
  const a1 = await realFetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "a",
    fetchFn,
    probeBudgetPath: isolatedBudgetPath,
    capPerHour: 2,
  });
  assert.equal(a1.verdict, CI_VERDICT.GREEN);

  // "감시기 B" -- 완전히 별개 호출(다른 sha, 별도 프로세스라고 가정) --
  // 같은 파일을 보므로 합계는 이제 2, 상한(2)에 도달.
  const b1 = await realFetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "b",
    fetchFn,
    probeBudgetPath: isolatedBudgetPath,
    capPerHour: 2,
  });
  assert.equal(b1.verdict, CI_VERDICT.GREEN);

  // 감시기 A가 다시 호출 -- 합계가 이미 상한에 도달했으므로, 실제 fetch를
  // 시도조차 하지 않고 예산 소진으로 거부돼야 한다.
  const a2 = await realFetchCheckRuns({
    owner: "o",
    repo: "r",
    sha: "a",
    fetchFn,
    probeBudgetPath: isolatedBudgetPath,
    capPerHour: 2,
  });
  assert.equal(a2.verdict, CI_VERDICT.UNKNOWN);
  assert.equal(a2.reasonCode, CI_REASON_CODE.LOCAL_PROBE_BUDGET_EXHAUSTED);
  assert.notEqual(
    a2.reasonCode,
    CI_REASON_CODE.RATE_LIMIT_EXHAUSTED,
    "로컬 예산 소진과 GitHub 자신의 403 한도 소진은 다른 reasonCode여야 한다",
  );
  assert.equal(
    realCallCount,
    2,
    "예산 소진 이후 시도는 실제 fetchFn을 전혀 호출하지 않아야 한다(진짜 GitHub 요청 절약)",
  );
});

test("pollCiStatus도 매 폴링 시도마다 같은 probeBudgetPath로 예산을 소비한다(무한정 폴링이 공유 예산을 우회하지 않는다)", async () => {
  const isolatedBudgetPath = join(
    dirname(TEST_PROBE_BUDGET_PATH),
    "poll-shares-budget.json",
  );
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    return jsonResponse(200, {
      total_count: 1,
      check_runs: [{ name: "build", status: "in_progress", conclusion: null }],
    });
  };
  const result = await realPollCiStatus({
    owner: "o",
    repo: "r",
    sha: "abc",
    fetchFn,
    maxAttempts: 10,
    sleepFn: async () => {},
    probeBudgetPath: isolatedBudgetPath,
    capPerHour: 3,
  });
  // 상한 3: 1~3번째 시도는 실제 호출, 4번째부터는 예산 소진으로 거부되어
  // UNKNOWN -> 즉시 중단(§3-3 계약) -- 총 실제 호출은 3회뿐이어야 한다.
  assert.equal(result.verdict, CI_VERDICT.UNKNOWN);
  assert.equal(result.reasonCode, CI_REASON_CODE.LOCAL_PROBE_BUDGET_EXHAUSTED);
  assert.equal(
    calls,
    3,
    "예산 소진 뒤에는 실제 fetchFn 호출이 더 늘지 않아야 한다",
  );
});
