import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ADMISSION_SCHEMA_VERSION,
  RESERVATION_STATUS,
  ADMISSION_DECISION,
  ADMISSION_REASON,
  createEmptyLedger,
  admitReservation,
  completeReservation,
  sweepAndRecover,
  buildCutoverLedger,
  countActive,
  isWellFormedLedger,
} from "./admission-ledger-core.mjs";

const EPOCH = "2026-08-11T00:00:00.000Z";
const T0 = "2026-08-11T00:00:01.000Z";
const T1 = "2026-08-11T00:00:02.000Z";

test("createEmptyLedger produces a well-formed ledger", () => {
  const ledger = createEmptyLedger(EPOCH);
  assert.equal(ledger.schema_version, ADMISSION_SCHEMA_VERSION);
  assert.equal(isWellFormedLedger(ledger), true);
  assert.equal(countActive(ledger), 0);
});

// RED ⓑ: 차단 분기 -- removing the `activeBefore >= cap` short-circuit
// (or its `<` inversion) collapses this into always-ADMITTED, which this
// test catches directly.
test("admitReservation blocks when cap is reached (RED-b: block branch)", () => {
  let ledger = createEmptyLedger(EPOCH);
  const first = admitReservation(ledger, {
    reservationId: "r1",
    cap: 1,
    now: T0,
  });
  assert.equal(first.decision, ADMISSION_DECISION.ADMITTED);
  ledger = first.ledger;

  const second = admitReservation(ledger, {
    reservationId: "r2",
    cap: 1,
    now: T1,
  });
  assert.equal(second.decision, ADMISSION_DECISION.BLOCKED);
  assert.equal(second.active, 1);
  // BLOCKED must not mutate -- the ledger returned is the SAME object, no
  // second reservation ever appears.
  assert.equal(second.ledger, ledger);
  assert.equal(countActive(second.ledger), 1);
  assert.equal(second.ledger.reservations.r2, undefined);
});

test("admitReservation admits when a slot is free", () => {
  const ledger = createEmptyLedger(EPOCH);
  const result = admitReservation(ledger, {
    reservationId: "r1",
    cap: 2,
    now: T0,
    role: "CODER",
    seatKey: "seat-1",
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision, ADMISSION_DECISION.ADMITTED);
  assert.equal(result.activeBefore, 0);
  assert.equal(result.active, 1);
  assert.equal(result.ledger.reservations.r1.status, RESERVATION_STATUS.ACTIVE);
  assert.equal(result.ledger.reservations.r1.role, "CODER");
  assert.equal(result.ledger.reservations.r1.seat_key, "seat-1");
});

test("admitReservation re-admitting the same ACTIVE reservationId is idempotent, not a second slot", () => {
  const ledger = createEmptyLedger(EPOCH);
  const first = admitReservation(ledger, {
    reservationId: "r1",
    cap: 1,
    now: T0,
  });
  const second = admitReservation(first.ledger, {
    reservationId: "r1",
    cap: 1,
    now: T1,
  });
  assert.equal(second.decision, ADMISSION_DECISION.ALREADY_ADMITTED);
  assert.equal(second.active, 1);
});

test("admitReservation rejects malformed cap/reservationId/now with INVALID_ARGUMENTS (fail-closed, not a silent default)", () => {
  const ledger = createEmptyLedger(EPOCH);
  assert.equal(
    admitReservation(ledger, { reservationId: "", cap: 1, now: T0 }).reasonCode,
    ADMISSION_REASON.INVALID_ARGUMENTS,
  );
  assert.equal(
    admitReservation(ledger, { reservationId: "r1", cap: -1, now: T0 })
      .reasonCode,
    ADMISSION_REASON.INVALID_ARGUMENTS,
  );
  assert.equal(
    admitReservation(ledger, { reservationId: "r1", cap: 1, now: "not-a-date" })
      .reasonCode,
    ADMISSION_REASON.INVALID_ARGUMENTS,
  );
});

// RED ⓒ: fail-closed -- removing the isWellFormedLedger guard (or loosening
// it) would let a malformed ledger silently produce a decision instead of
// LEDGER_MALFORMED; this test pins that it must not.
test("admitReservation refuses a malformed ledger snapshot (RED-c: fail-closed)", () => {
  const malformed = { schema_version: "wrong", epoch: EPOCH, reservations: {} };
  const result = admitReservation(malformed, {
    reservationId: "r1",
    cap: 2,
    now: T0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, ADMISSION_REASON.LEDGER_MALFORMED);
});

test("completeReservation frees the slot and is idempotent on a second call", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: T0,
  });
  const completed = completeReservation(admitted.ledger, {
    reservationId: "r1",
    now: T1,
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.changed, true);
  assert.equal(
    completed.ledger.reservations.r1.status,
    RESERVATION_STATUS.COMPLETED,
  );
  assert.equal(countActive(completed.ledger), 0);

  const again = completeReservation(completed.ledger, {
    reservationId: "r1",
    now: T1,
  });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
});

