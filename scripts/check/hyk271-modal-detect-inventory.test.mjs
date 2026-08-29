// HYK-271-modal-stall-1/-2: integrity check for
// scripts/check/hyk271-modal-detect-inventory.json -- the machine-readable
// Q2 inventory of candidate axes for detecting "is this seat currently
// blocked on an interactive prompt" before dispatch.
//
// This is NOT the detector itself (Q4's design doc is the proposal for
// that). This file only checks the inventory stays well-formed: required
// fields present and non-empty, confidence drawn from the allowed set, ids
// unique, every required axis still present (2R P1-2), and -- per
// coder-task.md §5 Q3 -- any axis tagged "확실" must carry evidence that
// points at a real, currently-existing PLAIN FILE (not a directory or
// symlink, 2R P1-3), and if the evidence names a line/line-range that range
// must actually exist in that file.
//
// 2R review (HYK-271-modal-stall-2) rejected 1R for three reasons this
// version fixes directly:
//   P1-2: REQUIRED_AXIS_IDS below is the single source of truth for "the
//         six axes" -- both the list-coverage test and validateInventory
//         itself (so a deleted axis fails "zero errors" too, not just a
//         separately-maintained test) read it, and a per-axis loop proves
//         each one individually is load-bearing (deleting ANY of the six
//         alone -- not just the whole set -- goes RED).
//   P1-3: validateConfidentEvidence now lstat()s the resolved path and
//         rejects anything that is not a plain file (directories,
//         symlinks), then -- when the evidence string carries a
//         "<path>:<line>" or "<path>:<start>-<end>" suffix -- reads the
//         file and rejects an out-of-bounds line/range.
//   P1-1: the two 확실-tagged axes' evidence was replaced (not padded) in
//         the JSON itself with citations that actually back the specific
//         behavioral claim being made; this file doesn't re-litigate that,
//         it only re-verifies the replacement evidence is real.
//
// The "되돌림 변이 RED" requirement is proven here via in-memory mutated
// clones of the real data (same technique as
// scripts/check/hyk389-candidate0-inventory.test.mjs); a SEPARATE live-file
// mutation + restore was performed by hand for both 1R and 2R and is
// recorded in .harness/coder.md, not repeated here (this file must stay
// green against the real inventory on every future run).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
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

// Single source of truth (2R P1-2): the six minimum candidate axes
// coder-task.md §3 Q2 requires. Both the coverage test below AND
// validateInventory itself consult this exact array -- there is nowhere
// else in this file a "the six axes" list is spelled out again.
export const REQUIRED_AXIS_IDS = Object.freeze([
  "axis-screen-scrollback",
  "axis-session-jsonl-tail",
  "axis-process-pty-liveness",
  "axis-orca-query-preview",
  "axis-result-file-silence",
  "axis-heartbeat-absence",
]);

function validateField(item, field, label) {
  if (!(field in item)) {
    return [`${label}: missing required field "${field}"`];
  }
  const value = item[field];
  return typeof value === "string" && value.trim() !== ""
    ? []
    : [`${label}.${field}: must be a non-empty string`];
}

// "확실" 항목은 evidence가 실재하는 "파일"(디렉터리·심볼릭 링크 불가)을
// 가리켜야 하고(coder-task.md §5 Q3-3, 2R P1-3), 줄 번호가 있으면 그 줄이
// 실제 파일 범위 안에 있어야 한다. evidence 형식 관례 =
// "<path>[:<line-or-range>] -- <설명>". " -- " 앞부분에서 경로(+줄 범위)를
// 뽑는다. repo-relative 경로와 이 저장소 관례상의 절대 경로(예:
// C:\Users\...\.claude-team\..., D:\문서관리\...)를 모두 허용한다 -- 이
// 저장소는 이미 다른 곳에서도 이런 절대 경로를 근거로 쓴다(예: HYK-379
// 패치 문서의 D:\ 경로).
function extractPathAndLineFromEvidence(evidence) {
  const beforeDash = evidence.split(" -- ")[0].trim();
  const withLine = beforeDash.match(/^(.*?):(\d+)(?:-(\d+))?$/);
  if (withLine) {
    return {
      rawPath: withLine[1],
      lineStart: Number(withLine[2]),
      lineEnd: withLine[3] ? Number(withLine[3]) : Number(withLine[2]),
    };
  }
  return { rawPath: beforeDash, lineStart: null, lineEnd: null };
}

function resolveEvidencePath(rawPath) {
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) return rawPath;
  return fileURLToPath(new URL(`../../${rawPath}`, import.meta.url));
}

function validateEvidenceLineRange(resolved, lineStart, lineEnd, label) {
  if (lineStart === null) return [];
  let content;
  try {
    content = readFileSync(resolved, "utf8");
  } catch (err) {
    return [
      `${label}: confidence "확실" but evidence file could not be read for line-range check: ${resolved} (${err.message})`,
    ];
  }
  const totalLines = content.split(/\r\n|\n/).length;
  if (lineStart < 1 || lineEnd < lineStart || lineEnd > totalLines) {
    return [
      `${label}: confidence "확실" but evidence line range ${lineStart}-${lineEnd} is out of bounds for ${resolved} (file has ${totalLines} lines)`,
    ];
  }
  return [];
}

