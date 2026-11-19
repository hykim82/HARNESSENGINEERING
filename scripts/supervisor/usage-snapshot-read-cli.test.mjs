// HYK-406-wk-gate-1 (조각 B · 저장소 몫) -- 주간 사용량 읽기 CLI + memory-gate 패치 문서 시험.
//
// 두 층을 «실제로 구동»한다 (문자열 대조만은 헛시험이다):
//   ① CLI = 자식 node 프로세스. 입력은 전부 합성 mkdtemp HUD 디렉터리 + `--now` 주입.
//   ② 패치 문서 = docs/control-room-patches/HYK-406-memory-gate-wk.md 의 patch-unit 을
//      «합성 memory-gate 사본»(앵커 줄만 실물과 같게 흉내낸 ps1)에 control-room-patch-apply
//      로 적용한 뒤, 실제 PowerShell(pwsh) 자식 프로세스로 실행한다. 합성 사본의 «좌석 기동»
//      은 로그 한 줄이다 -- ⛔실제 관제실 파일 · 실제 HUD(~/.claude/hud) · 실제 좌석 0.
//
// ⛔OBSERVER · 앵커 아님: HUD 파일은 ORCH 도 쓸 수 있다(usage-threshold-core.mjs 머리).
// ⚠️정직 한계: 실제 memory-gate.ps1(측정 수 분 · Get-Counter · orca terminal create)은 이 시험이
// 열지 않는다 -- 관제실 적용은 별도 상신 + 책임자 판정 뒤다. 합성 사본이 실물과 같은 것은 «앵커 줄»
// 뿐이므로 앵커 적용은 패치 문서의 적용 절차(원본 SHA-256 대조 + 도구 적용)가 한 번 더 본다.
//
// 단언 규율: 출력 «전체» 문자열 동등 단언 금지 -- 자기 토막만 본다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findPowerShell } from "../check/seat-proof-wrapper-behavior.mjs";
import { runUsageSnapshotCli } from "./usage-snapshot-read-cli.mjs";
import {
  parsePatchDocument,
  applyControlRoomPatch,
} from "../check/control-room-patch-apply.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const CLI = here("./usage-snapshot-read-cli.mjs");
const CORE = here("./usage-threshold-core.mjs");
const WIRE = here("./usage-threshold-wire.mjs");
const PATCH_DOC = here(
  "../../docs/control-room-patches/HYK-406-memory-gate-wk.md",
);
const LIVE_GATE_SHA =
  "a7e19784e7864373ed421ae649917f863218ac8e6588d322614613ae9ea11a58";

const MIN = 60 * 1000;
const NOW_ISO = "2026-11-19T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// harness-hud.mjs 가 쓰는 모양(at · role · ctx · five_hour · seven_day).
function writeHud(hudDir, role, fields, now = NOW) {
  mkdirSync(hudDir, { recursive: true });
  const snap = {
    at: new Date(now - 1 * MIN).toISOString(),
    role: role === "NOROLE" ? null : role,
    model: "synthetic",
    ctx: 10,
    five_hour: 10,
    seven_day: 10,
    session_id: "s-synthetic",
    cwd: "C:/synthetic",
    ...fields,
  };
  writeFileSync(
    join(hudDir, `ratelimit-${role}.json`),
    `${JSON.stringify(snap)}\n`,
  );
}

function childEnv(extra = {}) {
  return {
    ...process.env,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    ...extra,
  };
}

// ---- ① CLI 층 ------------------------------------------------------------

function runCli({ args = [], env = {}, timeout = 30000 } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: childEnv(env),
    timeout,
  });
  const stdout = r.stdout ?? "";
  return { ...r, stdout, json: safeParse(stdout) };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function withHud(fn) {
  const root = tmp("hyk406b-hud-");
  const hudDir = join(root, "hud");
  mkdirSync(hudDir, { recursive: true });
  try {
    return fn({ root, hudDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const cliAt = (hudDir, extra = []) =>
  runCli({ args: ["--hud-dir", hudDir, "--now", NOW_ISO, ...extra] });

test("CLI ok: 가장 신선한 파일의 seven_day 를 한 줄 JSON 으로 · 종료 0 · 키 6개 그대로", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", { seven_day: 91 });
    const r = cliAt(hudDir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim().split("\n").length, 1, "stdout 은 한 줄");
    assert.deepEqual(Object.keys(r.json).sort(), [
      "ageMin",
      "at",
      "reason",
      "role",
      "seven_day",
      "status",
    ]);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.seven_day, 91);
    assert.equal(r.json.role, "ORCH");
    assert.equal(r.json.ageMin, 1);
    assert.equal(r.json.at, new Date(NOW - MIN).toISOString());
    assert.equal(r.json.reason, null);
  });
});

