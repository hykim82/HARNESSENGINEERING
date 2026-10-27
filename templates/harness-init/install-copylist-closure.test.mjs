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
  ENFORCEMENT_SUPERVISOR_FILES,
  ENFORCEMENT_SUPERVISOR_REQUIRED,
  supervisorCopyPairs,
} from "./install.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "..", "..");
const CHECK_DIR = path.join(REPO_ROOT, "scripts", "check");
const RELAY_DIR = path.join(REPO_ROOT, "scripts", "relay");
const SUPERVISOR_DIR = path.join(REPO_ROOT, "scripts", "supervisor");

// The real lists, all three axes plus the presence requirement. Every call
// below spreads this and overrides only the one list it is probing, so no
// call can silently drop an axis.
const REAL_LISTS = {
  check: ENFORCEMENT_CHECK_FILES,
  relay: ENFORCEMENT_RELAY_FILES,
  supervisor: ENFORCEMENT_SUPERVISOR_FILES,
  supervisorRequired: ENFORCEMENT_SUPERVISOR_REQUIRED,
};

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
// documents that this installer copies none of those files except
// ENFORCEMENT_SUPERVISOR_FILES (HYK-209-installer-closure-derive-1 2R: the
// derive CLI and its one import, rate-limit-stall-adapter.mjs). The
// supervisor axis IS closure-checked, but only for same-directory "./X"
// imports from files inside scripts/supervisor/; a check/relay file that
// imports "../supervisor/X.mjs" is still invisible to this regex -- a
// candidate for a later round, not this one. Several ENFORCEMENT_RELAY_FILES entries genuinely
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

