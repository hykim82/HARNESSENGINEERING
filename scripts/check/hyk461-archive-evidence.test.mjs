// HYK-461 §4-D regression coverage -- "보존 사본을 위조 저항을 잃지 않고
// 반납 증거로 인정" + "envelopeBindingValid를 어댑터 경로에도 결선".
//
// This round fixes the availability failure HYK-456 §1-3/§3-3 measured: a
// prior round's honest retirement (RUNNER_GREEN_UNREACHABLE_AT_HEAD) could
// never release its ledger reservation once the NEXT round overwrote the live
// `<role>.md`, because verifyRetirementEvidence keyed the task_id echo to that
// (now-clobbered) live file. Two structural gaps were closed:
//   §4-A  admission-completion-adapter.mjs's resolveRetirementArchiveCandidateForAdapter
//         never computed envelopeBindingValid (HYK-456 §5-1) -- it reached the
//         core as `undefined`, so the core's `=== false` ARCHIVE_ENVELOPE_
//         BINDING_INVALID guard was a no-op on the adapter's release path.
//         Now single-sourced in envelope-archive.mjs (the producer of the
//         very content_sha256 header it reads back) and imported by BOTH the
//         canonical gate (dispatch-gate-decision.mjs) and this adapter.
//   §4-B  when the live task_id echo mismatches, a binding-VALID preserved
//         copy whose own body echoes the reservationId is promoted to
//         substitute evidence -- live axis kept, archive axis ADDED.
//
// §4-D forbids counting-only tests: every axis below drives the REAL adapter
// completion path (completeAdmissionReservation) against an isolated ledger +
// real evidence-shaped files, and asserts the exact verdict text.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync as _rf } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { resolveEnvelopeBindingValidity } from "./envelope-archive.mjs";
import { archiveUnconsumedRoundEnvelope } from "./envelope-archive.mjs";
import { completeAdmissionReservation } from "./admission-completion-adapter.mjs";
import {
  createEmptyLedger,
  admitReservation,
  COMPLETION_REASON,
} from "../supervisor/admission-ledger-core.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Group 1: the shared read-back validator, across every axis value.
// (envelope-archive.resolveEnvelopeBindingValidity -- the ONE definition both
// consumers now share.)
// ---------------------------------------------------------------------------
test("§4-A shared validator: valid content_sha256 over the stripped body -> true", () => {
  const body = "task_id: HYK-x\nhead_commit: " + "a".repeat(40) + "\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x kind=unconsumed_result content_sha256=${sha256(
    body,
  )} -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), true);
});

test("§4-A shared validator: content_sha256 mismatched with body -> false (손 사본 ⓐ)", () => {
  const body = "task_id: HYK-x\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x kind=unconsumed_result content_sha256=${"0".repeat(
    64,
  )} -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), false);
});

test("§4-A shared validator: kind=unconsumed_result declared but content_sha256 field absent -> false (손 사본 ⓑ)", () => {
  const body = "task_id: HYK-x\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x kind=unconsumed_result -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), false);
});

test("§4-A shared validator: no envelope header -> null (this axis does not apply, regression 0)", () => {
  const body = "task_id: HYK-x\n";
  assert.equal(resolveEnvelopeBindingValidity(body, body), null);
});

test("§4-A shared validator: header present but kind != unconsumed_result -> null (old consumption-success archive)", () => {
  const body = "task_id: HYK-x\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), null);
});

