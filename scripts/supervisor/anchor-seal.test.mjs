// HYK-255-s1-anchor-seal-1 (S1 봉인 일지) -- 시험.
//
// ⭐프로덕션 회차(`runWatchOnce`)를 구동한다 -- 코어 함수 단독 시험은 헛시험이다
// (판정 #20261119-1520 B). 입력은 전부 합성: mkdtemp 원천 디렉터리 · mkdtemp watch
// 디렉터리 · mkdtemp `git init --bare` 원격. ⛔실제 원격(GitHub) 호출 0 · 실제 봇 PAT
// 파일 읽기 0(가짜 PAT 는 mkdtemp 안 파일) · 실제 홈 · 관제실 · 통역 무접촉.
//
// 칸 열둘(task §2 ⓒ) 이름은 `⑴`..`⑿` 접두로 시험 제목에 박았다. 모듈은 칸마다
// 지연 import 한다 -- 모듈이 없는 base 에서는 «RED 1줄» 이 아니라 칸별 기대 실패가
// 나오게 하려는 것이다.
//
// 단언 규율: 출력 «전체» 문자열 동등 단언 금지 -- 자기 토막만 본다(단 ⑴ 칸은 «base 와
// 같은 입력에서 줄 전체를 비교» 하는 것이 계약이다 · 예외 1).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as watchRun from "./watch-run.mjs";
import { ADMISSION_SCHEMA_VERSION } from "./admission-ledger-core.mjs";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// 실제 홈을 읽지 않게 이 시험 프로세스의 «홈» 을 합성 디렉터리로 돌린다(기존 한도
// 정지 단계가 os.homedir() 기준으로 세션 기록을 찾는다 -- usage-threshold-watch
// 시험과 같은 방식).
const FAKE_HOME = fs.mkdtempSync(join(os.tmpdir(), "hyk255s1-home-"));
const SAVED_ENV = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
};
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;
process.on("exit", () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

const { runWatchOnce } = watchRun;
// 기준 시각은 UTC 로 고정한다(2026-11-19T01:00:00.000Z) -- ⑴ 칸의 기준 줄(BASE_LINE_TEMPLATE)이
// 이 순간을 글자 그대로 박았기 때문이다. 로컬 생성자(new Date(년, 월, …))로 만들면 TZ 에 따라
// 순간이 달라져(KST 01:00Z · UTC 10:00Z) 기준 줄과 어긋난다(PR #389 CI 빨강 = 러너 UTC).
const T0 = Date.UTC(2026, 10, 19, 1, 0, 0);
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const OK_DETECTOR = JSON.stringify({
  verdict: "PROGRESSING",
  reasonCode: "OK",
});
// 실제 토큰 모양(ghp_… 등)을 피한다 -- 비밀 스캐너(gitleaks)가 시험 값을 실제 PAT 로 오인한다.
const FAKE_PAT = "FAKE_BOT_PAT_hyk255_0123456789_notarealtoken";
const SESSION_ID = "6f0c2b5e-8a4d-4c1e-9b7a-3d2e1f0a9c8b";
// 원격 객체에서 0 건이어야 하는 표지 문자열(파일 이름 · 본문 · 경로 · sessionId 토막).
const LEAK_NAME = "LEAKNAME-게이트1-표지";
const LEAK_BODY = "LEAKBODY-본문-표지-7731";
const LEAK_PATH = "leakpathdir-표지";

async function loadSeal() {
  return import("./anchor-seal.mjs");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function makeWorld() {
  const root = fs.mkdtempSync(join(os.tmpdir(), "hyk255s1-"));
  const w = {
    root,
    outboxDir: join(root, LEAK_PATH, "보내는함"),
    inboxDir: join(root, LEAK_PATH, "받는함"),
    ledgerDir: join(root, "harness"),
    sessionsDir: join(root, "sessions", "proj"),
    northStarFile: join(root, "북극성-좌표.md"),
    watchDir: join(root, "watch"),
    sealDir: join(root, "seal-git"),
    remote: join(root, "remote.git"),
    patFile: join(root, "fake-bot-pat.txt"),
    // 합성 동시 실행 상한 파일 -- 저장소의 실제 concurrency-cap.json 값이 바뀌어도
    // ⑴ 칸의 «줄 전체 비교» 가 흔들리지 않게 한다.
    capPath: join(root, "cap.json"),
  };
  for (const d of [w.outboxDir, w.inboxDir, w.ledgerDir, w.sessionsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(
    join(w.outboxDir, `2026-11-19-1000-${LEAK_NAME}.md`),
    `# 게이트1 ${LEAK_BODY}\n`,
  );
  fs.writeFileSync(
    join(w.outboxDir, "2026-11-19-1530-판정-1530-마커.md"),
    `판정 ${LEAK_BODY}\n`,
  );
  fs.writeFileSync(
    join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md"),
    `상신 ${LEAK_BODY}\n`,
  );
  fs.writeFileSync(
    join(w.ledgerDir, "reject-streak.json"),
    `{"issues":{"HYK-1":{"history":[]}}}\n`,
  );
  fs.writeFileSync(
    join(w.ledgerDir, "reject-streak-chain.json"),
    `{"chains":{}}\n`,
  );
  fs.writeFileSync(w.northStarFile, `북극성 ${LEAK_BODY}\n`);
  writeTypedTurns(w, [["2026-11-19T01:00:00.000Z", "typed"]]);
  fs.writeFileSync(w.patFile, `${FAKE_PAT}\n`);
  fs.writeFileSync(
    w.capPath,
    `{"schema_version":"concurrency-cap/v1","global_hard_cap":2}\n`,
  );
  git(["init", "--bare", "-q", w.remote]);
  return w;
}

function writeTypedTurns(w, turns) {
  const lines = turns.map(([ts, src]) =>
    JSON.stringify({
      type: "user",
      sessionId: SESSION_ID,
      timestamp: ts,
      promptSource: src,
      message: { content: LEAK_BODY },
    }),
  );
  fs.writeFileSync(
    join(w.sessionsDir, `${SESSION_ID}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

function sealOpts(w, extra = {}) {
  return {
    remote: w.remote,
    sealDir: w.sealDir,
    patFile: w.patFile,
    sources: {
      outboxDir: w.outboxDir,
      inboxDir: w.inboxDir,
      ledgerDir: w.ledgerDir,
      sessionsDirs: [w.sessionsDir],
      northStarFile: w.northStarFile,
    },
    ...extra,
  };
}

function cycle(w, now = T0, sealExtra = {}, runExtra = {}) {
  return runWatchOnce({
    repoRoot: ROOT,
    watchDir: w.watchDir,
    now,
    capPath: w.capPath,
    execFn: () => OK_DETECTOR,
    // 정지-종결 축의 조사 디렉터리를 빈 합성 폴더로 -- 실제 체크아웃의 `.harness/aborts` 를
    // 읽지 않는다(ⓗ ⑵ · 그 날 상태에 따라 결과가 달라지면 시험 결함).
    blockedTerminationScan: emptyHarnessScan(w),
    anchorSeal: sealOpts(w, sealExtra),
    ...runExtra,
  });
}

function withWorld(fn) {
  const w = makeWorld();
  try {
    return fn(w);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
}

async function withWorldAsync(fn) {
  const w = makeWorld();
  try {
    return await fn(w);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
}

function remoteSealText(w) {
  try {
    return git(["--git-dir", w.remote, "show", "anchor-seal:seal.jsonl"]);
  } catch {
    return "";
  }
}

function remoteSealLines(w) {
  return remoteSealText(w).split("\n").filter(Boolean);
}

function remoteTip(w) {
  try {
    return git([
      "--git-dir",
      w.remote,
      "rev-parse",
      "refs/heads/anchor-seal",
    ]).trim();
  } catch {
    return null;
  }
}

function remoteCommitCount(w) {
  if (!remoteTip(w)) return 0;
  return Number(
    git([
      "--git-dir",
      w.remote,
      "rev-list",
      "--count",
      "refs/heads/anchor-seal",
    ]).trim(),
  );
}

function logText(w) {
  return fs.readFileSync(join(w.watchDir, "watch.log"), "utf8");
}

function lastLogLine(w) {
  return logText(w).trim().split("\n").at(-1);
}

// ---------------------------------------------------------------------------
// ⑴ 스위치 없음 -> 줄 바이트 동일 · git 호출 0
// ---------------------------------------------------------------------------
// 아래 줄은 base(master 55c25b9) 에서 같은 입력으로 잰 원문이다(cap_source 는 이
// 저장소의 절대 경로라 자리표시자로 두고 시험이 같은 식으로 채운다).
const BASE_LINE_TEMPLATE =
  "2026-11-19T01:00:00.000Z exit=0 verdict=PROGRESSING reason=OK seat_status=NONE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=NONE idle_status=NONE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=NONE start_status=NONE start_verdict=NONE start_worst_count=NONE start_worktrees=NONE unconsumed_status=NONE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=NONE cap_status=OK cap_verdict=DECIDED cap_value=2 cap_source=@@CAP@@ escalation_status=NONE escalation_verdict=NONE escalation_worst_count=NONE escalation_worktrees=NONE postcheck_status=NONE postcheck_verdict=NONE postcheck_worst_count=NONE postcheck_worktrees=NONE chain_status=NONE chain_verdict=NONE chain_worst_count=NONE chain_worktrees=NONE binding_status=NONE binding_verdict=NONE binding_worst_count=NONE binding_worktrees=NONE blocked_termination_status=NONE blocked_termination_count=0 blocked_termination_source=harness/aborts memory_reopen_sent=false memory_reopen_reason=MEMORY_REOPEN_STATE_MISSING";

function baseLine(w) {
  return BASE_LINE_TEMPLATE.replace("@@CAP@@", w.capPath);
}

// ⑴ 칸의 «줄 전체 비교» 는 이 저장소 체크아웃의 `.harness/aborts` 에 기대면 안 된다(5R 실측:
// 4R 이 남긴 중단 기록 CODER-abort-r1.json 이 있으면 줄이 blocked_termination_status=FOUND 로
// 달라져 시간대와 무관하게 빨강). 정지-종결 축의 조사 디렉터리를 빈 임시 디렉터리로 돌린다 --
// 줄 비교 자체는 그대로다(그 축이 FOUND 로 줄에 실리는 동작은
// watch-run-blocked-termination.test.mjs 의 opt-in 칸이 합성 기록으로 따로 지킨다).
function emptyHarnessScan(w) {
  const harnessDir = join(w.root, "empty-harness");
  fs.mkdirSync(harnessDir, { recursive: true });
  return { harnessDir };
}

test("⑴ 스위치 없음 -> watch.log 줄이 base 와 바이트 같다 · 단계 미실행 · 봉인 흔적 파일 0", () => {
  withWorld((w) => {
    const before = fs.existsSync(w.watchDir) ? fs.readdirSync(w.watchDir) : [];
    const r = runWatchOnce({
      repoRoot: ROOT,
      watchDir: w.watchDir,
      now: T0,
      capPath: w.capPath,
      execFn: () => OK_DETECTOR,
      blockedTerminationScan: emptyHarnessScan(w),
    });
    assert.equal(r.line, baseLine(w));
    assert.equal(lastLogLine(w), baseLine(w));
    assert.ok(!r.line.includes("anchor-seal:"));
    const after = fs.readdirSync(w.watchDir);
    assert.ok(
      !after.some((n) => n.includes("anchor-seal")),
      `봉인 흔적 파일이 생겼다: ${after.join(",")} (이전 ${before.join(",")})`,
    );
    assert.ok(!fs.existsSync(w.sealDir), "전용 git 디렉터리가 만들어졌다");
    assert.equal(remoteTip(w), null);
  });
});

test("⑴ 스위치가 명시적으로 null 이어도 줄이 같다 · 단계 함수는 git 을 한 번도 부르지 않는다", async () => {
  await withWorldAsync(async (w) => {
    const r = runWatchOnce({
      repoRoot: ROOT,
      watchDir: w.watchDir,
      now: T0,
      capPath: w.capPath,
      execFn: () => OK_DETECTOR,
      anchorSeal: null,
      blockedTerminationScan: emptyHarnessScan(w),
    });
    assert.equal(r.line, baseLine(w));
    assert.equal(typeof watchRun.runAnchorSealStep, "function");
    let gitCalls = 0;
    const res = watchRun.runAnchorSealStep({
      anchorSeal: null,
      watchDir: w.watchDir,
      repoRoot: ROOT,
      now: T0,
      gitFn: () => {
        gitCalls += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(res.notRun, true);
    assert.equal(gitCalls, 0);
  });
});

// ⑴ 시간대 칸(5R · PR #389 CI 빨강 수리): 위 두 «스위치» 칸이 «어느 시간대에서도» 같은
// 판정을 내는지 -- 시간대를 «자식 프로세스 env TZ» 로 준다(부모의 process.env.TZ 를 바꿔 같은
// 프로세스에서 재면 Node 의 시간대 캐시 때문에 헛시험이 될 수 있다 · 그래서 자식). 자식이 실제로
// 그 시간대로 떴다는 값도 단언한다(헛시험 방지). 음수 오프셋(America/Los_Angeles)은 UTC 기준
// 순간의 «로컬 날짜가 전날로 넘어가는 쪽» 이라 칸으로 고정한다(자식 2칸 × 시간대 3 = 몇 초).
// 이 칸 이름은 자식이 고르는 이름 패턴(`⑴ 스위치`)에 걸리지 않는다 -- 자식이 이 칸을 다시
// 돌려 재귀하지 않는다.
const SWITCH_OFF_CELL_PATTERN = "⑴ 스위치";
const TZ_CASES = [
  // [TZ, 로컬 생성자 2026-11-19 10:00 이 가리키는 순간(자식 확인값), T0 순간의 로컬 날짜]
  ["UTC", "2026-11-19T10:00:00.000Z", "2026-11-19"],
  ["Asia/Seoul", "2026-11-19T01:00:00.000Z", "2026-11-19"],
  ["America/Los_Angeles", "2026-11-19T18:00:00.000Z", "2026-11-18"],
];

function runChildNode(args, tz) {
  // 러너가 시험 파일 프로세스에 심는 NODE_TEST_CONTEXT 가 자식 `node --test` 에 상속되면 자식이
  // TAP 대신 러너 내부 직렬화로 말해 stdout 이 비므로 뺀다.
  const env = { ...process.env, TZ: tz };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env,
    timeout: 120000,
  });
}

test("⑴ 시간대 UTC · Asia/Seoul · America/Los_Angeles: 스위치 없음 두 칸이 자식 프로세스(env TZ)에서도 초록 · T0 는 UTC 고정", () => {
  for (const [tz, localCtorInstant, localDateAtT0] of TZ_CASES) {
    // 1) 자식이 실제로 그 시간대로 떴다 -- 로컬 생성자 값이 시간대마다 달라진다.
    const probe = runChildNode(
      [
        "-e",
        `console.log(JSON.stringify({ctor:new Date(2026,10,19,10,0,0).toISOString(),` +
          `local:(()=>{const d=new Date(${T0});const p=(n)=>String(n).padStart(2,"0");` +
          `return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());})()}))`,
      ],
      tz,
    );
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout.trim()), {
      ctor: localCtorInstant,
      local: localDateAtT0,
    });
    // 2) 부모의 T0 는 시간대와 무관하게 기준 줄의 순간이다.
    assert.equal(new Date(T0).toISOString(), "2026-11-19T01:00:00.000Z");
    assert.ok(
      BASE_LINE_TEMPLATE.startsWith(`${new Date(T0).toISOString()} `),
      "기준 줄 머리의 시각이 T0 와 다르다",
    );
    // 3) 그 시간대의 자식에서 «스위치» 칸 둘이 초록 -- TAP 요약 줄만 판독한다.
    const child = runChildNode(
      [
        "--test",
        "--test-reporter=tap",
        `--test-name-pattern=${SWITCH_OFF_CELL_PATTERN}`,
        fileURLToPath(import.meta.url),
      ],
      tz,
    );
    const tap = child.stdout ?? "";
    const okCells = tap.match(/^ok \d+ - ⑴ 스위치/gm) ?? [];
    assert.equal(
      okCells.length,
      2,
      `자식(${tz}) 초록 칸 수 · 상태 ${child.status}\n${tap.slice(0, 1500)}`,
    );
    assert.ok(
      /^# fail 0$/m.test(tap),
      `자식(${tz}) 실패 요약\n${tap.slice(0, 1500)}`,
    );
    assert.ok(
      !/^not ok /m.test(tap),
      `자식(${tz}) 빨간 칸\n${tap.slice(0, 1500)}`,
    );
    assert.equal(child.status, 0);
  }
});

test("⑴ CLI 인자 -> opt-in 객체: --anchor-seal-remote 가 없으면 null", () => {
  assert.equal(typeof watchRun.buildAnchorSealFromArgv, "function");
  assert.equal(watchRun.buildAnchorSealFromArgv([]), null);
  assert.equal(
    watchRun.buildAnchorSealFromArgv(["--usage-hud-dir", "x", "--no-reach"]),
    null,
  );
  const on = watchRun.buildAnchorSealFromArgv([
    "--anchor-seal-remote",
    "R",
    "--anchor-seal-git-dir",
    "G",
    "--anchor-seal-pat-file",
    "P",
    "--anchor-seal-outbox-dir",
    "O",
    "--anchor-seal-inbox-dir",
    "I",
    "--anchor-seal-ledger-dir",
    "L",
    "--anchor-seal-sessions-dir",
    "S1",
    "--anchor-seal-sessions-dir",
    "S2",
    "--anchor-seal-northstar-file",
    "N",
  ]);
  assert.equal(on.remote, "R");
  assert.equal(on.sealDir, "G");
  assert.equal(on.patFile, "P");
  assert.equal(on.sources.outboxDir, "O");
  assert.equal(on.sources.inboxDir, "I");
  assert.equal(on.sources.ledgerDir, "L");
  assert.deepEqual(on.sources.sessionsDirs, ["S1", "S2"]);
  assert.equal(on.sources.northStarFile, "N");
});

// ---------------------------------------------------------------------------
// ⑵ 스위치 있음 -> 봉인 커밋 1 + 재계산 뿌리 일치
// ---------------------------------------------------------------------------
test("⑵ 스위치 켠 합성 회차 -> 원격 anchor-seal 가지에 봉인 커밋 1 · 같은 원천으로 다시 계산한 뿌리가 줄과 같다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const r = cycle(w);
    assert.equal(r.anchorSeal.failed, undefined);
    assert.equal(remoteCommitCount(w), 1);
    const lines = remoteSealLines(w);
    assert.equal(lines.length, 1);
    const journal = seal.parseSealJournal(remoteSealText(w));
    assert.equal(journal.seals.length, 1);
    assert.equal(journal.malformed, 0);
    const recomputed = seal.computeAnchorRoots(sealOpts(w).sources);
    for (const key of seal.ANCHOR_TYPE_KEYS) {
      assert.match(recomputed.roots[key], /^[0-9a-f]{64}$/, key);
      assert.equal(journal.seals[0].roots[key], recomputed.roots[key], key);
    }
    assert.match(logText(w), /anchor-seal: sealed/);
  });
});

test('⑵ 정규화 규칙 고정 -- 잎 = sha256("hyk255-anchor-seal/v1" 0x00 유형키 0x00 길이 0x00 바이트) · 뿌리 = 정렬 후 0x01 쌍 해시 · 홀수는 올림', async () => {
  const seal = await loadSeal();
  const leafOf = (type, bytes) =>
    createHash("sha256")
      .update(
        Buffer.concat([
          Buffer.from("hyk255-anchor-seal/v1", "utf8"),
          Buffer.from([0]),
          Buffer.from(type, "utf8"),
          Buffer.from([0]),
          Buffer.from(String(bytes.length), "utf8"),
          Buffer.from([0]),
          bytes,
        ]),
      )
      .digest();
  const a = leafOf("g1", Buffer.from("aaa"));
  const b = leafOf("g1", Buffer.from("bbb"));
  const c = leafOf("g1", Buffer.from("ccc"));
  assert.equal(seal.leafHash("g1", Buffer.from("aaa")), a.toString("hex"));
  const pair = (l, r) =>
    createHash("sha256")
      .update(Buffer.concat([Buffer.from([1]), l, r]))
      .digest();
  const sorted = [a, b, c].sort(Buffer.compare);
  const expected = pair(pair(sorted[0], sorted[1]), sorted[2]);
  // 입력 순서는 결과에 영향이 없다(정렬).
  const shuffled = [c, a, b].map((x) => x.toString("hex"));
  assert.equal(seal.merkleRoot(shuffled), expected.toString("hex"));
  assert.equal(seal.merkleRoot([a.toString("hex")]), a.toString("hex"));
  // 유형 키가 다르면 같은 바이트도 다른 잎이다(유형 간 교차 증명 금지).
  assert.notEqual(
    seal.leafHash("g2", Buffer.from("aaa")),
    seal.leafHash("g1", Buffer.from("aaa")),
  );
});

test("⑵ 정의 이탈 방지 -- 보내는함 «게이트1» · «판정-/상신 HHMM» 정규식은 partial-count-report 의 정의와 같다", async () => {
  const seal = await loadSeal();
  const src = fs.readFileSync(
    join(ROOT, "scripts", "supervisor", "partial-count-report.mjs"),
    "utf8",
  );
  assert.ok(
    src.includes(String.raw`const GATE1_OUTBOX_NAME_RE = /게이트1(?!\d)/;`),
  );
  assert.ok(
    src.includes(
      String.raw`const GATE7_PAIR_TOKEN_RE = /(?<![\p{L}\p{N}])(?:판정-|상신)(\d{4})(?!\d)/gu;`,
    ),
  );
  assert.equal(seal.GATE1_OUTBOX_NAME_RE.source, "게이트1(?!\\d)");
  assert.equal(
    seal.GATE7_PAIR_TOKEN_RE.source,
    String.raw`(?<![\p{L}\p{N}])(?:판정-|상신)(\d{4})(?!\d)`,
  );
});

test("⑵ 상한 상수 = 24 · 봉인 파일 이름 · 가지 이름 고정", async () => {
  const seal = await loadSeal();
  assert.equal(seal.DAILY_PUSH_CAP, 24);
  assert.equal(seal.SEAL_BRANCH, "anchor-seal");
  assert.equal(seal.SEAL_FILE, "seal.jsonl");
  assert.deepEqual([...seal.ANCHOR_TYPE_KEYS], ["g1", "g2", "g3", "g6", "g7"]);
});

// ---------------------------------------------------------------------------
// ⑶ 같은 원천 다음 회차 -> push 0 (unchanged)
// ---------------------------------------------------------------------------
test("⑶ 같은 원천으로 다음 회차 -> push 0 · 구간 unchanged · git 호출 0", async () => {
  await withWorldAsync(async (w) => {
    cycle(w);
    const tip1 = remoteTip(w);
    const calls = [];
    const seal = await loadSeal();
    const realGit = seal.defaultGitFn;
    const r = cycle(w, T0 + 15 * MIN, {
      gitFn: (...a) => {
        calls.push(a[0]);
        return realGit(...a);
      },
    });
    assert.equal(remoteTip(w), tip1);
    assert.equal(remoteCommitCount(w), 1);
    assert.equal(
      calls.length,
      0,
      `unchanged 회차가 git 을 불렀다: ${calls.map((c) => c.join(" ")).join(" | ")}`,
    );
    assert.match(lastLogLine(w), /anchor-seal: unchanged/);
    assert.equal(r.anchorSeal.status, "unchanged");
  });
});

// ---------------------------------------------------------------------------
// ⑷ 원천 1바이트 변경 -> 새 봉인 1 · 옛 뿌리와 불일치
// ---------------------------------------------------------------------------
test("⑷ 원천 한 바이트를 바꾸면 새 봉인 1 · 옛 봉인과는 «불일치» · 새 봉인과는 일치", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    cycle(w);
    const file = join(w.outboxDir, `2026-11-19-1000-${LEAK_NAME}.md`);
    fs.appendFileSync(file, "x");
    cycle(w, T0 + 15 * MIN);
    assert.equal(remoteCommitCount(w), 2);
    const journal = seal.parseSealJournal(remoteSealText(w));
    assert.equal(journal.seals.length, 2);
    const current = seal.computeAnchorRoots(sealOpts(w).sources).roots;
    const against = (s) => seal.compareSealToRoots(s.roots, current);
    const old = against(journal.seals[0]);
    const fresh = against(journal.seals[1]);
    assert.equal(old.g1, "mismatch");
    assert.equal(old.g7, "match", "바뀌지 않은 유형은 일치");
    for (const key of seal.ANCHOR_TYPE_KEYS)
      assert.equal(fresh[key], "match", key);
  });
});

// ---------------------------------------------------------------------------
// ⑸ 하루 상한 -> push 0 + 미봉인 수
// ---------------------------------------------------------------------------
test("⑸ 하루 상한 24 -- 23 번째까지 찼으면 1 회 더 봉인 · 그 뒤 변경은 push 0 + 미봉인 회차 수(0 으로 접지 않음) · 다음 날 다시 봉인", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const statePath = join(w.watchDir, seal.STATE_FILE);
    fs.mkdirSync(w.watchDir, { recursive: true });
    cycle(w); // 첫 봉인 1 (오늘 1)
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const today = Object.keys(st.days)[0];
    assert.equal(st.days[today], 1);
    st.days[today] = 23; // 상한 직전으로 시드(합성)
    fs.writeFileSync(statePath, JSON.stringify(st));
    const f = join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md");
    fs.appendFileSync(f, "1");
    const r24 = cycle(w, T0 + 1 * MIN);
    assert.equal(remoteCommitCount(w), 2, "24 번째 봉인은 허용");
    assert.equal(r24.anchorSeal.status, "sealed");
    fs.appendFileSync(f, "2");
    const r25 = cycle(w, T0 + 2 * MIN);
    assert.equal(remoteCommitCount(w), 2, "상한 뒤 push 0");
    assert.equal(r25.anchorSeal.status, "cap_reached");
    assert.equal(r25.anchorSeal.unsealed, 1);
    assert.match(lastLogLine(w), /anchor-seal: cap_reached unsealed=1/);
    fs.appendFileSync(f, "3");
    const r26 = cycle(w, T0 + 3 * MIN);
    assert.equal(r26.anchorSeal.unsealed, 2);
    assert.equal(remoteCommitCount(w), 2);
    // 다음 로컬 날짜 -> 다시 봉인(상한은 날짜별).
    const next = cycle(w, T0 + DAY + MIN);
    assert.equal(next.anchorSeal.status, "sealed");
    assert.equal(remoteCommitCount(w), 3);
  });
});

// ---------------------------------------------------------------------------
// ⑹ 원천 없음 -> none (0 아님) · ⑺ 읽기 실패 -> read_error (0 아님)
// ---------------------------------------------------------------------------
test("⑹ 원천이 없으면 낱말 none -- 0 도 빈 뿌리도 아니다 · 원천 있는 유형은 영향 없음", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    fs.rmSync(w.northStarFile);
    fs.rmSync(join(w.ledgerDir, "reject-streak.json"));
    fs.rmSync(join(w.ledgerDir, "reject-streak-chain.json"));
    cycle(w);
    const journal = seal.parseSealJournal(remoteSealText(w));
    const roots = journal.seals[0].roots;
    assert.equal(roots.g3, "none");
    assert.equal(roots.g2, "none");
    assert.equal(roots.g6, "none");
    assert.match(roots.g1, /^[0-9a-f]{64}$/);
    assert.notEqual(roots.g3, "0");
    assert.notEqual(roots.g3, sha256(Buffer.alloc(0)), "빈 뿌리로 접지 않는다");
    assert.match(lastLogLine(w), /anchor-seal: sealed none=3 read_error=0/);
  });
});

test("⑺ 읽을 수 없으면(파일 자리에 디렉터리) 낱말 read_error -- none 으로도 0 으로도 접지 않는다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    fs.rmSync(join(w.ledgerDir, "reject-streak.json"));
    fs.mkdirSync(join(w.ledgerDir, "reject-streak.json")); // EISDIR
    cycle(w);
    const roots = seal.parseSealJournal(remoteSealText(w)).seals[0].roots;
    assert.equal(roots.g2, "read_error");
    assert.equal(roots.g6, "read_error");
    assert.match(roots.g1, /^[0-9a-f]{64}$/);
    assert.match(lastLogLine(w), /read_error=2/);
    // 읽기 실패가 풀리면 새 뿌리로 다시 봉인한다(read_error 와 뿌리는 서로 다른 값).
    fs.rmSync(join(w.ledgerDir, "reject-streak.json"), { recursive: true });
    fs.writeFileSync(
      join(w.ledgerDir, "reject-streak.json"),
      `{"issues":{}}\n`,
    );
    cycle(w, T0 + 15 * MIN);
    const roots2 = seal.parseSealJournal(remoteSealText(w)).seals[1].roots;
    assert.match(roots2.g2, /^[0-9a-f]{64}$/);
  });
});

test("⑺ 보내는함 디렉터리 자리에 파일이 있어도(ENOTDIR) read_error · 디렉터리가 아예 없으면(ENOENT) none", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const srcs = sealOpts(w).sources;
    const notDir = join(w.root, "not-a-dir.txt");
    fs.writeFileSync(notDir, "x");
    const r1 = seal.computeAnchorRoots({ ...srcs, outboxDir: notDir });
    assert.equal(r1.roots.g1, "read_error");
    assert.equal(r1.roots.g7, "read_error");
    const r2 = seal.computeAnchorRoots({
      ...srcs,
      outboxDir: join(w.root, "없는-폴더"),
      inboxDir: join(w.root, "없는-받는함"),
      sessionsDirs: [join(w.root, "없는-세션")],
    });
    assert.equal(r2.roots.g7, "none");
    assert.equal(
      r2.roots.g1,
      "none",
      "보내는함 · 세션 폴더가 없으면 잎 0 -> none",
    );
    assert.match(r2.roots.g2, /^[0-9a-f]{64}$/, "원장은 그대로 읽힌다");
  });
});

// ---------------------------------------------------------------------------
// ⑻ 같은 뿌리 두 번 -> 정본 = 가장 이른 줄
// ---------------------------------------------------------------------------
test("⑻ 같은 뿌리가 두 번 봉인되면(바꿨다 되돌림) 정본 = 가장 이른 줄", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const file = join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md");
    const original = fs.readFileSync(file);
    cycle(w, T0);
    fs.appendFileSync(file, "변경");
    cycle(w, T0 + 15 * MIN);
    fs.writeFileSync(file, original);
    cycle(w, T0 + 30 * MIN);
    const journal = seal.parseSealJournal(remoteSealText(w));
    assert.equal(journal.seals.length, 3);
    const r1 = journal.seals[0].roots.g7;
    assert.equal(journal.seals[2].roots.g7, r1, "되돌렸으니 같은 뿌리");
    const canon = seal.findCanonicalSeal(journal, "g7", r1);
    assert.equal(canon.index, 0, "정본은 가장 이른 줄(index 0)");
    assert.equal(canon.at, journal.seals[0].at);
    const none = seal.findCanonicalSeal(journal, "g7", "f".repeat(64));
    assert.equal(none, null);
  });
});

test("⑻ 깨진 줄은 조용히 버리지 않는다 -- malformed 로 센다", async () => {
  const seal = await loadSeal();
  const text =
    `{"v":1,"at":"2026-11-19T01:00:00.000Z","roots":{"g1":"none"}}\n` +
    `이건 json 이 아님\n` +
    `{"v":1,"at":"2026-11-19T02:00:00.000Z","roots":{"g1":"read_error"}}\n`;
  const j = seal.parseSealJournal(text);
  assert.equal(j.seals.length, 2);
  assert.equal(j.malformed, 1);
  assert.equal(j.seals[1].index, 2, "줄 번호는 원본 파일 기준");
});

// ---------------------------------------------------------------------------
// ⑼ 단계 예외 -> 회차 계속 + FAILED 구간
// ---------------------------------------------------------------------------
test("⑼ git 실행 실패 -> 회차는 계속(다른 구간 그대로) + anchor-seal: FAILED 구간 · 상태 전진 0", async () => {
  await withWorldAsync(async (w) => {
    const r = cycle(w, T0, {
      gitFn: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
      }),
    });
    assert.equal(r.anchorSeal.failed, true);
    assert.match(lastLogLine(w), /anchor-seal: FAILED reason=/);
    assert.match(lastLogLine(w), /exit=0 verdict=PROGRESSING/);
    assert.ok(
      fs.existsSync(join(w.watchDir, "last-run.json")),
      "회차 생존 기록",
    );
    assert.equal(remoteTip(w), null);
  });
});

test("⑼ 단계가 던져도(원천 읽기 자리 예외) 회차는 죽지 않는다", async () => {
  await withWorldAsync(async (w) => {
    const r = cycle(w, T0, {
      gitFn: () => {
        throw new Error("boom-from-git-seam");
      },
    });
    assert.equal(r.anchorSeal.failed, true);
    assert.match(lastLogLine(w), /anchor-seal: FAILED reason=/);
    assert.match(lastLogLine(w), /boom-from-git-seam/);
  });
});

test("⑼ push 거절 -> FAILED · 상태 전진 0 · 거절 원인이 사라진 다음 회차에 같은 내용이 봉인된다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const lock = join(w.remote, "refs", "heads", "anchor-seal.lock");
    fs.mkdirSync(join(w.remote, "refs", "heads"), { recursive: true });
    fs.writeFileSync(lock, "");
    const r = cycle(w, T0);
    assert.equal(r.anchorSeal.failed, true);
    assert.match(lastLogLine(w), /anchor-seal: FAILED reason=/);
    assert.equal(remoteTip(w), null);
    const statePath = join(w.watchDir, seal.STATE_FILE);
    const st = fs.existsSync(statePath)
      ? JSON.parse(fs.readFileSync(statePath, "utf8"))
      : {};
    assert.equal(
      st.last ?? null,
      null,
      "실패한 회차가 «마지막 봉인» 을 전진시켰다",
    );
    fs.rmSync(lock);
    const r2 = cycle(w, T0 + 15 * MIN);
    assert.equal(r2.anchorSeal.status, "sealed");
    assert.equal(
      remoteCommitCount(w),
      1,
      "거절된 로컬 커밋이 같이 올라가지 않는다",
    );
  });
});

// ---------------------------------------------------------------------------
// ⑽ 원격 끝이 후손 아님 -> push 0 + REWRITE_SUSPECT
// ---------------------------------------------------------------------------
test("⑽ 원격 anchor-seal 이 다시 쓰이면(강제 push 흉내) push 0 + REWRITE_SUSPECT · 원격은 그대로", async () => {
  await withWorldAsync(async (w) => {
    cycle(w);
    const rogue = join(w.root, "rogue");
    git(["clone", "-q", w.remote, rogue]);
    git(["-C", rogue, "checkout", "-q", "--orphan", "evil"]);
    fs.writeFileSync(join(rogue, "seal.jsonl"), "rewritten\n");
    git(["-C", rogue, "add", "seal.jsonl"]);
    git([
      "-C",
      rogue,
      "-c",
      "user.name=rogue",
      "-c",
      "user.email=rogue@example.invalid",
      "commit",
      "-q",
      "-m",
      "rewrite",
    ]);
    git(["-C", rogue, "push", "-q", "--force", "origin", "evil:anchor-seal"]);
    const rogueTip = remoteTip(w);
    fs.appendFileSync(
      join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md"),
      "z",
    );
    const r = cycle(w, T0 + 15 * MIN);
    assert.equal(r.anchorSeal.status, "REWRITE_SUSPECT");
    assert.match(lastLogLine(w), /anchor-seal: REWRITE_SUSPECT reason=/);
    assert.equal(remoteTip(w), rogueTip, "의심 상태에서는 push 0");
    // 다음 회차도 계속 막힌다(자동으로 풀리지 않는다).
    const r2 = cycle(w, T0 + 30 * MIN);
    assert.equal(r2.anchorSeal.status, "REWRITE_SUSPECT");
    assert.equal(remoteTip(w), rogueTip);
  });
});

test("⑽ 원격 가지가 지워졌으면(봉인한 적이 있는데) REWRITE_SUSPECT · 새로 만들지 않는다", async () => {
  await withWorldAsync(async (w) => {
    cycle(w);
    git(["--git-dir", w.remote, "update-ref", "-d", "refs/heads/anchor-seal"]);
    fs.appendFileSync(
      join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md"),
      "q",
    );
    const r = cycle(w, T0 + 15 * MIN);
    assert.equal(r.anchorSeal.status, "REWRITE_SUSPECT");
    assert.equal(remoteTip(w), null);
  });
});

test("⑽ 정상 전진(원격 끝이 마지막 봉인의 후손) 은 막지 않는다", async () => {
  await withWorldAsync(async (w) => {
    cycle(w);
    fs.appendFileSync(
      join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md"),
      "ok",
    );
    const r = cycle(w, T0 + 15 * MIN);
    assert.equal(r.anchorSeal.status, "sealed");
    assert.equal(remoteCommitCount(w), 2);
  });
});

// ---------------------------------------------------------------------------
// ⑾ 유출 0
// ---------------------------------------------------------------------------
test("⑾ 합성 원천에 심은 표지(파일 이름 · 본문 · 경로 · sessionId) 가 원격 모든 객체에서 0 건", async () => {
  await withWorldAsync(async (w) => {
    cycle(w);
    fs.appendFileSync(
      join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md"),
      "again",
    );
    cycle(w, T0 + 15 * MIN);
    assert.equal(remoteCommitCount(w), 2);
    const all = execFileSync(
      "git",
      ["--git-dir", w.remote, "cat-file", "--batch-all-objects", "--batch"],
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString("utf8");
    assert.ok(
      all.includes('"roots"'),
      "양성 대조: 객체 안에 봉인 줄이 실제로 있다",
    );
    for (const marker of [
      LEAK_NAME,
      "LEAKNAME",
      LEAK_BODY,
      "LEAKBODY",
      LEAK_PATH,
      SESSION_ID,
      w.root,
      "게이트1",
      "판정-1530",
      "상신1530",
      "reject-streak",
      "북극성",
    ]) {
      assert.ok(!all.includes(marker), `원격 객체에 표지가 새었다: ${marker}`);
    }
  });
});

// ---------------------------------------------------------------------------
// ⑿ 자격 비노출
// ---------------------------------------------------------------------------
test("⑿ 가짜 PAT 값이 argv · 로그 · 결과 · 오류 · 커밋에서 0 건 -- 값은 환경변수로만 push 자식에게 간다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const calls = [];
    const real = seal.defaultGitFn;
    const spy = (args, o) => {
      calls.push({ args: [...args], env: o && o.env ? { ...o.env } : {} });
      return real(args, o);
    };
    const r = cycle(w, T0, { gitFn: spy });
    assert.equal(r.anchorSeal.status, "sealed");
    const pushCalls = calls.filter((c) => c.args.includes("push"));
    assert.equal(pushCalls.length, 1);
    for (const c of calls) {
      assert.ok(
        !c.args.join("\u0001").includes(FAKE_PAT),
        `argv 에 토큰: ${c.args.join(" ")}`,
      );
    }
    // 양성 대조: 토큰은 push 자식의 환경에만 실려 간다 · helper 주입 argv 가 있다.
    assert.equal(pushCalls[0].env.GIT_BOT_PAT, FAKE_PAT);
    assert.ok(
      pushCalls[0].args.some((a) => a.startsWith("credential.helper=!")),
    );
    assert.ok(
      !pushCalls[0].args.some((a) => /--force|-f$|\+refs/.test(a)),
      "force push 흔적",
    );
    assert.ok(!logText(w).includes(FAKE_PAT));
    assert.ok(!JSON.stringify(r.anchorSeal).includes(FAKE_PAT));
    assert.ok(!r.line.includes(FAKE_PAT));
    const all = execFileSync(
      "git",
      ["--git-dir", w.remote, "cat-file", "--batch-all-objects", "--batch"],
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString("utf8");
    assert.ok(!all.includes(FAKE_PAT));
    assert.ok(
      !fs
        .readFileSync(join(w.watchDir, seal.STATE_FILE), "utf8")
        .includes(FAKE_PAT),
    );
    const sealGit = git([
      "--git-dir",
      join(w.sealDir, ".git"),
      "log",
      "--format=%H%n%an%n%ae%n%cn%n%ce%n%B",
    ]);
    assert.ok(!sealGit.includes(FAKE_PAT));
    assert.ok(!sealGit.includes("Codex"), "전역 사람 이름이 커밋에 박혔다");
  });
});

test("⑿ 실패 문구에도 토큰이 없다 -- push 거절 stderr 에 토큰이 섞여 와도 가린다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const real = seal.defaultGitFn;
    const leaky = (args, o) => {
      if (args.includes("push")) {
        return {
          status: 1,
          stdout: "",
          stderr: `fatal: bad creds ${FAKE_PAT} at https://x:${FAKE_PAT}@h/r`,
        };
      }
      return real(args, o);
    };
    const r = cycle(w, T0, { gitFn: leaky });
    assert.equal(r.anchorSeal.failed, true);
    assert.ok(!JSON.stringify(r.anchorSeal).includes(FAKE_PAT));
    assert.ok(!logText(w).includes(FAKE_PAT));
    assert.ok(!r.line.includes(FAKE_PAT));
  });
});

