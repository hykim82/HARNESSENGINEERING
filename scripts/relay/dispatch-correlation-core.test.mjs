import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORRELATION,
  REASON,
  judgeDispatchCorrelation,
} from "./dispatch-correlation-core.mjs";

function seatRecord(overrides = {}) {
  return {
    paneKey: "seatMain-tab:seatMain-leaf",
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    ...overrides,
  };
}
function dispatchShow(overrides = {}) {
  return {
    ok: true,
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    assigneePaneKey: "seatMain-tab:seatMain-leaf",
    ...overrides,
  };
}
function observed(overrides = {}) {
  return {
    adoptionObservable: true,
    tabId: "seatMain-tab",
    leafId: "seatMain-leaf",
    taskId: "taskMain",
    dispatchId: "dispatchMain",
    ...overrides,
  };
}

test("PROVEN: registry paneKey, dispatch-show assigneePaneKey, and reconstructed tabId:leafId all agree in the same generation", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.PROVEN);
  assert.equal(r.reason, REASON.CORRELATION_PROVEN);
});

test("UNPROVEN: adoption state not observable (no guessing)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow(),
    observed: observed({ adoptionObservable: false }),
  });
  assert.equal(r.verdict, CORRELATION.UNPROVEN);
  assert.equal(r.reason, REASON.ADOPTION_NOT_OBSERVABLE);
});

test("UNPROVEN: adoption claimed observable but tabId/leafId missing -- can't reconstruct, treated as unobservable", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow(),
    observed: {
      adoptionObservable: true,
      taskId: "taskMain",
      dispatchId: "dispatchMain",
    },
  });
  assert.equal(r.verdict, CORRELATION.UNPROVEN);
  assert.equal(r.reason, REASON.ADOPTION_NOT_OBSERVABLE);
});

test("UNPROVEN: seat registry record missing dispatchId (incomplete provenance)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ dispatchId: null }),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.UNPROVEN);
  assert.equal(r.reason, REASON.SEAT_RECORD_INCOMPLETE);
});

test("UNPROVEN: dispatch-show ok:false -- fail-closed, never PROVEN", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow({ ok: false }),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.UNPROVEN);
  assert.equal(r.reason, REASON.DISPATCH_SHOW_NOT_OK);
});

test("MISMATCH: target incarnation differs from registry record (stale grant attempt)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ taskId: "taskOld", dispatchId: "dispatchOld" }),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.MISMATCH);
  assert.equal(r.reason, REASON.INCARNATION_MISMATCH);
});

test("MISMATCH: reconstructed tabId:leafId disagrees with registry paneKey", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ paneKey: "seatOther-tab:seatOther-leaf" }),
    dispatchShow: dispatchShow(),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.MISMATCH);
  assert.equal(r.reason, REASON.REGISTRY_PANE_KEY_MISMATCH);
});

test("MISMATCH: reconstructed tabId:leafId disagrees with dispatch-show assigneePaneKey", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord(),
    dispatchShow: dispatchShow({
      assigneePaneKey: "seatOther-tab:seatOther-leaf",
    }),
    observed: observed(),
  });
  assert.equal(r.verdict, CORRELATION.MISMATCH);
  assert.equal(r.reason, REASON.DISPATCH_PANE_KEY_MISMATCH);
});

test("PROVEN: rotated handle carried on the observation is simply ignored (not part of the signature's evidence)", () => {
  const r = judgeDispatchCorrelation({
    seatRecord: seatRecord({ handle: "term_created_seat" }),
    dispatchShow: dispatchShow(),
    observed: { ...observed(), handle: "term_rotated_seat" },
  });
  assert.equal(r.verdict, CORRELATION.PROVEN);
});