const DIRS = { check: CHECK_DIR, relay: RELAY_DIR, supervisor: SUPERVISOR_DIR };
// Returns a list of {file, missing} violations across ALL lists at once:
// (1) a file in `lists.check`/`lists.relay`/`lists.supervisor` statically
// imports another file (same directory, or explicitly "../check/"/
// "../relay/" cross-directory), but that target name is not itself present
// in the list for ITS directory;
// (2) HYK-209-installer-closure-derive-1 1-1: a listed name whose source file
// does NOT exist on disk is a violation, not a silent skip. The old
// `if (!existsSync(abs)) continue;` made the closure check blind to the
// list's own contents -- a name could be added or left behind with no
// source and the check stayed green, so "remove it from the list -> red"
// could never hold;
// (3) HYK-209-installer-closure-derive-1 1-2: every name in
// `lists.supervisorRequired` must be present in `lists.supervisor`.
function findClosureViolations(lists) {
  const sets = {
    check: new Set(lists.check),
    relay: new Set(lists.relay),
    supervisor: new Set(lists.supervisor),
  };
  const violations = [];
  for (const dirKey of ["check", "relay", "supervisor"]) {
    for (const name of lists[dirKey]) {
      const abs = path.join(DIRS[dirKey], name);
      if (!existsSync(abs)) {
        violations.push({
          file: `${dirKey}/${name}`,
          missing: "(listed in the copy list, but the source file is absent)",
        });
        continue;
      }
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
  for (const name of lists.supervisorRequired) {
    if (!sets.supervisor.has(name)) {
      violations.push({
        file: "supervisor (copy list)",
        missing: `supervisor/${name} (required entry point, absent from the list)`,
      });
    }
  }
  return violations;
}

describe("ⓐ' install copy-list closure (real lists, real files, cross-directory aware)", () => {
  test("ENFORCEMENT_CHECK_FILES + ENFORCEMENT_RELAY_FILES + ENFORCEMENT_SUPERVISOR_FILES are jointly import-closed, present, and carry their required entry points", () => {
    const violations = findClosureViolations(REAL_LISTS);
    assert.deepEqual(
      violations,
      [],
      `copy lists are missing (or would MODULE_NOT_FOUND on install): ${JSON.stringify(violations, null, 2)}`,
    );
  });
});

// HYK-209-installer-closure-derive-1 1-1 regression: a listed name with NO
// source file on disk must go RED (it was green before -- the silent skip).
describe("1-1 listed-but-absent source is a violation (no silent skip)", () => {
  test("a nonexistent name added to the check list goes RED", () => {
    const violations = findClosureViolations({
      ...REAL_LISTS,
      check: [...ENFORCEMENT_CHECK_FILES, "zz-no-such-file.mjs"],
    });
    assert.ok(
      violations.some(
        (v) =>
          v.file === "check/zz-no-such-file.mjs" && /absent/.test(v.missing),
      ),
      `expected a violation naming the absent listed file; got ${JSON.stringify(violations)}`,
    );
  });
});

// HYK-209-installer-closure-derive-1 1-2 / 1-3: the scripts/supervisor axis.
describe("1-2 / 1-3 scripts/supervisor copy axis", () => {
  test("removing derive-claude-project-dir-cli.mjs from the supervisor list goes RED (required entry point)", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "derive-claude-project-dir-cli.mjs",
    );
    const violations = findClosureViolations({
      ...REAL_LISTS,
      supervisor: reduced,
    });
    assert.ok(
      violations.some(
        (v) =>
          v.missing ===
          "supervisor/derive-claude-project-dir-cli.mjs (required entry point, absent from the list)",
      ),
      `expected removing derive-claude-project-dir-cli.mjs to surface a violation naming it; got ${JSON.stringify(violations)}`,
    );
  });

  test("removing rate-limit-stall-adapter.mjs (the CLI's relative import) goes RED via import closure", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "rate-limit-stall-adapter.mjs",
    );
    const violations = findClosureViolations({
      ...REAL_LISTS,
      supervisor: reduced,
    });
    assert.ok(
      violations.some(
        (v) =>
          v.file === "supervisor/derive-claude-project-dir-cli.mjs" &&
          v.missing === "supervisor/rate-limit-stall-adapter.mjs",
      ),
      `expected derive CLI's import of rate-limit-stall-adapter.mjs to surface a violation; got ${JSON.stringify(violations)}`,
    );
  });

  test("installed destination is scripts/supervisor/<name> (the CLI's endsWith entry-point contract)", () => {
    const target = path.join(REPO_ROOT, "__target__");
    const pairs = supervisorCopyPairs(target);
    assert.equal(pairs.length, ENFORCEMENT_SUPERVISOR_FILES.length);
    for (const { src, dst } of pairs) {
      const name = path.basename(src);
      assert.equal(dst, path.join(target, "scripts", "supervisor", name));
      assert.equal(src, path.join(SUPERVISOR_DIR, name));
      assert.ok(
        dst.split(path.sep).join("/").endsWith(`scripts/supervisor/${name}`),
        `destination for ${name} must end with scripts/supervisor/${name}; got ${dst}`,
      );
    }
    const cli = pairs.find(
      (p) => path.basename(p.src) === "derive-claude-project-dir-cli.mjs",
    );
    assert.ok(cli, "derive CLI must be among the copied pairs");
    assert.ok(
      cli.dst
        .split(path.sep)
        .join("/")
        .endsWith("scripts/supervisor/derive-claude-project-dir-cli.mjs"),
      "the CLI's own run-detection endsWith() string must match its installed path",
    );
  });
});

