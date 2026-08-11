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
import { join } from "node:path";
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
// ALLOW인지 확인한다(1건 일반화 금지: 최소 3개). ★실측: 아래 3개 경로는
// scripts/check/dispatch-worker.ps1 그렙(§0에서 사람이 실행)으로 찾은
// 것과 동일한 3개다 -- D:\문서관리\하네스-관제실\dispatch-worker.ps1의
// line 163/184/210 `Join-Path $Worktree "scripts/..."` 참조. 이 저장소
// 자신의 origin/master를 대상으로 확인한다(관제실 파일은 무접촉 -- 경로
// 문자열만 표본으로 쓴다).
test("오탐 분모: dispatch-worker.ps1이 실제 참조하는 저장소 경로 3개, 전부 origin/master에 있어 ALLOW", () => {
  const realReferencedPaths = [
    "scripts/check/dispatch-gate-decision.mjs",
    "scripts/supervisor/admission-cli.mjs",
    "scripts/relay/dispatch-receipt-cli.mjs",
  ];
  const patchText = realReferencedPaths
    .map((p) => `$x = Join-Path $Worktree "${p}"`)
    .join("\n");
  const r = judgeActivationDependency({
    patchText,
    ref: "origin/master",
    checkRefPathExists: (ref, path) => {
      execFileSync(
        "git",
        ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      try {
        execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        return true;
      } catch {
        return false;
      }
    },
  });
  assert.equal(r.state, ACTIVATION_DEPENDENCY_STATE.ALLOW);
  assert.equal(r.exitCode, 0);
  assert.equal(r.references.length, 3);
  assert.deepEqual(r.missing, []);
});
