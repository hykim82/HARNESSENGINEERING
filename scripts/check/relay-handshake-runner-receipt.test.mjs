// HYK-411 1R -- 러너 자기 종료코드 영수증을 소비 쪽이 fail-closed로
// 요구하는지 고정한다(coder-task.md §2-3).
//
// 실사고 원문(coder-task.md §1): `npm test 2>&1 | tail -N`의 파이프라인
// 종료코드는 마지막 명령(tail)의 것이다 -- 실패한 러너가 exit 0으로 보인다.
// HYK-408 1R에서는 워커가 낡은 수치를 "검증"으로 보고했고, ORCH가 총계
// 불일치를 이상히 여겨 되물어서만 잡혔다(기계가 막은 게 아니었다).
//
// 이 축(resolveRunnerReceiptVerdict, relay-handshake.mjs)은 결과 파일이
// 표준 실행 관용구(`npm test; echo "exit=$?"`)가 남기는 칼럼 0의 단독
// `exit=<n>` 줄로 "전체 러너 결과"를 주장할 때만 작동하고, 그 주장이
// 있으면 `<harnessDir>/runner-receipt.json`(isolated-suite-runner.mjs가
// 스스로 쓰는 영수증)을 요구한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveRunnerReceiptVerdict,
  resolveConsecutiveRunnerReceiptsVerdict,
  countRunnerExitClaims,
  resultClaimsRunnerResults,
  RUNNER_RECEIPT_REJECT_REASON,
  RUNNER_RECEIPT_RUN_PREFIX,
  parseKstTimestamp,
} from "./relay-handshake.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

