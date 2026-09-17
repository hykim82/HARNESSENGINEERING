// install-copylist-closure.test.mjs -- HYK-209-frame-repair-1 ⓐ'.
//
// install.mjs's scripts/check/*.mjs and scripts/relay/*.mjs copy lists
// (ENFORCEMENT_CHECK_FILES / ENFORCEMENT_RELAY_FILES, exported by
// install.mjs itself -- this test reads the SAME list the installer uses,
// not a regex-scraped guess of it) are hand-maintained. The same class of
// gap -- a file the list ships gets copied, but a file IT statically
// imports does not, so the installed copy fails to even load
// (MODULE_NOT_FOUND) on a fresh target -- has now happened three times:
//   1. time-authority.mjs (relay-handshake.mjs's dependency, HYK-186 1R)
//   2. done-line-write-guard.mjs (the wired hook's redirect target existed
//      nowhere on a fresh target, HYK-186 3R P1-1)
//   3. stop-blocking.mjs / reject-streak.mjs (HYK-209-frame-repair-1 ⓐ)
//
// This test makes the list's import-closure a machine-checked property:
// every static `import ... from "./X.mjs"` / `export ... from "./X.mjs"`
// relative specifier found inside a listed file must itself be a name in
// the same list.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENFORCEMENT_CHECK_FILES,
  ENFORCEMENT_RELAY_FILES,
} from "./install.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const CHECK_DIR = path.join(REPO_ROOT, "scripts", "check");
const RELAY_DIR = path.join(REPO_ROOT, "scripts", "relay");

