// HYK-424 (coder-task.md §1): 419-wire-2/422-dispatch-run-1 실사고 --
// 워커가 결과 파일 `head_commit:`에 "이 라운드의 base"(지시서가 선언한
// 값)를 그대로 베껴 썼다(자기 커밋이 아님). resolveHeadCommitBinding
// (HYK-383)은 REVIEW 계열에만 걸린다(coder-task.md §2 범위 -- CODER는
// 이 축 밖, relay-handshake-head-commit.test.mjs (head-7) 참조) -- 즉
// 지금 코드에서 CODER 라운드의 head_commit 필드는 "이 라운드의 base를
// 그대로 베꼈는지" 전혀 확인되지 않는다. 이 시험은 relay-handshake.mjs의
// 새 축(resolveBaseCopyGuard, §2 product_scope ①)이 그 구멍을 실제로
// 막는지 실 CLI와 in-process 양쪽으로 고정한다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtemp 안에 새로 만든 합성
// git 저장소다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { resolveBaseCopyGuard } from "./relay-handshake.mjs";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 진짜 git 저장소를 만들고 그 실제 HEAD(40-hex SHA)를 반환한다.
function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "base-copy test fixture"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function makeAnotherCommit(dir) {
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "worker's own commit"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function writeCoderRound(dir, { taskExtra = "", resultExtra = "" }) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: HYK-424-C\ndropped_at: 2026-11-04 06:00 KST\n${taskExtra}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: HYK-424-C\n${resultExtra}\n>>> DONE: CODER @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env: isolatedChildEnv(),
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
// (bc-1)★ 실사고 재현 표본 ⓘ: 레거시 CODER 머리의 `head_commit:` 키가
// "base"를 선언하고, 결과가 그 base를 그대로 베꼈다(실제 HEAD는 그 뒤
// 다른 커밋으로 움직였다) -- 전용 사유로 거부.
// ---------------------------------------------------------------------------
test("(bc-1)★ 완료조건1+2: 레거시 CODER 머리 head_commit:(=base) + 결과가 그 base를 그대로 베낌(실제 HEAD는 다름) -> 실 CLI exit 1, base-copy 전용 사유", () => {
  withFixtureDir("hyk424-legacy-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    makeAnotherCommit(dir); // 워커가 실제로 커밋을 만들었다 -- HEAD는 base에서 움직였다.
    writeCoderRound(dir, {
      taskExtra: `head_commit: ${baseSha}\n`, // 레거시 표기: 이 라운드의 base
      resultExtra: `head_commit: ${baseSha}\n`, // 사고: base를 그대로 베낌
    });
    const res = runCli(["coder", dir]);
    assert.notEqual(res.exit, 0, `base-copy must be rejected: ${res.stdout}`);
    assert.match(res.stderr, /base를 베꼈다/);
    assert.match(res.stderr, /HYK-424/);
  });
});

// ---------------------------------------------------------------------------
// (bc-2)★ 실사고 재현 표본 ⓘⓘ: 정식 키 `base_commit_of_this_round:`로
// base를 선언한 경우도 같은 사고가 같은 사유로 잡혀야 한다.
// ---------------------------------------------------------------------------
test("(bc-2)★ 완료조건1+2: 정식 base_commit_of_this_round: + 결과가 그 base를 그대로 베낌(실제 HEAD는 다름) -> 실 CLI exit 1, base-copy 전용 사유", () => {
  withFixtureDir("hyk424-formal-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    makeAnotherCommit(dir);
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const res = runCli(["coder", dir]);
    assert.notEqual(res.exit, 0, `base-copy must be rejected: ${res.stdout}`);
    assert.match(res.stderr, /base를 베꼈다/);
    assert.match(res.stderr, /base_commit_of_this_round/);
  });
});

