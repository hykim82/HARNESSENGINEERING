// installer-update-flag.test.mjs -- HYK-209-installer-update-flag-1.
//
// Proves --update-mismatched (상이 ∩ 틀 등록 교체) · the update manifest ·
// --rollback · the 6th cell 「갱신(병합)」 on SYNTHETIC targets only (a `git init`
// folder under the OS temp dir -- never the real repo, never a worktree of it,
// never the real admission ledger). Production entry is the subprocess
// `node templates/harness-init/install.mjs ...`.
//
// Every assertion is by NAME (absolute path -> cell or -> sha256), never by count
// alone. The flag-less run is pinned by sha256 of every pre-existing file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  accessSync,
  constants,
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

// 상이 ∩ 틀 등록 -- the one file the flag may replace (writeTemplateFile/copyRawFile).
const STALE_RAW = path.join("scripts", "check", "review-gate.mjs");
// 치환설치 (pm-guard) -- stale on purpose; the flag must NOT replace it.
const STALE_PM = path.join("scripts", "check", "pm-guard.mjs");
// hooks 키가 이미 있고 다른 것 -- 상이, must NOT be replaced.
const SETTINGS = path.join(".claude", "settings.local.json");
// gitignore 블록이 옛 템플릿 -- 상이, must NOT be replaced (append branch).
const GITIGNORE = ".gitignore";
// 설치기 목록 밖 값 파일 (the real repo tracks it here; the installer does not
// copy it, only concurrency-cap-adapter.mjs is listed) -- the flag must NOT touch
// it, and the report must place it in the 손이식 cell as 상이.
const CAP = path.join("scripts", "supervisor", "concurrency-cap.json");

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fixtureArgs(dir) {
  return [
    INSTALL_PATH,
    "--profile",
    "solo-full",
    "--repo-path",
    dir,
    "--control-room-path",
    path.join(dir, "control-room"),
    "--github-repo",
    "owner/repo",
    "--bot-account",
    "bot",
    "--verify-cmd",
    "true",
    "--notify-dir",
    path.join(dir, "control-room", "notify"),
    "--approver-login",
    "approver",
    "--approver-id",
    "1",
    "--workspaces-root",
    path.join(dir, "workspaces"),
    "--main-repo-path",
    path.join(dir, "main-repo"),
  ];
}

// Synthetic target: a git repo with one stale raw file, one stale pm-guard, a
// hooks-bearing settings file that differs, an old gitignore block, and a value
// file. The merge case (settings WITHOUT a hooks key) is built inside its own
// tests by rewriting SETTINGS.
function seedTarget(dir) {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  const put = (rel, body) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body, "utf8");
  };
  put(STALE_RAW, "// stale local copy -- differs from the source\n");
  put(
    STALE_PM,
    "// stale pm-guard -- differs from the substituted expectation\n",
  );
  put(SETTINGS, '{"permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[]}}\n');
  put(GITIGNORE, "# harness-init (solo-full)\nnode_modules/\n");
  put(CAP, '{"schema_version":"concurrency-cap/v1","global_hard_cap":3}\n');
  // Staged, so the out-of-list transplant scan sees it as tracked.
  execFileSync("git", ["-C", dir, "add", "--", CAP]);
}

// Runs the installer. Returns { status, stdout, stderr }. Never throws on a
// nonzero exit -- callers assert the exit they expect.
function runInstaller(dir, extra = []) {
  const res = spawnSync(process.execPath, [...fixtureArgs(dir), ...extra], {
    encoding: "utf8",
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// Lines (2-space indented) under one 다섯 칸 / 6th-cell header.
function sectionLines(stdout, header) {
  const lines = stdout.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(header));
  assert.ok(at >= 0, `section header not found: ${header}`);
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("  ")) break;
    out.push(line.slice(2));
  }
  return out;
}

// "<marker> <path> :: <detail>" -> "<path>" (the marker is optional).
const pathOf = (line) => line.split(" :: ")[0].replace(/^\S+ /, "");

// Update-manifest / backup names under <dir>/.harness (none if the dir is absent).
function updateFilesIn(dir) {
  const harness = path.join(dir, ".harness");
  if (!existsSync(harness)) return [];
  return readdirSync(harness).filter((f) => f.startsWith("install-update-"));
}

function freshTarget(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-update-flag-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedTarget(dir);
  return dir;
}

// Every pre-existing file's sha256 must be pinned before a run.
const PINNED = [STALE_RAW, STALE_PM, SETTINGS, GITIGNORE, CAP];
function pin(dir) {
  return Object.fromEntries(
    PINNED.map((rel) => [rel, sha256(path.join(dir, rel))]),
  );
}

