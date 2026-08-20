// HYK-270-stall-visible-2/-3 (coder-task.md §4) -- dispatch-start-confirm-cli.mjs
// 결선 시험. 실제 대기 0(sleepFn을 즉시 반환하는 가짜로 주입) -- 실
// ~/.claude·실 관제실 무접촉.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runDispatchStartConfirm,
  DISPATCH_START_CONFIRM_STATUS,
  DISPATCH_START_CONFIRM_EXIT_CODE,
} from "./dispatch-start-confirm-cli.mjs";

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeClock(startMs, stepMs) {
  let t = startMs;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}
const instantSleep = async () => {};
const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(THIS_DIR, "dispatch-start-confirm-cli.mjs");

test("★사례2(계속 진행): 매 폴링마다 늘어나면, 전체 관측 창 끝까지 폴링한 뒤 STARTED로 확정한다(2R처럼 두 번째 관측에서 조기 종료하지 않는다)", async () => {
  let call = 0;
  const collectFn = () => {
    call++;
    return { ok: true, totalBytes: call * 1000 }; // 매번 늘어난다.
  };
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    stallThresholdMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.STARTED);
  // 60000ms 창을 15000ms 간격으로 다 채워야 확정되므로 4회 이상 폴링했다
  // (조기 종료 0 -- 2R 회귀 가드).
  assert.ok(
    result.observations.length >= 4,
    `observations.length=${result.observations.length}`,
  );
});

test("★사례1(아예 시작 못 함): 타임아웃까지 계속 0 -> NOT_STARTED", async () => {
  const collectFn = () => ({ ok: true, totalBytes: 0 });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    stallThresholdMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.NOT_STARTED);
});

// ★★HYK-270-stall-visible-3 핵심 -- 2R REVIEW 반려가 직접 지목한 관측열을
// CLI 폴링 루프 레벨에서 그대로 재현한다: totalBytes = 0 -> 5000 -> 5000 -> …
// (배달 후 시작했다가 승인창 등으로 멈춘 사례 2). ★2R은 이 시나리오를
// `STARTED`로 즉시 종료했다(검토자 실측 원문 그대로) -- 이 시험이 그
// 결함의 회귀 가드다.
test("★★2R 반례: 한 번만 늘고(0->5000) 그 뒤 계속 그대로면(승인창 정지 동형) STALLED_AFTER_START -- 2R처럼 STARTED로 새지 않는다", async () => {
  let call = 0;
  const sizes = [0, 5000]; // 2번째 이후로는 계속 5000(무증가)만 반환.
  const collectFn = () => ({
    ok: true,
    totalBytes: sizes[Math.min(call++, sizes.length - 1)],
  });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 300000,
    stallThresholdMs: 60000, // ORCH 참고 실측(3분)을 시험 편의상 1분으로 축소.
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(
    result.status,
    DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START,
  );
  assert.equal(result.details.lastGrowthAtMs, 15000);
});

test("관측 수집 자체가 실패하면 즉시 COLLECTION_FAILED로 멈춘다(조용히 STARTED로 접지 않는다)", async () => {
  const collectFn = () => ({
    ok: false,
    reasonCode: "BOOM",
    detail: "disk error",
  });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.COLLECTION_FAILED);
});

test("«아예 시작 못 함»과 «시작 후 멈춤»은 종료코드가 다르다(사람 조치가 다르므로)", () => {
  assert.notEqual(
    DISPATCH_START_CONFIRM_EXIT_CODE[DISPATCH_START_CONFIRM_STATUS.NOT_STARTED],
    DISPATCH_START_CONFIRM_EXIT_CODE[
      DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START
    ],
  );
  assert.equal(
    DISPATCH_START_CONFIRM_EXIT_CODE[DISPATCH_START_CONFIRM_STATUS.STARTED],
    0,
  );
  assert.notEqual(
    DISPATCH_START_CONFIRM_EXIT_CODE[DISPATCH_START_CONFIRM_STATUS.NOT_STARTED],
    0,
  );
  assert.notEqual(
    DISPATCH_START_CONFIRM_EXIT_CODE[
      DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START
    ],
    0,
  );
});

