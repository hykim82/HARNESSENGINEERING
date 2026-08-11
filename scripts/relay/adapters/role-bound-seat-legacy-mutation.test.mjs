// HYK-214-seat-legacy-1 (§1-①/§4(e)): mutation-kill for the
// assumeFreshWorktree gate added to createRoleBoundSeat. Same disk-copy-
// sibling pattern as role-bound-seat-select-mutation.test.mjs (imports a
// mutated copy of orca-adapter.mjs from a disposable mkdtemp dir, relative
// imports rewritten to absolute file:// URLs) -- proves the gate is
// load-bearing, not decorative: with the gate mutated away (pre-existing
// candidates always get recorded as NOT_WORKER_SEAT_ROLE regardless of the
// caller's assumeFreshWorktree value), a legacy/mixed-worktree call that
// does NOT set assumeFreshWorktree:true still wrongly stamps a real
// (unregistered, pre-existing) worker seat as NOT_WORKER_SEAT_ROLE -- the
// exact §0/§1 incident shape (실측: B트랙 CODER 좌석 REJECTED).
//
// 정직 한계: mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를
// 읽는다(위 선례 동일 이유).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACES_ROOT } from "./orca-adapter.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const LIVE_SRC_PATH = join(THIS_DIR, "orca-adapter.mjs");
const LIVE_SRC = readFileSync(LIVE_SRC_PATH, "utf8");

const VALID_WORKTREE = `${WORKSPACES_ROOT}/HARNESSENGINEERING/hyk-214-mutant-fixture`;
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
    join(tmpdir(), `hyk214-seat-legacy-mutant-${label}-`),
  );
  const mutantPath = join(mutantDir, "orca-adapter.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

function terminalEntry(overrides = {}) {
  return {
    handle: "term_a",
    worktreePath: VALID_WORKTREE,
    tabId: "11111111-2222-3333-4444-555555555555",
    leafId: "99999999-8888-7777-6666-555555555555",
    ptyId: "pty_default",
    connected: true,
    writable: true,
    lastOutputAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function managedWorktreeStub(path = VALID_WORKTREE) {
  return { ok: true, result: { worktrees: [{ path }] } };
}
function terminalListStub(entries) {
  return { ok: true, result: { terminals: entries } };
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

const CREATE_RESPONSE = {
  ok: true,
  result: {
    terminal: {
      handle: "term_new_verify",
      tabId: "tab_new",
      paneKey: "tab_new:leaf_new",
      ptyId: "pty_new_verify",
      worktreeId: "wt_id",
      title: "VERIFY",
      surface: "visible",
    },
  },
};

test("NC mutation/role-bound-seat-legacy #7 (필수, HYK-214 §1-①/§4(e)): assumeFreshWorktree 게이트를 지우고 pre-existing을 항상 NOT_WORKER_SEAT_ROLE로 기록하는 변조 -> RED (레거시 워크트리에서도 실제 워커가 오라벨된다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  const preExistingResult =
    assumeFreshWorktree === true
      ? recordPreExistingSeatsAsNotWorker(
          worktreePath,
          registryLoad.registry,
          opts,
        )
      : { ok: true, registry: registryLoad.registry, observed: [] };`,
        `  const preExistingResult = recordPreExistingSeatsAsNotWorker(
    worktreePath,
    registryLoad.registry,
    opts,
  ); // mutated: assumeFreshWorktree gate removed, always records pre-existing as NOT_WORKER_SEAT_ROLE`,
      ),
    "7",
  );
  const fs = fakeWritableRegistryFs({ schemaVersion: 1, seats: [] });
  const execFn = fakeExecFn({
    list: managedWorktreeStub(VALID_WORKTREE),
    "terminal-list": terminalListStub([
      // A real, unregistered legacy worker (old-style CODER seat) -- NOT
      // our own default tab, but indistinguishable from these signals.
      terminalEntry({ handle: "term_legacy_coder", ptyId: "pty_legacy_coder" }),
    ]),
    create: CREATE_RESPONSE,
  });
  // Caller deliberately does NOT set assumeFreshWorktree -- this is exactly
  // the legacy/mixed-worktree call shape (seat-create-cli.mjs today, and
  // any future non-"brand new worktree" caller).
  const r = mutant.createRoleBoundSeat(
    { role: "VERIFY", worktreePath: VALID_WORKTREE },
    { execFn, registryPath: REGISTRY_PATH, registryFs: fs },
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    r.observedNotWorkerSeats,
    [
      {
        handle: "term_legacy_coder",
        ptyId: "pty_legacy_coder",
        skipped: false,
      },
    ],
    "mutant must record the legacy worker as NOT_WORKER_SEAT_ROLE even without assumeFreshWorktree:true (RED signal; proves the gate is load-bearing, not decorative)",
  );
  const saved = fs.savedRegistry();
  const legacy = saved.seats.find((s) => s.ptyId === "pty_legacy_coder");
  assert.equal(legacy.role, "NOT_WORKER_SEAT");
});
