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
  collectPledgeDerivationEvidence,
  runOrchStallDetect,
  EXIT_CODE_BY_VERDICT,
} from "./orch-stall-detect.mjs";
import { ARTIFACT_KIND, ORCH_PROGRESS_VERDICT } from "./orch-progress-core.mjs";
import { PLEDGE_SOURCE } from "./pledge-derive-core.mjs";
import { scanRepoForOrcaExecCalls } from "../check/orca-cli-boundary.mjs";

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

// ★재작업 2R(coder-task.md §11 P1) -- "저장소가 아님"은 이제 진짜 수집
// 실패(UNDECIDABLE)로 판정된다(§11 ㄹ). 그래서 runOrchStallDetect/
// collectPledgeDerivationEvidence를 부르는 시험은 `--repo-root`가
// **최소한의 유효한 git 저장소**(커밋 1개, upstream 없음 -- upstream
// 없음은 그 자체로 정상, §11 ㄷ)여야 "정상" 경로를 시험할 수 있다.
function initPlainGitRepo(dir) {
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

// `--repo-root <dir>`을 모든 호출에 붙여 gap#61 증거 수집(.harness
// 스캔·git 조회)이 실제 워크트리가 아니라 합성 `dir`만 보게 격리한다
// (coder-task.md §9 비타협 #5). ★재작업 2R(§11 P1): `dir`은 이제 **최소
// 유효 git 저장소**여야 한다 -- "저장소가 아님"은 더 이상 조용히 빈
// 배열로 접히지 않고 §11 (ㄹ) 수집 실패(`UNDECIDABLE`)로 판정되기
// 때문이다(아래 "collection-failure fail-closed" 절 참조). 이 시험들이
// 검증하려는 것은 판정 파이프라인(관측→판정)이지 git 저장소 여부
// 자체가 아니므로, `initPlainGitRepo(dir)`로 그 축을 정상 쪽에
// 고정한다.
test("runOrchStallDetect: synthetic PROGRESSING pledges file -> exit 0 (--repo-root isolates from the real worktree)", () => {
  withTempDir("orch-stall-run-", (dir) => {
    initPlainGitRepo(dir);
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
      "--repo-root",
      dir,
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.PROGRESSING);
    assert.equal(exitCode, 0);
  });
});

test("runOrchStallDetect: synthetic STALLED pledges file (artifact never appeared, past default threshold) -> non-zero exit, distinct from UNDECIDABLE's code", () => {
  withTempDir("orch-stall-run-", (dir) => {
    initPlainGitRepo(dir);
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
      "--repo-root",
      dir,
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
    assert.notEqual(exitCode, 0);
    assert.notEqual(
      exitCode,
      EXIT_CODE_BY_VERDICT[ORCH_PROGRESS_VERDICT.UNDECIDABLE],
    );
  });
});

