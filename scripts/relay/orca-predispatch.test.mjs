import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createArmStore, armStorePath, hashContent } from "./arm-state.mjs";
import { checkPreDispatch, buildSpec, verifySpec, REASON } from "./orca-predispatch.mjs";

const SCRIPT_PATH = fileURLToPath(new URL("./orca-predispatch.mjs", import.meta.url));

const GRANT = Object.freeze({
  arm_id: "arm-hyk162-1",
  cycle_id: "cycle-hyk162-1",
  human_approval_ref: "한용 2026-07-19 00:30",
  issued_at: "2026-07-19T00:30:00.000Z",
  expires_at: "2026-07-19T23:59:00.000Z",
  allowed_lanes: ["CODER"],
  allowed_task_ids: ["HYK-999-coder-1"],
  max_starts_total: 1,
  max_starts_per_lane: 1,
  max_rejections: 3,
  publish_allowed: false,
  question_policy: "pause",
  error_policy: "pause",
});
const TASK_CONTENT = "task_id: HYK-999-coder-1\nsome task body\n";
const IN_WINDOW_NOW = Date.parse("2026-07-19T12:00:00.000Z");
const EXPECTED_TARGET = "coder-terminal-main";
const EXPECTED_ROLE = "CODER";

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// 합성 fixture: 서명 패킷 + arm store(attempts_total override 가능) + task 파일.
function withFixture({ grant = GRANT, attemptsTotal = 0, taskContent = TASK_CONTENT, signed = true } = {}, fn) {
  const dir = mkdtempSync(join(tmpdir(), "orca-predispatch-test-"));
  try {
    const packetPath = join(dir, "packet.md");
    writeFileSync(packetPath, signed ? "packet_id: PKT-1\n승인: OK 한용 2026-07-19 00:30\n" : "packet_id: PKT-1\n승인: ☐\n", "utf8");

    const created = createArmStore(grant, { at: grant.issued_at });
    assert.equal(created.ok, true);
    const storeContent = { ...created.store, attempts_total: attemptsTotal };
    const storePath = armStorePath(dir, grant.arm_id);
    writeFileSync(storePath, JSON.stringify(storeContent), "utf8");

    const taskFilePath = join(dir, "coder-task.md");
    writeFileSync(taskFilePath, taskContent, "utf8");

    fn({ dir, packetPath, storePath, taskFilePath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function goodRequest(overrides = {}) {
  return {
    human_approval_ref: GRANT.human_approval_ref,
    arm_id: GRANT.arm_id,
    cycle_id: GRANT.cycle_id,
    task_id: GRANT.allowed_task_ids[0],
    content_hash: hashContent(TASK_CONTENT),
    target: EXPECTED_TARGET,
    role: EXPECTED_ROLE,
    ...overrides,
  };
}

function baseInput(fx, overrides = {}) {
  return {
    packetPath: fx.packetPath,
    armDir: fx.dir,
    arm_id: GRANT.arm_id,
    taskFilePath: fx.taskFilePath,
    nowMs: IN_WINDOW_NOW,
    request: goodRequest(overrides.request),
    expected: { target: EXPECTED_TARGET, role: EXPECTED_ROLE, ...overrides.expected },
    ...overrides.top,
  };
}

test("(0) known-good baseline: all fields matching -> ALLOW, store untouched", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx));
    assert.equal(result.ok, true);
    assert.equal(result.allow, true);
    assert.equal(result.reason, REASON.ALLOW);
    assert.equal(fileSha256(fx.storePath), before, "checkPreDispatch must not mutate the arm store");
  });
});

test("(1) PACKET_UNSIGNED: packet not signed -> deny, store untouched", () => {
  withFixture({ signed: false }, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PACKET_UNSIGNED);
    assert.equal(fileSha256(fx.storePath), before);
  });
});

