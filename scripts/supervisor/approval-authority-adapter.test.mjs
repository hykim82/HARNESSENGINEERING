import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  APPROVAL_STATUS,
  APPROVAL_REASON,
  createAnonymousFetchJson,
  measureRepoIdentity,
  measureProtectedBranch,
  readApproverAllowlist,
  createGitHubApprovalPort,
} from "./approval-authority-adapter.mjs";
import {
  collectAndEvaluateQueue,
  createGitRunner,
} from "./queue-observation-adapter.mjs";
import { QUEUE_VERDICT, QUEUE_REASON } from "./queue-manifest-core.mjs";

// HYK-183 v1 사이클2b (coder-task.md §4) -- approval-authority-adapter.mjs
// 테스트. 프로덕션 export를 직접 구동한다(테스트 전용 헬퍼 안에서만 계약이
// 성립하면 헛시험이다).
//
// 이 계약이 보장하지 않는 것 (상시기준 S11):
// 1. 주장 범위 -- 이 파일의 픽스처는 D:\문서관리\하네스-관제실\증거\
//    2026-07-30-approval-rest\*.json을 그대로(HTTP 상태·필드명·값 불변)
//    인라인한 것이거나(MEASURED), 그것을 변형한 SYNTHETIC이다. 실제
//    네트워크는 이 파일 어디서도 타지 않는다(가짜 fetchJson만 쓴다).
// 2. 표본 -- MEASURED 2건(PR #70·#71), 함정 1건(commit-985249f-pulls.json),
//    나머지는 변형.

// ---------------------------------------------------------------------------
// 실측 픽스처 (원본 그대로 -- HTTP 상태/필드명/값 불변, 프로젝트 크기상
// 필요한 필드만 옮겨 적었으나 값은 원본과 정확히 같다)
// ---------------------------------------------------------------------------

const REPO_FULL_NAME = "hykim82/HARNESSENGINEERING";
const OWNER = { login: "hykim82", id: 286230306 };
const BOT_AUTHOR = { login: "codexlocal101-rgb", id: 300438013 };

const REPO_RESPONSE_JSON = { default_branch: "master" };

function branchResponseJson(headSha, protectedFlag = true) {
  return { name: "master", protected: protectedFlag, commit: { sha: headSha } };
}

// PR #71 (merge commit bb58152..., head 985249f...) -- pull-71.json 실측치.
const PULL_71_MERGE_SHA = "bb58152b79051dda8ceb92fd9d72ec75f881c294";
const PULL_71_HEAD_SHA = "985249f7515e61a2e811f5de6e520568c58d7f90";
const PULL_71_BASE_SHA = "e022fbda5bbbd765805ea12b11875c14f082304a";

// 재작업 2R P1-5 -- 실측 branch-master.json의 현재 보호 브랜치(master) head는
// bb58152...다(= 이 저장소의 최신 병합이 PR #71이었기 때문에 우연이 아니라
// PULL_71_MERGE_SHA와 같은 값이다). 이 수집기는 "판정 대상 sha == 보호
// 브랜치 head"를 요구하지 않는다(그 대조는 코어의
// repo.head_commit === manifest_commit.sha 몫) -- 그래서 PR #70 시나리오도
// 이 실측 head를 protected-branch head / allowlist ref로 그대로 쓸 수 있다
// (ORCH 판정, coder-task.md §10 P1-5). MEASURED로 표시된 테스트는 반드시 이
// 값을 쓴다. PULL_71_BASE_SHA는 실측값이 아니라 다른(비-MEASURED) 반례
// 테스트에서 "일관되기만 하면 되는" 임의 SYNTHETIC 보호-브랜치-head
// 자리표시자로만 쓴다 -- 그 테스트들은 MEASURED를 주장하지 않는다.
const MEASURED_PROTECTED_HEAD_SHA = PULL_71_MERGE_SHA; // "bb58152b79051dda8ceb92fd9d72ec75f881c294", branch-master.json 실측

function pull71DetailJson(overrides = {}) {
  return {
    number: 71,
    merged: true,
    merge_commit_sha: PULL_71_MERGE_SHA,
    base: { ref: "master", sha: PULL_71_BASE_SHA },
    head: { ref: "hykim82/hyk183-v1c2", sha: PULL_71_HEAD_SHA },
    user: { login: BOT_AUTHOR.login, id: BOT_AUTHOR.id },
    ...overrides,
  };
}

function commitPullsListJson(shaThatLinks) {
  return [
    {
      number: 71,
      merge_commit_sha: shaThatLinks,
      base: { ref: "master" },
      head: { sha: PULL_71_HEAD_SHA },
    },
  ];
}

function pull71ReviewJson(overrides = {}) {
  return [
    {
      id: 4806923224,
      user: { login: OWNER.login, id: OWNER.id },
      state: "APPROVED",
      commit_id: PULL_71_HEAD_SHA,
      submitted_at: "2026-07-29T10:23:25Z",
      ...overrides,
    },
  ];
}

// PR #70 (merge commit bd41688..., head 6129a3c... base) -- pull-70.json 실측치.
const PULL_70_MERGE_SHA = "e022fbda5bbbd765805ea12b11875c14f082304a";
const PULL_70_HEAD_SHA = "bd4168856d1702a2b0f65c5155c1fd48a0c75f2e";

function pull70DetailJson(overrides = {}) {
  return {
    number: 70,
    merged: true,
    merge_commit_sha: PULL_70_MERGE_SHA,
    base: { ref: "master", sha: "6129a3ca3ee16660dde3e37fe3bb5f67cf1a17fd" },
    head: { ref: "hykim82/hyk183-v1c1", sha: PULL_70_HEAD_SHA },
    user: { login: BOT_AUTHOR.login, id: BOT_AUTHOR.id },
    ...overrides,
  };
}

function commitPullsListJson70(shaThatLinks) {
  return [
    {
      number: 70,
      merge_commit_sha: shaThatLinks,
      base: { ref: "master" },
      head: { sha: PULL_70_HEAD_SHA },
    },
  ];
}

function pull70ReviewJson(overrides = {}) {
  return [
    {
      id: 4804923377,
      user: { login: OWNER.login, id: OWNER.id },
      state: "APPROVED",
      commit_id: PULL_70_HEAD_SHA,
      submitted_at: "2026-07-29T06:57:01Z",
      ...overrides,
    },
  ];
}

