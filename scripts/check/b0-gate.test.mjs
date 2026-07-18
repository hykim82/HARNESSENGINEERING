import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  classifyB0,
  checkB0Contract,
  B0_REASON_CODES,
  B0_GATE_CLI_FLAGS,
} from "./b0-gate.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./b0-gate.mjs", import.meta.url));

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "b0-gate-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

const REQUEST_BLOCK = [
  "## B0 사전 비평 요청",
  "b0_id: HYK-160-b0-1",
  "대상 결정: 결정적 분해",
  "트리거: 2번",
  "선택안: 2사이클",
  "왜 이 안인가: 신뢰경계 분리",
  "검토한 대안: 1사이클 통합",
  "영향 계약·층: coder/review",
  "미확인·제약: 없음",
  "PM에 묻는 것: 반례",
].join("\n");

const RESPONSE_BLOCK = [
  "## B0 사전 비평 답변",
  "b0_id: HYK-160-b0-1",
  "판정: 변경 권고",
  "핵심 근거: §2",
  "반례·누락 위험: 없음",
].join("\n");

const CONSUMPTION_BLOCK = [
  "<!-- b0-consumption",
  "b0_id: HYK-160-b0-1",
  "결론: 채택",
  "근거: §3",
  "linear_comment: https://linear.app/anchor/issue/HYK-160/comment-1",
  "-->",
].join("\n");

// ---------------------------------------------------------------------------
// classifyB0
// ---------------------------------------------------------------------------

test("(1) classifyB0: request block present -> target", () => {
  const result = classifyB0(`# drop\n\n${REQUEST_BLOCK}\n`);
  assert.equal(result.classification, "target");
});

test("(2) classifyB0: non-target one-liner -> non-target with reason captured", () => {
  const result = classifyB0(
    "# drop\n\nB0: 비대상 (사유: 기계적 오탈자 수정)\n",
  );
  assert.equal(result.classification, "non-target");
  assert.equal(result.reasonNote, "기계적 오탈자 수정");
});

test("(3) classifyB0: neither marker present -> null", () => {
  const result = classifyB0("# drop\n\nno B0 marker here.\n");
  assert.equal(result.classification, null);
});

// ---------------------------------------------------------------------------
// checkB0Contract — known-bad / paired-good matrix
// ---------------------------------------------------------------------------

test("(4) known-bad: no classification marker at all -> B0_CLASSIFICATION_REQUIRED", () => {
  const result = checkB0Contract({ dropText: "# drop\n\nno marker\n" });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_CLASSIFICATION_REQUIRED/);
});

test("(5) known-bad: 비대상 marker with empty 사유 -> B0_CLASSIFICATION_REQUIRED", () => {
  const result = checkB0Contract({ dropText: "B0: 비대상 (사유: )\n" });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_CLASSIFICATION_REQUIRED/);
});

test("(6) paired good: 비대상 marker with a real 사유 -> PASS, no further evidence required", () => {
  const result = checkB0Contract({
    dropText: "B0: 비대상 (사유: 명백한 한 줄 조치)\n",
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(7) known-bad: target drop, response block entirely missing -> B0_EVIDENCE_REQUIRED", () => {
  const result = checkB0Contract({ dropText: `# drop\n\n${REQUEST_BLOCK}\n` });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_EVIDENCE_REQUIRED/);
});

test("(8) paired good: same drop, response block added -> still blocked (consumption still missing) but response gap alone is closed", () => {
  const withoutResponse = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
  });
  assert.match(withoutResponse.reason, /답변.*없음|B0_EVIDENCE_REQUIRED.*답변/);
  const withResponse = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
  });
  // consumption still absent -> still BLOCK, but for a different (consumption) reason now
  assert.equal(withResponse.status, "BLOCK");
  assert.match(withResponse.reason, /consumption record found/);
});

test("(9) known-bad: consumption record missing entirely (request+response present) -> B0_EVIDENCE_REQUIRED", () => {
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_EVIDENCE_REQUIRED/);
});

test("(10) paired good: all three blocks present with matching b0_id -> PASS", () => {
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${CONSUMPTION_BLOCK}\n`,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(11) known-bad: response b0_id differs from request b0_id -> B0_ID_MISMATCH", () => {
  const badResponse = RESPONSE_BLOCK.replace("HYK-160-b0-1", "HYK-160-b0-2");
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${badResponse}\n`,
    consumptionText: `# issue comment\n\n${CONSUMPTION_BLOCK}\n`,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_ID_MISMATCH/);
});