// HYK-414 1R -- 이 파일의 모든 픽스처는 절대시각(dropped_at 06:00 /
// finished_at 06:09:00 / DONE 06:10:00, 전부 2026-09-01 KST)을 쓴다.
// checkRelayHandshake의 `now`를 기본값(Date.now(), 진짜 시계)에 맡기면
// checkTimezoneMislabel 가드가 "값이 지금과 정확히 9시간 차 ±10분"일 때
// 합성 픽스처를 실제 UTC/KST 오라벨로 오판한다 -- 즉 이 시험은 하루 중
// 그 창(대략 15:00~15:30 KST 부근, 시스템 로컬 시간대에 따라 달라짐)에
// 도는 순간에만 실패했다(coder-task.md §1, 실측: 15:09/15:12 fail,
// 15:22 pass, 코드 변경 0으로 시계만 이동). 고정하는 `now`는 픽스처의
// 마지막 절대시각(DONE 06:10:00)보다 살짝 뒤인 06:15:00으로 둬 시계
// 의존을 0으로 만든다 -- 어느 시각에 돌려도 이 값은 바뀌지 않는다.
const FIXED_NOW_MS = parseKstTimestamp("2026-09-01 06:15:00 KST").getTime();

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
// relay-handshake.mjs's real static sibling dependency list (single source,
// scripts/check/relay-handshake-fixture-siblings.mjs) -- the mutated copy
// below is written to a FRESH tmpdir with no other files, so its relative
// imports resolve only if these are copied alongside it.
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// HYK-383(relay-handshake-head-commit.test.mjs)와 동일 함정: fn이 async면
// `fn(dir)`는 Promise를 즉시 반환하고, await 없이는 바로 이어지는 finally의
// rmSync가 그 비동기 작업이 실제로 끝나기 «전에» dir를 지운다(경쟁 조건) --
// 아래 되돌림 변이 시험들(async fn)은 반드시 이 변형을 쓰고 반드시 await한다.
async function withFixtureDirAsync(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 실제 git 저장소를 만들고 그 HEAD(40-hex SHA)를 반환한다 -- 이 축은
// harnessDir의 실제 HEAD를 기계가 직접 읽어 영수증과 대조한다
// (relay-handshake-head-commit.test.mjs의 ensureGitHeadCommit과 동일).
function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "runner-receipt test fixture"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function writeCoderRound(dir, { resultBody }) {
  writeFileSync(
    join(dir, "coder-task.md"),
    "task_id: HYK-411-T\ndropped_at: 2026-09-01 06:00 KST\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- carry the marker so
    // this shared fixture keeps exercising the runner-receipt wiring under
    // test, not this promotion's rejection.
    `task_id: HYK-411-T\n${resultBody}\n>>> DONE: CODER @ 2026-09-01 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function writeReceipt(dir, receipt) {
  writeFileSync(
    join(dir, "runner-receipt.json"),
    JSON.stringify(receipt, null, 2),
    "utf8",
  );
}

// HYK-485 §2-2: 회차별(run-scoped) 사본 -- isolated-suite-runner.mjs가
// allocateRunSlot/writeNumberedRunnerReceipt로 기계로 남기는 파일과 같은
// 이름 규약.
function writeNumberedReceipt(dir, n, receipt) {
  writeFileSync(
    join(dir, `${RUNNER_RECEIPT_RUN_PREFIX}${n}.json`),
    JSON.stringify(receipt, null, 2),
    "utf8",
  );
}

// 두 번(이상) 러너를 돌렸다는 표준 관용구 주장 -- coder-task.md §5 "2회
// 연속 초록 · 분리 프로세스로"가 남기는 그대로(회차마다 exit=<n> 줄 반복).
const TWO_RUN_CLAIM_BODY =
  'npm test; echo "exit=$?"\nexit=0\nnpm test; echo "exit=$?"\nexit=0';

function baseReceipt(headCommit, overrides = {}) {
  return {
    schema_version: 1,
    runner_exit: 0,
    tests: 10,
    pass: 10,
    fail: 0,
    skip: 0,
    head_commit: headCommit,
    finished_at: "2026-09-01 06:09:00 KST",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (0) 판별 함수 자체: 표준 관용구만 "주장"으로 인정한다.
// ---------------------------------------------------------------------------
test("(rr-0a) resultClaimsRunnerResults: 칼럼 0의 단독 'exit=<n>' 줄이 있으면 true", () => {
  assert.equal(
    resultClaimsRunnerResults("npm test output...\nexit=0\nmore text\n"),
    true,
  );
});

test("(rr-0b) resultClaimsRunnerResults: 'exit='이 문장 중간에만 있으면 false(과차단 방지 -- 우연한 언급을 주장으로 오인하지 않는다)", () => {
  assert.equal(
    resultClaimsRunnerResults("I saw exit=0 mentioned in the log once.\n"),
    false,
  );
});

test("(rr-0c) resultClaimsRunnerResults: 'exit=' 줄이 아예 없으면 false", () => {
  assert.equal(resultClaimsRunnerResults("verdict: approved\n"), false);
});

// ---------------------------------------------------------------------------
// (ⓓ) ★주장 없는 라운드는 영향 0 -- 과차단 금지의 핵심 표본. 영수증이
// 없어도, runner_exit이 있어도 없어도 정상 소비돼야 한다.
// ---------------------------------------------------------------------------
test("(rr-d) ★주장 없는 라운드는 영수증이 전혀 없어도 정상 소비된다(과차단 아님을 증명)", () => {
  withFixtureDir("hyk411-no-claim-", (dir) => {
    writeCoderRound(dir, { resultBody: "verdict: approved" });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      result.ok,
      true,
      `claim이 없는 라운드는 이 축의 영향을 받지 않아야 한다: ${result.reason}`,
    );
  });
});

test("(rr-d2) resolveRunnerReceiptVerdict 직접 확인: 주장 없는 resultContent -> 즉시 {ok:true, skipped:true}", () => {
  const r = resolveRunnerReceiptVerdict({
    resultContent: "verdict: approved\n",
    harnessDir: "/does/not/matter",
  });
  assert.deepEqual(r, { ok: true, skipped: true });
});

// ---------------------------------------------------------------------------
// (ⓒ) 영수증 없음 + 러너 결과 주장 -> 거부(MISSING).
// ---------------------------------------------------------------------------
test("(rr-c) ⓒ 영수증 없음 + 러너 결과 주장 -> 소비 거부(MISSING)", () => {
  withFixtureDir("hyk411-missing-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);
    assert.match(result.reason, /runner-receipt\.json is missing/);
  });
});

// ---------------------------------------------------------------------------
// (ⓐ) 파이프로 숨긴 빨간 실행 표본 -- 영수증의 runner_exit != 0 -> 거부(RED).
// ---------------------------------------------------------------------------
test("(rr-a)★ ⓐ 파이프로 숨긴 빨간 실행: exit=0으로 보고했지만 영수증 runner_exit=1 -> 소비 거부(RED)", () => {
  withFixtureDir("hyk411-red-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    // 파이프가 숨긴 정확한 형태: 결과 파일은 exit=0을 신고하지만(파이프
    // 뒤에서 관찰된 값), 러너 자신이 쓴 영수증은 진실(runner_exit=1)을
    // 담고 있다.
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1, fail: 3, pass: 7 }));
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
    assert.match(result.reason, /runner_exit=1/);
  });
});

// ---------------------------------------------------------------------------
// (ⓑ) 낡은 head_commit 영수증 표본 -- HYK-408 실피해의 정확한 형태.
// ---------------------------------------------------------------------------
test("(rr-b)★ ⓑ 낡은 head_commit 영수증: 영수증이 이전 커밋의 것 -> 소비 거부(STALE, HYK-408 재발 방지)", () => {
  withFixtureDir("hyk411-stale-", (dir) => {
    const oldSha = ensureGitHeadCommit(dir);
    execFileSync(
      "git",
      ["commit", "-q", "--allow-empty", "-m", "new commit after the receipt"],
      { cwd: dir },
    );
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(oldSha)); // 낡은 커밋 값 그대로.
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.STALE);
    assert.match(result.reason, /does not match this worktree's actual HEAD/);
  });
});

// ---------------------------------------------------------------------------
// 정상 경로: 초록 + 신선한 head_commit -> 정상 소비.
// ---------------------------------------------------------------------------
test("(rr-ok) 정상 경로: runner_exit=0 + head_commit이 실제 HEAD와 일치 -> 정상 소비 성공", () => {
  withFixtureDir("hyk411-ok-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(sha));
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, true, `expected clean pass: ${result.reason}`);
  });
});

// ---------------------------------------------------------------------------
// (rr-clock-sweep) ★HYK-414 1R -- 이 결함의 직접적 반증. `now`를 24시간
// 전부에 걸쳐 훑어, (a) 결함이 실재했음(now를 벽시계에 맡겼다면 픽스처
// 날짜의 특정 시간대에서만 떨어졌을 것)을 같은 (rr-ok) 픽스처로 재현하고,
// (b) 이 파일의 실제 프로덕션 호출(위 모든 checkRelayHandshake 호출)은
// `now: FIXED_NOW_MS`만 쓰고 있어 그 결함이 있는 시간대에 도달할 길이
// 없음을 함께 못박는다.
// ---------------------------------------------------------------------------
test("(rr-clock-sweep)★ now를 하루 24시간에 걸쳐 훑는다: (a) now를 벽시계에 맡겼다면 걸렸을 시간대(픽스처+9h 부근)가 실제로 있고, (b) 이 파일이 실제로 쓰는 FIXED_NOW_MS는 그 시간대 밖이라 안전하다", () => {
  withFixtureDir("hyk411-sweep-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(sha));

    // (a) 결함 재현: droppedAt(06:00)/doneAt(06:10:00)의 정확히 +9h인
    // 14~15시대는 checkTimezoneMislabel의 "값이 지금과 정확히 9시간 차
    // ±10분"(TZ_MISLABEL_TOLERANCE_MS=10분) 창에 들어 소비가 거부된다 --
    // 이게 `now`를 안 넘겼을 때(=Date.now() 기본값) 실제 관측된 실패
    // (coder-task.md §1: 15:09/15:12 fail, 15:22 pass)의 원인 그 자체다.
    const hourlyResults = [];
    for (let hour = 0; hour < 24; hour++) {
      const hourMs = parseKstTimestamp(
        `2026-09-01 ${String(hour).padStart(2, "0")}:00:00 KST`,
      ).getTime();
      const result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: hourMs,
      });
      hourlyResults.push({
        hour,
        ok: result.ok,
        state: result.ok ? null : result.state,
      });
    }

    // 시간대 0~6시(=droppedAt 06:00 이전)는 droppedAt이 now보다 "미래"로
    // 보여 별개 축(checkFutureSkew, 진짜 미래 시각 거부)이 정당하게
    // 걸린다 -- 이 축(TZ 오라벨)과 무관하니 여기서는 걸러내고, 오직
    // "TZ 오라벨로 의심" 상태만 이 시험의 관심사로 본다.
    const tzMislabelHours = hourlyResults
      .filter((r) => !r.ok && /TZ_MISLABEL/.test(String(r.state)))
      .map((r) => r.hour);
    assert.ok(
      tzMislabelHours.length > 0,
      `기대: now를 벽시계에 맡기면 TZ 오라벨로 의심돼 걸리는 시간대가 있어야 결함 재현이다(발견된 시간대 없음 -- sweep이 결함을 못 잡고 있다는 뜻일 수 있어 확인 필요): ${JSON.stringify(hourlyResults)}`,
    );
    assert.ok(
      tzMislabelHours.every((h) => h >= 14 && h <= 15),
      `기대: TZ 오라벨 거부는 픽스처(06:00/06:10:00)+9h 부근(14~15시)에만 몰려야 한다(그 밖에서 나오면 이 축과 무관한 별개 결함): ${JSON.stringify(hourlyResults)}`,
    );

    // (b) 수리 확인: 이 파일의 실제 프로덕션 호출은 전부 FIXED_NOW_MS를
    // 쓴다 -- 그 값이 위에서 재현한 위험 시간대(14~15시) 밖에 있어야
    // "수리가 위험을 실제로 피했다"고 말할 수 있다.
    const fixedHour = new Date(FIXED_NOW_MS).getUTCHours(); // UTC로 봐도 되는 이유: 아래는 danger set과의 상대 비교가 아니라 절대 시각 재계산이라서 무관 -- 대신 실제 판정으로 직접 확인한다.
    const fixedResult = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      fixedResult.ok,
      true,
      `FIXED_NOW_MS(${new Date(FIXED_NOW_MS).toISOString()}, hour=${fixedHour} UTC)가 위험 시간대에 걸렸다 -- 상수를 다시 골라야 한다: ${fixedResult.reason}`,
    );
  });
});

// ---------------------------------------------------------------------------
// INVALID: 영수증이 있지만 JSON이 아니거나 필수 필드가 없다.
// ---------------------------------------------------------------------------
test("(rr-invalid-json) 영수증이 유효한 JSON이 아니다 -> 소비 거부(INVALID)", () => {
  withFixtureDir("hyk411-badjson-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeFileSync(join(dir, "runner-receipt.json"), "{ not json", "utf8");
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
  });
});

test("(rr-invalid-fields) 영수증에 필수 필드(runner_exit/head_commit)가 없다 -> 소비 거부(INVALID)", () => {
  withFixtureDir("hyk411-badfields-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeFileSync(
      join(dir, "runner-receipt.json"),
      JSON.stringify({ schema_version: 1 }),
      "utf8",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
  });
});

// ---------------------------------------------------------------------------
// 사유 구별: MISSING/RED/STALE/INVALID 넷은 서로 다른 code다(HYK-413
// "유휴/과차단 미구별" 재발 방지 -- 조용히 하나로 뭉뚱그리지 않는다).
// ---------------------------------------------------------------------------
test("(rr-codes-distinct) MISSING/RED/STALE/INVALID 네 코드는 서로 전부 다르다", () => {
  const codes = Object.values(RUNNER_RECEIPT_REJECT_REASON);
  assert.equal(new Set(codes).size, codes.length);
});

// ---------------------------------------------------------------------------
// (ⓔ) 되돌림 변이 -- 검사를 끄면 ⓐⓑⓒ가 다시 통과하는지 직접 확인한다.
// 바이트 동일 복원 + git status 확인은 CLAUDE.md 작업 규율(임시 파일은
// 워크트리 안, 승인 프롬프트를 유발할 명령 회피)에 맞춰 읽기 전용 문자열
// 치환 + 되돌리기로 수행한다(파일을 실제로 건드리지 않는다 -- 소스를
// 메모리에서 치환한 사본을 파일로 써서 그 사본만 import한다,
// relay-handshake-head-commit.test.mjs (8)의 관례 그대로).
// ---------------------------------------------------------------------------
function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

async function importMutatedRelayHandshake(mutatedSrc, label) {
  const mutDir = mkdtempSync(join(tmpdir(), `hyk411-mut-${label}-`));
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(mutDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  const mutPath = join(mutDir, "relay-handshake.mjs");
  writeFileSync(mutPath, mutatedSrc, "utf8");
  const mod = await import(
    `file://${mutPath.replace(/\\/g, "/")}?t=${Date.now()}`
  );
  return { mod, mutDir };
}

test("(rr-e1)★ 되돌림 변이: 소비 축(checkRelayHandshake 결선) 자체를 제거하면 -- (rr-a)의 파이프 은폐 빨간 실행 표본이 다시 통과한다(RED, load-bearing 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  // HYK-423 3R §2: call-site text updated -- `resultContent` is now
  // `resultContent: judgedRegion` (the same DONE-line-bounded region the
  // observation fingerprint uses, coder.md ⑵) so this gate can no longer be
  // fed content placed after the DONE line. The wiring this mutation proves
  // load-bearing (resolveRunnerReceiptVerdict + the ok:false return) is
  // unchanged, only its input's scope narrowed; deleting this whole block
  // still removes both the gate AND that scoping, so the RED assertion
  // below still proves the gate itself is load-bearing.
  const target =
    "  const runnerReceiptVerdict = resolveRunnerReceiptVerdict({\n    resultContent: judgedRegion,\n    harnessDir,\n  });\n  if (!runnerReceiptVerdict.ok) return runnerReceiptVerdict;\n\n";
  assertExactlyOneMatch(src, target, "runner receipt wiring block");
  const mutated = src.replace(target, "");
  assert.equal(mutated.length, src.length - target.length);

  await withFixtureDirAsync("hyk411-mut-e1-fixture-", async (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1 }));
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "e1");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with the wiring removed, a receipt reporting runner_exit=1 is wrongly consumed as success",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });

  // 파일은 애초에 건드리지 않았다(치환은 메모리 문자열에서만 일어났다) --
  // 그래도 §2-3 ⓔ의 "바이트 동일 복원 + git status 확인" 요구를 문자
  // 그대로 만족시키기 위해 명시적으로 재확인한다.
  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

