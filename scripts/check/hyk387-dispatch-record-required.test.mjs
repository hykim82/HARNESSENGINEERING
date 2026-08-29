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
import { isolatedChildEnvWithLedger } from "./admission-ledger-env-isolation.mjs";

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

// HYK-387 2R (자체 회귀 수리, 실측): 1R은 dropped_at/DONE을 절대 달력
// 값("2026-08-29 06:00/06:10:00 KST")으로 하드코딩했다. checkRelayHandshake
// 의 authority clock은 실제 wall-clock(`Date.now()`)이고,
// isSuspectedTimezoneMislabel(time-authority.mjs)은 후보값이 "지금으로부터
// 정확히 9시간(KST_OFFSET_MS) ± 10분(TZ_MISLABEL_TOLERANCE_MS)" 안에 들면
// SUSPECTED_TZ_MISLABEL로 먼저 거부한다 -- 이 절대값은 이 라운드를 작업한
// 실제 시각대(오전 6시대 KST 기준 잡힌 값)에서 하루 중 특정 실행 시각에
// 그 9시간 창과 겹친다(직접 실측: 실행 시각 06:12 UTC(=15:12 KST) 기준
// diff = 9.21h, 창 경계까지 불과 수 분 여유 -- 재현 가능한 flaky 표본).
// 절대 날짜 대신 "지금으로부터 상대 오프셋"으로 찍어 하루 중 언제 돌아도
// 그 어떤 휴리스틱 창(미래-스큐·tz-오판 9h±10분·PENDING 30분)과도 겹치지
// 않게 한다.
function formatKst(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // KST = UTC+9, UTC 필드로 렌더링
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

// 초 단위로 내림한다 -- parseKstTimestamp는 텍스트 왕복에서 초까지만
// 보존하므로(밀리초 없음), DEFAULT_DONE_MS를 초 경계에 정렬해야 "텍스트로
// 썼다가 다시 파싱"해도 정확히 같은 ms 값으로 돌아온다(경계값 시험이
// 요구하는 정밀도).
const NOW_MS = Date.now();
const DEFAULT_DROPPED_MS = Math.floor((NOW_MS - 20 * 60 * 1000) / 1000) * 1000; // now - 20분
const DEFAULT_DONE_MS = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000; // now - 10분(dropped 뒤, now 앞)

function writeCoderRound(
  dir,
  {
    taskId = "HYK-387-T",
    doneAtMs = DEFAULT_DONE_MS,
    droppedAtMs = DEFAULT_DROPPED_MS,
  } = {},
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n\n>>> DONE: CODER @ ${formatKst(doneAtMs, {
      seconds: true,
    })}\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

// HYK-387 2R §2 (P2 시간축 수리): recorded_at 기본값은 dropped_at 30초
// 뒤(=DEFAULT_DROPPED_MS+30s) -- doneAt(now-10분)보다 한참 전인, "정상적으로
// 배정 뒤 완료 전에 기록된" 참값이다. `recordedAtMs`를 넘기면 그 값을
// ISO로 그대로 쓴다(경계값 시험 전용).
function validReceipt({
  role = "coder",
  taskId = "HYK-387-T",
  recordedAtMs = DEFAULT_DROPPED_MS + 30 * 1000,
} = {}) {
  return {
    recorded_at: new Date(recordedAtMs).toISOString(),
    runtime_task_id: "RT-1",
    dispatch_id: "DISPATCH-1",
    assignee_pane_key: "pane-1",
    dispatch_timestamp_utc: new Date(DEFAULT_DROPPED_MS).toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: taskId,
  };
}

// 실 CLI(생산 진입점) spawn -- checkRelayHandshake를 직접 부르는 것과
// 별개로 §5의 «실제 소비 명령»을 그대로 구동한다. HYK-387 2R §1:
// `DISPATCH_RECEIPT_LEDGER_PATH`는 이제 코어 함수(resolveDispatchLedgerPath)
// 자신이 읽으므로 admission-ledger-env-isolation.mjs의
// AMBIENT_LEDGER_ENV_KEYS에도 새로 추가됐다 -- 그 결과 plain
// `isolatedChildEnv({DISPATCH_RECEIPT_LEDGER_PATH: ledgerPath})`(1R 방식)는
// 이제 그 값을 스스로 걸러내 버린다(isolatedChildEnv 자신의 계약, HYK-359
// 2R P1-2). 의도적으로 이 키를 세팅하는 유일한 승인 경로인
// isolatedChildEnvWithLedger의 `dispatchReceiptLedgerPath` 필드를 쓴다.
function runCli(args, { ledgerPath } = {}) {
  const env = isolatedChildEnvWithLedger(
    ledgerPath ? { dispatchReceiptLedgerPath: ledgerPath } : {},
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
    "export function resolveDispatchRecordExistence({\n  role,\n  taskId,\n  dispatchLedgerPath,\n  doneAtMs,\n}) {\n  const ledgerPath = resolveDispatchLedgerPath(dispatchLedgerPath);\n  if (!ledgerPath) return { ok: true, skipped: true };";
  assert.ok(
    original.includes(marker),
    "mutation anchor text must exist verbatim in relay-handshake.mjs (되돌림 변이 anchor drifted)",
  );
  const mutated = original.replace(
    marker,
    "export function resolveDispatchRecordExistence({\n  role,\n  taskId,\n  dispatchLedgerPath,\n  doneAtMs,\n}) {\n  return { ok: true, skipped: true, mutated: true }; // HYK-387 되돌림 변이: 이 축을 무력화\n  const ledgerPath = resolveDispatchLedgerPath(dispatchLedgerPath);\n  if (!ledgerPath) return { ok: true, skipped: true };",
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
    const env = isolatedChildEnvWithLedger({
      dispatchReceiptLedgerPath: ledgerPath,
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

// 변이 B: «존재+시간축»만 증명하는 이 축의 설계상 한계 -- 손으로 지어낸(실제
// dispatch-receipt-cli.mjs 호출 없이 직접 작성한) 위조 원장 항목도 role+
// harness_task_label이 맞고 recorded_at이 완료 전으로 그럴듯하면 그대로
// «존재한다»로 통과시킨다. 이 축은 진위(authenticity, dispatch_id/
// assignee_pane_key가 실제 dispatch와 대응하는지)를 보지 않는다(그건 G1
// 축의 몫, HYK-390으로 분리된 P1-2) -- 그래서 이 변이도 뚫린다.
// HYK-387 2R §2 P2 추가 후 좁아진 구멍(정직 기록): recorded_at까지
// 아무렇게나("forged" 같은 파싱 불가 문자열) 지어내면 2R부터는 시간축
// 검사가 LATE로 거부한다(파싱 불가 = 근거 못 됨, fail-closed) -- 그래서 이
// 표본은 recorded_at만은 완료 전 시각으로 «그럴듯하게» 채웠다. 즉 위조자가
// 뚫으려면 이제 role+taskId+recorded_at(시간 선후) 세 가지를 맞춰야 한다
// (1R까지는 role+taskId 두 가지). dispatch_id/assignee_pane_key/
// runtime_task_id는 여전히 전혀 검증되지 않는다 -- 그 세 필드의 진위는
// 여전히 HYK-390 범위다.
test("(hyk387-5b) 변이 B(위조 원장 항목, recorded_at만 그럴듯함) -- ★뚫린다: dispatch_id/pane_key가 위조여도 role+taskId+시간선후만 맞으면 «존재»로 통과(진위는 여전히 범위 밖, HYK-390)", () => {
  withFixtureDir("mutation-b-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    // 실제 dispatch-receipt-cli.mjs를 거치지 않고 손으로 지어낸 항목 --
    // dispatch_id/assignee_pane_key가 전부 조작된 값이라도 role+
    // harness_task_label+recorded_at(완료 전)만 맞으면 매치된다.
    writeFileSync(
      ledgerPath,
      ledgerLine({
        recorded_at: "2026-08-28T21:00:30.000Z", // 완료(21:10:00Z) 전 -- 시간축은 통과
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
test("(hyk387-6) in-process: dispatchLedgerPath 생략 + env 미설정 -> skipped:true", () => {
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

// ---------------------------------------------------------------------------
// HYK-387 2R §1 (P1-1 직접 수리): «인자 없는 기본 호출»에서도 이 축이
// 발동한다 -- 검토자가 실측한 정확히 그 모양(watchResult의 실 호출은
// `checkFn({role, harnessDir})`뿐, dispatchLedgerPath 인자가 코드 어디에도
// 없다)을 그대로 재현해, env(DISPATCH_RECEIPT_LEDGER_PATH)만 세팅하고
// **코드는 손대지 않은 채** 거부되는지를 본다. withDispatchLedgerEnv는 이
// 시험 프로세스 자신의 process.env만 건드리고 항상 원상복구한다(다른
// 시험에 새는 것 방지) -- §0 "라이브 원장 무접촉"과는 별개 축(이 값 자체는
// 합성 mkdtemp 경로만 가리킨다).
// ---------------------------------------------------------------------------
function withDispatchLedgerEnv(ledgerPath, fn) {
  const prior = process.env.DISPATCH_RECEIPT_LEDGER_PATH;
  process.env.DISPATCH_RECEIPT_LEDGER_PATH = ledgerPath;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.DISPATCH_RECEIPT_LEDGER_PATH;
    else process.env.DISPATCH_RECEIPT_LEDGER_PATH = prior;
  }
}

test("(hyk387-8)★ 완료조건1: 기본 호출(checkRelayHandshake({role,harnessDir}), dispatchLedgerPath 인자 없음) + env만 설정 -> 기록 0건 라운드 거부", () => {
  withFixtureDir("default-wiring-inprocess-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8"); // 기록 0건
    const result = withDispatchLedgerEnv(ledgerPath, () =>
      // ⛔dispatchLedgerPath 인자를 절대 넘기지 않는다 -- watch-result.mjs/
      // relay-core.mjs/orca-spike-live.mjs/seat-signal-adapter.mjs가 실제로
      // 부르는 그 정확한 모양(role, harnessDir 둘뿐)이다.
      checkRelayHandshake({ role: "coder", harnessDir: dir }),
    );
    assert.equal(
      result.ok,
      false,
      "기본 호출(인자 없음)도 env만 있으면 기록 0건 라운드를 거부해야 한다",
    );
    assert.equal(result.state, DISPATCH_RECORD_STATE.ABSENT);
  });
});

// HYK-387 2R: watch-result.mjs의 실 진입점 watchResult()를 직접 구동하는
// 대응 시험은 이 파일에 두지 않는다 -- A3 인벤토리 경계(HYK-148,
// no-restricted-imports)가 scripts/check/* -> scripts/relay/* import를
// 금지한다(quality-check 실측: eslint가 이 규칙으로 막았다). 그 시험은
// scripts/relay/hyk387-watch-result-default-wiring.test.mjs로 옮겼다
// (관계 방향이 허용되는 relay -> check 쪽에 둔다) -- 완료조건1의 "검토자의
// 정확한 재현"(watchResult 자체 구동)은 거기서 계속 확인한다.

test("(hyk387-10) 무회귀: env도 dispatchLedgerPath 인자도 둘 다 없으면 기본 호출은 여전히 스킵된다(기존 호출자 바이트 단위 무회귀)", () => {
  withFixtureDir("default-wiring-noop-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    // 원장 파일조차 만들지 않는다 -- env가 정말 안 읽히면 이 축은 존재
    // 자체를 확인할 방법이 없어야 한다(스킵).
    assert.equal(process.env.DISPATCH_RECEIPT_LEDGER_PATH, undefined);
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true, `무회귀 위반: ${result.reason}`);
  });
});

// ⛔동적 import가 아니라 spawnSync(CLI)로 구동한다(hyk387-4와 동일 관용구) --
// 변조본을 별도 프로세스로 돌리면 원본 relay-handshake.mjs의 모듈 캐시/
// mkdtemp 정리 시점과 절대 얽히지 않는다(비동기 import + withFixtureDir의
// 동기 cleanup이 경합할 위험을 원천 차단).
test("(hyk387-11)★ 되돌림 변이: 기본 호출 env-fallback(resolveDispatchLedgerPath) 자체를 무력화하면 -- 인자 없는 기본 호출이 기록 0건 라운드를 다시 통과시켜버린다(RED, 새 결선 코드가 실제로 이 시험을 지탱한다는 증거)", () => {
  withFixtureDir("mutation-default-wiring-red-", (dir) => {
    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const original = readFileSync(join(HERE, "relay-handshake.mjs"), "utf8");
    const marker =
      'function resolveDispatchLedgerPath(explicit) {\n  if (explicit !== undefined) return explicit;\n  const fromEnv = process.env.DISPATCH_RECEIPT_LEDGER_PATH;\n  return typeof fromEnv === "string" && fromEnv.length > 0\n    ? fromEnv\n    : undefined;\n}';
    assert.ok(
      original.includes(marker),
      "mutation anchor text must exist verbatim in relay-handshake.mjs (되돌림 변이 anchor drifted)",
    );
    const mutated = original.replace(
      marker,
      // 2R 이전(1R) 동작으로 되돌린다: env fallback 없이 explicit만 쓴다.
      "function resolveDispatchLedgerPath(explicit) {\n  return explicit; // HYK-387 되돌림 변이: env fallback 제거\n}",
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

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, { taskId: "HYK-387-T" });
    const ledgerPath = join(roundDir, "dispatch-receipts.jsonl");
    writeFileSync(ledgerPath, "", "utf8");

    const mutatedCliPath = join(stageDir, "relay-handshake.mjs");
    // ⛔"인자 없는 기본 호출"이 가리키는 것은 dispatchLedgerPath 인자다 --
    // harnessDir는 정상적인 모든 호출자가 항상 넘기는 값이라(watch-
    // result.mjs 등도 harnessDir는 넘긴다) 여기서도 그대로 넘긴다(§0
    // "실물 원장 무접촉" 안전을 위해서도 필수 -- 생략하면 repoRoot()가
    // roundDir의 git 조상(=이 실제 저장소!)을 타고 올라가 진짜
    // `.harness/`를 가리킬 위험이 있다). dispatchLedgerPath만 env로만
    // 준다.
    const env = isolatedChildEnvWithLedger({
      dispatchReceiptLedgerPath: ledgerPath,
    });
    const mutantRes = spawnSync(
      process.execPath,
      [mutatedCliPath, "coder", roundDir],
      { encoding: "utf8", env },
    );
    assert.equal(
      mutantRes.error,
      undefined,
      `spawn must succeed: ${mutantRes.error?.message}`,
    );
    assert.equal(
      mutantRes.status,
      0,
      `되돌림 변이가 env-fallback을 실제로 제거했다면, 인자 없는 기본 호출은 기록 0건 라운드도 «잘못» 통과해야 한다(RED). stderr: ${mutantRes.stderr}`,
    );

    // 대조: 무력화 안 된 원본 CLI는 같은 표본을 반드시 거부한다(GREEN).
    const originalRes = spawnSync(
      process.execPath,
      [CLI_PATH, "coder", roundDir],
      { encoding: "utf8", env },
    );
    assert.notEqual(
      originalRes.status,
      0,
      "원본(무력화 안 된) env-fallback은 같은 표본을 반드시 거부해야 한다(대조군)",
    );
  });
});

// ---------------------------------------------------------------------------
// HYK-387 2R §2 (P2 승격, 검토자 P2-ⓑ): 시간축 -- 완료 시각 «뒤»에 기록된
// 항목은 근거가 되지 않는다. 경계값(같은 밀리초·±1ms·±1s·역방향 스큐)까지
// 명시로 시험한다(coder-task.md 완료조건 3).
// ---------------------------------------------------------------------------
function timingCase(recordedAtMs) {
  return withFixtureDir("timing-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      ledgerLine(validReceipt({ taskId: "HYK-387-T", recordedAtMs })),
      "utf8",
    );
    return runCli(["coder", dir], { ledgerPath });
  });
}

test("(hyk387-12)★ 경계값: recorded_at이 완료시각과 정확히 같은 밀리초 -> LATE로 거부(동률은 '그 전'으로 인정하지 않는다, fail-closed 설계 결정)", () => {
  const res = timingCase(DEFAULT_DONE_MS);
  assert.notEqual(res.exit, 0);
  assert.match(res.stderr, /DISPATCH_RECORD_LATE/);
});

test("(hyk387-13) 경계값: recorded_at이 완료시각보다 1ms 이전 -> 통과(exit 0)", () => {
  const res = timingCase(DEFAULT_DONE_MS - 1);
  assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
});

test("(hyk387-14) 경계값: recorded_at이 완료시각보다 1ms 이후 -> LATE로 거부", () => {
  const res = timingCase(DEFAULT_DONE_MS + 1);
  assert.notEqual(res.exit, 0);
  assert.match(res.stderr, /DISPATCH_RECORD_LATE/);
});

test("(hyk387-15) 경계값: recorded_at이 완료시각보다 1초 이전 -> 통과(exit 0, 위양성 0)", () => {
  const res = timingCase(DEFAULT_DONE_MS - 1000);
  assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
});

test("(hyk387-16) 경계값: recorded_at이 완료시각보다 1초 이후 -> LATE로 거부", () => {
  const res = timingCase(DEFAULT_DONE_MS + 1000);
  assert.notEqual(res.exit, 0);
  assert.match(res.stderr, /DISPATCH_RECORD_LATE/);
});

// 역방향 시계 스큐: 실제로는 dispatch(→기록)가 완료보다 먼저 일어났더라도,
// 기록 기계의 시계가 완료 기계보다 (여기서는) 10분 앞서가면 recorded_at
// 숫자가 doneAt보다 «뒤»로 관측된다 -- 이 축은 이 두 경우를 원리적으로
// 구별할 수 없다(검토자 원문 "시간 선후는 진위의 값싼 대용"). 애매하면
// 거부(오탐보다 오인식 방지 우선)를 그대로 보여준다 -- ★정직 한계로
// §6 보고에 명시.
test("(hyk387-17)★ 역방향 시계 스큐: 기록 기계 시계가 10분 앞서가 실제로는 먼저였을 recorded_at이 doneAt '뒤'로 관측됨 -> LATE로 거부(정직 한계: 이 축은 스큐와 진짜 지연을 구별 못 한다)", () => {
  const skewedRecordedAtMs = DEFAULT_DONE_MS + 10 * 60 * 1000; // +10분
  const res = timingCase(skewedRecordedAtMs);
  assert.notEqual(
    res.exit,
    0,
    "스큐로 인한 오탐도 이 설계의 알려진 한계다 -- 애매하면 거부 쪽으로 접는다",
  );
  assert.match(res.stderr, /DISPATCH_RECORD_LATE/);
});

test("(hyk387-18) 위양성 0(재확인): 정확한 시간 선후(배정이 완료보다 한참 전) -> exit 0", () => {
  const res = timingCase(DEFAULT_DONE_MS - 9 * 60 * 1000); // 완료 9분 전
  assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
});

// ---------------------------------------------------------------------------
// HYK-387 2R §3 (P2 관찰 담기): ⓐ role 대소문자 정규화 · ⓒ 부분 손상 뒤
// matching line
// ---------------------------------------------------------------------------
test("(hyk387-19)★ P2ⓐ 담음: 소문자 호출 role='coder' + 원장엔 대문자 'CODER'로 기록 -> 대소문자 무시 매치로 통과(1R까지는 exact-equality라 여기서 false rejection이었다)", () => {
  withFixtureDir("case-insensitive-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(
      ledgerPath,
      ledgerLine(validReceipt({ role: "CODER", taskId: "HYK-387-T" })),
      "utf8",
    );
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(
      res.exit,
      0,
      `role 대소문자 정규화가 적용되지 않았다: ${res.stderr}`,
    );
  });
});

test("(hyk387-20)★ P2ⓒ 담음: 손상된 JSON 줄들 뒤에 matching line -> 부분 손상은 막지 않는다(ABSENT/LOOKUP_FAILED 어느 쪽도 아님, exit 0) + 손상 사실은 stderr에 남는다", () => {
  withFixtureDir("partial-corruption-", (dir) => {
    writeCoderRound(dir, { taskId: "HYK-387-T" });
    const ledgerPath = join(dir, "dispatch-receipts.jsonl");
    const validLine = ledgerLine(
      validReceipt({ taskId: "HYK-387-T" }),
    ).trimEnd();
    writeFileSync(
      ledgerPath,
      `{not valid json\n{also not valid\n${validLine}\n`,
      "utf8",
    );
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(
      res.exit,
      0,
      `부분 손상 뒤 matching line이 막히면 안 된다: ${res.stderr}`,
    );
    assert.match(
      res.stderr,
      /corrupted line/,
      "부분 손상 사실 자체는 조용히 삼켜지지 않고 stderr로 남아야 한다(감사 가능성)",
    );
  });
});
