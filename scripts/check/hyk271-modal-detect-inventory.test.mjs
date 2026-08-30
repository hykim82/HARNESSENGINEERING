// HYK-271-modal-stall-1/-2: integrity check for
// scripts/check/hyk271-modal-detect-inventory.json -- the machine-readable
// Q2 inventory of candidate axes for detecting "is this seat currently
// blocked on an interactive prompt" before dispatch.
//
// This is NOT the detector itself (Q4's design doc is the proposal for
// that). This file checks the inventory stays well-formed: required fields
// present and non-empty, confidence drawn from the allowed set, ids unique,
// every required axis still present (2R P1-2) -- and, per coder-task.md §2
// invariant P1, that EVERY item's evidence pointer resolves to a real,
// currently-existing, GIT-TRACKED PLAIN FILE (not a directory or symlink,
// 2R P1-3; not an absolute machine path outside the repo, 3R P1-fix; not
// merely existing-on-disk-but-.gitignore'd, 4R P1-fix -- see below), with
// any cited line/line-range actually existing in that file. Separately, per
// invariant P2, any axis tagged "확실" must also carry an evidence_kind of
// 실측관측 (a recorded real observation) or 동작코드 (the evidence IS the
// implementation being described) -- 구조설명 (a field-list/comment
// enumeration that only describes structure, not behavior) is never enough
// to carry "확실", no matter how real the file is.
//
// 4R (HYK-271-tracked-4) rejected 3R for one reason this version fixes:
//   P1 (existence != tracked): validateEvidencePointer only ever checked
//         that the resolved path existed on disk (lstat). `.harness/` is
//         `.gitignore`d, so a mutated evidence pointer at the real, existing
//         file `.harness/rounds/review-task-r1.md:1` still passed every
//         check with `errors: []` -- that path would not exist in a fresh
//         clone or CI. Fixed by adding checkGitTracked(), which runs
//         `git ls-files --error-unmatch <path>` (coder-task.md §2's named
//         machine command: exit 0 = tracked, non-zero = not tracked) for
//         EVERY item once it is confirmed to be a real plain file, and
//         fails CLOSED (rejects, does not pass) if git itself cannot be
//         asked. See the two "(HYK-271-tracked-4, Q2)" mutation tests below,
//         which point a 확실 axis and a non-확실 axis at that exact ignored
//         file and assert both go RED -- 3R's P1 was found on a non-확실
//         item specifically, so covering only 확실 here would repeat that
//         gap in a different shape.
//
// 3R (HYK-271-evidence-3) rejected 2R for three reasons this version fixes
// directly:
//   P1 (pointer tracking): axis-screen-scrollback's evidence pointed at
//         `.harness/rounds/coder-task-r1.md:30` -- `.harness/` is
//         `.gitignore`d, so that path does not exist in a fresh clone or in
//         CI. The "existence" check below used to run ONLY for 확실-tagged
//         items, so a 추론-tagged axis with a dead pointer slipped through
//         "real inventory validates with zero errors" unnoticed -- exactly
//         how this got past 2R. validateEvidencePointer now runs for EVERY
//         item regardless of confidence, and rejects any evidence path that
//         is an absolute machine path (outside what a fresh clone/CI has),
//         not just a missing/directory/symlink one.
//   Q2 (generalization): axis-process-pty-liveness's "확실" tag was
//         demoted to "추론" -- its evidence (an update-confirmation-modal
//         incident) did not establish that the same holds for a
//         command-approval-modal, and the field-list code it cross-referenced
//         only describes structure, not behavior.
//   P2 (확실-needs-real-evidence, actually enforced): "whether evidence
//         backs a claim" can't be read by a machine, so the contract is
//         narrowed into something checkable: every item now also declares
//         an evidence_kind (실측관측/동작코드/구조설명), and validateItem
//         rejects "확실" + 구조설명 as a combination. This is the concrete
//         fix for 2R's finding that reverting a 확실 axis to its old
//         field-list-only evidence stayed GREEN -- see the "MUTATION (Q3)"
//         test below, which performs exactly that revert on an in-memory
//         clone and asserts it now goes RED. Known limit: this still cannot
//         judge whether a given 실측관측/동작코드 citation is *convincing*
//         evidence for the *specific* claim next to it -- that judgment
//         stays human (reviewer read), same as before. What changed is that
//         the one concrete failure mode actually observed (a demonstrably
//         non-behavioral citation, e.g. a bare field-list comment, silently
//         carrying "확실") is now mechanically closed.
//
// 2R (HYK-271-modal-stall-2) had already fixed, and this version keeps:
//   P1-2: REQUIRED_AXIS_IDS below is the single source of truth for "the
//         six axes" -- both the list-coverage test and validateInventory
//         itself (so a deleted axis fails "zero errors" too, not just a
//         separately-maintained test) read it, and a per-axis loop proves
//         each one individually is load-bearing (deleting ANY of the six
//         alone -- not just the whole set -- goes RED).
//   P1-3: the pointer check lstat()s the resolved path and rejects anything
//         that is not a plain file (directories, symlinks), then -- when
//         the evidence string carries a "<path>:<line>" or
//         "<path>:<start>-<end>" suffix -- reads the file and rejects an
//         out-of-bounds line/range.
//
// The "되돌림 변이 RED" requirement is proven here via in-memory mutated
// clones of the real data (same technique as
// scripts/check/hyk389-candidate0-inventory.test.mjs); a SEPARATE live-file
// mutation + restore was performed by hand for 1R/2R/3R and is recorded in
// .harness/coder.md, not repeated here (this file must stay green against
// the real inventory on every future run).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const INVENTORY_PATH = fileURLToPath(
  new URL("./hyk271-modal-detect-inventory.json", import.meta.url),
);

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const REQUIRED_FIELDS = [
  "id",
  "axis_label",
  "can_indicate_modal",
  "distinguishes_idle",
  "evidence",
  "confidence",
  "evidence_kind",
];

