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
import { runPartialCountStep } from "./watch-run.mjs";
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