// 함정 표본(실측) -- head 커밋 985249f로 조회해도 같은 PR #71이 1건
// 반환된다(merge_commit_sha는 bb58152, sha는 985249f -- 다르다).
const TRAP_HEAD_SHA = PULL_71_HEAD_SHA;
function trapCommitPullsListJson() {
  return commitPullsListJson(PULL_71_MERGE_SHA); // merge_commit_sha !== TRAP_HEAD_SHA
}

// ---------------------------------------------------------------------------
// 가짜 포트 빌더
// ---------------------------------------------------------------------------

function jsonResp(json, { status = 200, linkHeader = null } = {}) {
  return { ok: true, status, json, linkHeader, rawTextLength: 1 };
}
function errorResp(status, json = { message: "error" }) {
  return { ok: false, status, json, linkHeader: null, rawTextLength: 1 };
}

// scriptedFetchJson: URL 접미사 패턴 -> 응답 큐. 호출 인자 전체를 기록한다
// (§4-9 자격증명 0 관측용).
function scriptedFetchJson(routes) {
  const calls = [];
  const fetchJson = async (opts) => {
    calls.push(opts);
    for (const [matcher, respond] of routes) {
      const matches =
        typeof matcher === "function"
          ? matcher(opts.url)
          : opts.url.includes(matcher);
      if (matches) {
        const r = typeof respond === "function" ? respond(opts) : respond;
        return r;
      }
    }
    throw new Error(`scriptedFetchJson: no route for ${opts.url}`);
  };
  return { fetchJson, calls };
}

function normalRoutes({
  headSha,
  protectedFlag = true,
  pullNumber = 71,
  pullDetail = pull71DetailJson(),
  commitPulls = commitPullsListJson(PULL_71_MERGE_SHA),
  reviews = pull71ReviewJson(),
  reviewsLinkHeader = null,
} = {}) {
  return [
    [
      "/repos/hykim82/HARNESSENGINEERING/branches/",
      () => jsonResp(branchResponseJson(headSha, protectedFlag)),
    ],
    [
      (url) => url.endsWith(`/repos/${REPO_FULL_NAME}`),
      () => jsonResp(REPO_RESPONSE_JSON),
    ],
    [`/commits/`, () => jsonResp(commitPulls)],
    [
      `/pulls/${pullNumber}/reviews`,
      () => jsonResp(reviews, { linkHeader: reviewsLinkHeader }),
    ],
    [`/pulls/${pullNumber}`, () => jsonResp(pullDetail)],
  ];
}

function gitPortRemote(files) {
  return {
    code: 0,
    stdout: Buffer.from(
      files.remoteUrl ?? "https://github.com/hykim82/HARNESSENGINEERING.git",
    ),
    stderr: Buffer.alloc(0),
  };
}

function gitPortRevParse(files) {
  return {
    code: 0,
    stdout: Buffer.from(files.originMasterSha),
    stderr: Buffer.alloc(0),
  };
}

function gitPortCatFile(files, args) {
  const ref = args[2]; // "origin/master:<path>"
  const blobPath = ref.split(":").slice(1).join(":");
  const content = files.blobs && files.blobs[blobPath];
  if (content === undefined) {
    return {
      code: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("not found"),
    };
  }
  return { code: 0, stdout: Buffer.from(content), stderr: Buffer.alloc(0) };
}

function gitPort(files, extra = {}) {
  // files: { "origin/master" ref sha, blobs: { path: content } }
  return {
    async run(args) {
      const [cmd] = args;
      if (extra.throwOn && extra.throwOn(args)) {
        throw new Error("git port exploded");
      }
      if (cmd === "remote" && args[1] === "get-url" && args[2] === "origin") {
        return gitPortRemote(files);
      }
      if (cmd === "rev-parse" && args[1] === "origin/master") {
        return gitPortRevParse(files);
      }
      if (cmd === "cat-file" && args[1] === "blob") {
        return gitPortCatFile(files, args);
      }
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`unhandled: ${args.join(" ")}`),
      };
    },
  };
}

function allowlistJsonText(overrides = {}) {
  return JSON.stringify({
    schema_version: "approver-allowlist/v1",
    repo: REPO_FULL_NAME,
    approvers: [{ login: OWNER.login, id: OWNER.id }],
    ...overrides,
  });
}

function normalGitPort(overrides = {}) {
  return gitPort({
    remoteUrl: "https://github.com/hykim82/HARNESSENGINEERING.git",
    originMasterSha: PULL_71_BASE_SHA, // must equal the protected branch head sha
    blobs: {
      "scripts/supervisor/approver-allowlist.json": allowlistJsonText(),
    },
    ...overrides,
  });
}

const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";

async function isHumanApprovedFor({
  sha = PULL_71_MERGE_SHA,
  routes,
  git = normalGitPort(),
  allowlistPath = ALLOWLIST_PATH,
  callBudget,
} = {}) {
  const { fetchJson, calls } = scriptedFetchJson(
    routes ?? normalRoutes({ headSha: PULL_71_BASE_SHA }),
  );
  const port = createGitHubApprovalPort({
    fetchJson,
    git,
    allowlistPath,
    callBudget,
  });
  const verdict = await port.isHumanApproved(sha);
  return { verdict, calls };
}

// ---------------------------------------------------------------------------
// 1. 정상 승인 경로 (MEASURED) -- 표본 2건
// ---------------------------------------------------------------------------

test("MEASURED PR #71: normal approval path -> APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    sha: PULL_71_MERGE_SHA,
    routes: normalRoutes({ headSha: MEASURED_PROTECTED_HEAD_SHA }),
    git: normalGitPort({ originMasterSha: MEASURED_PROTECTED_HEAD_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.APPROVED);
});