test("(12) paired good: response b0_id corrected back to match -> PASS (single-variable fix)", () => {
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${CONSUMPTION_BLOCK}\n`,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(13) known-bad: consumption b0_id differs from request -> B0_ID_MISMATCH", () => {
  const badConsumption = CONSUMPTION_BLOCK.replace(
    "HYK-160-b0-1",
    "HYK-160-b0-9",
  );
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${badConsumption}\n`,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_ID_MISMATCH/);
});

test("(14) known-bad: consumption block present but missing 결론 field -> B0_EVIDENCE_REQUIRED", () => {
  const noConclusion = CONSUMPTION_BLOCK.replace(/결론:.*\n/, "");
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${noConclusion}\n`,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_EVIDENCE_REQUIRED/);
  assert.match(result.reason, /결론/);
});

test("(15) request block itself missing b0_id -> B0_EVIDENCE_REQUIRED (cannot link anything)", () => {
  const noId = REQUEST_BLOCK.replace(/b0_id:.*\n/, "");
  const result = checkB0Contract({ dropText: `# drop\n\n${noId}\n` });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_EVIDENCE_REQUIRED/);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("(16) CLI: complete target exchange across three files -> exit 0", () => {
  withFixtureDir((dir) => {
    const dropPath = join(dir, "pm-task.md");
    const responsePath = join(dir, "pm.md");
    const consumptionPath = join(dir, "consumption.md");
    writeFileSync(dropPath, `# drop\n\n${REQUEST_BLOCK}\n`, "utf8");
    writeFileSync(responsePath, `# pm\n\n${RESPONSE_BLOCK}\n`, "utf8");
    writeFileSync(
      consumptionPath,
      `# comment\n\n${CONSUMPTION_BLOCK}\n`,
      "utf8",
    );
    const { status } = runCli([
      "--drop",
      dropPath,
      "--response",
      responsePath,
      "--consumption",
      consumptionPath,
    ]);
    assert.equal(status, 0);
  });
});

test("(17) CLI: 비대상 drop needs no --response/--consumption -> exit 0", () => {
  withFixtureDir((dir) => {
    const dropPath = join(dir, "pm-task.md");
    writeFileSync(dropPath, "B0: 비대상 (사유: 명백한 한 줄 조치)\n", "utf8");
    const { status } = runCli(["--drop", dropPath]);
    assert.equal(status, 0);
  });
});

test("(18) CLI: no classification marker -> exit 2 (BLOCK)", () => {
  withFixtureDir((dir) => {
    const dropPath = join(dir, "pm-task.md");
    writeFileSync(dropPath, "# drop\n\nno marker\n", "utf8");
    const { status, stderr } = runCli(["--drop", dropPath]);
    assert.equal(status, 2);
    assert.match(stderr, /B0_CLASSIFICATION_REQUIRED/);
  });
});

test("(19) CLI: missing drop file -> exit 1 (operator error, not a judgment)", () => {
  withFixtureDir((dir) => {
    const { status } = runCli(["--drop", join(dir, "does-not-exist.md")]);
    assert.equal(status, 1);
  });
});

test("(20) CLI: no --drop given -> usage, exit 1", () => {
  const { status } = runCli([]);
  assert.equal(status, 1);
});

// ---------------------------------------------------------------------------
// HYK-160-coder-2 (review-1 결함 2): consumption record must carry a
// linear_comment evidence pointer -- a local b0-consumption mirror alone
// duplicated the Linear-comment-is-정본 ledger with nothing tying the two
// together.
// ---------------------------------------------------------------------------

test("(21) known-bad: consumption block has 결론 but no linear_comment field -> B0_CONSUMPTION_EVIDENCE_REQUIRED", () => {
  const noLinearComment = CONSUMPTION_BLOCK.replace(/linear_comment:.*\n/, "");
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${noLinearComment}\n`,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_CONSUMPTION_EVIDENCE_REQUIRED/);
});

test("(22) known-bad: linear_comment present but malformed (not a linear.app URL or 'comment:<id>') -> B0_CONSUMPTION_EVIDENCE_REQUIRED", () => {
  const badFormat = CONSUMPTION_BLOCK.replace(
    "https://linear.app/anchor/issue/HYK-160/comment-1",
    "just some text",
  );
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${badFormat}\n`,
  });
  assert.equal(result.status, "BLOCK");
  assert.match(result.reason, /B0_CONSUMPTION_EVIDENCE_REQUIRED/);
});

