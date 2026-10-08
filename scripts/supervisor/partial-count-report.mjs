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
//
// HYK-255-consumed-denominator-1 수리 -- 위 «소비 영수증은 워크트리와
// 함께 사라진다» 한계를 좁힌다. collectConsumedRounds가 이제 ①repoRoot
// 등록 워크트리 외에 ②추가 저장소(기본 = 에디터 저장소) 등록 워크트리
// ③아카이브 루트(기본 = 하네스-관제실/아카이브) 아래 "receipts" 폴더
// (B-7-6 IDENTICAL 사본)도 «읽기만» 한다. taskId+ROLE+라운드로 중복
// 제거하고(같으면 살아있는 워크트리를 1건으로), 보고의 소비영수증 줄에
// 살아있는 a건 / 아카이브 b건을 갈라 적는다 -- 아카이브는 ORCH가 쓸 수
// 있는 사본이라 독립 앵커가 아니라는 뜻도 그 줄에 함께 적는다. B-7-6이
// 아카이브를 남기지 않은 라운드(그 관행 이전 · 수동 정리)는 여전히
// «영수증 결손»으로 남는다 -- 이 수리로도 닫히지 않는 한계다.
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

// HYK-255-consumed-denominator-1 -- 소비 분모 추가 출처(①repoRoot 외).
// ②추가 저장소(기본값 = 에디터 저장소) 등록 워크트리의 .harness/receipts.
// ③아카이브 루트 아래 이름이 "receipts"인 폴더(재귀). CLI 인자
// --extra-repo-root(반복 가능) · --archive-root · --archive-scan-max-depth
// 로 바꿀 수 있다(parseCliArgs 참고).
export const DEFAULT_EXTRA_REPO_ROOTS = Object.freeze([
  "C:/Users/Administrator/Documents/모바일마크다운에디터",
]);
export const DEFAULT_ARCHIVE_ROOT = "D:/문서관리/하네스-관제실/아카이브";
// 실측 아카이브 레이아웃(§1-2) = 아카이브/<날짜·사유 슬러그>/<pr 슬러그>/
// receipts/*.json -- archiveRoot 기준 깊이 2에서 "receipts"가 나온다.
// 상한 6 = 그 실측 깊이(2)에 변형 레이아웃(예: 프로젝트 하위 폴더 한 단
// 더) 여유분을 더한 값 -- 병적 재귀(예: node_modules 심볼릭 루프)를
// node_modules·.git 이름 제외와 함께 막는 보수적 상한이다.
export const DEFAULT_ARCHIVE_SCAN_MAX_DEPTH = 6;

// 소비 영수증 파일 이름 -- "<ROLE>-receipt-r<N>.json"(ROLE = CODER/REVIEW
// 등 영문자). 라운드 중복 제거 키(taskId+ROLE+N)를 여기서 뽑는다. 이
// 모양이 아닌 파일(예: runner-receipt-run4.json)은 라운드를 못 읽는
// 영수증이다 -- sink.unkeyedCount로 값을 남기고(세는가 선택, 조용히
// 버리지 않음) 중복 제거 없이 그대로 가산한다.
const ROUND_RECEIPT_FILENAME_RE = /^([A-Za-z]+)-receipt-r(\d+)\.json$/;

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

// 영수증 파일 하나 -- 파싱·키 뽑기를 readReceiptsInDir에서 떼어냈다
// (eslint complexity 예산 때문에 분기를 한 곳에 몰지 않는다).
function classifyReceiptFile({ name, dir, readFn, source, sink }) {
  try {
    const receipt = JSON.parse(readFn(path.join(dir, name), "utf8"));
    const doneAtMs = parseKstTimestampMs(receipt?.binding?.doneAt);
    if (doneAtMs === null) {
      sink.parseFailures += 1;
      return;
    }
    const taskId = receipt?.binding?.taskId ?? null;
    const m = name.match(ROUND_RECEIPT_FILENAME_RE);
    let key = null;
    if (m && typeof taskId === "string") {
      key = `${taskId}::${m[1].toUpperCase()}::${m[2]}`;
    } else {
      sink.unkeyedCount += 1;
    }
    sink.records.push({ key, doneAtMs, taskId, source });
  } catch {
    sink.parseFailures += 1;
  }
}

