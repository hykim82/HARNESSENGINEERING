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
  statSync,
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
  renderOutboxAuxNote,
  UNCOUNTED_EXAMPLES_V1,
  UNCOUNTED_EXAMPLES_V2,
  UNCOUNTED_EXAMPLES_V3,
  GATE_TYPES,
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
// 디렉터리, 던지면 파일(또는 못 읽음)"로 덕타이핑한다.
// HYK-255-consumed-denominator-1 2R 수리 -- catch에서 err.code로 "파일이라
// 건너뜀"(ENOTDIR)과 "진짜 읽기 실패"(EACCES 등)를 가른다. 같은 readdirFn
// 포트의 err.code만 쓰므로 새 fs 직접 호출은 없다(기존 포트 제약 그대로).
// 진짜 실패는 sink.walkDirFailures로 값을 남긴다(0건으로 조용히 접지
// 않는다 -- §2 요건 1). 깊이 상한에 걸려 더 내려가지 않은 폴더도
// sink.depthExceededCount로 값을 남긴다(§2 요건 2) -- 그 폴더 아래에 진짜
// receipts가 있었는지는 원리상 알 수 없으므로(내려가지 않았으니까) "폴더
// 수"만 센다.
function walkForReceiptsDirs({ dir, depth, maxDepth, readdirFn, sink }) {
  if (depth > maxDepth) {
    sink.depthExceededCount += 1;
    return [];
  }
  let names;
  try {
    names = readdirFn(dir);
  } catch (err) {
    if (err && err.code === "ENOTDIR") {
      // 파일이라 건너뜀(기존 동작) -- 실패로 세지 않는다.
      return [];
    }
    sink.walkDirFailures += 1;
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
        sink,
      }),
    );
  }
  return found;
}

