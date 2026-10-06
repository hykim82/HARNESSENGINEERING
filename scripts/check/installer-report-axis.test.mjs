// installer-report-axis.test.mjs -- HYK-209-installer-report-axis-1 (다섯 칸 + 목록 밖 손이식).
//
// Proves the installer's five-cell report and the out-of-list transplant block on
// SYNTHETIC targets only (a `git init` folder under the OS temp dir -- never the
// real repo, never a worktree of it). The production entry is the subprocess
// `node templates/harness-init/install.mjs ...` (main()); the only in-process
// calls are the pure substitution pin at the bottom.
//
// Every assertion is by NAME (absolute path -> cell), never by count alone.
// Real runs also assert that no existing file's sha256 changes (this round
// writes nothing over existing files) and that the --dry-run and real-run
// reports carry the same five cells.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { substitutePmGuardControlRoom } from "../../templates/harness-init/install.mjs";

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
const PM_GUARD_SRC = path.join(REPO_ROOT, "scripts", "check", "pm-guard.mjs");
const PM_GUARD_LINE_RE = /^export const CONTROL_ROOM_ROOT = "[^"]*";$/m;

const RAW_STALE = path.join("scripts", "check", "review-gate.mjs"); // 상이
const RAW_SAME = path.join("scripts", "check", "relay-handshake.mjs"); // 동일
const RAW_ABSENT = path.join("scripts", "check", "time-authority.mjs"); // 신규
const RAW_DIR = path.join("scripts", "check", "context-inject.mjs"); // 검증 불가 (디렉터리)
const PM_GUARD = path.join("scripts", "check", "pm-guard.mjs"); // 치환설치
const TRANSPLANT_SAME = path.join(
  "scripts",
  "supervisor",
  "approval-authority-adapter.mjs",
); // 목록 밖 손이식, 동일
const TRANSPLANT_DIFF = path.join(
  "scripts",
  "supervisor",
  "queue-observation-adapter.mjs",
); // 목록 밖 손이식, 상이
const TRANSPLANT_UNTRACKED = path.join(
  "scripts",
  "supervisor",
  "task-drop-core.mjs",
); // 있지만 미추적 -> 목록에 안 나온다

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function posix(p) {
  return p.replace(/\\/g, "/");
}

function put(dir, rel, body) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), body, "utf8");
}

// Copies one real repo file to the same relative path under `dir`.
function copyInto(dir, rel) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, rel), path.join(dir, rel));
}

// The real pm-guard with its one control-room line set to `value` -- i.e. what a
// correct substitution for that control-room value looks like on disk.
function substitutedPmGuard(value) {
  return readFileSync(PM_GUARD_SRC, "utf8").replace(
    PM_GUARD_LINE_RE,
    `export const CONTROL_ROOM_ROOT = "${value}";`,
  );
}

// Main synthetic target: one file per shape of the six 1-5 shapes.
function seedMain(dir) {
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
  put(dir, RAW_STALE, "// stale local copy -- differs from the source\n");
  copyInto(dir, RAW_SAME);
  // 치환설치 stale: a substituted copy carrying some OTHER control-room value.
  put(dir, PM_GUARD, substitutedPmGuard("D:/stale-control-room"));
  // 검증 불가: a DIRECTORY sitting where a listed raw file should be.
  mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
  // 목록 밖 손이식: tracked + identical, tracked + modified, untracked.
  copyInto(dir, TRANSPLANT_SAME);
  copyInto(dir, TRANSPLANT_DIFF);
  appendFileSync(path.join(dir, TRANSPLANT_DIFF), "// hand edit\n");
  copyInto(dir, TRANSPLANT_UNTRACKED);
  execFileSync(
    "git",
    ["-C", dir, "add", "--", TRANSPLANT_SAME, TRANSPLANT_DIFF],
    { stdio: "ignore" },
  );
}

