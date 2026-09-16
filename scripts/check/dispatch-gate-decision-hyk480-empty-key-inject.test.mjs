// HYK-480 (coder-task.md 정본) -- dispatch-gate-decision.mjs's
// bestEffortInjectResultPaths (HYK-465) 멱등 검사가 "빈 키 템플릿"에서
// 조용히 건너뛰는 실사고를 닫는다.
//
// 실사고(책임자 실측 · 재현 완료, 이 라운드 coder-task.md §1):
// `RESULT_FILE_LINE_RE = /^result_file:\s*.+$/im`의 `\s*`가 개행을
// 삼켰다 -- 입력 "task_id: X\nresult_file:\nrunner_receipt_file:\n"에서
// 이 정규식은 "result_file:\nrunner_receipt_file:"를 통째로 매치해
// «빈 키 + 다음 줄»을 «이미 주입됨»으로 잘못 읽었고(478 1R 게이트
// 스냅샷 실물 증거), 게다가 로그 한 줄 없이 조용히 return했다.
//
// 이 파일은 (§3 완료조건 그대로) 회귀 시험 ⓐ~ⓓ를 담는다. 파일 이름을
// "dispatch-gate-decision*.test.mjs"에 맞춘다 -- coder-task.md §
// 1b_exec_line(`node --test scripts/check/dispatch-gate-decision*.test.mjs`)
// 이 이 새 파일도 함께 실행하게 하기 위함.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { writeLedger } from "./reject-streak.mjs";
import { RESULT_FILE_LINE_RE } from "./dispatch-gate-decision.mjs";
// HYK-480 §2-1 (책임자 실사고 근거): 점검표 문면을 그대로 따른 결과
// 파일이 파서에서 표지 «1개»로 읽히는지는 naive grep이 아니라 실제
// 생산 파서 함수로 단정해야 한다(HYK-468 2R과 같은 판정선) -- 같은
// scripts/check 디렉터리 형제 모듈이라 relay -> check 방향 제약(A3
// 인벤토리, HYK-148)과 무관하다(scripts/check가 scripts/check를 읽는
// 것은 그 규칙이 막는 방향이 아니다).
import {
  resolveResultTaskId,
  DONE_RE,
  countVerdictLines,
  maskQuotedMarkerRegions,
} from "./relay-handshake.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-hyk480-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-hyk480-test-receipts-")),
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

function countOccurrences(text, keyLinePrefixRe) {
  return [...text.matchAll(keyLinePrefixRe)].length;
}

