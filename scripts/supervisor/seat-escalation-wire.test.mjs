// HYK-433-seat-escalation-push-1 (coder-task.md) -- seat 축이
// SUSPECTED_UNRESPONSIVE로 "새로 열릴" 때(전이 1회)만 Run coordinator에게
// orchestration escalation 메시지 1건을 보내는 결선 계약 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 라이브 실물 -- 이 스위트는 실 `orca` 프로세스를 전혀 접촉하지 않는다
//    (fake execFn만 주입, live_send_ban). 라이브 왕복 검증은 병합 뒤
//    다음 실제 전이 1회에서 ORCH가 escalation을 받은 시각 기록으로
//    대체한다(§3 완료조건4).
// 2. mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를 읽는다
//    (seat-liveness-wire.test.mjs와 동일 이유 -- 이번 사이클에서 새로
//    추가한 결선 줄 자체가 아직 HEAD에 없다).
// 3. run-id.json 읽기는 전부 readFn 주입으로 가로챈다(hyk464-idle-stop-
//    reason.test.mjs의 stopReasonsExistsFn 주입 패턴과 동일 이유 --
//    watchDir의 부모는 공유 OS tmp 루트라 실 파일을 거기 쓰지 않는다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  runWatchOnce,
  buildLogLine,
  isSeatUnresponsiveNewlyOpened,
  buildSeatEscalationBody,
} from "./watch-run.mjs";
import {
  buildSeatEscalationSendCommand,
  createOrcaExecFn,
} from "../relay/adapters/orca-adapter.mjs";
import {
  computeOpenAnomalies,
  parseWatchLog,
  formatMorningReport,
} from "./reach-report-core.mjs";
import { decideNotifications, buildNoticeText } from "./reach-notify-core.mjs";

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
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

const NOW_MS = Date.parse("2026-08-03T18:00:00+09:00");

function tmpWatchDir() {
  return fs.mkdtempSync(join(tmpdir(), "nc-seat-esc-watch-"));
}

// detector stdout 합성 -- SUSPECTED_UNRESPONSIVE(또는 RESPONSIVE/없음)인
// seat 축 하나를 만든다. judgeSeatLivenessAcrossWorktrees의 실제 반환
// 모양(orch-stall-detect.mjs 1392-1414행 근처) 그대로: top-level
// status/verdict/details/worktreePath + worktrees[] 배열 안에
// dispatch.dispatchId/correlation.handle.
function seatUnresponsiveExec({
  worktreePath = "C:/repo/wt1",
  handle = "term_fake_handle",
  dispatchId = ".harness/coder-task.md",
  elapsedMs = 25 * 60000,
  referencePointMs = NOW_MS - 25 * 60000,
} = {}) {
  const wtEntry = {
    worktreePath,
    status: "SEAT_LIVENESS_JUDGED",
    verdict: "SUSPECTED_UNRESPONSIVE",
    dispatch: { dispatchId, dispatchedAtMs: referencePointMs },
    correlation: {
      attempted: true,
      ok: true,
      handle,
      runtimeTaskId: "task_fake",
    },
  };
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    seatLiveness: {
      status: "SEAT_LIVENESS_JUDGED",
      verdict: "SUSPECTED_UNRESPONSIVE",
      worstCount: 1,
      totalWorktrees: 1,
      worktreePath,
      details: {
        now: NOW_MS,
        maxNoOutputSeconds: 1200,
        referencePointMs,
        elapsedMs,
        reasonHint: null,
      },
      worktrees: [wtEntry],
    },
  });
}

function respondsiveExec() {
  return JSON.stringify({
    verdict: "PROGRESSING",
    reasonCode: "OK",
    seatLiveness: {
      status: "SEAT_LIVENESS_JUDGED",
      verdict: "RESPONSIVE",
      worstCount: 0,
      totalWorktrees: 1,
      worktrees: [],
    },
  });
}