test("(23) paired good: linear_comment field alone added back (URL form) -> PASS", () => {
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${CONSUMPTION_BLOCK}\n`,
  });
  assert.equal(result.status, "PASS", result.reason);
});

test("(24) paired good: linear_comment accepted in the alternate 'comment:<id>' short form (single-variable swap from the URL form)", () => {
  const shortForm = CONSUMPTION_BLOCK.replace(
    "https://linear.app/anchor/issue/HYK-160/comment-1",
    "comment:c-abc123",
  );
  const result = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# issue comment\n\n${shortForm}\n`,
  });
  assert.equal(result.status, "PASS", result.reason);
});

// ---------------------------------------------------------------------------
// HYK-160-coder-2 (review-1 결함 2, 처방 c): integration -- the actual
// drop-time CLI invocation ORCH runs before a coder-task.md drop, across the
// three scenarios the reject asked for: gate not run at all (nothing
// blocks, because nothing checked), gate run and blocked, gate run and
// passed. All three share one realistic drop layout (pm-task.md/pm.md/a
// local consumption echo), the exact filenames ORCH's real invocation uses.
// ---------------------------------------------------------------------------

test("(25) integration known-bad: gate run at drop time on an incomplete exchange (missing linear_comment) -> blocks the drop, exit 2", () => {
  withFixtureDir((dir) => {
    const dropPath = join(dir, "pm-task.md");
    const responsePath = join(dir, "pm.md");
    const consumptionPath = join(dir, "b0-consumption-HYK-160-b0-1.md");
    writeFileSync(dropPath, `# HYK-160 pm-task\n\n${REQUEST_BLOCK}\n`, "utf8");
    writeFileSync(responsePath, `# pm\n\n${RESPONSE_BLOCK}\n`, "utf8");
    const noLinearComment = CONSUMPTION_BLOCK.replace(
      /linear_comment:.*\n/,
      "",
    );
    writeFileSync(
      consumptionPath,
      `# 소비 미러\n\n${noLinearComment}\n`,
      "utf8",
    );

    const result = runCli([
      "--drop",
      dropPath,
      "--response",
      responsePath,
      "--consumption",
      consumptionPath,
    ]);
    assert.equal(
      result.status,
      2,
      "an incomplete exchange must block the drop when the gate is actually invoked",
    );
    assert.match(result.stderr, /B0_CONSUMPTION_EVIDENCE_REQUIRED/);
  });
});

test("(26) integration paired good: same drop layout, complete exchange (linear_comment present) -> gate run at drop time passes, exit 0", () => {
  withFixtureDir((dir) => {
    const dropPath = join(dir, "pm-task.md");
    const responsePath = join(dir, "pm.md");
    const consumptionPath = join(dir, "b0-consumption-HYK-160-b0-1.md");
    writeFileSync(dropPath, `# HYK-160 pm-task\n\n${REQUEST_BLOCK}\n`, "utf8");
    writeFileSync(responsePath, `# pm\n\n${RESPONSE_BLOCK}\n`, "utf8");
    writeFileSync(
      consumptionPath,
      `# 소비 미러\n\n${CONSUMPTION_BLOCK}\n`,
      "utf8",
    );

    const result = runCli([
      "--drop",
      dropPath,
      "--response",
      responsePath,
      "--consumption",
      consumptionPath,
    ]);
    assert.equal(
      result.status,
      0,
      "a complete exchange must pass when the gate is actually invoked at drop time",
    );
  });
});

test("(27) integration honesty check: gate NOT run at drop time -- an incomplete exchange sitting on disk is never inspected, nothing blocks it (documents why (c)'s CLI wiring is ORCH's responsibility, not a filesystem watcher this module runs on its own)", () => {
  withFixtureDir((dir) => {
    const dropPath = join(dir, "pm-task.md");
    const responsePath = join(dir, "pm.md");
    const consumptionPath = join(dir, "b0-consumption-HYK-160-b0-1.md");
    writeFileSync(dropPath, `# HYK-160 pm-task\n\n${REQUEST_BLOCK}\n`, "utf8");
    writeFileSync(responsePath, `# pm\n\n${RESPONSE_BLOCK}\n`, "utf8");
    const noLinearComment = CONSUMPTION_BLOCK.replace(
      /linear_comment:.*\n/,
      "",
    );
    writeFileSync(
      consumptionPath,
      `# 소비 미러\n\n${noLinearComment}\n`,
      "utf8",
    );

    // Deliberately never call runCli(...) here -- this IS the "미실행"
    // scenario: an incomplete exchange sits on disk, unexamined, and
    // nothing about this module changes it or blocks anything on its own.
    // The only honest assertion for an uninvoked check is that the fixture
    // is exactly what was written -- there is no gate side effect to assert.
    const written = readFileSync(consumptionPath, "utf8");
    assert.equal(written, `# 소비 미러\n\n${noLinearComment}\n`);
  });
});

