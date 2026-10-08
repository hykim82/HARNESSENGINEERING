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
  DEFAULT_MAX_MERGE_CHECKS,
  DEFAULT_EXTRA_REPO_ROOTS,
  DEFAULT_ARCHIVE_ROOT,
} from "./partial-count-report.mjs";
import { runReachOnce } from "./reach-report.mjs";
import { formatKst } from "./partial-count-core.mjs";

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
    // 독립 ㄴ 수집기 부재가 관측 건강에 표면화된다.
    assert.ok(text.includes("독립ㄴ수집기 FAIL(부재 — 이 라운드 결선 없음"));
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
    assert.equal(DEFAULT_MAX_MERGE_CHECKS, 3);
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