// HYK-342/HYK-249: `reason` is a new, optional field -- omitted (every
// pre-existing caller, including the two tests directly above) leaves
// `completion_reason` unset, byte-identical to before this round.
test("completeReservation without `reason` leaves completion_reason unset (byte-identical to pre-HYK-342)", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: T0,
  });
  const completed = completeReservation(admitted.ledger, {
    reservationId: "r1",
    now: T1,
  });
  assert.equal(completed.ok, true);
  assert.equal("completion_reason" in completed.ledger.reservations.r1, false);
});

test("completeReservation with `reason` stamps completion_reason on the released entry", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: T0,
  });
  const completed = completeReservation(admitted.ledger, {
    reservationId: "r1",
    now: T1,
    reason: "BLOCKED_TERMINATION_RELEASED",
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.changed, true);
  assert.equal(
    completed.ledger.reservations.r1.completion_reason,
    "BLOCKED_TERMINATION_RELEASED",
  );
  assert.equal(countActive(completed.ledger), 0);
});

test("completeReservation with `reason` is still idempotent -- a second call on an already-COMPLETED entry changes nothing (including completion_reason)", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: T0,
  });
  const completed = completeReservation(admitted.ledger, {
    reservationId: "r1",
    now: T1,
    reason: "BLOCKED_TERMINATION_RELEASED",
  });
  const again = completeReservation(completed.ledger, {
    reservationId: "r1",
    now: T1,
    reason: "SOME_OTHER_REASON_THAT_MUST_NOT_OVERWRITE",
  });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(
    again.ledger.reservations.r1.completion_reason,
    "BLOCKED_TERMINATION_RELEASED",
    "이미 COMPLETED인 항목은 재호출로 completion_reason이 덮어써지지 않는다",
  );
});

test("completeReservation on an unknown reservationId fails closed", () => {
  const ledger = createEmptyLedger(EPOCH);
  const result = completeReservation(ledger, {
    reservationId: "ghost",
    now: T0,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasonCode, ADMISSION_REASON.RESERVATION_NOT_FOUND);
});

test("completing a reservation frees the cap for a new admit (full lifecycle)", () => {
  let ledger = createEmptyLedger(EPOCH);
  const a1 = admitReservation(ledger, { reservationId: "r1", cap: 1, now: T0 });
  ledger = a1.ledger;
  const blocked = admitReservation(ledger, {
    reservationId: "r2",
    cap: 1,
    now: T1,
  });
  assert.equal(blocked.decision, ADMISSION_DECISION.BLOCKED);

  const completed = completeReservation(ledger, {
    reservationId: "r1",
    now: T1,
  });
  ledger = completed.ledger;
  const a2 = admitReservation(ledger, { reservationId: "r2", cap: 1, now: T1 });
  assert.equal(a2.decision, ADMISSION_DECISION.ADMITTED);
});

test("sweepAndRecover marks a stale ACTIVE reservation SUSPECT when its seat is not live", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: "2026-08-11T00:00:00.000Z",
    seatKey: "seat-dead",
  });
  const swept = sweepAndRecover(admitted.ledger, {
    now: "2026-08-11T01:00:00.000Z",
    liveSeatKeys: [],
    staleAfterMs: 30 * 60 * 1000,
    recoveryGraceMs: 60 * 60 * 1000,
  });
  assert.equal(swept.ok, true);
  assert.equal(swept.ledger.reservations.r1.status, RESERVATION_STATUS.SUSPECT);
  assert.equal(swept.changed.length, 1);
});

test("sweepAndRecover restores SUSPECT back to ACTIVE if the seat reappears live", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: "2026-08-11T00:00:00.000Z",
    seatKey: "seat-x",
  });
  const suspected = sweepAndRecover(admitted.ledger, {
    now: "2026-08-11T01:00:00.000Z",
    liveSeatKeys: [],
    staleAfterMs: 1000,
    recoveryGraceMs: 60 * 60 * 1000,
  });
  assert.equal(
    suspected.ledger.reservations.r1.status,
    RESERVATION_STATUS.SUSPECT,
  );

  const recovered = sweepAndRecover(suspected.ledger, {
    now: "2026-08-11T01:05:00.000Z",
    liveSeatKeys: ["seat-x"],
    staleAfterMs: 1000,
    recoveryGraceMs: 60 * 60 * 1000,
  });
  assert.equal(
    recovered.ledger.reservations.r1.status,
    RESERVATION_STATUS.ACTIVE,
  );
});

