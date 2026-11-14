// HYK-255-p1fix-2 (판정 2026-11-14 0706 · 사건 합집합) -- 일별 줄의 확인 값 = «그날 회차들이 처음 본 확인 사건 수».
//
//   회차마다 이미 계산한 24시간 창의 확인 사건(D1 = 커밋 sha · 권한 사람 답 = sessionId + tool_use_id)을 식별자로 오늘 상태
//   파일에 모으고, 일별 줄의 확인 값 = 그날 처음 본 식별자 수 - 앞 일별 줄들이 이미 센 식별자(최근 2일 보관).
//   일별 줄 창 표기 = 그날 첫 회차의 창 시작 ~ 마지막 회차 + «앞 줄에서 센 사건 N건 제외» (값과 같은 창).
//
// ⛔헛시험 금지: 프로덕션 export 를 직접 구동한다 -- runPartialCountStep(watch-run 부분 계수 단계) · runPartialCountOnce(실제
// 보고 조립 · 실제 세션 수집기) · partial-count-core 의 순수 함수. 사본 import 0. 모든 저장소/파일은 mkdtemp 합성 홈 ·
// 합성 watchDir · 주입 시계(now) · 가짜 fetchJson/git -- 실제 네트워크 · 관제실 · 실물 세션 기록 쓰기 0.
// ⛔표기 산수만 단언 금지: 모든 «창» 칸은 사건을 넣고 일별 줄의 «값» 을 단언한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as core from "./partial-count-core.mjs";
import * as report from "./partial-count-report.mjs";
import { runPartialCountStep } from "./watch-run.mjs";

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const kst = (s) =>
  Date.parse(`${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}+09:00`);

const cleanups = [];
function tmpDir(prefix) {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
after(() => {
  for (const d of cleanups) fs.rmSync(d, { recursive: true, force: true });
});

const dailyPath = (dir) => join(dir, "partial-count-daily.jsonl");
const statePath = (dir) => join(dir, "partial-count-daily-state.json");
const readState = (dir) => JSON.parse(fs.readFileSync(statePath(dir), "utf8"));
const readLines = (dir) =>
  fs.existsSync(dailyPath(dir))
    ? fs
        .readFileSync(dailyPath(dir), "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l))
    : [];
const lineOf = (lines, day) => lines.find((l) => l.day === day);

// ---- 합성 세션 jsonl(권한 확인창 사람 답) -----------------------------------------------------

const BODY = "BODY-SENTINEL-대화본문-표식";

function decisionLine({
  atMs,
  cwd,
  sessionId,
  toolUseId,
  source = "user_temporary",
}) {
  return JSON.stringify({
    type: "user",
    uuid: `u-${sessionId}-${toolUseId}`,
    timestamp: new Date(atMs).toISOString(),
    cwd,
    sessionId,
    version: "2.1.322",
    entrypoint: "cli",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: BODY }],
    },
    toolUseResult: BODY,
    permissionDecision: { decision: "accept", source },
  });
}

function makeHome() {
  const home = tmpDir("nc-union-home-");
  const interpreter = join(home, "통역-합성");
  fs.mkdirSync(join(interpreter, "보내는함"), { recursive: true });
  for (const r of [".claude", ".claude-team"]) {
    fs.mkdirSync(join(home, r, "projects", "p1"), { recursive: true });
  }
  return {
    home,
    outboxDir: join(interpreter, "보내는함"),
    wt: join(home, "orca", "workspaces", "HARNESSENGINEERING", "wt-1"),
  };
}

// 세션 파일 1개 -- 줄들(레코드 모양 {atMs, toolUseId, sessionId})을 심는다. mtime = 가장 늦은 줄(창 시작 필터를 통과).
function putSession(h, name, events) {
  const dir = join(h.home, ".claude-team", "projects", "p1");
  const file = join(dir, `${name}.jsonl`);
  fs.writeFileSync(
    file,
    events
      .map((e) =>
        decisionLine({ cwd: h.wt, sessionId: e.sessionId ?? name, ...e }),
      )
      .join("\n") + "\n",
    "utf8",
  );
  const last = Math.max(...events.map((e) => e.atMs));
  fs.utimesSync(file, new Date(last), new Date(last));
}

