import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runNulByteGuard } from "./nul-byte-guard.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function withFixtureRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nul-byte-guard-test-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "a@a"]);
    git(dir, ["config", "user.name", "a"]);
    writeFileSync(join(dir, "base.mjs"), "export const base = 1;\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "base"]);
    const baseSha = git(dir, ["rev-parse", "HEAD"]);
    fn(dir, baseSha);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withNul(...parts) {
  return Buffer.concat(
    parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, "utf8"))),
  );
}
const NUL = Buffer.from([0x00]);

// --- files-input entry (denominator measurement + direct unit tests) ---

test("runNulByteGuard: files entry with a clean file -> ok, scanned count reported", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["a.mjs", "b.md"],
    readFileBytes: () => Buffer.from("clean\n", "utf8"),
  });
  assert.equal(result.ok, true);
  assert.match(result.reason, /2 file\(s\) scanned/);
  assert.deepEqual(result.violations, []);
});

test("runNulByteGuard: NUL byte at the very start of the file -> BLOCKED", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["start.mjs"],
    readFileBytes: () => withNul(NUL, "export const a = 1;\n"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].count, 1);
  assert.equal(result.violations[0].firstOffset, 0);
});

test("runNulByteGuard: NUL byte in the middle of the file -> BLOCKED", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["mid.mjs"],
    readFileBytes: () => withNul("export const a", NUL, " = 1;\n"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].count, 1);
  assert.equal(result.violations[0].firstOffset, 14);
});

test("runNulByteGuard: NUL byte at the very end of the file -> BLOCKED", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["end.mjs"],
    readFileBytes: () => withNul("export const a = 1;\n", NUL),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].count, 1);
});

test("runNulByteGuard: exactly one NUL byte -> still BLOCKED (not a >1 threshold)", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["one.mjs"],
    readFileBytes: () => withNul("a", NUL, "b"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].count, 1);
});

test("runNulByteGuard: reports per-file count and firstOffset for multiple NULs", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["multi.mjs"],
    readFileBytes: () =>
      withNul("aa", NUL, "bb", NUL, "cc", NUL, "dd", NUL, "ee", NUL),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].count, 5);
  assert.equal(result.violations[0].firstOffset, 2);
});

// --- extension coverage ---

test("runNulByteGuard: NUL in .md/.json/extensionless-hooks files -> all BLOCKED (broad extension coverage)", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["README.md", "config.json", "hooks/pre-commit"],
    readFileBytes: () => withNul("x", NUL, "y"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 3);
});

test("runNulByteGuard: allowlist-excluded binary extension (.png) with real NUL bytes -> NOT scanned, ok:true", () => {
  const called = [];
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["logo.png"],
    readFileBytes: (cwd, f) => {
      called.push(f);
      return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(called, [], "out-of-allowlist file must never be read");
});

test("runNulByteGuard: hooks/ subdirectory extensionless file is out of scope (guard only covers hooks/<name>, not hooks/sub/<name>)", () => {
  const called = [];
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["hooks/sub/thing"],
    readFileBytes: (cwd, f) => {
      called.push(f);
      return withNul(NUL);
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(called, []);
});

// --- narrowing checks: must NOT false-positive on legitimate content ---

test("runNulByteGuard: UTF-8 Korean and emoji content -> ok (no false positive)", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["ko.md"],
    readFileBytes: () =>
      Buffer.from("# 한글 제목입니다 🎉🚀\n한글 본문 텍스트\n", "utf8"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("runNulByteGuard: CRLF line endings -> ok (no false positive)", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["crlf.txt"],
    readFileBytes: () =>
      Buffer.from("line one\r\nline two\r\nline three\r\n", "utf8"),
  });
  assert.equal(result.ok, true);
});

test("runNulByteGuard: UTF-8 BOM prefix -> ok (no false positive)", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["bom.txt"],
    readFileBytes: () =>
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("hello\n", "utf8"),
      ]),
  });
  assert.equal(result.ok, true);
});

test('runNulByteGuard: literal escape text "\\u0000" (backslash-u-0-0-0-0 characters, not a real byte) -> ok (no false positive)', () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["escaped.js"],
    readFileBytes: () => Buffer.from('const s = "\\u0000";\n', "utf8"),
  });
  assert.equal(result.ok, true);
});

// --- fail-closed on read errors ---

test("runNulByteGuard: readFileBytes throws -> fail-closed, not a silent pass", () => {
  const result = runNulByteGuard({
    cwd: "/nonexistent",
    files: ["broken.mjs"],
    readFileBytes: () => {
      throw new Error("synthetic read failure");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fail-closed/);
});

// --- mode resolution (reuses quality-check's resolveChangedFiles) ---

test("runNulByteGuard: mode staged resolves via git diff --cached, scans only staged files (Case C: index and working tree identical, clean)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "clean.mjs"), "export const ok = 1;\n", "utf8");
    git(dir, ["add", "clean.mjs"]);
    const result = runNulByteGuard({ cwd: dir, mode: "staged" });
    assert.equal(result.ok, true);
    assert.match(result.reason, /1 file\(s\) scanned/);
  });
});

