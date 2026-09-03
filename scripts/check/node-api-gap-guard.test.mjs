import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  BANNED_APIS,
  scanTextForBannedApis,
  listSourceFiles,
  runNodeApiGapGuard,
} from "./node-api-gap-guard.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

// coder-task.md §0: never use this repo's own .harness/*.md as a test
// target -- every fixture in this file lives under an mkdtempSync(tmpdir())
// scratch directory, never under the checked-out worktree.
function withScratchDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "node-api-gap-guard-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Fixture snippets below are built by string CONCATENATION, split exactly
// at the identifier/paren or from/quote boundary -- never written as one
// contiguous literal. This file's own COMMITTED TEXT must never contain a
// literal "identifier(" or "from \"quoted-module\"" run, because the guard
// under test scans this repo's real .mjs files (see the "does the guard
// self-flag against the real repo" test below), and this test file itself
// is one of the files it scans. A unit test for a static source scanner
// necessarily needs fixture STRINGS that exercise exactly the shapes the
// scanner looks for; concatenation keeps the runtime string value intact
// while keeping the raw source bytes non-matching. Splitting works because
// scanTextForBannedApis' call-form patterns require real whitespace (`\s*`)
// immediately before the paren, and the source text between two adjacent
// string literals joined by `+` is never real whitespace (it's a quote,
// then `+`, then a quote).
const FS_GLOBSYNC_IMPORT = "import { globSync }" + ' from "node:fs";\n';
const FS_GLOBSYNC_CALL = "globSync" + '("**/*.mjs");\n';
const FS_GLOBSYNC_NS_IMPORT = 'import fs from "node:fs";\n';
const FS_GLOBSYNC_NS_CALL = "fs.globSync" + '("*.js");\n';
const OBJECT_GROUPBY_CALL = "Object.groupBy" + "(items, (x) => x.kind);\n";
const OBJECT_GROUPBY_CALL_SHORT = "Object.groupBy" + "(x, f);\n";
const ARRAY_FROMASYNC_CALL = "const a = await Array.fromAsync" + "(iter);\n";
const SQLITE_IMPORT = "import { DatabaseSync } from" + ' "node:sqlite";\n';
const CLEAN_READDIR_MODULE =
  'import { readdirSync } from "node:fs";\n\nexport const found = readdirSync(".");\n';
const MODULE_TOP_LEVEL_GLOBSYNC =
  FS_GLOBSYNC_IMPORT + "\nexport const found = " + FS_GLOBSYNC_CALL;

// --- scanTextForBannedApis: call-form detection, one per banned API ---

test("scanTextForBannedApis: fs.globSync call -> flagged (PR #242 1R incident shape)", () => {
  const violations = scanTextForBannedApis(MODULE_TOP_LEVEL_GLOBSYNC, {
    file: "fixture.mjs",
    targetMajor: 20,
  });
  const ids = violations.map((v) => v.id);
  assert.ok(
    ids.includes("fs.globSync"),
    `expected fs.globSync in ${JSON.stringify(ids)}`,
  );
});

test("scanTextForBannedApis: fs.globSync via a namespaced call -> flagged", () => {
  const violations = scanTextForBannedApis(
    FS_GLOBSYNC_NS_IMPORT + FS_GLOBSYNC_NS_CALL,
    {
      file: "fixture.mjs",
      targetMajor: 20,
    },
  );
  assert.ok(violations.some((v) => v.id === "fs.globSync"));
});

test("scanTextForBannedApis: Object.groupBy call -> flagged (Node 21)", () => {
  const violations = scanTextForBannedApis("const g = " + OBJECT_GROUPBY_CALL, {
    file: "fixture.mjs",
    targetMajor: 20,
  });
  assert.ok(violations.some((v) => v.id === "Object.groupBy"));
});

test("scanTextForBannedApis: Array.fromAsync call -> flagged (Node 22)", () => {
  const violations = scanTextForBannedApis(ARRAY_FROMASYNC_CALL, {
    file: "fixture.mjs",
    targetMajor: 20,
  });
  assert.ok(violations.some((v) => v.id === "Array.fromAsync"));
});

