// HYK-383 2R §2: "대상 커밋을 지정하지 않은 REVIEW 배달은 애초에 나가지
// 않는다." 1R은 relay-handshake.mjs의 소비 축(resolveHeadCommitBinding)만
// 걸었다 -- 워커가 라운드를 통째로 끝낸 뒤에야 막혔고, 2026-08-28 23:14에
// 실제로 검토 라운드 하나를 그렇게 버렸다(검토 1R 원문). 이 시험은 그
// 실패를 배달 시점으로 앞당기는 새 축(dispatch-gate-decision.mjs의
// checkHeadCommitPrecondition/extractHeadCommitFacts)을, 관제실
// `dispatch-worker.ps1`의 `[1.5/3]`이 실제로 부르는 그 CLI로 직접
// 고정한다(§5의 «실제 소비 명령» 대응 -- 여기서는 «실제 배달 게이트»).
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtemp 안에 새로 만든 합성
// 원장이다 -- 실제 `.harness/reject-streak.json`은 절대 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeLedger } from "./reject-streak.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, "dispatch-gate-decision.mjs");

// hyk241-oneb-gate-mutation.test.mjs와 동일한 «고정 의존성 목록» 관례
// (그 파일 헤더 주석 원문) -- dispatch-gate-decision.mjs가 정적 import하는
// 형제 모듈 전부를 격리 사본 옆에 함께 둬야 mutant 모듈이 MODULE_NOT_FOUND
// 없이 로드된다. 이 라운드는 새 정적 import를 추가하지 않았으므로(이미
// import된 dispatch-gate-decision-core.mjs의 새 export 하나만 씀) 이
// 목록은 그 파일의 것과 동일하다.
const SIBLING_FILES = [
  "dispatch-gate-decision-core.mjs",
  "reject-streak.mjs",
  "reject-streak-chain.mjs",
  "consumption-receipt-core.mjs",
  "dropped-at-stamp-core.mjs",
  "abort-record-core.mjs",
  "retirement-record-core.mjs",
  "envelope-archive.mjs",
];

function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "dispatch-gate-decision.mjs": readFileSync(SCRIPT_PATH, "utf8"),
  };
  for (const name of SIBLING_FILES) {
    files[name] = readFileSync(join(HERE, name), "utf8");
  }
  Object.assign(files, overrides);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return join(scriptsCheckDir, "dispatch-gate-decision.mjs");
}

// dispatch-gate-decision.test.mjs 자신의 관례 그대로 재사용(그 파일 헤더
// 주석 원문): 1-B 축이 이미 이 CLI에 걸려 있으므로, ALLOW를 기대하는
// 모든 fixture는 이 블록도 함께 갖춰야 한다 -- head_commit 축과 무관.
const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-head-commit-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// dispatch-gate-decision.test.mjs 자신의 SHARED_EMPTY_RECEIPT_PATH 관례
// 그대로(그 파일 헤더 주석 원문 인용) -- "receipt 확인 불가"(REJECT)와
// "확인했고 비어있다"(진짜 첫 배달)를 가르는 4R 축이 이 파일의 모든
// ALLOW-기대 fixture에도 걸리므로, 읽을 수 있는 빈 영수증 파일 하나를
// 공유한다.
const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-head-commit-test-receipts-")),
  "dispatch-receipts.jsonl",
);
writeFileSync(SHARED_EMPTY_RECEIPT_PATH, "", "utf8");

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH,
      },
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

function freshLedger(dir) {
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });
  return ledgerPath;
}

const SHA = "60c6b5e7b7d0e010f5a20bb69764d57d636acbb3";

function writeReviewTask(dir, { extra = "" } = {}) {
  const taskPath = join(dir, "review-task.md");
  writeFileSync(
    taskPath,
    `task_id: HYK-9400-review-1\ndropped_at: 2026-08-28 23:00 KST\n${extra}${ONE_B_BLOCK}`,
    "utf8",
  );
  return taskPath;
}

function writeCoderTask(dir) {
  const taskPath = join(dir, "coder-task.md");
  writeFileSync(
    taskPath,
    `task_id: HYK-9401-coder-1\ndropped_at: 2026-08-28 23:00 KST\n${ONE_B_BLOCK}`,
    "utf8",
  );
  return taskPath;
}

// ---------------------------------------------------------------------------
// (1) 완료조건1: 표지 없는 검토 태스크 -> 배달 전 거부, 종료코드·사유
// 문자열을 실제 CLI 실행으로 숫자로 확인한다.
// ---------------------------------------------------------------------------
test("(dg-1)★ 완료조건1: head_commit 표지 없는 review-task.md -> 배달 전 REJECT, exit 1", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir);
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, `expected REJECT exit 1, stdout=${r.stdout}`);
    assert.match(r.stderr, /대상 커밋을 지정하는 'head_commit:' 표지가 없음/);
    assert.match(r.stderr, /dispatch-gate-decision: REJECT/);
  });
});

// ---------------------------------------------------------------------------
// (2) 완료조건3: 정상 경로 무회귀 -- 표지가 있는 검토 배달은 ALLOW.
// ---------------------------------------------------------------------------
test("(dg-2) 완료조건3: head_commit 표지가 있는 review-task.md -> ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir, {
      extra: `head_commit: ${SHA}\n`,
    });
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, `expected ALLOW exit 0, stderr=${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// (3) 완료조건3: CODER 배달은 이 축 밖 -- head_commit 표지가 전혀 없어도
// 영향 0(1R coder-task.md §2 범위와 동일한 CODER 제외).
// ---------------------------------------------------------------------------
test("(dg-3) 완료조건3: CODER 배달은 head_commit 축 밖 -- 표지 없어도 ALLOW, exit 0", () => {
  withFixtureDir((dir) => {
    const taskPath = writeCoderTask(dir);
    const ledgerPath = freshLedger(dir, "HYK-9401");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, `expected ALLOW exit 0, stderr=${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});