// run-id.json을 실 fs에 쓰지 않고 readFn 주입으로 가로챈다(위 S11-3).
// 그 밖 경로는 전부 실 fs.readFileSync로 위임한다(watchDir 아래 상태
// 파일은 mkdtemp로 격리된 이 시험 전용 디렉터리라 실 fs를 써도 안전).
function makeReadFnWithRunId(runIdPath, runIdContent) {
  return (p, enc) => {
    if (p === runIdPath) {
      if (runIdContent === undefined) {
        const err = new Error("no such file");
        err.code = "ENOENT";
        throw err;
      }
      return runIdContent;
    }
    return fs.readFileSync(p, enc);
  };
}

function withWatchDir(fn) {
  const watchDir = tmpWatchDir();
  try {
    fn(watchDir);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
}

// ---- 순수 함수 단위 시험 ----

test("isSeatUnresponsiveNewlyOpened: null/empty current -> never newly-opened (닫혀 있으면 전이가 아니다) (1/1)", () => {
  assert.equal(
    isSeatUnresponsiveNewlyOpened({
      currentOpenWorktreePath: null,
      priorOpenWorktreePath: "C:/repo/wt1",
    }),
    false,
  );
  assert.equal(
    isSeatUnresponsiveNewlyOpened({
      currentOpenWorktreePath: "",
      priorOpenWorktreePath: null,
    }),
    false,
  );
});

test("isSeatUnresponsiveNewlyOpened: same worktree as prior tick -> false (반복 회차 재통지 금지) (1/1)", () => {
  assert.equal(
    isSeatUnresponsiveNewlyOpened({
      currentOpenWorktreePath: "C:/repo/wt1",
      priorOpenWorktreePath: "C:/repo/wt1",
    }),
    false,
  );
});

test("isSeatUnresponsiveNewlyOpened: prior null (first time open) -> true; prior different worktree -> true (새로 열림 두 모양) (2/2)", () => {
  assert.equal(
    isSeatUnresponsiveNewlyOpened({
      currentOpenWorktreePath: "C:/repo/wt1",
      priorOpenWorktreePath: null,
    }),
    true,
  );
  assert.equal(
    isSeatUnresponsiveNewlyOpened({
      currentOpenWorktreePath: "C:/repo/wt1",
      priorOpenWorktreePath: "C:/repo/wt2",
    }),
    true,
  );
});

test("buildSeatEscalationBody: 5칸(seat·worktree·dispatch·no_output_min·last_output)을 모두 싣는다 (1/1)", () => {
  const body = buildSeatEscalationBody({
    handle: "term_abc",
    worktreePath: "C:/repo/wt1",
    dispatchLabel: ".harness/coder-task.md",
    elapsedMs: 25 * 60000,
    referencePointMs: NOW_MS - 25 * 60000,
  });
  assert.match(body, /seat=term_abc/);
  assert.match(body, /worktree=C:\/repo\/wt1/);
  assert.match(body, /dispatch=\.harness\/coder-task\.md/);
  assert.match(body, /no_output_min=25/);
  assert.match(body, /last_output=\d{4}-\d{2}-\d{2}T/);
});

test("buildSeatEscalationBody: 값이 없으면(null) NONE으로 접는다(거짓 확신 금지) (1/1)", () => {
  const body = buildSeatEscalationBody({
    handle: null,
    worktreePath: null,
    dispatchLabel: null,
    elapsedMs: null,
    referencePointMs: null,
  });
  assert.equal(
    body,
    "seat=NONE worktree=NONE dispatch=NONE no_output_min=NONE last_output=NONE",
  );
});

test("buildSeatEscalationSendCommand: argv shape는 HYK-493 F-2c 통로 수리 뒤 원문과 일치한다 (--to run:<id> --type status --subject --body --json -- escalation은 배정 없는 발신자에게 거부된다, coder-task.md §1 증거 ⑴) (1/1)", () => {
  const argv = buildSeatEscalationSendCommand({
    runId: "run_abc123",
    subject: "seat unresponsive: term_x",
    body: "seat=term_x worktree=w dispatch=d no_output_min=25 last_output=2026",
  });
  assert.deepEqual(argv, [
    "orchestration",
    "send",
    "--to",
    "run:run_abc123",
    "--type",
    "status",
    "--subject",
    "seat unresponsive: term_x",
    "--body",
    "seat=term_x worktree=w dispatch=d no_output_min=25 last_output=2026",
    "--json",
  ]);
});

// ---- 결선 계약 시험(runWatchOnce 전체, fake execFn) ----

test("전이 1회: SUSPECTED_UNRESPONSIVE가 새로 열리고 run-id.json이 있으면 escalation argv 1건이 fake execFn으로 나간다 (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const sentArgvs = [];
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => seatUnresponsiveExec(),
      readFn: makeReadFnWithRunId(
        runIdPath,
        JSON.stringify({ runId: "run_live_1" }),
      ),
      seatEscalationExecFn: (argv) => {
        sentArgvs.push(argv);
        return { ok: true };
      },
    });
    assert.equal(
      sentArgvs.length,
      1,
      "정확히 1건의 escalation send가 나가야 한다",
    );
    assert.deepEqual(sentArgvs[0].slice(0, 4), [
      "orchestration",
      "send",
      "--to",
      "run:run_live_1",
    ]);
    assert.equal(result.seatEscalation.attempted, true);
    assert.equal(result.seatEscalation.sent, true);
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.match(logText, /seat_escalation_attempted=1/);
    assert.match(logText, /seat_escalation_detail=term_fake_handle@/);
    assert.match(
      logText,
      /seat_detail=term_fake_handle@C:\/repo\/wt1:\.harness\/coder-task\.md:25m:/,
    );
  });
});