test("(2) G1 known-bad: human_approval_ref reversed -> APPROVAL_REF_MISMATCH", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { request: { human_approval_ref: "다른사람 2026-07-19 00:30" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.APPROVAL_REF_MISMATCH);
    assert.equal(fileSha256(fx.storePath), before);
  });
});
test("(2b) G1 known-good: human_approval_ref matching (paired) -> ALLOW", () => {
  withFixture({}, (fx) => {
    const result = checkPreDispatch(baseInput(fx));
    assert.equal(result.allow, true);
  });
});

test("(3) G1 known-bad: arm_id reversed -> ARM_ID_MISMATCH", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { request: { arm_id: "arm-other" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ARM_ID_MISMATCH);
    assert.equal(fileSha256(fx.storePath), before);
  });
});
test("(3b) G1 known-good: arm_id matching (paired) -> ALLOW", () => {
  withFixture({}, (fx) => {
    assert.equal(checkPreDispatch(baseInput(fx)).allow, true);
  });
});

test("(4) G1 known-bad: cycle_id reversed -> CYCLE_ID_MISMATCH", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { request: { cycle_id: "cycle-other" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.CYCLE_ID_MISMATCH);
    assert.equal(fileSha256(fx.storePath), before);
  });
});
test("(4b) G1 known-good: cycle_id matching (paired) -> ALLOW", () => {
  withFixture({}, (fx) => {
    assert.equal(checkPreDispatch(baseInput(fx)).allow, true);
  });
});

test("(5) G1 known-bad: task_id not in allowed_task_ids -> TASK_ID_MISMATCH", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { request: { task_id: "HYK-000-coder-9" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TASK_ID_MISMATCH);
    assert.equal(fileSha256(fx.storePath), before);
  });
});
test("(5b) G1 known-good: task_id in allowed_task_ids (paired) -> ALLOW", () => {
  withFixture({}, (fx) => {
    assert.equal(checkPreDispatch(baseInput(fx)).allow, true);
  });
});

test("(6) EXPIRED: nowMs past expires_at -> EXPIRED", () => {
  withFixture({}, (fx) => {
    const result = checkPreDispatch(baseInput(fx, { top: { nowMs: Date.parse("2026-07-20T00:00:01.000Z") } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.EXPIRED);
  });
});

test("(7) BUDGET_EXHAUSTED: attempts_total already at max -> BUDGET_EXHAUSTED", () => {
  withFixture({ attemptsTotal: 1 }, (fx) => {
    const result = checkPreDispatch(baseInput(fx));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.BUDGET_EXHAUSTED);
  });
});

test("(8) G3 known-bad: content_hash reversed (tampered) -> CONTENT_HASH_MISMATCH", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { request: { content_hash: "0".repeat(64) } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.CONTENT_HASH_MISMATCH);
    assert.equal(fileSha256(fx.storePath), before);
  });
});
test("(8b) G3 known-good: content_hash matching actual task file content (paired) -> ALLOW", () => {
  withFixture({}, (fx) => {
    assert.equal(checkPreDispatch(baseInput(fx)).allow, true);
  });
});

test("(9) G3 known-bad: task file's own task_id no longer matches request -> TASK_ID_MISMATCH (spec cross-check)", () => {
  withFixture({ taskContent: "task_id: HYK-DIFFERENT-1\nswapped body\n" }, (fx) => {
    const result = checkPreDispatch(baseInput(fx));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TASK_ID_MISMATCH);
  });
});

test("(10) G4 known-bad: expected.target unset -> TARGET_UNSPECIFIED", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { expected: { target: undefined } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TARGET_UNSPECIFIED);
    assert.equal(fileSha256(fx.storePath), before);
  });
});