test("runOrchStallDetect: unreadable pledges file (path given but not readable) -> UNDECIDABLE exit code, no throw", () => {
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

// gap#61 (★이 사이클의 실질 성과): --pledges 생략은 더 이상 사용법
// 오류가 아니다 -- "안 줬다"(정당, 유도만으로 진행)와 "줬는데 못
// 읽었다"(오류, 위 시험)를 구별한다. ★재작업 2R(§11 ㄱ): 증거 수집
// 자체는 **정상**이었지만(유효 git 저장소·`.harness` 없음) 유도할 흔적이
// 진짜로 0개인 경우 -- 유도 약속도 0개라 PROGRESSING/NO_PLEDGES_RECORDED로
// 닫힌다(orch-progress-core.mjs §(e)와 동일한 한계 -- "검사할 약속이
// 없다"는 뜻이며 "진짜 진행 중"이 아니다). "저장소가 아님"(§11 ㄹ, 수집
// 실패)과 이 "정상적으로 없음"(§11 ㄱ)을 혼동하지 않도록 `initPlainGitRepo`로
// 이 시험을 유효한 저장소 축에 고정한다 -- "저장소 아님" 쪽은 아래
// §(ㄱ)~(ㄹ) 판별 시험이 별도로 검증한다.
test("runOrchStallDetect: missing --pledges + no derivable evidence in an EMPTY BUT VALID git repo-root -> PROGRESSING/NO_PLEDGES_RECORDED, exit 0 (not a usage error, and not a collection failure)", () => {
  withTempDir("orch-stall-empty-", (dir) => {
    initPlainGitRepo(dir);
    assert.doesNotThrow(() => {
      const { result, exitCode } = runOrchStallDetect([
        "--repo-root",
        dir,
        "--now",
        "2026-08-01T10:00:00+09:00",
      ]);
      assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.PROGRESSING);
      assert.equal(result.reasonCode, "NO_PLEDGES_RECORDED");
      assert.equal(exitCode, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// gap#61 (h): 진입점에서 «유도»가 실제로 쓰인다 -- 약속 파일이 아예 없어도
// 저장소 흔적(드롭된 태스크 파일 + 미도착 결과, 그리고 원격에 없는 로컬
// 커밋)만으로 STALLED 판정이 나온다는 것을 직접 확인한다.
// ---------------------------------------------------------------------------
test("runOrchStallDetect: NO --pledges flag at all, derived-only TASK_FILE_DROPPED_AFTER pledge from a synthetic .harness/*-task.md -> STALLED (derivation alone drives the verdict)", () => {
  withTempDir("orch-stall-derive-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-TEST-1\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    // 대응 결과 파일이 이미 나왔다(mtime = 파일 쓰기 시각) -- "소비"
    // 약속이 유도될 조건.
    fs.writeFileSync(join(dir, ".harness", "coder.md"), "결과\n", "utf8");
    const resultMtimeMs = fs.statSync(
      join(dir, ".harness", "coder.md"),
    ).mtimeMs;
    const now = resultMtimeMs + 700_000; // 기본 임계(600s)를 넘김, 다음 태스크 드롭 없음.
    const { result, exitCode } = runOrchStallDetect([
      "--repo-root",
      dir,
      "--now",
      new Date(now).toISOString(),
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
    assert.notEqual(exitCode, 0);
    assert.equal(
      result.pledgeSources["derived:consume:HYK-TEST-1"],
      PLEDGE_SOURCE.DERIVED,
      "the winning pledge must be tagged DERIVED in the output (source is visible in the result, §3-e)",
    );
  });
});

// ---------------------------------------------------------------------------
// gap#61 유도/선언 병합 -- pledgeId가 같으면 유도가 선언을 이긴다(선언이
// 유도를 조용히 덮어써 상태를 바꾸지 못한다, §3-e).
// ---------------------------------------------------------------------------
test("runOrchStallDetect: a DECLARED pledge sharing the same pledgeId as a DERIVED one cannot silently flip the verdict -- derived wins", () => {
  withTempDir("orch-stall-merge-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-TEST-2\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    fs.writeFileSync(join(dir, ".harness", "coder.md"), "결과\n", "utf8");
    const resultMtimeMs = fs.statSync(
      join(dir, ".harness", "coder.md"),
    ).mtimeMs;
    const now = resultMtimeMs + 700_000;
    // 선언된 약속이 같은 pledgeId로 "이미 해소됨(RESOLVED)"이라 주장한다
    // -- 유도된 판정(OPEN, 여전히 STALLED)을 지우려는 시도.
    const pledgesPath = join(dir, "pledges.json");
    fs.writeFileSync(
      pledgesPath,
      JSON.stringify({
        pledges: [
          {
            pledgeId: "derived:consume:HYK-TEST-2",
            content: "선언: 이미 끝났다고 주장",
            expectedArtifact: {
              kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
              path: "irrelevant.md",
            },
            recordedAt: "2026-08-01T09:00:00+09:00",
            resolution: { status: "RESOLVED" },
          },
        ],
      }),
      "utf8",
    );
    const { result } = runOrchStallDetect([
      "--pledges",
      pledgesPath,
      "--repo-root",
      dir,
      "--now",
      new Date(now).toISOString(),
    ]);
    assert.equal(
      result.verdict,
      ORCH_PROGRESS_VERDICT.STALLED,
      "a declared RESOLVED claim must not silently override the derived OPEN/overdue pledge sharing its id",
    );
    assert.equal(
      result.pledgeSources["derived:consume:HYK-TEST-2"],
      PLEDGE_SOURCE.DERIVED,
    );
  });
});

// ---------------------------------------------------------------------------
// ★재작업 1R(coder-task.md §10 항목 2) -- 배달했으나 결과가 아직 안 온
// 태스크가 이제 RESULT_FILE_APPEARS_AFTER로 유도된다. "오탐이 늘지
// 않는지" 확인 -- 임계 판정 자체는 orch-progress-core.mjs 몫이고 이
// 조각은 약속만 만든다는 분담을 end-to-end로 보여준다(임계 이내 →
// PROGRESSING / 임계 초과 → STALLED, 둘 다 같은 evidence 형태에서).
// ---------------------------------------------------------------------------
test("runOrchStallDetect: NO --pledges, task dropped but result NOT yet produced, WITHIN default threshold -> PROGRESSING (no false stall for a task that's still legitimately running)", () => {
  withTempDir("orch-stall-await-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    const droppedAt = "2026-08-03T18:40:00+09:00";
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-AWAIT-1\ndropped_at: 2026-08-03 18:40 KST\n\n본문\n",
      "utf8",
    );
    // 결과 파일(.harness/coder.md)을 만들지 않는다 -- 아직 작업 중.
    const now = Date.parse(droppedAt) + 60_000; // 1분 경과, 기본 임계(600s) 이내.
    const { result, exitCode } = runOrchStallDetect([
      "--repo-root",
      dir,
      "--now",
      new Date(now).toISOString(),
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.PROGRESSING);
    assert.equal(exitCode, 0);
    assert.equal(
      result.pledgeSources["derived:await-result:HYK-AWAIT-1"],
      PLEDGE_SOURCE.DERIVED,
    );
  });
});

test("runOrchStallDetect: NO --pledges, task dropped but result NOT yet produced, PAST default threshold -> STALLED via the derived RESULT_FILE_APPEARS_AFTER pledge (this is the exact gap#61 1R fix -- real stall #3, 83min)", () => {
  withTempDir("orch-stall-await-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    const droppedAt = "2026-08-03T18:40:00+09:00";
    fs.writeFileSync(
      join(dir, ".harness", "review-task.md"),
      "task_id: HYK-AWAIT-2\ndropped_at: 2026-08-03 18:40 KST\n\n본문\n",
      "utf8",
    );
    // 결과 파일(.harness/review.md)이 끝내 오지 않는다 -- 83분 건 재현.
    const now = Date.parse(droppedAt) + 700_000; // 기본 임계(600s) 초과.
    const { result, exitCode } = runOrchStallDetect([
      "--repo-root",
      dir,
      "--now",
      new Date(now).toISOString(),
    ]);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
    assert.notEqual(exitCode, 0);
    assert.equal(
      result.pledgeSources["derived:await-result:HYK-AWAIT-2"],
      PLEDGE_SOURCE.DERIVED,
    );
  });
});

// ---------------------------------------------------------------------------
// collectPledgeDerivationEvidence -- 진입점의 evidence 수집(합성 저장소
// 전용, coder-task.md §6-1 실측 표 그대로).
// ---------------------------------------------------------------------------
// ★재작업 2R(§11 P1): "no .harness dir, not a git repo"는 더 이상
// "정상적으로 비어있음" 하나로 뭉뚱그려지지 않는다 -- ".harness 없음"은
// 정상(§11 ㄱ의 연장)이지만 "git 저장소 아님"은 수집 실패(§11 ㄹ)다.
// 아래 두 시험이 그 둘을 각각 고정한다.
test("collectPledgeDerivationEvidence: no .harness dir but a VALID git repo -> {droppedTaskFiles: [], localVsRemote: [], collectionFailures: []} (legitimately empty, no throw, no collection failure) [§11 ㄱ]", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    initPlainGitRepo(dir);
    assert.doesNotThrow(() => {
      const evidence = collectPledgeDerivationEvidence(dir);
      assert.deepEqual(evidence, {
        droppedTaskFiles: [],
        localVsRemote: [],
        collectionFailures: [],
      });
    });
  });
});

test("collectPledgeDerivationEvidence: repo-root is NOT a git repository at all -> collectionFailures includes 'localVsRemote' (real collection failure, not silently empty) [§11 ㄹ]", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    assert.doesNotThrow(() => {
      const evidence = collectPledgeDerivationEvidence(dir);
      assert.deepEqual(evidence.droppedTaskFiles, []);
      assert.deepEqual(evidence.localVsRemote, []);
      assert.deepEqual(evidence.collectionFailures, ["localVsRemote"]);
    });
  });
});