test("(rr-e2)★ 되돌림 변이: runner_exit 대조를 제거하면 -- (rr-a) 빨간 실행이 다시 통과한다(RED)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  if (receipt.runner_exit !== 0) {\n    return {\n      ok: false,\n      code: RUNNER_RECEIPT_REJECT_REASON.RED,\n      reason: `runner receipt gate (HYK-411): runner receipt at ${found.path} reports runner_exit=${receipt.runner_exit} (non-zero) -- the runner itself observed a failed run, refusing to consume a result claiming green (파이프가 숨긴 빨간 실행 차단)`,\n    };\n  }\n";
  assertExactlyOneMatch(src, target, "runner_exit RED comparison");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk411-mut-e2-fixture-", async (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1 }));
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "e2");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with the runner_exit comparison removed, a red receipt is wrongly consumed as success",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

test("(rr-e3)★ 되돌림 변이: head_commit 대조를 제거하면 -- (rr-b) 낡은 영수증이 다시 통과한다(RED, HYK-408 재발 방지 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  if (receipt.head_commit.toLowerCase() !== actualHead.sha) {\n    return {\n      ok: false,\n      code: RUNNER_RECEIPT_REJECT_REASON.STALE,\n      reason: `runner receipt gate (HYK-411): runner receipt at ${found.path} head_commit '${receipt.head_commit}' does not match this worktree's actual HEAD '${actualHead.sha}' -- refusing to consume a stale/reused runner result (HYK-408 1R 실피해 재발 방지)`,\n    };\n  }\n";
  assertExactlyOneMatch(src, target, "head_commit STALE comparison");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk411-mut-e3-fixture-", async (dir) => {
    const oldSha = ensureGitHeadCommit(dir);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], {
      cwd: dir,
    });
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=0' });
    writeReceipt(dir, baseReceipt(oldSha));
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "e3");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with the head_commit comparison removed, a stale receipt is wrongly consumed as success",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

