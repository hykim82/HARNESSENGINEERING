// HYK-404-race-1: shared, non-test module for the live `.harness/`
// fingerprinting logic that dispatch-gate-live-path-guard.test.mjs's own
// before()/after() hooks use (HYK-394 P1: file list + per-file sha256,
// asserted byte-identical across that test file's own run).
//
// Factored out of that test file so a SEPARATE test file (dispatch-gate-
// live-path-guard-concurrent-race.test.mjs) can drive the exact same real
// logic without `import`-ing a `*.test.mjs` file's top-level `test(...)`
// registrations into its own process (node's test runner isolates each
// `*.test.mjs` file into its own child process by default; importing
// another test file's module would silently re-register and re-run that
// file's tests a second time inside the importer's process).
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));

export function repoRootFromHere() {
  return execFileSync("git", ["-C", HERE, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

export function fingerprintDir(dir) {
  const entries = [];
  function walk(sub) {
    let names;
    try {
      names = readdirSync(join(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of names) {
      const rel = sub ? `${sub}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(rel);
      } else if (ent.isFile()) {
        const hash = createHash("sha256")
          .update(readFileSync(join(dir, rel)))
          .digest("hex");
        entries.push(`${rel.replace(/\\/g, "/")}:${hash}`);
      }
    }
  }
  walk("");
  entries.sort();
  return entries.join("\n");
}
