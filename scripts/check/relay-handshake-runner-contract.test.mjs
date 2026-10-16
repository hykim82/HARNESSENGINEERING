// HYK-425 §2 -- 러너 영수증 게이트(HYK-411/HYK-485)의 발화 조건을 결과
// 파일의 `exit=<n>` 주장 하나에만 묶지 않고, task 파일(<harnessDir>/
// <role>-task.md)이 선언하는 `runner_contract:` 계약 줄로도 넓힌다.
//
// §1 실측(coder-task.md 원문): 모든 지시서의 상시 문면이 "열 0에
// exit=<숫자> 모양 줄을 쓰지 마라"(승계 규율 47)다 -- 규율을 지키는
// 워커일수록 HYK-411/HYK-485 축이 안 켜진다. 이 축이 그 빈칸을 닫는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveRunnerContractDirective,
  resolveConsecutiveRunnerReceiptsVerdict,
  RUNNER_RECEIPT_REJECT_REASON,
  RUNNER_RECEIPT_RUN_PREFIX,
  parseKstTimestamp,
} from "./relay-handshake.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

// HYK-414 1R과 같은 이유(relay-handshake-runner-receipt.test.mjs 머리
// 참조) -- 모든 픽스처가 절대시각(2026-09-01 KST)을 쓰므로 `now`를 그
// 뒤로 고정해 하루 중 특정 창에서만 깨지는 시계 의존을 없앤다.
const FIXED_NOW_MS = parseKstTimestamp("2026-09-01 06:15:00 KST").getTime();

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// relay-handshake-head-commit.test.mjs/runner-receipt.test.mjs와 동일 함정
// 회피: async fn은 반드시 await해야 finally의 rmSync가 경쟁하지 않는다.
async function withFixtureDirAsync(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "runner-contract test fixture"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

// 배달된 task 파일 그대로 -- `contractLine`(있으면 `runner_contract: ...\n`)
// 을 task_id:/dropped_at: 뒤에 그대로 붙인다(열 0, 인용/펜스 밖 그대로
// 두는 것은 호출자 책임 -- 펜스로 감싸는 시험은 contractLine 자체에
// 펜스 문자를 포함시킨다).
function writeCoderRound(dir, { contractLine = "", resultBody }) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: HYK-425-T\ndropped_at: 2026-09-01 06:00 KST\n${contractLine}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: HYK-425-T\n${resultBody}\n>>> DONE: CODER @ 2026-09-01 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

// §3 조건2 ⓚ: BLOCKED 라운드 -- 이 축이 BLOCKED 판정보다 먼저 닿지
// 않는지 확인하기 위한 전용 픽스처(완료 표지 없음, DONE 대신 BLOCKED).
function writeBlockedRound(dir, { contractLine = "" }) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: HYK-425-T\ndropped_at: 2026-09-01 06:00 KST\n${contractLine}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    "task_id: HYK-425-T\n>>> BLOCKED: waiting for input\n",
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

function writeNumberedReceipt(dir, n, receipt) {
  writeFileSync(
    join(dir, `${RUNNER_RECEIPT_RUN_PREFIX}${n}.json`),
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

const TWO_RUN_CLAIM_BODY =
  'npm test; echo "exit=$?"\nexit=0\nnpm test; echo "exit=$?"\nexit=0';

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

async function importMutatedRelayHandshake(mutatedSrc, label) {
  const mutDir = mkdtempSync(join(tmpdir(), `hyk425-mut-${label}-`));
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

// ===========================================================================
// (0) resolveRunnerContractDirective 자체 -- 판독 계약(열 0 단독 줄,
// maskQuotedMarkerRegions로 인용/펜스 밖만, 값은 none/full-1x/full-2x만,
// 같은 키 2개 이상이거나 값이 셋 밖이면 AMBIGUOUS -- HYK-486 선례).
// ===========================================================================
test("(rc-0a) 계약 줄 없음 -> absent", () => {
  assert.deepEqual(resolveRunnerContractDirective("task_id: X\n"), {
    state: "absent",
  });
});

test("(rc-0b) runner_contract: none -> set/value=none/requiredRuns=0", () => {
  assert.deepEqual(resolveRunnerContractDirective("runner_contract: none\n"), {
    state: "set",
    value: "none",
    requiredRuns: 0,
  });
});

test("(rc-0c) runner_contract: full-1x -> set/requiredRuns=1", () => {
  assert.deepEqual(
    resolveRunnerContractDirective("runner_contract: full-1x\n"),
    { state: "set", value: "full-1x", requiredRuns: 1 },
  );
});

test("(rc-0d) runner_contract: full-2x -> set/requiredRuns=2", () => {
  assert.deepEqual(
    resolveRunnerContractDirective("runner_contract: full-2x\n"),
    { state: "set", value: "full-2x", requiredRuns: 2 },
  );
});

test("(rc-0e) 같은 키가 인용 밖에 2개 이상 -> ambiguous(조용히 하나를 고르지 않는다, HYK-486 선례)", () => {
  const r = resolveRunnerContractDirective(
    "runner_contract: full-1x\nrunner_contract: full-2x\n",
  );
  assert.equal(r.state, "ambiguous");
  assert.match(r.reason, /2 standalone/);
});

test("(rc-0f) 값이 none/full-1x/full-2x 밖(예: 'yes') -> ambiguous(판정 불가)", () => {
  const r = resolveRunnerContractDirective("runner_contract: yes\n");
  assert.equal(r.state, "ambiguous");
  assert.match(r.reason, /is not one of/);
});

test("(rc-0g) 값이 none/full-1x/full-2x 밖(예: 'full-3x') -> ambiguous", () => {
  const r = resolveRunnerContractDirective("runner_contract: full-3x\n");
  assert.equal(r.state, "ambiguous");
});

test("(rc-0h) 펜스 안에만 있는 계약 줄 -> absent(계약 없음으로 취급, 지금 동작)", () => {
  const r = resolveRunnerContractDirective(
    "```\nrunner_contract: full-2x\n```\n",
  );
  assert.deepEqual(r, { state: "absent" });
});

// ===========================================================================
// (rc-nm) HYK-425 2R P1-1/P2-1 -- 근사(장식) 줄은 표준 매치가 0개여도
// "계약 없음"으로 조용히 접히지 않고 전부 판정 불가(ambiguous)로 거부한다
// (검토 1R 표 L·O·M·N·P·R·X, coder-task.md 1b_exec_line ⓐ~ⓕ 그대로).
// ===========================================================================

test("(rc-nm-a) 꼬리 글: 'runner_contract: full-2x — 설명' -> ambiguous(판정 불가, P1-1)", () => {
  const r = resolveRunnerContractDirective("runner_contract: full-2x — 설명\n");
  assert.equal(r.state, "ambiguous");
  assert.match(r.reason, /near-miss/);
});

test("(rc-nm-b) 빈 값: 'runner_contract:' -> ambiguous(판정 불가, P1-1)", () => {
  const r = resolveRunnerContractDirective("runner_contract:\n");
  assert.equal(r.state, "ambiguous");
  assert.match(r.reason, /near-miss/);
});

test("(rc-nm-c) 목록 접두: '- runner_contract: full-1x' -> ambiguous(P2-1, G1과 다른 정책)", () => {
  const r = resolveRunnerContractDirective("- runner_contract: full-1x\n");
  assert.equal(r.state, "ambiguous");
});

test("(rc-nm-d) 키 대문자: 'RUNNER_CONTRACT: full-1x' -> ambiguous(P2-1)", () => {
  const r = resolveRunnerContractDirective("RUNNER_CONTRACT: full-1x\n");
  assert.equal(r.state, "ambiguous");
});

test("(rc-nm-e) 전각 콜론: 'runner_contract：full-1x' -> ambiguous(P2-1)", () => {
  const r = resolveRunnerContractDirective("runner_contract：full-1x\n");
  assert.equal(r.state, "ambiguous");
});

test("(rc-nm-f) 굵게: '**runner_contract**: full-1x' -> ambiguous(P2-1)", () => {
  const r = resolveRunnerContractDirective("**runner_contract**: full-1x\n");
  assert.equal(r.state, "ambiguous");
});

test("(rc-nm-indent) 들여쓰기만(목록 접두 없음): '    runner_contract: full-1x' -> ambiguous(P2-1)", () => {
  const r = resolveRunnerContractDirective("    runner_contract: full-1x\n");
  assert.equal(r.state, "ambiguous");
});

test("(rc-nm-coexist) 표준 줄 1개 + 근사 줄 1개 공존 -> ambiguous(조용히 표준만 고르지 마라, HYK-486)", () => {
  const r = resolveRunnerContractDirective(
    "runner_contract: full-1x\n- runner_contract: full-2x\n",
  );
  assert.equal(r.state, "ambiguous");
  assert.match(r.reason, /near-miss/);
});

test("(rc-nm-fenced) 근사 줄이 펜스 안에만 -> absent(계약 없음, 마스킹 범위 밖, 지금 동작 유지)", () => {
  const r = resolveRunnerContractDirective(
    "```\n- runner_contract: full-1x\n```\n",
  );
  assert.deepEqual(r, { state: "absent" });
});

test("(rc-nm-regression) 표준 줄만 있고 근사 줄은 전혀 없음 -> 평소처럼 set(무회귀)", () => {
  assert.deepEqual(
    resolveRunnerContractDirective("runner_contract: full-2x\n"),
    { state: "set", value: "full-2x", requiredRuns: 2 },
  );
});

// ===========================================================================
// (rc-p22) HYK-425 2R P2-2 -- 계약으로만 발화하고(claims=false) 결과 파일에
// exit= 주장이 0일 때 MISSING 사유 앞머리가 "task file declares a runner
// contract"로 갈라진다(검토 1R 표 A 실측). claims=true일 때는 옛 문구
// 그대로(주장 발화 경로, 무회귀).
// ===========================================================================

test("(rc-p22-a)★ full-1x + 주장 0 + 영수증 없음 -> MISSING 사유 앞머리가 'task file declares a runner contract', 'result claims'는 없다", () => {
  withFixtureDir("hyk425-p22a-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a (no exit= idiom anywhere)",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);
    assert.match(result.reason, /task file declares a runner contract/);
    assert.doesNotMatch(result.reason, /result claims/);
  });
});

test("(rc-p22-b) full-1x + 주장 1(exit=0) + 영수증 없음 -> MISSING 사유 앞머리는 옛 문구 'result claims ...' 그대로(무회귀, 주장 발화 경로)", () => {
  withFixtureDir("hyk425-p22b-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: 'npm test; echo "exit=$?"\nexit=0',
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);
    assert.match(
      result.reason,
      /result claims full runner results \(standalone 'exit=<n>' line\)/,
    );
  });
});

