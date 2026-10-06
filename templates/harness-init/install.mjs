#!/usr/bin/env node
// harness-init installer (HYK-92) — parameterized, profile-aware.
//
// Reads a profile (`solo-full` | `team-local`) plus five placeholder
// parameters (repoPath, controlRoomPath, githubRepo, botAccount,
// verifyCmd), copies the matching template set into the target repo with
// placeholder substitution, and never overwrites a file that already
// exists (skip + warn instead).
//
// Source of truth for hook/check scripts: this installer reads
// `hooks/*` and `scripts/check/*.mjs` directly from THIS repository (the
// live solo-full instance) at install time, rather than from a frozen
// duplicate under templates/. That is deliberate — HYK-92 exists because a
// frozen copy drifts from the real implementation; reading the live files
// means an install always ships whatever this repo's enforcement layer
// currently is.
//
// Usage:
//   node install.mjs --profile <solo-full|team-local> --repo-path <path>
//     [--control-room-path <path>] --github-repo <owner/repo>
//     [--bot-account <name>] --verify-cmd "<command>"
//     [solo-full only, HYK-209-frame-1 — see installUnattendedLayerManifest:
//      --notify-dir <path> --approver-login <name> --approver-id <n>
//      --workspaces-root <path> --main-repo-path <path>]
//     [--dry-run]
//   node install.mjs --config <path-to-harness-init.config.json> [--dry-run]
//   node install.mjs ... --update-mismatched [--dry-run]
//       (HYK-209-installer-update-flag-1) 상이 ∩ 틀 등록(고정 틀 바이트로 쓰는
//       파일)만 틀 값으로 교체한다. 기본값은 교체하지 않는다. 교체 전 원본은
//       <repo>/.harness/install-backup/<stamp>/ 로 옮기고, 전·후 sha256 을
//       <repo>/.harness/install-update-<stamp>.manifest.json 에 적는다.
//   node install.mjs --rollback <manifest.json> [--dry-run]
//       (HYK-209-installer-update-flag-1) manifest 의 교체 전 값으로 되돌린다.
//       현재 내용이 교체 직후 값과 다르면 그 칸은 손대지 않고 거부한다(fail-closed).
//
// If --config is omitted, the installer also looks for
// `<repo-path>/harness-init.config.json` (or `./harness-init.config.json`
// when --repo-path is not yet known) and merges it under any CLI flags
// given (CLI wins on conflicting keys).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  appendFileSync,
  chmodSync,
  readdirSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const TEMPLATES_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEMPLATES_DIR, "..", "..");

const PROFILES = ["solo-full", "team-local"];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "dry-run") {
      out.dryRun = true;
      continue;
    }
    if (key === "update-mismatched") {
      out.updateMismatched = true;
      continue;
    }
    const value = argv[i + 1];
    i++;
    out[key] = value;
  }
  return out;
}

function loadConfigFile(configPath) {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(
      `failed to parse config file '${configPath}': ${err.message}`,
      { cause: err },
    );
  }
}

// CLI flag names are kebab-case; config file / internal keys are camelCase.
const FLAG_TO_KEY = {
  profile: "profile",
  "repo-path": "repoPath",
  "control-room-path": "controlRoomPath",
  "github-repo": "githubRepo",
  "bot-account": "botAccount",
  "verify-cmd": "verifyCmd",
  // HYK-209-frame-1: five new placeholders for the "무인·병렬 층"
  // (unattended/parallel layer -- scripts/supervisor/*,
  // scripts/relay/adapters/orca-adapter.mjs) that ORCH's own instance has
  // built directly into itself, hardcoded, never through this installer
  // (§2 placeholder table in .harness/coder.md has the exact file:line
  // citations). This round does NOT copy those source files (§3
  // "내용물 조립 0" -- that is a separate, later assembly step) -- these
  // flags exist so the installer already knows how to receive and validate
  // the values a future assembly round's templates will need, and records
  // them now in a manifest (installUnattendedLayerManifest below) instead
  // of silently deferring the whole question.
  "notify-dir": "notifyDir",
  "approver-login": "approverLogin",
  "approver-id": "approverId",
  "workspaces-root": "workspacesRoot",
  "main-repo-path": "mainRepoPath",
  config: "config",
};

function normalizeCliArgs(rawArgs) {
  const out = {
    dryRun: !!rawArgs.dryRun,
    updateMismatched: !!rawArgs.updateMismatched,
  };
  for (const [flag, key] of Object.entries(FLAG_TO_KEY)) {
    if (rawArgs[flag] !== undefined) out[key] = rawArgs[flag];
  }
  return out;
}

function resolveParams(argv) {
  const cli = normalizeCliArgs(parseArgs(argv));
  const configPath =
    cli.config ||
    (cli.repoPath && path.join(cli.repoPath, "harness-init.config.json")) ||
    (existsSync(path.join(process.cwd(), "harness-init.config.json"))
      ? path.join(process.cwd(), "harness-init.config.json")
      : null);
  const fileConfig = loadConfigFile(configPath);
  const merged = { ...fileConfig, ...cli };
  delete merged.config;
  return merged;
}

// HYK-209-frame-1: extracted from validateParams (ESLint complexity ceiling)
// -- loud-reject, not a silent default, same convention as
// controlRoomPath/botAccount in validateParams itself. Each of these five
// mirrors a real hardcoded value ORCH's own instance carries outside this
// installer's current copy list (source cited so the rejection message
// itself tells a human *why* the value is needed, not just that it's
// missing). team-local never calls this — it has no control room, no bot
// collaborator, and (since it has neither a control room nor a
// scheduler/PM-lane install) no unattended layer to describe.
function validateUnattendedLayerParams(params, errors) {
  if (!params.notifyDir)
    errors.push(
      "solo-full requires notifyDir (--notify-dir) -- mirrors reach-report.mjs's DEFAULT_NOTIFY_DIR hardcode",
    );
  if (!params.approverLogin)
    errors.push(
      "solo-full requires approverLogin (--approver-login) -- mirrors approver-allowlist.json's approvers[].login hardcode",
    );
  if (!params.approverId)
    errors.push(
      "solo-full requires approverId (--approver-id) -- mirrors approver-allowlist.json's approvers[].id hardcode",
    );
  if (!params.workspacesRoot)
    errors.push(
      "solo-full requires workspacesRoot (--workspaces-root) -- mirrors orca-adapter.mjs's WORKSPACES_ROOT hardcode",
    );
  if (!params.mainRepoPath)
    errors.push(
      "solo-full requires mainRepoPath (--main-repo-path) -- mirrors orca-adapter.mjs's MAIN_REPO_PATH hardcode",
    );
}

function validateParams(params) {
  const errors = [];
  if (!PROFILES.includes(params.profile)) {
    errors.push(
      `--profile must be one of ${PROFILES.join(" | ")} (got: ${params.profile ?? "<missing>"})`,
    );
  }
  if (!params.repoPath) errors.push("repoPath is required (--repo-path)");
  if (!params.githubRepo)
    errors.push("githubRepo is required (--github-repo, owner/repo form)");
  if (!params.verifyCmd) errors.push("verifyCmd is required (--verify-cmd)");
  if (params.profile === "solo-full") {
    if (!params.controlRoomPath)
      errors.push("solo-full requires controlRoomPath (--control-room-path)");
    if (!params.botAccount)
      errors.push("solo-full requires botAccount (--bot-account)");
    validateUnattendedLayerParams(params, errors);
  }
  // team-local: controlRoomPath / botAccount / the five unattended-layer
  // placeholders are all allowed to be empty or absent — team-local has no
  // control room, no bot collaborator, and (since it has neither a control
  // room nor a scheduler/PM-lane install) no unattended layer to describe.
  if (errors.length) {
    throw new Error("invalid parameters:\n  - " + errors.join("\n  - "));
  }
}

function placeholderMap(params) {
  return {
    "<PROFILE>": params.profile,
    "<REPO_PATH>": params.repoPath,
    "<CONTROL_ROOM_PATH>":
      params.controlRoomPath || "(none — team-local has no control room)",
    "<GITHUB_REPO>": params.githubRepo,
    "<BOT_ACCOUNT>":
      params.botAccount ||
      "(none — team-local pushes directly under this account)",
    "<VERIFY_CMD>": params.verifyCmd,
    // HYK-209-frame-1: not yet substituted into any template file this
    // installer writes (see installUnattendedLayerManifest) — carried here
    // too so `--dry-run`'s printed plan (main() logs this whole map) shows
    // every placeholder this install run knows about, substituted or not.
    "<NOTIFY_DIR>":
      params.notifyDir || "(none — team-local has no unattended layer)",
    "<APPROVER_LOGIN>":
      params.approverLogin || "(none — team-local has no unattended layer)",
    "<APPROVER_ID>":
      params.approverId || "(none — team-local has no unattended layer)",
    "<WORKSPACES_ROOT>":
      params.workspacesRoot || "(none — team-local has no unattended layer)",
    "<MAIN_REPO_PATH>":
      params.mainRepoPath || "(none — team-local has no unattended layer)",
  };
}

function substitute(content, map) {
  let out = content;
  for (const [token, value] of Object.entries(map)) {
    out = out.split(token).join(value);
  }
  return out;
}

const installed = [];
const skipped = [];
// HYK-209-installer-mismatch-report-1 축 B: the subset of `skipped` whose
// existing file differs from what this installer would write. Reporting only:
// a differing file is still NOT overwritten (update policy is a separate
// decision), and `skipped` keeps its old meaning (every skip, identical or not).
const differing = [];
// HYK-209-installer-report-axis-1 축 C(다섯 칸): {path, reason} for every skip
// whose existing file could NOT be compared -- neither "same" nor "differing".
const unverifiable = [];
// 치환설치 칸: {path, verdict} for each file whose one line this installer
// substitutes (pm-guard.mjs), verdict = 신규 | 동일 | 상이 | 검증 불가.
const substituted = [];
// HYK-209-installer-update-flag-1: run-scoped options. `updated` = 상이 → 틀
// 값으로 교체한 칸(--update-mismatched 일 때만 채워진다). `mergedFiles` = 기존
// 파일에 hooks 만 덧붙인 칸(6번째 칸 「갱신(병합)」).
const runOpts = {
  dryRun: false,
  updateMismatched: false,
  targetRepoPath: "",
  stamp: "",
};
const updated = [];
const mergedFiles = [];
const UPDATE_MANIFEST_SCHEMA = "installer-update-manifest/1";
// HYK-209-installer-rollback-gaps-1: manifest header fields, fixed at the first
// write of a run (see writeUpdateManifest). Reset in startRun.
let manifestAt = "";
let manifestInstaller;
let manifestAnnounced = false;

