// HYK-185 B/C (coder-task.md §7, §5-C) -- orch-stall-detect.mjs(진입점)
// 계약 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 여기 fixture는 전부 이 시험이 `mkdtemp`로 만든 합성 표적이다
//    (coder-task.md §2-9 "진입점 시험도 합성 표적만 쓴다"). 실제
//    `.harness/`·관제실 파일·실제 원격을 이 시험이 접촉하지 않는다.
// 2. REMOTE_REF_CONTAINS_COMMIT 수집은 이 시험이 만든 합성 임시 git
//    저장소에서만 측정한다(로컬 커밋 그래프뿐, `git fetch` 없음).
// 3. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseArgs,
  collectObservationForPledge,
  collectObservation,
  runOrchStallDetect,
  EXIT_CODE_BY_VERDICT,
} from "./orch-stall-detect.mjs";
import { ARTIFACT_KIND, ORCH_PROGRESS_VERDICT } from "./orch-progress-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();

const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initSyntheticRepo(dir) {
  git(dir, ["init", "--quiet", "-b", "main"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  ]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "-b", "feature", "--quiet"]);
  git(dir, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "--allow-empty",
    "-m",
    "feature",
    "--quiet",
  ]);
  const featureSha = git(dir, ["rev-parse", "HEAD"]);
  git(dir, ["checkout", "main", "--quiet"]);
  return { baseSha, featureSha };
}

// ---------------------------------------------------------------------------
// parseArgs -- CLI 파싱.
// ---------------------------------------------------------------------------
test("parseArgs: reads --pledges/--now/--threshold-s/--json in any order", () => {
  const parsed = parseArgs([
    "--threshold-s",
    "120",
    "--pledges",
    "/x/pledges.json",
    "--json",
    "--now",
    "2026-08-01T00:00:00+09:00",
  ]);
  assert.equal(parsed.pledgesPath, "/x/pledges.json");
  assert.equal(parsed.nowIso, "2026-08-01T00:00:00+09:00");
  assert.equal(parsed.thresholdSeconds, 120);
  assert.equal(parsed.json, true);
});

test("parseArgs: no flags -> all fields at their empty defaults, no throw", () => {
  assert.doesNotThrow(() => {
    const parsed = parseArgs([]);
    assert.equal(parsed.pledgesPath, null);
    assert.equal(parsed.json, false);
  });
});

// ---------------------------------------------------------------------------
// collectObservationForPledge -- 실측 가능 필드 표(coder-task.md §7-1)
// 그대로: 파일 mtime · task 파일 dropped_at 헤더 · 원격 ref의 커밋 포함
// 여부.
// ---------------------------------------------------------------------------
test("collect FILE_EXISTS_AFTER: file absent -> {collected:true, exists:false, mtimeMs:null}", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
        path: "never-created.md",
      },
    });
    assert.deepEqual(entry, { collected: true, exists: false, mtimeMs: null });
  });
});

test("collect FILE_EXISTS_AFTER: file present -> {collected:true, exists:true, mtimeMs:<real stat mtime>}", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    fs.writeFileSync(join(dir, "created.md"), "x", "utf8");
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
        path: "created.md",
      },
    });
    assert.equal(entry.collected, true);
    assert.equal(entry.exists, true);
    assert.equal(typeof entry.mtimeMs, "number");
  });
});

test("collect RESULT_FILE_APPEARS_AFTER: same file-mtime mechanic as FILE_EXISTS_AFTER (distinct kind, same real observation)", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER,
        path: ".harness/review.md",
      },
    });
    assert.deepEqual(entry, { collected: true, exists: false, mtimeMs: null });
  });
});

test("collect TASK_FILE_DROPPED_AFTER: task file with a well-formed dropped_at header -> {collected:true, taskFileExists:true, droppedAtMs:<parsed>}", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-000-x\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
        path: ".harness/coder-task.md",
      },
    });
    assert.equal(entry.collected, true);
    assert.equal(entry.taskFileExists, true);
    assert.equal(entry.droppedAtMs, Date.parse("2026-08-01T10:00:00+09:00"));
  });
});

