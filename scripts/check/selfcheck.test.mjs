import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildManifestById, loadSettingsByLocation, buildLimitations, buildReceipts, runSelfcheck } from "./selfcheck.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "selfcheck-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("(1) buildManifestById: indexes manifest.checks by id", () => {
  const manifest = { checks: [{ id: "a", x: 1 }, { id: "b", x: 2 }] };
  assert.deepEqual(buildManifestById(manifest), { a: { id: "a", x: 1 }, b: { id: "b", x: 2 } });
});

test("(2) loadSettingsByLocation: resolves REPO placeholder and reads the real file", () => {
  withFixtureDir((dir) => {
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir);
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ hooks: { Stop: [] } }), "utf8");
    const manifest = {
      checks: [
        {
          id: "x",
          install_targets: [{ location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "Stop" }],
        },
      ],
    };
    const settings = loadSettingsByLocation(manifest, { REPO: dir, CONTROL_ROOM: "/nowhere", USER_HOME: "/nowhere" });
    assert.deepEqual(settings["repo-settings"], { hooks: { Stop: [] } });
  });
});

test("(3) loadSettingsByLocation: missing file at resolved path -> key simply absent, no throw", () => {
  const manifest = {
    checks: [
      {
        id: "x",
        install_targets: [{ location: "repo-settings", kind: "claude-settings", path: "REPO/.claude/settings.local.json", hook_event: "Stop" }],
      },
    ],
  };
  const settings = loadSettingsByLocation(manifest, { REPO: "/definitely/does/not/exist", CONTROL_ROOM: "/x", USER_HOME: "/x" });
  assert.equal("repo-settings" in settings, false);
});

test("(4) buildLimitations: includes structural notes plus one line per UNJUDGABLE entry and failed smoke case", () => {
  const limitations = buildLimitations({
    inventoryResults: [
      { id: "role-guard", status: "ALIVE", evidence: [] },
      { id: "pm-guard", status: "UNJUDGABLE", evidence: ["no canary receipt"] },
    ],
    smokeCases: [{ id: "clear-safe-check", variant: "bad", pass: false }],
  });
  assert.ok(limitations.some((l) => l.includes("canary")));
  assert.ok(limitations.some((l) => l.includes("UNJUDGABLE: pm-guard")));
  assert.ok(limitations.some((l) => l.includes("스모크 실패: clear-safe-check:bad")));
});

test("(5) buildReceipts: notes manifest hash, smoke zero-diff result, and canary dir presence/absence", () => {
  const withoutCanary = buildReceipts({ manifestPath: "/x/manifest.json", manifestText: "{}", smokeZeroDiff: true, canaryDir: undefined });
  assert.ok(withoutCanary.some((r) => r.includes("sha256=")));
  assert.ok(withoutCanary.some((r) => r.includes("diff-0=true")));
  assert.ok(withoutCanary.some((r) => r.includes("제공되지 않음")));

  const withCanary = buildReceipts({ manifestPath: "/x/manifest.json", manifestText: "{}", smokeZeroDiff: true, canaryDir: "/tmp/canary" });
  assert.ok(withCanary.some((r) => r.includes("/tmp/canary")));
});

test("(6) runSelfcheck: end-to-end against the real repo manifest -- produces a summary, smoke results, and report text with no throw", () => {
  const manifestPath = join(REPO_ROOT, "scripts", "check", "enforcement-inventory.json");
  const result = runSelfcheck({ repoRoot: REPO_ROOT, manifestPath, taskId: "test-run", now: Date.parse("2026-07-13T15:00:00+09:00") });
  assert.equal(typeof result.summary.ALIVE, "number");
  assert.ok(result.inventoryResults.length >= 14, "expected all 14 manifest entries to be judged");
  assert.equal(result.smokeCases.length, 14);
  assert.equal(result.smokeZeroDiff, true);
  assert.match(result.text, /## 요약/);
  assert.match(result.text, /## 인벤토리/);
  assert.match(result.text, /## 스모크/);
  assert.match(result.text, /## 드리프트/);
  assert.match(result.text, /## 한계·판정불가/);
  assert.match(result.text, /## 영수증/);
});

// review-1 rejected fix: this repo's actual pre-commit/CI-coverage state is
// live, ambient, and can legitimately change out from under this test (e.g.
// a human installing the pre-commit hook mid-cycle, as happened between
// coder-1 and this round) -- asserting one specific status literal here
// means the test breaks the moment the drift it names gets fixed, which is
// a test design defect, not a real regression. This asserts only what must
// always be true regardless of live state: a real judgment happened (one of
// the 5 fixed values, non-empty evidence), never a crash or a placeholder.
// Any assertion that pins a *specific* current-environment status belongs in
// a synthetic fixture (see selfcheck-inventory.test.mjs), not here.
const VALID_STATUSES = ["ALIVE", "SILENT_BROKEN", "DRIFT", "UNJUDGABLE", "NOT_INSTALLED"];

test("(7) runSelfcheck: every manifest entry (including the ones with known-at-authoring-time drift) resolves to one of the 5 fixed statuses with non-empty evidence -- never asserts which one, since live repo state can legitimately change", () => {
  const manifestPath = join(REPO_ROOT, "scripts", "check", "enforcement-inventory.json");
  const result = runSelfcheck({ repoRoot: REPO_ROOT, manifestPath, taskId: "test-run" });
  for (const r of result.inventoryResults) {
    assert.ok(VALID_STATUSES.includes(r.status), `${r.id}: unexpected status '${r.status}'`);
    assert.ok(r.evidence.length > 0, `${r.id}: judged with no evidence at all`);
  }
  const preCommit = result.inventoryResults.find((r) => r.id === "pre-commit-gitleaks");
  const ci = result.inventoryResults.find((r) => r.id === "ci-enforce");
  assert.ok(preCommit, "pre-commit-gitleaks entry must be present in results");
  assert.ok(ci, "ci-enforce entry must be present in results");
});