test("collectPledgeDerivationEvidence: dropped task file with a produced result file -> one droppedTaskFiles item with resultFile.exists:true", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "review-task.md"),
      "task_id: HYK-EV-1\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    fs.writeFileSync(join(dir, ".harness", "review.md"), "결과\n", "utf8");
    const evidence = collectPledgeDerivationEvidence(dir);
    assert.equal(evidence.droppedTaskFiles.length, 1);
    const item = evidence.droppedTaskFiles[0];
    assert.equal(item.path, ".harness/review-task.md");
    assert.equal(item.taskId, "HYK-EV-1");
    assert.equal(item.droppedAtMs, Date.parse("2026-08-01T10:00:00+09:00"));
    assert.equal(item.resultFile.path, ".harness/review.md");
    assert.equal(item.resultFile.exists, true);
    assert.equal(typeof item.resultFile.mtimeMs, "number");
  });
});

// HYK-185-residue-rule-2(coder-task.md §R P1-1, §2-2-ㄴ) -- taskIdMismatch
// evidence. §1 실측 그대로: coder-task.md의 task_id(HYK-167-cycle0-1)와
// coder.md의 task_id(HYK-166-coder-2)가 다르다. ★2R부터 이 값은
// pledge-derive-core.mjs가 소비할 evidence 계층에 있다(1R은 관측 계층에
// 잘못 놓았다 -- REVIEW P1-1 반려, coder-task.md §R 참조).
test("collectPledgeDerivationEvidence: taskIdMismatch=true on the evidence item when task file and result file echo different task_id (exact real shape from coder-task.md §1: HYK-167-cycle0-1 vs HYK-166-coder-2)", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-167-cycle0-1\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    fs.writeFileSync(
      join(dir, ".harness", "coder.md"),
      "task_id: HYK-166-coder-2\n\n본문\n",
      "utf8",
    );
    const evidence = collectPledgeDerivationEvidence(dir);
    assert.equal(evidence.droppedTaskFiles.length, 1);
    assert.equal(evidence.droppedTaskFiles[0].taskIdMismatch, true);
  });
});