function ensureParentDir(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function stampNow() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupDirOf(stamp) {
  return path.join(runOpts.targetRepoPath, ".harness", "install-backup", stamp);
}

// HYK-209-installer-report-axis-1 1-1: the single door for every skip branch.
// Before this round 12 sites pushed to `skipped` directly (gitignore x2,
// AGENTS.md, settings.local.json x3, ledger, receipts, two pointers, manifest,
// checklist) and only one helper (noteSkippedExisting) compared bytes. The
// caller now decides the verdict by ITS OWN stated criterion (see each branch)
// and this function records it. 동일 is not stored: it is "skipped, and in
// neither differing nor unverifiable" (computed in printFiveCellReport).
function recordSkip(destPath, verdict, reason = "") {
  skipped.push(destPath);
  if (verdict === "상이") {
    differing.push(destPath);
    console.warn(`  ↳ 있지만 내용이 다름 — 갱신하지 않음: ${destPath}`);
  }
  if (verdict === "검증 불가") {
    unverifiable.push({ path: destPath, reason });
    console.warn(
      `  ↳ 검증 불가 (같다고도 다르다고도 말하지 않는다 — 갱신 대상 아님): ${destPath} — ${reason}`,
    );
  }
  return verdict;
}

// Every skip-if-exists branch in the copy axes (copyRawFile, writeTemplateFile,
// installPmGuard) funnels here. `expected` is the bytes this install would have
// written (a Buffer/string, or a thunk producing one). If computing it or
// reading the existing file fails, the file is reported as 검증 불가 -- an
// unverifiable file is not claimed to be stale, and it is not hidden under
// 상이 0 either (HYK-209-installer-report-axis-1 1-2: the old `catch { return; }`
// here was that silence). Returns the verdict.
//
// HYK-209-installer-update-flag-1: `replaceable` = the caller writes this file
// from a fixed template/raw source (writeTemplateFile · copyRawFile only). Only
// those may be replaced under --update-mismatched. Merge targets (gitignore,
// AGENTS.md, settings.local.json), pointers, manifest, checklist and pm-guard
// (치환설치) are never passed `replaceable`, so the flag cannot byte-replace them.
function noteSkippedExisting(destPath, expected, { replaceable = false } = {}) {
  console.warn(`skip (already exists): ${destPath}`);
  let want;
  let same;
  try {
    want = Buffer.from(typeof expected === "function" ? expected() : expected);
    same = readFileSync(destPath).equals(want);
  } catch (err) {
    return recordSkip(destPath, "검증 불가", err.message);
  }
  if (same) return recordSkip(destPath, "동일");
  if (replaceable && runOpts.updateMismatched) {
    return replaceMismatched(destPath, want);
  }
  return recordSkip(destPath, "상이");
}

// HYK-209-installer-update-flag-1: the one replacement door. The original bytes
// go to <target>/.harness/install-backup/<stamp>/<rel> first; before/after
// sha256 are kept for the manifest (the input --rollback reads). Dry-run records
// the same entry without touching disk, so the printed set matches a real run.
// HYK-209-installer-rollback-gaps-1 (숙제 2): the order is backup -> manifest
// entry -> target write. The entry reaches the manifest BEFORE the target changes,
// so a death between the two leaves an entry whose current bytes are still the
// before-value --rollback reports as "already at pre-update value" (no loss).
function replaceMismatched(destPath, want) {
  const rel = path.relative(runOpts.targetRepoPath, destPath);
  const before = sha256Buffer(readFileSync(destPath));
  const after = sha256Buffer(want);
  const backup = path.join(backupDirOf(runOpts.stamp), rel);
  if (!runOpts.dryRun) {
    ensureParentDir(backup);
    copyFileSync(destPath, backup);
    updated.push({ path: destPath, rel, before, after, backup });
    writeUpdateManifest();
    writeFileSync(destPath, want);
  } else {
    updated.push({ path: destPath, rel, before, after, backup });
  }
  console.log(
    `${runOpts.dryRun ? "[dry-run] would update" : "updated"} (상이 → 틀 값): ${destPath}`,
  );
  return "갱신";
}

function writeTemplateFile(srcPath, destPath, map, { dryRun, executable }) {
  if (existsSync(destPath)) {
    noteSkippedExisting(
      destPath,
      () => substitute(readFileSync(srcPath, "utf8"), map),
      { replaceable: true },
    );
    return;
  }
  const content = substitute(readFileSync(srcPath, "utf8"), map);
  if (!dryRun) {
    ensureParentDir(destPath);
    writeFileSync(destPath, content, "utf8");
    if (executable) {
      try {
        chmodSync(destPath, 0o755);
      } catch {
        // best-effort; not all filesystems (e.g. some Windows setups) honor this
      }
    }
  }
  installed.push(destPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${destPath}`,
  );
}

function copyRawFile(srcPath, destPath, { dryRun, executable }) {
  if (!existsSync(srcPath)) {
    console.warn(`source missing, skipping: ${srcPath}`);
    return;
  }
  if (existsSync(destPath)) {
    noteSkippedExisting(destPath, () => readFileSync(srcPath), {
      replaceable: true,
    });
    return;
  }
  if (!dryRun) {
    ensureParentDir(destPath);
    writeFileSync(destPath, readFileSync(srcPath));
    if (executable) {
      try {
        chmodSync(destPath, 0o755);
      } catch {
        // best-effort; not all filesystems (e.g. some Windows setups) honor this
      }
    }
  }
  installed.push(destPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${destPath}`,
  );
}

function appendGitignoreBlock(profile, targetRepoPath, { dryRun }) {
  const templatePath = path.join(TEMPLATES_DIR, "gitignore.append.template");
  const raw = readFileSync(templatePath, "utf8");
  // \r?\n tolerates the template being saved with either LF or CRLF line
  // endings (this file has been re-saved as CRLF by Windows-side tooling
  // before, which silently broke a plain \n-only match).
  const re = new RegExp(`# @profile:${profile}\\r?\\n([\\s\\S]*?)# @end`, "m");
  const match = raw.match(re);
  if (!match)
    throw new Error(
      `gitignore.append.template has no block for profile '${profile}'`,
    );
  const block = match[1]
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#") && line.trim() !== "")
    .join("\n");
  const gitignorePath = path.join(targetRepoPath, ".gitignore");
  const existing = existsSync(gitignorePath)
    ? readFileSync(gitignorePath, "utf8")
    : "";
  const marker = `# harness-init (${profile})`;

  // 1-1 판정 기준(추가·병합 분기): 동일 = 현재 템플릿의 블록 줄이 전부 이미
  // 있다(순서·연속성 무관). 상이 = 마커는 있는데 블록 줄이 빠져 있다(옛
  // 템플릿이거나 손편집). 기대 바이트를 한 값으로 정할 수 없는 append 분기라
  // 「줄 집합 포함」으로 가른다.
  if (existing.includes(block.trim())) {
    recordSkip(gitignorePath, "동일");
    console.warn(`skip (block already present): ${gitignorePath}`);
    return;
  }

  // HYK-98: the check above only catches an exact, current-template match.
  // If this profile's marker is already present, some earlier install ran
  // here before -- re-appending would duplicate lines a prior (possibly
  // older-template) run already added. Never auto-upgrade/rewrite what's
  // there (that risks clobbering a hand-edit); skip and print exactly which
  // current-template lines are missing so a human can merge them by hand.
  if (existing.includes(marker)) {
    const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const missingLines = block
      .split("\n")
      .filter((line) => !existingLines.has(line.trim()));
    if (missingLines.length === 0) {
      recordSkip(gitignorePath, "동일");
      console.warn(
        `skip (marker '${marker}' already present, current-template lines already covered): ${gitignorePath}`,
      );
    } else {
      recordSkip(gitignorePath, "상이");
      console.warn(
        `skip (marker '${marker}' already present, from an older template version -- not auto-upgrading): ${gitignorePath}\n` +
          `Missing lines from the current template -- add these by hand if still wanted:\n${missingLines.map((l) => `  ${l}`).join("\n")}`,
      );
    }
    return;
  }

  if (!dryRun) {
    ensureParentDir(gitignorePath);
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(gitignorePath, `${sep}\n${marker}\n${block}\n`, "utf8");
  }
  installed.push(gitignorePath);
  console.log(
    `${dryRun ? "[dry-run] would append to" : "appended to"}: ${gitignorePath}`,
  );
}

function appendAgentsFile(targetRepoPath, { dryRun }) {
  const agentsPath = path.join(targetRepoPath, "AGENTS.md");
  const snippet = readFileSync(
    path.join(TEMPLATES_DIR, "AGENTS.append.md"),
    "utf8",
  );
  if (existsSync(agentsPath)) {
    const existing = readFileSync(agentsPath, "utf8");
    if (existing.includes("Harness Operating Rules")) {
      // 1-1 판정 기준(추가 분기): 동일 = 현재 스니펫 전문이 파일 안에 그대로
      // 있다(CRLF/LF 무관). 상이 = 제목만 있고 스니펫 전문은 없다(옛 버전이거나
      // 손편집) -- 스니펫은 append 전용이라 기대 바이트 한 값이 없다.
      const normalize = (s) => s.replace(/\r\n/g, "\n");
      const same = normalize(existing).includes(normalize(snippet).trim());
      recordSkip(agentsPath, same ? "동일" : "상이");
      console.warn(`skip (equivalent rules already present): ${agentsPath}`);
      return;
    }
    if (!dryRun) appendFileSync(agentsPath, `\n${snippet}`, "utf8");
    installed.push(agentsPath);
    console.log(
      `${dryRun ? "[dry-run] would append to" : "appended to"}: ${agentsPath}`,
    );
    return;
  }
  if (!dryRun) writeFileSync(agentsPath, snippet, "utf8");
  installed.push(agentsPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${agentsPath}`,
  );
}

// Windows-native params.controlRoomPath arrives with backslashes; the live
// solo-full example this mirrors (.claude/settings.local.json's own
// `--context "D:/문서관리/..."`) uses forward slashes, so normalize before
// building a command string.
function toPosixPath(p) {
  return p.replace(/\\/g, "/");
}

function joinPosix(base, file) {
  return `${toPosixPath(base).replace(/\/+$/, "")}/${file}`;
}

// Builds the same `hooks` object this repository's own live
// `.claude/settings.local.json` carries (PreToolUse role-guard, Stop
// status-fresh + clear-safe-check, SessionStart + UserPromptSubmit
// context-inject), with STATUS/PROJECT-CONTEXT paths resolved per profile:
// solo-full points at the control room (outside the repo), team-local has
// no control room and points at its own `.harness/` via the portable
// `$CLAUDE_PROJECT_DIR` token (no substitution needed, unlike the other
// placeholder tokens this installer replaces in template files).
function buildHooksBlock(params) {
  const statusPath =
    params.profile === "solo-full"
      ? joinPosix(params.controlRoomPath, "STATUS.md")
      : "$CLAUDE_PROJECT_DIR/.harness/STATUS.md";
  const contextPath =
    params.profile === "solo-full"
      ? joinPosix(params.controlRoomPath, "PROJECT-CONTEXT.md")
      : "$CLAUDE_PROJECT_DIR/.harness/PROJECT-CONTEXT.md";

  return {
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit|NotebookEdit",
        hooks: [
          {
            type: "command",
            command: 'node "$CLAUDE_PROJECT_DIR/scripts/check/role-guard.mjs"',
          },
          // HYK-186 3R P1-1: done-line-write-guard.mjs was documented as
          // "the second PreToolUse hook" (docs/harness-init.md) but never
          // actually wired here -- an independent review caught the
          // mismatch (0 occurrences of "done-line-write-guard" in this file
          // before this fix). Same matcher as role-guard.mjs (both inspect
          // Edit/Write/MultiEdit tool_input.file_path); NotebookEdit is
          // included in the matcher for consistency with role-guard's own
          // entry even though this guard's own WRITE_TOOLS set doesn't act
          // on it (matches role-guard's pre-existing matcher shape exactly,
          // no new behavior invented here).
          {
            type: "command",
            command:
              'node "$CLAUDE_PROJECT_DIR/scripts/check/done-line-write-guard.mjs"',
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/status-fresh.mjs" --status "${statusPath}"`,
          },
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/clear-safe-check.mjs" --status "${statusPath}"`,
          },
          // solo-full only: team-local has no control room to check against
          // (see checkControlRoomFresh's own vacuous-ok path for the
          // absent-path case this guards even if that ever drifted).
          ...(params.profile === "solo-full"
            ? [
                {
                  type: "command",
                  command: `node "$CLAUDE_PROJECT_DIR/scripts/check/controlroom-fresh.mjs" --control-room "${toPosixPath(params.controlRoomPath)}"`,
                },
              ]
            : []),
        ],
      },
    ],
    SessionStart: [
      {
        matcher: "startup|resume|clear|compact",
        hooks: [
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/context-inject.mjs" --mode session-start --context "${contextPath}"`,
          },
        ],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [
          {
            type: "command",
            command: `node "$CLAUDE_PROJECT_DIR/scripts/check/context-inject.mjs" --mode user-prompt-submit --context "${contextPath}"`,
          },
        ],
      },
    ],
  };
}

