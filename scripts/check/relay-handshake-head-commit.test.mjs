// HYK-383: 검토 결과 계약의 자기확인이 dispatch/pane 일치뿐이라 «엉뚱한
// 커밋을 열심히 검토»해도 형식은 전부 통과했다(2026-08-28 19:07 실사고,
// HYK-377 review-5 -- 표지 task_id·dispatch·pane 전부 일치했으나 본문은
// 직전 라운드 커밋(1285e2f)을 판정했고, 검토자 워크트리 HEAD도 그 값에서
// 한 번도 움직이지 않았다). 이 시험은 relay-handshake.mjs의 새 head_commit:
// 축(§2, resolveHeadCommitBinding)이 소비 경로에서 실제로 거부를 만드는지
// 실 CLI(§5의 «실제 소비 명령»)와 in-process 양쪽으로 고정한다.
//
// ⛔실물 원장·곁파일 무접촉: 모든 fixture는 mkdtemp 안에 새로 만든 합성
// git 저장소다 -- 이 실행이 만드는 어떤 파일도 이 워크트리(실물 .harness)
// 밖/안 어디에도 실제 원장을 건드리지 않는다(REVIEW-family 원장 기록은
// mainRepoRoot()가 fixture 자신의 mkdtemp 저장소로 해석되므로 격리된다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveHeadCommitBinding,
} from "./relay-handshake.mjs";
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

