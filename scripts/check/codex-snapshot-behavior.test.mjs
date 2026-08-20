// HYK-286-codex-collect-1 (coder-task.md §4) -- behavioral proof that the
// PATCHED `Confirm-GetCodexSnapshot` (extracted from the committed applied
// fixture) actually tolerates first-line timing accidents and still fails
// closed on a real enumeration failure. Each case is asserted independently
// on its own expected fields (not just a pass/fail count) per coder-task.md
// §4's "⛔자기참조 금지" instruction -- expected values are hand-written,
// not derived by looping over the same declarations under test.
//
// Honesty limit: skips (with a printed reason, `t.skip(...)`) if no
// PowerShell executable is found on PATH, or if `icacls` is unavailable for
// the enumeration-failure case -- never a silent pass. Deliberately forged
// rollout content is out of scope (coder-task.md §0) -- every fixture here
// models a timing accident, not an adversarial file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  findPowerShell,
  extractFunctionText,
  runCodexSnapshotBehavior,
  buildSessionsDir,
  buildUnreadableSessionsDir,
  unlockSessionsDir,
  normalSessionMetaLine,
} from "./codex-snapshot-behavior.mjs";

const APPLIED_FIXTURE_PATH = fileURLToPath(
  new URL(
    "./fixtures/dispatch-worker-snapshot-2026-08-20-hyk286-applied.ps1.txt",
    import.meta.url,
  ),
);

const TARGET_WORKTREE = "C:/Users/Administrator/orca/workspaces/example";
const OTHER_WORKTREE = "C:/Users/Administrator/orca/workspaces/other";

function loadCandidateFunctionText() {
  const source = readFileSync(APPLIED_FIXTURE_PATH, "utf8");
  const text = extractFunctionText(source, "Confirm-GetCodexSnapshot");
  assert.ok(
    text,
    "extractFunctionText found no Confirm-GetCodexSnapshot in the applied fixture -- fixture regenerated in an incompatible shape?",
  );
  return text;
}

const psExe = findPowerShell();

test("prerequisite: a PowerShell executable is on PATH", (t) => {
  if (!psExe) {
    t.skip(
      "no pwsh/powershell.exe found on PATH -- skipping all behavioral cases below with this explicit reason (honesty limit, never a silent pass)",
    );
    return;
  }
  assert.ok(psExe);
});

