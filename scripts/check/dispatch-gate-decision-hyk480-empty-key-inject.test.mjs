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
//
// HYK-485(범위3)+HYK-486 번들(이 라운드 coder-task.md): 같은
// 1b_exec_line이 이 파일을 이미 태우므로, 두 스코프의 새 시험도 같은
// 파일에 더한다(exec_line이 고정 파일 목록이라 새 파일을 만들면 실행
// 목록에서 빠진다).
// - 범위 A(HYK-485): buildResultHeaderChecklistLines가 «회차별 파일명
//   규약» 한 줄을 더 주입하는지.
// - 범위 B(HYK-486): fillEmptyLegacyKeysInPlace가 인용된 빈 키를 더 이상
//   진짜 키로 오인하지 않는지, g 플래그 없이 첫 매치만 치환하던 버그가
//   고쳐졌는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import {
  RESULT_FILE_LINE_RE,
  buildResultHeaderChecklistLines,
  fillEmptyLegacyKeysInPlace,
} from "./dispatch-gate-decision.mjs";
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
  HEAD_COMMIT_RE_G,
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

test("(c) 줄 없음 -- 4개 옛 키 + 점검표 8줄(HYK-485 범위3: runner_naming 줄 포함), 총 12줄이 task_id: 바로 뒤에 새로 주입된다", () => {
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
      "result_header_checklist_runner_naming",
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
      /^result_header_checklist_headcommit:.*단독 40-hex 줄\(HYK-383\) 정확히 1개 -- 키와 값은 반드시 같은 줄\(줄바꿈 금지\), 예시 형태: head_commit 다음에 콜론 하나 붙이고 공백만 두고 같은 줄에 곧바로 40자리 16진수 값\(콜론 다음에 개행하고 다음 줄에 값만 쓰면 두 줄로 갈라져 표지로 인정되지 않는다\)$/im,
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

// ===========================================================================
// HYK-485 범위3: 주입 블록에 «회차별 파일명 규약» 한 줄.
// ===========================================================================

test("(h) HYK-485 범위3: buildResultHeaderChecklistLines가 회차별 파일명 규약 줄을 정확히 1개 더 넣고, 옛 7줄 + 새 1줄 = 8줄이며 키 이름이 비타협 3가지를 지킨다(프로덕션 export 직접 구동)", () => {
  const lines = buildResultHeaderChecklistLines("CODER");
  assert.equal(lines.length, 8, "옛 7줄 + 회차별 파일명 규약 1줄 = 8줄");

  const runnerNamingLines = lines.filter((l) =>
    l.startsWith("result_header_checklist_runner_naming:"),
  );
  assert.equal(
    runnerNamingLines.length,
    1,
    "회차별 파일명 규약 줄은 정확히 1개여야 한다",
  );
  const [runnerNamingLine] = runnerNamingLines;

  // 내용: 러너 영수증/로그 정본 코드(runner-receipt-writer.mjs·
  // RUNNER_RECEIPT_RUN_PREFIX)가 이미 프로덕션에서 쓰는 이름과 맞춘다.
  assert.match(runnerNamingLine, /runner-receipt-run<N>\.json/);
  assert.match(runnerNamingLine, /full-runner-<N>\.log/);
  assert.match(runnerNamingLine, /정본 runner-receipt\.json 은 그대로 둔다/);

  // 비타협 3가지(이 라운드 coder-task.md §1): 키 이름에 head_commit·
  // task_id·verdict·for를 부분 문자열로도 넣지 않는다.
  const key = runnerNamingLine.slice(0, runnerNamingLine.indexOf(":"));
  for (const bad of ["head_commit", "task_id", "verdict", "for"]) {
    assert.equal(
      key.includes(bad),
      false,
      `키 이름 '${key}'는 '${bad}'를 부분 문자열로도 포함하면 안 된다(비타협 3가지 #1)`,
    );
  }
  // 비타협 #2: 열 0에서 완료 표지 모양(>>> ...)으로 시작하지 않는다.
  assert.equal(runnerNamingLine.startsWith(">>>"), false);
  // 비타협 #3: 단일 key: value 한 줄 관례(개행 없음).
  assert.equal(runnerNamingLine.includes("\n"), false);
});

test("(i) 변이 RED: 회차별 파일명 규약 줄을 빼면(HYK-485 범위3 이전 실물 모양) 8줄 계약과 규약 텍스트가 사라진다", () => {
  const lines = buildResultHeaderChecklistLines("CODER");
  const PRE_HYK_485_SCOPE3_LINE_COUNT = 7; // 이 라운드 coder-task.md §1 인용: "7줄을 기계 주입한다"
  assert.notEqual(
    lines.length,
    PRE_HYK_485_SCOPE3_LINE_COUNT,
    "새 줄이 실제로 추가됐다(지금 길이가 옛 7이 아니다)",
  );

  // RED 재현: 지금 프로덕션 배열에서 새로 추가된 마지막 줄을 빼면(=이
  // 라운드 이전 실물 모양) 그 7줄에는 회차별 파일명 규약이 전혀 없었다.
  const preFixLines = lines.slice(0, PRE_HYK_485_SCOPE3_LINE_COUNT);
  assert.equal(preFixLines.length, 7);
  assert.equal(
    preFixLines.some((l) => l.includes("runner-receipt-run<N>.json")),
    false,
    "재현: 옛 7줄에는 회차별 영수증 파일명 규약이 없었다(이 라운드가 메우는 공백)",
  );
  assert.equal(
    lines.some((l) => l.includes("runner-receipt-run<N>.json")),
    true,
    "수리 후: 지금 프로덕션 8줄에는 있다",
  );
});

test("(j) HYK-485 범위3: 새 규약 줄이 섞여도 실제 파서(resolveResultTaskId/DONE_RE/countVerdictLines)의 표지 개수 판정이 그대로다", () => {
  const checklistLines = buildResultHeaderChecklistLines("CODER");
  const resultBody =
    "role: CODER\n" +
    "task_id: HYK-9508-runner-naming-1\n" +
    checklistLines.join("\n") +
    "\n본문...\n" +
    ">>> DONE: CODER @ 2026-09-17 10:00:00 KST\n";

  const taskIdVerdict = resolveResultTaskId(resultBody);
  assert.equal(taskIdVerdict.ok, true);
  assert.equal(taskIdVerdict.id, "HYK-9508-runner-naming-1");

  const doneMatches = [
    ...maskQuotedMarkerRegions(resultBody).matchAll(DONE_RE),
  ];
  assert.equal(
    doneMatches.length,
    1,
    "점검표 8줄(회차별 파일명 규약 포함)이 섞여도 완료 표지는 여전히 1개로 읽힌다",
  );
  assert.equal(
    countVerdictLines(resultBody),
    0,
    "CODER 결과에는 verdict: 가 여전히 0개다",
  );
});

// ===========================================================================
// HYK-486: 인용된 빈 키가 진짜 키를 가로챈다 -- fillEmptyLegacyKeysInPlace
// 수리 회귀.
// ===========================================================================

test("(k) HYK-486 ⓐ: 코드펜스로 인용된 빈 result_file: 이 진짜 키보다 앞에 있어도 진짜 키가 채워지고 인용 줄은 그대로다(CLI 프로덕션 경로)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original =
      `task_id: HYK-9509-quote-hijack-1\n` +
      `role: CODER\n` +
      "예시(코드펜스 안, 진짜 키 아님):\n" +
      "```\n" +
      "result_file:\n" +
      "```\n" +
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

    const after = readFileSync(taskPath, "utf8");
    const resultFile = join(dir, "coder.md");

    assert.match(
      after,
      /```\nresult_file:\n```/,
      "코드펜스 안 인용 빈 키 줄은 손대지 않고 그대로 남아야 한다(HYK-486 실사고가 채웠던 바로 그 줄)",
    );
    assert.ok(
      after.includes(`\nresult_file: ${resultFile}\n`),
      "진짜(인용 밖) result_file: 이 실제 경로로 채워져야 한다 -- 영원히 건너뛰어지면 안 된다",
    );

    // 실제 파서(마스킹)로 재확인: 인용 밖에서 값 있는 result_file: 줄이
    // 정확히 1개.
    const masked = maskQuotedMarkerRegions(after);
    assert.equal(
      [...masked.matchAll(/^result_file:\s*\S.*$/gim)].length,
      1,
      "마스킹 후(인용 제외) 값 있는 result_file: 줄이 정확히 1개여야 한다",
    );
    // 나머지 3키도 정상 채움(회귀 없음).
    assert.match(after, /^runner_receipt_file:.*runner-receipt\.json$/im);
    assert.match(after, /^harness_gitignore_note:.*git-ignore/im);
    assert.match(after, /^worktree_discipline:.*HEAD/im);
  });
});

