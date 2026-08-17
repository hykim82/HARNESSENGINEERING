// HYK-292 I2 -- orch-boot-budget-check.mjs CLI 계약 시험. mkdtemp
// 픽스처만 사용한다(coder-task.md §3-1 요건 6) -- 실물 관제실(D
// 드라이브)에 의존하지 않으므로 CI에서도 돈다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "orch-boot-budget-check.mjs",
);
const CONFIG_BODY = JSON.stringify({
  schema_version: "docs-budget/v1",
  status_budget_bytes: 100,
  orch_boot_budget_bytes: 50,
  pm_output_budget_bytes: null,
});

// 4R -- 실물 relay-terminal-setup.md §1.5 부팅줄 아래에 ORCH가 추가한
// 기계 판독 표식의 형태를 그대로 옮긴 픽스처(coder-task.md §2 -- 부팅
// 계약 문서의 orch-boot-set 표식에서 기계 유도).
function charterFixture() {
  return [
    "## 1.5 ORCH 부팅줄",
    "",
    "① 부팅 시 아래 순서로 PHASE-HANDOFF.md 와 STATUS.md만 읽고 이어가라.",
    "",
    "<!-- orch-boot-set: STATUS.md, PHASE-HANDOFF.md -->",
    '<!-- 기계 판독용(HYK-292 I2). 위 부팅줄의 "만 읽고" 목록과 일치 유지. -->',
    "",
    "## 2. 권한",
  ].join("\n");
}

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-orch-boot-budget-cli-"));
  try {
    const configPath = join(dir, "docs-budget-config.json");
    const controlRoomPath = join(dir, "control-room");
    const charterPath = join(dir, "charter.md");
    writeFileSync(configPath, CONFIG_BODY, "utf8");
    writeFileSync(charterPath, charterFixture(), "utf8");
    return fn({ dir, configPath, controlRoomPath, charterPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  const env = { ...process.env };
  delete env.HARNESS_CONTROL_ROOM_PATH;
  delete env.HARNESS_DOCS_BUDGET_CONFIG_PATH;
  delete env.HARNESS_BOOT_CHARTER_PATHS;
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
// 되돌리면 RED -- 통과와 거부를 둘 다 보인다.
// ---------------------------------------------------------------------------
test("orch-boot-budget-check CLI: within budget -> exit 0, ORCH_BOOT_BYTES line, derivation note on stderr", () => {
  withFixture(({ configPath, controlRoomPath, charterPath }) => {
    mkdirSync(controlRoomPath);
    writeFileSync(join(controlRoomPath, "STATUS.md"), "x".repeat(20), "utf8");
    writeFileSync(
      join(controlRoomPath, "PHASE-HANDOFF.md"),
      "x".repeat(20),
      "utf8",
    );
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      charterPath,
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^ORCH_BOOT_BYTES=40\s*$/);
    assert.match(
      result.stderr,
      /manifest_derived_from=.*charter\.md files=STATUS\.md,PHASE-HANDOFF\.md count=2/,
    );
    assert.match(result.stderr, /scope=/);
  });
});

test("orch-boot-budget-check CLI: over budget -> exit 1, RED", () => {
  withFixture(({ configPath, controlRoomPath, charterPath }) => {
    mkdirSync(controlRoomPath);
    writeFileSync(join(controlRoomPath, "STATUS.md"), "x".repeat(40), "utf8");
    writeFileSync(
      join(controlRoomPath, "PHASE-HANDOFF.md"),
      "x".repeat(40),
      "utf8",
    );
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      charterPath,
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /ORCH_BOOT_BYTES=80/);
  });
});

test("orch-boot-budget-check CLI: fail-closed -- missing config -> exit 2", () => {
  withFixture(({ dir, controlRoomPath, charterPath }) => {
    mkdirSync(controlRoomPath);
    writeFileSync(join(controlRoomPath, "STATUS.md"), "x", "utf8");
    writeFileSync(join(controlRoomPath, "PHASE-HANDOFF.md"), "x", "utf8");
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      join(dir, "nope.json"),
      "--charter-paths",
      charterPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /CONFIG_REJECTED/);
  });
});

test("orch-boot-budget-check CLI: manifest file missing (STATUS.md absent) -> exit 2, fail-closed (not silently 0 bytes)", () => {
  withFixture(({ configPath, controlRoomPath, charterPath }) => {
    mkdirSync(controlRoomPath);
    writeFileSync(join(controlRoomPath, "PHASE-HANDOFF.md"), "x", "utf8");
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      charterPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /manifest file not found/);
  });
});

