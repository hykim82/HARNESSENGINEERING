// HYK-387: 2026-08-29 실사고 -- ORCH가 태스크 문안을 좌석에 배달했으나
// 배정(dispatch) 기록 생성이 `agent_prompt_stalled`로 실패했다. 문안은
// 도착했고 워커는 그대로 라운드를 시작해 커밋까지 만들었다. 런타임
// 태스크는 `ready`로 남아 있었다 -- 장부에는 그 라운드가 없었다.
//
// 이 시험은 relay-handshake.mjs의 새 축(resolveDispatchRecordExistence,
// checkRelayHandshake에 결선)이 «배정 기록 존재»를 실제로 거부하는지
// 실 CLI(§5의 «실제 소비 명령», invokedDirectly 블록)를 spawn해 확인한다
// -- 헬퍼만 부르는 헛시험이 아니다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 이 워크트리 «안»의 mkdtemp
// 디렉터리에만 쓴다 -- 시스템 TEMP/TMP 환경변수는 건드리지 않는다
// (coder-task.md §0 경계 2 -- os.tmpdir() 대신 이 워크트리 루트 아래
// 직접 만든 스크래치 디렉터리를 mkdtemp의 prefix로 쓴다).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveDispatchRecordExistence,
  DISPATCH_RECORD_STATE,
} from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(dirname(HERE)); // scripts/check -> scripts -> repo root
const CLI_PATH = join(HERE, "relay-handshake.mjs");

// ⛔이 워크트리 «안»의 스크래치 루트 -- os.tmpdir()(TEMP/TMP)를 쓰지 않는다.
// `.harness/` 아래 두는 이유: 이 저장소의 .gitignore가 `.harness/` 전체를
// 무시하므로(실측: `git check-ignore .harness/coder.md` -> `.gitignore:1:
// .harness/`), 다른 시험이 동시에(병렬) 도는 동안에도 `git status
// --porcelain`가 이 스크래치 디렉터리를 «워크트리 오염»으로 절대 보지
// 않는다 -- 저장소 루트 바로 아래 새 디렉터리를 만들면 그 시험들이 병렬
// 실행 중 일시적으로 그 존재를 untracked로 잡아채 flaky하게 실패한다(실측:
// 최초 시도에서 hyk357-352-2r-cross-issue-note.test.mjs/nc-gitleaks.test.mjs/
// reject-streak-auto-record.test.mjs가 정확히 이 경합으로 깨졌다).
const SCRATCH_ROOT = join(REPO_ROOT, ".harness", "hyk387-scratch");

function withFixtureDir(prefix, fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// hyk359-ambient-env-regression.test.mjs 등 여러 시험이 "이 워크트리를
// 시험 실행 전과 정확히 같은 상태로 남긴다"를 `git status --porcelain`으로
// 단언한다 -- SCRATCH_ROOT 자신(빈 디렉터리라도)이 untracked로 남으면 그
// 단언이 깨진다. 모든 개별 fixture는 이미 각자 rmSync되지만, 스크래치
// "루트" 디렉터리 자체는 마지막에 한 번 더 지워야 완전히 원상복구된다.
after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function writeCoderRound(dir, { taskId = "HYK-387-T" } = {}) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: 2026-08-29 06:00 KST\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ 2026-08-29 06:10:00 KST\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

function validReceipt({ role = "coder", taskId = "HYK-387-T" } = {}) {
  return {
    recorded_at: "2026-08-29T06:00:30.000Z",
    runtime_task_id: "RT-1",
    dispatch_id: "DISPATCH-1",
    assignee_pane_key: "pane-1",
    dispatch_timestamp_utc: "2026-08-29T06:00:00.000Z",
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: taskId,
  };
}

// 실 CLI(생산 진입점) spawn -- checkRelayHandshake를 직접 부르는 것과
// 별개로 §5의 «실제 소비 명령»을 그대로 구동한다. DISPATCH_RECEIPT_LEDGER_PATH
// 는 이 축의 유일한 결선 지점(relay-handshake.mjs invokedDirectly 블록,
// HYK-387 헤더 참조)이라 여기서만 명시로 세팅한다 -- 다른 세 개 보호 키
// (ADMISSION_LEDGER_PATH/ADMISSION_LOCK_PATH/DISPATCH_RECEIPT_PATH)는 계속
// isolatedChildEnv가 걸러낸다(무관 축이라 건드릴 필요 없음).
function runCli(args, { ledgerPath } = {}) {
  const env = isolatedChildEnv(
    ledgerPath ? { DISPATCH_RECEIPT_LEDGER_PATH: ledgerPath } : {},
  );
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ---------------------------------------------------------------------------
// (1) 완료조건 2: 배정 기록이 없는 합성 라운드가 거부된다 -- 실 CLI, 숫자로
// (exit code != 0).
// ---------------------------------------------------------------------------
test("(hyk387-1)★ 배정 기록이 아예 없는 원장(빈 파일) -> 실 CLI exit != 0, ABSENT 사유", () => {
  withFixtureDir("absent-empty-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8"); // 원장은 있으나 항목 0건
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0, "no matching dispatch record must reject");
    assert.match(res.stderr, /DISPATCH_RECORD_ABSENT/);
    assert.match(res.stderr, /HYK-387/);
  });
});

