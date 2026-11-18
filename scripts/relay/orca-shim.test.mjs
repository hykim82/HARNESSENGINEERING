// orca-shim.test.mjs -- HYK-389 조각 1 고정 시험 T1~T6 + «라이브 설치 0» 칸.
//
// shim 을 «자식 프로세스로 실제 구동» 한다(테스트 helper 만 부르는 헛시험이
// 아니다): PowerShell shim(orca.ps1) · sh shim(orca) · CLI 직접(node). 진짜
// orca 자리에는 가짜 orca 대역(받은 argv 를 파일에 적는 node 스크립트)을 끼운다
// -- 진짜 orca 호출 0회. 원장은 mkdtemp 합성 경로. PATH 는 «자식 프로세스 env 로만»
// 바꾼다(이 프로세스 · 사용자 · 시스템 PATH 변경 0).
//
// 시험 단언 규율: 출력 «전체» 동등 단언 0 -- 자기 토막만. 고정 문면 비교는
// 프로덕션 export(MSG_*)와 한다.
//
// ★Linux CI 에서 ps1 칸: pwsh 가 없으면 skip 이 아니라 «사유 있는 분기»(그
// 칸이 존재하지 않음을 값으로 단언)로 간다 -- skip 수를 바꾸지 않는다.
// 이 기계(Windows)에서 못 잰 것: Linux · Node 20 · CI 러너의 pwsh 유무.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENV_LEDGER,
  ENV_REAL_BIN,
  ENV_REAL_BIN_PREFIX,
  MSG_LEDGER_WRITE_FAILED,
  MSG_NOT_VERIFIED,
  MSG_REAL_BIN_MISSING,
} from "./orca-shim-cli.mjs";
import {
  WRITE_VERBS,
  classifyArgv,
  hasStandaloneHelp,
} from "./orca-shim-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SHIM_DIR = path.join(REPO_ROOT, "templates", "orca-shim");
const CLI_PATH = path.join(HERE, "orca-shim-cli.mjs");
const IS_WIN = process.platform === "win32";

// ── 합성 환경 ──────────────────────────────────────────────────────
const DOUBLE_SOURCE = `import { appendFileSync } from "node:fs";
const log = process.env.FAKE_ORCA_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdout.write("FAKE_ORCA_OUT\\n");
process.exit(Number(process.env.FAKE_ORCA_EXIT ?? "0"));
`;

function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "hyk389-shim-"));
  const doublePath = path.join(root, "fake-orca.mjs");
  writeFileSync(doublePath, DOUBLE_SOURCE, "utf8");
  return {
    root,
    doublePath,
    ledger: path.join(root, "orca-direct-ledger.test.jsonl"),
    doubleLog: path.join(root, "double-calls.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// 자식 env: 이 프로세스 env 에서 하네스 · orca 값을 모두 걷어낸 뒤 합성 값만 올린다.
function childEnv(box, extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HARNESS_|ORCA_|FAKE_ORCA_|NODE_TEST_)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    ORCA_PANE_KEY: "pane-synthetic",
    HARNESS_ROLE: "ORCH",
    [ENV_REAL_BIN]: process.execPath,
    [ENV_REAL_BIN_PREFIX]: JSON.stringify([box.doublePath]),
    [ENV_LEDGER]: box.ledger,
    FAKE_ORCA_LOG: box.doubleLog,
    FAKE_ORCA_EXIT: "0",
    ...extra,
  });
  return env;
}

// «복사본» sh shim(저장소 상대 구조 밖)용 자식 env: childEnv() 가 HARNESS_* 를 걷어내므로
// HARNESS_ORCA_SHIM_CLI(저장소 CLI 절대 경로)를 «명시적으로» 주입해야 shim 이 CLI 를 찾는다
// (검토 1R P1-1 · 사유: shim 을 저장소 자리에서 구동하면 파일 모드 · 줄바꿈에 기대게 되어
// 복사 + env 주입이 Linux CI 에서 더 결정적이다). T6 비-Windows 분기와 T6b 가 같이 쓴다.
const ENV_SHIM_CLI = "HARNESS_ORCA_SHIM_CLI";
function posixCopiedShimEnv(box, extra = {}) {
  return childEnv(box, { [ENV_SHIM_CLI]: CLI_PATH, ...extra });
}