const ALLOWED_CONFIDENCE = new Set(["확실", "추론", "미확인"]);

// 3R (Q3): the evidence *kind*, not just its existence. 실측관측 = a
// recorded real observation/measurement; 동작코드 = the evidence IS the
// implementation whose behavior is being cited; 구조설명 = a field-list or
// comment enumeration that only describes structure/shape, never behavior.
// This is the machine-checkable proxy coder-task.md §3 Q3 asks for ("근거가
// 주장을 받치는가"는 기계가 읽을 수 없으니 판정 가능한 형태로 좁혀라) --
// it does not judge whether a citation is convincing for its specific
// claim, only whether its declared kind is strong enough to ever carry
// "확실".
const ALLOWED_EVIDENCE_KIND = new Set(["실측관측", "동작코드", "구조설명"]);
const CONFIDENT_ALLOWED_EVIDENCE_KIND = new Set(["실측관측", "동작코드"]);

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

// evidence 형식 관례 = "<path>[:<line-or-range>] -- <설명>". " -- " 앞부분에서
// 경로(+줄 범위)를 뽑는다.
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

// 3R P1 fix: absolute machine paths (C:\Users\...\.claude-team\...,
// D:\문서관리\...) used to be accepted on the theory that this repository
// already cites such paths elsewhere. coder-task.md §2 invariant P1
// overrides that precedent explicitly: an evidence pointer must be
// something the REPOSITORY tracks (source code / commit SHA / a doc inside
// the repo) -- a path on this machine is none of those, and does not exist
// in a fresh clone or CI. So an absolute drive-letter path is now always a
// validation error, regardless of confidence tier.
function isAbsoluteMachinePath(rawPath) {
  return /^[A-Za-z]:[\\/]/.test(rawPath);
}

function resolveRepoRelativePath(rawPath) {
  return fileURLToPath(new URL(`../../${rawPath}`, import.meta.url));
}