// archiveRoot 자신의 상태(경로 없음 / 읽기 실패 / 스캔함)는 별도로 값을
// 남긴다 -- 비타협: "0건"으로 조용히 접지 않는다(§2 요건 4).
function scanArchiveRoot({ archiveRoot, maxDepth, existsFn, readdirFn, sink }) {
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
      ...walkForReceiptsDirs({
        dir: full,
        depth: 1,
        maxDepth,
        readdirFn,
        sink,
      }),
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

// P3-3 수리 -- archiveScanMaxDepth가 비숫자·음수·소수(NaN 포함)면 기본값
// (DEFAULT_ARCHIVE_SCAN_MAX_DEPTH)으로 되돌린다. CLI 실패 종료(거부) 대신
// 기본값을 고른 이유(§4 정직 한계에도 적는다): 이 CLI는 watch-run.mjs가
// 주기적으로 호출하는 읽기 전용 감시 도구다 -- 플래그 오타 하나로 전체
// 보고가 거부·중단되면 감시 자체가 끊긴다. "상한이 통째로 꺼지는 것"(옛
// 버그 -- depth > NaN이 항상 false)만 막으면 되므로, 조용히 안전한 기본값
// 으로 복귀시키는 쪽이 감시 가용성을 깨지 않는다. collectConsumedRounds
// 하나의 관문에서만 걸어 CLI·options.archiveScanMaxDepth 양쪽을 다 막는다
// (CLI parseCliArgs와 runPartialCountOnce의 resolveValueOptions는 둘 다
// 이 함수를 거쳐 이 값을 쓴다).
function resolveArchiveScanMaxDepth(value) {
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_ARCHIVE_SCAN_MAX_DEPTH;
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

  const effectiveArchiveScanMaxDepth =
    resolveArchiveScanMaxDepth(archiveScanMaxDepth);

  const sink = {
    records: [],
    parseFailures: 0,
    dirFailures: 0,
    unkeyedCount: 0,
    walkDirFailures: 0,
    depthExceededCount: 0,
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
    maxDepth: effectiveArchiveScanMaxDepth,
    existsFn,
    readdirFn,
    sink,
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
    walkDirFailures: sink.walkDirFailures,
    depthExceededCount: sink.depthExceededCount,
    archiveScanMaxDepthUsed: effectiveArchiveScanMaxDepth,
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
// 수집 4(보조, HYK-255-outbox-aux-1) -- 보내는함(통역) 머리줄 보조 관측.
// ⛔독립 앵커 아님(ORCH가 쓸 수 있는 폴더) -- ㄱ-4 독립 확인·ㄴ 확인
// 사건에 전혀 섞이지 않고 renderOutboxAuxNote(partial-count-core.mjs)를
// 거쳐 «ORCH-writeable 보조 관측» 줄 하나로만 나간다. outboxDir은
// «인자로만» 받는다 -- 기본값이 없으므로 runPartialCountOnce가 그 값을
// 안 받으면(기존 모든 호출자, 회귀 0) 이 수집기 자체를 부르지 않는다.
// ---------------------------------------------------------------------------

const OUTBOX_HANYONG_CONFIRMED_MARK = "한용 확정";
const OUTBOX_RESPONSIBLE_MARK = "책임자 경유";

// 파일 첫 줄 분류 -- coder-task.md §2 ⓐ: 한 파일이 둘 다 포함하면 «한용
// 확정»이 우선한다(실측 = "[책임자 경유 · 한용 확정 B-9 위임]" 모양의
// 머리줄이 실제로 다수 존재 -- 책임자 경유는 거의 모든 문서가 깔고 있는
// 전달 경로 표시이고, 한용 확정은 그 위에 얹는 더 강한 신호라 상위로
// 친다). 둘 다 아니면 «분류 불가»로만 센다(조용한 탈락 금지 -- 그 건수도
// 값으로 남긴다).
function classifyOutboxFirstLine(firstLine) {
  if (
    typeof firstLine === "string" &&
    firstLine.includes(OUTBOX_HANYONG_CONFIRMED_MARK)
  ) {
    return "hanyongConfirmed";
  }
  if (
    typeof firstLine === "string" &&
    firstLine.includes(OUTBOX_RESPONSIBLE_MARK)
  ) {
    return "responsible";
  }
  return "unclassified";
}

// 파일 하나 스캔 -- stat 실패·창 밖·읽기 실패를 한 곳에 몰아 eslint
// complexity 예산을 지킨다(이 파일의 다른 수집기들과 동일한 분리 이유,
// 예: classifyReceiptFile). stat·읽기 실패는 sink.readFailures로 값을
// 남기고(조용한 0 금지) 분류에선 제외한다.
function scanOutboxFile({
  name,
  dir,
  windowStartMs,
  windowEndMs,
  statFn,
  readFn,
  sink,
}) {
  const full = path.join(dir, name);
  let st;
  try {
    st = statFn(full);
  } catch {
    sink.readFailures += 1;
    return;
  }
  if (st.mtimeMs < windowStartMs || st.mtimeMs > windowEndMs) return;
  let text;
  try {
    text = readFn(full, "utf8");
  } catch {
    sink.readFailures += 1;
    return;
  }
  sink.scanned += 1;
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  sink[classifyOutboxFirstLine(firstLine)] += 1;
}

export function collectOutboxHeaderCounts({
  outboxDir,
  windowStartMs,
  windowEndMs,
  readdirFn = readdirSync,
  readFn = readFileSync,
  statFn = statSync,
}) {
  if (!outboxDir) {
    return { known: false, reason: "미결선(보내는함 경로 미지정)" };
  }
  let names;
  try {
    names = readdirFn(outboxDir);
  } catch (err) {
    return {
      known: false,
      reason: `보내는함 읽기 실패: ${err && err.message ? err.message : String(err)}`,
    };
  }
  // ⛔하위 폴더(보관·전달됨) 미포함 -- coder-task.md §2 ⓐ 근거: 그 폴더로의
  // 이동은 머리줄 발생 «이후»의 2차 손길(분류·정리)이고, 이 저장소의 다른
  // 통계 수집기(collectConsumedRounds 등)와 달리 이동 자체가 "다시 쓴
  // 사건"이 아니다 -- 그런데 mtime은 이동 시각으로 갱신될 수 있어서, 하위
  // 폴더까지 보면 측정 기간의 뜻이 "그 기간에 머리줄이 났다"에서 "그
  // 기간에 옮겨졌다"로 조용히 바뀌어버린다(과다/과소 계수). 최초 발화
  // 신호만 보는 이 보조 칸은 평평한(top-level) *.md만 scan한다.
  const sink = {
    responsible: 0,
    hanyongConfirmed: 0,
    unclassified: 0,
    scanned: 0,
    readFailures: 0,
  };
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    scanOutboxFile({
      name,
      dir: outboxDir,
      windowStartMs,
      windowEndMs,
      statFn,
      readFn,
      sink,
    });
  }
  return { known: true, ...sink };
}

// ---------------------------------------------------------------------------
// 수집 5(보조, HYK-255-relay-aux-1) -- 전달 파일(통역 「기록\전달-*.md」)
// 머리줄 대조. 설계 정본 = D:\문서관리\하네스-관제실\PM\산출물\하네스\
// 2026-11-04-SSOT-전달파일-계수기\SSOT-전달파일-계수기-설계.md §(b)(c).
// ⛔읍기 전용 -- 전달 파일·보내는함·받는함 중 어느 것도 쓰지 않는다.
// ⛔독립 앵커 아님(ORCH가 쓸 수 있는 세 폴더를 전부 대조할 뿐) --
// renderRelayLedgerAuxLines(partial-count-core.mjs)를 거쳐 ㄴ 절의
// «ORCH-writeable 보조 관측» 두 줄로만 나간다. relayGlob은 «인자로만»
// 받는다(기본값 없음 -- §(f) "다음 조각 밖" 그대로, outboxDir과 동일한
// opt-in 관례).
// ---------------------------------------------------------------------------

// §(b) 머리줄 정규식 그대로(줄 머리 고정 `^` · 줄 끝 고정 `$` -- 본문
// 속에 떠다니는 인용을 항목으로 세지 않는다, 변이①의 표적).
const RELAY_HEADER_RE =
  /^\[책임자 경유 · (한용 확정|책임자 판정) · #(\d{8}-\d{4}[a-z]?) · (\d{4}-\d{2}-\d{2} \d{2}:(?:\d{2}|\dx)) KST · (지시|판정|교정|승인|답변) · (ㄱ-[1-7]|ㄴ)\]$/;
// "머리줄처럼 시작했는데 전체 정규식은 안 맞는" 줄을 형식 오류로 잡기
// 위한 느슨한 접두 판정(줄 머리 고정은 유지한다).
const RELAY_HEADER_PREFIX_RE = /^\[책임자 경유 · /;
// §(b) "그다음 줄부터 `> 한용: «…」` 인용 줄" -- 혼용 종결 부호(«…»/«…」)
// 모두 받는다(근거-부록 B).
const RELAY_QUOTE_LINE_RE = /^> 한용: «(.+)[」»]$/;
const RELAY_TIME_FIELD_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}|\dx)$/;
// 보내는함·받는함 파일 이름 머리의 `YYYY-MM-DD-HHMM`(두 함 모두 이
// 이름 체계를 쓴다, 근거-부록 B·D) -- 발화 시각으로 쓴다.
const LEDGER_FILE_NAME_TS_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})/;
// S1·S2 공용 인용 추출 -- 근거-부록 B: `«[^」»]{3,}[」»]`로 찾으면
// 바이트가 아니라 글자 단위라야 한다(C: cut -c 바이트 절단은 가짜
// "없음"을 낸다).
const QUOTE_EXTRACT_RE = /«([^」»]{3,})[」»]/;
const INBOX_QUOTE_LINE_RE = /한용\s*«([^」»]{3,})[」»]/g;
const RELAY_NUMBER_TOKEN_RE = /전달 #(\d{8}-\d{4}[a-z]?)/;
// 오탐 방지 ⓑ -- 보내는함 파일 이름이 `판정-<HHMM>` 모양이면 그 HHMM을
// 뽑아 받는함의 `상신` 파일과 대조한다(아래 isGate7MissingCandidate).
const OUTBOX_PANJEONG_HHMM_RE = /판정-(\d{4})/;

function parseLedgerFileNameTimestampMs(name) {
  const m = LEDGER_FILE_NAME_TS_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return parseKstTimestampMs(`${y}-${mo}-${d} ${h}:${mi} KST`);
}

