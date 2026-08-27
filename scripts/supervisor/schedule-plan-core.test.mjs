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
import { join, posix as posixPath, win32 as win32Path } from "node:path";
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
    conhostPath: "C:\\Windows\\System32\\conhost.exe",
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
// ★재작업 2R(coder-task.md §11) -- 리눅스 CI가 실제로 이 차이를 드러냄:
// `path.isAbsolute`/`path.join`(호스트 OS에 따라 posix/win32가 바뀌는
// "네이티브" 구현)을 쓰면 이 코어가 리눅스에서 실행될 때 Windows 경로를
// 거부한다. 정적 검사(네이티브 호출 0)와 동적 검사(win32 고정 동작이
// posix와 실제로 다름을 이 머신에서 직접 증명) 둘 다로 재발을 막는다.
// ---------------------------------------------------------------------------
test("static: schedule-plan-core.mjs calls only path.win32.* for path ops -- zero native path.isAbsolute(/path.join( calls (regression guard for the linux-CI failure)", () => {
  const codeOnly = SRC_TEXT.split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const bareIsAbsolute = [...codeOnly.matchAll(/[^.]path\.isAbsolute\(/g)];
  const bareJoin = [...codeOnly.matchAll(/[^.]path\.join\(/g)];
  assert.deepEqual(
    bareIsAbsolute,
    [],
    "must call winPath.isAbsolute (path.win32), not the host-dependent native path.isAbsolute",
  );
  assert.deepEqual(
    bareJoin,
    [],
    "must call winPath.join (path.win32), not the host-dependent native path.join",
  );
});

test("platform independence proof: path.posix would reject a Windows repoRoot that path.win32 (this module's choice) accepts -- this is exactly the bug the linux CI run hit (1/1)", () => {
  const winStylePath = "C:\\Users\\hykim\\repo";
  assert.equal(
    posixPath.isAbsolute(winStylePath),
    false,
    "path.posix treats this as relative -- the native `path` module resolves to path.posix on linux, which is why the CI run's validatePaths rejected every Windows-style fixture",
  );
  assert.equal(
    win32Path.isAbsolute(winStylePath),
    true,
    "path.win32 always applies Windows rules regardless of host OS -- this is what schedule-plan-core.mjs now uses exclusively",
  );
  const result = buildSchedulePlan(
    validArgs({ repoRoot: winStylePath, watchDir: "D:\\watch" }),
  );
  assert.equal(
    result.ok,
    true,
    "buildSchedulePlan must accept this Windows path on any host (this assertion runs identically on Windows and Linux since path.win32 is host-independent)",
  );
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
// HYK-369 -- `/TR` 실행 대상이 콘솔 서브시스템 실행파일(node.exe)을 창
// 없이 호스팅하는 `conhost.exe --headless --` 로 감싸져 있는지. 이 계약이
// 사라지면(=node.exe를 다시 직접 `/TR`로 실행하면) 등록된 이 태스크가
// 돌 때마다 사람 화면에 새 터미널 창이 뜬다(coder.md §1-6 실측 -- ORCH가
// 확인한 실 등록 Execute 경로와 한용이 본 창 제목이 글자 그대로 일치).
// ---------------------------------------------------------------------------
test("HYK-369: commandLine이 node.exe를 conhost.exe --headless --로 감싸 실행한다 -- 창 없이 뜨는 계약(1/1)", () => {
  const { plan } = buildSchedulePlan(validArgs());
  assert.match(
    plan.commandLine,
    /^"C:\\Windows\\System32\\conhost\.exe" --headless -- /,
    "commandLine must start by wrapping the real command through headless conhost -- if this regresses to a bare node.exe invocation, HYK-369's console-window flash comes back",
  );
  // 원래 node.exe 호출 자체는 그대로 이어붙어 있어야 한다(경로/인자 손실
  // 없이 감싸기만 했는지 -- 창을 없애려다 실행 대상 자체를 바꾸면 안 된다).
  assert.match(plan.commandLine, /"C:\\Program Files\\nodejs\\node\.exe"/);
  assert.match(plan.commandLine, /watch-run\.mjs/);
  assert.match(plan.commandLine, /--repo-root/);
  assert.match(plan.commandLine, /--watch-dir/);
  // `/IT`는 그대로 살아 있어야 한다(대화형 세션 -- orca 터미널 관측 능력의
  // 전제, ORCH 비타협 ⓐ). 이 창-숨김은 실행 대상의 콘솔 호스팅 방식만
  // 바꿀 뿐, 등록 계정/세션 방식(§1의 registerArgs)은 건드리지 않는다.
  assert.ok(plan.registerArgs.includes("/IT"));
});

// ---------------------------------------------------------------------------
// HYK-369 2R P1-1(검토 반려) -- 재등록 계획이 라이브 작업의 각성/sweep
// watch-run.mjs 인자(`--wake --admission-sweep-ledger … --wake-live`류)를
// 보존하는지. 이 계약이 사라지면(=extraRunnerArgs가 다시 무시되면)
// 코드 경로로 재등록할 때마다 감시자의 각성 기능이 조용히 꺼진다.
// ---------------------------------------------------------------------------
test("HYK-369 P1-1: extraRunnerArgs가 commandLine 끝에 등장 순서 그대로 이어붙는다 -- 재등록해도 각성 인자가 안 사라지는 계약(1/1)", () => {
  const liveWakeArgs = [
    "--wake",
    "--admission-sweep-ledger",
    "D:\\문서관리\\하네스-관제실\\admission-ledger.json",
    "--wake-live",
  ];
  const { plan } = buildSchedulePlan(
    validArgs({ extraRunnerArgs: liveWakeArgs }),
  );
  const expectedSuffix =
    ` "--wake" "--admission-sweep-ledger" ` +
    `"D:\\문서관리\\하네스-관제실\\admission-ledger.json" "--wake-live"`;
  assert.ok(
    plan.commandLine.endsWith(expectedSuffix),
    `commandLine must end with the live wake/sweep args in order, got: ${plan.commandLine}`,
  );
  // 순서를 뒤섞지 않는다는 것까지 명시 -- watch-run.mjs 자신의 인자
  // 파서는 위치가 아니라 이름으로 읽지만(§ argv 루프), 등록 명령줄
  // 자체가 사람이 검토·비교하는 대상이라 순서 보존이 필요하다.
  const wakeIdx = plan.commandLine.indexOf('"--wake"');
  const ledgerIdx = plan.commandLine.indexOf('"--admission-sweep-ledger"');
  const liveIdx = plan.commandLine.indexOf('"--wake-live"');
  assert.ok(wakeIdx < ledgerIdx && ledgerIdx < liveIdx);
});

test("HYK-369 P1-1: extraRunnerArgs 생략 시 기본값 []이고 commandLine이 1R과 바이트 동일하다 -- 회귀 0(1/1)", () => {
  const { plan } = buildSchedulePlan(validArgs());
  assert.equal(
    plan.commandLine,
    '"C:\\Windows\\System32\\conhost.exe" --headless -- ' +
      '"C:\\Program Files\\nodejs\\node.exe" ' +
      `"${win32Path.join(ROOT, "scripts", "supervisor", "watch-run.mjs")}" ` +
      '--repo-root "' +
      ROOT +
      '" --watch-dir "D:\\문서관리\\하네스-관제실\\watch"',
  );
});

// ---------------------------------------------------------------------------
// HYK-369 2R P2-1(검토 반려) -- conhost.exe 경로가 더 이상 리터럴로
// 하드코딩돼 있지 않고, 이 함수의 다른 경로 인자(repoRoot/nodePath/
// watchDir)와 똑같이 검증되는 매개변수인지.
// ---------------------------------------------------------------------------
test("HYK-369 P2-1: conhostPath는 매개변수다 -- 넘긴 값이 commandLine에 그대로 쓰이고, 없으면/상대경로면 거부된다(3/3)", () => {
  const custom = buildSchedulePlan(
    validArgs({ conhostPath: "D:\\다른설치\\conhost.exe" }),
  );
  assert.equal(custom.ok, true);
  assert.match(
    custom.plan.commandLine,
    /^"D:\\다른설치\\conhost\.exe" --headless -- /,
    "conhostPath must NOT be hardcoded -- a different valid path must be honored verbatim",
  );

  const missing = buildSchedulePlan(validArgs({ conhostPath: undefined }));
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, SCHEDULE_PLAN_REASON.CONHOST_PATH_INVALID);

  const relative = buildSchedulePlan(validArgs({ conhostPath: "conhost.exe" }));
  assert.equal(relative.ok, false);
  assert.equal(relative.reasonCode, SCHEDULE_PLAN_REASON.CONHOST_PATH_INVALID);
});

// ---------------------------------------------------------------------------
// HYK-369 2R P1-3(검토 반려) -- 실행형 시험. 위의 문자열 계약 시험들은
// `commandLine`이 어떤 "모양"인지만 본다 -- 검토자가 지적한 대로, 그
// 모양이 실제로 자식을 돌리고 파일을 쓰는지는 안 본다. 이 시험은 실제
// `conhost.exe --headless -- <buildCommandLine이 만드는 그 모양>`을
// 돌려 `watch.log`/`last-run.json`이 실제로 생기는지 확인한다.
//
// ★왜 `execFileSync`로 conhost.exe를 직접 부르지 않는가(coder.md 2R §2
// 참조): Node의 child_process는 Windows에서 자식에게 항상 콘솔 핸들을
// 상속시킨다(stdio/windowsHide/detached/shell 옵션과 무관) -- 그 상속된
// 핸들이 `conhost --headless`와 충돌해 "exit 0, 파일 0개"로 조용히
// 실패한다(이게 검토자가 본 것과 똑같은 현상이다, 원인은 이 코드가
// 아니라 그 호출 방식). 예약 작업(schtasks)은 셸이 없어 상속할 콘솔
// 핸들 자체가 없으므로 이 실패 모드와 만나지 않는다(§1-6 WINEXE
// 재현으로 확인). 이 시험은 그 차이를 정면으로 피해 간다 -- Node가
// PowerShell을 부르는 건 그대로 두되(그 계층은 상관없다), **PowerShell
// 자신이 conhost.exe를 부를 때 표준 스트림을 리다이렉션하지 않는
// `Start-Process`를 쓴다** -- 이게 신뢰 가능한 CreateProcess 그대로다.
test(
  "HYK-369 P1-3: buildSchedulePlan이 실제로 만드는 plan.commandLine 문자열 그대로 돌리면 watch.log/last-run.json이 생긴다(1/1)",
  {
    skip:
      process.platform !== "win32" &&
      "Windows 전용(schtasks/conhost) -- 다른 플랫폼에서는 실행 자체가 성립하지 않는다",
  },
  () => {
    const watchDir = fs.mkdtempSync(join(tmpdir(), "hyk369-exec-repro-"));
    // ★손으로 인자 배열을 다시 조립하지 않는다 -- 조립 자체가 틀리면
    // 손조립 배열은 여전히 "옳은 모양"으로 남아 이 시험이 그 회귀를 못
    // 잡는다(1차 초안의 결함, 변이로 직접 확인: `--repo-root`/
    // `--watch-dir` 값을 서로 바꿔치기하는 변이를 넣었더니 손조립판은
    // 여전히 초록이었지만, 실제로 그 변이는 watch.log를 워크트리
    // 루트에 실물로 써 버리는 심각한 결함이었다 -- coder.md 2R §3
    // 원문 참조). 그래서 `buildSchedulePlan`이
    // **실제로 반환한 `plan.commandLine` 문자열**을 이 시험이 직접
    // 토큰화해(따옴표로 묶인 조각을 하나의 토큰으로) `Start-Process`의
    // FilePath/ArgumentList로 넘긴다 -- `cmd.exe /c "<전체 문자열>"`을
    // 거치면 cmd 자신의 따옴표 해체 규칙(첫 토큰이 따옴표로 시작하는
    // 문자열을 다루는 유명한 함정)이 끼어들어 이 코드와 무관한 이유로
    // 깨진다는 것을 직접 확인했다(1차 시도 -- REVERT, coder.md 2R §3
    // 원문 참조). CreateProcess 자체(schtasks가 실제로 하는 일)는 셸을
    // 거치지 않으므로, 셸 파싱 함정 없이 토큰 배열을 직접 넘기는 이
    // 방식이 실제 조건에 더 가깝다.
    const { ok, plan } = buildSchedulePlan(
      validArgs({
        watchDir,
        nodePath: process.execPath, // 이 기계에 실재하는 node.exe -- validArgs 기본값은 시험용 리터럴이라 실행 불가.
        extraRunnerArgs: ["--no-reach"], // 실 관제실 받는함 미접촉 -- §0 원장 무접촉과 같은 정신.
      }),
    );
    assert.equal(ok, true, "buildSchedulePlan must accept these valid args");

    // 따옴표로 묶인 조각은 하나의 토큰, 나머지는 공백 기준 토큰 --
    // buildCommandLine이 만드는 문자열(각 인자를 "..."로 감싸고 "--"만
    // 안 감싼다)에 정확히 맞는 최소 토크나이저다.
    const tokens = plan.commandLine.match(/"[^"]*"|\S+/g);
    assert.ok(
      tokens && tokens.length >= 2,
      `commandLine must tokenize into at least [conhostPath, ...], got: ${plan.commandLine}`,
    );
    const [firstToken, ...restTokens] = tokens;
    const conhostExe = firstToken.replace(/^"|"$/g, "");
    const restArgs = restTokens.map((t) => t.replace(/^"|"$/g, ""));

    const psArgList = restArgs
      .map((a) => `'${a.replace(/'/g, "''")}'`)
      .join(",");
    const psCommand =
      `$p = Start-Process -FilePath '${conhostExe.replace(/'/g, "''")}' ` +
      `-ArgumentList @(${psArgList}) -PassThru -Wait -WindowStyle Hidden; ` +
      `exit $p.ExitCode`;
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psCommand],
      { stdio: "ignore", windowsHide: true, timeout: 30_000 },
    );

    const watchLogPath = join(watchDir, "watch.log");
    const lastRunPath = join(watchDir, "last-run.json");
    assert.ok(
      fs.existsSync(watchLogPath) && fs.statSync(watchLogPath).size > 0,
      "watch.log must exist and be non-empty after running plan.commandLine verbatim -- if empty/missing, the headless wrap silently prevented the real runner from executing (검토 P1-2)",
    );
    assert.ok(
      fs.existsSync(lastRunPath) && fs.statSync(lastRunPath).size > 0,
      "last-run.json must exist and be non-empty for the same reason",
    );
    fs.rmSync(watchDir, { recursive: true, force: true });
  },
);

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
        "  const expires = validateExpiresAt(expiresAt, now);\n  if (expires.code) return { code: expires.code };\n",
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