test("⑿ URL 원격 + PAT 파일 없음 -> push 시도 전에 FAILED(자격 없는 URL push 는 하지 않는다)", async () => {
  await withWorldAsync(async (w) => {
    let pushes = 0;
    const r = cycle(w, T0, {
      remote: "https://example.invalid/owner/repo.git",
      patFile: undefined,
      gitFn: (args) => {
        if (args.includes("push")) pushes += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(r.anchorSeal.failed, true);
    assert.equal(pushes, 0);
  });
});

test("⑿ credential.helper 주입 모양이 실제 git 에서 토큰을 환경변수로만 전달한다(git credential fill)", async () => {
  const seal = await loadSeal();
  const authArgs = seal.buildGitAuthArgs();
  assert.ok(authArgs.join(" ").includes("credential.helper="));
  assert.ok(!authArgs.join(" ").includes(FAKE_PAT));
  const env = {
    ...process.env,
    ...seal.buildGitAuthEnv(FAKE_PAT, "codexlocal101-rgb"),
  };
  const out = execFileSync("git", [...authArgs, "credential", "fill"], {
    input: "protocol=https\nhost=example.invalid\n\n",
    env,
    encoding: "utf8",
  });
  assert.match(out, /^username=codexlocal101-rgb$/m);
  assert.match(out, new RegExp(`^password=${FAKE_PAT}$`, "m"));
});

// ---------------------------------------------------------------------------
// 보조: 새 자격 · 전용 디렉터리 안전 · 첫 회차 상태
// ---------------------------------------------------------------------------
test("전용 git 디렉터리는 본체 저장소 · watch 폴더 자체일 수 없다(FAILED · push 0)", async () => {
  await withWorldAsync(async (w) => {
    const r1 = cycle(w, T0, { sealDir: ROOT });
    assert.equal(r1.anchorSeal.failed, true);
    const r2 = cycle(w, T0 + MIN, { sealDir: w.watchDir });
    assert.equal(r2.anchorSeal.failed, true);
    assert.equal(remoteTip(w), null);
  });
});

test("봉인 줄 모양 -- 뿌리 · 시각 · 상태 낱말뿐(이름 · 경로 · 건수 필드 0)", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    cycle(w);
    const line = JSON.parse(remoteSealLines(w)[0]);
    assert.deepEqual(Object.keys(line).sort(), ["at", "roots", "v"]);
    assert.deepEqual(Object.keys(line.roots), [...seal.ANCHOR_TYPE_KEYS]);
    assert.equal(line.at, new Date(T0).toISOString());
    const msg = git([
      "--git-dir",
      w.remote,
      "log",
      "-1",
      "--format=%s",
      "anchor-seal",
    ]).trim();
    assert.equal(msg, `anchor-seal ${new Date(T0).toISOString()}`);
  });
});

