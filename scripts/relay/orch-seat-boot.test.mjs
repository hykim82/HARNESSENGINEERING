// orch-seat-boot.test.mjs -- HYK-389 조각 2 저장소 몫: ORCH 좌석 부팅 판정 CLI +
// 런처 템플릿 시험(기록 단계 · OBSERVER · 앵커 아님).
//
// 프로덕션 진입점을 «자식 프로세스로 실제 구동» 한다:
//   - 부팅 판정 CLI = `node scripts/relay/orch-seat-boot.mjs`
//   - 런처 템플릿   = `pwsh -File templates/orca-shim/orca-orch-seat.ps1`
// 합성 재료만 쓴다: mkdtemp 합성 원장 · 합성 shim 디렉터리 · 가짜 «진짜 orca 경로» ·
// 가짜 실행 명령(자기 PATH · 역할 env · 인자를 파일로 남기는 node 스크립트).
// ⛔실제 `orca` · 실제 좌석 명령 실행 0 · 사용자 PATH · 환경 변수 변경 0(자식 env 로만).
//
// 새 모듈을 정적 import 하지 않는다 -- 모듈이 없을 때 «파일 전체 빨강» 이 아니라
// 칸마다 빨강이 보이게(프로덕션 진입점 구동만).
//
// 시험 단언 규율: 출력 «전체» 문자열 동등 단언 0 -- 자기 토막만.
// ★ps1 칸: Windows + pwsh 가 없으면 skip 이 아니라 «사유 있는 분기» -- skip 수 무변.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SHIM_TEMPLATE_DIR = path.join(REPO_ROOT, "templates", "orca-shim");
const BOOT_CLI = path.join(HERE, "orch-seat-boot.mjs");
const SHIM_CLI = path.join(HERE, "orca-shim-cli.mjs");
const LAUNCHER = path.join(SHIM_TEMPLATE_DIR, "orca-orch-seat.ps1");
const IS_WIN = process.platform === "win32";

const PWSH = (() => {
  const probe = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    { encoding: "utf8" },
  );
  return probe.error || probe.status !== 0 ? null : "pwsh";
})();

// 가짜 실행 명령: 자기 PATH · 역할 env · 인자를 파일로 남긴다.
const FAKE_COMMAND_SOURCE = `import { writeFileSync } from "node:fs";
const env = process.env;
writeFileSync(env.FAKE_TRACE, JSON.stringify({
  path: env.PATH ?? env.Path ?? null,
  role: env.HARNESS_ROLE ?? null,
  realBin: env.HARNESS_ORCA_REAL_BIN ?? null,
  ledger: env.HARNESS_ORCA_SHIM_LEDGER ?? null,
  shimCli: env.HARNESS_ORCA_SHIM_CLI ?? null,
  mark: env.HARNESS_ORCA_SHIM ?? null,
  argv: process.argv.slice(2),
}));
process.exit(Number(env.FAKE_EXIT ?? "0"));
`;

// 가짜 진짜 orca(조각 1 shim CLI 가 위임하는 대역) -- 받은 argv 를 파일에 적는다.
const FAKE_ORCA_SOURCE = `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.exit(0);
`;

function makeBox() {
  const root = mkdtempSync(path.join(tmpdir(), "hyk389-orch-boot-"));
  const shimDir = path.join(root, "shim-dir");
  mkdirSync(shimDir);
  // 합성 shim 디렉터리: 이름만 맞는 빈 파일(실제 shim 은 구동하지 않는다).
  writeFileSync(path.join(shimDir, "orca.ps1"), "# synthetic\n", "utf8");
  writeFileSync(path.join(shimDir, "orca"), "# synthetic\n", "utf8");
  const fakeRealBin = path.join(root, "fake-real-orca.exe");
  writeFileSync(fakeRealBin, "synthetic", "utf8");
  const fakeShimCli = path.join(root, "fake-shim-cli.mjs");
  writeFileSync(fakeShimCli, "// synthetic\n", "utf8");
  const fakeCommand = path.join(root, "fake-command.mjs");
  writeFileSync(fakeCommand, FAKE_COMMAND_SOURCE, "utf8");
  const fakeOrca = path.join(root, "fake-orca.mjs");
  writeFileSync(fakeOrca, FAKE_ORCA_SOURCE, "utf8");
  return {
    root,
    shimDir,
    fakeRealBin,
    fakeShimCli,
    fakeCommand,
    fakeOrca,
    ledger: path.join(root, "orca-direct-ledger.test.jsonl"),
    trace: path.join(root, "command-trace.json"),
    orcaLog: path.join(root, "fake-orca-calls.jsonl"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withBox(fn) {
  const box = makeBox();
  try {
    return fn(box);
  } finally {
    box.cleanup();
  }
}

// 자식 env: 이 프로세스 env 에서 하네스 · orca 값을 걷어낸 뒤 합성 값만 올린다.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(HARNESS_|ORCA_|FAKE_|NODE_TEST_)/.test(key)) delete env[key];
  }
  return Object.assign(env, extra);
}

function runBoot(box, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BOOT_CLI, ...args], {
    env: cleanEnv(extraEnv),
    cwd: box.root,
    encoding: "utf8",
  });
}

