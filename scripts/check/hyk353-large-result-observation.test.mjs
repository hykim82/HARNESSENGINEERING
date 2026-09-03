// HYK-353 회귀 고정 -- 결과 파일이 크면(41,894바이트 실사고, ORCH 실측
// 2026-08-25) spawnObserveDoneLine이 payload를 argv로 넘겨 OS 명령줄 길이
// 한계를 넘었다(Windows ENAMETOOLONG). checkRelayHandshake 자신은 그
// 실패를 best-effort/non-fatal로 삼켜 ok:true를 그대로 반환했고, 그 결과
// «첫 관측» 로그 줄이 조용히 사라졌다(소비 표시 tombstone 한 줄만 남음).
//
// 수리(이 라운드): payload를 argv 대신 stdin으로 넘긴다(execFileSync의
// `input` 옵션) -- 이제 크기와 무관하다. ⛔"몇 바이트면 터진다"를
// 하드코딩하지 않는다 -- 아래 padding은 실사고(41,894바이트)보다 뚜렷이
// 크게만 잡아(플랫폼별 argv 한계 추정치와 무관), "이 정도로 커도 여전히
// 관측된다"는 것을 보인다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";

function freshHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk353-large-result-test-"));
}

function kstToMs(kstText) {
  return new Date(`${kstText.replace(" ", "T")}+09:00`).getTime();
}

function observationLogPath(role, harnessDir) {
  return join(harnessDir, `${role}-done-first-observation.jsonl`);
}

test("HYK-353: 큰 결과 파일(실사고보다 뚜렷이 큰 합성 패딩)도 첫 관측 줄을 잃지 않는다", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk353_large_result";
  const doneLineRaw = ">>> DONE: CODER @ 2026-08-17 09:05:00 KST";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-17 09:00 KST\n`,
    "utf8",
  );

  // 실사고(41,894바이트)보다 뚜렷이 큰 합성 패딩 -- 재작업 라운드가 누적된
  // 실제 결과 파일을 흉내낸다. 특정 임계값을 겨냥하지 않는다(플랫폼마다
  // 실제 argv 한계가 다르다는 것이 이 라운드의 근거).
  const padding = "x".repeat(200_000);
  // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
  // with no finalize-done marker (fail-closed) -- carry the marker so
  // this fixture reaches the large-payload observation axis unmasked.
  const resultContent = `task_id: ${taskId}\n${padding}\n${doneLineRaw}\ndone_stamped_by: finalize-done\n`;
  writeFileSync(join(harnessDir, `${role}.md`), resultContent, "utf8");

  const now = kstToMs("2026-08-17 09:05:05");
  const result = checkRelayHandshake({ role, harnessDir, now });
  assert.equal(
    result.ok,
    true,
    `round itself must still complete cleanly: ${JSON.stringify(result)}`,
  );

  const logRaw = readFileSync(observationLogPath(role, harnessDir), "utf8");
  const entries = logRaw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  // 정상 라운드는 두 줄을 남긴다: 첫 관측(지문·DONE 원문·관측 시각) +
  // 소비 표시(tombstone). 수리 전에는 첫 관측 줄이 통째로 빠져 tombstone
  // 한 줄만 남았다(이 시험이 고정하는 회귀).
  const observationEntries = entries.filter((e) => e.consumed !== true);
  const tombstoneEntries = entries.filter((e) => e.consumed === true);
  assert.equal(
    observationEntries.length,
    1,
    `expected exactly one first-observation entry, got: ${JSON.stringify(entries)}`,
  );
  assert.equal(tombstoneEntries.length, 1);

  const observed = observationEntries[0];
  assert.equal(observed.taskId, taskId);
  assert.equal(observed.doneLineRaw, doneLineRaw);
  assert.ok(
    typeof observed.resultFingerprint === "string" &&
      observed.resultFingerprint.length > 0,
    "first-observation entry must carry a result fingerprint",
  );
  assert.ok(
    typeof observed.observedAtMs === "number",
    "first-observation entry must carry an observed-at timestamp",
  );
});