// ===========================================================================
// HYK-485 §2-2: resolveConsecutiveRunnerReceiptsVerdict -- 회차별 영수증
// 2개를 기계로 대조한다. 1개뿐이면 «측정 불능»(HYK-480 1R 실사고의 정확한
// 형태: 정직하게 두 번 돌렸지만 기계 증거는 2회차 영수증 하나뿐이었다).
// ===========================================================================

test("(cr-0) countRunnerExitClaims: 0/1/2/3회 -- 같은 표준 관용구를 세기만 한다(새 정규식 아님)", () => {
  assert.equal(countRunnerExitClaims("verdict: approved"), 0);
  assert.equal(countRunnerExitClaims('npm test; echo "exit=$?"\nexit=0'), 1);
  assert.equal(countRunnerExitClaims(TWO_RUN_CLAIM_BODY), 2);
  assert.equal(
    countRunnerExitClaims(
      `${TWO_RUN_CLAIM_BODY}\nnpm test; echo "exit=$?"\nexit=1`,
    ),
    3,
  );
});

test("(cr-skip) resolveConsecutiveRunnerReceiptsVerdict 직접 확인: 0/1회 주장은 이 축의 영향 밖(과차단 금지) -- 즉시 {ok:true, skipped:true}", () => {
  assert.deepEqual(
    resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: "verdict: approved",
      harnessDir: "/does/not/matter",
    }),
    { ok: true, skipped: true },
  );
  assert.deepEqual(
    resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: 'npm test; echo "exit=$?"\nexit=0',
      harnessDir: "/does/not/matter",
    }),
    { ok: true, skipped: true },
  );
});

