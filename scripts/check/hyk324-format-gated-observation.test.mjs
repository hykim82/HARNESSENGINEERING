// HYK-324 §2-2 (관측은 형식 검사 이후에만) + HYK-325 §2-3 (finalize-done
// 마커 검사, 원래는 경고-only) -- coder-task.md §3 시험 6/7/9.
// HYK-418 §2-1: HYK-325 §2-3의 마커 검사를 경고에서 fail-closed 거부로
// 승격했다 -- 시험9(과 그 대조군)는 그 승격을 반영해 재작성했다(원래
// 제목/단언은 주석으로 보존, 아래 각 시험 자신의 헤더 참조).
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
    // HYK-418 §2-1: this test's own subject is the observation contract for
    // a format-VALID DONE line, not the marker gate -- carry the marker so
    // it reaches that contract instead of being intercepted by the (now
    // fail-closed) marker check first. See 시험9 below for the marker gate's
    // own dedicated test.
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-19 19:01:11 KST\ndone_stamped_by: finalize-done\n`,
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

// HYK-418 §2-1: this test used to lock down HYK-325 §2-3's warn-only
// contract ("no marker must never block consumption"). That contract is
// exactly what this round promotes to fail-closed (coder-task.md §1 요구4)
// -- rewritten to assert the NEW contract instead of the old one. The old
// title/assertion is preserved here as a comment so the history of what
// changed and why stays visible in the diff, not just in a commit message.
test("시험9 (HYK-418 §2-1로 재작성): finalize-done 마커 없는 (형식은 유효한) DONE -> 거부(더 이상 경고만이 아니다), 사유에 복구 명령이 담긴다", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk324_no_marker_rejected";

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
    assert.equal(
      result.ok,
      false,
      "HYK-418 §2-1: an unmarked (likely hand-typed) DONE line must now be rejected, not just warned about",
    );
    assert.match(
      result.reason,
      /has no 'done_stamped_by: finalize-done' marker/,
    );
    assert.match(
      result.reason,
      /node scripts\/relay\/finalize-done\.mjs coder/,
    );
  });

  assert.ok(
    messages.some(
      (m) => m.includes("first-observation skipped") && m.includes("marker"),
    ),
    `expected a first-observation-skipped message naming the marker, got: ${JSON.stringify(messages)}`,
  );

  const logPath = observationLogPath(harnessDir, role);
  assert.equal(
    existsSync(logPath),
    false,
    "HYK-418 §2-2: a value this function rejects must never be recorded as first-observed",
  );
});

test("시험9 대조군: finalize-done 마커가 있으면 거부되지 않는다", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk324_marker_present_no_rejection";

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
    !messages.some((m) => m.includes("no finalize-done marker")),
    `expected no marker-rejection message when the marker is present, got: ${JSON.stringify(messages)}`,
  );
});