function runInstaller(
  targetDir,
  { dryRun, installPath = INSTALL_PATH, controlRoom } = {},
) {
  const cr = controlRoom ?? path.join(targetDir, "control-room");
  const args = [
    installPath,
    "--profile",
    "solo-full",
    "--repo-path",
    targetDir,
    "--control-room-path",
    cr,
    "--github-repo",
    "owner/repo",
    "--bot-account",
    "bot",
    "--verify-cmd",
    "true",
    "--notify-dir",
    path.join(cr, "notify"),
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
  assert.equal(res.error, undefined, `spawn: ${res.error?.message}`);
  assert.equal(res.status, 0, `installer must exit 0: ${res.stderr}`);
  return res.stdout ?? "";
}

// The five cells + the out-of-list block, keyed by name. Each entry is the text
// after the two-space indent: "<path>" or "<path> :: <detail>".
const HEADERS = {
  신규: "신규 (",
  동일: "동일 (",
  상이: "상이 — 갱신하지 않음 (",
  치환: "치환설치 (",
  검증불가: "검증 불가 (",
  손이식: "설치기 목록 밖 손이식 — 설치기가 갱신하지 않음 (",
};

function fiveCell(stdout) {
  const lines = stdout.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    l.startsWith("--- 다섯 칸 보고 (HYK-209-installer-report-axis-1)"),
  );
  assert.ok(start >= 0, "five-cell report block not found in output");
  const out = Object.fromEntries(Object.keys(HEADERS).map((k) => [k, []]));
  let key = null;
  for (const line of lines.slice(start + 1)) {
    const hit = Object.entries(HEADERS).find(([, h]) => line.startsWith(h));
    if (hit) {
      key = hit[0];
      continue;
    }
    if (key && line.startsWith("  ")) out[key].push(line.slice(4));
    else key = null;
  }
  return out;
}

const pathOf = (entry) => entry.split(" :: ")[0];
const detailOf = (entry) => entry.split(" :: ")[1] ?? "";
const pathsOf = (list) => list.map(pathOf);

