// install-net-closure.test.mjs -- HYK-209-install-closure-1 §2 ⓑ.
//
// install-copylist-closure.test.mjs's own header already names its limit:
// its RELATIVE_IMPORT_RE walk only sees a static `import`/`export ... from`
// specifier. It is blind to a RUNTIME reference -- a `spawnSync`/
// `execFileSync` call that names a sibling file by path, or a module-top-
// level `readFileSync` of a fixture -- which is exactly the shape this
// round's own real measurement found still broken on a freshly-installed
// target (coder.md §2 ⓑ 표, 〔직접〕 실측): scripts/check/
// seat-proof-wrapper-canonical.json, scripts/check/hyk400-receiver-probe-
// runner.mjs + its scripts/check/fixtures/hyk400-*.mjs.txt siblings,
// scripts/check/reject-streak-defect-sample.json, docs/enforcement-v1.md,
// and scripts/check/abort-record-writer.mjs (spawned by relay-handshake.mjs,
// degrades silently rather than crashing -- see install.mjs's own
// ENFORCEMENT_CHECK_FILES comment on it).
//
// This file is the machine-checked net for that whole class of gap: real
// installer (not --dry-run) -> real `git init` target outside this
// worktree -> commit the installed tree (so self-checks that compare disk
// against `git show HEAD:...`, e.g. relay-handshake.test.mjs, see a
// consistent repo, not "staged but uncommitted") -> actually RUN every
// installed `.test.mjs` file there via `node --test`, one file at a time
// (simpler, unambiguous per-file attribution than parsing one combined TAP
// stream for which file a given `not ok` belongs to).
//
// 완결(실행까지 vs 로드만) 선택 근거 〔직접〕: 로드(import)만 보면 이
// 라운드가 찾은 실제 결함의 절반을 못 잡는다 -- hyk400-receiver-probe-
// runner.mjs/각 fixture는 정적 import가 아니라 "테스트 바디 안의
// spawnSync/copyFileSync 호출"에서만 참조되므로, 그 테스트가 실제로
// *실행*돼야 ENOENT가 드러난다(실측: import()만으로는 이 파일들이 전부
// 조용히 통과한다). 러너 시간: 파일마다 별도 `node --test` 프로세스를 띄워
// (약 46개) 매 실행에 수십~수백 ms의 시작 비용이 더 붙지만, 한 번에
// 합쳐 돌리는 쪽은 "어느 파일이 실패했는가"를 TAP 중첩 구조에서 다시
// 파싱해야 해서 더 깨지기 쉽다(이 라운드가 손으로 그 파싱을 하다가 실제로
// 겪은 혼란 -- coder.md 참조) -- 단순함을 시간보다 우선했다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS } from "./install.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INSTALLER_PATH = path.join(
  REPO_ROOT,
  "templates",
  "harness-init",
  "install.mjs",
);

// Same shape install-g1-adapter-list.test.mjs's own installerArgsFor uses
// (ⓒ above: "로직을 새로 발명하지 않는다") -- duplicated, not imported
// (this repo's own convention, see e.g. runner-receipt-writer.mjs's header
// on why consumer/producer modules stay un-coupled by import).
function installerArgsFor(base, targetRepoPath) {
  return [
    "--profile",
    "solo-full",
    "--repo-path",
    targetRepoPath,
    "--control-room-path",
    path.join(base, "fake-control-room"),
    "--github-repo",
    "someorg/somerepo",
    "--bot-account",
    "bot-x",
    "--verify-cmd",
    "npm test",
    "--notify-dir",
    path.join(base, "notify"),
    "--approver-login",
    "approver-x",
    "--approver-id",
    "1",
    "--workspaces-root",
    path.join(base, "workspaces"),
    "--main-repo-path",
    path.join(base, "main-repo"),
  ];
}

