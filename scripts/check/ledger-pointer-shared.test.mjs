// HYK-302/355 §2-A (coder-task.md, 책임자 조건 ③ -- HYK-350 "정의 두 벌
// 드리프트" 교훈): pins two things --
//  1. ledger-pointer-shared.mjs's own two exports behave correctly.
//  2. the two production files this round de-duplicated
//     (admission-completion-adapter.mjs, orch-stall-detect.mjs) actually
//     IMPORT from here rather than redefining locally -- a source-text
//     assertion, not just a behavioral one, because a behavioral test alone
//     cannot tell "imports the shared symbol" apart from "coincidentally
//     redefined an identical copy" (exactly the drift HYK-350 warned about).
//
// relay-handshake.mjs is deliberately NOT included in the "must import"
// assertion below: this round assessed extending the dedup to its own
// isInsideGitWorktree copy and found ~20 separate isolated-fixture test
// files stage a mutated/spawned copy of relay-handshake.mjs, each of which
// would need its own sibling-list update to avoid MODULE_NOT_FOUND --
// verifying all of them safely did not fit this round's budget, so that
// half of the dedup was reverted (see coder.md §2-A). This test instead
// pins that relay-handshake.mjs's own copy is untouched and still correct,
// so a future round doing that dedup has a clean, known starting point.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  PERSISTENT_LEDGER_POINTER_FILENAME,
  isInsideGitWorktree,
} from "./ledger-pointer-shared.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = readFileSync(
  join(HERE, "admission-completion-adapter.mjs"),
  "utf8",
);
const RELAY_HANDSHAKE_SRC = readFileSync(
  join(HERE, "relay-handshake.mjs"),
  "utf8",
);
const ORCH_STALL_DETECT_SRC = readFileSync(
  join(HERE, "..", "supervisor", "orch-stall-detect.mjs"),
  "utf8",
);

test("PERSISTENT_LEDGER_POINTER_FILENAME is the exact filename both admission-completion-adapter.mjs and orch-stall-detect.mjs's installer-pointer resolution depend on", () => {
  assert.equal(
    PERSISTENT_LEDGER_POINTER_FILENAME,
    "admission-ledger-path.json",
  );
});

test("isInsideGitWorktree: a real git worktree (this repo's own checkout) -> true", () => {
  assert.equal(isInsideGitWorktree(HERE), true);
});

test("isInsideGitWorktree: a plain non-git scratch directory -> false", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk302-355-nonworktree-"));
  try {
    assert.equal(isInsideGitWorktree(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isInsideGitWorktree: a deliberate separate git clone still passes (documented honesty limit, not every isolation escape is closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk302-355-separate-clone-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    assert.equal(isInsideGitWorktree(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isInsideGitWorktree: missing/falsy dir -> false without throwing", () => {
  assert.equal(isInsideGitWorktree(undefined), false);
  assert.equal(isInsideGitWorktree(""), false);
  assert.equal(isInsideGitWorktree(join(HERE, "no-such-dir-xyz")), false);
});

test("admission-completion-adapter.mjs imports both symbols from ledger-pointer-shared.mjs and no longer redefines them locally", () => {
  assert.match(
    ADAPTER_SRC,
    /from\s+["']\.\/ledger-pointer-shared\.mjs["']/,
    "expected a static import of ledger-pointer-shared.mjs",
  );
  assert.doesNotMatch(
    ADAPTER_SRC,
    /\bconst\s+PERSISTENT_LEDGER_POINTER_FILENAME\s*=/,
    "PERSISTENT_LEDGER_POINTER_FILENAME must no longer be locally redefined here -- HYK-350 drift",
  );
  assert.doesNotMatch(
    ADAPTER_SRC,
    /\bfunction\s+isInsideGitWorktree\s*\(/,
    "isInsideGitWorktree must no longer be locally redefined here -- HYK-350 drift",
  );
});

test("orch-stall-detect.mjs imports PERSISTENT_LEDGER_POINTER_FILENAME from ledger-pointer-shared.mjs and no longer redefines it locally", () => {
  assert.match(
    ORCH_STALL_DETECT_SRC,
    /from\s+["']\.\.\/check\/ledger-pointer-shared\.mjs["']/,
    "expected a static import of ../check/ledger-pointer-shared.mjs",
  );
  assert.doesNotMatch(
    ORCH_STALL_DETECT_SRC,
    /\bconst\s+PERSISTENT_LEDGER_POINTER_FILENAME\s*=/,
    "PERSISTENT_LEDGER_POINTER_FILENAME must no longer be locally redefined here -- HYK-350 drift",
  );
});

// 정직 한계 (see this file's own header): relay-handshake.mjs's copy is
// deliberately UNTOUCHED this round -- pin that it still exists (proves the
// revert landed cleanly, not half-migrated) rather than asserting it must
// stay this way forever.
test("relay-handshake.mjs still carries its own local isInsideGitWorktree (dedup deferred this round -- see coder.md §2-A blast-radius note)", () => {
  assert.match(RELAY_HANDSHAKE_SRC, /\bfunction\s+isInsideGitWorktree\s*\(/);
  assert.doesNotMatch(
    RELAY_HANDSHAKE_SRC,
    /from\s+["']\.\/ledger-pointer-shared\.mjs["']/,
    "relay-handshake.mjs must not half-import ledger-pointer-shared.mjs while also keeping its local copy",
  );
});
