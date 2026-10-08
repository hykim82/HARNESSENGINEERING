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
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import {
  RESULT_FILE_LINE_RE,
  RESULT_FILE_EMPTY_KEY_RE,
  buildResultHeaderChecklistLines,
  fillEmptyLegacyKeysInPlace,
} from "./dispatch-gate-decision.mjs";
// HYK-480-3 §2-5 (v): bestEffortInjectResultPaths는 export되지 않는 CLI
// 내부 함수라 (d)/(n)/(o)처럼 순수 함수를 직접 구동할 수 없다 --
// hyk468-3r-three-readers.test.mjs가 이미 증명한 관례(scripts/check 전체를
// 임시 디렉터리에 스테이징하고 변이한 dispatch-gate-decision.mjs 한 장만
// 바꿔 CLI를 그 경로로 그대로 구동)를 그대로 재사용한다. 스테이징 목록은
// 단일 정본 DISPATCH_GATE_DECISION_SIBLINGS(HYK-460-staging-list-fix-3)를
// 그대로 쓴다 -- 손으로 목록을 복제하면 그 자체가 새 동기화 공백이 된다.
import { DISPATCH_GATE_DECISION_SIBLINGS } from "./dispatch-gate-decision-deps.mjs";
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

const SCRIPTS_ROOT = fileURLToPath(new URL("..", import.meta.url));
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