function goodArgs(box, over = {}) {
  const values = {
    "--real-bin": box.fakeRealBin,
    "--shim-dir": box.shimDir,
    "--shim-cli": box.fakeShimCli,
    "--ledger": box.ledger,
    "--mark": "2026-11-18T12:00:00.000Z",
    "--role": "ORCH",
    ...over,
  };
  return Object.entries(values).flatMap(([k, v]) => (v === null ? [] : [k, v]));
}

function ledgerLines(box) {
  if (!existsSync(box.ledger)) return [];
  return readFileSync(box.ledger, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
}

function parseResult(r) {
  const out = r.stdout.trim();
  assert.ok(!out.includes("\n"), `stdout 은 한 줄 JSON 이어야 한다: ${out}`);
  return JSON.parse(out);
}

// ── 부팅 판정 CLI ───────────────────────────────────────────────────
test("B1 진짜 경로 · shim · CLI 모두 있음 -> enabled + 원장 orch_seat_boot 1줄 + 종료 0", () =>
  withBox((box) => {
    const r = runBoot(box, goodArgs(box));
    assert.equal(r.status, 0, r.stderr);
    const result = parseResult(r);
    assert.equal(result.shim, "enabled");
    assert.equal(result.reason, null);
    assert.equal(result.ledger, "written");
    const lines = ledgerLines(box);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "orch_seat_boot");
    assert.equal(lines[0].shim, "enabled");
    assert.equal(lines[0].reason, null);
    assert.equal(lines[0].role, "ORCH");
    assert.equal(lines[0].launcher_mark, "2026-11-18T12:00:00.000Z");
    assert.equal(lines[0].cwd, box.root);
    assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  }));

test("B1b 인자 대신 환경 변수로 주입해도 같은 판정(인자가 없으면 env)", () =>
  withBox((box) => {
    const r = runBoot(box, [], {
      HARNESS_ORCA_REAL_BIN: box.fakeRealBin,
      HARNESS_ORCA_SHIM_DIR: box.shimDir,
      HARNESS_ORCA_SHIM_CLI: box.fakeShimCli,
      HARNESS_ORCA_SHIM_LEDGER: box.ledger,
      HARNESS_ORCA_SHIM: "mark-from-env",
      HARNESS_ROLE: "ORCH",
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseResult(r).shim, "enabled");
    const [line] = ledgerLines(box);
    assert.equal(line.launcher_mark, "mark-from-env");
    assert.equal(line.role, "ORCH");
  }));

test("B2 가짜 진짜 경로 «없음» -> disabled + REAL_BIN_MISSING + 원장 부팅 1줄 + 종료 0", () =>
  withBox((box) => {
    const missing = path.join(box.root, "no-such-real-orca.exe");
    const r = runBoot(box, goodArgs(box, { "--real-bin": missing }));
    assert.equal(r.status, 0, r.stderr);
    const result = parseResult(r);
    assert.equal(result.shim, "disabled");
    assert.equal(result.reason, "REAL_BIN_MISSING");
    const lines = ledgerLines(box);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "orch_seat_boot");
    assert.equal(lines[0].shim, "disabled");
    assert.equal(lines[0].reason, "REAL_BIN_MISSING");
  }));

test("B3 shim 디렉터리에 shim 파일 없음 -> disabled + SHIM_MISSING", () =>
  withBox((box) => {
    const emptyDir = path.join(box.root, "empty-shim-dir");
    mkdirSync(emptyDir);
    const r = runBoot(box, goodArgs(box, { "--shim-dir": emptyDir }));
    assert.equal(r.status, 0, r.stderr);
    const result = parseResult(r);
    assert.equal(result.shim, "disabled");
    assert.equal(result.reason, "SHIM_MISSING");
    assert.equal(ledgerLines(box)[0].reason, "SHIM_MISSING");
  }));

