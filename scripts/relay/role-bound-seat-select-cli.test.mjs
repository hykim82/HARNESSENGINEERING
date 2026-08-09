import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRoleBoundSeatSelectArgs,
  formatRoleBoundSeatSelectResult,
  runRoleBoundSeatSelectCli,
} from "./role-bound-seat-select-cli.mjs";
import {
  ROLE_BOUND_SEAT_REASON,
  WORKSPACES_ROOT,
} from "./adapters/orca-adapter.mjs";

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-cli-fixture`;
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(THIS_DIR, "role-bound-seat-select-cli.mjs");

// HYK-211-seat-select coder-1/2 (coder-task.md §4 "1-B 세 요건" · §2-2
// P1-2): CLI 파싱 + 사람이 읽는 출력 포맷 시험(export helper 직접 호출,
// 실 orca 호출 0) + **실제 direct-entry 진입점을 자식 프로세스로 구동하는
// 시험**(아래 "direct-entry" 절 -- P1-2가 실제로 닫혔는지의 증거).

test("parseRoleBoundSeatSelectArgs: requires --role, --worktree, and --registry", () => {
  assert.equal(parseRoleBoundSeatSelectArgs([]).ok, false);
  assert.equal(parseRoleBoundSeatSelectArgs(["--role", "CODER"]).ok, false);
  assert.equal(
    parseRoleBoundSeatSelectArgs(["--role", "CODER", "--worktree", "/wt"]).ok,
    false,
  );
  const ok = parseRoleBoundSeatSelectArgs([
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

test("parseRoleBoundSeatSelectArgs: rejects unrecognized flags and '='-syntax", () => {
  assert.equal(parseRoleBoundSeatSelectArgs(["--bogus", "x"]).ok, false);
  assert.equal(parseRoleBoundSeatSelectArgs(["--role=CODER"]).ok, false);
});

test("formatRoleBoundSeatSelectResult: ok:true shows the selected handle", () => {
  assert.equal(
    formatRoleBoundSeatSelectResult({ ok: true, handle: "term_coder" }),
    "SELECTED handle=term_coder",
  );
});

test("formatRoleBoundSeatSelectResult: ok:true also renders the per-candidate role map (P2-3)", () => {
  assert.equal(
    formatRoleBoundSeatSelectResult({
      ok: true,
      handle: "term_coder",
      candidateRoles: [
        { handle: "term_review", role: "REVIEW" },
        { handle: "term_coder", role: "CODER" },
      ],
    }),
    "SELECTED handle=term_coder roles=[term_review=REVIEW, term_coder=CODER]",
  );
});

test("formatRoleBoundSeatSelectResult: ok:false shows the reason code and detail, plus the role map when present", () => {
  const line = formatRoleBoundSeatSelectResult({
    ok: false,
    roleBoundSeatReason: ROLE_BOUND_SEAT_REASON.NOT_FOUND,
    reason: "no seat registry-matches 'CODER'",
    candidateRoles: [{ handle: "term_review", role: "REVIEW" }],
  });
  assert.match(line, /^REJECTED code=ROLE_BOUND_SEAT_NOT_FOUND reason=/);
  assert.match(line, /roles=\[term_review=REVIEW\]$/);
});

test("formatRoleBoundSeatSelectResult: no candidateRoles (e.g. rejected before candidate collection) -- no trailing 'roles=' segment", () => {
  const line = formatRoleBoundSeatSelectResult({
    ok: false,
    locationReason: "MAIN_REPO_FORBIDDEN",
    reason: "forbidden",
  });
  assert.equal(line, "REJECTED code=MAIN_REPO_FORBIDDEN reason=forbidden");
});

test("runRoleBoundSeatSelectCli: bad args -> ok:false before any execFn call", () => {
  let called = false;
  const r = runRoleBoundSeatSelectCli([], {
    execFn: () => {
      called = true;
      return { ok: true, result: {} };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

test("runRoleBoundSeatSelectCli: good args reach resolveRoleBoundSeatHandle via injected execFn + registryFs", () => {
  const execFn = (argv) => {
    if (argv[0] === "worktree" && argv[1] === "list") {
      return { ok: true, result: { worktrees: [{ path: VALID_WORKTREE }] } };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return {
        ok: true,
        result: {
          terminals: [
            {
              handle: "term_coder",
              worktreePath: VALID_WORKTREE,
              ptyId: "pty_coder",
            },
          ],
        },
      };
    }
    throw new Error(`unexpected argv: ${JSON.stringify(argv)}`);
  };
  const registry = {
    schemaVersion: 1,
    seats: [{ schemaVersion: 1, ptyId: "pty_coder", role: "CODER" }],
  };
  const registryText = JSON.stringify(registry);
  const r = runRoleBoundSeatSelectCli(
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
        existsFn: () => true,
        readFn: () => registryText,
      },
    },
  );
  assert.equal(r.ok, true);
  assert.equal(r.handle, "term_coder");
  assert.deepEqual(r.candidateRoles, [{ handle: "term_coder", role: "CODER" }]);
});

// ---------------------------------------------------------------------------
// direct-entry (P1-2 수리 증거): 자식 프로세스로 실제 `node
// role-bound-seat-select-cli.mjs ...`를 실행해 stdout/종료코드를
// 단언한다. `ROLE_BOUND_SEAT_SELECT_FIXTURE`(시험 전용 seam, 파일 헤더
// 주석 참조)로 terminal/worktree list를 고정하고, `--registry`는 실제
// mkdtemp 파일을 가리킨다(가짜가 아니라 진짜 fs I/O).
// ---------------------------------------------------------------------------

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCliChildProcess(args, { fixturePath, extraEnv = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(fixturePath ? { ROLE_BOUND_SEAT_SELECT_FIXTURE: fixturePath } : {}),
        ...extraEnv,
      },
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

test("direct-entry: real child process, valid fixture -- prints SELECTED with the role map and exits 0", () => {
  withTempDir("hyk211-cli-child-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        seats: [
          { schemaVersion: 1, ptyId: "pty_review", role: "REVIEW" },
          { schemaVersion: 1, ptyId: "pty_coder", role: "CODER" },
        ],
      }),
      "utf8",
    );
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        worktreeList: {
          ok: true,
          result: { worktrees: [{ path: VALID_WORKTREE }] },
        },
        terminalList: {
          ok: true,
          result: {
            terminals: [
              {
                handle: "term_review",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_review",
              },
              {
                handle: "term_coder",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_coder",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const result = runCliChildProcess(
      [
        "--role",
        "CODER",
        "--worktree",
        VALID_WORKTREE,
        "--registry",
        registryPath,
      ],
      { fixturePath },
    );
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout.trim(),
      "SELECTED handle=term_coder roles=[term_review=REVIEW, term_coder=CODER]",
    );
  });
});

