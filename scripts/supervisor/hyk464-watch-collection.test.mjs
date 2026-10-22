// HYK-464-watch-collection-1 (coder-task.md §2) -- "watch excludes stale
// undelivered main-repo task files (visible, not silent) + dispatch-start
// axis accepts GREW_RECENTLY evidence" 결선 계약 시험.
//
// 배경(실측, 2026-10-19): 하네스 본체 `.harness/coder-task.md`·
// `review-task.md`(라벨 `HYK-220-ledger-path-2`/`-review-3`, 2026-08-10
// 드롭)는 `dispatch-receipts.jsonl`에 그 role+라벨 조합이 단 한 번도
// 없다(orca로 실제 배달된 적이 없는 레거시 표본) -- 그런데 결과 파일이
// 없다는 사실만으로 `selectActiveDispatch`가 이 파일들을 영원히 "활성
// 배달"로 고르고, 그 라벨로 좌석을 찾으려다 못 찾아 `*_COLLECTION_FAILED`
// 를 낸다(last-run.json 실물, 2026-10-14부터 123시간 연속 관측 -- ⓐ⑴).
// 같은 시각(2026-10-19 13:43), 착수 축은 화면(`orca terminal show`)의
// lastOutputAt 전진만 보므로 그 화면 자신이 멈춘 구간에서 실제로 일하는
// 좌석을 NOT_STARTED로 오판했다(ⓐ⑵).
//
// 이 계약이 보장하지 않는 것(S11):
// 1. 여기 fixture는 전부 이 시험이 `mkdtemp`로 만든 합성 표적 + 주입한
//    fake execFn/fake store/fake size-collector다 -- "ⓖ 본체 실물 읽기
//    대조" 시험 하나만 예외로, 실 하네스 본체 `.harness`와 실 관제실
//    `dispatch-receipts.jsonl`을 **읽기 전용**으로 입력해 부른다(쓰기 0 --
//    `collectDroppedTaskFileEvidence`는 fs 쓰기 호출이 구조적으로 없다).
// 2. judgeDispatchStart/judgeDispatchStartBySize/dispatch-start-size-adapter
//    의 코어 판정 로직 자신은 한 글자도 시험하지 않는다(각자의 .test.mjs
//    가 함) -- 이 파일은 오직 "결선"(두 증거를 어떻게 합치는가)만 본다.
// 3. mutation 시험은 "커밋된 HEAD"가 아니라 디스크의 현재 소스를 읽는다
//    (dispatch-start-wire.test.mjs/seat-liveness-wire.test.mjs와 동일 이유).
// 4. 변이체는 저장소 밖 `mkdtemp`에 쓰고 상대 import는 절대 `file://`로
//    치환한다(같은 선례) -- 저장소 안에 쓰면 다른 시험의 "워크트리 청결"
//    가드가 잔재를 본다.
// 5. ★정직 한계 -- 이 조각은 세 축 결과(judge*ForWorktree) 수준까지
//    `excludedUndeliveredTaskFiles`를 보이는 값으로 올린다. watch-run.mjs
//    의 buildLogLine/last-run.json 직렬화까지 그 필드를 추가로 꿰는 것은
//    이 라운드의 범위 밖으로 뺐다(product_scope "필요 시" = 선택, 이
//    라운드는 orch-stall-detect.mjs의 함수 출력 경계까지만 보장한다).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  collectDroppedTaskFileEvidence,
  selectActiveDispatch,
  DELIVERY_RECEIPT_CHECK,
  judgeDispatchStartForRepo,
  DISPATCH_START_WIRE_STATUS,
  DISPATCH_START_OVERRIDE_REASON,
  judgeSeatLivenessAcrossWorktrees,
  judgeSeatIdleAcrossWorktrees,
  judgeDispatchStartAcrossWorktrees,
} from "./orch-stall-detect.mjs";
import { DISPATCH_START_VERDICT } from "./dispatch-start-core.mjs";
import { deriveClaudeProjectDirName } from "./rate-limit-stall-adapter.mjs";
import { runWatchOnce } from "./watch-run.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
// HYK-460 4R P2-2 (with-temp-dir-thenable-guard.test.mjs 가 전 저장소를
// 스캔해 강제하는 모양 그대로, dispatch-start-wire.test.mjs 와 동일 재현) --
// `fn(dir)`가 돌려준 프로미스를 기다리지 않고 `finally`에서 곧바로
// `rmSync`하면, 이 파일의 async mutation 콜백들이 첫 `await`에서 제어를
// 넘기는 순간 임시 폴더가 지워진다. thenable이면 정착된 뒤에만 정리한다.
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try {
    result = fn(dir);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.then(
      (value) => {
        cleanup();
        return value;
      },
      (err) => {
        cleanup();
        throw err;
      },
    );
  }
  cleanup();
  return result;
}
function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function listWorktreePaths(dir) {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
  return [...out.matchAll(/^worktree\s+(.+)$/gm)].map((m) => m[1].trim());
}
function gitWorktreeSelfPath(dir) {
  return listWorktreePaths(dir)[0];
}
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
function writeTaskFile(dir, { role = "coder", taskId, droppedAt }) {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, ".harness", `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt} KST\nrole: ${role.toUpperCase()}\n\n본문\n`,
    "utf8",
  );
}
function writeReceiptsFile(dir, lines) {
  const p = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(
    p,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );
  return p;
}
function fakeOrcaExecFn({ terminals = [], showsByHandle = {} } = {}) {
  return function execFn(argv) {
    if (argv[0] === "terminal" && argv[1] === "list") {
      return { ok: true, result: { terminals } };
    }
    if (argv[0] === "terminal" && argv[1] === "show") {
      const handle = argv[argv.indexOf("--terminal") + 1];
      const stub = showsByHandle[handle];
      if (!stub) throw new Error(`fakeOrcaExecFn: no show-stub for ${handle}`);
      return typeof stub === "function" ? stub() : stub;
    }
    throw new Error(`fakeOrcaExecFn: unexpected argv ${JSON.stringify(argv)}`);
  };
}
function fakeDispatchStartStore(initialText = null) {
  let stored = initialText;
  return {
    dispatchStartExistsFn: () => stored !== null,
    dispatchStartReadFn: () => stored,
    dispatchStartWriteFn: (_p, text) => {
      stored = text;
    },
    dispatchStartMkdirFn: () => {},
    peek: () => (stored === null ? null : JSON.parse(stored)),
  };
}
// 호출될 때마다 sequence의 다음 값을 돌려준다(polling 두 틱 = 두 호출) --
// 마지막 값 뒤로는 그대로 반복한다.
function nextFromSequence(sequence) {
  let i = 0;
  return () => {
    const value = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return value;
  };
}
// 세션 로그 "총 바이트" 수집을 실 fs 없이 흉내낸다(collectSessionSizeFn 자리).
function fakeSessionSize(sequence) {
  const next = nextFromSequence(sequence);
  return () => ({
    ok: true,
    totalBytes: next(),
    fileCount: 1,
    excludedSymlinkCount: 0,
  });
}
function failingSessionSize() {
  return () => ({ ok: false, reasonCode: "STAT_FAILED", detail: "boom" });
}

