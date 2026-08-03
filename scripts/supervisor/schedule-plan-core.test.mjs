// HYK-185 gap#69 (coder-task.md §7, §3) -- schedule-plan-core.mjs 계약
// 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 이 스위트가 100% 통과해도 "실제로 이 계획대로 schtasks가 등록됐다"를
//    증명하지 않는다 -- 등록 실행은 사람 손이며 이 시험은 실제 스케줄러를
//    전혀 건드리지 않는다(coder-task.md §2-1).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildSchedulePlan,
  ACCOUNT_MODE,
  SCHEDULE_PLAN_REASON,
  TASK_NAME,
} from "./schedule-plan-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const NOW_MS = Date.parse("2026-08-03T18:00:00+09:00");
const EXPIRES_IN_7D = new Date(NOW_MS + 7 * 24 * 3600_000).toISOString();

function validArgs(overrides = {}) {
  return {
    repoRoot: ROOT,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    watchDir: "D:\\문서관리\\하네스-관제실\\watch",
    intervalMinutes: 10,
    expiresAt: EXPIRES_IN_7D,
    accountMode: ACCOUNT_MODE.LOGON_ONLY,
    runAsUser: "HOST\\hykim",
    now: NOW_MS,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0(coder-task.md §3-a) -- 주입한 감시자가 호출되지
// 않았음을 단언.
// ---------------------------------------------------------------------------
test("side effects: fs/child_process/fetch/Date.now are never invoked while building a valid plan", () => {
  const fsWatched = [
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
    "existsSync",
    "statSync",
    "readdirSync",
    "mkdirSync",
  ];
  const cpWatched = [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
  ];
  const fsMocks = fsWatched
    .filter((n) => typeof fs[n] === "function")
    .map((n) =>
      mock.method(fs, n, () => {
        throw new Error(`unexpected fs.${n} call from buildSchedulePlan`);
      }),
    );
  const cpMocks = cpWatched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(
          `unexpected child_process.${n} call from buildSchedulePlan`,
        );
      }),
    );
  const hasFetch = typeof globalThis.fetch === "function";
  const fetchMock = hasFetch
    ? mock.method(globalThis, "fetch", () => {
        throw new Error("unexpected fetch call from buildSchedulePlan");
      })
    : null;
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from buildSchedulePlan");
  });
  try {
    const result = buildSchedulePlan(validArgs());
    assert.equal(result.ok, true);
    for (const m of [...fsMocks, ...cpMocks])
      assert.equal(m.mock.calls.length, 0);
    if (fetchMock) assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(dateNowMock.mock.calls.length, 0);
  } finally {
    for (const m of [...fsMocks, ...cpMocks]) m.mock.restore();
    if (fetchMock) fetchMock.mock.restore();
    dateNowMock.mock.restore();
  }
});

const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "schedule-plan-core.mjs"),
  "utf8",
);
test("static: schedule-plan-core.mjs's only import is node:path (no other I/O surface)", () => {
  const imports = [
    ...SRC_TEXT.matchAll(/^import[\s\S]*?from\s+["'](.+)["'];?\s*$/gm),
  ].map((m) => m[1]);
  assert.deepEqual(imports, ["node:path"]);
});

// ---------------------------------------------------------------------------
// happy path -- (c) 드라이런 출력이 사람이 읽는 형태로 §3-c 항목 전부를
// 담는지 확인.
// ---------------------------------------------------------------------------
test("happy path: valid args -> ok:true, registerArgs/unregisterArgs match the real schtasks argument table (1/1)", () => {
  const result = buildSchedulePlan(validArgs());
  assert.equal(result.ok, true);
  const { plan } = result;
  assert.equal(plan.taskName, TASK_NAME);
  assert.equal(plan.passwordStored, false);
  assert.deepEqual(plan.registerArgs, [
    "/Create",
    "/SC",
    "MINUTE",
    "/MO",
    "10",
    "/TN",
    TASK_NAME,
    "/TR",
    plan.commandLine,
    "/RU",
    "HOST\\hykim",
    "/IT",
    "/ED",
    "2026/08/10",
    "/F",
  ]);
  assert.deepEqual(plan.unregisterArgs, ["/Delete", "/TN", TASK_NAME, "/F"]);
  // humanSummary가 §3-c 요구 항목 전부(작업 이름·실행 명령·주기·실행
  // 계정 방식·만료 시점·로그·생존 기록 경로·해제 방법)를 담는지 확인.
  assert.match(plan.humanSummary, /작업 이름:/);
  assert.match(plan.humanSummary, /실행 명령:/);
  assert.match(plan.humanSummary, /주기:/);
  assert.match(plan.humanSummary, /실행 계정:/);
  assert.match(plan.humanSummary, /만료:/);
  assert.match(plan.humanSummary, /로그 경로:/);
  assert.match(plan.humanSummary, /생존 기록 경로:/);
  assert.match(plan.humanSummary, /해제 방법:/);
  assert.match(plan.humanSummary, /--confirm/);
});

// ---------------------------------------------------------------------------
// (b) 등록·해제 «한 쌍» -- 해제 절차가 같은 계획 안에 있는지.
// ---------------------------------------------------------------------------
test("register/unregister pair: unregisterArgs always present alongside registerArgs (1/1)", () => {
  const { plan } = buildSchedulePlan(validArgs());
  assert.ok(Array.isArray(plan.registerArgs) && plan.registerArgs.length > 0);
  assert.ok(
    Array.isArray(plan.unregisterArgs) && plan.unregisterArgs.length > 0,
  );
  assert.equal(plan.unregisterArgs[0], "/Delete");
});

// ---------------------------------------------------------------------------
// fail-closed 검증 -- ★mutation #2/#3 표적 가드가 실제로 거부하는지.
// ---------------------------------------------------------------------------
test("fail-closed: expiresAt missing/empty -> ok:false EXPIRES_AT_REQUIRED (3/3: undefined, null, empty string)", () => {
  for (const bad of [undefined, null, ""]) {
    const result = buildSchedulePlan(validArgs({ expiresAt: bad }));
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, SCHEDULE_PLAN_REASON.EXPIRES_AT_REQUIRED);
  }
});

test("fail-closed: expiresAt not in the future -> ok:false EXPIRES_AT_NOT_IN_FUTURE (1/1)", () => {
  const result = buildSchedulePlan(
    validArgs({ expiresAt: new Date(NOW_MS - 1000).toISOString() }),
  );
  assert.equal(result.ok, false);
  assert.equal(
    result.reasonCode,
    SCHEDULE_PLAN_REASON.EXPIRES_AT_NOT_IN_FUTURE,
  );
});

test("fail-closed: expiresAt unparseable -> ok:false EXPIRES_AT_UNPARSEABLE (1/1)", () => {
  const result = buildSchedulePlan(validArgs({ expiresAt: "not-a-date" }));
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, SCHEDULE_PLAN_REASON.EXPIRES_AT_UNPARSEABLE);
});

