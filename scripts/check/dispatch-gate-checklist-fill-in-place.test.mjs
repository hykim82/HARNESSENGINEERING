// HYK-480 실사고 수리 -- task 파일에 `result_file:` 이 이미 있으면 경로 주입은
// 건너뛰되, 결과 파일 머리줄 점검표는 "누락분만" 채운다.
//
// 실사고(라운드 4, 2026-09-18 근방): ORCH 가 손으로 쓴 지시서는 거의 전부
// `result_file:` 을 적으므로, 옛 `return` 이 점검표 주입 자체를 꺼 버렸다.
// 그 결과 head_commit 축이 0개인 봉투로 배달돼 워커가 head_commit 을 안 써
// 소비가 거부됐다. 이 시험은 (a) 실사고 모양이 합성 표적에서 재현되고 누락분
// 만 채워지며 손글씨 줄은 글자 하나 안 바뀌는 것, (b) 두 번째 실행이 무변경
// (멱등)인 것, (c) `result_file:` 이 없는 기존 경로가 무회귀인 것, (d) 인용
// (펜스) 안의 점검표 예시는 "있는 줄"로 세지 않아 진짜 줄이 채워지는 것을
// 값으로 증명한다. 원장은 전부 합성 경로로 덮어쓴다(전역 원장 무접촉).
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

// 실사고 봉투 모양: 점검표 손글씨 6줄, head_commit 축 없음.
const HAND_CHECKLIST_SIX = [
  "result_header_checklist_note: 손글씨 노트(ORCH 가 직접 씀)",
  "result_header_checklist_role: role 은 CODER 로 쓰라(손글씨)",
  "result_header_checklist_task_id: task_id 는 라운드 라벨(손글씨)",
  "result_header_checklist_done: 완료 표지는 한 개(손글씨)",
  "result_header_checklist_exit: exit 줄 금지(손글씨)",
  "result_header_checklist_count_line: 계수 줄 주의(손글씨)",
];

const SYNTHETIC_FIXTURE_HEAD =
  "task_id: HYK-9480-fill-1\nresult_file: /synthetic/coder.md\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk480-checklist-fill-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 합성 경로만 쓴다: 원장·락·영수증 전부 fixture 디렉터리 안.
function runCliSynthetic(dir, taskPath) {
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });
  const receiptPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(receiptPath, "", "utf8");
  try {
    const stdout = execFileSync(
      "node",
      [SCRIPT_PATH, taskPath, "--ledger", ledgerPath],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ADMISSION_LEDGER_PATH: ledgerPath,
          ADMISSION_LEDGER_LOCK_PATH: join(dir, "reject-streak.lock"),
          DISPATCH_RECEIPT_PATH: receiptPath,
        },
      },
    );
    return { status: 0, stdout };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "" };
  }
}

function countLinesEqual(text, line) {
  return text.split("\n").filter((l) => l === line).length;
}

test("(a) 실사고 모양: result_file 있음 + 손글씨 6줄 -> 손글씨 줄은 글자 동일, head_commit 축만 누락분으로 추가, 표식 ≥1", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `${SYNTHETIC_FIXTURE_HEAD}${HAND_CHECKLIST_SIX.join("\n")}\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");

    const r = runCliSynthetic(dir, taskPath);
    assert.equal(r.status, 0);
    assert.match(
      r.stdout,
      /result-path injection skipped \(already injected/,
      "경로 주입은 여전히 건너뛴다(무변경)",
    );
    assert.match(
      r.stdout,
      /checklist fill-in-place \(HYK-480 기계 주입, missing keys only: .*headcommit/,
      "누락분 채움이 로그에 실물로 찍힌다",
    );

    const after = readFileSync(taskPath, "utf8");
    for (const hand of HAND_CHECKLIST_SIX) {
      assert.equal(
        countLinesEqual(after, hand),
        1,
        `손글씨 줄은 글자 하나 안 바뀌고 정확히 1번 남아야 한다: ${hand}`,
      );
    }
    assert.equal(
      after
        .split("\n")
        .filter((l) => /^result_header_checklist_headcommit:/.test(l)).length,
      1,
      "head_commit 축 줄이 누락분으로 정확히 1개 채워진다",
    );
    assert.ok(
      after.includes("HYK-480 기계 주입"),
      "기계 주입 표식이 남는다(손글씨와 판별하는 유일한 수단)",
    );
    assert.doesNotMatch(
      after,
      /[0-9a-f]{40}/i,
      "점검표는 지시문일 뿐 40-hex head_commit 값을 기계가 쓰지 않는다(설계 금지선)",
    );
  });
});

test("(b) 멱등: 두 번째 실행은 파일을 단 1바이트도 바꾸지 않고 누락분 로그를 찍지 않는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `${SYNTHETIC_FIXTURE_HEAD}${HAND_CHECKLIST_SIX.join("\n")}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    runCliSynthetic(dir, taskPath);
    const afterFirst = readFileSync(taskPath, "utf8");

    const second = runCliSynthetic(dir, taskPath);
    assert.equal(second.status, 0);
    assert.doesNotMatch(second.stdout, /fill-in-place/);
    assert.equal(readFileSync(taskPath, "utf8"), afterFirst);
  });
});

test("(c) 무회귀: result_file 없는 기존 경로는 경로 4줄 + 점검표 8줄을 task_id 바로 뒤에 전부 주입한다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9481-fresh-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const r = runCliSynthetic(dir, taskPath);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /result-path block machine-injected/);
    const after = readFileSync(taskPath, "utf8");
    const checklist = after
      .split("\n")
      .filter((l) => /^result_header_checklist_[a-z_]+:/.test(l));
    assert.equal(checklist.length, 8, "점검표 8줄 전부(HYK-485 범위3 포함)");
    assert.ok(after.includes("HYK-480 기계 주입"));
  });
});

test("(d) 인용 구분: 펜스 안의 점검표 예시는 «있는 줄»로 세지 않아, 진짜 headcommit 줄이 그래도 채워진다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original =
      `${SYNTHETIC_FIXTURE_HEAD}` +
      "```\nresult_header_checklist_headcommit: 예시(인용)\n```\n" +
      "result_header_checklist_role: 손글씨 역할 줄\n" +
      ONE_B_BLOCK;
    writeFileSync(taskPath, original, "utf8");
    runCliSynthetic(dir, taskPath);
    const after = readFileSync(taskPath, "utf8");
    assert.ok(
      after.includes(
        "```\nresult_header_checklist_headcommit: 예시(인용)\n```",
      ),
      "인용된 예시 줄은 무접촉",
    );
    assert.equal(
      after
        .split("\n")
        .filter((l) => /^result_header_checklist_headcommit:/.test(l)).length,
      2,
      "인용 예시 1줄(무접촉) + 진짜 headcommit 줄 1개 = 2개 -- 인용을 세지 않아 진짜 줄이 추가된다",
    );
    assert.equal(
      countLinesEqual(after, "result_header_checklist_role: 손글씨 역할 줄"),
      1,
      "손글씨 role 줄은 무접촉",
    );
  });
});