// HYK-353/HYK-244 ci-repair-1의 같은 함정: fn이 async면 `fn(dir)`는 Promise를
// 즉시 반환하고, await 없이는 바로 이어지는 finally의 rmSync가 그 비동기
// 작업이 실제로 끝나기 «전에» dir를 지워 버리는 경쟁 조건이 된다 -- 그래서
// async fn을 넘기는 호출자(아래 (8) 되돌림 변이 시험들)는 반드시 이
// async 변형을 쓰고 반드시 await한다.
async function withFixtureDirAsync(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 진짜 git 저장소를 만들고 그 실제 HEAD(40-hex SHA)를 반환한다 -- 축 ⓑ가
// `git rev-parse HEAD`로 harnessDir를 직접 읽으므로, REVIEW 계열 정상
// 표본은 항상 이 안에서 만들어야 한다.
function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "head-commit test fixture"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function writeReviewRound(
  dir,
  { taskHeadCommit, resultHeadCommit, extra = "" },
) {
  writeFileSync(
    join(dir, "review-task.md"),
    `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\n${taskHeadCommit ?? ""}`,
    "utf8",
  );
  writeFileSync(
    join(dir, "review.md"),
    // HYK-418 §2-1: relay-handshake now rejects a well-formed DONE line
    // with no finalize-done marker (fail-closed) -- carry the marker so
    // this shared fixture keeps exercising the head-commit binding
    // mechanics under test, not this promotion's rejection.
    `task_id: HYK-383-T\n${resultHeadCommit ?? ""}${extra}\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

// ⛔호출자가 넘긴 role/harnessDir을 §5의 «실제 소비 명령»(정본 CLI)에
// 그대로 넘긴다 -- checkRelayHandshake를 직접 부르는 것과 달리, 여기는
// 프로덕션 진입점(invokedDirectly 블록) 자체를 spawn한다.
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
// (1) 정상 경로 무회귀: task/result의 head_commit이 서로 일치하고, 그 값이
// 검토자 워크트리의 실제 HEAD와도 일치하면 -- 그대로 소비 성공(exit 0).
// ---------------------------------------------------------------------------
test("(head-1) 정상 경로: task/result head_commit이 실제 워크트리 HEAD와 삼중 일치 -> 실 CLI exit 0, 소비 성공", () => {
  withFixtureDir("hyk383-normal-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeReviewRound(dir, {
      taskHeadCommit: `head_commit: ${sha}\n`,
      resultHeadCommit: `head_commit: ${sha}\n`,
    });
    const res = runCli(["review", dir]);
    assert.equal(res.exit, 0, `expected clean pass, got stderr: ${res.stderr}`);
  });
});

// ---------------------------------------------------------------------------
// (2) 완료조건1+2: 어긋난 커밋 거부 + 오늘의 실사고 재현이 잡힌다.
// task는 새 커밋(FAKE_NEW, 실제로 만들어진 적 없는 값이라도 문자열
// 대조로 충분하다)을 지정했지만, 검토자 워크트리 HEAD는 옛 커밋(SHA)에
// 머물러 있고, 결과도 «정직하게» 그 옛 값을 신고한다 -- 축 ⓑ(결과 vs
// 실물)는 내부적으로 일치하므로 축 ⓑ 단독으로는 절대 못 잡는다(coder-
// task.md §2 원문 "ⓑ만 있으면 ... 그대로 통과한다"). 축 ⓐ(결과 vs 배달
// 지정값)만이 이 표본을 잡는다.
// ---------------------------------------------------------------------------
const FAKE_NEW_COMMIT = "f".repeat(40);

test("(head-2)★ 완료조건1+2: task가 지정한 새 커밋과 다른, 정직하게 신고된 옛 커밋 -> 실 CLI exit 1, 축 ⓐ 사유로 거부(오늘의 실사고 재현)", () => {
  withFixtureDir("hyk383-repro-", (dir) => {
    const staleSha = ensureGitHeadCommit(dir); // 워크트리는 여기서 멈춘다 -- 다음 라운드 커밋이 일어나지 않았다.
    writeReviewRound(dir, {
      taskHeadCommit: `head_commit: ${FAKE_NEW_COMMIT}\n`, // 배달이 지정한 "다음" 커밋
      resultHeadCommit: `head_commit: ${staleSha}\n`, // 검토자가 정직하게 신고한, 실제로 머문 옛 커밋
    });
    const res = runCli(["review", dir]);
    assert.notEqual(
      res.exit,
      0,
      "mismatched-commit review result must be rejected",
    );
    assert.match(res.stderr, /head_commit mismatch/);
    assert.match(res.stderr, /축 ⓐ/);
  });
});

// ---------------------------------------------------------------------------
// (3) 위조 시도 ⓐ: 결과가 배달 지정값을 그대로 베껴 쓰지만(축 ⓐ 통과),
// 실제 워크트리 HEAD는 다르다(그 사이 새 커밋이 생겼다) -- 축 ⓑ가 잡는다.
// ---------------------------------------------------------------------------
test("(head-3)★ 완료조건6 위조ⓐ: 결과가 지정값을 그대로 베꼈지만 실제 HEAD는 다르다 -> 거부(축 ⓑ)", () => {
  withFixtureDir("hyk383-forge-a-", (dir) => {
    const firstSha = ensureGitHeadCommit(dir);
    // task는 firstSha를 지정한다 -- 그런데 검토자가 응답을 쓰기 전에
    // 워크트리가 다음 커밋으로 이미 옮겨갔다(2026-08-28 실사고의 반대
    // 형태: 이번엔 워크트리가 "너무 앞서" 있다).
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], {
      cwd: dir,
    });
    const actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    assert.notEqual(actualSha, firstSha);
    writeReviewRound(dir, {
      taskHeadCommit: `head_commit: ${firstSha}\n`,
      resultHeadCommit: `head_commit: ${firstSha}\n`, // 지정값을 그대로 베낀 위조
    });
    const res = runCli(["review", dir]);
    assert.notEqual(
      res.exit,
      0,
      "copied-but-wrong-HEAD review result must be rejected",
    );
    assert.match(res.stderr, /head_commit mismatch/);
    assert.match(res.stderr, /축 ⓑ/);
  });
});

// ---------------------------------------------------------------------------
// (4) 위조 시도 ⓑ: head_commit:을 문장 한가운데 숨긴다 -- column-0 독립
// 줄 앵커 요건 위반, MID_LINE으로 거부.
// ---------------------------------------------------------------------------
test("(head-4) 완료조건6 위조ⓑ: head_commit:을 문장 중간에 숨기면 -> 거부(column-0 앵커 위반)", () => {
  withFixtureDir("hyk383-forge-b-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-383-T\nnote: this round's head_commit: ${sha} is embedded mid sentence\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(
      res.exit,
      0,
      "mid-line head_commit must never be accepted as a cover line",
    );
    assert.match(res.stderr, /not a standalone column-0/);
  });
});

// ---------------------------------------------------------------------------
// (5) fail-closed 4종 -- 표지 부재 / 형식 위반 / 지정 커밋 부재 / git 조회
// 실패, 각각 거부(⛔통과로 접지 않는다).
// ---------------------------------------------------------------------------
test("(head-5a) fail-closed: result에 head_commit 표지 자체가 없다 -> 거부", () => {
  withFixtureDir("hyk383-fc-missing-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-383-T\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /missing head_commit header/);
  });
});

test("(head-5b) fail-closed: head_commit 값이 40-hex가 아니다(형식 위반) -> 거부", () => {
  withFixtureDir("hyk383-fc-format-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      // 39자(한 자리 부족) -- 40-hex SHA 계약 위반.
      `task_id: HYK-383-T\nhead_commit: ${sha.slice(0, 39)}\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(
      res.stderr,
      /not a standalone column-0|missing head_commit header/,
    );
  });
});