test("(cr-1)★ 2회 주장 + 회차별 영수증 0개 -> 소비 거부(MEASUREMENT_UNAVAILABLE, NOT RED/TESTS_FAILED)", () => {
  withFixtureDir("hyk485-cr1-", (dir) => {
    ensureGitHeadCommit(dir);
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE);
    assert.match(r.reason, /측정 불능/);
  });
});

test("(cr-2)★ HYK-480 1R 실사고의 정확한 형태 재현: 2회 주장 + 회차별 영수증 1개뿐(2회차만 남고 1회차가 덮어써진 모양) -> 소비 거부(MEASUREMENT_UNAVAILABLE)", () => {
  withFixtureDir("hyk485-cr2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(
      dir,
      2,
      baseReceipt(sha, { finished_at: "2026-09-01 06:09:00 KST" }),
    );
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE);
    assert.match(r.reason, /only 1 numbered receipt/);
  });
});

test("(cr-3) 2회 주장 + 회차별 영수증 2개, 그중 하나 runner_exit != 0 -> 소비 거부(RED)", () => {
  withFixtureDir("hyk485-cr3-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(
      dir,
      1,
      baseReceipt(sha, { finished_at: "2026-09-01 06:08:00 KST" }),
    );
    writeNumberedReceipt(
      dir,
      2,
      baseReceipt(sha, {
        runner_exit: 1,
        fail: 1,
        finished_at: "2026-09-01 06:09:00 KST",
      }),
    );
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});