function findPwsh() {
  const probe = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8" },
  );
  return probe.error || probe.status !== 0 ? null : "pwsh";
}

function findSh() {
  if (!IS_WIN) return existsSync("/bin/sh") ? "/bin/sh" : null;
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const PWSH = findPwsh();
const SH = findSh();

// 어느 shim 을 자식 프로세스로 구동할 수 있는가(값으로 기록).
const KINDS = ["cli", ...(PWSH ? ["ps1"] : []), ...(SH ? ["sh"] : [])];

function runShim(kind, args, env, cwd) {
  const options = { env, cwd, encoding: "utf8", shell: false };
  if (kind === "cli") {
    return spawnSync(process.execPath, [CLI_PATH, ...args], options);
  }
  if (kind === "ps1") {
    return spawnSync(
      PWSH,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        path.join(SHIM_DIR, "orca.ps1"),
        ...args,
      ],
      options,
    );
  }
  const shim = path.join(SHIM_DIR, "orca").replace(/\\/g, "/");
  return spawnSync(SH, [shim, ...args], options);
}

function ledgerLines(box) {
  if (!existsSync(box.ledger)) return [];
  return readFileSync(box.ledger, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function doubleCalls(box) {
  if (!existsSync(box.doubleLog)) return [];
  return readFileSync(box.doubleLog, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function withBox(fn) {
  const box = makeSandbox();
  try {
    return fn(box);
  } finally {
    box.cleanup();
  }
}

// ── 구동 가능한 칸 기록(사유 있는 분기 · skip 아님) ────────────────────
test("kinds: which shim kinds were drivable on this machine (value, not skip)", () => {
  assert.ok(KINDS.includes("cli"));
  assert.equal(PWSH === null, !KINDS.includes("ps1"));
  assert.equal(SH === null, !KINDS.includes("sh"));
  const reason = {
    ps1: PWSH
      ? "pwsh 있음 -> ps1 칸 구동"
      : "pwsh 없음 -> ps1 칸 없음(사유 분기)",
    sh: SH
      ? `sh 있음(${path.basename(SH)}) -> sh 칸 구동`
      : "sh 없음 -> sh 칸 없음(사유 분기)",
  };
  console.log(
    `# shim-kinds ${JSON.stringify({ platform: process.platform, KINDS, reason })}`,
  );
});

for (const kind of KINDS) {
  // T1 — 쓰기 동사: 원장 1줄 + 대역이 같은 argv + 종료코드 그대로.
  test(`T1[${kind}] terminal send -> 원장 1줄(verb=send target=t1 text_len=1) + 대역 같은 argv + 종료코드 그대로`, () =>
    withBox((box) => {
      const args = [
        "terminal",
        "send",
        "--terminal",
        "t1",
        "--text",
        "x",
        "--enter",
        "--json",
      ];
      const r = runShim(
        kind,
        args,
        childEnv(box, { FAKE_ORCA_EXIT: "7" }),
        box.root,
      );
      assert.equal(r.status, 7, `종료코드는 대역 것 그대로: ${r.stderr}`);
      assert.match(r.stdout, /FAKE_ORCA_OUT/);
      const lines = ledgerLines(box);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].verb, "send");
      assert.equal(lines[0].domain, "terminal");
      assert.equal(lines[0].target, "t1");
      assert.equal(lines[0].text_len, 1);
      assert.equal(lines[0].actor, "orch");
      assert.equal(lines[0].pane_key, "pane-synthetic");
      assert.equal(lines[0].role, "ORCH");
      assert.equal(typeof lines[0].ts, "string");
      assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
      const calls = doubleCalls(box);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, args);
    }));

  test(`T1b[${kind}] 원장 줄에 본문이 없다(--text 는 길이만) · HARNESS_ROLE 없으면 actor=unattributed`, () =>
    withBox((box) => {
      const secret = "SECRET-PAYLOAD-한글-12345";
      const env = childEnv(box);
      delete env.HARNESS_ROLE;
      const r = runShim(
        kind,
        ["terminal", "send", "--terminal", "t9", "--text", secret],
        env,
        box.root,
      );
      assert.equal(r.status, 0, r.stderr);
      const raw = readFileSync(box.ledger, "utf8");
      assert.ok(
        !raw.includes("SECRET-PAYLOAD"),
        "원장 줄에 본문이 새면 안 된다",
      );
      const [line] = ledgerLines(box);
      assert.equal(line.text_len, Array.from(secret).length);
      assert.equal(line.actor, "unattributed");
      assert.equal(line.role, null);
    }));

  // T2 — 조회 동사: 원장 0줄 · 위임 1회.
  test(`T2[${kind}] terminal list -> 원장 0줄 · 위임 1회`, () =>
    withBox((box) => {
      const args = ["terminal", "list", "--json"];
      const r = runShim(kind, args, childEnv(box), box.root);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(ledgerLines(box).length, 0);
      const calls = doubleCalls(box);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, args);
    }));

  // T3 — --help 독립 토큰만 면제(보존 브랜치 hyk389-send-boundary-1 SHA 6fa3be2 사례 이식).
  test(`T3[${kind}] terminal send --help -> 원장 0줄 · 위임은 함`, () =>
    withBox((box) => {
      const r = runShim(
        kind,
        ["terminal", "send", "--help"],
        childEnv(box),
        box.root,
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(ledgerLines(box).length, 0);
      assert.equal(doubleCalls(box).length, 1);
    }));

  test(`T3b[${kind}] --text=--help · --text "a --help" · --text --help 는 도움말이 아니다 -> 각 원장 1줄`, () =>
    withBox((box) => {
      const cases = [
        ["terminal", "send", "--terminal", "t1", "--text=--help"],
        ["terminal", "send", "--terminal", "t1", "--text", "a --help"],
        ["terminal", "send", "--terminal", "t1", "--text", "--help"],
      ];
      for (const args of cases) {
        const r = runShim(kind, args, childEnv(box), box.root);
        assert.equal(r.status, 0, `${JSON.stringify(args)}: ${r.stderr}`);
      }
      assert.equal(ledgerLines(box).length, cases.length);
      assert.equal(doubleCalls(box).length, cases.length);
    }));

  // T4 — 원장 쓰기 불가: 위임은 함 + 경고 + 종료코드 = 대역 것.
  test(`T4[${kind}] 원장 경로 쓰기 불가 -> 위임은 함 + ${MSG_LEDGER_WRITE_FAILED} + 종료코드 = 대역 것`, () =>
    withBox((box) => {
      const blocker = path.join(box.root, "blocker-file");
      writeFileSync(blocker, "not a directory", "utf8");
      const env = childEnv(box, {
        [ENV_LEDGER]: path.join(blocker, "ledger.jsonl"),
        FAKE_ORCA_EXIT: "5",
      });
      const args = ["terminal", "send", "--terminal", "t1", "--text", "x"];
      const r = runShim(kind, args, env, box.root);
      assert.equal(r.status, 5);
      assert.ok(r.stderr.includes(MSG_LEDGER_WRITE_FAILED), r.stderr);
      const calls = doubleCalls(box);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].argv, args);
    }));

  // T5 — 진짜 바이너리 없음: 위임 0 · 비0 · «조회 실패 ≠ 위반 없음».
  test(`T5[${kind}] 진짜 바이너리 경로 없음 -> 위임 0 · 비0 · 조회 실패 ≠ 위반 없음`, () =>
    withBox((box) => {
      const missing = path.join(box.root, "no-such-orca-binary");
      const r = runShim(
        kind,
        ["terminal", "send", "--terminal", "t1", "--text", "x"],
        childEnv(box, { [ENV_REAL_BIN]: missing }),
        box.root,
      );
      assert.notEqual(r.status, 0);
      assert.equal(doubleCalls(box).length, 0);
      assert.ok(r.stderr.includes(MSG_REAL_BIN_MISSING), r.stderr);
      assert.ok(r.stderr.includes(MSG_NOT_VERIFIED), r.stderr);
      assert.equal(ledgerLines(box).length, 0);
    }));

  test(`T5b[${kind}] 진짜 바이너리 변수 자체가 없어도 위임 0 · 비0`, () =>
    withBox((box) => {
      const env = childEnv(box);
      delete env[ENV_REAL_BIN];
      const r = runShim(kind, ["terminal", "list"], env, box.root);
      assert.notEqual(r.status, 0);
      assert.equal(doubleCalls(box).length, 0);
      assert.ok(r.stderr.includes(MSG_NOT_VERIFIED), r.stderr);
    }));
}

