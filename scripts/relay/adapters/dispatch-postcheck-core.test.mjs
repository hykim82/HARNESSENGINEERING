import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  judgeDispatchPostcheck,
  DISPATCH_POSTCHECK_VERDICT,
  DISPATCH_POSTCHECK_STATUS,
  DISPATCH_POSTCHECK_REASON,
} from "./dispatch-postcheck-core.mjs";

test("dispatch-postcheck-core.mjs has zero import statements (pure core contract)", () => {
  const text = readFileSync(
    new URL("./dispatch-postcheck-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

test("injected !== true -> NOT_APPLICABLE regardless of normalized", () => {
  for (const injected of [false, null, undefined, "true", 1]) {
    const r = judgeDispatchPostcheck({
      injected,
      normalized: { ok: true },
    });
    assert.equal(r.status, DISPATCH_POSTCHECK_STATUS.OK);
    assert.equal(r.verdict, null);
    assert.equal(r.reasonCode, DISPATCH_POSTCHECK_REASON.NOT_APPLICABLE);
  }
});

test("injected:true + normalized.ok:true -> CONFIRMED (normal delivery, no alarm)", () => {
  const r = judgeDispatchPostcheck({
    injected: true,
    normalized: { ok: true, dispatchId: "ctx_1", taskId: "task_1" },
  });
  assert.deepEqual(r, {
    status: DISPATCH_POSTCHECK_STATUS.OK,
    verdict: DISPATCH_POSTCHECK_VERDICT.CONFIRMED,
    reasonCode: DISPATCH_POSTCHECK_REASON.VALID,
  });
});

test("injected:true + normalized reasonCode NO_DISPATCH -> RECORD_MISSING (the alarm)", () => {
  const r = judgeDispatchPostcheck({
    injected: true,
    normalized: { ok: false, reasonCode: "NO_DISPATCH" },
  });
  assert.deepEqual(r, {
    status: DISPATCH_POSTCHECK_STATUS.OK,
    verdict: DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING,
    reasonCode: DISPATCH_POSTCHECK_REASON.NO_DISPATCH,
  });
});

test("injected:true + normalized reasonCode NOT_OK -> QUERY_FAILED, not RECORD_MISSING (§3-3)", () => {
  const r = judgeDispatchPostcheck({
    injected: true,
    normalized: { ok: false, reasonCode: "NOT_OK" },
  });
  assert.equal(r.status, DISPATCH_POSTCHECK_STATUS.QUERY_FAILED);
  assert.equal(r.verdict, null);
  assert.notEqual(r.verdict, DISPATCH_POSTCHECK_VERDICT.RECORD_MISSING);
});

test("injected:true + normalized reasonCode FIELDS_INCOMPLETE -> QUERY_FAILED, not RECORD_MISSING", () => {
  const r = judgeDispatchPostcheck({
    injected: true,
    normalized: { ok: false, reasonCode: "FIELDS_INCOMPLETE" },
  });
  assert.equal(r.status, DISPATCH_POSTCHECK_STATUS.QUERY_FAILED);
  assert.equal(r.verdict, null);
});

test("injected:true + synthetic QUERY_THREW (execFn threw) -> QUERY_FAILED, not RECORD_MISSING", () => {
  const r = judgeDispatchPostcheck({
    injected: true,
    normalized: { ok: false, reasonCode: "QUERY_THREW" },
  });
  assert.deepEqual(r, {
    status: DISPATCH_POSTCHECK_STATUS.QUERY_FAILED,
    verdict: null,
    reasonCode: DISPATCH_POSTCHECK_REASON.QUERY_THREW,
  });
});

test("injected:true + malformed normalized (null/non-object) -> QUERY_FAILED, not silently OK", () => {
  for (const normalized of [null, undefined, "oops", 42]) {
    const r = judgeDispatchPostcheck({ injected: true, normalized });
    assert.equal(r.status, DISPATCH_POSTCHECK_STATUS.QUERY_FAILED);
    assert.equal(r.verdict, null);
    assert.equal(r.reasonCode, DISPATCH_POSTCHECK_REASON.MALFORMED_INPUT);
  }
});

test("QUERY_FAILED is never folded into either CONFIRMED or RECORD_MISSING (closed 3-outcome contract)", () => {
  const outcomes = new Set();
  const cases = [
    { injected: false, normalized: { ok: true } },
    { injected: true, normalized: { ok: true } },
    { injected: true, normalized: { ok: false, reasonCode: "NO_DISPATCH" } },
    { injected: true, normalized: { ok: false, reasonCode: "NOT_OK" } },
    {
      injected: true,
      normalized: { ok: false, reasonCode: "FIELDS_INCOMPLETE" },
    },
    { injected: true, normalized: { ok: false, reasonCode: "QUERY_THREW" } },
    { injected: true, normalized: null },
  ];
  for (const c of cases) {
    const r = judgeDispatchPostcheck(c);
    outcomes.add(`${r.status}:${r.verdict}`);
  }
  assert.deepEqual(
    [...outcomes].sort(),
    [
      "OK:CONFIRMED",
      "OK:RECORD_MISSING",
      "OK:null",
      "QUERY_FAILED:null",
    ].sort(),
  );
});