test("세션 typed 턴만 잎이 된다 -- typed 아닌 줄은 무시 · 같은 (sessionId, ts) 중복은 한 잎 · 줄이 깨졌으면 read_error", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const srcs = sealOpts(w).sources;
    writeTypedTurns(w, [["2026-11-19T01:00:00.000Z", "typed"]]);
    const base = seal.computeAnchorRoots(srcs).roots.g1;
    writeTypedTurns(w, [
      ["2026-11-19T01:00:00.000Z", "typed"],
      ["2026-11-19T02:00:00.000Z", "paste"],
    ]);
    assert.equal(
      seal.computeAnchorRoots(srcs).roots.g1,
      base,
      "typed 아닌 줄이 뿌리를 바꿨다",
    );
    writeTypedTurns(w, [
      ["2026-11-19T01:00:00.000Z", "typed"],
      ["2026-11-19T01:00:00.000Z", "typed"],
    ]);
    assert.equal(
      seal.computeAnchorRoots(srcs).roots.g1,
      base,
      "중복이 잎을 늘렸다",
    );
    writeTypedTurns(w, [
      ["2026-11-19T01:00:00.000Z", "typed"],
      ["2026-11-19T03:00:00.000Z", "typed"],
    ]);
    assert.notEqual(seal.computeAnchorRoots(srcs).roots.g1, base);
    fs.appendFileSync(
      join(w.sessionsDir, `${SESSION_ID}.jsonl`),
      `{"promptSource":"typed", 깨진 줄\n`,
    );
    assert.equal(seal.computeAnchorRoots(srcs).roots.g1, "read_error");
  });
});