test("MEASURED PR #70: normal approval path -> APPROVED (second sample, generalization check)", async () => {
  const { verdict } = await isHumanApprovedFor({
    sha: PULL_70_MERGE_SHA,
    routes: normalRoutes({
      headSha: MEASURED_PROTECTED_HEAD_SHA,
      pullNumber: 70,
      pullDetail: pull70DetailJson(),
      commitPulls: commitPullsListJson70(PULL_70_MERGE_SHA),
      reviews: pull70ReviewJson(),
    }),
    git: normalGitPort({ originMasterSha: MEASURED_PROTECTED_HEAD_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.APPROVED);
});

// ---------------------------------------------------------------------------
// 2. evidence 내용 검사 -- 개수/최종상태뿐 아니라 필드 값이 측정값과
//    정확히 일치하는지.
// ---------------------------------------------------------------------------

test("evidence: APPROVED evidence fields exactly match the measured values (PR #71)", async () => {
  const { verdict } = await isHumanApprovedFor({
    sha: PULL_71_MERGE_SHA,
    routes: normalRoutes({ headSha: MEASURED_PROTECTED_HEAD_SHA }),
    git: normalGitPort({ originMasterSha: MEASURED_PROTECTED_HEAD_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.APPROVED);
  assert.deepEqual(verdict.evidence, {
    repo_full_name: REPO_FULL_NAME,
    protected_branch_name: "master",
    protected_head_sha: MEASURED_PROTECTED_HEAD_SHA,
    allowlist_ref_sha: MEASURED_PROTECTED_HEAD_SHA,
    pull_number: 71,
    pull_head_sha: PULL_71_HEAD_SHA,
    merge_commit_sha: PULL_71_MERGE_SHA,
    review_id: 4806923224,
    reviewer_login: OWNER.login,
    reviewer_id: OWNER.id,
    author_login: BOT_AUTHOR.login,
    author_id: BOT_AUTHOR.id,
    rest_call_count: 5,
  });
});

// ---------------------------------------------------------------------------
// 3. 사유 코드 전건 반례 -- APPROVAL_REASON의 각 코드 최소 1개.
// ---------------------------------------------------------------------------

test("REASON: NO_APPROVING_REVIEW -> empty reviews list, status NOT_APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA, reviews: [] }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.NO_APPROVING_REVIEW);
});

test("REASON: REVIEW_COMMIT_MISMATCH -> approving review commit_id != PR head sha, status NOT_APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({ commit_id: "c".repeat(40) }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.REVIEW_COMMIT_MISMATCH);
});

test("REASON: REVIEWER_NOT_ALLOWLISTED -> review from someone not on the allowlist, status NOT_APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({
        user: { login: "someone-else", id: 999999 },
      }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.REVIEWER_NOT_ALLOWLISTED,
  );
});

test("REASON: REVIEWER_IS_AUTHOR -> allowlisted approver is also the PR author, status NOT_APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      pullDetail: pull71DetailJson({
        user: { login: OWNER.login, id: OWNER.id },
      }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.REVIEWER_IS_AUTHOR);
});

test("REASON: LAST_REVIEW_NOT_APPROVED -> allowlisted approver's last review is CHANGES_REQUESTED, status NOT_APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({ state: "CHANGES_REQUESTED" }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.LAST_REVIEW_NOT_APPROVED,
  );
});

test("REASON: INVALID_ARGUMENTS -> sha missing, status UNDECIDABLE", async () => {
  const { fetchJson } = scriptedFetchJson([]);
  const port = createGitHubApprovalPort({
    fetchJson,
    git: normalGitPort(),
    allowlistPath: ALLOWLIST_PATH,
  });
  const verdict = await port.isHumanApproved(undefined);
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.INVALID_ARGUMENTS);
});

test("REASON: HTTP_FAILED -> repo fetch 500, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: [
      [(url) => url.endsWith(`/repos/${REPO_FULL_NAME}`), () => errorResp(500)],
    ],
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("REASON: RATE_LIMITED -> 403 with rate-limit body, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: [
      [
        (url) => url.endsWith(`/repos/${REPO_FULL_NAME}`),
        () => errorResp(403, { message: "API rate limit exceeded" }),
      ],
    ],
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.RATE_LIMITED);
});

test("REASON: MALFORMED_PAYLOAD -> repo response missing default_branch, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: [
      [(url) => url.endsWith(`/repos/${REPO_FULL_NAME}`), () => jsonResp({})],
    ],
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("REASON: PAGINATION_UNHANDLED -> reviews response has Link rel=next, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviewsLinkHeader: '<https://api.github.com/x?page=2>; rel="next"',
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.PAGINATION_UNHANDLED);
});

test("REASON: CALL_BUDGET_EXCEEDED -> callBudget too small, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
    callBudget: 2,
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.CALL_BUDGET_EXCEEDED);
});

test("REASON: NO_PR_LINK -> commits/pulls list is empty, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA, commitPulls: [] }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.NO_PR_LINK);
});

test("REASON: MULTIPLE_PR_LINKS -> two PRs both match merge_commit_sha, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      commitPulls: [
        ...commitPullsListJson(PULL_71_MERGE_SHA),
        {
          number: 72,
          merge_commit_sha: PULL_71_MERGE_SHA,
          base: { ref: "master" },
          head: { sha: "d".repeat(40) },
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MULTIPLE_PR_LINKS);
});

test("REASON: PR_NOT_MERGED -> pull detail merged:false, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      pullDetail: pull71DetailJson({ merged: false }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.PR_NOT_MERGED);
});

test("REASON: BASE_NOT_PROTECTED_BRANCH -> pull detail base.ref != measured protected branch, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      pullDetail: pull71DetailJson({
        base: { ref: "some-feature", sha: PULL_71_BASE_SHA },
      }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.BASE_NOT_PROTECTED_BRANCH,
  );
});

test("REASON: PROTECTED_BRANCH_UNCONFIRMED -> branches/{b} protected:false, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA, protectedFlag: false }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.PROTECTED_BRANCH_UNCONFIRMED,
  );
});

test("REASON: REPO_IDENTITY_MISMATCH -> git remote.origin.url is not a github.com URL, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    git: normalGitPort({ remoteUrl: "https://gitlab.com/hykim82/other.git" }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.REPO_IDENTITY_MISMATCH);
});

test("REASON: ALLOWLIST_UNREADABLE -> cat-file blob fails (file missing at origin/master), status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA, blobs: {} }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_UNREADABLE);
});

test("REASON: ALLOWLIST_MALFORMED -> allowlist entry missing id, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({
      originMasterSha: PULL_71_BASE_SHA,
      blobs: {
        "scripts/supervisor/approver-allowlist.json": JSON.stringify({
          schema_version: "approver-allowlist/v1",
          repo: REPO_FULL_NAME,
          approvers: [{ login: OWNER.login }],
        }),
      },
    }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_MALFORMED);
});

test("REASON: ALLOWLIST_REPO_MISMATCH -> allowlist.repo != measured repo, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({
      originMasterSha: PULL_71_BASE_SHA,
      blobs: {
        "scripts/supervisor/approver-allowlist.json": allowlistJsonText({
          repo: "someone-else/other-repo",
        }),
      },
    }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.ALLOWLIST_REPO_MISMATCH,
  );
});

