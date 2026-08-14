// HYK-255-partial-counter-1 (coder-task.md) -- «부분 계수 보고기» wire +
// 사람 한 줄 실행(1-B 요건 1이 요구하는 그 한 줄이 바로 이 파일):
//
//   node scripts/supervisor/partial-count-report.mjs
//
// 인자 없이 치면 관제실 배달 영수증·watch.log를 «읽기만» 하고, GitHub
// REST(무인증)를 조회해, PM 판정 3 «표기 규격» 그대로의 부분 계수 보고를
// 화면에 찍는다. ⛔기본 실행은 아무 파일도 쓰지 않는다 -- 관제실에 보고
// 파일을 남기려면 `--report-out <경로>`를 명시한다(아침 보고 편입은
// reach-report.mjs가 morning-report.md 옆의 partial-count-report.md를
// 읽는 방식 -- 그 파일 생성 여부는 운영자의 명시 선택이다).
//
// ★새 감지기 0 -- 이 파일이 «수집»하는 것은 전부 기존 관측기의 산출물이다:
// - 배달 분모 = 관제실 dispatch-receipts.jsonl(어댑터 B가 이미 쌓는 것)
// - 소비 분모 = 각 워크트리 .harness/receipts/*.json(HYK-244 소비 완료
//   영수증, relay-handshake.mjs -> consumption-receipt-writer.mjs가 쌓는 것)
// - 무진행-재개 의심 구간 = watch.log(watch-run.mjs가 이미 쌓는 것)를
//   reach-report-core.mjs의 parseWatchLog/AXES로 그대로 읽은 verdict
// - ㄱ-4 독립 확인 = approval-authority-adapter.mjs(무인증 GitHub 수집기,
//   헤더상 live=false였던 것)를 이 wire가 **실제로 호출**한다 --
//   createGitHubApprovalPort(...)로 포트를 만들고 각 병합 후보 sha에
//   isHumanApproved(sha)를 부른다(아래 collectGate4Independent). 이
//   결선이 «만들었지만 안 부른다» 상태를 닫는 이 라운드의 핵심이다.
//
// ⛔정직 한계(이 wire 자신의):
// - GitHub 조회는 호출 예산(sha당 REST 8회 · 무인증 60회/시간)에 갇힌다.
//   후보가 예산보다 많으면 나머지는 «미조회(예산)»로 표기된다 -- 0으로
//   접지 않는다.
// - origin/master가 GitHub 최신과 다르면(fetch 전) 수집기 계약대로
//   ALLOWLIST_REF_MISMATCH = UNDECIDABLE이 된다. 이 wire는 스스로 git
//   fetch하지 않는다(저장소 상태를 바꾸지 않는 읽기 전용 계약).
// - 소비 영수증은 워크트리와 함께 사라진다(관제실 리서치 §1 실측) --
//   지워진 워크트리의 라운드는 소비 분모에서 «영수증 결손»으로만 남는다.
import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  createGitHubApprovalPort,
  createAnonymousFetchJson,
  APPROVAL_STATUS,
} from "./approval-authority-adapter.mjs";
import { parseWatchLog } from "./reach-report-core.mjs";
import { DEFAULT_WATCH_LOG_PATH } from "./reach-report.mjs";
import {
  buildPartialCountReport,
  computeSuspectedStallResumeIntervals,
  computeCoverageGaps,
  parseKstTimestampMs,
} from "./partial-count-core.mjs";

export const DEFAULT_DISPATCH_RECEIPTS_PATH =
  "D:/문서관리/하네스-관제실/dispatch-receipts.jsonl";
export const DEFAULT_WINDOW_HOURS = 24;
// sha당 REST 최대 8회(수집기 예산) x 3 = 24회 < 무인증 한도 60회/시간.
export const DEFAULT_MAX_MERGE_CHECKS = 3;
export const DEFAULT_ALLOWLIST_PATH =
  "scripts/supervisor/approver-allowlist.json";