test("파일 이름은 잎에 들어가지 않는다 -- 같은 바이트의 파일 이름만 바꿔도 뿌리가 같다 · 파일 하나가 더 생기면 달라진다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const srcs = sealOpts(w).sources;
    const before = seal.computeAnchorRoots(srcs).roots;
    fs.renameSync(
      join(w.outboxDir, `2026-11-19-1000-${LEAK_NAME}.md`),
      join(w.outboxDir, "2026-11-19-1000-다른이름-게이트1.md"),
    );
    fs.renameSync(
      join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md"),
      join(w.inboxDir, "2026-11-19-1520-상신1530-바뀐이름.md"),
    );
    const renamed = seal.computeAnchorRoots(srcs).roots;
    assert.equal(renamed.g1, before.g1, "이름이 g1 잎에 들어갔다");
    assert.equal(renamed.g7, before.g7, "이름이 g7 잎에 들어갔다");
    fs.writeFileSync(
      join(w.inboxDir, "2026-11-19-1521-상신1531-추가.md"),
      "다른 본문\n",
    );
    assert.notEqual(seal.computeAnchorRoots(srcs).roots.g7, before.g7);
  });
});

test("redactSecret -- 토큰 값은 어떤 문구에서도 가려진다", async () => {
  const seal = await loadSeal();
  assert.equal(
    seal.redactSecret(`a ${FAKE_PAT} b ${FAKE_PAT}`, FAKE_PAT),
    "a *** b ***",
  );
  assert.equal(seal.redactSecret("plain", null), "plain");
});

// ===========================================================================
// HYK-255-s1-anchor-seal-2 (판정 #20261119-2121 · 검토 1R 상신 가·나 수리) -- 2R 칸.
// 검토자 합성 입력(probe.mjs I · J 구역)을 «그대로» 옮겨 고정한다: 열쇠(sessionId·ts)가
// 같고 본문이 다른 두 줄 · 둘째 줄 본문 변경 · 둘째 줄 삭제 · 한 줄 본문 변경 · 봉인 뒤
// 본문 변조 · 거부 원격 4회차. 전부 프로덕션 회차(runWatchOnce)로 구동한다.
// ===========================================================================
const SESSION_ID2 = "f0e1d2c3-aaaa-4bbb-8ccc-dddddddddddd";
const TS_SAME = "2026-11-19T03:00:00.000Z";
// 본문 원문 표지 -- 원격 · 로그 · 상태 파일 · 봉인 줄 어디에도 없어야 한다.
const R2_RAW_MARK = "R2RAWBODY-원문-표지-0042";

function turnLine(body, sid = SESSION_ID, ts = TS_SAME) {
  return JSON.stringify({
    type: "user",
    sessionId: sid,
    timestamp: ts,
    promptSource: "typed",
    message: { content: body },
  });
}

function writeTypedRaw(w, lines, sid = SESSION_ID) {
  fs.writeFileSync(
    join(w.sessionsDir, `${sid}.jsonl`),
    `${lines.join("\n")}\n`,
  );
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

test("R2 ⑴ 열쇠(sessionId·ts)가 같고 본문이 다른 두 줄 -- 둘째 줄 본문을 바꾸면 g1·g7 뿌리가 바뀌고 새 봉인이 올라간다", async () => {
  await withWorldAsync(async (w) => {
    writeTypedRaw(w, [turnLine("BODY-A"), turnLine("BODY-B")]);
    const r1 = cycle(w, T0);
    assert.equal(r1.anchorSeal.status, "sealed");
    writeTypedRaw(w, [turnLine("BODY-A"), turnLine("BODY-B-CHANGED")]);
    const r2 = cycle(w, T0 + 15 * MIN);
    assert.equal(
      r2.anchorSeal.status,
      "sealed",
      "둘째 줄 본문을 고쳤는데 unchanged -- 열쇠만 보고 접었다",
    );
    assert.notEqual(r2.anchorSeal.roots.g1, r1.anchorSeal.roots.g1);
    assert.notEqual(r2.anchorSeal.roots.g7, r1.anchorSeal.roots.g7);
    assert.equal(
      r2.anchorSeal.roots.g2,
      r1.anchorSeal.roots.g2,
      "대조: 원장 뿌리는 그대로",
    );
    assert.equal(remoteCommitCount(w), 2);
    // 양성 대조: 같은 입력을 한 번 더 돌리면 unchanged -- 달라진 것은 본문뿐이다.
    const r3 = cycle(w, T0 + 30 * MIN);
    assert.equal(r3.anchorSeal.status, "unchanged");
  });
});

test("R2 ⑵ 같은 열쇠 두 줄에서 둘째 줄을 지우면 뿌리가 바뀐다(둘은 잎 둘이다)", async () => {
  await withWorldAsync(async (w) => {
    writeTypedRaw(w, [turnLine("BODY-A"), turnLine("BODY-B")]);
    const r1 = cycle(w, T0);
    writeTypedRaw(w, [turnLine("BODY-A")]);
    const r2 = cycle(w, T0 + 15 * MIN);
    assert.equal(
      r2.anchorSeal.status,
      "sealed",
      "둘째 줄을 지웠는데 unchanged -- 둘째 줄이 잎이 아니었다",
    );
    assert.notEqual(r2.anchorSeal.roots.g1, r1.anchorSeal.roots.g1);
    assert.notEqual(r2.anchorSeal.roots.g7, r1.anchorSeal.roots.g7);
    assert.equal(remoteCommitCount(w), 2);
  });
});

test("R2 ⑶ 한 줄만 있을 때 그 줄 본문을 한 글자 고쳐도 뿌리가 바뀐다", async () => {
  await withWorldAsync(async (w) => {
    writeTypedRaw(w, [turnLine("BODY-A")]);
    const r1 = cycle(w, T0);
    writeTypedRaw(w, [turnLine("BODY-A-EDITED")]);
    const r2 = cycle(w, T0 + 15 * MIN);
    assert.equal(
      r2.anchorSeal.status,
      "sealed",
      "본문 편집이 뿌리에 안 닿았다",
    );
    assert.notEqual(r2.anchorSeal.roots.g1, r1.anchorSeal.roots.g1);
    assert.notEqual(r2.anchorSeal.roots.g7, r1.anchorSeal.roots.g7);
    // 열쇠 필드만 바뀐 경우도 바뀐다(대조).
    writeTypedRaw(w, [turnLine("BODY-A-EDITED", SESSION_ID2)]);
    const r3 = cycle(w, T0 + 30 * MIN);
    assert.equal(r3.anchorSeal.status, "sealed");
    assert.notEqual(r3.anchorSeal.roots.g1, r2.anchorSeal.roots.g1);
  });
});

test("R2 ⑷ 봉인 «뒤» 본문을 고치고 다음 회차를 돌리면 결과가 unchanged 가 아니다(원격 봉인 커밋 +1)", async () => {
  await withWorldAsync(async (w) => {
    writeTypedRaw(w, [turnLine("BODY-A")]);
    const sealed = cycle(w, T0);
    assert.equal(sealed.anchorSeal.status, "sealed");
    assert.equal(remoteCommitCount(w), 1);
    writeTypedRaw(w, [turnLine("BODY-A-TAMPERED-AFTER-SEAL")]);
    const after = cycle(w, T0 + MIN);
    assert.notEqual(after.anchorSeal.status, "unchanged");
    assert.equal(after.anchorSeal.status, "sealed");
    assert.equal(remoteCommitCount(w), 2);
    assert.match(lastLogLine(w), /anchor-seal: sealed/);
  });
});

test("R2 ⑸ 같은 바이트 줄 둘(이어하기 복제) = 잎 하나 · 본문 원문 · 본문 해시는 원격 · 로그 · 상태 파일 · 봉인 줄 어디에도 0", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const rawLine = turnLine(R2_RAW_MARK);
    writeTypedRaw(w, [rawLine]);
    const one = cycle(w, T0);
    assert.equal(one.anchorSeal.status, "sealed");
    // 같은 줄이 두 번(이어하기가 줄을 통째로 복제) -> 잎 하나 -> 뿌리 같음 -> unchanged.
    writeTypedRaw(w, [rawLine, rawLine]);
    const dup = cycle(w, T0 + MIN);
    assert.equal(
      dup.anchorSeal.status,
      "unchanged",
      "같은 바이트 줄 복제가 잎을 늘렸다",
    );
    assert.equal(dup.anchorSeal.roots.g1, one.anchorSeal.roots.g1);
    // 같은 줄이 다른 세션 파일에 복제돼도(이어하기 파일) 잎 하나.
    writeTypedRaw(w, [rawLine], SESSION_ID2);
    const copy = cycle(w, T0 + 2 * MIN);
    assert.equal(copy.anchorSeal.status, "unchanged");
    // 비밀 표지 0: 원문 · 본문 해시(줄 원문 바이트의 sha256) 모두.
    const bodyHash = sha256(Buffer.from(rawLine, "utf8"));
    const remoteAll = execFileSync(
      "git",
      ["--git-dir", w.remote, "cat-file", "--batch-all-objects", "--batch"],
      { maxBuffer: 64 * 1024 * 1024 },
    ).toString("utf8");
    assert.ok(
      remoteAll.includes('"roots"'),
      "양성 대조: 봉인 줄이 실제로 있다",
    );
    const stateText = fs.readFileSync(
      join(w.watchDir, seal.STATE_FILE),
      "utf8",
    );
    assert.ok(
      stateText.includes('"last"'),
      "양성 대조: 상태 파일에 뿌리 칸이 있다",
    );
    const places = {
      remote: remoteAll,
      log: logText(w),
      state: stateText,
      sealGit: git(["--git-dir", join(w.sealDir, ".git"), "log", "-p"]),
    };
    for (const [where, text] of Object.entries(places)) {
      assert.ok(!text.includes(R2_RAW_MARK), `${where} 에 본문 원문이 있다`);
      assert.ok(!text.includes(bodyHash), `${where} 에 본문 해시가 있다`);
    }
  });
});

test("R2 ⑸ 잎 바이트 모양 -- 정규 JSON 한 줄 {sessionId, ts, body} · body = 줄 «원문 바이트» sha256(64hex) · 원문은 잎에 없다 · 줄 끝 \\n 만 뺀다", async () => {
  const seal = await loadSeal();
  const raw = turnLine(R2_RAW_MARK);
  const expected = JSON.stringify({
    sessionId: SESSION_ID,
    ts: TS_SAME,
    body: sha256(Buffer.from(raw, "utf8")),
  });
  const leaves = seal.typedTurnLeaves(Buffer.from(`${raw}\n`, "utf8"));
  assert.deepEqual(leaves, [expected]);
  assert.match(JSON.parse(leaves[0]).body, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(JSON.parse(leaves[0])), [
    "sessionId",
    "ts",
    "body",
  ]);
  assert.ok(!leaves[0].includes(R2_RAW_MARK), "잎에 본문 원문이 들어갔다");
  // 줄 끝 규칙: 끝 개행이 없어도 같은 잎 · CRLF 의 \r 은 «뺀다» 가 아니라 줄 바이트로 센다.
  assert.deepEqual(seal.typedTurnLeaves(Buffer.from(raw, "utf8")), [expected]);
  const crlf = seal.typedTurnLeaves(Buffer.from(`${raw}\r\n`, "utf8"));
  assert.equal(
    JSON.parse(crlf[0]).body,
    sha256(Buffer.from(`${raw}\r`, "utf8")),
    "\\r 은 줄 바이트다 -- 해시 입력은 줄 끝 \\n 앞까지",
  );
  // 원문 «바이트» -- 깨진 UTF-8 한 바이트만 달라도 본문 해시가 달라진다(디코드 뒤 문자열이 아님).
  const head = Buffer.from(raw.replace(R2_RAW_MARK, "X"), "utf8");
  const at = head.indexOf("X");
  const withFF = Buffer.concat([
    head.subarray(0, at),
    Buffer.from([0xff]),
    head.subarray(at + 1),
  ]);
  const withFE = Buffer.concat([
    head.subarray(0, at),
    Buffer.from([0xfe]),
    head.subarray(at + 1),
  ]);
  const lf = seal.typedTurnLeaves(Buffer.concat([withFF, Buffer.from("\n")]));
  const le = seal.typedTurnLeaves(Buffer.concat([withFE, Buffer.from("\n")]));
  assert.notEqual(JSON.parse(lf[0]).body, JSON.parse(le[0]).body);
  assert.equal(JSON.parse(lf[0]).body, sha256(withFF));
  // typed 아닌 줄 · promptSource 없는 줄은 잎이 아니다 · 깨진 줄은 null(= read_error).
  const paste = JSON.stringify({
    sessionId: SESSION_ID,
    timestamp: TS_SAME,
    promptSource: "paste",
  });
  assert.deepEqual(
    seal.typedTurnLeaves(Buffer.from(`${paste}\n\n{"x":1}\n`)),
    [],
  );
  assert.equal(
    seal.typedTurnLeaves(Buffer.from('{"promptSource":"typed", 깨진\n')),
    null,
  );
});

