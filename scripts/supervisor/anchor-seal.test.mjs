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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as watchRun from "./watch-run.mjs";

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
// 로컬 날짜가 TZ 와 무관하게 2026-11-19 가 되도록 «로컬 생성자» 로 만든다.
const T0 = new Date(2026, 10, 19, 10, 0, 0).getTime();
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

test("⑴ 스위치 없음 -> watch.log 줄이 base 와 바이트 같다 · 단계 미실행 · 봉인 흔적 파일 0", () => {
  withWorld((w) => {
    const before = fs.existsSync(w.watchDir) ? fs.readdirSync(w.watchDir) : [];
    const r = runWatchOnce({
      repoRoot: ROOT,
      watchDir: w.watchDir,
      now: T0,
      capPath: w.capPath,
      execFn: () => OK_DETECTOR,
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

test("redactSecret -- 토큰 값은 어떤 문구에서도 가려진다", async () => {
  const seal = await loadSeal();
  assert.equal(
    seal.redactSecret(`a ${FAKE_PAT} b ${FAKE_PAT}`, FAKE_PAT),
    "a *** b ***",
  );
  assert.equal(seal.redactSecret("plain", null), "plain");
});
