// HYK-292 I1 -- status-budget-check.mjs CLI 계약 시험. mkdtemp 픽스처만
// 사용한다(coder-task.md §3-1 요건 6) -- 실물 관제실(D 드라이브)에 의존하지
// 않으므로 CI에서도 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "status-budget-check.mjs",
);
const CONFIG_BODY = JSON.stringify({
  schema_version: "docs-budget/v1",
  status_budget_bytes: 1000,
  orch_boot_budget_bytes: 200,
  pm_output_budget_bytes: null,
});

// §1 표 헤더 행이 있어야 checkStatusBudget이 §1 범위를 식별한다
// (2R 수리 2 -- fail-closed면 §1을 못 찾은 픽스처와 구분해야 한다).
const SECTION1_HEADER = "| 역할 | 내용 |";
const SIX_ROLE_ROWS = [
  SECTION1_HEADER,
  "| 사람 | a |",
  "| ORCH | a |",
  "| PM | a |",
  "| CODER | a |",
  "| REVIEW | a |",
  "| VERIFY | a |",
].join("\n");

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-status-budget-cli-"));
  try {
    const configPath = join(dir, "docs-budget-config.json");
    const statusPath = join(dir, "STATUS.md");
    writeFileSync(configPath, CONFIG_BODY, "utf8");
    return fn({ dir, configPath, statusPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeConfig(dir, overrides) {
  const path = join(dir, "docs-budget-config-custom.json");
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: "docs-budget/v1",
      status_budget_bytes: 100,
      orch_boot_budget_bytes: 200,
      pm_output_budget_bytes: null,
      ...overrides,
    }),
    "utf8",
  );
  return path;
}

// 이 세션 환경에는 이미 HARNESS_STATUS_PATH/HARNESS_DOCS_BUDGET_CONFIG_PATH가
// 실물 관제실 경로로 깔려 있을 수 있다(외부 하네스 기동 환경) -- 시험이
// 그 값을 우연히 물려받으면 "usage 에러"를 기대한 시험이 실물 경로를
// 읽어버려 거짓 통과/실패가 난다. 두 변수를 명시적으로 지워 시험을
// 환경에서 격리한다.
function runCli(args) {
  const env = { ...process.env };
  delete env.HARNESS_STATUS_PATH;
  delete env.HARNESS_DOCS_BUDGET_CONFIG_PATH;
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// 되돌리면 RED -- 통과와 거부를 둘 다 보인다 (coder-task.md §3-1 요건 8).
// ---------------------------------------------------------------------------
test("status-budget-check CLI: within budget + 6 role rows -> exit 0, one bytes/role_rows line", () => {
  withFixture(({ configPath, statusPath }) => {
    writeFileSync(statusPath, SIX_ROLE_ROWS, "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^bytes=\d+ role_rows=6\s*$/);
  });
});

test("status-budget-check CLI: over budget -> exit 1, RED", () => {
  withFixture(({ configPath, statusPath }) => {
    writeFileSync(statusPath, SIX_ROLE_ROWS + "\n" + "x".repeat(2000), "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /bytes=\d+ role_rows=6/);
  });
});

test("status-budget-check CLI: role rows wrong count -> exit 1, RED", () => {
  withFixture(({ configPath, statusPath }) => {
    writeFileSync(
      statusPath,
      [SECTION1_HEADER, "| 사람 | a |", "| ORCH | a |"].join("\n"),
      "utf8",
    );
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /role_rows=2/);
  });
});

test("status-budget-check CLI: fail-closed -- missing config file -> exit 2, never treated as 'no cap'", () => {
  withFixture(({ dir, statusPath }) => {
    writeFileSync(statusPath, SIX_ROLE_ROWS, "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      join(dir, "nope.json"),
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /CONFIG_REJECTED/);
  });
});

test("status-budget-check CLI: fail-closed -- malformed config schema -> exit 2", () => {
  withFixture(({ dir, statusPath }) => {
    writeFileSync(
      join(dir, "bad-config.json"),
      JSON.stringify({ schema_version: "wrong" }),
      "utf8",
    );
    writeFileSync(statusPath, SIX_ROLE_ROWS, "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      join(dir, "bad-config.json"),
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /CONFIG_REJECTED/);
  });
});

test("status-budget-check CLI: missing status file -> exit 2", () => {
  withFixture(({ configPath, dir }) => {
    const result = runCli([
      "--status-path",
      join(dir, "nope.md"),
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /file not found/);
  });
});

test("status-budget-check CLI: missing --status-path -> exit 2, usage line", () => {
  withFixture(({ configPath }) => {
    const result = runCli(["--config-path", configPath]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage:/);
  });
});

// ---------------------------------------------------------------------------
// 2R 수리 2 -- §1 표 범위 fail-closed (review-r1.md 축3 재측정).
// ---------------------------------------------------------------------------
test("status-budget-check CLI: §1 header row not found -> exit 2, fail-closed (not silently 'whole file')", () => {
  withFixture(({ configPath, statusPath }) => {
    writeFileSync(statusPath, "이 문서엔 §1 표가 없다\n그냥 산문.", "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /§1 표/);
  });
});

test("status-budget-check CLI: role-like row past the next markdown heading is NOT counted (real STATUS.md shape)", () => {
  withFixture(({ configPath, statusPath }) => {
    const text = [
      SIX_ROLE_ROWS,
      "### 2) 한 줄 상태",
      "| PM | DONE (과거 정책 표, §1 밖) |",
    ].join("\n");
    writeFileSync(statusPath, text, "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /role_rows=6/);
  });
});

// ---------------------------------------------------------------------------
// 2R 수리 1 -- PM_OUTPUT_BUDGET 진단 줄 (review-r1.md 반려 사유 1).
// ---------------------------------------------------------------------------
test("status-budget-check CLI: pm_output_budget_bytes:null -> PM_OUTPUT_BUDGET=UNSET line on stderr, regardless of I1 pass/fail", () => {
  withFixture(({ configPath, statusPath }) => {
    writeFileSync(statusPath, SIX_ROLE_ROWS, "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stderr, /PM_OUTPUT_BUDGET=UNSET \(사람 승인 대기\)/);
  });
});

test("status-budget-check CLI: pm_output_budget_bytes set to a number -> judged line (not UNSET)", () => {
  withFixture(({ dir, statusPath }) => {
    const configPath = writeConfig(dir, { pm_output_budget_bytes: 1000000 });
    writeFileSync(statusPath, SIX_ROLE_ROWS, "utf8");
    const result = runCli([
      "--status-path",
      statusPath,
      "--config-path",
      configPath,
    ]);
    assert.doesNotMatch(result.stderr, /UNSET/);
    assert.match(result.stderr, /PM_OUTPUT_BUDGET=\d+\/1000000/);
  });
});
