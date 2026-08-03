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
    "--confirm",
  ]; // --expires-at 생략(고의 -- 계획 거부를 유도).
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
