// HYK-255-partial-counter-1 (coder-task.md §3) -- 부분 계수 보고기 wire
// 계약 시험. ⛔공허 시험 금지: runPartialCountOnce(프로덕션 조립 함수)와
// CLI 진입점(node partial-count-report.mjs)을 직접 구동한다.
//
// ★GitHub 수집기 «라이브 결선» 증거(coder-task.md §1): 첫 시험은 가짜
// fetchJson/git 포트를 주입하되 approval-authority-adapter.mjs의 실제
// 코드(createGitHubApprovalPort -> isHumanApproved)를 그대로 통과시킨다 --
// repo 신원 측정·보호 브랜치 확인·origin/master 판본 allowlist 대조·PR
// 결속·리뷰 판정 전부가 실제 수집기 로직으로 돈다(가짜인 것은 HTTP/git
// 전송층뿐 -- 그 수집기 자신의 시험 규율 «실제 네트워크 호출 0건»과
// 동일). fetchJson이 api.github.com URL로 실제 호출됐는지를 기록해
// «만들었지만 안 부른다»가 아님을 고정한다.
// ★모든 경로는 mkdtemp 격리 -- 실 관제실·실 받는함 미접촉.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  runPartialCountOnce,
  collectMergeCandidates,
  collectConsumedRounds,
  collectOutboxHeaderCounts,
  collectRelayLedger,
  collectGate4Independent,
  DEFAULT_MAX_MERGE_CHECKS,
  DEFAULT_EXTRA_REPO_ROOTS,
  DEFAULT_ARCHIVE_ROOT,
} from "./partial-count-report.mjs";
import { runReachOnce } from "./reach-report.mjs";
import { formatKst, renderRelayLedgerAuxLines } from "./partial-count-core.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-08-14T06:00:00.000Z");
const MERGE_SHA = "f".repeat(40);
const HEAD_SHA = MERGE_SHA;
const PULL_HEAD_SHA = "e".repeat(40);
const REPO = "hykim82/HARNESSENGINEERING";

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function watchLogLine({
  ts,
  idleVerdict = "NONE",
  idleStatus = "SEAT_IDLE_NOT_APPLICABLE",
}) {
  return (
    `${ts} exit=0 verdict=PROGRESSING reason=OK ` +
    `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
    `idle_status=${idleStatus} idle_verdict=${idleVerdict} idle_worst_count=NONE idle_worktrees=1 ` +
    `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
    `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`
  );
}

// 실제 저장소의 approver-allowlist.json과 같은 스키마(schema_version 포함
// -- 다르면 수집기가 ALLOWLIST_MALFORMED로 fail-closed한다).
const ALLOWLIST_JSON = JSON.stringify({
  schema_version: "approver-allowlist/v1",
  repo: REPO,
  approvers: [{ login: "hykim82", id: 286230306 }],
});