// T6 — m1: node spawnSync("orca", {shell:false}) 는 shim 이 PATH 앞에 있어도
// Windows 에서는 «.exe 만» 잡는다(CreateProcess 규칙) -> 어댑터 경로는 기록
// 대상이 아니다. POSIX 는 execvp 가 실행 가능한 `orca` shim 을 먼저 잡는다
// (이 분기는 이 기계에서 못 쟀다 〔못쟀다〕 -- Linux 에서 처음 도는 칸이다. 복사본 shim 은
// 저장소 상대 구조 밖이라 CLI 를 못 찾으므로 env 에 HARNESS_ORCA_SHIM_CLI 를 주입한다
// (posixCopiedShimEnv). 그 «복사본 sh shim + 주입 env» 모양은 Git bash 로 T6b 가 이
// 기계에서도 먼저 구동한다 -- 그러나 execvp 가 shim 을 먼저 잡는다는 쪽은 여전히 추론).
test("T6(m1) node spawnSync('orca',{shell:false}) 가 PATH 앞 shim 디렉터리를 두고도 대역 실행 파일을 잡는다(Windows) / POSIX 는 shim 이 먼저(추론)", () =>
  withBox((box) => {
    const exeDir = path.join(box.root, "exe-dir");
    mkdirSync(exeDir);
    const shimDir = path.join(box.root, "shim-dir");
    mkdirSync(shimDir);
    // shim 디렉터리에는 두 shim 의 «복사본» 만 둔다(저장소 파일 모드에 의존 안 함).
    copyFileSync(
      path.join(SHIM_DIR, "orca.ps1"),
      path.join(shimDir, "orca.ps1"),
    );
    copyFileSync(path.join(SHIM_DIR, "orca"), path.join(shimDir, "orca"));
    chmodSync(path.join(shimDir, "orca"), 0o755);
    const env = {
      ...childEnv(box),
      PATH: [shimDir, exeDir, process.env.PATH ?? ""].join(path.delimiter),
    };
    if (IS_WIN) {
      // 대역 .exe = node.exe 의 하드링크(실패하면 복사) -- `--version` 이 대역 정체를 밝힌다.
      const exe = path.join(exeDir, "orca.exe");
      try {
        linkSync(process.execPath, exe);
      } catch {
        copyFileSync(process.execPath, exe);
      }
      const r = spawnSync("orca", ["--version"], {
        env,
        encoding: "utf8",
        shell: false,
      });
      assert.equal(r.error, undefined, String(r.error));
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), process.version);
      assert.equal(
        ledgerLines(box).length,
        0,
        "어댑터 경로는 기록 대상이 아니다",
      );
    } else {
      // POSIX: 실행 가능한 shim `orca` 가 PATH 앞이면 execvp 가 그것을 잡는다(추론).
      const r = spawnSync(
        "orca",
        ["terminal", "send", "--terminal", "t1", "--text", "x"],
        {
          env: { ...posixCopiedShimEnv(box), PATH: env.PATH },
          encoding: "utf8",
          shell: false,
        },
      );
      assert.equal(r.status, 0, r.stderr);
      assert.equal(
        ledgerLines(box).length,
        1,
        "POSIX: PATH 앞 shim 이 node spawn 도 감싼다(Linux 실측 못 함)",
      );
    }
  }));