// source = "living"(①repoRoot ·②추가 저장소 워크트리) | "archive"(③아카이브
// 사본). 중복 제거(아래 collectConsumedRounds)가 source로 승자를 고른다.
function readReceiptsInDir({ dir, readFn, readdirFn, source, sink }) {
  let names;
  try {
    names = readdirFn(dir);
  } catch {
    sink.dirFailures += 1;
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    classifyReceiptFile({ name, dir, readFn, source, sink });
  }
}

// ③아카이브 재귀 walk -- 포트는 readdirFn 하나뿐(새 경로에서 fs 직접
// 호출 금지 요건). Dirent/withFileTypes 없이 "readdirFn(path)가 성공하면
// 디렉터리, 던지면 파일(또는 못 읽음)"로 덕타이핑한다. ⛔정직 한계: 이
// 덕타이핑은 "파일이라 스킵"과 "권한 없어 못 읽는 디렉터리"를 구분하지
// 못한다 -- archiveRoot 자신의 읽기 실패(아래 scanArchiveRoot)만 별도로
// 표면화하고, 더 깊은 단계의 그런 실패는 조용히 "파일"로 취급해 스킵한다
// (§4 정직 한계 문단에 그대로 적는다).
function walkForReceiptsDirs({ dir, depth, maxDepth, readdirFn }) {
  if (depth > maxDepth) return [];
  let names;
  try {
    names = readdirFn(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    if (name === "receipts") {
      found.push(full);
      continue;
    }
    found.push(
      ...walkForReceiptsDirs({
        dir: full,
        depth: depth + 1,
        maxDepth,
        readdirFn,
      }),
    );
  }
  return found;
}

// archiveRoot 자신의 상태(경로 없음 / 읽기 실패 / 스캔함)는 별도로 값을
// 남긴다 -- 비타협: "0건"으로 조용히 접지 않는다(§2 요건 4).
function scanArchiveRoot({ archiveRoot, maxDepth, existsFn, readdirFn }) {
  if (!existsFn(archiveRoot)) {
    return { root: archiveRoot, status: "경로 없음", dirs: [] };
  }
  let topNames;
  try {
    topNames = readdirFn(archiveRoot);
  } catch (err) {
    return {
      root: archiveRoot,
      status: `읽기 실패: ${err && err.message ? err.message : String(err)}`,
      dirs: [],
    };
  }
  const dirs = [];
  for (const name of topNames) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(archiveRoot, name);
    if (name === "receipts") {
      dirs.push(full);
      continue;
    }
    dirs.push(
      ...walkForReceiptsDirs({ dir: full, depth: 1, maxDepth, readdirFn }),
    );
  }
  return { root: archiveRoot, status: "스캔함", dirs };
}

// ①repoRoot·②추가 저장소 공용 -- 등록 워크트리 목록의 .harness/receipts를
// "living" 출처로 읽는다(①②가 코드를 공유 -- 중복 분기를 피한다).
function scanWorktreesForReceipts({
  worktrees,
  existsFn,
  readFn,
  readdirFn,
  sink,
}) {
  let scanned = 0;
  for (const wt of worktrees) {
    const dir = path.join(wt, ".harness", "receipts");
    if (!existsFn(dir)) continue;
    scanned += 1;
    readReceiptsInDir({ dir, readFn, readdirFn, source: "living", sink });
  }
  return scanned;
}