test("CLI end-to-end(spawn): NOT_STARTED면 종료코드 1 + notifyDir에 «재배달» 문구 통지 파일이 실제로 생긴다", async () => {
  await withTempDir("dsc-notify-notstarted-", async (notifyDir) => {
    const { execFileSync } = await import("node:child_process");
    let threw = null;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [
          CLI_PATH,
          "--repo-root",
          "C:\\definitely-not-a-real-worktree-zzz",
          "--dispatched-at-ms",
          String(Date.now() - 10 * 60 * 1000),
          "--notify-dir",
          notifyDir,
          "--task-id",
          "HYK-TEST-e2e",
          "--timeout-ms",
          "1",
          "--stall-threshold-ms",
          "1",
          "--poll-interval-ms",
          "1",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      threw = err;
      stderr = err.stderr || "";
    }
    assert.ok(threw, "NOT_STARTED는 비0 종료코드여야 한다");
    assert.equal(threw.status, 1);
    assert.match(stderr, /NOT_STARTED/);
    assert.match(stderr, /재배달/);
    const files = readdirSync(notifyDir);
    assert.equal(files.length, 1);
    const text = readFileSync(join(notifyDir, files[0]), "utf8");
    assert.match(text, /아예 시작 못 함/);
    assert.match(text, /재배달/);
    assert.match(text, /HYK-TEST-e2e/);
  });
});

// ★4R 수리(coder-task.md §2, REVIEW 3R 반려 그대로): 이전 버전은 "150ms
// 뒤 딱 한 번" 파일을 키우는 `setTimeout` 하나에 기대고 있었다. 부하가
// 큰 전체 스윕에서는 자식 프로세스의 «첫 관측» 자체가 150ms보다 늦게
// 일어날 수 있고, 그러면 그 한 번의 쓰기가 첫 관측 «전에» 이미 반영돼
// 버려 growth가 전혀 감지되지 않는다(검토자가 동일 조건을 직접 주입해
// `NOT_STARTED`로 재현했다). ⛔"대기 시간을 늘리는 것"은 해법이 아니다
// (부하가 더 크면 또 깨진다).
//
// ★수리 방법(동기화 -- 시간 예약이 아니라 "계속 자라는 상태") -- 한 번의
// 정밀한 타이밍에 기대는 대신, 자식이 살아 있는 동안 **짧은 간격으로
// 계속 키우다가 멈춘다.** 이러면 자식이 자신의 «첫 관측»을 정확히
// 언제 하든(부하로 늦어지든 빠르든) 그 순간의 크기가 무엇이든, **그
// 뒤에 최소 한 번은 더 큰 값을 보게 된다**(계속 자라는 동안 관측하는
// 한, 자식이 최소 2회 폴링만 하면 성립 -- 특정 시각 정렬에 기대지
// 않는다). 성장 창(`GROWTH_WINDOW_MS`)이 끝나면 더는 안 건드려
// "승인창 등으로 멈춤"과 동형이 되고, 그 뒤 `stallThresholdMs`가
// 지나면 결정적으로 STALLED_AFTER_START가 된다.
// ★HYK-329 2차 원인(결과 파일 §1 실측 -- tick-누적 수리 뒤에도 남아 있던
// 별개의 실패 경로): 성장 창을 "실측 경과"로 닫아도(위 growContinuously
// 수리), 자식 프로세스 자체의 spawn·node 기동이 이 창보다 «더» 지연되면
// (전체 스윕 부하 아래 관측: round 1에서 exit code 1=NOT_STARTED로 재현),
// 자식의 «첫 실관측»이 이미 성장이 다 끝난 뒤에야 일어나 이번 실행 안에서
// 성장을 한 번도 못 본다 -- 이건 CLI 자신이 4R부터 "알려진 한계"로 고정해
// 둔 바로 그 자리(첫 관측 전에 이미 커져 있으면 구조적으로 NOT_STARTED,
// coder-task.md 범위 밖 -- 다음 조각 몫)이지, 오늘 고칠 CLI 버그가
// 아니다. 이 시험이 그 알려진 한계를 «부하 때문에 우연히» 건드리지
// 않으려면, 성장 창이 실전 부하에서 관측된 spawn 지연보다 충분히 커야
// 한다 -- 900ms 창은 그 여유가 부족했다(실측 재현: 4819개 시험 전체
// 부하에서 5회 반복 중 1회, round 1이 NOT_STARTED로 재현). 4000ms로
// 늘려 여유를 키운다(수학적 보장은 아니다 -- §2-3 정정 문구와 동일한
// 정직 한계, 극단적 부하면 여전히 이론상 깨질 수 있다 -- 다만 실측
// 표본으로 그 여유가 실전에서 충분함을 보인다, 아래 반복 실행 실측).
const GROWTH_WINDOW_MS = 4000; // 부하 아래 자식 spawn 지연에 대한 실측 기반 여유(위 주석).
const GROWTH_TICK_MS = 20;