test("collect TASK_FILE_DROPPED_AFTER: task file exists but dropped_at header missing -> {collected:false} (fail-closed, not a fabricated timestamp)", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "본문만 있음\n",
      "utf8",
    );
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
        path: ".harness/coder-task.md",
      },
    });
    assert.deepEqual(entry, { collected: false });
  });
});

test("collect TASK_FILE_DROPPED_AFTER: task file absent -> {collected:true, taskFileExists:false, droppedAtMs:null}", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
        path: ".harness/coder-task.md",
      },
    });
    assert.deepEqual(entry, {
      collected: true,
      taskFileExists: false,
      droppedAtMs: null,
    });
  });
});

test("collect REMOTE_REF_CONTAINS_COMMIT: commit reachable from ref -> {collected:true, contains:true} (synthetic tmp git repo, local objects only)", () => {
  withTempDir("orch-stall-git-", (dir) => {
    const { baseSha } = initSyntheticRepo(dir);
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT,
        commitSha: baseSha,
        remoteRef: "main",
      },
    });
    assert.deepEqual(entry, { collected: true, contains: true });
  });
});

test("collect REMOTE_REF_CONTAINS_COMMIT: commit NOT reachable from ref -> {collected:true, contains:false}", () => {
  withTempDir("orch-stall-git-", (dir) => {
    const { featureSha } = initSyntheticRepo(dir);
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT,
        commitSha: featureSha,
        remoteRef: "main",
      },
    });
    assert.deepEqual(entry, { collected: true, contains: false });
  });
});

test("collect REMOTE_REF_CONTAINS_COMMIT: unresolvable commit/ref -> {collected:false} (not silently 'contains:false')", () => {
  withTempDir("orch-stall-git-", (dir) => {
    initSyntheticRepo(dir);
    const entry = collectObservationForPledge(dir, {
      expectedArtifact: {
        kind: ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT,
        commitSha: "0000000000000000000000000000000000dead",
        remoteRef: "main",
      },
    });
    assert.deepEqual(entry, { collected: false });
  });
});

test("collectObservationForPledge: malformed expectedArtifact (missing) -> null (no observation fabricated)", () => {
  assert.equal(collectObservationForPledge("/tmp", { pledgeId: "p1" }), null);
});

test("collectObservation: skips pledges without a string pledgeId, keys the rest by pledgeId (denominator=3, 1 skipped)", () => {
  withTempDir("orch-stall-collect-", (dir) => {
    const observation = collectObservation(dir, [
      {
        pledgeId: "a",
        expectedArtifact: {
          kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
          path: "a.md",
        },
      },
      {
        expectedArtifact: {
          kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
          path: "b.md",
        },
      },
      {
        pledgeId: "c",
        expectedArtifact: {
          kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
          path: "c.md",
        },
      },
    ]);
    assert.deepEqual(Object.keys(observation).sort(), ["a", "c"]);
  });
});

// ---------------------------------------------------------------------------
// runOrchStallDetect -- 종료 코드는 4상태를 서로 다른 코드로 알린다
// (coder-task.md §5-C "정지 의심과 판정 불가를 같은 코드로 접지 마라").
// ---------------------------------------------------------------------------
test("runOrchStallDetect: PROGRESSING/STALLED/WAITING_HUMAN_GATE/UNDECIDABLE each map to a distinct exit code (4/4 distinct)", () => {
  const codes = new Set(Object.values(EXIT_CODE_BY_VERDICT));
  assert.equal(codes.size, 4, "all 4 verdicts must map to distinct exit codes");
});