test("B4 shim CLI 없음 -> disabled + CLI_MISSING", () =>
  withBox((box) => {
    const r = runBoot(
      box,
      goodArgs(box, { "--shim-cli": path.join(box.root, "no-such-cli.mjs") }),
    );
    assert.equal(r.status, 0, r.stderr);
    const result = parseResult(r);
    assert.equal(result.shim, "disabled");
    assert.equal(result.reason, "CLI_MISSING");
  }));

test("B4b 여러 실패가 겹치면 reason = 판정 순서의 첫 값 · reasons = 전부", () =>
  withBox((box) => {
    const r = runBoot(
      box,
      goodArgs(box, {
        "--real-bin": path.join(box.root, "none.exe"),
        "--shim-cli": path.join(box.root, "none.mjs"),
      }),
    );
    assert.equal(r.status, 0, r.stderr);
    const result = parseResult(r);
    assert.equal(result.reason, "REAL_BIN_MISSING");
    assert.deepEqual(result.reasons, ["REAL_BIN_MISSING", "CLI_MISSING"]);
  }));

test("B5 원장 경로 쓰기 불가 -> 종료 0 + JSON ledger=write_failed + stderr 표지 · 판정은 그대로", () =>
  withBox((box) => {
    // 원장 경로가 «디렉터리» 라 덧붙이기가 실패한다.
    const dirAsLedger = path.join(box.root, "ledger-is-a-dir");
    mkdirSync(dirAsLedger);
    const r = runBoot(box, goodArgs(box, { "--ledger": dirAsLedger }));
    assert.equal(
      r.status,
      0,
      `원장 실패가 종료코드를 바꾸면 안 된다: ${r.stderr}`,
    );
    const result = parseResult(r);
    assert.equal(result.ledger, "write_failed");
    assert.ok(typeof result.ledger_error === "string" && result.ledger_error);
    assert.equal(result.shim, "enabled");
    assert.ok(
      r.stderr.includes("ORCH_SEAT_BOOT_LEDGER_WRITE_FAILED"),
      r.stderr,
    );
  }));

test("B6 원장 경로를 안 줌 -> disabled + LEDGER_UNSET + ledger=not_configured + 종료 0", () =>
  withBox((box) => {
    const r = runBoot(box, goodArgs(box, { "--ledger": null }));
    assert.equal(r.status, 0, r.stderr);
    const result = parseResult(r);
    assert.equal(result.shim, "disabled");
    assert.equal(result.reason, "LEDGER_UNSET");
    assert.equal(result.ledger, "not_configured");
  }));

test("B7 입력이 전부 없음 · 쓰레기 인자 -> 그래도 종료 0 + disabled JSON(기동을 막지 않는다)", () =>
  withBox((box) => {
    for (const args of [
      [],
      ["--real-bin"],
      ["--bogus", "x", "=", "--ledger="],
    ]) {
      const r = runBoot(box, args);
      assert.equal(r.status, 0, `${JSON.stringify(args)}: ${r.stderr}`);
      const result = parseResult(r);
      assert.equal(result.shim, "disabled");
      assert.ok(typeof result.reason === "string" && result.reason !== "");
    }
  }));

test("B8 조각 1 쓰기 줄과 부팅 줄이 «같은 파일» 에 섞여도 둘 다 읽힌다(쓰기 줄 칸 무변 · 부팅 줄은 event 로 갈림)", () =>
  withBox((box) => {
    const boot = runBoot(box, goodArgs(box));
    assert.equal(boot.status, 0, boot.stderr);
    // 같은 원장에 조각 1 shim CLI 가 쓰기 줄을 덧붙인다(진짜 orca 자리 = 가짜 대역).
    const write = spawnSync(
      process.execPath,
      [SHIM_CLI, "terminal", "send", "--terminal", "t1", "--text", "x"],
      {
        env: cleanEnv({
          HARNESS_ROLE: "ORCH",
          HARNESS_ORCA_REAL_BIN: process.execPath,
          HARNESS_ORCA_REAL_BIN_PREFIX: JSON.stringify([box.fakeOrca]),
          HARNESS_ORCA_SHIM_LEDGER: box.ledger,
          FAKE_ORCA_LOG: box.orcaLog,
        }),
        cwd: box.root,
        encoding: "utf8",
      },
    );
    assert.equal(write.status, 0, write.stderr);
    const lines = ledgerLines(box);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].schema, lines[1].schema);
    assert.equal(lines[0].event, "orch_seat_boot");
    assert.equal(lines[1].event, undefined);
    assert.equal(lines[1].verb, "send");
    assert.equal(lines[1].actor, "orch");
  }));