// ---------------------------------------------------------------------------
// Group 2: structural single-source proof -- the exact anti-drift guard the
// retirement-block-reason-shared.test.mjs precedent established. If a future
// round re-copies resolveEnvelopeBindingValidity into either consumer instead
// of importing it, the drift HYK-456 §5-1 suffered can silently return.
// ---------------------------------------------------------------------------
test("§4-A single-source: both consumers IMPORT resolveEnvelopeBindingValidity from envelope-archive.mjs and neither re-defines it", () => {
  const consumers = [
    "dispatch-gate-decision.mjs",
    "admission-completion-adapter.mjs",
  ];
  for (const name of consumers) {
    const src = _rf(join(CHECK_DIR, name), "utf8");
    assert.match(
      src,
      /resolveEnvelopeBindingValidity[\s\S]*from "\.\/envelope-archive\.mjs"/,
      `${name} must import resolveEnvelopeBindingValidity from envelope-archive.mjs`,
    );
    assert.doesNotMatch(
      src,
      /function\s+resolveEnvelopeBindingValidity\s*\(/,
      `${name} must NOT define its own resolveEnvelopeBindingValidity (single-source only)`,
    );
  }
  // And the ONE definition lives in the producer module.
  assert.match(
    _rf(join(CHECK_DIR, "envelope-archive.mjs"), "utf8"),
    /export function resolveEnvelopeBindingValidity\s*\(/,
  );
});

// ---------------------------------------------------------------------------
// Group 3: end-to-end through the REAL adapter completion path, isolated
// ledger + real evidence-shaped files. This is the raison d'être -- "다음
// 라운드가 live 파일을 덮은 뒤에도 앞 라운드의 정당한 은퇴가 열리는가".
// ---------------------------------------------------------------------------
const RESID = "HYK-461-test-lock-review-1";
const ROLE = "REVIEW";
const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);

// The preserved round copy's BODY (stripped of the envelope header). Its
// task_id echoes RESID and it carries the round's own head_commit -- exactly
// what a genuine unconsumed REVIEW round result file holds.
const ARCHIVE_BODY = `for: HYK-461-test\nrole: REVIEW\ntask_id: ${RESID}\nhead_commit: ${HEAD}\nverdict: approved\n>>> DONE: REVIEW @ 2026-01-01 00:00:00 KST\n`;

// The live <role>.md AFTER the next round overwrote it -- a DIFFERENT label
// and head_commit, exactly the HYK-346/HYK-450 availability failure shape.
const LIVE_NEXT_ROUND = `for: HYK-999-next\nrole: REVIEW\ntask_id: HYK-999-next-review-1\nhead_commit: ${NEXT_HEAD}\n>>> DONE: REVIEW @ 2026-02-02 00:00:00 KST\n`;

function envelopeHeader(contentSha256) {
  return `<!-- envelope-archive: role=${ROLE} archived_at=2026-01-01 00:00:00 KST kind=unconsumed_result content_sha256=${contentSha256} -->\n`;
}

function writeRunnerReceipt(harnessDir, relPath, { runnerExit, headCommit }) {
  const full = join(harnessDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    JSON.stringify({
      schema_version: 1,
      runner_exit: runnerExit,
      tests: 6164,
      pass: 6157,
      fail: runnerExit === 0 ? 0 : 1,
      skip: 6,
      head_commit: headCommit,
      finished_at: "2026-01-01 00:00:00 KST",
    }),
    "utf8",
  );
}

// Builds a fully-formed .harness fixture. Overrides let each case break
// exactly one axis (binding / label / receipt / copy presence / live match).
function buildHarness({
  bodyForSha = ARCHIVE_BODY, // body used to WRITE the copy
  claimedShaOverride, // force a wrong content_sha256 header (binding break)
  archiveLabel = RESID, // the copy's own echoed task_id
  writeCopy = true,
  liveContent = LIVE_NEXT_ROUND,
  receipt = {
    runnerExit: 1,
    headCommit: HEAD,
    relPath: "rounds/REVIEW-r1-runner-receipt.json",
  },
  evidenceReceiptPath = "rounds/REVIEW-r1-runner-receipt.json",
} = {}) {
  const dir = tmpDir("hyk461-e2e-");
  writeFileSync(join(dir, "review.md"), liveContent, "utf8");
  writeFileSync(
    join(dir, "review-task.md"),
    `task_id: ${RESID}\ndropped_at: 2026-01-01 00:00:00 KST\n`,
    "utf8",
  );
  mkdirSync(join(dir, "rounds"), { recursive: true });
  mkdirSync(join(dir, "retirements"), { recursive: true });

  const copyBody = bodyForSha.replace(
    /^task_id: .+$/m,
    `task_id: ${archiveLabel}`,
  );
  const trueSha = sha256(copyBody);
  const headerSha = claimedShaOverride ?? trueSha;
  if (writeCopy) {
    writeFileSync(
      join(dir, "rounds", "REVIEW-r1.md"),
      envelopeHeader(headerSha) + copyBody,
      "utf8",
    );
  }
  if (receipt) writeRunnerReceipt(dir, receipt.relPath, receipt);
  writeFileSync(
    join(dir, "retirements", "REVIEW-retire-r1.json"),
    JSON.stringify({
      role: ROLE,
      harnessTaskLabel: RESID,
      archivePath: "rounds/REVIEW-r1.md",
      // The record claims the TRUE stripped-body sha (the honest producer's
      // value) -- a binding break perturbs only the header the copy carries,
      // not this record, exactly like a real hand-tampered copy.
      archiveFingerprintClaimed: sha256(
        ARCHIVE_BODY.replace(/^task_id: .+$/m, `task_id: ${RESID}`),
      ),
      blockReasonCode: "RUNNER_GREEN_UNREACHABLE_AT_HEAD",
      successorLabel: "HYK-461-test-next-1",
      recordedAt: "2026-01-01 00:00:00 KST",
      evidenceReceiptPath,
    }),
    "utf8",
  );
  return dir;
}

function isolatedLedger(dir) {
  let ledger = createEmptyLedger("2026-01-01T00:00:00.000Z");
  const admit = admitReservation(ledger, {
    reservationId: RESID,
    cap: 1,
    now: "2026-01-01T00:00:00.000Z",
    role: ROLE,
    seatKey: "tab:leaf",
  });
  assert.equal(admit.decision, "ADMITTED");
  ledger = admit.ledger;
  const ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
  return ledgerPath;
}

function release(harnessDir) {
  const ledgerPath = isolatedLedger(harnessDir);
  return completeAdmissionReservation({
    reservationId: RESID,
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
    reason: COMPLETION_REASON.RETIREMENT_RELEASED,
    harnessDir,
    role: ROLE,
  });
}

test("§5-1(a) live 덮임 + 결속 유효 보존 사본 + 유효 영수증 -> released (changed=true)", () => {
  const out = release(buildHarness());
  assert.equal(out.ok, true, out.reason);
  assert.match(out.reason, /released \(changed=true\)/);
});

test("§5-1(b) live 일치 + 아카이브 결속 어긋남 -> ARCHIVE_ENVELOPE_BINDING_INVALID 거부 (§4-A 결선 증명)", () => {
  // live matches RESID (so we take the live path and build a candidate whose
  // envelopeBindingValid is computed from the tampered copy) -> the core's
  // `=== false` guard MUST fire now that the adapter populates the field.
  const liveMatches = ARCHIVE_BODY; // task_id echoes RESID
  const out = release(
    buildHarness({
      claimedShaOverride: "0".repeat(64),
      liveContent: liveMatches,
    }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /ARCHIVE_ENVELOPE_BINDING_INVALID|원문 결속/);
  assert.match(out.reason, /NOT released/);
});

test("§5-1(b2) live 덮임 + 아카이브 결속 어긋남 -> 대체 증거 승격 거부 (위조 사본은 대체로 승격되지 않는다)", () => {
  const out = release(buildHarness({ claimedShaOverride: "0".repeat(64) }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /결속이 유효한 보존 사본.*없음|task_id 에코/);
  assert.match(out.reason, /NOT released/);
});

test("§5-1(c) live 덮임 + 이름표가 다른 사본 -> 거부", () => {
  const out = release(buildHarness({ archiveLabel: "HYK-OTHER-review-1" }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /NOT released/);
});

test("§5-1(d) live 덮임 + 보존 사본 없음 -> 거부", () => {
  const out = release(buildHarness({ writeCopy: false }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /NOT released/);
});

test("§5-1(e) live 덮임 + 결속 유효 사본이지만 영수증 runner_exit 0 -> BLOCK_REASON_UNCONFIRMED 거부", () => {
  const out = release(
    buildHarness({
      receipt: {
        runnerExit: 0,
        headCommit: HEAD,
        relPath: "rounds/REVIEW-r1-runner-receipt.json",
      },
    }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /BLOCK_REASON_UNCONFIRMED|기계로 확인/);
  assert.match(out.reason, /NOT released/);
});

test("§5-1(e2) live 덮임 + 결속 유효 사본이지만 영수증 파일 자체가 없음 -> 거부", () => {
  const out = release(buildHarness({ receipt: null }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /NOT released/);
});

// ---------------------------------------------------------------------------
// Group 4: §4-C runner-receipt preservation at the round-preservation point.
// ---------------------------------------------------------------------------
test("§4-C archiveUnconsumedRoundEnvelope preserves the live runner-receipt.json alongside the round copy, keyed to the same round number, under rounds/ (no collision with receipts/)", () => {
  const dir = tmpDir("hyk461-preserve-");
  const receiptJson = JSON.stringify({
    schema_version: 1,
    runner_exit: 1,
    head_commit: HEAD,
  });
  writeFileSync(join(dir, "runner-receipt.json"), receiptJson, "utf8");
  const out = archiveUnconsumedRoundEnvelope({
    role: "REVIEW",
    resultContent: ARCHIVE_BODY,
    harnessDir: dir,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(
    out.runnerReceiptPath,
    join("rounds", "REVIEW-r1-runner-receipt.json"),
  );
  const names = readdirSync(join(dir, "rounds")).sort();
  assert.deepEqual(names, ["REVIEW-r1-runner-receipt.json", "REVIEW-r1.md"]);
  // byte-identical copy
  assert.equal(
    readFileSync(join(dir, "rounds", "REVIEW-r1-runner-receipt.json"), "utf8"),
    receiptJson,
  );
  // the preserved copy survives a later round overwriting the LIVE receipt
  writeFileSync(
    join(dir, "runner-receipt.json"),
    JSON.stringify({ runner_exit: 0, head_commit: NEXT_HEAD }),
    "utf8",
  );
  assert.equal(
    JSON.parse(
      readFileSync(
        join(dir, "rounds", "REVIEW-r1-runner-receipt.json"),
        "utf8",
      ),
    ).head_commit,
    HEAD,
  );
});

test("§4-C no live runner-receipt.json -> round copy still written, preservation skipped (best-effort, never throws)", () => {
  const dir = tmpDir("hyk461-preserve-none-");
  const out = archiveUnconsumedRoundEnvelope({
    role: "REVIEW",
    resultContent: ARCHIVE_BODY,
    harnessDir: dir,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(out.runnerReceiptPath, null);
  assert.deepEqual(readdirSync(join(dir, "rounds")), ["REVIEW-r1.md"]);
});