// Generates or merges the target's `.claude/settings.local.json` hooks
// block. Merge semantics, in order:
//   1. file absent -> create `{ "hooks": {...} }`.
//   2. file present, no top-level `hooks` key -> preserve everything else,
//      add `hooks` (e.g. a file that only has a `permissions` block).
//   3. file present, `hooks` key already exists -> do not touch it (an
//      existing wiring could be intentionally different); skip, warn, and
//      print the hooks block as a snippet for a human to merge by hand.
//      Auto-merging hook arrays is not attempted -- silently interleaving
//      commands into an existing hook the operator wrote risks misrouting
//      it in a way that is hard to notice.
//   4. file present but not valid JSON -> do not touch it; same snippet
//      fallback as (3).
// All object assembly goes through `JSON.stringify(obj, null, 2)` -- no
// regex/string surgery on existing JSON, so a merge can never corrupt
// unrelated keys it didn't intend to touch.
function installSettingsLocal(params, targetRepoPath, { dryRun }) {
  const settingsPath = path.join(
    targetRepoPath,
    ".claude",
    "settings.local.json",
  );
  const hooksBlock = buildHooksBlock(params);
  const hooksOnlySnippet = JSON.stringify({ hooks: hooksBlock }, null, 2);
  const restartNote =
    "Restart Claude Code once and confirm the hooks actually fire before relying on them -- this is a one-time human step (self-modifying a live session's own settings mid-task is out of scope for this installer); see docs/harness-init.md.";

  if (!existsSync(settingsPath)) {
    if (!dryRun) {
      ensureParentDir(settingsPath);
      writeFileSync(settingsPath, `${hooksOnlySnippet}\n`, "utf8");
    }
    installed.push(settingsPath);
    console.log(
      `${dryRun ? "[dry-run] would create" : "created"}: ${settingsPath}\n${hooksOnlySnippet}\n${restartNote}`,
    );
    return;
  }

  let existingRaw;
  try {
    existingRaw = readFileSync(settingsPath, "utf8");
  } catch (err) {
    console.warn(
      `skip (could not read existing ${settingsPath}: ${err.message}) -- merge this manually:\n${hooksOnlySnippet}`,
    );
    recordSkip(settingsPath, "검증 불가", `읽기 실패: ${err.message}`);
    return;
  }

  let existingObj;
  try {
    existingObj = existingRaw.trim() ? JSON.parse(existingRaw) : {};
  } catch (err) {
    console.warn(
      `skip (existing ${settingsPath} is not valid JSON: ${err.message}) -- not touched. Merge this manually:\n${hooksOnlySnippet}`,
    );
    recordSkip(settingsPath, "검증 불가", `JSON 파싱 실패: ${err.message}`);
    return;
  }

  if (existingObj.hooks) {
    // 1-1 판정 기준(병합 분기): 동일 = 기존 hooks 블록이 이 설치기가 쓸 블록과
    // 구조적으로 같다(키 순서 무관). 상이 = 다르다(사람이 손으로 바꿨을 수 있다).
    const same = isDeepStrictEqual(existingObj.hooks, hooksBlock);
    recordSkip(settingsPath, same ? "동일" : "상이");
    console.warn(
      `skip (${settingsPath} already has a "hooks" key -- not touched, auto-merging hook arrays risks misrouting an existing wiring). Merge this manually:\n${hooksOnlySnippet}`,
    );
    return;
  }

  const merged = { ...existingObj, hooks: hooksBlock };
  const mergedSnippet = JSON.stringify(merged, null, 2);
  if (!dryRun) {
    writeFileSync(settingsPath, `${mergedSnippet}\n`, "utf8");
  }
  // HYK-209-installer-update-flag-1 (6번째 칸): a merge into an existing file is
  // 갱신(병합), not 신규 -- counting it under 신규 was the mixing this round fixes.
  mergedFiles.push({
    path: settingsPath,
    added: ["hooks"],
    preserved: Object.keys(existingObj),
  });
  console.log(
    `${dryRun ? "[dry-run] would merge hooks into" : "merged hooks into"}: ${settingsPath} (existing keys preserved)\n${mergedSnippet}\n${restartNote}`,
  );
}

// Installs commit-msg/pre-commit into `<target>/.git/hooks/` (per-clone,
// untracked by git itself -- this is the one part of a git hook's model
// that has always required a local, non-committed install step, same as
// the manual `cp hooks/commit-msg .git/hooks/commit-msg` documented in
// docs/enforcement-v1.md). Only runs when `<target>/.git` exists as a real
// directory; a target that is not yet a git repository (or uses some other
// VCS layout) gets a warning instead of a crash, and the tracked copy under
// `hooks/` (already installed above) remains available for a manual install
// later.
function installGitHooksIntoDotGit(targetRepoPath, { dryRun }) {
  const gitDir = path.join(targetRepoPath, ".git");
  let isGitDir;
  try {
    isGitDir = existsSync(gitDir) && statSync(gitDir).isDirectory();
  } catch {
    isGitDir = false;
  }
  if (!isGitDir) {
    console.warn(
      `skip (.git/hooks/ auto-install): '${gitDir}' is not a directory -- per-clone install is manual here: copy hooks/commit-msg and hooks/pre-commit into .git/hooks/ and chmod +x them.`,
    );
    return;
  }
  for (const name of ["commit-msg", "pre-commit"]) {
    copyRawFile(
      path.join(REPO_ROOT, "hooks", name),
      path.join(gitDir, "hooks", name),
      { dryRun, executable: true },
    );
  }
}

// HYK-100: a real near-miss on a machine with multiple github.com
// credentials -- a team-local push attempted under the harness bot's
// identity instead of the operator's own account (blocked only because the
// bot lacked write access; had it had access, the bot's identity would have
// leaked into a shared team repo's history). The fix that was applied by
// hand, `git config --local credential.helper "!gh auth git-credential"`,
// pins this one clone's push identity to whatever account `gh` is logged in
// as, regardless of which credential a global/manager-stored entry would
// otherwise have raced to supply. This function mechanizes that for every
// team-local install.
const CREDENTIAL_HELPER_KEY = "credential.helper";
const CREDENTIAL_HELPER_VALUE = "!gh auth git-credential";

