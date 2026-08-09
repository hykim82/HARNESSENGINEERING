import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
const CLI_SRC = readFileSync(CLI_PATH, "utf8");

// HYK-211-seat-select coder-1/2/3 (coder-task.md §4 "1-B 세 요건" · §2-2
// P1-2 · HYK-211-seat-select-3 §1 남은 P1): CLI 파싱 + 사람이 읽는 출력
// 포맷 시험(export helper 직접 호출, 실 orca 호출 0) + **실제
// direct-entry 진입점을 자식 프로세스로 구동하는 시험**(아래
// "direct-entry" 절 -- P1-2가 실제로 닫혔는지의 증거) + **프로덕션에
// 시험용 뒷문이 없음을 보이는 시험**(3R, 아래 "no-backdoor" 절).

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
// no-backdoor (HYK-211-seat-select-3, coder-task.md §1/§3): 2R의
// `ROLE_BOUND_SEAT_SELECT_FIXTURE` 환경변수 seam은 검토자 반려로 완전히
// 제거됐다(ⓑ 선택 -- role-bound-seat-select-cli.mjs 헤더 주석 §3 근거
// 참조). 여기서는 그 제거를 두 층으로 증명한다:
//   ① 정적: 프로덕션 소스에 `process.env` 참조가 0건이다(grep과 동형).
//   ② 행동: 실제(수리된) CLI를 자식 프로세스로 실행하되, 옛 seam과 같은
//      이름의 환경변수를 "악의적" fixture로 채워 넣어도 그 fixture가 전혀
//      쓰이지 않는다(§5-1 mutation은 이 방어를 도로 없앤 변조가 RED임을
//      증명한다, 아래).
// ---------------------------------------------------------------------------