test("collectPledgeDerivationEvidence: taskIdMismatch=false on the evidence item when task file and result file echo the same task_id (matched pair, not residue)", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-167-cycle0-1\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    fs.writeFileSync(
      join(dir, ".harness", "coder.md"),
      "task_id: HYK-167-cycle0-1\n\n본문\n",
      "utf8",
    );
    const evidence = collectPledgeDerivationEvidence(dir);
    assert.equal(evidence.droppedTaskFiles[0].taskIdMismatch, false);
  });
});

test("collectPledgeDerivationEvidence: taskIdMismatch=false (undecidable -> safe default) when the result file doesn't exist yet (2/2: result absent, result has no task_id header)", () => {
  const cases = [
    { resultFile: null },
    { resultFile: "본문만 있음, task_id 헤더 없음\n" },
  ];
  for (const c of cases) {
    withTempDir("orch-stall-evidence-", (dir) => {
      initPlainGitRepo(dir);
      fs.mkdirSync(join(dir, ".harness"));
      fs.writeFileSync(
        join(dir, ".harness", "coder-task.md"),
        "task_id: HYK-167-cycle0-1\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
        "utf8",
      );
      if (c.resultFile !== null) {
        fs.writeFileSync(
          join(dir, ".harness", "coder.md"),
          c.resultFile,
          "utf8",
        );
      }
      const evidence = collectPledgeDerivationEvidence(dir);
      assert.equal(evidence.droppedTaskFiles[0].taskIdMismatch, false);
    });
  }
});

test("collectPledgeDerivationEvidence: dropped task file with NO corresponding result file yet -> resultFile.path present, exists:false, mtimeMs:null", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "review-task.md"),
      "task_id: HYK-EV-2\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    const evidence = collectPledgeDerivationEvidence(dir);
    assert.deepEqual(evidence.droppedTaskFiles[0].resultFile, {
      path: ".harness/review.md",
      exists: false,
      mtimeMs: null,
    });
  });
});

