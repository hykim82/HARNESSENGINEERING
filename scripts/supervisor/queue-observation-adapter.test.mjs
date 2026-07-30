import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectQueueObservation,
  collectAndEvaluateQueue,
  createGitRunner,
  createUnavailableApprovalPort,
  COLLECTION_FAILURE_REASON,
  OBSERVATION_SCHEMA_VERSION,
} from "./queue-observation-adapter.mjs";
import { QUEUE_VERDICT, QUEUE_REASON } from "./queue-manifest-core.mjs";

// HYK-183 v1 사이클2a (coder-task.md §3-3) -- queue-observation-adapter.mjs
// 테스트. §2-A(git fixture는 tmpdir 아래 전부 새로 git init)를 지킨다:
// 이 워크트리/메인 저장소/D:/문서관리 어디도 건드리지 않는다.
//
// 이 계약이 보장하지 않는 것 (상시기준 S11):
// 1. 주장 범위 -- A절(MEASURED) 표본은 이 파일이 만든 임시 저장소에서 실제
//    git 명령으로 측정한 값이다. B절(SYNTHETIC)은 손으로 만든 승인 포트다.
//    실제 GitHub 승인 흐름은 검증하지 않는다(2b 몫).
// 2. 표본 수와 조건 -- git 버전은 실행 환경의 `git --version`(보고서에
//    기록). 각 시나리오는 이 파일에서 독립된 임시 디렉터리로 1회씩만 측정한다.

async function run(repoRoot, args) {
  const result = await createGitRunner(repoRoot).run(args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`,
    );
  }
  return result.stdout.toString("utf8");
}

async function commitAll(dir, message) {
  await run(dir, ["add", "-A"]);
  await run(dir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  ]);
}

async function mergeBranch(dir, branch, message) {
  await run(dir, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "merge",
    "--no-ff",
    "-m",
    message,
    branch,
  ]);
}

async function mkTempRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-obs-"));
  await run(dir, ["init"]);
  // Disable autocrlf so a fresh `git checkout` (e.g. into a linked worktree)
  // cannot silently rewrite line endings and desync the blob hash from what
  // this test wrote directly to disk.
  await run(dir, ["config", "core.autocrlf", "false"]);
  await run(dir, ["checkout", "-b", "main"]);
  return dir;
}

function queueManifestJson(overrides = {}) {
  return `${JSON.stringify(
    {
      schema_version: "queue-manifest/v1",
      queue_epoch: 0,
      entries: [
        {
          issue_id: "HYK-1",
          ordinal: 1,
          approved_merge_commit: "a".repeat(40),
          enabled: true,
        },
      ],
      ...overrides,
    },
    null,
    2,
  )}\n`;
}

// 정상 시나리오: main 브랜치 == protected · queue.json이 머지 커밋으로
// 들어옴 · 작업 트리 깨끗.
//
// queue.json을 양쪽 브랜치에서 서로 다른 내용으로 만들어 머지가 실제로
// 두 부모 모두와 다른 트리를 만들게 한다 -- 그래야 `git rev-list -1 HEAD --
// queue.json`(경로 제한 히스토리 단순화)이 머지 커밋 자체를 가리킨다. 한쪽
// 부모와 TREESAME이면 git이 그 부모 쪽으로 단순화해 버려 머지 커밋이 아닌
// 그 커밋을 반환한다(실측으로 확인한 동작 -- 처음엔 이 함정에 걸렸다).
async function buildNormalRepo() {
  const dir = await mkTempRepo();
  await fsp.writeFile(path.join(dir, "README.md"), "init\n");
  await commitAll(dir, "init");

  await run(dir, ["checkout", "-b", "feature"]);
  await fsp.writeFile(
    path.join(dir, "queue.json"),
    queueManifestJson({ queue_epoch: 111 }),
  );
  await commitAll(dir, "feature: queue placeholder");

  await run(dir, ["checkout", "main"]);
  await fsp.writeFile(
    path.join(dir, "queue.json"),
    queueManifestJson({ queue_epoch: 222 }),
  );
  await commitAll(
    dir,
    "main: queue placeholder (diverges to force a real merge)",
  );

  try {
    await mergeBranch(dir, "feature", "merge queue (expected conflict)");
  } catch {
    // conflict expected -- resolved by the write+commit below.
  }
  await fsp.writeFile(path.join(dir, "queue.json"), queueManifestJson());
  await commitAll(dir, "merge queue: resolve to final manifest");

  return dir;
}

function approvedPort() {
  return {
    async isHumanApproved(sha) {
      return { status: "APPROVED", evidence: { sha } };
    },
  };
}
function notApprovedPort() {
  return {
    async isHumanApproved(sha) {
      return { status: "NOT_APPROVED", evidence: { sha } };
    },
  };
}

function measuredProtectedBranchPort(protectedBranchName = "main") {
  return {
    async measure() {
      return { ok: true, protectedBranchName };
    },
  };
}

function depsFor(dir, approval, overrides = {}) {
  return {
    repoRoot: dir,
    manifestPath: "queue.json",
    protectedBranch: measuredProtectedBranchPort(),
    previousApproved: null,
    git: createGitRunner(dir),
    approval,
    ...overrides,
  };
}

async function withTempRepo(build, fn) {
  const dir = await build();
  try {
    await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A. 실제 git 표본 (MEASURED)
// ---------------------------------------------------------------------------

test("MEASURED normal: protected branch + merge commit + clean worktree -> START_ALLOWED", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const result = await collectAndEvaluateQueue(depsFor(dir, approvedPort()));
    assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
    assert.equal(result.reason, QUEUE_REASON.OK);
    assert.equal(result.collection.ok, true);
  });
});

test("MEASURED: working tree queue.json modified (not committed) -> BLOB_HASH_MISMATCH", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    await fsp.writeFile(
      path.join(dir, "queue.json"),
      queueManifestJson({ queue_epoch: 99 }),
    );
    const result = await collectAndEvaluateQueue(depsFor(dir, approvedPort()));
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.BLOB_HASH_MISMATCH);
  });
});

