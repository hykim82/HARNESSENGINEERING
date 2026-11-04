// HYK-255-watch-wire-1 (coder-task.md §3) -- 감시 실행이 부분 계수 보고
// «실파일»을 실제로 만드는지의 결선 계약 시험. ⛔공허 시험 금지: 프로덕션
// 함수(runPartialCountStep · runReachOnce)를 직접 구동해 ⓐ파일이 생겼는지
// ⓑ아침 보고 본문이 UNKNOWN에서 실제 배너로 바뀌었는지를 필드 내용으로
// 확인한다.
//
// 이 스위트가 보장하지 않는 것: 실제 GitHub REST 호출·실제 스케줄러 등록
// (그건 partial-count-wire.test.mjs·schedule-wire.test.mjs 몫) -- 여기는
// "감시 실행 -> 파일 생성 -> 아침 보고 편입" 배선 자체만 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  runPartialCountStep,
  runWatchCliPartialCountStep,
} from "./watch-run.mjs";
import { runReachOnce } from "./reach-report.mjs";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

test("실제 경로: runPartialCountStep이 부분 계수 파일을 만들고(진짜 runPartialCountOnce 경유, 비-git 디렉터리라 분모는 UNKNOWN이어도 PARTIAL 배너는 실제로 찍힌다), runReachOnce가 그 내용을 UNKNOWN 대신 아침 보고에 편입한다", async () => {
  const watchDir = tmpDir("nc-wr-pc-happy-");
  try {
    const watchLogPath = join(watchDir, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");

    const step = await runPartialCountStep({
      watchDir,
      now: NOW,
      logPath: watchLogPath,
      options: {
        repoRoot: join(watchDir, "not-a-git-repo"),
        dispatchReceiptsPath: join(watchDir, "does-not-exist.jsonl"),
        watchLogPath,
        maxMergeChecks: 0,
      },
    });
    assert.equal(step.ran, true);
    assert.equal(step.ok, true);

    const partialCountOut = join(watchDir, "partial-count-report.md");
    assert.ok(fs.existsSync(partialCountOut));
    const written = fs.readFileSync(partialCountOut, "utf8");
    assert.equal(written.split("\n")[0], "집계 성격: PARTIAL — 전수 아님");

    const reportOutPath = join(watchDir, "morning-report.md");
    const reach = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath: join(watchDir, "reach-notify-state.json"),
      notifyDir: join(watchDir, "받는함"),
      now: NOW,
    });
    assert.ok(reach.reportText.includes("집계 성격: PARTIAL — 전수 아님"));
    assert.ok(!reach.reportText.includes("UNKNOWN — 부분 계수 보고 파일 없음"));
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("음성 시험: 부분 계수 수집이 실패하면(주입된 실패) ⓐ파일을 쓰지 않고 ⓑwatch.log에 실패가 시끄럽게 남고 ⓒ그 뒤 runReachOnce는 숫자를 지어내지 않고 여전히 UNKNOWN을 낸다", async () => {
  const watchDir = tmpDir("nc-wr-pc-fail-");
  try {
    const watchLogPath = join(watchDir, "watch.log");
    fs.writeFileSync(watchLogPath, "2026-08-14T11:00:00.000Z exit=0\n", "utf8");

    const step = await runPartialCountStep({
      watchDir,
      now: NOW,
      logPath: watchLogPath,
      runPartialCountOnceFn: async () => {
        throw new Error("injected collector failure");
      },
    });
    assert.equal(step.ran, true);
    assert.equal(step.ok, false);
    assert.ok(step.message.includes("injected collector failure"));

    const partialCountOut = join(watchDir, "partial-count-report.md");
    assert.equal(fs.existsSync(partialCountOut), false);

    const log = fs.readFileSync(watchLogPath, "utf8");
    assert.ok(log.includes("PARTIAL_COUNT_STEP_FAILED"));
    assert.ok(log.includes("injected collector failure"));

    const reportOutPath = join(watchDir, "morning-report.md");
    const reach = runReachOnce({
      watchLogPath,
      reportOutPath,
      statePath: join(watchDir, "reach-notify-state.json"),
      notifyDir: join(watchDir, "받는함"),
      now: NOW,
    });
    assert.ok(reach.reportText.includes("UNKNOWN — 부분 계수 보고 파일 없음"));
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// HYK-255-watch-wire-2 (coder-task.md §0/§1) -- ORCH 지시서 오류 정정 고정.
// 직전 REVIEW 라운드가 실제 생산 출력(runPartialCountStep 경유)에서
// «ㄴ=0»이라는 글자를 발견하고 그 존재 자체를 반려 사유로 삼았다. 하지만
// 병합된 계약(partial-count-core.mjs buildPartialCountReport)은 그 글자를
// «ㄴ=0이라고 말할 수 없다»는 부정문 «안에서» 일부러 쓴다 -- 지우면
// 정직 장치가 약해진다. 금지 대상은 «ㄴ의 계수 값 자체를 0으로 표기»하는
// 것뿐이다. 이 시험이 그 구분을 실제 생산 출력 위에서 문면으로 고정한다.
test("ORCH 정정 고정: 실제 생산 경로가 만든 부분 계수 파일에서 ⓐ부정문 2개는 반드시 남아 있고 ⓑㄴ 계수 줄은 «확인 0건»뿐 bare «0건»/«ㄴ=0» 표기가 아니며 ⓒ그 판정은 «ㄴ 계수 줄» 하나로만 좁혀 ⓐ를 무력화하지 않는다", async () => {
  const watchDir = tmpDir("nc-wr-pc-orch-fix-");
  try {
    const watchLogPath = join(watchDir, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");

    await runPartialCountStep({
      watchDir,
      now: NOW,
      logPath: watchLogPath,
      options: {
        repoRoot: join(watchDir, "not-a-git-repo"),
        dispatchReceiptsPath: join(watchDir, "does-not-exist.jsonl"),
        watchLogPath,
        maxMergeChecks: 0,
      },
    });
    const written = fs.readFileSync(
      join(watchDir, "partial-count-report.md"),
      "utf8",
    );

    // ⓐ -- 부정문 2개는 «정직 장치»다(coder-task.md §0) -- 지워지면
    // 계약이 약해진다. 둘 중 하나라도 지워지면 이 assert가 빨간불이다.
    assert.ok(
      written.includes(
        "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가",
      ),
      "부정문 1(«ㄴ=0» 판정 불가)이 실제 생산 출력에서 사라졌다",
    );
    assert.ok(
      written.includes(
        "금지 해석: «확인된 N건»은 «기간 내 총 N회» 또는 «ㄴ=0»을 뜻하지 않음",
      ),
      "부정문 2(«ㄴ=0»을 뜻하지 않음)가 실제 생산 출력에서 사라졌다",
    );

    // ⓑ -- 금지 대상은 «ㄴ의 계수 값이 0으로 «표기»»되는 것뿐이다. 그
    // 표기가 나올 수 있는 자리는 «- 외부 독립 증거로 확인된 사건: ...»
    // 줄 하나뿐이다(partial-count-core.mjs buildLnSection 참조) -- 그
    // 줄을 정확히 뽑아 «확인 0건»과 바이트 단위로 같은지 본다(bare
    // «0건»/«ㄴ=0» 형태가 섞이면 이 equal이 깨진다).
    const lnCountLine = written
      .split("\n")
      .find((line) => line.startsWith("- 외부 독립 증거로 확인된 사건:"));
    assert.equal(lnCountLine, "- 외부 독립 증거로 확인된 사건: 확인 0건");

    // ⓒ -- ⓑ를 문서 전체가 아니라 «그 줄 하나»로 좁힌 이유가 바로 위
    // ⓐ다: 만약 ⓑ가 문서 전체에서 «0건»/«ㄴ=0» 문자열 자체를 금지하는
    // 형태였다면, ⓐ가 지키는 두 부정문(둘 다 «ㄴ=0»이라는 글자를 그대로
    // 포함한다)까지 함께 걸려 넘어져 ⓐ와 ⓑ가 서로를 무력화했을 것이다.
    // ⓑ가 «ㄴ 계수 줄» 하나로 범위를 좁혔기 때문에, 부정문 두 줄은 다른
    // 줄이라 이 좁은 검사에 걸리지 않고, ⓐ의 assert.ok 두 건이 독립적으로
    // 계속 부정문의 존재를 고정한다.
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-1 (coder-task.md product_scope ③ · §2 ⓒ⑸) -- "ㄴ
// 후보 K 또는 형식 오류 E가 바뀔 때만 받는함 통지 1개"(그림자 teardown
// 통지 모양 · 상태 파일). 변이⑥의 표적 -- 상태 파일 dedupe를 지우면
// 2·3회차에서 통지 파일이 매번 더 생긴다.
function makeRelayLedgerResult(candidateCount, formatErrorCount) {
  return {
    known: true,
    sourceUtteranceCount: 5,
    mergedAwayCount: 0,
    matchedCount: 2,
    candidateCount,
    gate7MissingCount: 0,
    formatErrorCount,
    beforeFormatCount: 0,
    classificationTally: {},
    scannedRelayFiles: 1,
    relayReadFailures: [],
  };
}

test("watch-run 통지: 전달 파일 대조의 ㄴ 후보·형식 오류가 바뀌면 받는함에 통지 파일이 하나 생기고, 같은 값 재실행은 더 생기지 않으며, 값이 다시 바뀌면 또 하나 생긴다", async () => {
  const watchDir = tmpDir("nc-wr-relay-notify-");
  const notifyDir = join(watchDir, "받는함");
  try {
    await runPartialCountStep({
      watchDir,
      now: NOW,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n1\n",
        relayResult: makeRelayLedgerResult(1, 0),
      }),
    });
    assert.equal(fs.readdirSync(notifyDir).length, 1);

    await runPartialCountStep({
      watchDir,
      now: NOW + 1000,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n2\n",
        relayResult: makeRelayLedgerResult(1, 0),
      }),
    });
    assert.equal(
      fs.readdirSync(notifyDir).length,
      1,
      "값이 안 바뀌었는데 통지가 더 생겼다(상태 파일 무시 -- 변이⑥)",
    );

    await runPartialCountStep({
      watchDir,
      now: NOW + 2000,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n3\n",
        relayResult: makeRelayLedgerResult(2, 0),
      }),
    });
    assert.equal(
      fs.readdirSync(notifyDir).length,
      2,
      "ㄴ 후보 K가 바뀌었는데 통지가 안 생겼다",
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-2 P2-1 -- 전달 파일 개별 읽기 실패가 있으면 통지
// 문면에도 "읽기 실패 N건"이 찍히고, "대응 없음(ㄴ 후보)" 수치에
// 불확실 괄호가 붙는다(partial-count-core.mjs의 보조 관측 줄과 같은
// 문구).
test("watch-run 통지: 전달 파일 읽기 실패가 있으면 통지 문면에 읽기 실패 건수와 ㄴ 후보 불확실 표기가 찍힌다(P2-1)", async () => {
  const watchDir = tmpDir("nc-wr-relay-notify-readfail-");
  const notifyDir = join(watchDir, "받는함");
  try {
    await runPartialCountStep({
      watchDir,
      now: NOW,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n1\n",
        relayResult: {
          ...makeRelayLedgerResult(1, 0),
          relayReadFailures: ["전달-잠김.md"],
        },
      }),
    });
    const files = fs.readdirSync(notifyDir);
    assert.equal(files.length, 1);
    const text = fs.readFileSync(join(notifyDir, files[0]), "utf8");
    assert.ok(text.includes("읽기 실패 1건"));
    assert.ok(
      text.includes("대응 없음(ㄴ 후보): 1건(전달 파일 읽기 실패로 불확실)"),
    );
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

test("watch-run 통지: relayResult가 없거나(미결선) known:false(폴더 없음)면 통지를 시도하지 않는다(판단 불가를 변화 없음으로 접지 않는다)", async () => {
  const watchDir = tmpDir("nc-wr-relay-notify-skip-");
  const notifyDir = join(watchDir, "받는함");
  try {
    const stepA = await runPartialCountStep({
      watchDir,
      now: NOW,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n",
      }),
    });
    assert.equal(stepA.relayNotify.attempted, false);
    assert.equal(fs.existsSync(notifyDir), false);

    const stepB = await runPartialCountStep({
      watchDir,
      now: NOW + 1000,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n",
        relayResult: { known: false, reason: "전달 폴더 읽기 실패: ENOENT" },
      }),
    });
    assert.equal(stepB.relayNotify.attempted, false);
    assert.equal(fs.existsSync(notifyDir), false);
  } finally {
    fs.rmSync(watchDir, { recursive: true, force: true });
  }
});

// coder-task.md product_scope ③ ":2494" -- --relay-glob/--inbox-dir도
// --outbox-dir과 같은 "1곳 전달"로 옵션까지 닿는다(watch-run-outbox-
// forward.test.mjs의 변이10 패턴과 동일 -- argv 분기 또는 호출부 전달이
// 끊기면 이 단언이 RED).
test("runWatchCliPartialCountStep: argv의 --relay-glob/--inbox-dir이 실제로 options까지 전달된다", async () => {
  let received = null;
  const fakeStepFn = async ({ options }) => {
    received = options;
    return { ran: true, ok: true };
  };
  await runWatchCliPartialCountStep({
    argv: [
      "--relay-glob",
      "D:/문서관리/통역/기록/전달-*.md",
      "--inbox-dir",
      "D:/문서관리/통역/받는함",
    ],
    repoRoot: "/repo",
    watchDir: "/repo/watch",
    now: 1000,
    result: { logPath: "/repo/watch/watch.log" },
    runPartialCountStepFn: fakeStepFn,
  });
  assert.deepEqual(received, {
    repoRoot: "/repo",
    watchLogPath: "/repo/watch/watch.log",
    outboxDir: null,
    relayGlob: "D:/문서관리/통역/기록/전달-*.md",
    inboxDir: "D:/문서관리/통역/받는함",
  });
});

test("경로 위생: partialCountOut 기본값은 호출자가 준 watchDir에서만 파생된다(절대경로 하드코딩 없음) — 다른 watchDir을 주면 그 밑에 쓴다", async () => {
  const watchDirA = tmpDir("nc-wr-pc-pathA-");
  const watchDirB = tmpDir("nc-wr-pc-pathB-");
  try {
    await runPartialCountStep({
      watchDir: watchDirA,
      now: NOW,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\nA\n",
      }),
    });
    await runPartialCountStep({
      watchDir: watchDirB,
      now: NOW,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\nB\n",
      }),
    });
    assert.ok(
      fs
        .readFileSync(join(watchDirA, "partial-count-report.md"), "utf8")
        .includes("A"),
    );
    assert.ok(
      fs
        .readFileSync(join(watchDirB, "partial-count-report.md"), "utf8")
        .includes("B"),
    );
  } finally {
    fs.rmSync(watchDirA, { recursive: true, force: true });
    fs.rmSync(watchDirB, { recursive: true, force: true });
  }
});
