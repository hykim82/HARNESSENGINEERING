import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  selectRelayAdapterForRole,
  ADAPTER_SELECT_REASON,
  ALLOWED_ADAPTER_DIR,
  REQUIRED_ADAPTER_PORTS,
} from "./engine-adapter-registry.mjs";
import {
  ensureSeat,
  deliverTask,
  collectCompletionSignals,
  teardownSeat,
} from "./adapters/orca-adapter.mjs";
import { observeSeatCandidates } from "./adapters/seat-candidate-adapter.mjs";
import { ENGINE_PROFILE_LOAD_REASON } from "../check/engine-profile.mjs";

// HYK-153-adapter-registry-1 (coder-task.md §2, piece D of HYK-153): these
// tests drive the real production export (selectRelayAdapterForRole), not
// a copy. The picking layer's own `opts.loadProfilesFn`/`opts.importFn`
// seams let the negative matrix craft arbitrary (role -> engine ->
// adapterModule) shapes and arbitrary imported-module shapes WITHOUT ever
// touching the real scripts/check/engine-profiles.json or writing a second
// real file anywhere in scripts/relay/adapters/ (coder-task.md §4
// evidence_rule/live_send_ban -- synthetic injected config/adapter only).
// ALLOWED_ADAPTER_DIR itself is never test-injectable (fixed at this
// module's own on-disk location, by design) -- the one test that needs a
// REAL symlink/junction escape places it directly inside the real
// scripts/relay/adapters/ directory of THIS worktree (a separate git
// worktree's own checkout, not the shared main repo) and removes it again
// in a `finally`.

function fakeProfiles({ roles, engines }) {
  return { roles, engines, configPathUsed: "synthetic-profiles" };
}

// ---- positive: production wiring, all 4 live roles ----

test("selectRelayAdapterForRole: all 4 live roles (CODER/REVIEW/VERIFY/PM) resolve to the real orca-relay-adapter with port-for-port === identity, never a copy/wrapper", async () => {
  for (const role of ["CODER", "REVIEW", "VERIFY", "PM"]) {
    const selection = await selectRelayAdapterForRole(role);
    assert.equal(selection.ok, true, JSON.stringify(selection));
    assert.equal(selection.engine, "claude");
    assert.equal(selection.role, role);
    assert.equal(
      selection.adapterModule,
      "scripts/relay/adapters/orca-relay-adapter.mjs",
    );
    assert.equal(selection.adapter.ensureSeat, ensureSeat);
    assert.equal(
      selection.adapter.observeSeatCandidates,
      observeSeatCandidates,
    );
    assert.equal(selection.adapter.deliverTask, deliverTask);
    assert.equal(
      selection.adapter.collectCompletionSignals,
      collectCompletionSignals,
    );
    assert.equal(selection.adapter.teardownSeat, teardownSeat);
    assert.equal(typeof selection.execFn, "function");
  }
});

test("REQUIRED_ADAPTER_PORTS names exactly the 5 relayStep ports (ensureSeat/observeSeatCandidates/deliverTask/collectCompletionSignals/teardownSeat)", () => {
  assert.deepEqual(
    [...REQUIRED_ADAPTER_PORTS].sort(),
    [
      "collectCompletionSignals",
      "deliverTask",
      "ensureSeat",
      "observeSeatCandidates",
      "teardownSeat",
    ].sort(),
  );
});

// ---- negative ①: ROLE_PROFILE_MISSING ----

test("selectRelayAdapterForRole: a role absent from config.roles is ROLE_PROFILE_MISSING, not a thrown exception or a guessed default", async () => {
  const selection = await selectRelayAdapterForRole("NOT-A-REAL-ROLE");
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ROLE_PROFILE_MISSING,
  );
  assert.match(selection.reason, /no role profile/);
});

// ---- negative ②: ADAPTER_MODULE_MISSING ----