function applyMutation(src, find, replacement) {
  const count = src.split(find).length - 1;
  assert.equal(
    count,
    1,
    `mutation target string must match exactly once in the source, got ${count} -- stale or ambiguous target`,
  );
  return src.replace(find, replacement);
}
function rewriteRelativeImportsToAbsolute(src, baseDir) {
  return src.replace(
    /from\s+(["'])(\.\.?\/[^"']+)\1/g,
    (whole, quote, relPath) => {
      const absPath = join(baseDir, relPath).replace(/\\/g, "/");
      return `from ${quote}file://${absPath}${quote}`;
    },
  );
}
const LIVE_SRC_PATH = join(THIS_DIR, "orch-stall-detect.mjs");
const LIVE_SRC = readFileSync(LIVE_SRC_PATH, "utf8");
async function importMutatedSibling(mutate, label) {
  const rewritten = rewriteRelativeImportsToAbsolute(
    mutate(LIVE_SRC),
    THIS_DIR,
  );
  const mutantDir = mkdtempSync(
    join(tmpdir(), `hyk464-watch-mutant-${label}-`),
  );
  const mutantPath = join(mutantDir, "orch-stall-detect.mutant.mjs");
  writeFileSync(mutantPath, rewritten, "utf8");
  try {
    return await import(`file://${mutantPath.replace(/\\/g, "/")}`);
  } finally {
    rmSync(mutantDir, { recursive: true, force: true });
  }
}

// ===========================================================================
// ⓐ⑴/ⓑ/ⓓ -- 배달 영수증 없는 task 파일의 제외(보이는 값으로).
// ===========================================================================

test("ⓐ⑴ 기준선 재현 + ⓑ 수리: 영수증 없는 묵은 task 파일 -> 활성 후보에서 제외, excludedUndeliveredTaskFiles에 보이는 값으로 남는다", () => {
  withTempDir("hyk464-stale-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-220-ledger-path-2",
      droppedAt: "2026-08-10 20:51",
    });
    // 영수증 파일은 "있다"(판정 가능) -- 그런데 이 라벨 줄이 없다(실물과
    // 동형: dispatch-receipts.jsonl에 HYK-220-ledger-path-2가 0건).
    const receiptPath = writeReceiptsFile(dir, [
      { role: "CODER", harness_task_label: "HYK-OTHER-1" },
    ]);
    const evidence = collectDroppedTaskFileEvidence(dir, {
      dispatchReceiptPath: receiptPath,
    });
    assert.equal(evidence.failed, false);
    assert.equal(evidence.items.length, 1);
    assert.equal(
      evidence.items[0].deliveryReceipt.status,
      DELIVERY_RECEIPT_CHECK.NOT_FOUND,
    );
    // 보이는 값 -- 조용한 제외 금지.
    assert.equal(evidence.excludedUndeliveredTaskFiles.length, 1);
    assert.equal(
      evidence.excludedUndeliveredTaskFiles[0].taskId,
      "HYK-220-ledger-path-2",
    );
    assert.equal(evidence.excludedUndeliveredTaskFiles[0].role, "CODER");
    // 활성 후보에서 실제로 빠진다 -- selectActiveDispatch가 이걸 고르면
    // 그 라벨로 좌석을 찾으려다 실측 그대로 COLLECTION_FAILED가 난다.
    assert.equal(selectActiveDispatch(evidence.items), null);
  });
});

test("ⓓ⑴ 반대 방향: 영수증이 «있는» 결과 파일 없는 task 파일 -- 여전히 활성 배달로 판정", () => {
  withTempDir("hyk464-found-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-real-1",
      droppedAt: "2026-10-19 15:14",
    });
    const receiptPath = writeReceiptsFile(dir, [
      { role: "CODER", harness_task_label: "HYK-464-real-1" },
    ]);
    const evidence = collectDroppedTaskFileEvidence(dir, {
      dispatchReceiptPath: receiptPath,
    });
    assert.equal(evidence.failed, false);
    assert.equal(
      evidence.items[0].deliveryReceipt.status,
      DELIVERY_RECEIPT_CHECK.FOUND,
    );
    assert.equal(evidence.excludedUndeliveredTaskFiles.length, 0);
    assert.notEqual(selectActiveDispatch(evidence.items), null);
  });
});

test("ⓓ 회귀 0: 영수증 경로 자체가 안 구해지는 환경(기존 시험 fixture 전부와 동형, env/opts/포인터 파일 전부 없음) -- 제외도 수집 실패도 아니다, 기존 동작 그대로 활성", () => {
  withTempDir("hyk464-noreceiptinfra-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-legacy-env-1",
      droppedAt: "2026-10-19 15:14",
    });
    const evidence = collectDroppedTaskFileEvidence(dir, {});
    assert.equal(evidence.failed, false);
    assert.equal(
      evidence.items[0].deliveryReceipt.status,
      DELIVERY_RECEIPT_CHECK.NOT_APPLICABLE,
    );
    assert.equal(evidence.excludedUndeliveredTaskFiles.length, 0);
    assert.notEqual(selectActiveDispatch(evidence.items), null);
  });
});

test("ⓑ 비타협: 영수증 경로는 구해지는데 그 파일을 못 읽으면(EISDIR 등) -- «없음»으로 섞지 않고 수집 실패(판정 불가)로 닫는다", () => {
  withTempDir("hyk464-unresolved-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-real-2",
      droppedAt: "2026-10-19 15:14",
    });
    // 경로는 "있다"(디렉터리 자체) -- 그러나 파일로 못 읽는다(EISDIR류).
    const bogusPath = join(dir, "not-a-file-dir");
    mkdirSync(bogusPath);
    const evidence = collectDroppedTaskFileEvidence(dir, {
      dispatchReceiptPath: bogusPath,
    });
    assert.equal(
      evidence.failed,
      true,
      "조회 자체 실패는 failed:true -- '없음'으로 뭉개지지 않는다",
    );
    assert.equal(evidence.items.length, 0);
  });
});

// ★HYK-464-watch-collection-1 3R P1-2(검토 1R §2 ⓗ 실측): 이 칸은 아래
// `mainRepoRoot`/`realReceiptPath`를 건너뛰기 가드 없이 바로 readFileSync
// 한다 -- 이 두 경로는 이 워크트리가 올라앉은 특정 Windows 기계에만 있는
// 실물(하네스 본체 워크트리·관제실)이라, 그 경로가 없는 환경(예: CI
// `ubuntu-24.04`, enforce.yml의 `npm test`가 이 파일도 돈다)에서는
// `readFileSync`가 ENOENT로 던져 이 칸이 거짓 빨강이 된다(검토자 실측:
// 그 경로들을 제자리로 "없는 경로"로 흉내 내자 `not ok 5 … code: 'ENOENT'`).
// 수리: 실경로가 "없을 때만" 건너뛴다(사유를 TAP 출력에 남기는 node:test
// 의 `skip` 옵션 -- 조용한 초록이 아니라 눈에 보이는 SKIP, §2 "조용한
// 제외 금지"와 같은 원칙). 실경로가 있는 이 기계(지금 이 라운드)에서는
// `ggPathsPresent`가 true라 전혀 건너뛰지 않고 그대로 실행된다(회귀 0).
const mainRepoRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
const realReceiptPath = "D:/문서관리/하네스-관제실/dispatch-receipts.jsonl";
const ggPathsPresent = existsSync(mainRepoRoot) && existsSync(realReceiptPath);
const ggSkipReason = `실경로 부재(mainRepoRoot=${mainRepoRoot} realReceiptPath=${realReceiptPath}) -- 이 환경(예: Linux CI)에는 하네스 본체 워크트리·관제실이 없다`;

