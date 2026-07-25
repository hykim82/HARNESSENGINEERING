import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeAdmission, REASON } from "./admission-core.mjs";
import { REASON as PULL_REASON } from "./pull-admission.mjs";
import {
  withTempDir,
  writePullAdmissionBundle,
  pullAdmissionInput,
  makeAllowGates,
} from "./hyk171-cycle3a-fixtures.mjs";

function goodInput(dir, pinPath, gateOverrides = {}) {
  return {
    pullAdmission: pullAdmissionInput(dir, pinPath),
    gates: makeAllowGates(gateOverrides),
  };
}

// ---- causal control: fully valid bundle + all gates ALLOW -> ALLOW ----
test("judgeAdmission: known-good bundle + all gates satisfied -> ALLOW (causal control)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(goodInput(dir, pinPath));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.reason, REASON.ALLOW);
    assert.ok(result.pullAdmission);
    assert.equal(result.pullAdmission.reason, PULL_REASON.ALLOW);
  });
});

test("judgeAdmission: malformed input (no pullAdmission field) -> DENY MALFORMED_INPUT, never reaches judgePullAdmission", () => {
  const result = judgeAdmission({ gates: makeAllowGates() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, REASON.MALFORMED_INPUT);
});

// ---- §6 mutation #7: 새 이슈 / reject streak 2 / 북극성 승인 없음 / hard-stop -> 0 grants ----
test("judgeAdmission: newIssueBoundary=true -> DENY NEW_ISSUE_BOUNDARY (mutation #7 a)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { newIssueBoundary: true }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.NEW_ISSUE_BOUNDARY);
  });
});

test("judgeAdmission: consecutiveRejections=2 -> DENY REJECT_STREAK (mutation #7 b)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { consecutiveRejections: 2 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.REJECT_STREAK);
  });
});

test("judgeAdmission: consecutiveRejections=3 (streak beyond 2) -> still DENY REJECT_STREAK", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { consecutiveRejections: 3 }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.REJECT_STREAK);
  });
});

test("judgeAdmission: missing north-star approval receipt -> DENY NO_NORTH_STAR_APPROVAL (mutation #7 c)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { northStarApprovalReceipt: null }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.NO_NORTH_STAR_APPROVAL);
  });
});

test("judgeAdmission: hardStop=true -> DENY HARD_STOP (mutation #7 d)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(goodInput(dir, pinPath, { hardStop: true }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.HARD_STOP);
  });
});

test("judgeAdmission: dangerousExecution=true -> DENY DANGEROUS_EXECUTION", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { dangerousExecution: true }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.DANGEROUS_EXECUTION);
  });
});

test("judgeAdmission: packetScopeChanged=true -> DENY PACKET_SCOPE_CHANGED", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { packetScopeChanged: true }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PACKET_SCOPE_CHANGED);
  });
});

test("judgeAdmission: authorityKnown!==true (unknown authority) -> DENY UNKNOWN_AUTHORITY", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { authorityKnown: false }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.UNKNOWN_AUTHORITY);
  });
});

test("judgeAdmission: storeCorrupt=true -> DENY STORE_CORRUPT", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { storeCorrupt: true }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.STORE_CORRUPT);
  });
});

// ---- §3 허용 표 자격 게이트: 명시적 true가 아니면 기본 거부(fail-closed) ----
test("judgeAdmission: sameIssueFirstRework not explicitly true -> DENY NOT_FIRST_REWORK", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { sameIssueFirstRework: false }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.NOT_FIRST_REWORK);
  });
});

test("judgeAdmission: withinApprovedScopeBudget not explicitly true -> DENY OUT_OF_SCOPE_BUDGET", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(
      goodInput(dir, pinPath, { withinApprovedScopeBudget: false }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.OUT_OF_SCOPE_BUDGET);
  });
});

test("judgeAdmission: gates missing entirely (undefined) -> fail-closed DENY (defaults never ALLOW)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission({
      pullAdmission: pullAdmissionInput(dir, pinPath),
    });
    assert.equal(result.ok, false);
    assert.notEqual(result.reason, REASON.ALLOW);
  });
});

// ---- sub-check 위임: judgePullAdmission이 DENY하면 이 판정도 DENY, 이유가
// 실려 온다(자체 게이트는 모두 통과했는데도) ----
test("judgeAdmission: all local gates pass but the underlying pull-admission bundle is invalid -> DENY PULL_ADMISSION_DENIED", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir, {
      grantFields: {
        issued_at: "2000-01-01T00:00:00.000Z",
        expires_at: "2000-01-01T00:10:00.000Z",
      }, // 과거 만료 -> EXPIRED
    });
    const result = judgeAdmission(goodInput(dir, pinPath));
    assert.equal(result.ok, false);
    assert.equal(result.reason, REASON.PULL_ADMISSION_DENIED);
    assert.equal(result.detail.pull_admission_reason, PULL_REASON.EXPIRED);
  });
});

// ---- PR 승인/merge·Linear Done 우회 불가(정직 한계) ----
test("judgeAdmission: ALLOW never claims to satisfy the downstream human gate (no such field on the result)", () => {
  withTempDir((dir) => {
    const { pinPath } = writePullAdmissionBundle(dir);
    const result = judgeAdmission(goodInput(dir, pinPath));
    assert.equal(result.ok, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "pr_approved"),
      false,
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, "linear_done"),
      false,
    );
  });
});