test("selectRelayAdapterForRole: an engine with no adapterModule configured is ADAPTER_MODULE_MISSING", async () => {
  const profiles = fakeProfiles({
    roles: { TESTROLE: { engine: "ghost-engine", model: "m", effort: "e" } },
    engines: { "ghost-engine": {} },
  });
  const selection = await selectRelayAdapterForRole("TESTROLE", {
    loadProfilesFn: () => profiles,
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_MODULE_MISSING,
  );
  assert.match(selection.reason, /no adapterModule configured/);
});

// ---- negative ③: ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR (path algebra, no real fs escape needed) ----

test("selectRelayAdapterForRole: an adapterModule that resolves (path algebra, no real symlink needed) outside scripts/relay/adapters/ is ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR", async () => {
  const profiles = fakeProfiles({
    roles: { TESTROLE: { engine: "escape-engine", model: "m", effort: "e" } },
    engines: {
      "escape-engine": {
        adapterModule: "scripts/relay/adapters/../orca-adapter.mjs",
      },
    },
  });
  const selection = await selectRelayAdapterForRole("TESTROLE", {
    loadProfilesFn: () => profiles,
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR,
  );
  assert.match(selection.reason, /outside the allowed directory/);
});

// ---- negative ④: ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR (real symlink/junction escape, Windows real fs) ----

test("selectRelayAdapterForRole: a REAL symlink placed directly inside scripts/relay/adapters/ that resolves outside it on disk is ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR (junction/link escape, 실경로 -- not just the naming-pattern string check)", async (t) => {
  const outsideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "hyk153-adapter-registry-escape-target-"),
  );
  const outsideFile = path.join(outsideDir, "escape-target.mjs");
  fs.writeFileSync(
    outsideFile,
    "export function createRelayAdapter() { return null; }\n",
    "utf8",
  );
  const linkName = "test-junction-escape-relay-adapter.mjs";
  const linkPath = path.join(ALLOWED_ADAPTER_DIR, linkName);
  let linkCreated = false;
  try {
    try {
      fs.symlinkSync(outsideFile, linkPath, "file");
      linkCreated = true;
    } catch (err) {
      // Honesty contract (coder-task.md §4 universal_claim_discipline):
      // creating a real file symlink on Windows needs
      // SeCreateSymbolicLinkPrivilege (admin/Developer Mode) -- if this
      // account/session does not have it, this cell is UNMEASURED, not
      // assumed-green. Skip with the real error attached, do not fabricate
      // a pass.
      t.skip(
        `못쟀다 -- fs.symlinkSync failed on this machine/account (${err.code ?? err.message}), real junction/link escape not measured here`,
      );
      return;
    }
    const profiles = fakeProfiles({
      roles: { TESTROLE: { engine: "link-engine", model: "m", effort: "e" } },
      engines: {
        "link-engine": {
          adapterModule: `scripts/relay/adapters/${linkName}`,
        },
      },
    });
    const selection = await selectRelayAdapterForRole("TESTROLE", {
      loadProfilesFn: () => profiles,
    });
    assert.equal(selection.ok, false);
    assert.equal(
      selection.reasonCode,
      ADAPTER_SELECT_REASON.ADAPTER_MODULE_OUTSIDE_ALLOWED_DIR,
      `expected a real symlink resolving outside ${ALLOWED_ADAPTER_DIR} to be caught by the real-path containment check, got: ${JSON.stringify(selection)}`,
    );
  } finally {
    if (linkCreated) fs.rmSync(linkPath, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ---- negative ⑤: ADAPTER_MODULE_IMPORT_FAILED ----

test("selectRelayAdapterForRole: an adapterModule naming a file that does not exist is ADAPTER_MODULE_IMPORT_FAILED (naming-pattern-valid, but the dynamic import itself fails)", async () => {
  const profiles = fakeProfiles({
    roles: {
      TESTROLE: { engine: "missing-file-engine", model: "m", effort: "e" },
    },
    engines: {
      "missing-file-engine": {
        adapterModule:
          "scripts/relay/adapters/does-not-exist-relay-adapter.mjs",
      },
    },
  });
  const selection = await selectRelayAdapterForRole("TESTROLE", {
    loadProfilesFn: () => profiles,
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_MODULE_IMPORT_FAILED,
  );
  assert.match(selection.reason, /importing adapterModule/);
});

test("selectRelayAdapterForRole: opts.importFn throwing is also ADAPTER_MODULE_IMPORT_FAILED (DI seam exercised directly, no real fs needed)", async () => {
  const selection = await selectRelayAdapterForRole("CODER", {
    importFn: () => {
      throw new Error("synthetic import failure");
    },
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_MODULE_IMPORT_FAILED,
  );
});

// ---- negative ⑥: ADAPTER_CONTRACT_INVALID (several sub-shapes) ----

test("selectRelayAdapterForRole: an adapterModule that imports fine but has no createRelayAdapter export is ADAPTER_CONTRACT_INVALID", async () => {
  const selection = await selectRelayAdapterForRole("CODER", {
    importFn: async () => ({}),
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
  );
  assert.match(selection.reason, /does not export createRelayAdapter/);
});

test("selectRelayAdapterForRole: createRelayAdapter() returning an adapter missing a required port is ADAPTER_CONTRACT_INVALID", async () => {
  const selection = await selectRelayAdapterForRole("CODER", {
    importFn: async () => ({
      createRelayAdapter: () => ({
        adapter: {
          ensureSeat: () => {},
          observeSeatCandidates: () => {},
          deliverTask: () => {},
          collectCompletionSignals: () => {},
          // teardownSeat intentionally missing
        },
        execFn: () => {},
      }),
    }),
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
  );
  assert.match(selection.reason, /missing required port 'teardownSeat'/);
});

test("selectRelayAdapterForRole: createRelayAdapter() returning a missing/non-function execFn is ADAPTER_CONTRACT_INVALID", async () => {
  const selection = await selectRelayAdapterForRole("CODER", {
    importFn: async () => ({
      createRelayAdapter: () => ({
        adapter: {
          ensureSeat: () => {},
          observeSeatCandidates: () => {},
          deliverTask: () => {},
          collectCompletionSignals: () => {},
          teardownSeat: () => {},
        },
        execFn: "not-a-function",
      }),
    }),
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
  );
  assert.match(selection.reason, /missing an 'execFn' function/);
});

test("selectRelayAdapterForRole: createRelayAdapter() throwing is ADAPTER_CONTRACT_INVALID (never propagates the throw to the caller)", async () => {
  const selection = await selectRelayAdapterForRole("CODER", {
    importFn: async () => ({
      createRelayAdapter: () => {
        throw new Error("synthetic createRelayAdapter failure");
      },
    }),
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ADAPTER_SELECT_REASON.ADAPTER_CONTRACT_INVALID,
  );
  assert.match(selection.reason, /createRelayAdapter threw/);
});

// ---- load-layer errors pass through verbatim (no default fallback) ----

test("selectRelayAdapterForRole: a config-load error (EngineProfileLoadError) passes its own .reason through verbatim, never papered over with a default adapter", async () => {
  const err = new Error("synthetic config-load failure");
  err.reason = ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_UNREADABLE;
  const selection = await selectRelayAdapterForRole("CODER", {
    loadProfilesFn: () => {
      throw err;
    },
  });
  assert.equal(selection.ok, false);
  assert.equal(
    selection.reasonCode,
    ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_UNREADABLE,
  );
  assert.match(selection.reason, /loading engine profiles failed/);
});