// 주석(`// ...`)은 검사에서 뺀다 -- 이 파일 자신의 헤더 주석이 사람이
// 읽을 설명으로 "process.env"라는 문자열을 언급하기 때문에(3R 결정 근거를
// 적어 두려고), 문자열 그대로 grep하면 자기 자신의 설명글에 오탐한다.
// orca-cli-boundary.mjs의 EXEC_CALL_RE 전례와 달리 이 파일은 스캔 대상
// 문자열이 자기 설명에도 등장하므로 주석 줄만 제거하고 검사한다(코드
// 줄에는 절대 등장하면 안 된다는 계약은 그대로 유지).
function stripLineComments(src) {
  return src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

test("no-backdoor ①: production CLI source contains zero `process.env` references outside comments (structural proof there is no environment-variable seam)", () => {
  assert.equal(
    /process\.env/.test(stripLineComments(CLI_SRC)),
    false,
    "role-bound-seat-select-cli.mjs must not read any environment variable in code -- reintroducing one is exactly the P1 finding this round closed",
  );
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
// direct-entry (P1-2 수리 증거, 1R/2R부터 유지): 자식 프로세스로 실제
// `node role-bound-seat-select-cli.mjs ...`를 실행해 stdout/종료코드를
// 단언한다.
//
// ★3R 교체: 2R은 `ROLE_BOUND_SEAT_SELECT_FIXTURE` 환경변수(프로덕션
// seam)로 terminal/worktree list를 고정했다 -- 그 seam이 사라졌으므로,
// 이제 **시험이 프로그램 밖에서 환경을 제어한다**(coder-task.md §3 ⓑ
// 요구): `node --require <preload.cjs> <cli>`로 실행하고, preload가
// `node:child_process`의 `spawnSync`를 이 CLI 파일이 로드되기 *전에*
// monkeypatch한다 -- `createOrcaExecFn`이 호출 시점에 그 patched
// `spawnSync`를 그대로 쓴다(실측: ESM named import binding이 CJS
// `--require` preload의 monkeypatch를 그대로 반영함을 Windows(PowerShell,
// 격리 PATH)·POSIX(Git Bash) 둘 다에서 직접 확인했다).
//
// ⚠️정직 한계: 애초에 PATH 맨 앞에 가짜 `orca` 실행 파일을 두는 방식(§3
// ⓑ가 예시로 든 것)도 검토했으나, 이 환경의 Node 26에서
// `spawnSync(cmd, args, {shell:false})`는 PATH 상의 `.cmd`/`.bat`를 더
// 이상 자동 실행하지 않는다(직접 실측: 격리 PATH에 stub `orca.cmd`만
// 두고 실행하면 `ENOENT` -- Windows에서 성립하지 않음, §3 ⓑ의 "양쪽에서
// 안 되면 정직 한계로 적고 ⓐ로 가라"는 조건에 해당). `--require`
// monkeypatch는 OS의 PATH/확장자 해석에 의존하지 않으므로 이 문제를
// 겪지 않는다 -- 그래서 이 방식을 최종으로 골랐다(ⓑ 안에서의 구현
// 선택, 여전히 "프로그램 밖에서 환경을 제어"하는 방식이다).
// ---------------------------------------------------------------------------

// preload가 참조할 fixtures는 JSON으로 직렬화해 파일에 심는다(코드 문자열
// 안에 값을 인라인하지 않는다 -- 따옴표/특수문자 이스케이프 지옥 방지).
function writeFakeOrcaPreload(dir, { worktreeList, terminalList }) {
  const fixturesPath = join(dir, "fixtures.json");
  writeFileSync(
    fixturesPath,
    JSON.stringify({ worktreeList, terminalList }),
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

function runCliChildProcess(args, { preloadPath, extraEnv = {} } = {}) {
  const nodeArgs = preloadPath
    ? ["--require", preloadPath, CLI_PATH, ...args]
    : [CLI_PATH, ...args];
  try {
    const stdout = execFileSync(process.execPath, nodeArgs, {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

test("direct-entry: real child process, spawnSync monkeypatched via --require preload -- prints SELECTED with the role map and exits 0", () => {
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
    assert.equal(result.status, 1);
    assert.match(
      result.stdout.trim(),
      /^REJECTED code=ROLE_BOUND_SEAT_ROLE_UNDETERMINED reason=.*roles=\[term_unknown=UNDETERMINED, term_coder=CODER\]$/,
    );
  });
});

test("direct-entry: real child process, missing args -- usage REJECTED and exits 1 (no preload needed, fails before any execFn call)", () => {
  const result = runCliChildProcess([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout.trim(), /^REJECTED code=UNKNOWN reason=usage:/);
});

// ---------------------------------------------------------------------------
// mutation-kill 시험 2건 (coder-task.md HYK-211-seat-select-3 §5-1/§5-2).
// 둘 다 실 소스는 건드리지 않고, 변조된 사본 CLI 스크립트를 mkdtemp에 써서
// 자식 프로세스로 실행한다(orca-adapter mutation-kill 파일과 동일 원칙 --
// 원복 diff 0이 구조적으로 항상 참).
// ---------------------------------------------------------------------------

// ★★§5-1 (필수): 우회로 부활 변조 -- 2R이 반려당한 그 코드(환경변수로
// execFn을 갈아치우는 direct-entry)를 그대로 되살린 변조 스크립트를
// 실행한다. PATH를 격리해(가짜 `orca-none` 디렉터리만) 실제 `orca`가
// 전혀 없는 상태로 만들고, "그럴듯한" 이름의 환경변수에 조작된 fixture(가짜
// 좌석 `term_backdoor_coder`)를 채워 넣는다 -- 되살아난 변조는 그 fixture를
// 실제 좌석 목록인 것처럼 받아들여 `SELECTED handle=term_backdoor_coder`를
// 낸다(RED, 우회로가 실제로 다시 작동함을 보인다). 지금의 실제(수리된)
// CLI는 바로 아래 no-backdoor ② 시험이 같은 조건에서 그 우회가 통하지
// 않음을 확인한다.
function buildBackdoorRevivalMutantSource() {
  const adapterUrl = `file://${THIS_DIR.replace(/\\/g, "/")}/adapters/orca-adapter.mjs`;
  const cliUrl = `file://${CLI_PATH.replace(/\\/g, "/")}`;
  return `
import { readFileSync } from "node:fs";
import { resolveRoleBoundSeatHandle, createOrcaExecFn } from "${adapterUrl}";
import { parseRoleBoundSeatSelectArgs, formatRoleBoundSeatSelectResult, runRoleBoundSeatSelectCli } from "${cliUrl}";

// mutated: revives the 2R env-var backdoor inside runRoleBoundSeatSelectCli's
// direct-entry call site (the exact shape the reviewer flagged: an env var
// present -> fixture execFn, absent -> real orca).
function buildFixtureExecFn(fixturePath) {
  const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
  return function fixtureExecFn(argv) {
    const key = argv[0] === "worktree" && argv[1] === "list" ? "worktreeList"
      : argv[0] === "terminal" && argv[1] === "list" ? "terminalList" : null;
    if (!key || !(key in fixtures)) throw new Error("no stub: " + JSON.stringify(argv));
    return fixtures[key];
  };
}
const fixturePath = process.env.ROLE_BOUND_SEAT_SELECT_FIXTURE;
const cliOpts = fixturePath ? { execFn: buildFixtureExecFn(fixturePath) } : {};
const result = runRoleBoundSeatSelectCli(process.argv.slice(2), cliOpts);
console.log(formatRoleBoundSeatSelectResult(result));
process.exit(result.ok ? 0 : 1);
`;
}

function isolatedPathEnv(extra = {}) {
  const nodeDir = dirname(process.execPath);
  return { ...process.env, PATH: nodeDir, Path: nodeDir, ...extra };
}

test("NC mutation/role-bound-seat-select-cli #1 (필수, §5-1): 2R의 환경변수 백도어를 되살리는 변조 -> RED (가짜 좌석 목록으로 실제 배달 판단을 갈아치울 수 있게 된다)", () => {
  withTempDir("hyk211-cli-backdoor-mutant-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        seats: [{ schemaVersion: 1, ptyId: "pty_backdoor", role: "CODER" }],
      }),
      "utf8",
    );
    const fixturePath = join(dir, "malicious-fixture.json");
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
                handle: "term_backdoor_coder",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_backdoor",
              },
            ],
          },
        },
      }),
      "utf8",
    );
    const mutantPath = join(dir, "role-bound-seat-select-cli.mutant.mjs");
    writeFileSync(mutantPath, buildBackdoorRevivalMutantSource(), "utf8");
    let outcome;
    try {
      outcome = {
        status: 0,
        stdout: execFileSync(
          process.execPath,
          [
            mutantPath,
            "--role",
            "CODER",
            "--worktree",
            VALID_WORKTREE,
            "--registry",
            registryPath,
          ],
          {
            encoding: "utf8",
            env: isolatedPathEnv({
              ROLE_BOUND_SEAT_SELECT_FIXTURE: fixturePath,
            }),
          },
        ),
      };
    } catch (err) {
      outcome = {
        status: typeof err.status === "number" ? err.status : 1,
        stdout: typeof err.stdout === "string" ? err.stdout : "",
      };
    }
    assert.equal(
      outcome.status,
      0,
      "mutant must succeed by trusting the malicious fixture instead of the (absent, isolated-PATH) real orca (RED signal; proves the absence of an env-var seam is load-bearing)",
    );
    assert.match(outcome.stdout.trim(), /^SELECTED handle=term_backdoor_coder/);
  });
});