// ===========================================================================
// (rc-r1~r3) HYK-425 2R 되돌림 변이 -- §2 item5. 프로덕션 파일은 건드리지
// 않는다(치환은 메모리 문자열에서만, 위 M1~M4와 같은 관례).
// ===========================================================================

test("(rc-r1)★ 되돌림 변이: 근사 매치 분기 전체를 제거하면 -- (rc-nm-a)~(rc-nm-f)가 전부 다시 absent로 접힌다(RED, 근사 매치 거부가 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  // 표준 줄 1개 + 근사 줄 공존도 판정 불가다(조용히 표준만 고르지 마라,\n  // HYK-486) -- standardIndexes에 없는 loose 매치가 하나라도 있으면\n  // (매치 0개뿐이라 전부가 근사 줄인 경우도 포함) 거부한다.\n  const standardIndexes = new Set(matches.map((m) => m.index));\n  const looseMatches = [...scan.matchAll(RUNNER_CONTRACT_LOOSE_RE_G)];\n  const extraLoose = looseMatches.find((m) => !standardIndexes.has(m.index));\n  if (extraLoose) {\n    const lineEnd = scan.indexOf(\"\\n\", extraLoose.index);\n    const lineText = (\n      lineEnd === -1\n        ? scan.slice(extraLoose.index)\n        : scan.slice(extraLoose.index, lineEnd)\n    ).trim();\n    return {\n      state: \"ambiguous\",\n      reason: `task file has a 'runner_contract' line that is not a standalone column-0 'runner_contract: none|full-1x|full-2x' line (near-miss text: '${lineText}') -- 판정 불가 (ambiguous, cannot resolve, HYK-425 2R)`,\n    };\n  }\n";
  assertExactlyOneMatch(src, target, "runner contract near-miss branch");
  const mutated = src.replace(
    target,
    "  // HYK-425 되돌림 변이 R1: 근사 매치 분기 전체 제거\n",
  );

  const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "r1");
  try {
    const r = mod.resolveRunnerContractDirective(
      "runner_contract: full-2x — 설명\n",
    );
    assert.deepEqual(
      r,
      { state: "absent" },
      "RED: with the near-miss branch removed, a tail-decorated line is wrongly treated as 'no contract' again",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

test("(rc-r2)★ 되돌림 변이: 공존 판정만 제거(matches.length===0일 때만 근사를 보게 좁히면) -- (rc-nm-coexist)가 다시 (조용히) set으로 접힌다(RED, 공존 판정이 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target = "  if (extraLoose) {\n";
  assertExactlyOneMatch(src, target, "near-miss coexistence guard");
  const mutated = src.replace(
    target,
    "  if (matches.length === 0 && extraLoose) {\n    // HYK-425 되돌림 변이 R2: 공존 판정 제거(표준 0개일 때만 근사를 본다)\n",
  );

  const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "r2");
  try {
    const r = mod.resolveRunnerContractDirective(
      "runner_contract: full-1x\n- runner_contract: full-2x\n",
    );
    assert.equal(
      r.state,
      "set",
      "RED: with the coexistence guard narrowed to matches.length===0, a standard line coexisting with a near-miss line is silently resolved instead of 판정 불가",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
  }

  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
  );
});

test("(rc-r3)★ 되돌림 변이: P2-2 사유 앞머리 갈래를 제거하면 -- (rc-p22-a)가 다시 옛 'result claims ...' 문구로 접힌다(RED, 갈래가 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "function missingReceiptReasonHead(claims, contractDirective) {\n  if (claims) {\n    return \"result claims full runner results (standalone 'exit=<n>' line)\";\n  }\n  return `task file declares a runner contract ('runner_contract: ${contractDirective?.value}' line)`;\n}\n";
  assertExactlyOneMatch(src, target, "P2-2 missing reason head branch");
  const mutated = src.replace(
    target,
    // HYK-425 되돌림 변이 R3: 갈래 제거 -- claims와 무관하게 항상 옛 문구
    "function missingReceiptReasonHead() {\n  return \"result claims full runner results (standalone 'exit=<n>' line)\";\n}\n",
  );

  await withFixtureDirAsync("hyk425-mut-r3-", async (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a (no exit= idiom anywhere)",
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "r3");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.match(
        result.reason,
        /result claims full runner results/,
        "RED: with the head branch removed, a contract-only activation (no exit= claim) wrongly says 'result claims' again",
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
// (ⓐ~ⓚ) checkRelayHandshake 종단 -- §3 조건2.
// ===========================================================================

test("(rc-a)★ full-1x + 주장 없음 + 영수증 없음 -> RUNNER_RECEIPT_MISSING, 사유에 계약 줄(키·값)이 보인다", () => {
  withFixtureDir("hyk425-a-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a (no exit= idiom anywhere)",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);
    assert.match(result.reason, /runner_contract: full-1x/);
    assert.match(result.reason, /HYK-425/);
  });
});

test("(rc-b) full-1x + 주장 없음 + 정상 영수증(head 일치·exit 0) -> 소비된다", () => {
  withFixtureDir("hyk425-b-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a",
    });
    writeReceipt(dir, baseReceipt(sha));
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, true, `expected consumption: ${result.reason}`);
  });
});