// HYK-209 §2 ⓑ 실측: a plain `mkdtempSync(path.join(tmpdir(), ...))` can
// come back under Windows' 8.3 short-name form (this machine, live:
// `tmpdir()` itself returned `C:\Users\ADMINI~1\...`), which then makes
// quality-check.test.mjs's own CLI-invocation path construction (a `file://
// URL -> .pathname` conversion somewhere in that test, undecoded) turn the
// literal "~" into "%7E" and MODULE_NOT_FOUND -- the exact same class of
// gap isolated-suite-runner.mjs's own longFormTmpdir() already exists to
// avoid (see that file's header). Resolving to the real (long) form before
// using it avoids tripping that PRE-EXISTING, unrelated test-harness quirk
// -- this round's own product_scope does not include quality-check.mjs/
// .test.mjs, so this round doesn't fix that quirk, it just doesn't let an
// unrelated artifact of THIS test's own temp-dir choice masquerade as an
// install-list gap.
function longFormTmpdir() {
  try {
    return realpathSync.native(tmpdir());
  } catch {
    return tmpdir();
  }
}

function makeSyntheticTarget(prefix) {
  const base = mkdtempSync(path.join(longFormTmpdir(), prefix));
  const targetRepo = path.join(base, "target-repo");
  mkdirSync(targetRepo, { recursive: true });
  execFileSync("git", ["-C", targetRepo, "init", "-q"]);
  execFileSync("git", ["-C", targetRepo, "config", "user.email", "t@t.com"]);
  execFileSync("git", ["-C", targetRepo, "config", "user.name", "t"]);
  return { base, targetRepo };
}

function runRealInstall(base, targetRepoPath) {
  return execFileSync(
    "node",
    [INSTALLER_PATH, ...installerArgsFor(base, targetRepoPath)],
    { encoding: "utf8" },
  );
}

// HYK-209 §2 ⓑ 실측: relay-handshake.test.mjs's own module-top-level logic
// does `git show HEAD:scripts/check/relay-handshake.mjs` and throws at
// import time if that fails ("exists on disk, but not in 'HEAD'") -- the
// installer only writes files, it never commits them (correctly: that is
// a human/CI decision, not this tool's). Without a commit here, that one
// file's failure would be indistinguishable from a real install-list gap.
// `--no-verify`: this target's own installed commit-msg/pre-commit hooks
// (review-gate.mjs etc.) are themselves designed to block an unreviewed
// commit -- this is a throwaway smoke-test tree, not a tracked project, so
// bypassing them here is the synthetic-fixture equivalent of "a human
// committed the bootstrap once by hand", not a real enforcement bypass.
function commitInstalledTree(targetRepoPath) {
  execFileSync("git", ["-C", targetRepoPath, "add", "-A"]);
  execFileSync("git", [
    "-C",
    targetRepoPath,
    "commit",
    "--no-verify",
    "-q",
    "-m",
    "synthetic: installed harness files (smoke-test fixture, not a real project)",
  ]);
}

// Same ambient-env stripping as install-g1-adapter-list.test.mjs's
// ledgerIsolatedEnv (duplicated, same non-coupling convention) -- both the
// admission-ledger env keys (a floating value from the invoking shell must
// not leak into the child) and NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID (this
// file is itself running under `node --test`; without stripping these, the
// installed target's own child `node --test` sees itself as a "recursive"
// call and silently skips running -- a false "0 failures" that is actually
// "0 tests ran at all").
function isolatedEnv() {
  const env = { ...process.env };
  delete env.ADMISSION_LEDGER_PATH;
  delete env.ADMISSION_LOCK_PATH;
  delete env.DISPATCH_RECEIPT_PATH;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}

// Non-recursive listing under each of the three installed script roots --
// mirrors isolated-suite-runner.mjs's own TEST_DIRS shape (scripts/check,
// scripts/relay, scripts/relay/adapters, scripts/supervisor) minus the
// adapters entry (this installer never copies scripts/relay/adapters/*,
// see INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS's own header) -- just the two
// directories this installer actually populates with `.test.mjs` files.
const INSTALLED_TEST_DIRS = ["scripts/check", "scripts/relay"];

