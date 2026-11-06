// HYK-491-teardown-arm-1 (coder-task.md §2 ⓒ, 1b_exec_line) -- 그림자
// (HYK-464)가 ELIGIBLE로 가린 워크트리를 실제로 치우는 "무장(armed)"
// 실행 경로의 시험. 프로덕션 진입점(runWatchOnce)을 합성 git 저장소
// (`git init` + `git worktree add`) + 합성 워크트리 + 합성 감시 폴더 +
// 가짜 orca exec로 직접 구동한다(헛시험 방지 -- teardown-shadow-wire.
// test.mjs와 동일 원칙). 판정 축(gitFn/lsRemoteFn/isAncestorFn/existsFn/
// readFileFn/listHarnessFilesFn/readFileBufferFn)은 전부 "실" 기본값을
// 그대로 쓴다(teardownShadow: {archiveRoot} -- 프로덕션과 거의 동일한
// 결선) -- 가짜로 대체하는 것은 ⓐ 미소비 판정이 쓰는 감지기 자식
// 프로세스(JSON, 기존 unconsumedExecFn 관례)와 ⓑ orca exec
// (resourceResidue.orcaExecFn) 둘뿐이다(§live_send_ban: 실 orca 호출
// 0 -- 실제 `orca` 바이너리는 호출되지 않는다, execFn 자체가 가짜다).
//
// ★경로 주의(실측): Windows에서 os.tmpdir()은 8.3 짧은 이름(ADMINI~1)을
// 돌릴 수 있는데, `git worktree list --porcelain`은 같은 디렉터리를
// 긴 이름(Administrator)으로 보고한다 -- fs 호출은 둘 다 같은 물리
// 위치로 풀리지만, computeCanonicalPathDigest 대조(미소비 판정의
// findUnconsumedEntryForWorktree 등)는 "같은 경로"로 보지 않는다. 그래서
// 이 스위트는 워크트리 생성 뒤 **항상** `listWorktreePaths(mainRoot)`로
// 되읽은 "git이 실제로 보고하는 문자열"을 fixture·대조 키로 쓴다(직접
// 만든 경로 변수는 git 호출 인자로만 쓴다).
//
// 이 스위트가 증명하는 것:
// 1. armed 기본값 off(플래그 파일 부재) -- 이 라운드가 더한 어떤 로그
//    토큰·받는함 파일도 생기지 않는다(§2 비타협 ⓘ "바이트 동작 동일").
//    orca exec는 단 한 번도 불리지 않는다(파괴 호출 0).
// 2. armed on + 양성 1 -- 고정 순서(SHA 선기록 -> 아카이브+sha256
//    IDENTICAL -> 좌석 0 -> 어댑터 제거 -> 브랜치 복원 -> 재관측)가
//    전부 실물로 일어난다(가짜 exec가 받은 "worktree","rm" 원문 1건,
//    실제 파일 사라짐, 실제 브랜치 복원, 사본 sha256 == 원본).
// 3. 음성: keep-reason 있음 + 미소비 있음(그림자 판정 자체가 거부) ->
//    제거 0. 좌석 1개 있음(이 라운드가 더한 추가 안전판) -> 제거 0.
// 4. 중간 실패: 아카이브 쓰기 실패/제거 명령 실패 -> 그 뒤 단계 0,
//    브랜치 손실 0(실제 그대로 존재). 브랜치 복원 실패 -> SHA 선기록
//    파일은 그대로 남아 복구 가능(손실이 아니라 "수동 복구 대기").
// 5. 한 회차에 양성 2 + 음성 1 -> 양성만 순서대로 제거, 음성은 가짜
//    exec의 "worktree","rm" 호출 목록에 전혀 나타나지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runWatchOnce } from "./watch-run.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// 합성 저장소: origin(bare) + main(실제 작업 트리, master 브랜치) --
// ⓐ 병합 완료 축(ls-remote + merge-base --is-ancestor)이 실 git으로
// 동작하려면 "진짜" origin/master가 있어야 한다(가짜 lsRemoteFn을 주면
// 그 축의 실물 검증이 안 된다, 1b_exec_line의 취지).
function setupRepo() {
  const parent = fs.mkdtempSync(path.join(tmpdir(), "nc-hyk491-repo-"));
  const originRoot = path.join(parent, "origin.git");
  const mainRoot = path.join(parent, "main");
  fs.mkdirSync(originRoot, { recursive: true });
  git(originRoot, ["init", "-q", "--bare"]);
  fs.mkdirSync(mainRoot, { recursive: true });
  git(mainRoot, ["init", "-q", "-b", "master"]);
  git(mainRoot, ["config", "user.email", "t@example.com"]);
  git(mainRoot, ["config", "user.name", "T"]);
  git(mainRoot, ["remote", "add", "origin", originRoot]);
  fs.writeFileSync(path.join(mainRoot, "README.md"), "root\n");
  git(mainRoot, ["add", "."]);
  git(mainRoot, ["commit", "-q", "-m", "init"]);
  git(mainRoot, ["push", "-q", "origin", "master"]);
  return { parent, originRoot, mainRoot };
}

