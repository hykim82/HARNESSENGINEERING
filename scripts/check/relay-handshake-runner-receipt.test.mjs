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
  resultClaimsRunnerResults,
  RUNNER_RECEIPT_REJECT_REASON,
} from "./relay-handshake.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
// relay-handshake.mjs's real static sibling dependency list (grep-verified,
// same list relay-handshake-head-commit.test.mjs's mutation harness uses) --
// the mutated copy below is written to a FRESH tmpdir with no other files,
// so its relative imports resolve only if these are copied alongside it.
const SIBLING_DEPS = [
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "time-authority.mjs",
];

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
    `task_id: HYK-411-T\n${resultBody}\n>>> DONE: CODER @ 2026-09-01 06:10:00 KST\n`,
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, true, `expected clean pass: ${result.reason}`);
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
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
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
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
  const target =
    "  const runnerReceiptVerdict = resolveRunnerReceiptVerdict({\n    resultContent,\n    harnessDir,\n  });\n  if (!runnerReceiptVerdict.ok) return runnerReceiptVerdict;\n\n";
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