test("같은 이상이 이어지는 회차: 두 번째 tick도 같은 worktree가 SUSPECTED_UNRESPONSIVE면 재전송 0건(dedupe) (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const readFn = makeReadFnWithRunId(
      runIdPath,
      JSON.stringify({ runId: "run_live_2" }),
    );
    const sentArgvs = [];
    const seatEscalationExecFn = (argv) => {
      sentArgvs.push(argv);
      return { ok: true };
    };
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => seatUnresponsiveExec(),
      readFn,
      seatEscalationExecFn,
    });
    assert.equal(sentArgvs.length, 1, "1회차: 1건");
    const result2 = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 15 * 60000,
      execFn: () => seatUnresponsiveExec(),
      readFn,
      seatEscalationExecFn,
    });
    assert.equal(sentArgvs.length, 1, "2회차(같은 이상 계속): 추가 전송 0건");
    assert.equal(result2.seatEscalation.attempted, false);
    const logText2 = fs.readFileSync(result2.logPath, "utf8");
    const lines2 = logText2.trim().split("\n");
    assert.doesNotMatch(
      lines2[lines2.length - 1],
      /seat_escalation_attempted=1/,
      "2회차 로그 줄에는 escalation 시도 세그먼트가 없어야 한다",
    );
    // seat_detail은 verdict가 여전히 SUSPECTED_UNRESPONSIVE인 한 매
    // tick 찍힌다(reach-report-core.mjs가 "열려 있는 동안 계속 식별
    // 가능"해야 하므로 -- escalation 전송 dedupe와는 별개 축).
    assert.match(lines2[lines2.length - 1], /seat_detail=term_fake_handle@/);
  });
});