test("(a) 빈 키 템플릿(실사고 재현 모양) -- 4개 빈 키가 제자리에서 값 있는 줄로 채워지고, 중복 키는 0개", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // 실물 증거(478 1R 스냅샷)와 동일한 모양: 4키가 빈 값으로 이미
    // 존재한다(어떤 손 지시서/템플릿이든, 이 라운드 §2-1이 명시한
    // "템플릿 정리 자체는 범위 밖" 그대로 -- 이 시험은 이 «모양»을
    // 그냥 입력으로 받아들인다).
    const original =
      `task_id: HYK-9501-empty-key-1\n` +
      `role: CODER\n` +
      `result_file:\n` +
      `runner_receipt_file:\n` +
      `harness_gitignore_note:\n` +
      `worktree_discipline:\n` +
      `some body\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stdout,
      /result-path block machine-injected \(HYK-480, in-place fill of empty template keys: result_file, runner_receipt_file, harness_gitignore_note, worktree_discipline\)/,
      "in-place fill must be visible in delivery-time stdout, never a silent no-op",
    );

    const after = readFileSync(taskPath, "utf8");
    const resultFile = join(dir, "coder.md");
    const receiptFile = join(dir, "runner-receipt.json");
    assert.ok(
      after.includes(`result_file: ${resultFile}`),
      "the empty result_file: line must now carry the real absolute path",
    );
    assert.ok(
      after.includes(`runner_receipt_file: ${receiptFile}`),
      "the empty runner_receipt_file: line must now carry the real absolute path",
    );
    assert.match(after, /^harness_gitignore_note:.*git-ignore/im);
    assert.match(after, /^worktree_discipline:.*HEAD/im);

    // ⛔중복 키 금지 -- 각 키가 정확히 1개씩만 있어야 한다(제자리
    // 교체이지 추가 삽입이 아님).
    assert.equal(countOccurrences(after, /^result_file:/gim), 1);
    assert.equal(countOccurrences(after, /^runner_receipt_file:/gim), 1);
    assert.equal(countOccurrences(after, /^harness_gitignore_note:/gim), 1);
    assert.equal(countOccurrences(after, /^worktree_discipline:/gim), 1);

    // 점검표(§5)도 같은 블록으로 붙는다 -- 이전엔 없던 새 키라 "빈 키"로
    // 사전 존재할 수 없었으므로 뒤에 덧붙는다.
    assert.equal(
      countOccurrences(after, /^result_header_checklist_role:/gim),
      1,
    );
    assert.equal(
      countOccurrences(after, /^result_header_checklist_done:/gim),
      1,
    );

    // 위조 방지: 이번 실행에서 RESULT_FILE_LINE_RE(수리된 버전)가
    // "이미 주입됨"으로 오판하지 않았다는 것 자체가, 원본(교체 전)
    // 텍스트에 대해 이 정규식이 매치하지 «않았음»을 뜻한다.
    assert.equal(
      RESULT_FILE_LINE_RE.test(original),
      false,
      "빈 키 템플릿은 수리된 정규식으로는 애초에 '이미 주입됨'이 아니어야 한다",
    );
  });
});

test("(b) 값 있는 파일 -- 재게이트해도 무변경(멱등), 건너뛰기 로그가 매치 줄과 함께 실물로 찍힌다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9502-valued-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const first = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(first.status, 0);
    const afterFirst = readFileSync(taskPath, "utf8");

    // HYK-480 §2: 두 번째 실행 -- 조용한 no-op이 아니라 "already
    // injected -- <매치 줄>" 로그가 실물로 찍혀야 한다(§1 실사고가
    // 닫는 바로 그 무음 return).
    const second = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(second.status, 0);
    assert.match(
      second.stdout,
      /result-path injection skipped \(already injected -- matched line: 'result_file:.*coder\.md'\)/,
      "skip must be logged with the ACTUAL matched line, not silent",
    );
    assert.doesNotMatch(
      second.stdout,
      /result-path block machine-injected/,
      "second run must not re-inject",
    );

    const afterSecond = readFileSync(taskPath, "utf8");
    assert.equal(
      afterSecond,
      afterFirst,
      "값 있는 파일에 대한 재게이트는 파일을 단 1바이트도 바꾸지 않아야 한다(완전 멱등)",
    );
  });
});

test("(c) 줄 없음 -- 4개 옛 키 + 점검표 7줄, 총 11줄이 task_id: 바로 뒤에 새로 주입된다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9503-fresh-1\nrole: CODER\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(
      r.stdout,
      /result-path block machine-injected \(HYK-465\/HYK-480\)/,
    );

    const after = readFileSync(taskPath, "utf8");
    for (const prefix of [
      "result_file",
      "runner_receipt_file",
      "harness_gitignore_note",
      "worktree_discipline",
      "result_header_checklist_note",
      "result_header_checklist_role",
      "result_header_checklist_task_id",
      "result_header_checklist_for",
      "result_header_checklist_verdict",
      "result_header_checklist_headcommit",
      "result_header_checklist_done",
    ]) {
      assert.equal(
        countOccurrences(after, new RegExp(`^${prefix}:`, "gim")),
        1,
        `${prefix}: must appear exactly once`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// (d) 변이(정규식 원복) -- 옛 `\s*`판이 빈 키 템플릿을 실제로 "이미
// 주입됨"으로 잘못 매치했음을, 이 라운드가 수리한 RESULT_FILE_LINE_RE와
// 나란히 대조해 기계로 증명한다. §1 실사고를 재현하지 «못하면» 이
// 시험이 헛것이 아님을 보장하는 자리다.
// ---------------------------------------------------------------------------
test("(d) 변이 RED: 옛 `/^result_file:\\s*.+$/im` 정규식을 되살리면 빈 키 템플릿을 '이미 주입됨'으로 오판한다(수리된 정규식은 그러지 않는다)", () => {
  const PRE_FIX_RESULT_FILE_LINE_RE = /^result_file:\s*.+$/im;
  const emptyKeyTemplateBody =
    "task_id: HYK-9504-mutation-1\n" +
    "result_file:\n" +
    "runner_receipt_file:\n" +
    "harness_gitignore_note:\n" +
    "worktree_discipline:\n";

  // RED: 옛 정규식은 "빈 키 + 다음 줄"을 통째로 매치해 true를 돌려준다
  // (§1 실사고 그 자체 -- 이 라운드가 존재하는 이유).
  assert.equal(
    PRE_FIX_RESULT_FILE_LINE_RE.test(emptyKeyTemplateBody),
    true,
    "재현: 옛 정규식은 개행을 삼켜 빈 키 템플릿에서도 매치한다(버그 재현)",
  );
  const preFixMatch = emptyKeyTemplateBody.match(PRE_FIX_RESULT_FILE_LINE_RE);
  assert.match(
    preFixMatch[0],
    /\n/,
    "재현: 옛 정규식의 매치 텍스트 자체가 개행을 삼켜 여러 줄에 걸쳐 있다(진단: 이게 버그의 실체)",
  );

  // GREEN: 이 라운드가 수리한 정규식은 같은 입력에서 false를 돌려준다
  // (같은 줄 안에 값이 없으면 매치하지 않는다).
  assert.equal(
    RESULT_FILE_LINE_RE.test(emptyKeyTemplateBody),
    false,
    "수리 후: 빈 키 템플릿은 더 이상 '이미 주입됨'으로 잘못 읽히지 않는다",
  );

  // 대조군: 값이 실제로 있으면 둘 다 여전히 true(회귀 없음 -- 정상
  // 케이스까지 깨뜨리지 않았다는 증거).
  const valuedBody =
    "task_id: HYK-9504-mutation-1\nresult_file: /abs/coder.md\n";
  assert.equal(PRE_FIX_RESULT_FILE_LINE_RE.test(valuedBody), true);
  assert.equal(RESULT_FILE_LINE_RE.test(valuedBody), true);
});

// ---------------------------------------------------------------------------
// HYK-480 §5/§2-1: "결과 파일 필수 머리줄 점검표"가 기계로 박히는지, 그리고
// 그 점검표 문면을 «그대로 따른» 결과 파일이 실제 파서 함수(naive grep이
// 아니라 resolveResultTaskId/DONE_RE/countVerdictLines -- relay-handshake.mjs
// 정본)에서 표지 «1개»로 읽히는지를 증명한다.
// ---------------------------------------------------------------------------
test("(e) 점검표 기계 주입: CODER 라운드는 for/verdict/head_commit이 '검토 전용 -- 0개'로, 완료 표지 요구가 손기입 금지로 명시된다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9505-checklist-coder-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    runCli([taskPath, "--ledger", ledgerPath]);

    const after = readFileSync(taskPath, "utf8");
    assert.match(
      after,
      /^result_header_checklist_for:.*검토 전용 -- 이 역할엔 0개$/im,
    );
    assert.match(
      after,
      /^result_header_checklist_verdict:.*검토 전용 -- 이 역할엔 0개$/im,
    );
    assert.match(
      after,
      /^result_header_checklist_headcommit:.*검토 전용 -- 이 역할엔 0개$/im,
    );
    assert.match(after, /^result_header_checklist_done:.*손기입 금지$/im);
    // §2-1 요구: 점검표 문면 자체가 "계수 줄 서식" 경고를 담고 있어야 한다.
    assert.match(
      after,
      /^result_header_checklist_note:.*완료 표지 모양으로 시작하지 마라/im,
    );
  });
});

test("(f) 점검표 기계 주입: REVIEW 라운드는 for/verdict/head_commit이 '정확히 1개' 요건으로 채워진다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "review-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9506-checklist-review-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    runCli([taskPath, "--ledger", ledgerPath]);

    const after = readFileSync(taskPath, "utf8");
    assert.match(
      after,
      /^result_header_checklist_for:.*판정 대상 CODER 라운드 harness_label 값으로 정확히 1개$/im,
    );
    assert.match(
      after,
      /^result_header_checklist_verdict:.*approved 또는 rejected 중 하나만, 정확히 1개$/im,
    );
    assert.match(
      after,
      /^result_header_checklist_headcommit:.*단독 40-hex 줄\(HYK-383\) 정확히 1개$/im,
    );

    // ⚠️REVIEW 역할에서 실측으로 잡힌 함정(구현 중 발견): 점검표 키
    // 이름이 "head_commit:"을 부분 문자열로 포함하면 이 파일 자신의
    // DISPATCH_HEAD_COMMIT_ANYWHERE_RE(근사매치, 경계 없음)가 그 키
    // 이름 자체를 오인해 REJECT_HEAD_COMMIT_MISSING이 REJECT_HEAD_
    // COMMIT_NEAR_MISS로 둔갑했다(dispatch-gate-head-commit-wire.test.mjs
    // (dg-4a) 회귀로 드러남, 수리: "head_commit"을 밑줄 없는
    // "headcommit"으로 쓴 키 이름). 이 시험은 그 REJECT 사유 문자열 자체가
    // "표지 자체가 없다"는 정확한 사유를 유지하는지 대조한다(점검표 주입이
    // REVIEW 배달 자신의 head_commit 게이트를 위조/오염하지 않는다는
    // 증거).
    const r2 = runCli([taskPath, "--ledger", ledgerPath]);
    assert.match(
      r2.stderr,
      /대상 커밋을 지정하는 'head_commit:' 표지가 없음/,
      "점검표 주입이 head_commit 근사매치를 오발동시키지 않아야 한다(그랬다면 다른 사유 문자열이 나온다)",
    );
  });
});

test("(g) 점검표를 «그대로 따른» 결과 파일이 실제 파서 함수에서 표지 정확히 1개로 읽힌다(naive grep 아님)", () => {
  // 점검표(§2-1 안전 서식)가 시키는 대로: role 1개 · task_id 1개 ·
  // 완료 표지(>>> DONE) 1개, 계수 줄은 열 0에서 완료 표지 모양으로
  // 시작하지 않는다(예: '- 완료 표지 개수: 1').
  const compliantResult =
    "role: CODER\n" +
    "task_id: HYK-9507-compliant-1\n" +
    "- 완료 표지 개수: 1\n" +
    "본문...\n" +
    ">>> DONE: CODER @ 2026-09-16 15:00:00 KST\n";

  const taskIdVerdict = resolveResultTaskId(compliantResult);
  assert.equal(taskIdVerdict.ok, true);
  assert.equal(taskIdVerdict.id, "HYK-9507-compliant-1");

  const doneMatches = [
    ...maskQuotedMarkerRegions(compliantResult).matchAll(DONE_RE),
  ];
  assert.equal(
    doneMatches.length,
    1,
    "완료 표지는 실제 파서(DONE_RE)로 정확히 1개로 읽혀야 한다",
  );

  assert.equal(
    countVerdictLines(compliantResult),
    0,
    "CODER 결과에는 verdict: 가 0개여야 한다(검토 전용)",
  );

  // 대조(§0-1 실사고 모양): 계수/설명 줄이 «완료 표지 모양»(열 0에서
  // `>>> DONE:...@...` 형태, DONE_RE가 요구하는 두 조각을 우연히 모두
  // 갖춤)으로 시작하면, 실제 파서(구조적 선행 맥락 가드가 없는 DONE_RE
  // -- resolveResultTaskId와 달리 hasStructuralPredecessor 검사가 없다)가
  // 진짜 완료 표지와 구별하지 못해 «표지 2개»로 오판한다 -- 점검표의
  // 안전 서식 경고("계수 줄은 열 0 에서 완료 표지 모양으로 시작하지
  // 마라")가 왜 필요한지의 기계 증거.
  const noncompliantResult =
    "role: CODER\n" +
    "task_id: HYK-9507-noncompliant-1\n" +
    ">>> DONE: 완료 표지 개수 확인용 예시 @ 0\n" +
    "본문...\n" +
    ">>> DONE: CODER @ 2026-09-16 15:00:00 KST\n";
  const noncompliantDoneMatches = [
    ...maskQuotedMarkerRegions(noncompliantResult).matchAll(DONE_RE),
  ];
  assert.equal(
    noncompliantDoneMatches.length,
    2,
    "§0-1 실사고 재현: 계수 줄을 완료 표지 모양으로 쓰면 실제 파서가 2개로 센다(점검표 안전 서식 경고가 막는 바로 그 함정)",
  );
});