test("orch-boot-budget-check CLI: missing --control-room -> exit 2, usage line", () => {
  withFixture(({ configPath, charterPath }) => {
    const result = runCli([
      "--config-path",
      configPath,
      "--charter-paths",
      charterPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage:/);
  });
});

// ---------------------------------------------------------------------------
// 2R 수리 3 -- 계약 문서 유도 실패는 fail-closed (요건 3), 두 파일로
// 조용히 축소하지 않는다.
// ---------------------------------------------------------------------------
test("orch-boot-budget-check CLI: missing --charter-paths -> exit 2, usage line", () => {
  withFixture(({ configPath }) => {
    const result = runCli(["--config-path", configPath]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /usage:/);
  });
});

test("orch-boot-budget-check CLI: charter document not found -> exit 2, fail-closed", () => {
  withFixture(({ dir, configPath, controlRoomPath }) => {
    mkdirSync(controlRoomPath);
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      join(dir, "no-such-charter.md"),
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /charter document not found/);
  });
});

test("orch-boot-budget-check CLI: charter document has no orch-boot-set marker -> exit 2, MANIFEST_DERIVATION_FAILED (not a silent fallback to two hardcoded files)", () => {
  withFixture(({ dir, configPath, controlRoomPath }) => {
    mkdirSync(controlRoomPath);
    const badCharterPath = join(dir, "bad-charter.md");
    writeFileSync(badCharterPath, "# 아무 문서\n부팅 얘기는 없다.", "utf8");
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      badCharterPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /MANIFEST_DERIVATION_FAILED/);
    assert.match(result.stderr, /no_marker|표식을 하나도 못 찾음/);
  });
});

test("orch-boot-budget-check CLI: orch-boot-set marker present but empty -> exit 2, MANIFEST_DERIVATION_FAILED", () => {
  withFixture(({ dir, configPath, controlRoomPath }) => {
    mkdirSync(controlRoomPath);
    const emptyMarkerCharterPath = join(dir, "empty-marker-charter.md");
    writeFileSync(
      emptyMarkerCharterPath,
      "## 1.5 ORCH 부팅줄\n\n<!-- orch-boot-set:  -->\n",
      "utf8",
    );
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      emptyMarkerCharterPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /MANIFEST_DERIVATION_FAILED/);
    assert.match(result.stderr, /파일명이 0개/);
  });
});

test("orch-boot-budget-check CLI: two orch-boot-set markers -> exit 2, MANIFEST_DERIVATION_FAILED (does not silently pick the first)", () => {
  withFixture(({ dir, configPath, controlRoomPath }) => {
    mkdirSync(controlRoomPath);
    const dualMarkerCharterPath = join(dir, "dual-marker-charter.md");
    writeFileSync(
      dualMarkerCharterPath,
      "<!-- orch-boot-set: STATUS.md, PHASE-HANDOFF.md -->\n<!-- orch-boot-set: 다른.md -->\n",
      "utf8",
    );
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      dualMarkerCharterPath,
    ]);
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /MANIFEST_DERIVATION_FAILED/);
    assert.match(result.stderr, /2개 발견됨/);
  });
});

test("orch-boot-budget-check CLI: 표식 목록에 항목이 하나 늘면(계약 문서 수정, 코드 수정 0) 예산 계산에 자동으로 들어간다", () => {
  withFixture(({ dir, configPath, controlRoomPath }) => {
    mkdirSync(controlRoomPath);
    writeFileSync(join(controlRoomPath, "STATUS.md"), "x".repeat(10), "utf8");
    writeFileSync(
      join(controlRoomPath, "PHASE-HANDOFF.md"),
      "x".repeat(10),
      "utf8",
    );
    writeFileSync(join(controlRoomPath, "새필독.md"), "x".repeat(10), "utf8");
    const growingCharterPath = join(dir, "growing-charter.md");
    writeFileSync(
      growingCharterPath,
      [
        "## 1.5 ORCH 부팅줄",
        "",
        "<!-- orch-boot-set: STATUS.md, PHASE-HANDOFF.md, 새필독.md -->",
        "",
        "## 2. 권한",
      ].join("\n"),
      "utf8",
    );
    const result = runCli([
      "--control-room",
      controlRoomPath,
      "--config-path",
      configPath,
      "--charter-paths",
      growingCharterPath,
    ]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /^ORCH_BOOT_BYTES=30\s*$/);
    assert.match(result.stderr, /새필독\.md/);
  });
});
