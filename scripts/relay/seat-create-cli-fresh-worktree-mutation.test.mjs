// HYK-214-seat-legacy-2 (§0/§1-①ⓒ): mutation-kill for the `--fresh-worktree`
// flag wiring added to seat-create-cli.mjs. Same disk-copy-sibling pattern
// as scripts/relay/adapters/role-bound-seat-select-mutation.test.mjs
// (imports a mutated copy of seat-create-cli.mjs from a disposable mkdtemp
// dir, relative imports rewritten to absolute file:// URLs) -- proves the
// flag -> assumeFreshWorktree wiring is load-bearing, not decorative: with
// the wiring mutated away (the parsed flag is parsed but never forwarded to
// createRoleBoundSeat), the new-worktree standard path (§1(a) fixture --
// caller passes --fresh-worktree) regresses back to the pre-2R bug: the
// leftover pre-existing candidate is never recorded as NOT_WORKER_SEAT_ROLE,
// so a later role-bound select still rejects as ROLE_UNDETERMINED even
// though the caller correctly declared the worktree was just created.
//
// 정직 한계: mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를
// 읽는다(선례 동일 이유).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACES_ROOT } from "./adapters/orca-adapter.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const LIVE_SRC_PATH = join(THIS_DIR, "seat-create-cli.mjs");
const LIVE_SRC = readFileSync(LIVE_SRC_PATH, "utf8");

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-214-fresh-mutant-fixture`;
const REGISTRY_PATH = "fake/mutant-registry.json";

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- stale or ambiguous target`,
  );
  return src.replace(find, replacement);
}

function rewriteRelativeImportsToAbsolute(src, baseDir) {
  return src.replace(
    /from\s+(["'])(\.\.?\/[^"']+)\1/g,
    (whole, quote, relPath) => {
      const absPath = join(baseDir, relPath).replace(/\\/g, "/");
      return `from ${quote}file://${absPath}${quote}`;
    },
  );
}

async function importMutatedSibling(mutate, label) {
  const rewritten = rewriteRelativeImportsToAbsolute(
    mutate(LIVE_SRC),
    THIS_DIR,
  );
  const mutantDir = mkdtempSync(
    join(tmpdir(), `hyk214-fresh-worktree-mutant-${label}-`),
  );
  const mutantPath = join(mutantDir, "seat-create-cli.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

function fakeWritableRegistryFs(registry) {
  let text = registry === null ? null : JSON.stringify(registry);
  const writes = [];
  return {
    existsFn: () => text !== null,
    readFn: () => text ?? "",
    writeFn: (p, t) => {
      writes.push([p, t]);
      text = t;
    },
    renameFn: () => {},
    writes,
    savedRegistry: () => JSON.parse(writes[writes.length - 1][1]),
  };
}

function fakeExecFn(responses) {
  function fn(argv) {
    const key =
      argv[0] === "terminal" && argv[1] === "list"
        ? "terminal-list"
        : argv[0] === "orchestration" ||
            argv[0] === "worktree" ||
            argv[0] === "terminal"
          ? argv[1]
          : argv[0];
    const entry = responses[key];
    if (entry === undefined) {
      throw new Error(
        `fakeExecFn: no stub for '${key}' (argv=${JSON.stringify(argv)})`,
      );
    }
    return entry;
  }
  return fn;
}

function managedWorktreeStub(path = VALID_WORKTREE) {
  return { ok: true, result: { worktrees: [{ path }] } };
}
function terminalListStub(entries) {
  return { ok: true, result: { terminals: entries } };
}

const CREATE_RESPONSE = {
  ok: true,
  result: {
    terminal: {
      handle: "term_new_coder",
      tabId: "tab_new",
      paneKey: "tab_new:leaf_new",
      ptyId: "pty_new_coder",
      worktreeId: "wt_id",
      title: "CODER",
      surface: "visible",
    },
  },
};

test("NC mutation/seat-create-cli-fresh-worktree #1 (필수, HYK-214 §1-①ⓒ): --fresh-worktree 파싱 결과를 createRoleBoundSeat로 전달하지 않는 변조 -> RED (플래그를 줘도 새 워크트리 표준 경로가 다시 실패한다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  return createRoleBoundSeat(
    {
      role: parsed.role,
      worktreePath: parsed.worktreePath,
      assumeFreshWorktree: parsed.assumeFreshWorktree,
    },
    { execFn, registryPath: parsed.registryPath, registryFs: opts.registryFs },
  );`,
        `  return createRoleBoundSeat(
    { role: parsed.role, worktreePath: parsed.worktreePath }, // mutated: assumeFreshWorktree dropped
    { execFn, registryPath: parsed.registryPath, registryFs: opts.registryFs },
  );`,
      ),
    "1",
  );
  const fs = fakeWritableRegistryFs({ schemaVersion: 1, seats: [] });
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      {
        handle: "term_default_tab",
        worktreePath: VALID_WORKTREE,
        ptyId: "pty_default_tab",
      },
    ]),
    create: CREATE_RESPONSE,
  });
  // Caller correctly declares the worktree was just created.
  const r = mutant.runSeatCreateCli(
    [
      "--role",
      "CODER",
      "--worktree",
      VALID_WORKTREE,
      "--registry",
      REGISTRY_PATH,
      "--fresh-worktree",
    ],
    { execFn, registryFs: fs },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.observedNotWorkerSeats,
    [],
    "mutant must fail to record the pre-existing candidate as NOT_WORKER_SEAT_ROLE even though the caller passed --fresh-worktree (RED signal; proves the parsed-flag -> assumeFreshWorktree wiring is load-bearing, not decorative)",
  );
});
