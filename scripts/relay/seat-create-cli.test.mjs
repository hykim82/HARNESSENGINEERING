import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSeatCreateArgs,
  formatSeatCreateResult,
  runSeatCreateCli,
} from "./seat-create-cli.mjs";
import {
  WORKSPACES_ROOT,
  SEAT_CREATE_LEDGER_REASON,
} from "./adapters/orca-adapter.mjs";

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-cli-fixture`;
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(THIS_DIR, "seat-create-cli.mjs");
const CLI_SRC = readFileSync(CLI_PATH, "utf8");

// HYK-213-seat-ledger (coder-task.md §3/§6 "1-B 세 요건"): 사람이 부를 수
// 있는 진입점 -- role-bound-seat-select-cli.mjs(HYK-211-seat-select-3)와
// 동형 구조: parse/format 단위 시험, runSeatCreateCli 직접 호출, 그리고
// 자식 프로세스로 direct-entry를 실제로 구동하는 시험.

test("parseSeatCreateArgs: requires --role, --worktree, and --registry", () => {
  assert.equal(parseSeatCreateArgs([]).ok, false);
  assert.equal(parseSeatCreateArgs(["--role", "CODER"]).ok, false);
  const ok = parseSeatCreateArgs([
    "--role",
    "CODER",
    "--worktree",
    "/wt",
    "--registry",
    "/wt/registry.json",
  ]);
  assert.deepEqual(ok, {
    ok: true,
    role: "CODER",
    worktreePath: "/wt",
    registryPath: "/wt/registry.json",
  });
});

test("parseSeatCreateArgs: rejects unrecognized flags and '='-syntax", () => {
  assert.equal(parseSeatCreateArgs(["--bogus", "x"]).ok, false);
  assert.equal(parseSeatCreateArgs(["--role=CODER"]).ok, false);
});

test("formatSeatCreateResult: ok:true shows ptyId/role/paneKey presence", () => {
  assert.equal(
    formatSeatCreateResult({
      ok: true,
      record: { ptyId: "pty_1", role: "CODER", paneKey: "tab:leaf" },
    }),
    "CREATED ptyId=pty_1 role=CODER paneKey=present",
  );
});

test("formatSeatCreateResult: ok:true also renders observed not-worker seats when present", () => {
  assert.equal(
    formatSeatCreateResult({
      ok: true,
      record: { ptyId: "pty_1", role: "CODER", paneKey: "tab:leaf" },
      observedNotWorkerSeats: [
        { handle: "term_default", ptyId: "pty_default", skipped: false },
      ],
    }),
    "CREATED ptyId=pty_1 role=CODER paneKey=present notWorkerSeatsRecorded=[term_default]",
  );
});

test("formatSeatCreateResult: ok:false shows the reason code and detail", () => {
  const line = formatSeatCreateResult({
    ok: false,
    seatCreateLedgerReason: SEAT_CREATE_LEDGER_REASON.CREATE_FAILED,
    reason: "terminal create failed",
  });
  assert.equal(
    line,
    "FAILED code=SEAT_CREATE_LEDGER_CREATE_FAILED reason=terminal create failed",
  );
});

test("runSeatCreateCli: bad args -> ok:false before any execFn call", () => {
  let called = false;
  const r = runSeatCreateCli([], {
    execFn: () => {
      called = true;
      return { ok: true, result: {} };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("runSeatCreateCli: good args reach createRoleBoundSeat via injected execFn + registryFs", () => {
  const execFn = (argv) => {
    if (argv[0] === "worktree" && argv[1] === "list") {
      return { ok: true, result: { worktrees: [{ path: VALID_WORKTREE }] } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { ok: true, result: { terminals: [] } };
    }
    if (argv[0] === "terminal" && argv[1] === "create") {
      return {
        ok: true,
        result: {
          ptyId: "pty_new",
          handle: "term_new",
          tabId: "t1",
          leafId: "l1",
          paneKey: "t1:l1",
          worktreeId: "w1",
          worktreePath: VALID_WORKTREE,
        },
      };
    }
    throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
  };
  let saved = null;
  const r = runSeatCreateCli(
    [
      "--role",
      "CODER",
      "--worktree",
      VALID_WORKTREE,
      "--registry",
      "/fake/registry.json",
    ],
    {
      execFn,
      registryFs: {
        existsFn: () => false,
        readFn: () => "",
        writeFn: (p, t) => {
          saved = t;
        },
        renameFn: () => {},
      },
    },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.role, "CODER");
  assert.ok(saved && JSON.parse(saved).seats.length === 1);
});

// ---------------------------------------------------------------------------
// no-env-read (role-bound-seat-select-cli.mjs 전례 그대로): 이 파일도
// 환경변수를 하나도 읽지 않는다 -- direct-entry는 항상 createOrcaExecFn()
// (실 orca spawn)을 쓴다.
// ---------------------------------------------------------------------------
function stripLineComments(src) {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("static: production CLI source contains zero `process.env` references outside comments", () => {
  assert.equal(
    /process\.env/.test(stripLineComments(CLI_SRC)),
    false,
    "seat-create-cli.mjs must not read any environment variable in code",
  );
});

test("static: seat-create-cli.mjs never guesses role/seat identity from title/preview strings", () => {
  const codeOnly = stripLineComments(CLI_SRC);
  assert.equal(/\btitle\b/.test(codeOnly), false);
  assert.equal(/\bpreview\b/.test(codeOnly), false);
});

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// direct-entry: real child process, spawnSync monkeypatched via --require
// preload (role-bound-seat-select-cli.mjs의 3R 방식 재사용 -- 프로그램
// 밖에서 환경을 제어한다).
// ---------------------------------------------------------------------------
function writeFakeOrcaPreload(
  dir,
  { worktreeList, terminalList, terminalCreate },
) {
  const fixturesPath = join(dir, "fixtures.json");
  writeFileSync(
    fixturesPath,
    JSON.stringify({ worktreeList, terminalList, terminalCreate }),
    "utf8",
  );
  const preloadPath = join(dir, "fake-orca-preload.cjs");
  const fixturesUrl = fixturesPath.replace(/\\/g, "/");
  writeFileSync(
    preloadPath,
    `
