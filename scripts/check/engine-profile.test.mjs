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

// HYK-153-engine-profile-2 (coder-task.md §2 P2-3): a minimal but
// *complete* engine block -- every key validateEngines now requires
// present (homeDirName/modelFamilyPatterns/agentMarkerWords), so synthetic
// configs below that aren't testing one of those specific keys don't have
// to repeat all four lines inline. `overrides` replaces individual keys
// (including with intentionally-missing via `undefined` deletion below).
function fullEngineBlock(deliveryMode, overrides = {}) {
  const base = {
    deliveryMode,
    homeDirName: null,
    modelFamilyPatterns: {},
    agentMarkerWords: [],
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete base[k];
  }
  return base;
}

// Same idea for the top-level bannerMarkerPatterns object this round made
// required (P2-3).
function fullBannerMarkerPatterns(overrides = {}) {
  const base = {
    orcaAdapterAgentMarker: "x",
    seatCensusAgentBanner: "y",
    ...overrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete base[k];
  }
  return base;
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
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
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
        claude: fullEngineBlock("inject"),
        codex: fullEngineBlock("no-inject"),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
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

// ---- P2-2/P2-3 honesty contract: deliveryMode closed set + required
// consumed keys (coder-task.md §2 "조용한 기본값 -> 사유 있는 실패") ----

test("loadEngineProfiles: deliveryMode outside the closed {inject, no-inject} set is CONFIG_SCHEMA_INVALID, not silently truthy", () => {
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("sideways-inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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

test("loadEngineProfiles: a missing homeDirName KEY (not just a falsy value) is CONFIG_SCHEMA_INVALID -- codex's real null value still loads fine", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { homeDirName: undefined }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject", { homeDirName: null }) },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.doesNotThrow(() => loadEngineProfiles(file));
    },
  );
});

test("loadEngineProfiles: modelFamilyPatterns must be an object, agentMarkerWords must be an array -- missing either is CONFIG_SCHEMA_INVALID", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { modelFamilyPatterns: undefined }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { agentMarkerWords: undefined }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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

test("loadEngineProfiles: a missing bannerMarkerPatterns object, or one missing a required key, is CONFIG_SCHEMA_INVALID", () => {
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns({
        seatCensusAgentBanner: undefined,
      }),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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

// ---- P2-7: PM added to config.roles (live = claude, Opus-family model,
// high -- 관제실 seat-launch-registry.jsonl 최근 PM 행 실측, 2026-11-10) ----

test("getRoleProfile: PM resolves to claude/opus-family/high (added this round, matches live seat-launch-registry)", () => {
  const pm = getRoleProfile("PM");
  assert.ok(pm, "expected config.roles.PM to exist");
  assert.equal(pm.engine, "claude");
  assert.match(pm.model, /opus/i);
  assert.equal(pm.effort, "high");
});

test("getEngineByRole: adding PM does not change CODER/REVIEW/VERIFY's resolved engine (live role resolution unchanged apart from PM)", () => {
  const byRole = getEngineByRole();
  assert.equal(byRole.CODER, "claude");
  assert.equal(byRole.REVIEW, "claude");
  assert.equal(byRole.VERIFY, "claude");
  assert.equal(byRole.PM, "claude");
});

// ---- HYK-153-engine-profile-4 (coder-task.md §2 product_scope ⓘ): close
// the whole "empty config value" family in the one schema-validation place
// -- empty string / blank-only string / empty array element, for every key
// production code actually consumes. Missing-key presence rules above
// (homeDirName/modelFamilyPatterns/agentMarkerWords/bannerMarkerPatterns)
// are unchanged; these tests are about a key being PRESENT but carrying an
// empty or whitespace-only value, which used to load cleanly and only bite
// a consumer later (e.g. seat-candidate-adapter.mjs's
// `CLAUDE_AGENT_MARKERS.some((m) => text.includes(m))` -- an empty-string
// marker makes `text.includes("")` true for every text, so
// agentMarkerWords: [""] silently turned "any seat output" into "this is
// an agent", confirmed by direct probe against this exact config shape
// before this round's fix).

test("loadEngineProfiles: agentMarkerWords containing an empty-string or whitespace-only element is CONFIG_SCHEMA_INVALID -- text.includes('') matches everything, so this must not load silently", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { agentMarkerWords: ["Sonnet", ""] }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID &&
          /agentMarkerWords\[1\] must be a non-empty string/.test(err.message),
      );
    },
  );
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { agentMarkerWords: ["   "] }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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

test("loadEngineProfiles: an empty agentMarkerWords array ([]) still loads fine -- zero markers is safe (text.includes never called), unlike a zero-length element", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { agentMarkerWords: [] }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.doesNotThrow(() => loadEngineProfiles(file));
    },
  );
});

