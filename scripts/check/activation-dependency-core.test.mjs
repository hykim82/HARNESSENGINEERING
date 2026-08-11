// HYK-226-activation-invariant-1 (coder-task.md) -- tests for
// activation-dependency-core.mjs. §2 RED->GREEN reproduction uses
// SYNTHETIC git fixtures only (mkdtempSync + `git init`) -- never the real
// 관제실 repo/files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeActivationDependency,
  extractRepoPathReferences,
  ACTIVATION_DEPENDENCY_STATE,
} from "./activation-dependency-core.mjs";

test("activation-dependency-core.mjs has zero import statements (pure core contract)", () => {
  const text = readFileSync(
    new URL("./activation-dependency-core.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(/^import /m.test(text), false);
});

// ---------------------------------------------------------------------------
// extractRepoPathReferences
// ---------------------------------------------------------------------------

test("extractRepoPathReferences: pulls quoted repo-relative paths out of ps1-style patch text", () => {
  const text =
    '$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"\n' +
    '$gateScript = Join-Path $Worktree "scripts/check/dispatch-gate-decision.mjs"\n';
  const refs = extractRepoPathReferences(text);
  assert.deepEqual(refs, [
    "scripts/supervisor/admission-cli.mjs",
    "scripts/check/dispatch-gate-decision.mjs",
  ]);
});

test("extractRepoPathReferences: dedupes repeated references, preserves first-seen order", () => {
  const text =
    "a/b.mjs referenced twice: a/b.mjs and once more a/b.mjs, then c/d.mjs";
  assert.deepEqual(extractRepoPathReferences(text), ["a/b.mjs", "c/d.mjs"]);
});

test("extractRepoPathReferences: does not mistake an https URL subpath for a repo path", () => {
  const text =
    "see https://example.com/some/dir/readme.md for background, plus scripts/x/y.mjs";
  assert.deepEqual(extractRepoPathReferences(text), ["scripts/x/y.mjs"]);
});

test("extractRepoPathReferences: no slash -> not a reference (bare filename ignored)", () => {
  assert.deepEqual(
    extractRepoPathReferences("just admission-cli.mjs alone"),
    [],
  );
});

test("extractRepoPathReferences: empty/non-string input -> empty array", () => {
  assert.deepEqual(extractRepoPathReferences(""), []);
  assert.deepEqual(extractRepoPathReferences("   "), []);
  assert.deepEqual(extractRepoPathReferences(undefined), []);
  assert.deepEqual(extractRepoPathReferences(null), []);
});

// ---------------------------------------------------------------------------
// judgeActivationDependency -- closed state set with a FAKE checker
// (behavioral contract of the checker's return value, no git involved)
// ---------------------------------------------------------------------------

test("ALLOW: 1+ references extracted, all report exists:true", () => {
  const r = judgeActivationDependency({
    patchText: "scripts/a/b.mjs and scripts/c/d.mjs",
    ref: "origin/master",
    checkRefPathExists: () => true,
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.ALLOW);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.missing, []);
  assert.equal(r.references.length, 2);
});

test("REJECT_UNMERGED_DEPENDENCY: at least one reference reports exists:false", () => {
  const seen = [];
  const r = judgeActivationDependency({
    patchText: "scripts/a/b.mjs and scripts/c/d.mjs",
    ref: "origin/master",
    checkRefPathExists: (ref, path) => {
      seen.push(path);
      return path !== "scripts/c/d.mjs";
    },
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNMERGED_DEPENDENCY);
  assert.equal(r.exitCode, 2);
  assert.deepEqual(r.missing, ["scripts/c/d.mjs"]);
  assert.deepEqual(seen, ["scripts/a/b.mjs", "scripts/c/d.mjs"]);
});

test("REJECT_UNJUDGABLE: ref missing/blank never silently proceeds", () => {
  const never = () => {
    throw new Error("must not be called -- ref check happens first");
  };
  for (const badRef of [undefined, null, "", "   "]) {
    const r = judgeActivationDependency({
      patchText: "scripts/a/b.mjs",
      ref: badRef,
      checkRefPathExists: never,
    });
    assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
    assert.equal(r.exitCode, 2);
  }
});

test("REJECT_UNJUDGABLE: patchText missing/blank", () => {
  for (const bad of [undefined, null, "", "   "]) {
    const r = judgeActivationDependency({
      patchText: bad,
      ref: "origin/master",
      checkRefPathExists: () => true,
    });
    assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
    assert.equal(r.exitCode, 2);
  }
});

test("REJECT_UNJUDGABLE: zero references extracted is NOT a vacuous ALLOW", () => {
  const r = judgeActivationDependency({
    patchText: "no repo-relative paths in this text at all",
    ref: "origin/master",
    checkRefPathExists: () => {
      throw new Error("must not be called -- nothing to check");
    },
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /0개 추출/);
});

test("REJECT_UNJUDGABLE: checker throwing (query failure) is distinct from ALLOW and from REJECT_UNMERGED_DEPENDENCY", () => {
  const r = judgeActivationDependency({
    patchText: "scripts/a/b.mjs",
    ref: "origin/nonexistent-branch",
    checkRefPathExists: () => {
      throw new Error(
        "fatal: not a valid object name origin/nonexistent-branch",
      );
    },
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
  assert.equal(r.exitCode, 2);
  assert.match(r.reason, /조회 실패/);
});

test("REJECT_UNJUDGABLE: checker returning a non-boolean is ambiguous, default-reject", () => {
  const r = judgeActivationDependency({
    patchText: "scripts/a/b.mjs",
    ref: "origin/master",
    checkRefPathExists: () => undefined,
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
  assert.equal(r.exitCode, 2);
});

test("REJECT_UNJUDGABLE: checkRefPathExists not a function (operational misuse)", () => {
  const r = judgeActivationDependency({
    patchText: "scripts/a/b.mjs",
    ref: "origin/master",
    checkRefPathExists: "not-a-function",
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
});

// ---------------------------------------------------------------------------
// §2 RED->GREEN reproduction against a SYNTHETIC git fixture. All git state
// below is created fresh under a mkdtempSync() directory and torn down
// after each test -- zero contact with the real 관제실 files or repo.
// ---------------------------------------------------------------------------

function withSyntheticGitFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "activation-dependency-fixture-"));
  const run = (args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    run(["init", "--initial-branch=master"]);
    run(["config", "user.email", "fixture@example.invalid"]);
    run(["config", "user.name", "Fixture"]);
    // origin/master needs to exist as a ref for the CLI's default; a bare
    // remote isn't necessary -- an ordinary local branch named
    // "refs/remotes/origin/master" is enough for `git cat-file -e` to
    // resolve it, and is far cheaper than standing up a real remote.
    fn({ dir, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 두 단계(ref 자체 검증 -> ref 안 경로 검증) -- git cat-file -e는 "ref가
// 무효"와 "ref는 유효하나 경로가 없다"를 exit code로 구별하지 않는다
// (둘 다 exit 128). activation-dependency-check.mjs의 gitCatFileExists와
// 동일한 두 단계를 이 시험 헬퍼에서도 그대로 재현한다.
function gitChecker(dir) {
  return (ref, path) => {
    execFileSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { cwd: dir, stdio: ["ignore", "ignore", "pipe"] },
    );
    try {
      execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
        cwd: dir,
        stdio: ["ignore", "ignore", "pipe"],
      });
      return true;
    } catch {
      return false;
    }
  };
}

function commitAndTagAsOriginMaster(dir, run) {
  run(["commit", "-m", "fixture commit"]);
  // Fake an "origin/master" ref pointing at HEAD without a real remote --
  // update-ref writes refs/remotes/origin/master directly.
  const head = run(["rev-parse", "HEAD"]).trim();
  run(["update-ref", "refs/remotes/origin/master", head]);
}

test("(a) 사고 재현: 스테이징만 됨(작업트리+인덱스엔 있으나 커밋 ref엔 없음) -> REJECT_UNMERGED_DEPENDENCY", () => {
  withSyntheticGitFixture(({ dir, run }) => {
    writeFileSync(join(dir, "README.md"), "seed\n", "utf8");
    run(["add", "README.md"]);
    commitAndTagAsOriginMaster(dir, run);

    // Sabotage scenario: a NEW file is created and `git add`ed (staged,
    // i.e. present in the index AND the working tree) but never committed
    // -- exactly today's incident shape (coder-task.md §0-2).
    mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "supervisor", "admission-cli.mjs"),
      "// staged, not committed\n",
      "utf8",
    );
    run(["add", "scripts/supervisor/admission-cli.mjs"]);

    const patchText =
      '$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"\n';
    const r = judgeActivationDependency({
      patchText,
      ref: "origin/master",
      checkRefPathExists: gitChecker(dir),
    });
    assert.equal(
      r.state,
      ACTIVATION_DEPENDENCY_STATE.REJECT_UNMERGED_DEPENDENCY,
    );
    assert.equal(r.exitCode, 2);
    assert.deepEqual(r.missing, ["scripts/supervisor/admission-cli.mjs"]);
  });
});

test("(b) 양성 대조: 같은 경로를 커밋해 ref에 넣음 -> ALLOW", () => {
  withSyntheticGitFixture(({ dir, run }) => {
    mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "supervisor", "admission-cli.mjs"),
      "// committed this time\n",
      "utf8",
    );
    run(["add", "scripts/supervisor/admission-cli.mjs"]);
    commitAndTagAsOriginMaster(dir, run);

    const patchText =
      '$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"\n';
    const r = judgeActivationDependency({
      patchText,
      ref: "origin/master",
      checkRefPathExists: gitChecker(dir),
    });
    assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.ALLOW);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(r.missing, []);
  });
});

test("(c) 조회 실패: 존재하지 않는 ref -> REJECT_UNJUDGABLE (ALLOW도 REJECT_UNMERGED_DEPENDENCY도 아님)", () => {
  withSyntheticGitFixture(({ dir, run }) => {
    mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "supervisor", "admission-cli.mjs"),
      "// committed\n",
      "utf8",
    );
    run(["add", "scripts/supervisor/admission-cli.mjs"]);
    commitAndTagAsOriginMaster(dir, run);

    const patchText =
      '$admissionCliPath = Join-Path $Worktree "scripts/supervisor/admission-cli.mjs"\n';
    const r = judgeActivationDependency({
      patchText,
      ref: "origin/this-ref-does-not-exist",
      checkRefPathExists: gitChecker(dir),
    });
    assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.REJECT_UNJUDGABLE);
    assert.equal(r.exitCode, 2);
    assert.notEqual(r.state, ACTIVATION_DEPENDENCY_STATE.ALLOW);
    assert.notEqual(
      r.state,
      ACTIVATION_DEPENDENCY_STATE.REJECT_UNMERGED_DEPENDENCY,
    );
  });
});

