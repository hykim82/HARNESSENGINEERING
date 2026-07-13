import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseStatusOpenIssues, diffSync, loadLinearApiKey, normalizeStatusState, resolveSyncExitCode } from "./linear-sync.mjs";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "linear-sync-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A trimmed but structurally real slice of this repo's own STATUS.md §6/§7,
// including the parenthetical Done-rollup line and a priority-annotated state
// (`*Todo, **High***`) that must not break state extraction.
const REAL_SHAPED_STATUS = `
## B. 진행 파악 (매번 덮어씀)

### 5) 활성 릴레이 슬롯
\`coder = HYK-93-coder-1 (go 대기)\`

### 6) 열린 이슈 (Linear)
- **HYK-85** 대표 CORE 플로우(제품/TEAM10) — *In Progress* (1단계 완결)
- **HYK-98** install.mjs gitignore 구블록 중복 append — *Todo* (위생/멱등성, Low)
- **HYK-93** STATUS↔Linear 정합성(SoT 기계화) — *Todo, **High*** (배치 1 마지막)
- (HYK-97·100·101·92·91·68 = Done 처리됨, §7 참고)

### 7) 직전 완료 (최근 3)
- **HYK-97** Scope A 게이트 갭 — merge \`c11003e\` PR #14 → **Done**
- **HYK-101** git 훅 worktree 이식성 — merge \`75784a0\` → **Done**
`;

test("(1) §6 parsing: extracts id+state from real-shaped fixture, excludes rollup line and §7", () => {
  const issues = parseStatusOpenIssues(REAL_SHAPED_STATUS);
  assert.deepEqual(issues, [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-98", state: "Todo" },
    { id: "HYK-93", state: "Todo" },
  ]);
  // §7's HYK-97/HYK-101 and the parenthetical rollup's ids must never appear.
  const ids = issues.map((i) => i.id);
  assert.ok(!ids.includes("HYK-97"));
  assert.ok(!ids.includes("HYK-101"));
});

test("(2) diffSync: staleInStatus fires when §6 lists an issue Linear already completed", () => {
  const statusIssues = [{ id: "HYK-97", state: "Todo" }];
  const linearIssues = [{ id: "HYK-97", stateName: "Done", stateType: "completed" }];
  const { staleInStatus, missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(staleInStatus.length, 1);
  assert.equal(staleInStatus[0].id, "HYK-97");
  assert.equal(staleInStatus[0].linearState, "Done");
  assert.equal(missingInStatus.length, 0);
});

test("(2b) diffSync: canceled counts as stale too, not just completed", () => {
  const statusIssues = [{ id: "HYK-68", state: "In Progress" }];
  const linearIssues = [{ id: "HYK-68", stateName: "Canceled", stateType: "canceled" }];
  const { staleInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(staleInStatus.length, 1);
  assert.equal(staleInStatus[0].id, "HYK-68");
});

test("(3) diffSync: missingInStatus fires when Linear has an open issue absent from §6", () => {
  const statusIssues = [{ id: "HYK-93", state: "Todo" }];
  const linearIssues = [
    { id: "HYK-93", stateName: "Todo", stateType: "unstarted" },
    { id: "HYK-102", stateName: "Todo", stateType: "unstarted" },
  ];
  const { staleInStatus, missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(staleInStatus.length, 0);
  assert.equal(missingInStatus.length, 1);
  assert.equal(missingInStatus[0].id, "HYK-102");
});

test("(4) diffSync: matched state, no drift on either side", () => {
  const statusIssues = [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-93", state: "Todo" },
  ];
  const linearIssues = [
    { id: "HYK-85", stateName: "In Progress", stateType: "started" },
    { id: "HYK-93", stateName: "Todo", stateType: "unstarted" },
    { id: "HYK-97", stateName: "Done", stateType: "completed" }, // done, absent from §6 -- fine, not open
  ];
  const { staleInStatus, missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(staleInStatus.length, 0);
  assert.equal(missingInStatus.length, 0);
});

test("(5) loadLinearApiKey: no env var, no .env.local -> fail-open null, no value ever surfaced", () => {
  withFixtureDir((dir) => {
    const result = loadLinearApiKey(dir, {});
    assert.equal(result, null);
  });
});

test("(5b) loadLinearApiKey: env var present -> returns it with source 'env'", () => {
  withFixtureDir((dir) => {
    const result = loadLinearApiKey(dir, { LINEAR_API_KEY: "dummy-key-alpha" });
    assert.deepEqual(result, { key: "dummy-key-alpha", source: "env" });
  });
});

test("(5c) loadLinearApiKey: no env var, key present in .env.local -> read from file", () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, ".env.local"), "OTHER_KEY=x\nLINEAR_API_KEY=dummy-key-from-file\n", "utf8");
    const result = loadLinearApiKey(dir, {});
    assert.deepEqual(result, { key: "dummy-key-from-file", source: ".env.local" });
  });
});

test("(5d) loadLinearApiKey: .env.local exists but has no LINEAR_API_KEY line -> fail-open null", () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, ".env.local"), "OTHER_KEY=x\n", "utf8");
    const result = loadLinearApiKey(dir, {});
    assert.equal(result, null);
  });
});

test("(6) normalizeStatusState: known names normalize case-insensitively", () => {
  assert.equal(normalizeStatusState("Todo"), "Todo");
  assert.equal(normalizeStatusState("in review"), "In Review");
  assert.equal(normalizeStatusState("IN PROGRESS"), "In Progress");
});

