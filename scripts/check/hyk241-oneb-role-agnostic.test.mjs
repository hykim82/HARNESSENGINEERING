// HYK-241 2R §3-1: REVIEW 반려 축 -- 조각2의 1-B 검문이 「CODER 배달」에만
// 발화한다는 지적은 저장소 쪽 게이트 CLI 자체가 아니라 관제실
// dispatch-worker.ps1의 `if ($Role -eq "CODER") { ... }` 래핑에서 왔다
// (.harness/review.md §G 실측). 이 시험은 그 지적과 별개로, **1-B/게이트/
// 체인 축은 이미 role별 특례를 두지 않는다**는 사실을 고정한다 --
// CODER/REVIEW/VERIFY/PM 어느 task 파일 이름을 줘도 완전히 동일한 규칙
// (1-B ⓐ/ⓑ 미기재 -> REJECT, 기재 -> ALLOW)으로 판정한다.
//
// ⛔역할별 특례를 만들지 않는다(coder-task.md §3-1 비타협) -- 아래 필터
// 파라미터화 시험들이 그 사실을 직접 증명한다(1-B가 role별로 다르게
// 발화하지 않는다).
//
// ★HYK-244-receipt-wire-2b2 갱신(2026-08-14, 이 파일의 원래 단언을
// 좁힘 -- 지워지지 않았다): 원래 이 파일 맨 위 시험은 "'role'이라는
// 문자열이 소스에 아예 없다"는 훨씬 더 엄격한 리터럴 금지였다. HYK-244
// §3-1(이 이슈의 명시적 지정)이 dispatch-gate-decision.mjs가
// `toConsumptionGateDecision({ role, currentBinding, candidates })`를
// **그대로** 호출하도록 요구하는데, 그 1R 승인 코어의 계약 자체가
// `role`이라는 이름의 필드를 요구한다 -- 즉 "role이라는 단어가 소스에
// 한 글자도 없어야 한다"는 예전 리터럴 금지와 이번 이슈의 명시적 지정이
// 문자 그대로 양립 불가능하다. 그 충돌을 조용히 어느 한쪽으로 접지
// 않고, 이 파일의 원래 의도(role별 "특례"를 두지 않는다 -- 예:
// `role === "CODER"`처럼 특정 role 값에만 다르게 반응하는 분기가
// 없다)를 그대로 지키는 더 정확한 검사로 바꿨다: 특정 role **값**과의
// 하드코딩된 비교(`=== "coder"`, `=== "CODER"` 등)가 없는지 확인한다.
// HYK-244의 새 소비 축이 실제로 하는 유일한 role 비교는 "영수증
// 레코드의 role 필드가 이 라운드가 파생시킨 role과 같은가"라는 구조적
// 동등 비교뿐(리터럴 값과의 비교가 아니다) -- 아래 시험이 그 구분을
// 직접 확인한다. 1-B/게이트/체인 축 자신은 여전히 role을 전혀 참조하지
// 않는다는 것은 그대로 유지되는 아래 파라미터화 시험들이 증명한다.
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

test('dispatch-gate-decision.mjs never hardcodes a comparison against a specific role VALUE (no per-role special-casing, e.g. no `role === "coder"`-shaped branch)', () => {
  const coreSrc = execFileSync(
    "node",
    [
      "-e",
      "process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))",
      fileURLToPath(new URL("./dispatch-gate-decision.mjs", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  // 특정 role 리터럴 값(coder/review/verify/pm 등)과의 하드코딩된 비교가
  // 없는지 확인한다 -- 이게 원래 이 시험이 막으려던 "role별 특례
  // 분기"의 실제 모양이다. `role`이라는 식별자/필드명 자체는 이제
  // 허용된다(1R 승인 코어의 `toConsumptionGateDecision({role, ...})`
  // 계약이 요구).
  const knownRoleLiterals = ["coder", "review", "verify", "pm"];
  for (const literal of knownRoleLiterals) {
    const pattern = new RegExp(
      `role[a-zA-Z]*\\s*(===|==)\\s*["'\`]${literal}["'\`]`,
      "i",
    );
    assert.doesNotMatch(
      coreSrc,
      pattern,
      `dispatch-gate-decision.mjs must not hardcode a comparison against the role literal "${literal}"`,
    );
  }
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