// ---------------------------------------------------------------------------
// (4) 완료조건2: fail-closed 4종.
// ---------------------------------------------------------------------------
test("(dg-4a) fail-closed(부재): head_commit 표지 자체가 없다 -> REJECT_HEAD_COMMIT_MISSING", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir);
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /대상 커밋을 지정하는 'head_commit:' 표지가 없음/);
  });
});

test("(dg-4b) fail-closed(형식 위반): head_commit 값이 39자(40-hex 아님) -> 거부", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir, {
      extra: `head_commit: ${SHA.slice(0, 39)}\n`,
    });
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /줄 시작 독립 줄이 아니거나.*40자리 hex가 아님/);
  });
});

test("(dg-4b2) fail-closed(형식 위반): head_commit이 문장 중간에 숨어 있다 -> 거부", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir, {
      extra: `note: 대상은 head_commit: ${SHA} 입니다\n`,
    });
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /줄 시작 독립 줄이 아니거나.*40자리 hex가 아님/);
  });
});

test("(dg-4c) fail-closed(다중): head_commit 표지가 2개 -> 거부", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir, {
      extra: `head_commit: ${SHA}\nhead_commit: ${SHA}\n`,
    });
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /독립 'head_commit:' 표지가 2개 있어/);
  });
});

test("(dg-4d) fail-closed(읽기 실패): extractHeadCommitFacts가 taskPath를 못 읽으면(경합 재현) -> REJECT_HEAD_COMMIT_UNREADABLE", () => {
  // 소스 코드를 직접 실행하지 않고, checkHeadCommitPrecondition 자체를
  // 단위 호출해 readOk:false 사실을 직접 넣는다(코어는 zero-import, 파일을
  // 스스로 읽지 않으므로 이 경로가 파일 I/O 경합을 만들지 않고도 정직하게
  // 검증 가능한 유일한 방법이다 -- 이 저장소의 다른 코어 시험과 동일 관례).
  return import(
    `${pathToFileURL(join(HERE, "dispatch-gate-decision-core.mjs")).href}`
  ).then(({ checkHeadCommitPrecondition }) => {
    const r = checkHeadCommitPrecondition({
      isReviewRole: true,
      readOk: false,
      readErrorReason: "EACCES: permission denied (synthetic)",
    });
    assert.equal(r.state, "REJECT_HEAD_COMMIT_UNREADABLE");
    assert.equal(r.allow, false);
    assert.match(r.reason, /읽을 수 없음/);
  });
});

// ---------------------------------------------------------------------------
// (5) 완료조건5: 대소문자 신원 -- 대문자 HEAD_COMMIT:는 이제 표지로
// 인정되지 않는다(형식 위반 근사매치로 거부, "부재"가 아니다).
// ---------------------------------------------------------------------------
test("(dg-5)★ 완료조건5: 대문자 HEAD_COMMIT:(column-0, 유효 40-hex)는 표지로 인정되지 않음 -> 거부", () => {
  withFixtureDir((dir) => {
    const taskPath = writeReviewTask(dir, {
      extra: `HEAD_COMMIT: ${SHA}\n`,
    });
    const ledgerPath = freshLedger(dir, "HYK-9400");
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(
      r.status,
      1,
      "uppercase HEAD_COMMIT: must not be accepted at delivery time either",
    );
    assert.match(r.stderr, /줄 시작 독립 줄이 아니거나.*40자리 hex가 아님/);
  });
});

// ---------------------------------------------------------------------------
// (6) 완료조건4: 되돌림 변이 -- 새 게이트 검사를 없애면 (dg-1)만 RED,
// (dg-3)(CODER 무회귀)은 어차피 이 축 밖이라 영향 없음을 함께 보인다.
// 이 저장소 기존 관례(문자열 치환 격리 사본 + assertExactlyOneMatch) 그대로.
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once (found ${count})`,
  );
}

test("(dg-6)★ 되돌림 변이: checkHeadCommitPrecondition 호출부를 제거하면 -- (dg-1) 표지 없는 REVIEW 배달이 다시 ALLOW된다(RED, 이 축이 load-bearing임을 증명)", () => {
  const src = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "        const headCommitDecision = checkHeadCommitPrecondition(\n          extractHeadCommitFacts(taskPath, deriveRoleFromTaskPath(taskPath)),\n        );\n        if (headCommitDecision) decisions.push(headCommitDecision);\n";
  assertExactlyOneMatch(src, target, "headCommitDecision call site");
  const mutated = src.replace(target, "");

  withFixtureDir((dir) => {
    const mutPath = stageScriptsCheckDir(dir, {
      "dispatch-gate-decision.mjs": mutated,
    });
    const taskDir = join(dir, "harness-fixture");
    mkdirSync(taskDir, { recursive: true });
    const taskPath = writeReviewTask(taskDir); // head_commit 표지 없음, (dg-1)과 동일 표본
    const ledgerPath = freshLedger(taskDir, "HYK-9400");
    const r = (() => {
      try {
        const stdout = execFileSync(
          "node",
          [mutPath, taskPath, "--ledger", ledgerPath],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH,
            },
          },
        );
        return { status: 0, stdout, stderr: "" };
      } catch (err) {
        return {
          status: err.status,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? "",
        };
      }
    })();
    assert.equal(
      r.status,
      0,
      `RED: with the head_commit precondition call site removed, a review-task.md with no head_commit cover wrongly ALLOWs -- proving this axis is load-bearing (stderr=${r.stderr})`,
    );
  });
});