test("flag-less run: differing files stay byte-identical and are reported 상이", (t) => {
  const dir = freshTarget(t);
  const before = pin(dir);
  const res = runInstaller(dir);
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);
  for (const rel of PINNED) {
    assert.equal(
      sha256(path.join(dir, rel)),
      before[rel],
      `flag-less must not touch ${rel}`,
    );
  }
  const differing = sectionLines(
    res.stdout,
    "있지만 내용이 다름 — 갱신하지 않음 (",
  ).map((l) => l.replace(/^! /, ""));
  assert.ok(
    differing.some((p) => path.resolve(p) === path.join(dir, STALE_RAW)),
    "stale raw file must be in the differing bucket",
  );
  assert.equal(
    existsSync(path.join(dir, ".harness", "install-backup")),
    false,
    "no backup without the flag",
  );
  assert.equal(
    updateFilesIn(dir).length,
    0,
    "no update manifest without the flag",
  );
  assert.ok(
    !res.stdout.includes("갱신 (--update-mismatched"),
    "no update section without the flag",
  );
});

test("--update-mismatched replaces ONLY 상이 ∩ 틀 등록 and leaves every other differing file alone", (t) => {
  const dir = freshTarget(t);
  const before = pin(dir);
  const res = runInstaller(dir, ["--update-mismatched"]);
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);

  // The one registered (틀 등록) differing raw file is now the source bytes.
  const source = readFileSync(path.join(REPO_ROOT, STALE_RAW));
  assert.ok(
    readFileSync(path.join(dir, STALE_RAW)).equals(source),
    "review-gate.mjs must become the source bytes",
  );
  assert.notEqual(sha256(path.join(dir, STALE_RAW)), before[STALE_RAW]);

  // Everything else in the 상이 bucket (치환설치 pm-guard, hooks settings, gitignore
  // append block) and the value file must be byte-identical.
  for (const rel of [STALE_PM, SETTINGS, GITIGNORE, CAP]) {
    assert.equal(
      sha256(path.join(dir, rel)),
      before[rel],
      `flag must not touch ${rel}`,
    );
  }

  // The update is reported by name in its own section, not under 상이.
  const updated = sectionLines(res.stdout, "갱신 (--update-mismatched").map(
    (l) => l.replace(/^↻ /, ""),
  );
  assert.ok(
    updated.some(
      (l) => path.resolve(l.split(" :: ")[0]) === path.join(dir, STALE_RAW),
    ),
    "replaced file must appear in the update section by name",
  );
  const differing = sectionLines(res.stdout, "상이 — 갱신하지 않음 (").map(
    (l) => path.resolve(pathOf(l)),
  );
  assert.ok(
    !differing.includes(path.join(dir, STALE_RAW)),
    "replaced file must not stay under 상이",
  );
  assert.ok(
    differing.includes(path.join(dir, SETTINGS)),
    "hooks-present settings stays under 상이",
  );
});

test("--update-mismatched writes a backup and a manifest with before/after sha256", (t) => {
  const dir = freshTarget(t);
  const before = sha256(path.join(dir, STALE_RAW));
  const res = runInstaller(dir, ["--update-mismatched"]);
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);
  const manifestName = updateFilesIn(dir).find((f) =>
    f.endsWith(".manifest.json"),
  );
  assert.ok(
    manifestName,
    "manifest must be written on a real run with a replacement",
  );
  const manifest = JSON.parse(
    readFileSync(path.join(dir, ".harness", manifestName), "utf8"),
  );
  assert.equal(manifest.schema, "installer-update-manifest/1");
  const entry = manifest.entries.find(
    (e) => path.resolve(e.path) === path.join(dir, STALE_RAW),
  );
  assert.ok(entry, "manifest must name the replaced file");
  assert.equal(
    entry.before_sha256,
    before,
    "manifest before-sha must be the pre-update bytes",
  );
  assert.equal(
    entry.after_sha256,
    sha256(path.join(dir, STALE_RAW)),
    "manifest after-sha must be the post-update bytes",
  );
  assert.equal(
    sha256(entry.backup),
    before,
    "backup must hold the pre-update bytes",
  );
});