test(
  "ⓖ 본체 실물 읽기 대조(읽기 전용): 실 .harness의 두 묵은 task 파일이 실 dispatch-receipts.jsonl 대조로 '제외됨'으로 나온다",
  { skip: ggPathsPresent ? false : ggSkipReason },
  () => {
    const before = createHash("sha256")
      .update(readFileSync(realReceiptPath))
      .digest("hex");
    const evidence = collectDroppedTaskFileEvidence(mainRepoRoot, {
      dispatchReceiptPath: realReceiptPath,
    });
    const after = createHash("sha256")
      .update(readFileSync(realReceiptPath))
      .digest("hex");
    assert.equal(
      before,
      after,
      "읽기 전용 -- 실 관제실 영수증 파일이 바뀌면 안 된다",
    );
    assert.equal(evidence.failed, false);
    const excludedLabels = evidence.excludedUndeliveredTaskFiles.map(
      (e) => e.taskId,
    );
    assert.ok(
      excludedLabels.includes("HYK-220-ledger-path-2"),
      `expected HYK-220-ledger-path-2 excluded, got ${JSON.stringify(excludedLabels)}`,
    );
    assert.ok(
      excludedLabels.includes("HYK-220-ledger-path-review-3"),
      `expected HYK-220-ledger-path-review-3 excluded, got ${JSON.stringify(excludedLabels)}`,
    );
    assert.equal(selectActiveDispatch(evidence.items), null);
    console.log(
      "HYK-464-watch-collection-1 ⓖ quote: excludedUndeliveredTaskFiles =",
      JSON.stringify(evidence.excludedUndeliveredTaskFiles),
    );
  },
);

// ===========================================================================
// 3R P1-3 -- excludedUndeliveredTaskFiles를 watch-run.mjs의 last-run.json·
// watch.log까지: 결선 칸(mkdtemp 합성 대상 · 생산 관제실 인자 실행 0).
// orch-stall-detect.mjs 쪽 세 축(judgeSeat*AcrossWorktrees/
// judgeDispatchStartAcrossWorktrees)은 실제로 부른다(공개 함수) -- 이
// 칸은 그 세 축의 실제 결과가 watch-run.mjs의 extractor/record/로그
// 조립을 실제로 지나는지만 본다("감지기 서브프로세스 자체"는 watch-run.
// mjs가 execFn으로 감싸는 경계라, 이 축은 그 경계 바로 밖에서 실제
// 값을 만들어 넣는다 -- 이 파일 머리 "보장하지 않는 것" 5 참조).
// ===========================================================================

test("3R P1-3 결선: orch-stall-detect의 세 축(seat/idle/start)이 실제로 내는 excludedUndeliveredTaskFiles가 watch-run.mjs의 last-run.json·watch.log까지 실제로 닿는다", () => {
  withTempDir("hyk464-p13-wiring-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-p13-excluded-1",
      droppedAt: "2026-10-19 15:14",
    });
    const receiptPath = writeReceiptsFile(dir, [
      { role: "CODER", harness_task_label: "HYK-OTHER-2" },
    ]);
    const worktreePath = gitWorktreeSelfPath(dir);
    const now = Date.parse("2026-10-19T15:30:00+09:00");
    const opts = { dispatchReceiptPath: receiptPath };
    // 세 축 전부 실제 공개 함수를 그대로 부른다(fabricate 0) -- 1R이
    // 이미 보장한 "제외 1건" 결과를 여기서 재확인한다(아래 결선이
    // 그 값을 그대로 옮기는지가 이 칸의 실제 관심사).
    const seatLiveness = judgeSeatLivenessAcrossWorktrees(
      { repoRoot: worktreePath, now },
      opts,
    );
    const seatIdle = judgeSeatIdleAcrossWorktrees(
      { repoRoot: worktreePath, now },
      opts,
    );
    const dispatchStart = judgeDispatchStartAcrossWorktrees(
      { repoRoot: worktreePath, now },
      opts,
    );
    assert.equal(
      seatLiveness.worktrees[0].excludedUndeliveredTaskFiles.length,
      1,
    );
    assert.equal(seatIdle.worktrees[0].excludedUndeliveredTaskFiles.length, 1);
    assert.equal(
      dispatchStart.worktrees[0].excludedUndeliveredTaskFiles.length,
      1,
    );

    const watchDir = mkdtempSync(join(tmpdir(), "hyk464-p13-watchdir-"));
    try {
      // ★CLI 자신의 실제 stdout 모양(printResult, orch-stall-detect.mjs
      // "console.log(JSON.stringify(result))")과 동일한 봉투 -- 세 축의
      // 실제 값만 손으로 조립한다(생산 관제실 인자로 서브프로세스를
      // 실행하지 않는다, product_scope 비타협).
      const stdout = JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        seatLiveness,
        seatIdle,
        dispatchStart,
      });
      const result = runWatchOnce({
        repoRoot: worktreePath,
        watchDir,
        now,
        execFn: () => stdout,
      });
      const record = JSON.parse(readFileSync(result.aliveRecordPath, "utf8"));
      assert.equal(record.seatLivenessExcludedUndeliveredTaskFiles.length, 1);
      assert.equal(
        record.seatLivenessExcludedUndeliveredTaskFiles[0].taskId,
        "HYK-464-p13-excluded-1",
      );
      assert.equal(record.seatIdleExcludedUndeliveredTaskFiles.length, 1);
      assert.equal(record.startExcludedUndeliveredTaskFiles.length, 1);

      const logText = readFileSync(result.logPath, "utf8");
      assert.match(
        logText,
        /seat_excluded_undelivered=1 seat_excluded_undelivered_detail=HYK-464-p13-excluded-1:CODER/,
      );
      assert.match(
        logText,
        /idle_excluded_undelivered=1 idle_excluded_undelivered_detail=HYK-464-p13-excluded-1:CODER/,
      );
      assert.match(
        logText,
        /start_excluded_undelivered=1 start_excluded_undelivered_detail=HYK-464-p13-excluded-1:CODER/,
      );
      console.log(
        "HYK-464-watch-collection-1 3R P1-3 quote: watch.log line =",
        logText.trim(),
      );
    } finally {
      rmSync(watchDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// ⓐ⑵/ⓒ/ⓓ -- 착수 축: 화면 정체 + GREW_RECENTLY 증거.
// ===========================================================================

test("ⓐ⑵ 기준선 재현: 화면만 보면(기존 동작) 2틱 모두 무진행 + 타임아웃 지남 -> NOT_STARTED", () => {
  withTempDir("hyk464-screenonly-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-screen-1",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, ...store },
    );
    assert.equal(r.status, DISPATCH_START_WIRE_STATUS.JUDGED);
    assert.equal(r.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
  });
});