test("(hyk387-1b) 배정 기록이 아예 없는 원장(파일 자체가 없음) -> 실 CLI exit != 0, ABSENT 사유(모른다 아니라 없다)", () => {
  withFixtureDir("absent-nofile-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "does-not-exist.jsonl"); // 한 번도 안 만들어짐
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /DISPATCH_RECORD_ABSENT/);
  });
});

test("(hyk387-1c) 원장에 다른 라운드 기록만 있음(role/taskId 불일치) -> 실 CLI exit != 0, ABSENT", () => {
  withFixtureDir("absent-mismatch-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      ledgerLine(validReceipt({ role: "coder", taskId: "HYK-999-OTHER" })),
      "utf8",
    );
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /DISPATCH_RECORD_ABSENT/);
  });
});

// ---------------------------------------------------------------------------
// (2) 완료조건 3: «조회 실패»도 통과하지 않는다 -- ABSENT와 다른 사유 문자열로.
// ---------------------------------------------------------------------------
test("(hyk387-2)★ 원장 조회 자체가 실패(경로가 디렉터리) -> 실 CLI exit != 0, LOOKUP_FAILED(ABSENT와 다른 사유)", () => {
  withFixtureDir("lookup-failed-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    mkdirSync(ledgerPath); // 파일이 아니라 디렉터리 -- readFileSync가 EISDIR로 던진다
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0, "unreadable ledger must reject, not pass");
    assert.match(res.stderr, /DISPATCH_RECORD_LOOKUP_FAILED/);
    assert.doesNotMatch(
      res.stderr,
      /DISPATCH_RECORD_ABSENT/,
      "조회 실패는 기록 없음과 다른 사유로 진단돼야 한다(같은 코드로 뭉뚱그리지 않는다)",
    );
  });
});

test("(hyk387-2b) 원장의 모든 줄이 손상된 JSON -> 실 CLI exit != 0, LOOKUP_FAILED(«없다»로 접지 않는다)", () => {
  withFixtureDir("lookup-corrupt-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "{not valid json\n{also not valid\n", "utf8");
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /DISPATCH_RECORD_LOOKUP_FAILED/);
  });
});

