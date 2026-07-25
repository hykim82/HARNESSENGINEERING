import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCHEMA_VERSION,
  createEmptyRegistry,
  normalizeSeatRecord,
  recordSeatCreation,
  findByPtyId,
  parseRegistryText,
  loadRegistry,
  saveRegistry,
} from "./seat-registry.mjs";

const FULL_RESPONSE = {
  ptyId: "pty-1",
  handle: "term_abc",
  tabId: "tab-1",
  leafId: "leaf-1",
  paneKey: "seatResp",
  worktreeId: "wt-1",
  worktreePath: "C:/wt/1",
  role: "CODER",
  taskId: "task_1",
  dispatchId: "ctx_1",
  capturedAt: "2026-07-26T03:00:00Z",
};

test("createEmptyRegistry: schemaVersion + empty seats array", () => {
  assert.deepEqual(createEmptyRegistry(), {
    schemaVersion: SCHEMA_VERSION,
    seats: [],
  });
});

test("normalizeSeatRecord: full authoritative response -- all fields preserved", () => {
  const record = normalizeSeatRecord(FULL_RESPONSE);
  for (const [k, v] of Object.entries(FULL_RESPONSE)) {
    assert.equal(record[k], v);
  }
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
});

test("normalizeSeatRecord: missing fields recorded as null (not fabricated) -- paneKey itself must be a non-empty string to count as the provenance marker", () => {
  const record = normalizeSeatRecord({ ptyId: "pty-2", paneKey: "seatMarker" });
  assert.equal(record.ptyId, "pty-2");
  assert.equal(record.worktreeId, null);
  assert.equal(record.capturedAt, null);
  assert.equal(record.paneKey, "seatMarker");
});

test("normalizeSeatRecord: non-object input (array/null/undefined) -- every field null", () => {
  for (const bad of [null, undefined, [FULL_RESPONSE], "term_abc", 5]) {
    const record = normalizeSeatRecord(bad);
    assert.equal(record.ptyId, null);
    assert.equal(record.worktreeId, null);
  }
});

test("normalizeSeatRecord: REVIEW review-1 P1-2 -- a plain object with real ptyId/worktreeId/capturedAt but NO paneKey key at all (terminal-list row shape) is rejected wholesale, not just missing paneKey", () => {
  const terminalListRow = {
    ptyId: "pty-scavenged",
    worktreeId: "wt-cycle4b2b1",
    capturedAt: "later",
  };
  const record = normalizeSeatRecord(terminalListRow);
  assert.equal(record.ptyId, null);
  assert.equal(record.worktreeId, null);
  assert.equal(record.capturedAt, null);
});

// REVIEW review-2 P1 (반전, 2026-07-26): 이 시험은 원래 "paneKey 키 존재 +
// null 값도 마커로 인정됐다"를 고정하고 있었다 -- 그게 정확히 review-2가
// 반례로 든 우회로였다(어댑터가 `paneKey: t.paneKey`로 필드를 뽑으면
// t.paneKey가 undefined/null인 채로 키만 남는 현실적 오사용 경로). 이제는
// 반대로 고정한다: paneKey가 non-empty string이 아니면(키만 있고 값이
// null/undefined든, 키 자체가 없든) 마커 실패 -- 전 필드 null.
test("normalizeSeatRecord: REVIEW review-2 P1 -- paneKey key present but with null value does NOT count as the creation-provenance marker anymore -- rejected wholesale", () => {
  const record = normalizeSeatRecord({
    ptyId: "pty-3",
    worktreeId: "wt-3",
    paneKey: null,
  });
  assert.equal(record.ptyId, null);
  assert.equal(record.worktreeId, null);
  assert.equal(record.paneKey, null);
});

test("normalizeSeatRecord: REVIEW review-2 P1 -- paneKey key present but with undefined value (the exact adapter-mapping shape: {ptyId: t.ptyId, worktreeId: t.worktreeId, paneKey: t.paneKey} where t.paneKey is undefined) does NOT count as the marker -- rejected wholesale, never registered as an owned identity", () => {
  const terminalListRow = {
    ptyId: "pty-scavenged-mapped",
    worktreeId: "wt-cycle4b2b1",
    capturedAt: "later",
  };
  const forged = { ...terminalListRow, paneKey: terminalListRow.paneKey };
  assert.equal(Object.prototype.hasOwnProperty.call(forged, "paneKey"), true);
  const record = normalizeSeatRecord(forged);
  assert.equal(record.ptyId, null);
  assert.equal(record.worktreeId, null);
  assert.equal(record.capturedAt, null);
});

