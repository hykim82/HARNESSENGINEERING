// HYK-183 v1 사이클2a (coder-task.md §3-1) -- 큐 관측 **수집** 어댑터(git 층).
//
// 배경(coder-task.md §1): queue-manifest-core.mjs(evaluateQueueManifest)는
// I/O가 0이라 observation이 진짜 git 저장소에서 왔는지 증명하지 않는다.
// 이 파일이 그 증거를 실제로 재서 코어에 넘기는 어댑터다.
//
// 이 계약이 보장하지 않는 것 (§4 정직 한계):
// 1. `repo.protected_branch_name`은 측정값이 아니라 호출자가 넘긴 인자
//    그대로다. 실제 GitHub 브랜치 보호 설정은 이 어댑터가 조회하지 않는다
//    (그럴 네트워크 접근 자체가 이번 사이클 범위 밖이다).
// 2. `manifest_commit.human_approved`의 권위 있는 공급원이 아직 없다.
//    이번 사이클은 `approval` 포트의 인터페이스만 두고, 이 파일이 export하는
//    유일한 구현체(`createUnavailableApprovalPort`)는 항상 `UNDECIDABLE`을
//    반환한다 -- 즉 이 어댑터로는 실전에서 항상 수집 실패(차단)로 끝난다.
//    실제 GitHub PR 승인 조회는 사이클 2b의 몫이다.
// 3. 표본 수와 조건 -- 이 파일 자체는 표본을 만들지 않는다(전부
//    queue-observation-adapter.test.mjs에 있다). git 표본은 임시 저장소에서
//    측정한 MEASURED, 승인 포트 표본은 손으로 만든 SYNTHETIC이다.
//
// 비타협(coder-task.md §2):
// - `repoRoot`에 기본값 없음 -- 인자 누락은 실패 반환이다(process.cwd() 낙하 금지).
// - 네트워크 호출 0 · GitHub 접근 0(이번 사이클은 git 층만).
// - `orca` 문자열 0.
// - throw로 판정을 대신하지 않는다 -- git/파일/JSON 오류 전부 실패 객체로 변환한다.
// - 판정을 지어내지 않는다 -- 승인 여부가 UNDECIDABLE이면 human_approved를
//   채우지 않고 수집 실패를 반환한다.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  evaluateQueueManifest,
  QUEUE_VERDICT,
} from "./queue-manifest-core.mjs";

export const OBSERVATION_SCHEMA_VERSION = "queue-observation/v1";

export const COLLECTION_FAILURE_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  GIT_UNAVAILABLE: "GIT_UNAVAILABLE",
  GIT_COMMAND_FAILED: "GIT_COMMAND_FAILED",
  MANIFEST_FILE_MISSING: "MANIFEST_FILE_MISSING",
  MANIFEST_FILE_NOT_TRACKED: "MANIFEST_FILE_NOT_TRACKED",
  MANIFEST_JSON_PARSE_FAILED: "MANIFEST_JSON_PARSE_FAILED",
  APPROVAL_UNDECIDABLE: "APPROVAL_UNDECIDABLE",
});

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isFunction(v) {
  return typeof v === "function";
}

function toBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  return Buffer.from(v === null || v === undefined ? "" : String(v), "utf8");
}

function toText(v) {
  return toBuffer(v).toString("utf8").trim();
}

function failure(reason, detail) {
  return { ok: false, reason, detail };
}

function ok(value) {
  return { ok: true, ...value };
}

// 인자 방어(§3-3 D) -- 예외가 아니라 실패 객체를 반환한다.
function validateArgs(args) {
  if (!isPlainObject(args)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "args must be a plain object",
    );
  }
  const {
    repoRoot,
    manifestPath,
    protectedBranchName,
    previousApproved,
    git,
    approval,
  } = args;
  if (!isNonEmptyString(repoRoot)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "repoRoot missing/invalid",
    );
  }
  if (!isNonEmptyString(manifestPath)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "manifestPath missing/invalid",
    );
  }
  if (!isNonEmptyString(protectedBranchName)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "protectedBranchName missing/invalid",
    );
  }
  if (previousApproved !== null && !isPlainObject(previousApproved)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "previousApproved must be null or a plain object",
    );
  }
  if (!isPlainObject(git) || !isFunction(git.run)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "git port missing/invalid",
    );
  }
  if (!isPlainObject(approval) || !isFunction(approval.isHumanApproved)) {
    return failure(
      COLLECTION_FAILURE_REASON.INVALID_ARGUMENTS,
      "approval port missing/invalid",
    );
  }
  return null;
}

