// installer-mismatch-report.test.mjs -- HYK-209-installer-mismatch-report-1 ⓑ (축 B).
//
// Proves the installer's stale-file report on a SYNTHETIC target (a fresh
// `git init` folder under the OS temp dir -- never the real repo, never a
// worktree of it). The production entry is exercised as a subprocess:
// `node templates/harness-init/install.mjs ...`, i.e. main(), not a copy of the
// report logic (grep-verified in the result file: no report helper is redefined
// in this file).
//
// Three buckets are pinned per file, by name, not by count:
//   installed                       -> the file was absent and got written
//   skipped (=) and NOT differing    -> the file exists and is byte-identical
//   differing (!)                   -> the file exists and DIFFERS; NOT overwritten
// The report must be the same on --dry-run and on a real run, and a real run
// must leave the differing file's sha256 unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALL_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);

const DIFFER_RAW = path.join("scripts", "check", "review-gate.mjs");
const SAME_RAW = path.join("scripts", "check", "relay-handshake.mjs");
const MISSING_RAW = path.join("scripts", "check", "time-authority.mjs");
const DIFFER_TPL = path.join(".harness", "STATUS.md");
const SAME_TPL = path.join(".harness", "gate-criteria.md");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Builds the synthetic target: a git repo with a stale copy of one raw file, a
// byte-identical copy of another, a stale template, a byte-identical template,
// and leaves one listed file absent.
function seedTarget(dir) {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  const put = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body, "utf8");
  };
  put(DIFFER_RAW, "// stale local copy -- differs from the source\n");
  mkdirSync(path.dirname(path.join(dir, SAME_RAW)), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, SAME_RAW), path.join(dir, SAME_RAW));
  put(DIFFER_TPL, "stale status\n");
  mkdirSync(path.dirname(path.join(dir, SAME_TPL)), { recursive: true });
  copyFileSync(
    path.join(
      REPO_ROOT,
      "templates",
      "harness-init",
      "gate-criteria.template.md",
    ),
    path.join(dir, SAME_TPL),
  );
}

function runInstaller(targetDir, { dryRun }) {
  const args = [
    INSTALL_PATH,
    "--profile",
    "solo-full",
    "--repo-path",
    targetDir,
    "--control-room-path",
    path.join(targetDir, "control-room"),
    "--github-repo",
    "owner/repo",
    "--bot-account",
    "bot",
    "--verify-cmd",
    "true",
    "--notify-dir",
    path.join(targetDir, "control-room", "notify"),
    "--approver-login",
    "approver",
    "--approver-id",
    "1",
    "--workspaces-root",
    path.join(targetDir, "workspaces"),
    "--main-repo-path",
    path.join(targetDir, "main-repo"),
  ];
  if (dryRun) args.push("--dry-run");
  const res = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);
  return res.stdout ?? "";
}

// Reads the "  <marker> path" lines under one summary header
// (marker: + installed, = skipped, ! differing).
function listUnder(stdout, header) {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(header));
  assert.ok(at >= 0, `summary header not found: ${header}`);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("  ")) break;
    out.push(line.replace(/^ {2}\S /, "").trim());
  }
  return out.map((p) => path.resolve(p));
}

const HDR_INSTALLED = "installed (";
const HDR_SKIPPED = "skipped, already existed (";
const HDR_DIFFERING = "있지만 내용이 다름 — 갱신하지 않음 (";

test("축 B: differing / identical / absent files land in the three named buckets", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-mismatch-report-"));
  try {
    seedTarget(dir);
    const out = runInstaller(dir, { dryRun: true });
    const installed = listUnder(out, HDR_INSTALLED);
    const skipped = listUnder(out, HDR_SKIPPED);
    const differing = listUnder(out, HDR_DIFFERING);

    const abs = (rel) => path.resolve(dir, rel);
    assert.deepEqual(
      [...differing].sort(),
      [abs(DIFFER_RAW), abs(DIFFER_TPL)].sort(),
      "exactly the two stale files are differing",
    );
    assert.ok(
      skipped.includes(abs(SAME_RAW)),
      "identical raw file is still a skip",
    );
    assert.ok(
      skipped.includes(abs(SAME_TPL)),
      "identical template is still a skip",
    );
    assert.ok(
      !differing.includes(abs(SAME_RAW)),
      "identical raw file must NOT be reported differing",
    );
    assert.ok(
      !differing.includes(abs(SAME_TPL)),
      "identical template must NOT be reported differing",
    );
    assert.ok(
      installed.includes(abs(MISSING_RAW)),
      "absent listed file is installed, not skipped",
    );
    assert.ok(
      !skipped.includes(abs(MISSING_RAW)),
      "absent file must not be counted as skipped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("축 B: a real run does not overwrite a differing file, and reports the same differing list as dry-run", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-mismatch-report-"));
  try {
    seedTarget(dir);
    const dryDiffering = listUnder(
      runInstaller(dir, { dryRun: true }),
      HDR_DIFFERING,
    );
    const beforeRaw = sha256(path.join(dir, DIFFER_RAW));
    const beforeTpl = sha256(path.join(dir, DIFFER_TPL));

    const realOut = runInstaller(dir, { dryRun: false });

    assert.equal(
      sha256(path.join(dir, DIFFER_RAW)),
      beforeRaw,
      "differing raw file must be byte-identical after a real run",
    );
    assert.equal(
      sha256(path.join(dir, DIFFER_TPL)),
      beforeTpl,
      "differing template must be byte-identical after a real run",
    );
    assert.deepEqual(
      listUnder(realOut, HDR_DIFFERING),
      dryDiffering,
      "real run and dry-run must report the same differing set",
    );
    assert.ok(
      existsSync(path.join(dir, MISSING_RAW)),
      "the absent file is installed by the real run",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