test("(rc-c) full-1x + RED 영수증(runner_exit!=0) -> RED 거부", () => {
  withFixtureDir("hyk425-c-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a",
    });
    writeReceipt(dir, baseReceipt(sha, { runner_exit: 1 }));
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.RED);
  });
});

test("(rc-d) full-1x + 낡은 head 영수증 -> STALE 거부", () => {
  withFixtureDir("hyk425-d-", (dir) => {
    const oldSha = ensureGitHeadCommit(dir);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], {
      cwd: dir,
    });
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a",
    });
    writeReceipt(dir, baseReceipt(oldSha));
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.STALE);
  });
});

test("(rc-e) full-2x + 주장 없음 + 회차 영수증 1개뿐(단일 영수증은 정상) -> 거부(HYK-485 축과 같은 MEASUREMENT_UNAVAILABLE 사유, 계약 줄 언급 포함)", () => {
  withFixtureDir("hyk425-e-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-2x\n",
      resultBody: "verdict: n/a",
    });
    // 단일(latest) 영수증 축은 통과시킨다 -- 이 시험이 고립해서 보는 것은
    // 2회 연속 축(entries.length<2)이다.
    writeReceipt(dir, baseReceipt(sha));
    writeNumberedReceipt(dir, 1, baseReceipt(sha));
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
    assert.match(result.reason, /runner_contract: full-2x/);
  });
});