// ── 런처 템플릿(pwsh 로 실제 구동) ───────────────────────────────────
function launcherEnv(box, extra = {}) {
  return cleanEnv({
    HARNESS_ORCA_REAL_BIN: box.fakeRealBin,
    HARNESS_ORCA_SHIM_DIR: box.shimDir,
    HARNESS_ORCA_SHIM_CLI: box.fakeShimCli,
    HARNESS_ORCA_SHIM_LEDGER: box.ledger,
    HARNESS_ORCH_SEAT_COMMAND: process.execPath,
    HARNESS_ORCH_SEAT_NODE: process.execPath,
    HARNESS_ORCH_SEAT_BOOT_CLI: BOOT_CLI,
    FAKE_TRACE: box.trace,
    ...extra,
  });
}

function runLauncher(box, env, commandArgs) {
  return spawnSync(
    PWSH,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      LAUNCHER,
      ...commandArgs,
    ],
    { env, cwd: box.root, encoding: "utf8" },
  );
}

function readTrace(box) {
  assert.ok(
    existsSync(box.trace),
    "가짜 실행 명령이 «실제로 실행됐다» 는 흔적 파일이 있어야 한다",
  );
  return JSON.parse(readFileSync(box.trace, "utf8"));
}

function pathEntries(value) {
  return String(value ?? "")
    .split(path.delimiter)
    .filter((p) => p !== "");
}

function launcherTest(name, fn) {
  test(name, () => {
    if (!IS_WIN || PWSH === null) {
      const reason = !IS_WIN
        ? "비-Windows -> 런처 칸 구동 안 함(사유 분기)"
        : "pwsh 없음 -> 런처 칸 구동 안 함(사유 분기)";
      console.log(`# launcher-branch ${name.split(" ")[0]} ${reason}`);
      assert.ok(reason.length > 0);
      return;
    }
    withBox(fn);
  });
}

launcherTest(
  "L1 진짜 경로 있음 -> enabled: 가짜 명령의 PATH 맨 앞 = shim 디렉터리 · HARNESS_ROLE=ORCH · env 4종 · 인자 그대로 · 종료코드 그대로",
  (box) => {
    const r = runLauncher(box, launcherEnv(box, { FAKE_EXIT: "3" }), [
      box.fakeCommand,
      "alpha",
      "--model",
      "m-1",
      "--effort",
      "high",
    ]);
    assert.equal(r.status, 3, `가짜 명령 종료코드가 그대로: ${r.stderr}`);
    const trace = readTrace(box);
    assert.equal(pathEntries(trace.path)[0], box.shimDir);
    assert.equal(trace.role, "ORCH");
    assert.equal(trace.realBin, box.fakeRealBin);
    assert.equal(trace.ledger, box.ledger);
    assert.equal(trace.shimCli, box.fakeShimCli);
    assert.ok(typeof trace.mark === "string" && trace.mark !== "");
    assert.deepEqual(trace.argv, [
      "alpha",
      "--model",
      "m-1",
      "--effort",
      "high",
    ]);
    const [boot] = ledgerLines(box);
    assert.equal(boot.event, "orch_seat_boot");
    assert.equal(boot.shim, "enabled");
    assert.equal(boot.launcher_mark, trace.mark);
    assert.equal(boot.role, "ORCH");
  },
);

launcherTest(
  "L2 가짜 진짜 경로 «없음» -> disabled: 가짜 명령은 shim 없이 «그래도 기동» (PATH 에 shim 없음 · 표지 없음) + 부팅 줄 REAL_BIN_MISSING",
  (box) => {
    const r = runLauncher(
      box,
      launcherEnv(box, {
        HARNESS_ORCA_REAL_BIN: path.join(box.root, "wrong-real-orca.exe"),
      }),
      [box.fakeCommand, "beta"],
    );
    assert.equal(r.status, 0, r.stderr);
    const trace = readTrace(box);
    assert.ok(
      !pathEntries(trace.path).includes(box.shimDir),
      "disabled 이면 shim 디렉터리가 PATH 에 없어야 한다",
    );
    assert.equal(trace.mark, null);
    // 입력으로 받은 env 값은 런처가 건드리지 않는다(틀린 경로 그대로 · 표지만 없다).
    assert.equal(trace.realBin, path.join(box.root, "wrong-real-orca.exe"));
    assert.deepEqual(trace.argv, ["beta"]);
    assert.ok(r.stderr.includes("ORCH_SEAT_SHIM_DISABLED"), r.stderr);
    assert.ok(r.stderr.includes("REAL_BIN_MISSING"), r.stderr);
    const lines = ledgerLines(box);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "orch_seat_boot");
    assert.equal(lines[0].shim, "disabled");
    assert.equal(lines[0].reason, "REAL_BIN_MISSING");
  },
);