// HYK-209-install-list-dispatch-start-1 (1R): the "3 + 3" addition's own
// teeth -- a required entry point and its two import-closure dependencies --
// in a separate describe block (not appended to "1-2 / 1-3" above) purely to
// stay under this repo's ESLint max-lines-per-function ceiling; same
// REAL_LISTS / findClosureViolations the block above uses.
describe("HYK-209-install-list-dispatch-start-1: dispatch-start trio supervisor-list teeth", () => {
  test("removing dispatch-start-confirm-cli.mjs from the supervisor list goes RED (required entry point, this round's addition)", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "dispatch-start-confirm-cli.mjs",
    );
    const violations = findClosureViolations({
      ...REAL_LISTS,
      supervisor: reduced,
    });
    assert.ok(
      violations.some(
        (v) =>
          v.missing ===
          "supervisor/dispatch-start-confirm-cli.mjs (required entry point, absent from the list)",
      ),
      `expected removing dispatch-start-confirm-cli.mjs to surface a violation naming it; got ${JSON.stringify(violations)}`,
    );
  });

  test("removing dispatch-start-size-core.mjs (confirm-cli's relative import) goes RED via import closure", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "dispatch-start-size-core.mjs",
    );
    const violations = findClosureViolations({
      ...REAL_LISTS,
      supervisor: reduced,
    });
    assert.ok(
      violations.some(
        (v) =>
          v.file === "supervisor/dispatch-start-confirm-cli.mjs" &&
          v.missing === "supervisor/dispatch-start-size-core.mjs",
      ),
      `expected confirm-cli's import of dispatch-start-size-core.mjs to surface a violation; got ${JSON.stringify(violations)}`,
    );
  });

  test("removing dispatch-start-size-adapter.mjs (confirm-cli's other relative import) goes RED via import closure", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "dispatch-start-size-adapter.mjs",
    );
    const violations = findClosureViolations({
      ...REAL_LISTS,
      supervisor: reduced,
    });
    assert.ok(
      violations.some(
        (v) =>
          v.file === "supervisor/dispatch-start-confirm-cli.mjs" &&
          v.missing === "supervisor/dispatch-start-size-adapter.mjs",
      ),
      `expected confirm-cli's import of dispatch-start-size-adapter.mjs to surface a violation; got ${JSON.stringify(violations)}`,
    );
  });

  // ⓔ⑶ (coder-task §2): removing one of the 3 paired .test.mjs entries does
  // NOT go RED via THIS generic closure check (findClosureViolations) --
  // no other listed file statically imports a .test.mjs file back (same
  // documented blind spot as the "review-gate.mjs" case in the 음성대조
  // block below: a list member reached only by convention, not by another
  // file's import, is invisible to a closure walk).
  //
  // HYK-209-install-pair-test-1 (⛔UPDATE, this round): the broader "짝 관례
  // 칸 = 없음" claim this comment used to make is no longer true -- the new,
  // GENERIC "짝 .test.mjs 목록 편입 관례" describe block further below
  // (findPairTestViolations) now catches exactly this removal (and every
  // other non-test .mjs whose on-disk sibling .test.mjs drops out of the
  // same list), across all three lists, not just these three dispatch-start
  // entries. The assertion immediately below this comment stays literally
  // true on its own narrow terms -- findClosureViolations itself (a static
  // import-closure walk, not a pair-naming convention) still cannot and
  // does not see this -- so the test is left in place, now documenting that
  // specific, narrower limit of THIS check; the broader gap it used to
  // describe is closed by the separate cell, not this one.
  test("removing dispatch-start-size-core.test.mjs (a paired test, not an import target) stays GREEN under the import-closure check alone -- a narrower, still-real blind spot of findClosureViolations specifically (the separate pair-test cell below now catches the same removal)", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "dispatch-start-size-core.test.mjs",
    );
    const violations = findClosureViolations({
      ...REAL_LISTS,
      supervisor: reduced,
    });
    assert.ok(
      !violations.some((v) =>
        /dispatch-start-size-core\.test\.mjs/.test(v.missing),
      ),
      `expected removing the paired test (with no other list member importing it back) to NOT surface a violation; got ${JSON.stringify(violations)}`,
    );
  });
});

// HYK-209-install-pair-test-1 (coder-task.md §2 ⓐ/ⓑ/ⓒ/ⓓ): generic "짝
// 시험 목록 편입" cell -- every non-test .mjs that is ITSELF a member of one
// of the three real lists, and whose on-disk sibling .test.mjs (same
// directory, same basename + ".test.mjs" -- the exact convention every
// existing pair in these three lists already follows, e.g.
// "review-gate.mjs"/"review-gate.test.mjs") EXISTS IN THE REPO, must have
// that sibling in the SAME list too. H6 검토 1R (REVIEW-r1.md, read-only
// citation in coder-task.md §1) found this convention was not machine-
// checked anywhere: a paired test can be dropped from a list with none of
// the four installer test files going RED. This closes that, generically,
// across all three lists (not just the 3-member dispatch-start trio the
// describe block above already covers one-off).
//
// Deliberately separate from findClosureViolations() above: that function
// checks STATIC IMPORT closure (a file importing another must have that
// other file listed too); this one checks a NAMING CONVENTION (a listed
// non-test file whose same-named .test.mjs exists on disk must have THAT
// name listed too). Neither subsumes the other -- see the updated comment
// on "removing dispatch-start-size-core.test.mjs ... stays GREEN under the
// import-closure check alone" right above for the precise boundary between
// the two.
//
// Returns the exact sibling .test.mjs name for a non-test .mjs name, or
// null when `name` is not eligible for pairing (not a ".mjs" name at all,
// or already itself a ".test.mjs" name).
function siblingTestName(name) {
  if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) return null;
  return name.slice(0, -".mjs".length) + ".test.mjs";
}