test("fail-closed: accountMode other than LOGON_ONLY -> ok:false ACCOUNT_MODE_INVALID (3/3: password-style, empty, wrong type)", () => {
  for (const bad of ["PASSWORD_STORED", "", 123]) {
    const result = buildSchedulePlan(validArgs({ accountMode: bad }));
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, SCHEDULE_PLAN_REASON.ACCOUNT_MODE_INVALID);
  }
});

test("fail-closed: intervalMinutes out of schtasks MINUTE range [1,1439] -> ok:false (4/4: 0, 1440, -1, non-integer)", () => {
  for (const bad of [0, 1440, -1, 5.5]) {
    const result = buildSchedulePlan(validArgs({ intervalMinutes: bad }));
    assert.equal(result.ok, false);
    assert.equal(
      result.reasonCode,
      SCHEDULE_PLAN_REASON.INTERVAL_MINUTES_INVALID,
    );
  }
});

test("fail-closed: repoRoot/nodePath/watchDir must be non-empty absolute paths -> ok:false (3/3)", () => {
  assert.equal(
    buildSchedulePlan(validArgs({ repoRoot: "relative/path" })).ok,
    false,
  );
  assert.equal(buildSchedulePlan(validArgs({ nodePath: "" })).ok, false);
  assert.equal(buildSchedulePlan(validArgs({ watchDir: null })).ok, false);
});

test("fail-closed: runAsUser missing -> ok:false RUN_AS_USER_INVALID (2/2: undefined, empty string)", () => {
  for (const bad of [undefined, ""]) {
    const result = buildSchedulePlan(validArgs({ runAsUser: bad }));
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, SCHEDULE_PLAN_REASON.RUN_AS_USER_INVALID);
  }
});

test("fail-closed: args not a plain object / now not finite -> ok:false, never thrown (3/3)", () => {
  for (const bad of [undefined, "not-an-object", []]) {
    assert.doesNotThrow(() => {
      assert.equal(buildSchedulePlan(bad).ok, false);
    });
  }
  assert.equal(buildSchedulePlan(validArgs({ now: NaN })).ok, false);
});

// ---------------------------------------------------------------------------
// (g) 판별력 자동화 -- copy-and-mutate(orch-progress-core.test.mjs 선례).
// 신규 파일이라 아직 HEAD에 없으면 명시적 사유로 skip한다.
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/schedule-plan-core.mjs"],
    {
      cwd: ROOT,
      encoding: "utf8",
    },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "schedule-plan-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-schedule-plan-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "schedule-plan-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/schedule-plan-core #2 (필수): 만료 필수 검사 제거 -> RED (무기한 등록 계획이 만들어짐)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  const expires = validateExpiresAt(expiresAt, now);\n  if (expires.code) return fail(expires.code);\n",
        "  const expires = validateExpiresAt(expiresAt, now);\n",
      ),
    );
    const result = mutant.buildSchedulePlan(
      validArgs({ expiresAt: undefined }),
    );
    assert.equal(
      result.ok,
      true,
      "mutant must accept a missing expiresAt (RED signal; proves the required-expiry gate is load-bearing)",
    );
  },
);

test(
  "NC mutation/schedule-plan-core #3 (필수): 계정 방식 제한 검사 제거 -> RED (비밀번호 저장 방식이 허용됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "function validateAccountMode(accountMode) {\n  if (accountMode !== ACCOUNT_MODE.LOGON_ONLY) {\n    return SCHEDULE_PLAN_REASON.ACCOUNT_MODE_INVALID;\n  }\n  return null;\n}",
        "function validateAccountMode(accountMode) {\n  return null;\n}",
      ),
    );
    const result = mutant.buildSchedulePlan(
      validArgs({ accountMode: "PASSWORD_STORED" }),
    );
    assert.equal(
      result.ok,
      true,
      "mutant must accept a non-LOGON_ONLY account mode (RED signal; proves the account-mode allowlist gate is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #6) -- 실제 워크트리를 손대지
// 않는다(전부 mkdtemp 안에서만 파일을 만들었다).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "schedule-plan-core.test.mjs must leave the real worktree exactly as it found it",
  );
});