// ---------------------------------------------------------------------------
// HYK-160-coder-3 (review-2 조건 2·3): doc-code contract -- docs/
// enforcement-v1.md §H's prose (exact CLI command, reason-code list) must
// match b0-gate.mjs's real exports, mechanically, so a future edit to
// either side that drifts from the other fails this suite instead of
// waiting for a reviewer to notice by hand (same convention as
// reject-streak.test.mjs's §G extraction test).
// ---------------------------------------------------------------------------

function readEnforcementDoc() {
  const docPath = fileURLToPath(
    new URL("../../docs/enforcement-v1.md", import.meta.url),
  );
  return readFileSync(docPath, "utf8");
}

function extractH0Section(docText) {
  const start = docText.indexOf("## H — B0 사전 설계비평");
  if (start === -1)
    throw new Error(
      "could not find '## H — B0 사전 설계비평' section in docs/enforcement-v1.md",
    );
  const rest = docText.slice(start);
  const nextSectionIdx = rest.slice(1).search(/^## [A-Z] —/m);
  return nextSectionIdx === -1 ? rest : rest.slice(0, nextSectionIdx + 1);
}

test("(28) doc-code contract: enforcement-v1.md §H's documented command line names exactly the CLI flags b0-gate.mjs exports (B0_GATE_CLI_FLAGS)", () => {
  const section = extractH0Section(readEnforcementDoc());
  const commandLineMatch = section.match(
    /`node scripts\/check\/b0-gate\.mjs ([^`]+)`/,
  );
  assert.ok(
    commandLineMatch,
    "doc §H must contain a fenced 'node scripts/check/b0-gate.mjs ...' command line",
  );
  const commandLine = commandLineMatch[1];
  for (const flag of B0_GATE_CLI_FLAGS) {
    assert.ok(
      commandLine.includes(flag),
      `doc command line must mention CLI flag '${flag}' -- got: ${commandLine}`,
    );
  }
});

test("(29) doc-code contract: enforcement-v1.md §H's reason-code list matches b0-gate.mjs's B0_REASON_CODES exactly (same set, no extra/missing)", () => {
  const section = extractH0Section(readEnforcementDoc());
  const codeMatches = [...section.matchAll(/`(B0_[A-Z_]+)`/g)].map((m) => m[1]);
  const documentedCodes = [...new Set(codeMatches)];
  for (const code of B0_REASON_CODES) {
    assert.ok(
      documentedCodes.includes(code),
      `doc §H must mention reason code '${code}'`,
    );
  }
  for (const code of documentedCodes) {
    assert.ok(
      B0_REASON_CODES.includes(code),
      `doc §H mentions '${code}' but b0-gate.mjs's B0_REASON_CODES does not export it -- drift`,
    );
  }
});

test("(30) doc-code contract: every documented reason code is a real, live reason string checkB0Contract actually returns (not just a name match)", () => {
  const badMarker = checkB0Contract({ dropText: "no marker\n" });
  assert.match(badMarker.reason, /B0_CLASSIFICATION_REQUIRED/);

  const badEvidence = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
  });
  assert.match(badEvidence.reason, /B0_EVIDENCE_REQUIRED/);

  const badId = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK.replace("HYK-160-b0-1", "HYK-160-b0-9")}\n`,
    consumptionText: `# c\n\n${CONSUMPTION_BLOCK}\n`,
  });
  assert.match(badId.reason, /B0_ID_MISMATCH/);

  const badConsumptionEvidence = checkB0Contract({
    dropText: `# drop\n\n${REQUEST_BLOCK}\n`,
    responseText: `# pm\n\n${RESPONSE_BLOCK}\n`,
    consumptionText: `# c\n\n${CONSUMPTION_BLOCK.replace(/linear_comment:.*\n/, "")}\n`,
  });
  assert.match(
    badConsumptionEvidence.reason,
    /B0_CONSUMPTION_EVIDENCE_REQUIRED/,
  );
});