// T6b — 복사본 sh shim 이 «CLI 를 어떻게 찾는가» 를 이 기계(Windows · Git bash)에서도
// 값으로 고정한다(T6 의 비-Windows 분기는 Linux CI 에서만 돈다 -- 그 분기가 쓰는
// env 모양을 같은 헬퍼로 여기서 먼저 구동한다). 복사본은 저장소 상대 구조(../../
// scripts/relay/)가 없는 자리에 있으므로 HARNESS_ORCA_SHIM_CLI 없이는 CLI 를 못 찾아
// 127 이다 -- childEnv() 가 HARNESS_* 를 걷어내므로 «명시적으로 주입» 해야 한다.
test("T6b 복사본 sh shim: HARNESS_ORCA_SHIM_CLI 없으면 127(CLI 못 찾음) · 주입하면 0 + 원장 1줄(Linux 조건 흉내 · Git bash)", () =>
  withBox((box) => {
    if (SH === null) {
      assert.equal(
        KINDS.includes("sh"),
        false,
        "sh 없음 -> T6b 칸 없음(사유 분기 · skip 아님)",
      );
      return;
    }
    const shimDir = path.join(box.root, "copied-shim-dir");
    mkdirSync(shimDir);
    const copied = path.join(shimDir, "orca");
    copyFileSync(path.join(SHIM_DIR, "orca"), copied);
    chmodSync(copied, 0o755);
    const args = ["terminal", "send", "--terminal", "t1", "--text", "x"];
    const run = (env) =>
      spawnSync(SH, [copied.replace(/\\/g, "/"), ...args], {
        env,
        cwd: box.root,
        encoding: "utf8",
        shell: false,
      });
    // (a) 주입 없음 = b9a4e00 의 T6 비-Windows env 모양 -> 127 · 위임 0 · 기록 0.
    const bare = run(childEnv(box));
    assert.equal(bare.status, 127, bare.stderr);
    assert.ok(bare.stderr.includes("ORCA_SHIM_CLI_MISSING"), bare.stderr);
    assert.equal(doubleCalls(box).length, 0);
    assert.equal(ledgerLines(box).length, 0);
    // (b) 주입 = T6 비-Windows 분기가 쓰는 env -> 0 · 위임 1 · 원장 1줄.
    const injected = run(posixCopiedShimEnv(box));
    assert.equal(injected.status, 0, injected.stderr);
    assert.equal(doubleCalls(box).length, 1);
    assert.equal(ledgerLines(box).length, 1);
  }));