// ②추가 저장소 하나 -- repoRoot와 같은 "등록 워크트리" 계약
// (listGitWorktrees)을 그대로 탄다. 경로 없음 / 열거 실패도 값으로
// 남긴다(§2 요건 4 — 조용한 0건 금지).
function scanExtraRepoRoot({
  root,
  gitWorktreeListExecFn,
  existsFn,
  readFn,
  readdirFn,
  sink,
}) {
  if (!existsFn(root)) {
    return { root, status: "경로 없음", scannedWorktrees: 0 };
  }
  const wl = listGitWorktrees(root, gitWorktreeListExecFn);
  if (!wl.ok) {
    return {
      root,
      status: `열거 실패: ${wl.detail ?? wl.reason}`,
      scannedWorktrees: 0,
    };
  }
  const scanned = scanWorktreesForReceipts({
    worktrees: wl.worktrees,
    existsFn,
    readFn,
    readdirFn,
    sink,
  });
  return { root, status: "스캔함", scannedWorktrees: scanned };
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

function buildUnknownConsumedResult({ archiveRoot, wl }) {
  return {
    consumed: { known: false, reason: "워크트리 열거 실패" },
    labels: null,
    parseFailures: 0,
    unkeyedCount: 0,
    scannedWorktrees: 0,
    scannedArchiveDirs: 0,
    livingCount: 0,
    archiveCount: 0,
    extraRepoRootsStatus: [],
    archiveStatus: { root: archiveRoot, status: "미시도(① 실패)" },
    collectorDetail: wl.detail ?? wl.reason,
  };
}

// 중복 제거 -- 키 = taskId+ROLE+라운드(파일 이름에서). 같은 키가
// living·archive 둘에 있으면 한 번만 세고 출처는 living(§2 요건 2).
// 라운드를 못 읽는 영수증(key=null)은 중복 제거 없이 그대로 가산한다
// (sink.unkeyedCount가 이미 그 건수를 값으로 남겼다).
function dedupeConsumedRecords(records) {
  const byKey = new Map();
  const unkeyedRecords = [];
  for (const r of records) {
    if (r.key === null) {
      unkeyedRecords.push(r);
      continue;
    }
    const existing = byKey.get(r.key);
    if (!existing || (existing.source === "archive" && r.source === "living")) {
      byKey.set(r.key, r);
    }
  }
  return [...byKey.values(), ...unkeyedRecords];
}

function summarizeConsumedRecords({ records, windowStartMs, windowEndMs }) {
  const labels = new Set();
  let livingCount = 0;
  let archiveCount = 0;
  for (const r of records) {
    if (r.doneAtMs < windowStartMs || r.doneAtMs > windowEndMs) continue;
    if (r.source === "living") livingCount += 1;
    else archiveCount += 1;
    if (typeof r.taskId === "string") labels.add(r.taskId);
  }
  return { labels, livingCount, archiveCount };
}

export function collectConsumedRounds({
  repoRoot,
  extraRepoRoots = DEFAULT_EXTRA_REPO_ROOTS,
  archiveRoot = DEFAULT_ARCHIVE_ROOT,
  archiveScanMaxDepth = DEFAULT_ARCHIVE_SCAN_MAX_DEPTH,
  windowStartMs,
  windowEndMs,
  readFn = readFileSync,
  readdirFn = readdirSync,
  existsFn = existsSync,
  gitWorktreeListExecFn,
}) {
  // ①repoRoot 열거 실패 규칙은 그대로 둔다(기존 비타협) -- 실패하면
  // ②③ 시도 자체를 건너뛴다(①이 UNKNOWN이면 전체가 UNKNOWN이므로 나머지
  // 출처를 먼저 긁는 것은 자원 낭비다 -- §4 정직 한계에 명시).
  const wl = listGitWorktrees(repoRoot, gitWorktreeListExecFn);
  if (!wl.ok) return buildUnknownConsumedResult({ archiveRoot, wl });

  const sink = {
    records: [],
    parseFailures: 0,
    dirFailures: 0,
    unkeyedCount: 0,
  };
  let scannedLivingWorktrees = scanWorktreesForReceipts({
    worktrees: wl.worktrees,
    existsFn,
    readFn,
    readdirFn,
    sink,
  });

  // ②추가 저장소(기본 = 에디터 저장소) -- 각 루트의 상태를 값으로 남긴다.
  const extraRepoRootsStatus = extraRepoRoots.map((root) => {
    const st = scanExtraRepoRoot({
      root,
      gitWorktreeListExecFn,
      existsFn,
      readFn,
      readdirFn,
      sink,
    });
    scannedLivingWorktrees += st.scannedWorktrees;
    return st;
  });

  // ③아카이브 루트 -- 이름이 "receipts"인 폴더를 재귀로 찾아 "archive"
  // 출처로 읽는다.
  const archiveScan = scanArchiveRoot({
    archiveRoot,
    maxDepth: archiveScanMaxDepth,
    existsFn,
    readdirFn,
  });
  for (const dir of archiveScan.dirs) {
    readReceiptsInDir({ dir, readFn, readdirFn, source: "archive", sink });
  }

  const dedupedRecords = dedupeConsumedRecords(sink.records);
  const { labels, livingCount, archiveCount } = summarizeConsumedRecords({
    records: dedupedRecords,
    windowStartMs,
    windowEndMs,
  });

  return {
    consumed: { known: true, count: livingCount + archiveCount },
    labels,
    parseFailures: sink.parseFailures + sink.dirFailures,
    unkeyedCount: sink.unkeyedCount,
    scannedWorktrees: scannedLivingWorktrees,
    scannedArchiveDirs: archiveScan.dirs.length,
    livingCount,
    archiveCount,
    extraRepoRootsStatus,
    archiveStatus: { root: archiveScan.root, status: archiveScan.status },
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

// HYK-255-consumed-denominator-1 §2 요건 3 -- 소비영수증 수집기 줄 하나에
// 살아있는 워크트리 a건 / 아카이브 사본 b건을 갈라 적고, 아카이브는 독립
// 앵커가 아니라는 뜻을 한 마디로 함께 적는다. 요건 4 -- 추가 저장소·
// 아카이브 루트의 실패/부재도 같은 줄에 값으로 남긴다("스캔함"이 아닌
// 상태만 보여서 조용한 "0건"을 막는다).
// 추가 저장소·아카이브 루트가 "스캔함"이 아니면 그 상태를 값으로 남긴다
// (§2 요건 4 — 조용한 0건 금지). buildConsumedCollectorEntry에서 떼어낸
// 이유는 eslint complexity 예산.
function buildConsumedFailureDetails(consumedResult) {
  const details = [];
  if (consumedResult.parseFailures > 0) {
    details.push(`파싱 실패 ${consumedResult.parseFailures}건`);
  }
  if (consumedResult.unkeyedCount > 0) {
    details.push(
      `라운드 비식별 ${consumedResult.unkeyedCount}건(중복 제거 미적용·그대로 가산)`,
    );
  }
  for (const st of consumedResult.extraRepoRootsStatus ?? []) {
    if (st.status !== "스캔함") {
      details.push(`추가저장소(${st.root}) ${st.status}`);
    }
  }
  if (consumedResult.archiveStatus?.status !== "스캔함") {
    details.push(
      `아카이브 루트(${consumedResult.archiveStatus?.root}) ${consumedResult.archiveStatus?.status}`,
    );
  }
  return details;
}

function buildConsumedCollectorEntry(consumedResult) {
  const scannedWt = consumedResult.scannedWorktrees ?? 0;
  const scannedArchive = consumedResult.scannedArchiveDirs ?? 0;
  const name = `소비영수증(워크트리 ${scannedWt}곳 · 아카이브 ${scannedArchive}곳 스캔)`;
  if (consumedResult.consumed.known !== true) {
    return {
      name,
      ok: false,
      detail: consumedResult.collectorDetail ?? "사유 미상",
    };
  }
  const details = [
    `살아있는 ${consumedResult.livingCount}건 / 아카이브 ${consumedResult.archiveCount}건` +
      `(아카이브는 ORCH가 쓸 수 있는 사본 — 독립 앵커 아님)`,
    ...buildConsumedFailureDetails(consumedResult),
  ];
  return { name, ok: true, detail: details.join(" · ") };
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
  collectors.push(buildConsumedCollectorEntry(consumedResult));
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
    extraRepoRoots: options.extraRepoRoots ?? DEFAULT_EXTRA_REPO_ROOTS,
    archiveRoot: options.archiveRoot ?? DEFAULT_ARCHIVE_ROOT,
    archiveScanMaxDepth:
      options.archiveScanMaxDepth ?? DEFAULT_ARCHIVE_SCAN_MAX_DEPTH,
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
    extraRepoRoots,
    archiveRoot,
    archiveScanMaxDepth,
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
    extraRepoRoots,
    archiveRoot,
    archiveScanMaxDepth,
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
    else if (argv[i] === "--extra-repo-root") {
      if (!opts.extraRepoRoots) opts.extraRepoRoots = [];
      opts.extraRepoRoots.push(argv[++i]);
    } else if (argv[i] === "--archive-root") opts.archiveRoot = argv[++i];
    else if (argv[i] === "--archive-scan-max-depth")
      opts.archiveScanMaxDepth = Number(argv[++i]);
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
