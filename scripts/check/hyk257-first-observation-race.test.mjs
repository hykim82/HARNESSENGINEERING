// HYK-257-done-stamp-2 §2 범위1 -- 실사례 재현 + 정상 라운드 오탐 0 증명.
//
// §2 범위1 실사례 (coder-task.md, 증거 폴더 2026-08-17-hyk257-미래시각-
// 자기정정, 읽기만):
//   05:37:23.998 관측 → >>> DONE: CODER @ 2026-08-17 05:44:12 KST   / 최종 05:37:54
//   06:26:36.210 관측 → >>> DONE: CODER @ 2026-08-17 06:09:47 KST   / 최종 06:26:37
//   10:46:37     관측 → >>> DONE: CODER @ 2026-08-17 10:52:07 KST   / 최종 10:46:39
//
// This test replays incident #1 synthetically: checkRelayHandshake is
// called TWICE for the same taskId (mirroring watch-result.mjs's real
// polling loop) -- once while the result file still carries the
// first-written (bad/future) DONE value, once after the worker
// self-corrected it -- and asserts the SECOND (final, judged) call is
// rejected with TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION.
//
// A second test proves the 오탐 0 requirement: a normal round (single
// observation, same value at judgment time) produces ok:true with NO new
// rejection from this channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkRelayHandshake,
  TIME_AUTHORITY_STATE,
} from "./relay-handshake.mjs";

function freshHarnessDir() {
  return mkdtempSync(join(tmpdir(), "hyk257-2r-race-test-"));
}

function kstToMs(kstText) {
  return new Date(`${kstText.replace(" ", "T")}+09:00`).getTime();
}

test("실사례 #1 재현: 첫 관측(05:44:12, future) -> 자기정정 후 최종(05:37:54) -- 중간 수정 감지·거부", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk257_incident1";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-17 05:30 KST\n`,
    "utf8",
  );

  // Poll #1: mirrors watch-result.mjs's first poll -- worker has written
  // the (bad, future-skewed) 05:44:12 DONE value. `now` pinned to the real
  // observed-at instant (05:37:23.998 KST) from the incident.
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-17 05:44:12 KST\n`,
    "utf8",
  );
  const poll1Now = kstToMs("2026-08-17 05:37:23.998");
  const poll1 = checkRelayHandshake({ role, harnessDir, now: poll1Now });
  console.log(
    "POLL#1 (first observation, future-skewed DONE):",
    JSON.stringify(poll1),
  );
  assert.equal(poll1.ok, false);
  assert.equal(poll1.state, TIME_AUTHORITY_STATE.FUTURE_DONE);

  // Poll #2: mirrors watch-result.mjs's next poll, after the worker
  // self-corrected the DONE line to the real final value (05:37:54).
  // `now` advanced accordingly.
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-17 05:37:54 KST\n`,
    "utf8",
  );
  const poll2Now = kstToMs("2026-08-17 05:38:10");
  const poll2 = checkRelayHandshake({ role, harnessDir, now: poll2Now });
  console.log("POLL#2 (final judged value, corrected):", JSON.stringify(poll2));
  assert.equal(poll2.ok, false);
  assert.equal(
    poll2.state,
    TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
  );
  assert.match(poll2.reason, /05:44:12/);
  assert.match(poll2.reason, /05:37:54/);
});

test("정상 라운드(단일 관측, 최종본과 동일값) -- 오탐 0: 이 채널로 인한 새 거부 없음, ok:true", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "task_hyk257_normal_round";

  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-17 09:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-17 09:05:00 KST\n`,
    "utf8",
  );
  const now = kstToMs("2026-08-17 09:05:05");

  // Simulate watch-result.mjs's own repeated polling of the SAME
  // never-changed content -- the immediate pre-sleep check plus one poll
  // tick, per watchResult's own loop shape (checkFn called once before any
  // sleep, then again each tick). Neither call may be flagged by this
  // channel: identical content both times.
  const pollA = checkRelayHandshake({ role, harnessDir, now });
  console.log("NORMAL ROUND poll A:", JSON.stringify(pollA));
  const pollB = checkRelayHandshake({ role, harnessDir, now: now + 1000 });
  console.log(
    "NORMAL ROUND poll B (re-poll, unchanged content):",
    JSON.stringify(pollB),
  );

  assert.equal(pollA.ok, true);
  assert.notEqual(
    pollA.state,
    TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
  );
  // pollB re-observes the exact same content a second time -- still must
  // not be flagged as a rewrite (same value, not a different one).
  assert.notEqual(
    pollB.state,
    TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
  );
});

// HYK-257-done-stamp-3 §2 범위1 (2R 반려 조치): "★증명 시험 -- 같은
// task_id로 정상 1R -> 2R를 이어서 돌렸을 때 오탐 0(2R이 통과)임을 시험으로
// 고정하라" -- 이 시험이 그 요구를 문자 그대로 재현한다. 실물
// checkRelayHandshake를 통해 라운드 1을 완전히 소비(ok:true)시킨 뒤, ORCH가
// 같은 task_id로 다음 라운드를 다시 떨어뜨리는(HYK-241의 정상 관례) 실제
// 파일 갱신 순서를 그대로 재현한다.
test("HYK-257-done-stamp-3: 같은 task_id의 정상 1R -> 2R 연속 소비 -- 2R 오탐 0(2R 판정도 ok:true)", () => {
  const harnessDir = freshHarnessDir();
  const role = "coder";
  const taskId = "HYK-257-repeat-task-id"; // same task_id across both rounds -- normal ORCH re-drop

  // Round 1: drop, worker finishes with the DONE line matching what was
  // observed the whole time (no tampering) -- judged complete.
  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-17 08:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-17 08:05:00 KST\n`,
    "utf8",
  );
  const round1Now = kstToMs("2026-08-17 08:05:05");
  const round1 = checkRelayHandshake({ role, harnessDir, now: round1Now });
  console.log("ROUND 1 (judged complete):", JSON.stringify(round1));
  assert.equal(round1.ok, true, "round 1 itself must pass cleanly");

  // ORCH re-drops the SAME taskId for round 2 (new dropped_at, new task
  // body) -- this overwrites both live files exactly as the real relay
  // does between rounds.
  writeFileSync(
    join(harnessDir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: 2026-08-17 08:30 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(harnessDir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-17 08:35:00 KST\n`,
    "utf8",
  );
  const round2Now = kstToMs("2026-08-17 08:35:05");
  const round2 = checkRelayHandshake({ role, harnessDir, now: round2Now });
  console.log("ROUND 2 (same task_id, new round):", JSON.stringify(round2));
  assert.equal(
    round2.ok,
    true,
    "round 2 (same task_id, genuinely new round) must NOT be false-flagged as an intermediate rewrite of round 1",
  );
  assert.notEqual(
    round2.state,
    TIME_AUTHORITY_STATE.DONE_REWRITTEN_AFTER_FIRST_OBSERVATION,
  );
});