// ★HYK-329 수리 -- 원인 기전(결과 파일 §1에 실측 기록): 이전 버전은
// `elapsed += tickMs`로 "틱이 몇 번 불렸는가"만 셌다. setInterval의 콜백
// 간격은 부하가 크면 예약된 tickMs(20ms)보다 훨씬 늘어질 수 있는데(콜백
// 자체는 지연되지만 "이번에도 20ms 지났다"고 가정하고 누적하므로), 그
// 결과 "명목상 900ms"(=45틱)를 채우는 데 걸리는 **실제** 시간이 부하 아래
// 몇 배로 늘어난다(재현 실측: 인위적 이벤트 루프 부하 아래 900ms 명목
// 창이 실제로는 1854ms 걸림 -- repro-growth.mjs, 45틱 그대로). 이 CLI의
// 정지 판정(dispatch-start-size-core.mjs)은 반대로 항상 **실제 시각**
// (Date.now())으로 lastGrowthAtMs/now를 비교하므로, "명목 900ms"가 실제로
// 늘어져 성장이 CLI의 `timeoutMs`(4000ms) 턱밑까지 실제로 계속되면, CLI
// 입장에서는 "최근에 진짜로 늘었다"가 참이 되어 STARTED(+ pastOverallTimeout)
// 로 확정돼 버린다 -- 검토 좌석이 잡은 그 실패(round 0: exit code null)가
// 바로 이 경로다.
// 수리: 틱 카운트가 아니라 **실측 경과 시간**(Date.now() - start)으로
// 창을 닫는다. 이러면 콜백이 부하로 얼마나 늦게 불리든 "실제로 흐른
// 시간"만 기준이 되므로, 성장 창은 항상 실제 시계로 windowMs(900ms) 안팎
// 에서 끝난다(콜백 빈도가 낮아지면 틱 수는 줄지만 -- 재현 결과 15틱 -- 그건
// 이 시험이 요구하는 "최소 2회 폴링"과 무관: CLI는 파일 크기만 보므로
// 몇 번 썼는지가 아니라 언제까지 커졌는지만 중요하다). ★대기 시간을
// 늘리는 방향이 아니다 -- 같은 900ms 예산을 "명목"이 아니라 "실측"으로
// 재는 것뿐이라 부하가 얼마나 크든 창 자체가 실제로 벌어지지 않는다.
function growContinuously(
  logPath,
  windowMs,
  tickMs,
  writeFileSync,
  nowFn = Date.now,
) {
  const startMs = nowFn();
  let chunk = 0;
  const timer = setInterval(() => {
    chunk += 1;
    writeFileSync(logPath, "x".repeat(chunk * 200), "utf8");
    if (nowFn() - startMs >= windowMs) clearInterval(timer);
  }, tickMs);
  return () => clearInterval(timer);
}