test("collectPledgeDerivationEvidence: task file with no dropped_at header at all -> NOT included as evidence (0 items, not a malformed entry)", () => {
  withTempDir("orch-stall-evidence-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "review-task.md"),
      "본문만 있음, 헤더 없음\n",
      "utf8",
    );
    const evidence = collectPledgeDerivationEvidence(dir);
    assert.deepEqual(evidence.droppedTaskFiles, []);
  });
});

test("collectPledgeDerivationEvidence: local commit ahead of its upstream -> one localVsRemote item with contains:false (synthetic git repo, local objects only)", () => {
  withTempDir("orch-stall-evidence-git-", (dir) => {
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
    const remoteDir = tmpDir("orch-stall-evidence-remote-");
    try {
      git(remoteDir, ["init", "--quiet", "--bare"]);
      git(dir, ["remote", "add", "origin", remoteDir]);
      git(dir, ["push", "-q", "-u", "origin", "main"]);
      git(dir, [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "--allow-empty",
        "-m",
        "ahead",
        "--quiet",
      ]);
      const headSha = git(dir, ["rev-parse", "HEAD"]);
      const evidence = collectPledgeDerivationEvidence(dir);
      assert.equal(evidence.localVsRemote.length, 1);
      const item = evidence.localVsRemote[0];
      assert.equal(item.commitSha, headSha);
      assert.equal(item.remoteRef, "origin/main");
      assert.equal(item.contains, false);
      assert.equal(typeof item.commitTimeMs, "number");
    } finally {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    }
  });
});

test("collectPledgeDerivationEvidence: no upstream configured for the current branch -> localVsRemote: [], collectionFailures: [] (nothing to check, NOT a collection failure) [§11 ㄷ]", () => {
  withTempDir("orch-stall-evidence-git-", (dir) => {
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
    const evidence = collectPledgeDerivationEvidence(dir);
    assert.deepEqual(evidence.localVsRemote, []);
    assert.deepEqual(evidence.collectionFailures, []);
  });
});