test("empty first-line rollout + normal rollout: collection still succeeds, normal file's bytes are preserved", (t) => {
  if (!psExe) {
    t.skip("no PowerShell on PATH");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "codex-snap-case-"));
  try {
    const normalContent = normalSessionMetaLine(TARGET_WORKTREE);
    const sessionsDir = buildSessionsDir(base, [
      { name: "rollout-a-empty.jsonl", firstLine: "" },
      { name: "rollout-b-normal.jsonl", firstLine: normalContent },
    ]);
    const result = runCodexSnapshotBehavior(
      loadCandidateFunctionText(),
      sessionsDir,
      TARGET_WORKTREE,
      psExe,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.fileNames, ["rollout-b-normal.jsonl"]);
    const expectedBytes = Buffer.byteLength(
      `${normalContent}\n{"type":"other"}\n`,
      "utf8",
    );
    assert.equal(result.fileBytes[0], expectedBytes);
    assert.equal(result.totalBytes, expectedBytes);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("whitespace-only first-line rollout + normal rollout: collection still succeeds, normal file's bytes are preserved", (t) => {
  if (!psExe) {
    t.skip("no PowerShell on PATH");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "codex-snap-case-"));
  try {
    const normalContent = normalSessionMetaLine(TARGET_WORKTREE);
    const sessionsDir = buildSessionsDir(base, [
      { name: "rollout-a-whitespace.jsonl", firstLine: "   " },
      { name: "rollout-b-normal.jsonl", firstLine: normalContent },
    ]);
    const result = runCodexSnapshotBehavior(
      loadCandidateFunctionText(),
      sessionsDir,
      TARGET_WORKTREE,
      psExe,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.fileNames, ["rollout-b-normal.jsonl"]);
    assert.equal(result.error, "");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("truncated (mid-write) JSON first-line rollout + normal rollout: collection still succeeds, normal file's bytes are preserved", (t) => {
  if (!psExe) {
    t.skip("no PowerShell on PATH");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "codex-snap-case-"));
  try {
    const normalContent = normalSessionMetaLine(TARGET_WORKTREE);
    const sessionsDir = buildSessionsDir(base, [
      // A session_meta line codex hadn't finished writing yet -- valid
      // JSON prefix, no closing braces.
      {
        name: "rollout-a-truncated.jsonl",
        firstLine: '{"type":"session_meta","payload":{"cwd":"C:/Us',
      },
      { name: "rollout-b-normal.jsonl", firstLine: normalContent },
    ]);
    const result = runCodexSnapshotBehavior(
      loadCandidateFunctionText(),
      sessionsDir,
      TARGET_WORKTREE,
      psExe,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.fileNames, ["rollout-b-normal.jsonl"]);
    assert.equal(result.error, "");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("order independence: the problem file being first (name a-) vs last (name z-) in enumeration order yields the same result", (t) => {
  if (!psExe) {
    t.skip("no PowerShell on PATH");
    return;
  }
  const normalContent = normalSessionMetaLine(TARGET_WORKTREE);
  const runWithOrder = (problemName, normalName) => {
    const base = mkdtempSync(join(tmpdir(), "codex-snap-case-"));
    try {
      const sessionsDir = buildSessionsDir(base, [
        {
          name: problemName,
          firstLine: '{"type":"session_meta","payload":{"cwd":"C:/broke',
        },
        { name: normalName, firstLine: normalContent },
      ]);
      return runCodexSnapshotBehavior(
        loadCandidateFunctionText(),
        sessionsDir,
        TARGET_WORKTREE,
        psExe,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  };

  const problemFirst = runWithOrder(
    "rollout-a-broken.jsonl",
    "rollout-z-normal.jsonl",
  );
  const problemLast = runWithOrder(
    "rollout-z-broken.jsonl",
    "rollout-a-normal.jsonl",
  );

  assert.equal(problemFirst.ok, true, JSON.stringify(problemFirst));
  assert.equal(problemLast.ok, true, JSON.stringify(problemLast));
  assert.equal(problemFirst.totalBytes, problemLast.totalBytes);
  assert.equal(problemFirst.fileBytes[0], problemLast.fileBytes[0]);
});

test("a rollout belonging to a DIFFERENT worktree is still skipped (existing behavior, unaffected by this fix) while the timing-accident file is also skipped", (t) => {
  if (!psExe) {
    t.skip("no PowerShell on PATH");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "codex-snap-case-"));
  try {
    const sessionsDir = buildSessionsDir(base, [
      { name: "rollout-a-empty.jsonl", firstLine: "" },
      {
        name: "rollout-b-other-worktree.jsonl",
        firstLine: normalSessionMetaLine(OTHER_WORKTREE),
      },
    ]);
    const result = runCodexSnapshotBehavior(
      loadCandidateFunctionText(),
      sessionsDir,
      TARGET_WORKTREE,
      psExe,
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.fileNames, []);
    assert.equal(result.totalBytes, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("REGRESSION (must still fail): a real enumeration failure (Get-ChildItem itself throws, e.g. permission denied) still returns ok=false", (t) => {
  if (!psExe) {
    t.skip("no PowerShell on PATH");
    return;
  }
  const base = mkdtempSync(join(tmpdir(), "codex-snap-case-"));
  let built;
  try {
    built = buildUnreadableSessionsDir(base);
    if (!built.ok) {
      // HYK-286-codex-collect-2: a host where a real permission-denied
      // directory cannot be constructed (icacls missing, or POSIX mode
      // bits not enforced e.g. running as root) is an explicit, printed
      // skip -- never a silent pass and never a crash (the bug this round
      // fixes: the old code called icacls unconditionally and died with
      // ENOENT on ubuntu-latest CI, PR #192 run 32347838848).
      t.skip(built.reason);
      return;
    }
    const result = runCodexSnapshotBehavior(
      loadCandidateFunctionText(),
      built.sessionsDir,
      TARGET_WORKTREE,
      psExe,
    );
    assert.equal(
      result.ok,
      false,
      `expected a real enumeration failure to stay ok=false, got: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.error && result.error.length > 0,
      "expected a non-empty error message for a real enumeration failure",
    );
  } finally {
    if (built?.ok) unlockSessionsDir(built.sessionsDir);
    rmSync(base, { recursive: true, force: true });
  }
});

test("PORTABILITY (HYK-286-codex-collect-2 §4 self-check): forcing the POSIX (non-Windows) code path never shells out to icacls, and never throws -- it either builds a real permission-denied directory or returns an explicit skip reason", () => {
  // This module's own platform branch decides which mechanism to use
  // (icacls on win32, chmod everywhere else); this test forces the
  // "everywhere else" branch via the injectable `platform` option so the
  // ubuntu-latest CI code path is exercised even from this Windows dev
  // worktree (coder-task.md §4: "로컬이 Windows라 그냥 돌리면 CI와 같은
  // 조건이 아니다" -- this is the substitute verification method).
  const base = mkdtempSync(join(tmpdir(), "codex-snap-portability-"));
  let built;
  try {
    built = buildUnreadableSessionsDir(base, { platform: "linux" });
    // Must always return the {ok, ...} shape -- never throw, regardless of
    // whether this Windows host can actually enforce POSIX mode bits.
    assert.equal(typeof built.ok, "boolean");
    if (built.ok) {
      assert.equal(built.sessionsDir, join(base, "sessions"));
    } else {
      assert.ok(
        typeof built.reason === "string" && built.reason.length > 0,
        "a false ok must carry a non-empty explicit reason (no silent skip)",
      );
    }
  } finally {
    if (built?.ok) unlockSessionsDir(built.sessionsDir, { platform: "linux" });
    rmSync(base, { recursive: true, force: true });
  }
});

test("PORTABILITY (HYK-286-codex-collect-2 §4 self-check): forcing win32 with icacls made unavailable returns an explicit skip reason, not a thrown ENOENT", () => {
  const base = mkdtempSync(join(tmpdir(), "codex-snap-portability-"));
  const originalPath = process.env.PATH;
  try {
    // Empty PATH -- no `icacls` (or anything else) resolvable, reproducing
    // the exact "binary not found" condition that used to throw
    // `spawnSync icacls ENOENT` uncaught.
    process.env.PATH = "";
    const built = buildUnreadableSessionsDir(base, { platform: "win32" });
    assert.equal(built.ok, false);
    assert.match(built.reason, /icacls/);
  } finally {
    process.env.PATH = originalPath;
    rmSync(base, { recursive: true, force: true });
  }
});