function runCliAt(scriptPath, args) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], {
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

function runCli(args) {
  return runCliAt(SCRIPT_PATH, args);
}

function countOccurrences(text, keyLinePrefixRe) {
  return [...text.matchAll(keyLinePrefixRe)].length;
}

// HYK-480-3 §2 요구4(2R 검토 P3-2 권고): (u)의 1회차 로그 단언이 쓰는
// `.*coder\.md`는 "값 있는 result_file: 줄이면 전부" 매치해, 진짜(인용
// 밖) 줄의 경로 값과 펜스 예시의 가짜 경로 값(둘 다 "...coder.md"로
// 끝난다)을 갈라내지 못한다 -- 실제 경로 값을 그대로(escape해서) 박아
// 넣어야 "그 경로가 바로 이 경로"임을 값으로 증명한다.
function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// HYK-480-3 (v)/(M5)/(M6): 변이한 dispatch-gate-decision.mjs 한 장을 실제
// 형제 파일들과 함께 임시 디렉터리에 스테이징하고, 그 경로로 CLI를
// 그대로(child process) 구동한다 -- 같은 스테이징 관례, 참조:
// hyk468-3r-three-readers.test.mjs stageSiblings/dispatch-gate-abort-wire.
// test.mjs stageScriptsCheckDir.
const REAL_CHECK_DIR = join(SCRIPTS_ROOT, "check");

function stageMutantDispatchGateDecision(dir, mutatedSource) {
  const scriptsCheckDir = join(dir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  writeFileSync(
    join(scriptsCheckDir, "dispatch-gate-decision.mjs"),
    mutatedSource,
    "utf8",
  );
  for (const name of DISPATCH_GATE_DECISION_SIBLINGS) {
    writeFileSync(
      join(scriptsCheckDir, name),
      readFileSync(join(REAL_CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  return join(scriptsCheckDir, "dispatch-gate-decision.mjs");
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
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

// ===========================================================================
// HYK-480-2 P2-4 (검토 #310 approved · P2-4 전문): 첫 `result_file:` 매치가
// «인용(펜스) 안에만» 있으면(진짜 줄은 아예 없음) 옛 코드는 그걸 "이미
// 주입됨"으로 오판해, 점검표 채움을 매번 그 펜스 «안으로» 밀어넣었다 --
// 다음 실행에서도 그 주입분이 마스킹에 가려져 또 "누락"으로 보여 무한히
// 자랐다(검토자 실측: 9->18->27->36줄, 호출당 +1303바이트, 상한 없음).
// 수리: 분기 판정(existingMatch)과 삽입 위치(fillAt) 모두 masked 텍스트
// 기준으로 통일 -- 매치가 masked에서 사라지면(=인용 안에만 있었다는 뜻)
// 채움 자체를 거부하고 조용하지 않은 로그만 남긴다(fail-closed).
// ===========================================================================

test("(s) HYK-480-2 P2-4 수리: 첫 result_file: 매치가 펜스 인용 안에만 있으면(진짜 줄 없음) 채움을 거부하고 거부 로그를 남기며, 4회 연속 호출해도 파일이 한 바이트도 자라지 않는다(synthC 재현, CLI 프로덕션 경로)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // ⛔1b_* 블록을 일부러 넣지 않는다 -- bestEffortInjectResultPaths는
    // ALLOW/REJECT 판정과 무관하게 항상 먼저 돈다(이 파일 자신의 호출부
    // 주석, HYK-479 §A), 그래서 REJECT 라운드로 둬도 이 축을 그대로
    // 시험할 수 있고, 이 모양이면 dropped_at 스탬프(별도 축, ALLOW
    // 게이트 뒤에만 실행)가 섞이지 않아 "바이트 하나도 안 바뀐다"는
    // 단정이 이 축 하나만을 가리키게 된다(entanglement 없음).
    const original =
      `task_id: HYK-9513-quote-only-1\n` +
      `role: CODER\n` +
      "본문 설명: 예시로 결과 경로 모양을 보여준다.\n" +
      "~~~\n" +
      `result_file: C:\\example\\not-a-real-path\\coder.md\n` +
      "~~~\n" +
      `본문 계속\n`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const originalSha = createHash("sha256").update(original).digest("hex");

    for (let call = 1; call <= 4; call++) {
      const r = runCli([taskPath, "--ledger", ledgerPath]);
      // 1b_* 세 줄을 일부러 뺀 고정 모양이라 1-B precondition이 매번
      // REJECT(exit 1)다 -- 그 판정은 이 축과 무관(아래가 보는 것은
      // 오직 result-path 주입 함수의 거부/바이트 무변경뿐)이다.
      assert.equal(
        r.status,
        1,
        `call ${call}: 1-B precondition REJECT is this fixture's own, unrelated exit code`,
      );
      assert.match(
        r.stdout,
        /result-path injection REFUSED \(fail-closed, HYK-480-2 P2-4\)/,
        `call ${call}: refusal must be logged loudly, never a silent no-op`,
      );
      // HYK-480-3 §2 요구2(P2-1 수리): 옛 문구 "no 'result_file:' line
      // outside a quoted/fenced region" -> 새 문구 "no non-empty
      // result_file line outside quoted regions"로 사실화됐다 -- 인용
      // 밖에 «빈 키»가 있는 모양(P2-1)에서는 이 거부 자체를 타지 않게
      // 됐으므로(= 아래 (v)), 이 축이 실제로 거부로 떨어지는 모양은
      // "인용 밖에 값 있는 줄도 빈 키도 하나도 없다"는 뜻이어야 정확하다.
      assert.match(
        r.stdout,
        /no non-empty result_file line outside quoted regions/,
        `call ${call}: refusal reason must name the actual cause, and must not claim "no result_file: line at all" when an empty key could exist (HYK-480-3 §2 요구2)`,
      );
      assert.doesNotMatch(
        r.stdout,
        /result-path block machine-injected|checklist fill-in-place/,
        `call ${call}: must not fall through to injection or checklist-fill`,
      );

      const after = readFileSync(taskPath, "utf8");
      const afterSha = createHash("sha256").update(after).digest("hex");
      assert.equal(
        afterSha,
        originalSha,
        `call ${call}: task file must be byte-identical to the pristine original -- the bug grew it by +1303 bytes per call`,
      );
      assert.equal(
        [...after.matchAll(/^result_header_checklist_[a-z_]+:/gim)].length,
        0,
        `call ${call}: zero checklist lines must ever be injected into the fence`,
      );
    }
  });
});

test("(t) HYK-480-2 §2 요구1&2 무회귀: 진짜(인용 밖) 값 있는 result_file: 이 뒤쪽 펜스 인용 예시보다 먼저 오면, masked 기준 매치로도 지금까지와 같이 그 진짜 줄을 '이미 주입됨'으로 보고 점검표만 채우며, 인용 예시는 바이트 그대로 남는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original =
      `task_id: HYK-9514-real-before-quote-1\n` +
      `role: CODER\n` +
      `result_file: ${join(dir, "coder.md")}\n` +
      "본문 설명: 아래는 예시일 뿐이다.\n" +
      "~~~\n" +
      `result_file: C:\\example\\not-a-real-path\\coder.md\n` +
      "~~~\n" +
      `본문 계속\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const first = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(first.status, 0);
    assert.match(
      first.stdout,
      /result-path injection skipped \(already injected -- matched line: 'result_file:.*coder\.md'\)/,
      "진짜(인용 밖) 줄이 masked 매치로도 '이미 주입됨'으로 잡혀야 한다(무회귀)",
    );
    assert.doesNotMatch(first.stdout, /REFUSED/);

    const afterFirst = readFileSync(taskPath, "utf8");
    assert.match(
      afterFirst,
      /~~~\nresult_file: C:\\example\\not-a-real-path\\coder\.md\n~~~/,
      "펜스 인용 예시 줄은 바이트 그대로 남아야 한다",
    );
    assert.equal(
      [...afterFirst.matchAll(/^result_header_checklist_role:/gim)].length,
      1,
      "첫 실행에서 점검표가 정상적으로 채워져야 한다(무회귀)",
    );

    // 두 번째 호출 -- 완전 멱등(점검표도 이미 다 있으므로 바이트 무변경).
    const second = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(second.status, 0);
    const afterSecond = readFileSync(taskPath, "utf8");
    assert.equal(
      afterSecond,
      afterFirst,
      "두 번째 호출은 파일을 단 1바이트도 바꾸지 않아야 한다",
    );
  });
});

// ---------------------------------------------------------------------------
// 검토 #310-r2 P2-1 (HYK-480-checklist-inject-2-review-1 §8): 요구 2(삽입
// 위치도 가린 텍스트 기준)가 실제로 갈리는 입력은 synthMixed(펜스 인용
// 예시가 먼저, 펜스 밖 진짜 result_file: 줄이 뒤) 모양뿐이다 -- (s)는
// 거부 갈래에서 끝나고 (t)는 원문 첫 매치 = 가린 첫 매치인 모양이라 둘
// 다 이 줄을 보지 않는다. 이 칸이 그 공백을 메운다: 삽입 위치를 원문
// 기준(RED 재현 M2)으로 되돌리면 synthMixed는 펜스 「안」에 거듭
// 밀어넣어져 9->18->27->36으로 상한 없이 자란다(검토 §1 실측, 이
// 라운드 scratch 재현과 같은 수치) -- 지금 프로덕션(가린 텍스트 기준)은
// 진짜 줄 바로 뒤에 한 번만 채우고 4회 연속 호출해도 더 자라지 않는다.
// ---------------------------------------------------------------------------
test("(u) HYK-480-2 P2-1 수리: synthMixed(펜스 예시가 먼저, 진짜 result_file: 줄이 뒤)에서도 가린 텍스트 매치를 따라 진짜 줄 바로 뒤에만 채우고, 4회 연속 호출해도 더 자라지 않으며, 펜스 예시는 바이트 그대로 남는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const resultFile = join(dir, "coder.md");
    const original =
      `task_id: HYK-9515-quote-before-real-1\n` +
      `role: CODER\n` +
      "본문 설명: 아래는 예시일 뿐이다.\n" +
      "~~~\n" +
      `result_file: C:\\example\\not-a-real-path\\coder.md\n` +
      "~~~\n" +
      `본문 계속\n` +
      `result_file: ${resultFile}\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    let shaAfterCall1;
    for (let call = 1; call <= 4; call++) {
      const r = runCli([taskPath, "--ledger", ledgerPath]);
      assert.equal(r.status, 0, `call ${call}: expected ALLOW`);
      assert.doesNotMatch(
        r.stdout,
        /REFUSED/,
        `call ${call}: 진짜 줄이 뒤에 있으면 거부로 떨어지면 안 된다(요구 1과 요구 2는 서로 다른 모양을 본다)`,
      );
      const after = readFileSync(taskPath, "utf8");
      const sha = createHash("sha256").update(after).digest("hex");

      if (call === 1) {
        // HYK-480-3 §2 요구4(P3-2 수리): `.*coder\.md`는 펜스 예시의
        // 가짜 경로('C:\example\not-a-real-path\coder.md')에도 매치
        // 하므로, 진짜(인용 밖) 경로 값을 그대로 escape해 끼워 넣어 -- 두
        // 후보 중 "이 값"이 찍혔다는 것까지 좁혀 단정한다(M2처럼 원문
        // 기준 매치로 되돌아가 '먼저 나오는' 펜스 예시 줄을 '이미
        // 주입됨'으로 잘못 잡아도 이 느슨한 정규식으로는 여전히 통과
        // 했을 자리).
        const matchedLineRe = new RegExp(
          `result-path injection skipped \\(already injected -- matched line: 'result_file: ${escapeRegExp(resultFile)}'\\)`,
        );
        assert.match(
          r.stdout,
          matchedLineRe,
          "call 1: 가린 텍스트 매치가 진짜(인용 밖) 줄의 '그 경로 값'을 '이미 주입됨'으로 잡아야 한다(펜스 예시의 가짜 경로가 아니다)",
        );
        assert.doesNotMatch(
          r.stdout,
          /matched line: 'result_file: C:\\example\\not-a-real-path\\coder\.md'/,
          "call 1: 펜스 예시의 가짜 경로가 '이미 주입됨' 매치로 찍히면 안 된다(M2 재발 시 이 축이 레드로 샌다)",
        );
        // 요구 2가 갈리는 지점: 채움 블록이 펜스 예시 "안"이 아니라
        // 펜스 밖 진짜 줄 바로 뒤에 와야 한다(원문 기준 매치였다면
        // 이 블록이 펜스 예시 뒤에 붙어 매번 펜스 안을 거듭 키운다).
        assert.ok(
          after.includes(
            `result_file: ${resultFile}\nresult_header_checklist_fill:`,
          ),
          "call 1: 채움 블록은 진짜 result_file: 줄 바로 뒤에 와야 한다(펜스 안이 아님)",
        );
        shaAfterCall1 = sha;
      } else {
        assert.equal(
          sha,
          shaAfterCall1,
          `call ${call}: 첫 채움 뒤로는 바이트가 1개도 바뀌면 안 된다(완전 멱등) -- 수리 전(M2와 같은 모양)에는 호출마다 +1303B씩 9->18->27->36으로 자랐다`,
        );
      }

      assert.match(
        after,
        /~~~\nresult_file: C:\\example\\not-a-real-path\\coder\.md\n~~~/,
        `call ${call}: 펜스 인용 예시는 바이트 그대로 남아야 한다`,
      );
      assert.equal(
        [...after.matchAll(/^result_header_checklist_[a-z_]+:/gim)].length,
        9,
        `call ${call}: 점검표 줄 수는 9에서 상한을 넘지 않아야 한다(수리 전/M2 재현: 9->18->27->36으로 무한 성장)`,
      );
    }
  });
});

// ===========================================================================
// HYK-480-3 §2-5 (v, 필수): 2R 검토 P2-1 가 지목한 네 번째 모양 -- 펜스
// 「안」 값 있는 result_file: 예시(진짜 줄 아님) + 펜스 「밖」 열 0 빈
// result_file: 키 + 빈 runner_receipt_file: 키. (s)는 거부 갈래(진짜 줄도
// 빈 키도 없음)에서 끝나고, (t)/(u)는 인용 밖에 «값 있는» 진짜 줄이 있는
// 모양이라 둘 다 이 네 번째 모양을 보지 않는다 -- 이 칸이 그 공백을
// 메운다: §2-1 수리 후에는 이 모양에서 거부가 아니라 빈 키 제자리 채움이
// 일어나야 한다.
// ===========================================================================
const CHECKLIST_KEY_PREFIXES = [
  "result_header_checklist_note",
  "result_header_checklist_role",
  "result_header_checklist_task_id",
  "result_header_checklist_for",
  "result_header_checklist_verdict",
  "result_header_checklist_headcommit",
  "result_header_checklist_done",
  "result_header_checklist_runner_naming",
];

test("(v0) RESULT_FILE_EMPTY_KEY_RE 단독: 값 없는 줄에만 매치하고, 값 있는 줄·개행 삼키는 모양에는 매치하지 않는다(프로덕션 export 직접 구동)", () => {
  assert.equal(RESULT_FILE_EMPTY_KEY_RE.test("result_file:"), true);
  assert.equal(RESULT_FILE_EMPTY_KEY_RE.test("result_file:   "), true);
  assert.equal(
    RESULT_FILE_EMPTY_KEY_RE.test("result_file: /abs/coder.md"),
    false,
    "값이 있으면 매치하지 않는다(그건 RESULT_FILE_LINE_RE의 몫)",
  );
  const multiLine = "result_file:\nrunner_receipt_file:";
  const match = multiLine.match(RESULT_FILE_EMPTY_KEY_RE);
  assert.ok(match, "빈 result_file: 줄이 있으면 매치한다");
  assert.equal(
    match[0],
    "result_file:",
    "매치는 그 줄 자신에서 끝난다 -- 다음 줄까지 삼키지 않는다(§1 실사고와 같은 '\\s*' 함정 재발 방지)",
  );
});

test("(v) HYK-480-3 §2-1 수리: 펜스 안 값 있는 result_file: 예시 + 펜스 밖 빈 result_file:/runner_receipt_file: 키 모양에서는 거부가 아니라 그 자리에서 빈 키가 채워지고, 점검표 8키가 각각 1번씩, 펜스 예시는 바이트 그대로, 2~4회째는 더 자라지 않는다(CLI 프로덕션 경로)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const resultFile = join(dir, "coder.md");
    const receiptFile = join(dir, "runner-receipt.json");
    const original =
      `task_id: HYK-9517-fence-example-then-empty-keys-1\n` +
      `role: CODER\n` +
      "본문 설명: 아래는 예시일 뿐이다.\n" +
      "~~~\n" +
      `result_file: C:\\example\\not-a-real-path\\coder.md\n` +
      "~~~\n" +
      `본문 계속\n` +
      `result_file:\n` +
      `runner_receipt_file:\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    let shaAfterCall1;
    for (let call = 1; call <= 4; call++) {
      const r = runCli([taskPath, "--ledger", ledgerPath]);
      assert.equal(r.status, 0, `call ${call}: expected ALLOW`);
      // ⓔ 거부 로그가 한 번도 안 찍혔는가.
      assert.doesNotMatch(
        r.stdout,
        /REFUSED/,
        `call ${call}: 인용 밖에 빈 키가 있으면 값 있는 예시가 펜스 안에만 있어도 거부로 떨어지면 안 된다(§2-1 수리)`,
      );

      const after = readFileSync(taskPath, "utf8");
      const sha = createHash("sha256").update(after).digest("hex");

      if (call === 1) {
        // ⓐ 1회째: 빈 키가 "그 줄 그 자리에서" 채워졌는가(내용 + 줄
        // 위치까지 -- 개수만 세지 않는다). 펜스 예시 「안」이 아니라
        // 본문의 두 빈 줄이 있던 자리 그대로다.
        assert.ok(
          after.includes(
            `본문 계속\nresult_file: ${resultFile}\nrunner_receipt_file: ${receiptFile}\n`,
          ),
          "call 1: 두 빈 키가 그 줄 그 자리에서(본문 계속 바로 뒤) 채워져야 한다 -- 펜스 예시 안이 아니다",
        );
        assert.match(
          r.stdout,
          /result-path block machine-injected \(HYK-480, in-place fill of empty template keys: result_file, runner_receipt_file\)/,
          "call 1: 빈 키 제자리 채움이 실물로 로그에 찍혀야 한다(조용한 no-op 아님)",
        );

        // ⓑ 점검표 8키가 인용 밖에 각각 정확히 1번인가.
        for (const prefix of CHECKLIST_KEY_PREFIXES) {
          assert.equal(
            countOccurrences(after, new RegExp(`^${prefix}:`, "gim")),
            1,
            `call 1: ${prefix}: must appear exactly once`,
          );
        }
        shaAfterCall1 = sha;
      } else {
        // ⓓ 2~4회째 sha256 이 1회째 결과와 같은가(완전 멱등 -- 더 자라지
        // 않는다).
        assert.equal(
          sha,
          shaAfterCall1,
          `call ${call}: 1회째 채움 뒤로는 바이트가 1개도 바뀌면 안 된다(완전 멱등)`,
        );
      }

      // ⓒ 펜스 안 예시가 바이트 그대로인가(부분 문자열 동일, 매 호출).
      assert.match(
        after,
        /~~~\nresult_file: C:\\example\\not-a-real-path\\coder\.md\n~~~/,
        `call ${call}: 펜스 인용 예시는 바이트 그대로 남아야 한다`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// HYK-480-3 변이 M5 (필수, RED): §2-1 이 더하는 "빈 키 게이트"를 죽이면
// -- 값은 늘 false 이므로 if (!hasGenuineEmptyResultFileKey) 분기가 항상
// 타서 -- 위 (v)의 모양이 다시 거부(REFUSED)로 샌다(= ae5cf1b 의 순서로
// 되돌림). 로그 문구 자체는(M6과 분리) 건드리지 않는다.
// ---------------------------------------------------------------------------
test("RED(변이 M5, 필수): 빈 키 게이트를 죽이면(거부 분기가 채움보다 항상 먼저 걸림, = ae5cf1b 순서) (v) 모양이 다시 거부로 샌다", () => {
  const realSource = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "const hasGenuineEmptyResultFileKey =\n      RESULT_FILE_EMPTY_KEY_RE.test(maskedOriginal);";
  assertExactlyOneMatch(
    realSource,
    target,
    "hasGenuineEmptyResultFileKey 선언",
  );
  const mutated = realSource.replace(
    target,
    "const hasGenuineEmptyResultFileKey = false; // MUTATED(HYK-480-3 M5 RED): 게이트를 죽여 거부 분기가 항상 먼저 걸린다(= ae5cf1b 순서로 되돌림)",
  );

  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // ⛔1b_* 블록을 일부러 넣지 않는다 -- (s)와 같은 이유(이 파일 자신의
    // (s) 주석): bestEffortInjectResultPaths는 ALLOW/REJECT 판정과 무관
    // 하게 항상 먼저 돈다. 1b_*를 채우면 ALLOW로 넘어가 dropped_at
    // 스탬프(별개 축, ALLOW 게이트 뒤에만 실행)가 끼어들어 "바이트
    // 무변경" 단정이 이 축(result-path 거부) 하나만을 가리키지 못하게
    // 된다(entanglement) -- 1R 구현 중 실측으로 드러난 함정, 이 주석이
    // 그 값을 적어 둔다.
    const original =
      `task_id: HYK-9518-m5-mutation-1\n` +
      `role: CODER\n` +
      "본문 설명: 아래는 예시일 뿐이다.\n" +
      "~~~\n" +
      `result_file: C:\\example\\not-a-real-path\\coder.md\n` +
      "~~~\n" +
      `본문 계속\n` +
      `result_file:\n` +
      `runner_receipt_file:\n`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const originalSha = createHash("sha256").update(original).digest("hex");

    const mutantDir = mkdtempSync(join(tmpdir(), "dispatch-gate-m5-stage-"));
    try {
      const mutantPath = stageMutantDispatchGateDecision(mutantDir, mutated);
      const r = runCliAt(mutantPath, [taskPath, "--ledger", ledgerPath]);
      assert.match(
        r.stdout,
        /result-path injection REFUSED \(fail-closed, HYK-480-2 P2-4\)/,
        "RED: 게이트가 죽으면 (v) 모양도 다시 거부로 샌다(이 축이 실제로 결과를 바꾼다는 증거)",
      );
      const after = readFileSync(taskPath, "utf8");
      const afterSha = createHash("sha256").update(after).digest("hex");
      assert.equal(
        afterSha,
        originalSha,
        "RED: 거부 갈래는 여전히 바이트 무변경이다(이 변이가 바꾸는 건 '거부 여부'뿐, 거부 자체의 무변경성이 아니다)",
      );
    } finally {
      rmSync(mutantDir, { recursive: true, force: true });
    }

    // 복원 증명: 변이는 임시 스테이징 디렉터리에만 썼다 -- 실 소스 파일은
    // 전혀 건드리지 않았다.
    const afterMutationRealSource = readFileSync(SCRIPT_PATH, "utf8");
    assert.equal(
      afterMutationRealSource,
      realSource,
      "원복 증명: 실 소스 파일은 바이트 동일해야 한다(변이는 임시 사본에만 적용)",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-480-3 변이 M6 (필수, RED): §2 요구2가 고친 거부 로그 문구를 옛
// 문구로 되돌리면, (s)의 새 단언("no non-empty result_file line outside
// quoted regions")이 더 이상 찾을 수 없는 문자열이 된다 -- 값으로:
// 되돌린 뒤 실제 찍히는 문구가 옛 문구이고, 새 문구 패턴은 매치되지
// 않는다는 것을 직접 보인다(= 되돌리면 (s)가 잡아낸다는 증거).
// ---------------------------------------------------------------------------
test("RED(변이 M6, 필수): 거부 로그 문구를 옛 문구로 되돌리면 새 문구가 더 이상 찍히지 않는다(값 증거 -- 되돌리면 (s)가 잡아낸다)", () => {
  const realSource = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "`dispatch-gate-decision: result-path injection REFUSED (fail-closed, HYK-480-2 P2-4) -- no non-empty result_file line outside quoted regions (raw match: '${rawMatchAnywhere[0].trim()}') -- not injecting paths, not filling checklist, task file left byte-unchanged -- ${taskPath}`,";
  assertExactlyOneMatch(realSource, target, "거부 로그 템플릿 문자열");
  const mutated = realSource.replace(
    target,
    "`dispatch-gate-decision: result-path injection REFUSED (fail-closed, HYK-480-2 P2-4) -- no 'result_file:' line outside a quoted/fenced region (raw match: '${rawMatchAnywhere[0].trim()}') -- not injecting paths, not filling checklist, task file left byte-unchanged -- ${taskPath}`,",
  );

  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // (s)와 같은 모양(진짜 줄도 빈 키도 인용 밖에 없음) -- 이 모양에서만
    // 거부가 일어난다(§2-1 수리 후에도 그대로).
    const original =
      `task_id: HYK-9519-m6-mutation-1\n` +
      `role: CODER\n` +
      "본문 설명: 예시로 결과 경로 모양을 보여준다.\n" +
      "~~~\n" +
      `result_file: C:\\example\\not-a-real-path\\coder.md\n` +
      "~~~\n" +
      `본문 계속\n`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const mutantDir = mkdtempSync(join(tmpdir(), "dispatch-gate-m6-stage-"));
    try {
      const mutantPath = stageMutantDispatchGateDecision(mutantDir, mutated);
      const r = runCliAt(mutantPath, [taskPath, "--ledger", ledgerPath]);
      assert.match(
        r.stdout,
        /no 'result_file:' line outside a quoted\/fenced region/,
        "RED: 되돌리면 옛 문구가 실제로 찍힌다",
      );
      assert.doesNotMatch(
        r.stdout,
        /no non-empty result_file line outside quoted regions/,
        "값 증거: 되돌리면 (s)가 찾는 새 문구는 더 이상 이 출력에 없다 -- 되돌아가면 (s)가 레드로 샌다는 뜻",
      );
    } finally {
      rmSync(mutantDir, { recursive: true, force: true });
    }

    const afterMutationRealSource = readFileSync(SCRIPT_PATH, "utf8");
    assert.equal(
      afterMutationRealSource,
      realSource,
      "원복 증명: 실 소스 파일은 바이트 동일해야 한다(변이는 임시 사본에만 적용)",
    );
  });
});

// ── HYK-209 (2026-10-05) -- `dropped_at:` 빈 값이 다음 줄을 값으로 오독하던
// 실사고 수리. 같은 파일에 두는 이유는 위 헤더와 같다(1b_exec_line 이 이 파일을
// 고정 목록으로 태운다). 세 모양(ⓐ빈 값 ⓑ값 있음 ⓒ줄 없음) + 음성 대조 +
// 봉투 축 + 경계(탭 뒤 값·공백만 있는 값) + 모호 거부(빈 줄 2개).
import {
  checkGatePreconditions,
  DISPATCH_GATE_STATE,
} from "./dispatch-gate-decision-core.mjs";
import { archiveRoundTaskFile } from "./envelope-archive.mjs";
import { DROPPED_AT_RE } from "./relay-handshake.mjs";

// dropLine: 문자열(그 줄을 넣는다) | null(dropped_at 줄 자체를 넣지 않는다)
function hyk209TaskBody(dropLine) {
  const dropPart = dropLine === null ? "" : `${dropLine}\n`;
  return (
    `task_id: HYK-9601-dropped-empty-1\nrole: CODER\n${dropPart}` +
    `some body\n${ONE_B_BLOCK}`
  );
}

function runHyk209Shape(body) {
  let out;
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(taskPath, body, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    out = { r, after: readFileSync(taskPath, "utf8") };
  });
  return out;
}

const DROP_LINES = (text) =>
  text.split("\n").filter((l) => /^dropped_at:/.test(l));

test("HYK-209 (a) ⓐ 빈 값 `dropped_at:` -> 제자리에서 기계 스탬프가 채워지고 줄은 1개(중복 없음), 다음 줄은 무변경", () => {
  const { r, after } = runHyk209Shape(hyk209TaskBody("dropped_at:"));
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /machine-filled in place/);
  const lines = DROP_LINES(after);
  assert.equal(
    lines.length,
    1,
    "exactly one dropped_at line -- filled in place, never duplicated",
  );
  assert.match(lines[0], /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/);
  assert.match(
    after,
    /^role: CODER$/m,
    "the line after the empty key stays untouched",
  );
  // 소비측 정규식(수리본)이 같은 값을 읽는다 -- 다음 줄 텍스트가 아니다
  const readBack = DROPPED_AT_RE.exec(after);
  assert.ok(readBack, "the repaired consumer regex finds the stamped value");
  assert.equal(readBack[1].trim(), lines[0].slice("dropped_at: ".length));
});

test("HYK-209 (b) ⓑ 값 있음 `dropped_at: 2026-10-05 09:00 KST` -> write-once 그대로(덮어쓰지 않음, 기존 계약 무변경)", () => {
  const { r, after } = runHyk209Shape(
    hyk209TaskBody("dropped_at: 2026-10-05 09:00 KST"),
  );
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /already present -- write-once/);
  assert.deepEqual(DROP_LINES(after), ["dropped_at: 2026-10-05 09:00 KST"]);
});

test("HYK-209 (c) ⓒ `dropped_at:` 줄 자체가 없음 -> task_id 바로 뒤에 기계 삽입(HYK-316 동작 무변경)", () => {
  const { r, after } = runHyk209Shape(hyk209TaskBody(null));
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /machine-inserted right after 'task_id:'/);
  // 삽입 위치: task_id 바로 다음 줄(뒤에 점검표 블록이 붙으므로 role 줄은 나중에 온다)
  assert.match(
    after,
    /^task_id: HYK-9601-dropped-empty-1\ndropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\n/m,
  );
  assert.match(after, /^role: CODER$/m);
  assert.equal(DROP_LINES(after).length, 1);
});

test("HYK-209 (d) 경계: 탭 뒤 값(`dropped_at:\\t…`)은 계속 매치되고, 공백만 있는 값은 「빈 값」으로 채워진다", () => {
  const tabBody = runHyk209Shape(
    hyk209TaskBody("dropped_at:\t2026-10-05 09:00 KST"),
  );
  assert.equal(tabBody.r.status, 0);
  assert.match(
    tabBody.r.stdout,
    /already present -- write-once/,
    "tab-separated value stays a present value",
  );
  assert.equal(
    DROPPED_AT_RE.exec("dropped_at:\t2026-10-05 09:00 KST")[1].trim(),
    "2026-10-05 09:00 KST",
  );

  const spacesBody = runHyk209Shape(hyk209TaskBody("dropped_at:   "));
  assert.equal(spacesBody.r.status, 0);
  assert.match(
    spacesBody.r.stdout,
    /machine-filled in place/,
    "whitespace-only value is treated as empty, not as a value",
  );
  assert.equal(DROP_LINES(spacesBody.after).length, 1);
});

test("HYK-209 (e) 모호: 빈 `dropped_at:` 줄이 2개 -> 어느 줄도 채우지 않고, 그 사유가 다른 precondition 사유와 구별되는 문자열로 거부된다", () => {
  const body = hyk209TaskBody("dropped_at:").replace(
    "some body\n",
    "dropped_at:\nsome body\n",
  );
  const { r, after } = runHyk209Shape(body);
  assert.notEqual(r.status, 0, "ambiguous shape must not ALLOW");
  assert.match(
    `${r.stdout}${r.stderr}`,
    /'dropped_at:' 줄이 2개이고 값이 비어 있음/,
    "the rejection names the shape: the dropped_at line is present but empty",
  );
  assert.equal(
    [...after.matchAll(/^dropped_at:[ \t]*$/gm)].length,
    2,
    "no stamp written into either ambiguous line",
  );
});

test("HYK-209 (f) 코어 단독: REJECT_DROPPED_AT_EMPTY_AMBIGUOUS 는 빈 줄 2개에서만 나고, 0·1개는 기존 계약 그대로(null)", () => {
  const base = {
    taskIdMatchCount: 1,
    taskIdFormatValid: true,
    ledgerExists: true,
    ledgerLoadOk: true,
    ledgerEntryShapeValid: true,
  };
  assert.equal(
    checkGatePreconditions(base),
    null,
    "no empty line -> unchanged contract",
  );
  assert.equal(
    checkGatePreconditions({ ...base, droppedAtEmptyLineCount: 1 }),
    null,
    "one empty line -> the stamp fills it in place",
  );
  const two = checkGatePreconditions({ ...base, droppedAtEmptyLineCount: 2 });
  assert.equal(
    two.state,
    DISPATCH_GATE_STATE.REJECT_DROPPED_AT_EMPTY_AMBIGUOUS,
  );
  assert.equal(two.allow, false);
  // 기존 여섯 precondition 사유와 서로 다른 문자열이어야 한다(P1-B 축)
  const taskIdNotUnique = checkGatePreconditions({
    ...base,
    taskIdMatchCount: 0,
  });
  assert.notEqual(two.reason, taskIdNotUnique.reason);
});

test("HYK-209 (g) 봉투 축: 빈 값 task 는 봉투 머리줄에 `dropped_at=unknown`(오독 없음), 값 있는 task 는 그 값이 기록된다", () => {
  withFixtureDir((dir) => {
    const empty = archiveRoundTaskFile({
      role: "CODER",
      taskContent: "task_id: HYK-9602-env-1\ndropped_at:\nrole: CODER\n",
      harnessDir: join(dir, "h1"),
    });
    assert.equal(empty.ok, true, empty.reason);
    const emptyHeader = readFileSync(empty.path, "utf8").split("\n")[0];
    assert.match(emptyHeader, /dropped_at=unknown /);
    assert.doesNotMatch(
      emptyHeader,
      /dropped_at=role/,
      "the next line's text must never become the value",
    );

    const filled = archiveRoundTaskFile({
      role: "CODER",
      taskContent:
        "task_id: HYK-9602-env-2\ndropped_at: 2026-10-05 09:00 KST\nrole: CODER\n",
      harnessDir: join(dir, "h2"),
    });
    assert.equal(filled.ok, true, filled.reason);
    const filledHeader = readFileSync(filled.path, "utf8").split("\n")[0];
    assert.match(filledHeader, /dropped_at=2026-10-05 09:00 KST /);
  });
});

test("HYK-209 (h) 변이 RED: 옛 `\\s*` 정규식은 빈 dropped_at: 줄 다음 줄을 값으로 읽는다 -- 수리본은 그러지 않는다", () => {
  const OLD_DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
  const body = "task_id: HYK-9603-red-1\ndropped_at:\nrole: CODER\n";
  assert.equal(
    OLD_DROPPED_AT_RE.exec(body)[1],
    "role: CODER",
    "the old regex misreads the next line (실사고 모양)",
  );
  assert.equal(
    DROPPED_AT_RE.exec(body),
    null,
    "the repaired regex reads an empty line as no value",
  );
});

// ── HYK-209 깊이 방어 (2026-10-05, 검토 P2-1 수리) ──
// 제자리 채움·계수는 인용·펜스 안의 `dropped_at:` 예시를 건드리지 않는다
// (음성 대조), 칼럼 0의 진짜 빈 줄은 여전히 채워진다(양성 대조), 진짜 빈
// 줄이 2개면 인용을 빼고 세도 여전히 거부된다(계수 축 대조).
const DEPTH_FENCE_EXAMPLE = "```\ndropped_at:\n```\n";
const DEPTH_HTML_EXAMPLE = "<!--\ndropped_at:\n-->\n";
const DEPTH_STAMP_LINE_RE =
  /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\r?$/;

function hyk209DepthBody(realLine, extra) {
  return (
    `task_id: HYK-9602-depth-fence-1\nrole: CODER\n${realLine}\n` +
    `some body\n${extra}${ONE_B_BLOCK}`
  );
}

test("HYK-209 깊이 (i) 음성 대조: 펜스 안 빈 `dropped_at:` 예시는 바이트 무변경, 진짜 빈 줄(칼럼 0)만 채워진다", () => {
  const { r, after } = runHyk209Shape(
    hyk209DepthBody("dropped_at:", DEPTH_FENCE_EXAMPLE),
  );
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /machine-filled in place/);
  assert.ok(
    after.includes(DEPTH_FENCE_EXAMPLE),
    "the fenced example must survive byte-for-byte",
  );
  const stamped = after.split("\n").filter((l) => DEPTH_STAMP_LINE_RE.test(l));
  assert.equal(stamped.length, 1, "exactly the one real line is filled");
  assert.match(
    after,
    /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\nsome body\n/m,
  );
});

test("HYK-209 깊이 (j) 음성 대조: HTML 주석 안 빈 `dropped_at:` 예시도 바이트 무변경, 진짜 빈 줄만 채워진다", () => {
  const { r, after } = runHyk209Shape(
    hyk209DepthBody("dropped_at:", DEPTH_HTML_EXAMPLE),
  );
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  assert.ok(
    after.includes(DEPTH_HTML_EXAMPLE),
    "the commented-out example must survive byte-for-byte",
  );
  const stamped = after.split("\n").filter((l) => DEPTH_STAMP_LINE_RE.test(l));
  assert.equal(stamped.length, 1);
});

test("HYK-209 깊이 (k) 계수 축: 칼럼 0의 진짜 빈 줄 2개는 인용을 빼고 세도 여전히 모호로 거부된다(펜스 예시는 무변경)", () => {
  const body = hyk209DepthBody(
    "dropped_at:",
    `dropped_at:\n${DEPTH_FENCE_EXAMPLE}`,
  );
  const { r, after } = runHyk209Shape(body);
  assert.notEqual(r.status, 0, "two genuine empty lines must not ALLOW");
  // 헤더 점검표 주입(HYK-465/480)은 CLI가 게이트 전에 하므로 바이트 동일 대신
  // 「빈 줄 3개(진짜 2 + 펜스 1)가 그대로」라는 사실만 본다 -- 아무것도 채워지지 않았다.
  assert.equal(
    after.split("\n").filter((l) => l === "dropped_at:").length,
    3,
    "no empty line may be filled when the count is ambiguous",
  );
  assert.ok(after.includes(DEPTH_FENCE_EXAMPLE), "fenced example untouched");
});

test("HYK-209 깊이 (l) 양성 대조 CRLF: CRLF 파일의 진짜 빈 줄도 채워지고 줄끝 CR 이 보존된다", () => {
  const body = hyk209DepthBody("dropped_at:", "").replace(/\n/g, "\r\n");
  const { r, after } = runHyk209Shape(body);
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  const stamped = after
    .split("\r\n")
    .filter((l) => DEPTH_STAMP_LINE_RE.test(l));
  assert.equal(stamped.length, 1, "the CRLF line is filled and keeps its CR");
  assert.equal(
    after.includes("dropped_at:\r\n"),
    false,
    "no empty line survives",
  );
});

// ── HYK-209 깊이 방어 (검토 P3-3 대응 · 전수 계수) ──
// `dropped_at` 정규식 리터럴 9자리가 전부 `\s` 없이 `[ \t]` 로만 좁혀져 있다.
// 새 자리가 생기면 이 단정이 수를 바꿔 알려야 한다(조용히 `\s*` 가 되살아나지 않게).
test("HYK-209 깊이 (m) 전수 계수: scripts/ 안 `/^dropped_at:` 정규식 리터럴은 정확히 9자리이고 그 어느 것도 `\\s` 를 쓰지 않는다", () => {
  const sites = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) {
        for (const line of readFileSync(full, "utf8").split("\n")) {
          if (line.includes("/^dropped_at:")) sites.push({ full, line });
        }
      }
    }
  };
  walk(join(SCRIPTS_ROOT));
  assert.equal(
    sites.length,
    9,
    `expected 9 dropped_at regex sites, got ${sites.length}`,
  );
  for (const { full, line } of sites) {
    assert.doesNotMatch(line, /\\s/, `${full} still uses \\s: ${line.trim()}`);
  }
});

test("HYK-209 깊이 (n) 닫히지 않은 펜스 «뒤»의 진짜 빈 줄도 제자리에서 채워진다(삽입으로 줄을 늘리지 않는다)", () => {
  const body = `task_id: HYK-9603-unclosed-fence-1\nrole: CODER\n${ONE_B_BLOCK}\`\`\`\nsome unclosed example\ndropped_at:\n`;
  const { r, after } = runHyk209Shape(body);
  assert.equal(r.status, 0, `ALLOW expected, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /machine-filled in place/);
  assert.doesNotMatch(
    r.stdout,
    /machine-inserted/,
    "the empty line must be filled, not joined by a second inserted line",
  );
  assert.equal(
    DROP_LINES(after).length,
    1,
    "exactly one dropped_at line after the fill",
  );
  assert.equal(after.split("\n").includes("dropped_at:"), false);
});