function collectInstalledTestFiles(targetRepoPath) {
  const files = [];
  for (const dir of INSTALLED_TEST_DIRS) {
    const abs = path.join(targetRepoPath, ...dir.split("/"));
    let entries;
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of entries.filter((f) => f.endsWith(".test.mjs")).sort()) {
      if (statSync(path.join(abs, name)).isFile()) {
        files.push(`${dir}/${name}`);
      }
    }
  }
  return files;
}

// One `node --test` child per file -- unambiguous per-file pass/fail
// attribution (see this file's own header for why over one combined run).
function runOneInstalledTestFile(targetRepoPath, rel) {
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", rel], {
    cwd: targetRepoPath,
    encoding: "utf8",
    env: isolatedEnv(),
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

test("install-net-closure: every INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS entry names a file this installer actually ships (no stale exception for a file that was removed/renamed)", () => {
  for (const { file } of INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS) {
    assert.match(
      file,
      /^scripts\/(check|relay)\/[A-Za-z0-9._-]+\.test\.mjs$/,
      `exception entry '${file}' is not a scripts/check or scripts/relay .test.mjs path -- this test's own file collection would never find it`,
    );
  }
});

test("install-net-closure: real installer -> real git target -> every installed .test.mjs actually RUNS (not just imports) with 0 failures, except the named, reasoned exceptions", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-install-net-");
  try {
    runRealInstall(base, targetRepo);
    commitInstalledTree(targetRepo);
    const files = collectInstalledTestFiles(targetRepo);
    // Fail-closed (same posture as isolated-suite-runner.mjs's
    // collectTestFiles): if the installer's own output shape changes such
    // that nothing is found here, that is this test finding NOTHING to
    // check, not proof everything passed.
    assert.ok(
      files.length >= 40,
      `expected at least 40 installed .test.mjs files (sanity floor against a broken collection, got ${files.length}): ${files.join(", ")}`,
    );

    const exceptionReasons = new Map(
      INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS.map((e) => [e.file, e.reason]),
    );
    const unexpectedFailures = [];
    const exceptionsSeen = new Set();

    for (const rel of files) {
      const result = runOneInstalledTestFile(targetRepo, rel);
      assert.equal(
        result.error,
        undefined,
        `spawnSync itself failed running ${rel} -- error: ${result.error?.message}, signal: ${result.signal}, status: ${result.status}`,
      );
      const passed = result.status === 0;
      if (passed) continue;
      if (exceptionReasons.has(rel)) {
        exceptionsSeen.add(rel);
        continue;
      }
      unexpectedFailures.push({
        rel,
        tail: `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-1500),
      });
    }

    assert.deepEqual(
      unexpectedFailures.map((f) => f.rel),
      [],
      `installed test file(s) failed that are NOT in INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS -- either fix the install list (ⓑ 편입) or add a reasoned exception:\n${unexpectedFailures
        .map((f) => `--- ${f.rel} ---\n${f.tail}`)
        .join("\n\n")}`,
    );
    // Every exception is real/still-reproducing -- an exception that
    // stopped failing (e.g. once the adapters layer is eventually
    // assembled) should be REMOVED from the list, not left as a stale
    // skip that quietly stops meaning anything.
    assert.deepEqual(
      [...exceptionsSeen].sort(),
      INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS.map((e) => e.file)
        .slice()
        .sort(),
      "every INSTALL_NET_CLOSURE_KNOWN_EXCEPTIONS entry must still actually fail on a fresh install -- an entry that now passes is stale and should be deleted from the list, not kept as a no-op skip",
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-209 §2 ⓒ: installAdmissionLedgerPointer's lockPath must match the
// dispatch pipeline's own live convention (installer-lockpath-defect.md,
// 2026-08-12), not the `${ledgerPath}.lock` derivation that produced
// "...admission-ledger.json.lock" instead of "...admission-ledger.lock".
// ---------------------------------------------------------------------------
test("install-net-closure ⓒ: a real install's admission-ledger-path.json pointer names lockPath as a sibling 'admission-ledger.lock' file (not '<ledgerPath>.lock')", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-install-net-c-");
  try {
    runRealInstall(base, targetRepo);
    const pointerPath = path.join(
      targetRepo,
      ".harness",
      "admission-ledger-path.json",
    );
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8"));
    assert.equal(
      path.posix.basename(pointer.lockPath),
      "admission-ledger.lock",
      `expected lockPath's own filename to be exactly "admission-ledger.lock" (the dispatch-worker.ps1 convention), got: ${pointer.lockPath}`,
    );
    assert.equal(
      path.posix.dirname(pointer.lockPath),
      path.posix.dirname(pointer.ledgerPath),
      `expected lockPath and ledgerPath to live in the same control-room directory; lockPath=${pointer.lockPath} ledgerPath=${pointer.ledgerPath}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-209 §2 ⓓ: an "archive install" -- REPO_ROOT (this installer's own
// source location) is NOT a git checkout, the shape a tarball/zip
// extraction produces. Before this round: `git -C REPO_ROOT rev-parse HEAD`
// leaked its failing stderr ("fatal: not a git repository ...") straight to
// this process's own stderr, AND the update manifest's `installer` field
// silently became `null` -- indistinguishable from "never even tried".
// ---------------------------------------------------------------------------

// A non-git copy of just enough of this repo for install.mjs to run against
// a target with --update-mismatched (which is the only path that calls
// writeUpdateManifest at all). cpSync (no .git -- genuinely not a checkout).
function makeArchiveCopy(base) {
  const archiveDir = path.join(base, "archive-copy");
  mkdirSync(archiveDir, { recursive: true });
  for (const dir of ["templates", "scripts", "hooks"]) {
    cpSync(path.join(REPO_ROOT, dir), path.join(archiveDir, dir), {
      recursive: true,
    });
  }
  return path.join(archiveDir, "templates", "harness-init", "install.mjs");
}

test("install-net-closure ⓓ: an archive install (REPO_ROOT not a git checkout) leaks no 'fatal:' line to stderr, and the update manifest's installer field is a non-null, explicit '미상(...)' string", () => {
  const { base, targetRepo } = makeSyntheticTarget("hyk209-install-net-d-");
  try {
    // A real install first (so there is at least one installed file to
    // mismatch below -- writeUpdateManifest only runs on a real mismatch +
    // --update-mismatched).
    runRealInstall(base, targetRepo);
    const archiveInstallerPath = makeArchiveCopy(base);
    // Confirm the archive copy really is not a git checkout -- otherwise
    // this test would not be exercising the ⓓ code path at all.
    const probe = spawnSync(
      "git",
      ["-C", archiveInstallerPath, "rev-parse", "HEAD"],
      {
        encoding: "utf8",
      },
    );
    assert.notEqual(
      probe.status,
      0,
      "archive copy must NOT be a git checkout for this test to mean anything",
    );

    const mismatchedFile = path.join(
      targetRepo,
      "scripts",
      "check",
      "role-guard.mjs",
    );
    writeFileSync(
      mismatchedFile,
      readFileSync(mismatchedFile, "utf8") + "\n// deliberate mismatch\n",
      "utf8",
    );

    const result = spawnSync(
      "node",
      [
        archiveInstallerPath,
        ...installerArgsFor(base, targetRepo),
        "--update-mismatched",
      ],
      { encoding: "utf8" },
    );
    assert.equal(
      result.status,
      0,
      `archive install should still succeed; stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.ok(
      !(result.stderr ?? "").includes("fatal:"),
      `no raw 'fatal:' line should leak to stderr; got:\n${result.stderr}`,
    );

    const manifestFiles = readdirSync(path.join(targetRepo, ".harness")).filter(
      (f) => f.startsWith("install-update-") && f.endsWith(".json"),
    );
    assert.ok(
      manifestFiles.length >= 1,
      "expected at least one install-update-*.manifest.json to have been written",
    );
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          targetRepo,
          ".harness",
          manifestFiles[manifestFiles.length - 1],
        ),
        "utf8",
      ),
    );
    assert.notEqual(
      manifest.installer,
      null,
      "manifest.installer must not be null on an archive install",
    );
    assert.match(
      manifest.installer,
      /^미상\(/,
      `expected an explicit "미상(...)" string, got: ${JSON.stringify(manifest.installer)}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