function addWorktree({ mainRoot, parent }, name, branch) {
  const wtPath = path.join(parent, name);
  git(mainRoot, ["worktree", "add", "-q", "-b", branch, wtPath, "master"]);
}

function writeHarnessFile(wtPath, relPath, content) {
  const full = path.join(wtPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeEligibleHarness(wtPath) {
  // roundEvidence(§B1) >=1 + keep-reason 없음(기본) -- unconsumed는
  // 호출자가 top-level execFn(unconsumedExecFn)으로 따로 채운다.
  writeHarnessFile(
    wtPath,
    ".harness/receipts/CODER-receipt-r1.json",
    JSON.stringify({ ok: true }),
  );
  writeHarnessFile(wtPath, ".harness/coder.md", "task_id: FIXTURE-1\n");
}

// git이 실제로 보고하는 문자열 그대로(인덱스 0 = main, 그 뒤는 생성
// 순서) -- 이 스위트의 유일한 경로 진실 소스(위 "경로 주의" 참조).
function listWorktreePaths(mainRoot) {
  const stdout = git(mainRoot, ["worktree", "list", "--porcelain"]);
  return stdout
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

function tmpWatchDir() {
  return fs.mkdtempSync(path.join(tmpdir(), "nc-hyk491-watch-"));
}
function tmpNotifyDir() {
  return fs.mkdtempSync(path.join(tmpdir(), "nc-hyk491-notify-"));
}
function tmpArchiveRoot() {
  return fs.mkdtempSync(path.join(tmpdir(), "nc-hyk491-archive-"));
}

function armFlag(watchDir) {
  fs.writeFileSync(path.join(watchDir, "teardown-arm.flag"), "on\n");
}

// 감지기(자식 프로세스) 자리 -- 미소비 축 fixture(teardown-shadow-wire.
// test.mjs의 unconsumedExecFn과 동일 관례, 새로 구현하지 않는다). rows의
// worktreePath는 반드시 listWorktreePaths가 돌려준 문자열이어야 한다.
function unconsumedExecFn(rows) {
  const entries = rows.map(({ worktreePath, kind, role = "coder" }) => {
    if (kind === "NA")
      return { worktreePath, status: "UNCONSUMED_NOT_APPLICABLE" };
    return {
      worktreePath,
      status: "UNCONSUMED_JUDGED",
      verdict: kind === "CONSUMED" ? "CONSUMED" : "SUSPECTED_UNCONSUMED",
      resultFile: { path: `.harness/${role}.md` },
    };
  });
  return () =>
    JSON.stringify({
      verdict: "PROGRESSING",
      reasonCode: "OK",
      unconsumed: {
        status: "JUDGED",
        totalWorktrees: entries.length,
        worstWorktreePaths: [],
        worstCount: 0,
        worktrees: entries,
      },
    });
}

// 가짜 orca exec -- terminal list(좌석 0 확인) + worktree rm(실제
// 어댑터가 받을 argv를 그대로 받아, 실제 git worktree remove + branch -D
// 로 "orca worktree rm이 브랜치도 함께 지운다"는 실측 계약을 충실히
// 모사한다). 실 `orca` 바이너리는 절대 호출하지 않는다(live_send_ban).
// argv에서 지운 워크트리의 브랜치 이름을 찾아낸다(가짜 exec가 "orca
// worktree rm은 브랜치도 함께 지운다"는 실측 계약을 충실히 모사하는 데
// 쓴다). buildFakeOrcaExecFn의 복잡도를 낮추려고 분리.
function findBranchForWorktreePath(mainRoot, targetPath) {
  const listing = git(mainRoot, ["worktree", "list", "--porcelain"]);
  for (const block of listing.split(/\n\n+/)) {
    if (block.split(/\r?\n/)[0] !== `worktree ${targetPath}`) continue;
    const m = /^branch refs\/heads\/(.+)$/m.exec(block);
    if (m) return m[1];
  }
  return null;
}

// 가짜 exec의 "worktree","rm" 처리 -- 실제 git worktree remove + branch
// -D로 orca의 실측 계약을 모사한다(실 `orca` 바이너리는 호출하지
// 않는다). buildFakeOrcaExecFn에서 분리(복잡도 분산).
function handleFakeWorktreeRemove(mainRoot, argv, removeBehavior) {
  if (typeof removeBehavior === "function") {
    const res = removeBehavior(argv);
    if (res) return res;
  }
  const pathArg = argv.find((a) => a.startsWith("path:"));
  const targetPath = pathArg.slice("path:".length);
  const branch = findBranchForWorktreePath(mainRoot, targetPath);
  git(mainRoot, ["worktree", "remove", "--force", targetPath]);
  if (branch) {
    try {
      git(mainRoot, ["branch", "-D", branch]);
    } catch {
      // 가짜 exec도 ok:true를 돌린다 -- 실제 orca worktree rm처럼 브랜치
      // 삭제 실패는 조용히 무시되는 경로를 모사한다(이 축의 실패 시나리오는
      // 별도 removeBehavior로 직접 주입한다).
    }
  }
  return { ok: true, result: {} };
}

function buildFakeOrcaExecFn({
  mainRoot,
  terminals = [],
  removeBehavior,
} = {}) {
  const calls = [];
  const exec = (argv) => {
    calls.push(argv);
    if (argv[0] === "worktree" && argv[1] === "list") {
      const paths = listWorktreePaths(mainRoot);
      return {
        ok: true,
        result: { worktrees: paths.map((p) => ({ path: p, id: `wtid:${p}` })) },
      };
    }
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { ok: true, result: { terminals } };
    }
    if (argv[0] === "worktree" && argv[1] === "rm") {
      return handleFakeWorktreeRemove(mainRoot, argv, removeBehavior);
    }
    return { ok: false, reason: `unexpected argv: ${JSON.stringify(argv)}` };
  };
  exec.calls = calls;
  return exec;
}

function removeCalls(execFn) {
  return execFn.calls.filter((a) => a[0] === "worktree" && a[1] === "rm");
}

function readNoticeText(notifyDir) {
  const name = fs
    .readdirSync(notifyDir)
    .find((n) => n.startsWith("teardown-arm-notify-"));
  assert.ok(name, "expected a teardown-arm-notify-*.md file");
  return fs.readFileSync(path.join(notifyDir, name), "utf8");
}

function cleanup(dirs) {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

test("1. armed off(기본값, 플래그 파일 없음): 양성 워크트리가 있어도 teardown_arm_ 로그 토큰·받는함 파일·orca exec 호출이 전혀 없다(바이트 동작 동일)", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-eligible", "feature/eligible");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=1/);
    assert.equal(result.line.includes("teardown_arm_"), false);
    assert.equal(execFn.calls.length, 0, "armed=off must never call orca exec");
    const notices = fs
      .readdirSync(notifyDir)
      .filter((n) => n.startsWith("teardown-arm-notify-"));
    assert.equal(notices.length, 0);
    assert.equal(fs.existsSync(wtPath), true, "worktree must remain untouched");
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

// SHA 선기록 파일 + 아카이브 사본의 sha256 IDENTICAL을 검증한다(테스트
// 2의 몸통 길이를 줄이려고 분리). 기대 레코드도 돌려준다(record.sha
// 등을 뒤이은 브랜치 복원 대조에 쓴다).
function assertShaRecordAndArchiveCopy({
  archiveRoot,
  worktreePath,
  branch,
  originalBuffer,
}) {
  const digestDirs = fs.readdirSync(archiveRoot);
  assert.equal(digestDirs.length, 1);
  const recordPath = path.join(archiveRoot, digestDirs[0], "sha-record.json");
  assert.equal(fs.existsSync(recordPath), true);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(record.worktreePath, worktreePath);
  assert.equal(record.branch, branch);
  assert.match(record.sha, /^[0-9a-f]{40}$/);

  const copyPath = path.join(
    archiveRoot,
    digestDirs[0],
    "harness-archive",
    ".harness",
    "receipts",
    "CODER-receipt-r1.json",
  );
  assert.equal(fs.existsSync(copyPath), true);
  assert.equal(sha256(fs.readFileSync(copyPath)), sha256(originalBuffer));
  return record;
}

test("2. armed on + 양성 1: 고정 순서(SHA 선기록 -> 아카이브 sha256 IDENTICAL -> 좌석 0 -> 어댑터 제거 -> 브랜치 복원 -> 재관측)가 실물로 일어난다", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-eligible", "feature/eligible");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const originalBuffer = fs.readFileSync(
    path.join(wtPath, ".harness/receipts/CODER-receipt-r1.json"),
  );
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_arm_attempted=true/);
    assert.match(result.line, /teardown_arm_processed=1/);
    assert.match(result.line, /teardown_arm_removed=1/);

    const rmCalls = removeCalls(execFn);
    assert.equal(rmCalls.length, 1);
    assert.deepEqual(rmCalls[0], [
      "worktree",
      "rm",
      "--worktree",
      `path:${wtPath}`,
      "--force",
      "--json",
    ]);

    // SHA 선기록 + 아카이브 사본 sha256 IDENTICAL.
    const record = assertShaRecordAndArchiveCopy({
      archiveRoot,
      worktreePath: wtPath,
      branch: "feature/eligible",
      originalBuffer,
    });

    // 제거 실물 + 브랜치 복원.
    assert.equal(
      fs.existsSync(wtPath),
      false,
      "worktree directory must be gone",
    );
    const branchSha = git(repo.mainRoot, [
      "rev-parse",
      "feature/eligible",
    ]).trim();
    assert.equal(branchSha, record.sha);

    // 받는함 1장.
    const noticeText = readNoticeText(notifyDir);
    assert.match(noticeText, /제거됨\(SUCCEEDED\)/);
    assert.match(noticeText, new RegExp(wtPath.replace(/[/\\]/g, "[/\\\\]")));
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("3a. 음성 -- keep-reason.md 있음: armed on이어도 제거 0(그림자 판정이 이미 거부, 무장 실행 자체가 열리지 않는다)", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-keepreason", "feature/keepreason");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  writeHarnessFile(
    wtPath,
    ".harness/keep-reason.md",
    "사유: 아직 보존\n2026-11-06\n",
  );
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=0/);
    assert.match(result.line, /TEARDOWN_KEEP_REASON_PRESENT/);
    assert.equal(result.line.includes("teardown_arm_attempted=true"), false);
    assert.equal(removeCalls(execFn).length, 0);
    assert.equal(fs.existsSync(wtPath), true);
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("3b. 음성 -- 미소비 라운드 있음: armed on이어도 제거 0", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-unconsumed", "feature/unconsumed");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "SUSPECTED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=0/);
    assert.match(result.line, /TEARDOWN_UNCONSUMED_ROUNDS_PRESENT/);
    assert.equal(result.line.includes("teardown_arm_attempted=true"), false);
    assert.equal(removeCalls(execFn).length, 0);
    assert.equal(fs.existsSync(wtPath), true);
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("3c. 음성 -- 좌석 1개 있음(그림자 ELIGIBLE이지만 이 라운드의 추가 안전판이 막는다): 제거 0, 재시도 가능한 상태 그대로", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-seatbusy", "feature/seatbusy");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({
      mainRoot: repo.mainRoot,
      terminals: [{ handle: "term_x", worktreePath: wtPath, connected: false }],
    });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=1/);
    assert.match(result.line, /teardown_arm_processed=1/);
    assert.match(result.line, /teardown_arm_removed=0/);
    assert.equal(removeCalls(execFn).length, 0);
    assert.equal(fs.existsSync(wtPath), true);
    assert.match(readNoticeText(notifyDir), /TEARDOWN_ARM_SEAT_PRESENT/);
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("4a. 중간 실패 -- 아카이브 쓰기 실패: 제거 명령 0, 브랜치 손실 0(워크트리·브랜치 그대로)", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-archivefail", "feature/archivefail");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: {
          archiveRoot,
          writeArchiveBufferFn: () => {
            throw new Error("disk full (synthetic)");
          },
        },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_arm_processed=1/);
    assert.match(result.line, /teardown_arm_removed=0/);
    assert.equal(
      removeCalls(execFn).length,
      0,
      "ARCHIVE step must fail before REMOVE",
    );
    assert.equal(fs.existsSync(wtPath), true);
    const branchSha = git(repo.mainRoot, [
      "rev-parse",
      "feature/archivefail",
    ]).trim();
    assert.match(branchSha, /^[0-9a-f]{40}$/);
    assert.match(
      readNoticeText(notifyDir),
      /TEARDOWN_ARM_ARCHIVE_WRITE_FAILED/,
    );
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("4b. 중간 실패 -- 제거 명령 실패(가짜 exec ok:false): 워크트리·브랜치 그대로(손실 0)", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-rmfail", "feature/rmfail");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({
      mainRoot: repo.mainRoot,
      removeBehavior: () => ({ ok: false, reason: "synthetic rm failure" }),
    });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_arm_removed=0/);
    assert.equal(
      fs.existsSync(wtPath),
      true,
      "fake exec returning ok:false must not touch disk",
    );
    const branchSha = git(repo.mainRoot, [
      "rev-parse",
      "feature/rmfail",
    ]).trim();
    assert.match(branchSha, /^[0-9a-f]{40}$/);
    assert.match(
      readNoticeText(notifyDir),
      /orca-adapter: ARCHIVE_TEARDOWN_REMOVE_FAILED/,
    );
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("4c. 중간 실패 -- 브랜치 복원 실패: SHA 선기록 파일이 남아 있어 수동 복구 가능(손실이 아니라 복구 대기)", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-restorefail", "feature/restorefail");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: {
          archiveRoot,
          repoRootGitFn: (argv, repoRootPath) => {
            if (argv[0] === "branch" && argv.length === 3) {
              throw new Error("synthetic branch restore failure");
            }
            return execFileSync("git", argv, {
              cwd: repoRootPath,
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            });
          },
        },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_arm_removed=0/);
    assert.equal(
      fs.existsSync(wtPath),
      false,
      "worktree was actually removed before restore ran",
    );
    const digestDirs = fs.readdirSync(archiveRoot);
    assert.equal(digestDirs.length, 1);
    const record = JSON.parse(
      fs.readFileSync(
        path.join(archiveRoot, digestDirs[0], "sha-record.json"),
        "utf8",
      ),
    );
    assert.equal(record.branch, "feature/restorefail");
    assert.match(record.sha, /^[0-9a-f]{40}$/);
    const noticeText = readNoticeText(notifyDir);
    assert.match(noticeText, /TEARDOWN_ARM_BRANCH_RESTORE_FAILED/);
    assert.match(noticeText, new RegExp(record.sha));
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("5. 한 회차 양성 2 + 음성 1: 양성만 순서대로 제거되고 음성은 가짜 exec의 worktree,rm 호출 목록에 전혀 나타나지 않는다", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-a-eligible", "feature/a-eligible");
  addWorktree(repo, "wt-b-keepreason", "feature/b-keepreason");
  addWorktree(repo, "wt-c-eligible", "feature/c-eligible");
  const [mainPath, wtA, wtBlocked, wtC] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtA);
  makeEligibleHarness(wtBlocked);
  writeHarnessFile(
    wtBlocked,
    ".harness/keep-reason.md",
    "사유: 보존\n2026-11-06\n",
  );
  makeEligibleHarness(wtC);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtA, kind: "CONSUMED" },
        { worktreePath: wtBlocked, kind: "CONSUMED" },
        { worktreePath: wtC, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: { archiveRoot },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_shadow_eligible=2/);
    assert.match(result.line, /teardown_arm_processed=2/);
    assert.match(result.line, /teardown_arm_removed=2/);
    const rmCalls = removeCalls(execFn);
    assert.equal(rmCalls.length, 2);
    const removedPaths = rmCalls.map((a) =>
      a[a.indexOf("--worktree") + 1].slice("path:".length),
    );
    assert.deepEqual(removedPaths, [wtA, wtC]);
    assert.equal(removedPaths.includes(wtBlocked), false);
    assert.equal(fs.existsSync(wtA), false);
    assert.equal(fs.existsSync(wtC), false);
    assert.equal(fs.existsSync(wtBlocked), true);
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});

