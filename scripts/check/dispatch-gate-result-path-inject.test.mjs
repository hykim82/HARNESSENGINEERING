// HYK-465 (coder-task.md §A) -- dispatch-gate-decision.mjs's new
// bestEffortInjectResultPaths best-effort machine-injection step.
//
// 실사고(2026-09-10): 검토자가 "필수 정직 한계 절이 없다 ... 작성자 결과
// 산출물도 없다"로 P1 반려했다. .harness/ 는 git-ignore라 작성자 결과가
// 커밋 diff에 전혀 안 나오는데, 지시서 자체가 그 절대경로를 안 적어서다
// -- 검토자는 볼 수 있는 표면을 전수 조사하고 정직하게 "없다"고 판정한
// 것이었다. 이 시험은 (a) 그 절대경로가 이제 기계로 지시서에 박히는 것,
// (b) 주입이 없으면 실사고와 같은 "산출물 없음" 신호 부재가 재현되는
// 것(음성 확인), (c) 되돌림 변이로 이 시험 자체가 헛것이 아님을 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-result-path-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-result-path-test-receipts-")),
  "dispatch-receipts.jsonl",
);
writeFileSync(SHARED_EMPTY_RECEIPT_PATH, "", "utf8");

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// A reviewer searching a task file for "where is the artifact" would grep
// for an absolute path (drive letter + the role's result filename). This
// is the exact signal 2026-09-10's reject was missing.
function hasDiscoverableResultPathSignal(text, harnessDir, role) {
  const expected = join(harnessDir, `${role}.md`);
  return text.includes(expected);
}

test("(a) fresh coder-task.md gets result_file/runner_receipt_file/gitignore-note/discipline lines machine-injected right after task_id:, ALLOW unaffected", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `task_id: HYK-9201-inject-1\nrole: CODER\nsome body\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stdout,
      /result-path block machine-injected \(HYK-465\/HYK-480\)/,
      "insertion must be visible in the delivery-time stdout (조용히 고치지 말 것, dropped_at 관례와 동일)",
    );

    const after = readFileSync(taskPath, "utf8");
    assert.ok(
      hasDiscoverableResultPathSignal(after, dir, "coder"),
      "the injected file must literally contain the absolute path to coder.md",
    );
    assert.match(
      after,
      /^runner_receipt_file:\s*.+runner-receipt\.json$/im,
      "runner receipt absolute path must also be injected",
    );
    assert.match(
      after,
      /harness_gitignore_note:.*git-ignore/i,
      "the one-fact-line explaining .harness/ is git-ignored must be present",
    );
    assert.match(
      after,
      /worktree_discipline:.*HEAD/,
      "the '검토 뒤 워크트리를 옮기지 마라' discipline line (책임자 §A-3) must also be machine-injected",
    );
    // HYK-480 §5: 결과 파일 필수 머리줄 점검표(role/task_id/for/verdict/
    // head_commit/완료 표지) 7줄도 같은 블록으로 기계 주입되어야 한다.
    assert.match(after, /^result_header_checklist_note:.*완료 표지 모양/im);
    assert.match(after, /^result_header_checklist_role:.*'CODER'/im);
    assert.match(after, /^result_header_checklist_task_id:/im);
    assert.match(after, /^result_header_checklist_for:.*검토 전용/im);
    assert.match(after, /^result_header_checklist_verdict:.*검토 전용/im);
    assert.match(after, /^result_header_checklist_headcommit:.*검토 전용/im);
    assert.match(after, /^result_header_checklist_done:.*손기입 금지/im);
    // HYK-485 범위3이 추가한 회차별 러너 파일명 규약 줄도 같은 블록에
    // 있어야 한다(이 단정이 없으면 이 시험은 그 줄의 존재를 못 잡는다).
    assert.match(
      after,
      /^result_header_checklist_runner_naming:.*runner-receipt-run<N>\.json/im,
    );

    // Lines must sit immediately after task_id: (this injection runs
    // BEFORE bestEffortStampDroppedAt -- dispatch-gate-decision.mjs's call
    // site comment -- so dropped_at's own "insert right after task_id:"
    // ends up running last and lands closer to task_id: than this block).
    // HYK-486: a6c0809 added result_header_checklist_runner_naming: as an
    // 8th checklist line, shifting everything after it down by one --
    // this seal must track the block's real length, not a stale count.
    const lines = after.split("\n");
    assert.equal(lines[0], "task_id: HYK-9201-inject-1");
    assert.match(lines[1], /^dropped_at:/);
    assert.match(lines[2], /^result_file:/);
    assert.match(lines[3], /^runner_receipt_file:/);
    assert.match(lines[4], /^harness_gitignore_note:/);
    assert.match(lines[5], /^worktree_discipline:/);
    assert.match(lines[6], /^result_header_checklist_note:/);
    assert.match(lines[7], /^result_header_checklist_role:/);
    assert.match(lines[8], /^result_header_checklist_task_id:/);
    assert.match(lines[9], /^result_header_checklist_for:/);
    assert.match(lines[10], /^result_header_checklist_verdict:/);
    assert.match(lines[11], /^result_header_checklist_headcommit:/);
    assert.match(lines[12], /^result_header_checklist_done:/);
    assert.match(lines[13], /^result_header_checklist_runner_naming:/);
    assert.equal(lines[14], "role: CODER");
  });
});

test("(b) idempotent -- running the gate a second time does not duplicate the injected block", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9202-idempotent-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const first = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(first.status, 0);
    const afterFirst = readFileSync(taskPath, "utf8");
    const firstCount = (afterFirst.match(/^result_file:/gim) ?? []).length;
    assert.equal(firstCount, 1);

    const second = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(second.status, 0);
    assert.doesNotMatch(
      second.stdout,
      /result-path block machine-injected/,
      "second run must be a silent no-op (already injected)",
    );
    const afterSecond = readFileSync(taskPath, "utf8");
    const secondCount = (afterSecond.match(/^result_file:/gim) ?? []).length;
    assert.equal(secondCount, 1, "must not duplicate the block on re-run");
  });
});

test("(c) no task_id: line present -- injection step is a no-op, file untouched", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `role: CODER\nno task_id line here\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    runCli([taskPath, "--ledger", ledgerPath]);
    const after = readFileSync(taskPath, "utf8");
    assert.equal(
      after,
      original,
      "file must be byte-identical when no task_id: line exists (this round does not invent one)",
    );
  });
});