test("(cr-4) 2회 주장 + 회차별 영수증 2개, 그중 하나 head_commit 낡음 -> 소비 거부(STALE)", () => {
  withFixtureDir("hyk485-cr4-", (dir) => {
    const oldSha = ensureGitHeadCommit(dir);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], {
      cwd: dir,
    });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    writeNumberedReceipt(
      dir,
      1,
      baseReceipt(oldSha, { finished_at: "2026-09-01 06:08:00 KST" }),
    );
    writeNumberedReceipt(
      dir,
      2,
      baseReceipt(sha, { finished_at: "2026-09-01 06:09:00 KST" }),
    );
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.STALE);
  });
});

test("(cr-5) 2회 주장 + 회차별 영수증 2개, finished_at 서로 같음(같은 실행을 두 번 셈한 모양) -> 소비 거부(INVALID)", () => {
  withFixtureDir("hyk485-cr5-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    const same = "2026-09-01 06:09:00 KST";
    writeNumberedReceipt(dir, 1, baseReceipt(sha, { finished_at: same }));
    writeNumberedReceipt(dir, 2, baseReceipt(sha, { finished_at: same }));
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
    assert.match(r.reason, /same finished_at/);
  });
});

test("(cr-6) 2회 주장 + 회차별 영수증 2개, 그중 하나 runner_status=MEASUREMENT_UNAVAILABLE_OOM -> 소비 거부(MEASUREMENT_UNAVAILABLE, RED 아님)", () => {
  withFixtureDir("hyk485-cr6-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(
      dir,
      1,
      baseReceipt(sha, { finished_at: "2026-09-01 06:08:00 KST" }),
    );
    writeNumberedReceipt(
      dir,
      2,
      baseReceipt(sha, {
        runner_exit: 1,
        runner_status: "MEASUREMENT_UNAVAILABLE_OOM",
        finished_at: "2026-09-01 06:09:00 KST",
      }),
    );
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE);
  });
});