test("(head-5c) fail-closed: task 파일에 지정 커밋 자체가 없다 -> 거부", () => {
  withFixtureDir("hyk383-fc-notask-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-383-T\nhead_commit: ${sha}\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /task file missing head_commit header/);
  });
});

test("(head-5d) fail-closed: harnessDir가 애초에 git 워크트리가 아니다(rev-parse 실패) -> 거부, «확인 못하니 통과» 금지", () => {
  withFixtureDir("hyk383-fc-nogit-", (dir) => {
    // ⛔git init을 절대 하지 않는다 -- 진짜 워크트리가 아닌 상태를 재현.
    const sha = "a".repeat(40);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-383-T\nhead_commit: ${sha}\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(
      res.exit,
      0,
      "a non-worktree harnessDir must fail-closed, never silently pass",
    );
    assert.match(res.stderr, /git rev-parse HEAD failed/);
  });
});

// ---------------------------------------------------------------------------
// (6) AMBIGUOUS: head_commit 표지가 2개 이상이면 -- 어느 것이 최종인지
// 결정할 수 없다(기존 task_id 다중 처리와 같은 결).
// ---------------------------------------------------------------------------
test("(head-6) AMBIGUOUS: result에 head_commit: 줄이 2개 -> 거부, 둘 중 하나로 조용히 고르지 않는다", () => {
  withFixtureDir("hyk383-ambiguous-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-383-T\nhead_commit: ${sha}\nhead_commit: ${sha}\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /ambiguous, cannot resolve/);
  });
});