// no-backdoor ②(행동 증거): 위와 정확히 같은 조건(격리 PATH, 같은 이름의
// 환경변수, 같은 악의적 fixture)으로 지금의 실제(수리된) CLI를 실행한다 --
// 환경변수를 읽는 코드가 없으므로 fixture는 완전히 무시되고, 격리된
// PATH에는 진짜 `orca`가 없으므로 `spawnSync`가 ENOENT로 실패해 조회
// 실패로 정직하게 거부한다. `term_backdoor_coder`는 출력 어디에도 나타나지
// 않는다.
test("no-backdoor ②: real (fixed) CLI ignores the same env-var-shaped fixture under isolated PATH -- never trusts the malicious fixture, never selects the fabricated seat", () => {
  withTempDir("hyk211-cli-nobackdoor-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        seats: [{ schemaVersion: 1, ptyId: "pty_backdoor", role: "CODER" }],
      }),
      "utf8",
    );
    const fixturePath = join(dir, "malicious-fixture.json");
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
                handle: "term_backdoor_coder",
                worktreePath: VALID_WORKTREE,
                ptyId: "pty_backdoor",
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
      {
        extraEnv: isolatedPathEnv({
          ROLE_BOUND_SEAT_SELECT_FIXTURE: fixturePath,
        }),
      },
    );
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /term_backdoor_coder/);
    assert.doesNotMatch(result.stdout, /^SELECTED/);
  });
});