// Static-only, on purpose (★정직 한계, restated in the result file too):
// this regex finds `import`/`export ... from "<spec>"` relative
// specifiers of the three shapes this repo actually uses between these two
// directories -- "./X.mjs" (same directory), "../check/X.mjs" and
// "../relay/X.mjs" (the other of these two directories). It does NOT see a
// dynamic `import()`, a plain `fs` read of another file's path (the exact
// class of gap ⓑ in this same round fixes for context-inject.test.mjs's
// template read), a file a hook's own command line or a spawned child
// process names by path rather than importing (e.g.
// hyk400-receiver-probe-runner.mjs, spawned by hyk400-receiver-guard.mjs --
// confirmed still MODULE_NOT_FOUND on an installed target even after this
// round; see the result file's honesty-limits section), or a relative
// import into a THIRD directory such as "./adapters/X.mjs" or
// "../supervisor/X.mjs" (scripts/relay/adapters/* and scripts/supervisor/*
// are this repo's still-unassembled "unattended layer" --
// installUnattendedLayerManifest's own header in install.mjs already
// documents that this installer copies none of those files, in this round
// or any prior one; several ENFORCEMENT_RELAY_FILES entries genuinely
// import from scripts/relay/adapters/, so those specific files still
// MODULE_NOT_FOUND on an installed target -- a real, pre-existing,
// out-of-scope gap this round does not close).
// [^;]* (not [^;\n]*) deliberately spans newlines -- multi-line
// `import {\n  a,\n  b,\n} from "./x.mjs";` blocks are common in this repo
// (e.g. dispatch-gate-decision.mjs) and a newline-excluding version of this
// regex silently misses them (found live: it missed
// dispatch-gate-decision.mjs -> "./retirement-record-core.mjs" until this
// was caught by actually running the installed target's own tests, §3-3 --
// not by this regex itself, which is the honest limit worth recording:
// this static check is only as good as its own regex, and a regex is not a
// parser). Likewise the cross-directory "../check/" / "../relay/" forms
// were missed by an earlier same-directory-only version of this regex
// until caught the same way (finalize-done.mjs -> "../check/first-
// observation.mjs").
const RELATIVE_IMPORT_RE =
  /\b(?:import|export)\b[^;]*?\bfrom\s+["'](\.\.?\/(?:check\/|relay\/)?[A-Za-z0-9._-]+\.mjs)["']/g;

// Parses one raw specifier (as captured by RELATIVE_IMPORT_RE) into which
// list it must belong to ("check" or "relay") plus the bare filename,
// given which directory the importing file itself lives in.
function resolveSpec(spec, ownDirKey) {
  if (spec.startsWith("../check/")) {
    return { dirKey: "check", name: spec.slice("../check/".length) };
  }
  if (spec.startsWith("../relay/")) {
    return { dirKey: "relay", name: spec.slice("../relay/".length) };
  }
  return { dirKey: ownDirKey, name: spec.slice("./".length) };
}

function extractRelativeRefs(absPath, ownDirKey) {
  const src = readFileSync(absPath, "utf8");
  const refs = [];
  let m;
  RELATIVE_IMPORT_RE.lastIndex = 0;
  while ((m = RELATIVE_IMPORT_RE.exec(src))) {
    refs.push(resolveSpec(m[1], ownDirKey));
  }
  return refs;
}

// pm-guard.mjs is a deliberate, single, documented exemption: install.mjs's
// installPmGuard() installs it via a SEPARATE path (substitutePmGuard
// ControlRoom rewrites its CONTROL_ROOM_ROOT constant for the target before
// writing it -- see install.mjs's own comment at that call site, HYK-309),
// not via the raw ENFORCEMENT_CHECK_FILES copy loop. It genuinely IS
// installed -- just not by this list -- so pm-guard.test.mjs's import of it
// is not a real gap. Adding "pm-guard.mjs" to the raw list instead would be
// actively wrong: the raw loop runs first and would write the
// UNSUBSTITUTED file, and installPmGuard's own skip-if-exists check would
// then leave that wrong (still pointing at THIS repo's live control room)
// copy in place.
const EXEMPT_FROM_CLOSURE = new Set(["pm-guard.mjs"]);

const DIRS = { check: CHECK_DIR, relay: RELAY_DIR };
// Returns a list of {file, missing} violations across BOTH lists at once:
// a file in `lists.check`/`lists.relay` statically imports another file
// (same directory, or explicitly "../check/"/"../relay/" cross-directory),
// but that target name is not itself present in the list for ITS
// directory. Files that don't exist on disk are silently skipped -- a
// different, already-covered failure (copyRawFile's own "source missing"
// warning), not a closure gap.
function findClosureViolations(lists) {
  const sets = { check: new Set(lists.check), relay: new Set(lists.relay) };
  const violations = [];
  for (const dirKey of ["check", "relay"]) {
    for (const name of lists[dirKey]) {
      const abs = path.join(DIRS[dirKey], name);
      if (!existsSync(abs)) continue;
      for (const ref of extractRelativeRefs(abs, dirKey)) {
        if (
          !sets[ref.dirKey].has(ref.name) &&
          !EXEMPT_FROM_CLOSURE.has(ref.name)
        ) {
          violations.push({
            file: `${dirKey}/${name}`,
            missing: `${ref.dirKey}/${ref.name}`,
          });
        }
      }
    }
  }
  return violations;
}

describe("ⓐ' install copy-list closure (real lists, real files, cross-directory aware)", () => {
  test("ENFORCEMENT_CHECK_FILES + ENFORCEMENT_RELAY_FILES are jointly import-closed", () => {
    const violations = findClosureViolations({
      check: ENFORCEMENT_CHECK_FILES,
      relay: ENFORCEMENT_RELAY_FILES,
    });
    assert.deepEqual(
      violations,
      [],
      `copy lists are missing (or would MODULE_NOT_FOUND on install): ${JSON.stringify(violations, null, 2)}`,
    );
  });
});

// ⛔음성 대조 (negative control) + ★회귀 증명 (regression proof), both at
// once: filter the REAL, CURRENT list down (in-memory only -- the real list
// on disk is never mutated by this test) by removing exactly one past
// incident's file, and assert the SAME closure function that just passed
// above now reports that exact name as a violation. If any of these went
// green (no violation reported), the closure check would be proven to have
// no teeth -- this is what "이 RED 가 없으면 헛시험이다" is checking for.
describe("음성 대조 + 과거 사고 회귀 증명 (in-memory list reduction, no file mutation)", () => {
  // ★정직 한계 (읽어야 함): of the 3 past incidents named in this round's
  // task (time-authority.mjs / done-line-write-guard.mjs / stop-blocking+
  // reject-streak.mjs), only 2 of the 3 are actually an IMPORT-closure gap
  // that this static-import check can see:
  //   - time-authority.mjs: relay-handshake.mjs statically imports it.
  //   - stop-blocking.mjs / reject-streak.mjs: clear-safe-check.mjs /
  //     controlroom-fresh.mjs / review-gate.mjs / relay-handshake.mjs /
  //     dispatch-gate-decision.test.mjs statically import them.
  // done-line-write-guard.mjs's ORIGINAL incident was a DIFFERENT failure
  // class from time-authority.mjs's: no installed file statically imports
  // done-line-write-guard.mjs for its own sake -- it is reached in
  // production only from a hook's COMMAND LINE
  // (`node .../done-line-write-guard.mjs`) in the .claude/settings.local
  // .json this installer writes, which this regex-based check cannot see
  // (only `import`/`export ... from`). If done-line-write-guard.mjs had
  // shipped with NO .test.mjs pair, removing it from the list would NOT go
  // red here (that exact scenario is what the "OUT OF SCOPE" test right
  // below actually demonstrates, using a file that truly has no importer).
  // done-line-write-guard.mjs itself, however, DOES have a same-named
  // .test.mjs pair already in this list, and that test file imports its
  // own implementation ("./done-line-write-guard.mjs") purely to unit-test
  // it -- so removing the .mjs while leaving its .test.mjs in the list
  // still surfaces a violation below, just via that incidental self-import,
  // not via the hook-command-line path the original incident actually
  // broke on. A future file reached ONLY by hook command line, with no
  // test file importing it back, would still be invisible to this check --
  // see the honesty-limits section of the result file for that statement.
  const PAST_INCIDENTS = [
    {
      removed: "time-authority.mjs",
      culprit: "relay-handshake.mjs (HYK-186 1R)",
    },
    {
      removed: "stop-blocking.mjs",
      culprit: "clear-safe-check.mjs / controlroom-fresh.mjs (this round, ⓐ)",
    },
    {
      removed: "reject-streak.mjs",
      culprit:
        "review-gate.mjs / relay-handshake.mjs / dispatch-gate-decision.test.mjs (this round, ⓐ)",
    },
  ];

  for (const { removed, culprit } of PAST_INCIDENTS) {
    test(`removing "${removed}" from the real list goes RED (${culprit})`, () => {
      const reduced = ENFORCEMENT_CHECK_FILES.filter((n) => n !== removed);
      assert.ok(
        reduced.length === ENFORCEMENT_CHECK_FILES.length - 1,
        `${removed} must actually be present in the real list for this control to mean anything`,
      );
      const violations = findClosureViolations({
        check: reduced,
        relay: ENFORCEMENT_RELAY_FILES,
      });
      assert.ok(
        violations.some((v) => v.missing === `check/${removed}`),
        `expected removing ${removed} to surface a violation naming it; got ${JSON.stringify(violations)}`,
      );
    });
  }

  test('removing "done-line-write-guard.mjs" (keeping its .test.mjs) goes RED via the test-pair self-import, not the original hook-command-line path', () => {
    const reduced = ENFORCEMENT_CHECK_FILES.filter(
      (n) => n !== "done-line-write-guard.mjs",
    );
    const violations = findClosureViolations({
      check: reduced,
      relay: ENFORCEMENT_RELAY_FILES,
    });
    assert.ok(
      violations.some(
        (v) =>
          v.missing === "check/done-line-write-guard.mjs" &&
          v.file === "check/done-line-write-guard.test.mjs",
      ),
      `expected done-line-write-guard.test.mjs's own self-import to surface a violation; got ${JSON.stringify(violations)}`,
    );
  });

  test("hook-command-line-only reference (no test-file self-import) is a genuine blind spot -- synthetic proof", () => {
    // Distinguishes the coincidental catch above from the real limit: a
    // file reached ONLY by a hook command line, shipped with NO .test.mjs
    // that imports it back, is invisible to this static-import check. This
    // is the honest boundary this round's task explicitly requires be
    // documented, not silently left implicit.
    const hookOnlyFile = "check/review-gate.mjs"; // stands in for "any list member"
    const listWithoutItsOwnTest = ENFORCEMENT_CHECK_FILES.filter(
      (n) => n !== "review-gate.test.mjs",
    );
    const violations = findClosureViolations({
      check: listWithoutItsOwnTest,
      relay: ENFORCEMENT_RELAY_FILES,
    });
    assert.ok(
      !violations.some((v) => v.file === hookOnlyFile),
      "review-gate.mjs itself has no relative imports, so removing only its .test.mjs pair should not, on its own, surface a violation naming review-gate.mjs -- demonstrating that a hook-only reference (never imported back by a test) would slip through the same way",
    );
  });
});

// Algorithm self-test, independent of any real repo file: proves
// findClosureViolations() itself actually detects an open list and
// clears a closed one, using synthetic fixtures written to a temp dir so
// this test never depends on -- or could be defeated by -- future edits to
// this repo's real scripts/check files.
describe("closure algorithm self-test (synthetic fixtures)", () => {
  test("open list (missing dependency) -> violation reported", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const dir = mkdtempSync(path.join(os.tmpdir(), "closure-selftest-"));
    try {
      writeFileSync(
        path.join(dir, "a.mjs"),
        'import { b } from "./b.mjs";\nexport const a = 1;\n',
        "utf8",
      );
      writeFileSync(path.join(dir, "b.mjs"), "export const b = 1;\n", "utf8");
      const violations = findSyntheticViolations(dir, ["a.mjs"]);
      assert.deepEqual(violations, [{ file: "a.mjs", missing: "b.mjs" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("closed list (dependency included) -> no violation", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const dir = mkdtempSync(path.join(os.tmpdir(), "closure-selftest-"));
    try {
      writeFileSync(
        path.join(dir, "a.mjs"),
        'import { b } from "./b.mjs";\nexport const a = 1;\n',
        "utf8",
      );
      writeFileSync(path.join(dir, "b.mjs"), "export const b = 1;\n", "utf8");
      const violations = findSyntheticViolations(dir, ["a.mjs", "b.mjs"]);
      assert.deepEqual(violations, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Single-directory helper for the synthetic self-test above only (the real
// findClosureViolations is always two-directory/cross-aware now; this
// mirrors its original single-directory shape against throwaway fixtures).
function findSyntheticViolations(dir, list) {
  const listSet = new Set(list);
  const violations = [];
  for (const name of list) {
    const abs = path.join(dir, name);
    if (!existsSync(abs)) continue;
    for (const ref of extractRelativeRefs(abs, "solo")) {
      if (!listSet.has(ref.name))
        violations.push({ file: name, missing: ref.name });
    }
  }
  return violations;
}