// ---- 실제 파이프라인(runPartialCountStep + runPartialCountOnce + 실제 수집기) ----------------

const GIT_STUB = { run: () => ({ code: 0, stdout: "", stderr: "" }) };

function makeRig() {
  const h = makeHome();
  const watchDir = tmpDir("nc-union-watch-");
  const calls = { fetch: 0 };
  const root = tmpDir("nc-union-run-");
  const runReal = (args) =>
    report.runPartialCountOnce({
      repoRoot: root,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      fetchJson: async () => {
        calls.fetch += 1;
        return { ok: false, status: 404, json: null, linkHeader: null };
      },
      git: GIT_STUB,
      gitWorktreeListExecFn: () => "",
      ...args,
    });
  const tick = (now) =>
    runPartialCountStep({
      watchDir,
      now,
      logPath: join(watchDir, "watch.log"),
      options: { outboxDir: h.outboxDir, sessionHomeDir: h.home },
      runPartialCountOnceFn: runReal,
    });
  return { h, watchDir, calls, runReal, tick };
}

// 한 날을 15분 간격으로 돈다(첫 회차 = first · 마지막 회차 = last · 같은 날 안).
async function tickRange(tick, day, first, last) {
  const times = [];
  for (
    let t = kst(`${day} ${first}`);
    t <= kst(`${day} ${last}`);
    t += 15 * MIN
  ) {
    times.push(t);
  }
  for (const t of times) await tick(t);
  return times;
}

// ======================================================================================
// ⑴ 틈 탐침 -- 11-13 23:45 사람 답 1건 · 마지막 회차 11-13 23:41 · 11-14 23:50 (실제 파이프라인)
// ======================================================================================

test("틈 탐침: 11-13 23:45 사람 답 1건이 11-13 줄 · 11-14 줄 어디서도 0 으로 사라지지 않고 «정확히 한 줄» 에 1 로 남는다", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-gap", [
    { atMs: kst("2026-11-13 23:45"), toolUseId: "tu-gap-1" },
  ]);
  // 11-13 회차: 마지막 23:41(= 사람 답 4분 전 · 그 회차의 창 끝보다 뒤)
  for (const hhmm of ["23:11", "23:26", "23:41"]) {
    await rig.tick(kst(`2026-11-13 ${hhmm}`));
  }
  // 11-14 회차: 00:20 · 12:00 · 마지막 23:50(그 회차의 창 시작 = 11-13 23:50 이라 23:45 는 창 밖)
  for (const hhmm of ["00:20", "12:00", "23:50"]) {
    await rig.tick(kst(`2026-11-14 ${hhmm}`));
  }
  await rig.tick(kst("2026-11-15 00:05")); // 11-14 줄을 닫는다
  const lines = readLines(rig.watchDir);
  const l13 = lineOf(lines, "2026-11-13");
  const l14 = lineOf(lines, "2026-11-14");
  assert.ok(l13 && l14, "두 날 줄이 모두 있다");
  assert.deepEqual(
    [l13.permissionHumanAnswers, l14.permissionHumanAnswers],
    [0, 1],
    "[11-13 줄, 11-14 줄] -- 11-13 줄 = 23:45 를 본 회차가 없다 · 11-14 줄 = 00:20 회차가 처음 본 사건 1",
  );
  const total = lines.reduce((s, l) => s + (l.permissionHumanAnswers ?? 0), 0);
  assert.equal(total, 1, "두 줄 합 = 1 (0 으로 사라짐 0 · 두 줄 중복 0)");
});

