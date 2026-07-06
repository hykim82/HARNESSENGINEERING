import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { posix as posixPath } from "node:path";

const KNOWN_ROLES = ["ORCH", "CODER", "REVIEW", "VERIFY"];
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const TASK_FILE_RE = /^\.harness\/[^/]+-task\.md$/i;

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// Maps WSL (`/mnt/c/...`) and Git-Bash (`/c/...`) drive-relative forms to
// Windows drive-letter form (`C:/...`) so a path can be compared against a
// repo root reported in either scheme. Without this, the *same* file seen
// through a different shell's path convention could be misjudged as outside
// the repo root and slip past the guard entirely.
function toDriveStyle(p) {
  let m = p.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  m = p.match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p;
}

// Normalizes the tool-reported path and the repo root onto the same scheme
// (backslashes -> forward slashes, WSL/Git-Bash drive forms -> `C:/...`),
// resolves `.`/`..` segments (so `.harness/foo/../review.md` collapses to
// `.harness/review.md` before matching, not after), then expresses the
// result relative to the repo root. A relative input path is assumed already
// relative to the repo root (PreToolUse hands back whatever the tool call
// used, which in this harness is always a cwd-relative or repo-relative
// path, never a foreign cwd). Anything that resolves outside the repo root
// is out of scope for this guard by design (e.g. the control room under
// D:\ is ORCH's to edit freely).
function normalizeToRepoRelative(filePath, root) {
  const fp = toDriveStyle(filePath.replace(/\\/g, "/"));
  const rootNorm = toDriveStyle(root.replace(/\\/g, "/").replace(/\/$/, ""));
  const isAbsolute = /^[a-zA-Z]:\//.test(fp) || fp.startsWith("/");

  const absoluteFp = isAbsolute ? fp : `${rootNorm}/${fp}`;
  const resolved = posixPath.normalize(absoluteFp);

  const resolvedLower = resolved.toLowerCase();
  const rootLower = rootNorm.toLowerCase();
  if (resolvedLower === rootLower) {
    return { relative: "", insideRepo: true };
  }
  if (resolvedLower.startsWith(`${rootLower}/`)) {
    return { relative: resolved.slice(rootNorm.length + 1), insideRepo: true };
  }
  return { relative: null, insideRepo: false };
}

export function checkRoleWrite({ role, filePath, repoRoot: root }) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { ok: false, reason: "role-guard: no file path provided" };
  }

  const { relative, insideRepo } = normalizeToRepoRelative(filePath, root);
  if (!insideRepo) {
    return { ok: true, reason: `role-guard: '${filePath}' is outside the repo root; not regulated` };
  }

  if (!role || !KNOWN_ROLES.includes(role)) {
    return {
      ok: true,
      warn: true,
      reason: `role-guard: HARNESS_ROLE unset or unrecognized ('${role ?? ""}') — no role restriction applied for '${relative}'`,
    };
  }

  const isTaskFile = TASK_FILE_RE.test(relative);
  const isReviewFile = relative.toLowerCase() === ".harness/review.md";
  const isVerifyFile = relative.toLowerCase() === ".harness/verify.md";

  if (role === "ORCH") {
    if (isTaskFile) {
      return { ok: true, reason: `role-guard: ORCH may drop task file '${relative}'` };
    }
    return {
      ok: false,
      reason: `role-guard: ORCH may only write .harness/<role>-task.md task files, not '${relative}'`,
    };
  }

  if (role === "CODER") {
    if (isReviewFile || isVerifyFile || isTaskFile) {
      return {
        ok: false,
        reason: `role-guard: CODER may not write '${relative}' (owned by another role or ORCH)`,
      };
    }
    return { ok: true, reason: `role-guard: CODER write allowed for '${relative}'` };
  }

  if (role === "REVIEW") {
    if (isReviewFile) {
      return { ok: true, reason: `role-guard: REVIEW may write '${relative}'` };
    }
    return { ok: false, reason: `role-guard: REVIEW may only write .harness/review.md, not '${relative}'` };
  }

  // role === "VERIFY"
  if (isVerifyFile) {
    return { ok: true, reason: `role-guard: VERIFY may write '${relative}'` };
  }
  return { ok: false, reason: `role-guard: VERIFY may only write .harness/verify.md, not '${relative}'` };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/role-guard.mjs");
if (invokedDirectly) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    raw = "";
  }

  let hookInput;
  try {
    hookInput = JSON.parse(raw);
  } catch {
    // No/malformed PreToolUse payload: nothing to check against, allow.
    process.exit(0);
  }

  const toolName = hookInput.tool_name;
  if (!WRITE_TOOLS.has(toolName)) {
    process.exit(0);
  }

  const toolInput = hookInput.tool_input || {};
  const filePath = toolInput.file_path || toolInput.notebook_path;
  if (!filePath) {
    process.exit(0);
  }

  const result = checkRoleWrite({ role: process.env.HARNESS_ROLE, filePath, repoRoot: repoRoot() });
  if (result.warn) {
    console.error(result.reason);
  }
  if (result.ok) {
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(2);
}
