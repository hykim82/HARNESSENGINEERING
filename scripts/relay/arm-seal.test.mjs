import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import {
  sealArm,
  parseAddendum,
  deriveConfirmationPhrase,
} from "./arm-seal.mjs";
import {
  sha256,
  makeFixtureDir,
  writeAddendum,
  goodDeps,
} from "./arm-seal-test-helpers.mjs";

// HYK-162 coder-8 (보고서-pm2.md §4.2/§4.4, 패킷-addendum-초안.md §F): arm-seal
// 세리모니 단위 테스트. 전부 실제 임시 디렉터리 + 실 fs(관례는 arm-state.test.mjs와
// 동형 -- nowFn/readlineFn만 주입). 실 orca 호출은 이 파일 어디에도 없다.

test("(G1) known-good: fully filled+signed addendum seals authorization+grant+ARMED store", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, fx.fields);
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, true, result.reason);
    const auth = JSON.parse(readFileSync(result.authorizationPath, "utf8"));
    const grantRaw = readFileSync(result.grantPath, "utf8");
    const grant = JSON.parse(grantRaw);
    const store = JSON.parse(readFileSync(result.armStorePath, "utf8"));
    assert.equal(auth.grant_sha256, sha256(grantRaw));
    assert.equal(grant.addendum_sha256, auth.addendum_sha256);
    assert.equal(grant.arm_id, "arm-test-1");
    assert.equal(store.grant.arm_id, "arm-test-1");
    assert.equal(store.state, "ARMED");
    assert.equal(auth.issued_at, "2026-07-19T02:05:00.000Z");
    assert.equal(auth.expires_at, "2026-07-19T02:35:00.000Z");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("(A2) known-bad: addendum unsigned (승인: ☐) -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      signedApproval: "☐",
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("(A2) known-bad: addendum signature malformed (single-char tamper) -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      signedApproval: "0K 한용 2026-07-19 11:05", // 'OK' -> '0K'
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /signed|malformed/i);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("(A2) known-bad: any remaining ☐ placeholder anywhere in structured fields -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      target_terminal_handle: "☐",
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /☐/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: packet SHA-256 in addendum does not match actual packet file -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      packet_sha256: "0".repeat(64),
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /packet SHA-256 mismatch/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: packet itself unsigned -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const tampered = "packet_id: PKT-TEST-1\n승인: ☐\n";
    writeFileSync(fx.packetPath, tampered, "utf8");
    const tamperedHash = sha256(tampered).toUpperCase();
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      packet_sha256: tamperedHash,
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not signed/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: task file SHA-256 does not match addendum's claimed hash -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      task_sha256: "1".repeat(64),
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /task file SHA-256 mismatch/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: target role/repo undetermined ('판단 불가') -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, {
      ...fx.fields,
      target_role_evidence: "판단 불가",
    });
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /undetermined/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: human types the wrong confirmation phrase -> no partial success, nothing written", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, fx.fields);
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps({ readlineFn: async () => "ARM HYK-162 WRONG-TASK" }),
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /confirmation mismatch/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: already-expired grant at seal time -> issuance refused", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, fx.fields);
    const result = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps({ nowFn: () => "2026-07-19T03:00:00.000Z" }), // 36 min after signature
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /already be expired/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("known-bad: re-sealing the same arm_id a second time is refused (no overwrite)", async () => {
  const fx = makeFixtureDir();
  try {
    const addendumPath = writeAddendum(fx.dir, fx.fields);
    const first = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(first.ok, true, first.reason);
    const second = await sealArm({
      addendumPath,
      outDir: fx.dir,
      deps: goodDeps(),
    });
    assert.equal(second.ok, false);
    assert.match(second.reason, /already sealed|existing file/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

// ---- parser unit tests (vacuous-test guard: prove the fenced-block scoping actually works) ----
test("parseAddendum: ☐ outside fenced blocks (explanatory prose) does not block issuance", () => {
  const content = [
    "> 이 문서는 초안이다. 아래 `☐`가 모두 실측값으로 채워지고...",
    "```text",
    "addendum_id: ADD-1",
    "allowed_task_id: X",
    "```",
  ].join("\n");
  const parsed = parseAddendum(content);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.fields.addendum_id, "ADD-1");
});

test("parseAddendum: ☐ inside a fenced block is detected and blocks issuance", () => {
  const content = [
    "```text",
    "addendum_id: ADD-1",
    "allowed_task_id: ☐",
    "```",
  ].join("\n");
  const parsed = parseAddendum(content);
  assert.equal(parsed.ok, false);
});

test("deriveConfirmationPhrase derives 'ARM HYK-<n> <task_id>' from addendum_id/allowed_task_id", () => {
  const phrase = deriveConfirmationPhrase({
    addendum_id: "ADD-PKT-20260719-HYK162-ORCA-HYBRID-SPIKE-ARM-1",
    allowed_task_id: "SPIKE-LIVE-1",
  });
  assert.equal(phrase, "ARM HYK-162 SPIKE-LIVE-1");
});