test("REASON: ALLOWLIST_REF_MISMATCH -> local origin/master sha != GitHub protected branch head, status UNDECIDABLE", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({ originMasterSha: "f".repeat(40) }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_REF_MISMATCH);
});

// MERGE_SHA_MISMATCH is covered separately below (§4-4, the trap sample).

// ---------------------------------------------------------------------------
// 4. 함정 반례(필수) -- head 커밋으로 조회해도 같은 PR이 1건 반환된다.
// ---------------------------------------------------------------------------

test("TRAP: querying by head commit (985249f...) returns the same PR #71, but merge_commit_sha differs -> MERGE_SHA_MISMATCH", async () => {
  const { verdict } = await isHumanApprovedFor({
    sha: TRAP_HEAD_SHA,
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      commitPulls: trapCommitPullsListJson(),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MERGE_SHA_MISMATCH);
});

// ---------------------------------------------------------------------------
// 5. 명단 위조 반례 -- 작업 폴더 판본이 아니라 origin/master 판본만 본다.
// ---------------------------------------------------------------------------

test("FORGERY: a git port whose worktree file differs from the origin/master blob is irrelevant -- only the blob is read", async () => {
  // gitPort() only ever answers cat-file blob queries for "origin/master:<path>"
  // -- there is no worktree-read code path in readApproverAllowlist at all.
  // This test proves the port contract never asks for anything else by
  // making the port throw on any other kind of read.
  const forgedWorktreeAwareGit = {
    async run(args) {
      const [cmd] = args;
      if (cmd === "remote") {
        return {
          code: 0,
          stdout: Buffer.from(
            "https://github.com/hykim82/HARNESSENGINEERING.git",
          ),
          stderr: Buffer.alloc(0),
        };
      }
      if (cmd === "rev-parse" && args[1] === "origin/master") {
        return {
          code: 0,
          stdout: Buffer.from(PULL_71_BASE_SHA),
          stderr: Buffer.alloc(0),
        };
      }
      if (cmd === "cat-file" && args[1] === "blob") {
        const ref = args[2];
        assert.ok(
          ref.startsWith("origin/master:"),
          `expected an origin/master blob read, got: ${ref}`,
        );
        return {
          code: 0,
          stdout: Buffer.from(
            allowlistJsonText({ approvers: [{ login: "attacker", id: 1 }] }),
          ),
          stderr: Buffer.alloc(0),
        };
      }
      throw new Error(
        `unexpected git call outside the origin/master contract: ${args.join(" ")}`,
      );
    },
  };
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: forgedWorktreeAwareGit,
  });
  // The attacker-controlled allowlist does not include the real owner, so
  // the real owner's review no longer matches any allowlisted approver.
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.REVIEWER_NOT_ALLOWLISTED,
  );
});

// ---------------------------------------------------------------------------
// 6. ref 불일치 반례 -- 위 REASON 섹션의 ALLOWLIST_REF_MISMATCH 테스트가
//    이를 담당한다(중복 생략, §4-6 요구는 위에서 충족됨).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. 리뷰어=작성자 / 명단 외 리뷰어 / 승인 후 CHANGES_REQUESTED 반례
//    (위 REASON 섹션에서 이미 다룸: REVIEWER_IS_AUTHOR,
//    REVIEWER_NOT_ALLOWLISTED, LAST_REVIEW_NOT_APPROVED). 여기서는 "승인
//    후 나중 리뷰가 CHANGES_REQUESTED" 시나리오를 리뷰 2건으로 명시적으로
//    검증한다(마지막 리뷰만 본다는 것 자체를 단언).
// ---------------------------------------------------------------------------

test("§4-7: approver approves, then later requests changes -> last review wins -> LAST_REVIEW_NOT_APPROVED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00Z",
        },
        {
          id: 2,
          user: { login: OWNER.login, id: OWNER.id },
          state: "CHANGES_REQUESTED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:20:00Z",
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.LAST_REVIEW_NOT_APPROVED,
  );
  assert.equal(verdict.evidence.review_id, 2);
});

// ---------------------------------------------------------------------------
// 7b (재작업 3R, coder-task.md §11 -- 한용 게이트 2 지시) -- "마지막 리뷰"는
// submitted_at(제출 시각) 기준으로 결정한다, 응답 배열 순서를 신뢰하지
// 않는다. 위 §4-7 테스트는 목록 순서와 시각 순서가 우연히 같아서(먼저
// 나온 원소가 실제로도 더 이른 시각) 순서 독립성을 증명하지 못한다 --
// 아래 세 반례가 목록 순서와 시각 순서를 **일부러 어긋나게** 만든다.
// ---------------------------------------------------------------------------

test("§11(a): list order says APPROVED-was-last, but submitted_at says CHANGES_REQUESTED is later -> NOT_APPROVED/LAST_REVIEW_NOT_APPROVED (array order must not win)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 2,
          user: { login: OWNER.login, id: OWNER.id },
          state: "CHANGES_REQUESTED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:20:00Z", // 더 늦은 시각, 목록에서는 먼저 나온다
        },
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00Z", // 더 이른 시각, 목록에서는 나중에 나온다(=배열 순서로는 "마지막")
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.LAST_REVIEW_NOT_APPROVED,
  );
  assert.equal(
    verdict.evidence.review_id,
    2,
    "must pick review id 2 (CHANGES_REQUESTED, later submitted_at), not id 1 which is merely last in the array",
  );
});

test("§11(b): list order says CHANGES_REQUESTED-was-last, but submitted_at says APPROVED is later -> APPROVED (sorting works in both directions)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:20:00Z", // 더 늦은 시각, 목록에서는 먼저 나온다
        },
        {
          id: 2,
          user: { login: OWNER.login, id: OWNER.id },
          state: "CHANGES_REQUESTED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00Z", // 더 이른 시각, 목록에서는 나중에 나온다(=배열 순서로는 "마지막")
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.APPROVED);
  assert.equal(
    verdict.evidence.review_id,
    1,
    "must pick review id 1 (APPROVED, later submitted_at), not id 2 which is merely last in the array",
  );
});