test("MEASURED: untracked file added only -> WORKTREE_DIRTY", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    await fsp.writeFile(path.join(dir, "untracked.txt"), "surprise\n");
    const result = await collectAndEvaluateQueue(depsFor(dir, approvedPort()));
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.WORKTREE_DIRTY);
  });
});

test("MEASURED: different branch checked out -> NOT_PROTECTED_BRANCH", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    await run(dir, ["checkout", "-b", "other"]);
    const result = await collectAndEvaluateQueue(depsFor(dir, approvedPort()));
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.NOT_PROTECTED_BRANCH);
  });
});

test("MEASURED: detached HEAD -> NOT_PROTECTED_BRANCH (head_branch_name is literal 'HEAD')", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const sha = (await run(dir, ["rev-parse", "HEAD"])).trim();
    await run(dir, ["checkout", sha]);
    const result = await collectAndEvaluateQueue(depsFor(dir, approvedPort()));
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.NOT_PROTECTED_BRANCH);
  });
});

test("MEASURED: queue.json added via a regular (non-merge) commit -> NOT_MERGE_COMMIT", async () => {
  await withTempRepo(
    async () => {
      const dir = await mkTempRepo();
      await fsp.writeFile(path.join(dir, "queue.json"), queueManifestJson());
      await commitAll(dir, "add queue directly");
      return dir;
    },
    async (dir) => {
      const result = await collectAndEvaluateQueue(
        depsFor(dir, approvedPort()),
      );
      assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
      assert.equal(result.reason, QUEUE_REASON.NOT_MERGE_COMMIT);
    },
  );
});

test("MEASURED: linked worktree (git worktree add) -> ALTERNATE_CHECKOUT", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const linkedDir = `${dir}-linked`;
    await run(dir, ["worktree", "add", "--force", linkedDir, "main"]);
    try {
      const result = await collectAndEvaluateQueue(
        depsFor(linkedDir, approvedPort()),
      );
      assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
      assert.equal(result.reason, QUEUE_REASON.ALTERNATE_CHECKOUT);
    } finally {
      await run(dir, ["worktree", "remove", "--force", linkedDir]);
    }
  });
});

test("MEASURED: manifest file never committed -> collection failure MANIFEST_FILE_NOT_TRACKED", async () => {
  await withTempRepo(
    async () => {
      const dir = await mkTempRepo();
      await fsp.writeFile(path.join(dir, "README.md"), "init\n");
      await commitAll(dir, "init");
      return dir;
    },
    async (dir) => {
      const result = await collectQueueObservation(
        depsFor(dir, approvedPort()),
      );
      assert.equal(result.ok, false);
      assert.equal(
        result.reason,
        COLLECTION_FAILURE_REASON.MANIFEST_FILE_NOT_TRACKED,
      );
    },
  );
});