test("sweepAndRecover frees a SUSPECT reservation past recoveryGraceMs (reboot recovery)", () => {
  const admitted = admitReservation(createEmptyLedger(EPOCH), {
    reservationId: "r1",
    cap: 1,
    now: "2026-08-11T00:00:00.000Z",
    seatKey: "seat-dead",
  });
  const suspected = sweepAndRecover(admitted.ledger, {
    now: "2026-08-11T01:00:00.000Z",
    liveSeatKeys: [],
    staleAfterMs: 1000,
    recoveryGraceMs: 1000,
  });
  assert.equal(
    suspected.ledger.reservations.r1.status,
    RESERVATION_STATUS.SUSPECT,
  );

  const freed = sweepAndRecover(suspected.ledger, {
    now: "2026-08-11T02:00:00.000Z",
    liveSeatKeys: [],
    staleAfterMs: 1000,
    recoveryGraceMs: 1000,
  });
  assert.equal(
    freed.ledger.reservations.r1.status,
    RESERVATION_STATUS.COMPLETED,
  );
  assert.equal(countActive(freed.ledger), 0);
});

// HYK-224-3R §2 (REVIEW 2R 반려): 2R left a stale seatKey:null reservation
// completely untouched by sweep -- permanently invisible, "sweep 대상
// 아님으로 영원히 남지 마라"의 정확한 반례였다. 3R still refuses to GUESS
// liveness (status stays ACTIVE, never silently freed) but now flags it
// durably and visibly once it's old enough -- this test replaces the old
// "never touches it at all" assertion with the new flag-don't-guess
// contract.
test("sweepAndRecover flags (not silently ignores, not silently frees) a stale seatKey:null reservation", () => {
  const ledger = {
    schema_version: ADMISSION_SCHEMA_VERSION,
    epoch: EPOCH,
    reservations: {
      cutoverEntry: {
        status: RESERVATION_STATUS.ACTIVE,
        role: null,
        seat_key: null,
        admitted_at: "2026-08-11T00:00:00.000Z",
        completed_at: null,
        suspect_at: null,
        flagged_unjudgeable_at: null,
        source: "cutover",
      },
    },
  };
  const swept = sweepAndRecover(ledger, {
    now: "2026-08-12T00:00:00.000Z",
    liveSeatKeys: [],
    staleAfterMs: 1000,
    recoveryGraceMs: 1000,
  });
  // Still ACTIVE -- never auto-freed, no ground truth to justify that.
  assert.equal(
    swept.ledger.reservations.cutoverEntry.status,
    RESERVATION_STATUS.ACTIVE,
  );
  // But now visibly flagged, both in the durable ledger field and in the
  // sweep's own changed-list output.
  assert.equal(
    swept.ledger.reservations.cutoverEntry.flagged_unjudgeable_at,
    "2026-08-12T00:00:00.000Z",
  );
  assert.equal(swept.changed.length, 1);
  assert.equal(swept.changed[0].flag, "UNJUDGEABLE_NO_SEAT_KEY");

  // Idempotent -- a second sweep does not re-flag/re-report it.
  const sweptAgain = sweepAndRecover(swept.ledger, {
    now: "2026-08-13T00:00:00.000Z",
    liveSeatKeys: [],
    staleAfterMs: 1000,
    recoveryGraceMs: 1000,
  });
  assert.equal(sweptAgain.changed.length, 0);
  assert.equal(
    sweptAgain.ledger.reservations.cutoverEntry.flagged_unjudgeable_at,
    "2026-08-12T00:00:00.000Z",
  );
});

test("buildCutoverLedger seeds one ACTIVE reservation per live seat, and needs no old-dispatch input at all", () => {
  const result = buildCutoverLedger({
    liveSeats: [
      { seatKey: "seat-a", role: "CODER" },
      { seatKey: "seat-b", role: null },
    ],
    now: T0,
    epoch: T0,
  });
  assert.equal(result.ok, true);
  assert.equal(countActive(result.ledger), 2);
  const entries = Object.values(result.ledger.reservations);
  assert.equal(entries.filter((e) => e.source === "cutover").length, 2);
  assert.deepEqual(entries.map((e) => e.role).sort(), ["CODER", null].sort());
});

test("buildCutoverLedger with zero live seats produces an empty-but-valid epoch (matches today's ground truth: 0 running)", () => {
  const result = buildCutoverLedger({ liveSeats: [], now: T0, epoch: T0 });
  assert.equal(result.ok, true);
  assert.equal(countActive(result.ledger), 0);
  assert.equal(isWellFormedLedger(result.ledger), true);
});