test("1-5 six shapes land in the named cells (dry-run, by name not by count)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    seedMain(dir);
    const cells = fiveCell(runInstaller(dir, { dryRun: true }));
    const abs = (rel) => path.join(dir, rel);

    // (1) 상이(목록): the stale listed raw file is a differing file.
    assert.ok(pathsOf(cells.상이).includes(abs(RAW_STALE)), "shape 1 상이");
    // (2) 동일: the byte-identical listed raw file is a same file.
    assert.ok(pathsOf(cells.동일).includes(abs(RAW_SAME)), "shape 2 동일");
    assert.ok(!pathsOf(cells.상이).includes(abs(RAW_SAME)));
    // (3) 신규: the absent listed file is installed.
    assert.ok(pathsOf(cells.신규).includes(abs(RAW_ABSENT)), "shape 3 신규");
    // (4) 치환설치: the stale substituted pm-guard is 상이 in the 치환 cell.
    const pm = cells.치환.find((e) => pathOf(e) === abs(PM_GUARD));
    assert.ok(pm, "shape 4 치환설치 lists pm-guard");
    assert.equal(detailOf(pm), "상이", "stale substituted copy is 상이");
    // (5) 검증 불가: a directory at a listed path is named, with its reason.
    const dirEntry = cells.검증불가.find((e) => pathOf(e) === abs(RAW_DIR));
    assert.ok(dirEntry, "shape 5 검증 불가 names the directory path");
    assert.match(detailOf(dirEntry), /EISDIR|illegal operation/i);
    // (6) 목록 밖 손이식: identical + modified tracked transplants, by name.
    const tp = Object.fromEntries(
      cells.손이식.map((e) => [pathOf(e), detailOf(e)]),
    );
    assert.equal(
      tp[posix(TRANSPLANT_SAME)],
      "동일 · git 추적",
      "shape 6 identical tracked transplant",
    );
    assert.equal(
      tp[posix(TRANSPLANT_DIFF)],
      "상이 · git 추적",
      "shape 6 modified tracked transplant",
    );
    assert.ok(
      !(posix(TRANSPLANT_UNTRACKED) in tp),
      "an untracked stray file is not reported as a tracked transplant",
    );
    assert.ok(
      !(posix(RAW_STALE) in tp),
      "a file the installer covers is never reported as out-of-list",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-5 real run writes nothing over existing files; dry-run and real run report the same five cells", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    seedMain(dir);
    const preexisting = [
      RAW_STALE,
      RAW_SAME,
      PM_GUARD,
      TRANSPLANT_SAME,
      TRANSPLANT_DIFF,
      TRANSPLANT_UNTRACKED,
    ].map((rel) => [rel, sha256(path.join(dir, rel))]);

    const dryCells = fiveCell(runInstaller(dir, { dryRun: true }));
    const realCells = fiveCell(runInstaller(dir, { dryRun: false }));

    for (const [rel, before] of preexisting) {
      assert.equal(
        sha256(path.join(dir, rel)),
        before,
        `existing file must be byte-identical after a real run: ${rel}`,
      );
    }
    assert.ok(existsSync(path.join(dir, RAW_ABSENT)), "absent file installed");
    // The same five cells, name for name -- dry-run is a faithful preview.
    for (const key of Object.keys(HEADERS)) {
      assert.deepEqual(
        realCells[key],
        dryCells[key],
        `dry-run and real run must agree on cell ${key}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("치환설치: a correct substitution for this control room is 동일, a stale one is 상이 (both shapes pinned)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
    const cr = path.join(dir, "control-room");
    put(dir, PM_GUARD, substitutedPmGuard(posix(cr)));
    const cells = fiveCell(runInstaller(dir, { dryRun: true }));
    const pm = cells.치환.find((e) => pathOf(e) === path.join(dir, PM_GUARD));
    assert.ok(pm, "pm-guard is in the 치환설치 cell");
    assert.equal(detailOf(pm), "동일", "correct substitution is 동일");
    assert.ok(
      pathsOf(cells.동일).includes(path.join(dir, PM_GUARD)),
      "correct substitution is also in the 동일 cell",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-2 silence removed: a directory at a listed path is 검증 불가 with a reason, not hidden under 상이 0", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
    mkdirSync(path.join(dir, RAW_DIR), { recursive: true });
    const cells = fiveCell(runInstaller(dir, { dryRun: true }));
    assert.ok(
      pathsOf(cells.검증불가).includes(path.join(dir, RAW_DIR)),
      "the directory is named in 검증 불가",
    );
    assert.ok(
      !pathsOf(cells.상이).includes(path.join(dir, RAW_DIR)),
      "an unverifiable path is never claimed to be stale",
    );
    assert.ok(
      !pathsOf(cells.동일).includes(path.join(dir, RAW_DIR)),
      "an unverifiable path is never claimed to be identical",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-2 anchor drift: a pm-guard whose CONTROL_ROOM_ROOT line is gone is 검증 불가 with the anchor reason", () => {
  // Synthetic HARNESS root: a copy of the installer + templates, and a pm-guard
  // source with its anchor line renamed. REPO_ROOT resolves to this copy, so the
  // real repo is never touched.
  const root = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-harness-"));
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    cpSync(
      path.join(REPO_ROOT, "templates", "harness-init"),
      path.join(root, "templates", "harness-init"),
      { recursive: true },
    );
    put(
      root,
      PM_GUARD,
      readFileSync(PM_GUARD_SRC, "utf8").replace(
        PM_GUARD_LINE_RE,
        'export const CONTROL_ROOM_NAME = "moved";',
      ),
    );
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
    put(
      dir,
      PM_GUARD,
      "// existing pm-guard -- its content is irrelevant to the anchor\n",
    );
    const drifted = path.join(root, "templates", "harness-init", "install.mjs");
    const cells = fiveCell(
      runInstaller(dir, { dryRun: true, installPath: drifted }),
    );
    const hit = cells.검증불가.find(
      (e) => pathOf(e) === path.join(dir, PM_GUARD),
    );
    assert.ok(hit, "drifted anchor surfaces as 검증 불가 for pm-guard");
    assert.match(
      detailOf(hit),
      /CONTROL_ROOM_ROOT constant not found/,
      "the reason names the anchor that was not found",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-1 판정 기준: gitignore/AGENTS/settings merge branches, pointers, and runtime files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
    // gitignore: this profile's marker present, its block lines mostly missing.
    put(dir, ".gitignore", "node_modules/\n# harness-init (solo-full)\n");
    // AGENTS.md: the heading present, the rules body not the current snippet.
    put(
      dir,
      "AGENTS.md",
      "# Notes\n\n## Harness Operating Rules\nold rules only\n",
    );
    // settings.local.json: a hooks key that is not the one this installer writes.
    put(
      dir,
      ".claude/settings.local.json",
      JSON.stringify({ permissions: {}, hooks: { PreToolUse: [] } }),
    );
    // Pointer with the wrong content (deterministic expected bytes -> 상이).
    put(dir, ".harness/admission-ledger-path.json", '{"ledgerPath":"x"}\n');
    // Runtime ledger already present (no fixed expected bytes -> 검증 불가).
    put(dir, "control-room/admission-ledger.json", "{}\n");

    const cells = fiveCell(runInstaller(dir, { dryRun: true }));
    const at = (rel) => path.join(dir, rel);
    const differing = pathsOf(cells.상이);
    assert.ok(
      differing.includes(at(".gitignore")),
      "gitignore with missing block lines is 상이",
    );
    assert.ok(
      differing.includes(at("AGENTS.md")),
      "AGENTS heading without the snippet is 상이",
    );
    assert.ok(
      differing.includes(at(".claude/settings.local.json")),
      "a settings hooks block that differs is 상이",
    );
    assert.ok(
      differing.includes(at(".harness/admission-ledger-path.json")),
      "a pointer with the wrong bytes is 상이",
    );
    const ledger = cells.검증불가.find(
      (e) => pathOf(e) === at("control-room/admission-ledger.json"),
    );
    assert.ok(ledger, "a live ledger is 검증 불가, not 상이");
    assert.match(detailOf(ledger), /런타임 원장/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-1 판정 기준: settings.local.json that is not valid JSON is 검증 불가 (not claimed stale)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: dir });
    put(dir, ".claude/settings.local.json", "{ not json");
    const cells = fiveCell(runInstaller(dir, { dryRun: true }));
    const settings = path.join(dir, ".claude", "settings.local.json");
    const hit = cells.검증불가.find((e) => pathOf(e) === settings);
    assert.ok(hit, "invalid JSON settings is 검증 불가");
    assert.match(detailOf(hit), /JSON 파싱 실패/);
    assert.ok(
      !pathsOf(cells.상이).includes(settings),
      "invalid JSON is never reported as 상이",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-3 no git: out-of-list transplant is judged by existence and says so (basis = 실재)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hyk209-report-axis-"));
  try {
    // NOT a git repo: no .git directory at all.
    copyInto(dir, TRANSPLANT_SAME);
    const cells = fiveCell(runInstaller(dir, { dryRun: true }));
    const hit = cells.손이식.find((e) => pathOf(e) === posix(TRANSPLANT_SAME));
    assert.ok(hit, "a non-git target still gets the transplant scan");
    assert.match(detailOf(hit), /^동일 · 실재\(git 추적 판정 불가/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1-4 ⓑ pin: the single-ledger control-room value goes into the substituted pm-guard exactly, and nothing else changes", () => {
  const src = readFileSync(PM_GUARD_SRC, "utf8");
  const value = "D:/문서관리/하네스-관제실";
  const out = substitutePmGuardControlRoom(src, {
    profile: "solo-full",
    controlRoomPath: value,
  });
  assert.match(
    out,
    /^export const CONTROL_ROOM_ROOT = "D:\/문서관리\/하네스-관제실";$/m,
    "the installed control-room line is the single-ledger path",
  );
  assert.equal(
    out.replace(PM_GUARD_LINE_RE, ""),
    src.replace(PM_GUARD_LINE_RE, ""),
    "only the one constant line differs from the source",
  );
});