function validateConfidentEvidence(item, label) {
  if (item.confidence !== "확실") return [];
  if (typeof item.evidence !== "string" || item.evidence.trim() === "") {
    return [`${label}: confidence "확실" but evidence is empty`];
  }
  const { rawPath, lineStart, lineEnd } = extractPathAndLineFromEvidence(
    item.evidence,
  );
  if (!rawPath) {
    return [`${label}: confidence "확실" but evidence has no parseable path`];
  }
  const resolved = resolveEvidencePath(rawPath);

  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    return [
      `${label}: confidence "확실" but evidence path does not exist: ${resolved}`,
    ];
  }
  if (stat.isSymbolicLink()) {
    return [
      `${label}: confidence "확실" but evidence path is a symlink, not a plain file: ${resolved}`,
    ];
  }
  if (!stat.isFile()) {
    return [
      `${label}: confidence "확실" but evidence path is not a plain file (directory?): ${resolved}`,
    ];
  }

  return validateEvidenceLineRange(resolved, lineStart, lineEnd, label);
}

function validateRequiredAxes(seenIds) {
  const errors = [];
  for (const requiredId of REQUIRED_AXIS_IDS) {
    if (!seenIds.has(requiredId)) {
      errors.push(`missing required axis id: "${requiredId}"`);
    }
  }
  return errors;
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

// validateInventory itself enforces axis coverage (not just a separate
// test) -- this is the 2R P1-2 fix: deleting axis-heartbeat-absence (or any
// other required axis) now makes THIS function return a non-empty error
// list, which "real inventory validates with zero errors" already asserts
// against. The list-coverage test below is kept as an explicit, named
// regression guard on top of that, not as the only line of defense.
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
  errors.push(...validateRequiredAxes(seenIds));

  return errors;
}

function loadRealInventory() {
  return JSON.parse(readFileSync(INVENTORY_PATH, "utf8"));
}

function cloneItems(data) {
  return JSON.parse(JSON.stringify(data));
}

function removeItemById(data, id) {
  return { ...data, items: data.items.filter((item) => item.id !== id) };
}

test("real inventory file parses as JSON", () => {
  assert.doesNotThrow(() => loadRealInventory());
});

test("real inventory validates with zero errors", () => {
  const data = loadRealInventory();
  const errors = validateInventory(data);
  assert.deepEqual(errors, []);
});

test("real inventory covers all six required candidate axes (coder-task.md §3 Q2, REQUIRED_AXIS_IDS)", () => {
  const data = loadRealInventory();
  const ids = new Set(data.items.map((item) => item.id));
  for (const required of REQUIRED_AXIS_IDS) {
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
// performed by hand and is logged in .harness/coder.md.

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

test("MUTATION: confidence typo with a trailing space ('확실 ') is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].confidence = "확실 ";
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes(".confidence:")));
});

test("MUTATION: confidence typo with an inserted space ('확 실') is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].confidence = "확 실";
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

// 2R P1-3: this is the exact defect the reviewer demonstrated (evidence =
// "scripts/check:1", a real, existing DIRECTORY, previously slipped past
// existsSync-only validation with exit 0 / 13/13 pass).
test("MUTATION: 확실 axis with a directory as evidence path is caught (2R P1-3)", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].evidence =
    "scripts/check:1 -- directory, not a file";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("not a plain file (directory?)")),
    "expected a 확실 item whose evidence path is a directory to be rejected",
  );
});

test("MUTATION: 확실 axis with an out-of-bounds line range is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].evidence =
    "scripts/check/hyk271-modal-detect-inventory.json:999999 -- out of bounds";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("line range") && e.includes("out of bounds")),
    "expected a 확실 item whose evidence line range does not exist in the file to be rejected",
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
  // an empty array is also, trivially, missing every required axis --
  // both failure modes should be visible, not just the first one found.
  for (const required of REQUIRED_AXIS_IDS) {
    assert.ok(errors.includes(`missing required axis id: "${required}"`));
  }
});

test("MUTATION: items not an array is caught", () => {
  const errors = validateInventory({ items: "not-an-array" });
  assert.deepEqual(errors, ["data.items is not an array"]);
});

// 2R P1-2: prove EACH of the six required axes is individually
// load-bearing -- deleting any single one (not just the whole list) must
// go RED. This is what the 1R test failed to do: its hardcoded required
// list was itself missing axis-heartbeat-absence, so removing exactly that
// axis from the real data produced zero errors.
for (const requiredId of REQUIRED_AXIS_IDS) {
  test(`MUTATION (2R P1-2): deleting required axis "${requiredId}" alone is caught`, () => {
    const data = removeItemById(cloneItems(loadRealInventory()), requiredId);
    const errors = validateInventory(data);
    assert.ok(
      errors.includes(`missing required axis id: "${requiredId}"`),
      `expected deleting "${requiredId}" alone to be caught by validateInventory`,
    );
  });
}

test("sanity: REQUIRED_AXIS_IDS has no duplicates and matches the real inventory's id set exactly", () => {
  assert.equal(new Set(REQUIRED_AXIS_IDS).size, REQUIRED_AXIS_IDS.length);
  const data = loadRealInventory();
  const realIds = new Set(data.items.map((item) => item.id));
  assert.deepEqual(new Set(REQUIRED_AXIS_IDS), realIds);
});