async function runStalledAfterStartOnce({ label }) {
  return withTempDir(`dsc-notify-stalled-${label}-`, async (notifyDir) => {
    return withTempDir(`dsc-home-stalled-${label}-`, async (fakeHome) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { deriveClaudeProjectDirName } =
        await import("./rate-limit-stall-adapter.mjs");
      const repoRoot = `C:\\wt\\hyk270-stalled-demo-${label}`;
      const projectDir = join(
        fakeHome,
        ".claude",
        "projects",
        deriveClaudeProjectDirName(repoRoot),
      );
      mkdirSync(projectDir, { recursive: true });
      const logPath = join(projectDir, "s.jsonl");
      writeFileSync(logPath, "", "utf8"); // 배달 직후, 아직 아무것도 없음.

      const stopGrowing = growContinuously(
        logPath,
        GROWTH_WINDOW_MS,
        GROWTH_TICK_MS,
        writeFileSync,
      );

      let threw = null;
      let stderr = "";
      try {
        await execFileAsync(
          process.execPath,
          [
            CLI_PATH,
            "--repo-root",
            repoRoot,
            "--dispatched-at-ms",
            String(Date.now()),
            "--notify-dir",
            notifyDir,
            "--task-id",
            `HYK-TEST-stalled-${label}`,
            // ★부하 여유: 이 세 값은 타이밍을 "맞추기" 위한 것이 아니라
            // "growth 창이 끝난 뒤에도 자식이 stallThreshold 도달을 볼
            // 시간이 있다"는 여유만 준다 -- 정밀 정렬은 growContinuously
            // 쪽 로직(계속 자람)이 담당한다. ★HYK-329 2차 원인 수리(위
            // GROWTH_WINDOW_MS 주석 참조) -- growth 창을 4000ms로 늘린
            // 만큼 stall-threshold·timeout도 같이 늘려 자식 spawn 지연
            // 여유를 유지한다.
            "--timeout-ms",
            "15000",
            "--stall-threshold-ms",
            "4000",
            "--poll-interval-ms",
            "40",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
          },
        );
      } catch (err) {
        threw = err;
        stderr = err.stderr || "";
      } finally {
        stopGrowing();
      }
      return { threw, stderr, notifyDir };
    });
  });
}

// ★4R 신규(coder-task.md §2 항2 요구 -- 검토자가 반증에 쓴 그 부하 조건을
// «고치지 않고» fixture로 고정한다): 세션 로그가 자식의 «첫 관측 전에»
// 이미 커져 있으면(=이번 실행의 첫 관측 자체가 그 값을 기준선으로
// 삼는다), 그 뒤로 더 안 늘어도 이 CLI는 `STALLED_AFTER_START`가 아니라
// `NOT_STARTED`를 낸다 -- ★이것은 버그가 아니라 "현재 설계가 구조적으로
// 못 보는" 알려진 한계다(한용 확정: 이번 라운드에서 고치지 않는다, «첫
// 관측 기준선» 근본 수리는 ps1 결선과 함께 다음 조각). 이 시험은 그 한계
// 자체를 고정한다(결정적 -- 실제 시간에 전혀 기대지 않는다, collectFn을
// 호출 순서로만 제어).
test("★4R 알려진 한계 fixture(★고치지 않음, 고정만): 첫 관측 전에 이미 커져 있으면(=growth가 이번 실행의 관측 구간 밖) NOT_STARTED다 -- STALLED_AFTER_START가 아니다", async () => {
  const collectFn = () => ({ ok: true, totalBytes: 5000 }); // 첫 호출부터 이미 5000 -- 이번 실행 안에서는 절대 "늘어난 적"이 없다.
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 60000,
    stallThresholdMs: 60000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  // ⚠️의도된 동작 확인(고치는 시험이 아니다) -- «첫 관측이 이미 큰 값»과
  // «전혀 시작 못 함」을 이 설계는 구별하지 못한다. 그 사실을 정직하게
  // 고정한다.
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.NOT_STARTED);
});