// git 실 구현 러너 -- child_process.execFile로 `git -C <repoRoot> <args...>`를
// 돈다. shell:false(인자 배열 그대로, 셸 해석 없음).
export function createGitRunner(repoRoot) {
  return {
    run(args) {
      return new Promise((resolve) => {
        execFile(
          "git",
          ["-C", repoRoot, ...args],
          { encoding: null, shell: false, windowsHide: true },
          (err, stdout, stderr) => {
            if (err && typeof err.code !== "number") {
              resolve({
                code: null,
                stdout: stdout ?? Buffer.alloc(0),
                stderr: stderr ?? Buffer.from(String(err)),
              });
              return;
            }
            const code = err
              ? typeof err.code === "number"
                ? err.code
                : 1
              : 0;
            resolve({
              code,
              stdout: stdout ?? Buffer.alloc(0),
              stderr: stderr ?? Buffer.alloc(0),
            });
          },
        );
      });
    },
  };
}

// 명시적 실패 포트 -- 항상 UNDECIDABLE을 반환한다. GitHub 권위 조회로
// 교체되는 것은 사이클 2b다. "기본 승인"으로 읽히지 않도록 이름을 골랐다.
export function createUnavailableApprovalPort() {
  return {
    async isHumanApproved() {
      return {
        status: "UNDECIDABLE",
        evidence: {
          source: "createUnavailableApprovalPort",
          note: "no GitHub authority query exists yet -- replaced in cycle 2b",
        },
      };
    },
  };
}

async function runGit(git, args) {
  let result;
  try {
    result = await git.run(args);
  } catch (err) {
    return failure(
      COLLECTION_FAILURE_REASON.GIT_UNAVAILABLE,
      err && err.message ? err.message : String(err),
    );
  }
  if (!result || typeof result.code !== "number") {
    return failure(
      COLLECTION_FAILURE_REASON.GIT_UNAVAILABLE,
      "git port returned malformed result",
    );
  }
  if (result.code !== 0) {
    return failure(
      COLLECTION_FAILURE_REASON.GIT_COMMAND_FAILED,
      toText(result.stderr),
    );
  }
  return ok({ stdout: result.stdout });
}

async function collectRepoSection({ protectedBranchName, git }) {
  const headCommit = await runGit(git, ["rev-parse", "HEAD"]);
  if (!headCommit.ok) return headCommit;
  const headBranch = await runGit(git, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!headBranch.ok) return headBranch;
  const status = await runGit(git, ["status", "--porcelain"]);
  if (!status.ok) return status;
  const gitDir = await runGit(git, ["rev-parse", "--git-dir"]);
  if (!gitDir.ok) return gitDir;
  const gitCommonDir = await runGit(git, ["rev-parse", "--git-common-dir"]);
  if (!gitCommonDir.ok) return gitCommonDir;

  const resolvedGitDir = path.resolve(toText(gitDir.stdout));
  const resolvedCommonDir = path.resolve(toText(gitCommonDir.stdout));

  return ok({
    repo: {
      head_commit: toText(headCommit.stdout),
      head_branch_name: toText(headBranch.stdout),
      protected_branch_name: protectedBranchName,
      is_dirty: toText(status.stdout).length > 0,
      is_alternate_checkout: resolvedGitDir !== resolvedCommonDir,
    },
  });
}

function toGitPathArg(manifestPath) {
  return manifestPath.split(path.sep).join("/");
}

async function resolveApproval(approval, sha) {
  const verdict = await approval.isHumanApproved(sha);
  if (!isPlainObject(verdict) || !isNonEmptyString(verdict.status)) {
    return failure(
      COLLECTION_FAILURE_REASON.APPROVAL_UNDECIDABLE,
      "malformed approval verdict",
    );
  }
  if (verdict.status === "APPROVED") return ok({ humanApproved: true });
  if (verdict.status === "NOT_APPROVED") return ok({ humanApproved: false });
  return failure(
    COLLECTION_FAILURE_REASON.APPROVAL_UNDECIDABLE,
    verdict.evidence,
  );
}

async function collectManifestCommitSection({ manifestPath, git, approval }) {
  const gitPath = toGitPathArg(manifestPath);
  const shaResult = await runGit(git, [
    "rev-list",
    "-1",
    "HEAD",
    "--",
    gitPath,
  ]);
  if (!shaResult.ok) return shaResult;
  const sha = toText(shaResult.stdout);
  if (!isNonEmptyString(sha)) {
    return failure(
      COLLECTION_FAILURE_REASON.MANIFEST_FILE_NOT_TRACKED,
      "no commit touches manifestPath reachable from HEAD",
    );
  }
  const parentsResult = await runGit(git, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    sha,
  ]);
  if (!parentsResult.ok) return parentsResult;
  const parentCount =
    toText(parentsResult.stdout).split(/\s+/).filter(Boolean).length - 1;

  const approvalResult = await resolveApproval(approval, sha);
  if (!approvalResult.ok) return approvalResult;

  return ok({
    manifestCommit: {
      sha,
      is_merge_commit: parentCount >= 2,
      human_approved: approvalResult.humanApproved,
    },
  });
}