// P2-4(이 라운드 변이③의 표적) -- ㄱ-7 기록 누락 대조는 "같은 날짜 +
// HHMM"을 파일 이름의 날짜·시각 토큰에서 구조로 뽑아 대조해야 한다
// (부분 문자열 포함 판정이면 다른 날 같은 HHMM, 또는 이름 어딘가에
// 우연히 같은 네 자리가 낀 파일도 짝이 된다).
function parseLedgerFileNameDateHhmm(name) {
  const m = LEDGER_FILE_NAME_TS_RE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return { date: `${y}-${mo}-${d}`, hhmm: `${h}${mi}` };
}

// 머리줄의 시각 필드("2026-11-03 21:4x" 모양)를 ms로. 분 자리가 `x`면
// (분 추정) approx:true를 돌려주고, 시각 창 매칭에서 ±10분(그 외 ±15분,
// §(c))으로 좁힌다 -- §(b) "분 자리 x 허용"의 코드쪽 짝.
function parseRelayHeaderTimeField(raw) {
  const m = RELAY_TIME_FIELD_RE.exec(raw);
  if (!m) return { ms: null, approx: false };
  const [, datePart, hh, mm] = m;
  const approx = mm.includes("x");
  const mmNorm = approx ? `${mm[0]}0` : mm;
  return { ms: parseKstTimestampMs(`${datePart} ${hh}:${mmNorm} KST`), approx };
}

// 게이트 2 판정 A(HYK-255-relay-aux-4, 1604 상신 답) -- 정규식 밖
// `[책임자 경유 · ` 줄 하나의 시각을 "그 줄 자신"에서 정한다: ⑴ 줄 안에
// 머리줄 3번째 필드와 같은 모양의 `YYYY-MM-DD HH:MM`(분 추정 `\dx` 포함)
// 토큰이 있으면 그것 ⑵ 없으면 그 줄이 든 전달 파일 이름의
// `전달-YYYY-MM-DD` 날짜(그 날 00:00 KST) ⑶ 둘 다 없으면 "시각 미정"
// (timeMs null · timeSource "undetermined"). 이 세 단계 중 어느 것으로
// 정해졌는지(timeSource)도 함께 남긴다 -- 아래 classifyFormatErrorCandidates
// 가 "시각 미정"만 따로 세기 위해서다.
const INLINE_LINE_TIME_TOKEN_RE = /(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}|\dx)/;

function parseInlineLineTimeMs(line) {
  const m = INLINE_LINE_TIME_TOKEN_RE.exec(line);
  if (!m) return null;
  const mm = m[3].includes("x") ? `${m[3][0]}0` : m[3];
  return parseKstTimestampMs(`${m[1]} ${m[2]}:${mm} KST`);
}

// 전달 파일 이름 `전달-YYYY-MM-DD...` 머리의 날짜 -- 그 날 00:00 KST로
// 본다(파일 이름에 시각(HHMM)이 더 있어도 날짜만 쓴다, 판정 원문 그대로
// "그 날 00:00 KST").
const RELAY_FILE_NAME_DATE_RE = /^전달-(\d{4})-(\d{2})-(\d{2})/;

function parseRelayFileNameDateMs(fileName) {
  const m = RELAY_FILE_NAME_DATE_RE.exec(fileName);
  if (!m) return null;
  return parseKstTimestampMs(`${m[1]}-${m[2]}-${m[3]} 00:00 KST`);
}

function resolveInvalidLineTime(line, fileName) {
  const inlineMs = parseInlineLineTimeMs(line);
  if (inlineMs !== null) return { timeMs: inlineMs, timeSource: "inline" };
  const fileNameMs = parseRelayFileNameDateMs(fileName);
  if (fileNameMs !== null)
    return { timeMs: fileNameMs, timeSource: "fileName" };
  return { timeMs: null, timeSource: "undetermined" };
}

// 헤더 다음 줄들에서 첫 `> 한용:` 인용 줄만 집는다(빈 줄 또는 다음
// 머리줄 접두에서 멈춘다 -- 한 항목의 인용이 다음 항목으로 새지 않게).
function findQuoteAfterHeader(lines, headerIdx) {
  for (let j = headerIdx + 1; j < lines.length; j++) {
    const q = RELAY_QUOTE_LINE_RE.exec(lines[j]);
    if (q) return q[1];
    if (lines[j].trim() === "" || RELAY_HEADER_PREFIX_RE.test(lines[j])) {
      return null;
    }
  }
  return null;
}

// 전달 파일 한 편의 본문 -> 항목 배열 + 정규식 밖 줄 배열(중복 번호는
// 아직 안 센다 -- dedupeRelayEntriesByNumber가 뒤에서 센다). 변이①의
// 표적 = 이 함수가 매 줄을 "그 줄 전체"에 `^...$` 고정 정규식으로만
// 매칭한다는 사실 자체(본문 속 줄 중간에 끼워진 머리줄 모양 문자열은
// 줄 머리가 아니므로 매칭되지 않는다). 게이트 2 판정 A(HYK-255-relay-
// aux-4) -- 정규식 밖 줄은 더 이상 숫자로만 세지 않는다: 각 줄의 own
// 시각(resolveInvalidLineTime)을 같이 남겨 collectRelayLedger가
// formatStartMs 대조로 형식 오류/형식 이전/시각 미정을 줄 단위로
// 가르게 한다.
function parseRelayFileEntries(text, fileName) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const invalidLines = [];
  for (let i = 0; i < lines.length; i++) {
    const full = RELAY_HEADER_RE.exec(lines[i]);
    if (full) {
      const [, scheme, number, timeRaw, kind, classification] = full;
      const { ms: timeMs, approx: timeApprox } =
        parseRelayHeaderTimeField(timeRaw);
      entries.push({
        scheme,
        number,
        timeMs,
        timeApprox,
        kind,
        classification,
        quote: findQuoteAfterHeader(lines, i),
        lineNo: i + 1,
      });
    } else if (RELAY_HEADER_PREFIX_RE.test(lines[i])) {
      const { timeMs, timeSource } = resolveInvalidLineTime(lines[i], fileName);
      invalidLines.push({ lineNo: i + 1, timeMs, timeSource });
    }
  }
  return { entries, invalidLines };
}