test("runNulByteGuard: mode staged detects a real staged NUL byte via the index blob (end-to-end, no injected readBlobBytes; index and working tree both have the NUL)", () => {
  withFixtureRepo((dir) => {
    const buf = Buffer.concat([
      Buffer.from("export const withNul = 1;\n// marker ", "utf8"),
      Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from("\nexport const after = 2;\n", "utf8"),
    ]);
    writeFileSync(join(dir, "hasnul.mjs"), buf);
    git(dir, ["add", "hasnul.mjs"]);
    const result = runNulByteGuard({ cwd: dir, mode: "staged" });
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].file, "hasnul.mjs");
    assert.equal(result.violations[0].count, 5);
  });
});

// --- 2R regression (HYK-183 §11, REVIEW P1): mode:staged/ci must read the
// git object (index blob / HEAD blob), never the working-tree filesystem --
// otherwise a working tree that has drifted from what's staged/committed
// makes the gate judge bytes that will never actually be committed. ---

test("runNulByteGuard: Case A (P1 exact repro) -- NUL staged in the index, working tree overwritten clean -> staged mode still BLOCKS (index blob is authoritative, not the currently-visible file)", () => {
  withFixtureRepo((dir) => {
    const buf = Buffer.concat([
      Buffer.from("export const a = 1;\n", "utf8"),
      Buffer.from([0x00, 0x00, 0x00]),
    ]);
    writeFileSync(join(dir, "local-block.mjs"), buf);
    git(dir, ["add", "local-block.mjs"]);
    // Overwrite the working tree with clean content AFTER staging -- the
    // index still holds the NUL-containing blob. Pre-fix, this made the
    // gate read the now-clean working-tree file and wrongly pass.
    writeFileSync(
      join(dir, "local-block.mjs"),
      "export const a = 1;\n",
      "utf8",
    );
    const result = runNulByteGuard({ cwd: dir, mode: "staged" });
    assert.equal(
      result.ok,
      false,
      "the index blob (what would actually be committed) still has the NUL bytes",
    );
    assert.equal(result.violations[0].file, "local-block.mjs");
    assert.equal(result.violations[0].count, 3);
  });
});

test("runNulByteGuard: Case B -- NUL only in an unstaged working-tree edit on top of a clean staged blob -> staged mode PASSES (no false block on bytes that would not be committed)", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "caseb.mjs"), "export const b = 1;\n", "utf8");
    git(dir, ["add", "caseb.mjs"]);
    // Dirty the working tree further WITHOUT re-staging -- the index still
    // holds the clean blob that was `git add`-ed above.
    const buf = Buffer.concat([
      Buffer.from("export const b = 1;\n", "utf8"),
      Buffer.from([0x00, 0x00]),
    ]);
    writeFileSync(join(dir, "caseb.mjs"), buf);
    const result = runNulByteGuard({ cwd: dir, mode: "staged" });
    assert.equal(
      result.ok,
      true,
      "the staged (index) blob is clean -- an unstaged edit must not block a commit that would not include it",
    );
  });
});

test("runNulByteGuard: mode ci reads the HEAD blob, not a dirty working tree (same authoritative-source fix, CI side)", () => {
  withFixtureRepo((dir, baseSha) => {
    const buf = Buffer.concat([
      Buffer.from("export const c = 1;\n", "utf8"),
      Buffer.from([0x00]),
    ]);
    writeFileSync(join(dir, "ci-block.mjs"), buf);
    git(dir, ["add", "ci-block.mjs"]);
    git(dir, ["commit", "-q", "-m", "add ci-block.mjs with a NUL"]);
    // Overwrite the working tree with clean content AFTER the commit --
    // HEAD still points at the NUL-containing blob.
    writeFileSync(join(dir, "ci-block.mjs"), "export const c = 1;\n", "utf8");
    const result = runNulByteGuard({ cwd: dir, mode: "ci", baseSha });
    assert.equal(
      result.ok,
      false,
      "the committed HEAD blob still has the NUL bytes, regardless of the dirty working tree",
    );
    assert.equal(result.violations[0].file, "ci-block.mjs");
    assert.equal(result.violations[0].count, 1);
  });
});

test("runNulByteGuard: mode ci with missing base SHA -> fail-closed (inherits resolveChangedFiles posture)", () => {
  withFixtureRepo((dir) => {
    const result = runNulByteGuard({
      cwd: dir,
      mode: "ci",
      baseSha: undefined,
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /fail-closed/);
  });
});

test("runNulByteGuard: deleted file in the changed set is excluded (nothing left to scan)", () => {
  withFixtureRepo((dir) => {
    git(dir, ["rm", "-q", "base.mjs"]);
    const result = runNulByteGuard({ cwd: dir, mode: "staged" });
    assert.equal(result.ok, true);
    assert.match(result.reason, /0 file\(s\) scanned/);
  });
});

test("runNulByteGuard: out-of-scope extension (.png) in the changed set -> not scanned, ok:true", () => {
  withFixtureRepo((dir) => {
    writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    git(dir, ["add", "logo.png"]);
    const result = runNulByteGuard({ cwd: dir, mode: "staged" });
    assert.equal(result.ok, true);
    assert.match(result.reason, /0 file\(s\) scanned/);
  });
});