// T7 — ps1 shim 은 호출자 스크립트 값을 «프로세스 전역에 남기지 않는다»(검토 1R P1-2).
// 같은 pwsh 프로세스에서 «스크립트 경유 호출 1번 -> 직접 호출 1번» 을 차례로 한다
// (shim 은 경로로 직접 호출 -> PATH 해석(OS 마다 다름)에 의존하지 않는다).
function runPs1Session(box, extraEnv, statements) {
  return spawnSync(
    PWSH,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", statements],
    {
      env: childEnv(box, extraEnv),
      cwd: box.root,
      encoding: "utf8",
      shell: false,
    },
  );
}

function psq(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

test("T7 ps1: 스크립트 경유 호출 뒤 같은 pwsh 의 직접 호출이 앞 caller_script 를 달지 않는다 · 호출 뒤 셸 env 에 값이 남지 않는다", () =>
  withBox((box) => {
    if (PWSH === null) {
      assert.equal(
        KINDS.includes("ps1"),
        false,
        "pwsh 없음 -> T7 칸 없음(사유 분기 · skip 아님)",
      );
      return;
    }
    const shimPs1 = path.join(SHIM_DIR, "orca.ps1");
    const launcher = path.join(box.root, "fake-launcher.ps1");
    writeFileSync(
      launcher,
      `& ${psq(shimPs1)} terminal send --terminal from-launcher --text x\n`,
      "utf8",
    );
    const r = runPs1Session(
      box,
      {},
      [
        `& ${psq(launcher)}`,
        `& ${psq(shimPs1)} terminal send --terminal typed-directly --text y`,
        `Write-Output ('AFTER=[' + [string]$env:HARNESS_ORCA_SHIM_CALLER + ']')`,
      ].join("; "),
    );
    assert.equal(r.status, 0, r.stderr);
    const lines = ledgerLines(box);
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.equal(lines[0].target, "from-launcher");
    // tmpdir 의 8.3 단축 이름(Windows) · 심볼릭 링크(macOS)가 경로 문자열을 바꿀 수 있어 파일명으로 대조한다.
    assert.equal(
      path.basename(lines[0].caller_script ?? ""),
      path.basename(launcher),
      "스크립트 경유 호출은 그 스크립트 경로를 단다",
    );
    assert.equal(lines[1].target, "typed-directly");
    assert.equal(
      lines[1].caller_script,
      null,
      "직접 호출은 앞 스크립트 경로를 달면 안 된다",
    );
    assert.ok(
      r.stdout.includes("AFTER=[]"),
      `셸 env 에 값이 남았다: ${r.stdout}`,
    );
  }));

test("T7b ps1: 바깥이 이미 쥔 HARNESS_ORCA_SHIM_CALLER 는 직접 호출에 새지 않고 · 호출 뒤 원래 값으로 되돌려진다", () =>
  withBox((box) => {
    if (PWSH === null) {
      assert.equal(KINDS.includes("ps1"), false);
      return;
    }
    const shimPs1 = path.join(SHIM_DIR, "orca.ps1");
    const r = runPs1Session(
      box,
      { HARNESS_ORCA_SHIM_CALLER: "PRESET-OUTER-VALUE" },
      [
        `& ${psq(shimPs1)} terminal send --terminal typed-directly --text y`,
        `Write-Output ('AFTER=[' + [string]$env:HARNESS_ORCA_SHIM_CALLER + ']')`,
      ].join("; "),
    );
    assert.equal(r.status, 0, r.stderr);
    const lines = ledgerLines(box);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(
      lines[0].caller_script,
      null,
      "직접 호출 때 바깥 값이 caller_script 로 새면 안 된다",
    );
    assert.ok(
      r.stdout.includes("AFTER=[PRESET-OUTER-VALUE]"),
      `호출 뒤 원래 값으로 되돌려져야 한다: ${r.stdout}`,
    );
  }));

// m2 — PowerShell 이 PATH 앞 `orca.ps1` 을 뒤쪽 `orca.exe` 보다 먼저 고르는가
// (자식 pwsh 에 합성 PATH · 대역만). Windows 는 값으로 단언한다. 그 밖의 OS 는
// 같은 질문을 던져 «값을 기록» 만 한다(pwsh 의 해석이 OS 마다 다르다 〔못쟀다〕).
test("m2 자식 pwsh: shim 디렉터리가 PATH 앞이면 Get-Command orca 의 첫 결과가 orca.ps1(ExternalScript), exe 디렉터리가 앞이면 Application", () =>
  withBox((box) => {
    if (PWSH === null) {
      assert.equal(
        KINDS.includes("ps1"),
        false,
        "pwsh 없음 -> m2 칸 없음(사유 분기 · skip 아님)",
      );
      return;
    }
    const shimDir = path.join(box.root, "a-shim");
    const exeDir = path.join(box.root, "b-exe");
    mkdirSync(shimDir);
    mkdirSync(exeDir);
    copyFileSync(
      path.join(SHIM_DIR, "orca.ps1"),
      path.join(shimDir, "orca.ps1"),
    );
    const exe = path.join(exeDir, IS_WIN ? "orca.exe" : "orca");
    if (IS_WIN) {
      try {
        linkSync(process.execPath, exe);
      } catch {
        copyFileSync(process.execPath, exe);
      }
    } else {
      writeFileSync(exe, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(exe, 0o755);
    }
    const first = (dirs) => {
      const script = `$env:PATH = '${dirs.join(path.delimiter)}' + [IO.Path]::PathSeparator + $env:PATH; (Get-Command orca | Select-Object -First 1).CommandType.ToString()`;
      const r = spawnSync(
        PWSH,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          env: childEnv(box),
        },
      );
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const shimFirst = first([shimDir, exeDir]);
    const exeFirst = first([exeDir, shimDir]);
    console.log(
      `# m2 ${JSON.stringify({ platform: process.platform, shimFirst, exeFirst })}`,
    );
    if (IS_WIN) {
      assert.equal(shimFirst, "ExternalScript");
      assert.equal(exeFirst, "Application");
    } else {
      assert.ok(shimFirst.length > 0 && exeFirst.length > 0);
    }
  }));

// ── 코어 단위(순수 함수) -- 자식 구동 칸의 보조 ────────────────────────
test("core: WRITE_VERBS 가 설계 목록과 같다(terminal 7 · orchestration 3)", () => {
  assert.deepEqual([...WRITE_VERBS.terminal].sort(), [
    "close",
    "create",
    "rename",
    "send",
    "split",
    "stop",
    "switch",
  ]);
  assert.deepEqual([...WRITE_VERBS.orchestration].sort(), [
    "dispatch",
    "send",
    "task-update",
  ]);
});

test("core: classifyArgv 는 쓰기/조회/도움말을 가른다", () => {
  assert.equal(
    classifyArgv(["terminal", "close", "--terminal", "t"]).kind,
    "write",
  );
  assert.equal(
    classifyArgv(["orchestration", "dispatch", "--to", "h"]).kind,
    "write",
  );
  assert.equal(
    classifyArgv(["orchestration", "task-update", "--id", "x"]).target,
    "x",
  );
  assert.equal(
    classifyArgv(["terminal", "show", "--terminal", "t"]).kind,
    "read",
  );
  assert.equal(classifyArgv(["worktree", "create"]).kind, "read");
  assert.equal(classifyArgv([]).kind, "read");
  assert.equal(classifyArgv(["terminal", "send", "--help"]).kind, "help");
  assert.equal(hasStandaloneHelp(["terminal", "send", "--text=--help"]), false);
});

test("core: orca-shim-core.mjs 는 zero-import(import 문 0 · require 0)", () => {
  const source = readFileSync(path.join(HERE, "orca-shim-core.mjs"), "utf8");
  assert.ok(!/^\s*import\s/m.test(source), "정적 import 가 있다");
  assert.ok(!/\bimport\s*\(/.test(source), "동적 import 가 있다");
  assert.ok(!/\brequire\s*\(/.test(source), "require 가 있다");
});

// ── 「라이브 설치 0」 고정 ─────────────────────────────────────────────
// 설치기(install.mjs)가 shim 을 «좌석에 얹지» 않는다: PATH · 프로필 · 사용자
// 환경을 건드리지 않고, `orca` 라는 이름의 실행 파일을 대상에 만들지 않는다.
test("라이브 설치 0: install.mjs 소스에 PATH · 프로필 · 사용자 환경 변경 구문이 없다", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "templates", "harness-init", "install.mjs"),
    "utf8",
  );
  const forbidden = [
    /\bsetx\b/i,
    /SetEnvironmentVariable/,
    /\$PROFILE/,
    /\.bashrc|\.zshrc|\.zprofile|\.bash_profile/,
    /Microsoft\.PowerShell_profile/,
    /process\.env\.PATH\s*=[^=]/,
    /process\.env\[["']PATH["']\]\s*=[^=]/,
    /\bHKCU\b|\bHKLM\b/,
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `install.mjs 에 ${pattern} 가 있다`);
  }
});

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

// 합성 사용자 환경: 홈 · AppData 를 빈 합성 디렉터리로 돌려 설치기가 «사용자
// 환경» 에 쓰면 그 디렉터리가 비어 있지 않게 되도록 한다.
function syntheticInstallEnv(fakeHome, fakeAppData) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HARNESS_|ORCA_|NODE_TEST_|ADMISSION_|DISPATCH_RECEIPT)/.test(key))
      delete env[key];
  }
  return Object.assign(env, {
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    APPDATA: fakeAppData,
    LOCALAPPDATA: fakeAppData,
  });
}