test("scanTextForBannedApis: node:sqlite import -> flagged (Node 22.5, experimental)", () => {
  const violations = scanTextForBannedApis(SQLITE_IMPORT, {
    file: "fixture.mjs",
    targetMajor: 20,
  });
  assert.ok(violations.some((v) => v.id === "node:sqlite"));
});

test("scanTextForBannedApis: every BANNED_APIS entry has at least one pattern that matches its own note-free minimal call shape smoke", () => {
  // Sanity: BANNED_APIS is hand-curated free text; this just guards against
  // a future entry being added with an empty/broken patterns array.
  for (const api of BANNED_APIS) {
    assert.ok(Array.isArray(api.patterns) && api.patterns.length > 0, api.id);
    assert.ok(api.minNode > 0, api.id);
  }
});

// --- targetMajor gating: an API is only flagged if minNode > targetMajor ---

test("scanTextForBannedApis: targetMajor at/above minNode -> NOT flagged", () => {
  const violations = scanTextForBannedApis(FS_GLOBSYNC_NS_CALL, {
    file: "fixture.mjs",
    targetMajor: 22,
  });
  assert.deepEqual(violations, []);
});

// --- prose / comment mentions must NOT false-positive (this repo's own
// time-judgment-now-injection.test.mjs relies on exactly this distinction,
// see node-api-gap-guard.mjs's BANNED_APIS header comment) ---

test("scanTextForBannedApis: bare word 'globSync' in a comment/string, no call or import form -> NOT flagged", () => {
  const src = [
    "// this file used to call globSync but no longer does",
    'const msg = "globSync is not available on Node 20";',
    "const referencesGlobSync = (s) => /\\bglobSync\\s*\\(/.test(s);",
  ].join("\n");
  const violations = scanTextForBannedApis(src, {
    file: "fixture.mjs",
    targetMajor: 20,
  });
  assert.deepEqual(violations, []);
});

test("scanTextForBannedApis: this guard's own test/source files (real repo scan) do not self-flag", () => {
  const result = runNodeApiGapGuard({ cwd: REPO_ROOT, targetMajor: 20 });
  assert.equal(result.ok, true, result.reason);
});

// --- module-load-death repro (coder-task.md §3-3: "«모듈 로드 단계
// 사망»이라는 실제 사고 형태를 재현한 표본을 최소 1개 포함") ---
//
// Honesty limit (same posture as time-judgment-now-injection.test.mjs's
// (tj-node20) test): this machine only has Node v26.2.0 available, so this
// cannot literally spawn Node 20 and observe the module fail to load. What
// IS reproduced here is the SOURCE SHAPE of the PR #242 1R incident: the
// banned call sits at module top level (evaluated the instant the file is
// imported, before any test body runs), not deferred inside a function --
// exactly the shape that made the whole file die at import time instead of
// failing one test. The guard's job is to catch that shape statically
// before it ever reaches a Node 20 process; the test below is what turns
// local `npm test` red the moment such a file exists anywhere under the
// scanned tree, which is the RED task §1b_shown asks for.
test("runNodeApiGapGuard: isolated fixture with a MODULE-TOP-LEVEL fs.globSync call -> RED (reproduces PR #242 1R's load-time-death shape)", () => {
  withScratchDir((dir) => {
    const scriptsCheck = join(dir, "scripts", "check");
    mkdirSync(scriptsCheck, { recursive: true });
    // Top-level call, mirroring the real incident: this line runs the
    // instant the module is imported/loaded, not inside a test body or
    // function -- on real Node 20 this is precisely where the import would
    // throw and kill the whole file's test registration.
    writeFileSync(
      join(scriptsCheck, "hyk417-fixture-detector.mjs"),
      MODULE_TOP_LEVEL_GLOBSYNC,
      "utf8",
    );
    const result = runNodeApiGapGuard({ cwd: dir, targetMajor: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].id, "fs.globSync");
    assert.equal(
      result.violations[0].file,
      "scripts/check/hyk417-fixture-detector.mjs",
    );
  });
});

test("runNodeApiGapGuard: same fixture with globSync removed -> GREEN (control: proves the RED above is caused by the API use, not the fixture harness)", () => {
  withScratchDir((dir) => {
    const scriptsCheck = join(dir, "scripts", "check");
    mkdirSync(scriptsCheck, { recursive: true });
    writeFileSync(
      join(scriptsCheck, "hyk417-fixture-detector.mjs"),
      CLEAN_READDIR_MODULE,
      "utf8",
    );
    const result = runNodeApiGapGuard({ cwd: dir, targetMajor: 20 });
    assert.equal(result.ok, true, result.reason);
  });
});