// ---------------------------------------------------------------------------
// (6b) HYK-383 2R §2 (검토 1R P2 실측): 대소문자 신원 -- 대문자
// `HEAD_COMMIT:`은 더 이상 표지로 인정되지 않는다(1R은 `gim` 플래그라
// 수락했었다, 검토자가 직접 probe해 실측). column-0 독립 줄에 유효한
// 40-hex 값이라도 대문자면 근사매치(malformed)로 거부된다 -- "missing"이
// 아니라 더 정확한 진단을 준다.
// ---------------------------------------------------------------------------
test("(head-6b)★ 대소문자 신원: 대문자 HEAD_COMMIT:(column-0, 유효 40-hex)는 표지로 인정되지 않고 거부된다", () => {
  withFixtureDir("hyk383-uppercase-", (dir) => {
    const sha = ensureGitHeadCommit(dir);
    writeFileSync(
      join(dir, "review-task.md"),
      `task_id: HYK-383-T\ndropped_at: 2026-08-28 06:00 KST\nhead_commit: ${sha}\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      `task_id: HYK-383-T\nHEAD_COMMIT: ${sha}\n\n>>> DONE: REVIEW @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n`,
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(
      res.exit,
      0,
      "uppercase HEAD_COMMIT: must no longer be accepted as a valid cover line",
    );
    assert.match(res.stderr, /not a standalone column-0/);
  });
});

// ---------------------------------------------------------------------------
// (7) 범위 확인: CODER 결과는 이 축 밖이다(coder-task.md §2 범위, 작성자는
// 커밋을 만들며 그 라운드 안에서 HEAD가 움직이므로 정적 대조가 성립하지
// 않는다) -- head_commit이 전혀 없어도 CODER 라운드는 그대로 통과해야
// 한다(§4 무회귀).
// ---------------------------------------------------------------------------
test("(head-7) 범위 확인: CODER 결과는 head_commit 축 밖 -- 표지가 전혀 없어도 그대로 소비 성공", () => {
  withFixtureDir("hyk383-coder-scope-", (dir) => {
    writeFileSync(
      join(dir, "coder-task.md"),
      "task_id: HYK-383-C\ndropped_at: 2026-08-28 06:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "coder.md"),
      "task_id: HYK-383-C\n\n>>> DONE: CODER @ 2026-08-28 06:10:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      true,
      `CODER rounds must never be gated by head_commit: ${result.reason}`,
    );
  });
});

test("(head-7b) resolveHeadCommitBinding 직접 확인: 비REVIEW role은 즉시 {ok:true, skipped:true}", () => {
  const r = resolveHeadCommitBinding({
    role: "coder",
    taskContent: "task_id: X\n",
    resultContent: "task_id: X\n",
    harnessDir: "/does/not/matter",
  });
  assert.deepEqual(r, { ok: true, skipped: true });
});

// ---------------------------------------------------------------------------
// (8) 되돌림 변이 -- 완료조건5: 축 ⓐ·ⓑ 각각 1건씩 무력화하면 정확히 그
// 시험만 RED. 이 저장소의 기존 관례(relay-handshake.test.mjs의 "경로
// 조립에서 소문자화를 제거하면..." 류)와 동일하게, 소스를 문자열 치환해
// 격리 사본을 만들고 동적 import로 실행한다.
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
  const mutDir = mkdtempSync(join(tmpdir(), `hyk383-mut-${label}-`));
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

test("(head-8a)★ 되돌림 변이: 축 ⓐ(지정 대조) 비교를 제거하면 -- (head-2)의 «정직한 옛 커밋» 표본이 다시 통과한다(RED, 이 축이 load-bearing임을 증명)", async () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "  // 축 ⓐ(지정 대조): 결과가 배달이 지정한 대상 커밋과 같은가.\n  if (resultHead.sha !== taskHead.sha) {\n    return {\n      ok: false,\n      reason: `head_commit mismatch (축 ⓐ 지정 대조, HYK-383): task dispatch specifies '${taskHead.sha}' but result echoes '${resultHead.sha}' -- 배달이 지정한 대상 커밋과 결과가 판정했다고 신고한 커밋이 다르다`,\n    };\n  }\n";
  assertExactlyOneMatch(src, target, "axis-A comparison block");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk383-mut-a-fixture-", async (dir) => {
    const staleSha = ensureGitHeadCommit(dir);
    writeReviewRound(dir, {
      taskHeadCommit: `head_commit: ${FAKE_NEW_COMMIT}\n`,
      resultHeadCommit: `head_commit: ${staleSha}\n`,
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      mutated,
      "axis-a",
    );
    try {
      const result = mod.checkRelayHandshake({
        role: "review",
        harnessDir: dir,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with axis A removed, the (head-2) mismatched-designation sample wrongly passes -- proving axis A alone catches it",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

test("(head-8b)★ 되돌림 변이: 축 ⓑ(실물 대조) 비교를 제거하면 -- (head-3)의 «지정값 위조» 표본이 다시 통과한다(RED, 이 축이 load-bearing임을 증명)", async () => {
  const src = readFileSync(CLI_PATH, "utf8");
  const target =
    "  if (resultHead.sha !== actualHead.sha) {\n    return {\n      ok: false,\n      reason: `head_commit mismatch (축 ⓑ 실물 대조, HYK-383): result echoes '${resultHead.sha}' but the reviewer worktree's actual HEAD ('${harnessDir}') is '${actualHead.sha}' -- 엉뚱한 커밋에 머문 채 그 커밋을 정직하게 신고했더라도 거부한다(2026-08-28 19:07 실사고 재현 방지)`,\n    };\n  }\n";
  assertExactlyOneMatch(src, target, "axis-B comparison block");
  const mutated = src.replace(target, "");

  await withFixtureDirAsync("hyk383-mut-b-fixture-", async (dir) => {
    const firstSha = ensureGitHeadCommit(dir);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "moved on"], {
      cwd: dir,
    });
    writeReviewRound(dir, {
      taskHeadCommit: `head_commit: ${firstSha}\n`,
      resultHeadCommit: `head_commit: ${firstSha}\n`,
    });
    const { mod, mutDir } = await importMutatedRelayHandshake(
      mutated,
      "axis-b",
    );
    try {
      const result = mod.checkRelayHandshake({
        role: "review",
        harnessDir: dir,
      });
      assert.equal(
        result.ok,
        true,
        "RED: with axis B removed, the (head-3) copied-but-stale-worktree sample wrongly passes -- proving axis B alone catches it",
      );
    } finally {
      rmSync(mutDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (9) 순서 회귀 0: head_commit 축은 다른 사유별 거부(예: future-skew)
// «뒤에» 걸린다 -- 이미 다른 이유로 거부되는 라운드는 여전히 그 원래
// 사유로 거부된다(§4 무회귀: 이 축이 기존 거부 사유를 가리지 않는다).
// ---------------------------------------------------------------------------
test("(head-9) 순서 회귀 0: head_commit이 아예 없어도, 이미 future-skew로 거부되는 라운드는 여전히 future-skew 사유로 거부된다(가리지 않는다)", () => {
  withFixtureDir("hyk383-order-", (dir) => {
    // ⛔head_commit 표지를 아예 쓰지 않는다 -- 그런데도 future-skew가 먼저
    // 걸려야 한다(head_commit 축이 그 사유를 가려서는 안 된다).
    writeFileSync(
      join(dir, "review-task.md"),
      "task_id: HYK-383-T\ndropped_at: 2026-08-01 00:00 KST\n",
      "utf8",
    );
    writeFileSync(
      join(dir, "review.md"),
      "task_id: HYK-383-T\n\n>>> DONE: REVIEW @ 2099-01-01 00:00:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );
    const res = runCli(["review", dir]);
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /ahead of authority now/);
    assert.doesNotMatch(res.stderr, /head_commit/);
  });
});