// approval-authority-adapter.mjs의 git 포트 계약({run(args)->{code,stdout,
// stderr}})을 그대로 구현한 가짜 -- 전송층만 가짜, 판정은 실제 수집기.
function fakeGitPort() {
  return {
    run(args) {
      const key = args.join(" ");
      if (key === "remote get-url origin") {
        return {
          code: 0,
          stdout: `https://github.com/${REPO}.git\n`,
          stderr: "",
        };
      }
      if (key === "rev-parse origin/master") {
        return { code: 0, stdout: `${HEAD_SHA}\n`, stderr: "" };
      }
      if (key.startsWith("cat-file blob origin/master:")) {
        return { code: 0, stdout: ALLOWLIST_JSON, stderr: "" };
      }
      if (args[0] === "log") {
        return {
          code: 0,
          stdout: `${MERGE_SHA} 2026-08-14T05:00:00+00:00\n`,
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: `unexpected git args: ${key}` };
    },
  };
}

// GitHub REST 응답 가짜 -- 호출 URL을 calledUrls에 기록한다(라이브 결선
// 증거). payload는 수집기의 형태 검사(isWellFormedPullDetail 등)를
// 통과하는 최소 실형태.
function fakeFetchJson(calledUrls) {
  const routes = new Map([
    [`https://api.github.com/repos/${REPO}`, { default_branch: "master" }],
    [
      `https://api.github.com/repos/${REPO}/branches/master`,
      { protected: true, commit: { sha: HEAD_SHA } },
    ],
    [
      `https://api.github.com/repos/${REPO}/commits/${MERGE_SHA}/pulls`,
      [{ merge_commit_sha: MERGE_SHA, number: 152 }],
    ],
    [
      `https://api.github.com/repos/${REPO}/pulls/152`,
      {
        merged: true,
        base: { ref: "master" },
        head: { sha: PULL_HEAD_SHA },
        user: { login: "harness-bot", id: 999 },
      },
    ],
    [
      `https://api.github.com/repos/${REPO}/pulls/152/reviews?per_page=100`,
      [
        {
          id: 1,
          user: { login: "hykim82", id: 286230306 },
          state: "APPROVED",
          commit_id: PULL_HEAD_SHA,
          submitted_at: "2026-08-14T04:59:00Z",
        },
      ],
    ],
  ]);
  return async ({ url }) => {
    calledUrls.push(url);
    const json = routes.get(url);
    if (json === undefined) {
      return { ok: false, status: 404, json: null, linkHeader: null };
    }
    return { ok: true, status: 200, json, linkHeader: null };
  };
}

// nowMs -- 이 fixture가 만드는 시각들이 상대적으로 서 있는 기준점.
// «지금부터 지난 24시간» 창을 재는 쪽(runPartialCountOnce)의 `now`와
// 반드시 같은 기준이어야 한다 -- 절대 리터럴로 못 박으면 그 기준(now)이
// 며칠만 지나도 창 밖으로 밀려난다(HYK-255 시한폭탄 실사고). 창 안 2건은
// nowMs-1h·nowMs-2h(항상 안), 창 밖 1건은 nowMs-5일(항상 밖)로 둔다.
function writeFixtures(root, nowMs = NOW) {
  const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
  fs.writeFileSync(
    dispatchReceiptsPath,
    [
      JSON.stringify({
        recorded_at: new Date(nowMs - 1 * HOUR).toISOString(),
        role: "CODER",
        harness_task_label: "HYK-1-a",
      }),
      JSON.stringify({
        recorded_at: new Date(nowMs - 2 * HOUR).toISOString(),
        role: "REVIEW",
        harness_task_label: "HYK-2-b",
      }),
      JSON.stringify({
        recorded_at: new Date(nowMs - 5 * DAY).toISOString(),
        role: "CODER",
        harness_task_label: "HYK-old",
      }),
      "this-line-is-not-json",
    ].join("\n"),
    "utf8",
  );

  const watchLogPath = join(root, "watch.log");
  fs.writeFileSync(
    watchLogPath,
    [
      watchLogLine({
        ts: new Date(nowMs - 3 * HOUR).toISOString(),
        idleStatus: "SEAT_IDLE_JUDGED",
        idleVerdict: "SUSPECTED_ABANDONED",
      }),
      watchLogLine({ ts: new Date(nowMs - 2 * HOUR).toISOString() }),
    ].join("\n"),
    "utf8",
  );

  // 소비 완료 영수증(HYK-244 writer가 만드는 실형태의 부분집합) --
  // 배달 라벨 HYK-1-a 라운드가 소비됐고 HYK-2-b는 결손.
  const wt1 = join(root, "wt1");
  fs.mkdirSync(join(wt1, ".harness", "receipts"), { recursive: true });
  fs.writeFileSync(
    join(wt1, ".harness", "receipts", "CODER-receipt-r1.json"),
    JSON.stringify({
      binding: {
        taskId: "HYK-1-a",
        role: "CODER",
        droppedAt: formatKst(nowMs - 3 * HOUR),
        doneAt: formatKst(nowMs - 2 * HOUR),
      },
      effects: {
        envelopeArchived: true,
        taskArchived: true,
        admissionReturned: true,
      },
    }),
    "utf8",
  );
  const worktreeListPorcelain = `worktree ${wt1}\nHEAD ${"a".repeat(40)}\n`;
  return { dispatchReceiptsPath, watchLogPath, worktreeListPorcelain };
}

test("runPartialCountOnce: 실제 수집기(approval-authority-adapter)를 GitHub REST 층까지 실호출해 ㄱ-4 확인 1건·분모·의심구간·«확인 0건»을 한 보고서로 낸다", async () => {
  const root = tmpDir("nc-pcw-full-");
  try {
    const fx = writeFixtures(root);
    const calledUrls = [];
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: fx.dispatchReceiptsPath,
      watchLogPath: fx.watchLogPath,
      // HYK-255-consumed-denominator-1 격리: ②③ 기본값은 실제 D:\ ·
      // C:\Users\...\모바일마크다운에디터 경로다 -- 이 시험은 그 실경로를
      // 건드리지 않도록 ②를 비우고 ③을 이 tmp 루트 밑 "없는 경로"로 둔다.
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      fetchJson: fakeFetchJson(calledUrls),
      git: fakeGitPort(),
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    const text = result.reportText;
    assert.equal(text.split("\n")[0], "집계 성격: PARTIAL — 전수 아님");
    // ㄱ-4: 실제 수집기 판정 경로를 통과한 독립 확인 1건 + 결속 근거.
    assert.ok(text.includes("- 외부 독립 앵커로 확인: 1건"));
    assert.ok(
      text.includes(
        `확인 사건: ${MERGE_SHA.slice(0, 7)} PR#152 승인자 hykim82`,
      ),
    );
    // 라이브 결선 증거: 수집기가 GitHub REST URL을 실제로 호출했다.
    assert.ok(calledUrls.length >= 4, `REST 호출 ${calledUrls.length}회`);
    assert.ok(calledUrls.every((u) => u.startsWith("https://api.github.com/")));
    // 분모: 창 내 배달 2 · 소비 1 · 결손 1(HYK-2-b). 2R 반려 1 수리 고정:
    // 바로 다음 줄에 기준 단위(레코드/고유 라벨)가 프로덕션 출력으로 나온다.
    assert.ok(
      text.includes(
        "라운드 분모: 배달 2 / 소비 1 / 영수증 결손 1\n(기준 단위: 배달·소비 = 레코드 수 · 영수증 결손 = 영수증 없는 고유 라벨 수 — 단위가 달라 «배달−소비=결손»이 성립하지 않음)",
      ),
    );
    // 의심 구간(닫힌 1건)은 진단 칸에만 -- ㄴ 확인은 여전히 «확인 0건».
    assert.ok(text.includes("- 무진행-재개 의심 구간: 1건 — ㄴ 분자에 미산입"));
    assert.ok(text.includes("- 외부 독립 증거로 확인된 사건: 확인 0건"));
    assert.ok(!text.includes("외부 독립 증거로 확인된 사건: 0건"));
    // 독립 ㄴ 수집기: HYK-255-ln-update-branch-1 -- Update branch 수집기가 결선됐으므로
    // 옛 «FAIL(부재 -- 이 라운드 결선 없음)» 은 사실이 아니다(의도된 변경 · 한용 확정 1540).
    // 한 유형만 결선이라는 사실은 줄에 남는다.
    assert.ok(!text.includes("독립ㄴ수집기 FAIL(부재"));
    assert.ok(
      text.includes(
        "독립ㄴ수집기 OK(GitHub 웹 Update branch 확인분만 결선(외부독립증거후보수집기) — 그 밖 ㄴ 유형은 결선 없음)",
      ),
    );
    // 배달 영수증 파싱 실패 1줄이 조용히 사라지지 않는다.
    assert.ok(text.includes("파싱 실패 1줄"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("수집 실패는 0으로 접히지 않는다: 배달 영수증 파일 없음 -> 배달 UNKNOWN(사유)", async () => {
  const root = tmpDir("nc-pcw-unknown-");
  try {
    const fx = writeFixtures(root);
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: join(root, "does-not-exist.jsonl"),
      watchLogPath: fx.watchLogPath,
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      fetchJson: fakeFetchJson([]),
      git: fakeGitPort(),
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    assert.ok(
      result.reportText.includes("배달 UNKNOWN(dispatch-receipts 읽기 실패)"),
    );
    assert.ok(!result.reportText.includes("배달 0 /"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("호출 예산 0이면 후보는 «미조회(예산)»로 남고 REST 호출이 0회다 -- 미조회는 0으로 접히지 않는다", async () => {
  const root = tmpDir("nc-pcw-budget-");
  try {
    const fx = writeFixtures(root);
    const calledUrls = [];
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: fx.dispatchReceiptsPath,
      watchLogPath: fx.watchLogPath,
      maxMergeChecks: 0,
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      fetchJson: fakeFetchJson(calledUrls),
      git: fakeGitPort(),
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    assert.equal(calledUrls.length, 0);
    assert.ok(
      result.reportText.includes("미조회(예산) 1건 — 미조회는 미계수다"),
    );
    // HYK-255-ln-update-branch-1 커밋 3 (의도된 변경 · 판정 1804): ㄱ-4 기본 상한 3 -> 1.
    assert.equal(DEFAULT_MAX_MERGE_CHECKS, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectMergeCandidates: git log 실패는 ok:false(UNKNOWN 재료)이고 창 밖 병합은 후보가 아니다", () => {
  const failing = collectMergeCandidates({
    git: { run: () => ({ code: 128, stdout: "", stderr: "no origin" }) },
    windowStartMs: 0,
    windowEndMs: NOW,
  });
  assert.equal(failing.ok, false);
  const windowed = collectMergeCandidates({
    git: {
      run: () => ({
        code: 0,
        stdout:
          `${"a".repeat(40)} 2026-08-14T05:00:00+00:00\n` +
          `${"b".repeat(40)} 2026-08-01T00:00:00+00:00\n`,
        stderr: "",
      }),
    },
    windowStartMs: NOW - 24 * HOUR,
    windowEndMs: NOW,
  });
  assert.equal(windowed.ok, true);
  assert.equal(windowed.candidates.length, 1);
  assert.equal(windowed.candidates[0].sha, "a".repeat(40));
});

test("CLI 진입점: 인자만으로 격리 실행되고(비 git 폴더 -> 소비·ㄱ-4가 UNKNOWN) PARTIAL 배너가 첫 줄이다", () => {
  const root = tmpDir("nc-pcw-cli-");
  try {
    // CLI(partial-count-report.mjs)는 --now를 받지 않고 실행 시각의
    // Date.now()로 창을 잰다 -- fixture도 그 실제 현재 시각 기준으로
    // 써야 한다(고정된 NOW를 쓰면 시간이 지날수록 창 밖으로 밀려난다 --
    // HYK-255 시한폭탄의 원인).
    const fx = writeFixtures(root, Date.now());
    const stdout = execFileSync(
      process.execPath,
      [
        join(
          process.cwd(),
          "scripts",
          "supervisor",
          "partial-count-report.mjs",
        ),
        "--dispatch-receipts",
        fx.dispatchReceiptsPath,
        "--watch-log",
        fx.watchLogPath,
        "--repo-root",
        join(root, "not-a-git-repo-i-swear"),
        "--max-merge-checks",
        "0",
        // HYK-255-consumed-denominator-1: 새 CLI 플래그가 실제로 읽히는지
        // (그리고 ②③ 실경로 기본값을 밀어내는지) 같은 호출에서 스모크.
        // --repo-root가 비-git이라 ①에서 조기 반환되므로 이 값들 자체는
        // 쓰이지 않지만, 파서가 던지지 않고 받아들이는지는 값으로 증명한다.
        "--extra-repo-root",
        join(root, "extra-missing"),
        "--archive-root",
        join(root, "archive-missing"),
        "--archive-scan-max-depth",
        "2",
      ],
      { encoding: "utf8" },
    );
    assert.equal(stdout.split("\n")[0], "집계 성격: PARTIAL — 전수 아님");
    assert.ok(stdout.includes("배달 2"));
    // 2R 반려 1 수리 고정: 기준 단위 줄이 CLI 실출력에도 나온다(분모가
    // 일부 UNKNOWN이어도 단위 표기는 항상 붙는다).
    assert.ok(stdout.includes("(기준 단위: 배달·소비 = 레코드 수"));
    assert.ok(stdout.includes("소비 UNKNOWN(워크트리 열거 실패)"));
    assert.ok(
      stdout.includes("- 외부 독립 앵커로 확인: UNKNOWN(병합 후보 조회 실패:"),
    );
    assert.ok(stdout.includes("- 외부 독립 증거로 확인된 사건: 확인 0건"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HYK-255-watch-wire-1 수리 고정: 승인 수집기 헤더가 «온디맨드 CLI + 상시 감시 실행 경로 둘 다 결선»을 말하고, 옛 «상시 실행기·스케줄러는 없음»·«호출자가 없다» 문면은 남아 있지 않다", () => {
  const src = fs.readFileSync(
    join(
      process.cwd(),
      "scripts",
      "supervisor",
      "approval-authority-adapter.mjs",
    ),
    "utf8",
  );
  // 새 문면 -- 온디맨드 CLI + 상시 감시 실행 경로(watch-run.mjs) 둘 다
  // 결선됐다는 사실, 그리고 과대 주장(«항상 최신»)을 하지 않는다는 한계.
  assert.ok(src.includes("온디맨드 부분 계수 CLI"));
  assert.ok(src.includes("감시 실행 경로"));
  assert.ok(src.includes("watch-run.mjs"));
  assert.ok(src.includes("과대 주장 금지"));
  // 옛 문면(HYK-255 2R 정정 당시의 «상시 실행기·스케줄러는 없음»)은 이제
  // 사실과 모순 -- 이 라운드가 그 경로를 실제로 결선했으므로 재유입을
  // 막는다.
  assert.ok(!src.includes("상시 실행기·스케줄러는 없음"));
  // 옛 문면(«호출자가 없다» -- :39·:143에 있었다)은 이제 사실과 모순 --
  // 재유입을 막는다. (:36의 «호출자가 fetch를 선행해야 한다»는 별개
  // 문장이라 이 정규식에 안 걸린다.)
  assert.ok(!/호출자가 (아직 )?없/.test(src));
});

test("아침 보고 도달(1-B): runReachOnce가 부분 계수 보고 파일을 morning-report에 편입하고, 없으면 UNKNOWN을 명시한다", () => {
  const root = tmpDir("nc-pcw-reach-");
  try {
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(
      watchLogPath,
      watchLogLine({ ts: new Date(NOW - HOUR).toISOString() }),
      "utf8",
    );
    const reportOutPath = join(root, "morning-report.md");
    const base = {
      watchLogPath,
      reportOutPath,
      statePath: join(root, "state.json"),
      notifyDir: join(root, "받는함"),
      now: NOW,
    };

    // (1) 부분 계수 파일 없음 -> UNKNOWN 명시(조용한 생략 금지).
    const missing = runReachOnce({ ...base });
    assert.ok(missing.reportText.includes("## 부분 계수 보고 (HYK-255)"));
    assert.ok(
      missing.reportText.includes("UNKNOWN — 부분 계수 보고 파일 없음"),
    );
    assert.equal(fs.readFileSync(reportOutPath, "utf8"), missing.reportText);

    // (2) morning-report 옆의 기본 위치에 신선한 보고가 있으면 내용이
    // 그대로 실린다 -- watch-run.mjs의 기존 호출(경로 미지정)이 그대로
    // 실 아침 보고에 닿는 경로다.
    fs.writeFileSync(
      join(root, "partial-count-report.md"),
      `집계 성격: PARTIAL — 전수 아님\n생성 시각: ${formatKst(NOW - HOUR)}\n라운드 분모: 배달 2 / 소비 1 / 영수증 결손 1\n`,
      "utf8",
    );
    const present = runReachOnce({ ...base });
    assert.ok(present.reportText.includes("집계 성격: PARTIAL — 전수 아님"));
    assert.ok(
      present.reportText.includes(
        "라운드 분모: 배달 2 / 소비 1 / 영수증 결손 1",
      ),
    );
    assert.ok(present.reportText.includes("(1시간 0분 전)"));
    assert.ok(
      !present.reportText.includes("UNKNOWN — 부분 계수 보고 파일 없음"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-consumed-denominator-1 -- §2 요건 7(신규 시험 칸, 필수). 모두
// collectConsumedRounds(프로덕션 export)를 직접 타고 내용을 단언한다.
// 합성 폴더는 전부 mkdtemp 격리 -- 실 아카이브·실 에디터 저장소 미접촉.
// ---------------------------------------------------------------------------

test("기본값: DEFAULT_EXTRA_REPO_ROOTS·DEFAULT_ARCHIVE_ROOT가 문서화된 값이고(①외 ②③ 기본 경로) 옵션/CLI로 바뀐다", () => {
  assert.deepEqual(DEFAULT_EXTRA_REPO_ROOTS, [
    "C:/Users/Administrator/Documents/모바일마크다운에디터",
  ]);
  assert.equal(DEFAULT_ARCHIVE_ROOT, "D:/문서관리/하네스-관제실/아카이브");
});

test("ⓐ HYK-255-consumed-denominator-1: 아카이브에만 있는 영수증의 라벨이 소비로 세지고(아카이브 b건) labels에 들어간다", () => {
  const root = tmpDir("nc-pcw-archive-only-");
  try {
    const archiveRoot = join(root, "archive");
    const receiptsDir = join(
      archiveRoot,
      "2026-08-10-슬러그",
      "pr1-author",
      "receipts",
    );
    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.writeFileSync(
      join(receiptsDir, "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-9-archived-only",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );
    const result = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(result.consumed.known, true);
    assert.equal(result.consumed.count, 1);
    assert.equal(result.livingCount, 0);
    assert.equal(result.archiveCount, 1);
    assert.ok(result.labels.has("HYK-9-archived-only"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓑ HYK-255-consumed-denominator-1: 추가 저장소(②)의 워크트리에만 있는 영수증이 소비로 세진다", () => {
  const repoRoot = tmpDir("nc-pcw-extra-repo-");
  const extraRoot = tmpDir("nc-pcw-extra-root-");
  try {
    const extraWt = join(extraRoot, "editor-wt1");
    fs.mkdirSync(join(extraWt, ".harness", "receipts"), { recursive: true });
    fs.writeFileSync(
      join(extraWt, ".harness", "receipts", "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-10-extra-only",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );
    const extraPorcelain = `worktree ${extraWt}\n`;
    const result = collectConsumedRounds({
      repoRoot,
      extraRepoRoots: [extraRoot],
      archiveRoot: join(repoRoot, "archive-missing"),
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: (root) =>
        root === extraRoot ? extraPorcelain : `worktree ${repoRoot}\n`,
    });
    assert.equal(result.consumed.count, 1);
    assert.equal(result.livingCount, 1);
    assert.equal(result.archiveCount, 0);
    assert.ok(result.labels.has("HYK-10-extra-only"));
    assert.equal(result.extraRepoRootsStatus[0].status, "스캔함");
    assert.equal(result.extraRepoRootsStatus[0].scannedWorktrees, 1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(extraRoot, { recursive: true, force: true });
  }
});

test("ⓒ HYK-255-consumed-denominator-1: 같은 taskId+라운드가 살아있는 워크트리와 아카이브 둘에 있으면 한 번만 세고 출처는 살아있는 워크트리", () => {
  const repoRoot = tmpDir("nc-pcw-dedup-");
  try {
    const wt1 = join(repoRoot, "wt1");
    fs.mkdirSync(join(wt1, ".harness", "receipts"), { recursive: true });
    // B-7-6 IDENTICAL 사본 -- 살아있는 쪽과 아카이브 쪽이 바이트 동일.
    const receiptJson = JSON.stringify({
      binding: {
        taskId: "HYK-11-dup",
        role: "CODER",
        doneAt: formatKst(NOW - HOUR),
      },
    });
    fs.writeFileSync(
      join(wt1, ".harness", "receipts", "CODER-receipt-r1.json"),
      receiptJson,
      "utf8",
    );
    const archiveRoot = join(repoRoot, "archive");
    const archiveReceiptsDir = join(
      archiveRoot,
      "2026-08-10-슬러그",
      "pr1-author",
      "receipts",
    );
    fs.mkdirSync(archiveReceiptsDir, { recursive: true });
    fs.writeFileSync(
      join(archiveReceiptsDir, "CODER-receipt-r1.json"),
      receiptJson,
      "utf8",
    );

    const result = collectConsumedRounds({
      repoRoot,
      extraRepoRoots: [],
      archiveRoot,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${wt1}\n`,
    });
    assert.equal(result.consumed.count, 1);
    assert.equal(result.livingCount, 1);
    assert.equal(result.archiveCount, 0);
    assert.equal(result.labels.size, 1);
    assert.ok(result.labels.has("HYK-11-dup"));
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ⓓ HYK-255-consumed-denominator-1: 같은 taskId의 r1·r2는 두 라운드로 따로 센다", () => {
  const repoRoot = tmpDir("nc-pcw-tworounds-");
  try {
    const wt1 = join(repoRoot, "wt1");
    fs.mkdirSync(join(wt1, ".harness", "receipts"), { recursive: true });
    fs.writeFileSync(
      join(wt1, ".harness", "receipts", "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-12-tworounds",
          role: "CODER",
          doneAt: formatKst(NOW - 3 * HOUR),
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      join(wt1, ".harness", "receipts", "CODER-receipt-r2.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-12-tworounds",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );
    const result = collectConsumedRounds({
      repoRoot,
      extraRepoRoots: [],
      archiveRoot: join(repoRoot, "archive-missing"),
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${wt1}\n`,
    });
    assert.equal(result.consumed.count, 2);
    assert.equal(result.livingCount, 2);
    // taskId는 하나뿐이라 labels(고유 라벨 집합)는 1 -- 라운드 수(2)와
    // 고유 라벨 수(1)가 다른 단위라는 것을 그대로 보여준다.
    assert.equal(result.labels.size, 1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("ⓔ HYK-255-consumed-denominator-1: 보고 텍스트에 살아있는 a건 / 아카이브 b건과 «독립 앵커 아님» 뜻이 찍힌다", async () => {
  const root = tmpDir("nc-pcw-report-split-");
  try {
    const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
    fs.writeFileSync(dispatchReceiptsPath, "", "utf8");
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");

    const wt1 = join(root, "wt1");
    fs.mkdirSync(join(wt1, ".harness", "receipts"), { recursive: true });
    fs.writeFileSync(
      join(wt1, ".harness", "receipts", "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-13-living",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );
    const archiveRoot = join(root, "archive");
    const archiveReceiptsDir = join(
      archiveRoot,
      "2026-08-10-슬러그",
      "pr2-author",
      "receipts",
    );
    fs.mkdirSync(archiveReceiptsDir, { recursive: true });
    fs.writeFileSync(
      join(archiveReceiptsDir, "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-14-archived",
          role: "CODER",
          doneAt: formatKst(NOW - 2 * HOUR),
        },
      }),
      "utf8",
    );

    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath,
      watchLogPath,
      extraRepoRoots: [],
      archiveRoot,
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => `worktree ${wt1}\n`,
    });
    const text = result.reportText;
    assert.ok(text.includes("소비영수증(워크트리 1곳 · 아카이브 1곳 스캔)"));
    assert.ok(text.includes("살아있는 1건 / 아카이브 1건"));
    assert.ok(text.includes("독립 앵커 아님"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓕ HYK-255-consumed-denominator-1: 아카이브 루트 없음·추가 저장소 열거 실패가 보고에 보인다(«0건» 침묵 아님)", async () => {
  const root = tmpDir("nc-pcw-missing-sources-");
  try {
    const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
    fs.writeFileSync(dispatchReceiptsPath, "", "utf8");
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");
    const wt1 = join(root, "wt1");
    fs.mkdirSync(join(wt1, ".harness", "receipts"), { recursive: true });

    const extraRoot = join(root, "extra-repo-enum-fail");
    fs.mkdirSync(extraRoot, { recursive: true });
    const missingArchiveRoot = join(root, "archive-does-not-exist");

    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath,
      watchLogPath,
      extraRepoRoots: [extraRoot],
      archiveRoot: missingArchiveRoot,
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: (r) => {
        if (r === extraRoot) {
          throw new Error("git worktree list failed (synthetic)");
        }
        return `worktree ${wt1}\n`;
      },
    });
    const text = result.reportText;
    assert.ok(
      text.includes(
        `추가저장소(${extraRoot}) 열거 실패: git worktree list failed (synthetic)`,
      ),
    );
    assert.ok(text.includes(`아카이브 루트(${missingArchiveRoot}) 경로 없음`));
    // 소비 자체는 ①이 성공했으므로 여전히 known:true(OK) -- ②③ 실패가
    // 전체를 UNKNOWN으로 끌어올리지 않는다는 설계(§4 정직 한계)도 같은
    // 줄에서 값으로 보인다.
    assert.ok(
      text.includes("소비영수증(워크트리 1곳 · 아카이브 0곳 스캔) OK("),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-consumed-denominator-1 2R -- §2 요건 5(새 칸 필수, ㉝). 1R 검토
// P2-1·P2-2·P3-3 수리를 고정한다. 전부 collectConsumedRounds(프로덕션
// export)를 직접 타거나 runPartialCountOnce의 보고 텍스트로 내용을
// 단언한다. 합성 실패는 전부 readdirFn 포트를 감싼 합성(실 EACCES 아님) --
// 실 아카이브·실 에디터 저장소 미접촉.
// ---------------------------------------------------------------------------

test("ⓖ HYK-255-consumed-denominator-1 2R: 깊은 단계 폴더 readdir가 EACCES를 던지면 detail에 「아카이브 하위 폴더 읽기 실패 N곳」이 찍히고, 그 아래 영수증은 «0건 침묵»이 아니라 흔적을 남기며 사라진다", async () => {
  const root = tmpDir("nc-pcw-walkfail-");
  try {
    const archiveRoot = join(root, "archive");
    const blockedDir = join(archiveRoot, "2026-08-10-슬러그", "blocked");
    const hiddenReceiptsDir = join(blockedDir, "receipts");
    fs.mkdirSync(hiddenReceiptsDir, { recursive: true });
    fs.writeFileSync(
      join(hiddenReceiptsDir, "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-15-hidden",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );
    // 합성 포트 -- blockedDir만 EACCES를 던지고 나머지는 실 fs로 위임한다.
    const readdirFn = (dir) => {
      if (dir === blockedDir) {
        const err = new Error("EACCES: permission denied, scandir (synthetic)");
        err.code = "EACCES";
        throw err;
      }
      return fs.readdirSync(dir);
    };

    const direct = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      readdirFn,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(direct.walkDirFailures, 1);
    assert.equal(direct.archiveCount, 0);
    assert.ok(!direct.labels.has("HYK-15-hidden"));

    const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
    fs.writeFileSync(dispatchReceiptsPath, "", "utf8");
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath,
      watchLogPath,
      extraRepoRoots: [],
      archiveRoot,
      readdirFn,
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.ok(result.reportText.includes("아카이브 하위 폴더 읽기 실패 1곳"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓗ HYK-255-consumed-denominator-1 2R: 같은 walk에서 ENOTDIR(파일)은 실패로 세지 않는다(양성 대조 — 실패 건수 0)", () => {
  const root = tmpDir("nc-pcw-walkfile-");
  try {
    const archiveRoot = join(root, "archive");
    const slugDir = join(archiveRoot, "2026-08-10-슬러그");
    fs.mkdirSync(slugDir, { recursive: true });
    // "receipts"가 아닌 이름의 평범한 파일 -- walk가 디렉터리인 줄 알고
    // readdirFn을 걸었다가 실제 Node.js ENOTDIR을 자연히 받는다(합성 아님
    // -- Windows 실측으로 ENOTDIR 코드를 §4 한계 문단에 직접 확인한다).
    fs.writeFileSync(join(slugDir, "not-a-dir.txt"), "x", "utf8");
    // 정상 receipts도 옆에 둬서 ENOTDIR이 다른 정상 스캔을 막지 않는지도
    // 같은 시험에서 본다.
    const okReceiptsDir = join(slugDir, "pr1-author", "receipts");
    fs.mkdirSync(okReceiptsDir, { recursive: true });
    fs.writeFileSync(
      join(okReceiptsDir, "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-16-ok",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );

    const result = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(result.walkDirFailures, 0);
    assert.equal(result.archiveCount, 1);
    assert.ok(result.labels.has("HYK-16-ok"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓘ HYK-255-consumed-denominator-1 2R: 깊이 상한을 초과한 폴더가 있으면 건수가 보인다(상한 바로 다음 단계의 receipts는 못 찾되 흔적은 남는다)", async () => {
  const root = tmpDir("nc-pcw-depthcap-");
  try {
    const archiveRoot = join(root, "archive");
    // archiveRoot/d1/.../d7/receipts -- d1..d6이 depth 1..6, d7은 depth 7.
    let deepDir = archiveRoot;
    for (let i = 1; i <= 7; i++) deepDir = join(deepDir, `d${i}`);
    const deepReceiptsDir = join(deepDir, "receipts");
    fs.mkdirSync(deepReceiptsDir, { recursive: true });
    fs.writeFileSync(
      join(deepReceiptsDir, "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-17-too-deep",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );

    // 기본 상한(6) -- d7(depth 7)은 못 내려간다.
    const withDefaultDepth = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(withDefaultDepth.depthExceededCount, 1);
    assert.equal(withDefaultDepth.archiveCount, 0);
    assert.ok(!withDefaultDepth.labels.has("HYK-17-too-deep"));

    // 상한을 8로 넓히면(옵션으로 실제 바뀐다는 것도 같이 증명) d7까지
    // 내려가 receipts를 찾는다.
    const withDeeperDepth = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      archiveScanMaxDepth: 8,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(withDeeperDepth.depthExceededCount, 0);
    assert.equal(withDeeperDepth.archiveCount, 1);
    assert.ok(withDeeperDepth.labels.has("HYK-17-too-deep"));

    const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
    fs.writeFileSync(dispatchReceiptsPath, "", "utf8");
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath,
      watchLogPath,
      extraRepoRoots: [],
      archiveRoot,
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.ok(result.reportText.includes("깊이 상한(6) 초과 1곳"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓙ X3 고정 HYK-255-consumed-denominator-1 2R: 추가 저장소(②) 경로가 없으면 보고에 「추가저장소(...) 경로 없음」이 그대로 찍힌다(1R ⓕ의 «열거 실패»와 별개 칸)", async () => {
  const root = tmpDir("nc-pcw-extramissing-");
  try {
    const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
    fs.writeFileSync(dispatchReceiptsPath, "", "utf8");
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");
    const missingExtraRoot = join(root, "extra-repo-does-not-exist");

    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath,
      watchLogPath,
      extraRepoRoots: [missingExtraRoot],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.ok(
      result.reportText.includes(`추가저장소(${missingExtraRoot}) 경로 없음`),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓚ X4 고정 HYK-255-consumed-denominator-1 2R: 아카이브 루트는 있지만 자신의 readdir가 실패하면 보고에 「아카이브 루트(...) 읽기 실패: ...」가 그대로 찍힌다(1R ⓕ의 «경로 없음»과 별개 칸)", async () => {
  const root = tmpDir("nc-pcw-archivereadfail-");
  try {
    const archiveRoot = join(root, "archive");
    fs.mkdirSync(archiveRoot, { recursive: true });
    const dispatchReceiptsPath = join(root, "dispatch-receipts.jsonl");
    fs.writeFileSync(dispatchReceiptsPath, "", "utf8");
    const watchLogPath = join(root, "watch.log");
    fs.writeFileSync(watchLogPath, "", "utf8");
    const readdirFn = (dir) => {
      if (dir === archiveRoot) {
        const err = new Error("EACCES: permission denied, scandir (synthetic)");
        err.code = "EACCES";
        throw err;
      }
      return fs.readdirSync(dir);
    };

    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath,
      watchLogPath,
      extraRepoRoots: [],
      archiveRoot,
      readdirFn,
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.ok(
      result.reportText.includes(
        `아카이브 루트(${archiveRoot}) 읽기 실패: EACCES: permission denied, scandir (synthetic)`,
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ⓛ P3-3 고정 HYK-255-consumed-denominator-1 2R: archiveScanMaxDepth가 NaN·음수면 기본값(6)으로 복귀하고 상한이 꺼지지 않는다(NaN으로 상한이 꺼지는 경로 0)", () => {
  const root = tmpDir("nc-pcw-depthnan-");
  try {
    const archiveRoot = join(root, "archive");
    // d1..d7/receipts -- 기본 상한(6)이 꺼지지 않으면 d7(depth 7)은 여전히
    // 못 찾는다. NaN이 상한을 꺼버리면(depth > NaN이 항상 false) 찾아져
    // archiveCount가 1이 돼 이 시험이 RED가 된다.
    let deepDir = archiveRoot;
    for (let i = 1; i <= 7; i++) deepDir = join(deepDir, `d${i}`);
    const deepReceiptsDir = join(deepDir, "receipts");
    fs.mkdirSync(deepReceiptsDir, { recursive: true });
    fs.writeFileSync(
      join(deepReceiptsDir, "CODER-receipt-r1.json"),
      JSON.stringify({
        binding: {
          taskId: "HYK-18-nan-depth",
          role: "CODER",
          doneAt: formatKst(NOW - HOUR),
        },
      }),
      "utf8",
    );

    // CLI의 `--archive-scan-max-depth abc` -> Number("abc") = NaN이 그대로
    // 들어오는 상황을 그대로 재현한다.
    assert.ok(Number.isNaN(Number("abc")));
    const withNaN = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      archiveScanMaxDepth: Number("abc"),
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(withNaN.archiveScanMaxDepthUsed, 6);
    assert.equal(withNaN.depthExceededCount, 1);
    assert.equal(withNaN.archiveCount, 0);

    const withNegative = collectConsumedRounds({
      repoRoot: root,
      extraRepoRoots: [],
      archiveRoot,
      archiveScanMaxDepth: -3,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      gitWorktreeListExecFn: () => `worktree ${root}\n`,
    });
    assert.equal(withNegative.archiveScanMaxDepthUsed, 6);
    assert.equal(withNegative.archiveCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-outbox-aux-1 -- 보내는함(통역) 머리줄 보조 수집기
// (collectOutboxHeaderCounts, 프로덕션 export). 전부 mkdtemp 격리 -- 실
// 보내는함(D:\문서관리\통역\보내는함) 미접촉(evidence_rule).
// ---------------------------------------------------------------------------

test("collectOutboxHeaderCounts: 분류 3종(책임자 경유·한용 확정·분류 불가) + 둘 다 있으면 한용 확정 우선 + 창 밖 파일은 제외", () => {
  const root = tmpDir("nc-pcw-outbox-classify-");
  try {
    const now = NOW;
    const mk = (name, firstLine, mtimeMs) => {
      const full = join(root, name);
      fs.writeFileSync(full, `${firstLine}\n본문\n`, "utf8");
      fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
    };
    mk("a-responsible.md", "[책임자 경유 · 상태 통지] 내용", now - HOUR);
    mk(
      "b-hanyong.md",
      "[책임자 경유 · 한용 확정 B-9 위임] 내용",
      now - 2 * HOUR,
    );
    mk("c-unclassified.md", "# 그냥 제목(분류 표지 없음)", now - 3 * HOUR);
    mk("d-outside-window.md", "[책임자 경유] 창 밖", now - 999 * HOUR);
    fs.writeFileSync(join(root, "e-not-md.txt"), "[한용 확정] 무시", "utf8");

    const result = collectOutboxHeaderCounts({
      outboxDir: root,
      windowStartMs: now - 24 * HOUR,
      windowEndMs: now,
    });
    assert.equal(result.known, true);
    assert.equal(result.responsible, 1);
    assert.equal(result.hanyongConfirmed, 1);
    assert.equal(result.unclassified, 1);
    assert.equal(result.scanned, 3);
    assert.equal(result.readFailures, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectOutboxHeaderCounts: 하위 폴더(보관·전달됨)는 보지 않는다", () => {
  const root = tmpDir("nc-pcw-outbox-subdir-");
  try {
    const now = NOW;
    const archived = join(root, "보관", "old.md");
    fs.mkdirSync(join(root, "보관"), { recursive: true });
    fs.writeFileSync(archived, "[한용 확정] 보관된 문서\n", "utf8");
    fs.utimesSync(archived, new Date(now - HOUR), new Date(now - HOUR));

    const result = collectOutboxHeaderCounts({
      outboxDir: root,
      windowStartMs: now - 24 * HOUR,
      windowEndMs: now,
    });
    assert.equal(result.scanned, 0);
    assert.equal(result.hanyongConfirmed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectOutboxHeaderCounts: outboxDir 미지정 -> 미결선(UNKNOWN 재료, 0 침묵 아님)", () => {
  const result = collectOutboxHeaderCounts({
    outboxDir: null,
    windowStartMs: 0,
    windowEndMs: NOW,
  });
  assert.equal(result.known, false);
  assert.ok(result.reason.includes("미결선"));
});

test("collectOutboxHeaderCounts: 경로 자체 읽기 실패(readdir 실패) -> UNKNOWN(사유)", () => {
  const result = collectOutboxHeaderCounts({
    outboxDir: join(tmpdir(), "nc-pcw-outbox-does-not-exist-xyz"),
    windowStartMs: 0,
    windowEndMs: NOW,
  });
  assert.equal(result.known, false);
  assert.ok(result.reason.includes("보내는함 읽기 실패"));
});

test("collectOutboxHeaderCounts: 개별 파일 stat/읽기 실패는 조용히 0으로 접히지 않고 readFailures로 값이 남는다", () => {
  const root = tmpDir("nc-pcw-outbox-readfail-");
  try {
    fs.writeFileSync(join(root, "ok.md"), "[책임자 경유] 정상\n", "utf8");
    const result = collectOutboxHeaderCounts({
      outboxDir: root,
      windowStartMs: NOW - 24 * HOUR,
      windowEndMs: NOW,
      statFn: () => {
        throw new Error("synthetic stat failure");
      },
    });
    assert.equal(result.known, true);
    assert.equal(result.readFailures, 1);
    assert.equal(result.scanned, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPartialCountOnce: outboxDir을 주면 보조 관측 줄과 수집기 목록 1줄이 보고에 실리고, 1-C 판정 자격·미계수 예시 7개는 무변", async () => {
  const root = tmpDir("nc-pcw-outbox-integration-");
  try {
    const fx = writeFixtures(root);
    const outboxDir = join(root, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    const f1 = join(outboxDir, "x.md");
    fs.writeFileSync(f1, "[책임자 경유 · 한용 확정] 지시\n", "utf8");
    fs.utimesSync(f1, new Date(NOW - HOUR), new Date(NOW - HOUR));
    const f2 = join(outboxDir, "y.md");
    fs.writeFileSync(f2, "[책임자 경유] 통지\n", "utf8");
    fs.utimesSync(f2, new Date(NOW - 2 * HOUR), new Date(NOW - 2 * HOUR));

    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: fx.dispatchReceiptsPath,
      watchLogPath: fx.watchLogPath,
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      outboxDir,
      // HYK-255-p5a-perm-1 -- 권한 확인창 수집기가 실물 홈(.claude/projects)을 읽지 않게 합성 빈 홈을 준다(격리만 · 단언 무변).
      sessionHomeDir: join(root, "no-session-home"),
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    const text = result.reportText;
    // HYK-255-relay-aux-1 (product_scope ② 중복 꼬리 수리) -- 꼬리
    // "독립 계수에 미산입"이 이제 정확히 한 번만 찍힌다(수리 전에는
    // renderOutboxAuxNote 자신도 그 꼬리를 붙여 두 번 찍혔다).
    assert.ok(
      text.includes(
        "- ORCH-writeable 보조 관측: 보내는함 머리줄: 책임자 경유 1건 · 한용 확정 1건 · 분류 불가 0건 — ORCH-writeable — 독립 계수에 미산입",
      ),
    );
    assert.ok(text.includes("보내는함보조수집기 OK(스캔 2건)"));
    assert.ok(
      text.includes(
        "1-C 판정 자격: 없음 — 미계수 범위가 남아 있어 «ㄴ=0» 판정 불가",
      ),
    );
    assert.ok(text.includes("알려진 미계수 예시: 7개(uncounted-examples/v2)"));
    // HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓔ 변이 ⑵ "조건을 항상
    // v1로" 고정하면 이 단언이 RED) -- 결선된 실행에서는 8번 항목
    // («통역 보내는함 문서»)의 전제가 이 라운드로 깨지므로 빠져 있어야
    // 한다.
    assert.ok(
      !text.includes(
        "통역 보내는함 문서(ORCH-writeable -- 보조 칸에서도 제외)",
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPartialCountOnce: outboxDir 미지정이면 기존 기본 auxNote가 그대로 나온다(회귀 0) + 미계수 예시는 v1(8 · 8번 항목 문구 그대로)", async () => {
  const root = tmpDir("nc-pcw-outbox-default-");
  try {
    const fx = writeFixtures(root);
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: fx.dispatchReceiptsPath,
      watchLogPath: fx.watchLogPath,
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    assert.ok(
      result.reportText.includes(
        "- ORCH-writeable 보조 관측: 미계수(이 라운드 결선된 보조 수집기 없음) — 독립 계수에 미산입",
      ),
    );
    assert.ok(!result.reportText.includes("보내는함보조수집기"));
    // HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓐ·ⓔ 변이 ⑴ "조건을 항상
    // v2로" 고정하면 이 단언이 RED) -- 미결선 실행은 8번 항목(«통역
    // 보내는함 문서»)의 전제가 여전히 참이라 v1(8 · 문구 바이트 그대로)
    // 이어야 한다.
    assert.ok(
      result.reportText.includes(
        "알려진 미계수 예시: 8개(uncounted-examples/v1)",
      ),
    );
    assert.ok(
      result.reportText.includes(
        "통역 보내는함 문서(ORCH-writeable -- 보조 칸에서도 제외)",
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-outbox-aux-1-r3 (책임자 판정 2116 §1 ⑵ · REVIEW-r2 P2-1) --
// "결선"을 outboxResult 존재(인자 전달됨)가 아니라 수집기 결과
// known:true로 좁힌다. --outbox-dir을 줬어도 그 경로가 없거나(폴더 부재
// ·경로 오타) readdir 자체가 실패하면, 이 실행은 "미계수 예시 v2(7)"로
// 세지 않는다 -- 8번 항목(«통역 보내는함 문서»)의 전제가 실제로는 깨지지
// 않았기 때문이다(수집기가 한 줄도 못 읽었다). 동시에 그 실패는 조용한
// 0이 아니라 보조 칸 FAIL(사유)로 남는다.
test("runPartialCountOnce: --outbox-dir을 줬지만 폴더가 없으면(경로 오타와 같은 모양) 미계수 예시는 v1(8)로 남고 보조 칸은 FAIL(사유)이다(변이 11 -- 조건을 '인자 전달됨'으로 되돌리면 이 v1 단언이 RED)", async () => {
  const root = tmpDir("nc-pcw-outbox-missing-folder-");
  try {
    const fx = writeFixtures(root);
    const outboxDir = join(root, "no-such-outbox-dir");
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: fx.dispatchReceiptsPath,
      watchLogPath: fx.watchLogPath,
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      outboxDir,
      // HYK-255-p5a-perm-1 -- 실물 홈 격리(합성 빈 홈 · 단언 무변).
      sessionHomeDir: join(root, "no-session-home"),
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    assert.ok(
      result.reportText.includes(
        "알려진 미계수 예시: 8개(uncounted-examples/v1)",
      ),
      "폴더 부재 실행은 v2(7)로 세면 안 된다 -- 수집기가 아무것도 못 읽었다",
    );
    assert.ok(
      result.reportText.includes(
        "통역 보내는함 문서(ORCH-writeable -- 보조 칸에서도 제외)",
      ),
    );
    assert.match(
      result.reportText,
      /보내는함보조수집기 FAIL\(보내는함 읽기 실패: /,
    );
    assert.ok(
      !result.reportText.includes("보내는함보조수집기 OK"),
      "읽기 실패인데 OK로 조용히 접히면 안 된다",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI 진입점: --outbox-dir을 주면 합성 보내는함을 읽어 보조 관측 줄을 낸다", () => {
  const root = tmpDir("nc-pcw-outbox-cli-");
  try {
    const fx = writeFixtures(root, Date.now());
    const outboxDir = join(root, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(join(outboxDir, "z.md"), "[한용 확정] 지시\n", "utf8");
    const stdout = execFileSync(
      process.execPath,
      [
        join(
          process.cwd(),
          "scripts",
          "supervisor",
          "partial-count-report.mjs",
        ),
        "--dispatch-receipts",
        fx.dispatchReceiptsPath,
        "--watch-log",
        fx.watchLogPath,
        "--repo-root",
        join(root, "not-a-git-repo-i-swear"),
        "--max-merge-checks",
        "0",
        "--outbox-dir",
        outboxDir,
      ],
      { encoding: "utf8" },
    );
    assert.ok(
      stdout.includes(
        "보내는함 머리줄: 책임자 경유 0건 · 한용 확정 1건 · 분류 불가 0건",
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-relay-aux-1 -- collectRelayLedger(전달 파일 대조). PM 설계
// §(b)(c), coder-task.md §2 ⓒ ⑴~⑹. 합성 폴더 3개(전달 · 보내는함 ·
// 받는함)를 실제 파일로 써서 프로덕션 함수를 그대로 구동한다.
// ---------------------------------------------------------------------------

function writeRelayLedgerFixtures(root) {
  const relayDir = join(root, "기록");
  const outboxDir = join(root, "보내는함");
  const inboxDir = join(root, "받는함");
  fs.mkdirSync(relayDir, { recursive: true });
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });

  // 전달 파일 1편 -- 유효 항목 2개(#1000 ㄱ-1 · #1010 ㄴ) + 형식 오류 2건
  // (중복 번호 1 · 정규식 밖 머리줄 1) + 본문 속(줄 머리 아닌) 가짜
  // 머리줄 1줄(변이①의 표적 -- `^` 고정이 있으면 항목·오류 어느 쪽으로도
  // 세어지지 않아야 한다).
  const relayText = [
    "## 섹션",
    "",
    "[책임자 경유 · 한용 확정 · #20261101-1000 · 2026-11-01 10:00 KST · 지시 · ㄱ-1]",
    "> 한용: «첫째 테스트 발화입니다»",
    "",
    "[책임자 경유 · 한용 확정 · #20261101-1010 · 2026-11-01 10:1x KST · 지시 · ㄴ]",
    "> 한용: «둘째 테스트 발화 창대조용»",
    "",
    "  (참고) [책임자 경유 · 한용 확정 · #20261101-9999 · 2026-11-01 23:00 KST · 지시 · ㄴ]",
    "",
    "[책임자 경유 · 한용 확정 · #20261101-1010 · 2026-11-01 10:11 KST · 지시 · ㄴ]",
    "> 한용: «중복 번호 세번째»",
    "",
    "[책임자 경유 · 이상한 포맷 틀림]",
    "",
  ].join("\n");
  fs.writeFileSync(join(relayDir, "전달-test.md"), relayText, "utf8");

  // S1(보내는함) 4건.
  fs.writeFileSync(
    join(outboxDir, "2026-11-01-1000-판정.md"),
    "[책임자 경유 · 한용 확정 · 전달 #20261101-1000] 한용 «첫째 테스트 발화입니다 그대로»\n",
    "utf8",
  );
  fs.writeFileSync(
    join(outboxDir, "2026-11-01-1008-메모.md"),
    "[책임자 경유 · 책임자 판정] 한용 «둘째 테스트 발화 창대조용 추가»\n",
    "utf8",
  );
  fs.writeFileSync(
    join(outboxDir, "2026-11-01-1500-기타.md"),
    "[책임자 경유] 한용 «전혀 다른 이야기 매칭안됨»\n",
    "utf8",
  );
  fs.writeFileSync(
    join(outboxDir, "2026-11-01-1600-판정-1600.md"),
    "[책임자 판정] 한용 «상신 짝 테스트용 문구임»\n",
    "utf8",
  );

  // S2(받는함) 3건 -- in1(out2와 같은 분 -> 합침) · in2(인용 없음, ㄱ-7
  // 대조용 "상신" 파일) · in3(형식 시작 전).
  fs.writeFileSync(
    join(inboxDir, "2026-11-01-1008-상임-노트.md"),
    "본문에 한용 «둘째 테스트 발화 창대조용 다른 버전» 적힘\n",
    "utf8",
  );
  fs.writeFileSync(
    join(inboxDir, "2026-11-01-1600-상신-확인.md"),
    "# ORCH 상신 확인\n내용 없음\n",
    "utf8",
  );
  fs.writeFileSync(
    join(inboxDir, "2026-10-01-0900-옛날.md"),
    "본문에 한용 «형식 시작 전 옛 발화입니다» 적힘\n",
    "utf8",
  );

  return { relayDir, outboxDir, inboxDir };
}

test("collectRelayLedger: 번호 일치·시각창 매칭·대응 없음·같은 분 합침·ㄱ-7 기록 누락·형식 이전·형식 오류(중복 번호+정규식 밖 머리줄)·본문 속 인용 제외가 한 실행에서 값으로 갈린다", () => {
  const root = tmpDir("nc-pcw-relay-ledger-");
  try {
    const { relayDir, outboxDir, inboxDir } = writeRelayLedgerFixtures(root);
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    // 같은 분 합침(out2·in1이 같은 분) -- 원 소스 6건 중 1건이 합쳐져
    // 5건만 대조 대상이다.
    assert.equal(result.sourceUtteranceCount, 5);
    assert.equal(result.mergedAwayCount, 1);
    // 대응 있음(번호 일치 out1 · 시각창 out2) = 2.
    assert.equal(result.matchedCount, 2);
    // 대응 없음(ㄴ 후보, out3) = 1 -- out4는 ㄱ-7로 따로 빠진다.
    assert.equal(result.candidateCount, 1);
    assert.equal(result.gate7MissingCount, 1);
    // HYK-255-relay-aux-4(게이트 2 판정 A · 3R NEEDS_INPUT 결정) --
    // 형식 오류 = 중복 번호(#1010 두번째, own 시각 10:11 >= 형식 시작
    // 10:00) 1건뿐이다. 정규식 밖 머리줄("이상한 포맷 틀림")은 줄 안
    // 시각 토큰도 없고 파일 이름("전달-test.md")에도 날짜가 없어
    // "시각 미정"이고, 판정 원문대로 형식 이전 쪽으로 간다(E가 아님) --
    // 그래서 형식 오류는 1건, 형식 이전은 그만큼 늘어 2건이다(아래).
    // 본문 속(들여쓴) 가짜 머리줄은 줄 머리가 아니므로 항목·오류 어느
    // 쪽에도 안 들어간다(변이①의 표적).
    assert.equal(result.formatErrorCount, 1);
    // 형식 이전 = in3(2026-10-01 < 형식 시작 2026-11-01 10:00) 1 +
    // "이상한 포맷 틀림"(시각 미정) 1 = 2.
    assert.equal(result.beforeFormatCount, 2);
    // 시각 미정("이상한 포맷 틀림" 1건) -- 판정 원문 "형식 이전 + 별도
    // 칸"의 그 별도 칸.
    assert.equal(result.undeterminedCount, 1);
    assert.deepEqual(result.classificationTally, {
      "ㄱ-1": 1,
      "ㄱ-2": 0,
      "ㄱ-3": 0,
      "ㄱ-4": 0,
      "ㄱ-5": 0,
      "ㄱ-6": 0,
      "ㄱ-7": 0,
      ㄴ: 1,
    });
    assert.equal(result.scannedRelayFiles, 1);
    assert.deepEqual(result.relayReadFailures, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-2 P1-1(뒤집기, 이 라운드 변이①의 표적) -- 1R
// 결과(.harness/rounds/CODER-r1.md)의 이 시험은 "인용 앞 8글자만
// 일치해도(시각 창 밖이라도) 대응으로 센다"였다(matchedCount 1 ·
// candidateCount 0). 검토 1R(P1-1)이 PM 설계 §(c) "그리고"를 어겼다고
// 판정했다 -- 창 밖 인용 일치는 매칭이 아니라 ㄴ 후보다. 아래가 그
// 뒤집힌 버전(전후 원문은 결과 파일에).
test("collectRelayLedger: 인용 앞 8글자만 일치해도 시각 창 밖이면 대응이 아니라 ㄴ 후보로 센다(P1-1 뒤집기)", () => {
  const root = tmpDir("nc-pcw-relay-quote-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      join(relayDir, "전달-q.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-0900 · 2026-11-01 09:00 KST · 지시 · ㄱ-2]",
        "> 한용: «같은 앞머리 여덞글자 뒤는달라»",
        "",
      ].join("\n"),
      "utf8",
    );
    // 2026-11-10 -- #0900과 9일 넘게 떨어져 시각 창(±15분) 밖이지만
    // 인용 앞 8글자가 완전히 같다.
    fs.writeFileSync(
      join(outboxDir, "2026-11-10-0000-먼시각.md"),
      "[책임자 경유] 한용 «같은 앞머리 여덞글자 완전히 다른 뒷부분»\n",
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    // 뒤집힌 값: 창 밖이라 매칭 0 · ㄴ 후보 1(1R은 matched 1 · candidate 0).
    assert.equal(result.matchedCount, 0);
    assert.equal(result.candidateCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-2 ⓑ⑵ -- 1R 동작 유지 확인: 같은 인용이라도 시각
// 창 "안"이면(여기서는 번호 없이 시각만) 여전히 대응으로 센다(위
// 시험과 짝 -- 창 밖만 ㄴ 후보로 바뀌었을 뿐, 창 안은 회귀 없음).
test("collectRelayLedger: 창 안이면 인용 앞 8글자가 같아도(또는 달라도) 여전히 대응이다(1R 동작 유지)", () => {
  const root = tmpDir("nc-pcw-relay-quote-inwin-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      join(relayDir, "전달-q.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-0900 · 2026-11-01 09:00 KST · 지시 · ㄱ-2]",
        "> 한용: «같은 앞머리 여덞글자 뒤는달라»",
        "",
      ].join("\n"),
      "utf8",
    );
    // 2026-11-01 09:05 -- #0900과 5분 차(±15분 창 안), 인용 앞 8글자도
    // 같다.
    fs.writeFileSync(
      join(outboxDir, "2026-11-01-0905-가까운시각.md"),
      "[책임자 경유] 한용 «같은 앞머리 여덞글자 완전히 다른 뒷부분»\n",
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.candidateCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-2 ⓑ⑶ · P2-3(이 라운드 변이②의 표적) -- 출처에
// `전달 #번호` 토큰이 있는데 그 번호의 전달 항목이 전혀 없으면 "없는
// 번호를 가리킨다" 자체가 신호라 2순위(시각 창)로 넘기지 않고 곧장
// ㄴ 후보로 둔다. 아래 출처는 시각이 전달 항목과 창 안(±15분)인데도
// 번호 토큰이 틀려서 후보여야 한다 -- 2순위로 새면 매칭으로 잘못
// 세어진다.
test("collectRelayLedger: 전달 #번호 토큰이 있는데 짝이 없으면 시각이 창 안이어도 2순위로 안 넘기고 ㄴ 후보다(P2-3)", () => {
  const root = tmpDir("nc-pcw-relay-badnum-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      join(relayDir, "전달-badnum.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-0900 · 2026-11-01 09:00 KST · 지시 · ㄱ-2]",
        "> 한용: «번호 불일치 창안 발화»",
        "",
      ].join("\n"),
      "utf8",
    );
    // 2026-11-01 09:05(전달 #0900과 5분 차, 창 안) -- 그러나 토큰이
    // 가리키는 번호(#20261101-9999)는 전달 파일에 없다.
    fs.writeFileSync(
      join(outboxDir, "2026-11-01-0905-없는번호.md"),
      "[책임자 경유 · 한용 확정 · 전달 #20261101-9999] 한용 «번호 불일치 창안 발화 그대로»\n",
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.equal(result.matchedCount, 0);
    assert.equal(result.candidateCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-2 ⓑ⑷ · P2-4(이 라운드 변이③의 표적) -- ㄱ-7 짝은
// "같은 날짜 + 같은 HHMM"의 상신 파일만 인정한다. 다른 날 같은 HHMM,
// 또는 이름 어딘가에 같은 네 자리가 낀 파일은 짝이 아니다.
test("collectRelayLedger: ㄱ-7 짝은 다른 날 같은 HHMM이나 이름 속 같은 네 자리로는 안 되고, 같은 날 같은 HHMM만 된다(P2-4)", () => {
  const root = tmpDir("nc-pcw-relay-gate7-date-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    // 전달 파일은 비워 둔다(이 시험은 ㄱ-7 분기만 본다 -- 대응 0 ·
    // formatStartMs는 null이라 전부 형식 이전으로 빠지지 않도록 유효
    // 항목 하나를 아주 먼 미래에 둔다. 모든 출처가 그보다 전이면
    // before-format으로 빠져서 ㄱ-7 분기 자체가 평가되지 않으므로,
    // 유효 항목의 시각을 출처들보다 훨씬 이전으로 둔다.
    fs.writeFileSync(
      join(relayDir, "전달-anchor.md"),
      [
        "[책임자 경유 · 한용 확정 · #20200101-0000 · 2020-01-01 00:00 KST · 지시 · ㄱ-1]",
        "> 한용: «형식 시작 고정용 더미»",
        "",
      ].join("\n"),
      "utf8",
    );
    // out1 -- 2026-11-01 "판정-0900"(ㄱ-7 짝 후보 1). 받는함에 "다른
    // 날(11-02) 같은 HHMM 0900 상신" 파일 + "이름 속에 0900이 낀(상신
    // 아닌 접두)" 파일만 있다 -- 둘 다 짝이 아니어야 한다.
    fs.writeFileSync(
      join(outboxDir, "2026-11-01-0900-판정-0900.md"),
      "[책임자 경유] 한용 «짝 없는 ㄱ-7 발화 하나»\n",
      "utf8",
    );
    fs.writeFileSync(
      join(inboxDir, "2026-11-02-0900-상신-확인.md"),
      "다른 날 같은 HHMM -- 짝이면 안 된다\n",
      "utf8",
    );
    fs.writeFileSync(
      join(inboxDir, "2026-11-03-0901-그냥-0900든파일.md"),
      "이름 속에 우연히 0900이 낀 상신 파일 -- 짝이면 안 된다\n",
      "utf8",
    );
    const resultNoMatch = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(resultNoMatch.known, true);
    assert.equal(resultNoMatch.gate7MissingCount, 0);
    assert.equal(resultNoMatch.candidateCount, 1);

    // 같은 날(2026-11-01) 같은 HHMM(0900) 상신 파일을 추가하면 그제서야
    // 짝이다.
    fs.writeFileSync(
      join(inboxDir, "2026-11-01-0900-상신-확인.md"),
      "같은 날 같은 HHMM -- 짝이어야 한다\n",
      "utf8",
    );
    const resultMatch = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(resultMatch.known, true);
    assert.equal(resultMatch.gate7MissingCount, 1);
    assert.equal(resultMatch.candidateCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-4(게이트 2 판정 A, 2R 시험 2단계 뒤집기 -- 옛
// 2단계 `assert.equal(afterStart.formatErrorCount, 2)`는 "형식 시작
// 시각이 있으면 전부 E"(2R 전역 판정)를 고정했다는 검토 2R P1-1(2R)
// 지적대로다. 게이트 2 판정 A(줄 단위 시각 결정)대로면, 옛 두 줄은
// own 시각이 "시각 미정"(토큰도 파일 이름 날짜도 없음)이라 형식 시작
// 뒤에도 여전히 형식 이전이다 -- E가 되는 것은 "형식 시작 뒤에 새로
// 생긴" 정규식 밖 줄뿐이다(PM 설계 §(b) "소급 0"). 전후 원문은 바로
// 위 diff(이 메시지가 새로 쓴 코드 블록) 그대로 보존한다.
test("collectRelayLedger: 형식 시작 전 정규식 밖 줄은 형식 시작 뒤에도 여전히 형식 이전이고(소급 0), E가 되는 건 형식 시작 뒤 새로 생긴 정규식 밖 줄뿐이다(P2-2 뒤집기)", () => {
  const root = tmpDir("nc-pcw-relay-preformat-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });

    // 유효 머리줄이 0개인 전달 파일 -- 옛 형식(검토자 묶음 E 모양) 2편.
    // 파일 이름에 날짜가 없고 줄 안에도 시각 토큰이 없다 -- 게이트 2
    // 판정 A 기준 "시각 미정"(3단계 fallback 둘 다 실패).
    fs.writeFileSync(
      join(relayDir, "전달-old.md"),
      [
        "[책임자 경유 · 한용 확정] 옛 형식 줄 1",
        "[책임자 경유 · B-9] 옛 형식 줄 2",
        "",
      ].join("\n"),
      "utf8",
    );
    const beforeStart = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(beforeStart.known, true);
    assert.equal(beforeStart.formatErrorCount, 0);
    assert.equal(beforeStart.beforeFormatCount, 2);
    assert.equal(beforeStart.undeterminedCount, 2);

    // 유효 머리줄 1개(형식 시작 2026-11-01 09:00)를 더한다 -- 같은 두
    // 옛 줄(전달-old.md)은 여전히 시각 미정이라 형식 이전 그대로다
    // (뒤집힌 단언: 2R 판은 여기서 E 2를 단언했었다). 새로 "형식 시작
    // 뒤" 줄 안 시각 토큰을 가진 정규식 밖 줄 1개를 같은 파일에 더
    // 쓴다(09:30 > 09:00) -- 이 줄만 E다.
    fs.writeFileSync(
      join(relayDir, "전달-new.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-0900 · 2026-11-01 09:00 KST · 지시 · ㄱ-2]",
        "> 한용: «형식 시작됨»",
        "",
        "[책임자 경유 · 형식 깨짐] 2026-11-01 09:30 메모",
        "",
      ].join("\n"),
      "utf8",
    );
    const afterStart = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(afterStart.known, true);
    // 옛 두 줄 = 형식 이전 유지(소급 0 -- 뒤집힌 값).
    assert.equal(afterStart.beforeFormatCount, 2);
    assert.equal(afterStart.undeterminedCount, 2);
    // 형식 시작 뒤 새로 생긴 정규식 밖 줄 1개만 E.
    assert.equal(afterStart.formatErrorCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// HYK-255-relay-aux-2 ⓑ⑹ · P2-1(이 라운드 변이⑤의 표적) -- 전달 파일
// 1개가 EISDIR(폴더를 파일처럼 읥으려다 실패)이면 readFailures에
// 흔적이 남고, 보조 관측 줄에 "읽기 실패 N건"이 찍히며 "대응
// 없음(ㄴ 후보)"은 확정 문구가 아니게 괄호가 붙는다(검토자 묶음 C
// 모양 재현).
test("collectRelayLedger: 전달 파일 1개가 EISDIR이면 relayReadFailures에 남고, 보조 관측 줄이 읍기 실패 건수와 ㄴ 후보 불확실 표기를 낸다(P2-1)", () => {
  const root = tmpDir("nc-pcw-relay-eisdir-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      join(relayDir, "전달-ok.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-0900 · 2026-11-01 09:00 KST · 지시 · ㄱ-2]",
        "> 한용: «정상 파일»",
        "",
      ].join("\n"),
      "utf8",
    );
    // "전달-잠김.md"를 폴더로 만들면 readFileSync가 EISDIR을 던진다.
    fs.mkdirSync(join(relayDir, "전달-잠김.md"));
    fs.writeFileSync(
      join(outboxDir, "2026-11-05-0000-무관.md"),
      "[책임자 경유] 한용 «전달 기록과 무관한 발화»\n",
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.deepEqual(result.relayReadFailures, ["전달-잠김.md"]);
    const lines = renderRelayLedgerAuxLines(result);
    assert.ok(lines[0].includes("읽기 실패 1건"));
    assert.ok(
      lines[0].includes("대응 없음(ㄴ 후보) 1건(전달 파일 읽기 실패로 불확실)"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectRelayLedger: 전달 폴더 자체가 없으면 0이 아니라 known:false(UNKNOWN)다(변이③의 표적)", () => {
  const root = tmpDir("nc-pcw-relay-missing-");
  try {
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    const result = collectRelayLedger({
      relayGlob: join(root, "없는폴더", "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, false);
    assert.ok(result.reason.includes("전달 폴더 읽기 실패"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectRelayLedger: 전달 폴더는 있는데 패턴에 걸리는 파일이 0개면 known:true · 0건(폴더 없음과 다른 사실)", () => {
  const root = tmpDir("nc-pcw-relay-empty-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.equal(result.sourceUtteranceCount, 0);
    assert.equal(result.beforeFormatCount, 0);
    assert.equal(result.candidateCount, 0);
    assert.equal(result.scannedRelayFiles, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collectRelayLedger: outboxDir·inboxDir 중 하나라도 미지정이면 known:false(미결선)다", () => {
  const root = tmpDir("nc-pcw-relay-unwired-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    const withoutInbox = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir: null,
    });
    assert.equal(withoutInbox.known, false);
    assert.ok(withoutInbox.reason.includes("받는함"));
    const withoutOutbox = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir: null,
      inboxDir: join(root, "받는함-미존재"),
    });
    assert.equal(withoutOutbox.known, false);
    assert.ok(withoutOutbox.reason.includes("보내는함"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI 진입점: --relay-glob --inbox-dir을 주면 ㄴ 절에 전달 파일 대조 두 줄이 그대로 찍힌다(ⓒ⑴)", () => {
  const root = tmpDir("nc-pcw-relay-cli-");
  try {
    const fx = writeFixtures(root, Date.now());
    const { relayDir, outboxDir, inboxDir } = writeRelayLedgerFixtures(root);
    const stdout = execFileSync(
      process.execPath,
      [
        join(
          process.cwd(),
          "scripts",
          "supervisor",
          "partial-count-report.mjs",
        ),
        "--dispatch-receipts",
        fx.dispatchReceiptsPath,
        "--watch-log",
        fx.watchLogPath,
        "--repo-root",
        join(root, "not-a-git-repo-i-swear"),
        "--max-merge-checks",
        "0",
        "--outbox-dir",
        outboxDir,
        "--relay-glob",
        join(relayDir, "전달-*.md"),
        "--inbox-dir",
        inboxDir,
      ],
      { encoding: "utf8" },
    );
    // HYK-255-relay-aux-4(게이트 2 판정 A) -- 같은 fixture
    // (writeRelayLedgerFixtures)의 "이상한 포맷 틀림" 줄이 시각 미정
    // 판정으로 형식 이전 쪽으로 가면서(위 collectRelayLedger 단위
    // 시험과 같은 근거) 형식 오류 2→1 · 형식 이전 1→2로 바뀌고, 새
    // "시각 미정 1건" 사유가 덧붙는다(판정의 직접 귀결 · 3R NEEDS_INPUT
    // 결정으로 이 값 변경이 승인됐다).
    assert.ok(
      stdout.includes(
        "- ORCH-writeable 보조 관측(전달 파일 대조): 출처 한용 발화 5건 · " +
          "전달 항목 대응 2건 · 대응 없음(ㄴ 후보) 1건 · 형식 오류 1건 · " +
          "ㄱ-7 기록 누락 1건 · 형식 이전 구간 미계수 2건 · 시각 미정 1건 — 독립 계수에 미산입",
      ),
    );
    assert.ok(stdout.includes("- 전달 항목 분류: ㄱ-1 1 ·"));
    // v3 선택(결선 + known:true) -- 미계수 예시 7개, 1번 문구가 좁혀진
    // v3 모양이다(변이⑤의 표적 -- known:false였다면 v2로 남아야 한다).
    assert.ok(stdout.includes("7개(uncounted-examples/v3)"));
    assert.ok(
      stdout.includes("전달 파일·대조 출처(S1·S2) 어디에도 없는 채팅 지시"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runPartialCountOnce: relayGlob이 known:false(폴더 없음)면 미계수 예시는 v3이 아니라 v2/v1으로 남는다(변이⑤의 표적)", async () => {
  const root = tmpDir("nc-pcw-relay-v3-guard-");
  try {
    const fx = writeFixtures(root);
    const outboxDir = join(root, "outbox");
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(join(outboxDir, "z.md"), "[한용 확정] 지시\n", "utf8");
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: fx.dispatchReceiptsPath,
      watchLogPath: fx.watchLogPath,
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      outboxDir,
      // HYK-255-p5a-perm-1 -- 실물 홈 격리(합성 빈 홈 · 단언 무변).
      sessionHomeDir: join(root, "no-session-home"),
      relayGlob: join(root, "없는-전달-폴더", "전달-*.md"),
      inboxDir: join(root, "받는함-없음"),
      git: { run: () => ({ code: 0, stdout: "", stderr: "" }) },
      gitWorktreeListExecFn: () => fx.worktreeListPorcelain,
    });
    assert.equal(result.relayResult.known, false);
    assert.ok(result.reportText.includes("7개(uncounted-examples/v2)"));
    assert.ok(!result.reportText.includes("uncounted-examples/v3"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HYK-255-g-aux-render-1 커밋 2 (D3 ⑵) -- ㄱ-4 UNDECIDABLE 사유 분포. 사유는
// 기존 판정 결과(verdict.evidence.reason)에서 그대로 전달하고 새 REST 호출은
// 없다. 가짜 git · 가짜 fetchJson 은 수집기의 실제 코드(createGitHubApprovalPort
// -> isHumanApproved)를 통과시킨다 -- 후보 3개: 첫 후보는 git remote 를 못 읽어
// REPO_IDENTITY_MISMATCH, 나머지 둘은 remote 는 읽히지만 fetch 가 500 이라
// HTTP_FAILED.
// ---------------------------------------------------------------------------

function undecidableGitPort(nowMs) {
  let remoteCalls = 0;
  const logOut =
    [1, 2, 3]
      .map(
        (i) =>
          `${String(i).repeat(40)} ${new Date(nowMs - i * HOUR).toISOString()}`,
      )
      .join("\n") + "\n";
  return {
    run(args) {
      if (args[0] === "log") return { code: 0, stdout: logOut, stderr: "" };
      if (args[0] === "remote") {
        remoteCalls += 1;
        if (remoteCalls === 1) {
          return { code: 1, stdout: "", stderr: "no remote" };
        }
        return {
          code: 0,
          stdout: `https://github.com/${REPO}.git\n`,
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected git call" };
    },
  };
}

test("D3 ⑵ collectGate4Independent: UNDECIDABLE 판정의 사유(evidence.reason)가 분포로 전달된다 · 새 REST 호출 0", async () => {
  let fetchCalls = 0;
  const gate4 = await collectGate4Independent({
    fetchJson: async () => {
      fetchCalls += 1;
      return { ok: false, status: 500 };
    },
    git: undecidableGitPort(NOW),
    allowlistPath: "scripts/supervisor/approver-allowlist.json",
    windowStartMs: NOW - DAY,
    windowEndMs: NOW,
    maxMergeChecks: 3,
  });
  assert.equal(gate4.known, true);
  assert.equal(gate4.undecidable, 3);
  assert.deepEqual(gate4.undecidableReasons, {
    REPO_IDENTITY_MISMATCH: 1,
    HTTP_FAILED: 2,
  });
  // 사유 전달은 이미 한 판정에서 읽을 뿐이다 -- fetch 는 판정이 하던 만큼(후보 둘
  // 각 1회)만 불렸다.
  assert.equal(fetchCalls, 2);
});

test("D3 ⑵ collectGate4Independent: UNDECIDABLE 이 없으면 사유 분포는 빈 객체다", async () => {
  const gate4 = await collectGate4Independent({
    fetchJson: async () => ({ ok: false, status: 500 }),
    git: undecidableGitPort(NOW),
    allowlistPath: "scripts/supervisor/approver-allowlist.json",
    windowStartMs: NOW - DAY,
    windowEndMs: NOW,
    maxMergeChecks: 0,
  });
  assert.equal(gate4.undecidable, 0);
  assert.deepEqual(gate4.undecidableReasons, {});
});

test("D3 ⑵ runPartialCountOnce: 보고서 ㄱ-4 줄에 «UNDECIDABLE 3(사유: HTTP_FAILED 2 · REPO_IDENTITY_MISMATCH 1)» 이 찍힌다", async () => {
  const root = tmpDir("nc-pcw-undecidable-");
  try {
    const result = await runPartialCountOnce({
      now: NOW,
      repoRoot: root,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "none.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 3,
      maxExternalEvidenceChecks: 0,
      fetchJson: async () => ({ ok: false, status: 500 }),
      git: undecidableGitPort(NOW),
      gitWorktreeListExecFn: () => "",
    });
    assert.ok(
      result.reportText.includes(
        "UNDECIDABLE 3(사유: HTTP_FAILED 2 · REPO_IDENTITY_MISMATCH 1)",
      ),
      result.reportText,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
