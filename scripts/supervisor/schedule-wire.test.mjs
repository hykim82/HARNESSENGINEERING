// HYK-185 gap#69 (coder-task.md §7, §3) -- schedule-wire.mjs CLI 계약
// 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 이 스위트가 100% 통과해도 "실제 스케줄러가 등록됐다"를 증명하지
//    않는다 -- `exec`를 항상 주입해 실제 `schtasks.exe`를 호출하지
//    않는다(coder-task.md §2-1, 시험도 실제 스케줄러를 건드리면 안 됨).
// 2. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScheduleWire, EXIT_CODE } from "./schedule-wire.mjs";

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
const NOW_ISO = "2026-08-03T18:00:00+09:00";
const NOW_MS = Date.parse(NOW_ISO);
const EXPIRES_IN_7D = new Date(NOW_MS + 7 * 24 * 3600_000).toISOString();

// HYK-369 3R P1(fail-closed): 대부분의 시험은 각성 인자 자체를 다루지
// 않으니, 기본 인자 목록에 `--no-runner-args`를 포함해 "빈 게 맞다"고
// 명시적으로 확인한 상태로 시작한다 -- 이 확인 자체를 다루는 시험만
// 이 플래그를 빼거나 `--runner-arg`로 대체한다.
function commonArgs(extra = []) {
  return [
    "--repo-root",
    ROOT,
    "--node-path",
    "C:\\Program Files\\nodejs\\node.exe",
    "--watch-dir",
    "D:\\문서관리\\하네스-관제실\\watch",
    "--interval-minutes",
    "10",
    "--expires-at",
    EXPIRES_IN_7D,
    "--run-as-user",
    "HOST\\hykim",
    "--now",
    NOW_ISO,
    "--no-runner-args",
    ...extra,
  ];
}

function neverCalledExec() {
  throw new Error(
    "exec must not be called without --confirm (RED signal precondition)",
  );
}

test("plan: dry-run always, never calls exec, prints §3-c fields (1/1)", () => {
  const { output, exitCode } = runScheduleWire(["plan", ...commonArgs()], {
    exec: neverCalledExec,
  });
  assert.equal(exitCode, EXIT_CODE.OK);
  assert.match(output, /작업 이름:/);
  assert.match(output, /해제 방법:/);
});

test("register: without --confirm, exec is never called and exit code signals NOT_EXECUTED (1/1)", () => {
  const { output, exitCode } = runScheduleWire(["register", ...commonArgs()], {
    exec: neverCalledExec,
  });
  assert.equal(exitCode, EXIT_CODE.NOT_EXECUTED);
  assert.match(output, /DRY_RUN\(register\)/);
  assert.match(output, /schtasks \/Create/);
});

test("unregister: without --confirm, exec is never called and exit code signals NOT_EXECUTED (1/1)", () => {
  const { output, exitCode } = runScheduleWire(
    ["unregister", ...commonArgs()],
    { exec: neverCalledExec },
  );
  assert.equal(exitCode, EXIT_CODE.NOT_EXECUTED);
  assert.match(output, /DRY_RUN\(unregister\)/);
  assert.match(output, /schtasks \/Delete/);
});

test("register: with --confirm (mock exec only -- real schtasks never invoked), exec is called with the exact planned args (1/1)", () => {
  const calls = [];
  const { exitCode } = runScheduleWire(
    ["register", ...commonArgs(["--confirm"])],
    {
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        return "SUCCESS: registered.";
      },
    },
  );
  assert.equal(exitCode, EXIT_CODE.OK);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "schtasks");
  assert.deepEqual(calls[0][1].slice(0, 2), ["/Create", "/SC"]);
});