test("(rc-f) full-2x + 회차 영수증 2개 모두 정상(head 일치·exit 0·finished_at 다름) + 단일 영수증도 정상 -> 소비된다", () => {
  withFixtureDir("hyk425-f-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-2x\n",
      resultBody: "verdict: n/a",
    });
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
    assert.equal(result.ok, true, `expected consumption: ${result.reason}`);
  });
});

test("(rc-g) none(계약으로 명시) + 주장 1회 + 영수증 없음 -> 지금처럼 MISSING 거부(약화 0 -- 계약이 '없음'을 선언해도 실제 주장 기반 요구는 그대로)", () => {
  withFixtureDir("hyk425-g-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: none\n",
      resultBody: 'npm test; echo "exit=$?"\nexit=0',
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.MISSING);
    // none은 "계약이 요구한다"는 선언이 아니므로 발화 사유에 계약 줄을
    // 끌어들이지 않는다(§2 item4 -- 계약이 실제로 발화시켰을 때만 담는다).
    assert.doesNotMatch(result.reason, /runner_contract:/);
  });
});

test("(rc-h) 계약 줄 없음 + 주장 없음 -> 지금처럼 소비(무회귀, 이 축이 생기기 전과 동일)", () => {
  withFixtureDir("hyk425-h-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, { contractLine: "", resultBody: "verdict: n/a" });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, true, `expected consumption: ${result.reason}`);
  });
});