// §2 ⓑ: exact-name, one-line, fact-only-reason exceptions -- the current
// gaps 〔직접〕 measured by this round (findPairTestViolations against
// REAL_LISTS, before this exception list existed): 8 total (check 2,
// supervisor 6, relay 0), matching ORCH's own §1 count. No wildcards, no
// directory-level entries -- every entry below names exactly one (dir,
// main, sibling) triple.
const PAIR_TEST_EXCEPTIONS = [
  {
    dir: "check",
    main: "ledger-pointer-shared.mjs",
    sibling: "ledger-pointer-shared.test.mjs",
    reason:
      "blocked, not just unadopted -- 짝 시험이 설치 대상에 없는 모듈을 import 함: ledger-pointer-shared.test.mjs:42의 readFileSync(join(HERE, '..', 'supervisor', 'orch-stall-detect.mjs')) -- orch-stall-detect.mjs는 세 목록(check/relay/supervisor) 어디에도 없다 〔직접〕(install.mjs 자신의 1254-1270행 주석이 이미 같은 사유로 문서화).",
  },
  {
    dir: "check",
    main: "abort-record-writer.mjs",
    sibling: "abort-record-writer.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험의 import는 ./abort-record-writer.mjs, ./abort-record-core.mjs 둘뿐이고 둘 다 이미 check 목록 안에서 닫혀 있다(차단 사유 없음) 〔직접〕; 이 조각의 product_scope(생산 코드 0)가 실제 목록 편입을 막는다.",
  },
  {
    dir: "supervisor",
    main: "derive-claude-project-dir-cli.mjs",
    sibling: "derive-claude-project-dir-cli.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험의 import는 ./derive-claude-project-dir-cli.mjs, ./rate-limit-stall-adapter.mjs 둘뿐이고 둘 다 이미 supervisor 목록 안에서 닫혀 있다(차단 사유 없음) 〔직접〕; product_scope(생산 코드 0)가 편입을 막는다.",
  },
  {
    dir: "supervisor",
    main: "rate-limit-stall-adapter.mjs",
    sibling: "rate-limit-stall-adapter.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험은 자기 자신(./rate-limit-stall-adapter.mjs)만 import하고 node 빌트인 외 다른 상대 경로는 없다(차단 사유 없음) 〔직접〕; product_scope(생산 코드 0)가 편입을 막는다.",
  },
  {
    dir: "supervisor",
    main: "admission-cli.mjs",
    sibling: "admission-cli.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험은 자기 자신(./admission-cli.mjs)만 import하고 node 빌트인 외 다른 상대 경로는 없다(차단 사유 없음) 〔직접〕; product_scope(생산 코드 0)가 편입을 막는다.",
  },
  {
    dir: "supervisor",
    main: "admission-ledger-core.mjs",
    sibling: "admission-ledger-core.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험은 자기 자신(./admission-ledger-core.mjs)만 import한다(차단 사유 없음) 〔직접〕; product_scope(생산 코드 0)가 편입을 막는다.",
  },
  {
    dir: "supervisor",
    main: "admission-ledger-store.mjs",
    sibling: "admission-ledger-store.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험의 상대 import는 ./admission-ledger-store.mjs, ./admission-ledger-core.mjs(둘 다 supervisor 목록 안), ../check/admission-ledger-env-isolation.mjs(이미 check 목록 안) 뿐이라 전부 닫혀 있다(차단 사유 없음) 〔직접〕; product_scope(생산 코드 0)가 편입을 막는다.",
  },
  {
    dir: "supervisor",
    main: "concurrency-cap-adapter.mjs",
    sibling: "concurrency-cap-adapter.test.mjs",
    reason:
      "미편입 · 편입 후보 -- 짝 시험은 자기 자신(./concurrency-cap-adapter.mjs)만 import한다(차단 사유 없음) 〔직접〕; product_scope(생산 코드 0)가 편입을 막는다.",
  },
];

