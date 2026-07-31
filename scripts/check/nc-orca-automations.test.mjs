// NC-3 negative-control: orca-automations-present (scripts/check/orca-posture-check.mjs
// :: checkAutomationsPresent). One of the last 2 of the 9 v1-dependent
// enforcement devices this track covers (see .harness/coder-task.md §1).
//
// checkAutomationsPresent({dbPath, existsFn, readFileFn}) is fully
// injectable (module comment at orca-posture-check.mjs:136) -- every attack
// below calls the REAL exported function with synthetic fs ports, never
// touching the real %APPDATA%\orca\orchestration.db (§2 non-negotiable #2:
// that file is not even read, only a synthetic byte buffer standing in for
// it). The two mutation tests at the bottom import a MODIFIED COPY of the
// module from an mkdtemp file -- the real scripts/check/orca-posture-check.mjs
// is only ever opened read-only (`git show HEAD:...`).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  checkAutomationsPresent,
  runOrcaPostureCheck,
} from "./orca-posture-check.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
// §2 non-negotiable #5: not "empty output" -- INVARIANCE (whatever diff
// existed before this suite ran must still exist, byte-for-byte, after).
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// ---------------------------------------------------------------------------
// §5 attack table (task §5) -- all against the REAL exported function.
// ---------------------------------------------------------------------------

test("NC-3 orca-automations/attack: dbPath absent -> OK ('automations 없음')", () => {
  const result = checkAutomationsPresent({
    dbPath: "/synthetic/does-not-exist/orchestration.db",
    existsFn: () => false,
    readFileFn: () => {
      throw new Error("must not be called when existsFn says absent");
    },
  });
  assert.equal(result.status, "OK");
});

test("NC-3 orca-automations/attack: synthetic db bytes contain the 'automations' marker -> WARN (presence possible)", () => {
  const result = checkAutomationsPresent({
    dbPath: "/synthetic/orchestration.db",
    existsFn: () => true,
    readFileFn: () => Buffer.from("garbage ... automations ... garbage"),
  });
  assert.equal(result.status, "WARN");
});

test("NC-3 orca-automations/attack: synthetic db bytes exist but NO marker found -> UNJUDGABLE, never a false OK (this is the device's core contract)", () => {
  const result = checkAutomationsPresent({
    dbPath: "/synthetic/orchestration.db",
    existsFn: () => true,
    readFileFn: () => Buffer.from("SQLite format 3\0some other schema bytes"),
  });
  assert.equal(
    result.status,
    "UNJUDGABLE",
    "absence cannot be proven by a negative byte-scan alone -- a false OK here would be a critical defect (task §5 row 3)",
  );
  assert.notEqual(
    result.status,
    "OK",
    "a false OK on 'db exists, marker not found' would be the critical failure mode this device exists to avoid",
  );
});

test("NC-3 orca-automations/attack: readFileFn throws -> UNJUDGABLE + zero exception leakage", () => {
  let result;
  assert.doesNotThrow(() => {
    result = checkAutomationsPresent({
      dbPath: "/synthetic/orchestration.db",
      existsFn: () => true,
      readFileFn: () => {
        throw new Error("EACCES synthetic permission failure");
      },
    });
  });
  assert.equal(result.status, "UNJUDGABLE");
  assert.match(result.reason, /읽기 실패/);
});

test("NC-3 orca-automations/gap: marker stored as UTF-16LE bytes -> latin1 byte-scan MISSES it (empirically measured, not assumed)", () => {
  // §5 row 5 explicitly requires measuring this, not assuming it. Empirical
  // check (done by hand before writing this test, node -e repro): writing
  // "xx automations yy" as utf16le and reading it back through the SAME
  // Buffer->latin1 path checkAutomationsPresent's default readFileFn takes
  // produces a string where every ASCII byte is interleaved with a NUL byte
  // (e.g. "a<NUL>u<NUL>t<NUL>o<NUL>m<NUL>..."), so the contiguous
  // literal "automations" substring never occurs -- .includes() misses it.
  const utf16Buf = Buffer.from("xx automations yy", "utf16le");
  const result = checkAutomationsPresent({
    dbPath: "/synthetic/orchestration.db",
    existsFn: () => true,
    readFileFn: () => utf16Buf,
  });
  assert.equal(
    result.status,
    "UNJUDGABLE",
    "UTF-16LE-encoded marker bytes are missed by the latin1 scan -- classified as KNOWN GAP (docs/enforcement-known-gaps.md), not a defect (never a false OK -- UNJUDGABLE is the honest outcome, just an uninformative one)",
  );
});