launcherTest(
  "L3 원장 경로 쓰기 불가 -> 부팅 판정 JSON 은 write_failed 지만 런처는 그래도 가짜 명령을 띄운다",
  (box) => {
    const dirAsLedger = path.join(box.root, "ledger-is-a-dir");
    mkdirSync(dirAsLedger);
    const r = runLauncher(
      box,
      launcherEnv(box, { HARNESS_ORCA_SHIM_LEDGER: dirAsLedger }),
      [box.fakeCommand],
    );
    assert.equal(r.status, 0, r.stderr);
    readTrace(box);
    assert.ok(
      r.stderr.includes("ORCH_SEAT_BOOT_LEDGER_WRITE_FAILED"),
      r.stderr,
    );
  },
);

launcherTest(
  "L4 부팅 판정 CLI 경로가 틀림 · node 실행 파일이 없음 -> disabled(BOOT_CLI_FAILED)로 접고 가짜 명령은 그래도 기동",
  (box) => {
    const wrongCli = runLauncher(
      box,
      launcherEnv(box, {
        HARNESS_ORCH_SEAT_BOOT_CLI: path.join(box.root, "no-such-boot.mjs"),
      }),
      [box.fakeCommand, "gamma"],
    );
    assert.equal(wrongCli.status, 0, wrongCli.stderr);
    const t1 = readTrace(box);
    assert.ok(!pathEntries(t1.path).includes(box.shimDir));
    assert.ok(wrongCli.stderr.includes("BOOT_CLI_FAILED"), wrongCli.stderr);
    rmSync(box.trace);
    const noNode = runLauncher(
      box,
      launcherEnv(box, {
        HARNESS_ORCH_SEAT_NODE: path.join(box.root, "no-such-node.exe"),
      }),
      [box.fakeCommand, "delta"],
    );
    assert.equal(noNode.status, 0, noNode.stderr);
    const t2 = readTrace(box);
    assert.ok(!pathEntries(t2.path).includes(box.shimDir));
    assert.deepEqual(t2.argv, ["delta"]);
    assert.ok(noNode.stderr.includes("BOOT_CLI_FAILED"), noNode.stderr);
  },
);

launcherTest(
  "L5 실행 명령 자체를 못 띄움 -> 비0(127) + 사유 줄(런처가 조용히 0 으로 끝나지 않는다)",
  (box) => {
    const r = runLauncher(
      box,
      launcherEnv(box, {
        HARNESS_ORCH_SEAT_COMMAND: path.join(box.root, "no-such-command.exe"),
      }),
      [],
    );
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes("ORCH_SEAT_COMMAND_FAILED"), r.stderr);
  },
);

launcherTest(
  "L6 환경 값은 «그 명령을 띄우는 동안만» -- 런처가 돌아온 뒤 호출 셸의 PATH · HARNESS_ROLE 은 원래대로",
  (box) => {
    const env = launcherEnv(box);
    // 기준선은 «같은 pwsh 안» 에서 런처 호출 직전에 읽는다(pwsh 자신이 시작할 때
    // PATH 앞에 자기 디렉터리를 붙이므로 부모 env 와 비교하면 어긋난다).
    const script = [
      "Write-Output ('BEFORE_PATH=' + $env:PATH)",
      `& '${LAUNCHER}' '${box.fakeCommand}' epsilon`,
      "Write-Output ('AFTER_ROLE=' + [string]$env:HARNESS_ROLE)",
      "Write-Output ('AFTER_MARK=' + [string]$env:HARNESS_ORCA_SHIM)",
      "Write-Output ('AFTER_REAL=' + [string]$env:HARNESS_ORCA_REAL_BIN)",
      "Write-Output ('AFTER_PATH=' + $env:PATH)",
    ].join("; ");
    const r = spawnSync(
      PWSH,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { env, cwd: box.root, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const trace = readTrace(box);
    assert.equal(pathEntries(trace.path)[0], box.shimDir);
    const lineOf = (key) =>
      r.stdout
        .split(/\r?\n/)
        .find((l) => l.startsWith(`${key}=`))
        ?.slice(key.length + 1);
    assert.equal(lineOf("AFTER_ROLE"), "");
    assert.equal(lineOf("AFTER_MARK"), "");
    // 런처가 설정하기 전의 값(입력으로 줬던 값)으로 되돌아온다.
    assert.equal(lineOf("AFTER_REAL"), box.fakeRealBin);
    assert.ok(lineOf("BEFORE_PATH"), "기준선 PATH 를 읽었어야 한다");
    assert.equal(lineOf("AFTER_PATH"), lineOf("BEFORE_PATH"));
  },
);