// ---------------------------------------------------------------------------
// HYK-369 3R P1(2R 검토 반려, 한용 확정 fail-closed) -- CLI 층에서도
// `--runner-arg`/`--no-runner-args` 둘 다 안 주면 계획이 거부되는지.
// commonArgs()가 기본으로 `--no-runner-args`를 넣어 두므로, 여기서는
// 그걸 빼서 원래(순정) 인자 목록으로 시험한다.
// ---------------------------------------------------------------------------
test("plan: --runner-arg도 --no-runner-args도 안 주면 계획을 거부한다 -- 조용한 통과 금지(1/1)", () => {
  const args = [
    "--repo-root",
    ROOT,
    "--node-path",
    "C:\\Program Files\\nodejs\\node.exe",
    "--watch-dir",
    "D:\\문서관리\\하네스-관제실\\watch",
    "--interval-minutes",
    "10",
    "--expires-at",
    EXPIRES_IN_7D,
    "--run-as-user",
    "HOST\\hykim",
    "--now",
    NOW_ISO,
  ]; // --runner-arg도 --no-runner-args도 고의로 뺐다.
  const { output, exitCode } = runScheduleWire(["plan", ...args], {
    exec: neverCalledExec,
  });
  assert.equal(exitCode, EXIT_CODE.PLAN_REJECTED);
  assert.match(output, /EXTRA_RUNNER_ARGS_CONFIRMATION_REQUIRED/);
  // HYK-369 P(3R 검토 반려 지적) -- 거부 원문이 "무엇을 잃는지" 말해야
  // 한다. 개별 플래그 이름은 여기(schedule-wire.mjs, 결선 계층)의 안내
  // 문구에만 있고 코어 로직에는 없다(§본문 참조).
  assert.match(output, /--wake/);
  assert.match(output, /--runner-arg/);
  assert.match(output, /--no-runner-args/);
});

// ---------------------------------------------------------------------------
// HYK-369 4R P1(3R 검토 반려 그대로 재현, CLI 층) -- 3R을 반려시킨
// 정확한 그 명령: `--runner-arg ""`. 지금은 CLI에서도 거부돼야 한다.
// ---------------------------------------------------------------------------
test('plan: --runner-arg ""(빈 문자열, 3R 반려를 부른 그 우회)는 CLI 층에서도 거부된다(1/1)', () => {
  const { output, exitCode } = runScheduleWire(
    // commonArgs()는 기본으로 --no-runner-args를 넣는다 -- 이 시험은 그
    // opt-out 없이, 순수하게 빈 문자열 하나로 우회를 시도하는 시나리오를
    // 재현해야 하므로 그 플래그를 제거한다.
    ["plan", ...commonArgs(["--runner-arg", ""])].filter(
      (a) => a !== "--no-runner-args",
    ),
    { exec: neverCalledExec },
  );
  assert.equal(exitCode, EXIT_CODE.PLAN_REJECTED);
  assert.match(output, /EXTRA_RUNNER_ARGS_CONFIRMATION_REQUIRED/);
});

test('register: --runner-arg ""만 반복해도(여러 개, 전부 공백류) CLI 층에서 거부된다 -- --confirm과 무관하게 exec에 안 닿는다(1/1)', () => {
  const args = commonArgs([
    "--runner-arg",
    "",
    "--runner-arg",
    "   ",
    "--confirm",
  ]).filter((a) => a !== "--no-runner-args");
  const { exitCode } = runScheduleWire(["register", ...args], {
    exec: neverCalledExec,
  });
  assert.equal(exitCode, EXIT_CODE.PLAN_REJECTED);
});

// (별도 시험 불필요 -- 위 "register: with --confirm" 시험이 이미
// commonArgs()의 기본 `--no-runner-args`로 이 경로를 exec 호출까지
// 통과시킨다: 그 자체가 "명시적으로 확인하면 정당한 신규 설치가 안
// 막힌다"는 증거다.)

