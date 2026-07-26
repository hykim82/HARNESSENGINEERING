import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATTEMPT_REASON,
  createEmptyJournal,
  computeFailureFingerprint,
  recordFailure,
  attemptRecovery,
} from "./failure-journal.mjs";
import { fields } from "./hyk171-cycle4b2b2-axisB-fixtures.mjs";

// HYK-171 사이클4b-2b-2 (coder-task.md §4 축B) -- durable 실패 원장 mutation
// 원장. 4건, 전부 프로덕션 진입점(computeFailureFingerprint/recordFailure/
// attemptRecovery)을 직접 구동한다(helper 조립 금지). "실제 RED 재현"은
// 결과 보고서(.harness/coder.md)에 별도 기록한다.

// ---------------------------------------------------------------------------
// B1 -- fingerprint 구성 필드 하나가 빠지면(다른 실패인데) 같은 fingerprint
// 로 뭉개지면 안 된다.
// ---------------------------------------------------------------------------
test("mutation B1: two failures that differ only in errorCode must never collapse to the same fingerprint", () => {
  const a = computeFailureFingerprint(
    fields({ errorCode: "EVIDENCE_NOT_DURABLE" }),
  );
  const b = computeFailureFingerprint(
    fields({ errorCode: "PROTECTED_TARGET" }),
  );
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.fingerprint, b.fingerprint);
});

// ---------------------------------------------------------------------------
// B2 -- requiresHumanAck 검사가 제거되면 ack 없이도 자동 재시도가 일어난다.
// ---------------------------------------------------------------------------
test("mutation B2: requiresHumanAck failure recorded, no ack given -- attemptRecovery must never execute", () => {
  const { fingerprint } = computeFailureFingerprint(fields());
  const { journal } = recordFailure(createEmptyJournal(), {
    fingerprint,
    fields: fields(),
    requiresHumanAck: true,
    observedAtMs: 1000,
  });
  let calls = 0;
  const r = attemptRecovery(journal, {
    fingerprint,
    executeFn: () => {
      calls += 1;
    },
  });
  assert.equal(r.executed, false);
  assert.equal(r.reason, ATTEMPT_REASON.BLOCKED_PENDING_HUMAN_ACK);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// B3 -- 같은 fingerprint의 두 번째 호출에서 실행이 허용되면 안 된다(재시도
// 0 기대).
// ---------------------------------------------------------------------------
test("mutation B3: same fingerprint attempted twice while unacked -- the second call executes zero times", () => {
  const { fingerprint } = computeFailureFingerprint(fields());
  const { journal: j1 } = recordFailure(createEmptyJournal(), {
    fingerprint,
    fields: fields(),
    requiresHumanAck: true,
    observedAtMs: 1000,
  });
  let calls = 0;
  const first = attemptRecovery(j1, {
    fingerprint,
    executeFn: () => {
      calls += 1;
    },
  });
  // 실제 프로덕션 사용 패턴: 첫 시도가 blocked였으므로 journal은 그대로다.
  const second = attemptRecovery(first.journal, {
    fingerprint,
    executeFn: () => {
      calls += 1;
    },
  });
  assert.equal(first.executed, false);
  assert.equal(second.executed, false);
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// B4 -- 원장 기록이 개수만 남기고 필드 내용을 지우면(예: 카운터로만 뭉개면)
// 계약 필드(taskId·fingerprint 구성·ack 상태) 단언이 깨져야 한다.
// ---------------------------------------------------------------------------
test("mutation B4: recorded entry must expose contract fields (fields.taskId, requiresHumanAck, ack.status) -- a count-only entry fails these assertions", () => {
  const { fingerprint } = computeFailureFingerprint(fields());
  const { journal } = recordFailure(createEmptyJournal(), {
    fingerprint,
    fields: fields(),
    requiresHumanAck: true,
    observedAtMs: 1000,
  });
  const entry = journal.failures[fingerprint];
  assert.equal(entry.fields.taskId, "taskMain");
  assert.equal(entry.fields.dispatchId, "dispatchMain");
  assert.equal(entry.fields.errorCode, "EVIDENCE_NOT_DURABLE");
  assert.equal(entry.requiresHumanAck, true);
  assert.equal(entry.ack.status, "unacked");
  assert.equal(typeof entry.occurrences, "number");
});
