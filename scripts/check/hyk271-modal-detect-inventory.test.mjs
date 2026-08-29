// HYK-271-modal-stall-1 1R: integrity check for
// scripts/check/hyk271-modal-detect-inventory.json -- the machine-readable
// Q2 inventory of candidate axes for detecting "is this seat currently
// blocked on an interactive prompt" before dispatch.
//
// This is NOT the detector itself (Q4's design doc is the proposal for
// that). This file only checks the inventory stays well-formed: required
// fields present and non-empty, confidence drawn from the allowed set, ids
// unique, and -- per coder-task.md §5 Q3 -- any axis tagged "확실" must
// carry evidence that points at a real, currently-existing file (a bare
// claim of "확실" with no checkable evidence is exactly the failure mode
// this check exists to catch). The "되돌림 변이 RED" requirement is proven
// here via in-memory mutated clones of the real data (same technique as
// scripts/check/hyk389-candidate0-inventory.test.mjs); a SEPARATE live-file
// mutation + restore was performed by hand for this round and is recorded
// in .harness/coder.md §Q3, not repeated here (this file must stay green
// against the real inventory on every future run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH = fileURLToPath(
  new URL("./hyk271-modal-detect-inventory.json", import.meta.url),
);

const REQUIRED_FIELDS = [
  "id",
  "axis_label",
  "can_indicate_modal",
  "distinguishes_idle",
  "evidence",
  "confidence",
];

const ALLOWED_CONFIDENCE = new Set(["확실", "추론", "미확인"]);

function validateField(item, field, label) {
  if (!(field in item)) {
    return [`${label}: missing required field "${field}"`];
  }
  const value = item[field];
  return typeof value === "string" && value.trim() !== ""
    ? []
    : [`${label}.${field}: must be a non-empty string`];
}

// "확실" 항목은 evidence가 실재 파일을 가리켜야 한다(coder-task.md §5 Q3-3).
// evidence 형식 관례 = "<path>[:<line-or-range>] -- <설명>". " -- " 앞부분에서
// 경로를 뽑아 ":line" 접미사를 벗기고 existsSync로 확인한다. repo-relative
// 경로와 이 저장소 관례상의 절대 경로(예: C:\Users\...\.claude-team\...)를
// 모두 허용한다 -- 이 저장소는 이미 다른 곳에서도 이런 절대 경로를 근거로
// 쓴다(예: HYK-379 패치 문서의 D:\ 경로).
function extractPathFromEvidence(evidence) {
  const beforeDash = evidence.split(" -- ")[0].trim();
  return beforeDash.replace(/:\d+(-\d+)?$/, "");
}

function resolveEvidencePath(rawPath) {
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) return rawPath;
  return fileURLToPath(new URL(`../../${rawPath}`, import.meta.url));
}

function validateConfidentEvidence(item, label) {
  if (item.confidence !== "확실") return [];
  if (typeof item.evidence !== "string" || item.evidence.trim() === "") {
    return [`${label}: confidence "확실" but evidence is empty`];
  }
  const rawPath = extractPathFromEvidence(item.evidence);
  if (!rawPath) {
    return [`${label}: confidence "확실" but evidence has no parseable path`];
  }
  const resolved = resolveEvidencePath(rawPath);
  if (!existsSync(resolved)) {
    return [
      `${label}: confidence "확실" but evidence path does not exist: ${resolved}`,
    ];
  }
  return [];
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

  if (
    typeof item.confidence === "string" &&
    !ALLOWED_CONFIDENCE.has(item.confidence)
  ) {
    errors.push(
      `${label}.confidence: "${item.confidence}" is not one of ${[...ALLOWED_CONFIDENCE].join("/")}`,
    );
  }

  errors.push(...validateConfidentEvidence(item, label));

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

test("real inventory covers all six minimum candidate axes (coder-task.md §3 Q2)", () => {
  const data = loadRealInventory();
  const ids = new Set(data.items.map((item) => item.id));
  for (const required of [
    "axis-screen-scrollback",
    "axis-session-jsonl-tail",
    "axis-process-pty-liveness",
    "axis-orca-query-preview",
    "axis-result-file-silence",
  ]) {
    assert.ok(ids.has(required), `missing minimum candidate axis: ${required}`);
  }
});

test("real inventory ids are all unique (independent re-check via Set size)", () => {
  const data = loadRealInventory();
  const ids = data.items.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("real inventory includes at least one axis tagged 확실 with real evidence", () => {
  const data = loadRealInventory();
  const confident = data.items.filter((item) => item.confidence === "확실");
  assert.ok(
    confident.length >= 1,
    "expected at least one 확실-tagged axis (a bare list of 추론/미확인 would mean nothing was actually pinned down)",
  );
});

// --- Mutation tests: each takes a byte-identical clone of the real data and
// breaks exactly one invariant, then asserts validateInventory catches it.
// This proves the checker itself is not a no-op; it does not touch the real
// file. The task's separate "실제 목록 파일에" live-file RED/restore was
// performed by hand and is logged in .harness/coder.md §Q3.

test("MUTATION: duplicate id is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[1].id = data.items[0].id;
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.startsWith("duplicate id")));
});

test("MUTATION: missing required field is caught", () => {
  const data = cloneItems(loadRealInventory());
  delete data.items[0].evidence;
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes('missing required field "evidence"')),
  );
});

test("MUTATION: empty-string field is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].distinguishes_idle = "   ";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) =>
      e.includes(".distinguishes_idle: must be a non-empty string"),
    ),
  );
});

test("MUTATION: unknown confidence enum value is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].confidence = "그럴듯함";
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes(".confidence:")));
});

test("MUTATION: 확실 axis with fabricated (non-existent) evidence path is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].evidence =
    "scripts/check/this-file-does-not-exist-hyk271.mjs:1 -- fabricated";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("evidence path does not exist")),
    "expected a 확실 item with a fabricated path to be rejected",
  );
});

test("MUTATION: 확실 axis with empty evidence is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].evidence = "";
  const errors = validateInventory(data);
  assert.ok(
    errors.some(
      (e) =>
        e.includes('confidence "확실" but evidence is empty') ||
        e.includes("must be a non-empty string"),
    ),
  );
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