// HYK-271-tracked-4: "exists on disk" and "the repository tracks it" are
// different questions -- `.harness/` is `.gitignore`d, so a file under it
// can pass every lstat/isFile/line-range check above while still being
// invisible to a fresh clone or CI. coder-task.md §2 names the exact
// machine command for the tracking judgment: `git ls-files --error-unmatch
// <path>` (exit 0 = tracked, non-zero = not tracked). This must run
// unconditionally (same reasoning as 3R's fix to validateEvidencePointer:
// a 추론-tagged axis is not exempt just because it isn't "확실"), and it
// must fail CLOSED if git itself cannot be asked (missing binary, not a
// repo, etc.) -- an undecidable tracking judgment is never silently treated
// as "tracked".
function checkGitTracked(rawPath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rawPath], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return { tracked: true };
  } catch (err) {
    if (typeof err.status === "number") {
      // git ran and gave a definite answer: `--error-unmatch` exits
      // non-zero (git spec: 1) when the path is not tracked.
      return { tracked: false };
    }
    // git could not be run at all (ENOENT, spawn failure, etc.) -- this is
    // not a "not tracked" answer, it is NO answer. Fail closed: never let
    // an inability to ask the tracking question read as "passes".
    return { tracked: false, undecidable: true, reason: err.message };
  }
}

function validateEvidenceLineRange(resolved, lineStart, lineEnd, label) {
  if (lineStart === null) return [];
  let content;
  try {
    content = readFileSync(resolved, "utf8");
  } catch (err) {
    return [
      `${label}: evidence file could not be read for line-range check: ${resolved} (${err.message})`,
    ];
  }
  const totalLines = content.split(/\r\n|\n/).length;
  if (lineStart < 1 || lineEnd < lineStart || lineEnd > totalLines) {
    return [
      `${label}: evidence line range ${lineStart}-${lineEnd} is out of bounds for ${resolved} (file has ${totalLines} lines)`,
    ];
  }
  return [];
}

// 3R P1 fix: this used to run ONLY for confidence==="확실" items
// (validateConfidentEvidence). That gap is exactly how axis-screen-scrollback
// (confidence 추론) carried a dead `.harness/rounds/coder-task-r1.md:30`
// pointer through 2R's "real inventory validates with zero errors" test
// unnoticed -- a 추론 tag was never asked to prove its evidence was real.
// coder-task.md §2 invariant P1 ("모든 근거 포인터는 저장소가 추적하는
// 것을 가리킨다") applies to every item, not just 확실-tagged ones, so this
// now runs unconditionally.
function validateEvidencePointer(item, label) {
  if (typeof item.evidence !== "string" || item.evidence.trim() === "") {
    return []; // covered by the generic required-field check
  }
  const { rawPath, lineStart, lineEnd } = extractPathAndLineFromEvidence(
    item.evidence,
  );
  if (!rawPath) {
    return [`${label}: evidence has no parseable path`];
  }
  if (isAbsoluteMachinePath(rawPath)) {
    return [
      `${label}: evidence path "${rawPath}" is an absolute machine path, not something the repository tracks (coder-task.md P1 -- only source code / commit SHA / a repo doc qualify)`,
    ];
  }
  const resolved = resolveRepoRelativePath(rawPath);

  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    return [
      `${label}: evidence path does not exist in the repository: ${resolved}`,
    ];
  }
  if (stat.isSymbolicLink()) {
    return [
      `${label}: evidence path is a symlink, not a plain tracked file: ${resolved}`,
    ];
  }
  if (!stat.isFile()) {
    return [
      `${label}: evidence path is not a plain file (directory?): ${resolved}`,
    ];
  }

  // HYK-271-tracked-4: existing on disk (the checks above) is NOT the same
  // as being tracked by the repository -- `.harness/` is `.gitignore`d, so
  // a file under it can pass every check up to here while a fresh
  // clone/CI would never have it. This runs only once the file is
  // confirmed to be a real plain file, so the error message stays specific
  // (fabricated path -> "does not exist"; real-but-ignored path -> "not
  // tracked by git") instead of collapsing both into one message.
  const trackResult = checkGitTracked(rawPath);
  if (trackResult.undecidable) {
    return [
      `${label}: could not determine whether "${rawPath}" is git-tracked (git ls-files failed to run: ${trackResult.reason}) -- UNDECIDABLE tracking judgments are rejected, not passed`,
    ];
  }
  if (!trackResult.tracked) {
    return [
      `${label}: evidence path "${rawPath}" is not tracked by git (git ls-files --error-unmatch exited non-zero) -- an ignored file can exist on disk here yet not exist in a fresh clone or CI (coder-task.md §2 P1)`,
    ];
  }

  return validateEvidenceLineRange(resolved, lineStart, lineEnd, label);
}

