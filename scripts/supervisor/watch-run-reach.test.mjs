// HYK-191-reach-1 (coder-task.md §1 요건3, §7) -- watch-run.mjs가 매
// 예약 tick마다 reach 단계(reach-report.mjs)를 실제로 부르는지 확인하는
// 결선 시험. 기존 watch-run.test.mjs는 건드리지 않는다(회귀 0 -- 기존
// 시험은 notifyDir을 안 주므로 이 조각 추가 전후로 동작이 완전히 같다,
// watch-run.test.mjs 재실행으로 이미 확인됨). ★모든 경로는 mkdtemp.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runWatchOnce } from "./watch-run.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const NOW_MS = Date.parse("2026-08-05T00:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-watch-run-reach-"));
}

function idleAbandonedExec() {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    seatIdle: {
      status: "SEAT_IDLE_JUDGED",
      verdict: "SUSPECTED_ABANDONED",
      worstCount: 1,
      totalWorktrees: 1,
    },
  });
}

test("notifyDir supplied: a run whose detector output is anomalous writes a notice file + a morning-report.md inside watchDir (2/2)", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = join(watchDir, "받는함-테스트");
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => idleAbandonedExec(),
      notifyDir,
    });
    assert.equal(result.reachResult.notRun, undefined);
    assert.equal(result.reachResult.failed, undefined);
    assert.ok(
      result.reachResult.noticePath,
      "a transition notice must be written on first anomalous run",
    );
    assert.ok(fs.existsSync(result.reachResult.noticePath));
    assert.ok(fs.existsSync(join(watchDir, "morning-report.md")));
    assert.match(
      fs.readFileSync(join(watchDir, "morning-report.md"), "utf8"),
      /좌석 유휴 방치/,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("notifyDir omitted (default): reach step is skipped entirely -- no morning-report.md, no notice dir created (2/2)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => idleAbandonedExec(),
    });
    assert.equal(result.reachResult.notRun, true);
    assert.equal(fs.existsSync(join(watchDir, "morning-report.md")), false);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// HYK-198-capwire-2 §2-5 행동 증명: "코드를 넣었다"가 아니라 "값 파일을
// 못 읽는 상태를 만들면 아침 보고(또는 통지)에 그것이 실제로 나타난다"를
// 시험으로 고정한다. 실 관제실 파일 미접촉 -- capPath를 mkdtemp 경로에
// 명시 주입해 존재하지 않는 값 파일을 가리키게 한다.
test("HYK-198-capwire-2 §2: an unreadable concurrency-cap.json surfaces in the morning report AND fires a notice, through the real production entry point (2/2)", () => {
  const watchDir = tmpWatchDir();
  const notifyDir = join(watchDir, "받는함-cap-테스트");
  const missingCapPath = join(watchDir, "does-not-exist-concurrency-cap.json");
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
      notifyDir,
      capPath: missingCapPath,
    });
    assert.equal(result.capResult.status, "CAP_READ_FAILED");
    assert.ok(
      result.reachResult.noticePath,
      "a transition notice must be written on first cap-read-failure",
    );
    const reportText = fs.readFileSync(
      join(watchDir, "morning-report.md"),
      "utf8",
    );
    assert.match(reportText, /동시 실행 상한 읽기 실패/);
    assert.match(reportText, /FILE_UNREADABLE/);
    const noticeText = fs.readFileSync(result.reachResult.noticePath, "utf8");
    assert.match(noticeText, /동시 실행 상한 읽기 실패/);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// §2-4 검토자 지적("cap_verdict=DECIDED는 판정한 것처럼 보이지만 아무
// 정보도 안 나른다")에 대한 구조적 보장을 정상 경로에서도 확인한다 --
// cap이 정상(읽기 성공)이면 "DECIDED"라는 문자열이 아침 보고 어디에도
// 나타나지 않아야 한다(별도 은폐 코드 없이, badVerdicts를 비워 둔
// 설계 자체가 이를 보장한다는 주장의 시험).
test("HYK-198-capwire-2 §2-4: a healthy cap read (verdict=DECIDED) never appears in the morning report -- 'DECIDED' string is never human-visible (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () =>
        JSON.stringify({ verdict: "PROGRESSING", reasonCode: "OK" }),
      notifyDir: join(watchDir, "받는함-cap-healthy"),
    });
    assert.equal(result.capResult.status, "OK");
    assert.equal(result.capResult.verdict, "DECIDED");
    const reportText = fs.readFileSync(
      join(watchDir, "morning-report.md"),
      "utf8",
    );
    assert.doesNotMatch(reportText, /DECIDED/);
    assert.match(
      reportText,
      /없음 -- 열려 있는 이상이 없습니다\(5축 전부 정상 또는 관측 대상 없음\)/,
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("reach step failure (unwritable notifyDir) does not throw and does not stop the base watch-run contract (log+alive record still written) (1/1)", () => {
  const watchDir = tmpWatchDir();
  try {
    // notifyDir points at a path that a bogus mkdirFn injection will reject.
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => idleAbandonedExec(),
      notifyDir: join(watchDir, "받는함-실패"),
      mkdirFn: (p, opts) => {
        if (String(p).includes("받는함-실패"))
          throw new Error("simulated EACCES");
        fs.mkdirSync(p, opts);
      },
    });
    assert.equal(result.reachResult.failed, true);
    assert.match(result.reachResult.message, /simulated EACCES/);
    assert.ok(
      fs.existsSync(result.logPath),
      "watch.log must still exist despite reach failure",
    );
    assert.ok(
      fs.existsSync(result.aliveRecordPath),
      "last-run.json must still exist despite reach failure",
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});