// Every non-test .mjs in `lists[dirKey]` whose sibling .test.mjs exists on
// disk in the same directory must itself be a member of `lists[dirKey]`,
// unless an exact (dir, main) match is documented in `exceptions`.
function findPairTestViolations(lists, exceptions) {
  const exceptionMap = new Map(
    exceptions.map((e) => [`${e.dir}::${e.main}`, e]),
  );
  const violations = [];
  for (const dirKey of ["check", "relay", "supervisor"]) {
    const list = lists[dirKey];
    const listSet = new Set(list);
    for (const name of list) {
      const sibling = siblingTestName(name);
      if (!sibling) continue;
      if (!existsSync(path.join(DIRS[dirKey], sibling))) continue;
      if (listSet.has(sibling)) continue;
      const exc = exceptionMap.get(`${dirKey}::${name}`);
      if (exc && exc.sibling === sibling) continue;
      violations.push({ dir: dirKey, main: name, missing: sibling });
    }
  }
  return violations;
}

// §2 ⓑ bidirectional staleness: a documented exception is stale -- and
// must surface as its own violation rather than being silently honored --
// when ANY of:
//   (1) the main .mjs is no longer a member of `lists[dir]` (nothing left
//       to except);
//   (2) the sibling .test.mjs is ALREADY a member of `lists[dir]` (the pair
//       was added -- the exception entry should have been deleted then);
//   (3) the sibling .test.mjs file no longer exists on disk (nothing left
//       to except).
function findStaleExceptions(lists, exceptions) {
  const stale = [];
  for (const exc of exceptions) {
    const listSet = new Set(lists[exc.dir]);
    if (!listSet.has(exc.main)) {
      stale.push({ ...exc, why: "main module no longer in list" });
    } else if (listSet.has(exc.sibling)) {
      stale.push({ ...exc, why: "sibling already in list" });
    } else if (!existsSync(path.join(DIRS[exc.dir], exc.sibling))) {
      stale.push({ ...exc, why: "sibling file no longer on disk" });
    }
  }
  return stale;
}

// HYK-209-install-pair-test-1: split into two describe blocks purely to
// stay under this repo's ESLint max-lines-per-function ceiling (same reason
// the "HYK-209-install-list-dispatch-start-1" block above its own sibling
// is separate from "1-2 / 1-3") -- both share the same REAL_LISTS /
// PAIR_TEST_EXCEPTIONS / findPairTestViolations / findStaleExceptions this
// file defines once, above.
describe("HYK-209-install-pair-test-1: 짝 .test.mjs 목록 편입 관례 (core checks)", () => {
  test("siblingTestName computes the exact sibling name (and null for ineligible names) -- direct unit test, independent of repo state (ⓓ⑷: a mutation hollowing this out to always return null would fail THIS assertion directly)", () => {
    assert.equal(siblingTestName("foo.mjs"), "foo.test.mjs");
    assert.equal(siblingTestName("foo.test.mjs"), null);
    assert.equal(siblingTestName("foo.json"), null);
    assert.equal(siblingTestName("review-gate.mjs"), "review-gate.test.mjs");
  });

  test("every non-test .mjs in the three real lists with an on-disk sibling .test.mjs has that sibling in the same list, modulo the documented exception list", () => {
    const violations = findPairTestViolations(REAL_LISTS, PAIR_TEST_EXCEPTIONS);
    assert.deepEqual(
      violations,
      [],
      `missing pair-test entries (or a stale exception masking them): ${JSON.stringify(violations, null, 2)}`,
    );
  });

  test("the exception list itself is not stale (every entry still names a real, current gap)", () => {
    const stale = findStaleExceptions(REAL_LISTS, PAIR_TEST_EXCEPTIONS);
    assert.deepEqual(
      stale,
      [],
      `stale exception entries (no longer describe reality): ${JSON.stringify(stale, null, 2)}`,
    );
  });
});

