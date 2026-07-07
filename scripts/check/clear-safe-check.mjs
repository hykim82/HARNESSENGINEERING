import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

// The reconciliation attestation marker this checker looks for, e.g.:
//   <!-- clear-safe-attest: reconciled=2026-07-08 03:57 KST delta=applied -->
//   <!-- clear-safe-attest: reconciled=none delta=none -->
// `reconciled=` is captured non-greedily up to the next ` delta=`, which is
// what lets a KST timestamp containing a space ("YYYY-MM-DD HH:MM KST")
// round-trip correctly instead of being cut at its first space.
const ATTEST_RE = /<!--\s*clear-safe-attest:\s*reconciled=(.*?)\s+delta=(.*?)\s*-->/i;

// Escape hatch for a board that doesn't phrase its human-facing declaration
// with a 🟢 emoji next to the literal text "/clear" (this harness's own
// convention -- see STATUS.md's "/clear 안전" section) but still wants to
// mark itself green explicitly.
const EXPLICIT_GREEN_RE = /clear-safe:\s*green/i;

// Detects a "🟢 /clear declared safe" signal, scoped to whichever `##`/`###`
// heading-bounded section it appears in -- so a stray 🟢 elsewhere on the
// board (e.g. in an unrelated "done" checkbox) does not falsely couple to an
// unrelated mention of "/clear" in a different section.
function greenDeclared(statusText) {
  if (EXPLICIT_GREEN_RE.test(statusText)) return true;
  const lines = statusText.split(/\r?\n/);
  const sections = [];
  let current = [];
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      if (current.length) sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join("\n"));
  return sections.some((section) => section.includes("🟢") && section.includes("/clear"));
}

// Pure function: text in, verdict out (no file I/O), same shape as
// `extractHardConstraints`/`checkStatusFresh` in the other check scripts.
// This is deliberately a soft, form-only check -- see docs/enforcement-v1.md
// ("Scope B") for the platform-limitation reasons this cannot be a hard
// gate and cannot verify the attestation's *content*, only its *presence*.
export function checkClearSafe(statusText) {
  try {
    const text = statusText ?? "";

    if (!greenDeclared(text)) {
      return { ok: true, reason: "no 🟢 /clear declaration found -- nothing to attest" };
    }

    const match = text.match(ATTEST_RE);
    if (!match) {
      return {
        ok: false,
        reason:
          "🟢 /clear-safe declared without a filled context-card reconciliation attestation " +
          "(missing clear-safe-attest marker) -- run /capture-context and fill it in before relying on this declaration",
      };
    }

    const reconciled = match[1].trim();
    if (!reconciled) {
      return {
        ok: false,
        reason:
          "🟢 /clear-safe declared without a filled context-card reconciliation attestation " +
          "(clear-safe-attest marker present but reconciled= is empty) -- run /capture-context and fill it in",
      };
    }

    return { ok: true, reason: `clear-safe attestation present (reconciled=${reconciled})` };
  } catch (err) {
    // Fail-open: any parsing trouble is uncertain, not a confirmed-missing
    // attestation -- this check is a soft reminder, not a hard gate, so it
    // never blocks (or, at the CLI level, warns) on something it can't
    // actually judge.
    return { ok: true, reason: `clear-safe-check internal error (${err.message}) -- fail-open` };
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/clear-safe-check.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let statusPath = process.env.HARNESS_STATUS_PATH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--status") statusPath = args[++i];
  }
  statusPath = statusPath || join(repoRoot(), ".harness", "STATUS.md");

  let text;
  try {
    text = readFileSync(statusPath, "utf8");
  } catch (err) {
    // Missing/unreadable STATUS file is uncertain, not a confirmed-unsafe
    // declaration -- fail-open (this is a Stop-hook soft reminder, exit 1
    // is reserved for a confirmed unmet attestation, not "couldn't check").
    console.log(`clear-safe-check: could not read '${statusPath}' (${err.message}) -- fail-open, ok`);
    process.exit(0);
  }

  const result = checkClearSafe(text);
  if (result.ok) {
    console.log(result.reason);
    process.exit(0);
  } else {
    // Soft reminder only: exit 1, never exit 2. A Stop hook surfaces exit 1
    // as a non-blocking warning; this check must never be wired as a hard
    // gate (see docs/enforcement-v1.md, "Scope B" honesty notes).
    console.error(result.reason);
    process.exit(1);
  }
}
