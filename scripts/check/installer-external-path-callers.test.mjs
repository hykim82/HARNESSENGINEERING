// installer-external-path-callers.test.mjs -- HYK-209-installer-mismatch-report-1 ⓐ (축 A).
//
// Tests scripts/check/installer-external-path-callers.mjs. Placed under
// scripts/check/ on purpose: the isolated suite runner's TEST_DIRS (this base)
// collects scripts/check, and templates/harness-init/ is NOT collected on this
// base (that is PR #301's job, not this round's). Asserted below, not assumed.
//
// Detection power is proven two ways, both in this file:
//  - in-process: the copy lists handed to findCallerViolations are altered
//    (derive-claude-project-dir-cli.mjs removed) -> violation reported.
//  - the REAL installer lists are used in the main assertion, and the
//    presence-requirement constant is never read by this axis (see the
//    independence test), so emptying it cannot make this axis go green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PATCH_DOCS_DIR,
  COPY_LIST_BY_DIR,
  KNOWN_EXCEPTIONS,
  extractExternalPathCallers,
  findCallerViolations,
} from "./installer-external-path-callers.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DERIVE = "scripts/supervisor/derive-claude-project-dir-cli.mjs";

test("축 A: extraction finds the real by-path call sites (fail-closed guard input)", () => {
  const callers = extractExternalPathCallers();
  assert.ok(
    callers.length > 0,
    "0 by-path call sites extracted from docs/control-room-patches -- the axis would be silently dead",
  );
  const rels = new Set(callers.map((c) => c.rel));
  assert.ok(
    rels.has(DERIVE),
    `the ps1 derive call site (${DERIVE}) must be extracted from HYK-378 doc`,
  );
});

test("축 A: real repo -- every extracted by-path caller is in its copy list or a named exception", () => {
  const violations = findCallerViolations(extractExternalPathCallers());
  assert.deepEqual(
    violations,
    [],
    "by-path caller(s) missing from the installer copy list: " +
      JSON.stringify(violations),
  );
});

test("축 A: detection power -- removing derive-claude-project-dir-cli.mjs from its copy list is reported", () => {
  const altered = {
    ...COPY_LIST_BY_DIR,
    supervisor: COPY_LIST_BY_DIR.supervisor.filter(
      (n) => n !== "derive-claude-project-dir-cli.mjs",
    ),
  };
  const violations = findCallerViolations(
    extractExternalPathCallers(),
    altered,
  );
  const hit = violations.find((v) => v.rel === DERIVE);
  assert.ok(
    hit && hit.kind === "NOT_IN_COPY_LIST",
    `expected NOT_IN_COPY_LIST for ${DERIVE}, got ${JSON.stringify(violations)}`,
  );
});

test("축 A: fail-closed -- a docs folder with zero call sites is a violation, not a pass", () => {
  const empty = mkdtempSync(
    path.join(tmpdir(), "hyk209-mismatch-report-empty-"),
  );
  try {
    const callers = extractExternalPathCallers(empty);
    assert.equal(callers.length, 0);
    const violations = findCallerViolations(callers);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].kind, "NO_CALLERS_EXTRACTED");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("축 A: named exceptions must carry a non-empty reason (no blank or wildcard exemptions)", () => {
  for (const [rel, reason] of Object.entries(KNOWN_EXCEPTIONS)) {
    assert.match(
      rel,
      /^scripts\/(check|relay|supervisor)\/[^*]+\.mjs$/,
      `exception key must be an exact path: ${rel}`,
    );
    assert.ok(
      typeof reason === "string" && reason.trim().length > 20,
      `exception ${rel} needs a real reason`,
    );
  }
});

test("축 A: independence -- this axis does not read ENFORCEMENT_SUPERVISOR_REQUIRED", () => {
  const src = readFileSync(
    path.join(THIS_DIR, "installer-external-path-callers.mjs"),
    "utf8",
  );
  assert.ok(
    !src.includes("ENFORCEMENT_SUPERVISOR_REQUIRED"),
    "the new axis must not depend on the constant it is meant to back up",
  );
});

test("축 A: placement -- module and test sit in scripts/check (the runner's collected dir)", () => {
  assert.equal(path.basename(THIS_DIR), "check");
  const runner = readFileSync(
    path.join(THIS_DIR, "isolated-suite-runner.mjs"),
    "utf8",
  );
  assert.ok(
    /scripts\/check/.test(runner),
    "isolated-suite-runner.mjs must still collect scripts/check",
  );
  const repoRoot = path.resolve(THIS_DIR, "..", "..");
  assert.equal(
    path.resolve(CONTROL_PATCH_DOCS_DIR).startsWith(repoRoot),
    true,
    "docs must be read from inside the repo, never from the control-room disk",
  );
});

// HYK-209-installer-admission-closure-1: admission-cli.mjs left KNOWN_EXCEPTIONS
// once it joined ENFORCEMENT_SUPERVISOR_FILES. Two things are pinned here: the
// exception is really gone, and an EMPTY exception map still reports a
// by-path caller that is missing from the copy list (no wildcard behaviour).
test("축 A: admission-cli.mjs is no longer a named exception (it is in the copy list)", () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      KNOWN_EXCEPTIONS,
      "scripts/supervisor/admission-cli.mjs",
    ),
    false,
  );
  assert.ok(COPY_LIST_BY_DIR.supervisor.includes("admission-cli.mjs"));
});

test("축 A: empty exception map is not a wildcard -- an unlisted by-path caller is still reported", () => {
  const callers = [
    { rel: "scripts/supervisor/not-in-list.mjs", file: "probe.md", line: 1 },
  ];
  const violations = findCallerViolations(callers, COPY_LIST_BY_DIR, {});
  assert.deepEqual(violations, [
    {
      kind: "NOT_IN_COPY_LIST",
      rel: "scripts/supervisor/not-in-list.mjs",
      sites: ["probe.md:1"],
    },
  ]);
});
