// HYK-501-registry-consume-1 (piece E · step E1, coder-task.md §2 ⓒ) --
// collect layer for the two control-room patch documents that make the seat
// launcher (orca-worker-seat.ps1) and the memory gate (memory-gate.ps1) read
// engine / model / effort from the worktree engine-profiles registry instead
// of literal defaults:
//   docs/control-room-patches/HYK-501-registry-consume.md              (launcher)
//   docs/control-room-patches/HYK-501-registry-consume-memory-gate.md  (memory-gate)
//
// Per file: (1) the "before" fixture is a byte copy of the live control-room
// file (SHA-256 pinned below = the value ORCH measured 2026-11-13 08:2x), (2)
// applying the document's units to it with the REAL control-room-patch-apply
// export reproduces the committed "applied" fixture BYTE-FOR-BYTE, (3) the
// reverse round trip (swap anchor and content) gives the live bytes back.
//
// ⚠️정직 한계 (HYK-378/462/472 선례와 동일): this test reads only fixtures that
// are committed in this repository. It never opens the control-room live
// files, so it cannot notice a later live drift -- that is the E2 step's job
// (live SHA-256 == before SHA-256 before applying; live SHA-256 == applied
// SHA-256 after). A green here means "the document reproduces the applied
// fixture from the before fixture", nothing about the live machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parsePatchDocument,
  applyControlRoomPatch,
  applyPatchUnits,
} from "./control-room-patch-apply.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const sha256Of = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

const TARGETS = [
  {
    name: "orca-worker-seat.ps1 (launcher)",
    docPath: here(
      "../../docs/control-room-patches/HYK-501-registry-consume.md",
    ),
    beforePath: here(
      "./fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-before.ps1.txt",
    ),
    appliedPath: here(
      "./fixtures/control-room-orca-worker-seat-2026-11-13-hyk501-registry-consume-applied.ps1.txt",
    ),
    beforeSha256:
      "2f59d12522da51fc49a5a953f7c9e41761ca287d6956435a2e9ae20dd49be4f7",
    appliedSha256:
      "6e69909429962d0953502db41c3ec584c61a1bb34667cd1492e091439810ebe9",
    units: [
      ["hyk501-seat-param-dryrun", "replace"],
      ["hyk501-seat-resolve-registry", "insert_after"],
      ["hyk501-seat-drop-engine-default", "replace"],
      ["hyk501-seat-drop-codex-model-default", "replace"],
      ["hyk501-seat-drop-claude-defaults", "replace"],
    ],
  },
  {
    name: "memory-gate.ps1",
    docPath: here(
      "../../docs/control-room-patches/HYK-501-registry-consume-memory-gate.md",
    ),
    beforePath: here(
      "./fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-before.ps1.txt",
    ),
    appliedPath: here(
      "./fixtures/control-room-memory-gate-2026-11-13-hyk501-registry-consume-applied.ps1.txt",
    ),
    beforeSha256:
      "17219bdc58150c9e3771079c9d601d3c2a9a25764b7872f67fa2f20ecf1ade51",
    appliedSha256:
      "c9db5cd91f7232d5c77f548b8df18700d10dfc3b199ebd85b124bcb3d98b99b9",
    units: [
      ["hyk501-gate-param-engine", "replace"],
      ["hyk501-gate-param-effort", "replace"],
      ["hyk501-gate-log-header", "replace"],
      ["hyk501-gate-dryrun-precheck", "replace"],
      ["hyk501-gate-launch-args", "replace"],
    ],
  },
];

