// HYK-389-candidate0-1: integrity check for
// scripts/check/hyk389-candidate0-inventory.json -- the machine-readable
// Q1 inventory of legitimate direct-`orca`/seat-direct inputs.
//
// This is NOT a detection axis (1R/2R already established that "read text
// inside the repo and judge" is the wrong family for the HYK-389 threat --
// see .harness/coder-task.md §1). This file only checks that the inventory
// ITSELF stays well-formed: required fields present and non-empty, enum
// fields drawn from the allowed set, ids unique, and every `legitimate:true`
// item over a stable minimum count -- so a future round that reads
// docs/HYK-389-candidate0-capability-removal.md's Q1 table can trust the
// JSON has not silently rotted (missing field, duplicate id, renamed enum
// value). The "되돌림 변이 RED" requirement (coder-task.md §5-5) is
// satisfied by validating hand-built MUTATED COPIES in-memory below --
// each one must produce validation errors, proving the validator itself
// would catch that class of breakage if it were ever introduced into the
// real file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH = fileURLToPath(
  new URL("./hyk389-candidate0-inventory.json", import.meta.url),
);

const REQUIRED_FIELDS = [
  "id",
  "actor",
  "channel",
  "adapter_mediated",
  "command",
  "purpose",
  "legitimate",
  "alternative",
  "source",
  "confidence",
];

const ALLOWED_CONFIDENCE = new Set(["확실", "추론", "미확인"]);

// Loose on purpose -- this list is about WHO acts, not a closed taxonomy of
// every conceivable actor. Widen it if a future round finds a genuinely new
// actor kind; do not widen it just to make a specific item pass.
const ALLOWED_ACTORS = new Set(["worker", "human-or-orch", "human"]);

function validateField(item, field, label) {
  if (!(field in item)) {
    return [`${label}: missing required field "${field}"`];
  }
  const value = item[field];
  if (field === "adapter_mediated" || field === "legitimate") {
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

  errors.push(
    ...validateEnum(item, "confidence", label, ALLOWED_CONFIDENCE),
    ...validateEnum(item, "actor", label, ALLOWED_ACTORS),
  );

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

test("real inventory has at least 12 items (HYK-389 §5-1 coverage floor)", () => {
  const data = loadRealInventory();
  assert.ok(
    data.items.length >= 12,
    `expected >= 12 items, got ${data.items.length} -- Q1 requires a genuine sweep, not a token list`,
  );
});

test("real inventory ids are all unique (independent re-check via Set size)", () => {
  const data = loadRealInventory();
  const ids = data.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("real inventory includes at least one explicitly non-legitimate item (forbidden-orca-ask)", () => {
  const data = loadRealInventory();
  const forbidden = data.items.filter((item) => item.legitimate === false);
  assert.ok(
    forbidden.length >= 1,
    "expected at least one legitimate:false item documenting a forbidden command (orca orchestration ask)",
  );
});

// --- Mutation tests: each of these takes a byte-identical clone of the real
// data and breaks exactly one invariant, then asserts validateInventory
// catches it. This is the "되돌림 변이 RED" proof -- it does not touch the
// real file, it proves the checker itself is not a no-op.

test("MUTATION: duplicate id is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[1].id = data.items[0].id;
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.startsWith("duplicate id")));
});

test("MUTATION: missing required field is caught", () => {
  const data = cloneItems(loadRealInventory());
  delete data.items[0].source;
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes('missing required field "source"')));
});

test("MUTATION: empty-string field is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].purpose = "   ";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes(".purpose: must be a non-empty string")),
  );
});

test("MUTATION: non-boolean adapter_mediated is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].adapter_mediated = "false";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("adapter_mediated: must be boolean")),
  );
});

test("MUTATION: unknown confidence enum value is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].confidence = "그럴듯함";
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes(".confidence:")));
});

test("MUTATION: unknown actor enum value is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].actor = "ghost";
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes(".actor:")));
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