test("(d) pre-existing REJECT fixture shape still REJECTs -- injection does not weaken the gate, but still runs (unconditional, like dropped_at)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9203-reject-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9203": {
          streak: 2,
          history: [
            { task_id: "HYK-9203-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9203-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT/);
    const after = readFileSync(taskPath, "utf8");
    assert.ok(
      hasDiscoverableResultPathSignal(after, dir, "coder"),
      "injection must still have run even though delivery was rejected",
    );
  });
});

// ---------------------------------------------------------------------------
// (e) 음성 확인 (coder-task.md §A-4-2, ★필수): 주입이 «빠진» 지시서 --
// 실사고와 정확히 같은 모양 -- 를 합성해, 검토자가 이 파일 텍스트만
// 보고서는 결과물의 절대경로를 찾을 수 없다는 것(=2026-09-10 반려의
// 정확한 재현)을 먼저 보인다. 그 다음 이 CLI를 거치면 그 신호가 실제로
// 생긴다는 것을 대조한다 -- "주입이 일을 한다"는 이 대비 없이는 증명되지
// 않는다(coder-task.md §A-4 "이게 없으면 주입이 일을 한다를 증명 못
// 한다").
// ---------------------------------------------------------------------------
test("(e) 음성 확인: 주입 전(2026-09-10 실사고 모양)에는 절대경로 신호가 없다 -- 이 CLI를 거친 뒤에야 생긴다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // 실사고와 동일한 모양: task_id는 있지만 결과 파일 경로에 대한 언급이
    // 전혀 없는, 사람이 손으로 적은 지시서.
    const handAuthored = `task_id: HYK-9204-before-1\nrole: CODER\nfor: HYK-9204\n${ONE_B_BLOCK}`;
    assert.equal(
      hasDiscoverableResultPathSignal(handAuthored, dir, "coder"),
      false,
      "before injection, exactly like 2026-09-10, there is no absolute-path signal a reviewer could find",
    );

    writeFileSync(taskPath, handAuthored, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    runCli([taskPath, "--ledger", ledgerPath]);

    const afterGate = readFileSync(taskPath, "utf8");
    assert.ok(
      hasDiscoverableResultPathSignal(afterGate, dir, "coder"),
      "after passing through the gate, the reviewer-discoverable absolute-path signal must now exist",
    );
  });
});