test("CLI: 여러 역할 파일이면 «값이 있는 가장 신선한 것»(지갑은 하나) -- 낡은 ORCH 80 보다 새 CODER 91", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", {
      seven_day: 80,
      at: new Date(NOW - 30 * MIN).toISOString(),
    });
    writeHud(hudDir, "CODER", {
      seven_day: 91,
      at: new Date(NOW - 2 * MIN).toISOString(),
    });
    const r = cliAt(hudDir);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.seven_day, 91);
    assert.equal(r.json.role, "CODER");
    assert.equal(r.json.ageMin, 2);
  });
});

test("CLI stale: 61분 전 값 -> status stale · 값(seven_day)은 알려주되 사유에 낡음 · 59분 전은 ok(경계)", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", {
      seven_day: 95,
      at: new Date(NOW - 61 * MIN).toISOString(),
    });
    const r = cliAt(hudDir);
    assert.equal(r.status, 0);
    assert.equal(r.json.status, "stale");
    assert.equal(r.json.seven_day, 95);
    assert.equal(r.json.ageMin, 61);
    assert.match(r.json.reason, /낡음/);
    writeHud(hudDir, "ORCH", {
      seven_day: 95,
      at: new Date(NOW - 59 * MIN).toISOString(),
    });
    assert.equal(cliAt(hudDir).json.status, "ok");
  });
});

test("CLI unavailable: seven_day null -> seven_day 도 null(0 으로 접지 않는다) · at/ageMin/role null · 사유 있음 · 종료 0", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", { seven_day: null });
    const r = cliAt(hudDir);
    assert.equal(r.status, 0);
    assert.equal(r.json.status, "unavailable");
    assert.equal(r.json.seven_day, null);
    assert.notEqual(r.json.seven_day, 0);
    assert.equal(r.json.at, null);
    assert.equal(r.json.ageMin, null);
    assert.equal(r.json.role, null);
    assert.equal(typeof r.json.reason, "string");
    assert.ok(r.json.reason.length > 0);
  });
});

test("CLI 범위 밖(seven_day 150): unavailable · 사유에 «범위 밖» (P2-1) · 값은 null", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", { seven_day: 150 });
    const r = cliAt(hudDir);
    assert.equal(r.json.status, "unavailable");
    assert.equal(r.json.seven_day, null);
    assert.match(r.json.reason, /범위 밖/);
  });
});

test('CLI: 값이 문자열("91") · 깨진 JSON · 빈 HUD · HUD 디렉터리 없음 -> 전부 unavailable + seven_day null + 종료 0(던지지 않는다)', () => {
  withHud(({ root, hudDir }) => {
    writeHud(hudDir, "ORCH", { seven_day: "91" });
    let r = cliAt(hudDir);
    assert.equal(
      r.json.status,
      "unavailable",
      "문자열 91 을 숫자로 바꿔 읽으면 안 된다",
    );
    assert.equal(r.json.seven_day, null);
    writeFileSync(join(hudDir, "ratelimit-ORCH.json"), '{"at":"2026-11-19T1');
    r = cliAt(hudDir);
    assert.equal(r.json.status, "unavailable");
    assert.equal(r.status, 0);
    rmSync(join(hudDir, "ratelimit-ORCH.json"));
    r = cliAt(hudDir);
    assert.equal(r.json.status, "unavailable");
    r = cliAt(join(root, "없는-디렉터리"));
    assert.equal(r.status, 0);
    assert.equal(r.json.status, "unavailable");
    assert.equal(r.json.seven_day, null);
  });
});

test("CLI: at 이 미래(10분 뒤)인 파일은 믿지 않는다 -> unavailable · 쓸 수 없는 인자(--now 쓰레기)도 던지지 않고 unavailable + 종료 0", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", {
      seven_day: 99,
      at: new Date(NOW + 10 * MIN).toISOString(),
    });
    let r = cliAt(hudDir);
    assert.equal(r.json.status, "unavailable");
    assert.equal(r.json.seven_day, null);
    r = runCli({ args: ["--hud-dir", hudDir, "--now", "쓰레기"] });
    assert.equal(r.status, 0);
    assert.equal(r.json.status, "unavailable");
    assert.match(r.json.reason, /--now/);
    r = runCli({ args: ["--모르는-인자"] });
    assert.equal(r.status, 0);
    assert.equal(r.json.status, "unavailable");
  });
});