test("--update-mismatched --dry-run: every file byte-identical, no backup, no manifest, same set", (t) => {
  const dir = freshTarget(t);
  const before = pin(dir);
  const dry = runInstaller(dir, ["--update-mismatched", "--dry-run"]);
  assert.equal(dry.status, 0, `dry-run must exit 0: ${dry.stderr}`);
  for (const rel of PINNED) {
    assert.equal(
      sha256(path.join(dir, rel)),
      before[rel],
      `dry-run must not touch ${rel}`,
    );
  }
  assert.equal(
    existsSync(path.join(dir, ".harness", "install-backup")),
    false,
    "dry-run writes no backup",
  );
  assert.equal(updateFilesIn(dir).length, 0, "dry-run writes no manifest");
  const dryPaths = sectionLines(dry.stdout, "갱신 (--update-mismatched").map(
    (l) => pathOf(l.replace(/^↻ /, "")),
  );
  assert.ok(
    dryPaths.some((p) => path.resolve(p) === path.join(dir, STALE_RAW)),
    "dry-run must name the file it would update",
  );
  assert.ok(
    dry.stdout.includes("dry-run: 바이트 불변"),
    "dry-run section must say bytes are unchanged",
  );
});

test("--rollback restores the pre-update bytes, and a second rollback is idempotent", (t) => {
  const dir = freshTarget(t);
  const before = sha256(path.join(dir, STALE_RAW));
  runInstaller(dir, ["--update-mismatched"]);
  const manifestPath = path.join(dir, ".harness", updateFilesIn(dir)[0]);

  const first = spawnSync(
    process.execPath,
    [INSTALL_PATH, "--rollback", manifestPath],
    { encoding: "utf8" },
  );
  assert.equal(
    first.status,
    0,
    `rollback must exit 0: ${first.stdout}${first.stderr}`,
  );
  assert.equal(
    sha256(path.join(dir, STALE_RAW)),
    before,
    "rollback must restore the pre-update sha256",
  );

  const second = spawnSync(
    process.execPath,
    [INSTALL_PATH, "--rollback", manifestPath],
    { encoding: "utf8" },
  );
  assert.equal(
    second.status,
    0,
    `second rollback must exit 0: ${second.stdout}${second.stderr}`,
  );
  assert.ok(
    second.stdout.includes("already at pre-update value"),
    "second rollback must say already restored",
  );
});

test("--rollback refuses a file changed after the update and leaves its bytes as they are", (t) => {
  const dir = freshTarget(t);
  runInstaller(dir, ["--update-mismatched"]);
  const manifestPath = path.join(dir, ".harness", updateFilesIn(dir)[0]);
  writeFileSync(path.join(dir, STALE_RAW), "edited after the update\n", "utf8");
  const tampered = sha256(path.join(dir, STALE_RAW));

  const res = spawnSync(
    process.execPath,
    [INSTALL_PATH, "--rollback", manifestPath],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 1, "a refused entry must exit 1 (fail-closed)");
  assert.ok(res.stdout.includes("refused"), "the refusal must be printed");
  assert.equal(
    sha256(path.join(dir, STALE_RAW)),
    tampered,
    "a refused file must not be touched",
  );
});

test("6th cell 「갱신(병합)」: a merge into an existing settings file is not counted 신규", (t) => {
  const dir = freshTarget(t);
  // A settings file that exists but has NO hooks key -> the installer merges hooks in.
  rmSync(path.join(dir, SETTINGS));
  writeFileSync(
    path.join(dir, SETTINGS),
    '{"permissions":{"allow":["Bash(ls)"]}}\n',
    "utf8",
  );

  const res = runInstaller(dir);
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);
  const merged = sectionLines(res.stdout, "갱신(병합) (").map((l) =>
    path.resolve(pathOf(l.replace(/^\* /, ""))),
  );
  assert.ok(
    merged.includes(path.join(dir, SETTINGS)),
    "merged settings must be named under 갱신(병합)",
  );
  const installedNew = sectionLines(res.stdout, "신규 (").map((l) =>
    path.resolve(pathOf(l.replace(/^\+ /, ""))),
  );
  assert.ok(
    !installedNew.includes(path.join(dir, SETTINGS)),
    "a merge must not be counted under 신규",
  );
  const after = JSON.parse(readFileSync(path.join(dir, SETTINGS), "utf8"));
  assert.deepEqual(
    after.permissions,
    { allow: ["Bash(ls)"] },
    "existing keys must be preserved by the merge",
  );
  assert.ok(after.hooks && after.hooks.PreToolUse, "hooks must be merged in");
});