// ===========================================================================
// HYK-425 ③ 근거(HYK-434 H2, coder-task.md §2 point5) -- 완료 조건 대조
// (ORCH-103, 관제실 밖 통역 받는함 "2026-10-15-0743-ORCH103-HYK425완료
// 조건대조-읽기만.md" 전사)가 "417/418 양면 사례가 사례 번호·날짜로 남은
// 픽스처·주석 0"이라 지적한 빈칸을 닫는다. 아래 두 사례는 STATUS.md §6
// HYK-425 행("09-03 같은 날 양면 실측: 417 검토는 막혀 라운드 영구 잠김 /
// 418 은 게이트 skip")이 가리키는 실물을 관제실 원문에서 직접 찾아
// 인용한다(⛔못 찾았으면 "못 찾음"을 적으라는 §1 지시대로, 찾은 것만
// 적는다 -- 전부 찾았다).
//
// ★사례 418(게이트 skip, 아래 (rc-425-3-418)가 픽스처로 고정): 관제실
// `아카이브/2026-09-03-HYK418-421-산출물/hyk418-machine-stamp-1/coder.md`
// 원문(324·508~510·522·611·828행)은 실제 테스트 실패(`npm_test_exit=1`,
// fail 96건 -> 2차 재실행 fail 1건)를 정직하게 보고하면서도 "승계 규율
// 47(열 0에 bare `exit=<n>` 모양 줄을 쓰지 마라)"을 지키려고 그 실패를
// 한 번도 column-0 단독 `exit=<n>` 줄 모양으로는 적지 않았다(예: 611행
// "지난 절들처럼 bare `exit=` 형태는..."). 이 축(HYK-425/HYK-411/
// HYK-485)이 원래 그 리터럴 모양에만 걸렸으므로, 규율을 지킨 이 라운드는
// 구조적으로 그 게이트를 건드리지 못했다(= "게이트 skip" -- 정직한
// 워커일수록 이 축이 안 켜진다는 이 파일 §1 자신의 실측과 같은 모양).
// 이 라운드가 만든 runner_contract 선언 축은 ORCH가 task 파일에 그
// 선언을 실제로 적어야만 닫힌다 -- ⚠️**당시 라운드처럼 task 파일에
// runner_contract가 없는 상태 자체는 이 조각이 손대는 범위 밖이다**
// (coder-task.md §2 범위 밖: "프로덕션 코드 변경"). 아래 픽스처는 그
// 잔여 공백(선언 자체가 없으면 이 축은 여전히 열려 있다)을 정직하게
// 고정한다 -- 약화가 아니라 "지금 실제로 이렇다"의 증거다.
//
// ★사례 417(검토 막혀 라운드 영구 잠김, 근거 주석만 -- 이 축의 픽스처가
// 아니라 "별도 신설" 금지 원칙에 따라 중복 픽스처를 만들지 않는다): 관제실
// `2026-09-03-HYK417-검토지시서-2R.md` §-2R 원문(ORCH 자인) -- "내가
// 소비 전 필수 절차(`runner_exit 0` 확인)를 건너뛰고 핸드셰이크를 먼저
// 돌렸다. 그 핸드셰이크는 영수증 게이트에 거부당했지만 거부하면서 «첫
// 관측»을 박아버렸다. 그 뒤 내가 너에게 시킨 정당한 정정이 결과 파일
// 지문을 바꿔 `DONE_REWRITTEN_AFTER_FIRST_OBSERVATION`으로 영구 거부가
// 됐다 … 1R 라운드는 기계적으로 소비 불가다." -- 이것은 이 파일의 축
// (runner_contract 선언)과는 다른 축(first-observation/rewrite 잠금,
// time-authority.mjs 계열)이 만든 실피해라, 이 조각의 범위(HYK-425
// runner-contract 축) 밖의 코드를 시험하는 새 픽스처를 또 만들지 않는다
// -- "해당 축이 구조적으로 비어 있으면 사람이 수동으로 끼어들다가 다른
// 잠금에 걸린다"는 동기 근거로만 인용한다(이 축이 왜 필요한지의 배경).
// ===========================================================================
test("(rc-425-3-418)★ HYK-425 ③ 실물(2026-09-03, 관제실 hyk418-machine-stamp-1/coder.md): 계약 줄 없음 + 실패를 정직한 산문으로만 보고(bare exit=<n> 0건, 승계 규율 47 준수) -> 지금도 소비된다(잔여 공백, 코드 변경 범위 밖 -- (rc-h)와 같은 축, 실물 인용으로 고정)", () => {
  withFixtureDir("hyk425-418-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "", // 당시 실제 상태: task 파일에 runner_contract 선언 자체가 없었다
      resultBody:
        'npm test; echo "exit=$?"\n' +
        "ℹ tests 5884\nℹ pass 5788\nℹ fail 96\n" +
        "npm_test_exit=1\n" +
        "exit=1이며, 이것이 정직한 최종 상태다 -- bare `exit=` 형태로는 적지 않는다(승계 규율 47)",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(
      result.ok,
      true,
      `잔여 공백 확인(소비돼야 한다 -- 계약 선언이 없고 bare exit=<n> 도 없어 이 축이 구조적으로 안 켜진다): ${result.reason}`,
    );
  });
});