test("틈 탐침 · 사건 식별자는 같은 날 여러 회차가 같은 사건을 봐도 1 — 11-14 줄의 값 1 은 00:20 · 12:00 · 23:50 회차 중 창에 든 모든 회차가 본 같은 사건", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-multi", [
    { atMs: kst("2026-11-14 00:30"), toolUseId: "tu-m-1" },
  ]);
  const times = await tickRange(rig.tick, "2026-11-14", "00:45", "23:45");
  assert.ok(times.length > 60, "같은 사건을 본 회차가 60 개 넘게 있다");
  await rig.tick(kst("2026-11-15 00:05"));
  const l14 = lineOf(readLines(rig.watchDir), "2026-11-14");
  assert.equal(l14.permissionHumanAnswers, 1);
});

// ======================================================================================
// ⑵ 앞 줄에서 이미 센 사건은 뺀다 -- 실제 파이프라인
// ======================================================================================

test("앞 줄 제외: 11-13 23:30 사람 답은 11-13 줄에서 1 · 11-14 00:20 회차가 같은 사건을 또 보아도 11-14 줄은 0 (두 줄 중복 0) · 제외 건수 1", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-dup", [
    { atMs: kst("2026-11-13 23:30"), toolUseId: "tu-dup-1" },
  ]);
  await rig.tick(kst("2026-11-13 23:41")); // 사건을 본다
  await rig.tick(kst("2026-11-14 00:20")); // 같은 사건을 또 본다(창이 23시간 넘게 겹친다)
  await rig.tick(kst("2026-11-14 12:00"));
  await rig.tick(kst("2026-11-15 00:05"));
  const lines = readLines(rig.watchDir);
  assert.equal(lineOf(lines, "2026-11-13").permissionHumanAnswers, 1);
  const l14 = lineOf(lines, "2026-11-14");
  assert.equal(l14.permissionHumanAnswers, 0, "앞 줄에서 센 사건은 뺀다");
  assert.equal(
    l14.confirmedExcludedEarlier,
    1,
    "제외 건수 = 실제로 뺀 사건 수",
  );
  assert.match(l14.windowNote, /앞 줄에서 센 사건 1건 제외/);
});

test("같은 세션 두 답: sessionId 가 같고 tool_use_id 가 다른 두 사건은 2 (식별자 = sessionId + tool_use_id)", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-two", [
    { atMs: kst("2026-11-14 10:00"), toolUseId: "tu-a" },
    { atMs: kst("2026-11-14 10:05"), toolUseId: "tu-b" },
  ]);
  await rig.tick(kst("2026-11-14 11:00"));
  await rig.tick(kst("2026-11-15 00:05"));
  const l14 = lineOf(readLines(rig.watchDir), "2026-11-14");
  assert.equal(l14.permissionHumanAnswers, 2);
});

test("다른 세션이 같은 tool_use_id 를 쓰면 별개 사건 2 (식별자에 sessionId 가 든다)", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-x", [
    { atMs: kst("2026-11-14 10:00"), toolUseId: "tu-same" },
  ]);
  putSession(rig.h, "sess-y", [
    { atMs: kst("2026-11-14 10:01"), toolUseId: "tu-same" },
  ]);
  await rig.tick(kst("2026-11-14 11:00"));
  await rig.tick(kst("2026-11-15 00:05"));
  const l14 = lineOf(readLines(rig.watchDir), "2026-11-14");
  assert.equal(l14.permissionHumanAnswers, 2);
});

// ======================================================================================
// ⑶ D1 sha -- 프로덕션 회차 값 만들기(buildDailyTickValues) + 감시 단계
// ======================================================================================

const tickWith = (shas, extra = {}) =>
  core.buildDailyTickValues({
    externalEvidence: { known: true, confirmedShas: shas, unchecked: 0 },
    collectors: [],
    delivered: { known: true, count: 1 },
    uncountedExamples: core.UNCOUNTED_EXAMPLES_V3,
    permissionAnswers: { known: true, humanTotal: 0, undecided: 0 },
    ...extra,
  });