test("(cr-ok)★ 정상 경로: 2회 주장 + 회차별 영수증 2개 -- finished_at 서로 다름 · head_commit 동일 · 둘 다 fail 0 -> 정상 소비 성공", () => {
  withFixtureDir("hyk485-cr-ok-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(
      dir,
      1,
      baseReceipt(sha, { finished_at: "2026-09-01 06:08:00 KST" }),
    );
    writeNumberedReceipt(
      dir,
      2,
      baseReceipt(sha, { finished_at: "2026-09-01 06:09:00 KST" }),
    );
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
    });
    assert.equal(r.ok, true, `expected clean pass: ${r.reason}`);
  });
});

test("(cr-pipeline)★ HYK-480 1R 실사고 재발 방지, checkRelayHandshake 전체 파이프라인: 2회 러너를 주장하는 라운드에서 회차별 영수증이 1개(2회차)뿐이면 -- «2회 초록»으로 조용히 통과하지 않고 MEASUREMENT_UNAVAILABLE로 거부된다", () => {
  withFixtureDir("hyk485-cr-pipeline-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: TWO_RUN_CLAIM_BODY });
    writeReceipt(dir, baseReceipt(sha)); // "latest" -- 2회차 값 그대로 남는다.
    writeNumberedReceipt(dir, 2, baseReceipt(sha)); // 1회차 사본은 없다(실사고 재현).
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE,
    );
  });
});

test("(cr-pipeline-ok) checkRelayHandshake 전체 파이프라인: 2회 러너를 주장하고 회차별 영수증 2개가 모두 갖춰지면 정상 소비된다", () => {
  withFixtureDir("hyk485-cr-pipeline-ok-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: TWO_RUN_CLAIM_BODY });
    writeReceipt(dir, baseReceipt(sha));
    writeNumberedReceipt(
      dir,
      1,
      baseReceipt(sha, { finished_at: "2026-09-01 06:08:00 KST" }),
    );
    writeNumberedReceipt(
      dir,
      2,
      baseReceipt(sha, { finished_at: "2026-09-01 06:09:00 KST" }),
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, true, `expected clean pass: ${result.reason}`);
  });
});

test("(cr-e1)★ 되돌림 변이: consecutiveRunnerReceiptsVerdict 결선 자체를 제거하면 -- (cr-pipeline)의 HYK-480 재현 표본이 다시 통과한다(RED, load-bearing 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "\n  // HYK-485 §2-2: runnerReceiptVerdict와 같은 자리 원칙(§4 무회귀) -- 같은\n  // judgedRegion/harnessDir을 넘긴다. 0/1회 주장 라운드는 skip으로 빠져\n  // 나가 이 축이 존재하기 전과 완전히 동일하게 움직인다(과차단 금지).\n  const consecutiveRunnerReceiptsVerdict =\n    resolveConsecutiveRunnerReceiptsVerdict({\n      resultContent: judgedRegion,\n      harnessDir,\n    });\n  if (!consecutiveRunnerReceiptsVerdict.ok)\n    return consecutiveRunnerReceiptsVerdict;\n";
  assertExactlyOneMatch(src, target, "consecutive runner receipt wiring block");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk485-mut-cr-e1-", async (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: TWO_RUN_CLAIM_BODY });
    writeReceipt(dir, baseReceipt(sha));
    writeNumberedReceipt(dir, 2, baseReceipt(sha)); // 1회차 사본 없음.
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "cr-e1");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with the wiring removed, a 2-run claim backed by only 1 numbered receipt is wrongly consumed as success",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

// ===========================================================================
// HYK-477 §2-4: runner_status 소비자 -- MEASUREMENT_UNAVAILABLE_OOM은
// runner_exit도 0이 아니므로(classifySpawnOutcome, exitCode:1), 이 검사가
// 없으면 RED(「시험 실패」)로 조용히 접힌다. 이 축은 그 접힘을 막는다.
// ===========================================================================