test("R2 ⑸ 정규화 고정 -- g1 뿌리는 시험이 독립적으로 다시 접은 값(보내는함 파일 바이트 잎 + typed 턴 JSON 잎)과 같다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const raw = turnLine("BODY-A");
    writeTypedRaw(w, [raw]);
    const leafOf = (type, bytes) =>
      createHash("sha256")
        .update(
          Buffer.concat([
            Buffer.from("hyk255-anchor-seal/v1", "utf8"),
            Buffer.from([0]),
            Buffer.from(type, "utf8"),
            Buffer.from([0]),
            Buffer.from(String(bytes.length), "utf8"),
            Buffer.from([0]),
            bytes,
          ]),
        )
        .digest();
    const outFile = fs.readFileSync(
      join(w.outboxDir, `2026-11-19-1000-${LEAK_NAME}.md`),
    );
    const typedLeaf = Buffer.from(
      JSON.stringify({
        sessionId: SESSION_ID,
        ts: TS_SAME,
        body: sha256(Buffer.from(raw, "utf8")),
      }),
      "utf8",
    );
    const [l1, l2] = [leafOf("g1", outFile), leafOf("g1", typedLeaf)].sort(
      Buffer.compare,
    );
    const expected = createHash("sha256")
      .update(Buffer.concat([Buffer.from([1]), l1, l2]))
      .digest("hex");
    assert.equal(
      seal.computeAnchorRoots(sealOpts(w).sources).roots.g1,
      expected,
    );
  });
});

test("R2 ⑹ 거부 원격 4회차 -- 상태 파일 연속 실패 수 1·2·3·4 · 마지막 실패 시각 · FAILED 줄에 연속 값 · 성공하면 0 · 마지막 성공 시각", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    // 원격이 모든 push 를 거부한다(ref 잠금 파일 -- 셸 훅 없이 · ⑼ 칸과 같은 방식).
    const lock = join(w.remote, "refs", "heads", "anchor-seal.lock");
    fs.mkdirSync(join(w.remote, "refs", "heads"), { recursive: true });
    fs.writeFileSync(lock, "");
    const statePath = join(w.watchDir, seal.STATE_FILE);
    const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (let i = 0; i < 4; i += 1) {
      if (i === 2) fs.appendFileSync(w.northStarFile, "x"); // 검토자 입력: 3 회차에 원천도 바뀐다
      const now = T0 + i * MIN;
      const r = cycle(w, now);
      assert.equal(r.anchorSeal.failed, true, `회차 ${i + 1}`);
      const st = readState();
      assert.equal(st.failStreak, i + 1, `연속 실패 수 (회차 ${i + 1})`);
      assert.equal(
        st.lastFailureAt,
        isoOf(now),
        `마지막 실패 시각 (회차 ${i + 1})`,
      );
      assert.ok(st.lastSuccessAt == null, "성공한 적이 없다");
      assert.match(
        lastLogLine(w),
        new RegExp(
          `anchor-seal: FAILED reason=\\S+ consecutive=${i + 1}(\\s|$)`,
        ),
      );
    }
    assert.equal(remoteTip(w), null, "거부 원격에는 아무것도 안 올라갔다");
    // 성공 1 회 -> 0 으로 돌아가고 마지막 성공 시각이 찍힌다 · 마지막 실패 시각은 남는다.
    fs.rmSync(lock);
    const okNow = T0 + 10 * MIN;
    const ok = cycle(w, okNow);
    assert.equal(ok.anchorSeal.status, "sealed");
    const afterOk = readState();
    assert.equal(afterOk.failStreak, 0);
    assert.equal(afterOk.lastSuccessAt, isoOf(okNow));
    assert.equal(afterOk.lastFailureAt, isoOf(T0 + 3 * MIN));
    assert.ok(afterOk.last, "성공 때 봉인 상태(last)도 같이 전진한다");
    assert.doesNotMatch(lastLogLine(w), /FAILED/);
    // 다시 실패하면 1 부터 센다(이어 세지 않는다).
    fs.writeFileSync(lock, "");
    fs.appendFileSync(w.northStarFile, "y");
    const again = cycle(w, T0 + 20 * MIN);
    assert.equal(again.anchorSeal.failed, true);
    assert.equal(readState().failStreak, 1);
    assert.match(lastLogLine(w), /consecutive=1(\s|$)/);
  });
});

test("R2 ⑹ 실패 뒤 원천이 봉인된 내용으로 돌아오면(unchanged) 연속 실패 수도 0 · 상태 파일 쓰기 실패는 회차를 죽이지 않고 연속 값만 unknown", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    cycle(w, T0); // 봉인
    const lock = join(w.remote, "refs", "heads", "anchor-seal.lock");
    fs.writeFileSync(lock, "");
    const f = join(w.inboxDir, "2026-11-19-1520-상신1530-마커.md");
    const original = fs.readFileSync(f);
    fs.appendFileSync(f, "변경");
    const bad = cycle(w, T0 + MIN);
    assert.equal(bad.anchorSeal.failed, true);
    const statePath = join(w.watchDir, seal.STATE_FILE);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).failStreak, 1);
    fs.writeFileSync(f, original);
    const same = cycle(w, T0 + 2 * MIN);
    assert.equal(same.anchorSeal.status, "unchanged");
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(st.failStreak, 0);
    assert.equal(st.lastSuccessAt, isoOf(T0 + 2 * MIN));
    // 상태 파일을 쓸 수 없는 회차: 실패 기록도 못 쓰지만 단계 실패는 FAILED 로 남는다(원인은 가리지 않는다).
    fs.appendFileSync(f, "또");
    const noWrite = cycle(
      w,
      T0 + 3 * MIN,
      {},
      {
        writeFn: (p, ...a) => {
          if (String(p).includes(seal.STATE_FILE))
            throw new Error("EPERM-state-sim");
          return fs.writeFileSync(p, ...a);
        },
      },
    );
    assert.equal(noWrite.anchorSeal.failed, true);
    assert.match(
      lastLogLine(w),
      /anchor-seal: FAILED reason=\S+ consecutive=unknown/,
    );
  });
});

// ⑺ 읽기 실패 칸(검토 1R P2-1 · 변이 V4 메우기) -- «맞는 이름의 파일 하나» 를 읽을 수 없으면
// 그 유형은 read_error 다(읽힌 나머지로 «완전한 것처럼» 접지 않는다).
function failingReadIo(suffix, code) {
  return {
    readFileFn: (file, ...rest) => {
      if (String(file).endsWith(suffix)) {
        throw Object.assign(new Error(`${code}: 합성 읽기 실패`), { code });
      }
      return fs.readFileSync(file, ...rest);
    },
  };
}

test("R2 ⑺ 받는함 «상신» 파일 하나를 읽을 수 없으면(EACCES · 나머지는 읽힘) g7 = read_error · g1 은 영향 없음 · 풀리면 새 뿌리로 봉인", async () => {
  await withWorldAsync(async (w) => {
    fs.writeFileSync(
      join(w.inboxDir, "2026-11-19-1521-상신1531-읽기불가.md"),
      "둘째 상신\n",
    );
    const bad = cycle(w, T0, { srcIo: failingReadIo("읽기불가.md", "EACCES") });
    assert.equal(bad.anchorSeal.status, "sealed");
    assert.equal(bad.anchorSeal.roots.g7, "read_error");
    assert.match(bad.anchorSeal.roots.g1, /^[0-9a-f]{64}$/);
    assert.match(lastLogLine(w), /anchor-seal: sealed none=\d+ read_error=1/);
    const fixed = cycle(w, T0 + 15 * MIN);
    assert.equal(fixed.anchorSeal.status, "sealed");
    assert.match(fixed.anchorSeal.roots.g7, /^[0-9a-f]{64}$/);
  });
});

test("R2 ⑺ 보내는함 «게이트1» 파일 하나를 읽을 수 없으면 g1 = read_error · g7 은 영향 없음 · 읽다가 사라진 파일(ENOENT)도 none 이 아니라 read_error", async () => {
  await withWorldAsync(async (w) => {
    fs.writeFileSync(
      join(w.outboxDir, "2026-11-19-1001-둘째-게이트1-읽기불가.md"),
      "둘째 게이트1\n",
    );
    for (const code of ["EACCES", "ENOENT"]) {
      const r = cycle(w, T0, { srcIo: failingReadIo("읽기불가.md", code) });
      assert.equal(r.anchorSeal.roots.g1, "read_error", code);
      assert.match(r.anchorSeal.roots.g7, /^[0-9a-f]{64}$/, code);
      assert.notEqual(r.anchorSeal.roots.g1, "none", code);
      fs.rmSync(w.watchDir, { recursive: true, force: true });
      fs.rmSync(w.sealDir, { recursive: true, force: true });
      fs.rmSync(w.remote, { recursive: true, force: true });
      git(["init", "--bare", "-q", w.remote]);
    }
  });
});

test("R2 ⑻ 봉인 뒤 변조가 드러나는 길 -- anchor-seal.mjs 머리에 적힌 대조 명령 한 줄이 실제로 돈다(변조 전 전부 match · 변조 뒤 g1·g7 mismatch)", async () => {
  const src = fs.readFileSync(
    join(ROOT, "scripts", "supervisor", "anchor-seal.mjs"),
    "utf8",
  );
  const m = src.match(
    /^\/\/ {2,}git show origin\/anchor-seal:seal\.jsonl \| node --input-type=module -e "([^"]+)" (.+)$/m,
  );
  assert.ok(m, "머리 주석에 대조 명령 한 줄이 없다");
  assert.match(m[2], /보내는함.*받는함.*원장.*세션.*북극성/);
  await withWorldAsync(async (w) => {
    writeTypedRaw(w, [turnLine("BODY-A")]);
    cycle(w, T0);
    const journal = remoteSealText(w);
    assert.ok(journal.includes('"roots"'));
    const s = sealOpts(w).sources;
    const args = [
      s.outboxDir,
      s.inboxDir,
      s.ledgerDir,
      s.sessionsDirs[0],
      s.northStarFile,
    ];
    const run = () =>
      execFileSync(
        process.execPath,
        ["--input-type=module", "-e", m[1], ...args],
        {
          cwd: ROOT,
          input: journal,
          encoding: "utf8",
        },
      )
        .trim()
        .split("\n");
    const before = run();
    assert.equal(before.length, 1, "봉인 줄 하나 -> 출력 한 줄");
    const [, beforeJson] = before[0].split(" ");
    assert.deepEqual(Object.values(JSON.parse(beforeJson)), [
      "match",
      "match",
      "match",
      "match",
      "match",
    ]);
    writeTypedRaw(w, [turnLine("BODY-A-TAMPERED-AFTER-SEAL")]); // 봉인 뒤 한 줄 변조(회차 안 돌림)
    const after = JSON.parse(run()[0].split(" ")[1]);
    assert.equal(after.g1, "mismatch");
    assert.equal(after.g7, "mismatch");
    assert.equal(after.g2, "match");
  });
});

// ---------------------------------------------------------------------------
// ⒀ 봉인 단계 순서 (HYK-255-s1-seal-order-1 · 판정 #20261120-1424 3 · 선행 조건 #20261119-2121)
// ---------------------------------------------------------------------------
// «봉인을 켜도 감시 회차의 sweep · wake 가 봉인의 망 호출 때문에 늦어지지 않는다».
// 전부 프로덕션 회차(`runWatchOnce`)로 구동한다. 호출 순서는 seam 이 기록한다:
//   sweep = sweepExecFn 호출(orca 좌석 조회) · wake = wake 영수증 appendFn 호출 ·
//   seal-start = 봉인 단계가 가장 먼저 하는 일(상태 파일 읽기) · seal-git = 봉인의 git 호출.
// repoRoot 는 합성 디렉터리다 -- 실제 체크아웃의 `.harness` 나 상태를 읽지 않는다(ⓗ ⑵).
// 기준 시각 T0 는 위에서 UTC 로 고정했고 이 칸들은 로컬 시각 생성자 · 접근자 · toLocale 에
// 기대지 않는다(ⓗ ⑴).
function makeOrderWorld() {
  const w = makeWorld();
  w.repoRoot = join(w.root, "synthetic-repo");
  w.admDir = join(w.root, "adm");
  w.ledgerPath = join(w.admDir, "ledger.json");
  w.lockPath = join(w.admDir, "ledger.lock");
  w.wakeStatePath = join(w.root, "wake", "wake-state.json");
  w.wakeLogPath = join(w.root, "wake", "wake-log.jsonl");
  fs.mkdirSync(w.repoRoot, { recursive: true });
  fs.mkdirSync(w.admDir, { recursive: true });
  // wake 는 watch.log 를 «읽을 수 있어야» 영수증을 남긴다(없으면 읽기 실패로 일찍 끝난다).
  // 빈 로그를 미리 둔다 -- 이 회차의 줄은 finalize 단계에서 비로소 덧붙는다.
  fs.mkdirSync(w.watchDir, { recursive: true });
  fs.writeFileSync(join(w.watchDir, "watch.log"), "");
  fs.writeFileSync(
    w.ledgerPath,
    JSON.stringify({
      schema_version: ADMISSION_SCHEMA_VERSION,
      epoch: "2026-08-01T00:00:00.000Z",
      reservations: {},
    }),
  );
  return w;
}