// 번호 중복 = 형식 오류 후보로 센다(§(b) "조용히 하나를 고르지 않는다")
// -- 변이④의 표적. 처음 본 번호만 "유효 항목"으로 남기고 그 뒤 같은
// 번호는 duplicates에 담는다(own timeMs 보존 -- 완전 매칭 헤더라
// own 시각이 항상 있다, "정규식 밖 줄"의 시각 미정 3단계 fallback은
// 여기엔 적용하지 않는다, product_scope ① "시각 결정은 정규식 밖 줄에만").
// 매칭·분류 집계는 유효 항목만 쓴다.
function dedupeRelayEntriesByNumber(entries) {
  const byNumber = new Map();
  const valid = [];
  const duplicates = [];
  for (const e of entries) {
    if (byNumber.has(e.number)) {
      duplicates.push(e);
      continue;
    }
    byNumber.set(e.number, e);
    valid.push(e);
  }
  return { valid, byNumber, duplicates, duplicateCount: duplicates.length };
}

// `<dir>/전달-*.md` 모양의 glob 1개를 디렉터리 + 파일명 정규식으로
// 쪼갠다 -- `*`만 지원하는 최소 glob(이 저장소에 쓰는 모든 --relay-glob
// 예시가 이 모양이다, PM 설계 §(e)).
function splitGlobDirPattern(glob) {
  return { dir: path.dirname(glob), pattern: path.basename(glob) };
}

function globPatternToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// 전달 폴더 읍기 -- 변이③의 표적: 폴더 자체가 없거나 읍기 실패면
// known:false(⛔0 아님)로 돌려준다. 폴더는 있는데 패턴에 걸리는 파일이
// 0개면(진짜 "아직 전달 파일 없음") known:true · entries:[] 그대로다 --
// "폴더 없음"과 "폴더는 있는데 0건"은 다른 사실이라 섞지 않는다.
function readRelayFiles({ relayGlob, readdirFn, readFn }) {
  const { dir, pattern } = splitGlobDirPattern(relayGlob);
  const re = globPatternToRegex(pattern);
  let names;
  try {
    names = readdirFn(dir).filter((n) => re.test(n));
  } catch (err) {
    return {
      known: false,
      reason: `전달 폴더 읽기 실패: ${err && err.message ? err.message : String(err)}`,
    };
  }
  names.sort();
  const allEntries = [];
  const allInvalidLines = [];
  const readFailures = [];
  for (const name of names) {
    try {
      const { entries, invalidLines } = parseRelayFileEntries(
        readFn(path.join(dir, name), "utf8"),
        name,
      );
      allEntries.push(...entries);
      allInvalidLines.push(...invalidLines);
    } catch {
      readFailures.push(name);
    }
  }
  return {
    known: true,
    entries: allEntries,
    invalidLines: allInvalidLines,
    readFailures,
    scannedFiles: names.length,
  };
}

// S1 -- 보내는함 첫 줄의 한용 인용(§(c) 출처 S1). "한용"이 전혀 없는
// 첫 줄은 대조 대상 자체가 아니다(이 보조 칸이 세려는 것은 한용 발화
// 신호가 있는 줄뿐).
function extractOutboxQuoteItem({ name, firstLine }) {
  if (typeof firstLine !== "string" || !firstLine.includes("한용")) {
    return null;
  }
  const q = QUOTE_EXTRACT_RE.exec(firstLine);
  if (!q) return null;
  const numberM = RELAY_NUMBER_TOKEN_RE.exec(firstLine);
  const panjeongM = OUTBOX_PANJEONG_HHMM_RE.exec(name);
  // P2-4: ㄱ-7 짝 대조의 날짜는 이 출처 파일 자신의 이름 머리
  // `YYYY-MM-DD`에서 구조로 뽑는다(판정 토큰은 HHMM만 갖고 있다).
  const fileDateHhmm = parseLedgerFileNameDateHhmm(name);
  return {
    source: "S1",
    name,
    quote: q[1],
    number: numberM ? numberM[1] : null,
    timeMs: parseLedgerFileNameTimestampMs(name),
    panjeongHhmm: panjeongM ? panjeongM[1] : null,
    panjeongDate: panjeongM && fileDateHhmm ? fileDateHhmm.date : null,
  };
}

