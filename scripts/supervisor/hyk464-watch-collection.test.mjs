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
} from "./orch-stall-detect.mjs";
import { DISPATCH_START_VERDICT } from "./dispatch-start-core.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("ⓖ 본체 실물 읽기 대조(읽기 전용): 실 .harness의 두 묵은 task 파일이 실 dispatch-receipts.jsonl 대조로 '제외됨'으로 나온다", () => {
  const mainRepoRoot = "C:/Users/Administrator/Documents/HARNESSENGINEERING";
  const realReceiptPath = "D:/문서관리/하네스-관제실/dispatch-receipts.jsonl";
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
        `  try {
    readFileFn(receiptPath, "utf8"); // 읽기 가능성만 재확인(위 헤더 참조).
  } catch {
    return { status: DELIVERY_RECEIPT_CHECK.UNRESOLVED, role };
  }`,
        `  try {
    readFileFn(receiptPath, "utf8");
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