test("§11(c): same reviewer, identical submitted_at -> MALFORMED_PAYLOAD (cannot determine which review is last, fail-closed instead of picking one arbitrarily)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00Z",
        },
        {
          id: 2,
          user: { login: OWNER.login, id: OWNER.id },
          state: "CHANGES_REQUESTED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00Z", // 정확히 동일 시각
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("§11: same reviewer, submitted_at differs only in a way that still parses to the identical timestamp (e.g. explicit +00:00 vs Z) -> MALFORMED_PAYLOAD", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00Z",
        },
        {
          id: 2,
          user: { login: OWNER.login, id: OWNER.id },
          state: "CHANGES_REQUESTED",
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:00:00+00:00", // Date.parse로는 동일 시각
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

// ---------------------------------------------------------------------------
// 8. user.type 무의존 증명
// ---------------------------------------------------------------------------

test('§4-8: reviewer type changed to "Bot" does not change the verdict (login+id is the only identity check)', async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({
        user: { login: OWNER.login, id: OWNER.id, type: "Bot" },
      }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.APPROVED);
});

test('§4-8: a type:"User" bot author cannot pass as an approver merely by having type User (login/id decide, not type)', async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      // Bot author has type "User" per pull-71.json, but its login/id is not
      // on the allowlist, so it cannot approve regardless of `type`.
      reviews: pull71ReviewJson({
        user: { login: BOT_AUTHOR.login, id: BOT_AUTHOR.id, type: "User" },
      }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.NOT_APPROVED);
  assert.equal(
    verdict.evidence.reason,
    APPROVAL_REASON.REVIEWER_NOT_ALLOWLISTED,
  );
});

// ---------------------------------------------------------------------------
// 9. 자격증명 0 관측 테스트
// ---------------------------------------------------------------------------

test("§4-9: no fetchJson call ever carries an Authorization/Cookie header", async () => {
  const { calls } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.ok(
    calls.length >= 4,
    "expected multiple REST calls to have been recorded",
  );
  for (const call of calls) {
    const keys = Object.keys(call).map((k) => k.toLowerCase());
    assert.ok(!keys.includes("authorization"));
    assert.ok(!keys.includes("cookie"));
    if (call.headers) {
      const headerKeys = Object.keys(call.headers).map((k) => k.toLowerCase());
      assert.ok(!headerKeys.includes("authorization"));
      assert.ok(!headerKeys.includes("cookie"));
    }
  }
});