function fakeOnce(dailyTickFor) {
  return async (args) => ({
    reportText: `집계 성격: PARTIAL — 전수 아님\n${args.confirmedZeroStreakLine ?? ""}\n`,
    dailyTick: dailyTickFor(args.now),
  });
}

async function stepWith(dir, now, dailyTickFor) {
  return runPartialCountStep({
    watchDir: dir,
    now,
    logPath: join(dir, "watch.log"),
    runPartialCountOnceFn: fakeOnce(dailyTickFor),
  });
}

test("D1 sha 1건이 이틀 창에 걸쳐 보여도 한 줄에만 1 — 11-13 줄 1 · 11-14 줄 0(제외 1)", async () => {
  const dir = tmpDir("nc-union-sha-");
  const SHA = "a".repeat(40);
  const seen = (now) =>
    now >= kst("2026-11-13 20:00") && now <= kst("2026-11-14 19:00")
      ? tickWith([SHA])
      : tickWith([]);
  for (const t of [
    "2026-11-13 21:00",
    "2026-11-13 23:55",
    "2026-11-14 00:10",
    "2026-11-14 18:50",
    "2026-11-14 23:55",
    "2026-11-15 00:05",
  ]) {
    await stepWith(dir, kst(t), seen);
  }
  const lines = readLines(dir);
  assert.equal(lineOf(lines, "2026-11-13").lnConfirmed, 1);
  assert.equal(lineOf(lines, "2026-11-14").lnConfirmed, 0);
  assert.equal(lineOf(lines, "2026-11-14").confirmedExcludedEarlier, 1);
});

test("D1 sha 가 첫 번째 날의 마지막 회차 뒤에 처음 보여도(11-14 첫 회차) 11-14 줄에 정확히 1", async () => {
  const dir = tmpDir("nc-union-sha-late-");
  const SHA = "b".repeat(40);
  const seen = (now) =>
    now >= kst("2026-11-14 00:10") ? tickWith([SHA]) : tickWith([]);
  for (const t of [
    "2026-11-13 23:41",
    "2026-11-14 00:10",
    "2026-11-14 12:00",
    "2026-11-15 00:05",
  ]) {
    await stepWith(dir, kst(t), seen);
  }
  const lines = readLines(dir);
  assert.equal(lineOf(lines, "2026-11-13").lnConfirmed, 0);
  assert.equal(lineOf(lines, "2026-11-14").lnConfirmed, 1);
});

test("D1 sha 와 권한 답은 서로 다른 칸: sha 1 + 사람 답 1 이 같은 날 오면 lnConfirmed 1 · permissionHumanAnswers 1 (한 칸에 뭉치지 않는다)", async () => {
  const dir = tmpDir("nc-union-kinds-");
  const SHA = "c".repeat(40);
  const make = () =>
    tickWith([SHA], {
      permissionAnswers: {
        known: true,
        humanTotal: 1,
        undecided: 0,
        humanEventIds: ["perm:s1|t1"],
      },
    });
  for (const t of [
    "2026-11-14 10:00",
    "2026-11-14 10:15",
    "2026-11-15 00:05",
  ]) {
    await stepWith(dir, kst(t), make);
  }
  const l14 = lineOf(readLines(dir), "2026-11-14");
  assert.equal(l14.lnConfirmed, 1);
  assert.equal(l14.permissionHumanAnswers, 1);
});