function withOrderWorld(fn) {
  const w = makeOrderWorld();
  try {
    return fn(w);
  } finally {
    fs.rmSync(w.root, { recursive: true, force: true });
  }
}

// sweep · wake · (선택) 봉인을 모두 켠 한 회차. 돌려주는 것 = 회차 결과 + 호출 순서 기록.
// sealGit(args, opts, events) 가 있으면 봉인 단계가 켜진다(그 함수가 봉인의 git seam).
function orderCycle(w, { sealGit, sealOptsValue } = {}) {
  const events = [];
  const readFn = (p, enc) => {
    if (String(p).endsWith("anchor-seal-state.json")) events.push("seal-start");
    return fs.readFileSync(p, enc);
  };
  const appendFn = (p, data, enc) => {
    if (p === w.wakeLogPath) events.push("wake");
    return fs.appendFileSync(p, data, enc);
  };
  const sweepExecFn = () => {
    events.push("sweep");
    return { ok: true, result: { terminals: [] } };
  };
  const anchorSealArg = sealGit
    ? {
        anchorSeal: sealOpts(w, {
          gitFn: (args, o) => {
            events.push("seal-git");
            return sealGit(args, o, events);
          },
        }),
      }
    : sealOptsValue === undefined
      ? {}
      : { anchorSeal: sealOptsValue };
  const result = runWatchOnce({
    repoRoot: w.repoRoot,
    watchDir: w.watchDir,
    now: T0,
    capPath: w.capPath,
    execFn: () => OK_DETECTOR,
    readFn,
    appendFn,
    sweepExecFn,
    admissionSweep: { ledgerPath: w.ledgerPath, lockPath: w.lockPath },
    wake: { statePath: w.wakeStatePath, wakeLogPath: w.wakeLogPath },
    ...anchorSealArg,
  });
  return { result, events };
}

// 두 세계의 줄을 맞대려면 세계마다 다른 경로(cap_source)를 같은 자리표시자로 바꾼다.
function normLine(w, line) {
  return line.split(w.capPath).join("@CAP@");
}

const ETIMEDOUT_ERR = () =>
  Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function assertSealAfterSweepAndWake(events) {
  const sweep = events.indexOf("sweep");
  const wake = events.indexOf("wake");
  const sealStart = events.indexOf("seal-start");
  const sealGit = events.indexOf("seal-git");
  assert.ok(sweep >= 0, `sweep 이 기록되지 않았다: ${events.join(",")}`);
  assert.ok(wake >= 0, `wake 가 기록되지 않았다: ${events.join(",")}`);
  assert.ok(sealStart >= 0, `봉인 단계가 안 돌았다: ${events.join(",")}`);
  assert.ok(sealGit >= 0, `봉인 git 이 안 불렸다: ${events.join(",")}`);
  assert.ok(sweep < wake, `sweep 이 wake 보다 먼저여야 한다: ${events}`);
  assert.ok(wake < sealStart, `wake 가 봉인보다 먼저여야 한다: ${events}`);
  assert.ok(sealStart < sealGit, `봉인 시작이 봉인 git 보다 먼저: ${events}`);
  assert.ok(
    events.lastIndexOf("wake") < sealStart &&
      events.lastIndexOf("sweep") < sealStart,
    `sweep · wake 의 모든 호출이 봉인 시작보다 앞이어야 한다: ${events}`,
  );
}

test("⒀ ⑴ 켠 회차의 호출 순서 = sweep → wake → 봉인(상태 읽기 → git) · 봉인은 둘 어느 것보다도 앞서지 않는다", () => {
  withOrderWorld((w) => {
    const { result, events } = orderCycle(w, {
      sealGit: () => ({ status: 1, stdout: "", stderr: "stop-here" }),
    });
    assertSealAfterSweepAndWake(events);
    assert.equal(result.sweepResult.notRun, false);
    assert.equal(result.sweepResult.ok, true);
    assert.equal(result.wakeResult.notRun, false);
    assert.equal(result.anchorSeal.notRun, false);
  });
});

test("⒀ ⑵ 봉인 git 이 느려도(망 한도까지 걸린 흉내) 봉인 시작 «전» 에 sweep · wake 는 이미 끝나 있고 · 결과와 회차 줄이 그대로다", () => {
  let snap = null;
  const slow = (_args, _o, events) => {
    if (snap === null) {
      snap = {
        events: [...events],
        wakeReceipt: fs.existsSync(wakeLogPathOf.path)
          ? fs.readFileSync(wakeLogPathOf.path, "utf8")
          : null,
        logText: fs.readFileSync(
          join(wakeLogPathOf.watchDir, "watch.log"),
          "utf8",
        ),
      };
    }
    sleepMs(120);
    return { status: null, stdout: "", stderr: "", error: ETIMEDOUT_ERR() };
  };
  const wakeLogPathOf = { path: "", watchDir: "" };
  withOrderWorld((off) => {
    const baseline = orderCycle(off).result;
    withOrderWorld((w) => {
      wakeLogPathOf.path = w.wakeLogPath;
      wakeLogPathOf.watchDir = w.watchDir;
      const t0 = Date.now();
      const { result, events } = orderCycle(w, { sealGit: slow });
      assert.ok(Date.now() - t0 >= 120, "느린 seam 이 실제로 돌았다");
      // 봉인의 첫 git 호출 «순간» 에 sweep · wake 는 이미 일을 끝냈다.
      assert.ok(snap, "봉인 git seam 이 불리지 않았다");
      assert.ok(snap.events.includes("sweep"), `sweep 미완: ${snap.events}`);
      assert.ok(snap.events.includes("wake"), `wake 미완: ${snap.events}`);
      assert.ok(snap.wakeReceipt && snap.wakeReceipt.includes('"verdict"'));
      // 회차 줄은 봉인 결과를 담아 조립되므로(구간 자리 무변) 그 순간엔 아직 덧붙지 않았다.
      assert.equal(snap.logText, "");
      assertSealAfterSweepAndWake(events);
      // 결과: 봉인은 FAILED 로 끝났어도 sweep · wake 결과는 그대로다.
      assert.equal(result.anchorSeal.failed, true);
      assert.equal(result.sweepResult.status, "SWEEP_TRIGGER_SWEPT");
      assert.equal(result.wakeResult.notRun, false);
      // 줄 = (봉인 없이 같은 입력으로 돈 회차의 줄) + 맨 끝 `anchor-seal:` 구간 -- 형식 무변.
      const offLine = normLine(off, baseline.line);
      const onLine = normLine(w, result.line);
      assert.ok(onLine.startsWith(`${offLine} anchor-seal: FAILED reason=`));
      assert.match(
        onLine.slice(offLine.length),
        /^ anchor-seal: FAILED reason=\S*ETIMEDOUT\S* consecutive=1$/,
      );
      assert.equal(lastLogLine(w), result.line);
    });
  });
});

test("⒀ ⑵ 봉인 git 이 던져도 sweep · wake 결과는 회차 기록에 이미 있고 회차 줄 · 생존 기록이 남는다", () => {
  withOrderWorld((off) => {
    const baseline = orderCycle(off).result;
    withOrderWorld((w) => {
      const { result, events } = orderCycle(w, {
        sealGit: () => {
          throw new Error("boom-from-order-seam");
        },
      });
      assertSealAfterSweepAndWake(events);
      assert.equal(result.anchorSeal.failed, true);
      assert.equal(result.sweepResult.status, "SWEEP_TRIGGER_SWEPT");
      assert.equal(result.wakeResult.notRun, false);
      const offLine = normLine(off, baseline.line);
      const onLine = normLine(w, result.line);
      assert.ok(onLine.startsWith(`${offLine} anchor-seal: FAILED reason=`));
      assert.match(onLine, /boom-from-order-seam/);
      assert.equal(lastLogLine(w), result.line);
      assert.ok(fs.existsSync(join(w.watchDir, "last-run.json")));
      assert.ok(fs.existsSync(w.wakeLogPath), "wake 영수증이 남아 있다");
    });
  });
});

test("⒀ ⑶ 기본 꺼짐(인자 없음 · null · undefined) -> 줄 바이트 같음 · 봉인 흔적 0 · git 0 · sweep → wake 순서는 그대로", () => {
  const lines = [];
  for (const sealOptsValue of [undefined, null]) {
    withOrderWorld((w) => {
      const { result, events } = orderCycle(w, { sealOptsValue });
      lines.push(normLine(w, result.line));
      assert.ok(!result.line.includes("anchor-seal"));
      assert.equal(result.anchorSeal.notRun, true);
      // 봉인은 상태 파일도 읽지 않고(seal-start 0) git 도 부르지 않는다(seal-git 0).
      assert.ok(!events.includes("seal-start"), events.join(","));
      assert.ok(!events.includes("seal-git"), events.join(","));
      assert.ok(
        events.indexOf("sweep") < events.indexOf("wake"),
        events.join(","),
      );
      assert.ok(!fs.existsSync(w.sealDir), "전용 git 디렉터리가 만들어졌다");
      assert.ok(
        !fs.readdirSync(w.watchDir).some((n) => n.includes("anchor-seal")),
        "봉인 흔적 파일이 생겼다",
      );
    });
  }
  assert.equal(lines.length, 2);
  assert.equal(lines[0], lines[1]);
});

test("⒀ ⑷ 망 호출 한도 = 30 초가 실제 spawn 옵션 timeout 으로 전달된다(기본 git 함수 seam)", async () => {
  const seal = await loadSeal();
  assert.equal(seal.GIT_CALL_TIMEOUT_MS, 30_000);
  const seen = [];
  const res = seal.defaultGitFn(["--version"], {
    cwd: os.tmpdir(),
    spawnFn: (cmd, args, o) => {
      seen.push({ cmd, args, o });
      return { status: 0, stdout: "git version x", stderr: "", error: null };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cmd, "git");
  assert.deepEqual(seen[0].args, ["--version"]);
  assert.equal(seen[0].o.timeout, 30_000);
  assert.equal(res.status, 0);
});

// 봉인 한 회차의 git 호출 수를 회차 모양별로 잰다(실제 runAnchorSealOnce 경로 + 실제 기본
// git 함수 + 실제 git · mkdtemp 로컬 bare 원격). 호출 수 칸과 상한 칸이 같은 실측을 쓴다.
async function measureSealCallCounts(seal) {
  let counts = [];
  await withWorldAsync(async (w) => {
    counts = [];
    const counting = () => {
      let n = 0;
      return {
        fn: (args, o) => {
          n += 1;
          return seal.defaultGitFn(args, o);
        },
        n: () => n,
      };
    };
    // 가: 원격에 가지가 없는 첫 봉인 · 나: 원천을 바꾼 둘째 봉인(원격 끝 있음) ·
    // 다: 상태 파일과 전용 git 디렉터리를 «둘 다» 잃은 뒤(원격 끝을 이어받는다 · merge-base 없음) ·
    // 라: 전용 git 디렉터리만 잃고 상태 파일(lastCommit)은 남은 뒤(init 과 merge-base 가 «함께»
    //     나오는 가장 긴 경로 -- init 은 «전용 디렉터리 없음», merge-base 는 «상태에 lastCommit +
    //     원격 끝 있음» 으로 정해져 서로 독립이다).
    const a = counting();
    cycle(w, T0, { gitFn: a.fn });
    counts.push(a.n());
    fs.appendFileSync(w.northStarFile, "changed\n");
    const b = counting();
    cycle(w, T0 + MIN, { gitFn: b.fn });
    counts.push(b.n());
    fs.rmSync(w.sealDir, { recursive: true, force: true });
    fs.rmSync(join(w.watchDir, "anchor-seal-state.json"), { force: true });
    fs.appendFileSync(w.northStarFile, "changed-again\n");
    const c = counting();
    cycle(w, T0 + 2 * MIN, { gitFn: c.fn });
    counts.push(c.n());
    fs.rmSync(w.sealDir, { recursive: true, force: true });
    fs.appendFileSync(w.northStarFile, "changed-third\n");
    const d = counting();
    cycle(w, T0 + 3 * MIN, { gitFn: d.fn });
    counts.push(d.n());
  });
  return counts;
}

test("⒀ ⑷ 회차 호출 수 -- 봉인 한 회차의 git 호출은 모양별 정확한 값 [9, 10, 10, 11] · 최대 11 번", async () => {
  const seal = await loadSeal();
  const counts = await measureSealCallCounts(seal);
  // 가 9 번(init · symbolic-ref · ls-remote · rev-parse · read-tree · add · commit · rev-parse ·
  // push) · 나 10 번(symbolic-ref · ls-remote · fetch · merge-base · update-ref · reset · add ·
  // commit · rev-parse · push) · 다 10 번(init · symbolic-ref · ls-remote · fetch · update-ref ·
  // reset · add · commit · rev-parse · push) · 라 11 번(init · symbolic-ref · ls-remote · fetch ·
  // merge-base · update-ref · reset · add · commit · rev-parse · push). init 과 merge-base 는
  // 서로 독립이라 «전용 디렉터리만 잃은» 회차에서 함께 나오고, 그때가 한 회차 최대(11 번)다.
  // 이 값이 바뀌면(git 호출이 늘면) 아래 상한 칸의 계산이 달라지므로 «정확한 값» 으로 못 박는다.
  assert.deepEqual(counts, [9, 10, 10, 11]);
  assert.equal(Math.max(...counts), 11);
});

// 쌍: 위 호출 수 칸이 못 박은 최대 11 이 이 상한 칸의 «최악 호출 수» 다 -- 한쪽을 바꾸면 다른 쪽 계산도 같이 본다.
test("⒀ ⑷ 회차 최악 시간 상한 -- 최악 호출 수 × 호출 한도 < 생존 기록 신선도 기본 한도(두 상수에서 계산 · 손 숫자 0)", async () => {
  const seal = await loadSeal();
  const { DEFAULT_STALE_AFTER_SECONDS } = await import("./schedule-wire.mjs");
  assert.equal(
    typeof DEFAULT_STALE_AFTER_SECONDS,
    "number",
    "schedule-wire.mjs 가 DEFAULT_STALE_AFTER_SECONDS 를 export 하지 않는다",
  );
  const worstCalls = Math.max(...(await measureSealCallCounts(seal)));
  const worstMs = worstCalls * seal.GIT_CALL_TIMEOUT_MS;
  const staleMs = DEFAULT_STALE_AFTER_SECONDS * 1000;
  assert.ok(
    worstMs < staleMs,
    `회차 최악 ${worstCalls} × ${seal.GIT_CALL_TIMEOUT_MS}ms = ${worstMs}ms 가 생존 기록 신선도 한도 ${staleMs}ms 이상이다`,
  );
});

// ---------------------------------------------------------------------------
// ⒁ 봉인 선행 수리 둘 (HYK-255-seal-orphan-1 · 판정 #20261123-0654 · #20261123-0725)
// ---------------------------------------------------------------------------
// ① 멎은 망 호출이 «고아 git» 을 남기지 않게 진짜 git 이 스스로 끝나는 저속 한도(env 로 운반) ·
// ② git 은 0 으로 끝났는데 손자가 관을 쥐어 30 초 한도에 닿은 «성공을 실패로» 판정(status 0 +
// ETIMEDOUT) 을 종료 코드 전용 호출에서만 성공으로 바로잡는 순수 분류기 -- 의 시험이다.
// 전부 합성: mkdtemp · `git init --bare` 원격 · 127.0.0.1 루프백. ⛔실제 원격 호출 0 · 실제 PAT
// 파일 읽기 0 · 실제 `.harness` 읽기 0 · 봉인은 여전히 꺼져 있다(`--anchor-seal-remote` 는 어디에도
// 없다). I · R 칸은 프로덕션 `runAnchorSealOnce` → 회차 `run` → 실제 `defaultGitFn` 경로를 그대로
// 지난다(덧입히는 것은 결과 모양뿐이고 그 모양이 실제로 있다는 것은 R1 이 실제 git 으로 보인다).
// 기대값은 시험 안에서 손으로 정한 값이다(분류기로 기대값을 만들지 않는다).

// 봉인 한 회차(프로덕션 진입점). repoRoot 는 합성 디렉터리다(실제 체크아웃을 읽지 않는다).
function sealOnce(seal, w, now, gitFn) {
  return seal.runAnchorSealOnce({
    ...sealOpts(w, gitFn ? { gitFn } : {}),
    repoRoot: join(w.root, "synthetic-repo"),
    watchDir: w.watchDir,
    now,
  });
}

function sealFailure(seal, w, now, gitFn) {
  try {
    sealOnce(seal, w, now, gitFn);
  } catch (err) {
    return err;
  }
  return assert.fail("회차가 던져야 한다(FAILED)");
}

// git 인자에서 하위 명령 이름을 뽑는다(앞의 --git-dir · --work-tree · -c 쌍은 건너뛴다).
function gitSubOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i]);
    if (a === "--git-dir" || a === "--work-tree" || a === "-c") {
      i += 1;
    } else if (!a.startsWith("-")) {
      return a;
    }
  }
  return null;
}