test("§4-9: createAnonymousFetchJson issues no auth headers and never touches the network (fetch is stubbed)", async () => {
  const originalFetch = globalThis.fetch;
  const capturedRequests = [];
  globalThis.fetch = async (url, init) => {
    capturedRequests.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async text() {
        return "{}";
      },
    };
  };
  try {
    const { fetchJson } = createAnonymousFetchJson();
    const result = await fetchJson({
      url: "https://api.github.com/repos/hykim82/HARNESSENGINEERING",
    });
    assert.equal(result.ok, true);
    assert.equal(capturedRequests.length, 1);
    const headers = capturedRequests[0].init.headers;
    const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    assert.ok(!headerKeys.includes("authorization"));
    assert.ok(!headerKeys.includes("cookie"));
    assert.deepEqual(headers, {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 10. 호출 예산 · rate limit (RATE_LIMITED/CALL_BUDGET_EXCEEDED 각각 위
//     REASON 섹션에서 커버됨). 여기서는 429도 RATE_LIMITED로 흡수되는지
//     추가 확인.
// ---------------------------------------------------------------------------

test("§4-10: HTTP 429 is also RATE_LIMITED (not just 403)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: [
      [(url) => url.endsWith(`/repos/${REPO_FULL_NAME}`), () => errorResp(429)],
    ],
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.RATE_LIMITED);
});

// ---------------------------------------------------------------------------
// 11. 예외 누출 0
// ---------------------------------------------------------------------------

test("§4-11: fetchJson throws -> absorbed as HTTP_FAILED, no throw leaks", async () => {
  const throwingFetchJson = async () => {
    throw new Error("boom");
  };
  const port = createGitHubApprovalPort({
    fetchJson: throwingFetchJson,
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
    allowlistPath: ALLOWLIST_PATH,
  });
  const verdict = await port.isHumanApproved(PULL_71_MERGE_SHA);
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("§4-11: fetchJson returns broken (non-object) response -> absorbed as HTTP_FAILED", async () => {
  const brokenFetchJson = async () => "not an object";
  const port = createGitHubApprovalPort({
    fetchJson: brokenFetchJson,
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
    allowlistPath: ALLOWLIST_PATH,
  });
  const verdict = await port.isHumanApproved(PULL_71_MERGE_SHA);
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("§4-11: fetchJson returns null -> absorbed as HTTP_FAILED, no throw", async () => {
  const nullFetchJson = async () => null;
  const port = createGitHubApprovalPort({
    fetchJson: nullFetchJson,
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
    allowlistPath: ALLOWLIST_PATH,
  });
  const verdict = await port.isHumanApproved(PULL_71_MERGE_SHA);
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("§4-11: git port throws on remote lookup -> absorbed as REPO_IDENTITY_MISMATCH, no throw leaks", async () => {
  const throwingGit = {
    async run() {
      throw new Error("git binary missing");
    },
  };
  const port = createGitHubApprovalPort({
    fetchJson: scriptedFetchJson([]).fetchJson,
    git: throwingGit,
    allowlistPath: ALLOWLIST_PATH,
  });
  const verdict = await port.isHumanApproved(PULL_71_MERGE_SHA);
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.REPO_IDENTITY_MISMATCH);
});

test("§4-11: git port throws on allowlist blob read -> absorbed as ALLOWLIST_UNREADABLE, no throw leaks", async () => {
  const throwingOnCatFile = gitPort(
    {
      remoteUrl: "https://github.com/hykim82/HARNESSENGINEERING.git",
      originMasterSha: PULL_71_BASE_SHA,
      blobs: {},
    },
    { throwOn: (args) => args[0] === "cat-file" },
  );
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: throwingOnCatFile,
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_UNREADABLE);
});

// ---------------------------------------------------------------------------
// 11b (재작업 2R P1-1) -- public export 전부에 대해 "주입 포트가 throw"를
// *직접* 호출해서 확인한다(§4-11 위 테스트들은 전부 isHumanApproved를 거쳐서만
// 확인했다 -- 이번 반려는 measureProtectedBranch를 *직접* 부르면 throw가
// 새는 것을 잡았다. 같은 구멍이 다른 export에도 없는지 개별 확인).
// ---------------------------------------------------------------------------

test("P1-1: measureProtectedBranch() called directly with a throwing fetchJson does not throw", async () => {
  const throwingFetchJson = async () => {
    throw new Error("injected fetch failure");
  };
  const result = await measureProtectedBranch({
    fetchJson: throwingFetchJson,
    repoFullName: REPO_FULL_NAME,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("P1-1: measureProtectedBranch() called directly, throw on the second (branches) fetchJson call does not throw", async () => {
  let call = 0;
  const fetchJson = async () => {
    call += 1;
    if (call === 1) return jsonResp(REPO_RESPONSE_JSON);
    throw new Error("injected branches failure");
  };
  const result = await measureProtectedBranch({
    fetchJson,
    repoFullName: REPO_FULL_NAME,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("P1-1: measureRepoIdentity() called directly with a throwing git port does not throw", async () => {
  const throwingGit = {
    async run() {
      throw new Error("git binary missing");
    },
  };
  const result = await measureRepoIdentity({ git: throwingGit });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.REPO_IDENTITY_MISMATCH);
});

test("P1-1: readApproverAllowlist() called directly with a throwing git port does not throw", async () => {
  const throwingGit = {
    async run() {
      throw new Error("git binary missing");
    },
  };
  const result = await readApproverAllowlist({
    git: throwingGit,
    allowlistPath: ALLOWLIST_PATH,
    expectedRepoFullName: REPO_FULL_NAME,
    expectedRefSha: PULL_71_BASE_SHA,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.ALLOWLIST_UNREADABLE);
});

test("P1-1: readApproverAllowlist() called directly, throw on the cat-file (blob read) call does not throw", async () => {
  const throwingOnCatFile = gitPort(
    { originMasterSha: PULL_71_BASE_SHA, blobs: {} },
    { throwOn: (args) => args[0] === "cat-file" },
  );
  const result = await readApproverAllowlist({
    git: throwingOnCatFile,
    allowlistPath: ALLOWLIST_PATH,
    expectedRepoFullName: REPO_FULL_NAME,
    expectedRefSha: PULL_71_BASE_SHA,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.ALLOWLIST_UNREADABLE);
});

test("P1-1: createGitHubApprovalPort().isHumanApproved() called directly with a throwing fetchJson does not throw (public-export form of §4-11)", async () => {
  const throwingFetchJson = async () => {
    throw new Error("injected fetch failure");
  };
  const port = createGitHubApprovalPort({
    fetchJson: throwingFetchJson,
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
    allowlistPath: ALLOWLIST_PATH,
  });
  const verdict = await port.isHumanApproved(PULL_71_MERGE_SHA);
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.HTTP_FAILED);
});

test("P1-1: createAnonymousFetchJson().fetchJson() called directly, global fetch rejects -> absorbed, no throw leaks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("DNS resolution failed");
  };
  try {
    const { fetchJson } = createAnonymousFetchJson();
    const result = await fetchJson({
      url: "https://api.github.com/repos/hykim82/HARNESSENGINEERING",
    });
    assert.equal(result.ok, false);
    assert.equal(result.networkError, true);
    assert.equal(result.detail, "DNS resolution failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P1-1: createAnonymousFetchJson().fetchJson() called directly, response.text() throws -> absorbed, no throw leaks", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async text() {
      throw new Error("stream aborted");
    },
  });
  try {
    const { fetchJson } = createAnonymousFetchJson();
    const result = await fetchJson({
      url: "https://api.github.com/repos/hykim82/HARNESSENGINEERING",
    });
    assert.equal(result.ok, false);
    assert.equal(result.networkError, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 11c (재작업 2R P1-2) -- 손상된 리뷰 payload는 확정 부정이 아니라 모름
// (MALFORMED_PAYLOAD)이다. 리뷰 항목의 필드 형태 검사가 판정보다 먼저다.
// ---------------------------------------------------------------------------

test("P1-2: review missing `state` -> MALFORMED_PAYLOAD (not a confident NOT_APPROVED)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          commit_id: PULL_71_HEAD_SHA,
          submitted_at: "2026-07-29T10:23:25Z",
          // state 누락
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: review with non-string `state` -> MALFORMED_PAYLOAD", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({ state: 42 }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: review missing `commit_id` -> MALFORMED_PAYLOAD", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          submitted_at: "2026-07-29T10:23:25Z",
          // commit_id 누락
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: review with `user` not an object -> MALFORMED_PAYLOAD", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({ user: "hykim82" }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: review missing `submitted_at` -> MALFORMED_PAYLOAD (cannot order 'last review')", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        {
          id: 1,
          user: { login: OWNER.login, id: OWNER.id },
          state: "APPROVED",
          commit_id: PULL_71_HEAD_SHA,
          // submitted_at 누락
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: review with unparseable `submitted_at` -> MALFORMED_PAYLOAD (정렬 불가)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: pull71ReviewJson({ submitted_at: "not-a-date" }),
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: a review item that is not an object at all -> MALFORMED_PAYLOAD", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: ["not an object"],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

test("P1-2: one malformed review among otherwise-valid reviews still closes the whole batch to MALFORMED_PAYLOAD (cannot trust 'last review' ordering)", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      reviews: [
        ...pull71ReviewJson(),
        {
          id: 2,
          user: { login: "someone-else", id: 999999 },
          state: "COMMENTED",
          // commit_id 누락 -- 명단 밖 리뷰어라 무해해 보이지만, 형태 검사는
          // "관련 있는 리뷰만" 이 아니라 배열 전체에 적용된다.
          submitted_at: "2026-07-29T11:00:00Z",
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

// 같은 원칙(P1-2)을 commits/pulls 응답에도 적용했는지 -- matching PR 항목의
// number가 정수가 아니면 확정하지 않는다.
test("P1-2 (same principle, commits/pulls response): matched PR's `number` is not an integer -> MALFORMED_PAYLOAD", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({
      headSha: PULL_71_BASE_SHA,
      commitPulls: [
        {
          number: "71", // 문자열 -- 정수가 아니다
          merge_commit_sha: PULL_71_MERGE_SHA,
          base: { ref: "master" },
          head: { sha: PULL_71_HEAD_SHA },
        },
      ],
    }),
    git: normalGitPort({ originMasterSha: PULL_71_BASE_SHA }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.MALFORMED_PAYLOAD);
});

// ---------------------------------------------------------------------------
// 11d (재작업 2R P1-3) -- 명단 schema_version 검사: 누락 · 다른 버전 문자열
// · 타입 불일치 3건.
// ---------------------------------------------------------------------------

test("P1-3: allowlist missing schema_version -> ALLOWLIST_MALFORMED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({
      originMasterSha: PULL_71_BASE_SHA,
      blobs: {
        "scripts/supervisor/approver-allowlist.json": JSON.stringify({
          repo: REPO_FULL_NAME,
          approvers: [{ login: OWNER.login, id: OWNER.id }],
        }),
      },
    }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_MALFORMED);
});

test("P1-3: allowlist schema_version is a different version string -> ALLOWLIST_MALFORMED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({
      originMasterSha: PULL_71_BASE_SHA,
      blobs: {
        "scripts/supervisor/approver-allowlist.json": allowlistJsonText({
          schema_version: "approver-allowlist/v2",
        }),
      },
    }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_MALFORMED);
});

test("P1-3: allowlist schema_version has the wrong type (number) -> ALLOWLIST_MALFORMED", async () => {
  const { verdict } = await isHumanApprovedFor({
    routes: normalRoutes({ headSha: PULL_71_BASE_SHA }),
    git: normalGitPort({
      originMasterSha: PULL_71_BASE_SHA,
      blobs: {
        "scripts/supervisor/approver-allowlist.json": allowlistJsonText({
          schema_version: 1,
        }),
      },
    }),
  });
  assert.equal(verdict.status, APPROVAL_STATUS.UNDECIDABLE);
  assert.equal(verdict.evidence.reason, APPROVAL_REASON.ALLOWLIST_MALFORMED);
});

// ---------------------------------------------------------------------------
// 12. 결선 테스트 -- collectAndEvaluateQueue(프로덕션 진입점)를 새 포트로
//     실제로 호출한다.
// ---------------------------------------------------------------------------

const GIT_TEST_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.com",
];

function wiredRunner(dir) {
  return async (args) => {
    const result = await createGitRunner(dir).run(args);
    if (result.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`,
      );
    }
    return result.stdout.toString("utf8");
  };
}

async function writeAndCommit(run, dir, filename, content, message) {
  await fsp.mkdir(path.dirname(path.join(dir, filename)), {
    recursive: true,
  });
  await fsp.writeFile(path.join(dir, filename), content);
  await run([...GIT_TEST_IDENTITY, "add", "-A"]);
  await run([...GIT_TEST_IDENTITY, "commit", "-m", message]);
}

// 재작업 2R P1-4 -- §4-12는 "실제" createGitHubApprovalPort(가짜 fetchJson·
// 가짜 아닌 실 git 포트)와 실제 measureProtectedBranch 기반 protectedBranch
// 포트를 collectAndEvaluateQueue에 넣어야 한다. alwaysApprovedPort 같은
// 스텁은 "프로덕션 진입점 ↔ 실제 승인 수집기" 결선을 증명하지 못한다(반려
// 사유 그대로). 이 저장소는 SYNTHETIC이다 -- 실제 github.com에 나가지
// 않고, `origin` 리모트와 `refs/remotes/origin/master`를 로컬에서 직접
// 만들어 readApproverAllowlist가 요구하는 "origin/master 판본"을 충족한다.
const WIRED_REPO_FULL_NAME = REPO_FULL_NAME;
const WIRED_REMOTE_URL = "https://github.com/hykim82/HARNESSENGINEERING.git";

// 실제 git origin/master 판본에 allowlist 파일을 실제로 커밋해 둔다(P1-4
// 수리 전에는 이 파일이 아예 필요 없었다 -- alwaysApprovedPort가 approval
// 수집을 통째로 건너뛰었기 때문이다).
async function setupWiredRepoBase(dir) {
  const run = wiredRunner(dir);
  await run(["init"]);
  await run(["config", "core.autocrlf", "false"]);
  await run(["remote", "add", "origin", WIRED_REMOTE_URL]);
  await run(["checkout", "-b", "main"]);
  await writeAndCommit(run, dir, "README.md", "init\n", "init");
  await writeAndCommit(
    run,
    dir,
    ALLOWLIST_PATH,
    allowlistJsonText(),
    "add allowlist",
  );
  return run;
}

// main/feature 양쪽에서 서로 다른 queue.json으로 갈라졌다가 실제 머지
// 커밋으로 합쳐지는 저장소(§4의 buildNormalRepo와 동형 -- 경로 제한
// 히스토리 단순화 함정을 피하려면 두 부모 모두와 트리가 달라야 한다).
// 반환값 = 머지 커밋 sha(= 판정 대상 sha이자, 이번엔 origin/master ref로도
// 쓴다 -- 실 GitHub에서 이 커밋이 곧 protected branch head인 시나리오).
async function buildWiredApprovedRepo(dir, manifest) {
  const run = await setupWiredRepoBase(dir);

  await run(["checkout", "-b", "feature"]);
  await writeAndCommit(
    run,
    dir,
    "queue.json",
    `${JSON.stringify({ ...manifest, queue_epoch: 1 }, null, 2)}\n`,
    "feature",
  );

  await run(["checkout", "main"]);
  await writeAndCommit(
    run,
    dir,
    "queue.json",
    `${JSON.stringify({ ...manifest, queue_epoch: 2 }, null, 2)}\n`,
    "main diverge",
  );
  try {
    await run([
      ...GIT_TEST_IDENTITY,
      "merge",
      "--no-ff",
      "-m",
      "merge queue",
      "feature",
    ]);
  } catch {
    // conflict expected -- resolved by the write+commit below.
  }
  await writeAndCommit(
    run,
    dir,
    "queue.json",
    `${JSON.stringify(manifest, null, 2)}\n`,
    "resolve",
  );

  const sha = (await run(["rev-parse", "HEAD"])).trim();
  await run(["update-ref", "refs/remotes/origin/master", sha]);
  return sha;
}

const WIRED_PULL_NUMBER = 555;

function wiredPullDetail(sha) {
  return {
    number: WIRED_PULL_NUMBER,
    merged: true,
    merge_commit_sha: sha,
    base: { ref: "main", sha: "f".repeat(40) },
    head: { ref: "feature", sha: "1".repeat(40) },
    user: { login: "wired-pr-author", id: 555000 },
  };
}

function wiredApprovingReview(pullDetail) {
  return [
    {
      id: 999001,
      user: { login: OWNER.login, id: OWNER.id },
      state: "APPROVED",
      commit_id: pullDetail.head.sha,
      submitted_at: "2026-07-29T10:23:25Z",
    },
  ];
}

// 실제 measureProtectedBranch/createGitHubApprovalPort가 부르는 GitHub REST
// 형태를 그대로 흉내내는 라우트(§4의 normalRoutes와 같은 패턴, 이 저장소의
// default_branch가 "main"이라는 점만 다르다).
function wiredApprovalRoutes({ sha, defaultBranch, pullDetail, reviews }) {
  return [
    [
      (url) => url.endsWith(`/repos/${WIRED_REPO_FULL_NAME}`),
      () => jsonResp({ default_branch: defaultBranch }),
    ],
    [
      `/branches/${defaultBranch}`,
      () =>
        jsonResp({
          name: defaultBranch,
          protected: true,
          commit: { sha },
        }),
    ],
    [
      `/commits/${sha}/pulls`,
      () =>
        jsonResp([
          {
            number: pullDetail.number,
            merge_commit_sha: sha,
            base: { ref: defaultBranch },
            head: { sha: pullDetail.head.sha },
          },
        ]),
    ],
    [`/pulls/${pullDetail.number}/reviews`, () => jsonResp(reviews)],
    [`/pulls/${pullDetail.number}`, () => jsonResp(pullDetail)],
  ];
}

test("§4-12: collectAndEvaluateQueue wired with the *real* createGitHubApprovalPort + *real* measureProtectedBranch port -> START_ALLOWED", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "approval-wired-"));
  try {
    const manifest = {
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
    };
    const sha = await buildWiredApprovedRepo(dir, manifest);
    const pullDetail = wiredPullDetail(sha);
    const reviews = wiredApprovingReview(pullDetail);
    const { fetchJson } = scriptedFetchJson(
      wiredApprovalRoutes({ sha, defaultBranch: "main", pullDetail, reviews }),
    );

    const approvalPort = createGitHubApprovalPort({
      fetchJson,
      git: createGitRunner(dir),
      allowlistPath: ALLOWLIST_PATH,
    });
    const protectedBranchPort = {
      async measure() {
        return measureProtectedBranch({
          fetchJson,
          repoFullName: WIRED_REPO_FULL_NAME,
        });
      },
    };

    const result = await collectAndEvaluateQueue({
      repoRoot: dir,
      manifestPath: "queue.json",
      protectedBranch: protectedBranchPort,
      previousApproved: null,
      git: createGitRunner(dir),
      approval: approvalPort,
    });
    assert.equal(result.verdict, QUEUE_VERDICT.START_ALLOWED);
    assert.equal(result.reason, QUEUE_REASON.OK);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("§4-12: collectAndEvaluateQueue wired with the *real* createGitHubApprovalPort + *real* measureProtectedBranch port, approval genuinely UNDECIDABLE (NO_PR_LINK) -> START_BLOCKED", async () => {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "approval-wired-blocked-"),
  );
  try {
    const run = await setupWiredRepoBase(dir);
    const manifest = {
      schema_version: "queue-manifest/v1",
      queue_epoch: 0,
      entries: [],
    };
    // 머지가 아니라 직접 커밋 -- 실제 GitHub이라면 이 커밋은 어떤 PR과도
    // 연결되지 않는다(commits/pulls가 빈 배열을 돌려준다). 그래서
    // 스텁이 아니라 실제 createGitHubApprovalPort를 그대로 통과시켜도
    // NO_PR_LINK(모름)로 자연스럽게 막힌다.
    await writeAndCommit(
      run,
      dir,
      "queue.json",
      `${JSON.stringify(manifest, null, 2)}\n`,
      "add queue directly (not linked to any PR)",
    );
    const sha = (await run(["rev-parse", "HEAD"])).trim();
    await run(["update-ref", "refs/remotes/origin/master", sha]);

    const { fetchJson } = scriptedFetchJson([
      [
        (url) => url.endsWith(`/repos/${WIRED_REPO_FULL_NAME}`),
        () => jsonResp({ default_branch: "main" }),
      ],
      [
        "/branches/main",
        () => jsonResp({ name: "main", protected: true, commit: { sha } }),
      ],
      [`/commits/${sha}/pulls`, () => jsonResp([])],
    ]);

    const approvalPort = createGitHubApprovalPort({
      fetchJson,
      git: createGitRunner(dir),
      allowlistPath: ALLOWLIST_PATH,
    });
    const protectedBranchPort = {
      async measure() {
        return measureProtectedBranch({
          fetchJson,
          repoFullName: WIRED_REPO_FULL_NAME,
        });
      },
    };

    const result = await collectAndEvaluateQueue({
      repoRoot: dir,
      manifestPath: "queue.json",
      protectedBranch: protectedBranchPort,
      previousApproved: null,
      git: createGitRunner(dir),
      approval: approvalPort,
    });
    assert.equal(result.verdict, QUEUE_VERDICT.START_BLOCKED);
    assert.deepEqual(result.entries, []);
    // approval이 실제로 호출됐고 실제로 NO_PR_LINK(모름)를 냈는지까지
    // 확인한다 -- START_BLOCKED라는 결과만으로는 approval이 진짜 실행됐는지
    // 알 수 없다(git 층 실패로도 START_BLOCKED가 나올 수 있어서다).
    assert.equal(
      result.collection.reason,
      "APPROVAL_UNDECIDABLE",
      "expected the block to come from the real approval port (NO_PR_LINK), not an earlier git-layer failure",
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// measureRepoIdentity / measureProtectedBranch / readApproverAllowlist 단위
// 테스트 (isHumanApproved 통합 경로 밖 별도 커버리지).
// ---------------------------------------------------------------------------

test("measureRepoIdentity: https remote with .git suffix -> owner/name", async () => {
  const result = await measureRepoIdentity({
    git: normalGitPort({
      remoteUrl: "https://github.com/hykim82/HARNESSENGINEERING.git",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.repoFullName, REPO_FULL_NAME);
});

test("measureRepoIdentity: ssh remote -> owner/name", async () => {
  const result = await measureRepoIdentity({
    git: normalGitPort({
      remoteUrl: "git@github.com:hykim82/HARNESSENGINEERING.git",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.repoFullName, REPO_FULL_NAME);
});

test("measureRepoIdentity: git port missing -> ok:false/REPO_IDENTITY_MISMATCH, no throw", async () => {
  const result = await measureRepoIdentity({ git: undefined });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.REPO_IDENTITY_MISMATCH);
});

test("measureProtectedBranch: missing arguments -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await measureProtectedBranch({
    fetchJson: undefined,
    repoFullName: REPO_FULL_NAME,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.INVALID_ARGUMENTS);
});

test("readApproverAllowlist: missing arguments -> ok:false/INVALID_ARGUMENTS", async () => {
  const result = await readApproverAllowlist({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, APPROVAL_REASON.INVALID_ARGUMENTS);
});
