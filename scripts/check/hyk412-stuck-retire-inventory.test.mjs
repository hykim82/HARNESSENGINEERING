// HYK-412-stuck-retire-1: integrity check for
// scripts/check/hyk412-stuck-retire-inventory.json -- the machine-readable
// inventory of what evidence actually survives for a never-consumed round
// (coder-task.md §2-1).
//
// This is NOT a closure mechanism (1R is investigation+design only, zero
// production wiring -- see .harness/coder-task.md §0-A). This file only
// checks that the inventory ITSELF stays well-formed: required fields
// present and non-empty, enum fields drawn from the allowed set, ids unique
// -- so a future round that reads docs/HYK-412-stuck-retire-design.md's
// evidence table can trust the JSON has not silently rotted (missing field,
// duplicate id, renamed enum value). The "되돌림 변이 RED" requirement
// (coder-task.md §2-3) is satisfied by validating hand-built MUTATED COPIES
// in-memory below -- each one must produce validation errors, and because
// the real file on disk is never touched, restoration is byte-identical by
// construction.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH = fileURLToPath(
  new URL("./hyk412-stuck-retire-inventory.json", import.meta.url),
);

const REQUIRED_FIELDS = [
  "id",
  "path",
  "confidence",
  "machine_independently_reconfirmable",
  "sample_check",
  "caveat",
];

const ALLOWED_CONFIDENCE = new Set(["확실", "추론", "미확인"]);

function validateField(item, field, label) {
  if (!(field in item)) {
    return [`${label}: missing required field "${field}"`];
  }
  const value = item[field];
  if (field === "machine_independently_reconfirmable") {
    return typeof value === "boolean"
      ? []
      : [`${label}.${field}: must be boolean, got ${typeof value}`];
  }
  return typeof value === "string" && value.trim() !== ""
    ? []
    : [`${label}.${field}: must be a non-empty string`];
}

function validateEnum(item, field, label, allowed) {
  const value = item[field];
  if (typeof value !== "string" || allowed.has(value)) return [];
  return [
    `${label}.${field}: "${value}" is not one of ${[...allowed].join("/")}`,
  ];
}

function validateItem(item, index, seenIds) {
  const label = `items[${index}]`;
  if (item === null || typeof item !== "object") {
    return [`${label}: not an object`];
  }

  const errors = REQUIRED_FIELDS.flatMap((field) =>
    validateField(item, field, label),
  );

  if (typeof item.id === "string") {
    if (seenIds.has(item.id)) {
      errors.push(`duplicate id "${item.id}" at ${label}`);
    }
    seenIds.add(item.id);
  }

  errors.push(...validateEnum(item, "confidence", label, ALLOWED_CONFIDENCE));

  return errors;
}

export function validateInventory(data) {
  if (data === null || typeof data !== "object") {
    return ["root is not an object"];
  }
  if (!Array.isArray(data.items)) {
    return ["data.items is not an array"];
  }

  const errors = data.items.length === 0 ? ["data.items is empty"] : [];
  const seenIds = new Set();
  data.items.forEach((item, index) => {
    errors.push(...validateItem(item, index, seenIds));
  });

  return errors;
}

function loadRealInventory() {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

function cloneItems(data) {
  return JSON.parse(JSON.stringify(data));
}

test("real inventory file parses as JSON", () => {
  assert.doesNotThrow(() => loadRealInventory());
});

test("real inventory validates with zero errors", () => {
  const data = loadRealInventory();
  const errors = validateInventory(data);
  assert.deepEqual(errors, []);
});

test("real inventory has at least 7 items (evidence sweep floor, coder-task.md §2-1's minimum candidate list)", () => {
  const data = loadRealInventory();
  assert.ok(
    data.items.length >= 7,
    `expected >= 7 items, got ${data.items.length}`,
  );
});

test("real inventory ids are all unique (independent re-check via Set size)", () => {
  const data = loadRealInventory();
  const ids = data.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("real inventory includes at least one item flagged NOT machine-independently-reconfirmable (consumption-attempt-rejection-record)", () => {
  const data = loadRealInventory();
  const unreconfirmable = data.items.filter(
    (item) => item.machine_independently_reconfirmable === false,
  );
  assert.ok(
    unreconfirmable.length >= 1,
    "expected at least one item documenting evidence that cannot be independently re-confirmed by machine",
  );
});

test("real inventory documents the result-archive-copy gap central to this issue", () => {
  const data = loadRealInventory();
  const ids = data.items.map((item) => item.id);
  assert.ok(ids.includes("control-room-result-archive-copy"));
});

// --- Mutation tests: each takes an in-memory clone of the real data and
// breaks exactly one invariant, then asserts validateInventory catches it.
// The real file on disk is never opened for writing, so restoration is
// byte-identical by construction (nothing to restore).

test("MUTATION: duplicate id is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[1].id = data.items[0].id;
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.startsWith("duplicate id")));
});

test("MUTATION: missing required field is caught", () => {
  const data = cloneItems(loadRealInventory());
  delete data.items[0].sample_check;
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes('missing required field "sample_check"')),
  );
});

test("MUTATION: empty-string field is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].caveat = "   ";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes(".caveat: must be a non-empty string")),
  );
});

test("MUTATION: non-boolean machine_independently_reconfirmable is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].machine_independently_reconfirmable = "true";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) =>
      e.includes("machine_independently_reconfirmable: must be boolean"),
    ),
  );
});

test("MUTATION: unknown confidence enum value is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].confidence = "그럴듯함";
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes(".confidence:")));
});

test("MUTATION: empty items array is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items = [];
  const errors = validateInventory(data);
  assert.ok(errors.includes("data.items is empty"));
});

test("MUTATION: items not an array is caught", () => {
  const errors = validateInventory({ items: "not-an-array" });
  assert.deepEqual(errors, ["data.items is not an array"]);
});