// ---------------------------------------------------------------------------
// (h) gap#61 실행 확인 -- `node`로 이 파일을 직접(서브프로세스) 실행해,
// `--pledges` 없이도(약속 파일 자체가 아예 없어도) 유도만으로 STALLED
// 판정과 그 종료 코드가 나온다는 것을 출력·종료 코드로 직접 확인한다
// (coder-task.md §3-h "node로 직접 실행한 출력과 종료 코드로").
// ---------------------------------------------------------------------------
test("node subprocess: `node orch-stall-detect.mjs --repo-root <synthetic> --json` with NO --pledges flag at all -> STALLED exit code + JSON verdict from derivation alone", () => {
  withTempDir("orch-stall-cli-", (dir) => {
    initPlainGitRepo(dir);
    fs.mkdirSync(join(dir, ".harness"));
    fs.writeFileSync(
      join(dir, ".harness", "coder-task.md"),
      "task_id: HYK-CLI-1\ndropped_at: 2026-08-01 10:00 KST\n\n본문\n",
      "utf8",
    );
    fs.writeFileSync(join(dir, ".harness", "coder.md"), "결과\n", "utf8");
    const resultMtimeMs = fs.statSync(
      join(dir, ".harness", "coder.md"),
    ).mtimeMs;
    const now = resultMtimeMs + 700_000;
    const entrypoint = join(
      ROOT,
      "scripts",
      "supervisor",
      "orch-stall-detect.mjs",
    );
    let stdout, status;
    try {
      stdout = execFileSync(
        "node",
        [
          entrypoint,
          "--repo-root",
          dir,
          "--now",
          new Date(now).toISOString(),
          "--json",
        ],
        { encoding: "utf8" },
      );
      status = 0;
    } catch (err) {
      stdout = err.stdout;
      status = err.status;
    }
    assert.equal(status, EXIT_CODE_BY_VERDICT[ORCH_PROGRESS_VERDICT.STALLED]);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.verdict, ORCH_PROGRESS_VERDICT.STALLED);
    assert.equal(
      parsed.pledgeSources["derived:consume:HYK-CLI-1"],
      PLEDGE_SOURCE.DERIVED,
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

// HYK-185 seat-wire (coder-task.md §2-1): 갱신 -- 이 파일은 이제
// 좌석 무응답 관측을 위해 orca-adapter.mjs를 import한다(읽기 전용
// `terminal list`/`terminal show`만, orca-cli-boundary.mjs가 강제하는
// "orca를 literal spawn하는 코드는 adapter 안에만" 경계는 그대로다).
// "orca를 아예 언급하지 않는다"는 예전 불변식은 더 이상 이 파일의
// 계약이 아니다 -- 대신 "이 파일 자신은 'orca'를 spawn하지 않는다"
// (orca-cli-boundary.mjs의 EXEC_CALL_RE와 동일 패턴)로 좁힌다.
test("static: orch-stall-detect.mjs never itself spawns 'orca' (only imports the read-only adapter port)", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  const EXEC_CALL_RE =
    /\b(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(\s*["'`]orca["'`]/;
  assert.equal(EXEC_CALL_RE.test(codeOnly), false);
});

test("static: orca-cli-boundary.mjs's own scan still passes with orch-stall-detect.mjs importing the adapter (real-tree regression guard)", () => {
  const violations = scanRepoForOrcaExecCalls(ROOT);
  assert.equal(
    violations.includes("scripts/supervisor/orch-stall-detect.mjs"),
    false,
  );
});

test("static: orch-stall-detect.mjs never fetches over the network (no fetch/git fetch/git pull)", () => {
  const codeOnly = SRC_TEXT.replace(/\/\/.*$/gm, "");
  assert.equal(/\bfetch\s*\(/.test(codeOnly), false);
  assert.equal(/git["'][^)]*\bfetch\b/.test(codeOnly), false);
  assert.equal(/["']pull["']/.test(codeOnly), false);
});

// HYK-413-seat-binding-3 (§2ⓒ, 책임자 게이트 2 판정 A): 아래 두 항목
// (허용 목록·grep 헬퍼)을 모듈 스코프로 끌어올렸다 -- 이번 라운드가 새로
// 추가하는 드리프트-봉인 시험(아래 "static: eslint.config.mjs's supervisor
// relay-import exception...")이 **같은 배열/같은 grep 호출**을 재사용해야
// 하기 때문이다(값을 복사하면 그 복사본 자체가 또 다른 "두 번째 목록"이
// 되어 이번 반려의 원인을 그대로 재현한다). 로직·값은 원문과 동일, 스코프만
// 옮겼다.
//
// HYK-340-vanished-unresolved (eslint complexity 상한 준수 수리): 이
// 목록이 늘어날수록 아래 filter의 `&&` 체인 길이가 그대로 eslint
// complexity 분기 수가 되어(ESLint complexity.js 실측, orch-stall-
// detect.mjs의 REASON_BY_SIGNAL_KIND 등과 동일 계열 실측) 새 wire 시험
// 파일 하나를 추가할 때마다 상한을 넘길 위험이 커진다. 그래서 배열 +
// `.some()`로 바꾼다 -- 각 항목의 "왜 제외되는가" 설명은 그대로
// 보존한다(판단 로직·값은 원문과 동일, 표현 형태만 바꾼다).
const OWN_TEST_FILE_SUFFIXES = [
  "orch-stall-detect.mjs",
  "orch-stall-detect.test.mjs",
  "seat-liveness-wire.test.mjs",
  "seat-idle-wire.test.mjs",
  "dispatch-start-wire.test.mjs",
  "hyk185-seat-multi-repro.test.mjs",
  // HYK-185-unconsumed-1: unconsumed-wire.test.mjs exercises the same
  // production entry point for the "unconsumed" axis
  // (judgeUnconsumedForRepo/judgeUnconsumedAcrossWorktrees). Excluded
  // on the same "own .test.mjs" basis as the files above.
  "unconsumed-wire.test.mjs",
  // HYK-340-vanished-unresolved: unconsumed-receipt-signal.test.mjs is
  // the same shape once more -- it exercises the real production entry
  // point (judgeUnconsumedForRepo/collectUnconsumedCandidates) for the
  // new consumption-receipt signal on the existing "unconsumed" axis.
  // Excluded on the identical "own .test.mjs" basis as
  // unconsumed-wire.test.mjs above.
  "unconsumed-receipt-signal.test.mjs",
  // HYK-173-push-wire: escalation-axis-wire.test.mjs exercises the real
  // production entry point (runOrchStallDetect) for the escalation
  // axis. Excluded on the identical "own .test.mjs" basis.
  "escalation-axis-wire.test.mjs",
  // HYK-212-postcheck-1: dispatch-postcheck-wire.test.mjs/dispatch-
  // postcheck-axis-wire.test.mjs are the same shape once more for the
  // dispatch-postcheck axis. Excluded on the identical "own .test.mjs"
  // basis.
  "dispatch-postcheck-wire.test.mjs",
  "dispatch-postcheck-axis-wire.test.mjs",
  // HYK-239-chain-wire-2: dispatch-chain-wire.test.mjs/dispatch-chain-
  // axis-wire.test.mjs are the same shape once more for the chain(원장
  // 해시체인 위조 탐지) axis. Excluded on the identical "own .test.mjs"
  // basis.
  "dispatch-chain-wire.test.mjs",
  "dispatch-chain-axis-wire.test.mjs",
  // HYK-408-seat-decide: hyk408-seat-decide-repro.test.mjs is the same
  // shape once more -- it exercises judgeSeatLivenessForRepo/
  // judgeDispatchStartForRepo directly (same read-only production entry
  // points as hyk185-seat-multi-repro.test.mjs above) to pin the
  // ledger-primary/screen-fallback repro. Excluded on the identical
  // "own .test.mjs" basis.
  "hyk408-seat-decide-repro.test.mjs",
  // HYK-413-seat-binding-2: hyk413-seat-reason-projection.test.mjs is the
  // same shape once more -- it drives judgeSeatLivenessForRepo directly
  // (same production entry point as hyk408-seat-decide-repro.test.mjs
  // above) to confirm the adapter's split reason codes survive the
  // supervisor projection. Excluded on the identical "own .test.mjs"
  // basis. (HYK-413-seat-binding-3 3R repair: this line was missing from
  // this array in the 2R commit even though the matching eslint.config.mjs
  // exception was added -- exactly the drift the new test below now
  // seals.)
  "hyk413-seat-reason-projection.test.mjs",
];

function findOrchStallDetectImporters(root) {
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
      { cwd: root, encoding: "utf8" },
    );
  } catch (err) {
    // git grep exits 1 when there are zero matches -- that is the
    // "nothing wires this in yet" outcome this test expects, not a failure.
    if (err.status === 1) return [];
    throw err;
  }
  return grepOut.split(/\r?\n/).filter(Boolean);
}

// no production (non-test) file imports this module -- only its own
// .test.mjs wire tests do, each with its own "why excluded" comment
// inline in OWN_TEST_FILE_SUFFIXES above (HYK-340-vanished-unresolved
// moved this explanation there when the exclusion list became an array).
test("static: no PRODUCTION code imports orch-stall-detect.mjs yet (h -- can be called is not the same as is being called; only its own .test.mjs files do)", () => {
  const importers = findOrchStallDetectImporters(ROOT).filter(
    (f) => !OWN_TEST_FILE_SUFFIXES.some((suffix) => f.endsWith(suffix)),
  );
  assert.deepEqual(
    importers,
    [],
    `unexpected wiring found in: ${importers.join(", ")}`,
  );
});

// HYK-413-seat-binding-3 (§2ⓒ, 책임자 게이트 2 판정 A -- "두 목록 드리프트
// 봉인, 가능 범위"): 이번 반려의 진짜 원인은 같은 사실("이 새 wire 시험
// 파일은 scripts/relay/*도, orch-stall-detect.mjs도 정당하게 import한다")
// 을 두 목록(eslint.config.mjs의 scripts/supervisor no-restricted-imports
// 예외 · 이 파일의 OWN_TEST_FILE_SUFFIXES)이 따로 들고 있었는데 2R이 그중
// 하나만 갱신했다는 것이다. 두 목록을 하나로 합치지는 않는다(서로 다른
// 축 -- eslint 목록은 scripts/relay/* import 허용 전체를 다루고, 이
// 목록은 orch-stall-detect.mjs import 허용만 다룬다 -- 완전히 같은
// 집합이 아니다: 예를 들어 watch-run.mjs는 eslint 목록에만, unconsumed-
// wire.test.mjs는 이 목록에만 있다). 대신 **교집합**(두 허용 모두 실제로
// 필요한 파일 -- 즉 실제로 orch-stall-detect.mjs를 import«하면서» 동시에
// eslint의 scripts/supervisor 예외 블록에도 올라 있는 파일)에서만 어긋남을
// 검사한다: 그 교집합의 모든 원소는 반드시 OWN_TEST_FILE_SUFFIXES에도
// 있어야 한다 -- 없으면 이번 반려와 정확히 같은 모양(eslint만 갱신하고
// 런타임 허용 목록을 잊음)이 재발한 것이다.
// HYK-413-seat-binding-3 (3R repair, 자체 발견): 처음엔 이 함수가
// `import(pathToFileURL(...))`로 eslint.config.mjs를 직접 실행했다 --
// 그런데 이 저장소 러너(isolated-suite-runner.mjs)가 커밋된 HEAD를
// node_modules 없는 격리 clone에 복제해 돈다(§0 완료 도장·러너 규칙,
// 이번 반려의 뿌리 그 자체)는 사실을 놓쳐, eslint.config.mjs 자신의
// `import eslintJs from "@eslint/js"`가 그 clone 안에서
// `ERR_MODULE_NOT_FOUND`로 죽는 걸 커밋 뒤 재실행에서 실측했다(§0-1
// 실사고 -- "정본 시험을 초록으로 되돌린다"는 라운드 자신이 새 격리-clone
// 실패를 하나 더 심을 뻔했다). 수리: **모듈로 실행하지 않고 텍스트로만
// 읽는다** -- `files: [...]` 배열을 정규식으로 추출한다(이 배열은 문자열
// 리터럴과 줄 주석만 담고 중첩 배열이 없으므로 비탐욕 매치로 안전하게
// 닫는 `]`를 찾는다). node_modules를 전혀 건드리지 않으므로 격리 clone
// 안에서도 항상 돈다.
function extractEslintSupervisorExceptionFiles(root) {
  const configText = fs.readFileSync(join(root, "eslint.config.mjs"), "utf8");
  const anchor = '"scripts/supervisor/orch-stall-detect.mjs"';
  const anchorIdx = configText.indexOf(anchor);
  assert.ok(
    anchorIdx >= 0,
    `eslint.config.mjs: anchor string not found (looking for ${anchor} inside a 'files: [...]' array) -- has that block been renamed or restructured? this drift-seal test needs updating to match.`,
  );
  const filesKeywordIdx = configText.lastIndexOf("files: [", anchorIdx);
  assert.ok(
    filesKeywordIdx >= 0,
    "eslint.config.mjs: 'files: [' not found before the anchor -- block structure changed?",
  );
  const rest = configText.slice(filesKeywordIdx);
  const arrayMatch = rest.match(/^files:\s*\[([\s\S]*?)\]/);
  assert.ok(
    arrayMatch,
    "eslint.config.mjs: could not extract the files: [...] array body (non-greedy match found no closing ']') -- did a comment or entry start containing ']'?",
  );
  return [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("static: eslint.config.mjs's scripts/supervisor relay-import exception list and this file's OWN_TEST_FILE_SUFFIXES allowlist don't silently drift apart for files that need BOTH exceptions (HYK-413-seat-binding-3 §2ⓒ -- seals the exact 2R incident shape)", () => {
  const supervisorBlockFiles = extractEslintSupervisorExceptionFiles(ROOT);
  const actualImporters = new Set(findOrchStallDetectImporters(ROOT));
  const needsBothExceptions = supervisorBlockFiles.filter((f) =>
    actualImporters.has(f),
  );
  const missingFromOwnList = needsBothExceptions.filter(
    (f) => !OWN_TEST_FILE_SUFFIXES.some((suffix) => f.endsWith(suffix)),
  );
  assert.deepEqual(
    missingFromOwnList,
    [],
    `these file(s) are exempted in eslint.config.mjs's scripts/supervisor block AND actually import orch-stall-detect.mjs, but are missing from this file's own OWN_TEST_FILE_SUFFIXES allowlist above -- add them there too (this is the exact HYK-413-seat-binding-2 2R incident shape): ${missingFromOwnList.join(", ")}`,
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
