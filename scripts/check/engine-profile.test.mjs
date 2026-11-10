import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  loadEngineProfiles,
  getKnownEngines,
  assertKnownEngine,
  getEngineByRole,
  getRoleProfile,
  getEngineDeliveryMode,
  getEngineAttr,
  matchEngineByPreviewMarkers,
  describePreviewMarkerPatterns,
  getBannerMarkerPattern,
  getEngineModelFamilyPatterns,
  getEngineAgentMarkerWords,
  ENGINE_PROFILE_LOAD_REASON,
  DEFAULT_ENGINE_PROFILES_PATH,
} from "./engine-profile.mjs";

function withTempConfig(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-profile-test-"));
  const file = path.join(dir, "engine-profiles.json");
  if (content !== null) fs.writeFileSync(file, content, "utf8");
  try {
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---- real config (production export, production file -- not a copy) ----

test("loadEngineProfiles: the real repo config loads and validates", () => {
  const profiles = loadEngineProfiles();
  assert.ok(profiles.engines.claude);
  assert.ok(profiles.engines.codex);
  assert.ok(profiles.roles.CODER);
  assert.ok(profiles.roles.REVIEW);
  assert.ok(profiles.roles.VERIFY);
});

test("DEFAULT_ENGINE_PROFILES_PATH points at scripts/check/engine-profiles.json", () => {
  assert.equal(
    path.basename(DEFAULT_ENGINE_PROFILES_PATH),
    "engine-profiles.json",
  );
  assert.ok(fs.existsSync(DEFAULT_ENGINE_PROFILES_PATH));
});

test("getKnownEngines: real config exposes exactly claude and codex", () => {
  assert.deepEqual(getKnownEngines().sort(), ["claude", "codex"]);
});

test("getEngineByRole: CODER/REVIEW/VERIFY all resolve to claude -- matches live seat-launch-registry, not the stale REVIEW=codex literal this round fixes", () => {
  const byRole = getEngineByRole();
  assert.equal(byRole.CODER, "claude");
  assert.equal(byRole.REVIEW, "claude");
  assert.equal(byRole.VERIFY, "claude");
  assert.ok(Object.isFrozen(byRole));
});

test("getRoleProfile: CODER/REVIEW carry distinct models (sonnet vs opus family), same effort", () => {
  const coder = getRoleProfile("CODER");
  const review = getRoleProfile("REVIEW");
  assert.equal(coder.engine, "claude");
  assert.match(coder.model, /sonnet/i);
  assert.equal(coder.effort, "high");
  assert.equal(review.engine, "claude");
  assert.match(review.model, /opus/i);
  assert.equal(review.effort, "high");
});

test("getRoleProfile: a role absent from config.roles (e.g. ORCH) is null, not a guessed default", () => {
  assert.equal(getRoleProfile("ORCH"), null);
});

test("getEngineDeliveryMode: claude=inject, codex=no-inject, unknown engine=null (no throw, D11 no-side-effect contract)", () => {
  assert.equal(getEngineDeliveryMode("claude"), "inject");
  assert.equal(getEngineDeliveryMode("codex"), "no-inject");
  assert.equal(getEngineDeliveryMode("made-up-engine"), null);
});

test("assertKnownEngine: throws (does not guess) for an engine absent from config -- HYK-472 contract carried into the config layer", () => {
  assert.equal(assertKnownEngine("claude"), "claude");
  assert.throws(() => assertKnownEngine("made-up-engine"), /unknown engine/);
  assert.throws(() => assertKnownEngine(""), /unknown engine/);
  assert.throws(() => assertKnownEngine(null), /unknown engine/);
});

test("matchEngineByPreviewMarkers: unambiguous claude/codex banners resolve, blank/contaminated text does not", () => {
  assert.equal(
    matchEngineByPreviewMarkers(
      "Opus 5 · claude-opus-5\nbypass permissions on",
    ),
    "claude",
  );
  assert.equal(matchEngineByPreviewMarkers("model: gpt-5.6-terra"), "codex");
  assert.equal(matchEngineByPreviewMarkers(""), null);
  assert.equal(
    matchEngineByPreviewMarkers("PS C:\\Users\\Administrator>"),
    null,
  );
  assert.equal(
    matchEngineByPreviewMarkers(
      "Opus 5 bypass permissions\nmodel: gpt-5.6-terra",
    ),
    null,
    "both markers present -> ambiguous, refuse rather than guess",
  );
});

test("describePreviewMarkerPatterns: returns the exact pattern source per engine (for human-readable refusal messages)", () => {
  const patterns = describePreviewMarkerPatterns();
  assert.equal(patterns.claude, "Sonnet|Opus|Fable|bypass permissions");
  assert.equal(patterns.codex, "gpt-5\\.6");
});

test("getBannerMarkerPattern: orcaAdapterAgentMarker matches the byte-identical production AGENT_MARKER_RE source this round moved into config", () => {
  assert.equal(
    getBannerMarkerPattern("orcaAdapterAgentMarker"),
    "gpt-5\\.6|Sonnet|Opus|\\[CODER seat\\]|\\[REVIEW seat\\]|bypass permissions|MCP startup|weekly \\d",
  );
});

test("getBannerMarkerPattern: seatCensusAgentBanner matches the byte-identical production AGENT_BANNER_MARKERS source this round moved into config", () => {
  assert.equal(
    getBannerMarkerPattern("seatCensusAgentBanner"),
    "gpt-5\\.6|Sonnet|Opus|Fable|\\[CODER\\]|\\[REVIEW\\]|bypass permissions|MCP startup|weekly \\d",
  );
});

test("getBannerMarkerPattern: unknown name is null, not a crash", () => {
  assert.equal(getBannerMarkerPattern("does-not-exist"), null);
});

test("getEngineModelFamilyPatterns / getEngineAgentMarkerWords: claude carries the family markers that used to be hardcoded in seat-candidate-adapter.mjs / engine-split-rounds.mjs", () => {
  assert.deepEqual(getEngineModelFamilyPatterns("claude"), {
    sonnet: "sonnet",
    opus: "opus",
  });
  assert.deepEqual(getEngineAgentMarkerWords("claude"), [
    "Sonnet",
    "Opus",
    "Haiku",
  ]);
  assert.deepEqual(getEngineAgentMarkerWords("codex"), ["gpt-5.6", "codex"]);
});

test("getEngineAttr: homeDirName/teamDirName/cliHomeFlag are claude-only, null for codex (no silent cross-engine default)", () => {
  assert.equal(getEngineAttr("claude", "homeDirName"), ".claude");
  assert.equal(getEngineAttr("claude", "teamDirName"), ".claude-team");
  assert.equal(getEngineAttr("claude", "cliHomeFlag"), "--claude-home");
  assert.equal(getEngineAttr("codex", "homeDirName"), null);
  assert.equal(getEngineAttr("made-up-engine", "homeDirName"), null);
});

// ---- honesty contract: missing/broken config file, mkdtemp synthetic
// configs driving the real exported loadEngineProfiles (coder-task.md §2
// ⓒ "설정 파일이 없거나 깨졌을 때의 동작 -- 조용한 기본값 금지") ----

test("loadEngineProfiles: a missing config file throws CONFIG_FILE_UNREADABLE, not a silent default", () => {
  withTempConfig(null, (file) => {
    let caught = null;
    try {
      loadEngineProfiles(file);
    } catch (err) {
      caught = err;
    }
    assert.ok(
      caught,
      "expected loadEngineProfiles to throw for a missing file",
    );
    assert.equal(
      caught.reason,
      ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_UNREADABLE,
    );
  });
});

test("loadEngineProfiles: malformed JSON throws CONFIG_FILE_INVALID_JSON", () => {
  withTempConfig("{ not valid json", (file) => {
    let caught = null;
    try {
      loadEngineProfiles(file);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(
      caught.reason,
      ENGINE_PROFILE_LOAD_REASON.CONFIG_FILE_INVALID_JSON,
    );
  });
});

test("loadEngineProfiles: a well-formed JSON that is not an object throws CONFIG_SCHEMA_INVALID", () => {
  withTempConfig("[1,2,3]", (file) => {
    assert.throws(
      () => loadEngineProfiles(file),
      (err) => err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
    );
  });
});

test("loadEngineProfiles: missing engines/roles keys each throw CONFIG_SCHEMA_INVALID", () => {
  withTempConfig(
    JSON.stringify({
      roles: { CODER: { engine: "x", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
      );
    },
  );
  withTempConfig(
    JSON.stringify({ engines: { x: { deliveryMode: "inject" } } }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
      );
    },
  );
});

test("loadEngineProfiles: a role naming an engine absent from config.engines is CONFIG_SCHEMA_INVALID (no silent cross-reference guess)", () => {
  withTempConfig(
    JSON.stringify({
      engines: { claude: { deliveryMode: "inject" } },
      roles: { CODER: { engine: "codex", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
      );
    },
  );
});

test("loadEngineProfiles: a well-formed synthetic config of the same shape as production loads cleanly end to end", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: { deliveryMode: "inject" },
        codex: { deliveryMode: "no-inject" },
      },
      roles: {
        CODER: { engine: "claude", model: "m-sonnet", effort: "high" },
      },
    }),
    (file) => {
      const profiles = loadEngineProfiles(file);
      assert.deepEqual(getKnownEngines(profiles).sort(), ["claude", "codex"]);
      assert.deepEqual(getEngineByRole(profiles), { CODER: "claude" });
      assert.equal(getEngineDeliveryMode("codex", profiles), "no-inject");
    },
  );
});