// 3R (Q3, P2 실발동): "확실"은 evidence_kind가 실측관측 또는 동작코드일
// 때만 허용한다. 구조설명(필드 목록·주석 등 구조만 설명하는 근거)은 파일이
// 아무리 real이어도 "확실"을 못 받친다 -- 2R의 근본 결함(1R의 약한
// 근거를 되돌린 변이가 GREEN으로 통과)을 여기서 구조적으로 닫는다.
function validateEvidenceKindAllowsConfidence(item, label) {
  if (item.confidence !== "확실") return [];
  if (typeof item.evidence_kind !== "string") return [];
  if (!CONFIDENT_ALLOWED_EVIDENCE_KIND.has(item.evidence_kind)) {
    return [
      `${label}: confidence "확실" but evidence_kind "${item.evidence_kind}" is not strong enough to carry it (구조설명 등은 확실 근거로 인정하지 않는다 -- coder-task.md §3 Q3)`,
    ];
  }
  return [];
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

  if (
    typeof item.evidence_kind === "string" &&
    !ALLOWED_EVIDENCE_KIND.has(item.evidence_kind)
  ) {
    errors.push(
      `${label}.evidence_kind: "${item.evidence_kind}" is not one of ${[...ALLOWED_EVIDENCE_KIND].join("/")}`,
    );
  }

  errors.push(...validateEvidencePointer(item, label));
  errors.push(...validateEvidenceKindAllowsConfidence(item, label));

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

// 3R P1 fix: this is the exact gap that let axis-screen-scrollback's dead
// `.harness/rounds/coder-task-r1.md:30` pointer through 2R -- it was
// confidence 추론, and the old check only ran for 확실 items. Mutate a
// non-확실 (추론) item's evidence to an absolute machine path and prove it
// is caught anyway.
test("MUTATION (3R P1): non-확실 axis with an absolute machine-path evidence pointer is caught", () => {
  const data = cloneItems(loadRealInventory());
  const nonConfidentIndex = data.items.findIndex(
    (item) => item.confidence !== "확실",
  );
  assert.ok(
    nonConfidentIndex >= 0,
    "fixture must contain a non-확실 item to mutate",
  );
  data.items[nonConfidentIndex].evidence =
    "C:\\Users\\Administrator\\.claude-team\\projects\\fake\\session.jsonl:1 -- not repo-tracked";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("absolute machine path")),
    "expected an absolute machine-path evidence pointer on a non-확실 item to be rejected",
  );
});

// Same gap, opposite shape: a non-확실 item with a dead repo-relative path
// (not absolute) must also be caught, not just 확실 ones.
test("MUTATION (3R P1): non-확실 axis with a fabricated repo-relative evidence path is caught", () => {
  const data = cloneItems(loadRealInventory());
  const nonConfidentIndex = data.items.findIndex(
    (item) => item.confidence !== "확실",
  );
  assert.ok(
    nonConfidentIndex >= 0,
    "fixture must contain a non-확실 item to mutate",
  );
  data.items[nonConfidentIndex].evidence =
    "scripts/check/this-file-does-not-exist-hyk271.mjs:1 -- fabricated";
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("evidence path does not exist")),
    "expected a non-확실 item with a fabricated path to be rejected",
  );
});