function evidenceItems(repoRoot) {
  return collectDroppedTaskFileEvidence(repoRoot, {}).items;
}

test("ⓐ⑵ 수리 + ⓒ: 화면은 그대로 멈췄어도 작업자 기록 폴더가 최근에 자랐으면(GREW_RECENTLY) -> STARTED로 뒤집힌다(보이는 사유와 함께)", () => {
  withTempDir("hyk464-sizegrew-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-screen-2",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00"); // 화면 기준으론 NOT_STARTED권.
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const collectSessionSizeFn = fakeSessionSize([1_000, 51_000]); // 두 번째 틱에 실제로 자람.
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(r.status, DISPATCH_START_WIRE_STATUS.JUDGED);
    assert.equal(
      r.verdict,
      DISPATCH_START_VERDICT.STARTED,
      "화면이 멈췄어도 기록 폴더 성장 증거가 있으면 '진짜 미착수'로 접지 않는다",
    );
    assert.equal(
      r.reasonCode,
      DISPATCH_START_OVERRIDE_REASON.SESSION_SIZE_GREW_RECENTLY,
      "뒤집힌 사유가 화면 근거 그대로의 NOT_STARTED와 같은 값으로 섞이지 않는다",
    );
    assert.equal(r.details.screenReasonCode, "NO_PROGRESS_PAST_THRESHOLD");
    assert.equal(r.details.sizeDetails.observationCount >= 2, true);
    console.log(
      "HYK-464-watch-collection-1 ⓒ quote: result =",
      JSON.stringify({ verdict: r.verdict, reasonCode: r.reasonCode }),
    );
  });
});

test("ⓓ⑵ 반대 방향: 화면도 멈추고 기록 폴더도 안 늘었으면 -- 진짜 미착수, 여전히 NOT_STARTED", () => {
  withTempDir("hyk464-neithergrew-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-screen-3",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const collectSessionSizeFn = fakeSessionSize([1_000, 1_000]); // 안 늚.
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(r.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
  });
});

test("ⓓ⑶ 반대 방향: 기록 폴더 조회 자체가 실패하면 -- '착수'로 접지 않는다(여전히 NOT_STARTED)", () => {
  withTempDir("hyk464-sizefails-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-screen-4",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const collectSessionSizeFn = failingSessionSize();
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(r.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
  });
});

test("ⓒ 회귀 0: 화면이 이미 정상 진전이면(STARTED) size 증거가 있어도 화면 사유를 덮어쓰지 않는다", () => {
  withTempDir("hyk464-screenstarted-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-screen-5",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = dispatchedAtMs + 60_000;
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const nextLastOutputAt = nextFromSequence([
      dispatchedAtMs,
      tick1At + 10_000,
    ]);
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: {
        term_x: () => ({
          ok: true,
          result: {
            terminal: { lastOutputAt: nextLastOutputAt(), title: "CODER" },
          },
        }),
      },
    });
    const collectSessionSizeFn = fakeSessionSize([1_000, 1_000]); // size 증거는 없음(STARTED면 무관).
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(r.verdict, DISPATCH_START_VERDICT.STARTED);
    assert.equal(r.reasonCode, "PROGRESSED_BETWEEN_OBSERVATIONS");
  });
});

// ===========================================================================
// 3R P1-1 -- 착수 축 세션 기록 집을 배달기와 같은 출처(.claude-team)로:
// 기본 경로 칸(주입 없이 생산 결선을 지남) + observationUnavailable을
// '성장 없음'으로 접지 않음.
// ===========================================================================

test("3R P1-1 기본 경로: claudeHomeDir·collectSessionSizeFn 둘 다 주입하지 않아도(osHomedirFn만 주입해 기본 경로 자체를 지나감) 기본 집 .claude-team 아래 실 세션 파일 성장이 착수 축을 STARTED로 뒤집는다", () => {
  withTempDir("hyk464-defaulthome-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-defaulthome-1",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    return withTempDir("hyk464-fakehome-", (fakeHome) => {
      // ★osHomedirFn만 주입한다(claudeHomeDir/collectSessionSizeFn은 안
      // 준다) -- resolveClaudeHomeDir의 "기본값" 분기(opts.claudeHomeDir
      // 없을 때 os.homedir()+".claude-team"을 쓰는 자리)와
      // collectSessionSizeObservation의 "기본 collectFn"(실 readdirSync로
      // collectTotalSessionBytes를 직접 부르는 자리)을 둘 다 실제로
      // 지나간다 -- 기존 ⓐ⑵/ⓒ/ⓓ 다섯 칸은 전부 collectSessionSizeFn을
      // 주입해 이 결선 값(집 선택) 자체를 한 번도 안 지났다(검토 1R §2
      // ⓒ 실측, "집 선택을 고정하는 시험 0").
      const osHomedirFn = () => fakeHome;
      const projectDir = join(
        fakeHome,
        ".claude-team",
        "projects",
        deriveClaudeProjectDirName(worktreePath),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "session.jsonl"),
        "x".repeat(1_000),
        "utf8",
      );
      judgeDispatchStartForRepo(
        {
          repoRoot: worktreePath,
          droppedTaskFiles: evidenceItems(worktreePath),
          now: tick1At,
        },
        { execFn, osHomedirFn, ...store },
      );
      // 두 번째 틱 전에 실 파일을 키운다(진짜 fs 성장 -- fakeSessionSize
      // 흉내가 아니라 collectTotalSessionBytes가 실제로 읽는다).
      writeFileSync(
        join(projectDir, "session.jsonl"),
        "x".repeat(51_000),
        "utf8",
      );
      const r = judgeDispatchStartForRepo(
        {
          repoRoot: worktreePath,
          droppedTaskFiles: evidenceItems(worktreePath),
          now: tick2At,
        },
        { execFn, osHomedirFn, ...store },
      );
      assert.equal(
        r.verdict,
        DISPATCH_START_VERDICT.STARTED,
        "기본 경로(.claude-team)를 실제로 지나야 이 성장을 본다 -- M5(집을 .claude로 바꾸면)는 이 칸이 RED가 된다",
      );
      assert.equal(
        r.reasonCode,
        DISPATCH_START_OVERRIDE_REASON.SESSION_SIZE_GREW_RECENTLY,
      );
    });
  });
});

