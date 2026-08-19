// HYK-324 §2-2 (관측은 형식 검사 이후에만) + HYK-325 §2-3 (finalize-done
// 마커 경고, 거부 아님) -- coder-task.md §3 시험 6/7/9.
//
// 시험 8(★경합 보호 회귀: 형식 유효값을 관측한 뒤 그 값이 바뀌면 여전히
// 거부되는가)은 이 라운드가 새로 만들 필요가 없다 -- 이미
// hyk257-first-observation-race.test.mjs의 "실사례 #1 재현" 시험이 정확히
// 그 시나리오(첫 관측 05:44:12 -> 자기정정 05:37:54 -> 거부)를 문자 그대로
// 재현하고 있고, 이번 변경은 그 함수의 "형식 VALID 값에 대한" 동작을
// 전혀 건드리지 않았다(이 파일의 아래 시험 6이 그 불변을 별도로 다시
// 증명한다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";

function freshHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk324-format-gate-test-"));
}

function kstToMs(kstText) {
  return new Date(`${kstText.replace(" ", "T")}+09:00`).getTime();
}

function observationLogPath(harnessDir, role) {
  return join(harnessDir, `${role}-done-first-observation.jsonl`);
}

function withCapturedStderr(fn) {
  const original = console.error;
  const messages = [];
  console.error = (...args) => messages.push(args.join(" "));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return messages;
}

test("시험6: 형식 유효 DONE -> 첫 관측이 기록된다(기존 동작 유지)", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk324_valid_observed";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-19 19:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 19:01:11 KST\n`,
    "utf8",
  );

  const result = checkRelayHandshake({
    role,
    harnessDir,
    now: kstToMs("2026-08-19 19:01:15"),
  });
  assert.equal(result.ok, true);

  const logPath = observationLogPath(harnessDir, role);
  assert.equal(existsSync(logPath), true, "observation log must exist");
  const entries = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  assert.ok(
    entries.some((e) => e.taskId === taskId),
    "a first-observation entry for this round must have been recorded",
  );
});

test("시험7: 형식 불량(오늘 실제 문면, 분 단위) DONE -> 관측 미기록 + 사유 출력, 관측 없음", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk324_malformed_skipped";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-19 18:50 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 18:56 KST\n`,
    "utf8",
  );

  const messages = withCapturedStderr(() => {
    const result = checkRelayHandshake({
      role,
      harnessDir,
      now: kstToMs("2026-08-19 19:00:00"),
    });
    assert.equal(result.ok, false);
  });

  assert.ok(
    messages.some(
      (m) => m.includes("first-observation skipped") && m.includes("malformed"),
    ),
    `expected a first-observation-skipped message, got: ${JSON.stringify(messages)}`,
  );

  const logPath = observationLogPath(harnessDir, role);
  assert.equal(
    existsSync(logPath),
    false,
    "no observation entry must have been written for a malformed DONE line",
  );
});

test("시험9: finalize-done 마커 없는 (형식은 유효한) DONE -> 경고만, 소비는 성공", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk324_no_marker_warns";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-19 19:00 KST\n`,
    "utf8",
  );
  // 손기입을 흉내낸다 -- finalize-done.mjs가 찍는 `done_stamped_by:` 마커가
  // 없는, 그러나 형식은(초 단위) 유효한 DONE 줄.
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 19:01:11 KST\n`,
    "utf8",
  );

  const messages = withCapturedStderr(() => {
    const result = checkRelayHandshake({
      role,
      harnessDir,
      now: kstToMs("2026-08-19 19:01:15"),
    });
    assert.equal(result.ok, true, "no marker must never block consumption");
  });

  assert.ok(
    messages.some(
      (m) => m.includes("warning") && m.includes("finalize-done marker"),
    ),
    `expected a no-marker warning, got: ${JSON.stringify(messages)}`,
  );
});

test("시험9 대조군: finalize-done 마커가 있으면 경고가 없다", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk324_marker_present_no_warning";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-19 19:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 19:01:11 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );

  const messages = withCapturedStderr(() => {
    const result = checkRelayHandshake({
      role,
      harnessDir,
      now: kstToMs("2026-08-19 19:01:15"),
    });
    assert.equal(result.ok, true);
  });

  assert.ok(
    !messages.some(
      (m) => m.includes("warning") && m.includes("finalize-done marker"),
    ),
    `expected no marker warning when marker is present, got: ${JSON.stringify(messages)}`,
  );
});