// ★HYK-280(coder-task.md §2 항3, §4 항3) -- 위 "4R 알려진 한계" fixture가
// 고정했던 바로 그 자리(첫 실관측 전에 이미 커져 있어 growth를 이번
// 실행 안에서 전혀 못 보는 경우)를, 호출자가 `baselineBytes`(배달 시점에
// 잰 크기)를 넘기면 이제 정확히 판정한다는 것을 보인다. 위 4R 시험은
// 그대로 둔다(baselineBytes 없이 부르면 여전히 옛 동작 -- 회귀 0, §4
// 항2 요구 그대로).
test("★HYK-280 수리: baselineBytes(배달 시점 크기)를 넘기면, 첫 실관측 전에 이미 커져 있어도 더는 NOT_STARTED로 오판하지 않는다(성장 이력을 기준선부터 정확히 잡는다)", async () => {
  // 배달 순간(관측 밖)에 이미 0 -> 5000 만큼 커져 있었고, 이 실행의 첫
  // 실관측부터는 계속 5000(=승인창 등으로 멈춘 것과 동형)만 본다.
  const collectFn = () => ({ ok: true, totalBytes: 5000 });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    baselineBytes: 0, // 배달 순간에 잰 크기(=아직 아무것도 없었음).
    timeoutMs: 90000,
    stallThresholdMs: 10000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  // ★이전(4R, baselineBytes 없이)이라면 NOT_STARTED로 오판했을 바로 그
  // 관측열이다 -- 이번엔 기준선(0)부터 growth(0->5000)가 dispatchedAtMs
  // 시각에 정확히 기록되므로, "시작은 했다"가 인정되고 그 뒤 무증가가
  // stallThresholdMs를 넘겨 STALLED_AFTER_START로 정확히 갈린다.
  assert.equal(
    result.status,
    DISPATCH_START_CONFIRM_STATUS.STALLED_AFTER_START,
  );
  assert.equal(result.details.lastGrowthAtMs, 0);
});

test("★HYK-280 회귀 0: baselineBytes를 안 넘기면(undefined) 기존과 동일하게 동작한다(기준선을 심지 않음)", async () => {
  const collectFn = () => ({ ok: true, totalBytes: 5000 });
  const result = await runDispatchStartConfirm({
    repoRoot: "C:\\wt",
    dispatchedAtMs: 0,
    timeoutMs: 90000,
    stallThresholdMs: 10000,
    pollIntervalMs: 15000,
    now: fakeClock(0, 15000),
    sleepFn: instantSleep,
    collectFn,
  });
  // baselineBytes 없이는 여전히 "이번 실행 안에서 늘어난 적이 없다" ->
  // NOT_STARTED(4R 알려진 한계, 위 fixture와 동일 -- 회귀 0).
  assert.equal(result.status, DISPATCH_START_CONFIRM_STATUS.NOT_STARTED);
});

// ★HYK-280(coder-task.md §2 항1, §5) -- ps1이 넘길 `--claude-home` 인자가
// argv 파싱부터 실제 폴더 선택까지 실제로 결선돼 있는지 스폰으로
// 확인한다(항상 os.homedir()/.claude 고정이던 것이 이번 조각의 핵심
// 결함이었다 -- §1 실측). HOME/USERPROFILE 환경변수를 흔들지 않고
// `--claude-home`만으로 기록 폴더를 바꿀 수 있음을 보인다(item 1
// 완료조건). 같은 스폰에 `--baseline-bytes 0`도 함께 넘겨 그 인자도
// argv에서 실제로 읽히는지 같이 확인한다(수집 자체는 항상 실패 없이
// 진행되므로 COLLECTION_FAILED로 새지 않는다는 것만으로 파싱 성공을
// 판별할 수 있다 -- 아래 growContinuously가 실제 STALLED_AFTER_START로
// 확정시켜 두 인자 모두 실제로 쓰였음을 입증한다).
test("CLI end-to-end(spawn): --claude-home·--baseline-bytes 인자가 실제로 argv에서 읽혀 그 폴더/기준선을 쓴다(HOME 환경변수 조작 없이)", async () => {
  await withTempDir("dsc-notify-claudehome-", async (notifyDir) => {
    await withTempDir("dsc-claudehome-", async (claudeHomeDir) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { deriveClaudeProjectDirName } =
        await import("./rate-limit-stall-adapter.mjs");
      const repoRoot = "C:\\wt\\hyk280-claudehome-demo";
      const projectDir = join(
        claudeHomeDir,
        "projects",
        deriveClaudeProjectDirName(repoRoot),
      );
      mkdirSync(projectDir, { recursive: true });
      const logPath = join(projectDir, "s.jsonl");
      writeFileSync(logPath, "", "utf8");

      const stopGrowing = growContinuously(
        logPath,
        GROWTH_WINDOW_MS,
        GROWTH_TICK_MS,
        writeFileSync,
      );

      let threw = null;
      let stderr = "";
      try {
        await execFileAsync(
          process.execPath,
          [
            CLI_PATH,
            "--repo-root",
            repoRoot,
            "--dispatched-at-ms",
            String(Date.now()),
            "--notify-dir",
            notifyDir,
            "--task-id",
            "HYK-TEST-claudehome",
            "--claude-home",
            claudeHomeDir,
            "--baseline-bytes",
            "0",
            // ★HYK-329 2차 원인 수리(위 GROWTH_WINDOW_MS 주석 참조) -- 이
            // 값들은 growth 창(4000ms)과 짝을 맞춘다.
            "--timeout-ms",
            "15000",
            "--stall-threshold-ms",
            "4000",
            "--poll-interval-ms",
            "40",
          ],
          { encoding: "utf8" }, // ★HOME/USERPROFILE 무접촉 -- --claude-home만으로 폴더가 갈려야 한다.
        );
      } catch (err) {
        threw = err;
        stderr = err.stderr || "";
      } finally {
        stopGrowing();
      }
      assert.ok(threw, "STALLED_AFTER_START도 비0 종료코드여야 한다");
      assert.equal(threw.code, 3);
      assert.match(stderr, /STALLED_AFTER_START/);
      const files = readdirSync(notifyDir);
      assert.equal(files.length, 1);
    });
  });
});