test("Run id 미설정: run-id.json이 없으면 NO_RUN_CONFIGURED로 보내기를 생략하고, 받는함 통지(reach)는 그대로 돈다(fail-open) (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const sentArgvs = [];
    const notifyDir = fs.mkdtempSync(join(tmpdir(), "nc-seat-esc-notify-"));
    try {
      const result = runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        now: NOW_MS,
        execFn: () => seatUnresponsiveExec(),
        readFn: makeReadFnWithRunId(runIdPath, undefined),
        notifyDir,
        seatEscalationExecFn: (argv) => {
          sentArgvs.push(argv);
          return { ok: true };
        },
      });
      assert.equal(
        sentArgvs.length,
        0,
        "run id 미설정이면 실제 send가 0건이어야 한다",
      );
      assert.equal(result.seatEscalation.attempted, true);
      assert.equal(result.seatEscalation.sent, false);
      assert.equal(result.seatEscalation.reason, "NO_RUN_CONFIGURED");
      const logText = fs.readFileSync(result.logPath, "utf8");
      assert.match(
        logText,
        /seat_escalation_detail=term_fake_handle@C:\/repo\/wt1:SKIP:NO_RUN_CONFIGURED/,
      );
      // reach 단계(받는함 통지)는 이 축의 실패와 무관하게 그대로 실행됐다
      // -- 새 seat 이상이 열렸으므로 noticePath가 실제로 쓰였음을 값으로
      // 확인(runReachOnce 성공 경로는 notRun 필드를 두지 않는다 --
      // notRun은 notifyDir 자체가 없을 때만 쓰는 별도 가드값이다).
      assert.ok(
        result.reachResult.noticePath,
        "reach 단계는 생략되지 않아야 한다(fail-open) -- notice 파일이 써져야 한다",
      );
      assert.ok(
        fs.existsSync(result.reachResult.noticePath),
        "실제로 noticePath에 받는함 파일이 존재해야 한다",
      );
    } finally {
      fs.rmSync(notifyDir, { recursive: true, force: true });
    }
  });
});

test("어댑터 실패(send 자체가 throw): SEND_FAILED로 사유를 남기고, 받는함 통지는 막지 않는다(fail-open) (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const notifyDir = fs.mkdtempSync(join(tmpdir(), "nc-seat-esc-notify2-"));
    try {
      const result = runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        now: NOW_MS,
        execFn: () => seatUnresponsiveExec(),
        readFn: makeReadFnWithRunId(
          runIdPath,
          JSON.stringify({ runId: "run_live_3" }),
        ),
        notifyDir,
        seatEscalationExecFn: () => {
          throw new Error("adapter boom: orca unreachable");
        },
      });
      assert.equal(result.seatEscalation.attempted, true);
      assert.equal(result.seatEscalation.sent, false);
      assert.match(result.seatEscalation.reason, /^SEND_FAILED:/);
      const logText = fs.readFileSync(result.logPath, "utf8");
      assert.match(
        logText,
        /seat_escalation_detail=term_fake_handle@C:\/repo\/wt1:SKIP:SEND_FAILED/,
      );
      assert.ok(
        result.reachResult.noticePath,
        "어댑터 실패는 reach 단계를 막지 않아야 한다(fail-open) -- notice 파일이 써져야 한다",
      );
    } finally {
      fs.rmSync(notifyDir, { recursive: true, force: true });
    }
  });
});