// ---------------------------------------------------------------------------
// HYK-369 2R P1-1(검토 반려) -- `--runner-arg`를 반복 지정하면 라이브
// 작업의 각성/sweep 인자가 등장 순서 그대로 등록 계획의 `/TR`에 실린다.
// 이게 없으면 코드 경로로 재등록할 때마다 그 인자들이 조용히 사라진다.
// ---------------------------------------------------------------------------
test("register: --runner-arg를 반복 지정하면 등장 순서 그대로 /TR에 실린다 -- 각성 인자 보존 계약(1/1)", () => {
  const calls = [];
  const { exitCode } = runScheduleWire(
    [
      "register",
      ...commonArgs([
        "--runner-arg",
        "--wake",
        "--runner-arg",
        "--admission-sweep-ledger",
        "--runner-arg",
        "D:\\문서관리\\하네스-관제실\\admission-ledger.json",
        "--runner-arg",
        "--wake-live",
        "--confirm",
      ]),
    ],
    {
      exec: (cmd, args) => {
        calls.push([cmd, args]);
        return "SUCCESS: registered.";
      },
    },
  );
  assert.equal(exitCode, EXIT_CODE.OK);
  const trIdx = calls[0][1].indexOf("/TR");
  const commandLine = calls[0][1][trIdx + 1];
  assert.ok(
    commandLine.endsWith(
      ' "--wake" "--admission-sweep-ledger" ' +
        '"D:\\문서관리\\하네스-관제실\\admission-ledger.json" "--wake-live"',
    ),
    `/TR must end with the live wake/sweep args in order, got: ${commandLine}`,
  );
});

test("plan: --runner-arg를 안 주면 commandLine에 아무것도 안 붙는다 -- 회귀 0(1/1)", () => {
  const { output } = runScheduleWire(["plan", ...commonArgs(["--json"])], {
    exec: neverCalledExec,
  });
  const plan = JSON.parse(output);
  assert.ok(
    !plan.commandLine.includes("--wake"),
    "no --runner-arg means no extra tokens appended",
  );
});

test("register: rejected plan (e.g. missing expiresAt) never reaches exec, even with --confirm (1/1)", () => {
  const args = [
    "--repo-root",
    ROOT,
    "--node-path",
    "C:\\Program Files\\nodejs\\node.exe",
    "--watch-dir",
    "D:\\문서관리\\하네스-관제실\\watch",
    "--interval-minutes",
    "10",
    "--run-as-user",
    "HOST\\hykim",
    "--now",
    NOW_ISO,
    "--no-runner-args",
    "--confirm",
  ]; // --expires-at 생략(고의 -- 계획 거부를 유도). --no-runner-args는
  // 넣어 둔다 -- 안 그러면 그 확인 요구가 먼저 걸려 이 시험이 원래
  // 겨냥하는 "만료 누락" 경로를 더 이상 보여주지 못한다.
  const { exitCode } = runScheduleWire(["register", ...args], {
    exec: neverCalledExec,
  });
  assert.equal(exitCode, EXIT_CODE.PLAN_REJECTED);
});

test("status: missing/malformed alive record -> UNKNOWN, never ALIVE (2/2: ENOENT, malformed JSON)", () => {
  const missing = runScheduleWire(
    [
      "status",
      "--watch-dir",
      "C:\\nonexistent-watch-dir-xyz",
      "--now",
      NOW_ISO,
    ],
    {
      readFn: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    },
  );
  assert.match(missing.output, /UNKNOWN/);
  const malformed = runScheduleWire(
    ["status", "--watch-dir", "C:\\whatever", "--now", NOW_ISO],
    {
      readFn: () => "not json",
    },
  );
  assert.match(malformed.output, /UNKNOWN/);
});

test("status: fresh record -> ALIVE (1/1)", () => {
  const result = runScheduleWire(
    [
      "status",
      "--watch-dir",
      "C:\\whatever",
      "--now",
      NOW_ISO,
      "--stale-after-s",
      "900",
    ],
    {
      readFn: () => JSON.stringify({ recordedAtMs: NOW_MS - 60_000 }),
    },
  );
  assert.match(result.output, /^ALIVE/);
  assert.equal(result.exitCode, EXIT_CODE.OK);
});