test("3R P1-1 observationUnavailable: 세션 기록 폴더 자체를 못 찾으면(ok:true,totalBytes:0,observationUnavailable:true) '성장 없음 확정'으로 접지 않는다 -- 화면 쪽 사유가 그대로 남고, 저장된 관측에 totalBytes가 안 실린다", () => {
  withTempDir("hyk464-obsunavail-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-obsunavail-1",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    // 집은 (어느 값이든) "못 찾았다"만 흉내낸다 -- dispatch-start-size-
    // adapter.mjs의 실 collectTotalSessionBytes가 projects 폴더 부재일 때
    // 실제로 내는 모양 그대로(observationUnavailable:true).
    const collectSessionSizeFn = () => ({
      ok: true,
      totalBytes: 0,
      fileCount: 0,
      excludedSymlinkCount: 0,
      observationUnavailable: true,
    });
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(r.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
    assert.equal(
      r.reasonCode,
      "NO_PROGRESS_PAST_THRESHOLD",
      "observationUnavailable이 '성장 없음 확정' 코드로 덮지 않고 화면 쪽 사유 그대로 남는다",
    );
    const stored = store.peek();
    for (const obs of stored[worktreePath].observations) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(obs, "totalBytes"),
        false,
        "observationUnavailable 회차는 totalBytes를 관측 히스토리에 싣지 않는다(조회 실패와 동일하게 접힘)",
      );
    }
  });
});

// ===========================================================================
// 3R P2-1(상신 수용) -- "착수 뒤 정지"는 미착수와 다른 사유 코드로:
// 배달 이후 누적 증가 > 0인데 최근 무증가면, 진짜 미착수(누적 0)와 같은
// 사유로 재배달 후보에 올리지 않는다.
// ===========================================================================

test("3R P2-1: 화면 정체 + 배달 이후 누적 증가(한 번 자란 뒤 멈춤) -- STARTED로 남고, GREW_RECENTLY와도 진짜 미착수와도 다른 사유 코드", () => {
  withTempDir("hyk464-startedthenstalled-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-startedthenstalled-1",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    // 16:28Z 표본 모양(판정 §1 ⑷) -- 화면 출력 시각 고정 + 최근 창
    // 기록 폴더 무증가 + 배달 이후 누적 증가: t1에서 적게 자란 뒤
    // t2(+5분)에 크게 자라고(=배달 뒤 누적 증가), t3(+38분, t2로부터
    // 3분 stall 임계를 한참 넘겨)에는 더 안 늘어(=최근 창 무증가).
    const tick1At = dispatchedAtMs + 30_000; // +30s
    const tick2At = dispatchedAtMs + 5 * 60_000; // +5min, 실제로 자람.
    const tick3At = Date.parse("2026-10-19T13:43:00+09:00"); // +43min, t2로부터 38분 무증가.
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const collectSessionSizeFn = fakeSessionSize([1_000, 500_000, 500_000]);
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick3At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(
      r.verdict,
      DISPATCH_START_VERDICT.STARTED,
      "배달 이후 누적 증가가 있었던 좌석은 재배달 후보(SUSPECTED_NOT_STARTED)에 안 올라간다",
    );
    assert.equal(
      r.reasonCode,
      DISPATCH_START_OVERRIDE_REASON.SESSION_SIZE_STARTED_THEN_STALLED,
    );
    assert.notEqual(
      r.reasonCode,
      DISPATCH_START_OVERRIDE_REASON.SESSION_SIZE_GREW_RECENTLY,
      "방금 자라는 중(GREW_RECENTLY)과 자랐다가 멈춤(STARTED_THEN_STALLED)은 같은 사유 코드를 공유하지 않는다",
    );
    console.log(
      "HYK-464-watch-collection-1 3R P2-1 quote: result =",
      JSON.stringify({ verdict: r.verdict, reasonCode: r.reasonCode }),
    );
  });
});

test("3R P2-1 반대 방향(불변): 진짜 미착수(누적 0, 두 틱 모두 안 자람)는 여전히 NOT_STARTED/NO_PROGRESS_PAST_THRESHOLD -- 새 사유 코드로 안 샌다", () => {
  withTempDir("hyk464-trulynotstarted-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-trulynotstarted-1",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = dispatchedAtMs + 5 * 60_000;
    const tick3At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const collectSessionSizeFn = fakeSessionSize([0, 0, 0]); // 누적 0 -- 한 번도 안 자람.
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidenceItems(worktreePath),
        now: tick3At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(r.verdict, DISPATCH_START_VERDICT.NOT_STARTED);
    assert.equal(r.reasonCode, "NO_PROGRESS_PAST_THRESHOLD");
  });
});

// ===========================================================================
// ⓔ 변이(제자리 · 커밋 뒤와 동일 소스, 복원 불필요 -- mkdtemp 사본만 변이).
// ===========================================================================

test("NC mutation/hyk464 #1 (필수): isDispatchStillActive의 영수증 제외 분기 제거 -> RED(ⓐ⑴ 재현 -- 묵은 영수증 없는 task 파일이 다시 활성으로 선택된다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  if (
    item.deliveryReceipt &&
    item.deliveryReceipt.status === DELIVERY_RECEIPT_CHECK.NOT_FOUND
  ) {
    return false;
  }
`,
        "",
      ),
    "1",
  );
  await withTempDir("hyk464-mutant1-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-220-ledger-path-2",
      droppedAt: "2026-08-10 20:51",
    });
    const receiptPath = writeReceiptsFile(dir, [
      { role: "CODER", harness_task_label: "HYK-OTHER-1" },
    ]);
    const evidence = mutant.collectDroppedTaskFileEvidence(dir, {
      dispatchReceiptPath: receiptPath,
    });
    const active = mutant.selectActiveDispatch(evidence.items);
    assert.notEqual(
      active,
      null,
      "mutant must select the receiptless stale task file as active again (RED signal; proves the exclusion branch is load-bearing)",
    );
  });
});

test("NC mutation/hyk464 #2 (필수): excludedUndeliveredTaskFiles를 항상 []로 지우기 -> RED(제외는 되지만 조용해진다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  const excludedUndeliveredTaskFiles = items
    .filter(
      (it) => it.deliveryReceipt.status === DELIVERY_RECEIPT_CHECK.NOT_FOUND,
    )
    .map((it) => ({
      path: it.path,
      taskId: it.taskId,
      role: it.deliveryReceipt.role,
    }));`,
        `  const excludedUndeliveredTaskFiles = [];`,
      ),
    "2",
  );
  await withTempDir("hyk464-mutant2-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-220-ledger-path-2",
      droppedAt: "2026-08-10 20:51",
    });
    const receiptPath = writeReceiptsFile(dir, [
      { role: "CODER", harness_task_label: "HYK-OTHER-1" },
    ]);
    const evidence = mutant.collectDroppedTaskFileEvidence(dir, {
      dispatchReceiptPath: receiptPath,
    });
    assert.equal(
      mutant.selectActiveDispatch(evidence.items),
      null,
      "sanity: exclusion itself still works in this mutant",
    );
    assert.equal(
      evidence.excludedUndeliveredTaskFiles.length,
      0,
      "mutant must silence the exclusion record (RED signal; proves visibility reporting is load-bearing, not incidental)",
    );
  });
});