test("2일 지난 식별자는 지운다 — 3일 뒤 상태 파일의 앞 줄 식별자 보관에 3일 전 식별자가 없고 · 어제 · 그제 식별자는 있다", async () => {
  const dir = tmpDir("nc-union-keep-");
  const idFor = (day) => `sha-of-${day}`;
  const dayOf = (now) => core.kstDayOf(now);
  const seen = (now) => tickWith([idFor(dayOf(now)).padEnd(40, "0")]);
  for (const t of [
    "2026-11-10 12:00",
    "2026-11-11 12:00",
    "2026-11-12 12:00",
    "2026-11-13 12:00",
  ]) {
    await stepWith(dir, kst(t), seen);
  }
  const counted = readState(dir).countedEventIds;
  assert.deepEqual(
    Object.keys(counted).sort(),
    ["2026-11-11", "2026-11-12"],
    "오늘(11-13) 기준 최근 2일(11-11 · 11-12) 식별자만 남는다 — 11-10 은 지운다",
  );
});

test("옛 상태 파일(식별자 칸 없음 · 마지막 회차 값만 있음)이 마감될 때는 옛 규칙 그대로 마지막 회차 값을 줄에 적는다 — 확인 1 이 0 으로 접히지 않는다", async () => {
  const dir = tmpDir("nc-union-legacy-");
  const legacy = {
    schema: "partial-count-daily-state/v1",
    day: "2026-11-13",
    firstTickAtMs: kst("2026-11-13 23:00"),
    lastTickAtMs: kst("2026-11-13 23:45"),
    ticks: 4,
    gapCount: 0,
    gapTotalMs: 0,
    lnConfirmed: 2,
    lnUnchecked: 0,
    collectorFails: [],
    concurrentTracksMax: 1,
    delivered: 1,
    uncountedExampleIds: [],
    uncountedVersion: null,
  };
  fs.writeFileSync(statePath(dir), JSON.stringify(legacy), "utf8");
  await stepWith(dir, kst("2026-11-14 00:10"), () => tickWith([]));
  const l13 = lineOf(readLines(dir), "2026-11-13");
  assert.equal(
    l13.lnConfirmed,
    2,
    "옛 상태는 식별자가 없으니 마지막 회차 값 그대로",
  );
});

test("옛 상태 파일에서 이어진 날(앞 회차 식별자를 모름 + 뒤 회차는 식별자를 가짐)은 «그날 식별자를 다 모른다» -- 마감은 마지막 회차 값 · 앞 줄 장부에 넣지 않는다(보수 쪽: 다음 날 같은 사건을 또 세어도 숨기지 않는다)", async () => {
  const dir = tmpDir("nc-union-legacy-mixed-");
  const SHA = "e".repeat(40);
  const legacy = {
    schema: "partial-count-daily-state/v1",
    day: "2026-11-13",
    firstTickAtMs: kst("2026-11-13 23:00"),
    lastTickAtMs: kst("2026-11-13 23:30"),
    ticks: 3,
    gapCount: 0,
    gapTotalMs: 0,
    lnConfirmed: 2,
    lnUnchecked: 0,
    collectorFails: [],
    concurrentTracksMax: 1,
    delivered: 1,
    uncountedExampleIds: [],
    uncountedVersion: null,
  };
  fs.writeFileSync(statePath(dir), JSON.stringify(legacy), "utf8");
  await stepWith(dir, kst("2026-11-13 23:45"), () => tickWith([SHA]));
  assert.equal(
    readState(dir).eventIdsPartial,
    true,
    "앞 회차를 식별자 없이 적은 날 = 부분",
  );
  await stepWith(dir, kst("2026-11-14 00:10"), () => tickWith([SHA]));
  await stepWith(dir, kst("2026-11-15 00:05"), () => tickWith([]));
  const lines = readLines(dir);
  assert.equal(
    lineOf(lines, "2026-11-13").lnConfirmed,
    1,
    "부분인 날 = 마지막 회차 값",
  );
  assert.equal(
    lineOf(lines, "2026-11-14").lnConfirmed,
    1,
    "부분인 날은 앞 줄 장부에 안 들어가므로 같은 사건이 다음 날에도 센다(숨기지 않는 쪽)",
  );
});

