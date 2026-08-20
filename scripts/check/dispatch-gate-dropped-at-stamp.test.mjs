// HYK-257-done-stamp-2 §2 범위2 ⓑ -- dispatch-gate-decision.mjs's new
// best-effort dropped_at machine-stamp step.
//
// 실재 앵커(관제실 dispatch-worker.ps1, 읽기 전용 실측 원문): 배달 직전
// 항상 `node scripts/check/dispatch-gate-decision.mjs <roleTaskFile>
// --expect-repo-root <worktree>`를 부른다 -- 그 첫 인자가 이 파일이 새로
// 손대는 대상이다. 이 시험은 (a) 이미 있는 dropped_at: 줄이 새 기계
// 스탬프로 덮어써지고 그 외 내용은 바이트 동일하게 남는지, (b) 이 CLI의
// 기존 게이트/exit-code 계약이 전혀 바뀌지 않는지를 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-stamp-test-"));
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
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

const DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;

test("(a) existing dropped_at: line is rewritten to a fresh machine-stamped value, rest of file byte-identical", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `task_id: HYK-9101-stamp-1\ndropped_at: 2020-01-01 00:00 KST\nrole: CODER\nsome body line\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const before = Date.now();
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    const after = Date.now();

    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);

    const rewritten = readFileSync(taskPath, "utf8");
    assert.notEqual(
      rewritten,
      original,
      "dropped_at line must have been rewritten",
    );

    const match = rewritten.match(DROPPED_AT_RE);
    assert.ok(match, "dropped_at: line must still be present");
    assert.notEqual(match[1].trim(), "2020-01-01 00:00 KST");

    // The stamped value must be a real machine-clock reading taken during
    // this CLI invocation (KST, minute precision) -- not an arbitrary
    // string. Parse it back and confirm it falls within [before, after].
    const stampedMatch = match[1]
      .trim()
      .match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) KST$/);
    assert.ok(
      stampedMatch,
      `stamped value must match KST minute format: '${match[1]}'`,
    );
    const stampedMs = new Date(
      `${stampedMatch[1]}T${stampedMatch[2]}:00+09:00`,
    ).getTime();
    // Minute-precision rounds down -- allow a 60s window on both sides.
    assert.ok(
      stampedMs >= before - 60_000 && stampedMs <= after + 60_000,
      `stamped value ${match[1]} must be within the CLI invocation window`,
    );

    // Everything OUTSIDE the dropped_at line must be byte-identical.
    const expectedRewritten = original.replace(
      DROPPED_AT_RE,
      `dropped_at: ${match[1].trim()}`,
    );
    assert.equal(rewritten, expectedRewritten);
  });
});

test("(b) HYK-316-dropped-stamp-1: no dropped_at: line but task_id: IS present -- a machine dropped_at is INSERTED right after task_id:, ALLOW unaffected", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `task_id: HYK-9102-nodropped-1\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stdout,
      /dropped_at MISSING -- machine-inserted/,
      "insertion must be visible in the delivery-time stdout (§2 요건: 조용히 고치지 말 것)",
    );
    const after = readFileSync(taskPath, "utf8");
    assert.notEqual(
      after,
      original,
      "file must have been rewritten -- a dropped_at: line was inserted",
    );
    const lines = after.split("\n");
    assert.equal(lines[0], "task_id: HYK-9102-nodropped-1");
    assert.match(
      lines[1],
      /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/,
      "inserted dropped_at: line must sit immediately after task_id:",
    );
    assert.equal(
      after,
      `${lines[0]}\n${lines[1]}\n${original.slice(lines[0].length + 1)}`,
      "everything else in the file must be preserved verbatim around the inserted line",
    );
  });
});

test("(b2) HYK-316-dropped-stamp-1: neither dropped_at: nor task_id: line present -- stamp step is still a no-op, file untouched", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `role: CODER\nno task_id line at all here\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    const after = readFileSync(taskPath, "utf8");
    assert.equal(
      after,
      original,
      "file must be byte-identical when neither dropped_at: nor task_id: line exists",
    );
    void r;
  });
});

test("(c) pre-existing REJECT fixture shape (streak 2, no envelope) still REJECTs -- stamping does not weaken the gate", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9103-reject-1\ndropped_at: 2020-01-01 00:00 KST\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9103": {
          streak: 2,
          history: [
            { task_id: "HYK-9103-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9103-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT/);
    // Even though the CLI still rejects, the best-effort stamp step must
    // still have run (it runs before the gates, unconditionally once the
    // file exists) -- dropped_at should still have been overwritten.
    const rewritten = readFileSync(taskPath, "utf8");
    const match = rewritten.match(DROPPED_AT_RE);
    assert.ok(match);
    assert.notEqual(match[1].trim(), "2020-01-01 00:00 KST");
  });
});

// ---------------------------------------------------------------------------
// (d) HYK-316-dropped-stamp-1 §5-2: 어제(08-20) 실사고 재현 -- 프로덕션
// 소비 경로(relay-handshake.mjs의 checkRelayHandshake, helper 아님)로
// «missing dropped_at header» 거부가 더는 발생하지 않음을 고정한다.
// dropped_at 없이 배달된 task 파일이 이 CLI를 거치고 나면(=삽입됨),
// checkRelayHandshake는 dropped_at 단계를 통과해 그 다음 단계(DONE 줄
// 판정)에서만 멈춘다 -- 어제 실사고의 정확한 그 거부 문구
// "task file missing dropped_at header (required for staleness check)"가
// 다시는 이 경로에서 나오지 않는다는 것이 이 시험의 유일한 단언 대상이다.
// ---------------------------------------------------------------------------
test("(d) 프로덕션 경로: dropped_at 없이 배달된 지시서가 이 CLI를 거친 뒤에는, 실제 checkRelayHandshake가 더 이상 'missing dropped_at header'로 거부하지 않는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // 어제 실사고와 같은 모양: task_id는 있지만 dropped_at이 없는 수기
    // 지시서.
    const original = `task_id: HYK-9110-relay-real-1\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    const stamped = readFileSync(taskPath, "utf8");
    assert.match(stamped, DROPPED_AT_RE, "dropped_at must now be present");

    // 아직 결과 파일이 없다(워커가 완료하지 않음) -- resolveTaskAndResultFiles
    // 단계에서 'result file not found'로 그친다. dropped_at 판정까지도
    // 가지 않는다는 점을 먼저 고정한다(참고용 하한선).
    const beforeResult = checkRelayHandshake({
      role: "CODER",
      harnessDir: dir,
    });
    assert.equal(beforeResult.ok, false);
    assert.match(beforeResult.reason, /result file not found/);

    // 결과 파일을 만들되(>>> DONE: 줄은 아직 없음) -- 이제
    // resolveTaskAndResultFiles/resolveMatchedTaskId를 지나 dropped_at
    // 판정 단계에 실제로 도달한다.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-9110-relay-real-1\n(아직 완료 안 함)\n`,
      "utf8",
    );
    const result = checkRelayHandshake({ role: "CODER", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "DONE 줄이 없으므로 여전히 ok:false여야 한다(이 시험의 관심사는 '어느 사유로 거부되는가'다)",
    );
    assert.doesNotMatch(
      result.reason,
      /missing dropped_at header/,
      "어제(08-20) 실사고의 정확히 그 거부 문구가 더는 나오면 안 된다 -- dropped_at 판정은 이제 통과해야 한다",
    );
    assert.match(
      result.reason,
      /missing ">>> DONE:/,
      "dropped_at을 통과했으므로 다음 단계(DONE 줄 판정)에서만 멈춰야 한다",
    );
  });
});