async function readManifestWorktreeBytes(repoRoot, manifestPath) {
  try {
    const bytes = await readFile(path.join(repoRoot, manifestPath));
    return ok({ bytes });
  } catch (err) {
    return failure(
      COLLECTION_FAILURE_REASON.MANIFEST_FILE_MISSING,
      err.message,
    );
  }
}

function parseManifestJson(bytes) {
  try {
    return ok({ manifest: JSON.parse(bytes.toString("utf8")) });
  } catch (err) {
    return failure(
      COLLECTION_FAILURE_REASON.MANIFEST_JSON_PARSE_FAILED,
      err.message,
    );
  }
}

async function collectManifestBlobSection({
  repoRoot,
  manifestPath,
  manifestSha,
  git,
}) {
  const worktreeRead = await readManifestWorktreeBytes(repoRoot, manifestPath);
  if (!worktreeRead.ok) return worktreeRead;

  const parsed = parseManifestJson(worktreeRead.bytes);
  if (!parsed.ok) return parsed;

  const gitPath = toGitPathArg(manifestPath);
  const blobResult = await runGit(git, [
    "cat-file",
    "blob",
    `${manifestSha}:${gitPath}`,
  ]);
  if (!blobResult.ok) return blobResult;
  const expectedBytes = toBuffer(blobResult.stdout);

  return ok({
    manifestBlob: {
      sha256: createHash("sha256").update(worktreeRead.bytes).digest("hex"),
      expected_sha256: createHash("sha256").update(expectedBytes).digest("hex"),
      bytes: worktreeRead.bytes.length,
    },
    manifest: parsed.manifest,
  });
}

// collectQueueObservation(args) -> Promise<{ok:true, observation} | {ok:false, reason, detail}>
//
// 코어(queue-manifest-core.mjs)의 evaluateQueueManifest가 요구하는 정확한
// 형태로 observation을 조립한다. 각 절 수집이 실패하면 즉시 그 실패를
// 반환한다(부분 observation을 만들지 않는다).
export async function collectQueueObservation(args) {
  const argError = validateArgs(args);
  if (argError) return argError;

  const {
    repoRoot,
    manifestPath,
    protectedBranchName,
    previousApproved,
    git,
    approval,
  } = args;

  const repoSection = await collectRepoSection({ protectedBranchName, git });
  if (!repoSection.ok) return repoSection;

  const manifestCommitSection = await collectManifestCommitSection({
    manifestPath,
    git,
    approval,
  });
  if (!manifestCommitSection.ok) return manifestCommitSection;

  const manifestBlobSection = await collectManifestBlobSection({
    repoRoot,
    manifestPath,
    manifestSha: manifestCommitSection.manifestCommit.sha,
    git,
  });
  if (!manifestBlobSection.ok) return manifestBlobSection;

  return {
    ok: true,
    observation: {
      schema_version: OBSERVATION_SCHEMA_VERSION,
      repo: repoSection.repo,
      manifest_commit: manifestCommitSection.manifestCommit,
      manifest_blob: {
        sha256: manifestBlobSection.manifestBlob.sha256,
        expected_sha256: manifestBlobSection.manifestBlob.expected_sha256,
        bytes: manifestBlobSection.manifestBlob.bytes,
      },
      manifest: manifestBlobSection.manifest,
      previous_approved: previousApproved,
    },
  };
}

// collectAndEvaluateQueue(deps) -> Promise<{verdict, reason, entries, collection?}>
//
// 수집 성공 -> evaluateQueueManifest(observation) 결과를 그대로 돌려준다.
// 수집 실패 -> START_BLOCKED + 수집 실패 사유 + entries: [].
export async function collectAndEvaluateQueue(deps) {
  const collected = await collectQueueObservation(deps);
  if (!collected.ok) {
    return {
      verdict: QUEUE_VERDICT.START_BLOCKED,
      reason: collected.reason,
      entries: [],
      collection: {
        ok: false,
        reason: collected.reason,
        detail: collected.detail,
      },
    };
  }
  const verdictResult = evaluateQueueManifest(collected.observation);
  return { ...verdictResult, collection: { ok: true } };
}