test("(6b) normalizeStatusState: trailing annotation on §6 text still normalizes (prefix match)", () => {
  assert.equal(normalizeStatusState("Todo(루프 상설)"), "Todo");
});

test("(6c) normalizeStatusState: In Progress and In Review don't collide (diverge right after 'In ')", () => {
  assert.equal(normalizeStatusState("In Progress"), "In Progress");
  assert.equal(normalizeStatusState("In Review"), "In Review");
});

test("(6d) normalizeStatusState: unrecognized text -> null (judged unable, never guessed)", () => {
  assert.equal(normalizeStatusState("Blocked"), null);
  assert.equal(normalizeStatusState(""), null);
});

test("(7) diffSync: stateDrift fires when §6=Todo but Linear=In Progress (both open)", () => {
  const statusIssues = [{ id: "HYK-93", state: "Todo" }];
  const linearIssues = [{ id: "HYK-93", stateName: "In Progress", stateType: "started" }];
  const { stateDrift, staleInStatus, missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 1);
  assert.deepEqual(stateDrift[0], { id: "HYK-93", statusState: "Todo", linearState: "In Progress" });
  assert.equal(staleInStatus.length, 0);
  assert.equal(missingInStatus.length, 0);
});

test("(7b) diffSync: stateDrift fires when §6=In Progress but Linear=In Review (different type, same 'open')", () => {
  const statusIssues = [{ id: "HYK-128", state: "In Progress" }];
  const linearIssues = [{ id: "HYK-128", stateName: "In Review", stateType: "backlog" }];
  const { stateDrift } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 1);
  assert.deepEqual(stateDrift[0], { id: "HYK-128", statusState: "In Progress", linearState: "In Review" });
});

test("(7c) diffSync: matching open states on both sides -> no stateDrift", () => {
  const statusIssues = [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-93", state: "Todo" },
  ];
  const linearIssues = [
    { id: "HYK-85", stateName: "In Progress", stateType: "started" },
    { id: "HYK-93", stateName: "Todo", stateType: "unstarted" },
  ];
  const { stateDrift } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 0);
});

test("(7d) diffSync: unnormalizable §6 state never produces a false-positive stateDrift", () => {
  const statusIssues = [{ id: "HYK-99", state: "Blocked" }];
  const linearIssues = [{ id: "HYK-99", stateName: "In Progress", stateType: "started" }];
  const { stateDrift } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 0);
});

test("(7e) diffSync: closed Linear side (e.g. Done) never produces stateDrift, even if §6 text differs", () => {
  const statusIssues = [{ id: "HYK-97", state: "Todo" }];
  const linearIssues = [{ id: "HYK-97", stateName: "Done", stateType: "completed" }];
  const { stateDrift, staleInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 0);
  assert.equal(staleInStatus.length, 1); // this pair is staleInStatus's job, not stateDrift's
});

test("(8) diffSync: Linear 'Duplicate' (type duplicate) counts as closed -- staleInStatus fires, not stateDrift", () => {
  const statusIssues = [{ id: "HYK-68", state: "In Progress" }];
  const linearIssues = [{ id: "HYK-68", stateName: "Duplicate", stateType: "duplicate" }];
  const { staleInStatus, stateDrift, missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(staleInStatus.length, 1);
  assert.equal(staleInStatus[0].id, "HYK-68");
  assert.equal(staleInStatus[0].linearState, "Duplicate");
  assert.equal(stateDrift.length, 0);
  assert.equal(missingInStatus.length, 0);
});

test("(8b) diffSync: Linear 'Duplicate' open issue absent from §6 counts as closed -- no missingInStatus", () => {
  const statusIssues = [];
  const linearIssues = [{ id: "HYK-68", stateName: "Duplicate", stateType: "duplicate" }];
  const { missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(missingInStatus.length, 0);
});

// --- HYK-131: advisory exit-code normalization (G4) ---
// This check's CLI never exits 2, even on a confirmed drift -- exit 2 is
// reserved for the ORCH-only blocking checks (clear-safe-check.mjs,
// controlroom-fresh.mjs). The fail-open paths (missing key/STATUS
// file/network error) are untouched by this function -- they exit 0 directly
// in main() before diffSync is ever called.

test("(9) resolveSyncExitCode: no drift of any kind -> 0", () => {
  assert.equal(resolveSyncExitCode({ staleInStatus: [], missingInStatus: [], stateDrift: [] }), 0);
});

test("(9b) resolveSyncExitCode: staleInStatus present -> 1, never 2", () => {
  assert.equal(
    resolveSyncExitCode({ staleInStatus: [{ id: "HYK-97" }], missingInStatus: [], stateDrift: [] }),
    1,
  );
});

test("(9c) resolveSyncExitCode: missingInStatus present -> 1, never 2", () => {
  assert.equal(
    resolveSyncExitCode({ staleInStatus: [], missingInStatus: [{ id: "HYK-102" }], stateDrift: [] }),
    1,
  );
});

test("(9d) resolveSyncExitCode: stateDrift present -> 1, never 2", () => {
  assert.equal(
    resolveSyncExitCode({ staleInStatus: [], missingInStatus: [], stateDrift: [{ id: "HYK-93" }] }),
    1,
  );
});

test("(9e) resolveSyncExitCode: all three present at once -> still 1, not accumulated to a higher code", () => {
  assert.equal(
    resolveSyncExitCode({
      staleInStatus: [{ id: "HYK-97" }],
      missingInStatus: [{ id: "HYK-102" }],
      stateDrift: [{ id: "HYK-93" }],
    }),
    1,
  );
});