// ======================================================================================
// ⑷ 뜻 무변 -- 미조회 · 수집 실패 · 공백 · 동시 배달 최대 · 판정 불가
// ======================================================================================

test("뜻 무변: 마지막 회차가 수집 실패(null)면 확인 값은 0 이 아니라 null(UNKNOWN) — 앞 회차에서 센 사건이 있어도 0 으로 접지 않는다", async () => {
  const dir = tmpDir("nc-union-null-");
  const SHA = "d".repeat(40);
  const make = (now) =>
    now < kst("2026-11-14 12:00")
      ? tickWith([SHA])
      : core.dailyFailureTick("수집기 실패");
  for (const t of [
    "2026-11-14 10:00",
    "2026-11-14 13:00",
    "2026-11-15 00:05",
  ]) {
    await stepWith(dir, kst(t), make);
  }
  const l14 = lineOf(readLines(dir), "2026-11-14");
  assert.equal(l14.lnConfirmed, null);
  assert.deepEqual(l14.collectorFails, ["수집기 실패"]);
});

test("모르는 종류는 앞 줄 장부에 들어가지 않는다: 마지막 회차가 D1 수집 실패인 날에 본 D1 sha 는 다음 날 줄에서 1 로 센다 · 제외 0 (그날 줄 자신은 null)", async () => {
  const dir = tmpDir("nc-union-unknown-kind-");
  const SHA = "f".repeat(40);
  // 11-13: 낮 회차가 sha 를 본다 -> 그날 마지막 회차(23:50)는 D1 수집 실패(값 자리 = 모르는 종류).
  // 11-14: 같은 sha 가 아직 24시간 창 안이라 첫 회차가 다시 본다 · 마지막 회차는 사건 없음.
  const plan = [
    ["2026-11-13 12:00", () => tickWith([SHA])],
    ["2026-11-13 23:50", () => core.dailyFailureTick("수집기 실패")],
    ["2026-11-14 00:05", () => tickWith([SHA])],
    ["2026-11-14 23:50", () => tickWith([])],
  ];
  for (const [t, make] of plan.slice(0, 3)) {
    await stepWith(dir, kst(t), make);
  }
  // 11-13 을 닫은 직후: 값을 못 센 날(null)의 식별자는 «앞 줄에서 센 장부» 에 없다.
  assert.deepEqual(
    readState(dir).countedEventIds["2026-11-13"],
    [],
    "마지막 회차가 수집 실패인 날 = D1 식별자를 장부에 넣지 않는다",
  );
  const [lastT, lastMake] = plan[3];
  await stepWith(dir, kst(lastT), lastMake);
  await stepWith(dir, kst("2026-11-15 00:05"), () => tickWith([])); // 11-14 줄을 닫는다
  const lines = readLines(dir);
  const l13 = lineOf(lines, "2026-11-13");
  const l14 = lineOf(lines, "2026-11-14");
  assert.ok(l13 && l14, "두 날 줄이 모두 있다");
  assert.equal(l13.lnConfirmed, null, "그날 줄 = 모르는 종류 -> null(0 아님)");
  assert.deepEqual(l13.collectorFails, ["수집기 실패"]);
  assert.equal(
    l14.lnConfirmed,
    1,
    "11-13 줄이 세지 않았으니 11-14 줄이 센다(거짓 0 으로 사라지지 않는다)",
  );
  assert.equal(l14.confirmedExcludedEarlier, 0, "앞 줄에서 센 사건 = 0");
  assert.match(l14.windowNote, /앞 줄에서 센 사건 0건 제외/);
});