test("6th cell 「갱신(병합)」 and --update-mismatched never byte-replace the merge target", (t) => {
  const dir = freshTarget(t);
  rmSync(path.join(dir, SETTINGS));
  writeFileSync(
    path.join(dir, SETTINGS),
    '{"permissions":{"allow":["Bash(ls)"]}}\n',
    "utf8",
  );
  const first = runInstaller(dir);
  assert.equal(first.status, 0, `first run must exit 0: ${first.stderr}`);
  const merged = sha256(path.join(dir, SETTINGS));
  const second = runInstaller(dir, ["--update-mismatched"]);
  assert.equal(second.status, 0, `flagged run must exit 0: ${second.stderr}`);
  // Second run: hooks now present and identical -> 동일; the flag must not rewrite it.
  assert.equal(
    sha256(path.join(dir, SETTINGS)),
    merged,
    "the flag must not byte-replace a merged settings file",
  );
  const updatedPaths = sectionLines(
    second.stdout,
    "갱신 (--update-mismatched",
  ).map((l) => l.replace(/^↻ /, "").split(" :: ")[0]);
  assert.ok(
    !updatedPaths.some((p) => path.resolve(p) === path.join(dir, SETTINGS)),
    "merge target never appears in the flag's update section",
  );
});

test("value file: the flag never touches concurrency-cap.json, and admit fails closed without it", (t) => {
  const dir = freshTarget(t);
  const before = sha256(path.join(dir, CAP));
  const res = runInstaller(dir, ["--update-mismatched"]);
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);
  assert.equal(
    sha256(path.join(dir, CAP)),
    before,
    "the flag must not overwrite the value file",
  );
  const transplant = sectionLines(res.stdout, "설치기 목록 밖 손이식").find(
    (l) =>
      path.resolve(dir, pathOf(l.replace(/^◇ /, ""))) === path.join(dir, CAP),
  );
  assert.ok(
    transplant,
    "value file must be reported in the out-of-list 손이식 cell",
  );
  assert.ok(
    transplant.includes(":: 상이"),
    "value file must be judged 상이 (not updated)",
  );

  // Measured in the installed copy, against an isolated probe ledger (never the
  // real admission ledger). Missing value file -> exit 4, no ledger created.
  const probe = path.join(dir, "probe");
  mkdirSync(probe);
  const admit = spawnSync(
    process.execPath,
    [
      path.join(dir, "scripts", "supervisor", "admission-cli.mjs"),
      "admit",
      "--ledger",
      path.join(probe, "ledger.json"),
      "--lock",
      path.join(probe, "ledger.lock"),
      "--reservation-id",
      "probe-1",
      "--cap-path",
      path.join(probe, "no-such-cap.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(
    admit.status,
    4,
    `missing value file must exit 4: ${admit.stdout}${admit.stderr}`,
  );
  assert.ok(
    admit.stdout.includes("CAP_VALUE_FILE_UNREADABLE"),
    "reason must be CAP_VALUE_FILE_UNREADABLE",
  );
  assert.equal(
    existsSync(path.join(probe, "ledger.json")),
    false,
    "no ledger file may be created",
  );
});

// ── HYK-209-installer-rollback-gaps-1 ─────────────────────────────────────────
// 숙제 1 (되돌림 안전장치를 시험으로 고정): G2 = 백업 무결성 게이트 (runRollback),
// G3 = 복원 뒤 sha256 검증. G1(사람이 고친 칸 거부)은 위 「--rollback refuses」가 잡는다.
// 숙제 2 (중간 사망 복구): manifest 는 칸마다 교체 「직전」에 적힌다.

// Lists the replacement order the real run will take: the dry-run prints one
// 「would update」 line per cell in the order it will touch them.
function dryRunOrder(dir) {
  const dry = runInstaller(dir, ["--update-mismatched", "--dry-run"]);
  assert.equal(dry.status, 0, `dry-run must exit 0: ${dry.stderr}`);
  return [
    ...dry.stdout.matchAll(
      /\[dry-run\] would update \(상이 → 틀 값\): (.+)$/gm,
    ),
  ].map((m) => path.resolve(m[1].trim()));
}

test("--update-mismatched: a death in the middle of the run leaves a manifest for every reached cell, and --rollback restores them", (t) => {
  // A second registered stale cell, so one replacement can succeed before the
  // death. The death is REAL: the second target is made read-only, so the
  // installer's own writeFileSync throws (EPERM/EACCES) mid-run and the process
  // exits without reaching the end-of-run summary.
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-rollback-gaps-"));
  // The only file this test makes read-only. Cleanup restores exactly that
  // one: a recursive walk would also chmod directories, and on POSIX a 0o666
  // directory loses its search bit, so rmSync then fails with EACCES.
  let readOnly = null;
  t.after(() => {
    if (readOnly) chmodSync(readOnly, 0o666);
    rmSync(dir, { recursive: true, force: true });
  });
  seedTarget(dir);
  writeFileSync(path.join(dir, ".gitleaks.toml"), "# stale gitleaks\n", "utf8");

  const order = dryRunOrder(dir);
  const second = order[1];
  assert.ok(
    order.length >= 2 && second,
    `two cells must be replaceable, got: ${order.join(", ")}`,
  );
  const pre = Object.fromEntries(order.map((p) => [p, sha256(p)]));
  chmodSync(second, 0o444);
  readOnly = second;
  try {
    accessSync(second, constants.W_OK);
    t.skip(
      "read-only file is still writable here (root/ACL): death cannot be injected",
    );
    return;
  } catch {
    // read-only as intended
  }

  const res = runInstaller(dir, ["--update-mismatched"]);
  assert.notEqual(res.status, 0, "the second write must kill the run");

  const manifestName = updateFilesIn(dir).find((f) =>
    f.endsWith(".manifest.json"),
  );
  assert.ok(manifestName, "a manifest must exist although the run died");
  const manifestPath = path.join(dir, ".harness", manifestName);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(
    manifest.entries.length,
    2,
    "the manifest must hold the completed cell AND the cell whose write died",
  );
  const byPath = (p) =>
    manifest.entries.find((e) => path.resolve(e.path) === p);
  const done = byPath(order[0]);
  const died = byPath(second);
  assert.ok(done && died, "both reached cells must be named by path");
  assert.equal(sha256(order[0]), done.after_sha256, "first cell completed");
  assert.equal(
    sha256(second),
    pre[second],
    "the cell whose write died keeps its pre-update bytes",
  );
  assert.equal(died.before_sha256, pre[second], "its before-sha is recorded");

  const rb = spawnSync(
    process.execPath,
    [INSTALL_PATH, "--rollback", manifestPath],
    {
      encoding: "utf8",
    },
  );
  assert.equal(rb.status, 0, `rollback must exit 0: ${rb.stdout}${rb.stderr}`);
  assert.ok(
    rb.stdout.includes("rollback: 2 ok, 0 refused"),
    `rollback must report both cells ok: ${rb.stdout}`,
  );
  assert.equal(sha256(order[0]), pre[order[0]], "completed cell restored");
  assert.equal(
    sha256(second),
    pre[second],
    "died cell still at pre-update bytes",
  );
});

test("--rollback refuses a missing backup and leaves the current bytes untouched", (t) => {
  const dir = freshTarget(t);
  runInstaller(dir, ["--update-mismatched"]);
  const manifestPath = path.join(dir, ".harness", updateFilesIn(dir)[0]);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.entries.find(
    (e) => path.resolve(e.path) === path.join(dir, STALE_RAW),
  );
  const after = sha256(path.join(dir, STALE_RAW));
  rmSync(entry.backup, { force: true });

  const res = spawnSync(
    process.execPath,
    [INSTALL_PATH, "--rollback", manifestPath],
    {
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 1, "a refused entry must exit 1 (fail-closed)");
  assert.ok(
    res.stdout.includes("refused (백업이 없거나 원본 sha256 과 다르다)"),
    `the backup gate must name the refusal: ${res.stdout}${res.stderr}`,
  );
  assert.equal(
    sha256(path.join(dir, STALE_RAW)),
    after,
    "a refused cell must keep its updated bytes",
  );
});

test("--rollback refuses a tampered backup and never writes its bytes into the target", (t) => {
  const dir = freshTarget(t);
  runInstaller(dir, ["--update-mismatched"]);
  const manifestPath = path.join(dir, ".harness", updateFilesIn(dir)[0]);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const entry = manifest.entries.find(
    (e) => path.resolve(e.path) === path.join(dir, STALE_RAW),
  );
  const after = sha256(path.join(dir, STALE_RAW));
  writeFileSync(
    entry.backup,
    "tampered backup -- not the pre-update bytes\n",
    "utf8",
  );

  const res = spawnSync(
    process.execPath,
    [INSTALL_PATH, "--rollback", manifestPath],
    {
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 1, "a refused entry must exit 1 (fail-closed)");
  assert.ok(
    res.stdout.includes("refused (백업이 없거나 원본 sha256 과 다르다)"),
    `the backup gate must refuse a tampered backup: ${res.stdout}${res.stderr}`,
  );
  assert.equal(
    sha256(path.join(dir, STALE_RAW)),
    after,
    "the tampered backup must never be copied over the target",
  );
});