// ★§5-2 (필수, P1-2 유지 확인): direct-entry 배선 절단 -> RED. 1R의 실제
// 결함(direct-entry가 runRoleBoundSeatSelectCli를 안 부르고 parse+resolve를
// 따로 재호출해 registryPath 전달을 빠뜨리는 흔한 복붙 실수)을 재현한
// 변조 스크립트를 mkdtemp에 써서 실행한다.
function buildDirectEntryCutMutantSource() {
  const adapterUrl = `file://${THIS_DIR.replace(/\\/g, "/")}/adapters/orca-adapter.mjs`;
  const cliUrl = `file://${CLI_PATH.replace(/\\/g, "/")}`;
  return `
import { resolveRoleBoundSeatHandle, createOrcaExecFn } from "${adapterUrl}";
import { parseRoleBoundSeatSelectArgs, formatRoleBoundSeatSelectResult } from "${cliUrl}";

// mutated: direct-entry re-implements parse+resolve itself instead of
// calling runRoleBoundSeatSelectCli -- and forgets to forward registryPath
// (the exact class of bug P1-2 flagged).
const args = process.argv.slice(2);
const parsed = parseRoleBoundSeatSelectArgs(args);
if (!parsed.ok) {
  console.log("REJECTED code=UNKNOWN reason=" + parsed.reason);
  process.exit(1);
}
const execFn = createOrcaExecFn();
const result = resolveRoleBoundSeatHandle({ role: parsed.role, worktreePath: parsed.worktreePath }, { execFn });
console.log(formatRoleBoundSeatSelectResult(result));
process.exit(result.ok ? 0 : 1);
`;
}

function runDirectEntryCutMutant(dir, { registryPath, preloadPath }) {
  const mutantPath = join(dir, "role-bound-seat-select-cli.mutant.mjs");
  writeFileSync(mutantPath, buildDirectEntryCutMutantSource(), "utf8");
  const argv = [
    "--require",
    preloadPath,
    mutantPath,
    "--role",
    "CODER",
    "--worktree",
    VALID_WORKTREE,
    "--registry",
    registryPath,
  ];
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, argv, {
        encoding: "utf8",
        env: process.env,
      }),
    };
  } catch (err) {
    return {
      status: typeof err.status === "number" ? err.status : 1,
      stdout: typeof err.stdout === "string" ? err.stdout : "",
    };
  }
}

test("NC mutation/role-bound-seat-select-cli #2 (필수, §5-2): direct-entry가 runRoleBoundSeatSelectCli 를 안 쓰고 따로 재구현(registryPath 전달 누락) -> RED", () => {
  withTempDir("hyk211-cli-wiring-mutant-", (dir) => {
    const registryPath = join(dir, "registry.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        seats: [{ schemaVersion: 1, ptyId: "pty_coder", role: "CODER" }],
      }),
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
              handle: "term_coder",
              worktreePath: VALID_WORKTREE,
              ptyId: "pty_coder",
            },
          ],
        },
      },
    });
    const outcome = runDirectEntryCutMutant(dir, { registryPath, preloadPath });
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