// ---------------------------------------------------------------------------
// (3) 완료조건 4: 위양성 0 -- 정상 라운드는 그대로 통과한다.
// ---------------------------------------------------------------------------
test("(hyk387-3)★ 배정 기록이 원장에 실제로 있는 정상 라운드 -> 실 CLI exit 0", () => {
  withFixtureDir("normal-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      ledgerLine(validReceipt({ role: "coder", taskId: "HYK-387-T" })),
      "utf8",
    );
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

test("(hyk387-3b) 이 축의 env가 아예 설정되지 않은 기존 호출(무회귀) -> 실 CLI exit 0, 이 축은 스킵된다", () => {
  withFixtureDir("normal-no-ledger-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const res = runCli(["coder", dir]); // ledgerPath 생략 -- 기존 호출자와 동일
    assert.equal(
      res.exit,
      0,
      `기존 동작 무회귀: this axis must be a no-op when unwired, got stderr: ${res.stderr}`,
    );
  });
});

// ---------------------------------------------------------------------------
// (4) 완료조건 5: 되돌림 변이 RED -- 이 축을 지우면(무력화하면) 빨간불이어야
// 한다. relay-handshake.mjs를 그대로 복제한 뒤 resolveDispatchRecordExistence
// 를 무조건 통과로 무력화하고, (1)이 거부하는 바로 그 표본에 다시 돌려
// «그 무력화가 실패를 되살린다»(=원본 시험이 진짜로 그 코드에 의존한다)를
// 증명한다.
// ---------------------------------------------------------------------------
const SIBLING_DEPS = [
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "time-authority.mjs",
];

function stageMutatedRelayHandshake(stageDir) {
  const original = readFileSync(join(HERE, "relay-handshake.mjs"), "utf8");
  const marker =
    "export function resolveDispatchRecordExistence({\n  role,\n  taskId,\n  dispatchLedgerPath,\n}) {\n  if (!dispatchLedgerPath) return { ok: true, skipped: true };";
  assert.ok(
    original.includes(marker),
    "mutation anchor text must exist verbatim in relay-handshake.mjs (되돌림 변이 anchor drifted)",
  );
  const mutated = original.replace(
    marker,
    "export function resolveDispatchRecordExistence({\n  role,\n  taskId,\n  dispatchLedgerPath,\n}) {\n  return { ok: true, skipped: true, mutated: true }; // HYK-387 되돌림 변이: 이 축을 무력화\n  if (!dispatchLedgerPath) return { ok: true, skipped: true };",
  );
  assert.notEqual(
    mutated,
    original,
    "mutation must actually change the source",
  );
  writeFileSync(join(stageDir, "relay-handshake.mjs"), mutated, "utf8");
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(stageDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
}

test("(hyk387-4)★ 되돌림 변이: 이 축을 무력화한 복제본은 (1)의 ABSENT 표본을 잘못 통과시킨다(RED)", () => {
  withFixtureDir("mutation-red-", (dir) => {
    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    stageMutatedRelayHandshake(stageDir);

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, { taskId: "HYK-387-T" });
    const ledgerPath = join(roundDir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8"); // 기록 0건 -- 원본은 반드시 거부해야 하는 표본

    const mutatedCliPath = join(stageDir, "relay-handshake.mjs");
    const env = isolatedChildEnv({
      DISPATCH_RECEIPT_LEDGER_PATH: ledgerPath,
    });
    const res = spawnSync(
      process.execPath,
      [mutatedCliPath, "coder", roundDir],
      { encoding: "utf8", env },
    );
    assert.equal(
      res.error,
      undefined,
      `spawn must succeed: ${res.error?.message}`,
    );
    assert.equal(
      res.status,
      0,
      `되돌림 변이가 이 축을 실제로 무력화했다면, 기록 0건인 라운드도 exit 0으로 «잘못» 통과해야 한다(RED). stderr: ${res.stderr}`,
    );

    // 대조: 같은 표본을 무력화하지 않은 원본 CLI로 돌리면 반드시 거부된다(GREEN).
    const original = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      original.exit,
      0,
      "원본(무력화 안 된) 축은 같은 표본을 반드시 거부해야 한다(대조군)",
    );
  });
});

// ---------------------------------------------------------------------------
// (5) 완료조건 6: 이 검사의 의존을 흔드는 변이 최소 2가지 -- 뚫리면 뚫린다고
// 정직하게 적는다.
// ---------------------------------------------------------------------------

// 변이 A: env(DISPATCH_RECEIPT_LEDGER_PATH)를 아예 세팅하지 않는다 -- 이
// 축은 «호출자가 명시로 넘긴 경로가 있을 때만» 작동한다(설계 자체의 정직
// 한계, relay-handshake.mjs의 resolveDispatchRecordExistence 헤더 원문).
// 결과: 뚫린다 -- 기록이 실제로 0건인 라운드도 env가 없으면 그대로
// 통과한다. 관제실(dispatch-worker.ps1, 이 워크트리 밖의 살아 있는 자원)이
// 이 env를 채우기 전까지는 라이브 소비 경로에서 이 축이 한 번도 발동하지
// 않는다는 뜻이다 -- Q3의 정직 한계 그대로.
test("(hyk387-5a) 변이 A(env 미설정) -- ★뚫린다: 기록 0건 라운드도 env 없이는 그대로 통과", () => {
  withFixtureDir("mutation-a-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    // ledgerPath를 만들지도, env로 넘기지도 않는다.
    const res = runCli(["coder", dir]);
    assert.equal(
      res.exit,
      0,
      "정직 기록: env가 없으면 이 축은 스킵되고 기록 0건도 통과한다(뚫린다) -- 이 축은 관제실이 env를 채워야 완성된다",
    );
  });
});

