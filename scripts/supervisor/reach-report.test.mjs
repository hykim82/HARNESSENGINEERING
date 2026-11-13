// HYK-191-reach-1 (coder-task.md §5, §7) -- reach-report.mjs wire 계약
// 시험. ★모든 경로는 이 시험이 만든 mkdtemp 격리 디렉터리다 -- 실
// 관제실(`D:/문서관리/하네스-관제실`)·실 받는함(`D:/문서관리/통역/받는함`)
// 미접촉(coder-task.md §5 비타협). 이 시험이 실제로 그 두 실경로를
// 건드리지 않는다는 것은 reach-report-realpath-invariance.test.mjs가
// 바이트 단위로 재확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReachOnce } from "./reach-report.mjs";

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function watchLogLine({
  ts,
  idleVerdict = "NONE",
  idleStatus = "SEAT_IDLE_NOT_APPLICABLE",
}) {
  return (
    `${ts} exit=0 verdict=PROGRESSING reason=OK ` +
    `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
    `idle_status=${idleStatus} idle_verdict=${idleVerdict} idle_worst_count=NONE idle_worktrees=1 ` +
    `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
    `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`
  );
}

test("(a)(b) real repro paths: writes a non-blank report file + prints text with an explicit open anomaly and its duration (1/1)", () => {
  const root = tmpDir("nc-reach-wire-");
  try {
    const watchLogPath = join(root, "watch.log");
    const reportOutPath = join(root, "morning-report.md");
    const statePath = join(root, "state.json");
    const notifyDir = join(root, "받는함");
    const t0 = Date.parse("2026-08-05T00:00:00.000Z");
    fs.writeFileSync(
      watchLogPath,
      [
        watchLogLine({
          ts: new Date(t0).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
        watchLogLine({
          ts: new Date(t0 + 3_600_000).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
      ].join("\n"),
      "utf8",
    );
    const result = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0 + 3_600_000,
    });
    assert.match(result.reportText, /좌석 유휴 방치/);
    assert.match(result.reportText, /1시간 0분째/);
    const written = fs.readFileSync(reportOutPath, "utf8");
    assert.equal(written, result.reportText);
    assert.ok(written.trim().length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(c) transition writes a notice file into notifyDir on first open, second identical tick writes NO second notice file (2/2)", () => {
  const root = tmpDir("nc-reach-notify-");
  try {
    const watchLogPath = join(root, "watch.log");
    const reportOutPath = join(root, "morning-report.md");
    const statePath = join(root, "state.json");
    const notifyDir = join(root, "받는함");
    const t0 = Date.parse("2026-08-05T00:00:00.000Z");

    fs.writeFileSync(
      watchLogPath,
      watchLogLine({
        ts: new Date(t0).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
      "utf8",
    );
    const first = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0,
    });
    assert.equal(
      first.toNotify.length,
      1,
      "first tick: newly opened -> notified",
    );
    assert.ok(first.noticePath, "a notice file must have been written");
    assert.ok(fs.existsSync(first.noticePath));
    const filesAfterFirst = fs.readdirSync(notifyDir);
    assert.equal(filesAfterFirst.length, 1);

    // same anomaly, second tick 15 minutes later -- still SUSPECTED_ABANDONED
    fs.appendFileSync(
      watchLogPath,
      "\n" +
        watchLogLine({
          ts: new Date(t0 + 15 * 60000).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
    );
    const second = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0 + 15 * 60000,
    });
    assert.equal(
      second.toNotify.length,
      0,
      "(d) second tick: same ongoing anomaly -> no repeat notice",
    );
    const filesAfterSecond = fs.readdirSync(notifyDir);
    assert.equal(
      filesAfterSecond.length,
      1,
      "still exactly one notice file after the second tick",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("(b) no anomalies at all -> report explicitly says 없음, and no notice file is written (2/2)", () => {
  const root = tmpDir("nc-reach-clean-");
  try {
    const watchLogPath = join(root, "watch.log");
    const reportOutPath = join(root, "morning-report.md");
    const statePath = join(root, "state.json");
    const notifyDir = join(root, "받는함");
    const t0 = Date.parse("2026-08-05T00:00:00.000Z");
    fs.writeFileSync(
      watchLogPath,
      watchLogLine({ ts: new Date(t0).toISOString() }),
      "utf8",
    );
    const result = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath,
      notifyDir,
      now: t0,
    });
    assert.match(result.reportText, /없음/);
    assert.equal(result.toNotify.length, 0);
    assert.equal(result.noticePath, null);
    assert.equal(
      fs.existsSync(notifyDir),
      false,
      "notifyDir is not even created when there is nothing to notify",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing watch.log (not yet written) does not throw -- report still renders, explicitly says 없음 (1/1)", () => {
  const root = tmpDir("nc-reach-missing-");
  try {
    const result = runReachOnce({
      watchLogPath: join(root, "does-not-exist.log"),
      reportOutPath: join(root, "morning-report.md"),
      statePath: join(root, "state.json"),
      notifyDir: join(root, "받는함"),
      now: Date.now(),
    });
    assert.match(result.reportText, /없음/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-ln-github-anchor-1 (coder-task.md §2 ⓒ) -- «외부 독립 증거 후보:
// 확인 N» 의 N 이 바뀔 때만 받는함 통지 1장. 프로덕션 runReachOnce 를
// mkdtemp 격리 경로(합성 partial-count-report.md · 합성 상태 파일 · 합성
// 받는함)로 직접 구동한다.
// ---------------------------------------------------------------------------

function writeReachFixture(root, extLine) {
  const watchLogPath = join(root, "watch.log");
  const t0 = Date.parse("2026-11-12T00:00:00.000Z");
  if (!fs.existsSync(watchLogPath)) {
    fs.writeFileSync(
      watchLogPath,
      watchLogLine({ ts: new Date(t0).toISOString() }),
      "utf8",
    );
  }
  const partialCountPath = join(root, "partial-count-report.md");
  fs.writeFileSync(
    partialCountPath,
    [
      "집계 성격: PARTIAL — 전수 아님",
      "생성 시각: 2026-11-12 09:00:00 KST",
      "ㄴ 계획 밖 개입:",
      "- 외부 독립 증거로 확인된 사건: 확인 0건",
      ...(extLine === null ? [] : [extLine]),
      "관측 건강:",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    watchLogPath,
    partialCountPath,
    reportOutPath: join(root, "morning-report.md"),
    statePath: join(root, "state.json"),
    notifyDir: join(root, "받는함"),
    now: t0 + 3_600_000,
  };
}

function tick(fx, extLine, nowOffsetMs = 0) {
  writeReachFixture(fx.root, extLine);
  return runReachOnce({
    watchLogPath: fx.watchLogPath,
    partialCountPath: fx.partialCountPath,
    reportOutPath: fx.reportOutPath,
    statePath: fx.statePath,
    notifyDir: fx.notifyDir,
    now: fx.now + nowOffsetMs,
  });
}

function noticeFiles(fx) {
  return fs.existsSync(fx.notifyDir) ? fs.readdirSync(fx.notifyDir) : [];
}

const EXT = (n, u = 0) =>
  `- 외부 독립 증거 후보: 확인 ${n} · 미조회 ${u} · 분류 대기`;

test("외부 독립 증거 후보 N: 처음 0 은 기준선(통지 0장) · 0->1 변화는 통지 1장 · 같은 1 반복은 0장 · 1->2 는 또 1장", () => {
  const root = tmpDir("nc-reach-ext-");
  try {
    const fx = { ...writeReachFixture(root, EXT(0)), root };
    const first = tick(fx, EXT(0));
    assert.equal(first.noticePath, null, "기준선 0 -- 통지 없음");
    assert.equal(noticeFiles(fx).length, 0);

    const changed = tick(fx, EXT(1, 2), 1000);
    assert.ok(changed.noticePath, "0->1 변화 -- 통지 1장");
    assert.equal(noticeFiles(fx).length, 1);
    const body = fs.readFileSync(changed.noticePath, "utf8");
    assert.match(body, /외부 독립 증거 후보/);
    assert.match(body, /0 -> 1/);
    assert.match(body, /분류 대기/);

    const same = tick(fx, EXT(1, 5), 2000);
    assert.equal(same.noticePath, null, "N 무변(U 만 바뀜) -- 통지 0장");
    assert.equal(noticeFiles(fx).length, 1);

    const up = tick(fx, EXT(2), 3000);
    assert.ok(up.noticePath);
    assert.equal(noticeFiles(fx).length, 2);
    assert.match(fs.readFileSync(up.noticePath, "utf8"), /1 -> 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("외부 독립 증거 후보 N: 첫 관측부터 N>0 이면 «이전 없음 -> N» 변화로 통지 1장 (과소통지보다 과대통지)", () => {
  const root = tmpDir("nc-reach-ext-first-");
  try {
    const fx = { ...writeReachFixture(root, EXT(3)), root };
    const first = tick(fx, EXT(3));
    assert.ok(first.noticePath);
    assert.equal(noticeFiles(fx).length, 1);
    assert.equal(tick(fx, EXT(3), 1000).noticePath, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("외부 독립 증거 후보: 수집 실패 줄 · 줄 없음 은 N 변화가 아니다 -- 통지 0장이고 이전 N 은 기억된다", () => {
  const root = tmpDir("nc-reach-ext-fail-");
  try {
    const fx = { ...writeReachFixture(root, EXT(1)), root };
    assert.ok(tick(fx, EXT(1)).noticePath);
    assert.equal(noticeFiles(fx).length, 1);
    assert.equal(
      tick(fx, "- 외부 독립 증거 후보: 수집 실패(x)", 1000).noticePath,
      null,
    );
    assert.equal(tick(fx, null, 2000).noticePath, null);
    assert.equal(
      tick(fx, EXT(1), 3000).noticePath,
      null,
      "실패를 사이에 두고 돌아와도 같은 N 이면 0장",
    );
    assert.equal(noticeFiles(fx).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("외부 독립 증거 후보 N 변화 + 새 이상 전이가 같은 tick 에 겹쳐도 통지 파일은 1장이고 상태 파일에 두 기억이 함께 남는다", () => {
  const root = tmpDir("nc-reach-ext-both-");
  try {
    const fx = { ...writeReachFixture(root, EXT(1)), root };
    const t0 = Date.parse("2026-11-12T00:00:00.000Z");
    fs.writeFileSync(
      fx.watchLogPath,
      watchLogLine({
        ts: new Date(t0).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
      "utf8",
    );
    const r = tick(fx, EXT(1));
    assert.equal(r.toNotify.length, 1);
    assert.ok(r.noticePath);
    assert.equal(noticeFiles(fx).length, 1);
    const body = fs.readFileSync(r.noticePath, "utf8");
    assert.match(body, /외부 독립 증거 후보/);
    assert.match(body, /좌석 유휴 방치/);
    const state = JSON.parse(fs.readFileSync(fx.statePath, "utf8"));
    assert.ok(Object.keys(state).length >= 2, JSON.stringify(state));
    // 다음 tick: 둘 다 무변 -> 0장.
    assert.equal(tick(fx, EXT(1), 1000).noticePath, null);
    assert.equal(noticeFiles(fx).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-g-aux-render-1 커밋 3 (D1 검토 P2-4) -- 통지 표면: N 변화만 있는 tick 의
// 머리 문구는 «이상 전이 통지» 가 아니고, N 변화 절은 마무리 줄 «이 파일이 정본
// 입니다 …» 앞에 온다. 통지 조건 · 장 수는 무변(위 시험들이 그대로 단언한다).
// ---------------------------------------------------------------------------

const CLOSING_LINE_PREFIX = "이 파일이 정본입니다";
const OLD_ANOMALY_HEADER = "이상 전이 통지";

function nonEmptyLines(text) {
  return text.split("\n").filter((l) => l.trim() !== "");
}

test("P2-4: N 변화만 있는 tick 의 통지 머리는 «이상 전이 통지» 가 아니라 부분 계수 변화 통지다", () => {
  const root = tmpDir("nc-reach-p24-head-");
  try {
    const fx = { ...writeReachFixture(root, EXT(0)), root };
    tick(fx, EXT(0));
    const changed = tick(fx, EXT(1, 2), 1000);
    assert.equal(changed.toNotify.length, 0, "이상 전이 없이 N 변화만");
    const body = fs.readFileSync(changed.noticePath, "utf8");
    const head = body.split("\n")[0];
    assert.ok(head.startsWith("# "), head);
    assert.ok(!head.includes(OLD_ANOMALY_HEADER), `머리가 낡은 문구: ${head}`);
    assert.ok(head.includes("부분 계수 변화 통지"), head);
    assert.ok(!body.includes("새로 열린 이상"), "이상 절은 없다");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("P2-4: N 변화 절은 마무리 줄 «이 파일이 정본입니다 …» 앞에 온다 (N 변화만 · 이상 전이와 겹침 둘 다)", () => {
  const root = tmpDir("nc-reach-p24-order-");
  try {
    const fx = { ...writeReachFixture(root, EXT(0)), root };
    tick(fx, EXT(0));
    const only = fs.readFileSync(tick(fx, EXT(1, 2), 1000).noticePath, "utf8");
    const onlyLines = nonEmptyLines(only);
    assert.ok(
      onlyLines.at(-1).startsWith(CLOSING_LINE_PREFIX),
      onlyLines.at(-1),
    );
    assert.ok(
      only.indexOf("외부 독립 증거 후보") < only.indexOf(CLOSING_LINE_PREFIX),
      "N 변화 절이 마무리 줄 뒤에 있다",
    );
    assert.equal(
      only.split(CLOSING_LINE_PREFIX).length - 1,
      1,
      "마무리 줄은 1개",
    );

    // 겹침: 새 이상 전이 + N 변화 -> 머리는 이상 전이 통지 그대로, 순서는 같다.
    const root2 = tmpDir("nc-reach-p24-both-");
    try {
      const fx2 = { ...writeReachFixture(root2, EXT(1)), root: root2 };
      const t0 = Date.parse("2026-11-12T00:00:00.000Z");
      fs.writeFileSync(
        fx2.watchLogPath,
        watchLogLine({
          ts: new Date(t0).toISOString(),
          idleStatus: "SEAT_IDLE_JUDGED",
          idleVerdict: "SUSPECTED_ABANDONED",
        }),
        "utf8",
      );
      const both = tick(fx2, EXT(1));
      const bothBody = fs.readFileSync(both.noticePath, "utf8");
      assert.ok(bothBody.split("\n")[0].includes(OLD_ANOMALY_HEADER));
      assert.ok(nonEmptyLines(bothBody).at(-1).startsWith(CLOSING_LINE_PREFIX));
      assert.ok(
        bothBody.indexOf("좌석 유휴 방치") <
          bothBody.indexOf("외부 독립 증거 후보") &&
          bothBody.indexOf("외부 독립 증거 후보") <
            bothBody.indexOf(CLOSING_LINE_PREFIX),
        "이상 절 -> N 변화 절 -> 마무리 줄 순서",
      );
    } finally {
      fs.rmSync(root2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("P2-4: 통지 조건 · 장 수는 무변 -- 이상 전이만 있는 tick 의 통지 머리는 그대로 «이상 전이 통지», N 변화가 없으면 0장", () => {
  const root = tmpDir("nc-reach-p24-anom-");
  try {
    const fx = { ...writeReachFixture(root, null), root };
    const t0 = Date.parse("2026-11-12T00:00:00.000Z");
    fs.writeFileSync(
      fx.watchLogPath,
      watchLogLine({
        ts: new Date(t0).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
      "utf8",
    );
    const r = tick(fx, null);
    assert.equal(r.toNotify.length, 1);
    const body = fs.readFileSync(r.noticePath, "utf8");
    assert.ok(body.split("\n")[0].includes(OLD_ANOMALY_HEADER));
    assert.ok(!body.includes("외부 독립 증거 후보"));
    assert.equal(noticeFiles(fx).length, 1);
    assert.equal(tick(fx, null, 1000).noticePath, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