// 실제 defaultGitFn 에 «위임» 한 뒤 지정한 호출의 결과에만 모양을 덧입힌다(실제 git 이 실제로
// 돈다 · 덧입힌 호출 수를 hits 로 센다 -- 헛시험 차단).
function overlayGitFn(seal, match, shape) {
  const fn = (args, o) => {
    const real = seal.defaultGitFn(args, o);
    fn.calls.push(gitSubOf(args));
    if (!match(gitSubOf(args), args)) return real;
    fn.hits += 1;
    return shape(real);
  };
  fn.calls = [];
  fn.hits = 0;
  return fn;
}

const asExitedButTimedOut = (real) => ({ ...real, error: ETIMEDOUT_ERR() });
const asKilledAndTimedOut = (real) => ({
  ...real,
  status: null,
  error: ETIMEDOUT_ERR(),
});
const asKilledNoError = (real) => ({ ...real, status: null, error: null });

function lowSpeedKeysOff(fn) {
  const saved = {};
  for (const k of ["GIT_HTTP_LOW_SPEED_LIMIT", "GIT_HTTP_LOW_SPEED_TIME"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function waitPidGone(pid, limitMs) {
  const until = Date.now() + limitMs;
  while (isPidAlive(pid) && Date.now() < until) sleepMs(100);
  return !isPidAlive(pid);
}

// ── T1 분류기 진리표 18칸 ──────────────────────────────────────────────
// E = 종료 코드 전용 호출(push) · O = 출력을 쓰는 호출(rev-parse). 칸마다 allowFail 두 값.
const T1_SUB = { E: "push", O: "rev-parse" };
const T1_ENOENT = /git \S+ start failed: ENOENT/;
const T1_KILLED = /git \S+ killed/;
const T1_TIMEOUT = /git \S+ timeout: ETIMEDOUT/;
const T1_UNTRUSTED = /git \S+ output untrusted after timeout/;
const T1_EXIT1_LATE = /git \S+ exit 1 after timeout/;
const T1_EXIT1 = /git \S+ exit 1(:|$)/;
// [번호, status, error code, 종류, allowFail=false 기대, allowFail=true 기대]
// 기대: {lingering: n} = 던지지 않고 돌려줌(lingering n) · {throws: 정규식} = 던짐
const T1_ROWS = [
  [1, 0, null, "E", { lingering: 0 }, { lingering: 0 }],
  [2, 0, null, "O", { lingering: 0 }, { lingering: 0 }],
  [3, 1, null, "E", { throws: T1_EXIT1 }, { lingering: 0 }],
  [4, 1, null, "O", { throws: T1_EXIT1 }, { lingering: 0 }],
  [5, null, null, "E", { throws: T1_KILLED }, { throws: T1_KILLED }],
  [6, null, null, "O", { throws: T1_KILLED }, { throws: T1_KILLED }],
  [7, 0, "ETIMEDOUT", "E", { lingering: 1 }, { lingering: 1 }],
  [8, 0, "ETIMEDOUT", "O", { throws: T1_UNTRUSTED }, { throws: T1_UNTRUSTED }],
  [
    9,
    1,
    "ETIMEDOUT",
    "E",
    { throws: T1_EXIT1_LATE },
    { throws: T1_EXIT1_LATE },
  ],
  [
    10,
    1,
    "ETIMEDOUT",
    "O",
    { throws: T1_EXIT1_LATE },
    { throws: T1_EXIT1_LATE },
  ],
  [11, null, "ETIMEDOUT", "E", { throws: T1_TIMEOUT }, { throws: T1_TIMEOUT }],
  [12, null, "ETIMEDOUT", "O", { throws: T1_TIMEOUT }, { throws: T1_TIMEOUT }],
  [13, 0, "ENOENT", "E", { throws: T1_ENOENT }, { throws: T1_ENOENT }],
  [14, 0, "ENOENT", "O", { throws: T1_ENOENT }, { throws: T1_ENOENT }],
  [15, 1, "ENOENT", "E", { throws: T1_ENOENT }, { throws: T1_ENOENT }],
  [16, 1, "ENOENT", "O", { throws: T1_ENOENT }, { throws: T1_ENOENT }],
  [17, null, "ENOENT", "E", { throws: T1_ENOENT }, { throws: T1_ENOENT }],
  [18, null, "ENOENT", "O", { throws: T1_ENOENT }, { throws: T1_ENOENT }],
];

for (const [no, status, code, kind, noAllow, withAllow] of T1_ROWS) {
  test(`⒁ T1 #${no} 분류기 진리표 -- status ${status} · error ${code ?? "없음"} · ${kind === "E" ? "종료 코드 전용(E)" : "출력 사용(O)"} · allowFail 두 값`, async () => {
    const seal = await loadSeal();
    for (const [allowFail, expected] of [
      [false, noAllow],
      [true, withAllow],
    ]) {
      const res = {
        status,
        stdout: "",
        stderr: "boom",
        error: code ? Object.assign(new Error(code), { code }) : null,
      };
      const call = () =>
        seal.classifyGitResult(res, { sub: T1_SUB[kind], allowFail });
      const label = `#${no} allowFail=${allowFail}`;
      if (expected.throws) {
        assert.throws(call, expected.throws, label);
      } else {
        const verdict = call();
        assert.equal(verdict.lingering, expected.lingering, label);
        assert.equal(verdict.res.status, status, label);
      }
    }
  });
}

test("⒁ T2 종료 코드 전용 목록 = 정확히 열 개 · 목록 밖(foo · ls-remote · rev-parse)은 7번 모양에서도 던진다", async () => {
  const seal = await loadSeal();
  assert.deepEqual([...seal.GIT_EXIT_ONLY_SUBCOMMANDS].sort(), [
    "add",
    "commit",
    "fetch",
    "init",
    "merge-base",
    "push",
    "read-tree",
    "reset",
    "symbolic-ref",
    "update-ref",
  ]);
  const shape7 = {
    status: 0,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
  };
  for (const sub of ["foo", "ls-remote", "rev-parse"]) {
    assert.throws(
      () => seal.classifyGitResult(shape7, { sub, allowFail: false }),
      /output untrusted after timeout/,
      sub,
    );
  }
  // 목록 안은 같은 모양에서 성공 + lingering 1.
  for (const sub of seal.GIT_EXIT_ONLY_SUBCOMMANDS) {
    assert.equal(
      seal.classifyGitResult(shape7, { sub, allowFail: false }).lingering,
      1,
      sub,
    );
  }
});

// ── I1~I7 실제 git · mkdtemp bare 원격 · 결과 모양만 덧입힘 ───────────────
test("⒁ I1 push 가 status 0 + ETIMEDOUT -> sealed + lingering=1 · 다음 회차 unchanged · 원격 봉인 줄 정확히 +1", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const gitFn = overlayGitFn(seal, (s) => s === "push", asExitedButTimedOut);
    const r1 = sealOnce(seal, w, T0, gitFn);
    assert.equal(gitFn.hits, 1, "덧입힌 push 가 정확히 1 번 불렸다");
    assert.equal(r1.status, "sealed");
    assert.ok(r1.segment.startsWith("anchor-seal: sealed none="), r1.segment);
    assert.ok(r1.segment.endsWith(" lingering=1"), r1.segment);
    assert.equal(remoteSealLines(w).length, 1);
    const r2 = sealOnce(seal, w, T0 + MIN);
    assert.equal(r2.status, "unchanged");
    assert.equal(remoteSealLines(w).length, 1, "봉인 줄 중복 0");
    assert.equal(remoteCommitCount(w), 1);
  });
});

test("⒁ I2 ls-remote 가 status 0 + ETIMEDOUT -> FAILED(출력 불신) · push 전이라 다음 회차 sealed · 원격 줄 1", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const gitFn = overlayGitFn(
      seal,
      (s) => s === "ls-remote",
      asExitedButTimedOut,
    );
    const err = sealFailure(seal, w, T0, gitFn);
    assert.equal(gitFn.hits, 1);
    assert.match(err.message, /git ls-remote output untrusted after timeout/);
    assert.equal(err.consecutiveFailures, 1);
    assert.equal(remoteSealLines(w).length, 0, "push 전이라 원격 줄 0");
    const r2 = sealOnce(seal, w, T0 + MIN);
    assert.equal(r2.status, "sealed");
    assert.equal(remoteSealLines(w).length, 1);
  });
});

test("⒁ I3 fetch 가 status 0 + ETIMEDOUT -> 회차가 이어져 sealed + lingering=1 · 평소 회차의 구간에는 lingering 이 없다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const r1 = sealOnce(seal, w, T0);
    assert.equal(r1.status, "sealed");
    assert.ok(!r1.segment.includes("lingering"), r1.segment);
    fs.appendFileSync(w.northStarFile, "changed\n");
    const gitFn = overlayGitFn(seal, (s) => s === "fetch", asExitedButTimedOut);
    const r2 = sealOnce(seal, w, T0 + MIN, gitFn);
    assert.equal(gitFn.hits, 1, "원격 끝이 있어 fetch 가 불렸다");
    assert.equal(r2.status, "sealed");
    assert.ok(r2.segment.endsWith(" lingering=1"), r2.segment);
    assert.equal(remoteSealLines(w).length, 2);
  });
});

test("⒁ I4 rev-parse HEAD 가 status 0 + ETIMEDOUT -> FAILED(출력 불신) · push 전이라 다음 회차 sealed · 원격 줄 1", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const gitFn = overlayGitFn(
      seal,
      (s, args) => s === "rev-parse" && args.includes("HEAD"),
      asExitedButTimedOut,
    );
    const err = sealFailure(seal, w, T0, gitFn);
    assert.equal(gitFn.hits, 1);
    assert.match(err.message, /git rev-parse output untrusted after timeout/);
    assert.equal(remoteSealLines(w).length, 0);
    const r2 = sealOnce(seal, w, T0 + MIN);
    assert.equal(r2.status, "sealed");
    assert.equal(remoteSealLines(w).length, 1);
  });
});

test("⒁ I5 KNOWN GAP -- push 를 실제로 한 뒤 status null + ETIMEDOUT -> FAILED · 다음 회차는 같은 뿌리 줄을 하나 더 쓴다(원격 줄 2 · 알려진 중복)", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const gitFn = overlayGitFn(seal, (s) => s === "push", asKilledAndTimedOut);
    const err = sealFailure(seal, w, T0, gitFn);
    assert.equal(gitFn.hits, 1);
    assert.match(err.message, /git push timeout: ETIMEDOUT/);
    assert.equal(remoteSealLines(w).length, 1, "push 는 실제로 올라갔다");
    const r2 = sealOnce(seal, w, T0 + MIN);
    assert.equal(r2.status, "sealed");
    const lines = remoteSealLines(w);
    assert.equal(lines.length, 2, "알려진 구멍: 같은 뿌리 줄이 하나 더");
    assert.deepEqual(JSON.parse(lines[0]).roots, JSON.parse(lines[1]).roots);
  });
});

test("⒁ I6 init 이 status 0 + ETIMEDOUT -> 분류기를 지나 회차가 이어져 sealed + lingering=1(init 도 같은 분류기)", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const gitFn = overlayGitFn(seal, (s) => s === "init", asExitedButTimedOut);
    const r1 = sealOnce(seal, w, T0, gitFn);
    assert.equal(gitFn.hits, 1, "전용 git 디렉터리가 없어 init 이 불렸다");
    assert.equal(r1.status, "sealed");
    assert.ok(r1.segment.endsWith(" lingering=1"), r1.segment);
    assert.equal(remoteSealLines(w).length, 1);
  });
});