// 변이 B: «존재»만 증명하는 이 축의 설계상 한계 -- 손으로 지어낸(실제
// dispatch-receipt-cli.mjs 호출 없이 직접 작성한) 위조 원장 항목도 role+
// harness_task_label만 맞으면 그대로 «존재한다»로 통과시킨다. 이 축은
// 진위(authenticity)를 보지 않는다(그건 G1 축의 몫, coder-task.md §2
// Q1/Q2가 요구한 존재-vs-진위 구분 그대로) -- 그래서 이 변이도 뚫린다.
test("(hyk387-5b) 변이 B(위조 원장 항목) -- ★뚫린다: 손으로 지어낸 항목도 role+taskId만 맞으면 «존재»로 통과(이 축은 진위를 보지 않는다, 설계상 의도된 한계)", () => {
  withFixtureDir("mutation-b-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    // 실제 dispatch-receipt-cli.mjs를 거치지 않고 손으로 지어낸 항목 --
    // dispatch_id/assignee_pane_key가 전부 조작된 값이라도 role+
    // harness_task_label만 맞으면 매치된다.
    writeFileSync(
      ledgerPath,
      ledgerLine({
        recorded_at: "forged",
        runtime_task_id: "forged",
        dispatch_id: "forged-never-really-dispatched",
        assignee_pane_key: "forged",
        role: "coder",
        harness_task_label: "HYK-387-T",
      }),
      "utf8",
    );
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(
      res.exit,
      0,
      "정직 기록: 위조 항목도 존재 검사만으로는 통과한다(이 축의 의도된 범위 밖 -- 진위는 G1의 몫)",
    );
  });
});

// 변이 C(참고, 뚫리지 않음 -- 대조): 필드 이름을 살짝 바꾼(대소문자 변형)
// 위조는 오히려 막힌다 -- ===  엄격 비교라 "Role"/"ROLE" 같은 필드명은
// 매치되지 않고 정직하게 ABSENT로 거부된다.
test("(hyk387-5c, 대조) 필드명 대소문자를 바꾼 변이는 막힌다 -- fail-closed 쪽으로만 어긋난다(뚫리지 않음)", () => {
  withFixtureDir("mutation-c-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      ledgerLine({
        Role: "coder", // 필드명 대소문자 변형 -- 매치 대상 아님
        harness_task_label: "HYK-387-T",
      }),
      "utf8",
    );
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(
      res.exit,
      0,
      "필드명이 어긋난 위조는 안전측(거부)으로만 어긋난다 -- 통과를 만들지 않는다",
    );
  });
});

// ---------------------------------------------------------------------------
// in-process 단위 확인 -- resolveDispatchRecordExistence 자체의 세 상태
// (skip/ABSENT/LOOKUP_FAILED)를 직접 구동(§4 «프로덕션 실체를 구동» 요건 --
// CLI 레벨 시험과 별개로, export된 실제 함수 그 자체도 직접 부른다).
// ---------------------------------------------------------------------------
test("(hyk387-6) in-process: dispatchLedgerPath 생략 -> skipped:true", () => {
  const r = resolveDispatchRecordExistence({ role: "coder", taskId: "X" });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test("(hyk387-7) in-process: checkRelayHandshake에 dispatchLedgerPath를 직접 넘겨도 동일하게 거부된다", () => {
  withFixtureDir("inprocess-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8");
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      dispatchLedgerPath: ledgerPath,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, DISPATCH_RECORD_STATE.ABSENT);
  });
});