// ★HYK-280(coder-task.md §2 항4) -- codex 좌석 기록 폴더도 "그냥 다른
// 폴더"로 --claude-home에 넘기면 그대로 동작한다는 것을 보인다(코드에
// codex·claude를 분기하는 문자열이 전혀 없다는 사실 자체가 완료조건 --
// 이 시험은 폴더 이름을 codex류로 지어 같은 코드 경로가 그대로 먹힘을
// 보여준다. 실제 codex 세션 로그의 구체 포맷은 HYK-275 보류 사안이라
// 건드리지 않는다 -- 여기서 검증하는 것은 "인자가 제너릭하다"는 사실
// 뿐이다).
test("CLI end-to-end(spawn): --claude-home에 codex류 폴더를 넘겨도 동일 코드 경로로 동작한다(엔진 이름 분기 0 실증)", async () => {
  await withTempDir("dsc-notify-codexhome-", async (notifyDir) => {
    await withTempDir("dsc-codex-home-", async (codexHomeDir) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { deriveClaudeProjectDirName } =
        await import("./rate-limit-stall-adapter.mjs");
      const repoRoot = "C:\\wt\\hyk280-codexhome-demo";
      // ★실제 ORCA_CODEX_HOME 하위 구조를 흉내내는 것이 아니라, "이
      // 코드가 폴더 이름/출처에 무관하게 똑같이 동작한다"만 보인다
      // (deriveClaudeProjectDirName 재사용 자체가 클래스 이름과 무관한
      // 순수 경로 규약임을 이미 §2 항4에서 요구한 그대로).
      const projectDir = join(
        codexHomeDir,
        "projects",
        deriveClaudeProjectDirName(repoRoot),
      );
      mkdirSync(projectDir, { recursive: true });
      const logPath = join(projectDir, "s.jsonl");
      writeFileSync(logPath, "", "utf8");

      const stopGrowing = growContinuously(
        logPath,
        GROWTH_WINDOW_MS,
        GROWTH_TICK_MS,
        writeFileSync,
      );

      let threw = null;
      let stderr = "";
      try {
        await execFileAsync(
          process.execPath,
          [
            CLI_PATH,
            "--repo-root",
            repoRoot,
            "--dispatched-at-ms",
            String(Date.now()),
            "--notify-dir",
            notifyDir,
            "--task-id",
            "HYK-TEST-codexhome",
            "--claude-home",
            codexHomeDir,
            // ★HYK-329 2차 원인 수리(위 GROWTH_WINDOW_MS 주석 참조) -- 이
            // 값들은 growth 창(4000ms)과 짝을 맞춘다.
            "--timeout-ms",
            "15000",
            "--stall-threshold-ms",
            "4000",
            "--poll-interval-ms",
            "40",
          ],
          { encoding: "utf8" },
        );
      } catch (err) {
        threw = err;
        stderr = err.stderr || "";
      } finally {
        stopGrowing();
      }
      assert.ok(threw);
      assert.equal(threw.code, 3);
      assert.match(stderr, /STALLED_AFTER_START/);
    });
  });
});

