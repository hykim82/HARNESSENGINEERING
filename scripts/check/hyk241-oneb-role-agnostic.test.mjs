// HYK-241 2R §3-1: REVIEW 반려 축 -- 조각2의 1-B 검문이 「CODER 배달」에만
// 발화한다는 지적은 저장소 쪽 게이트 CLI 자체가 아니라 관제실
// dispatch-worker.ps1의 `if ($Role -eq "CODER") { ... }` 래핑에서 왔다
// (.harness/review.md §G 실측). 이 시험은 그 지적과 별개로, **저장소 쪽
// dispatch-gate-decision.mjs 자신은 이미 role을 전혀 모른다**는 사실을
// 고정한다 -- 파일 경로만 받는 구조이므로 CODER/REVIEW/VERIFY/PM 어느
// task 파일 이름을 줘도 완전히 동일한 규칙(1-B ⓐ/ⓑ 미기재 -> REJECT,
// 기재 -> ALLOW)으로 판정한다.
//
// ⛔역할별 특례를 만들지 않는다(coder-task.md §3-1 비타협) -- 이 파일은
// "이미 역할을 안 본다"는 사실만 증명하고, 역할별 분기를 새로 추가하지
// 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

// 관제실 dispatch-worker.ps1 자신이 이미 쓰는 파일명 규칙(줄 258/262:
// `$lower = $Role.ToLower()`, `.harness/$lower-task.md`)과 이 워크트리의
// 실제 파일(review-task.md 존재 실측)을 그대로 따른다 -- 파일명을
// 추측하지 않는다.
const ROLE_TASK_FILENAMES = [
  "coder-task.md",
  "review-task.md",
  "verify-task.md",
  "pm-task.md",
];

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk241-oneb-role-agnostic-test-"));
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

test("dispatch-gate-decision.mjs never references 'role' anywhere in its own source (structural anchor for role-agnostic behavior)", () => {
  const coreSrc = execFileSync(
    "node",
    [
      "-e",
      "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
      fileURLToPath(new URL("./dispatch-gate-decision.mjs", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.doesNotMatch(coreSrc.toLowerCase(), /\brole\b/);
});

for (const filename of ROLE_TASK_FILENAMES) {
  test(`role-agnostic (${filename}): 1-B ⓐ/ⓑ 둘 다 없음 -> REJECT_ONE_B_MISSING regardless of which role's task filename is used`, () => {
    withFixtureDir((dir) => {
      const taskPath = join(dir, filename);
      writeFileSync(
        taskPath,
        `task_id: HYK-9600-${filename.replace(/[^a-z]/g, "")}-1\nbody, no 1-B\n`,
        "utf8",
      );
      const ledgerPath = join(dir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const r = runCli([taskPath, "--ledger", ledgerPath]);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /REJECT_ONE_B_MISSING|북극성 1-B/);
      assert.match(r.stderr, /REJECT --/);
    });
  });

  test(`role-agnostic (${filename}): 1-B ⓐ 세 칸 전부 기재 -> ALLOW regardless of which role's task filename is used`, () => {
    withFixtureDir((dir) => {
      const taskPath = join(dir, filename);
      writeFileSync(
        taskPath,
        [
          `task_id: HYK-9601-${filename.replace(/[^a-z]/g, "")}-1`,
          "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task>",
          "1b_shown: ALLOW/REJECT 한 줄",
          "1b_reach_path: CLI 종료코드 -- 관제실 화면",
        ].join("\n"),
        "utf8",
      );
      const ledgerPath = join(dir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const r = runCli([taskPath, "--ledger", ledgerPath]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /ALLOW/);
    });
  });

  test(`role-agnostic (${filename}): 1-B ⓑ 선행 작업 선언만(10자 이상) -> ALLOW regardless of which role's task filename is used`, () => {
    withFixtureDir((dir) => {
      const taskPath = join(dir, filename);
      writeFileSync(
        taskPath,
        [
          `task_id: HYK-9602-${filename.replace(/[^a-z]/g, "")}-1`,
          "1b_prerequisite_for: HYK-9999 사람 실측 게이트를 준비하는 선행 작업",
        ].join("\n"),
        "utf8",
      );
      const ledgerPath = join(dir, "reject-streak.json");
      writeLedger(ledgerPath, { schema_version: 1, issues: {} });
      const r = runCli([taskPath, "--ledger", ledgerPath]);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /ALLOW/);
    });
  });
}

test("role-agnostic: byte-identical decisions for CODER-named and REVIEW-named fixtures holding the SAME task content (only the filename differs)", () => {
  withFixtureDir((dir) => {
    const body = "task_id: HYK-9603-same-1\nno 1-B here\n";
    const coderPath = join(dir, "coder-task.md");
    const reviewPath = join(dir, "review-task.md");
    writeFileSync(coderPath, body, "utf8");
    writeFileSync(reviewPath, body, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const coderResult = runCli([coderPath, "--ledger", ledgerPath]);
    const reviewResult = runCli([reviewPath, "--ledger", ledgerPath]);
    assert.equal(coderResult.status, reviewResult.status);
    assert.equal(coderResult.status, 1);
    // Only the echoed file path differs inside the reason text -- strip it
    // before comparing so this asserts "same verdict/reasoning shape", not
    // "byte-identical stderr including the path string".
    const stripPath = (s, p) => s.split(p).join("<task-path>");
    assert.equal(
      stripPath(coderResult.stderr, coderPath),
      stripPath(reviewResult.stderr, reviewPath),
    );
  });
});