test("(11) G4 known-bad: request.target reversed to a different terminal -> TARGET_MISMATCH", () => {
  withFixture({}, (fx) => {
    const before = fileSha256(fx.storePath);
    const result = checkPreDispatch(baseInput(fx, { request: { target: "worktree-pane-9" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.TARGET_MISMATCH);
    assert.equal(fileSha256(fx.storePath), before);
  });
});
test("(11b) G4 known-good: request.target fixed to the configured CODER terminal (paired) -> ALLOW", () => {
  withFixture({}, (fx) => {
    assert.equal(checkPreDispatch(baseInput(fx)).allow, true);
  });
});

test("(12) ROLE_UNDETERMINED: request.role missing -> ROLE_UNDETERMINED", () => {
  withFixture({}, (fx) => {
    const result = checkPreDispatch(baseInput(fx, { request: { role: undefined } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ROLE_UNDETERMINED);
  });
});

test("(13) ROLE_UNDETERMINED: request.role mismatched (e.g. REVIEW instead of CODER) -> ROLE_UNDETERMINED", () => {
  withFixture({}, (fx) => {
    const result = checkPreDispatch(baseInput(fx, { request: { role: "REVIEW" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.ROLE_UNDETERMINED);
  });
});

test("(14) STORE_UNAVAILABLE: no arm store on disk for the given arm_id", () => {
  withFixture({}, (fx) => {
    const result = checkPreDispatch(baseInput(fx, { top: { arm_id: "arm-never-armed" } }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.STORE_UNAVAILABLE);
  });
});

// ---- spec 계약: buildSpec/verifySpec ----
test("(15) buildSpec produces exactly 'go <task_id>' with no trailing whitespace", () => {
  const r = buildSpec("HYK-999-coder-1");
  assert.equal(r.ok, true);
  assert.equal(r.spec, "go HYK-999-coder-1");
});
test("(16) buildSpec refuses empty/whitespace-containing task_id", () => {
  assert.equal(buildSpec("").ok, false);
  assert.equal(buildSpec("HYK 999").ok, false);
  assert.equal(buildSpec(undefined).ok, false);
});

test("(17) verifySpec known-good: spec matches task file header exactly -> ok", () => {
  withFixture({}, (fx) => {
    const r = verifySpec("go HYK-999-coder-1", fx.taskFilePath);
    assert.equal(r.ok, true);
    assert.equal(r.task_id, "HYK-999-coder-1");
    assert.equal(r.content_hash, hashContent(TASK_CONTENT));
  });
});
test("(18) verifySpec known-bad: trailing newline in spec -> SPEC_FORMAT_INVALID", () => {
  withFixture({}, (fx) => {
    const r = verifySpec("go HYK-999-coder-1\n", fx.taskFilePath);
    assert.equal(r.ok, false);
    assert.match(r.reason, /SPEC_FORMAT_INVALID/);
  });
});
test("(19) verifySpec known-bad: spec task_id != task file task_id -> SPEC_TASK_ID_MISMATCH", () => {
  withFixture({}, (fx) => {
    const r = verifySpec("go HYK-OTHER-1", fx.taskFilePath);
    assert.equal(r.ok, false);
    assert.match(r.reason, /SPEC_TASK_ID_MISMATCH/);
  });
});
test("(20) verifySpec known-bad: expectedContentHash mismatch -> SPEC_CONTENT_HASH_MISMATCH", () => {
  withFixture({}, (fx) => {
    const r = verifySpec("go HYK-999-coder-1", fx.taskFilePath, { expectedContentHash: "0".repeat(64) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /SPEC_CONTENT_HASH_MISMATCH/);
  });
});

// ---- CLI: Orca 호출 없이 stdin JSON -> 판정 결과만 출력 ----
test("(21) CLI exits 0 and prints allow:true for a known-good payload", () => {
  withFixture({}, (fx) => {
    const input = baseInput(fx);
    const out = execFileSync("node", [SCRIPT_PATH], { input: JSON.stringify(input), encoding: "utf8" });
    const parsed = JSON.parse(out);
    assert.equal(parsed.allow, true);
  });
});
test("(22) CLI exits non-zero for a known-bad payload (packet unsigned)", () => {
  withFixture({ signed: false }, (fx) => {
    const input = baseInput(fx);
    assert.throws(() => execFileSync("node", [SCRIPT_PATH], { input: JSON.stringify(input), encoding: "utf8" }));
  });
});