function commandSucceeds(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function gitConfigLocalGet(targetRepoPath, key) {
  try {
    return execFileSync(
      "git",
      ["-C", targetRepoPath, "config", "--local", "--get", key],
      { encoding: "utf8" },
    ).trim();
  } catch {
    // Non-zero exit from `git config --get` means "not set at this scope"
    // (or, much less likely, a transient git error) -- either way, treated
    // as "nothing to preserve," matching this function's only two real
    // outcomes (skip because something's already there, or set because
    // nothing is).
    return null;
  }
}

function originRemoteUrl(targetRepoPath) {
  try {
    return execFileSync(
      "git",
      ["-C", targetRepoPath, "remote", "get-url", "origin"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    return null;
  }
}

// SSH remotes (`git@host:...` or `ssh://...`) never consult a credential
// helper at all -- setting one would be inert, not wrong, but skipping is
// more honest than claiming to have "pinned" something that plays no role
// in how that remote authenticates.
function isSshRemoteUrl(url) {
  return !!url && /^(git@|ssh:\/\/)/i.test(url);
}

function installCredentialBoundary(targetRepoPath, { dryRun }) {
  const gitDir = path.join(targetRepoPath, ".git");
  let isGitDir;
  try {
    isGitDir = existsSync(gitDir) && statSync(gitDir).isDirectory();
  } catch {
    isGitDir = false;
  }
  if (!isGitDir) {
    console.warn(
      `skip (credential.helper): '${targetRepoPath}' is not a git repository yet -- manual setup once it is: ` +
        `git -C <repo> config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}"`,
    );
    return;
  }

  try {
    const origin = originRemoteUrl(targetRepoPath);
    if (isSshRemoteUrl(origin)) {
      console.log(
        `credential.helper: origin ('${origin}') is an SSH remote -- credential helpers are not consulted for SSH pushes, nothing to pin.`,
      );
      return;
    }

    const existing = gitConfigLocalGet(targetRepoPath, CREDENTIAL_HELPER_KEY);
    if (existing) {
      console.warn(
        `skip (credential.helper already set to '${existing}' at repo-local scope -- not touched, same never-overwrite convention as every other file this installer writes). ` +
          `If this clone's pushes should go out under a specific account, consider: git -C <repo> config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}"`,
      );
      return;
    }

    if (!commandSucceeds("gh", ["--version"])) {
      console.warn(
        `skip (credential.helper): 'gh' CLI not found on PATH -- not setting it automatically (pinning to a helper that can't authenticate would break every push, worse than leaving the ambiguity). ` +
          `Once gh is installed and logged in as the intended account: git -C <repo> config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}"`,
      );
      return;
    }

    if (dryRun) {
      console.log(
        `[dry-run] would set credential.helper: git -C ${targetRepoPath} config --local ${CREDENTIAL_HELPER_KEY} "${CREDENTIAL_HELPER_VALUE}" (pins push identity to the current \`gh\` login account)`,
      );
      return;
    }

    execFileSync("git", [
      "-C",
      targetRepoPath,
      "config",
      "--local",
      CREDENTIAL_HELPER_KEY,
      CREDENTIAL_HELPER_VALUE,
    ]);
    console.log(
      `push identity pinned: credential.helper -> "${CREDENTIAL_HELPER_VALUE}" (this clone's pushes now authenticate as whichever account \`gh auth status\` currently reports)`,
    );
  } catch (err) {
    // Fail-open: this is a safety nicety on top of the install, not the
    // install itself -- an unexpected git/gh error here must never abort
    // the rest of install.mjs.
    console.warn(
      `skip (credential.helper): unexpected error (${err.message}) -- not touched, install continues.`,
    );
  }
}

function soloFullChecklist(params) {
  return `# solo-full GitHub setup checklist (do once, in the GitHub web UI)

Repo: ${params.githubRepo}

- [ ] Make the repo visible as intended (public/private) per project decision.
- [ ] Invite ${params.botAccount} as a collaborator with **Write** access only
      (not Admin) — this is the identity-separation step (HYK-87/B1) that
      keeps the acting agent unable to disable branch protection itself.
- [ ] Protect the default branch: require a pull request before merging,
      require the \`enforce\` status check to pass, require at least one
      approving review, and enable "Do not allow bypassing the above
      settings" (enforce_admins) so repo admins are not exempt.
- [ ] Enable GitHub secret scanning + push protection (Settings > Code
      security).
- [ ] Confirm \`.github/workflows/enforce.yml\` is present and green on the
      first PR.
- [ ] Local hooks: this installer already copied \`hooks/commit-msg\` and
      \`hooks/pre-commit\` into \`.git/hooks/\` when it ran (if \`.git/\` existed
      at install time) — confirm they're there and re-install if missing:
      \`cp hooks/commit-msg hooks/pre-commit .git/hooks/ && chmod +x .git/hooks/commit-msg .git/hooks/pre-commit\`.
- [ ] Install gitleaks locally for fast pre-commit feedback (optional; CI is
      authoritative regardless): https://github.com/gitleaks/gitleaks#installing
- [ ] Credential boundary (HYK-100): confirm this clone's push identity is
      what it should be — bot PAT if this is meant to push as
      \`${params.botAccount}\`, this account's own credentials otherwise.
      Check: \`git config --local credential.helper\` plus the actual
      account name in a real push's log/prompt. Not set automatically here —
      unlike team-local, solo-full has no single "always pin to gh login"
      answer (a bot-push flow legitimately wants the bot's PAT, not
      \`gh\`'s logged-in account), so which credential is correct is a human
      call, not something this installer can decide on its own.
`;
}

// HYK-309: pm-guard.mjs hardcodes THIS repo's own live control-room path
// (`const CONTROL_ROOM_ROOT = "...";`) because it doubles as this repo's
// own working enforcement script (see installEnforcementScripts' header
// comment -- scripts/check/*.mjs is read live, not from a frozen
// templates/ copy, precisely so it never drifts from the real
// implementation). `copyRawFile` used to ship that literal unchanged into
// every target, so every non-solo-full-on-this-machine install silently
// pointed pm-guard at a control room that isn't its own (synthetic-install
// repro: coder.md §1). This rewrites just that one constant's value at
// install time, the same "substitute a known token for this install's own
// value" idea `substitute()`/placeholderMap already apply to templates --
// applied here via a targeted regex instead of a `<TOKEN>` placeholder,
// because the source line must stay a real working literal for this
// repo's own live use, not a token nothing ever fills in for it.
// Anchored to line-start + the real declaration keyword ("export const"),
// not a bare `const CONTROL_ROOM_ROOT = "` substring -- a first cut of this
// regex matched the code-quoted mention of that same shape inside this
// very comment block instead of the real line below it (caught by the
// synthetic-install repro: the installed copy still carried this repo's
// own path because `content.replace` found and rewrote the FIRST match,
// which was the comment, not the declaration).
// No longer captures the quotes -- HYK-309 2R (REVIEW P1): the value is
// now re-embedded via JSON.stringify (see substitutePmGuardControlRoom),
// which already produces its own quoted, escaped literal, so nothing here
// needs to reuse pieces of the original quoted string.
const PM_GUARD_CONTROL_ROOM_LINE_RE =
  /^export const CONTROL_ROOM_ROOT = "[^"]*";$/m;

// team-local has no control room (validateParams never requires
// controlRoomPath for it). isControlRoomPath does
// `normalized.startsWith(rootLower + "/")` / `=== rootLower` -- an empty
// string would make `.startsWith("")` true for every path, i.e. pm-guard
// would allow a PM to write anywhere. This sentinel can never equal or
// prefix a real normalized filesystem path, so pm-guard stays fail-closed
// (blocks all PM writes outside scratchpad) on a profile that has no
// control room to allow-list in the first place.
const TEAM_LOCAL_CONTROL_ROOM_SENTINEL = "<NO_CONTROL_ROOM_TEAM_LOCAL_PROFILE>";

// Exported (HYK-209-installer-report-axis-1 1-4 ⓑ test) so the installed value
// can be checked in-process without writing a real control-room path to disk.
export function substitutePmGuardControlRoom(content, params) {
  if (!PM_GUARD_CONTROL_ROOM_LINE_RE.test(content)) {
    throw new Error(
      "pm-guard.mjs: CONTROL_ROOM_ROOT constant not found at its expected " +
        'shape (const CONTROL_ROOM_ROOT = "...";) -- refusing to install a ' +
        "copy that would silently keep this machine's own control-room " +
        "path (source/installer have drifted; fix substitutePmGuardControlRoom " +
        "or the source constant together)",
    );
  }
  const value =
    params.profile === "solo-full"
      ? toPosixPath(params.controlRoomPath)
      : TEAM_LOCAL_CONTROL_ROOM_SENTINEL;
  // HYK-309 2R (REVIEW P1, install.mjs:803 pre-fix): a plain string
  // replacement (`` `$1${value}$3` ``) is re-scanned by String.replace for
  // ITS OWN special patterns ($$, $&, $`, $', $<n>) -- a controlRoomPath
  // containing e.g. "$&" got the ENTIRE MATCHED LINE spliced into the
  // installed value instead of the literal characters "$&" (reviewer's
  // exact repro: `control-$&-room` -> `control-export const
  // CONTROL_ROOM_ROOT = "...";-room`). A replacer FUNCTION's return value
  // is inserted verbatim, with no such reinterpretation -- switching to one
  // removes the entire bug class instead of escaping just "$&".
  //
  // Separately, and more severely: the value also has to survive being
  // embedded inside a JS double-quoted string literal. A raw `"` in the
  // value would terminate the string literal early and splice arbitrary
  // trailing text in as JS source (a real code-injection shape, not just a
  // display glitch); a raw `\` could form an unintended escape sequence or
  // swallow the closing quote; a raw newline is a SyntaxError inside a
  // plain (non-template) string literal. JSON.stringify's output is a
  // spec-valid JS string literal (its escaping rules are a strict subset of
  // JS's), so it closes all three at once instead of hand-escaping each.
  const literal = JSON.stringify(value);
  return content.replace(
    PM_GUARD_CONTROL_ROOM_LINE_RE,
    () => `export const CONTROL_ROOM_ROOT = ${literal};`,
  );
}

function installPmGuard(params, targetRepoPath, { dryRun }) {
  const srcPath = path.join(REPO_ROOT, "scripts", "check", "pm-guard.mjs");
  const destPath = path.join(
    targetRepoPath,
    "scripts",
    "check",
    "pm-guard.mjs",
  );
  // Same missing-source convention as copyRawFile (warn-skip, never throw)
  // -- e.g. nc-install-hook-wiring.test.mjs's mutation fixture runs a copy
  // of install.mjs from outside this repo, so REPO_ROOT doesn't resolve to
  // a real checkout and this source legitimately doesn't exist there.
  if (!existsSync(srcPath)) {
    console.warn(`source missing, skipping: ${srcPath}`);
    return;
  }
  // 치환설치 칸: pm-guard is the one file whose substituted line is compared
  // against the substituted expectation (never against the raw source).
  if (existsSync(destPath)) {
    const verdict = noteSkippedExisting(destPath, () =>
      substitutePmGuardControlRoom(readFileSync(srcPath, "utf8"), params),
    );
    substituted.push({ path: destPath, verdict });
    return;
  }
  const content = substitutePmGuardControlRoom(
    readFileSync(srcPath, "utf8"),
    params,
  );
  if (!dryRun) {
    ensureParentDir(destPath);
    writeFileSync(destPath, content, "utf8");
  }
  substituted.push({ path: destPath, verdict: "신규" });
  installed.push(destPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${destPath} (CONTROL_ROOM_ROOT substituted for this target)`,
  );
}

// HYK-209-frame-repair-1 ⓐ': single source of truth for the
// scripts/check/*.mjs copy list, exported so a repo test
// (templates/harness-init/install-copylist-closure.test.mjs) can read the
// EXACT list this installer copies and statically verify it is
// import-closed, instead of a hand-maintained list drifting from a
// regex-scraped guess of it. Do not add a name here without also adding its
// .test.mjs pair unless that pair does not exist in this repo (a few
// *-core.mjs / *-registry.mjs files below have no dedicated test file --
// this mirrors the pre-existing pm-guard.mjs convention of "some names in
// this list are prod-only").
//
// Same sequential-comment sections as the pre-refactor loop -- see git
// blame / HYK-186 for why time-authority.mjs, done-line-write-guard.mjs
// exist here; this round (HYK-209-frame-repair-1) adds three more sections:
// ⓐ (stop-blocking/reject-streak, the third instance of this exact class of
// gap) and X-1 (the 9 dispatch-worker.ps1 + 3 CI hard-dependencies ORCH-73
// found missing on a real installed target).
export const ENFORCEMENT_CHECK_FILES = [
  "review-gate.mjs",
  "review-gate.test.mjs",
  "relay-handshake.mjs",
  "relay-handshake.test.mjs",
  // HYK-186 1R: relay-handshake.mjs imports "./time-authority.mjs" (the
  // future-skew registry) -- without a copy alongside it, an installed
  // relay-handshake.mjs fails to even load (MODULE_NOT_FOUND) on a fresh
  // target repo. Never caught before this round because no installer
  // test had ever actually run the copied file.
  "time-authority.mjs",
  "time-authority.test.mjs",
  "role-guard.mjs",
  "role-guard.test.mjs",
  // HYK-186 3R P1-1: the PreToolUse entry above now references this file
  // -- it must be copied or the wired hook command fails on every
  // Edit/Write/MultiEdit (MODULE_NOT_FOUND, same class of gap as
  // time-authority.mjs's above).
  "done-line-write-guard.mjs",
  "done-line-write-guard.test.mjs",
  "context-inject.mjs",
  "context-inject.test.mjs",
  "status-fresh.mjs",
  "status-fresh.test.mjs",
  "clear-safe-check.mjs",
  "clear-safe-check.test.mjs",
  "controlroom-fresh.mjs",
  "controlroom-fresh.test.mjs",
  "path-normalize.mjs",
  "path-normalize.test.mjs",
  // pm-guard.mjs is NOT copied raw here -- installPmGuard below rewrites
  // its CONTROL_ROOM_ROOT constant for this target first (HYK-309).
  "pm-guard.test.mjs",
  "packet-gate.mjs",
  "packet-gate.test.mjs",
  "worker-status-onstart.mjs",
  "worker-status-onstart.test.mjs",
  // HYK-209-frame-repair-1 ⓐ: clear-safe-check.mjs and controlroom-fresh.mjs
  // (both already in this list, above) import "./stop-blocking.mjs";
  // relay-handshake.mjs's review-gate/finalize-done path imports
  // "./reject-streak.mjs". Neither was ever copied -- the third occurrence
  // of the exact "installed relay/gate script MODULE_NOT_FOUND on a fresh
  // target" class of gap as time-authority.mjs and done-line-write-guard.mjs
  // above. See install-copylist-closure.test.mjs for the machine check that
  // is meant to prevent a fourth occurrence.
  "stop-blocking.mjs",
  "stop-blocking.test.mjs",
  "reject-streak.mjs",
  "reject-streak.test.mjs",
  // HYK-209-frame-repair-1 X-1: dispatch-worker.ps1 (control-room side,
  // not touched by this round) requires these 5 (relay-handshake.mjs
  // above is the dispatch-worker.ps1 dependency already installed; the
  // other 8 of its 9 were entirely missing per ORCH-73's 2026-09-17
  // real-target measurement) plus their transitive relative imports.
  "dispatch-gate-decision.mjs",
  "dispatch-gate-decision.test.mjs",
  "dispatch-arg-contract.mjs",
  "dispatch-arg-contract.test.mjs",
  "hyk400-receiver-guard.mjs",
  "hyk400-receiver-guard.test.mjs",
  "seat-engine-detect.mjs",
  "seat-engine-detect.test.mjs",
  "seat-proof-wrapper-shape.mjs",
  "seat-proof-wrapper-shape.test.mjs",
  // transitive: dispatch-gate-decision.mjs -> {dropped-at-stamp-core,
  // consumption-receipt-core, abort-record-core,
  // retirement-block-reason-shared, seat-origin-warn}.mjs;
  // consumption-receipt-core.test.mjs -> dispatch-gate-decision-core.mjs;
  // dispatch-arg-contract.mjs -> dispatch-arg-contract-core.mjs ->
  // dispatch-arg-contract-registry.mjs. seat-origin-warn.mjs itself ->
  // seat-origin-registry.mjs (one more hop). Review 1R P1 (HYK-460): this
  // exact class of gap (a listed file's own import goes uncopied) recurring
  // an 8th time -- seat-origin-warn.mjs has no .test.mjs sibling (none
  // exists on disk) so only the .mjs is added for it; seat-origin-registry
  // .mjs does have one, added as a pair per this list's own convention.
  "dropped-at-stamp-core.mjs",
  "seat-origin-warn.mjs",
  "seat-origin-registry.mjs",
  "seat-origin-registry.test.mjs",
  "consumption-receipt-core.mjs",
  "consumption-receipt-core.test.mjs",
  "abort-record-core.mjs",
  "abort-record-core.test.mjs",
  "retirement-block-reason-shared.mjs",
  "retirement-block-reason-shared.test.mjs",
  "dispatch-gate-decision-core.mjs",
  "dispatch-gate-decision-core.test.mjs",
  "dispatch-arg-contract-core.mjs",
  "dispatch-arg-contract-core.test.mjs",
  "dispatch-arg-contract-registry.mjs",
  // HYK-209-frame-repair-1 X-1: CI's enforce.yml calls 3 files directly --
  // all 3 were missing on a real installed target (ORCH-73). Only 2 of the
  // 3 are added here (isolated-suite-runner.mjs, quality-check.mjs) --
  // hook-sync-check.mjs is DELIBERATELY LEFT OUT, see the honesty-limit
  // block right below for why.
  "isolated-suite-runner.mjs",
  "isolated-suite-runner.test.mjs",
  "quality-check.mjs",
  "quality-check.test.mjs",
  // ★정직 한계 (HYK-209-frame-repair-1, discovered live by
  // harness-init-install-portability.test.mjs going RED when this round
  // first tried to add hook-sync-check.mjs): hook-sync-check.mjs statically
  // imports sha256Hex from "./selfcheck-inventory.mjs" (ⓐ' closure
  // requires it), but selfcheck-inventory.mjs's own invokedDirectly CLI
  // block hardcodes `process.env.HARNESS_CONTROL_ROOM_PATH || "D:/문서관리/
  // 하네스-관제실"` (this machine's OWN live control-room path) as its
  // fallback default -- selfcheck-inventory.mjs is one of the exact files
  // installUnattendedLayerManifest's own header already names as
  // intentionally NOT installed by this installer ("scripts/check/{linear-
  // sync,pm-guard,selfcheck,selfcheck-inventory}.mjs" -- the "unattended
  // layer", not yet made installer-safe). Adding hook-sync-check.mjs here
  // would transitively ship that live hardcode into every solo-full
  // target, exactly the class of leak X-2 (control-room folder/ledger
  // separation) in THIS SAME round exists to prevent elsewhere -- shipping
  // it to close a checklist item would be self-defeating. Unlike pm-guard
  // .mjs (a clean top-level `const CONTROL_ROOM_ROOT = "...";` declaration
  // substitutePmGuardControlRoom can safely rewrite), selfcheck-
  // inventory.mjs's hardcode is an inline `||` fallback inside a CLI
  // argument-parsing block -- giving it the same substitution treatment is
  // real, additional work this round's task did not scope. So: 2 of the
  // 3 named CI files are added; hook-sync-check.mjs stays out until either
  // (a) selfcheck-inventory.mjs's hardcode gets the same install-time
  // substitution pm-guard.mjs already has, or (b) ORCH accepts shipping it
  // with the hardcode intact (not recommended). CI (.github/workflows/
  // enforce.yml) itself already calls hook-sync-check.mjs, so an installed
  // solo-full target's CI will still red on this specific file until this
  // is resolved -- a real, known gap, not silently closed.
  // HYK-209-frame-repair-1 ⓐ': the closure check below found these THREE
  // pre-existing gaps -- review-gate.mjs imports envelope-archive.mjs and
  // review-approval-binding.mjs; relay-handshake.test.mjs imports
  // relay-handshake-fixture-siblings.mjs -- none were ever in the copy list
  // before this round, despite predating it (this is exactly the class of
  // gap ⓐ' exists to catch mechanically instead of relying on someone
  // noticing by hand).
  "envelope-archive.mjs",
  "envelope-archive.test.mjs",
  "review-approval-binding.mjs",
  "review-approval-binding.test.mjs",
  "relay-handshake-fixture-siblings.mjs",
  // HYK-209-frame-repair-1 ⓐ': deeper transitive gaps the closure check's
  // multi-line-import-aware regex (see install-copylist-closure.test.mjs's
  // RELATIVE_IMPORT_RE comment) found once run to full transitive fixpoint
  // -- an earlier, single-line-only version of that regex missed all of
  // these (they sit inside multi-line `import {...} from "./x.mjs"`
  // blocks), which is itself the reason this list went through two rounds
  // of "closed" before actually reaching closure.
  "child-probe-timeout-policy.mjs",
  "child-probe-timeout-policy.test.mjs",
  "admission-ledger-env-isolation.mjs",
  "admission-ledger-env-isolation.test.mjs",
  "retirement-record-core.mjs",
  "retirement-record-core.test.mjs",
  "reject-streak-chain.mjs",
  "reject-streak-chain.test.mjs",
  "seat-proof-wrapper-behavior.mjs",
  "seat-proof-wrapper-fixtures.mjs",
  "runner-receipt-writer.mjs",
  "runner-receipt-writer.test.mjs",
  // HYK-209-frame-repair-1 ⓐ': cross-directory relative import
  // ("../check/first-observation.mjs" from scripts/relay/finalize-done.mjs)
  // -- this round's first single-line-only closure regex also missed
  // every "../check/..." / "../relay/..." cross-directory specifier, not
  // just multi-line same-directory ones; see install-copylist-closure
  // .test.mjs's RELATIVE_IMPORT_RE comment for the final, cross-directory-
  // aware version.
  "first-observation.mjs",
  "first-observation.test.mjs",
];

// HYK-209-frame-repair-1 X-1: the scripts/relay/*.mjs copy list, same
// closure-tested single-source-of-truth treatment as ENFORCEMENT_CHECK_FILES
// above. finalize-done.mjs/.test.mjs were the pre-existing pair (HYK-186 3R
// P1-1); the three dispatch-worker.ps1 targets below and their one
// transitive test-fixture dependency are new this round.
export const ENFORCEMENT_RELAY_FILES = [
  // HYK-186 3R P1-1: done-line-write-guard.mjs's whole purpose is to point
  // a blocked worker at `node scripts/relay/finalize-done.mjs <role>
  // .harness` -- that target must exist on the installed repo too, or the
  // guard's own redirect instruction is dead on a fresh install (scripts/
  // relay/ was never copied by this installer at all before this round).
  "finalize-done.mjs",
  "finalize-done.test.mjs",
  "dispatch-receipt-cli.mjs",
  "dispatch-receipt-cli.test.mjs",
  "dispatch-worker-modal-check.mjs",
  "dispatch-worker-modal-check.test.mjs",
  // transitive: dispatch-worker-modal-check.test.mjs imports SAMPLES from
  // this fixture-shaped test file (no plain .mjs counterpart -- it is
  // itself the leaf).
  "hyk271-axis-preview-marker-synthetic.test.mjs",
  "dispatch-worker-seat-proof-gate.mjs",
  "dispatch-worker-seat-proof-gate.test.mjs",
  // HYK-209-frame-repair-1 ⓐ': transitive closure fixpoint (same story as
  // ENFORCEMENT_CHECK_FILES's own trailing block above).
  "hyk271-marker-catalog-real-corpus.test.mjs",
  "seat-proof-cli.mjs",
  "seat-proof-cli.test.mjs",
  "hyk171-cycle4b2c-fixtures.mjs",
  "dispatch-bound-seat-proof.mjs",
  "dispatch-bound-seat-proof.test.mjs",
];

// HYK-209-installer-closure-derive-1 (2R): the scripts/supervisor/*.mjs copy
// list. Closure-tested by install-copylist-closure.test.mjs alongside the two
// lists above, but copied to scripts/supervisor/<name> -- NOT to
// scripts/check or scripts/relay -- because derive-claude-project-dir-cli.mjs
// decides whether it is the real entry point by
// endsWith("scripts/supervisor/derive-claude-project-dir-cli.mjs"); a wrong
// install path would make that CLI refuse to run. Exactly these two files:
// the CLI and its one relative import (rate-limit-stall-adapter.mjs, the
// canonical deriveClaudeProjectDirName). HYK-209-installer-admission-closure-1
// (E7-2 1R-b): admission-cli.mjs is the by-path admission gate the control-room
// dispatch pipeline calls (docs/control-room-patches/HYK-256-...); without it
// on the target, delivery is refused (ADMISSION_CLI_MISSING). Its static
// relative imports are exactly the three below (fixpoint: none of them import
// another "./X.mjs"). concurrency-cap.json is a VALUE file and is deliberately
// NOT copied here -- a separate scope decision. Any other scripts/supervisor/*
// file is still a separate scope decision, not added here.
export const ENFORCEMENT_SUPERVISOR_FILES = [
  "derive-claude-project-dir-cli.mjs",
  "rate-limit-stall-adapter.mjs",
  "admission-cli.mjs",
  "admission-ledger-core.mjs",
  "admission-ledger-store.mjs",
  "concurrency-cap-adapter.mjs",
];

// Presence requirement, not an import-closure rule: the 관제실 dispatch
// pipeline (dispatch-worker.ps1, outside this repo) invokes
// derive-claude-project-dir-cli.mjs BY PATH, and nothing in this repo imports
// it -- so the import-closure check alone cannot see its absence. Every name
// here must appear in ENFORCEMENT_SUPERVISOR_FILES.
export const ENFORCEMENT_SUPERVISOR_REQUIRED = [
  "derive-claude-project-dir-cli.mjs",
];

// (repo source, installed destination) pairs for ENFORCEMENT_SUPERVISOR_FILES.
// Exported so the path contract is testable without running the installer.
export function supervisorCopyPairs(targetRepoPath) {
  return ENFORCEMENT_SUPERVISOR_FILES.map((name) => ({
    src: path.join(REPO_ROOT, "scripts", "supervisor", name),
    dst: path.join(targetRepoPath, "scripts", "supervisor", name),
  }));
}

// Extracted from main() (quality-check: keeps main()'s own line-count/
// complexity under the repo's ESLint ceiling) -- copies the local git hooks
// plus every scripts/check/scripts/relay/scripts/supervisor file that hook
// wiring and the supervisor entry point depend on.
// Both profiles get these; they are local-only (no server dependency).
function installEnforcementScripts(params, targetRepoPath, { dryRun }) {
  copyRawFile(
    path.join(REPO_ROOT, "hooks", "commit-msg"),
    path.join(targetRepoPath, "hooks", "commit-msg"),
    { dryRun, executable: true },
  );
  copyRawFile(
    path.join(REPO_ROOT, "hooks", "pre-commit"),
    path.join(targetRepoPath, "hooks", "pre-commit"),
    { dryRun, executable: true },
  );
  for (const name of ENFORCEMENT_CHECK_FILES) {
    copyRawFile(
      path.join(REPO_ROOT, "scripts", "check", name),
      path.join(targetRepoPath, "scripts", "check", name),
      { dryRun, executable: false },
    );
  }
  installPmGuard(params, targetRepoPath, { dryRun });
  for (const name of ENFORCEMENT_RELAY_FILES) {
    copyRawFile(
      path.join(REPO_ROOT, "scripts", "relay", name),
      path.join(targetRepoPath, "scripts", "relay", name),
      { dryRun, executable: false },
    );
  }
  for (const { src, dst } of supervisorCopyPairs(targetRepoPath)) {
    copyRawFile(src, dst, { dryRun, executable: false });
  }
}

// Extracted from main() (quality-check: keeps main()'s own line-count/
// complexity under the repo's ESLint ceiling) -- the profile-agnostic
// template writes + gitignore append + AGENTS.md append every install gets.
function installProfileAgnosticCore(params, targetRepoPath, map, { dryRun }) {
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "status.template.md"),
    path.join(targetRepoPath, ".harness", "STATUS.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "phase-handoff.template.md"),
    path.join(targetRepoPath, ".harness", "PHASE-HANDOFF.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "project-context.template.md"),
    path.join(targetRepoPath, ".harness", "PROJECT-CONTEXT.md"),
    map,
    { dryRun },
  );
  // HYK-209-frame-repair-1 ⓑ: context-inject.test.mjs (copied above via
  // ENFORCEMENT_CHECK_FILES) reads this RAW (unsubstituted) template file
  // itself via a relative path
  // ("../../templates/harness-init/project-context.template.md") to test
  // against the real placeholder shape rather than a hand-copied string
  // (see that test file's own header comment for why -- it is deliberate:
  // a regression in the template's placeholder shape must break this test
  // too). Only the SUBSTITUTED copy above (.harness/PROJECT-CONTEXT.md) was
  // ever installed before this round, so an installed target had no
  // templates/ folder at all and that test failed with ENOENT (2 failures,
  // §ⓑ). Bundling the raw template alongside is the "템플릿 동봉" option
  // named in this round's task -- it keeps the test's real detection power
  // (still reads and substitutes the actual template) instead of trading it
  // away for a skip or a hand-copied fixture string.
  copyRawFile(
    path.join(TEMPLATES_DIR, "project-context.template.md"),
    path.join(
      targetRepoPath,
      "templates",
      "harness-init",
      "project-context.template.md",
    ),
    { dryRun, executable: false },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "verify.sh.template"),
    path.join(targetRepoPath, "verify.sh"),
    map,
    { dryRun, executable: true },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "observe.sh.template"),
    path.join(targetRepoPath, "observe.sh"),
    map,
    { dryRun, executable: true },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "gc-task.template.md"),
    path.join(targetRepoPath, ".harness", "gc-task.template.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "gate-criteria.template.md"),
    path.join(targetRepoPath, ".harness", "gate-criteria.md"),
    map,
    { dryRun },
  );
  writeTemplateFile(
    path.join(TEMPLATES_DIR, "skill", "capture-context", "SKILL.md"),
    path.join(
      targetRepoPath,
      ".claude",
      "skills",
      "capture-context",
      "SKILL.md",
    ),
    map,
    { dryRun },
  );
  appendGitignoreBlock(params.profile, targetRepoPath, { dryRun });
  if (params.profile === "solo-full") {
    // team-local: AGENTS.md (or an equivalent project-instruction file) is
    // shared, committed team state — appending personal harness rules to it
    // would impose this account's tooling on the team repo, exactly what
    // HYK-92 says not to do. solo-full owns its own repo, so appending
    // there is fine.
    appendAgentsFile(targetRepoPath, { dryRun });
  } else {
    console.log(
      "team-local profile: skipping AGENTS.md append (shared team file — not this account's to change).",
    );
  }
}

// installControlRoomFolder -- HYK-209-frame-repair-1 X-2: ORCH-73 measured
// (2026-09-17, editor repo) that installAdmissionLedgerPointer / install
// DispatchReceiptPointer below only ever write a POINTER file inside the
// target repo's .harness/ -- the folder those pointers name
// (params.controlRoomPath itself) was never created by this installer, and
// neither were the admission-ledger.json / dispatch-receipts.jsonl files
// the pointers point at. A freshly-installed target's ledger/receipt
// therefore point at a directory that does not exist. solo-full only
// (team-local has no control room -- see validateParams). Idempotent: an
// existing folder or file is left completely untouched, same
// skip-if-exists convention as every other install* function here -- never
// re-initializes a ledger that already has real reservations in it.
//
// Separation from this (the harness's own) control room is structural, not
// a runtime check: every path this function touches is derived from
// params.controlRoomPath (the target's OWN --control-room-path value) and
// nothing here ever reads or falls back to this repo's live control room
// path -- see install-copylist-closure.test.mjs's "control-room folder"
// group for the test that installs into one temp control-room path
// alongside an untouched sentinel file standing in for a second (this
// repo's real) control room, and asserts the sentinel is byte-identical
// afterward.
function installControlRoomFolder(params, targetRepoPath, { dryRun }) {
  const controlRoomPath = params.controlRoomPath;
  console.log(
    `${dryRun ? "[dry-run] would create" : "created (or already existed)"}: ${controlRoomPath}`,
  );
  // Best-effort, like copyRawFile's own "source missing" warn-skip above --
  // harness-init-install-portability.test.mjs exercises --control-room-path
  // values containing characters that are valid to embed as a STRING
  // LITERAL (its whole point: proving those characters survive intact into
  // pm-guard.mjs's rewritten source) but are not valid as a real path on
  // this OS (e.g. a literal `"` on Windows) -- mkdirSync would throw and
  // abort the entire install over a scenario nothing here can actually fix.
  // A controlRoomPath a real operator supplies should always be a real,
  // creatable directory; this catch exists for exactly that synthetic-
  // string-only test shape, not as a signal that failure here is expected
  // in production use.
  let controlRoomFolderReady = dryRun;
  if (!dryRun) {
    try {
      mkdirSync(controlRoomPath, { recursive: true });
      controlRoomFolderReady = true;
    } catch (err) {
      console.warn(
        `warning: could not create control-room folder '${controlRoomPath}' (${err.message}) -- admission-ledger.json / dispatch-receipts.jsonl will NOT be initialized this run; the two pointer files below are still written`,
      );
    }
  }
  if (!controlRoomFolderReady) return;

  const ledgerPath = path.join(controlRoomPath, "admission-ledger.json");
  if (existsSync(ledgerPath)) {
    console.warn(`skip (already exists): ${ledgerPath}`);
    // 검증 불가: 원장은 예약 상태를 담는 런타임 파일이라 기대 바이트가 한 값이
    // 아니다(epoch·예약 목록). 「상이」로 부르면 살아 있는 원장이 전부 거짓
    // 낡음으로 보인다.
    recordSkip(
      ledgerPath,
      "검증 불가",
      "런타임 원장 -- 예약 상태를 담으므로 기대 바이트가 없다",
    );
  } else {
    // Local copy of admission-ledger-core.mjs's createEmptyLedger() shape
    // ({schema_version, epoch, reservations: {}}), NOT a static import of
    // that file -- same "로컬 복제" convention already used throughout this
    // repo for admission-completion-adapter.mjs's siblings (see e.g.
    // reject-streak.mjs / relay-handshake.mjs's own header comments on why
    // they duplicate rather than import). A static import here would make
    // install.mjs itself depend on scripts/supervisor/ resolving at
    // MODULE LOAD time -- nc-install-hook-wiring.test.mjs's mutation test
    // runs a copy of install.mjs from a throwaway directory with no
    // scripts/supervisor/ beside it at all, and unlike copyRawFile's
    // graceful warn-skip for a missing REPO_ROOT source, a missing static
    // import target throws before main() ever runs. ADMISSION_SCHEMA_
    // VERSION must match admission-ledger-core.mjs's own constant exactly
    // -- isWellFormedLedger() there is the reader that would reject a
    // drifted value.
    const ledger = {
      schema_version: "admission-ledger/v1",
      epoch: new Date().toISOString(),
      reservations: {},
    };
    const content = `${JSON.stringify(ledger, null, 2)}\n`;
    if (!dryRun) {
      writeFileSync(ledgerPath, content, "utf8");
    }
    installed.push(ledgerPath);
    console.log(
      `${dryRun ? "[dry-run] would install" : "installed"}: ${ledgerPath}`,
    );
  }

  const receiptPath = path.join(controlRoomPath, "dispatch-receipts.jsonl");
  if (existsSync(receiptPath)) {
    console.warn(`skip (already exists): ${receiptPath}`);
    // 검증 불가: 영수증은 append-only 런타임 로그다 -- 기대 바이트는 빈 파일이
    // 아니라 「지금까지 쌓인 내용」이라 한 값으로 비교할 수 없다.
    recordSkip(
      receiptPath,
      "검증 불가",
      "런타임 누적 로그(append-only) -- 기대 바이트가 없다",
    );
  } else {
    if (!dryRun) {
      writeFileSync(receiptPath, "", "utf8");
    }
    installed.push(receiptPath);
    console.log(
      `${dryRun ? "[dry-run] would install" : "installed"}: ${receiptPath}`,
    );
  }
}

// installAdmissionLedgerPointer -- HYK-227 2R §2/§3 항2 (한용 판정
// 2026-08-12 08:56): writes the persistent pointer file
// `admission-completion-adapter.mjs`'s `resolvePersistentLedgerPaths()`
// reads as its env-absent fallback. solo-full only -- team-local has no
// control room (no `controlRoomPath`), so there is no admission ledger to
// point at; the adapter's own no-op stays the whole story for that
// profile, unchanged from 1R.
//
// ★정직 한계 (§2-4, 미리 못 박은 그대로): this file write happens ONLY when
// install.mjs itself runs against a target repo. install.mjs has no
// automatic/scheduled/hooked invocation anywhere in this repo (confirmed:
// every reference to it in docs/harness-init.md is a documented CLI
// example for a human/agent to run by hand at bootstrap time) -- so for a
// repo that was already bootstrapped BEFORE this round (this repo itself
// included), this pointer file does not appear on its own. It requires
// one manual re-run of install.mjs against that target (idempotent and
// safe: writeTemplateFile-style skip-if-exists means a re-run only adds
// files that are still missing, never overwrites anything already there).
function installAdmissionLedgerPointer(params, targetRepoPath, { dryRun }) {
  const pointerPath = path.join(
    targetRepoPath,
    ".harness",
    "admission-ledger-path.json",
  );
  const ledgerPath = joinPosix(params.controlRoomPath, "admission-ledger.json");
  const pointer = {
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
  };
  const content = `${JSON.stringify(pointer, null, 2)}\n`;
  if (existsSync(pointerPath)) {
    noteSkippedExisting(pointerPath, content);
    return;
  }
  if (!dryRun) {
    ensureParentDir(pointerPath);
    writeFileSync(pointerPath, content, "utf8");
  }
  installed.push(pointerPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${pointerPath}\n${content}`,
  );
}

// installDispatchReceiptPointer -- HYK-356 (합성 재현으로 기전 확정,
// coder-task.md §0/§4 항1): installAdmissionLedgerPointer(위)와 정확히
// 같은 모양의 짝 -- `orch-stall-detect.mjs`의
// resolveDispatchReceiptPathForUnconsumed()가 env(`DISPATCH_RECEIPT_PATH`)
// 다음 셋째 자리로 읽는 영속 포인터 파일 `dispatch-receipt-path.json`을
// 쓴다. ADMISSION_LEDGER_PATH에는 이미 이 셋째 자리가 있었는데
// DISPATCH_RECEIPT_PATH에는 없었다 -- 그 비대칭이 "영수증이 결과보다
// 새것인데도 SUSPECTED_UNCONSUMED"가 나오는 실측 헛울림의 기전이었다
// (env는 `dispatch-worker.ps1`가 매 배달 호출 프로세스 안에서만 잠깐
// 채우고, 이 축을 도는 장기 실행 감시 루프의 프로세스 환경에는 그 값이
// 없다).
//
// ★정직 한계(installAdmissionLedgerPointer 헤더와 동일 사유 재적용):
// install.mjs는 이 저장소 어디서도 자동/예약 실행되지 않는다 -- 이미
// 부트스트랩된 저장소(이 워크트리 포함)에 이 포인터 파일이 나타나려면
// 그 대상에 install.mjs를 한 번 더 수동으로 재실행해야 한다(멱등 --
// 이미 있는 파일은 건드리지 않는다). 그 재실행은 관제실 쪽 조치라 이
// 코더 라운드가 대신 실행하지 않는다(§5 비타협 3, 관제실 무접촉).
function installDispatchReceiptPointer(params, targetRepoPath, { dryRun }) {
  const pointerPath = path.join(
    targetRepoPath,
    ".harness",
    "dispatch-receipt-path.json",
  );
  const receiptPath = joinPosix(
    params.controlRoomPath,
    "dispatch-receipts.jsonl",
  );
  const pointer = { receiptPath };
  const content = `${JSON.stringify(pointer, null, 2)}\n`;
  if (existsSync(pointerPath)) {
    noteSkippedExisting(pointerPath, content);
    return;
  }
  if (!dryRun) {
    ensureParentDir(pointerPath);
    writeFileSync(pointerPath, content, "utf8");
  }
  installed.push(pointerPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${pointerPath}\n${content}`,
  );
}

// installUnattendedLayerManifest -- HYK-209-frame-1 §2 항2 ("설치기 «틀»
// 확장"). Writes `.harness/unattended-layer-placeholders.json`: the five
// new placeholder values (validated above, never silently defaulted) plus
// an honest `knownGaps` list of the source hardcodes they mirror and the
// two hardcodes found during this round that have NO placeholder yet
// (scheduler task name, concurrency cap value) because they live in code
// this round is not allowed to touch (§3 "본체 동작 변경 0").
//
// ★정직 한계, stated once here and not repeated at every call site: this
// manifest is a record of what a FUTURE assembly round needs, not an
// install of the unattended layer itself. None of the files this manifest
// cites (scripts/supervisor/*, scripts/relay/adapters/orca-adapter.mjs,
// scripts/check/{linear-sync,selfcheck,selfcheck-inventory}.mjs,
// scripts/supervisor/approver-allowlist.json) is copied by this installer,
// with two exceptions. The first: the files in ENFORCEMENT_SUPERVISOR_FILES
// (derive-claude-project-dir-cli.mjs and its rate-limit-stall-adapter.mjs
// import) now are, added by HYK-209-installer-closure-derive-1 (2R). The
// second: pm-guard.mjs, which installPmGuard copies separately (control-room
// path substituted), not through any list above. Everything else
// this manifest cites is still not copied, so a repo installed today with
// this manifest present has only those two supervisor files of the
// unattended/parallel layer, and none of the rest. solo-full only:
// team-local has no control room, no scheduler, no PM lane, so it has no
// unattended layer for this manifest
// to describe.
// buildSourceHardcodes/buildKnownGaps -- extracted from
// installUnattendedLayerManifest (ESLint max-lines-per-function ceiling);
// pure data, no behavior. See that function's own header for what this
// data means and its honesty boundary.
function buildSourceHardcodes() {
  return [
    {
      placeholder: "NOTIFY_DIR",
      file: "scripts/supervisor/reach-report.mjs",
      line: 49,
      constant: "DEFAULT_NOTIFY_DIR",
    },
    {
      placeholder: "APPROVER_LOGIN / APPROVER_ID",
      file: "scripts/supervisor/approver-allowlist.json",
      line: 4,
      constant: "approvers[].login / approvers[].id",
    },
    {
      placeholder: "WORKSPACES_ROOT",
      file: "scripts/relay/adapters/orca-adapter.mjs",
      line: 158,
      constant: "WORKSPACES_ROOT",
    },
    {
      placeholder: "MAIN_REPO_PATH",
      file: "scripts/relay/adapters/orca-adapter.mjs",
      line: 159,
      constant: "MAIN_REPO_PATH",
    },
    {
      placeholder: "(also CONTROL_ROOM_PATH, already an existing token)",
      file:
        "scripts/check/linear-sync.mjs:8, scripts/check/pm-guard.mjs:10, " +
        "scripts/check/selfcheck.mjs:90,144, scripts/check/selfcheck-inventory.mjs:1021, " +
        "scripts/relay/adapters/orca-adapter.mjs:161",
      line: null,
      constant:
        "DEFAULT_STATUS_PATH / CONTROL_ROOM_ROOT / controlRoomPath default / CONTROL_ROOM_PATH",
    },
    {
      placeholder:
        "SEAT_LAUNCHER_PATH (derivable: <CONTROL_ROOM_PATH>/orca-worker-seat.ps1)",
      file: "scripts/relay/adapters/orca-adapter.mjs",
      line: 141,
      constant: "SEAT_LAUNCHER_PATH",
    },
  ];
}

function buildKnownGaps() {
  return [
    {
      item: "schedule task name",
      file: "scripts/supervisor/schedule-plan-core.mjs",
      line: 87,
      constant: "TASK_NAME",
      value: "HARNESS\\OrchStallWatch",
      gap: "고정 문자열(§2-3 자기 주석: '이 감시자 하나만 등록하는 고정 이름') -- 자리표가 아니다. 같은 계정에 두 저장소를 이식하면 schtasks 작업 이름이 충돌한다. 이번 라운드는 고치지 않는다(§3 '본체 동작 변경 0' -- schedule-plan-core.mjs는 scripts/ 산하 강제 장치).",
    },
    {
      item: "concurrency admission cap",
      file: "scripts/supervisor/concurrency-cap.json",
      line: 3,
      constant: "global_hard_cap",
      value: 2,
      gap: "커밋된 값 파일(코드 상수는 아니다, concurrency-cap-adapter.mjs가 fail-closed로 읽음)이지만 install.mjs는 scripts/supervisor/* 중 ENFORCEMENT_SUPERVISOR_FILES 두 개 외에는 복사하지 않으므로 이 파일 자체가 이식 대상 밖이다. 값의 출처는 한용(PKT-20260807-SUPERVISOR-CONCURRENCY-ADDENDUM-V1 S-5)이지 이 설치기가 아니다.",
    },
  ];
}

function installUnattendedLayerManifest(params, targetRepoPath, { dryRun }) {
  const manifestPath = path.join(
    targetRepoPath,
    ".harness",
    "unattended-layer-placeholders.json",
  );
  const manifest = {
    note: "이 파일이 존재해도 무인·병렬 층(scripts/supervisor/* 중 derive-claude-project-dir-cli.mjs·rate-limit-stall-adapter.mjs 두 개를 뺀 나머지, scripts/relay/adapters/orca-adapter.mjs 등)은 이 저장소에 설치되지 않았다 -- install.mjs는 그 나머지 파일들을 아직 복사하지 않는다(HYK-209 §3 '내용물 조립 0'). 이 값들은 그 조립 단계가 실제로 시작될 때 쓰일 자리표 값의 기록일 뿐이다.",
    placeholders: {
      NOTIFY_DIR: params.notifyDir,
      APPROVER_LOGIN: params.approverLogin,
      APPROVER_ID: params.approverId,
      WORKSPACES_ROOT: params.workspacesRoot,
      MAIN_REPO_PATH: params.mainRepoPath,
    },
    sourceHardcodes: buildSourceHardcodes(),
    knownGaps: buildKnownGaps(),
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existsSync(manifestPath)) {
    noteSkippedExisting(manifestPath, content);
    return;
  }
  if (!dryRun) {
    ensureParentDir(manifestPath);
    writeFileSync(manifestPath, content, "utf8");
  }
  installed.push(manifestPath);
  console.log(
    `${dryRun ? "[dry-run] would install" : "installed"}: ${manifestPath}\n${content}`,
  );
}

// HYK-209-installer-report-axis-1 축 C (1-3): 「설치기 목록 밖 손이식」 보고.
// A file this installer does NOT copy (in no list and no branch) that the target
// tracks under the SAME relative path as this harness's own source -- a byte
// hand-transplant (승계 규율 12). REPORT ONLY: this scan never writes, and what
// it finds is never added to a copy list (편입·갱신은 책임자 판정 · 다음 라운드).
const TRANSPLANT_SCAN_DIRS = [
  "scripts/check",
  "scripts/relay",
  "scripts/supervisor",
];

// Names this installer covers in each dir (by list or by a dedicated branch).
function installerCoveredNames(dirRel) {
  if (dirRel === "scripts/check") {
    // pm-guard.mjs is written by installPmGuard, not by a list.
    return new Set([...ENFORCEMENT_CHECK_FILES, "pm-guard.mjs"]);
  }
  if (dirRel === "scripts/relay") return new Set(ENFORCEMENT_RELAY_FILES);
  return new Set(ENFORCEMENT_SUPERVISOR_FILES);
}

function isKindAt(p, kind) {
  try {
    const st = statSync(p);
    return kind === "file" ? st.isFile() : st.isDirectory();
  } catch {
    return false;
  }
}

// true / false when git can say whether `rel` is tracked in the target, null
// when git cannot answer (target has no .git directory, or git is not runnable).
// null makes the caller fall back to plain file existence and say so.
function gitTracksFile(targetRepoPath, rel) {
  if (!isKindAt(path.join(targetRepoPath, ".git"), "dir")) return null;
  try {
    const out = execFileSync(
      "git",
      ["-C", targetRepoPath, "ls-files", "--", rel],
      { encoding: "utf8" },
    );
    return out.trim() !== "";
  } catch {
    return null;
  }
}

function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function compareWithSource(targetFile, sourceFile) {
  try {
    return sha256Of(targetFile) === sha256Of(sourceFile) ? "동일" : "상이";
  } catch {
    return "검증 불가";
  }
}

// Returns [{ rel, verdict, basis }] -- every tracked-or-present harness-named
// file in the three scanned dirs that the installer does not cover.
function scanOutOfListTransplants(targetRepoPath) {
  const found = [];
  for (const dirRel of TRANSPLANT_SCAN_DIRS) {
    const srcDir = path.join(REPO_ROOT, ...dirRel.split("/"));
    if (!isKindAt(srcDir, "dir")) continue;
    const covered = installerCoveredNames(dirRel);
    for (const name of readdirSync(srcDir).sort()) {
      const rel = `${dirRel}/${name}`;
      const sourceFile = path.join(srcDir, name);
      const targetFile = path.join(targetRepoPath, ...rel.split("/"));
      if (covered.has(name) || !isKindAt(sourceFile, "file")) continue;
      if (!isKindAt(targetFile, "file")) continue;
      const tracked = gitTracksFile(targetRepoPath, rel);
      // Untracked in a git target: a stray local file, not a tracked transplant.
      if (tracked === false) continue;
      found.push({
        rel,
        verdict: compareWithSource(targetFile, sourceFile),
        basis:
          tracked === null
            ? "실재(git 추적 판정 불가 -- 파일 존재로 대신함)"
            : "git 추적",
      });
    }
  }
  return found;
}

// The 다섯 칸 report (+ the out-of-list block). Pure output: the same call on
// --dry-run and on a real run prints the same sets. Header strings are part of
// the contract the installer tests parse -- change them only together with
// those tests.
function printFiveCellReport(transplants) {
  const inDiffering = (p) => differing.includes(p);
  const inUnverifiable = (p) => unverifiable.some((u) => u.path === p);
  const same = skipped.filter((p) => !inDiffering(p) && !inUnverifiable(p));
  const section = (header, lines) => {
    console.log(`${header} (${lines.length}):`);
    for (const line of lines) console.log(`  ${line}`);
  };
  console.log("\n--- 다섯 칸 보고 (HYK-209-installer-report-axis-1) ---");
  section(
    "신규",
    installed.map((p) => `+ ${p}`),
  );
  section(
    "동일",
    same.map((p) => `= ${p}`),
  );
  section(
    "상이 — 갱신하지 않음",
    differing.map((p) => `! ${p}`),
  );
  section(
    "치환설치 (pm-guard 한 줄 치환 후 기대 바이트 기준)",
    substituted.map((s) => `~ ${s.path} :: ${s.verdict}`),
  );
  section(
    "검증 불가 (같다고도 다르다고도 말하지 않음)",
    unverifiable.map((u) => `? ${u.path} :: ${u.reason}`),
  );
  section(
    "갱신(병합)",
    mergedFiles.map(
      (m) =>
        `* ${m.path} :: 추가: ${m.added.join(",")} · 보존 키: ${m.preserved.join(",") || "(없음)"}`,
    ),
  );
  // HYK-209-installer-update-flag-1: printed only when the flag is on, so a
  // flag-less run carries no extra section.
  if (runOpts.updateMismatched) {
    section(
      `갱신 (--update-mismatched · 상이 → 틀 값${runOpts.dryRun ? " · dry-run: 바이트 불변" : ""})`,
      updated.map(
        (u) =>
          `↻ ${u.path} :: ${u.before.slice(0, 12)} → ${u.after.slice(0, 12)}`,
      ),
    );
  }
  section(
    "설치기 목록 밖 손이식 — 설치기가 갱신하지 않음",
    transplants.map((t) => `◇ ${t.rel} :: ${t.verdict} · ${t.basis}`),
  );
}

// HYK-209-installer-update-flag-1: the update manifest -- the only input --rollback
// reads. HYK-209-installer-rollback-gaps-1 (숙제 2): it is rewritten after EVERY
// replacement entry (called from replaceMismatched, before the target changes),
// so a run that dies mid-way still leaves a manifest for every cell it reached.
// Each rewrite goes to a temp file and is renamed over the old one, so a death
// during the write leaves the previous complete manifest, never a torn file.
function writeUpdateManifest() {
  const file = path.join(
    runOpts.targetRepoPath,
    ".harness",
    `install-update-${runOpts.stamp}.manifest.json`,
  );
  if (!manifestAt) manifestAt = new Date().toISOString();
  if (manifestInstaller === undefined) {
    try {
      manifestInstaller = execFileSync(
        "git",
        ["-C", REPO_ROOT, "rev-parse", "HEAD"],
        {
          encoding: "utf8",
        },
      ).trim();
    } catch {
      // best-effort: the installer may run outside a git checkout
      manifestInstaller = null;
    }
  }
  const manifest = {
    schema: UPDATE_MANIFEST_SCHEMA,
    at: manifestAt,
    installer: manifestInstaller,
    target: runOpts.targetRepoPath,
    entries: updated.map((u) => ({
      rel: u.rel,
      path: u.path,
      before_sha256: u.before,
      after_sha256: u.after,
      backup: u.backup,
    })),
  };
  ensureParentDir(file);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  if (!manifestAnnounced) {
    console.log(`update manifest: ${file}`);
    manifestAnnounced = true;
  }
}

// HYK-209-installer-update-flag-1: `--rollback <manifest>`. Each entry is
// judged alone and fail-closed: a file whose current bytes are neither the
// after-value (restore it) nor the before-value (already restored) is refused
// and left as it is; a restore is verified by sha256 before it is reported.
// Returns the exit code (1 if any entry was refused).
function runRollback(manifestPath, { dryRun }) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== UPDATE_MANIFEST_SCHEMA) {
    throw new Error(
      `not an installer update manifest (schema=${manifest.schema ?? "<missing>"}): ${manifestPath}`,
    );
  }
  let refused = 0;
  for (const e of manifest.entries) {
    const cur = existsSync(e.path) ? sha256Buffer(readFileSync(e.path)) : null;
    if (cur === e.before_sha256) {
      console.log(`already at pre-update value: ${e.path}`);
      continue;
    }
    if (cur !== e.after_sha256) {
      refused++;
      console.log(
        `refused (현재 내용이 갱신 직후 값과 다르다 -- 손대지 않음): ${e.path}`,
      );
      continue;
    }
    if (!existsSync(e.backup) || sha256Of(e.backup) !== e.before_sha256) {
      refused++;
      console.log(`refused (백업이 없거나 원본 sha256 과 다르다): ${e.backup}`);
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] would restore: ${e.path}`);
      continue;
    }
    copyFileSync(e.backup, e.path);
    if (sha256Of(e.path) !== e.before_sha256) {
      refused++;
      console.log(`refused (복원 뒤 sha256 검증 실패): ${e.path}`);
      continue;
    }
    console.log(`restored: ${e.path}`);
  }
  console.log(
    `rollback: ${manifest.entries.length - refused} ok, ${refused} refused`,
  );
  return refused ? 1 : 0;
}

// `--rollback <manifest>` replaces the install entirely (no install params
// needed). Returns true when it handled the run.
function handleRollback(argv) {
  const raw = parseArgs(argv);
  if (!raw.rollback) return false;
  process.exitCode = runRollback(path.resolve(raw.rollback), {
    dryRun: !!raw.dryRun,
  });
  return true;
}

// Run-scoped options, set once before any file is touched.
function startRun(params) {
  if (!existsSync(params.repoPath)) {
    throw new Error(`repoPath does not exist: ${params.repoPath}`);
  }
  runOpts.dryRun = !!params.dryRun;
  runOpts.updateMismatched = !!params.updateMismatched;
  runOpts.targetRepoPath = params.repoPath;
  runOpts.stamp = stampNow();
  manifestAt = "";
  manifestInstaller = undefined;
  manifestAnnounced = false;
}

function main() {
  if (handleRollback(process.argv.slice(2))) return;
  const params = resolveParams(process.argv.slice(2));
  validateParams(params);
  const map = placeholderMap(params);
  const dryRun = !!params.dryRun;
  const targetRepoPath = params.repoPath;

  startRun(params);

  console.log(
    `\nharness-init install — profile=${params.profile} target=${targetRepoPath}${dryRun ? " [DRY RUN]" : ""}\n`,
  );

  // Profile-agnostic core.
  installProfileAgnosticCore(params, targetRepoPath, map, { dryRun });

  // Local enforcement hooks + check scripts: both profiles get these —
  // they are local-only (no server dependency) and useful whether or not
  // a server-side gate exists on top.
  installEnforcementScripts(params, targetRepoPath, { dryRun });

  // .git/hooks/ (per-clone, real install) and .claude/settings.local.json
  // (Claude Code hook pre-wiring) -- both profiles, both one-shot
  // completeness fixes for HYK-95. See installGitHooksIntoDotGit/
  // installSettingsLocal above for the exact conditions and merge rules.
  installGitHooksIntoDotGit(targetRepoPath, { dryRun });
  installSettingsLocal(params, targetRepoPath, { dryRun });

  if (params.profile === "team-local") {
    // HYK-100: pin this clone's push identity so it can't silently race
    // against a bot credential meant for a different repo. solo-full gets
    // a checklist item instead (soloFullChecklist below) -- see that
    // function and installCredentialBoundary's own comment for why the
    // two profiles are handled asymmetrically.
    installCredentialBoundary(targetRepoPath, { dryRun });
  }

  if (params.profile === "solo-full") {
    // HYK-209-frame-repair-1 X-2: the control-room folder + initial-empty
    // ledger/receipt files the two pointers below name -- must run BEFORE
    // the pointers so a human inspecting a fresh install finds a working
    // ledger, not a pointer to nothing. See installControlRoomFolder's own
    // header for scope/limits.
    installControlRoomFolder(params, targetRepoPath, { dryRun });

    // HYK-227 2R §3 항2: the persistent admission-ledger pointer file --
    // see installAdmissionLedgerPointer's own header for scope/limits.
    installAdmissionLedgerPointer(params, targetRepoPath, { dryRun });

    // HYK-356: the matching persistent dispatch-receipt-path pointer file --
    // see installDispatchReceiptPointer's own header for scope/limits.
    installDispatchReceiptPointer(params, targetRepoPath, { dryRun });

    // HYK-209-frame-1 §2 항2: record the five new unattended-layer
    // placeholder values (+ the two known gaps this round found but can't
    // place) — see installUnattendedLayerManifest's own header for limits.
    installUnattendedLayerManifest(params, targetRepoPath, { dryRun });

    // Server-side anchor: CI workflow + gitleaks ruleset. Never automated
    // past the file copy — branch protection, bot invite, and secret
    // scanning are one-time human steps in the GitHub web UI (checklist
    // below), per this repo's own B1 anchor precedent.
    copyRawFile(
      path.join(REPO_ROOT, ".github", "workflows", "enforce.yml"),
      path.join(targetRepoPath, ".github", "workflows", "enforce.yml"),
      { dryRun, executable: false },
    );
    const gitleaksToml = path.join(REPO_ROOT, ".gitleaks.toml");
    if (existsSync(gitleaksToml)) {
      copyRawFile(gitleaksToml, path.join(targetRepoPath, ".gitleaks.toml"), {
        dryRun,
        executable: false,
      });
    }
    const checklistPath = path.join(
      targetRepoPath,
      ".harness",
      "github-setup-checklist.md",
    );
    const checklist = soloFullChecklist(params);
    if (existsSync(checklistPath)) {
      noteSkippedExisting(checklistPath, checklist);
    } else {
      if (!dryRun) {
        ensureParentDir(checklistPath);
        writeFileSync(checklistPath, checklist, "utf8");
      }
      installed.push(checklistPath);
      console.log(
        `${dryRun ? "[dry-run] would install" : "installed"}: ${checklistPath}`,
      );
    }
    console.log("\n" + checklist);
  } else {
    console.log(
      "\nteam-local profile: no server-side setup — skipping GitHub checklist (no branch protection or CI to add on a shared team repo).",
    );
  }

  console.log(`\n--- summary ---`);
  console.log(`installed (${installed.length}):`);
  for (const f of installed) console.log(`  + ${f}`);
  console.log(`skipped, already existed (${skipped.length}):`);
  for (const f of skipped) console.log(`  = ${f}`);
  // HYK-209-installer-mismatch-report-1 축 B: the stale-file report. Printed on
  // dry-run too, so a human sees what is out of date before the install.
  console.log(`있지만 내용이 다름 — 갱신하지 않음 (${differing.length}):`);
  for (const f of differing) console.log(`  ! ${f}`);
  printFiveCellReport(scanOutOfListTransplants(targetRepoPath));
  console.log("");
}

// HYK-209-frame-repair-1: guard added so this file can be `import`ed (to
// read the exported copy-list arrays below for the closure check) without
// side-effecting a real install. Previously this repo's own tests
// documented (see nc-install-hook-wiring.test.mjs's runInstallerDryRun
// comment) that install.mjs "has no invokedDirectly guard, it always runs
// main() on load" and spawned it as a subprocess specifically to avoid
// that; this guard makes both usable: `node install.mjs ...` still runs
// main() (process.argv[1] resolves to this file), while `import` from a
// test does not.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