test("runOrchStallDetect: synthetic PROGRESSING pledges file -> exit 0", () => {
  withTempDir("orch-stall-run-", (dir) => {
    const pledgesPath = join(dir, "pledges.json");
    fs.writeFileSync(
      pledgesPath,
      JSON.stringify({
        pledges: [
          {
            pledgeId: "p1",
            content: "곧 만든다",
            expectedArtifact: {
              kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
              path: "x.md",
            },
            recordedAt: "2026-08-01T10:00:00+09:00",
            resolution: { status: "OPEN" },
          },
        ],
      }),
      "utf8",
    );
    const { result, exitCode } = runOrchStallDetect([
      "--pledges",
      pledgesPath,
      "--now",
      "2026-08-01T10:00:05+09:00",
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.PROGRESSING);
    assert.equal(exitCode, 0);
  });
});

test("runOrchStallDetect: synthetic STALLED pledges file (artifact never appeared, past default threshold) -> non-zero exit, distinct from UNDECIDABLE's code", () => {
  withTempDir("orch-stall-run-", (dir) => {
    const pledgesPath = join(dir, "pledges.json");
    fs.writeFileSync(
      pledgesPath,
      JSON.stringify({
        pledges: [
          {
            pledgeId: "p1",
            content: "곧 만든다",
            expectedArtifact: {
              kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
              path: "never-created.md",
            },
            recordedAt: "2026-08-01T10:00:00+09:00",
            resolution: { status: "OPEN" },
          },
        ],
      }),
      "utf8",
    );
    const { result, exitCode } = runOrchStallDetect([
      "--pledges",
      pledgesPath,
      "--now",
      "2026-08-01T11:00:00+09:00",
      "--threshold-s",
      "60",
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
    assert.notEqual(exitCode, 0);
    assert.notEqual(
      exitCode,
      EXIT_CODE_BY_VERDICT[ORCH_PROGRESS_VERDICT.UNDECIDABLE],
    );
  });
});

test("runOrchStallDetect: unreadable pledges file -> UNDECIDABLE exit code, no throw", () => {
  assert.doesNotThrow(() => {
    const { result, exitCode } = runOrchStallDetect([
      "--pledges",
      join(tmpdir(), "definitely-does-not-exist-orch-stall.json"),
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
    assert.equal(
      exitCode,
      EXIT_CODE_BY_VERDICT[ORCH_PROGRESS_VERDICT.UNDECIDABLE],
    );
  });
});

test("runOrchStallDetect: missing --pledges -> UNDECIDABLE exit code (usage error), no throw", () => {
  assert.doesNotThrow(() => {
    const { exitCode } = runOrchStallDetect([]);
    assert.equal(
      exitCode,
      EXIT_CODE_BY_VERDICT[ORCH_PROGRESS_VERDICT.UNDECIDABLE],
    );
  });
});

// ---------------------------------------------------------------------------
// (h) 진입점이 "부르면 도는" 프로그램(node만으로 실행, Claude 훅·Orca·
// 특정 에이전트 의존 0)이라는 정적 증거 -- 소스 직접 확인.
// ---------------------------------------------------------------------------
const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "orch-stall-detect.mjs"),
  "utf8",
);

test("static: orch-stall-detect.mjs never spawns 'orca' or builds a command string toward it", () => {
  assert.equal(/\borca\b/i.test(SRC_TEXT.replace(/\/\/.*$/gm, "")), false);
});

test("static: orch-stall-detect.mjs never fetches over the network (no fetch/git fetch/git pull)", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  assert.equal(/\bfetch\s*\(/.test(codeOnly), false);
  assert.equal(/git["'][^)]*\bfetch\b/.test(codeOnly), false);
  assert.equal(/["']pull["']/.test(codeOnly), false);
});

test("static: nothing else in the repo imports orch-stall-detect.mjs yet (h -- can be called is not the same as is being called)", () => {
  let grepOut;
  try {
    grepOut = execFileSync(
      "git",
      [
        "grep",
        "-l",
        "-I",
        "--untracked",
        "-E",
        "(from[ \\t]+|require\\()[\"'][^\"']*orch-stall-detect\\.mjs[\"']",
        "--",
        "*.mjs",
        "*.json",
        "*.yml",
        "*.yaml",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
  } catch (err) {
    // git grep exits 1 when there are zero matches -- that is the
    // "nothing wires this in yet" outcome this test expects, not a failure.
    if (err.status === 1) grepOut = "";
    else throw err;
  }
  const importers = grepOut
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(
      (f) =>
        !f.endsWith("orch-stall-detect.mjs") &&
        !f.endsWith("orch-stall-detect.test.mjs"),
    );
  assert.deepEqual(
    importers,
    [],
    `unexpected wiring found in: ${importers.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// 원상복구 단언 (coder-task.md §2 비타협 #6) -- 실제 워크트리를 손대지
// 않는다(전부 mkdtemp 안에서만 파일을 만들었다).
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "orch-stall-detect.test.mjs must leave the real worktree exactly as it found it",
  );
});