test("6. 아카이브 사본이 손상됐으면(원본·사본 sha256 불일치) 제거 0 -- 대조 자체가 값을 내는지(변이 ② 표적)", () => {
  const repo = setupRepo();
  addWorktree(repo, "wt-corrupt", "feature/corrupt");
  const [mainPath, wtPath] = listWorktreePaths(repo.mainRoot);
  makeEligibleHarness(wtPath);
  const watchDir = tmpWatchDir();
  const notifyDir = tmpNotifyDir();
  const archiveRoot = tmpArchiveRoot();
  try {
    armFlag(watchDir);
    const execFn = buildFakeOrcaExecFn({ mainRoot: repo.mainRoot });
    const result = runWatchOnce({
      repoRoot: repo.mainRoot,
      watchDir,
      notifyDir,
      now: Date.parse("2026-11-06T09:00:00+09:00"),
      execFn: unconsumedExecFn([
        { worktreePath: mainPath, kind: "NA" },
        { worktreePath: wtPath, kind: "CONSUMED" },
      ]),
      resourceResidue: {
        worktreeListFn: () => ({
          ok: true,
          worktrees: listWorktreePaths(repo.mainRoot),
        }),
        teardownShadow: {
          archiveRoot,
          // 실제로는 그대로 쓰지만, 되읽을 때 조작된 바이트를 돌려준다
          // (쓰기 자체는 성공 -- "쓴 것"과 "대조에 쓰는 것"을 갈라서,
          // 대조 단계 자신이 값을 내는지를 가린다).
          readArchiveBufferFn: () => Buffer.from("TAMPERED BYTES"),
        },
        orcaExecFn: execFn,
      },
    });
    assert.match(result.line, /teardown_arm_removed=0/);
    assert.equal(
      removeCalls(execFn).length,
      0,
      "ARCHIVE_COMPARE must fail before REMOVE",
    );
    assert.equal(fs.existsSync(wtPath), true);
    assert.match(readNoticeText(notifyDir), /TEARDOWN_ARM_ARCHIVE_MISMATCH/);
  } finally {
    cleanup([repo.parent, watchDir, notifyDir, archiveRoot]);
  }
});
