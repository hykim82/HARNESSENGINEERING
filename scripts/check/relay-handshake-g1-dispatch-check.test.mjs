// HYK-434: worker-dispatch-rule.md §1이 요구하는 "결과 파일 맨 위 3줄"
// (dispatch_verified:/task_id_from_dispatch:/pane_match:)을 relay-
// handshake.mjs가 실제로 배달 영수증 원장(dispatch-receipts.jsonl)과
// 기계로 대조하는지 확인한다(resolveG1DispatchVerificationVerdict,
// checkRelayHandshake에 결선). 2026-08-25 HYK-357 inject-3 실물(ORCH-99
// 인계서 ⓕ-3) -- G1 3줄이 빠진 결과 파일도 소비가 통과했다 -- 가 이
// 축의 재현 대상이다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 SCRATCH_ROOT(os.tmpdir() 아래,
// 이 워크트리 밖) 아래 mkdtemp 디렉터리에만 쓴다 -- hyk387-dispatch-
// record-required.test.mjs와 동일한 관용구(coder-task.md §0 경계 2).
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
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveG1DispatchVerificationVerdict,
} from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

const SCRATCH_ROOT = join(tmpdir(), "hyk434-scratch");

function withFixtureDir(prefix, fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

// hyk387-dispatch-record-required.test.mjs와 동일한 상대-오프셋 관용구
// (절대 달력값은 미래-스큐/tz-오판 휴리스틱 창과 우연히 겹칠 수 있다,
// 그 파일 헤더 "HYK-387 2R (자체 회귀 수리, 실측)" 참조).
function formatKst(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // KST = UTC+9, UTC 필드로 렌더링
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

const NOW_MS = Date.now();
const DEFAULT_DROPPED_MS = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000; // now - 30분
const DEFAULT_DONE_MS = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000; // now - 10분
// 원장 기록은 dropped_at과 doneAt 사이(=정상적으로 "배정 뒤 완료 전")에
// 둔다 -- HYK-387 LATE 축(recorded_at < doneAtMs)과 우연히 충돌하지 않게.
const DEFAULT_RECORDED_AT_MS = DEFAULT_DROPPED_MS + 60 * 1000; // dropped 1분 뒤

const RUNTIME_TASK_ID = "task_aaaaaaaaaaaa";
const PANE_KEY =
  "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";

function g1Block({
  dispatchVerified = "yes",
  taskIdFromDispatch = RUNTIME_TASK_ID,
  paneLeft = PANE_KEY,
  paneRight = PANE_KEY,
  paneVerdict = "일치",
} = {}) {
  return `dispatch_verified: ${dispatchVerified}\ntask_id_from_dispatch: ${taskIdFromDispatch}\npane_match: ${paneLeft} == ${paneRight} ? ${paneVerdict}\n`;
}

function writeCoderRound(
  dir,
  {
    taskId = "HYK-434-T",
    doneAtMs = DEFAULT_DONE_MS,
    droppedAtMs = DEFAULT_DROPPED_MS,
    g1 = g1Block(),
    extra = "",
  } = {},
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${g1}${extra}\n>>> DONE: CODER @ ${formatKst(
      doneAtMs,
      {
        seconds: true,
      },
    )}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function writeBlockedCoderRound(
  dir,
  {
    taskId = "HYK-434-T",
    droppedAtMs = DEFAULT_DROPPED_MS,
    reason = "git worktree unreachable",
    g1 = "",
  } = {},
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${g1}\n>>> BLOCKED: ${reason}\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

function validReceipt({
  role = "coder",
  taskId = "HYK-434-T",
  recordedAtMs = DEFAULT_RECORDED_AT_MS,
  runtimeTaskId = RUNTIME_TASK_ID,
  paneKey = PANE_KEY,
} = {}) {
  return {
    recorded_at: new Date(recordedAtMs).toISOString(),
    runtime_task_id: runtimeTaskId,
    dispatch_id: "ctx_1",
    assignee_pane_key: paneKey,
    dispatch_timestamp_utc: new Date(DEFAULT_DROPPED_MS).toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: taskId,
  };
}

// hyk387-dispatch-record-required.test.mjs와 동일한 관용구: args[1]이
// harnessDir(모든 호출부가 `runCli(["coder", dir], ...)` 모양)이므로,
// ledgerPath가 주어지면 그 디렉터리 안에 포인터 파일을 직접 쓴다.
function runCli(args, { ledgerPath } = {}) {
  if (ledgerPath) {
    writeFileSync(
      join(args[1], "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );
  }
  const env = isolatedChildEnv({});
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

function withLedger(dir, records) {
  const ledgerPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(ledgerPath, records.map((r) => ledgerLine(r)).join(""), "utf8");
  return ledgerPath;
}

// ---------------------------------------------------------------------------
// ⓐ 정상 경로: 3줄이 원장과 정확히 일치 -> 소비 성공(exit 0).
// ---------------------------------------------------------------------------
test("(g1-a)★ 정상 경로: dispatch_verified/task_id_from_dispatch/pane_match 3줄이 원장과 일치 -> 실 CLI exit 0", () => {
  withFixtureDir("g1-normal-", (dir) => {
    writeCoderRound(dir);
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// ⓑ task_id_from_dispatch가 앞 배달(재배달 전)의 runtime id -- 거부 + 사유에
// 줄 이름·기대값·실제값.
// ---------------------------------------------------------------------------
test("(g1-b)★ 위조: task_id_from_dispatch가 앞 라운드의 runtime id -> 거부, 사유에 줄 이름·기대·실제가 모두 찍힌다", () => {
  withFixtureDir("g1-stale-taskid-", (dir) => {
    const staleRuntimeId = "task_bbbbbbbbbbbb";
    writeCoderRound(dir, {
      g1: g1Block({ taskIdFromDispatch: staleRuntimeId }), // 앞 라운드 값을 그대로 가져옴
    });
    const ledgerPath = withLedger(dir, [validReceipt()]); // 원장의 진짜 값은 RUNTIME_TASK_ID
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /G1 cross-check failed \(HYK-434\)/);
    assert.match(res.stderr, /'task_id_from_dispatch:' line value mismatch/);
    assert.match(res.stderr, new RegExp(`expected '${RUNTIME_TASK_ID}'`));
    assert.match(res.stderr, new RegExp(`found '${staleRuntimeId}'`));
  });
});

// ---------------------------------------------------------------------------
// ⓒ 3줄 전부 부재 -> 거부(missing).
// ---------------------------------------------------------------------------
test("(g1-c)★ 3줄 전부 부재 -> 거부(missing, HYK-434)", () => {
  withFixtureDir("g1-all-missing-", (dir) => {
    writeCoderRound(dir, { g1: "" });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /G1 cross-check failed \(HYK-434\)/);
    assert.match(res.stderr, /missing \(no standalone column-0 line found/);
  });
});

// ---------------------------------------------------------------------------
// ⓓ dispatch_verified: no -> 거부.
// ---------------------------------------------------------------------------
test("(g1-d)★ dispatch_verified: no -> 거부(값 자체가 통과 조건을 만족하지 않는다)", () => {
  withFixtureDir("g1-not-verified-", (dir) => {
    writeCoderRound(dir, { g1: g1Block({ dispatchVerified: "no" }) });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'dispatch_verified:' line value mismatch/);
    assert.match(res.stderr, /expected 'yes', found 'no'/);
  });
});

// ---------------------------------------------------------------------------
// ⓔ pane_match의 키가 영수증과 다름 -> 거부.
// ---------------------------------------------------------------------------
test("(g1-e)★ pane_match 줄의 키가 원장의 assignee_pane_key와 다르다 -> 거부", () => {
  withFixtureDir("g1-pane-mismatch-", (dir) => {
    const wrongPane =
      "99999999-9999-9999-9999-999999999999:88888888-8888-8888-8888-888888888888";
    writeCoderRound(dir, {
      g1: g1Block({ paneLeft: wrongPane, paneRight: wrongPane }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line mismatch/);
    assert.match(res.stderr, new RegExp(`equal '${PANE_KEY}'`));
  });
});

test("(g1-e2) pane_match 줄 자신이 '불일치'로 끝난다 -> 거부(값이 정직해도 불일치면 통과시키지 않는다)", () => {
  withFixtureDir("g1-pane-disagree-", (dir) => {
    writeCoderRound(dir, {
      g1: g1Block({ paneVerdict: "불일치" }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line mismatch/);
  });
});

// ---------------------------------------------------------------------------
// ⓕ 재배달 2건 -- 마지막 배달(recorded_at 최신) 기준으로 대조한다.
// ---------------------------------------------------------------------------
test("(g1-f)★ 재배달 2건: 결과가 «최신» 배달 값을 쓰면 통과, «이전» 배달 값을 쓰면 거부(가장 최근 것이 기준)", () => {
  withFixtureDir("g1-redispatch-", (dir) => {
    const oldRuntimeId = "task_cccccccccccc";
    const oldPane =
      "33333333-3333-3333-3333-333333333333:44444444-4444-4444-4444-444444444444";
    const oldRecordedAtMs = DEFAULT_DROPPED_MS + 10 * 1000;
    const newRecordedAtMs = DEFAULT_DROPPED_MS + 20 * 1000;
    const ledgerPath = withLedger(dir, [
      validReceipt({
        recordedAtMs: oldRecordedAtMs,
        runtimeTaskId: oldRuntimeId,
        paneKey: oldPane,
      }),
      validReceipt({
        recordedAtMs: newRecordedAtMs,
        runtimeTaskId: RUNTIME_TASK_ID,
        paneKey: PANE_KEY,
      }),
    ]);

    // 최신 배달 값 -> 통과.
    writeCoderRound(dir, { g1: g1Block() });
    const passRes = runCli(["coder", dir], { ledgerPath });
    assert.equal(passRes.exit, 0, `stderr: ${passRes.stderr}`);

    // 이전 배달 값 -> 거부(더 이상 기준이 아니다).
    writeCoderRound(dir, {
      g1: g1Block({
        taskIdFromDispatch: oldRuntimeId,
        paneLeft: oldPane,
        paneRight: oldPane,
      }),
    });
    const failRes = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(failRes.exit, 0);
    assert.match(
      failRes.stderr,
      /'task_id_from_dispatch:' line value mismatch/,
    );
  });
});

// ---------------------------------------------------------------------------
// ⓖ 펜스 코드블록 «안»에만 3줄이 있다 -> 인용으로 마스킹되어 부재로 거부.
// ---------------------------------------------------------------------------
test("(g1-g)★ G1 3줄이 펜스 코드블록 안에만 인용돼 있다 -> 마스킹되어 부재로 거부(HYK-449/HYK-450과 같은 함정)", () => {
  withFixtureDir("g1-fenced-", (dir) => {
    const fenced = "```\n" + g1Block() + "```\n";
    writeCoderRound(dir, { g1: "", extra: fenced });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing \(no standalone column-0 line found/);
  });
});

// ---------------------------------------------------------------------------
// ⓗ 인용 밖 중복 -- 같은 키가 2번 이상 -> 모호 거부(조용히 하나를 고르지
// 않는다, HYK-486 선례).
// ---------------------------------------------------------------------------
test("(g1-h)★ AMBIGUOUS: 인용 밖에 'dispatch_verified:' 줄이 2개 -> 거부, 어느 것이 최종인지 결정할 수 없다", () => {
  withFixtureDir("g1-ambiguous-", (dir) => {
    writeCoderRound(dir, {
      g1:
        "dispatch_verified: yes\ndispatch_verified: yes\n" +
        `task_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /ambiguous, cannot resolve, HYK-434/);
  });
});

// ---------------------------------------------------------------------------
// ⓘ 어댑터 A -- 원장 포인터가 없다(사람 `go`, 이 라운드의 배달 기록이
// 원리상 없음) -> G1 대조를 건너뛴다, 건너뛴 사실이 출력에 한 줄로
// 보여야 한다(침묵 0).
// ---------------------------------------------------------------------------
test("(g1-i)★ 어댑터 A(원장 포인터 없음): G1 대조를 건너뛰고 그대로 소비 성공 + 건너뛴 사실이 stderr에 한 줄로 찍힌다(침묵 0)", () => {
  withFixtureDir("g1-adapter-a-", (dir) => {
    // ⛔G1 3줄을 아예 쓰지 않는다 -- 어댑터 A는 그 부재조차 보지 않는다는
    // 것을 보이기 위해서다.
    writeCoderRound(dir, { g1: "" });
    // ledgerPath/포인터 파일 둘 다 만들지 않는다.
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
    assert.match(
      res.stderr,
      /G1 dispatch-ledger cross-check skipped \(어댑터 A/,
      "건너뛴 사실이 한 줄로 보여야 한다(침묵 0)",
    );
  });
});

// ---------------------------------------------------------------------------
// ⓙ 범위 확인: BLOCKED 표지 라운드는 G1 부재여도 기존대로 소비된다(무회귀).
// G1 축은 DONE 소비에만 결선된다 -- BLOCKED는 이 축에 닿기 전에 이미
// 빠져나간다(resolveHandshakeCore).
// ---------------------------------------------------------------------------
test("(g1-j)★ 범위 확인: G1 3줄이 전혀 없는 BLOCKED 라운드도 BLOCKED 사유로(G1 사유 아님) 그대로 처리된다(무회귀, 레인 잠금 방지)", () => {
  withFixtureDir("g1-blocked-scope-", (dir) => {
    writeBlockedCoderRound(dir, { reason: "git worktree unreachable" });
    // 원장조차 만들지 않는다 -- BLOCKED 라운드는 이 축에 닿지 않으므로
    // 영향이 없어야 한다.
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(result.reason, /git worktree unreachable/);
    assert.doesNotMatch(result.reason, /G1 cross-check/);
  });
});

test("(g1-j2) 범위 확인: BLOCKED 라운드 + 원장이 실제로 있어도(기록 0건) G1/dispatchRecord 축 어느 쪽도 닿지 않는다", () => {
  withFixtureDir("g1-blocked-with-ledger-", (dir) => {
    writeBlockedCoderRound(dir, { reason: "awaiting input" });
    const ledgerPath = withLedger(dir, []); // 기록 0건
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /awaiting input/);
    assert.doesNotMatch(res.stderr, /DISPATCH_RECORD_ABSENT/);
    assert.doesNotMatch(res.stderr, /G1 cross-check/);
  });
});

// ---------------------------------------------------------------------------
// in-process 단위 확인 -- resolveG1DispatchVerificationVerdict 자체를
// 직접 구동한다(§4 "프로덕션 실체를 구동" 요건 -- CLI 레벨 시험과 별개로
// export된 실제 함수 그 자체도 직접 부른다).
// ---------------------------------------------------------------------------
test("(g1-k) in-process: dispatchRecordVerdict.skipped=true -> {ok:true, skipped:true}, G1 내용은 전혀 읽지 않는다", () => {
  const r = resolveG1DispatchVerificationVerdict({
    resultContent: "",
    dispatchRecordVerdict: { ok: true, skipped: true },
  });
  assert.deepEqual(r, { ok: true, skipped: true });
});

test("(g1-l) in-process: matchRecords가 정상 값일 때 정상 3줄 -> ok:true", () => {
  const r = resolveG1DispatchVerificationVerdict({
    resultContent: g1Block(),
    dispatchRecordVerdict: {
      ok: true,
      matches: 1,
      matchRecords: [validReceipt()],
    },
  });
  assert.equal(r.ok, true, r.reason);
});

// ---------------------------------------------------------------------------
// 되돌림 변이 G1~G5(coder-task.md §2-8) -- 소스를 문자열 치환해 격리
// 사본을 만들고 실 CLI(spawnSync)로 구동한다(hyk387-dispatch-record-
// required.test.mjs의 stageMutatedRelayHandshake와 동일 관용구 --
// invokedDirectly 게이트가 경로 suffix "scripts/check/relay-handshake.mjs"
// 매치만 보므로, 변조본도 그 중첩 구조를 재현해야 한다).
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageMutatedRelayHandshake(stageDir, mutateFn) {
  const nestedDir = join(stageDir, "scripts", "check");
  mkdirSync(nestedDir, { recursive: true });
  const original = readFileSync(CLI_PATH, "utf8");
  const mutated = mutateFn(original);
  assert.notEqual(
    mutated,
    original,
    "mutation must actually change the source",
  );
  writeFileSync(join(nestedDir, "relay-handshake.mjs"), mutated, "utf8");
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(nestedDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  return join(nestedDir, "relay-handshake.mjs");
}

function runMutatedCli(mutatedCliPath, args) {
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [mutatedCliPath, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// G1: G1 대조 호출 자체를 제거한다 -> (g1-b)/(g1-c) 표본이 다시 통과한다(RED).
test("(g1-mut-1)★ 되돌림 변이 G1: checkRelayHandshake의 G1 호출 자체를 제거하면 -- (g1-c) 3줄 전부 부재 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mut1-", (dir) => {
    const target =
      "  const g1Verdict = resolveG1DispatchVerificationVerdict({\n    resultContent: judgedRegion,\n    dispatchRecordVerdict,\n  });\n  if (!g1Verdict.ok) return g1Verdict;\n\n";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "G1 call site");

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, ""),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, { g1: "" }); // (g1-c) 표본: 3줄 전부 부재
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: G1 호출이 제거되면 3줄 부재 표본도 잘못 통과해야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본(무력화 안 됨)은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// G2: "최신 배달" 대신 "첫 배달"(가장 이른 recorded_at) 기준으로 바꾼다
// -> (g1-f)의 재배달 표본이 RED(이전 배달 값으로도 통과한다).
test("(g1-mut-2)★ 되돌림 변이 G2: 최신 배달 대신 첫 배달 기준으로 바꾸면 -- (g1-f)의 «이전 배달 값» 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mut2-", (dir) => {
    const target =
      "function resolveLatestDispatchRecord(records) {\n  return records.reduce((best, r) => {\n    const t = Date.parse(r?.recorded_at);\n    if (!Number.isFinite(t)) return best;\n    const bestT = best ? Date.parse(best.recorded_at) : -Infinity;\n    return t > bestT ? r : best;\n  }, null);\n}";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "latest-record reduce");
    const mutated_target_replacement =
      "function resolveLatestDispatchRecord(records) {\n  return records.reduce((best, r) => {\n    const t = Date.parse(r?.recorded_at);\n    if (!Number.isFinite(t)) return best;\n    const bestT = best ? Date.parse(best.recorded_at) : Infinity;\n    return t < bestT ? r : best; // HYK-434 되돌림 변이 G2: 최신 대신 가장 이른 레코드를 고른다\n  }, null);\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, mutated_target_replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const oldRuntimeId = "task_cccccccccccc";
    const oldPane =
      "33333333-3333-3333-3333-333333333333:44444444-4444-4444-4444-444444444444";
    const oldRecordedAtMs = DEFAULT_DROPPED_MS + 10 * 1000;
    const newRecordedAtMs = DEFAULT_DROPPED_MS + 20 * 1000;
    const ledgerPath = withLedger(roundDir, [
      validReceipt({
        recordedAtMs: oldRecordedAtMs,
        runtimeTaskId: oldRuntimeId,
        paneKey: oldPane,
      }),
      validReceipt({
        recordedAtMs: newRecordedAtMs,
        runtimeTaskId: RUNTIME_TASK_ID,
        paneKey: PANE_KEY,
      }),
    ]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );
    // 결과는 '이전 배달' 값을 쓴다 -- 원본이면 거부되는 표본.
    writeCoderRound(roundDir, {
      g1: g1Block({
        taskIdFromDispatch: oldRuntimeId,
        paneLeft: oldPane,
        paneRight: oldPane,
      }),
    });

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 첫 배달 기준이면 이전 배달 값도 통과해야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// G3: 마스킹(maskQuotedMarkerRegions)을 제거해 원문 텍스트에서 직접 줄을
// 판독하게 바꾼다 -> (g1-g) 펜스 인용 표본이 RED(펜스 안 인용도 표지로
// 오인해 통과한다).
test("(g1-mut-3)★ 되돌림 변이 G3: 마스킹을 제거하고 원문에서 직접 판독하면 -- (g1-g)의 펜스-인용 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mut3-", (dir) => {
    const target =
      "function resolveG1StandaloneLine(content, { reGlobal, reAnywhere, label }) {\n  const scan = maskQuotedMarkerRegions(content);";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "resolveG1StandaloneLine masking");
    const replacement =
      "function resolveG1StandaloneLine(content, { reGlobal, reAnywhere, label }) {\n  const scan = content; // HYK-434 되돌림 변이 G3: 마스킹 제거";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    const fenced = "```\n" + g1Block() + "```\n";
    writeCoderRound(roundDir, { g1: "", extra: fenced });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 마스킹이 없으면 펜스 안 인용도 표지로 통과해야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});

// G4: 어댑터 A 분기(skipped)를 거부로 바꾼다 -> (g1-i) 표본이 RED(포인터
// 없는 정상 라운드가 거부당한다 -- 과차단).
test("(g1-mut-4)★ 되돌림 변이 G4: 어댑터 A의 skip을 거부로 바꾸면 -- (g1-i)의 포인터-없음 정상 라운드가 거부당한다(RED, 과차단)", () => {
  withFixtureDir("g1-mut4-", (dir) => {
    const target =
      "  if (dispatchRecordVerdict.skipped) {\n    console.error(\n      \"relay-handshake: G1 dispatch-ledger cross-check skipped (어댑터 A -- this round has no dispatch-receipt ledger pointer, HYK-434) -- 'dispatch_verified:'/'task_id_from_dispatch:'/'pane_match:' header lines are NOT cross-checked against the ledger for this round\",\n    );\n    return { ok: true, skipped: true };\n  }";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "adapter-A skip branch");
    const replacement =
      '  if (dispatchRecordVerdict.skipped) {\n    return { ok: false, reason: "HYK-434 되돌림 변이 G4: 어댑터 A를 거부로 바꿈" };\n  }';

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, { g1: "" }); // 어댑터 A -- 포인터 자체가 없다
    // ledgerPath/포인터 파일 둘 다 만들지 않는다(= 어댑터 A).

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      "RED 필수: skip이 거부로 바뀌면 포인터 없는 정상 라운드도 잘못 거부당해야 한다",
    );

    const originalRes = runCli(["coder", roundDir]);
    assert.equal(
      originalRes.exit,
      0,
      `원본은 같은 표본을 통과시킨다(대조군). stderr: ${originalRes.stderr}`,
    );
  });
});

// G5: DONE 한정 조건을 제거한다(BLOCKED에도 적용) -- returnDoneResolvedVerdict가
// BLOCKED/NEEDS_INPUT 상태에서도 G1 대조를 돌려, 실패하면 그 결과를
// doneResolved 대신 반환하도록 바꾼다 -> (g1-j) 표본이 RED(G1 3줄이 없는
// BLOCKED 라운드가 BLOCKED 사유 대신 G1 사유로 거부된다 -- 레인 잠금 위험
// 형태의 회귀).
test("(g1-mut-5)★ 되돌림 변이 G5: DONE 한정 조건을 제거해 BLOCKED에도 G1 대조를 적용하면 -- (g1-j)의 BLOCKED 표본이 BLOCKED 사유 대신 G1 사유로 거부된다(RED)", () => {
  withFixtureDir("g1-mut5-", (dir) => {
    const target =
      "function returnDoneResolvedVerdict({\n  doneResolved,\n  role,\n  harnessDir,\n  taskId,\n  taskContent,\n  resultContent,\n  droppedMatch,\n  dispatchId,\n  resultPath,\n  now,\n}) {\n  runBlockedTerminationSideEffectsIfApplicable({\n    state: doneResolved.state,\n    role,\n    harnessDir,\n    taskId,\n    taskContent,\n    resultContent,\n    droppedMatch,\n    dispatchId,\n    resultPath,\n    now,\n  });\n  return doneResolved;\n}";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "returnDoneResolvedVerdict body");
    const replacement =
      "function returnDoneResolvedVerdict({\n  doneResolved,\n  role,\n  harnessDir,\n  taskId,\n  taskContent,\n  resultContent,\n  droppedMatch,\n  dispatchId,\n  resultPath,\n  now,\n}) {\n  runBlockedTerminationSideEffectsIfApplicable({\n    state: doneResolved.state,\n    role,\n    harnessDir,\n    taskId,\n    taskContent,\n    resultContent,\n    droppedMatch,\n    dispatchId,\n    resultPath,\n    now,\n  });\n  // HYK-434 되돌림 변이 G5: DONE 한정 조건 제거 -- BLOCKED/NEEDS_INPUT에도 G1을 적용한다.\n  if (doneResolved.state === 'BLOCKED' || doneResolved.state === 'NEEDS_INPUT') {\n    const forcedG1 = resolveG1DispatchVerificationVerdict({\n      resultContent,\n      dispatchRecordVerdict: resolveDispatchRecordExistence({ role, taskId, harnessDir }),\n    });\n    if (!forcedG1.ok) return forcedG1;\n  }\n  return doneResolved;\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeBlockedCoderRound(roundDir, { reason: "git worktree unreachable" }); // G1 3줄 없음
    const ledgerPath = withLedger(roundDir, [validReceipt()]); // 포인터가 있으므로 어댑터 A가 아니다
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(mutRes.exit, 0);
    assert.match(
      mutRes.stderr,
      /G1 cross-check failed/,
      "RED 필수: BLOCKED 사유 대신 G1 사유로 거부돼야 한다(현재는 이렇게 되지 않는다는 것이 (g1-j))",
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(originalRes.exit, 0);
    assert.match(originalRes.stderr, /git worktree unreachable/);
    assert.doesNotMatch(
      originalRes.stderr,
      /G1 cross-check/,
      "원본은 BLOCKED 사유만 내야 한다(대조군, (g1-j)와 동일 불변식)",
    );
  });
});

// ===========================================================================
// HYK-434 2R(coder-task.md §2 요구 7) -- 책임자 축 ⓐ "형식→값 대조 좁히기".
// 아래부터는 값이 원장과 완전히 같은데 «줄 모양»만 다른 표본들이 실 CLI로
// 소비(exit 0)되는지를 직접 구동한다(1R 검토 ⓐ-2 표의 26종, 책임자 축
// ⓐ~ⓕ 범주 23종 + 덧 3종 = 26). 표 한 줄 = 칸 하나(프로덕션 export인
// checkRelayHandshake를 CLI로 직접 구동 -- 헛시험 1형태 아님).
// ===========================================================================
// (라벨, g1 3줄 생성기) -- 전부 값은 원장(RUNTIME_TASK_ID/PANE_KEY)과 같다.
const FORMAT_ONLY_VARIANTS = [
  [
    "ⓐ 줄 앞 공백(dispatch_verified)",
    () =>
      ` dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓐ 줄 앞 공백(pane_match)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n pane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓑ tid 백틱",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: \`${RUNTIME_TASK_ID}\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓑ tid 큰따옴표",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: "${RUNTIME_TASK_ID}"\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓑ pane 백틱",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: \`${PANE_KEY}\` == \`${PANE_KEY}\` ? 일치\n`,
  ],
  [
    "ⓑ dispatch_verified 백틱",
    () =>
      `dispatch_verified: \`yes\`\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓒ Yes",
    () =>
      `dispatch_verified: Yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓒ YES",
    () =>
      `dispatch_verified: YES\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓒ pane 대문자",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY.toUpperCase()} == ${PANE_KEY.toUpperCase()} ? 일치\n`,
  ],
  [
    "ⓒ tid 대문자",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID.toUpperCase()}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 구분자 =",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} = ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 구분자 ===",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} === ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 구분자 ->",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} -> ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓓ 전각 ？",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ？ 일치\n`,
  ],
  [
    "ⓓ `?` 없음(아카이브 모양, 실라운드 공유)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} 일치\n`,
  ],
  [
    "ⓔ 끝낱말 생략(`?` 있음)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ?\n`,
  ],
  [
    "ⓔ 끝낱말 생략(`?` 없음)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY}\n`,
  ],
  [
    "ⓔ 일치함",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치함\n`,
  ],
  [
    "ⓔ match",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? match\n`,
  ],
  [
    "ⓔ (일치)",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? (일치)\n`,
  ],
  [
    "ⓕ 키 대소문자 Dispatch_Verified",
    () =>
      `Dispatch_Verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓕ 키 대소문자 TASK_ID_FROM_DISPATCH",
    () =>
      `dispatch_verified: yes\nTASK_ID_FROM_DISPATCH: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "ⓕ 키 대소문자 Pane_Match",
    () =>
      `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\nPane_Match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "덧 굵게(**dispatch_verified:**)",
    () =>
      `**dispatch_verified:** yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "덧 목록 기호(- )",
    () =>
      `- dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
  [
    "덧 전각 콜론",
    () =>
      `dispatch_verified： yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
  ],
];

assert.equal(
  FORMAT_ONLY_VARIANTS.length,
  26,
  "1R 검토 ⓐ-2 표의 26종과 칸 수가 일치해야 한다(표 드리프트 방지)",
);

for (const [label, buildG1] of FORMAT_ONLY_VARIANTS) {
  test(`(g1-fmt)★ 형식만 다른 표본(값은 원장과 같음) -- ${label} -> 실 CLI exit 0(소비)`, () => {
    withFixtureDir("g1-fmt-", (dir) => {
      writeCoderRound(dir, { g1: buildG1() });
      const ledgerPath = withLedger(dir, [validReceipt()]);
      const res = runCli(["coder", dir], { ledgerPath });
      assert.equal(
        res.exit,
        0,
        `값은 원장과 같은데 줄 모양만 다르다는 이유로 거부되면 안 된다. stderr: ${res.stderr}`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// ⓑ 1R 검토가 모은 실라운드 5건의 공유 모양 -- `?` 없이 "<pane> == <pane>
// 일치"(아카이브에서 그대로 재현한 모양, 위 FORMAT_ONLY_VARIANTS의 "`?`
// 없음" 항과 값은 같지만 이 표본은 "실라운드 재현"이라는 목적 자체를
// 전용 시험으로 고정해 둔다(coder-task.md §2 요구 7-ⓑ).
// ---------------------------------------------------------------------------
test('(g1-livefmt)★ 실라운드 5건 공유 모양: pane_match가 `?` 없이 "<pane> == <pane> 일치"로만 끝나도 소비된다', () => {
  withFixtureDir("g1-livefmt-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.equal(res.exit, 0, `stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// ⓒ 부재 3종 -- 키 하나씩만 없음 -> 거부 + 사유에 «그 줄 이름»이 찍힌다
// (1R P2-1: 변이 R1/R2가 이 칸이 없어서 생존했다 -- 이 칸이 그 생존을
// 다시 빨갛게 만든다, 아래 (g1-mut-v4)).
// ---------------------------------------------------------------------------
test("(g1-absent-dv)★ 부재: dispatch_verified: 줄만 없음 -> 거부, 사유에 그 줄 이름이 찍힌다", () => {
  withFixtureDir("g1-absent-dv-", (dir) => {
    writeCoderRound(dir, {
      g1: `task_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'dispatch_verified:' line missing/);
  });
});

test("(g1-absent-tid)★ 부재: task_id_from_dispatch: 줄만 없음 -> 거부, 사유에 그 줄 이름이 찍힌다", () => {
  withFixtureDir("g1-absent-tid-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'task_id_from_dispatch:' line missing/);
  });
});

test("(g1-absent-pane)★ 부재: pane_match: 줄만 없음 -> 거부, 사유에 그 줄 이름이 찍힌다", () => {
  withFixtureDir("g1-absent-pane-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line missing/);
  });
});

// ---------------------------------------------------------------------------
// ⓔ pane 비대칭 2종 -- 한쪽만 영수증과 같음 -> 거부(1R P2-2: 변이 R5가
// 이 칸이 없어서 생존했다, 아래 (g1-mut-v5)가 다시 빨갛게 만든다).
// ---------------------------------------------------------------------------
test("(g1-pane-asym-left)★ pane 비대칭: 왼쪽만 틀림(`x == <정답>`) -> 거부", () => {
  withFixtureDir("g1-pane-asym-left-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: x == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line mismatch/);
  });
});

test("(g1-pane-asym-right)★ pane 비대칭: 오른쪽만 틀림(`<정답> == x`) -> 거부", () => {
  withFixtureDir("g1-pane-asym-right-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == x ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line mismatch/);
  });
});

// ---------------------------------------------------------------------------
// ⓘ 백틱 값이 «실제로 다르면» value mismatch(줄 이름 포함)로 거부된다 --
// 형식(백틱 자체)이 "value mismatch"로 찍히는 1R P2-4와 달리, 여기는
// 값이 진짜 다른 경우라 "value mismatch"가 정답이다.
// ---------------------------------------------------------------------------
test("(g1-backtick-tid-diff)★ 백틱 tid인데 값 자체가 다름 -> 'task_id_from_dispatch:' value mismatch로 거부(형식 문제로 오인되지 않는다)", () => {
  withFixtureDir("g1-backtick-tid-diff-", (dir) => {
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: \`task_wrongwrongwrong\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'task_id_from_dispatch:' line value mismatch/);
    assert.match(res.stderr, /found 'task_wrongwrongwrong'/);
  });
});

test("(g1-backtick-pane-diff)★ 백틱 pane인데 값 자체가 다름 -> 'pane_match:' value mismatch로 거부(형식 문제로 오인되지 않는다)", () => {
  withFixtureDir("g1-backtick-pane-diff-", (dir) => {
    const wrongPane =
      "99999999-9999-9999-9999-999999999999:88888888-8888-8888-8888-888888888888";
    writeCoderRound(dir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: \`${wrongPane}\` == \`${wrongPane}\` ? 일치\n`,
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line mismatch/);
    assert.match(
      res.stderr,
      new RegExp(`found '${wrongPane} == ${wrongPane}'`),
    );
  });
});

// ===========================================================================
// 되돌림 변이 V1~V5(coder-task.md §2 요구 8) -- 2R이 추가한 값-대조
// 로직 자체를 하나씩 무력화해, 바로 위 ⓐ~ⓘ 칸들이 «실제로 그 코드가
// 지탱한다»는 것을 보인다(헛시험 방지, 1R과 같은 관용구).
// ===========================================================================

// V1: stripG1ValueDecoration의 장식 벗기기를 제거 -> 백틱으로 감싼 값(ⓘ)이
// 다시 거부된다(RED).
test("(g1-mut-v1)★ 되돌림 변이 V1: stripG1ValueDecoration의 장식 벗기기를 제거하면 -- 백틱으로 감싼 tid(값은 같음)가 다시 거부된다(RED)", () => {
  withFixtureDir("g1-mutv1-", (dir) => {
    const target =
      'function stripG1ValueDecoration(raw) {\n  return raw\n    .trim()\n    .replace(/^[`\'"*]+/, "")\n    .replace(/[`\'"*]+$/, "")\n    .trim();\n}';
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "stripG1ValueDecoration body");
    const replacement =
      "function stripG1ValueDecoration(raw) {\n  return raw; // HYK-434 되돌림 변이 V1: 장식 벗기기 제거\n}";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: \`${RUNTIME_TASK_ID}\`\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      `RED 필수: 장식 벗기기가 없으면 백틱 값(값은 같음)이 다시 거부돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.equal(originalRes.exit, 0, "원본은 같은 표본을 통과시킨다(대조군)");
  });
});

// V2: pane_match 키 대소문자 무시(/i)를 제거 -> 키 대소문자 변형(ⓐ)이
// 다시 거부된다(RED).
test("(g1-mut-v2)★ 되돌림 변이 V2: pane_match 키 대소문자 무시를 제거하면 -- 'Pane_Match:' 키 대소문자 표본이 다시 거부된다(RED)", () => {
  withFixtureDir("g1-mutv2-", (dir) => {
    const target = "(.*)$/gim;\nconst PANE_MATCH_ANYWHERE_RE";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "PANE_MATCH_RE_G flags");
    const replacement = "(.*)$/gm;\nconst PANE_MATCH_ANYWHERE_RE";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\nPane_Match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      `RED 필수: pane_match 키 대소문자 무시가 없으면 'Pane_Match:' 표본이 다시 거부돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.equal(originalRes.exit, 0, "원본은 같은 표본을 통과시킨다(대조군)");
  });
});

// V3: pane_match 토큰 추출을 1R 정규식(`\?` 필수)으로 되돌림 -> `?` 없는
// 실라운드 모양(ⓑ)이 다시 거부된다(RED).
test("(g1-mut-v3)★ 되돌림 변이 V3: pane_match 추출을 1R 정규식(`\\?` 필수)으로 되돌리면 -- `?` 없는 실라운드 모양이 다시 거부된다(RED)", () => {
  withFixtureDir("g1-mutv3-", (dir) => {
    const target =
      "const PANE_MATCH_RE_G =\n  /^[ \\t]*(?:[-*][ \\t]+)?\\*{0,2}pane_match\\*{0,2}[ \\t]*[:：][ \\t]*\\*{0,2}[ \\t]*(\\S+)[ \\t]*(?:={1,3}|->)[ \\t]*(\\S+)(.*)$/gim;";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "PANE_MATCH_RE_G declaration");
    const replacement =
      "const PANE_MATCH_RE_G =\n  /^pane_match:[ \\t]*(\\S+)[ \\t]*==[ \\t]*(\\S+)[ \\t]*\\?[ \\t]*(일치|불일치)[ \\t]*$/gm; // HYK-434 되돌림 변이 V3: 1R 정규식 복귀";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      `RED 필수: \`?\` 필수 정규식으로 되돌리면 \`?\` 없는 표본이 다시 거부돼야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.equal(originalRes.exit, 0, "원본은 같은 표본을 통과시킨다(대조군)");
  });
});

// V4: resolveG1StandaloneLine의 "missing" 사유에서 ${label}(줄 이름)을
// 제거 -> (g1-absent-*) 표본들의 줄 이름 단언이 다시 빨개진다(RED).
test("(g1-mut-v4)★ 되돌림 변이 V4: missing 사유에서 줄 이름을 제거하면 -- 부재 표본의 '줄 이름 고정' 단언이 다시 빨개진다(RED)", () => {
  withFixtureDir("g1-mutv4-", (dir) => {
    const target =
      "  return {\n    ok: false,\n    reason: `${label} missing (no standalone column-0 line found, HYK-434)`,\n  };";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(
      original,
      target,
      "resolveG1StandaloneLine missing reason",
    );
    const replacement =
      "  return {\n    ok: false,\n    reason: `missing (no standalone column-0 line found, HYK-434)`, // HYK-434 되돌림 변이 V4: 줄 이름 제거\n  };";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `task_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == ${PANE_KEY} ? 일치\n`, // dispatch_verified 부재
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.notEqual(
      mutRes.exit,
      0,
      "변이 후에도 거부는 유지된다(기능 자체는 안 바뀜)",
    );
    assert.doesNotMatch(
      mutRes.stderr,
      /'dispatch_verified:' line missing/,
      "RED 필수: 줄 이름이 제거되면 (g1-absent-dv)와 같은 단언이 더 이상 맞지 않아야 한다",
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(originalRes.exit, 0);
    assert.match(
      originalRes.stderr,
      /'dispatch_verified:' line missing/,
      "원본은 줄 이름이 찍힌다(대조군)",
    );
  });
});

// V5: pane_match의 오른쪽 pane key 비교를 제거 -> 오른쪽만 틀린 비대칭
// 표본(ⓔ)이 다시 통과한다(RED, 과관용).
test("(g1-mut-v5)★ 되돌림 변이 V5: pane_match의 오른쪽 비교를 제거하면 -- 오른쪽만 틀린 비대칭 표본이 다시 통과한다(RED)", () => {
  withFixtureDir("g1-mutv5-", (dir) => {
    const target =
      "  if (\n    leftKey.toLowerCase() !== expectedPaneKey.toLowerCase() ||\n    rightKey.toLowerCase() !== expectedPaneKey.toLowerCase()\n  ) {";
    const original = readFileSync(CLI_PATH, "utf8");
    assertExactlyOneMatch(original, target, "pane_match left/right comparison");
    const replacement =
      "  if (\n    leftKey.toLowerCase() !== expectedPaneKey.toLowerCase() // HYK-434 되돌림 변이 V5: 오른쪽 비교 제거\n  ) {";

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, (src) =>
      src.replace(target, replacement),
    );

    const roundDir = join(dir, "round");
    mkdirSync(roundDir);
    writeCoderRound(roundDir, {
      g1: `dispatch_verified: yes\ntask_id_from_dispatch: ${RUNTIME_TASK_ID}\npane_match: ${PANE_KEY} == x ? 일치\n`,
    });
    const ledgerPath = withLedger(roundDir, [validReceipt()]);
    writeFileSync(
      join(roundDir, "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );

    const mutRes = runMutatedCli(mutatedCliPath, ["coder", roundDir]);
    assert.equal(
      mutRes.exit,
      0,
      `RED 필수: 오른쪽 비교가 없으면 오른쪽만 틀린 비대칭 표본이 통과해버려야 한다. stderr: ${mutRes.stderr}`,
    );

    const originalRes = runCli(["coder", roundDir], { ledgerPath });
    assert.notEqual(
      originalRes.exit,
      0,
      "원본은 같은 표본을 반드시 거부한다(대조군)",
    );
  });
});