test("NC mutation/hyk464 #3 (필수): combineDispatchStartWithSizeEvidence 호출 제거(화면 판정만 사용) -> RED(ⓐ⑵ 재현 -- 기록 폴더가 자라도 NOT_STARTED로 남는다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        "  const judged = combineDispatchStartWithSizeEvidence(screenJudged, sizeJudged);",
        "  const judged = screenJudged;",
      ),
    "3",
  );
  await withTempDir("hyk464-mutant3-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-screen-2",
      droppedAt: "2026-10-19 13:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-19T13:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-19T13:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const collectSessionSizeFn = fakeSessionSize([1_000, 51_000]);
    const evidence = mutant.collectDroppedTaskFileEvidence(worktreePath, {});
    mutant.judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidence.items,
        now: tick1At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    const r = mutant.judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidence.items,
        now: tick2At,
      },
      { execFn, collectSessionSizeFn, ...store },
    );
    assert.equal(
      r.verdict,
      DISPATCH_START_VERDICT.NOT_STARTED,
      "mutant must stay NOT_STARTED despite real session-growth evidence (RED signal; proves the combine call is load-bearing)",
    );
  });
});

test("NC mutation/hyk464 #4 (필수, ⓓ⑶): 영수증 파일 읽기 실패를 UNRESOLVED 대신 NOT_FOUND로 접기 -> RED(판정 불가가 '정상 제외'로 섞인다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  let content;
  try {
    content = readFileFn(receiptPath, "utf8");
  } catch {
    return { status: DELIVERY_RECEIPT_CHECK.UNRESOLVED, role };
  }`,
        `  let content;
  try {
    content = readFileFn(receiptPath, "utf8");
  } catch {
    return { status: DELIVERY_RECEIPT_CHECK.NOT_FOUND, role };
  }`,
      ),
    "4",
  );
  await withTempDir("hyk464-mutant4-", async (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-real-3",
      droppedAt: "2026-10-19 15:14",
    });
    const bogusPath = join(dir, "not-a-file-dir");
    mkdirSync(bogusPath);
    const evidence = mutant.collectDroppedTaskFileEvidence(dir, {
      dispatchReceiptPath: bogusPath,
    });
    assert.equal(
      evidence.failed,
      false,
      "mutant must misreport an unreadable (but configured) receipt ledger as 'no receipt, exclude' (RED signal; proves the UNRESOLVED/NOT_FOUND distinction is load-bearing)",
    );
    assert.equal(mutant.selectActiveDispatch(evidence.items), null);
  });
});

// ===========================================================================
// HYK-464-watch-start-axis-1 (coder-task.md §2) -- 464 후속 "착수 축" 세
// 칸: ⓐ 관측 창이 잘려도 기준점(배달 뒤 첫 관측) 보존 ⓑ codex 좌석은
// ORCA_CODEX_HOME에서 세션 크기를 본다(배달기와 같은 출처) ⓒ "집 관측
// 불가" 사유 코드가 watch.log/last-run.json까지 닿는다.
// ===========================================================================

test("ⓐ 수리: 관측 창이 MAX_STORED_DISPATCH_START_OBSERVATIONS(5)를 넘어 잘려도 기준점(배달 뒤 첫 관측, totalBytes=0)이 살아남아 '시작은 했다가 멈춤'(STALLED 오버라이드)을 유지한다 -- 창이 잘리며 기준점을 잃으면 '애초에 시작도 못 함'(NOT_STARTED)과 같은 사유로 재배달 후보에 오른다(판정 §1 ⑴ 재현, P2-1)", () => {
  withTempDir("hyk464-baseline-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-baseline-1",
      droppedAt: "2026-10-20 10:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    // 6틱: t0 기준점(0B) -> t1 성장(5000B) -> t2..t5 평평(5000B, 변화 0).
    // 여섯 번째 호출(t5)에서 창(5)이 처음으로 넘쳐 잘린다 -- 기준점(t0,
    // 0B)이 안 보존되면 남는 5개가 전부 5000B로 평평해 "한 번도 안
    // 늘었다"로 보인다.
    const ticks = [10_000, 20_000, 30_000, 40_000, 50_000, 400_000];
    const sizes = [0, 5_000, 5_000, 5_000, 5_000, 5_000];
    const collectSessionSizeFn = fakeSessionSize(sizes);
    const opts = {
      execFn,
      collectSessionSizeFn,
      sessionSizeTimeoutMs: 60_000,
      sessionSizeStallThresholdMs: 60_000,
      ...store,
    };
    const evidence = evidenceItems(worktreePath);
    let r;
    for (const offset of ticks) {
      r = judgeDispatchStartForRepo(
        {
          repoRoot: worktreePath,
          droppedTaskFiles: evidence,
          now: dispatchedAtMs + offset,
        },
        opts,
      );
    }
    assert.equal(
      store.peek()[worktreePath].observations.length,
      5,
      "창은 상한(5) 그대로 유지된다(자르기 자체는 그대로 일어남)",
    );
    assert.equal(
      store.peek()[worktreePath].observations[0].totalBytes,
      0,
      "기준점(가장 이른 관측, 0B)이 창에서 밀려나지 않았다",
    );
    assert.equal(
      r.verdict,
      DISPATCH_START_VERDICT.STARTED,
      "기준점이 보존돼 화면의 NOT_STARTED가 '시작은 했다가 멈춤'으로 뒤집혀야 한다",
    );
    assert.equal(
      r.reasonCode,
      DISPATCH_START_OVERRIDE_REASON.SESSION_SIZE_STARTED_THEN_STALLED,
      "뒤집힌 사유가 GREW_RECENTLY/진짜 미착수와 다른 값으로 구별된다",
    );
    console.log(
      "HYK-464-watch-start-axis-1 ⓐ quote: result =",
      JSON.stringify({
        verdict: r.verdict,
        reasonCode: r.reasonCode,
        storedBaseline: store.peek()[worktreePath].observations[0],
      }),
    );
  });
});

test("ⓑ codex 좌석(합성): 역할이 REVIEW면(배달기 기본값과 같은 규칙, engine=codex) ORCA_CODEX_HOME(주입)에서 크기를 관측한다 -- claude 집(.claude-team)이 아니라 이 집의 성장만 본다(판정 §1 ⑶/§2 ⓑ)", () => {
  withTempDir("hyk464-codexhome-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      role: "review",
      taskId: "HYK-464-codex-1",
      droppedAt: "2026-10-20 10:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-20T10:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "REVIEW" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    return withTempDir("hyk464-fakecodexhome-", (fakeCodexHome) => {
      // ★osHomedirFn은 일부러 "claude 집"으로만 가리키는 다른 폴더를
      // 주지 않는다(주입 자체를 안 함, 기본 .claude-team 분기는 안 탄다
      // -- 이 칸은 engine=codex일 때 그 분기를 «안 타는지»가 핵심).
      const codexHomeEnvFn = () => fakeCodexHome;
      const projectDir = join(
        fakeCodexHome,
        "projects",
        deriveClaudeProjectDirName(worktreePath),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "session.jsonl"),
        "x".repeat(1_000),
        "utf8",
      );
      const opts = { execFn, codexHomeEnvFn, ...store };
      const evidence = evidenceItems(worktreePath);
      judgeDispatchStartForRepo(
        { repoRoot: worktreePath, droppedTaskFiles: evidence, now: tick1At },
        opts,
      );
      // 두 번째 틱 전에 codex 집 쪽 실 파일을 키운다(실 fs 성장).
      writeFileSync(
        join(projectDir, "session.jsonl"),
        "x".repeat(51_000),
        "utf8",
      );
      const r = judgeDispatchStartForRepo(
        { repoRoot: worktreePath, droppedTaskFiles: evidence, now: tick2At },
        opts,
      );
      assert.equal(
        r.verdict,
        DISPATCH_START_VERDICT.STARTED,
        "codex 집(ORCA_CODEX_HOME)의 실제 성장을 봐야 한다",
      );
      assert.equal(
        r.reasonCode,
        DISPATCH_START_OVERRIDE_REASON.SESSION_SIZE_GREW_RECENTLY,
      );
    });
  });
});

test("ⓑ 비타협: codex 좌석인데 ORCA_CODEX_HOME을 못 읽으면(주입이 undefined를 낙하) 조용히 .claude-team으로 안 내려가고 '관측 불가'로 떨어진다 -- 화면 판정은 그대로 남고 sizeObservationReasonCode가 보이는 값으로 실린다(판정 §1 ⑶/⑷, 조용한 낙하 금지)", () => {
  withTempDir("hyk464-codexmissing-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      role: "review",
      taskId: "HYK-464-codex-2",
      droppedAt: "2026-10-20 10:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
    const tick2At = Date.parse("2026-10-20T10:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "REVIEW" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    // ★이 실 머신에는 ORCA_CODEX_HOME이 실제로 설정돼 있다(관측,
    // 2026-10-22) -- 이 축이 그 실 env를 몰래 타지 않는다는 것을
    // 재현 가능하게 증명하려고 codexHomeEnvFn을 "undefined 낙하"로
    // 명시 주입한다(실 머신 env 설정 여부에 결과가 좌우되지 않는다).
    const codexHomeEnvFn = () => undefined;
    const opts = { execFn, codexHomeEnvFn, ...store };
    const evidence = evidenceItems(worktreePath);
    judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidence,
        now: dispatchedAtMs + 30_000,
      },
      opts,
    );
    const r = judgeDispatchStartForRepo(
      { repoRoot: worktreePath, droppedTaskFiles: evidence, now: tick2At },
      opts,
    );
    assert.equal(
      r.verdict,
      DISPATCH_START_VERDICT.NOT_STARTED,
      "관측 불가는 '시작했다'로 새지 않는다 -- 화면이 이미 NOT_STARTED면 그대로 유지",
    );
    assert.equal(
      r.sizeObservationReasonCode,
      "DISPATCH_START_SIZE_OBSERVATION_UNAVAILABLE",
    );
    const storedObservations = store.peek()[worktreePath].observations;
    assert.equal(
      storedObservations.every((o) => typeof o.totalBytes !== "number"),
      true,
      "관측 불가 회차는 totalBytes를 저장하지 않는다(ⓒ 기존 불변 유지)",
    );
  });
});

// ⓒ 결선의 두 칸이 공유하는 fixture(관측 불가를 유도하는 codex 좌석) --
// max-lines-per-function 상한(80) 준수를 위해 두 test로 나누되, 뼈대
// 조립만 뽑는다(판정 로직은 그대로).
function buildSizeObsWiringFixture(dir) {
  initPlainGitRepo(dir);
  writeTaskFile(dir, {
    role: "review",
    taskId: "HYK-464-sizeobs-1",
    droppedAt: "2026-10-20 10:00",
  });
  const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
  const now = Date.parse("2026-10-20T10:43:00+09:00");
  const worktreePath = gitWorktreeSelfPath(dir);
  const showStub = {
    ok: true,
    result: { terminal: { lastOutputAt: dispatchedAtMs, title: "REVIEW" } },
  };
  const execFn = fakeOrcaExecFn({
    terminals: [{ handle: "term_x", worktreePath }],
    showsByHandle: { term_x: showStub },
  });
  const store = fakeDispatchStartStore();
  const codexHomeEnvFn = () => undefined; // 미설정 흉내 -- 관측 불가 유도.
  const opts = { execFn, codexHomeEnvFn, ...store };
  const dispatchStart = judgeDispatchStartAcrossWorktrees(
    { repoRoot: worktreePath, now },
    opts,
  );
  return { worktreePath, now, dispatchStart };
}

test("ⓒ 결선: 집 관측 불가 사유 코드(sizeObservationReasonCode)가 judgeDispatchStartAcrossWorktrees의 worktrees[]를 거쳐 watch-run.mjs의 last-run.json·watch.log까지 실제로 닿는다", () => {
  withTempDir("hyk464-sizeobs-wiring-", (dir) => {
    const { worktreePath, now, dispatchStart } = buildSizeObsWiringFixture(dir);
    assert.equal(
      dispatchStart.worktrees[0].sizeObservationReasonCode,
      "DISPATCH_START_SIZE_OBSERVATION_UNAVAILABLE",
    );
    const watchDir = mkdtempSync(join(tmpdir(), "hyk464-sizeobs-watchdir-"));
    try {
      const stdout = JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        dispatchStart,
      });
      const result = runWatchOnce({
        repoRoot: worktreePath,
        watchDir,
        now,
        execFn: () => stdout,
      });
      const record = JSON.parse(readFileSync(result.aliveRecordPath, "utf8"));
      assert.equal(record.startSizeObservationUnavailable.length, 1);
      assert.equal(
        record.startSizeObservationUnavailable[0].reasonCode,
        "DISPATCH_START_SIZE_OBSERVATION_UNAVAILABLE",
      );
      const logText = readFileSync(result.logPath, "utf8");
      assert.match(
        logText,
        /start_size_observation_unavailable=1 start_size_observation_unavailable_detail=.+:DISPATCH_START_SIZE_OBSERVATION_UNAVAILABLE/,
      );
      console.log(
        "HYK-464-watch-start-axis-1 ⓒ quote: watch.log line =",
        logText.trim(),
      );
    } finally {
      rmSync(watchDir, { recursive: true, force: true });
    }
  });
});

test("ⓒ 회귀 0: 정상 회차(관측 불가 0건)는 그 코드가 watch.log·last-run.json에 한 글자도 안 남는다(산출물 소음 없음)", () => {
  withTempDir("hyk464-sizeobs-normal-", (dir) => {
    const { worktreePath, now } = buildSizeObsWiringFixture(dir);
    const normalDispatchStart = {
      status: "DISPATCH_START_JUDGED",
      verdict: "STARTED",
      worstCount: 1,
      totalWorktrees: 1,
      worktrees: [
        { worktreePath, status: "DISPATCH_START_JUDGED", verdict: "STARTED" },
      ],
    };
    const watchDir = mkdtempSync(join(tmpdir(), "hyk464-sizeobs-watchdir2-"));
    try {
      const stdout = JSON.stringify({
        verdict: "PROGRESSING",
        reasonCode: "OK",
        dispatchStart: normalDispatchStart,
      });
      const result = runWatchOnce({
        repoRoot: worktreePath,
        watchDir,
        now,
        execFn: () => stdout,
      });
      const record = JSON.parse(readFileSync(result.aliveRecordPath, "utf8"));
      assert.equal(record.startSizeObservationUnavailable.length, 0);
      const logText = readFileSync(result.logPath, "utf8");
      assert.doesNotMatch(logText, /start_size_observation_unavailable=/);
    } finally {
      rmSync(watchDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// NC mutation -- ⓐ/ⓑ/ⓒ 세 칸 되돌림(worker-dispatch-rule 비타협: mutations
// RED, importMutatedSibling 관례 그대로 재사용).
// ===========================================================================

test("NC mutation/hyk464-start-axis #5 (필수, ⓐ): nextObservationsForDispatch의 기준점 보존을 걷어내 옛 '단순 최근 N개' 자르기로 되돌리기 -> RED(기준점을 잃어 STALLED 오버라이드가 NOT_STARTED로 오판)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `  const combined = [...prevObservations, observation];
  if (combined.length <= MAX_STORED_DISPATCH_START_OBSERVATIONS) {
    return combined;
  }
  const baseline = combined[0];
  const recentSlotCount = MAX_STORED_DISPATCH_START_OBSERVATIONS - 1;
  const recent = combined.slice(combined.length - recentSlotCount);
  return [baseline, ...recent];
}`,
        `  const combined = [...prevObservations, observation];
  return combined.length > MAX_STORED_DISPATCH_START_OBSERVATIONS
    ? combined.slice(combined.length - MAX_STORED_DISPATCH_START_OBSERVATIONS)
    : combined;
}`,
      ),
    "5",
  );
  withTempDir("hyk464-mutant5-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      taskId: "HYK-464-baseline-mutant-1",
      droppedAt: "2026-10-20 10:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "CODER" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const ticks = [10_000, 20_000, 30_000, 40_000, 50_000, 400_000];
    const sizes = [0, 5_000, 5_000, 5_000, 5_000, 5_000];
    const collectSessionSizeFn = fakeSessionSize(sizes);
    const opts = {
      execFn,
      collectSessionSizeFn,
      sessionSizeTimeoutMs: 60_000,
      sessionSizeStallThresholdMs: 60_000,
      ...store,
    };
    const evidence = mutant.collectDroppedTaskFileEvidence(worktreePath, {});
    let r;
    for (const offset of ticks) {
      r = mutant.judgeDispatchStartForRepo(
        {
          repoRoot: worktreePath,
          droppedTaskFiles: evidence.items,
          now: dispatchedAtMs + offset,
        },
        opts,
      );
    }
    assert.equal(
      r.verdict,
      DISPATCH_START_VERDICT.NOT_STARTED,
      "mutant must lose the baseline and fall back to NOT_STARTED (RED signal; proves baseline preservation is load-bearing)",
    );
  });
});

test("NC mutation/hyk464-start-axis #6 (필수, ⓑ): resolveSeatEngineHint이 REVIEW/PM도 전부 claude로 접기(codex 분기 무효화) -> RED(codex 좌석의 실제 성장을 못 본다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `function resolveSeatEngineHint(role) {
  const upper = typeof role === "string" ? role.toUpperCase() : "";
  return upper === "REVIEW" || upper === "PM" ? "codex" : "claude";
}`,
        `function resolveSeatEngineHint(role) {
  return "claude";
}`,
      ),
    "6",
  );
  withTempDir("hyk464-mutant6-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      role: "review",
      taskId: "HYK-464-codex-mutant-1",
      droppedAt: "2026-10-20 10:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
    const tick1At = dispatchedAtMs + 30_000;
    const tick2At = Date.parse("2026-10-20T10:43:00+09:00");
    const store = fakeDispatchStartStore();
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "REVIEW" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    return withTempDir("hyk464-mutant6-codexhome-", (fakeCodexHome) => {
      const codexHomeEnvFn = () => fakeCodexHome;
      const projectDir = join(
        fakeCodexHome,
        "projects",
        deriveClaudeProjectDirName(worktreePath),
      );
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(
        join(projectDir, "session.jsonl"),
        "x".repeat(1_000),
        "utf8",
      );
      const opts = { execFn, codexHomeEnvFn, ...store };
      const evidence = mutant.collectDroppedTaskFileEvidence(worktreePath, {});
      mutant.judgeDispatchStartForRepo(
        {
          repoRoot: worktreePath,
          droppedTaskFiles: evidence.items,
          now: tick1At,
        },
        opts,
      );
      writeFileSync(
        join(projectDir, "session.jsonl"),
        "x".repeat(51_000),
        "utf8",
      );
      const r = mutant.judgeDispatchStartForRepo(
        {
          repoRoot: worktreePath,
          droppedTaskFiles: evidence.items,
          now: tick2At,
        },
        opts,
      );
      assert.equal(
        r.verdict,
        DISPATCH_START_VERDICT.NOT_STARTED,
        "mutant must miss the codex-home growth entirely (RED signal; proves engine-based home selection is load-bearing)",
      );
    });
  });
});

test("NC mutation/hyk464-start-axis #7 (필수, ⓒ): persistAndJudgeDispatchStart가 sizeObservationReasonCode를 결과에 안 싣게 되돌리기 -> RED(관측 불가 사유가 다시 조용히 사라진다)", async () => {
  const mutant = await importMutatedSibling(
    (src) =>
      applyMutation(
        src,
        `    ...(sizeCollected.ok !== true
      ? { sizeObservationReasonCode: sizeCollected.reasonCode ?? null }
      : {}),
    ...(correlation ? { correlation } : {}),`,
        `    ...(correlation ? { correlation } : {}),`,
      ),
    "7",
  );
  withTempDir("hyk464-mutant7-", (dir) => {
    initPlainGitRepo(dir);
    writeTaskFile(dir, {
      role: "review",
      taskId: "HYK-464-sizeobs-mutant-1",
      droppedAt: "2026-10-20 10:00",
    });
    const dispatchedAtMs = Date.parse("2026-10-20T10:00:00+09:00");
    const now = Date.parse("2026-10-20T10:43:00+09:00");
    const worktreePath = gitWorktreeSelfPath(dir);
    const showStub = {
      ok: true,
      result: { terminal: { lastOutputAt: dispatchedAtMs, title: "REVIEW" } },
    };
    const execFn = fakeOrcaExecFn({
      terminals: [{ handle: "term_x", worktreePath }],
      showsByHandle: { term_x: showStub },
    });
    const store = fakeDispatchStartStore();
    const codexHomeEnvFn = () => undefined;
    const opts = { execFn, codexHomeEnvFn, ...store };
    const evidence = mutant.collectDroppedTaskFileEvidence(worktreePath, {});
    mutant.judgeDispatchStartForRepo(
      {
        repoRoot: worktreePath,
        droppedTaskFiles: evidence.items,
        now: dispatchedAtMs + 30_000,
      },
      opts,
    );
    const r = mutant.judgeDispatchStartForRepo(
      { repoRoot: worktreePath, droppedTaskFiles: evidence.items, now },
      opts,
    );
    assert.equal(
      r.sizeObservationReasonCode,
      undefined,
      "mutant must drop the reason code again (RED signal; proves the field wiring is load-bearing)",
    );
  });
});