test("loadEngineProfiles: a modelFamilyPatterns value that is an empty string or whitespace-only is CONFIG_SCHEMA_INVALID, centrally -- not only when engine-split-rounds.mjs's own consumer-side guard happens to run (B3 review-4 P2-A, converged into this one schema place per coder-task.md §2 product_scope ⓘ)", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", {
          modelFamilyPatterns: { sonnet: "sonnet", opus: "" },
        }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID &&
          /modelFamilyPatterns\.opus must be a non-empty string/.test(
            err.message,
          ),
      );
    },
  );
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", {
          modelFamilyPatterns: { sonnet: "  " },
        }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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

test("loadEngineProfiles: an empty modelFamilyPatterns object ({}) still loads fine -- codex's real config carries this today, and no consumer presupposes a non-empty object (only presupposes non-empty VALUES for whichever keys are present)", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { modelFamilyPatterns: {} }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.doesNotThrow(() => loadEngineProfiles(file));
    },
  );
});

test("loadEngineProfiles: homeDirName present but an empty string or whitespace-only is CONFIG_SCHEMA_INVALID -- distinct from the deliberate null codex uses for 'no home dir'", () => {
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject", { homeDirName: "" }) },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID &&
          /homeDirName must be null or a non-empty string/.test(err.message),
      );
    },
  );
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject", { homeDirName: "  " }) },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID,
      );
    },
  );
  // null is still the correct, required way to say "no home dir" (codex).
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject", { homeDirName: null }) },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.doesNotThrow(() => loadEngineProfiles(file));
    },
  );
});

test("loadEngineProfiles: previewMarkerPattern, when present, must be a non-empty/non-blank string -- an empty value would silently and permanently never match (matchEngineByPreviewMarkers already guards isNonEmptyString at the call site, but a present-and-empty value should be a reasoned load-time refusal, not a quietly-unreachable engine)", () => {
  withTempConfig(
    JSON.stringify({
      engines: {
        claude: fullEngineBlock("inject", { previewMarkerPattern: "" }),
      },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.throws(
        () => loadEngineProfiles(file),
        (err) =>
          err.reason === ENGINE_PROFILE_LOAD_REASON.CONFIG_SCHEMA_INVALID &&
          /previewMarkerPattern must be a non-empty string/.test(err.message),
      );
    },
  );
  // absent entirely is still fine -- this key is optional (an engine may
  // legitimately not participate in preview-marker detection).
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.doesNotThrow(() => loadEngineProfiles(file));
    },
  );
});

test("loadEngineProfiles: bannerMarkerPatterns required values that are whitespace-only are CONFIG_SCHEMA_INVALID, not just a length check (closes the gap next to B2's isNonEmptyString)", () => {
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns({
        orcaAdapterAgentMarker: "   ",
      }),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
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

test("loadEngineProfiles: roles.<role>.model/effort that are whitespace-only are CONFIG_SCHEMA_INVALID, not just empty-length (closes the same gap for role fields)", () => {
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "   ", effort: "high" } },
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
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "   " } },
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

// ---- P2-2 (coder-task.md §2 product_scope ⓘⓘ): HARNESS_ENGINE_PROFILES_PATH
// self-report -- the loaded result object always carries the path actually
// used, so a caller reading a non-default (injected) config has one place
// to see that fact without re-deriving it from the env var itself.

test("loadEngineProfiles: the returned object carries configPathUsed -- the exact path argument it loaded (default or injected)", () => {
  assert.equal(
    loadEngineProfiles().configPathUsed,
    DEFAULT_ENGINE_PROFILES_PATH,
  );
  withTempConfig(
    JSON.stringify({
      engines: { claude: fullEngineBlock("inject") },
      bannerMarkerPatterns: fullBannerMarkerPatterns(),
      roles: { CODER: { engine: "claude", model: "m", effort: "high" } },
    }),
    (file) => {
      assert.equal(loadEngineProfiles(file).configPathUsed, file);
    },
  );
});