test("생산 execFn 모양(createOrcaExecFn): orca의 일반 오류(비0 종료 + ok:false run_not_found)가 SEND_FAILED로 접히고, 거짓 SENT가 남지 않는다(P1-1) (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const notifyDir = fs.mkdtempSync(join(tmpdir(), "nc-seat-esc-notify3-"));
    try {
      const seatEscalationExecFn = createOrcaExecFn({
        spawnSyncFn: () => ({
          status: 1,
          stdout: JSON.stringify({
            ok: false,
            error: { code: "run_not_found" },
          }),
        }),
      });
      const result = runWatchOnce({
        repoRoot: ROOT,
        watchDir,
        now: NOW_MS,
        execFn: () => seatUnresponsiveExec(),
        readFn: makeReadFnWithRunId(
          runIdPath,
          JSON.stringify({ runId: "run_stale_1" }),
        ),
        notifyDir,
        seatEscalationExecFn,
      });
      assert.equal(result.seatEscalation.attempted, true);
      assert.equal(
        result.seatEscalation.sent,
        false,
        "orca가 ok:false로 응답하면(throw 없이) sent=false여야 한다(1R 버그: 무조건 true)",
      );
      assert.match(result.seatEscalation.reason, /^SEND_FAILED:/);
      assert.match(result.seatEscalation.reason, /run_not_found/);
      const logText = fs.readFileSync(result.logPath, "utf8");
      assert.match(
        logText,
        /seat_escalation_detail=term_fake_handle@C:\/repo\/wt1:SKIP:SEND_FAILED/,
      );
      assert.match(logText, /run_not_found/);
      assert.doesNotMatch(
        logText,
        /seat_escalation_detail=term_fake_handle@C:\/repo\/wt1:SENT/,
        "거짓 SENT 기록이 남으면 안 된다",
      );
      assert.ok(
        result.reachResult.noticePath,
        "orca의 일반 오류(ok:false)도 reach 단계를 막지 않아야 한다(fail-open)",
      );
      assert.ok(fs.existsSync(result.reachResult.noticePath));
    } finally {
      fs.rmSync(notifyDir, { recursive: true, force: true });
    }
  });
});

test("RESPONSIVE(정상)일 때는 seat_detail/seat_escalation_* 세그먼트가 전혀 붙지 않는다(소음 최소화, byte 수준) (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const result = runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => respondsiveExec(),
      readFn: makeReadFnWithRunId(
        runIdPath,
        JSON.stringify({ runId: "run_live_4" }),
      ),
      seatEscalationExecFn: () => {
        throw new Error("must not be called for RESPONSIVE");
      },
    });
    const logText = fs.readFileSync(result.logPath, "utf8");
    assert.doesNotMatch(logText, /seat_detail=/);
    assert.doesNotMatch(logText, /seat_escalation_/);
  });
});

test("닫혔다가 다시 열림: wt1 열림(전송) -> wt1 닫힘(RESPONSIVE) -> wt1 재열림 -> 재전송 1건 더(같은 worktree라도 '새로 열림') (1/1)", () => {
  withWatchDir((watchDir) => {
    const runIdPath = join(dirname(watchDir), "run-id.json");
    const readFn = makeReadFnWithRunId(
      runIdPath,
      JSON.stringify({ runId: "run_live_5" }),
    );
    const sentArgvs = [];
    const seatEscalationExecFn = (argv) => {
      sentArgvs.push(argv);
      return { ok: true };
    };
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS,
      execFn: () => seatUnresponsiveExec(),
      readFn,
      seatEscalationExecFn,
    });
    assert.equal(sentArgvs.length, 1);
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 5 * 60000,
      execFn: () => respondsiveExec(),
      readFn,
      seatEscalationExecFn,
    });
    assert.equal(sentArgvs.length, 1, "닫힌 tick은 전송하지 않는다");
    runWatchOnce({
      repoRoot: ROOT,
      watchDir,
      now: NOW_MS + 10 * 60000,
      execFn: () => seatUnresponsiveExec(),
      readFn,
      seatEscalationExecFn,
    });
    assert.equal(
      sentArgvs.length,
      2,
      "같은 worktree라도 다시 열리면 새 전이 -- 2건째",
    );
  });
});

// ---- wire ③: reach-report-core.mjs / reach-notify-core.mjs에 좌석 식별 칸 ----

test("wire③ 아침 보고(formatMorningReport): '좌석 무응답' 행에 handle·worktree·dispatch·분·시각이 그대로 보인다 (1/1)", () => {
  const line = buildLogLine({
    nowIso: new Date(NOW_MS).toISOString(),
    detectorResult: {
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatLivenessStatus: "SEAT_LIVENESS_JUDGED",
      seatLivenessVerdict: "SUSPECTED_UNRESPONSIVE",
      seatLivenessWorstCount: 1,
      seatLivenessTotalWorktrees: 1,
      seatLivenessIdentity: {
        worktreePath: "C:/repo/wt1",
        handle: "term_fake_handle",
        dispatchLabel: ".harness/coder-task.md",
        elapsedMs: 25 * 60000,
        referencePointMs: NOW_MS - 25 * 60000,
      },
    },
  });
  const { entries } = parseWatchLog(line);
  const report = formatMorningReport({ entries, nowMs: NOW_MS });
  assert.match(report, /좌석 무응답/);
  assert.match(
    report,
    /term_fake_handle@C:\/repo\/wt1:\.harness\/coder-task\.md:25m:/,
  );
});