// ---------------------------------------------------------------------------
// (bc-3) 수리 뒤 통과: 결과가 실제로 만든 커밋(=실제 HEAD)을 정직하게
// 적으면 -- base-copy 축은 통과한다(§4 무회귀: 정직한 CODER 결과는 계속
// 받아들여진다).
// ---------------------------------------------------------------------------
test("(bc-3) 정상 경로: 결과 head_commit이 워커가 실제로 만든 커밋(실제 HEAD)과 같다 -> base-copy 축 통과", () => {
  withFixtureDir("hyk424-honest-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    const ownSha = makeAnotherCommit(dir);
    assert.notEqual(ownSha, baseSha);
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${ownSha}\n`,
    });
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// (bc-4) base가 선언되지 않은 CODER 라운드(§4 무회귀): head_commit 필드가
// 전혀 없는 보통 CODER 결과는 그대로 통과한다(기존 (head-7) 범위와 동일).
// ---------------------------------------------------------------------------
test("(bc-4) 무회귀: base 선언이 없는 보통 CODER 라운드는 head_commit 필드가 없어도 그대로 통과", () => {
  withFixtureDir("hyk424-nobase-", (dir) => {
    writeCoderRound(dir, { taskExtra: "", resultExtra: "" });
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// (bc-5) 0-커밋 라운드(무회귀): 실제 HEAD가 base와 같을 때(그 라운드에
// 새 커밋이 없다) base를 echo하는 것은 정직한 값이다 -- 거부하지 않는다.
// ---------------------------------------------------------------------------
test("(bc-5) 무회귀: 실제 HEAD == base인 라운드(0-커밋)에서 결과가 base를 echo해도 base-copy로 오인하지 않는다", () => {
  withFixtureDir("hyk424-zerocommit-", (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`, // HEAD가 실제로 base에 그대로 머물러 있다 -- 정직.
    });
    const res = runCli(["coder", dir]);
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// (bc-6) 과차단 0(REVIEW): REVIEW 머리의 head_commit:(=판정 대상 커밋)은
// 이 축의 "base 선언"으로 읽히지 않는다 -- 정상 REVIEW 라운드(task/result/
// 실제 HEAD 삼중 일치)는 이 축 때문에 거부되지 않는다.
// ---------------------------------------------------------------------------
test("(bc-6) 과차단 0: REVIEW 라운드의 정상 head_commit 삼중 일치는 base-copy 축을 절대 건드리지 않는다", () => {
  withFixtureDir("hyk424-review-ok-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-424-R\ndropped_at: 2026-11-04 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-424-R\nhead_commit: ${sha}\n\n>>> DONE: REVIEW @ 2026-11-04 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// (bc-7) 과차단 0(REVIEW, in-process 직접 확인): REVIEW 라운드에서 task의
// head_commit이 base_commit_of_this_round 부재 상태로 "레거시 base"로
// 오인되지 않는지 resolveBaseCopyGuard를 직접 호출해 확인한다 -- role이
// REVIEW 계열이면 legacy fallback 자체가 비활성(declared:false)이어야
// 한다.
// ---------------------------------------------------------------------------
test("(bc-7) resolveBaseCopyGuard 직접 확인: REVIEW role은 레거시 head_commit 머리를 base로 읽지 않는다(declared:false -> skipped)", () => {
  const r = resolveBaseCopyGuard({
    role: "review",
    taskContent: `task_id: X\nhead_commit: ${"a".repeat(40)}\n`,
    resultContent: `task_id: X\nhead_commit: ${"a".repeat(40)}\n`,
    harnessDir: "/does/not/matter",
  });
  assert.deepEqual(r, { ok: true, skipped: true });
});

// ---------------------------------------------------------------------------
// (bc-8) 되돌림 변이 -- base 대조를 "head_commit == base"만으로(실제 HEAD
// 비교를 제거) 되돌리면 (bc-3)의 "정직하게 자기 커밋을 적은" 표본이
// 거짓으로 거부되거나, 반대로 실제 HEAD 비교 없이 base 일치만으로 거부가
// 뒤집히는지가 아니라 -- 여기서는 "실제 HEAD 비교"가 빠지면 (bc-5) 0-커밋
// 표본과 (bc-1) 사고 표본을 가르지 못하게 된다는 것을 보인다: 비교를
// 제거한 채로는 (bc-1)의 거부 여부가 "실제 HEAD와 무관하게 항상 거부"로
// 바뀐다 -- 그러면 (bc-5)(정직한 0-커밋 echo)도 거부돼야 하므로 RED.
// ---------------------------------------------------------------------------
async function withFixtureDirAsync(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

async function importMutatedRelayHandshake(mutatedSrc, label) {
  const mutDir = mkdtempSync(join(tmpdir(), `hyk424-mut-${label}-`));
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(mutDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  const mutPath = join(mutDir, "relay-handshake.mjs");
  writeFileSync(mutPath, mutatedSrc, "utf8");
  const mod = await import(`${pathToFileURL(mutPath).href}?t=${Date.now()}`);
  return { mod, mutDir };
}

test("(bc-8)★ 되돌림 변이: 실제 HEAD 비교를 제거하고 base 선언만으로 거부하면 -- (bc-5) 0-커밋 정직 echo가 거짓으로 거부된다(RED, 실제 HEAD 비교가 load-bearing임을 증명)", async () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "  if (actualHead.sha === declaredBase.sha) {\n    return { ok: true, skipped: true };\n  }\n\n";
  assertExactlyOneMatch(src, target, "actual-HEAD-equals-base early return");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk424-mut-head-check-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    writeCoderRound(dir, {
      taskExtra: `base_commit_of_this_round: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`, // 0-커밋 라운드 -- 정직한 echo.
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      mutated,
      "no-actual-head-exemption",
    );
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
      });
      assert.equal(
        result.ok,
        false,
        "RED: without the actual-HEAD-equals-base exemption, an honest 0-commit echo is wrongly rejected -- proving that comparison is load-bearing",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

test("(bc-9)★ 되돌림 변이: resolveBaseCopyGuard 호출 자체를 checkRelayHandshake에서 제거하면 -- (bc-1) 사고 표본이 다시 통과한다(RED, 결선이 load-bearing임을 증명)", async () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "  const baseCopyVerdict = resolveBaseCopyRejection(core, role, harnessDir);\n  if (baseCopyVerdict) return baseCopyVerdict;\n\n";
  assertExactlyOneMatch(src, target, "baseCopyVerdict call site");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk424-mut-wire-", async (dir) => {
    const baseSha = ensureGitHeadCommit(dir);
    makeAnotherCommit(dir);
    writeCoderRound(dir, {
      taskExtra: `head_commit: ${baseSha}\n`,
      resultExtra: `head_commit: ${baseSha}\n`,
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      mutated,
      "unwired",
    );
    try {
      const result = mod.checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with the call site removed, the (bc-1) base-copy sample wrongly passes -- proving the wiring itself is load-bearing",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});