test("recordSeatCreation: appends without mutating input registry", () => {
  const empty = createEmptyRegistry();
  const { registry: next, record } = recordSeatCreation(empty, FULL_RESPONSE);
  assert.deepEqual(empty.seats, []);
  assert.equal(next.seats.length, 1);
  assert.equal(next.seats[0].ptyId, "pty-1");
  assert.equal(record.ptyId, "pty-1");
});

test("recordSeatCreation: does not dedupe -- duplicate ptyId appends a second record (conflict detection is the identity core's job)", () => {
  let registry = createEmptyRegistry();
  registry = recordSeatCreation(registry, FULL_RESPONSE).registry;
  registry = recordSeatCreation(registry, FULL_RESPONSE).registry;
  assert.equal(registry.seats.length, 2);
});

test("findByPtyId: returns all matching records, empty for unknown ptyId", () => {
  let registry = createEmptyRegistry();
  registry = recordSeatCreation(registry, FULL_RESPONSE).registry;
  assert.equal(findByPtyId(registry, "pty-1").length, 1);
  assert.equal(findByPtyId(registry, "nope").length, 0);
  assert.equal(findByPtyId(registry, "").length, 0);
  assert.equal(findByPtyId(registry, undefined).length, 0);
});

test("parseRegistryText: corrupt JSON -> ok:false corrupt-json", () => {
  assert.deepEqual(parseRegistryText("{not json"), {
    ok: false,
    reason: "corrupt-json",
  });
});

test("parseRegistryText: schema mismatch (wrong version / missing seats array) -> ok:false", () => {
  assert.equal(
    parseRegistryText(JSON.stringify({ schemaVersion: 999, seats: [] })).ok,
    false,
  );
  assert.equal(
    parseRegistryText(JSON.stringify({ schemaVersion: SCHEMA_VERSION })).ok,
    false,
  );
});

test("loadRegistry: missing existsFn/readFn -> ok:false", () => {
  assert.equal(loadRegistry("x.json", {}).ok, false);
});

test("loadRegistry: file absent -> empty registry (first run, not corruption)", () => {
  const r = loadRegistry("x.json", { existsFn: () => false, readFn: () => "" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.registry, createEmptyRegistry());
  assert.equal(r.rawText, null);
});

test("loadRegistry: read throws -> ok:false with reason", () => {
  const r = loadRegistry("x.json", {
    existsFn: () => true,
    readFn: () => {
      throw new Error("boom");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /boom/);
});

test("loadRegistry: file present and valid -> parsed registry + rawText", () => {
  const text = JSON.stringify(createEmptyRegistry());
  const r = loadRegistry("x.json", {
    existsFn: () => true,
    readFn: () => text,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.registry, createEmptyRegistry());
  assert.equal(r.rawText, text);
});

test("saveRegistry: missing writeFn/renameFn -> ok:false", () => {
  assert.equal(saveRegistry("x.json", createEmptyRegistry(), {}).ok, false);
});

test("saveRegistry: writes via tmp path then renames into place", () => {
  const calls = [];
  const r = saveRegistry("x.json", createEmptyRegistry(), {
    writeFn: (p, t) => calls.push(["write", p, t]),
    renameFn: (from, to) => calls.push(["rename", from, to]),
  });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], "write");
  assert.equal(calls[0][1], "x.json.tmp");
  assert.equal(calls[1][0], "rename");
  assert.deepEqual(calls[1], ["rename", "x.json.tmp", "x.json"]);
});

test("saveRegistry: write throws -> ok:false with reason", () => {
  const r = saveRegistry("x.json", createEmptyRegistry(), {
    writeFn: () => {
      throw new Error("disk-full");
    },
    renameFn: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /disk-full/);
});