test("wire③ 받는함 통지(buildNoticeText): 새로 열린 seat 이상에도 같은 식별 칸이 실린다 (1/1)", () => {
  const line = buildLogLine({
    nowIso: new Date(NOW_MS).toISOString(),
    detectorResult: {
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      seatLivenessStatus: "SEAT_LIVENESS_JUDGED",
      seatLivenessVerdict: "SUSPECTED_UNRESPONSIVE",
      seatLivenessWorstCount: 1,
      seatLivenessTotalWorktrees: 1,
      seatLivenessIdentity: {
        worktreePath: "C:/repo/wt1",
        handle: "term_fake_handle",
        dispatchLabel: ".harness/coder-task.md",
        elapsedMs: 25 * 60000,
        referencePointMs: NOW_MS - 25 * 60000,
      },
    },
  });
  const { entries } = parseWatchLog(line);
  const open = computeOpenAnomalies(entries, NOW_MS);
  const { toNotify } = decideNotifications({
    previousState: null,
    openAnomalies: open,
  });
  const text = buildNoticeText({ toNotify, nowMs: NOW_MS });
  assert.match(text, /좌석 무응답/);
  assert.match(
    text,
    /term_fake_handle@C:\/repo\/wt1:\.harness\/coder-task\.md:25m:/,
  );
});

test("다른 축(chain/binding/postcheck)은 identity가 항상 null -- 이 라운드가 그 축들의 표시를 바꾸지 않는다 (1/1)", () => {
  const line = buildLogLine({
    nowIso: new Date(NOW_MS).toISOString(),
    detectorResult: {
      exitCode: 0,
      verdict: "PROGRESSING",
      reasonCode: "OK",
      chainStatus: "CHAIN_JUDGED",
      chainVerdict: "TAMPER_DETECTED",
      chainWorstCount: 1,
      chainTotalWorktrees: 1,
      chainIssueId: "HYK-1",
      chainReason: "sig_mismatch",
      chainWorktreePath: "C:/repo/wt1",
    },
  });
  const { entries } = parseWatchLog(line);
  const open = computeOpenAnomalies(entries, NOW_MS);
  const chainEntry = open.find((a) => a.axisKey === "chain");
  assert.ok(chainEntry, "chain 축이 열린 이상으로 분류돼야 한다");
  assert.equal(chainEntry.identity, null);
  const report = formatMorningReport({ entries, nowMs: NOW_MS });
  // chain 행 자체는 그대로지만, 이 라운드가 추가한 identitySuffix 구문이
  // 전혀 붙지 않는다(a.identity===null -> identitySuffix === "").
  assert.match(report, /원장 위조 탐지\(해시체인\)/);
});

// ---- 정적 검사: orca 실행이 adapter 밖 0건 ----

test("정적 검사: orca-cli-boundary -- orca exec 호출이 scripts/relay/adapters/orca-adapter.mjs 밖 0건(기존 공용 검사 재실행, G9) (1/1)", () => {
  const output = execFileSync(
    process.execPath,
    [join(ROOT, "scripts", "check", "orca-cli-boundary.mjs")],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.match(output, /PASS/);
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "이 스위트는 저장소 작업트리를 건드리지 않아야 한다(격리 실패 감지)",
  );
  assert.equal(
    postDiffStat,
    preDiffStat,
    "이 스위트는 HEAD 대비 diff를 바꾸지 않아야 한다(격리 실패 감지)",
  );
});
