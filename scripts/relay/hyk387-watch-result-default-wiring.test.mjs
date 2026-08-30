// HYK-387 2R §1 (P1-1 직접 수리, 검토자의 정확한 재현), 3R §1 갱신
// (fallback 원천을 env에서 포인터 파일로 교체 -- relay-handshake.mjs
// 헤더의 "★3R 작업 도중 자체 발견·되돌림" 참조, env 방식이 이 저장소
// CI-canonical 시험 수십 개를 새로 ambient-leak에 노출시켰다): 검토자가
// 실사고를 증명한 정확한 모양 -- 존재하지 않는 원장 파일을 가리키는
// `<harnessDir>/dispatch-receipt-path.txt` 포인터 파일만 두고,
// `watch-result.mjs`의 실 진입점 `watchResult({role, harnessDir})`을
// (checkFn 주입 없이, 기본값 `checkRelayHandshake` 그대로) 그대로
// 구동한다. 검토 원문의 관측 숫자: "env가 가리키는 원장 파일은 없음인데
// watchResult 결과가 status:'done', elapsedS:0, 프로세스 exit 0" -- 이
// 시험은 그 관측이 2R/3R 수리 뒤에는 더 이상 재현되지 않음을 고정한다.
//
// ⛔이 시험을 scripts/check/hyk387-dispatch-record-required.test.mjs에
// 두지 않은 이유: A3 인벤토리 경계(HYK-148, quality-check의
// no-restricted-imports)가 scripts/check/* -> scripts/relay/* import를
// 금지한다(실제 의존 방향은 relay -> check 뿐) -- `watch-result.mjs`를
// 직접 import해야 하는 이 시험은 관계 방향이 허용되는 이 파일(scripts/
// relay/*)에 둔다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 이 워크트리 «안»의 mkdtemp
// 디렉터리에만 쓴다(coder-task.md §0 경계 2 그대로) -- 시스템 TEMP/TMP는
// 건드리지 않는다. 포인터 파일은 그 mkdtemp 디렉터리 안에만 쓴다 --
// 어떤 ambient 프로세스 상태도 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchResult } from "./watch-result.mjs";

// HYK-394-test-leak-3 §2 Q1 (검토자 rejected 판정, 2026-08-30 실사고):
// 이전에는 `join(REPO_ROOT, ".harness", "hyk387-watchresult-scratch")`
// -- 이 워크트리 자신의 «라이브» `.harness/` 아래였다. `.harness/`가
// 전체 gitignore 대상이라 병렬 시험의 git-status 스냅숏 오염은 피했지만
// (그 자체는 유효한 과거 근거, hyk387-dispatch-record-required.test.mjs의
// 같은 주석 참조), 그 대가로 이 스크래치 트리가 «진짜» ORCH 라운드 파일과
// 같은 디렉터리 트리를 공유했다 -- 오늘 밤 실사고: 그 형태로 이 워크트리의
// 실제 검토 결과·영수증이 소실됐다. `os.tmpdir()`는 두 문제를 동시에
// 푼다 -- 저장소 밖이라 git status에 절대 안 잡히고(과거 근거 그대로
// 유지), 라이브 `.harness/`와 물리적으로 분리돼 있어 어떤 실제 라운드
// 파일과도 경로를 공유하지 않는다.
const SCRATCH_ROOT = join(tmpdir(), "hyk387-watchresult-scratch");

async function withFixtureDirAsync(prefix, fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  }
}

// HYK-387 2R (자체 회귀 수리): 절대 달력 값 대신 "지금으로부터 상대
// 오프셋"을 쓴다 -- 하드코딩된 절대 시각은 하루 중 실행 시각이 그 값과
// "정확히 9시간" 근처(KST_OFFSET_MS ± TZ_MISLABEL_TOLERANCE_MS=10분,
// time-authority.mjs)로 들어오면 SUSPECTED_TZ_MISLABEL로 먼저 거부돼
// flaky해진다(hyk387-dispatch-record-required.test.mjs와 동일 근거,
// 그쪽에서 직접 실측 재현).
function formatKst(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

function writeCoderRound(dir, { taskId = "HYK-387-WR-T" } = {}) {
  const now = Date.now();
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(now - 20 * 60 * 1000)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ ${formatKst(now - 10 * 60 * 1000, { seconds: true })}\n`,
    "utf8",
  );
}

test("(hyk387-wr-1)★ 완료조건1(검토자의 정확한 재현): watch-result.mjs의 실 진입점 watchResult({role,harnessDir}) -- checkFn 주입 없이, 기본값 그대로 -- 포인터 파일만 있으면 존재하지 않는 원장을 가리켜도 더 이상 done/exit-equivalent 0이 아니다", async () => {
  await withFixtureDirAsync("default-wiring-watchresult-", async (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "does-not-exist.jsonl"); // 검토자 원문과 동일: 존재하지 않는 원장
    writeFileSync(join(dir, "dispatch-receipt-path.txt"), ledgerPath, "utf8");
    assert.equal(existsSync(ledgerPath), false);
    // checkFn을 주입하지 않는다 -- 기본값(checkRelayHandshake) 그대로,
    // watch-result.mjs가 production에서 실제로 쓰는 바로 그 호출 모양.
    const outcome = await watchResult({
      role: "coder",
      harnessDir: dir,
      maxWaitS: 1,
    });
    assert.notEqual(
      outcome.status,
      "done",
      `검토자 원문 재현: 포인터 파일이 존재하지 않는 원장을 가리킬 때 watchResult가 더 이상 "done"을 내면 안 된다 (실제: ${JSON.stringify(outcome)})`,
    );
  });
});

test("(hyk387-wr-2) 무회귀: 포인터 파일이 없으면 watchResult는 그대로 done(정상 라운드는 여전히 통과)", async () => {
  await withFixtureDirAsync("noop-watchresult-", async (dir) => {
    writeCoderRound(dir);
    const outcome = await watchResult({
      role: "coder",
      harnessDir: dir,
      maxWaitS: 1,
    });
    assert.equal(
      outcome.status,
      "done",
      `무회귀 위반: ${JSON.stringify(outcome)}`,
    );
  });
});