test("(rc-i1) 계약 줄이 인용 밖에 2개(값이 달라도) -> 판정 불가 거부(조용히 하나를 고르지 않는다, HYK-486 선례)", () => {
  withFixtureDir("hyk425-i1-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\nrunner_contract: full-2x\n",
      resultBody: "verdict: n/a",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
    assert.match(result.reason, /standalone 'runner_contract:' lines/);
  });
});

test("(rc-i2) 값이 none/full-1x/full-2x 밖(예: 'full-3x') -> 판정 불가 거부", () => {
  withFixtureDir("hyk425-i2-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-3x\n",
      resultBody: "verdict: n/a",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
    assert.match(result.reason, /is not one of/);
  });
});

test("(rc-i3) 값이 'yes'(세 값 밖) -> 판정 불가 거부", () => {
  withFixtureDir("hyk425-i3-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: yes\n",
      resultBody: "verdict: n/a",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, RUNNER_RECEIPT_REJECT_REASON.INVALID);
  });
});

test("(rc-j) 계약 줄이 펜스 안에만 -> 계약 없음으로 취급(지금 동작) -- 주장도 없으니 정상 소비", () => {
  withFixtureDir("hyk425-j-", (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "```\nrunner_contract: full-2x\n```\n",
      resultBody: "verdict: n/a",
    });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, true, `expected consumption: ${result.reason}`);
  });
});