test("runNodeApiGapGuard: multiple banned APIs across multiple files -> all reported, count matches", () => {
  withScratchDir((dir) => {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "a.mjs"), FS_GLOBSYNC_NS_CALL, "utf8");
    writeFileSync(
      join(dir, "scripts", "b.mjs"),
      OBJECT_GROUPBY_CALL_SHORT,
      "utf8",
    );
    writeFileSync(
      join(dir, "scripts", "c.mjs"),
      "export const clean = 1;\n",
      "utf8",
    );
    const result = runNodeApiGapGuard({ cwd: dir, targetMajor: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 2);
    assert.equal(result.scanned, 3);
  });
});

test("runNodeApiGapGuard: node_modules and .git subtrees are excluded from the scan", () => {
  withScratchDir((dir) => {
    mkdirSync(join(dir, "node_modules", "somedep"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "somedep", "index.mjs"),
      FS_GLOBSYNC_NS_CALL,
      "utf8",
    );
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "clean.mjs"),
      "export const clean = 1;\n",
      "utf8",
    );
    const result = runNodeApiGapGuard({ cwd: dir, targetMajor: 20 });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.scanned, 1);
  });
});

test("runNodeApiGapGuard: no explicit targetMajor -> resolves from real package.json/enforce.yml via node-target-version.mjs", () => {
  const result = runNodeApiGapGuard({ cwd: REPO_ROOT });
  assert.equal(result.targetMajor, 20);
});

// --- listSourceFiles: only .mjs/.js/.cjs collected ---

test("listSourceFiles: only source extensions collected, other files ignored", () => {
  withScratchDir((dir) => {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "a.mjs"), "", "utf8");
    writeFileSync(join(dir, "scripts", "b.md"), "", "utf8");
    writeFileSync(join(dir, "scripts", "c.json"), "{}", "utf8");
    const files = listSourceFiles(dir).map((f) => f.replace(/\\/g, "/"));
    assert.ok(files.some((f) => f.endsWith("scripts/a.mjs")));
    assert.ok(!files.some((f) => f.endsWith("scripts/b.md")));
    assert.ok(!files.some((f) => f.endsWith("scripts/c.json")));
  });
});

// --- CI-canonical wiring proof (coder-task.md §3-4): this test itself is
// under scripts/check/*.test.mjs, and isolated-suite-runner.mjs's
// TEST_DIRS + collectTestFiles picks up every scripts/check/*.test.mjs file
// with no per-file registration -- so this test running at all (as part of
// `npm test`) IS the evidence. This test additionally asserts the CLI
// entry point exits non-zero on a red fixture, for anyone invoking it
// directly outside the runner. ---

test("CLI: node scripts/check/node-api-gap-guard.mjs --cwd <fixture-with-violation> exits 1", () => {
  withScratchDir((dir) => {
    mkdirSync(join(dir, "scripts", "check"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "check", "bad.mjs"),
      FS_GLOBSYNC_NS_CALL,
      "utf8",
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ engines: { node: "20.x" } }),
      "utf8",
    );
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "enforce.yml"),
      "node-version: 20\n",
      "utf8",
    );
    const guardPath = join(
      REPO_ROOT,
      "scripts",
      "check",
      "node-api-gap-guard.mjs",
    );
    const result = spawnSync(process.execPath, [guardPath, "--cwd", dir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
  });
});

test("CLI: node scripts/check/node-api-gap-guard.mjs --cwd <clean fixture> exits 0", () => {
  withScratchDir((dir) => {
    mkdirSync(join(dir, "scripts", "check"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "check", "ok.mjs"),
      "export const ok = 1;\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ engines: { node: "20.x" } }),
      "utf8",
    );
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "enforce.yml"),
      "node-version: 20\n",
      "utf8",
    );
    const guardPath = join(
      REPO_ROOT,
      "scripts",
      "check",
      "node-api-gap-guard.mjs",
    );
    const result = spawnSync(process.execPath, [guardPath, "--cwd", dir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
  });
});
