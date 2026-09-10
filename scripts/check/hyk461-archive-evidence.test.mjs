// HYK-461 §4-D regression coverage (2R rewrite -- absorbs the 1R REVIEW
// rejection P1-1/P1-2 + P2). Fixes:
//   §4-A  envelopeBindingValid single-sourced in envelope-archive.mjs, wired
//         into the adapter (HYK-456 §5-1 gap).
//   §4-B  binding-valid preserved copy promoted to substitute evidence when
//         live is overwritten.
//   §4-C  runner receipt preserved per round (head_commit bound, 2R §2-C).
// 2R fixes on top:
//   §2-A (P1-1)  live axis is INDEPENDENT -- a valid live retirement is NOT
//                blocked by a sibling copy's broken self-binding; the binding
//                check applies ONLY on the archive-substitute path.
//   §2-B (P1-2)  the four substitute-promotion failures reject with DISTINCT
//                reasons (binding false / binding absent / label mismatch /
//                2+ valid copies ambiguous), each pinned by a test.
//   §2-C (P2)    preserveRoundRunnerReceipt binds the receipt's head_commit to
//                the round result's head_commit; a mismatch is skipped + noted.
//
// Counting-only tests are forbidden: every axis drives the REAL adapter
// completion path (completeAdmissionReservation) against an isolated ledger +
// real evidence-shaped files, or the real envelope-archive producer, and
// asserts the exact verdict / reason-code text.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync as _rf } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveEnvelopeBindingValidity,
  archiveUnconsumedRoundEnvelope,
} from "./envelope-archive.mjs";
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
// ---------------------------------------------------------------------------
test("§4-A shared validator: valid content_sha256 over the stripped body -> true", () => {
  const body = "task_id: HYK-x\nhead_commit: " + "a".repeat(40) + "\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x kind=unconsumed_result content_sha256=${sha256(
    body,
  )} -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), true);
});

test("§4-A shared validator: content_sha256 mismatched with body -> false", () => {
  const body = "task_id: HYK-x\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x kind=unconsumed_result content_sha256=${"0".repeat(
    64,
  )} -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), false);
});

test("§4-A shared validator: kind=unconsumed_result declared but content_sha256 absent -> false", () => {
  const body = "task_id: HYK-x\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x kind=unconsumed_result -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), false);
});

test("§4-A shared validator: no envelope header -> null (axis N/A, regression 0)", () => {
  const body = "task_id: HYK-x\n";
  assert.equal(resolveEnvelopeBindingValidity(body, body), null);
});

test("§4-A shared validator: header present but kind != unconsumed_result -> null (old archive)", () => {
  const body = "task_id: HYK-x\n";
  const raw = `<!-- envelope-archive: role=REVIEW archived_at=x -->\n${body}`;
  assert.equal(resolveEnvelopeBindingValidity(raw, body), null);
});