test("(rc-k) BLOCKED 라운드 + full-2x 계약 -- 이 축이 닿지 않는다(BLOCKED 사유 그대로, §2 item5)", () => {
  withFixtureDir("hyk425-k-", (dir) => {
    ensureGitHeadCommit(dir);
    writeBlockedRound(dir, { contractLine: "runner_contract: full-2x\n" });
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW_MS,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.doesNotMatch(result.reason, /RUNNER_RECEIPT|runner_contract/);
  });
});

test("(rc-l)★ 요구 회차 = max(계약 N, 주장 개수): requiredRuns=1(계약 full-1x 상당)로 넘겨도 resultContent가 실제로 2회 주장하면 2회 연속 축이 여전히 요구된다(약화 금지, §2 item3) -- 회차 영수증 1개뿐이면 거부", () => {
  withFixtureDir("hyk425-l-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(dir, 1, baseReceipt(sha));
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: TWO_RUN_CLAIM_BODY,
      harnessDir: dir,
      requiredRuns: 1,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, RUNNER_RECEIPT_REJECT_REASON.MEASUREMENT_UNAVAILABLE);
  });
});

test("(rc-l-control) 대조군: requiredRuns=1 + resultContent가 실제로 0회 주장 + 회차 영수증 1개뿐 -> 2회 연속 축은 여전히 skip(과차단 아님, full-1x는 2회 연속 축을 켜지 않는다)", () => {
  withFixtureDir("hyk425-l-control-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(dir, 1, baseReceipt(sha));
    const r = resolveConsecutiveRunnerReceiptsVerdict({
      resultContent: "verdict: n/a",
      harnessDir: dir,
      requiredRuns: 1,
    });
    assert.deepEqual(r, { ok: true, skipped: true });
  });
});

// ===========================================================================
// (M1~M4) 되돌림 변이 -- §3 조건3. 프로덕션 파일은 건드리지 않는다(치환은
// 메모리 문자열에서만, relay-handshake-runner-receipt.test.mjs의 관례 그대로).
// ===========================================================================