test("(rs-1)★ resolveRunnerReceiptVerdict 직접 확인: runner_status=MEASUREMENT_UNAVAILABLE_OOM인 영수증 -> 소비 거부(MEASUREMENT_UNAVAILABLE, RED 아님)", () => {
  withFixtureDir("hyk477-rs1-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeReceipt(
      dir,
      baseReceipt(sha, {
        schema_version: 2,
        runner_exit: 1,
        runner_status: "MEASUREMENT_UNAVAILABLE_OOM",
        fail: null,
      }),
    );
    const r = resolveRunnerReceiptVerdict({
      resultContent: 'npm test; echo "exit=$?"\nexit=1',
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE);
    assert.notEqual(r.code, RUNNER_RECEIPT_REJECT_REASON.RED);
    assert.match(r.reason, /측정 불능/);
  });
});

test("(rs-2) schema v1 영수증(runner_status 필드 자체가 없음)은 이 새 축의 영향을 받지 않는다(무회귀) -- runner_exit != 0이면 그대로 RED", () => {
  withFixtureDir("hyk477-rs2-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1, fail: 1 })); // v1, no runner_status
    const r = resolveRunnerReceiptVerdict({
      resultContent: 'npm test; echo "exit=$?"\nexit=1',
      harnessDir: dir,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});

test("(rs-pipeline)★ checkRelayHandshake 전체 파이프라인: runner_status=MEASUREMENT_UNAVAILABLE_OOM -> 거부 문장이 RED('시험 실패' 어휘)가 아니라 '측정 불능'이다", () => {
  withFixtureDir("hyk477-rs-pipeline-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=1' });
    writeReceipt(
      dir,
      baseReceipt(sha, {
        schema_version: 2,
        runner_exit: 1,
        runner_status: "MEASUREMENT_UNAVAILABLE_OOM",
        fail: null,
      }),
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.code,
      RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE,
    );
    // RED's wording ("the runner itself observed a failed run") must NOT
    // appear -- this is the concrete "다른 문장" §2-4 asks for, not just a
    // different code.
    assert.doesNotMatch(
      result.reason,
      /the runner itself observed a failed run/,
    );
    assert.match(result.reason, /측정 불능/);
  });
});

test("(rs-e1)★ 되돌림 변이: runner_status 검사를 제거하면 -- (rs-1)의 측정 불능 표본이 RED로 (문장이) 접힌다(측정 불능 구별이 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    '  // HYK-477 §2-4: runner_status는 schema v2부터 있는 필드다 -- v1 영수증\n  // (필드 자체가 undefined)은 이 비교가 항상 false가 되어 자연히 통과하고\n  // 아래 runner_exit 검사로 넘어간다(무회귀). 이 검사를 runner_exit 검사\n  // "앞"에 두는 순서가 핵심이다: classifySpawnOutcome은\n  // MEASUREMENT_UNAVAILABLE_OOM도 exitCode 1(0이 아님)로 남기므로, 순서가\n  // 바뀌면 이 값이 먼저 RED로 접혀 이 분기에 영영 도달하지 못한다 --\n  // §2-3이 분류기 안에서 고친 바로 그 왜곡이 소비 쪽에서 재발하는 것과\n  // 같은 형태다.\n  if (receipt.runner_status === MEASUREMENT_UNAVAILABLE_OOM_STATUS) {\n    return {\n      ok: false,\n      code: RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE,\n      reason: `runner receipt gate (HYK-477): runner receipt at ${found.path} reports runner_status=${MEASUREMENT_UNAVAILABLE_OOM_STATUS} -- 측정 불능(measurement unavailable), NOT a test failure: the runner was forcibly killed (OOM/signal) before node --test produced a real result (HYK-467 규율) -- fail-closed all the same (소비는 여전히 거부한다), but reported with a distinct code/문장 so a reader cannot mistake this for "the tests failed"`,\n    };\n  }\n';
  assertExactlyOneMatch(
    src,
    target,
    "runner_status MEASUREMENT_UNAVAILABLE check",
  );
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk477-mut-rs-e1-", async (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, { resultBody: 'npm test; echo "exit=$?"\nexit=1' });
    writeReceipt(
      dir,
      baseReceipt(sha, {
        schema_version: 2,
        runner_exit: 1,
        runner_status: "MEASUREMENT_UNAVAILABLE_OOM",
        fail: null,
      }),
    );
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "rs-e1");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        false,
        "still rejected either way (fail-closed 유지)",
      );
      assert.equal(
        result.code,
        RUNNER_RECEIPT_REJECT_REASON.RED,
        "RED: with the runner_status check removed, an OOM receipt collapses into the generic RED code/문장 -- exactly the §2-4 problem this check exists to prevent",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});
