// HYK-186 3R P1-1 -- the reviewer's exact finding was that
// docs/harness-init.md claimed done-line-write-guard.mjs was installed as
// a second PreToolUse hook, but nothing in templates/harness-init/
// install.mjs ever referenced it (grep -c "done-line-write-guard"
// templates/harness-init/install.mjs was 0). ★"documentation says X" is
// not evidence X happens -- this suite never reads docs/harness-init.md at
// all; it inspects the INSTALLER'S OWN OUTPUT (a real `--dry-run` child
// process), so removing the wiring from install.mjs (not the docs) is what
// must turn these tests RED.
//
// ★Lives in scripts/check/ (NOT templates/harness-init/) deliberately:
// isolated-suite-runner.mjs's TEST_DIRS and .github/workflows/enforce.yml's
// canonical check command both enumerate only scripts/check, scripts/relay,
// scripts/relay/adapters, scripts/supervisor -- a test file placed under
// templates/harness-init/ would never run in CI or the isolated suite at
// all, silently reproducing exactly the "written but not wired" failure
// mode this task exists to close, one layer up (a RED test that itself
// never runs is indistinguishable from no test).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  cpSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL_PATH = join(
  HERE,
  "..",
  "..",
  "templates",
  "harness-init",
  "install.mjs",
);

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function initGitRepo(dir) {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-q",
      "-m",
      "base",
    ],
    { cwd: dir },
  );
}

// Runs a real `node <installerPath> --dry-run ...` child process (production
// entry point, not an imported helper -- install.mjs has no invokedDirectly
// guard, it always runs main() on load, so importing it would execute a
// real (if dry-run) install as a side effect of the import itself; spawning
// is the only way to drive it that mirrors how a human/CI actually invokes
// this file).
function runInstallerDryRun(installerPath, targetDir) {
  const res = spawnSync(
    process.execPath,
    [
      installerPath,
      "--profile",
      "solo-full",
      "--repo-path",
      targetDir,
      "--control-room-path",
      join(targetDir, "control-room"),
      "--github-repo",
      "owner/repo",
      "--bot-account",
      "bot",
      "--verify-cmd",
      "true",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

test("installer --dry-run wires done-line-write-guard.mjs as a second PreToolUse command (production output, not docs)", () => {
  withTempDir("hyk186-install-dryrun-", (dir) => {
    initGitRepo(dir);
    const res = runInstallerDryRun(INSTALL_PATH, dir);
    assert.equal(res.exit, 0, `installer must exit 0: ${res.stderr}`);
    assert.match(
      res.stdout,
      /"command": "node \\"\$CLAUDE_PROJECT_DIR\/scripts\/check\/role-guard\.mjs\\""/,
      "role-guard.mjs command must still be present (regression guard)",
    );
    assert.match(
      res.stdout,
      /"command": "node \\"\$CLAUDE_PROJECT_DIR\/scripts\/check\/done-line-write-guard\.mjs\\""/,
      "done-line-write-guard.mjs must appear as an actual hooks-block command in the dry-run's printed settings.local.json, not just in prose documentation",
    );
  });
});

test("installer --dry-run copies done-line-write-guard.mjs/.test.mjs and its scripts/relay/finalize-done.mjs redirect target", () => {
  withTempDir("hyk186-install-dryrun-", (dir) => {
    initGitRepo(dir);
    const res = runInstallerDryRun(INSTALL_PATH, dir);
    for (const rel of [
      "scripts.check.done-line-write-guard\\.mjs",
      "scripts.check.done-line-write-guard\\.test\\.mjs",
      "scripts.relay.finalize-done\\.mjs",
      "scripts.relay.finalize-done\\.test\\.mjs",
      // HYK-186 1R gap this round also closes: relay-handshake.mjs's own
      // transitive dependency, previously never copied either.
      "scripts.check.time-authority\\.mjs",
    ]) {
      assert.match(
        res.stdout,
        new RegExp(`would install: .*${rel}`),
        `installer must report installing ${rel}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// ★RED 변조 (필수): remove the wiring from a COPY of install.mjs, run the
// mutant's own --dry-run, confirm the command disappears. install.mjs
// itself is only ever copied, never edited in place.
// ---------------------------------------------------------------------------

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
}

test("mutation (필수): done-line-write-guard hook-command line removed from install.mjs -> dry-run output no longer wires it -> RED", () => {
  const src = readFileSync(INSTALL_PATH, "utf8");
  const target =
    '          {\n            type: "command",\n            command:\n              \'node "$CLAUDE_PROJECT_DIR/scripts/check/done-line-write-guard.mjs"\',\n          },\n';
  assertExactlyOneMatch(src, target, "done-line-write-guard hook command line");
  const mutated = src.replace(target, "");

  withTempDir("hyk186-install-mut-", (mutDir) => {
    // install.mjs reads its own sibling *.template.md/*.sh.template files
    // via TEMPLATES_DIR (= its own dirname) BEFORE it ever reaches the
    // hooks-block step -- copy the whole templates/harness-init/ directory
    // alongside the mutant so those reads succeed and execution actually
    // reaches installSettingsLocal(). REPO_ROOT (TEMPLATES_DIR/../..) ends
    // up pointing outside the real repo this way, so scripts/check/hooks
    // copies just warn-skip (copyRawFile never throws on a missing source)
    // -- harmless here since buildHooksBlock's JSON (what this test reads)
    // is a pure string template with no REPO_ROOT dependency at all.
    cpSync(dirname(INSTALL_PATH), mutDir, { recursive: true });
    const mutantInstallPath = join(mutDir, "install.mjs");
    writeFileSync(mutantInstallPath, mutated, "utf8");

    withTempDir("hyk186-install-mut-target-", (targetDir) => {
      initGitRepo(targetDir);
      const res = runInstallerDryRun(mutantInstallPath, targetDir);
      assert.equal(res.exit, 0);
      assert.doesNotMatch(
        res.stdout,
        /done-line-write-guard\.mjs/,
        "RED: with the hook-command line removed, the mutant installer's own dry-run output no longer wires done-line-write-guard.mjs at all -- reproduces the exact pre-fix gap (grep -c was 0)",
      );
    });
  });
});