// HYK-271-ci-fixture-5: the pair below used to point at a real
// `.harness/`-relative file (`.harness/` is `.gitignore`d, so it existed
// on disk in every local worktree but is a wholly local artifact). CI runs
// from a fresh clone that never has `.harness/` at all, so `lstatSync`
// there throws for a DIFFERENT reason (missing file, not "exists but
// untracked") and the assertions below failed for the wrong error message
// (see PR #232 CI: not ok 972/973/974). Fixed by self-generating the
// antagonistic sample: this file is written to disk right here, at test
// time, and is never `git add`ed -- so it is untracked BY CONSTRUCTION in
// any environment, local or CI, with no dependency on `.harness/` or any
// other local-only path.
//
// It is written under `scripts/check/.tmp-fixtures/`, a directory this
// round adds to `.gitignore` for exactly this purpose (NOT `.harness/` --
// coder-task.md §0 forbids touching the live `.harness/` this round's own
// task/result files live under). Being `.gitignore`d matters here for a
// second, independent reason discovered while proving this fix against the
// full CI-canonical sweep (scripts/check/hyk359-ambient-env-regression.test.mjs):
// several other test files snapshot `git status --porcelain` of the whole
// repo before/after their own run and assert it is unchanged. `git status
// --porcelain` (no `--ignored`) never lists ignored paths, so a file
// created and removed here mid-sweep is invisible to those unrelated
// snapshots -- an earlier version of this fix wrote directly into
// `scripts/check/` (untracked but NOT ignored) and transiently broke that
// invariant for whichever other file's snapshot raced against this one's
// create/remove window. It is removed again in the `after()` hook below.
const SELF_GENERATED_UNTRACKED_FIXTURE_REL_PATH =
  "scripts/check/.tmp-fixtures/hyk271-ci-fixture-5-self-generated.tmp";
const SELF_GENERATED_UNTRACKED_FIXTURE_ABS_PATH = resolveRepoRelativePath(
  SELF_GENERATED_UNTRACKED_FIXTURE_REL_PATH,
);
const SELF_GENERATED_UNTRACKED_FIXTURE_DIR_ABS_PATH = resolveRepoRelativePath(
  "scripts/check/.tmp-fixtures",
);
mkdirSync(SELF_GENERATED_UNTRACKED_FIXTURE_DIR_ABS_PATH, { recursive: true });
writeFileSync(
  SELF_GENERATED_UNTRACKED_FIXTURE_ABS_PATH,
  "self-generated antagonistic fixture for HYK-271-ci-fixture-5 -- exists on disk, never git-added, untracked by construction\n",
);
after(() => {
  try {
    unlinkSync(SELF_GENERATED_UNTRACKED_FIXTURE_ABS_PATH);
  } catch {
    // already removed -- nothing to clean up
  }
  try {
    rmdirSync(SELF_GENERATED_UNTRACKED_FIXTURE_DIR_ABS_PATH);
  } catch {
    // not empty (a concurrent run also using it) or already removed --
    // leaving an empty, gitignored directory behind is harmless either way
  }
});

// HYK-271-tracked-4 (Q2, antagonistic sample -- the exact P1 this round
// fixes): an existing but untracked file. It is real on disk (passes
// lstat/isFile/line-range) but the repository does not track it, so a
// fresh clone/CI would not have it. Both a 확실 axis AND a non-확실 axis
// pointed at it must be rejected -- 3R's P1 was found on a non-확실 item
// specifically, so covering only 확실 here would repeat that exact gap.
const IGNORED_EXISTING_FILE_EVIDENCE = `${SELF_GENERATED_UNTRACKED_FIXTURE_REL_PATH}:1 -- exists on disk, self-generated at test time, never tracked`;

