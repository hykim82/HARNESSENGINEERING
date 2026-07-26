import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FINGERPRINT_FIELDS,
  ATTEMPT_REASON,
  createEmptyJournal,
  computeFailureFingerprint,
  recordFailure,
  ackFailure,
  attemptRecovery,
  parseJournalText,
} from "./failure-journal.mjs";

function fields(overrides = {}) {
  return {
    scope: "teardown",
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    errorCode: "EVIDENCE_NOT_DURABLE",
    ...overrides,
  };
}

test("computeFailureFingerprint: complete fields produce a stable joined key", () => {
  const r1 = computeFailureFingerprint(fields());
  const r2 = computeFailureFingerprint(fields());
  assert.equal(r1.ok, true);
  assert.equal(r1.fingerprint, r2.fingerprint);
  assert.equal(
    r1.fingerprint,
    "teardown::taskMain::dispatchMain::EVIDENCE_NOT_DURABLE",
  );
});

test("computeFailureFingerprint: any missing FINGERPRINT_FIELDS entry -- no fingerprint made (fail-closed)", () => {
  for (const key of FINGERPRINT_FIELDS) {
    const r = computeFailureFingerprint(fields({ [key]: undefined }));
    assert.equal(r.ok, false, `missing ${key} should fail closed`);
  }
});

test("recordFailure: appends a full-field entry, not a bare counter", () => {
  const { fingerprint } = computeFailureFingerprint(fields());
  const { ok, journal } = recordFailure(createEmptyJournal(), {
    fingerprint,
    fields: fields(),
    requiresHumanAck: true,
    observedAtMs: 1000,
  });
  assert.equal(ok, true);
  const entry = journal.failures[fingerprint];
  assert.equal(entry.fields.taskId, "taskMain");
  assert.equal(entry.requiresHumanAck, true);
  assert.equal(entry.ack.status, "unacked");
  assert.equal(entry.occurrences, 1);
});

test("recordFailure: missing fingerprint records nothing (fail-closed)", () => {
  const { ok, journal, reason } = recordFailure(createEmptyJournal(), {
    fields: fields(),
  });
  assert.equal(ok, false);
  assert.equal(reason, "fingerprint-missing");
  assert.deepEqual(journal.failures, {});
});

test("attemptRecovery: no prior failure recorded -- executes", () => {
  let calls = 0;
  const r = attemptRecovery(createEmptyJournal(), {
    fingerprint: "fp-fresh",
    executeFn: () => {
      calls += 1;
    },
  });
  assert.equal(r.executed, true);
  assert.equal(r.reason, ATTEMPT_REASON.EXECUTED);
  assert.equal(calls, 1);
});

test("attemptRecovery: requiresHumanAck unacked failure blocks the second attempt -- zero executions", () => {
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

test("attemptRecovery: after ackFailure, the same fingerprint is allowed to execute again", () => {
  const { fingerprint } = computeFailureFingerprint(fields());
  const { journal: j1 } = recordFailure(createEmptyJournal(), {
    fingerprint,
    fields: fields(),
    requiresHumanAck: true,
    observedAtMs: 1000,
  });
  const { ok: ackOk, journal: j2 } = ackFailure(j1, {
    fingerprint,
    ackedAtMs: 2000,
  });
  assert.equal(ackOk, true);
  let calls = 0;
  const r = attemptRecovery(j2, {
    fingerprint,
    executeFn: () => {
      calls += 1;
    },
  });
  assert.equal(r.executed, true);
  assert.equal(calls, 1);
});

test("ackFailure: unknown fingerprint is a safe no-op", () => {
  const { ok, reason } = ackFailure(createEmptyJournal(), {
    fingerprint: "fp-unknown",
  });
  assert.equal(ok, false);
  assert.equal(reason, "not-found");
});

test("parseJournalText: corrupt JSON and schema mismatch both fail closed", () => {
  assert.equal(parseJournalText("{not json").ok, false);
  assert.equal(
    parseJournalText(JSON.stringify({ schemaVersion: 999 })).ok,
    false,
  );
});