// ---------------------------------------------------------------------------
// Group 2: structural single-source proof (anti-drift guard).
// ---------------------------------------------------------------------------
test("§4-A single-source: both consumers IMPORT resolveEnvelopeBindingValidity and neither re-defines it", () => {
  for (const name of [
    "dispatch-gate-decision.mjs",
    "admission-completion-adapter.mjs",
  ]) {
    const src = _rf(join(CHECK_DIR, name), "utf8");
    assert.match(
      src,
      /resolveEnvelopeBindingValidity[\s\S]*from "\.\/envelope-archive\.mjs"/,
      `${name} must import resolveEnvelopeBindingValidity`,
    );
    assert.doesNotMatch(
      src,
      /function\s+resolveEnvelopeBindingValidity\s*\(/,
      `${name} must NOT define its own resolveEnvelopeBindingValidity`,
    );
  }
  assert.match(
    _rf(join(CHECK_DIR, "envelope-archive.mjs"), "utf8"),
    /export function resolveEnvelopeBindingValidity\s*\(/,
  );
});

// ---------------------------------------------------------------------------
// Group 3 + 4: end-to-end through the REAL adapter completion path.
// ---------------------------------------------------------------------------
const RESID = "HYK-461-test-lock-review-1";
const ROLE = "REVIEW";
const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);

const ARCHIVE_BODY = `for: HYK-461-test\nrole: REVIEW\ntask_id: ${RESID}\nhead_commit: ${HEAD}\nverdict: approved\n>>> DONE: REVIEW @ 2026-01-01 00:00:00 KST\n`;
const LIVE_NEXT_ROUND = `for: HYK-999-next\nrole: REVIEW\ntask_id: HYK-999-next-review-1\nhead_commit: ${NEXT_HEAD}\n>>> DONE: REVIEW @ 2026-02-02 00:00:00 KST\n`;

function bodyForLabel(label) {
  return ARCHIVE_BODY.replace(/^task_id: .+$/m, `task_id: ${label}`);
}

function validHeader(contentSha256) {
  return `<!-- envelope-archive: role=${ROLE} archived_at=2026-01-01 00:00:00 KST kind=unconsumed_result content_sha256=${contentSha256} -->\n`;
}

// header with NO kind=unconsumed_result field -> resolveEnvelopeBindingValidity
// returns null (binding-absent, table ⓑ).
function bindingAbsentHeader() {
  return `<!-- envelope-archive: role=${ROLE} archived_at=2026-01-01 00:00:00 KST -->\n`;
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

// Each `copies` entry: { label, kind: "valid"|"invalid"|"absent" }.
function buildHarness({
  liveContent = LIVE_NEXT_ROUND,
  copies = [{ label: RESID, kind: "valid" }],
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

  copies.forEach((c, i) => {
    const body = bodyForLabel(c.label);
    let header;
    if (c.kind === "valid") header = validHeader(sha256(body));
    else if (c.kind === "invalid") header = validHeader("0".repeat(64));
    else header = bindingAbsentHeader(); // "absent"
    writeFileSync(
      join(dir, "rounds", `REVIEW-r${i + 1}.md`),
      header + body,
      "utf8",
    );
  });
  if (receipt) writeRunnerReceipt(dir, receipt.relPath, receipt);
  writeFileSync(
    join(dir, "retirements", "REVIEW-retire-r1.json"),
    JSON.stringify({
      role: ROLE,
      harnessTaskLabel: RESID,
      archivePath: "rounds/REVIEW-r1.md",
      archiveFingerprintClaimed: sha256(bodyForLabel(RESID)),
      blockReasonCode: "RUNNER_GREEN_UNREACHABLE_AT_HEAD",
      successorLabel: "HYK-461-test-next-1",
      recordedAt: "2026-01-01 00:00:00 KST",
      evidenceReceiptPath,
    }),
    "utf8",
  );
  return dir;
}

function release(harnessDir) {
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
  const ledgerPath = join(harnessDir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
  return completeAdmissionReservation({
    reservationId: RESID,
    ledgerPath,
    lockPath: `${ledgerPath}.lock`,
    reason: COMPLETION_REASON.RETIREMENT_RELEASED,
    harnessDir,
    role: ROLE,
  });
}

test("§3.1 P1-1 양성: live task_id 일치 + 보존 사본 결속 «불일치» -> released (1R에서는 여기서 거부됐다)", () => {
  // live matches RESID; the sole preserved copy's self-binding is broken.
  // Per 2R §2-A the live axis is independent -> release MUST succeed.
  const out = release(
    buildHarness({
      liveContent: ARCHIVE_BODY, // task_id echoes RESID
      copies: [{ label: RESID, kind: "invalid" }],
    }),
  );
  assert.equal(out.ok, true, out.reason);
  assert.match(out.reason, /released \(changed=true\)/);
});

test("§3.2 P1-1 음성-A: live 불일치 + 결속 유효 사본 -> 여전히 released (대체 증거 승격)", () => {
  const out = release(buildHarness()); // live overwritten, valid copy, valid receipt
  assert.equal(out.ok, true, out.reason);
  assert.match(out.reason, /released \(changed=true\)/);
});

test("§3.2 P1-1 음성-B: live 불일치 + 결속 «불일치» 사본 -> 거부", () => {
  const out = release(
    buildHarness({ copies: [{ label: RESID, kind: "invalid" }] }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /NOT released|거부/);
});

// P1-2: the four substitute-promotion failures each reject with a DISTINCT
// reason. (All are on the live-overwritten path so the substitute selector
// runs.) Each row pins the exact reason code -- not a broad /NOT released/.
test("§3.3 P1-2 표 ⓐ 결속 false -> ARCHIVE_SUBSTITUTE_BINDING_INVALID", () => {
  const out = release(
    buildHarness({ copies: [{ label: RESID, kind: "invalid" }] }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /ARCHIVE_SUBSTITUTE_BINDING_INVALID/);
});

test("§3.3 P1-2 표 ⓑ 결속 헤더 부재 -> ARCHIVE_SUBSTITUTE_BINDING_ABSENT", () => {
  const out = release(
    buildHarness({ copies: [{ label: RESID, kind: "absent" }] }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /ARCHIVE_SUBSTITUTE_BINDING_ABSENT/);
});

test("§3.3 P1-2 표 ⓒ 이름표가 다름 -> ARCHIVE_SUBSTITUTE_LABEL_MISMATCH", () => {
  const out = release(
    buildHarness({ copies: [{ label: "HYK-OTHER-review-1", kind: "valid" }] }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /ARCHIVE_SUBSTITUTE_LABEL_MISMATCH/);
});

test("§3.3 P1-2 표 ⓓ 결속 유효 사본이 2개 이상(모호) -> ARCHIVE_SUBSTITUTE_AMBIGUOUS (조용히 하나 고르지 않음)", () => {
  const out = release(
    buildHarness({
      copies: [
        { label: RESID, kind: "valid" },
        { label: RESID, kind: "valid" },
      ],
    }),
  );
  assert.equal(out.ok, false);
  assert.match(out.reason, /ARCHIVE_SUBSTITUTE_AMBIGUOUS/);
});

test("§3.3 P1-2: 네 사유가 서로 다름 (같은 문자열이면 미완)", () => {
  const reasons = [
    release(buildHarness({ copies: [{ label: RESID, kind: "invalid" }] }))
      .reason,
    release(buildHarness({ copies: [{ label: RESID, kind: "absent" }] }))
      .reason,
    release(
      buildHarness({
        copies: [{ label: "HYK-OTHER-review-1", kind: "valid" }],
      }),
    ).reason,
    release(
      buildHarness({
        copies: [
          { label: RESID, kind: "valid" },
          { label: RESID, kind: "valid" },
        ],
      }),
    ).reason,
  ];
  const codes = reasons.map((r) => r.match(/ARCHIVE_SUBSTITUTE_[A-Z_]+/)[0]);
  assert.equal(
    new Set(codes).size,
    4,
    `사유가 구별되지 않음: ${codes.join(", ")}`,
  );
});

test("§3 (d) live 덮임 + 보존 사본 없음 -> LABEL_MISMATCH 거부", () => {
  const out = release(buildHarness({ copies: [] }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /ARCHIVE_SUBSTITUTE_LABEL_MISMATCH/);
});

test("§3 (e) live 덮임 + 결속 유효 사본 + 영수증 runner_exit 0 -> BLOCK_REASON_UNCONFIRMED", () => {
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
});

// ---------------------------------------------------------------------------
// Group 5: §4-C + 2R §2-C runner-receipt preservation with head_commit binding.
// ---------------------------------------------------------------------------
test("§4-C preserves the live runner-receipt.json (same HEAD) alongside the round copy under rounds/ (no collision with receipts/)", () => {
  const dir = tmpDir("hyk461-preserve-");
  const receiptJson = JSON.stringify({
    schema_version: 1,
    runner_exit: 1,
    head_commit: HEAD,
  });
  writeFileSync(join(dir, "runner-receipt.json"), receiptJson, "utf8");
  const out = archiveUnconsumedRoundEnvelope({
    role: "REVIEW",
    resultContent: ARCHIVE_BODY, // head_commit: HEAD
    harnessDir: dir,
  });
  assert.equal(out.ok, true, out.reason);
  assert.equal(
    out.runnerReceiptPath,
    join("rounds", "REVIEW-r1-runner-receipt.json"),
  );
  assert.deepEqual(readdirSync(join(dir, "rounds")).sort(), [
    "REVIEW-r1-runner-receipt.json",
    "REVIEW-r1.md",
  ]);
  assert.equal(
    readFileSync(join(dir, "rounds", "REVIEW-r1-runner-receipt.json"), "utf8"),
    receiptJson,
  );
  // preserved copy survives a later overwrite of the LIVE receipt
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

test("§2-C P2: live runner-receipt.json head_commit != round result head_commit -> preservation SKIPPED (round copy still written) + reason", () => {
  const dir = tmpDir("hyk461-preserve-mismatch-");
  // live receipt belongs to a DIFFERENT round (NEXT_HEAD), the round result
  // is HEAD -> refuse to bind the wrong receipt.
  writeFileSync(
    join(dir, "runner-receipt.json"),
    JSON.stringify({ runner_exit: 1, head_commit: NEXT_HEAD }),
    "utf8",
  );
  const out = archiveUnconsumedRoundEnvelope({
    role: "REVIEW",
    resultContent: ARCHIVE_BODY, // head_commit: HEAD
    harnessDir: dir,
  });
  assert.equal(out.ok, true, out.reason); // round copy still written
  assert.equal(out.runnerReceiptPath, null);
  assert.match(out.reason, /DIFFERENT round|!=/);
  // only the round copy exists, not the receipt
  assert.deepEqual(readdirSync(join(dir, "rounds")), ["REVIEW-r1.md"]);
});

test("§2-C P2: matching HEAD receipt IS preserved (positive control for the mismatch guard)", () => {
  const dir = tmpDir("hyk461-preserve-match-");
  writeFileSync(
    join(dir, "runner-receipt.json"),
    JSON.stringify({ runner_exit: 1, head_commit: HEAD }),
    "utf8",
  );
  const out = archiveUnconsumedRoundEnvelope({
    role: "REVIEW",
    resultContent: ARCHIVE_BODY,
    harnessDir: dir,
  });
  assert.equal(
    out.runnerReceiptPath,
    join("rounds", "REVIEW-r1-runner-receipt.json"),
  );
});

test("§4-C no live runner-receipt.json -> round copy still written, preservation skipped", () => {
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