function collectOutboxHanyongQuotes({ outboxDir, readdirFn, readFn }) {
  let names;
  try {
    names = readdirFn(outboxDir);
  } catch (err) {
    return {
      known: false,
      reason: `보내는함 읽기 실패: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const items = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let text;
    try {
      text = readFn(path.join(outboxDir, name), "utf8");
    } catch {
      continue;
    }
    const item = extractOutboxQuoteItem({
      name,
      firstLine: text.split(/\r?\n/)[0] ?? "",
    });
    if (item) items.push(item);
  }
  return { known: true, items };
}

// S2 -- 받는함 본문의 `한용 «` 줄(§(c) 출처 S2). 첫 줄만이 아니라 본문
// 전체를 본다(책임자 전달 뭉치가 아니라 ORCH 자유 서식 에코라 인용이
// 본문 어디에나 올 수 있다).
function extractInboxQuoteItems({ name, text }) {
  const timeMs = parseLedgerFileNameTimestampMs(name);
  const numberM = RELAY_NUMBER_TOKEN_RE.exec(text);
  const number = numberM ? numberM[1] : null;
  const items = [];
  const re = new RegExp(INBOX_QUOTE_LINE_RE);
  let m;
  while ((m = re.exec(text)) !== null) {
    items.push({ source: "S2", name, quote: m[1], number, timeMs });
  }
  return items;
}

function collectInboxHanyongQuotes({ inboxDir, readdirFn, readFn }) {
  let names;
  try {
    names = readdirFn(inboxDir);
  } catch (err) {
    return {
      known: false,
      reason: `받는함 읽기 실패: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const items = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let text;
    try {
      text = readFn(path.join(inboxDir, name), "utf8");
    } catch {
      continue;
    }
    if (!text.includes("한용 «") && !text.includes("한용«")) continue;
    items.push(...extractInboxQuoteItems({ name, text }));
  }
  return { known: true, items, names };
}

// ⓒ "같은 분 다중 인용은 1건으로 합친다" -- S1·S2를 합친 뒤 분(floor)
// 단위로 묶어 먼저 본 것만 남긴다(시각 불명 항목은 묶지 않는다 -- 묶을
// 분 자체가 없다).
function mergeSameMinuteSourceItems(items) {
  const seenMinutes = new Set();
  const merged = [];
  let mergedAwayCount = 0;
  for (const item of items) {
    if (item.timeMs === null) {
      merged.push(item);
      continue;
    }
    const key = Math.floor(item.timeMs / 60000);
    if (seenMinutes.has(key)) {
      mergedAwayCount += 1;
      continue;
    }
    seenMinutes.add(key);
    merged.push(item);
  }
  return { merged, mergedAwayCount };
}

function findFormatStartMs(validEntries) {
  let min = null;
  for (const e of validEntries) {
    if (e.timeMs !== null && (min === null || e.timeMs < min)) min = e.timeMs;
  }
  return min;
}

function relayEntryInWindow(entry, sourceTimeMs) {
  if (entry.timeMs === null || sourceTimeMs === null) return false;
  const windowMs = (entry.timeApprox ? 10 : 15) * 60 * 1000;
  return Math.abs(entry.timeMs - sourceTimeMs) <= windowMs;
}

// 오탐 방지 ⓑ -- 대응 없는 S1 항목이라도 파일 이름이 `판정-<HHMM>`이고
// 받는함에 "같은 날짜 + 같은 HHMM"의 `상신` 파일이 있으면 "ㄱ-7 기록
// 누락"으로 따로 센다(ㄴ 후보 아님). P2-4: 날짜·HHMM 둘 다 파일 이름의
// 구조화된 토큰으로 대조한다 -- 부분 문자열 포함(`includes`)만으로는
// 다른 날 같은 HHMM, 또는 이름 어딘가에 같은 네 자리가 낀 파일까지
// 짝으로 잡는다(이 라운드 변이③의 표적).
function isGate7MissingCandidate({ item, inboxNames }) {
  if (item.source !== "S1" || !item.panjeongHhmm || !item.panjeongDate) {
    return false;
  }
  return (inboxNames ?? []).some((n) => {
    if (!n.includes("상신")) return false;
    const parsed = parseLedgerFileNameDateHhmm(n);
    return (
      parsed !== null &&
      parsed.date === item.panjeongDate &&
      parsed.hhmm === item.panjeongHhmm
    );
  });
}

// 대조 키 1순위 = 번호 일치(P2-3: 번호 토큰은 있는데 그 번호의 전달
// 항목이 없으면 "없는 번호를 가리킨다" 자체가 신호라 2순위로 넘기지
// 않고 곧장 ㄴ 후보로 둔다 -- 이 라운드 변이②의 표적) · 2순위(번호 없는
// 옛 출처) = 시각 창(±15분, 분 추정이면 ±10분) **안에서만** 매칭으로
// 친다(PM 설계 §(c) "그리고" -- 창 밖에서 인용 앞 8글자만 같은 것은
// 매칭이 아니다, 이 라운드 변이①의 표적, P1-1). §(c)가 2순위에 나열한
// "인용 앞 8글자 일치 또는 같은 창 안 한용 항목 존재"는 창 조건과
// 묶이면 항상 뒤쪽 "같은 창 안 한용 항목 존재"로 흡수된다(창 안의
// entry가 하나라도 있으면 그 자체로 그 disjunct가 참이 된다) -- 그래서
// 창 안 존재 하나만 보면 되고, 인용 앞 8글자는 별도 비교가 필요 없다
// (검토 1R P1-1 제안 그대로 "결과적으로 창 안 전달 항목 존재와 같다").
// P2-1(2R) ⓘⓘ(HYK-255-relay-aux-4) -- 번호 토큰이 있는데 그 번호의
// 전달 항목이 전혀 없는 경우("없는 번호를 가리킴")를 시각 창 미매칭과
// 구분해서 돌려준다 -- 아래 classifySourceItems가 그 사유를
// numberMismatchCandidates로 따로 세어 렌더·통지 문면에 실제로 낸다
// (계수 동작 자체는 무변 -- 둘 다 "candidate"로 떨어진다).
function matchOneSourceItem({
  item,
  validEntries,
  relayByNumber,
  formatStartMs,
}) {
  if (
    formatStartMs === null ||
    (item.timeMs !== null && item.timeMs < formatStartMs)
  ) {
    return "before-format";
  }
  if (item.number) {
    return relayByNumber.has(item.number) ? "matched" : "number-mismatch";
  }
  for (const entry of validEntries) {
    if (relayEntryInWindow(entry, item.timeMs)) return "matched";
  }
  return "candidate";
}

function classifySourceItems({
  items,
  validEntries,
  relayByNumber,
  formatStartMs,
  inboxNames,
}) {
  let matched = 0;
  let candidates = 0;
  let beforeFormat = 0;
  let gate7Missing = 0;
  let numberMismatchCandidates = 0;
  for (const item of items) {
    const verdict = matchOneSourceItem({
      item,
      validEntries,
      relayByNumber,
      formatStartMs,
    });
    if (verdict === "matched") {
      matched += 1;
    } else if (verdict === "before-format") {
      beforeFormat += 1;
    } else if (isGate7MissingCandidate({ item, inboxNames })) {
      gate7Missing += 1;
    } else {
      candidates += 1;
      if (verdict === "number-mismatch") numberMismatchCandidates += 1;
    }
  }
  return {
    matched,
    candidates,
    beforeFormat,
    gate7Missing,
    numberMismatchCandidates,
  };
}

// 전달 항목(유효분만) 자기 분류 집계 -- 닫힌 목록(ㄱ-1~7·ㄴ) 밖 값은
// 조용히 버린다(정규식 5번째 그룹이 이미 그 닫힌 집합으로 고정돼 있어
// 실제로는 발생하지 않는다 -- 방어적으로만 가드).
function tallyRelayClassification(validEntries) {
  const tally = {};
  for (const g of GATE_TYPES) tally[`ㄱ-${g.number}`] = 0;
  tally["ㄴ"] = 0;
  for (const e of validEntries) {
    if (tally[e.classification] !== undefined) tally[e.classification] += 1;
  }
  return tally;
}

// 게이트 2 판정 A(HYK-255-relay-aux-4) -- 정규식 밖 줄·중복 번호 줄을
// "own 시각 vs formatStartMs"로 형식 오류 E/형식 이전/시각 미정으로
// 가른다(줄 단위 -- 2R의 전역 판정 `formatStartMs === null ? 0 : raw`를
// 대체한다). formatStartMs가 null(유효 머리줄 0개)이면 아직 시작되지
// 않은 형식을 소급해서 어겼다고 보지 않는다(2R 동작 유지) -- 전부
// 형식 이전으로 간다. 시각 미정(own 시각을 못 정한 정규식 밖 줄)은
// 형식 이전 버킷에 들어가되 별도 칸으로도 센다(판정 원문 "시각 미정 =
// 형식 이전 + 별도 칸"). 중복 번호 줄은 완전 매칭 헤더라 own 시각이
// 항상 있다 -- 시각 미정 3단계 fallback은 "정규식 밖 줄"에만 적용한다
// (product_scope ① 명시).
function classifyFormatErrorCandidates({
  invalidLines,
  duplicates,
  formatStartMs,
}) {
  if (formatStartMs === null) {
    // 형식 머리줄이 아직 0개라도 "시각 미정" 건수는 정보로 남긴다(둘 다
    // 형식 이전 버킷으로 가는 것은 같다 -- beforeFormatCount는 raw
    // 그대로, 2R 동작 무변).
    const undeterminedCount = invalidLines.filter(
      (line) => line.timeSource === "undetermined",
    ).length;
    return {
      formatErrorCount: 0,
      beforeFormatCount: invalidLines.length + duplicates.length,
      undeterminedCount,
    };
  }
  let formatErrorCount = 0;
  let beforeFormatCount = 0;
  let undeterminedCount = 0;
  for (const line of invalidLines) {
    if (line.timeMs === null) {
      beforeFormatCount += 1;
      undeterminedCount += 1;
    } else if (line.timeMs < formatStartMs) {
      beforeFormatCount += 1;
    } else {
      formatErrorCount += 1;
    }
  }
  for (const dup of duplicates) {
    if (dup.timeMs !== null && dup.timeMs < formatStartMs) {
      beforeFormatCount += 1;
    } else {
      formatErrorCount += 1;
    }
  }
  return { formatErrorCount, beforeFormatCount, undeterminedCount };
}

// collectRelayLedger -- 조립(읍기만, §2 비타협: 세 폴더 중 하나라도
// 결선이 안 됐거나 읍기 실패면 known:false로 fail-closed한다 -- 부분
// 수치를 조용히 내지 않는다).
export function collectRelayLedger({
  relayGlob,
  outboxDir,
  inboxDir,
  readdirFn = readdirSync,
  readFn = readFileSync,
}) {
  if (!outboxDir || !inboxDir) {
    return {
      known: false,
      reason: !outboxDir
        ? "미결선(보내는함 경로 미지정)"
        : "미결선(받는함 경로 미지정)",
    };
  }
  const relayFiles = readRelayFiles({ relayGlob, readdirFn, readFn });
  if (relayFiles.known !== true) return relayFiles;
  const outboxQuotes = collectOutboxHanyongQuotes({
    outboxDir,
    readdirFn,
    readFn,
  });
  if (outboxQuotes.known !== true) return outboxQuotes;
  const inboxQuotes = collectInboxHanyongQuotes({
    inboxDir,
    readdirFn,
    readFn,
  });
  if (inboxQuotes.known !== true) return inboxQuotes;

  const {
    valid: validEntries,
    byNumber: relayByNumber,
    duplicates,
  } = dedupeRelayEntriesByNumber(relayFiles.entries);
  const formatStartMs = findFormatStartMs(validEntries);
  const { merged, mergedAwayCount } = mergeSameMinuteSourceItems([
    ...outboxQuotes.items,
    ...inboxQuotes.items,
  ]);
  const {
    matched,
    candidates,
    beforeFormat,
    gate7Missing,
    numberMismatchCandidates,
  } = classifySourceItems({
    items: merged,
    validEntries,
    relayByNumber,
    formatStartMs,
    inboxNames: inboxQuotes.names,
  });

  // 게이트 2 판정 A(HYK-255-relay-aux-4, P2-2 2R 반려 수리) -- 정규식
  // 밖 줄·중복 번호는 더 이상 "형식 시작 시각이 있으면 전부 E"(2R의
  // 전역 판정)가 아니라, 줄 하나하나의 own 시각 대 formatStartMs로
  // 갈린다(classifyFormatErrorCandidates). 형식 머리줄이 아직 0개면
  // (formatStartMs null) 소급 0 원칙대로 전부 형식 이전이다(2R 동작
  // 유지).
  const {
    formatErrorCount,
    beforeFormatCount: relayBeforeFormatCount,
    undeterminedCount,
  } = classifyFormatErrorCandidates({
    invalidLines: relayFiles.invalidLines,
    duplicates,
    formatStartMs,
  });

  return {
    known: true,
    sourceUtteranceCount: merged.length,
    mergedAwayCount,
    matchedCount: matched,
    candidateCount: candidates,
    numberMismatchCandidateCount: numberMismatchCandidates,
    gate7MissingCount: gate7Missing,
    formatErrorCount,
    beforeFormatCount: beforeFormat + relayBeforeFormatCount,
    undeterminedCount,
    classificationTally: tallyRelayClassification(validEntries),
    scannedRelayFiles: relayFiles.scannedFiles,
    relayReadFailures: relayFiles.readFailures,
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
  // HYK-255-consumed-denominator-1 2R -- 깊은 단계 폴더 읽기 실패(ENOTDIR
  // 제외)와 깊이 상한 초과를 값으로 남긴다(§2 요건 1·2 -- 0건 침묵 금지).
  if (consumedResult.walkDirFailures > 0) {
    details.push(
      `아카이브 하위 폴더 읽기 실패 ${consumedResult.walkDirFailures}곳`,
    );
  }
  if (consumedResult.depthExceededCount > 0) {
    details.push(
      `깊이 상한(${consumedResult.archiveScanMaxDepthUsed}) 초과 ${consumedResult.depthExceededCount}곳`,
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

// HYK-255-outbox-aux-1 -- 보조 수집기 1줄. outboxResult가 null이면(=
// outboxDir 미지정, 기존 모든 호출자) 이 줄 자체를 목록에 더하지 않는다
// (admissionSweep/wake 등 이 저장소의 다른 opt-in 축과 동일한 관례 --
// "설정 안 함"과 "설정했는데 실패"를 섞지 않는다).
function buildOutboxCollectorEntry(outboxResult) {
  if (!outboxResult) return null;
  if (outboxResult.known !== true) {
    return {
      name: "보내는함보조수집기",
      ok: false,
      detail: outboxResult.reason,
    };
  }
  const detail =
    `스캔 ${outboxResult.scanned}건` +
    (outboxResult.readFailures > 0
      ? ` · 읽기 실패 ${outboxResult.readFailures}건`
      : "");
  return { name: "보내는함보조수집기", ok: true, detail };
}

function buildCollectors({
  deliveredResult,
  consumedResult,
  watchOk,
  watchSkipped,
  gate4,
  outboxResult,
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
  const outboxEntry = buildOutboxCollectorEntry(outboxResult);
  if (outboxEntry) collectors.push(outboxEntry);
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
    ...resolveAuxDirOptions(options),
  };
}

// HYK-255-relay-aux-1 -- resolveValueOptions가 relayGlob/inboxDir 두
// `??` 를 더 받아 eslint complexity(상한 12) 예산을 넘겼다(실측 14).
// outboxDir과 짝인 세 "경로 없으면 미결선" 기본값만 떼어낸다 --
// 로직·값은 원문과 완전히 동일.
function resolveAuxDirOptions(options) {
  return {
    // HYK-255-outbox-aux-1 -- 기본값 없음(§2 ⓐ "인자로 받음 · 기본값
    // 없으면 미결선 그대로"). `??`가 아니라 명시적으로 null 기본 --
    // undefined든 null이든 똑같이 "미지정"으로 다룬다(아래 runPartialCountOnce
    // 의 `if (outboxDir)` 분기 하나로 충분).
    outboxDir: options.outboxDir ?? null,
    // HYK-255-relay-aux-1 -- 기본값 없음(outboxDir과 동일한 opt-in
    // 관례) -- 둘 다 없으면 resolveRelayLedgerResult가 수집기 자체를
    // 부르지 않는다(회귀 0).
    relayGlob: options.relayGlob ?? null,
    inboxDir: options.inboxDir ?? null,
  };
}

function resolvePortOptions(options, repoRoot) {
  return {
    fetchJson: options.fetchJson ?? createAnonymousFetchJson().fetchJson,
    git: options.git ?? createProcessGitPort(repoRoot),
    readFn: options.readFn ?? readFileSync,
    readdirFn: options.readdirFn ?? readdirSync,
    existsFn: options.existsFn ?? existsSync,
    statFn: options.statFn ?? statSync,
    gitWorktreeListExecFn: options.gitWorktreeListExecFn,
  };
}

// HYK-255-outbox-aux-1 -- outboxDir이 없으면(기존 모든 호출자, 회귀 0) 이
// 수집기 자체를 부르지 않는다(eslint max-lines-per-function 예산 때문에
// runPartialCountOnce 본문에서 떼어낸 것 -- 로직은 그대로).
function resolveOutboxResult({
  outboxDir,
  windowStartMs,
  windowEndMs,
  readdirFn,
  readFn,
  statFn,
}) {
  return outboxDir
    ? collectOutboxHeaderCounts({
        outboxDir,
        windowStartMs,
        windowEndMs,
        readdirFn,
        readFn,
        statFn,
      })
    : null;
}

// HYK-255-relay-aux-1 (product_scope ①) -- relayGlob이 없으면(기존 모든
// 호출자, 회귀 0) 이 수집기 자체를 부르지 않는다. relayGlob이 있어도
// outboxDir·inboxDir 중 하나가 없으면 collectRelayLedger 자신이
// known:false(미결선)로 되돌린다 -- 여기서 null을 돌리지 않는 이유는
// "결선 시도는 했는데 재료가 모자랐다"를 "시도 자체를 안 했다"와 섞지
// 않기 위해서다(아래 렌더러가 null과 known:false를 다르게 그린다 --
// null = 줄 0개, known:false = UNKNOWN(사유) 한 줄).
function resolveRelayLedgerResult({
  relayGlob,
  outboxDir,
  inboxDir,
  readdirFn,
  readFn,
}) {
  return relayGlob
    ? collectRelayLedger({ relayGlob, outboxDir, inboxDir, readdirFn, readFn })
    : null;
}

// 보고 조립 -- runPartialCountOnce에서 떼어낸 것(eslint max-lines-per-
// function 예산). outboxResult가 null이면 auxNote는 undefined가 되고
// buildPartialCountReport의 기본 문면이 그대로 쓰인다(§2 ⓐ 회귀 0).
//
// HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓐ) -- uncountedExamples 선택도
// outboxResult 존재 여부(= --outbox-dir가 실제로 전달돼 수집기가 결선된
// 실행인지, 성공/실패 무관)로 갈린다. auxNote와 정확히 같은 조건식을
// 쓴다 -- 두 문면이 "결선 여부"에 대해 다른 답을 내면(하나는 결선,
// 하나는 미결선) 보고서 자체가 자기모순이 된다.
// HYK-255-relay-aux-1 (product_scope ① "미계수 예시 v3 선택 :1028-1030
// «결선 + known:true 일 때만» 규칙 준용") -- 두 보조 수집기 중 "더 좁힌"
// 쪽(관계 파일 대조가 결선됐으면 v3, 그게 아니면 보내는함만 결선됐으면
// v2, 둘 다 아니면 v1)을 고른다. ⛔relayResult가 "존재"만 해도(known
// 무관) v3을 고르면 전달 폴더가 없거나 읍기 실패한 실행에서도 v3이
// 나가는 거짓 축소가 생긴다(변이⑤의 표적) -- known===true를 엄격히
// 요구한다.
function selectUncountedExamples({ outboxResult, relayResult }) {
  if (relayResult?.known === true) return UNCOUNTED_EXAMPLES_V3;
  if (outboxResult?.known === true) return UNCOUNTED_EXAMPLES_V2;
  return UNCOUNTED_EXAMPLES_V1;
}

function assemblePartialCountReportText({
  now,
  windowStartMs,
  windowEndMs,
  deliveredResult,
  consumedResult,
  watch,
  gate4,
  outboxResult,
  relayResult,
}) {
  return buildPartialCountReport({
    generatedAtMs: now,
    windowStartMs,
    windowEndMs,
    delivered: deliveredResult.delivered,
    consumed: consumedResult.consumed,
    missingReceipts: deriveMissingReceipts(deliveredResult, consumedResult),
    gate4,
    auxNote: outboxResult ? renderOutboxAuxNote(outboxResult) : undefined,
    uncountedExamples: selectUncountedExamples({ outboxResult, relayResult }),
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
      outboxResult,
    }),
    lastAliveMs: watch.lastAliveMs,
    coverageGaps: watch.coverageGaps,
    relayLedgerResult: relayResult,
  });
}

// 수집 1~3 묶음(배달·소비·watch·ㄱ-4) -- runPartialCountOnce에서 떼어낸
// 것(eslint max-lines-per-function 예산). 로직·순서·값은 원문과 완전히
// 동일하다 -- 순수 리팩터, 새 동작 0.
async function collectPartialCountInputs({
  windowStartMs,
  windowEndMs,
  dispatchReceiptsPath,
  repoRoot,
  extraRepoRoots,
  archiveRoot,
  archiveScanMaxDepth,
  watchLogPath,
  fetchJson,
  git,
  allowlistPath,
  maxMergeChecks,
  readFn,
  readdirFn,
  existsFn,
  gitWorktreeListExecFn,
}) {
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
  return { deliveredResult, consumedResult, watch, gate4 };
}

// HYK-255-relay-aux-1 -- runPartialCountOnce 본문이 relayResult 한 줄
// 추가로 max-lines-per-function(상한 80) 예산을 넘겼다(실측 81). 보조
// 수집기 두 개(outbox·relay) 호출만 떼어낸다 -- 로직·순서·값은 원문과
// 완전히 동일.
function resolveAuxCollectorResults({
  outboxDir,
  relayGlob,
  inboxDir,
  windowStartMs,
  windowEndMs,
  readdirFn,
  readFn,
  statFn,
}) {
  const outboxResult = resolveOutboxResult({
    outboxDir,
    windowStartMs,
    windowEndMs,
    readdirFn,
    readFn,
    statFn,
  });
  const relayResult = resolveRelayLedgerResult({
    relayGlob,
    outboxDir,
    inboxDir,
    readdirFn,
    readFn,
  });
  return { outboxResult, relayResult };
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
    outboxDir,
    relayGlob,
    inboxDir,
  } = resolveValueOptions(options);
  const {
    fetchJson,
    git,
    readFn,
    readdirFn,
    existsFn,
    statFn,
    gitWorktreeListExecFn,
  } = resolvePortOptions(options, repoRoot);
  const windowEndMs = now;
  const windowStartMs = now - windowHours * 60 * 60 * 1000;

  const { deliveredResult, consumedResult, watch, gate4 } =
    await collectPartialCountInputs({
      windowStartMs,
      windowEndMs,
      dispatchReceiptsPath,
      repoRoot,
      extraRepoRoots,
      archiveRoot,
      archiveScanMaxDepth,
      watchLogPath,
      fetchJson,
      git,
      allowlistPath,
      maxMergeChecks,
      readFn,
      readdirFn,
      existsFn,
      gitWorktreeListExecFn,
    });

  const { outboxResult, relayResult } = resolveAuxCollectorResults({
    outboxDir,
    relayGlob,
    inboxDir,
    windowStartMs,
    windowEndMs,
    readdirFn,
    readFn,
    statFn,
  });

  const reportText = assemblePartialCountReportText({
    now,
    windowStartMs,
    windowEndMs,
    deliveredResult,
    consumedResult,
    watch,
    gate4,
    outboxResult,
    relayResult,
  });

  return {
    reportText,
    gate4,
    suspected: watch.suspected,
    coverageGaps: watch.coverageGaps,
    outboxResult,
    relayResult,
  };
}

// ---------------------------------------------------------------------------
// CLI -- 사람 한 줄 실행. 기본은 stdout만(쓰기 0). --report-out을 주면
// 그 경로에도 같은 텍스트를 쓴다(아침 보고 편입용 정본 위치 =
// 관제실 watch/partial-count-report.md -- reach-report.mjs가 읽는 곳).
// ---------------------------------------------------------------------------

// HYK-255-outbox-aux-1 -- 플래그 하나당 분기 하나이던 기존 if/else 사슬이
// --outbox-dir 추가로 eslint complexity(상한 12) 예산을 넘겼다. 분기를
// 줄이기 위해 "플래그 이름 -> opts에 쓰는 법" 표로 바꾼다(로직·플래그
// 이름·의미는 원문과 완전히 동일 -- 순수 리팩터, 새 동작 0).
const CLI_FLAG_HANDLERS = Object.freeze({
  "--report-out": (opts, v) => {
    opts.reportOut = v;
  },
  "--window-hours": (opts, v) => {
    opts.windowHours = Number(v);
  },
  "--max-merge-checks": (opts, v) => {
    opts.maxMergeChecks = Number(v);
  },
  "--dispatch-receipts": (opts, v) => {
    opts.dispatchReceiptsPath = v;
  },
  "--watch-log": (opts, v) => {
    opts.watchLogPath = v;
  },
  "--repo-root": (opts, v) => {
    opts.repoRoot = v;
  },
  "--extra-repo-root": (opts, v) => {
    if (!opts.extraRepoRoots) opts.extraRepoRoots = [];
    opts.extraRepoRoots.push(v);
  },
  "--archive-root": (opts, v) => {
    opts.archiveRoot = v;
  },
  "--archive-scan-max-depth": (opts, v) => {
    opts.archiveScanMaxDepth = Number(v);
  },
  // HYK-255-outbox-aux-1 -- §2 ⓐ "인자로 받음(기본값 없음)". 생략하면
  // opts.outboxDir은 undefined -> resolveValueOptions가 null로 정규화
  // -> 수집기 자체를 건너뛴다(기존 호출자 회귀 0).
  "--outbox-dir": (opts, v) => {
    opts.outboxDir = v;
  },
  // HYK-255-relay-aux-1 -- 둘 다 기본값 없음(--outbox-dir과 동일한
  // opt-in 관례). 생략하면 opts.relayGlob/opts.inboxDir은 undefined ->
  // resolveValueOptions가 null로 정규화 -> collectRelayLedger 자체를
  // 건너뛴다(기존 호출자 회귀 0).
  "--relay-glob": (opts, v) => {
    opts.relayGlob = v;
  },
  "--inbox-dir": (opts, v) => {
    opts.inboxDir = v;
  },
});

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const handler = CLI_FLAG_HANDLERS[argv[i]];
    if (handler) handler(opts, argv[++i]);
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