const cp = require("node:child_process");
const fs = require("node:fs");
const fixtures = JSON.parse(fs.readFileSync(${JSON.stringify(fixturesUrl)}, "utf8"));
cp.spawnSync = function fakeSpawnSync(cmd, args) {
  const key =
    args[0] === "worktree" && args[1] === "list" ? "worktreeList"
    : args[0] === "terminal" && args[1] === "list" ? "terminalList"
    : args[0] === "terminal" && args[1] === "create" ? "terminalCreate"
    : null;
  if (!key || !(key in fixtures)) {
    return { status: 1, stdout: "", stderr: "no stub: " + JSON.stringify(args), error: null, signal: null };
  }
  return { status: 0, stdout: JSON.stringify(fixtures[key]), stderr: "", error: null, signal: null };
};
`,
    "utf8",
  );
  return preloadPath;
}

function runCliChildProcess(args, { preloadPath } = {}) {
  const nodeArgs = preloadPath
    ? ["--require", preloadPath, CLI_PATH, ...args]
    : [CLI_PATH, ...args];
  try {
    const stdout = execFileSync(process.execPath, nodeArgs, {
      encoding: "utf8",
      env: process.env,
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

test("direct-entry: real child process, no pre-existing candidates -- CREATED with the role recorded and exits 0", () => {
  withTempDir("hyk213-cli-child-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({ schemaVersion: 1, seats: [] }),
      "utf8",
    );
    const preloadPath = writeFakeOrcaPreload(dir, {
      worktreeList: {
        ok: true,
        result: { worktrees: [{ path: VALID_WORKTREE }] },
      },
      terminalList: { ok: true, result: { terminals: [] } },
      terminalCreate: {
        ok: true,
        result: {
          ptyId: "pty_new",
          handle: "term_new",
          tabId: "t1",
          leafId: "l1",
          paneKey: "t1:l1",
          worktreeId: "w1",
          worktreePath: VALID_WORKTREE,
        },
      },
    });
    const result = runCliChildProcess(
      [
        "--role",
        "CODER",
        "--worktree",
        VALID_WORKTREE,
        "--registry",
        registryPath,
      ],
      { preloadPath },
    );
    assert.equal(result.status, 0, result.stdout);
    assert.equal(
      result.stdout.trim(),
      "CREATED ptyId=pty_new role=CODER paneKey=present",
    );
    const saved = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(saved.seats.length, 1);
    assert.equal(saved.seats[0].role, "CODER");
  });
});

test("direct-entry: real child process, a pre-existing default tab -- CREATED plus notWorkerSeatsRecorded, and the registry ends up with both facts", () => {
  withTempDir("hyk213-cli-child-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({ schemaVersion: 1, seats: [] }),
      "utf8",
    );
    const preloadPath = writeFakeOrcaPreload(dir, {
      worktreeList: {
        ok: true,
        result: { worktrees: [{ path: VALID_WORKTREE }] },
      },
      terminalList: {
        ok: true,
        result: {
          terminals: [
            {
              handle: "term_default_tab",
              worktreePath: VALID_WORKTREE,
              ptyId: "pty_default_tab",
            },
          ],
        },
      },
      terminalCreate: {
        ok: true,
        result: {
          ptyId: "pty_new",
          handle: "term_new",
          tabId: "t1",
          leafId: "l1",
          paneKey: "t1:l1",
          worktreeId: "w1",
          worktreePath: VALID_WORKTREE,
        },
      },
    });
    const result = runCliChildProcess(
      [
        "--role",
        "CODER",
        "--worktree",
        VALID_WORKTREE,
        "--registry",
        registryPath,
      ],
      { preloadPath },
    );
    assert.equal(result.status, 0, result.stdout);
    assert.equal(
      result.stdout.trim(),
      "CREATED ptyId=pty_new role=CODER paneKey=present notWorkerSeatsRecorded=[term_default_tab]",
    );
    const saved = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(saved.seats.length, 2);
    assert.equal(
      saved.seats.find((s) => s.ptyId === "pty_default_tab").role,
      "NOT_WORKER_SEAT",
    );
  });
});

test("direct-entry: real child process, missing args -- FAILED usage and exits 1 (no preload needed, fails before any execFn call)", () => {
  const result = runCliChildProcess([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout.trim(), /^FAILED code=UNKNOWN reason=usage:/);
});