test("(rc-m1)★ 되돌림 변이: 계약 줄 판독을 항상 '없음'으로 끄면 -- (rc-a)/(rc-c)/(rc-d)/(rc-e)가 다시 소비/skip으로 접힌다(RED, load-bearing 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    'export function resolveRunnerContractDirective(taskContent) {\n  if (typeof taskContent !== "string") return { state: "absent" };\n';
  assertExactlyOneMatch(src, target, "runner contract directive entry");
  const mutated = src.replace(
    target,
    'export function resolveRunnerContractDirective(taskContent) {\n  return { state: "absent" }; // HYK-425 되돌림 변이 M1: 계약 줄 판독을 항상 "없음"으로 끈다\n  if (typeof taskContent !== "string") return { state: "absent" };\n',
  );
  await withFixtureDirAsync("hyk425-mut-m1-", async (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\n",
      resultBody: "verdict: n/a (no exit= idiom anywhere)",
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "m1");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with contract reading disabled, a full-1x round with no claim and no receipt is wrongly consumed as success",
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

test("(rc-m2)★ 되돌림 변이: '요구 회차 = max(계약, 주장)'을 계약 우선(주장 무시)으로 바꾸면 -- (rc-l)의 재현 표본이 다시 skip으로 접힌다(RED, 약화 금지 축이 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  const effectiveRequired = Math.max(requiredRuns, claimCount);\n";
  assertExactlyOneMatch(src, target, "consecutive gate max(contract, claim)");
  const mutated = src.replace(
    target,
    "  const effectiveRequired = requiredRuns; // HYK-425 되돌림 변이 M2: 계약 우선(주장 무시)\n",
  );

  await withFixtureDirAsync("hyk425-mut-m2-", async (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeNumberedReceipt(dir, 1, baseReceipt(sha));
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "m2");
    try {
      const r = mod.resolveConsecutiveRunnerReceiptsVerdict({
        resultContent: TWO_RUN_CLAIM_BODY,
        harnessDir: dir,
        requiredRuns: 1,
      });
      assert.deepEqual(
        r,
        { ok: true, skipped: true },
        "RED: with the max() weakened to contract-only, a real 2-claim round with only 1 numbered receipt is wrongly skipped again",
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

test("(rc-m3)★ 되돌림 변이: 계약 줄 판독의 인용/펜스 마스킹을 제거하면 -- (rc-j)의 펜스-안-계약 표본이 더 이상 '계약 없음'으로 접히지 않고 거부로 바뀐다(RED, 마스킹이 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  const scan = maskQuotedMarkerRegions(taskContent);\n  const matches = [...scan.matchAll(RUNNER_CONTRACT_RE_G)];\n";
  assertExactlyOneMatch(src, target, "runner contract masking");
  const mutated = src.replace(
    target,
    "  const scan = taskContent; // HYK-425 되돌림 변이 M3: 인용/펜스 마스킹 제거\n  const matches = [...scan.matchAll(RUNNER_CONTRACT_RE_G)];\n",
  );

  await withFixtureDirAsync("hyk425-mut-m3-", async (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "```\nrunner_contract: full-2x\n```\n",
      resultBody: "verdict: n/a",
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "m3");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.equal(
        result.ok,
        false,
        "RED: with masking removed, a fenced-only contract line is wrongly treated as a real declaration (was ok:true before this mutation)",
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

test("(rc-m4)★ 되돌림 변이: 모호 거부(같은 키 2개 이상)를 제거하고 첫 줄을 조용히 채택하면 -- (rc-i1)의 재현 표본이 다시 (조용히) 다른 결과로 접힌다(RED, '판정 불가' 축이 load-bearing임을 증명)", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  if (matches.length > 1) {\n    return {\n      state: \"ambiguous\",\n      reason: `task file has ${matches.length} standalone 'runner_contract:' lines -- 어느 것이 최종인지 결정할 수 없다 (ambiguous, cannot resolve, HYK-425)`,\n    };\n  }\n";
  assertExactlyOneMatch(src, target, "runner contract ambiguous-count reject");
  const mutated = src.replace(
    target,
    "  // HYK-425 되돌림 변이 M4: 모호 거부 제거 -- 첫 줄을 조용히 채택한다\n",
  );

  await withFixtureDirAsync("hyk425-mut-m4-", async (dir) => {
    ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      contractLine: "runner_contract: full-1x\nrunner_contract: full-2x\n",
      resultBody: "verdict: n/a",
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(mutated, "m4");
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW_MS,
      });
      assert.notEqual(
        result.code,
        RUNNER_RECEIPT_REJECT_REASON.INVALID,
        "RED: with the ambiguous-count rejection removed, a duplicated contract line is silently resolved (first line wins) instead of 판정 불가",
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