for (const t of TARGETS) {
  const doc = () => readFileSync(t.docPath, "utf8");
  const before = () => readFileSync(t.beforePath, "utf8");
  const applied = () => readFileSync(t.appliedPath, "utf8");

  test(`[${t.name}] before fixture = the live bytes this patch was cut against (SHA-256 pinned, self-check)`, () => {
    assert.equal(sha256Of(t.beforePath), t.beforeSha256);
  });

  test(`[${t.name}] applied fixture is still the byte-identical value this test was written against (SHA-256 pinned, self-check)`, () => {
    assert.equal(sha256Of(t.appliedPath), t.appliedSha256);
  });

  test(`[${t.name}] the document declares exactly ${t.units.length} control-room-patch-unit blocks with the expected ids and modes`, () => {
    const parsed = parsePatchDocument(doc());
    assert.equal(parsed.ok, true, parsed.reason);
    assert.deepEqual(
      parsed.units.map((u) => [u.id, u.mode]),
      t.units,
    );
  });

  test(`★[${t.name}] applying the document to the before fixture reproduces the applied fixture BYTE-FOR-BYTE`, () => {
    const outcome = applyControlRoomPatch(doc(), before());
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(
      outcome.result,
      applied(),
      "tool output diverges from the committed applied fixture -- the document's anchors/content no longer reproduce it",
    );
  });

  test(`[${t.name}] unit order does not matter (reversed declaration order gives the same bytes)`, () => {
    const parsed = parsePatchDocument(doc());
    assert.equal(parsed.ok, true, parsed.reason);
    const outcome = applyPatchUnits([...parsed.units].reverse(), before());
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(outcome.result, applied());
  });

  test(`★[${t.name}] REVERSE round trip: swapping every unit's anchor/content and applying to the applied fixture gives the live (before) bytes back`, () => {
    const parsed = parsePatchDocument(doc());
    assert.equal(parsed.ok, true, parsed.reason);
    // replace units swap cleanly; an insert_after unit becomes a replace of
    // (anchor + content) by anchor.
    const reversed = parsed.units.map((u) =>
      u.mode === "replace"
        ? { id: u.id, mode: "replace", anchor: u.content, content: u.anchor }
        : {
            id: u.id,
            mode: "replace",
            anchor: u.anchor + u.content,
            content: u.anchor,
          },
    );
    const outcome = applyPatchUnits(reversed, applied());
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(outcome.result, before());
  });

  test(`[${t.name}] line-ending guard: the live file is LF-only, so before and applied carry no CR byte (a CRLF slip would break the SHA pin on checkout)`, () => {
    assert.equal(before().includes("\r"), false);
    assert.equal(applied().includes("\r"), false);
    assert.equal(before().endsWith("\n"), true);
    assert.equal(applied().endsWith("\n"), true);
  });

  test(`★되돌림 변이 (앵커 훼손) [${t.name}]: mangling one character of the first unit's anchor flips the document RED (ANCHOR_NOT_FOUND) -- proves the byte-for-byte test above is not vacuous`, () => {
    const parsed = parsePatchDocument(doc());
    assert.equal(parsed.ok, true, parsed.reason);
    const first = parsed.units[0];
    const mutatedUnits = parsed.units.map((u) =>
      u.id === first.id ? { ...u, anchor: u.anchor.replace(/.$/, "#") } : u,
    );
    const outcome = applyPatchUnits(mutatedUnits, before());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reasonCode, "ANCHOR_NOT_FOUND");
  });

  test(`★되돌림 변이 (내용 훼손) [${t.name}]: dropping the content of the last unit changes the output away from the applied fixture`, () => {
    const parsed = parsePatchDocument(doc());
    assert.equal(parsed.ok, true, parsed.reason);
    const last = parsed.units[parsed.units.length - 1];
    const mutatedUnits = parsed.units.map((u) =>
      u.id === last.id ? { ...u, content: "" } : u,
    );
    const outcome = applyPatchUnits(mutatedUnits, before());
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.notEqual(outcome.result, applied());
  });
}

test("the launcher document names the E2 procedure inputs a human types: live SHA-256 before (= before fixture), the order (launcher first, memory-gate second) and the rollback", () => {
  const doc = readFileSync(TARGETS[0].docPath, "utf8");
  assert.equal(doc.includes(TARGETS[0].beforeSha256), true);
  assert.equal(doc.includes(TARGETS[1].beforeSha256), true);
  assert.equal(doc.includes(TARGETS[0].appliedSha256), true);
  assert.equal(doc.includes(TARGETS[1].appliedSha256), true);
  assert.match(doc, /E2/);
  assert.match(doc, /-DryRun/);
  assert.match(doc, /되돌림/);
  assert.match(doc, /역순/);
});

test("the launcher document states that it replaces HYK-153-engine-profile.md §1 and §3", () => {
  const doc = readFileSync(TARGETS[0].docPath, "utf8");
  assert.match(doc, /HYK-153-engine-profile\.md/);
  assert.match(doc, /§1/);
  assert.match(doc, /§3/);
  assert.match(doc, /대체/);
});