describe("HYK-209-install-pair-test-1: 짝 .test.mjs 목록 편입 관례 (ⓓ mutation proofs + ⓔ candidate set)", () => {
  // ⓓ⑴ mutation proof: removing a currently-paired (non-excepted) test file
  // from a real list must surface a violation naming it.
  test("ⓓ⑴ removing dispatch-start-size-core.test.mjs (a real, currently-paired, non-excepted test) from the supervisor list goes RED", () => {
    const reduced = ENFORCEMENT_SUPERVISOR_FILES.filter(
      (n) => n !== "dispatch-start-size-core.test.mjs",
    );
    const violations = findPairTestViolations(
      { ...REAL_LISTS, supervisor: reduced },
      PAIR_TEST_EXCEPTIONS,
    );
    assert.ok(
      violations.some(
        (v) =>
          v.dir === "supervisor" &&
          v.main === "dispatch-start-size-core.mjs" &&
          v.missing === "dispatch-start-size-core.test.mjs",
      ),
      `expected removing the paired test to surface a violation naming it; got ${JSON.stringify(violations)}`,
    );
  });

  // ⓓ⑵ mutation proof: removing a documented exception entry un-masks the
  // (still-real) gap it was covering -- it must become a violation again,
  // not silently stay green.
  test("ⓓ⑵ removing the ledger-pointer-shared.mjs exception entry un-masks its still-real gap -> RED", () => {
    const reducedExceptions = PAIR_TEST_EXCEPTIONS.filter(
      (e) => e.main !== "ledger-pointer-shared.mjs",
    );
    const violations = findPairTestViolations(REAL_LISTS, reducedExceptions);
    assert.ok(
      violations.some(
        (v) => v.dir === "check" && v.main === "ledger-pointer-shared.mjs",
      ),
      `expected removing the exception entry to re-surface its violation; got ${JSON.stringify(violations)}`,
    );
  });

  // ⓓ⑶ mutation proof: a STALE exception (claims a gap for a pair that is
  // ALREADY closed in the real list) must itself be reported by
  // findStaleExceptions, not silently accepted as a valid exception.
  test("ⓓ⑶ a stale exception entry (sibling already paired in the real list) is reported, not silently honored", () => {
    const staleAddition = {
      dir: "check",
      // abort-record-core.mjs/.test.mjs are BOTH already in the real check
      // list (ENFORCEMENT_CHECK_FILES) -- a synthetic, deliberately-wrong
      // exception entry for an already-closed pair, to prove staleness
      // detection fires; not a real exception (not added to
      // PAIR_TEST_EXCEPTIONS itself).
      main: "abort-record-core.mjs",
      sibling: "abort-record-core.test.mjs",
      reason: "synthetic stale-exception probe (not a real exception entry)",
    };
    const stale = findStaleExceptions(REAL_LISTS, [
      ...PAIR_TEST_EXCEPTIONS,
      staleAddition,
    ]);
    assert.ok(
      stale.some(
        (s) =>
          s.main === "abort-record-core.mjs" &&
          s.why === "sibling already in list",
      ),
      `expected the synthetic stale exception to be reported; got ${JSON.stringify(stale)}`,
    );
  });

  // §2 ⓔ: candidates measured (not adopted this round -- product_scope
  // caps production code at 0) -- every PAIR_TEST_EXCEPTIONS entry above
  // whose own reason text says "미편입 · 편입 후보" (import closure already
  // satisfied, no blocker found) rather than "blocked". Listed here so a
  // later round reading this file alone (not just the result file, which
  // will eventually rot out of the task's own history) can see the
  // candidate set without re-deriving it.
  test("§2 ⓔ candidate-for-adoption subset of the exception list is exactly the 7 non-blocked entries (documents the candidate set this round measured but did not adopt)", () => {
    const candidates = PAIR_TEST_EXCEPTIONS.filter((e) =>
      e.reason.startsWith("미편입 · 편입 후보"),
    ).map((e) => e.main);
    assert.deepEqual(
      candidates,
      [
        "abort-record-writer.mjs",
        "derive-claude-project-dir-cli.mjs",
        "rate-limit-stall-adapter.mjs",
        "admission-cli.mjs",
        "admission-ledger-core.mjs",
        "admission-ledger-store.mjs",
        "concurrency-cap-adapter.mjs",
      ],
      `candidate set changed -- update this list (and the result file's ⓔ table) if that is intentional: ${JSON.stringify(candidates)}`,
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
    {
      // HYK-209-install-list-g1-adapter-1 V3: admission-completion-
      // adapter.mjs (newly added this round, same file) statically imports
      // "./ledger-pointer-shared.mjs" -- measured live, this was NOT
      // already covered by any pre-existing list entry's own closure.
      removed: "ledger-pointer-shared.mjs",
      culprit:
        "admission-completion-adapter.mjs (HYK-209-install-list-g1-adapter-1)",
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
        ...REAL_LISTS,
        check: reduced,
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
      ...REAL_LISTS,
      check: reduced,
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
      ...REAL_LISTS,
      check: listWithoutItsOwnTest,
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