test("뜻 무변: 미조회 · 관측 공백 · 동시 배달 최대 칸은 사건 합집합과 무관하게 마지막 회차 값 · 20분 초과 공백 · 최대값 그대로", async () => {
  const dir = tmpDir("nc-union-meaning-");
  const make = (now) =>
    now === kst("2026-11-14 10:00")
      ? tickWith([], {
          externalEvidence: { known: true, confirmedShas: [], unchecked: 3 },
        })
      : tickWith([], {
          externalEvidence: { known: true, confirmedShas: [], unchecked: 2 },
        });
  await stepWith(dir, kst("2026-11-14 10:00"), make);
  await stepWith(dir, kst("2026-11-14 10:30"), make); // 30분 간격 = 공백
  await stepWith(dir, kst("2026-11-15 00:05"), make);
  const l14 = lineOf(readLines(dir), "2026-11-14");
  assert.equal(l14.lnUnchecked, 2, "미조회 = 마지막 회차 값");
  assert.equal(l14.coverageGaps.count >= 1, true, "30분 간격 = 관측 공백");
  assert.equal(l14.lnConfirmed, 0);
});

// ======================================================================================
// ⑸ 창 표기 = 값의 창 -- 사건을 넣고 «값» 을 함께 단언
// ======================================================================================

test("창 표기: 일별 줄 창 = 첫 회차의 창 시작 ~ 마지막 회차 · 그 창 안에 든 사건은 값에 들고 · 창 밖 사건은 안 든다", async () => {
  const rig = makeRig();
  // 첫 회차 11-14 00:20 의 창 시작 = 11-13 00:20 · 마지막 회차 11-14 23:50
  putSession(rig.h, "sess-in", [
    { atMs: kst("2026-11-13 00:40"), toolUseId: "tu-first-window" }, // 첫 회차 창 안(창 시작 + 20분)
    { atMs: kst("2026-11-13 23:45"), toolUseId: "tu-gap" }, // 날 사이 틈
    { atMs: kst("2026-11-14 23:55"), toolUseId: "tu-after-last" }, // 마지막 회차 뒤 -> 창 밖
  ]);
  await tickRange(rig.tick, "2026-11-14", "00:20", "23:50");
  await rig.tick(kst("2026-11-15 00:05"));
  const l14 = lineOf(readLines(rig.watchDir), "2026-11-14");
  assert.equal(l14.windowStartMs, kst("2026-11-14 00:20") - DAY);
  assert.equal(l14.windowEndMs, kst("2026-11-14 23:50"));
  assert.equal(
    l14.permissionHumanAnswers,
    2,
    "창 안 사건 2(첫 회차 창 안 1 + 날 사이 틈 1) · 마지막 회차 뒤 사건은 창 밖이라 0",
  );
  // 값이 센 사건의 시각은 전부 표기 창 안에 든다
  for (const atMs of [kst("2026-11-13 00:40"), kst("2026-11-13 23:45")]) {
    assert.ok(atMs > l14.windowStartMs && atMs <= l14.windowEndMs);
  }
  assert.ok(kst("2026-11-14 23:55") > l14.windowEndMs);
});

test("창 표기 = 값의 창: 회차 창이 24시간이 아니어도(windowHours 6) 줄 창 시작 = 첫 회차가 실제로 본 창 시작 · 그 창 밖 사건은 값에 안 든다", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-w6", [
    { atMs: kst("2026-11-14 03:00"), toolUseId: "tu-outside" }, // 첫 회차 창(04:00 ~) 밖
    { atMs: kst("2026-11-14 05:00"), toolUseId: "tu-inside" }, // 창 안
  ]);
  const tick6 = (now) =>
    runPartialCountStep({
      watchDir: rig.watchDir,
      now,
      logPath: join(rig.watchDir, "watch.log"),
      options: {
        outboxDir: rig.h.outboxDir,
        sessionHomeDir: rig.h.home,
        windowHours: 6,
      },
      runPartialCountOnceFn: rig.runReal,
    });
  await tick6(kst("2026-11-14 10:00"));
  await tick6(kst("2026-11-14 10:15"));
  await tick6(kst("2026-11-15 00:05"));
  const l14 = lineOf(readLines(rig.watchDir), "2026-11-14");
  assert.equal(l14.windowStartMs, kst("2026-11-14 04:00"));
  assert.equal(l14.windowEndMs, kst("2026-11-14 10:15"));
  assert.equal(l14.permissionHumanAnswers, 1, "창 안 사건 1 · 창 밖 0");
});