test("CLI 읽기 전용: 실행 전후 HUD 디렉터리 파일 목록 · 바이트 동일 · 새 파일 0", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", { seven_day: 91 });
    writeHud(hudDir, "CODER", { seven_day: 40 });
    const snapshot = () =>
      readdirSync(hudDir)
        .sort()
        .map((n) => [n, readFileSync(join(hudDir, n), "utf8")]);
    const before = snapshot();
    const first = cliAt(hudDir);
    assert.equal(
      first.status,
      0,
      "CLI 가 실제로 돌았어야 «읽기만» 이 의미가 있다",
    );
    assert.equal(first.json.status, "ok");
    cliAt(hudDir, ["--now", "2026-11-20T12:00:00.000Z"]);
    assert.deepEqual(snapshot(), before);
  });
});

test("CLI 기본 HUD 자리: --hud-dir 생략 시 홈의 .claude/hud (합성 홈으로만 -- 실제 홈 0)", () => {
  const home = tmp("hyk406b-home-");
  try {
    writeHud(join(home, ".claude", "hud"), "ORCH", { seven_day: 77 });
    const r = runCli({
      args: ["--now", NOW_ISO],
      env: { HOME: home, USERPROFILE: home },
    });
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.seven_day, 77);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("진입점 runUsageSnapshotCli 는 now 를 주입하면 그 시각으로 판정한다 · 인자 오류는 던지지 않고 unavailable", () => {
  withHud(({ hudDir }) => {
    writeHud(hudDir, "ORCH", { seven_day: 92 });
    const ok = runUsageSnapshotCli(["--hud-dir", hudDir], { now: NOW });
    assert.equal(ok.status, "ok");
    assert.equal(ok.seven_day, 92);
    const later = runUsageSnapshotCli(["--hud-dir", hudDir], {
      now: NOW + 3 * 60 * MIN,
    });
    assert.equal(later.status, "stale");
    const bad = runUsageSnapshotCli(["--hud-dir"], { now: NOW });
    assert.equal(bad.status, "unavailable");
    assert.equal(bad.seven_day, null);
  });
});

// ---- ② 패치 문서 층 -------------------------------------------------------

const PS_EXE = findPowerShell();

// 실제 memory-gate.ps1 의 «앵커 줄»(param 끝 · Finish · 좌석 기동 직전 · DryRun 종료 · GATE=OPEN)만
// 같은 모양으로 흉내낸 합성 사본. 좌석 기동 = 로그 한 줄.
const SYNTHETIC_GATE = [
  "# synthetic copy of the memory-gate.ps1 anchors (HYK-406-wk-gate-1) -- NOT the control-room file",
  "param(",
  "  [Parameter(Mandatory=$true)][string]$Round,",
  "  [Parameter(Mandatory=$true)][string]$Worktree,",
  "  [Parameter(Mandatory=$true)][string]$Role,",
  "  [Parameter(Mandatory=$true)][string]$LogPath,",
  "  [int]$Threshold = 3000,",
  "  [string]$HistoryPath = 'unused',",
  "  [switch]$DryRun",
  ")",
  "$ErrorActionPreference = 'Stop'",
  "$OUT = $LogPath",
  "$WT = $Worktree",
  "$script:MODE = 'NORMAL'",
  "function Log([string]$m) { Add-Content -Path $OUT -Value $m; Write-Host $m }",
  'function Write-GateState([string]$verdict, [string]$status, $min) { Set-Content -Path "$OUT.state" -Value "$verdict $status min=$min" }',
  "function Finish([string]$verdictTail, [string]$status, $min) {",
  '  Log "VERDICT=$verdictTail"',
  "  Write-GateState (($verdictTail -split ' ')[0]) $status $min",
  "  exit 0",
  "}",
  "function Assert-NoRunner([string]$where) { }",
  "$min = 3500",
  "Assert-NoRunner 'pre-launch'",
  "",
  "if ($DryRun) { Finish \"DRYRUN_WOULD_OPEN mode=$($script:MODE) min=$min (no seat launched)\" 'dryrun-open' $min }",
  "",
  'Log "GATE=OPEN mode=$($script:MODE) -- launching $Role seat (synthetic: log line only)"',
  'Log "VERDICT=OPEN_SEAT_LAUNCHED mode=$($script:MODE)"',
  "Write-GateState 'OPEN_SEAT_LAUNCHED' 'open' $min",
  "",
].join("\n");

function appliedGate() {
  const doc = readFileSync(PATCH_DOC, "utf8");
  const out = applyControlRoomPatch(doc, SYNTHETIC_GATE);
  assert.equal(out.ok, true, `패치 적용 실패: ${out.reason ?? ""}`);
  return out.result;
}

// stubCli: 합성 워크트리의 scripts/supervisor/usage-snapshot-read-cli.mjs 를 이 본문으로 대신한다.
function makeGateEnv({ stubCli = null, cli = "real" } = {}) {
  const root = tmp("hyk406b-gate-");
  const wt = join(root, "wt");
  const sup = join(wt, "scripts", "supervisor");
  mkdirSync(sup, { recursive: true });
  if (stubCli !== null) {
    writeFileSync(join(sup, "usage-snapshot-read-cli.mjs"), stubCli);
  } else if (cli === "real") {
    copyFileSync(CLI, join(sup, "usage-snapshot-read-cli.mjs"));
    copyFileSync(CORE, join(sup, "usage-threshold-core.mjs"));
    copyFileSync(WIRE, join(sup, "usage-threshold-wire.mjs"));
  }
  const gate = join(root, "memory-gate.synthetic.ps1");
  writeFileSync(gate, appliedGate());
  return {
    root,
    wt,
    gate,
    hudDir: join(root, "hud"),
    log: join(root, "gate.log"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// HUD 의 at 은 «지금» 기준(게이트의 CLI 는 실제 시계를 쓴다).
function nowHud(g, role, fields, ageMin = 1) {
  writeHud(
    g.hudDir,
    role,
    { at: new Date(Date.now() - ageMin * MIN).toISOString(), ...fields },
    Date.now(),
  );
}

function runGate(g, extra = []) {
  assert.ok(
    PS_EXE,
    "PowerShell(pwsh) 이 없다 -- 이 칸은 조용히 건너뛰지 않는다(CI 는 pwsh 설치를 게이트로 막는다)",
  );
  const r = spawnSync(
    PS_EXE,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      g.gate,
      "-Round",
      "syn",
      "-Worktree",
      g.wt,
      "-Role",
      "CODER",
      "-LogPath",
      g.log,
      "-UsageHudDir",
      g.hudDir,
      ...extra,
    ],
    { encoding: "utf8", env: childEnv(), timeout: 120000 },
  );
  const log = existsSync(g.log) ? readFileSync(g.log, "utf8") : "";
  const stateFile = `${g.log}.state`;
  return {
    status: r.status,
    stderr: r.stderr ?? "",
    stdout: r.stdout ?? "",
    log,
    state: existsSync(stateFile) ? readFileSync(stateFile, "utf8").trim() : "",
  };
}

function withGate(opts, fn) {
  const g = makeGateEnv(opts);
  try {
    return fn(g);
  } finally {
    g.cleanup();
  }
}

test("패치 문서: patch-unit 2개 · 앵커는 내용(줄 번호 아님) · 합성 사본에 정확히 한 번씩 적용된다", () => {
  const doc = readFileSync(PATCH_DOC, "utf8");
  const parsed = parsePatchDocument(doc);
  assert.equal(parsed.ok, true);
  assert.deepEqual(
    parsed.units.map((u) => u.id),
    ["hyk406-gate-params", "hyk406-gate-wk-check"],
  );
  for (const u of parsed.units) {
    assert.equal(/^\d+$/.test(u.anchor.trim()), false, "줄 번호 앵커 금지");
    assert.ok(u.anchor.trim().length > 0);
  }
  const applied = appliedGate();
  assert.ok(applied.includes("[int]$WkFold = 90"));
  assert.ok(applied.includes("CLOSED_WK_FOLD"));
  assert.ok(
    doc.includes(LIVE_GATE_SHA),
    "문서는 앵커를 자른 라이브 파일 SHA-256 을 적어야 한다",
  );
});

test("wk 91 (기본 접기선 90) -> CLOSED_WK_FOLD · 좌석 기동 줄 0 · 상태 closed · 종료 0", () => {
  withGate({}, (g) => {
    nowHud(g, "ORCH", { seven_day: 91 });
    const r = runGate(g);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.log, /VERDICT=CLOSED_WK_FOLD wk=91 >= WkFold=90/);
    assert.equal(r.log.includes("GATE=OPEN"), false, "닫혔는데 좌석을 열었다");
    assert.equal(r.log.includes("OPEN_SEAT_LAUNCHED"), false);
    assert.match(r.state, /^CLOSED_WK_FOLD closed min=3500$/);
  });
});

test("wk 90 정확히 경계 -> 닫힘(≥) · wk 89 -> 열림(좌석 기동 줄 있음) + 통과 줄", () => {
  withGate({}, (g) => {
    nowHud(g, "ORCH", { seven_day: 90 });
    const closed = runGate(g);
    assert.match(closed.log, /VERDICT=CLOSED_WK_FOLD wk=90 >= WkFold=90/);
    rmSync(g.log, { force: true });
    nowHud(g, "ORCH", { seven_day: 89 });
    const open = runGate(g);
    assert.equal(open.status, 0, open.stderr);
    assert.equal(open.log.includes("CLOSED_WK_FOLD"), false);
    assert.ok(open.log.includes("GATE=OPEN"));
    assert.match(open.log, /VERDICT=OPEN_SEAT_LAUNCHED/);
    assert.match(open.log, /WK-GATE pass wk=89 < WkFold=90/);
    assert.match(open.state, /^OPEN_SEAT_LAUNCHED open /);
  });
});

test("wk 값 null(관측 불가) -> 열린다(fail-open) + 사유 줄(WK-GATE UNOBSERVED · status=unavailable) · 0% 로 접어 «통과» 라고 쓰지 않는다", () => {
  withGate({}, (g) => {
    nowHud(g, "ORCH", { seven_day: null });
    const r = runGate(g);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.log.includes("CLOSED_WK_FOLD"), false);
    assert.ok(r.log.includes("GATE=OPEN"), "관측 불가면 열려야 한다");
    assert.match(
      r.log,
      /WK-GATE UNOBSERVED \(fail-open\) status=unavailable reason=\S/,
    );
    assert.ok(
      r.log.includes("seven_day 값이 있는 것이 없다"),
      "CLI 가 UTF-8 로 쓴 한글 사유가 게이트 로그에서 깨지면 안 된다(Windows 기본 코드페이지로 읽는 결함 방지)",
    );
    assert.equal(
      r.log.includes("WK-GATE pass"),
      false,
      "관측 불가를 «통과» 줄로 적으면 안 된다",
    );
  });
});

test("wk 낡음(90분 전 99) -> 열린다 + 사유 줄(status=stale) · 낡은 99 로 닫지 않는다", () => {
  withGate({}, (g) => {
    nowHud(g, "ORCH", { seven_day: 99 }, 90);
    const r = runGate(g);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.log.includes("CLOSED_WK_FOLD"), false);
    assert.ok(r.log.includes("GATE=OPEN"));
    assert.match(
      r.log,
      /WK-GATE UNOBSERVED \(fail-open\) status=stale reason=\S/,
    );
    assert.ok(
      r.log.includes("값이 낡음 -- 마지막 갱신 90분 전"),
      "낡음 사유(한글)가 깨지지 않고 로그에 남아야 한다",
    );
  });
});

test("접기선 덮기: -WkFold 100 이면 wk 91 -> 열림 · wk 100 -> 닫힘(덮은 값이 경계) · -WkFold 85 면 wk 89 -> 닫힘", () => {
  withGate({}, (g) => {
    nowHud(g, "ORCH", { seven_day: 91 });
    const open = runGate(g, ["-WkFold", "100"]);
    assert.equal(open.log.includes("CLOSED_WK_FOLD"), false);
    assert.ok(open.log.includes("GATE=OPEN"));
    assert.match(open.log, /WK-GATE pass wk=91 < WkFold=100/);
    rmSync(g.log, { force: true });
    nowHud(g, "ORCH", { seven_day: 100 });
    const closed = runGate(g, ["-WkFold", "100"]);
    assert.match(closed.log, /VERDICT=CLOSED_WK_FOLD wk=100 >= WkFold=100/);
    rmSync(g.log, { force: true });
    nowHud(g, "ORCH", { seven_day: 89 });
    const lower = runGate(g, ["-WkFold", "85"]);
    assert.match(lower.log, /VERDICT=CLOSED_WK_FOLD wk=89 >= WkFold=85/);
  });
});

test("-DryRun 도 wk 91 이면 닫힌다(DRYRUN_WOULD_OPEN 아님) · wk 89 면 DRYRUN_WOULD_OPEN", () => {
  withGate({}, (g) => {
    nowHud(g, "ORCH", { seven_day: 91 });
    const closed = runGate(g, ["-DryRun"]);
    assert.match(closed.log, /VERDICT=CLOSED_WK_FOLD/);
    assert.equal(closed.log.includes("DRYRUN_WOULD_OPEN"), false);
    rmSync(g.log, { force: true });
    nowHud(g, "ORCH", { seven_day: 89 });
    const open = runGate(g, ["-DryRun"]);
    assert.match(open.log, /VERDICT=DRYRUN_WOULD_OPEN/);
  });
});

test("CLI 가 워크트리에 없다 · -UsageCli 가 없는 경로 -> 열린다 + 사유 줄(fail-open)", () => {
  withGate({ cli: "missing" }, (g) => {
    nowHud(g, "ORCH", { seven_day: 99 });
    const r = runGate(g);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.log.includes("CLOSED_WK_FOLD"), false);
    assert.ok(r.log.includes("GATE=OPEN"));
    assert.match(r.log, /WK-GATE UNOBSERVED \(fail-open\) .*not found/);
    rmSync(g.log, { force: true });
    const r2 = runGate(g, ["-UsageCli", join(g.root, "nowhere.mjs")]);
    assert.ok(r2.log.includes("GATE=OPEN"));
    assert.match(r2.log, /WK-GATE UNOBSERVED \(fail-open\) .*not found/);
  });
});