test("MUTATION (HYK-271-tracked-4, Q2): 확실 axis pointed at an existing but git-ignored file is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  data.items[confidentIndex].evidence = IGNORED_EXISTING_FILE_EVIDENCE;
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("is not tracked by git")),
    "expected a 확실 item pointed at an existing-but-untracked file to be rejected",
  );
});

test("MUTATION (HYK-271-tracked-4, Q2): non-확실 axis pointed at an existing but git-ignored file is caught", () => {
  const data = cloneItems(loadRealInventory());
  const nonConfidentIndex = data.items.findIndex(
    (item) => item.confidence !== "확실",
  );
  assert.ok(
    nonConfidentIndex >= 0,
    "fixture must contain a non-확실 item to mutate",
  );
  data.items[nonConfidentIndex].evidence = IGNORED_EXISTING_FILE_EVIDENCE;
  const errors = validateInventory(data);
  assert.ok(
    errors.some((e) => e.includes("is not tracked by git")),
    "expected a non-확실 item pointed at an existing-but-untracked file to be rejected (this is exactly the axis-screen-scrollback shape 3R found)",
  );
});

// sanity: confirm the self-generated fixture file this pair relies on is
// real on disk but genuinely untracked -- if this assumption ever breaks
// (write failed silently, or something `git add`s it), the two tests above
// would start failing for the wrong reason (missing-file, not tracking)
// without this guard making that distinction explicit.
test("sanity: the HYK-271-ci-fixture-5 self-generated antagonistic fixture exists on disk but is untracked by git", () => {
  assert.doesNotThrow(
    () => lstatSync(SELF_GENERATED_UNTRACKED_FIXTURE_ABS_PATH),
    "fixture file must exist on disk for this sanity check to mean anything",
  );
  const result = checkGitTracked(SELF_GENERATED_UNTRACKED_FIXTURE_REL_PATH);
  assert.equal(
    result.tracked,
    false,
    "self-generated fixture file must be untracked -- if it is somehow tracked, this sanity check would mean nothing",
  );
});

test("MUTATION: unknown evidence_kind enum value is caught", () => {
  const data = cloneItems(loadRealInventory());
  data.items[0].evidence_kind = "그럴듯한근거";
  const errors = validateInventory(data);
  assert.ok(errors.some((e) => e.includes(".evidence_kind:")));
});

// 3R Q3 -- THE central "되돌림 변이 RED" proof coder-task.md §1⑶ demands:
// 1R's weak evidence for a 확실 axis was a bare field-list/comment citation
// (구조설명), and reverting to that kind of evidence used to stay GREEN
// because nothing checked evidence *kind*, only its existence. Take the
// current 확실 axis (a real, existing, in-bounds file -- passes every
// existence/line-range check) and revert ONLY its evidence_kind to 구조설명,
// leaving the file path untouched. This must now be RED.
test("MUTATION (Q3, weak-evidence-revert RED): 확실 axis with evidence_kind reverted to 구조설명 is caught", () => {
  const data = cloneItems(loadRealInventory());
  const confidentIndex = data.items.findIndex(
    (item) => item.confidence === "확실",
  );
  assert.ok(confidentIndex >= 0, "fixture must contain a 확실 item to mutate");
  // sanity: the evidence path itself is untouched and still perfectly
  // valid -- proves this failure is coming from the kind check, not a
  // path/existence check silently doing the work instead.
  assert.deepEqual(
    validateEvidencePointer(data.items[confidentIndex], "sanity"),
    [],
  );
  data.items[confidentIndex].evidence_kind = "구조설명";
  const errors = validateInventory(data);
  assert.ok(
    errors.some(
      (e) =>
        e.includes('confidence "확실"') &&
        e.includes('evidence_kind "구조설명"'),
    ),
    "expected reverting a 확실 axis's evidence_kind to 구조설명 to be rejected even though its evidence file is real",
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