test("창 표기: 앞 줄에서 센 사건이 있으면 «앞 줄에서 센 사건 N건 제외» 의 N = 실제로 뺀 수 · 값 + 제외 = 그날 창이 본 사건 수", async () => {
  const rig = makeRig();
  putSession(rig.h, "sess-win", [
    { atMs: kst("2026-11-13 22:00"), toolUseId: "tu-w1" },
    { atMs: kst("2026-11-13 23:00"), toolUseId: "tu-w2" },
    { atMs: kst("2026-11-14 08:00"), toolUseId: "tu-w3" },
  ]);
  await rig.tick(kst("2026-11-13 23:30")); // 11-13 줄에서 w1 w2 를 센다
  await rig.tick(kst("2026-11-14 09:00")); // 창 = 11-13 09:00 ~: w1 w2 w3
  await rig.tick(kst("2026-11-15 00:05"));
  const lines = readLines(rig.watchDir);
  assert.equal(lineOf(lines, "2026-11-13").permissionHumanAnswers, 2);
  const l14 = lineOf(lines, "2026-11-14");
  assert.equal(l14.permissionHumanAnswers, 1, "w3 만 새 사건");
  assert.equal(l14.confirmedExcludedEarlier, 2, "w1 w2 는 앞 줄에서 센 사건");
  assert.match(l14.windowNote, /앞 줄에서 센 사건 2건 제외/);
  assert.equal(
    l14.permissionHumanAnswers + l14.confirmedExcludedEarlier,
    3,
    "값 + 제외 = 그날 창이 본 사건",
  );
});

// ======================================================================================
// ⑹ 추가 REST 0 · 불변
// ======================================================================================

test("추가 REST 0: 감시 단계로 도는 회차의 fetchJson 호출 수 = 같은 회차를 runPartialCountOnce 만 불렀을 때의 호출 수 (일별 층이 조회를 더하지 않는다)", async () => {
  const rigA = makeRig();
  putSession(rigA.h, "s", [
    { atMs: kst("2026-11-14 10:00"), toolUseId: "tu-rest" },
  ]);
  await rigA.runReal({
    now: kst("2026-11-14 11:00"),
    outboxDir: rigA.h.outboxDir,
    sessionHomeDir: rigA.h.home,
  });
  const once = rigA.calls.fetch;
  const rigB = makeRig();
  putSession(rigB.h, "s", [
    { atMs: kst("2026-11-14 10:00"), toolUseId: "tu-rest" },
  ]);
  await rigB.tick(kst("2026-11-14 11:00"));
  assert.equal(rigB.calls.fetch, once);
});

test("불변: 20분 기준 상수 무변 · 식별자 목록은 일별 줄에 싣지 않는다(건수만) · 본문 표식 0", async () => {
  assert.equal(core.DAILY_COVERAGE_GAP_MS, 20 * MIN);
  const rig = makeRig();
  putSession(rig.h, "sess-inv", [
    { atMs: kst("2026-11-14 10:00"), toolUseId: "tu-inv" },
  ]);
  await rig.tick(kst("2026-11-14 11:00"));
  await rig.tick(kst("2026-11-15 00:05"));
  const raw = fs.readFileSync(dailyPath(rig.watchDir), "utf8");
  assert.ok(!raw.includes("tu-inv"), "식별자는 일별 줄에 없다");
  assert.ok(!raw.includes("sess-inv"), "세션 식별자도 일별 줄에 없다");
  assert.ok(!raw.includes(BODY), "본문 표식 0");
  const state = readState(rig.watchDir);
  assert.ok(
    JSON.stringify(state).includes("tu-inv"),
    "식별자는 상태 파일에만 있다",
  );
});