test("-UsageCli 로 CLI 자리를 덮을 수 있다(워크트리 밖 CLI) -> 그 CLI 의 값으로 닫는다", () => {
  withGate({ cli: "missing" }, (g) => {
    mkdirSync(join(g.root, "elsewhere"), { recursive: true });
    for (const f of [CLI, CORE, WIRE]) {
      copyFileSync(f, join(g.root, "elsewhere", f.split(/[\\/]/).at(-1)));
    }
    nowHud(g, "ORCH", { seven_day: 93 });
    const r = runGate(g, [
      "-UsageCli",
      join(g.root, "elsewhere", "usage-snapshot-read-cli.mjs"),
    ]);
    assert.match(r.log, /VERDICT=CLOSED_WK_FOLD wk=93 >= WkFold=90/);
  });
});

test("CLI 가 망가진 출력 · 비정상 종료 · 숫자가 아닌 seven_day · 모르는 status -> 전부 열린다(fail-open) + 사유 줄", () => {
  const stubs = {
    "JSON 아님": 'console.log("this is not json");',
    "종료코드 7":
      'console.log(JSON.stringify({status:"ok",seven_day:99})); process.exit(7);',
    "빈 출력": "",
    "문자열 seven_day":
      'console.log(JSON.stringify({status:"ok",seven_day:"99",role:"ORCH",ageMin:1}));',
    "모르는 status":
      'console.log(JSON.stringify({status:"weird",seven_day:99,role:"ORCH",ageMin:1}));',
    "ok 인데 seven_day null":
      'console.log(JSON.stringify({status:"ok",seven_day:null,role:"ORCH",ageMin:1}));',
  };
  for (const [name, body] of Object.entries(stubs)) {
    withGate({ stubCli: body }, (g) => {
      const r = runGate(g);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.log.includes("CLOSED_WK_FOLD"), false, name);
      assert.ok(r.log.includes("GATE=OPEN"), name);
      assert.match(r.log, /WK-GATE UNOBSERVED \(fail-open\) /, name);
    });
  }
});

test("CLI 가 멈추면(무한 대기) -UsageCliTimeoutSec 뒤에 끊고 열린다(fail-open) -- 게이트가 같이 멈추지 않는다", () => {
  withGate({ stubCli: "setInterval(() => {}, 1000);" }, (g) => {
    const t0 = Date.now();
    const r = runGate(g, ["-UsageCliTimeoutSec", "2"]);
    const took = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.log.includes("GATE=OPEN"));
    assert.match(r.log, /WK-GATE UNOBSERVED \(fail-open\) .*timed out/);
    assert.ok(took < 60000, `끊김이 늦다: ${took}ms`);
  });
});