test("⒁ I7 rev-parse --verify 가 status null(오류 없음) -> «가지 없음» 으로 읽지 않고 FAILED · 다음 회차 sealed", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const gitFn = overlayGitFn(
      seal,
      (s, args) => s === "rev-parse" && args.includes("--verify"),
      asKilledNoError,
    );
    const err = sealFailure(seal, w, T0, gitFn);
    assert.equal(gitFn.hits, 1);
    assert.match(err.message, /git rev-parse killed/);
    assert.equal(err.consecutiveFailures, 1);
    assert.equal(remoteSealLines(w).length, 0);
    const r2 = sealOnce(seal, w, T0 + MIN);
    assert.equal(r2.status, "sealed");
    assert.equal(remoteSealLines(w).length, 1);
  });
});

// ── T3 env 운반 · T4 관계식 ───────────────────────────────────────────
test("⒁ T3 env -- 망 3호출(ls-remote · fetch · push)의 env 에만 GIT_HTTP_LOW_SPEED_LIMIT=1000 · TIME=15 · 로컬 호출 env 는 수리 전과 같다 · -c 로는 안 싣는다", async () => {
  const seal = await loadSeal();
  await withWorldAsync(async (w) => {
    const recorded = [];
    const gitFn = (args, o) => {
      recorded.push({
        sub: gitSubOf(args),
        args: [...args],
        env: { ...o.env },
      });
      return seal.defaultGitFn(args, o);
    };
    lowSpeedKeysOff(() => {
      // 로컬 호출 env 기대값 -- 손으로 만든 값(프로덕션 정리 함수를 쓰지 않는다).
      const localEnv = { ...process.env };
      for (const k of [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_PREFIX",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
      ]) {
        delete localEnv[k];
      }
      localEnv.GIT_TERMINAL_PROMPT = "0";
      sealOnce(seal, w, T0, gitFn);
      fs.appendFileSync(w.northStarFile, "changed\n");
      sealOnce(seal, w, T0 + MIN, gitFn);
      const net = recorded.filter((c) =>
        ["ls-remote", "fetch", "push"].includes(c.sub),
      );
      const local = recorded.filter((c) => !net.includes(c));
      assert.deepEqual([...new Set(net.map((c) => c.sub))].sort(), [
        "fetch",
        "ls-remote",
        "push",
      ]);
      assert.equal(net.length, 5, "첫 회차 2(ls-remote · push) + 둘째 회차 3");
      assert.ok(local.length >= 14, `로컬 호출 ${local.length}`);
      for (const c of net) {
        assert.equal(c.env.GIT_HTTP_LOW_SPEED_LIMIT, "1000", c.sub);
        assert.equal(c.env.GIT_HTTP_LOW_SPEED_TIME, "15", c.sub);
        assert.equal(c.env.GIT_BOT_PAT, FAKE_PAT, c.sub);
        const rest = { ...c.env };
        for (const k of [
          "GIT_HTTP_LOW_SPEED_LIMIT",
          "GIT_HTTP_LOW_SPEED_TIME",
          "GIT_BOT_PAT",
          "GIT_BOT_USER",
        ]) {
          delete rest[k];
        }
        assert.deepEqual(rest, localEnv, `${c.sub}: 두 키 밖의 env 는 그대로`);
      }
      for (const c of local) {
        const rest = { ...c.env };
        delete rest.GIT_AUTHOR_DATE;
        delete rest.GIT_COMMITTER_DATE;
        assert.deepEqual(rest, localEnv, `${c.sub}: 로컬 호출 env 무변`);
        assert.ok(!("GIT_HTTP_LOW_SPEED_LIMIT" in c.env), c.sub);
        assert.ok(!("GIT_HTTP_LOW_SPEED_TIME" in c.env), c.sub);
      }
      for (const c of recorded) {
        assert.ok(
          !c.args.some((a) => /lowSpeed/i.test(String(a))),
          `${c.sub}: -c 운반 금지`,
        );
      }
    });
  });
});

test("⒁ T4 관계 -- 저속 한도 시간 × 1000 × 2 <= 호출 한도(두 상수에서 계산) · 값 고정 1000 B/s · 15 초", async () => {
  const seal = await loadSeal();
  assert.equal(seal.GIT_HTTP_LOW_SPEED_LIMIT_BPS, 1000);
  assert.equal(seal.GIT_HTTP_LOW_SPEED_TIME_S, 15);
  assert.ok(
    seal.GIT_HTTP_LOW_SPEED_TIME_S * 1000 * 2 <= seal.GIT_CALL_TIMEOUT_MS,
    `${seal.GIT_HTTP_LOW_SPEED_TIME_S} s × 2 가 호출 한도 ${seal.GIT_CALL_TIMEOUT_MS} ms 를 넘는다`,
  );
});

// ── R1 실물 모양 · R2 멎은 서버 ───────────────────────────────────────
test(
  "⒁ R1 실물 모양 -- 실제 defaultGitFn + 별칭 `!node gc & exit 0`: git 은 0 으로 끝났는데 status 0 + ETIMEDOUT · 걸린 시간 ≥ 한도 · 손자를 치운 뒤 남는 프로세스 0",
  {
    timeout: 120_000,
  },
  async (t) => {
    const seal = await loadSeal();
    const dir = fs.mkdtempSync(join(os.tmpdir(), "hyk255r1-"));
    const pidFile = join(dir, "gc.pid");
    const gcFile = join(dir, "gc.cjs");
    // 손자: 자기 pid 를 적고 상속받은 stdout 을 쥔 채 90 초 뒤 스스로 끝난다(시험이 먼저 치운다).
    fs.writeFileSync(
      gcFile,
      [
        'const fs = require("node:fs");',
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        'process.stdout.write("gc-start\\n");',
        "setTimeout(() => process.exit(0), 90000);",
        "",
      ].join("\n"),
    );
    const fwd = (p) => p.split("\\").join("/");
    const gcCmd = `"${fwd(process.execPath)}" "${fwd(gcFile)}" "${fwd(pidFile)}"`;
    let gcPid = null;
    let gcGone = false;
    try {
      const t0 = process.hrtime.bigint();
      const res = seal.defaultGitFn(
        ["-c", `alias.zz=!${gcCmd} & exit 0`, "zz"],
        {
          cwd: dir,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        },
      );
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
      gcPid = Number(fs.readFileSync(pidFile, "utf8"));
      const observed = { status: res.status, code: res.error?.code, elapsedMs };
      t.diagnostic(`R1 ${JSON.stringify({ ...observed, gcPid })}`);
      assert.equal(res.status, 0, JSON.stringify(observed));
      assert.equal(res.error?.code, "ETIMEDOUT", JSON.stringify(observed));
      assert.ok(
        elapsedMs >= seal.GIT_CALL_TIMEOUT_MS - 100,
        `걸린 시간 ${elapsedMs} ms 가 한도 ${seal.GIT_CALL_TIMEOUT_MS} ms 보다 짧다`,
      );
      assert.ok(Number.isInteger(gcPid) && gcPid > 0, "손자 pid 가 기록됐다");
      assert.ok(isPidAlive(gcPid), "치우기 전에는 손자가 관을 쥔 채 살아 있다");
      // 실물 모양이 분류기에서 «성공 + lingering» 으로 읽힌다(종료 코드 전용 호출일 때).
      assert.equal(
        seal.classifyGitResult(res, { sub: "push", allowFail: false })
          .lingering,
        1,
      );
    } finally {
      if (gcPid === null) {
        try {
          gcPid = Number(fs.readFileSync(pidFile, "utf8"));
        } catch {
          gcPid = null;
        }
      }
      if (gcPid) {
        try {
          process.kill(gcPid);
        } catch {
          // 이미 끝났다.
        }
        gcGone = waitPidGone(gcPid, 10_000);
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 폴더 정리 실패는 시험 결과가 아니다.
      }
    }
    assert.ok(gcPid, "손자 pid 를 얻지 못했다");
    assert.ok(gcGone, `손자 pid ${gcPid} 가 아직 살아 있다`);
  },
);

const R2_SERVER_SRC = [
  'const net = require("node:net");',
  'const fs = require("node:fs");',
  "const log = process.argv[2];",
  "const server = net.createServer((sock) => {",
  '  fs.appendFileSync(log, "open " + Date.now() + "\\n");',
  '  sock.on("data", () => {});',
  '  sock.on("error", () => {});',
  '  sock.on("close", () => fs.appendFileSync(log, "close " + Date.now() + "\\n"));',
  "});",
  'server.listen(0, "127.0.0.1", () => {',
  '  process.stdout.write("port " + server.address().port + "\\n");',
  "});",
  'process.stdin.on("end", () => process.exit(0));',
  "process.stdin.resume();",
  "setTimeout(() => process.exit(0), 150000);",
  "",
].join("\n");

function r2DriverSource(sealUrl, params) {
  return [
    `import { runAnchorSealOnce } from ${JSON.stringify(sealUrl)};`,
    `const params = ${JSON.stringify(params)};`,
    "const t0 = process.hrtime.bigint();",
    "let out;",
    "try {",
    "  const r = runAnchorSealOnce(params);",
    "  out = { threw: null, status: r.status };",
    "} catch (err) {",
    "  out = { threw: String(err && err.message) };",
    "}",
    "out.elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;",
    'process.stdout.write("R2-RESULT " + JSON.stringify(out) + "\\n");',
    "",
  ].join("\n");
}

function readServerPort(server) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("R2 서버가 포트를 알리지 않았다")),
      10_000,
    );
    server.stdout.on("data", (d) => {
      buf += String(d);
      const m = /port (\d+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    server.on("exit", () => reject(new Error("R2 서버가 먼저 종료됐다")));
  });
}

// 드라이버(자식 node) env -- 프록시 제거 · 루프백은 프록시 제외 · 시스템/전역 git 설정 무시 ·
// 저속 한도 env 는 «프로덕션 run 이 싣는 것만» 쓰도록 물려받은 값을 지운다(TZ 는 물려받는다).
function r2DriverEnv(emptyGlobal) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(https?|all)_proxy$/i.test(k)) delete env[k];
  }
  env.NO_PROXY = "127.0.0.1";
  env.no_proxy = "127.0.0.1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = emptyGlobal;
  delete env.GIT_HTTP_LOW_SPEED_LIMIT;
  delete env.GIT_HTTP_LOW_SPEED_TIME;
  return env;
}

// 서버 자식 정리 -- 종료 이벤트와 pid 소멸을 «관측» 해 돌려준다.
async function stopR2Server(server, serverExit) {
  server.stdin.end();
  server.kill();
  const exitInfo = await Promise.race([
    serverExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  server.stdout.destroy();
  return { exitInfo, gone: waitPidGone(server.pid, 5_000) };
}

function parseServerLog(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const rows = text
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" "));
  return {
    opens: rows.filter((r) => r[0] === "open").map((r) => Number(r[1])),
    closes: rows.filter((r) => r[0] === "close").map((r) => Number(r[1])),
  };
}

test(
  "⒁ R2 멎은 서버 -- 127.0.0.1 에서 받고 아무것도 안 보내는 서버 · 진짜 git 이 저속 한도로 스스로 끝난다: `git ls-remote exit <n>` · 걸린 시간 < 30 s · 서버가 연결 close 를 기록(망을 쥔 프로세스 종료) · 서버 자식 종료",
  {
    timeout: 180_000,
  },
  async (t) => {
    const seal = await loadSeal();
    const dir = fs.mkdtempSync(join(os.tmpdir(), "hyk255r2-"));
    const serverLog = join(dir, "server.log");
    const serverFile = join(dir, "server.cjs");
    const driverFile = join(dir, "driver.mjs");
    const patFile = join(dir, "fake-bot-pat.txt");
    const emptyGlobal = join(dir, "empty-gitconfig");
    const northStar = join(dir, "north-star.md");
    fs.writeFileSync(serverFile, R2_SERVER_SRC);
    fs.writeFileSync(patFile, `${FAKE_PAT}\n`);
    fs.writeFileSync(emptyGlobal, "");
    fs.writeFileSync(northStar, "r2 north star\n");
    const server = spawn(process.execPath, [serverFile, serverLog], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    const serverExit = new Promise((resolve) => {
      server.on("exit", (code, signal) => resolve({ code, signal }));
    });
    let stopped;
    try {
      const port = await readServerPort(server);
      fs.writeFileSync(
        driverFile,
        r2DriverSource(new URL("./anchor-seal.mjs", import.meta.url).href, {
          remote: `http://127.0.0.1:${port}/x.git`,
          patFile,
          sealDir: join(dir, "seal-git"),
          watchDir: join(dir, "watch"),
          repoRoot: join(dir, "synthetic-repo"),
          now: T0,
          sources: { northStarFile: northStar },
        }),
      );
      const child = spawnSync(process.execPath, [driverFile], {
        encoding: "utf8",
        windowsHide: true,
        env: r2DriverEnv(emptyGlobal),
        timeout: 90_000,
      });
      const m = /R2-RESULT (.*)/.exec(child.stdout ?? "");
      assert.ok(m, `드라이버 출력 없음: ${child.stdout} ${child.stderr}`);
      const result = JSON.parse(m[1]);
      // 서버가 연결 close 를 적을 시간(드라이버 종료 직후)을 잠깐 준다.
      let log = parseServerLog(serverLog);
      for (let i = 0; i < 50 && log.closes.length < log.opens.length; i += 1) {
        sleepMs(100);
        log = parseServerLog(serverLog);
      }
      const label = JSON.stringify({ result, log });
      t.diagnostic(`R2 ${label}`);
      assert.match(String(result.threw), /^git ls-remote exit \d+/, label);
      assert.ok(
        result.elapsedMs < seal.GIT_CALL_TIMEOUT_MS,
        `걸린 시간 ${result.elapsedMs} ms 가 호출 한도 ${seal.GIT_CALL_TIMEOUT_MS} ms 이상이다 · ${label}`,
      );
      assert.ok(log.opens.length >= 1, `서버가 연결을 받지 못했다 · ${label}`);
      assert.equal(
        log.closes.length,
        log.opens.length,
        `닫히지 않은 연결이 남았다(고아) · ${label}`,
      );
    } finally {
      stopped = await stopR2Server(server, serverExit);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 폴더 정리 실패는 시험 결과가 아니다.
      }
    }
    assert.ok(stopped.exitInfo, "R2 서버 자식이 종료되지 않았다");
    assert.ok(stopped.gone, "R2 서버 pid 가 살아 있다");
  },
);