// ---------------------------------------------------------------------------
// 오탐 분모(계약, coder-task.md §2) -- dispatch-worker.ps1이 실제로
// 참조하는 저장소 경로 중 master에 «있는» 것들을 표본으로 써서 전부
// ALLOW인지 확인한다(1건 일반화 금지: 최소 3개).
//
// HYK-226-activation-invariant-3 (coder-task.md §0/§2, PR #140 CI 실패
// 수리): 이 시험은 이전 라운드까지 이 파일 머리의 "SYNTHETIC git
// fixtures only -- never the real" 계약을 스스로 어기는 유일한 곳이었다
// -- `checkRefPathExists`가 cwd 지정 없이 `execFileSync("git", ...)`를
// 불러 "현재 프로세스가 실행되는 실제 저장소"(로컬은 이 저장소 자신)를
// 상대로 조회했다. 로컬 워크트리는 `refs/remotes/origin/master`가
// 있어 통과했지만, GitHub Actions의 PR 체크아웃(단일 브랜치, 얕은 클론)
// 에는 그 원격 추적 ref가 없어 `git rev-parse --verify` 자체가 throw
// -> `REJECT_UNJUDGABLE` -> 이 시험이 기대한 `ALLOW`와 어긋나 CI에서만
// 낙제했다(로컬 재현: 같은 브랜치만 `--single-branch`로 새로 clone한
// 임시 디렉터리에서 이 시험을 실행하면 동일하게 실패, §1 재현 기록
// 참고). 아래는 그 실물 의존을 걷어내고 다른 시험들과 같은 합성
// 픽스처(withSyntheticGitFixture)로 옮긴 버전이다.
//
// ★이 시험의 고유 축(ⓑ 양성 대조와 겹치지 않는 부분): ⓑ는 참조 1개만
// 확인한다. 이 시험은 **관제실이 실제 참조하는 경로 문자열 3개를 한
// patchText에 한꺼번에 넣어도 전부 추출되고 전부 통과하는지**(다중
// 참조 추출 + 전부-ALLOW 집계)를 확인한다 -- extractRepoPathReferences가
// 세 슬래시 포함 경로를 모두 뽑아내고, judgeActivationDependency가 그
// 셋 전부에 대해 checkRefPathExists를 호출해 셋 다 true를 받아야 최종
// ALLOW로 집계되는 경로는 ⓑ가 커버하지 않는다.
//
// ⛔이 시험은 "이 3개 경로가 실제 origin/master에 있다"는 사실 자체를
// 검사하지 않는다(그러면 다시 실물 의존이 된다) -- 그 사실은 사람/REVIEW
// 실측으로 남긴다: §0(dropped_at 2026-08-11 17:xx, 이번 트랙 1R)에서
// `git cat-file -e origin/master:<path>` 3회 직접 실행 + REVIEW 1R이
// `.harness/review.md` §4에서 CLI `--ref origin/master`로 독립 재확인
// (3/3 ALLOW). 아래 픽스처는 그 3개 경로 문자열을 "합성 커밋"에 그대로
// 심어 다중 참조 추출/집계 로직만 검사한다.
test("오탐 분모(합성 픽스처): dispatch-worker.ps1이 실제 참조하는 저장소 경로 3개를 한 patchText에 넣어도 전부 추출·전부 ALLOW로 집계됨", () => {
  withSyntheticGitFixture(({ dir, run }) => {
    // 이 3개 경로 문자열은 §0 실측 그대로다(dispatch-worker.ps1 grep,
    // Test-Path로 확인되는 세 스크립트) -- 합성 픽스처 안에 그 경로
    // "모양"으로 빈 파일을 만들어 커밋할 뿐, 실제 관제실/저장소 파일과는
    // 무관하다.
    const realReferencedPaths = [
      "scripts/check/dispatch-gate-decision.mjs",
      "scripts/supervisor/admission-cli.mjs",
      "scripts/relay/dispatch-receipt-cli.mjs",
    ];
    for (const p of realReferencedPaths) {
      const abs = join(dir, ...p.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `// synthetic stand-in for ${p}\n`, "utf8");
    }
    run(["add", "."]);
    commitAndTagAsOriginMaster(dir, run);

    const patchText = realReferencedPaths
      .map((p) => `$x = Join-Path $Worktree "${p}"`)
      .join("\n");
    const r = judgeActivationDependency({
      patchText,
      ref: "origin/master",
      checkRefPathExists: gitChecker(dir),
    });
    assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.ALLOW);
    assert.equal(r.exitCode, 0);
    assert.equal(r.references.length, 3);
    assert.deepEqual(r.missing, []);
  });
});