// git 포트 -- approval-authority-adapter.mjs의 {run(args)} 계약({code,
// stdout, stderr}, throw 0)을 실제 git 실행으로 구현한다.
export function createProcessGitPort(cwd, execFn = execFileSync) {
  return {
    run(args) {
      try {
        const stdout = execFn("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (err) {
        return {
          code: typeof err.status === "number" ? err.status : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ? String(err.stderr) : String(err.message ?? err),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 수집 1 -- 배달 분모: dispatch-receipts.jsonl(기계 산출물)에서 측정 창 내
// 배달 레코드 수 + 라벨. 읽기·파싱 실패는 UNKNOWN(비타협 2)이다.
// ---------------------------------------------------------------------------

export function collectDeliveredRounds({
  dispatchReceiptsPath,
  windowStartMs,
  windowEndMs,
  readFn = readFileSync,
}) {
  let text;
  try {
    text = readFn(dispatchReceiptsPath, "utf8");
  } catch (err) {
    return {
      delivered: { known: false, reason: "dispatch-receipts 읽기 실패" },
      labels: null,
      parseFailures: 0,
      collectorDetail: err.message,
    };
  }
  let count = 0;
  let parseFailures = 0;
  const labels = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      parseFailures += 1;
      continue;
    }
    const tsMs = Date.parse(row.recorded_at ?? "");
    if (Number.isNaN(tsMs)) {
      parseFailures += 1;
      continue;
    }
    if (tsMs >= windowStartMs && tsMs <= windowEndMs) {
      count += 1;
      if (typeof row.harness_task_label === "string") {
        labels.add(row.harness_task_label);
      }
    }
  }
  return {
    delivered: { known: true, count },
    labels,
    parseFailures,
    collectorDetail: null,
  };
}

// ---------------------------------------------------------------------------
// 수집 2 -- 소비 분모: 등록된 모든 워크트리의 .harness/receipts/*.json
// (HYK-244 소비 완료 영수증). 워크트리 열거 실패 = UNKNOWN. 영수증 시각은
// binding.doneAt(라운드 자신의 DONE 줄 시각)으로 창 판정한다.
// ---------------------------------------------------------------------------

function readReceiptsInDir({ dir, readFn, readdirFn, sink }) {
  let names;
  try {
    names = readdirFn(dir);
  } catch {
    sink.dirFailures += 1;
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const receipt = JSON.parse(readFn(path.join(dir, name), "utf8"));
      const doneAtMs = parseKstTimestampMs(receipt?.binding?.doneAt);
      if (doneAtMs === null) {
        sink.parseFailures += 1;
        continue;
      }
      sink.records.push({
        doneAtMs,
        taskId: receipt?.binding?.taskId ?? null,
      });
    } catch {
      sink.parseFailures += 1;
    }
  }
}

// 워크트리 열거 -- orch-stall-detect.mjs의 collectGitWorktrees와 같은
// `git worktree list --porcelain` 파싱이지만 그 모듈을 import하지 않고
// 여기 두는 이유: orch-stall-detect.test.mjs의 정적 가드가 «프로덕션
// 코드는 orch-stall-detect.mjs를 import하지 않는다»(can be called != is
// being called)라는 정직 주장을 시험으로 고정하고 있다 -- 유틸 하나를
// 얻자고 그 주장을 이 라운드가 조용히 바꾸지 않는다. 스캔 범위 선언도
// 그 함수와 동일하다: git이 아는 등록된 워크트리 전부(메인 포함)뿐이다.
function listGitWorktrees(repoRoot, gitWorktreeListExecFn) {
  const exec =
    typeof gitWorktreeListExecFn === "function"
      ? gitWorktreeListExecFn
      : (root) =>
          execFileSync("git", ["worktree", "list", "--porcelain"], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
  try {
    const paths = [];
    for (const line of String(exec(repoRoot)).split(/\r?\n/)) {
      const m = line.match(/^worktree\s+(.+)$/);
      if (m) paths.push(m[1].trim());
    }
    return { ok: true, worktrees: paths };
  } catch (err) {
    return {
      ok: false,
      detail: err && err.message ? err.message : String(err),
    };
  }
}

export function collectConsumedRounds({
  repoRoot,
  windowStartMs,
  windowEndMs,
  readFn = readFileSync,
  readdirFn = readdirSync,
  existsFn = existsSync,
  gitWorktreeListExecFn,
}) {
  const wl = listGitWorktrees(repoRoot, gitWorktreeListExecFn);
  if (!wl.ok) {
    return {
      consumed: { known: false, reason: "워크트리 열거 실패" },
      labels: null,
      parseFailures: 0,
      scannedWorktrees: 0,
      collectorDetail: wl.detail ?? wl.reason,
    };
  }
  const sink = { records: [], parseFailures: 0, dirFailures: 0 };
  let scanned = 0;
  for (const wt of wl.worktrees) {
    const dir = path.join(wt, ".harness", "receipts");
    if (!existsFn(dir)) continue;
    scanned += 1;
    readReceiptsInDir({ dir, readFn, readdirFn, sink });
  }
  const labels = new Set();
  let count = 0;
  for (const r of sink.records) {
    if (r.doneAtMs >= windowStartMs && r.doneAtMs <= windowEndMs) {
      count += 1;
      if (typeof r.taskId === "string") labels.add(r.taskId);
    }
  }
  return {
    consumed: { known: true, count },
    labels,
    parseFailures: sink.parseFailures + sink.dirFailures,
    scannedWorktrees: scanned,
    collectorDetail: null,
  };
}

// ---------------------------------------------------------------------------
// 수집 3 -- ㄱ-4 독립 확인: origin/master의 측정 창 내 병합 커밋 후보를
// 뽑아, approval-authority-adapter.mjs의 isHumanApproved(sha)를 «실제로
// 호출»한다. APPROVED만 독립 확인 사건으로 센다(승인 리뷰가 commit·PR·
// 병합에 결속돼 있으므로 사건 결속이 수집기 안에서 이미 성립한다 --
// 비타협 4의 «레코드/사건 분리»는 이 경로에선 수집기가 해 준다).
// ---------------------------------------------------------------------------

export function collectMergeCandidates({ git, windowStartMs, windowEndMs }) {
  const result = git.run([
    "log",
    "--first-parent",
    "--merges",
    "--format=%H %cI",
    "-n",
    "200",
    "origin/master",
  ]);
  if (result.code !== 0) {
    return { ok: false, detail: result.stderr || "git log failed" };
  }
  const candidates = [];
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{40}) (\S+)$/);
    if (!m) continue;
    const tsMs = Date.parse(m[2]);
    if (Number.isNaN(tsMs)) continue;
    if (tsMs >= windowStartMs && tsMs <= windowEndMs) {
      candidates.push({ sha: m[1], tsMs });
    }
  }
  return { ok: true, candidates };
}

export async function collectGate4Independent({
  fetchJson,
  git,
  allowlistPath,
  windowStartMs,
  windowEndMs,
  maxMergeChecks,
}) {
  const cand = collectMergeCandidates({ git, windowStartMs, windowEndMs });
  if (!cand.ok) {
    return { known: false, reason: `병합 후보 조회 실패: ${cand.detail}` };
  }
  // ★수집기 라이브 결선 지점: 헤더상 live=false였던
  // approval-authority-adapter.mjs를 여기서 실제로 부른다.
  const port = createGitHubApprovalPort({ fetchJson, git, allowlistPath });
  const toCheck = cand.candidates.slice(0, Math.max(0, maxMergeChecks));
  let approved = 0;
  let notApproved = 0;
  let undecidable = 0;
  const approvedEvents = [];
  const verdicts = [];
  for (const c of toCheck) {
    const verdict = await port.isHumanApproved(c.sha);
    verdicts.push({ sha: c.sha, ...verdict });
    if (verdict.status === APPROVAL_STATUS.APPROVED) {
      approved += 1;
      approvedEvents.push({
        sha: c.sha,
        pullNumber: verdict.evidence?.pull_number ?? "?",
        reviewerLogin: verdict.evidence?.reviewer_login ?? "?",
      });
    } else if (verdict.status === APPROVAL_STATUS.NOT_APPROVED) {
      notApproved += 1;
    } else {
      undecidable += 1;
    }
  }
  return {
    known: true,
    candidatesInWindow: cand.candidates.length,
    checked: toCheck.length,
    approved,
    notApproved,
    undecidable,
    uncheckedByBudget: cand.candidates.length - toCheck.length,
    approvedEvents,
    verdicts,
  };
}

// ---------------------------------------------------------------------------
// 조립 -- 한 번의 실행.
// ---------------------------------------------------------------------------

function deriveMissingReceipts(deliveredResult, consumedResult) {
  if (
    deliveredResult.delivered.known !== true ||
    consumedResult.consumed.known !== true
  ) {
    return { known: false, reason: "배달 또는 소비가 UNKNOWN" };
  }
  let missing = 0;
  for (const label of deliveredResult.labels) {
    if (!consumedResult.labels.has(label)) missing += 1;
  }
  return { known: true, count: missing };
}

function buildCollectors({
  deliveredResult,
  consumedResult,
  watchOk,
  watchSkipped,
  gate4,
}) {
  const collectors = [];
  collectors.push({
    name: "배달영수증(dispatch-receipts.jsonl)",
    ok: deliveredResult.delivered.known === true,
    detail:
      deliveredResult.collectorDetail ??
      (deliveredResult.parseFailures > 0
        ? `파싱 실패 ${deliveredResult.parseFailures}줄`
        : undefined),
  });
  collectors.push({
    name: `소비영수증(워크트리 ${consumedResult.scannedWorktrees ?? 0}곳 스캔)`,
    ok: consumedResult.consumed.known === true,
    detail:
      consumedResult.collectorDetail ??
      (consumedResult.parseFailures > 0
        ? `파싱 실패 ${consumedResult.parseFailures}건`
        : undefined),
  });
  collectors.push({
    name: `watch.log${watchSkipped > 0 ? `(파싱 스킵 ${watchSkipped}줄)` : ""}`,
    ok: watchOk,
  });
  collectors.push({
    name:
      gate4.known === true
        ? `GitHub승인수집기(조회 ${gate4.checked}건)`
        : "GitHub승인수집기",
    ok: gate4.known === true,
    detail: gate4.known === true ? undefined : gate4.reason,
  });
  // 독립 ㄴ 수집기는 이 라운드에 존재하지 않는다 -- 그 부재 자체를 수집
  // 실패로 표면화한다(조용한 «확인 0건»이 «수집기가 돌았는데 0»으로
  // 오독되는 것을 막는 줄).
  collectors.push({
    name: "독립ㄴ수집기",
    ok: false,
    detail: "부재 — 이 라운드 결선 없음(ㄴ 확인은 원리적으로 불가)",
  });
  return collectors;
}

// watch.log 관측 묶음 -- 읽기 실패는 suspected/coverageGaps를 UNKNOWN
// 재료({known:false})로 만든다(0으로 접지 않는다).
function collectWatchObservations({
  watchLogPath,
  readFn,
  windowStartMs,
  windowEndMs,
}) {
  let watchOk = true;
  let watchText = "";
  try {
    watchText = readFn(watchLogPath, "utf8");
  } catch {
    watchOk = false;
  }
  const { entries, skipped } = parseWatchLog(watchText);
  const stall = computeSuspectedStallResumeIntervals({
    entries,
    windowStartMs,
    windowEndMs,
  });
  const gapsRaw = computeCoverageGaps({ entries, windowStartMs, windowEndMs });
  return {
    watchOk,
    skipped,
    suspected: watchOk
      ? {
          known: true,
          closedCount: stall.closed.length,
          openCount: stall.open.length,
        }
      : { known: false, reason: "watch.log 읽기 실패" },
    coverageGaps: watchOk
      ? { known: true, count: gapsRaw.gaps.length, totalMs: gapsRaw.totalMs }
      : { known: false, reason: "watch.log 읽기 실패" },
    lastAliveMs: entries.length > 0 ? entries[entries.length - 1].tsMs : null,
  };
}

// 옵션 기본값 해석 -- 값 계열(시각·창·경로)과 포트 계열(HTTP·git·fs)을
// 나눈 것은 eslint complexity 예산 때문이다(기본값 하나가 분기 하나로
// 계수된다). 기본 포트 = 실물(무인증 fetch·실 git·실 fs) -- 시험은 이
// 자리에 가짜를 주입하되, 판정 로직은 항상 실제 수집기를 통과한다.
function resolveValueOptions(options) {
  return {
    now: options.now ?? Date.now(),
    windowHours: options.windowHours ?? DEFAULT_WINDOW_HOURS,
    maxMergeChecks: options.maxMergeChecks ?? DEFAULT_MAX_MERGE_CHECKS,
    repoRoot: options.repoRoot ?? process.cwd(),
    dispatchReceiptsPath:
      options.dispatchReceiptsPath ?? DEFAULT_DISPATCH_RECEIPTS_PATH,
    watchLogPath: options.watchLogPath ?? DEFAULT_WATCH_LOG_PATH,
    allowlistPath: options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH,
  };
}

function resolvePortOptions(options, repoRoot) {
  return {
    fetchJson: options.fetchJson ?? createAnonymousFetchJson().fetchJson,
    git: options.git ?? createProcessGitPort(repoRoot),
    readFn: options.readFn ?? readFileSync,
    readdirFn: options.readdirFn ?? readdirSync,
    existsFn: options.existsFn ?? existsSync,
    gitWorktreeListExecFn: options.gitWorktreeListExecFn,
  };
}

export async function runPartialCountOnce(options = {}) {
  const {
    now,
    windowHours,
    maxMergeChecks,
    repoRoot,
    dispatchReceiptsPath,
    watchLogPath,
    allowlistPath,
  } = resolveValueOptions(options);
  const { fetchJson, git, readFn, readdirFn, existsFn, gitWorktreeListExecFn } =
    resolvePortOptions(options, repoRoot);
  const windowEndMs = now;
  const windowStartMs = now - windowHours * 60 * 60 * 1000;

  const deliveredResult = collectDeliveredRounds({
    dispatchReceiptsPath,
    windowStartMs,
    windowEndMs,
    readFn,
  });
  const consumedResult = collectConsumedRounds({
    repoRoot,
    windowStartMs,
    windowEndMs,
    readFn,
    readdirFn,
    existsFn,
    gitWorktreeListExecFn,
  });
  const watch = collectWatchObservations({
    watchLogPath,
    readFn,
    windowStartMs,
    windowEndMs,
  });

  const gate4 = await collectGate4Independent({
    fetchJson,
    git,
    allowlistPath,
    windowStartMs,
    windowEndMs,
    maxMergeChecks,
  });

  const reportText = buildPartialCountReport({
    generatedAtMs: now,
    windowStartMs,
    windowEndMs,
    delivered: deliveredResult.delivered,
    consumed: consumedResult.consumed,
    missingReceipts: deriveMissingReceipts(deliveredResult, consumedResult),
    gate4,
    // ⛔독립 ㄴ 수집기가 없는 이 라운드에 이 배열을 채우는 생산 경로는
    // 존재하지 않는다 -- 항상 [](= «확인 0건» 렌더링). 채우려면 독립적인
    // ㄴ 양성 신호원이 먼저 있어야 한다(PM 권고 «열어 둔다» 그대로).
    confirmedLnEvents: [],
    suspected: watch.suspected,
    collectors: buildCollectors({
      deliveredResult,
      consumedResult,
      watchOk: watch.watchOk,
      watchSkipped: watch.skipped,
      gate4,
    }),
    lastAliveMs: watch.lastAliveMs,
    coverageGaps: watch.coverageGaps,
  });

  return {
    reportText,
    gate4,
    suspected: watch.suspected,
    coverageGaps: watch.coverageGaps,
  };
}

// ---------------------------------------------------------------------------
// CLI -- 사람 한 줄 실행. 기본은 stdout만(쓰기 0). --report-out을 주면
// 그 경로에도 같은 텍스트를 쓴다(아침 보고 편입용 정본 위치 =
// 관제실 watch/partial-count-report.md -- reach-report.mjs가 읽는 곳).
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report-out") opts.reportOut = argv[++i];
    else if (argv[i] === "--window-hours") opts.windowHours = Number(argv[++i]);
    else if (argv[i] === "--max-merge-checks")
      opts.maxMergeChecks = Number(argv[++i]);
    else if (argv[i] === "--dispatch-receipts")
      opts.dispatchReceiptsPath = argv[++i];
    else if (argv[i] === "--watch-log") opts.watchLogPath = argv[++i];
    else if (argv[i] === "--repo-root") opts.repoRoot = argv[++i];
  }
  return opts;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/partial-count-report.mjs");
if (invokedDirectly) {
  const opts = parseCliArgs(process.argv.slice(2));
  runPartialCountOnce(opts)
    .then((result) => {
      console.log(result.reportText);
      if (opts.reportOut) {
        const dir = path.dirname(opts.reportOut);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(opts.reportOut, result.reportText, "utf8");
        console.error(`partial-count-report: written -> ${opts.reportOut}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(
        `partial-count-report: FAILED -- ${err && err.message ? err.message : String(err)}`,
      );
      process.exit(1);
    });
}