test("(l) HYK-486 ⓑ: 진짜(인용 아닌) 빈 키가 같은 라운드에 2번 나오면 조용히 하나만 고르지 않고 거부한다(fillEmptyLegacyKeysInPlace 직접 구동)", () => {
  const text =
    "task_id: HYK-9510-dup-real-1\n" +
    "result_file:\n" +
    "runner_receipt_file:\n" +
    "harness_gitignore_note:\n" +
    "worktree_discipline:\n" +
    "result_file:\n"; // 진짜 키가 실수로 한 번 더 -- 인용이 아니다.
  const legacyValues = {
    result_file: "/abs/coder.md",
    runner_receipt_file: "/abs/runner-receipt.json",
    harness_gitignore_note: "note",
    worktree_discipline: "discipline",
  };
  assert.throws(
    () => fillEmptyLegacyKeysInPlace(text, legacyValues),
    /result_file' appears as a genuine \(non-quoted\) empty key 2 times/,
    "HYK-486 ⓑ 정책: 전부 채움이 아니라 1개 아니면 거부 -- 조용히 하나만 고르지 않는다",
  );
});

test("(m) 값이 이미 있는 파일 재게이트 -- sha256 바이트 동일(완전 멱등)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9511-sha256-idempotent-1\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    runCli([taskPath, "--ledger", ledgerPath]);
    const afterFirst = readFileSync(taskPath);
    const sha1 = createHash("sha256").update(afterFirst).digest("hex");

    runCli([taskPath, "--ledger", ledgerPath]);
    const afterSecond = readFileSync(taskPath);
    const sha2 = createHash("sha256").update(afterSecond).digest("hex");

    assert.equal(
      sha1,
      sha2,
      "값 있는 파일 재게이트는 sha256 바이트 동일이어야 한다(HYK-486 수리가 멱등을 깨지 않았다는 증거)",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-486 변이 RED 2종: 이 라운드가 고친 두 축(마스킹 · g 플래그)을 «각각
// 따로» 되돌렸을 때 지금 프로덕션 정답 동작과 달라짐을 증명한다. 복원(=
// 지금 프로덕션 코드) 뒤에는 같은 입력에 대해 바이트 동일함도 함께 확인.
// ---------------------------------------------------------------------------

function mutantNoMasking(text, legacyValues) {
  // 변이 1: maskQuotedMarkerRegions를 거치지 않는다(그 외 구조는 지금
  // 프로덕션과 동일 -- g 플래그·거부 정책은 유지).
  const filledKeys = [];
  const replacements = [];
  for (const key of Object.keys(legacyValues)) {
    const emptyKeyRe = new RegExp(`^${key}:[ \\t]*$`, "gim");
    const matches = [...text.matchAll(emptyKeyRe)]; // ⛔masked 대신 원문
    if (matches.length === 0) continue;
    if (matches.length > 1) {
      throw new Error(
        `mutant(no-masking): key '${key}' appears ${matches.length} times`,
      );
    }
    filledKeys.push(key);
    replacements.push({
      index: matches[0].index,
      length: matches[0][0].length,
      key,
    });
  }
  const byIndexDesc = [...replacements].sort((a, b) => b.index - a.index);
  let rewritten = text;
  for (const { index, length, key } of byIndexDesc) {
    rewritten =
      rewritten.slice(0, index) +
      `${key}: ${legacyValues[key]}` +
      rewritten.slice(index + length);
  }
  return { rewritten, filledKeys };
}

function mutantNoGlobalFlag(text, legacyValues) {
  // 변이 2: g 플래그 없이 옛 방식(single .test + .replace)으로 되돌린다
  // (마스킹은 detection에만 쓰이고 치환은 옛 코드 그대로 non-global
  // `.replace()`를 원문에 직접 건다 -- 실사고 그 자체의 재현).
  const masked = maskQuotedMarkerRegions(text);
  let rewritten = text;
  const filledKeys = [];
  for (const key of Object.keys(legacyValues)) {
    const emptyKeyRe = new RegExp(`^${key}:[ \\t]*$`, "im");
    if (emptyKeyRe.test(masked)) {
      rewritten = rewritten.replace(emptyKeyRe, `${key}: ${legacyValues[key]}`);
      filledKeys.push(key);
    }
  }
  return { rewritten, filledKeys };
}

const QUOTE_HIJACK_FIXTURE =
  "task_id: HYK-9512-mutation-1\n" +
  "```\n" +
  "result_file:\n" +
  "```\n" +
  "result_file:\n" +
  "runner_receipt_file:\n" +
  "harness_gitignore_note:\n" +
  "worktree_discipline:\n";
const QUOTE_HIJACK_LEGACY_VALUES = {
  result_file: "/abs/coder.md",
  runner_receipt_file: "/abs/runner-receipt.json",
  harness_gitignore_note: "note",
  worktree_discipline: "discipline",
};

test("(n) 변이 RED (마스킹 제거): 인용 안 빈 키를 «진짜」로도 세어 거부하거나 잘못 채운다 -- 지금 프로덕션(마스킹 있음)은 정상 채운다", () => {
  // 마스킹 없이 세면 result_file:이 원문에서 2번(인용 1 + 진짜 1) 잡혀
  // "여러 번" 정책에 걸려 거부된다 -- 지금 프로덕션은 마스킹으로 인용을
  // 제외해 1번으로 보고 정상 채운다. 같은 입력, 다른 결과 = 마스킹이
  // 실제로 하는 일의 기계 증거.
  assert.throws(
    () => mutantNoMasking(QUOTE_HIJACK_FIXTURE, QUOTE_HIJACK_LEGACY_VALUES),
    /result_file/,
    "재현: 마스킹 없이는 인용된 빈 키도 진짜로 세어 '여러 번' 오판한다",
  );

  const { rewritten: fixed } = fillEmptyLegacyKeysInPlace(
    QUOTE_HIJACK_FIXTURE,
    QUOTE_HIJACK_LEGACY_VALUES,
  );
  assert.match(
    fixed,
    /```\nresult_file:\n```/,
    "복원(=지금 프로덕션): 인용 줄은 그대로",
  );
  assert.ok(
    fixed.includes("\nresult_file: /abs/coder.md\n"),
    "복원(=지금 프로덕션): 진짜 키가 채워진다",
  );
});

test("(o) 변이 RED (g 플래그 제거): 원문 검색에서 «먼저 나오는» 인용 줄을 채우고 진짜 키는 영원히 빈 채로 남긴다 -- HYK-486 실사고 그 자체", () => {
  const { rewritten: mutated } = mutantNoGlobalFlag(
    QUOTE_HIJACK_FIXTURE,
    QUOTE_HIJACK_LEGACY_VALUES,
  );
  // 재현: non-global .replace()가 masked 텍스트가 아니라 원문에서
  // «맨 처음» 매치(=인용 안 줄)를 채우고, 그 뒤 진짜 줄은 그대로 빈다.
  assert.match(
    mutated,
    /```\nresult_file: \/abs\/coder\.md\n```/,
    "재현: 인용 줄이 잘못 채워진다(HYK-486 실사고)",
  );
  assert.match(
    mutated,
    /```\nresult_file:\nrunner_receipt_file:/,
    "재현: 닫는 펜스 뒤 진짜 result_file: 은 영원히 빈 채로 남는다",
  );

  // 복원(=지금 프로덕션)은 반대로 인용은 그대로, 진짜만 채운다 -- 바이트
  // 단위로 재확인.
  const { rewritten: fixed } = fillEmptyLegacyKeysInPlace(
    QUOTE_HIJACK_FIXTURE,
    QUOTE_HIJACK_LEGACY_VALUES,
  );
  assert.match(fixed, /```\nresult_file:\n```/);
  assert.ok(fixed.includes("\nresult_file: /abs/coder.md\n"));
  assert.notEqual(
    fixed,
    mutated,
    "복원 후 결과는 변이 결과와 바이트 단위로 달라야 한다(수리가 실제로 동작을 바꿨다는 증거)",
  );
});

// ===========================================================================
// HYK-479 §B-B: 점검표 문면이 이제 "키와 값은 같은 줄" + 예시 형태를
// 명시한다 -- 그 예시를 «그대로 따른» 결과 파일이 실제 소비 정규식
// (relay-handshake.mjs의 HEAD_COMMIT_RE_G, 재구현 아닌 프로덕션 직접
// import)에 실제로 매치되는지, 그리고 두 줄로 갈라진 형태는 여전히
// 매치되지 «않는지»를 단정한다(HYK-357 검토 결과 head_commit 두 줄 분리
// 실사고를 다시 재현하지 않는다는 증거).
// ===========================================================================

test("(p) HYK-479 §B-B 양성: 점검표 예시 형태(키·값 같은 줄)를 그대로 따른 결과 파일은 프로덕션 HEAD_COMMIT_RE_G에 정확히 1개로 매치된다", () => {
  const sameLineResult =
    "role: REVIEW\n" +
    "task_id: HYK-9510-headcommit-sameline-1\n" +
    "for: HYK-9510-coder-1\n" +
    "verdict: approved\n" +
    "head_commit: 0123456789abcdef0123456789abcdef01234567\n" +
    "본문...\n" +
    ">>> DONE: REVIEW @ 2026-09-17 10:00:00 KST\n";
  const matches = [...sameLineResult.matchAll(HEAD_COMMIT_RE_G)];
  assert.equal(
    matches.length,
    1,
    "점검표가 시키는 대로 키와 값을 같은 줄에 쓰면 프로덕션 소비 정규식이 정확히 1개로 읽는다",
  );
  assert.equal(matches[0][1], "0123456789abcdef0123456789abcdef01234567");
});

test("(q) HYK-479 §B-B 음성(HYK-357 실사고 재현): head_commit 키와 40-hex 값이 두 줄로 갈라지면 여전히 매치되지 않는다", () => {
  const splitAcrossLinesResult =
    "role: REVIEW\n" +
    "task_id: HYK-9511-headcommit-split-1\n" +
    "for: HYK-9511-coder-1\n" +
    "verdict: approved\n" +
    "head_commit:\n" +
    "0123456789abcdef0123456789abcdef01234567\n" +
    "본문...\n" +
    ">>> DONE: REVIEW @ 2026-09-17 10:00:00 KST\n";
  const matches = [...splitAcrossLinesResult.matchAll(HEAD_COMMIT_RE_G)];
  assert.equal(
    matches.length,
    0,
    "실사고 재현: 키 한 줄 + 값 다음 줄로 갈라지면 프로덕션 정규식은 여전히 매치하지 않는다 -- 이게 이 축의 존재 이유다(dispatch-gate-decision.mjs:HEAD_COMMIT_RE_G 헤더 주석, '[ \\t]*'가 개행을 삼키지 않기 때문)",
  );
});

test("(r) HYK-479 §B-B: 점검표 문면 자체가 «같은 줄·줄바꿈 금지» 요구와 예시 형태를 값으로 명시한다(REVIEW 라운드)", () => {
  const lines = buildResultHeaderChecklistLines("REVIEW");
  const headCommitLine = lines.find((l) =>
    l.startsWith("result_header_checklist_headcommit:"),
  );
  assert.ok(headCommitLine, "headcommit 점검표 줄이 있어야 한다");
  assert.match(headCommitLine, /같은 줄/);
  assert.match(headCommitLine, /줄바꿈 금지/);
  assert.match(headCommitLine, /예시 형태/);
  // §5의 비타협(부분 문자열 충돌 금지)이 예시 문구 자신에도 그대로
  // 적용된다 -- "head_commit:"가 «콜론까지 붙어» 나타나면 안 된다(그
  // 랬다면 DISPATCH_HEAD_COMMIT_ANYWHERE_RE가 이 설명 문장 자체를
  // 근사매치로 오인한다, (f) 시험이 그 결과를 이미 고정한다).
  assert.equal(
    /head_commit:/.test(headCommitLine),
    false,
    "예시 문구도 'head_commit:'를 콜론까지 붙여 쓰면 안 된다(부분 문자열 충돌 금지, §5 비타협)",
  );
});