test("direct-entry: real child process, undetermined candidate -- prints REJECTED with the role map and exits 1", () => {
  withTempDir("hyk211-cli-child-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        seats: [{ schemaVersion: 1, ptyId: "pty_coder", role: "CODER" }],
      }),
      "utf8",
    );
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        worktreeList: {
          ok: true,
          result: { worktrees: [{ path: VALID_WORKTREE }] },
        },
        terminalList: {
          ok: true,
          result: {
            terminals: [
              {
                handle: "term_unknown",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_unregistered",
              },
              {
                handle: "term_coder",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_coder",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const result = runCliChildProcess(
      [
        "--role",
        "CODER",
        "--worktree",
        VALID_WORKTREE,
        "--registry",
        registryPath,
      ],
      { fixturePath },
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stdout.trim(),
      /^REJECTED code=ROLE_BOUND_SEAT_ROLE_UNDETERMINED reason=.*roles=\[term_unknown=UNDETERMINED, term_coder=CODER\]$/,
    );
  });
});

test("direct-entry: real child process, missing args -- usage REJECTED and exits 1 (no fixture needed, fails before any execFn call)", () => {
  const result = runCliChildProcess([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout.trim(), /^REJECTED code=UNKNOWN reason=usage:/);
});

// ★★§4-4 (필수): direct-entry 배선 절단 -> RED. 1R의 실제 결함(direct-entry
// 가 runRoleBoundSeatSelectCli를 안 부르고 parse+resolve를 따로 재호출해
// registryPath 전달을 빠뜨리는 흔한 복붙 실수)을 재현한 변조 스크립트를
// mkdtemp에 써서 실행한다 -- 실 소스는 건드리지 않는다(원복 diff 0 구조적
// 보장, orca-adapter의 mutation-kill 파일과 동일 원칙). 소스 조립은
// buildDirectEntryCutMutantSource로 분리한다(quality-check 함수 길이 상한
// 준수, 복잡도 분산).
function buildDirectEntryCutMutantSource() {
  const adapterUrl = `file://${THIS_DIR.replace(/\\/g, "/")}/adapters/orca-adapter.mjs`;
  const cliUrl = `file://${CLI_PATH.replace(/\\/g, "/")}`;
  return `
import { readFileSync } from "node:fs";
import { resolveRoleBoundSeatHandle, createOrcaExecFn } from "${adapterUrl}";
import { parseRoleBoundSeatSelectArgs, formatRoleBoundSeatSelectResult } from "${cliUrl}";

function buildFixtureExecFn(fixturePath) {
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  return function fixtureExecFn(argv) {
    const key = argv[0] === "worktree" && argv[1] === "list" ? "worktreeList"
      : argv[0] === "terminal" && argv[1] === "list" ? "terminalList" : null;
    if (!key || !(key in fixtures)) throw new Error("no stub: " + JSON.stringify(argv));
    return fixtures[key];
  };
}

// mutated: direct-entry re-implements parse+resolve itself instead of
// calling runRoleBoundSeatSelectCli -- and forgets to forward registryPath
// (the exact class of bug P1-2 flagged).
const args = process.argv.slice(2);
const parsed = parseRoleBoundSeatSelectArgs(args);
if (!parsed.ok) {
  console.log("REJECTED code=UNKNOWN reason=" + parsed.reason);
  process.exit(1);
}
const fixturePath = process.env.ROLE_BOUND_SEAT_SELECT_FIXTURE;
const execFn = fixturePath ? buildFixtureExecFn(fixturePath) : createOrcaExecFn();
const result = resolveRoleBoundSeatHandle({ role: parsed.role, worktreePath: parsed.worktreePath }, { execFn });
console.log(formatRoleBoundSeatSelectResult(result));
process.exit(result.ok ? 0 : 1);
`;
}

function runDirectEntryCutMutant(dir, { registryPath, fixturePath }) {
  const mutantPath = join(dir, "role-bound-seat-select-cli.mutant.mjs");
  writeFileSync(mutantPath, buildDirectEntryCutMutantSource(), "utf8");
  const argv = [
    mutantPath,
    "--role",
    "CODER",
    "--worktree",
    VALID_WORKTREE,
    "--registry",
    registryPath,
  ];
  const env = { ...process.env, ROLE_BOUND_SEAT_SELECT_FIXTURE: fixturePath };
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, argv, { encoding: "utf8", env }),
    };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

test("NC mutation/role-bound-seat-select-cli #4 (필수, §4-4): direct-entry가 runRoleBoundSeatSelectCli 를 안 쓰고 따로 재구현(registryPath 전달 누락) -> RED", () => {
  withTempDir("hyk211-cli-mutant-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        seats: [{ schemaVersion: 1, ptyId: "pty_coder", role: "CODER" }],
      }),
      "utf8",
    );
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        worktreeList: {
          ok: true,
          result: { worktrees: [{ path: VALID_WORKTREE }] },
        },
        terminalList: {
          ok: true,
          result: {
            terminals: [
              {
                handle: "term_coder",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_coder",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const outcome = runDirectEntryCutMutant(dir, { registryPath, fixturePath });
    assert.equal(
      outcome.status,
      1,
      "mutant must fail to select the seat because it dropped registryPath (RED signal; proves the real CLI's single call to runRoleBoundSeatSelectCli is load-bearing, not incidental)",
    );
    assert.match(
      outcome.stdout.trim(),
      /^REJECTED code=ROLE_BOUND_SEAT_REGISTRY_PATH_REQUIRED/,
    );
  });
});
