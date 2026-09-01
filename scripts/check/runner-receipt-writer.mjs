// HYK-411 1R -- «러너가 자기 종료코드를 자기 손으로 적는» 영수증 생산자.
//
// §1 왜: `npm test 2>&1 | tail -N` 형태의 파이프는 종료코드를 마지막
// 명령(`tail`)의 것으로 바꿔치기한다 -- 실패한 러너가 파이프 뒤에서
// exit 0으로 보인다(coder-task.md §1 실측). 파이프는 러너 자신이 자기
// 파일에 적는 값은 바꿀 수 없으므로, 종료코드를 실제로 아는 프로세스
// (러너 자신, isolated-suite-runner.mjs)가 그 값을 파일에 쓰면 껍데기
// 셸이 무엇을 삼키든 진실이 남는다.
//
// ⛔이 모듈은 소비 판정(relay-handshake.mjs)에서 import되지 않는다 --
// 소비 쪽은 이 파일이 쓴 JSON을 그냥 읽기만 한다(fs.readFileSync +
// JSON.parse). relay-handshake.mjs를 고정 파일목록으로 격리 clone하는
// 다수의 mutation 시험(hyk186-time-authority-mutation.test.mjs 등)이
// 이미 있어, 그 파일에 새 정적 import를 추가하면 그 시험들의 고정
// sidecar 목록이 전부 이 파일도 알아야 하는 광범위한 파급이 생긴다 --
// admission-completion-adapter.mjs가 정확히 같은 이유로 정적 import되지
// 않고 이 저장소 전체가 "쓰는 쪽과 읽는 쪽은 별개 모듈" 관행을 쓰는 것과
// 동일 근거(consumption-receipt-writer.mjs 헤더 참조).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RUNNER_RECEIPT_SCHEMA_VERSION = 1;
export const RUNNER_RECEIPT_FILENAME = "runner-receipt.json";

function pad(n) {
  return String(n).padStart(2, "0");
}

// KST는 DST가 없다 -- UTC에서 고정 +9h를 더하는 쪽이 호스트 머신의 로컬
// 타임존 설정에 기대는 것보다 안정적이다(finalize-done.mjs의 formatKst와
// 동일 근거·동일 구현 -- 그 파일을 import하지 않는 이유도 위 헤더와 같다:
// isolated-suite-runner.mjs는 relay/ 쪽 모듈에 의존하지 않는다).
export function formatKst(nowMs) {
  const kst = new Date(nowMs + 9 * 60 * 60 * 1000);
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(
    kst.getUTCDate(),
  )} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())}:${pad(
    kst.getUTCSeconds(),
  )} KST`;
}

// `node --test`가 병기 tap reporter destination에 쓰는 표준 요약 줄
// (`# tests N` / `# pass N` / `# fail N` / `# skipped N`)을 파싱한다.
// 실측(이 라운드, node v26.2.0): 기본 reporter는 `ℹ`로, tap reporter는
// `#`로 같은 요약을 찍는다 -- 이 파서는 tap 목적지 파일을 대상으로 하므로
// `#`만 본다. 못 찾은 필드는 null로 남긴다(추정치로 메우지 않는다 --
// fail-closed는 소비 쪽 책임이고, 이 함수는 "모른다"를 정직하게 알린다).
export function parseTapSummaryCounts(tapText) {
  const pick = (label) => {
    const m = new RegExp(`^# ${label} (\\d+)\\s*$`, "m").exec(tapText ?? "");
    return m ? Number(m[1]) : null;
  };
  return {
    tests: pick("tests"),
    pass: pick("pass"),
    fail: pick("fail"),
    skip: pick("skipped"),
  };
}

export function buildRunnerReceipt({
  runnerExit,
  counts,
  headCommit,
  finishedAtMs,
}) {
  return {
    schema_version: RUNNER_RECEIPT_SCHEMA_VERSION,
    runner_exit: runnerExit,
    tests: counts?.tests ?? null,
    pass: counts?.pass ?? null,
    fail: counts?.fail ?? null,
    skip: counts?.skip ?? null,
    head_commit: headCommit,
    finished_at: formatKst(finishedAtMs),
  };
}

// `<root>/.harness/runner-receipt.json`에 쓴다. ⛔.harness/는 gitignore라
// CI·새 clone에는 애초에 없다(coder-task.md §2-1 정직 의무) -- 그 디렉터리가
// 없으면 만든다. §2-1 "실패했다고 영수증을 안 쓰면 안 된다"를 만족하려면
// 이 함수 자체는 절대 예외를 삼켜 "썼다"고 거짓 보고하지 않되, 호출자
// (runIsolatedSuite)는 이 쓰기가 실패해도 러너 자신의 exit code 전파를
// 절대 막지 않는다(그 쪽은 try/catch로 감싼다 -- 영수증을 못 쓰는 것이
// 시험 결과 자체를 감춰서는 안 된다).
export function writeRunnerReceipt({
  harnessDir,
  runnerExit,
  counts,
  headCommit,
  finishedAtMs,
  mkdirFn = mkdirSync,
  writeFileFn = writeFileSync,
}) {
  const dir = harnessDir;
  mkdirFn(dir, { recursive: true });
  const receipt = buildRunnerReceipt({
    runnerExit,
    counts,
    headCommit,
    finishedAtMs,
  });
  const path = join(dir, RUNNER_RECEIPT_FILENAME);
  writeFileFn(path, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return { path, receipt };
}