function installerArgs(base, target) {
  return [
    path.join(REPO_ROOT, "templates", "harness-init", "install.mjs"),
    ...["--profile", "solo-full", "--repo-path", target],
    ...["--control-room-path", path.join(base, "fake-control-room")],
    ...["--github-repo", "someorg/somerepo", "--bot-account", "bot-x"],
    ...["--verify-cmd", "npm test", "--notify-dir", path.join(base, "notify")],
    ...["--approver-login", "approver-x", "--approver-id", "1"],
    ...["--workspaces-root", path.join(base, "workspaces")],
    ...["--main-repo-path", path.join(base, "main-repo")],
  ];
}

test("라이브 설치 0: 실제 설치기로 합성 대상에 설치하면 shim 코어 · CLI 만 복사되고 PATH 에 얹힐 `orca` 파일은 0 · 샌드박스 사용자 홈은 비어 있다", () => {
  const base = mkdtempSync(path.join(tmpdir(), "hyk389-install-"));
  try {
    const target = path.join(base, "target-repo");
    mkdirSync(target, { recursive: true });
    spawnSync("git", ["-C", target, "init", "-q"], { encoding: "utf8" });
    const fakeHome = path.join(base, "fake-home");
    const fakeAppData = path.join(base, "fake-appdata");
    mkdirSync(fakeHome);
    mkdirSync(fakeAppData);
    const r = spawnSync(process.execPath, installerArgs(base, target), {
      env: syntheticInstallEnv(fakeHome, fakeAppData),
      encoding: "utf8",
      cwd: base,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    // (a) 복사 목록: 코어 · CLI 는 실제로 설치됐다.
    for (const name of ["orca-shim-core.mjs", "orca-shim-cli.mjs"]) {
      assert.ok(
        existsSync(path.join(target, "scripts", "relay", name)),
        `${name} 가 설치돼야 한다`,
      );
    }
    // (b) PATH 에 얹히면 동작하는 shim 이름(orca · orca.ps1 · orca.cmd · orca.exe)은 대상 어디에도 없다.
    const stray = walkFiles(target).filter((f) =>
      /^orca(\.ps1|\.cmd|\.exe|\.bat)?$/i.test(path.basename(f)),
    );
    assert.deepEqual(stray, []);
    // (c) 합성 사용자 홈 · AppData 는 비어 있다(프로필 · 사용자 환경 무변).
    assert.deepEqual(readdirSync(fakeHome), []);
    assert.deepEqual(readdirSync(fakeAppData), []);
    // (d) 설치된 대상 디렉터리들을 PATH 로 줘도 `orca` 는 해석되지 않는다 -> 무동작.
    const probe = spawnSync("orca", ["--version"], {
      env: {
        PATH: [
          path.join(target, "scripts", "relay"),
          path.join(target, "scripts", "check"),
          target,
        ].join(path.delimiter),
      },
      encoding: "utf8",
      shell: false,
    });
    assert.ok(
      probe.error && probe.error.code === "ENOENT",
      `orca 가 해석되면 안 된다: ${probe.error?.code}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
