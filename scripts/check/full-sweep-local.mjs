// HYK-279: the canonical way to run the "전체 스윕" locally (against the
// LIVE worktree, including uncommitted changes -- unlike
// isolated-suite-runner.mjs, which only ever tests committed HEAD in a
// disposable clone). Reuses that file's own TEST_DIRS/collectTestFiles so
// the file set stays byte-identical to the CI-canonical list; only the
// execution target (live cwd, not a clone) and the ledger-isolation preload
// differ.
//
// Why this file exists (root cause, see sweep-ledger-isolation.mjs's own
// header for the full mechanism): a plain `node --test scripts/check/*.test.mjs
// scripts/relay/*.test.mjs scripts/relay/adapters/*.test.mjs
// scripts/supervisor/*.test.mjs`, run directly in a worktree, leaks
// test-fixture reservation ids into the REAL control-room admission ledger
// via admission-completion-adapter.mjs's persistent-pointer fallback. This
// wrapper preloads sweep-ledger-isolation.mjs (via `--import`, verified
// empirically to be visible to every node --test worker AND to any child
// process execFileSync-spawned from inside one -- both read process.env) so
// that fallback never reaches the real pointer file for any test that
// doesn't already isolate itself.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { TEST_DIRS, collectTestFiles } from "./isolated-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ISOLATION_PRELOAD = join(HERE, "sweep-ledger-isolation.mjs");

function repoRootOf(cwd, execFile) {
  return execFile("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

// Orchestrates one full local run: resolve the CI-canonical file set off the
// LIVE checkout (not a clone) -> run it with the ledger-isolation preload ->
// return the child's exit code verbatim.
export function runFullSweepLocal({
  repoRoot,
  execFile = execFileSync,
  spawn = spawnSync,
  log = console.log,
  collectFiles = collectTestFiles,
  isolationPreload = ISOLATION_PRELOAD,
} = {}) {
  const root = repoRoot ?? repoRootOf(process.cwd(), execFile);
  const files = collectFiles(root, TEST_DIRS);
  log(
    `[full-sweep-local] running LIVE checkout at ${root} (uncommitted changes INCLUDED, unlike isolated-suite-runner.mjs) -- ${files.length} test file(s)`,
  );
  log(`[full-sweep-local] ledger isolation preload: ${isolationPreload}`);
  const result = spawn(
    process.execPath,
    ["--test", `--import=${pathToFileURL(isolationPreload).href}`, ...files],
    { cwd: root, stdio: "inherit" },
  );
  return result.status ?? 1;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/full-sweep-local.mjs");
if (invokedDirectly) {
  const args = process.argv.slice(2);
  let repoRoot;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo-root") repoRoot = args[++i];
  }
  process.exit(runFullSweepLocal({ repoRoot }));
}
