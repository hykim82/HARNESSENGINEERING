import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CI_VERDICT,
  CI_EXIT_CODE,
  classifyCiStatus,
  fetchCheckRuns,
  pollCiStatus,
} from "./ci-status.mjs";

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
