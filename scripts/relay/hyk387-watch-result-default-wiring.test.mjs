// HYK-387 2R §1 (P1-1 직접 수리, 검토자의 정확한 재현): 검토자가 실사고를
// 증명한 정확한 모양 -- `DISPATCH_RECEIPT_LEDGER_PATH`가 존재하지 않는
// 원장 파일을 가리키게 세팅한 채, `watch-result.mjs`의 실 진입점
// `watchResult({role, harnessDir})`을 (checkFn 주입 없이, 기본값
// `checkRelayHandshake` 그대로) 그대로 구동한다. 검토 원문의 관측 숫자:
// "env가 가리키는 원장 파일은 없음인데 watchResult 결과가 status:'done',
// elapsedS:0, 프로세스 exit 0" -- 이 시험은 그 관측이 2R 수리 뒤에는 더 이상
// 재현되지 않음을 고정한다.
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
// 건드리지 않는다. `DISPATCH_RECEIPT_LEDGER_PATH`는 이 시험 프로세스
// 자신의 process.env만, 항상 원상복구하며 건드린다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { watchResult } from "./watch-result.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE)); // scripts/relay -> scripts -> repo root
// hyk387-dispatch-record-required.test.mjs와 동일한 이유로 `.harness/` 아래
// 둔다(.gitignore 전체 무시 대상 -- 병렬 시험이 git status를 오염된 것으로
// 보지 않는다).
const SCRATCH_ROOT = join(REPO_ROOT, ".harness", "hyk387-watchresult-scratch");

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

async function withDispatchLedgerEnvAsync(ledgerPath, fn) {
  const prior = process.env.DISPATCH_RECEIPT_LEDGER_PATH;
  process.env.DISPATCH_RECEIPT_LEDGER_PATH = ledgerPath;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.DISPATCH_RECEIPT_LEDGER_PATH;
    else process.env.DISPATCH_RECEIPT_LEDGER_PATH = prior;
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

test("(hyk387-wr-1)★ 완료조건1(검토자의 정확한 재현): watch-result.mjs의 실 진입점 watchResult({role,harnessDir}) -- checkFn 주입 없이, 기본값 그대로 -- env만 설정하면 존재하지 않는 원장을 가리켜도 더 이상 done/exit-equivalent 0이 아니다", async () => {
  await withFixtureDirAsync("default-wiring-watchresult-", async (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "does-not-exist.jsonl"); // 검토자 원문과 동일: 존재하지 않는 원장
    const outcome = await withDispatchLedgerEnvAsync(ledgerPath, () =>
      // checkFn을 주입하지 않는다 -- 기본값(checkRelayHandshake) 그대로,
      // watch-result.mjs가 production에서 실제로 쓰는 바로 그 호출 모양.
      watchResult({ role: "coder", harnessDir: dir, maxWaitS: 1 }),
    );
    assert.notEqual(
      outcome.status,
      "done",
      `검토자 원문 재현: env가 존재하지 않는 원장을 가리킬 때 watchResult가 더 이상 "done"을 내면 안 된다 (실제: ${JSON.stringify(outcome)})`,
    );
  });
});

test("(hyk387-wr-2) 무회귀: env가 설정되지 않으면 watchResult는 그대로 done(정상 라운드는 여전히 통과)", async () => {
  await withFixtureDirAsync("noop-watchresult-", async (dir) => {
    writeCoderRound(dir);
    assert.equal(process.env.DISPATCH_RECEIPT_LEDGER_PATH, undefined);
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