test("MEASURED: manifest committed then deleted from worktree -> collection failure MANIFEST_FILE_MISSING", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    await fsp.rm(path.join(dir, "queue.json"));
    const result = await collectQueueObservation(depsFor(dir, approvedPort()));
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      COLLECTION_FAILURE_REASON.MANIFEST_FILE_MISSING,
    );
  });
});

test("MEASURED: manifest worktree bytes are broken JSON -> collection failure MANIFEST_JSON_PARSE_FAILED", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    await fsp.writeFile(path.join(dir, "queue.json"), "{ not json");
    const result = await collectQueueObservation(depsFor(dir, approvedPort()));
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      COLLECTION_FAILURE_REASON.MANIFEST_JSON_PARSE_FAILED,
    );
  });
});

test("MEASURED: repoRoot is not a git repository -> collection failure GIT_COMMAND_FAILED", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "queue-obs-notrepo-"));
  try {
    const result = await collectQueueObservation(depsFor(dir, approvedPort()));
    assert.equal(result.ok, false);
    assert.equal(result.reason, COLLECTION_FAILURE_REASON.GIT_COMMAND_FAILED);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B. 승인 포트 (SYNTHETIC) -- APPROVED / NOT_APPROVED / UNDECIDABLE
// ---------------------------------------------------------------------------

test("SYNTHETIC approval: NOT_APPROVED -> START_BLOCKED/NOT_HUMAN_APPROVED", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const result = await collectAndEvaluateQueue(
      depsFor(dir, notApprovedPort()),
    );
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(result.reason, QUEUE_REASON.NOT_HUMAN_APPROVED);
  });
});

test("SYNTHETIC approval: UNDECIDABLE -> collection failure, human_approved is never defaulted to false (most important assertion this cycle)", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const collected = await collectQueueObservation(
      depsFor(dir, createUnavailableApprovalPort()),
    );
    assert.equal(collected.ok, false);
    assert.equal(
      collected.reason,
      COLLECTION_FAILURE_REASON.APPROVAL_UNDECIDABLE,
    );
    assert.equal(collected.observation, undefined);

    const evaluated = await collectAndEvaluateQueue(
      depsFor(dir, createUnavailableApprovalPort()),
    );
    assert.equal(evaluated.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.equal(
      evaluated.reason,
      COLLECTION_FAILURE_REASON.APPROVAL_UNDECIDABLE,
    );
    assert.deepEqual(evaluated.entries, []);
    assert.equal(evaluated.collection.ok, false);
  });
});

test("createUnavailableApprovalPort always reports UNDECIDABLE regardless of commit sha", async () => {
  const port = createUnavailableApprovalPort();
  const a = await port.isHumanApproved("a".repeat(40));
  const b = await port.isHumanApproved("nonsense");
  assert.equal(a.status, "UNDECIDABLE");
  assert.equal(b.status, "UNDECIDABLE");
});

// ---------------------------------------------------------------------------
// C. 스키마 정합 (헛시험 봉인) -- 수집기 출력이 코어 테스트의 스키마 lock과
// 정확히 같은 키 집합인지. 하나라도 늘거나 줄면 RED.
// ---------------------------------------------------------------------------

test("schema conformance: collected observation matches queue-manifest-core.test.mjs's validObservation() key sets exactly", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const collected = await collectQueueObservation(
      depsFor(dir, approvedPort()),
    );
    assert.equal(collected.ok, true);
    const o = collected.observation;

    assert.equal(o.schema_version, OBSERVATION_SCHEMA_VERSION);
    assert.deepEqual(
      Object.keys(o).sort(),
      [
        "schema_version",
        "repo",
        "manifest_commit",
        "manifest_blob",
        "manifest",
        "previous_approved",
      ].sort(),
    );
    assert.deepEqual(
      Object.keys(o.repo).sort(),
      [
        "head_commit",
        "head_branch_name",
        "protected_branch_name",
        "is_dirty",
        "is_alternate_checkout",
      ].sort(),
    );
    assert.deepEqual(
      Object.keys(o.manifest_commit).sort(),
      ["sha", "is_merge_commit", "human_approved"].sort(),
    );
    assert.deepEqual(
      Object.keys(o.manifest_blob).sort(),
      ["sha256", "expected_sha256", "bytes"].sort(),
    );
    assert.deepEqual(
      Object.keys(o.manifest).sort(),
      ["schema_version", "queue_epoch", "entries"].sort(),
    );
    assert.deepEqual(
      Object.keys(o.manifest.entries[0]).sort(),
      ["issue_id", "ordinal", "approved_merge_commit", "enabled"].sort(),
    );

    assert.equal(typeof o.repo.head_commit, "string");
    assert.equal(typeof o.repo.is_dirty, "boolean");
    assert.equal(typeof o.manifest_commit.is_merge_commit, "boolean");
    assert.equal(typeof o.manifest_blob.bytes, "number");
  });
});