// ★3R 신규 / ★4R 수리: STALLED_AFTER_START 경로를 실제 CLI 프로세스로
// spawn해 종료코드 3 + «좌석 확인» 문구 통지 파일이 실제로 생기는지
// 확인한다. ★4R부터 시간 예약(고정 지연 1회) 대신 "계속 자라다가 멈춤"
// 동기화를 쓴다(위 growContinuously/runStalledAfterStartOnce 헤더 주석
// 참조).
// ★HYK-329 정정(완료조건3 -- 아래 "부하 무관"이라는 옛 문구는 반증됐다,
// ORCH/검토 좌석 실측 그대로): growContinuously가 성장 창을 "명목 틱 수"
// (`elapsed += tickMs`)로 재고 있어서, 부하가 커서 setInterval 콜백이
// 지연되면 그 창의 **실제** 길이가 늘어나 CLI의 `timeoutMs`(4000ms)를
// 잠식했다(4819개 시험 전체 부하에서 1회 재현, 원인 경계값은 결과 파일
// §1 참조 -- 재현 스크립트: 인위 이벤트 루프 부하 아래 명목 900ms 창이
// 실측 1854ms 걸림, 45틱 그대로). 이제 growContinuously가 실측 경과
// (Date.now())로 창을 닫으므로 **그 특정 원인 경로는 닫혔다.** 다만 이
// 시험은 여전히 실제 자식 프로세스 spawn·실제 타이머·실제 파일 I/O에
// 의존하는 E2E 시험이다 -- "부하와 무관하게 결정적"이 실제로 보장하는
// 것은 정확히 «성장 창(900ms)이 부하 크기와 무관하게 실제 시계로 900ms
// 안팎에서 끝난다»는 것뿐이며, "이 프로세스 전체가 어떤 부하에서도
// 반드시 4000ms 안에 끝난다"는 수학적 증명은 아니다(운영체제가 그 예산
// 자체를 삼킬 만큼 극단적인 부하라면 여전히 실패할 수 있다 -- 잔여
// 위험은 아래 반복 실행 시험의 표본 통과로만 뒷받침된다). 아래 반복
// 실행 시험이 이 시험을 5회 이상 연속 통과시킨다.
test("CLI end-to-end(spawn, 부하-무관 동기화): 폴링 도중 계속 커지다 멈추면 종료코드 3 + notifyDir에 «좌석 확인» 문구 통지 파일이 실제로 생긴다", async () => {
  const { threw, stderr, notifyDir } = await runStalledAfterStartOnce({
    label: "single",
  });
  assert.ok(threw, "STALLED_AFTER_START도 비0 종료코드여야 한다");
  assert.equal(threw.code, 3);
  assert.match(stderr, /STALLED_AFTER_START/);
  assert.match(stderr, /좌석 확인/);
  const files = readdirSync(notifyDir);
  assert.equal(files.length, 1);
  const text = readFileSync(join(notifyDir, files[0]), "utf8");
  assert.match(text, /시작 후 멈춤/);
  assert.match(text, /좌석 상태를 직접 확인/);
});

// ★4R 완료조건3(coder-task.md §4 항3) -- 같은 시험을 반복 실행해 전건
// 동일 결과임을 실행 출력으로 보인다(최소 5회). withTempDir가 매번 새
// mkdtemp 디렉터리를 쓰므로 라운드끼리 간섭 없음.
test("반복 실행 결정성(5회 연속): 매번 동일하게 STALLED_AFTER_START·종료코드 3 (부하 무관 동기화 실증)", async () => {
  for (let i = 0; i < 5; i++) {
    const { threw, stderr } = await runStalledAfterStartOnce({
      label: `repeat${i}`,
    });
    assert.ok(threw, `round ${i}: 비0 종료코드여야 한다`);
    assert.equal(threw.code, 3, `round ${i}: 종료코드가 3이어야 한다`);
    assert.match(stderr, /STALLED_AFTER_START/, `round ${i}`);
  }
});