test("NC-3 orca-automations/measurement: runOrcaPostureCheck's WIRED readFileFn (utf8-decoded STRING, not a Buffer) -- UTF-16LE marker still missed, via a DIFFERENT code path than the default", () => {
  // Module comment (orca-posture-check.mjs:127-133) flags this exact gap:
  // runOrcaPostureCheck passes readFileFn=(p)=>readFileSync(p,"utf8"), which
  // hands checkAutomationsPresent an already-utf8-decoded STRING, not a
  // Buffer. `Buffer.isBuffer(buf) ? buf.toString("latin1") : String(buf)`
  // then takes the `String(buf)` branch (a no-op on an existing string) --
  // so the wired call site is NOT the same "assume latin1 bytes" path the
  // default readFileFn takes. Empirically (node -e repro run before writing
  // this test): reading UTF-16LE bytes via readFileSync(p,"utf8") mangles
  // every other byte into U+FFFD/garbage, and the "automations" substring
  // does not survive either. Same end result (missed), different mechanism
  // -- both are recorded so nobody assumes the two readFileFn shapes fail
  // for the same reason.
  const dir = mkdtempSync(join(tmpdir(), "nc-orca-automations-utf16-"));
  try {
    const dbPath = join(dir, "orchestration.db");
    writeFileSync(dbPath, Buffer.from("xx automations yy", "utf16le"));
    // exact shape runOrcaPostureCheck's default port uses
    const wiredReadFileFn = (p) => readFileSync(p, "utf8");
    const result = checkAutomationsPresent({
      dbPath,
      existsFn: () => true,
      readFileFn: wiredReadFileFn,
    });
    assert.equal(
      result.status,
      "UNJUDGABLE",
      "wired (utf8-string) path also misses a UTF-16LE marker -- same observable gap, distinct mechanism from the default Buffer/latin1 path",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NC-3 orca-automations/gap: marker case variant 'Automations' -> case-sensitive .includes() misses it", () => {
  const result = checkAutomationsPresent({
    dbPath: "/synthetic/orchestration.db",
    existsFn: () => true,
    readFileFn: () => Buffer.from("garbage ... Automations ... garbage"),
  });
  assert.equal(
    result.status,
    "UNJUDGABLE",
    "the marker scan is case-sensitive ('automations' only) -- a differently-cased occurrence is missed, same 'never false OK' floor still holds (UNJUDGABLE, not OK)",
  );
});

test("NC-3 orca-automations/wiring: runOrcaPostureCheck actually CALLS checkAutomationsPresent (not dead code) -- confirmed via a synthetic WARN result flowing through", () => {
  const dir = mkdtempSync(join(tmpdir(), "nc-orca-automations-wiring-"));
  try {
    const orcaHome = join(dir, "orca-home");
    const appDataOrca = join(dir, "appdata-orca");
    const dbPath = join(appDataOrca, "orchestration.db");
    // Synthetic existsFn/readFileFn: only the automations db "exists"; the
    // other two orca-posture-check.mjs sub-checks (linear-reconnect,
    // terminal-history) see everything absent, isolating this measurement
    // to the automations-present sub-check alone.
    const existsFn = (p) => p === dbPath;
    const readFileFn = (p) => (p === dbPath ? "xxx automations xxx" : "");
    const results = runOrcaPostureCheck({
      orcaHome,
      appDataOrca,
      fingerprints: [],
      existsFn,
      readFileFn,
    });
    const automationsResult = results.find(
      (r) => r.id === "automations-present",
    );
    assert.ok(
      automationsResult,
      "runOrcaPostureCheck's result array must contain an 'automations-present' entry",
    );
    assert.equal(
      automationsResult.status,
      "WARN",
      "the synthetic WARN-triggering input flowed all the way from runOrcaPostureCheck's ports into checkAutomationsPresent's return value -- proves it is actually called, not dead code",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// §5 row "훅 미설치 축" -- read-only check that enforcement-inventory.json's
// own invocation_note for this device documents "Not hook-installed" (this
// device is never invoked by any git hook or Claude-settings hook -- if
// nobody calls `node scripts/check/orca-posture-check.mjs` during the
// weekly VERIFY loop, this device simply never runs). Read-only, tracked
// file only.
test("NC-3 orca-automations/gap: enforcement-inventory.json documents this device as 'Not hook-installed' -- install/invocation axis, not just the check logic itself", () => {
  const inventoryText = execFileSync(
    "git",
    ["show", "HEAD:scripts/check/enforcement-inventory.json"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const inventory = JSON.parse(inventoryText);
  const entry = inventory.checks.find(
    (c) => c.id === "orca-automations-present",
  );
  assert.ok(
    entry,
    "enforcement-inventory.json must have an orca-automations-present entry",
  );
  assert.equal(
    entry.install_targets.length,
    0,
    "no install_targets -- confirms nothing installs a hook for this device",
  );
  assert.match(
    entry.invocation_note,
    /Not hook-installed/,
    "the manifest's own invocation_note must say this device is not hook-installed (registered as a KNOWN GAP: install/invocation axis, distinct from the check logic's own gaps above)",
  );
});

// ---------------------------------------------------------------------------
// §5 mutation ledger: at least 2 copy-mutations of the REAL module, RED
// measured. The real scripts/check/orca-posture-check.mjs is only ever
// opened read-only via `git show HEAD:...`.
// ---------------------------------------------------------------------------
const POSTURE_CHECK_SRC = execFileSync(
  "git",
  ["show", "HEAD:scripts/check/orca-posture-check.mjs"],
  { cwd: ROOT, encoding: "utf8" },
);

async function importMutatedCopy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nc-orca-automations-mutant-"));
  const mutated = mutate(POSTURE_CHECK_SRC);
  const filePath = join(dir, "orca-posture-check.mutant.mjs");
  writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("NC-3 mutation/orca-automations #1: flipping the 'marker not found' branch from UNJUDGABLE to OK -> RED (this is the exact false-OK failure mode the device exists to prevent)", async () => {
  const mutant = await importMutatedCopy((src) => {
    const needle =
      '  return {\n    status: "UNJUDGABLE",\n    reason:\n      "orchestration.db 존재하나 바이트 스캔으로 \'automations\' 흔적을 못 찾음 -- 부재 단정 불가(거짓 OK 금지), 런타임 확인 필요",\n  };\n}';
    assert.ok(
      src.includes(needle),
      "fixture assumption: the exact UNJUDGABLE-branch source text must still exist unmodified in the real module for this mutation to be meaningful",
    );
    return src.replace(
      needle,
      '  return {\n    status: "OK",\n    reason: "mutated: falsely claims absence",\n  };\n}',
    );
  });
  const result = mutant.checkAutomationsPresent({
    dbPath: "/synthetic/orchestration.db",
    existsFn: () => true,
    readFileFn: () => Buffer.from("no marker bytes here"),
  });
  assert.equal(
    result.status,
    "OK",
    "mutant must claim OK where the real gate refuses to (RED signal for the mutation -- proves the UNJUDGABLE branch is load-bearing)",
  );
});

test("NC-3 mutation/orca-automations #2: flipping the 'db absent' branch from OK to WARN -> RED (false-positive direction)", async () => {
  const mutant = await importMutatedCopy((src) => {
    const needle =
      '  if (!existsFn(dbPath)) {\n    return {\n      status: "OK",\n      reason: "orchestration.db 부재 -- automations 없음(Orca 미사용 포함)",\n    };\n  }';
    assert.ok(
      src.includes(needle),
      "fixture assumption: the exact 'db absent' branch source text must still exist unmodified in the real module for this mutation to be meaningful",
    );
    return src.replace(
      needle,
      '  if (!existsFn(dbPath)) {\n    return {\n      status: "WARN",\n      reason: "mutated: falsely warns on absence",\n    };\n  }',
    );
  });
  const result = mutant.checkAutomationsPresent({
    dbPath: "/synthetic/does-not-exist.db",
    existsFn: () => false,
    readFileFn: () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(
    result.status,
    "WARN",
    "mutant must warn on plain absence where the real gate says OK (RED signal for the mutation)",
  );
});

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "nc-orca-automations.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "nc-orca-automations.test.mjs changed the tracked-file diff state -- the suite must leave whatever diff existed before it ran untouched, not force it to empty",
  );
});