// ---------------------------------------------------------------------------
// HYK-369 3R P2-1(2R 검토 반려) -- `--conhost-path`로 존재하지 않는
// 경로를 명시 오버라이드하면, 등록 실행까지 가지 않고 `plan`/`register`
// 드라이런 단계에서 바로 잡힌다(검토자 재현: 이전엔 `MISSING_CONHOST_
// PLAN_EXIT=0`로 조용히 통과했다). `schedule-plan-core.mjs`는 "I/O 0"
// 순수 함수 계약이 있어 존재 확인을 할 수 없으므로, 이미 fs를 다루는
// 이 결선 계층(`schedule-wire.mjs`)에 검증을 뒀다 -- injected `existsFn`
// 으로 실제 파일시스템을 건드리지 않고 both 방향(있음/없음)을 잰다.
// ---------------------------------------------------------------------------
test("plan: --conhost-path가 존재하지 않으면 PLAN_REJECTED(CONHOST_NOT_FOUND)로 즉시 거부한다(1/1)", () => {
  const { output, exitCode } = runScheduleWire(
    [
      "plan",
      ...commonArgs(["--conhost-path", "Z:\\not-installed\\conhost.exe"]),
    ],
    { exec: neverCalledExec, existsFn: () => false },
  );
  assert.equal(exitCode, EXIT_CODE.PLAN_REJECTED);
  assert.match(output, /CONHOST_NOT_FOUND/);
  assert.match(output, /Z:\\not-installed\\conhost\.exe/);
});

test("register: --conhost-path가 존재하지 않으면 --confirm과 무관하게 exec에 닿지 못한다(1/1)", () => {
  const { exitCode } = runScheduleWire(
    [
      "register",
      ...commonArgs([
        "--conhost-path",
        "Z:\\not-installed\\conhost.exe",
        "--confirm",
      ]),
    ],
    { exec: neverCalledExec, existsFn: () => false },
  );
  assert.equal(exitCode, EXIT_CODE.PLAN_REJECTED);
});

test("plan: --conhost-path를 안 주면(기본값) existsFn이 참을 반환하는 한 그대로 통과한다(1/1)", () => {
  const { exitCode } = runScheduleWire(["plan", ...commonArgs()], {
    exec: neverCalledExec,
    existsFn: () => true,
  });
  assert.equal(exitCode, EXIT_CODE.OK);
});

test("unknown subcommand -> INVALID_ARGUMENTS, exec never called (1/1)", () => {
  const { exitCode } = runScheduleWire(["bogus"], { exec: neverCalledExec });
  assert.equal(exitCode, EXIT_CODE.INVALID_ARGUMENTS);
});

// ---------------------------------------------------------------------------
// (g) 판별력 자동화 -- copy-and-mutate. 신규 파일이라 아직 HEAD에 없으면
// 명시적 사유로 skip한다.
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/schedule-wire.mjs"],
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
  "schedule-wire.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-schedule-wire-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "schedule-wire.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  fs.copyFileSync(
    join(ROOT, "scripts", "supervisor", "schedule-plan-core.mjs"),
    join(dir, "schedule-plan-core.mjs"),
  );
  fs.copyFileSync(
    join(ROOT, "scripts", "supervisor", "watch-freshness-core.mjs"),
    join(dir, "watch-freshness-core.mjs"),
  );
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/schedule-wire #1 (필수): --confirm 요구 제거 -> RED (확인 없이도 exec가 호출됨)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        '  if (!cli.confirm) {\n    return {\n      output: `DRY_RUN(${kind}): --confirm 없이는 실행하지 않는다.\\nschtasks ${args.join(" ")}\\n\\n${built.plan.humanSummary}`,\n      exitCode: EXIT_CODE.NOT_EXECUTED,\n    };\n  }\n',
        "",
      ),
    );
    let called = false;
    mutant.runScheduleWire(["register", ...commonArgs()], {
      exec: () => {
        called = true;
        return "ok";
      },
    });
    assert.equal(
      called,
      true,
      "mutant must call exec without --confirm (RED signal; proves the --confirm gate is load-bearing)",
    );
  },
);

// ---------------------------------------------------------------------------
// 원상복구 단언(coder-task.md §2 비타협 #6·#7).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "schedule-wire.test.mjs must leave the real worktree exactly as it found it",
  );
});