// ---------------------------------------------------------------------------
// D. 인자 방어 -- repoRoot 누락/타입 오류, 포트 누락 시 전부 실패 반환
// (예외 없음).
// ---------------------------------------------------------------------------

test("argument defense: missing repoRoot -> ok:false/INVALID_ARGUMENTS, no throw", async () => {
  const result = await collectQueueObservation({
    manifestPath: "queue.json",
    protectedBranch: measuredProtectedBranchPort(),
    previousApproved: null,
    git: createGitRunner("."),
    approval: approvedPort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("argument defense: repoRoot wrong type (number) -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await collectQueueObservation({
    repoRoot: 42,
    manifestPath: "queue.json",
    protectedBranch: measuredProtectedBranchPort(),
    previousApproved: null,
    git: createGitRunner("."),
    approval: approvedPort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("argument defense: git port missing -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await collectQueueObservation({
    repoRoot: ".",
    manifestPath: "queue.json",
    protectedBranch: measuredProtectedBranchPort(),
    previousApproved: null,
    approval: approvedPort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("argument defense: approval port missing -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await collectQueueObservation({
    repoRoot: ".",
    manifestPath: "queue.json",
    protectedBranch: measuredProtectedBranchPort(),
    previousApproved: null,
    git: createGitRunner("."),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("argument defense: previousApproved wrong type (string) -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await collectQueueObservation({
    repoRoot: ".",
    manifestPath: "queue.json",
    protectedBranch: measuredProtectedBranchPort(),
    previousApproved: "nope",
    git: createGitRunner("."),
    approval: approvedPort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("argument defense: protectedBranch port missing -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await collectQueueObservation({
    repoRoot: ".",
    manifestPath: "queue.json",
    previousApproved: null,
    git: createGitRunner("."),
    approval: approvedPort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("argument defense: protectedBranch is a bare string (old call shape) -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await collectQueueObservation({
    repoRoot: ".",
    manifestPath: "queue.json",
    protectedBranch: "main",
    previousApproved: null,
    git: createGitRunner("."),
    approval: approvedPort(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("MEASURED: protectedBranch.measure() fails -> collection failure PROTECTED_BRANCH_UNMEASURED", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const result = await collectQueueObservation(
      depsFor(dir, approvedPort(), {
        protectedBranch: {
          async measure() {
            return { ok: false, reason: "PROTECTED_BRANCH_UNCONFIRMED" };
          },
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      COLLECTION_FAILURE_REASON.PROTECTED_BRANCH_UNMEASURED,
    );
  });
});

test("MEASURED: protectedBranch.measure() throws -> collection failure PROTECTED_BRANCH_UNMEASURED, no throw leaks", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const result = await collectQueueObservation(
      depsFor(dir, approvedPort(), {
        protectedBranch: {
          async measure() {
            throw new Error("network exploded");
          },
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(
      result.reason,
      COLLECTION_FAILURE_REASON.PROTECTED_BRANCH_UNMEASURED,
    );
  });
});

test("MEASURED: protectedBranch.measure() resolves to the git-measured branch name (not a caller-supplied string)", async () => {
  await withTempRepo(buildNormalRepo, async (dir) => {
    const result = await collectQueueObservation(
      depsFor(dir, approvedPort(), {
        protectedBranch: measuredProtectedBranchPort("main"),
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.observation.repo.protected_branch_name, "main");
  });
});

test("argument defense: entirely undefined args -> ok:false/INVALID_ARGUMENTS, no throw", async () => {
  const result = await collectQueueObservation(undefined);
  assert.equal(result.ok, false);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
});

test("collectAndEvaluateQueue also fails closed (not throw) on invalid args", async () => {
  const result = await collectAndEvaluateQueue({});
  assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
  assert.equal(result.reason, COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS);
  assert.deepEqual(result.entries, []);
});
