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
import { homedir } from "node:os";
import path from "node:path";
import {
  createGitHubApprovalPort,
  createAnonymousFetchJson,
  measureRepoIdentity,
  readApproverAllowlist,
  APPROVAL_STATUS,
} from "./approval-authority-adapter.mjs";
import {
  loadEngineProfiles,
  getKnownEngines,
  getEngineAttr,
} from "../check/engine-profile.mjs";
import { parseWatchLog } from "./reach-report-core.mjs";
import {
  DEFAULT_WATCH_LOG_PATH,
  DEFAULT_STATE_PATH,
  EXTERNAL_EVIDENCE_STATE_KEY,
} from "./reach-report.mjs";
// HYK-255-g-aux-render-1 커밋 1 -- ㄱ-2 · ㄱ-6 보조 관측이 reject-streak 원장을
// «읽기만» 한다. 하드스톱 문턱은 그 모듈의 상수를 import 해서 따라간다(숫자
// 리터럴 금지). 두 모듈은 이미 설치기 목록(templates/harness-init/install.mjs
// 1113 · 1268)과 DISPATCH_GATE_DECISION_SIBLINGS 에 실려 있고, 이 파일
// (scripts/supervisor/partial-count-report.mjs)은 설치기·스테이징 목록 어디에도
// 없어서 새로 등록할 목록은 없다.
import { HARD_STOP_STREAK, loadLedger } from "../check/reject-streak.mjs";
import {
  loadChainLedger,
  checkAppendOnlyAll,
} from "../check/reject-streak-chain.mjs";
import {
  buildPartialCountReport,
  computeSuspectedStallResumeIntervals,
  computeCoverageGaps,
  buildDailyTickValues,
  parseKstTimestampMs,
  renderOutboxAuxNote,
  PERMISSION_CLASS,
  PERMISSION_ROOT_KIND,
  classifyPermissionDecision,
  deriveSeatRoots,
  parentDirOf,
  summarizePermissionRecords,
  renderPermissionCollectorDetail,
  UNCOUNTED_EXAMPLES_V1,
  UNCOUNTED_EXAMPLES_V2,
  UNCOUNTED_EXAMPLES_V3,
  GATE_TYPES,
  ABOLISHED_GATE_TYPES,
} from "./partial-count-core.mjs";

export const DEFAULT_DISPATCH_RECEIPTS_PATH =
  "D:/문서관리/하네스-관제실/dispatch-receipts.jsonl";
export const DEFAULT_WINDOW_HOURS = 24;
// HYK-255-ln-update-branch-1 커밋 3 (책임자 판정 1804 · 교정 1904) -- ㄱ-4 회차당 조회 상한.
// sha당 REST 최대 8회(수집기 예산 callBudget 8 -- 무변) x 1 = 회차당 최대 8회. 예약 감시
// (watch-run.mjs)는 이 기본값으로 부른다(상한 인자 없음). D1 상한(아래
// DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS 4)과 합쳐 회차당 최악 8 + 4 = 12 · 15분 회차 4개 =
// 시간당 최악 48(익명 한도 60 중 나머지 12 는 책임자 CI 판독 몫). 옛 값은 3(= 회차당 최대 24).
// 상한 밖 ㄱ-4 후보는 «미조회(예산)» 그대로다(숨김 0) -- 회차당 최신 1건만 조회한다.
export const DEFAULT_MAX_MERGE_CHECKS = 1;
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
    undecidableReasons: summarizeUndecidableReasons(verdicts),
  };
}

// HYK-255-g-aux-render-1 커밋 2 (D3 ⑵) -- UNDECIDABLE 판정의 사유 분포. 사유는
// 위 루프가 이미 받은 판정(verdict.evidence.reason -- approval-authority-adapter
// 의 APPROVAL_REASON 코드)에서 읽을 뿐이고 새 REST 호출은 없다. 사유가 없는
// 판정은 «사유 미상» 으로 센다(조용히 빼지 않는다).
function summarizeUndecidableReasons(verdicts) {
  const reasons = {};
  for (const v of verdicts) {
    if (v.status !== APPROVAL_STATUS.UNDECIDABLE) continue;
    const reason = v.evidence?.reason ?? "사유 미상";
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 수집 3-b (HYK-255-ln-github-anchor-1, 판정 2026-11-12 19:1x 1) -- ㄴ 독립
// 수집기 1호: GitHub 웹 «Update branch» 병합 커밋 후보. ㄱ-4 수집기와
// «독립»이다 (collectGate4Independent 의 후보·예산·판정을 건드리지 않는다).
//
// ⓘ 후보 = git 으로 고른다: 측정 창 안, origin/master 에 «도달 가능»(first-
//   parent 가 아니다 -- Update branch 병합 커밋은 PR 브랜치 쪽에 있다),
//   committer = GitHub <noreply@github.com>, 부모 정확히 2, 제목 «Merge
//   branch …». 사람 committer 일반 병합 · «Merge pull request» · 창 밖은
//   후보가 아니다(REST 호출 0).
// ⓘⓘ 확인 = 주입 fetchJson 으로 무인증 REST /repos/<owner>/<repo>/commits/
//   <sha> 한 번: commit.verification.verified === true · reason === "valid"
//   (서명 검증은 GitHub 서버 판정에 기댄다) · 서명 주체 committer.login ===
//   "web-flow" · 작성자 author.login + id 가 approvers 허용 목록(origin/
//   master 판본)의 사람.
// ⓘⓘⓘ 무인증 REST 예산 = 회차당 상한 maxChecks(기본 4 -- HYK-255-ln-update-branch-1
//   커밋 3 · 판정 1804/교정 1904 · 후보당 1회 = 회차당 최대 4 · 옛 기본 10 · 기존
//   maxMergeChecks 와 별개) -- 초과분은 «미조회(예산)» 이고 그 회차 ㄴ 분자 옆에 하한 표기
//   («확인 N건 이상 · 미조회 K») 가 붙는다(core 렌더). 403/429 도 판정 문면상 «미조회(예산)»의
//   한 갈래이고(표기 = «미조회(예산 · rate limit)» -- 진단 줄이 «예산» 과 나란한
//   별도 낱말로 찍지 않는다 · 검토 P2-2), 내부 필드는 uncheckedByRateLimit 로
//   따로 세며 재시도 0 이고 그 회차의 남은 후보는 더 조회하지 않는다(같은 IP 의
//   한도를 ㄱ-4 · 책임자 CI 판독과 나눠 쓴다). 그 밖 조회 실패(404 · 던짐 ·
//   모양 위반)도 확인이 아니고 «미조회»에 넣되 사유를 diagnostics 에 남긴다.
// ⛔캐시는 승인 권위가 아니다 -- 확인 N 은 «이 회차 REST 응답»으로만 세고
//   회차 사이에 남는 상태가 없다.
// HYK-255-ln-update-branch-1 (한용 확정 2026-11-13 15:3x · 책임자 판정 1705) --
//   분류가 확정됐다(GitHub 웹 Update branch 클릭 = ㄴ). 이 수집기가 «그 회차 REST
//   응답으로» 확인한 confirmedShas 만 ㄴ 분자(confirmedLnEvents)로 들어간다
//   (assemblePartialCountReportText). 미조회(예산 · rate limit · 조회 실패) ·
//   서명/작성자/sha 불일치 · 스테일 직전 값 · 창 밖은 분자 밖이다 -- 분자 ≠ 0 을
//   숨기지 않고, 미조회는 분자에 넣지 않는다. 창 = 위 후보 고름의 24시간 그대로
//   (과거를 따로 재집계하지 않는다 -- 후보가 창에서 빠지면 분자에서도 빠진다).
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS = 4;

const CANDIDATE_LOG_FIELD_SEP = "\x1f";
const CANDIDATE_LOG_FORMAT = ["%H", "%cI", "%P", "%cn", "%ce", "%s"].join(
  "%x1f",
);
// 실물 합산 6주 표본이 27건 -- 창(기본 24h)을 한참 넘는 여유.
const CANDIDATE_LOG_MAX_MERGES = 500;
const GITHUB_WEB_COMMITTER_NAME = "GitHub";
const GITHUB_WEB_COMMITTER_EMAIL = "noreply@github.com";
const GITHUB_WEB_FLOW_LOGIN = "web-flow";
const UPDATE_BRANCH_SUBJECT_RE = /^Merge branch /;

function isUpdateBranchLogFields(fields) {
  const parents = fields[2].split(" ").filter(Boolean);
  return (
    parents.length === 2 &&
    fields[3] === GITHUB_WEB_COMMITTER_NAME &&
    fields[4] === GITHUB_WEB_COMMITTER_EMAIL &&
    UPDATE_BRANCH_SUBJECT_RE.test(fields[5])
  );
}

export async function collectUpdateBranchCandidates({
  git,
  windowStartMs,
  windowEndMs,
}) {
  let result;
  try {
    result = await git.run([
      "log",
      "--merges",
      `--format=${CANDIDATE_LOG_FORMAT}`,
      "-n",
      String(CANDIDATE_LOG_MAX_MERGES),
      "origin/master",
    ]);
  } catch (err) {
    return { ok: false, detail: err?.message ?? String(err) };
  }
  if (!result || result.code !== 0) {
    return { ok: false, detail: result?.stderr || "git log failed" };
  }
  const candidates = [];
  for (const line of String(result.stdout).split(/\r?\n/)) {
    const c = parseUpdateBranchLogLine(line, windowStartMs, windowEndMs);
    if (c) candidates.push(c);
  }
  return { ok: true, candidates };
}

// 로그 한 줄 -> 창 안 Update branch 후보 {sha, tsMs} | null.
function parseUpdateBranchLogLine(line, windowStartMs, windowEndMs) {
  const fields = line.split(CANDIDATE_LOG_FIELD_SEP);
  if (fields.length !== 6 || !/^[0-9a-f]{40}$/.test(fields[0])) return null;
  const tsMs = Date.parse(fields[1]);
  if (Number.isNaN(tsMs) || tsMs < windowStartMs || tsMs > windowEndMs) {
    return null;
  }
  return isUpdateBranchLogFields(fields) ? { sha: fields[0], tsMs } : null;
}

// 응답 한 건 -> {kind: "rateLimited"|"failure"|"response", ...}. throw 0.
async function fetchCommitResponse(fetchJson, url) {
  let resp;
  try {
    resp = await fetchJson({ url });
  } catch (err) {
    return { kind: "failure", detail: `조회 예외: ${err?.message ?? err}` };
  }
  if (!resp || typeof resp !== "object") {
    return { kind: "failure", detail: "응답 모양 위반(객체 아님)" };
  }
  if (resp.status === 403 || resp.status === 429) {
    return { kind: "rateLimited", detail: `HTTP ${resp.status}` };
  }
  if (resp.networkError || typeof resp.status !== "number") {
    return {
      kind: "failure",
      detail: `조회 실패: ${resp.detail ?? "상태 코드 없음"}`,
    };
  }
  if (!resp.ok) return { kind: "failure", detail: `HTTP ${resp.status}` };
  return { kind: "response", json: resp.json };
}

function hasWellFormedCommitShape(json, sha) {
  const v = json?.commit?.verification;
  return (
    json !== null &&
    typeof json === "object" &&
    json.sha === sha &&
    v !== null &&
    typeof v === "object" &&
    typeof v.verified === "boolean"
  );
}

function isAllowlistedAuthor(author, allowlist) {
  return (
    author !== null &&
    typeof author === "object" &&
    allowlist.approvers.some(
      (a) => a.login === author.login && a.id === author.id,
    )
  );
}

// 서명 확인 -- 이 한 함수가 «확인»의 전부다(서명 · 서명 주체 · 작성자).
function isVerifiedAllowlistedWebMerge(json, allowlist) {
  const v = json.commit.verification;
  return (
    v.verified === true &&
    v.reason === "valid" &&
    json.committer?.login === GITHUB_WEB_FLOW_LOGIN &&
    isAllowlistedAuthor(json.author, allowlist)
  );
}

async function readExternalEvidenceAllowlist({ git, allowlistPath }) {
  const identity = await measureRepoIdentity({ git });
  if (!identity.ok) {
    return { ok: false, reason: `저장소 신원 측정 실패: ${identity.detail}` };
  }
  const ref = await git.run(["rev-parse", "origin/master"]);
  if (!ref || ref.code !== 0) {
    return {
      ok: false,
      reason: "origin/master 해석 실패(허용 목록 읽기 불가)",
    };
  }
  const read = await readApproverAllowlist({
    git,
    allowlistPath,
    expectedRepoFullName: identity.repoFullName,
    expectedRefSha: String(ref.stdout).trim(),
  });
  if (!read.ok) {
    return {
      ok: false,
      reason: `허용 목록 읽기 실패(${read.reason}): ${read.detail}`,
    };
  }
  return {
    ok: true,
    allowlist: read.allowlist,
    repoFullName: identity.repoFullName,
  };
}

export async function collectExternalEvidenceCandidates({
  fetchJson,
  git,
  allowlistPath,
  windowStartMs,
  windowEndMs,
  maxChecks = DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS,
}) {
  const cand = await collectUpdateBranchCandidates({
    git,
    windowStartMs,
    windowEndMs,
  });
  if (!cand.ok) {
    return { known: false, reason: `후보 고름 실패: ${cand.detail}` };
  }
  const out = {
    known: true,
    candidatesInWindow: cand.candidates.length,
    checked: 0,
    confirmed: 0,
    notConfirmed: 0,
    uncheckedByBudget: 0,
    uncheckedByRateLimit: 0,
    uncheckedByFailure: 0,
    confirmedShas: [],
    diagnostics: [],
  };
  if (cand.candidates.length > 0) {
    const read = await readExternalEvidenceAllowlist({ git, allowlistPath });
    if (!read.ok) return { known: false, reason: read.reason };
    await checkCandidates({
      out,
      candidates: cand.candidates,
      fetchJson,
      allowlist: read.allowlist,
      repoFullName: read.repoFullName,
      budget: Number.isFinite(maxChecks)
        ? Math.max(0, Math.floor(maxChecks))
        : 0,
    });
  }
  out.unchecked =
    out.uncheckedByBudget + out.uncheckedByRateLimit + out.uncheckedByFailure;
  return out;
}

async function checkCandidates({
  out,
  candidates,
  fetchJson,
  allowlist,
  repoFullName,
  budget,
}) {
  let rateLimited = false;
  for (const c of candidates) {
    if (rateLimited || out.checked >= budget) {
      out.uncheckedByBudget += 1;
      continue;
    }
    out.checked += 1;
    const url = `https://api.github.com/repos/${repoFullName}/commits/${c.sha}`;
    const r = await fetchCommitResponse(fetchJson, url);
    if (r.kind === "rateLimited") {
      rateLimited = true;
      out.uncheckedByRateLimit += 1;
      out.diagnostics.push(
        `${c.sha.slice(0, 7)} 미조회(예산 · rate limit: ${r.detail})`,
      );
    } else if (r.kind === "failure") {
      out.uncheckedByFailure += 1;
      out.diagnostics.push(`${c.sha.slice(0, 7)} ${r.detail}`);
    } else if (!hasWellFormedCommitShape(r.json, c.sha)) {
      out.uncheckedByFailure += 1;
      out.diagnostics.push(`${c.sha.slice(0, 7)} 응답 모양 위반`);
    } else if (isVerifiedAllowlistedWebMerge(r.json, allowlist)) {
      out.confirmed += 1;
      out.confirmedShas.push(c.sha);
    } else {
      out.notConfirmed += 1;
    }
  }
}

// HYK-255-g7-key-stale-1 (커밋 3) -- 스테일 표기용 직전 확인값. 그 회차에 미조회가
// 있어(미조회 > 0) «확인 N» 이 직전 확인값보다 낮게 나왔으면, 이미 쓰는 감시 상태
// 파일(reach-notify-state.json -- 감시 로그와 같은 watch 폴더 · reach-report.mjs 가
// 쓰는 `__externalEvidenceCandidates` {confirmed, atMs})의 값을 externalEvidence
// .stalePrevious 로 «표시용으로만» 붙인다. ⛔confirmed · unchecked 는 건드리지 않는다
// (직전 값은 확인이 아니다 -- ㄴ 분자 무변 · 캐시는 승인 권위 아님) · REST 호출 0 ·
// 새 CLI 인자 0 · 새 파일 0. 상태 파일이 없거나 깨졌거나 직전 확인이 없으면(0 ·
// 숫자 아님) 붙이지 않는다 -- 조용히 옛 문면 그대로다.
function readExternalEvidencePrevious({ watchLogPath, readFn }) {
  try {
    const statePath = path.join(
      path.dirname(watchLogPath),
      path.basename(DEFAULT_STATE_PATH),
    );
    const entry = JSON.parse(readFn(statePath, "utf8"))?.[
      EXTERNAL_EVIDENCE_STATE_KEY
    ];
    if (!Number.isInteger(entry?.confirmed) || entry.confirmed <= 0) {
      return null;
    }
    return {
      confirmed: entry.confirmed,
      atMs: Number.isFinite(entry.atMs) ? entry.atMs : null,
    };
  } catch {
    return null;
  }
}

function attachExternalEvidenceStale({
  externalEvidence,
  watchLogPath,
  readFn,
  nowMs,
}) {
  if (externalEvidence?.known !== true || !(externalEvidence.unchecked > 0)) {
    return externalEvidence;
  }
  const previous = readExternalEvidencePrevious({ watchLogPath, readFn });
  if (!previous || previous.confirmed <= externalEvidence.confirmed) {
    return externalEvidence;
  }
  return { ...externalEvidence, stalePrevious: { ...previous, nowMs } };
}

// 수집기가 던져도(예: 주입 포트 결함) 보고 전체를 죽이지 않는다 -- 수집
// 실패(사유)로 표면화한다.
async function collectExternalEvidenceSafely(args) {
  try {
    return await collectExternalEvidenceCandidates(args);
  } catch (err) {
    return {
      known: false,
      reason: `수집기 예외: ${err?.message ?? String(err)}`,
    };
  }
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
// 오탐 방지 ⓑ -- ㄱ-7 짝 키(HYK-255-g7-key-stale-1 판정 1110 (가)): 보내는함 파일
// 이름의 `판정-<HHMM>` 머리 «또는» 이름 어디든 `상신<HHMM>` 토큰에서 HHMM을 뽑아
// 받는함의 `상신` 파일과 대조한다. ⛔이 정규식이 짝 키의 «유일한» 정의다 -- D2
// 보조 ㄱ-7 짝 수(collectGate7AuxCell)와 기존 «ㄱ-7 기록 누락» 계수
// (isGate7MissingCandidate)가 둘 다 parseGate7PairKey 를 거쳐 이 한 곳에서 읽는다.
// 4자리 뒤에 숫자가 더 이어지면(5자리 이상) HHMM 이 아니다 · `상신-1830` 처럼
// 하이픈이 끼면 토큰이 아니다 · «상신» 뒤가 아닌 다른 4자리(게이트 번호 · 시각 아닌
// 숫자)는 키가 아니다.
// HYK-255-g7-token-diag-1 (판정 1410 ⓑ) -- «상신HHMM» 토큰 경계: «상신» 바로 앞이
// 글자 또는 숫자(유니코드 \p{L} · \p{N})면 토큰이 아니다(«미상신1530» · «X상신1530» ·
// «3상신1530» = 키 아님 -- 부정 접두 오탐 방지). «상신» 앞이 이름 시작이거나 글자·숫자가
// 아닌 문자(구분자: `-` `_` 공백 `.` `(` `[` `+` 등 -- 글자·숫자의 여집합 «전부»)면 토큰이다.
// ⛔이 경계도 같은 한 정의 안에 있다(보조 ㄱ-7 · «기록 누락» 공용).
// HYK-255-ln-update-branch-1 (책임자 판정 2026-11-13 17:0x 항목 2 · #370 검토 1R 상신 대상 ①) --
// `판정-HHMM` 머리도 «상신» 과 같은 경계다: «판정-» 바로 앞이 글자 또는 숫자면 키가 아니다
// («…-미판정-1530» · «X판정-1530» · «3판정-1530» = 키 아님). 이름 시작이거나 글자·숫자가 아닌
// 문자(구분자 · 기호)면 키다(«…-판정-1530» · 이름 시작 «판정-1530»). 경계는 두 머리가 «한 번»
// 공유한다(lookbehind 를 갈라 두 번 쓰지 않는다 -- 한 정의 유지).
const GATE7_PAIR_TOKEN_RE = /(?<![\p{L}\p{N}])(?:판정-|상신)(\d{4})(?!\d)/gu;

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

// ㄱ-7 짝 키(보내는함 판정 파일 이름) -- {date: 이름 머리 날짜, hhmms: 서로 다른
// HHMM 토큰들}. 두 모양이 한 이름에 같이 있어도 같은 HHMM 은 한 번만 담긴다(중복
// 0). 날짜 머리가 없거나 토큰이 하나도 없으면 null(키 아님).
function parseGate7PairKey(name) {
  const dateHhmm = parseLedgerFileNameDateHhmm(name);
  if (!dateHhmm) return null;
  const hhmms = extractGate7PairTokens(name);
  return hhmms.length > 0 ? { date: dateHhmm.date, hhmms } : null;
}

// 이름에서 ㄱ-7 짝 키 HHMM 토큰만 뽑는다(등장 순서 · 같은 HHMM 은 한 번). 날짜 머리 검사는
// 하지 않는다 -- 그건 parseGate7PairKey 몫. 토큰 정의(GATE7_PAIR_TOKEN_RE)를 읽는
// «유일한» 함수라 시험이 경계(이름 시작 포함)를 바로 구동할 수 있다.
export function extractGate7PairTokens(name) {
  return [...new Set([...name.matchAll(GATE7_PAIR_TOKEN_RE)].map((t) => t[1]))];
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
  return {
    source: "S1",
    name,
    quote: q[1],
    number: numberM ? numberM[1] : null,
    timeMs: parseLedgerFileNameTimestampMs(name),
    // P2-4: ㄱ-7 짝 대조의 날짜는 이 출처 파일 자신의 이름 머리 `YYYY-MM-DD`에서
    // 구조로 뽑는다(판정 토큰은 HHMM만 갖고 있다) -- parseGate7PairKey 가 한 곳.
    gate7PairKey: parseGate7PairKey(name),
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

// 오탐 방지 ⓑ -- 대응 없는 S1 항목이라도 파일 이름에 ㄱ-7 짝 키(`판정-<HHMM>` 머리
// 또는 이름 어디든 `상신<HHMM>`)가 있고 받는함에 "같은 날짜 + 같은 HHMM"의 `상신`
// 파일이 있으면 "ㄱ-7 기록 누락"으로 따로 센다(ㄴ 후보 아님). P2-4: 날짜·HHMM 둘 다
// 파일 이름의 구조화된 토큰으로 대조한다 -- 부분 문자열 포함(`includes`)만으로는
// 다른 날 같은 HHMM, 또는 이름 어딘가에 같은 네 자리가 낀 파일까지 짝으로 잡는다
// (이 라운드 변이③의 표적).
function isGate7MissingCandidate({ item, inboxNames }) {
  if (item.source !== "S1" || !item.gate7PairKey) return false;
  const key = item.gate7PairKey;
  return (inboxNames ?? []).some((n) => {
    if (!n.includes("상신")) return false;
    const parsed = parseLedgerFileNameDateHhmm(n);
    return (
      parsed !== null &&
      parsed.date === key.date &&
      key.hhmms.includes(parsed.hhmm)
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
  // 전달 파일의 자기 분류 라벨은 폐지된 ㄱ-5 도 여전히 쓸 수 있다(과거
  // 항목) -- 분모(GATE_TYPES)에서 5 가 빠져도 이 집계 키를 지우면 그 라벨이
  // 아래 가드에서 «조용히 버려진다». 그래서 번호 순으로 폐지 목록을 합친다.
  const labelGates = [...GATE_TYPES, ...ABOLISHED_GATE_TYPES].sort(
    (a, b) => a.number - b.number,
  );
  for (const g of labelGates) tally[`ㄱ-${g.number}`] = 0;
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
// 수집 6(보조, HYK-255-g-aux-render-1 커밋 1 · PM 진단 §(b) · §(d) D2) -- ㄱ
// «보조 관측(독립 아님)» 4종. 이미 있는 ORCH · 책임자가 쓸 수 있는 파일을
// «읽기만» 센다 -- ⛔독립 앵커가 아니다(B · C 등급): 독립 앵커 유형 커버리지
// (INDEPENDENT_ANCHOR_COVERED_GATE_NUMBERS)의 분자 · 분모에 절대 넣지 않는다.
//   ㄱ-1 = 보내는함 파일 이름 «게이트1» 의 창 안 개수
//   ㄱ-2 = reject-streak 원장에서 streak 가 «2 로 올라서는 전이»가 창 안인 이슈 수
//   ㄱ-6 = 같은 원장에서 streak 가 하드스톱 문턱(HARD_STOP_STREAK)에 «닿는 전이»가
//          창 안인 이슈 수
//   ㄱ-7 = 받는함 «상신» 중 보내는함 «판정-HHMM» 머리 또는 «…상신HHMM…» 토큰과
//          날짜 + HHMM 짝이 있는 수(짝 대조 = 기존 isGate7MissingCandidate 재사용 ·
//          짝 키 = parseGate7PairKey 한 정의 -- 기존 «ㄱ-7 기록 누락» 계수도 같은 키)
// 창 = runPartialCountOnce 가 쓰는 보고서 창(windowStartMs..windowEndMs) 그대로
// -- 새 창 상수 0. 파일 기반 칸(ㄱ-1 · ㄱ-7)은 보내는함 보조 수집기
// (collectOutboxHeaderCounts)와 같은 «파일 mtime 이 창 안» 규칙이다.
// ⛔못 읽은 칸은 bare 0 이 아니라 {known:false, reason}: 폴더 읽기 실패 ·
// 원장 읽기 실패 · 원장 없음 · 체인(해시 체인 검증 실패 또는 체인 파일 없음).
// 체인은 ㄱ-2 와 ㄱ-6 이 같은 원장에서 나오므로 두 칸이 같이 실패로 낸다.
// ---------------------------------------------------------------------------

const GATE1_OUTBOX_NAME_RE = /게이트1(?!\d)/;
// ㄱ-2 = «연속 반려 2 회에 닿는» 전이(북극성-좌표 §1-C 게이트 2 · PM 진단 §(b)).
const GATE2_STREAK_THRESHOLD = 2;

function listWindowMdNames({
  dir,
  label,
  windowStartMs,
  windowEndMs,
  readdirFn,
  statFn,
}) {
  if (!dir) return { known: false, reason: `미결선(${label} 경로 미지정)` };
  let names;
  try {
    names = readdirFn(dir);
  } catch (err) {
    return {
      known: false,
      reason: `${label} 읽기 실패: ${err && err.message ? err.message : String(err)}`,
    };
  }
  const inWindow = [];
  let readFailures = 0;
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let st;
    try {
      st = statFn(path.join(dir, name));
    } catch {
      readFailures += 1;
      continue;
    }
    if (st.mtimeMs >= windowStartMs && st.mtimeMs <= windowEndMs) {
      inWindow.push(name);
    }
  }
  return { known: true, names: inWindow, readFailures };
}

function collectGate1AuxCell(outboxListing) {
  if (outboxListing.known !== true) {
    return { known: false, reason: outboxListing.reason };
  }
  return {
    known: true,
    count: outboxListing.names.filter((n) => GATE1_OUTBOX_NAME_RE.test(n))
      .length,
    readFailures: outboxListing.readFailures,
  };
}

// 보내는함 ㄱ-7 짝 키가 있는 파일 이름 -> isGate7MissingCandidate 가 읽는 S1 항목
// 모양(extractOutboxQuoteItem 과 같은 parseGate7PairKey 한 정의).
function buildOutboxPanjeongItem(name) {
  const gate7PairKey = parseGate7PairKey(name);
  if (!gate7PairKey) return null;
  return { source: "S1", gate7PairKey };
}

function collectGate7AuxCell({ outboxListing, inboxListing }) {
  if (outboxListing.known !== true) {
    return { known: false, reason: outboxListing.reason };
  }
  if (inboxListing.known !== true) {
    return { known: false, reason: inboxListing.reason };
  }
  const items = outboxListing.names
    .map(buildOutboxPanjeongItem)
    .filter((item) => item !== null);
  const count = inboxListing.names
    .filter((n) => n.includes("상신"))
    .filter((n) =>
      items.some((item) => isGate7MissingCandidate({ item, inboxNames: [n] })),
    ).length;
  return {
    known: true,
    count,
    readFailures: outboxListing.readFailures + inboxListing.readFailures,
  };
}

// 원장 + 체인 읽기·검증. 실패는 전부 {ok:false, reason, detail} -- 0 으로 접지
// 않는다. 체인 검증은 reject-streak-chain.mjs 의 checkAppendOnlyAll(변조 «탐지»
// 일 뿐 방지가 아니다 -- 원장과 체인을 둘 다 다시 쓰면 못 잡는다).
function readVerifiedRejectStreakLedger({ repoRoot, readFn, existsFn }) {
  const ledgerPath = path.join(repoRoot, ".harness", "reject-streak.json");
  const chainPath = path.join(repoRoot, ".harness", "reject-streak-chain.json");
  const io = { readFileFn: (p) => readFn(p, "utf8"), existsFn };
  const loaded = loadLedger(ledgerPath, io);
  if (loaded.ok !== true) {
    return { ok: false, reason: "원장 읽기 실패", detail: loaded.reason };
  }
  if (loaded.existed !== true) {
    return { ok: false, reason: "원장 없음", detail: ledgerPath };
  }
  const chain = loadChainLedger(chainPath, io);
  if (chain.ok !== true) {
    return { ok: false, reason: "체인", detail: chain.reason };
  }
  if (chain.existed !== true) {
    return {
      ok: false,
      reason: "체인",
      detail: `체인 파일 없음: ${chainPath}`,
    };
  }
  const verdict = checkAppendOnlyAll({
    primaryLedger: loaded.ledger,
    chain: chain.chain,
  });
  if (verdict.ok !== true) {
    const firstBad = verdict.results.find((r) => r.status === "BLOCK");
    return {
      ok: false,
      reason: "체인",
      detail: `${verdict.reason} -- ${firstBad ? firstBad.reason : "사유 미상"}`,
    };
  }
  return { ok: true, ledger: loaded.ledger };
}

// 이슈별로 streak 를 처음부터 접어(반려 +1 · 그 밖 0 -- reject-streak.mjs
// applyOutcome 과 같은 규칙) «threshold 미만 -> threshold 이상으로 올라서는»
// 전이를 찾는다. 현재 값이 threshold 이상이라는 사실만으로는 전이가 아니다(2->3
// 은 새 전이 아님). 전이 시각 = 그 항목의 at. 이슈 수로 센다.
function findStreakCrossingTimes(history, threshold) {
  const times = [];
  let run = 0;
  for (const entry of history) {
    const before = run;
    run = entry?.verdict === "rejected" ? run + 1 : 0;
    if (before < threshold && run >= threshold) {
      times.push(parseKstTimestampMs(entry?.at));
    }
  }
  return times;
}

function countStreakTransitions({
  ledger,
  threshold,
  windowStartMs,
  windowEndMs,
}) {
  let count = 0;
  let undated = 0;
  for (const issue of Object.values(ledger.issues ?? {})) {
    const times = findStreakCrossingTimes(issue?.history ?? [], threshold);
    if (
      times.some((t) => t !== null && t >= windowStartMs && t <= windowEndMs)
    ) {
      count += 1;
    } else if (times.includes(null)) {
      undated += 1;
    }
  }
  return { known: true, count, undated };
}

function collectLedgerAuxCells({
  repoRoot,
  hardStopStreak,
  windowStartMs,
  windowEndMs,
  readFn,
  existsFn,
}) {
  const read = readVerifiedRejectStreakLedger({ repoRoot, readFn, existsFn });
  if (read.ok !== true) {
    const failed = { known: false, reason: read.reason, detail: read.detail };
    return { gate2: failed, gate6: failed };
  }
  const range = { ledger: read.ledger, windowStartMs, windowEndMs };
  return {
    gate2: countStreakTransitions({
      ...range,
      threshold: GATE2_STREAK_THRESHOLD,
    }),
    gate6: countStreakTransitions({ ...range, threshold: hardStopStreak }),
  };
}

export function collectGateAuxObservations({
  repoRoot,
  outboxDir,
  inboxDir,
  windowStartMs,
  windowEndMs,
  hardStopStreak = HARD_STOP_STREAK,
  readdirFn = readdirSync,
  readFn = readFileSync,
  statFn = statSync,
  existsFn = existsSync,
}) {
  const list = (dir, label) =>
    listWindowMdNames({
      dir,
      label,
      windowStartMs,
      windowEndMs,
      readdirFn,
      statFn,
    });
  const outboxListing = list(outboxDir, "보내는함");
  const inboxListing = list(inboxDir, "받는함");
  return {
    gate1: collectGate1AuxCell(outboxListing),
    ...collectLedgerAuxCells({
      repoRoot,
      hardStopStreak,
      windowStartMs,
      windowEndMs,
      readFn,
      existsFn,
    }),
    gate7: collectGate7AuxCell({ outboxListing, inboxListing }),
  };
}

// HYK-255-g-aux-render-1 -- outboxDir 이 없으면(= 기존 모든 호출자 · 보내는함이
// 결선되지 않은 실행) 이 보조 수집기 자체를 부르지 않는다(줄 0개 · 회귀 0 --
// resolveOutboxResult 와 같은 opt-in 관례).
function resolveGateAuxResult({
  outboxDir,
  inboxDir,
  repoRoot,
  windowStartMs,
  windowEndMs,
  readdirFn,
  readFn,
  statFn,
  existsFn,
}) {
  return outboxDir
    ? collectGateAuxObservations({
        repoRoot,
        outboxDir,
        inboxDir,
        windowStartMs,
        windowEndMs,
        readdirFn,
        readFn,
        statFn,
        existsFn,
      })
    : null;
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

// ---------------------------------------------------------------------------
// HYK-255-p5a-perm-1 (판정 0105 ④ · P5 설계 (가)) -- ㄴ 유형 4 «권한 확인창 답» 수집기.
//
// Claude Code 세션 기록(jsonl, 뿌리 두 곳 <홈>/.claude/projects · <홈>/.claude-team/projects, 하위 subagents 포함)을
// «읽기만» 한다. 줄 1개 = JSON 1개 -- 이 수집기가 «여는» 칸은 아래뿐이다:
//   줄: type · uuid · timestamp · cwd · sessionId · version · entrypoint · permissionDecision{decision, source}
//   message.content[] 의 항목 형식(type)과 tool_use_id · tool_use 항목의 id · name
// ⛔대화 본문(message.content 의 text · content · input, toolUseResult 값)은 읽지도, 결과·보고·일별 줄에 싣지도 않는다.
// 회차 사이 상태(바이트 위치 캐시) 0 -- 매 회차 창(회차 −24h ~ 회차) 안 줄을 처음부터 다시 읽는다(캐시는 승인 권위 아님 ·
// 판정 1910). 읽을 파일 = mtime ≥ 창 시작인 jsonl 뿐이고, 줄은 `"permissionDecision"` 또는 `"tool_result"` 문자열이 있는
// 것만 JSON 해석한다.
//
// ⛔정직 한계: Claude Code 전용 원천이다(codex 좌석 기록은 이 원천에 없다 -- 엔진 무관 아님). 판정 칸은 CLI 2.1.322
// 이후 판부터 있어 그 앞 날은 «필드 없는 세션(S)» 으로 수집 실패다. SDK 세션은 자기 설정 규칙도 user_* 로 적혀 사람
// 클릭이 아닐 수 있다(SDK j건을 따로 적는다). 세션 jsonl 은 같은 계정 파일이라 지우거나 고치면 사람 답을 숨길 수 있다(B 등급).
// ---------------------------------------------------------------------------
// 세션 뿌리 이름(홈 아래 폴더 이름)은 엔진 프로필 설정(scripts/check/engine-profiles.json 의 homeDirName ·
// teamDirName)에서 «읽는다» -- 이 파일에 엔진 이름 문자열을 새로 적지 않는다(engine-name-literal 기준선 · HYK-153).
// 해당 칸이 null 인 엔진(세션 기록이 이 형식이 아닌 엔진)은 뿌리가 없다.
function permissionRootDirs(profiles = loadEngineProfiles()) {
  const dirs = [];
  const seen = new Set();
  for (const engine of getKnownEngines(profiles)) {
    for (const [attr, rootName] of [
      ["homeDirName", PERMISSION_ROOT_KIND.HOME],
      ["teamDirName", PERMISSION_ROOT_KIND.TEAM],
    ]) {
      const dirName = getEngineAttr(engine, attr, profiles);
      if (typeof dirName !== "string" || dirName === "") continue;
      if (seen.has(dirName)) continue;
      seen.add(dirName);
      dirs.push({ rootName, segments: [dirName, "projects"] });
    }
  }
  return dirs;
}
const PERMISSION_WALK_MAX_DEPTH = 8;
const PERMISSION_LINE_FILTERS = Object.freeze([
  '"permissionDecision"',
  '"tool_result"',
]);

// 뿌리 하나의 jsonl 목록(하위 폴더 포함 · mtime ≥ 창 시작). 뿌리 자체를 못 읽으면 throw -- 호출자가 수집 실패로 접는다.
function walkPermissionRoot({ root, readdirFn, statFn, windowStartMs }) {
  const files = [];
  let failures = 0;
  const visit = (dir, depth, isRoot) => {
    let names;
    try {
      names = readdirFn(dir);
    } catch (err) {
      if (isRoot) throw err;
      failures += 1;
      return;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      let st;
      try {
        st = statFn(p);
      } catch {
        failures += 1;
        continue;
      }
      if (st.isDirectory()) {
        if (depth < PERMISSION_WALK_MAX_DEPTH) visit(p, depth + 1, false);
      } else if (name.endsWith(".jsonl") && st.mtimeMs >= windowStartMs) {
        files.push(p);
      }
    }
  };
  visit(root, 0, true);
  return { files, failures };
}

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const strOrNull = (v) => (typeof v === "string" ? v : null);

// message.content 항목 중 type 이 `type` 인 것들 -- 항목의 «형식 이름(type)» 만 보고 고른다(본문 칸은 열지 않는다).
function contentItemsOfType(o, type) {
  const content = isPlainObject(o?.message) ? o.message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.filter((item) => isPlainObject(item) && item.type === type);
}

function sessionKeyOf(o, filePath) {
  return typeof o.sessionId === "string" && o.sessionId !== ""
    ? o.sessionId
    : `file:${filePath}`;
}

// 줄 1개(파싱된 객체) -> 레코드들. «쓰는 칸만» 옮긴다 -- 나머지 칸(본문 포함)은 여기서 버려진다.
function recordsFromLine(o, { rootName, filePath }) {
  const hasDecision = Object.hasOwn(o, "permissionDecision");
  const toolUseIds = contentItemsOfType(o, "tool_result").map((item) =>
    strOrNull(item.tool_use_id),
  );
  if (!hasDecision && toolUseIds.length === 0) return [];
  const pd = o.permissionDecision;
  const base = {
    sessionKey: sessionKeyOf(o, filePath),
    uid: strOrNull(o.uuid),
    atMs: typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN,
    cwd: strOrNull(o.cwd),
    rootName,
    entrypoint: strOrNull(o.entrypoint),
    version: strOrNull(o.version),
    hasDecision,
    decision: isPlainObject(pd)
      ? { decision: pd.decision, source: pd.source }
      : null,
    toolName: null,
  };
  const ids = toolUseIds.length > 0 ? toolUseIds : [null];
  return ids.map((toolUseId) => ({ ...base, toolUseId }));
}

// 도구 이름을 찾을 «사람 답 후보»(판정 칸이 있고 자동이 아닌 것)의 tool_use_id 들.
function wantedToolUseIds(records) {
  const wanted = new Map();
  for (const r of records) {
    if (
      r.hasDecision &&
      r.toolUseId !== null &&
      classifyPermissionDecision(r.decision) !== PERMISSION_CLASS.AUTO
    ) {
      wanted.set(r.toolUseId, null);
    }
  }
  return wanted;
}

// raw 줄이 tool_use 를 담고 찾는 id 중 하나를 문자열로 포함할 때만 JSON 해석한다.
function toolUseItemsOfLine(raw, wanted) {
  if (!raw.includes('"tool_use"')) return [];
  if (![...wanted.keys()].some((id) => raw.includes(id))) return [];
  try {
    return contentItemsOfType(JSON.parse(raw), "tool_use");
  } catch {
    return [];
  }
}

// 사람 답 후보 레코드의 도구 이름 -- 같은 파일의 tool_use 항목(id · name)만 본다.
function attachToolNames(records, lines) {
  const wanted = wantedToolUseIds(records);
  if (wanted.size === 0) return;
  for (const raw of lines) {
    for (const item of toolUseItemsOfLine(raw, wanted)) {
      if (wanted.has(item.id)) wanted.set(item.id, strOrNull(item.name));
    }
  }
  for (const r of records) {
    if (wanted.has(r.toolUseId)) r.toolName = wanted.get(r.toolUseId);
  }
}

// 파일 1개의 텍스트 -> {records, parseFailures}.
function extractPermissionRecords({ text, rootName, filePath }) {
  const lines = text.split("\n");
  const records = [];
  let parseFailures = 0;
  for (const raw of lines) {
    if (!PERMISSION_LINE_FILTERS.some((needle) => raw.includes(needle))) {
      continue;
    }
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      parseFailures += 1;
      continue;
    }
    if (isPlainObject(o)) {
      records.push(...recordsFromLine(o, { rootName, filePath }));
    }
  }
  attachToolNames(records, lines);
  return { records, parseFailures };
}

// 수집기 본체. 홈(homeDir)과 통역 폴더(interpreterRoot = --outbox-dir 의 부모)만 받는다 -- 새 CLI 인자 0.
// 반환 = summarizePermissionRecords 결과 + {filesScanned, readFailures, parseFailures} | {known:false, reason}.
const errorMessageOf = (err) =>
  err && err.message ? err.message : String(err);

// 읽을 파일 목록 -- {targets, readFailures} | {known:false, reason}. 뿌리 하나라도 못 읽으면 수집 실패(조용한 0 금지).
function listPermissionTargets({ homeDir, readdirFn, statFn, windowStartMs }) {
  let rootDirs;
  try {
    rootDirs = permissionRootDirs();
  } catch (err) {
    return {
      known: false,
      reason: `엔진 프로필 읽기 실패(${errorMessageOf(err)})`,
    };
  }
  const targets = [];
  let readFailures = 0;
  for (const { rootName, segments } of rootDirs) {
    try {
      const walked = walkPermissionRoot({
        root: path.join(homeDir, ...segments),
        readdirFn,
        statFn,
        windowStartMs,
      });
      readFailures += walked.failures;
      targets.push(...walked.files.map((filePath) => ({ rootName, filePath })));
    } catch (err) {
      return {
        known: false,
        reason: `세션 뿌리 읽기 실패(${rootName}: ${err && err.code ? err.code : "오류"})`,
      };
    }
  }
  return { targets, readFailures };
}

// 파일들 -> {records, readFailures, parseFailures}. 파일 하나를 못 읽어도 나머지는 센다(실패는 값으로 남는다).
function readPermissionTargets(targets, readFn) {
  const records = [];
  let readFailures = 0;
  let parseFailures = 0;
  for (const { rootName, filePath } of targets) {
    let text;
    try {
      text = readFn(filePath, "utf8");
    } catch {
      readFailures += 1;
      continue;
    }
    const extracted = extractPermissionRecords({ text, rootName, filePath });
    records.push(...extracted.records);
    parseFailures += extracted.parseFailures;
  }
  return { records, readFailures, parseFailures };
}

export function collectPermissionAnswers({
  homeDir,
  interpreterRoot,
  windowStartMs,
  windowEndMs,
  readdirFn = readdirSync,
  readFn = readFileSync,
  statFn = statSync,
}) {
  const roots = deriveSeatRoots({ homeDir, interpreterRoot });
  if (roots.main === null || roots.interpreter === null) {
    return {
      known: false,
      reason: "세션 뿌리 경로 파생 실패(홈 또는 통역 폴더 경로 없음)",
    };
  }
  const listing = listPermissionTargets({
    homeDir,
    readdirFn,
    statFn,
    windowStartMs,
  });
  if (listing.known === false) return listing;
  const read = readPermissionTargets(listing.targets, readFn);
  return {
    ...summarizePermissionRecords({
      records: read.records,
      windowStartMs,
      windowEndMs,
      roots,
    }),
    filesScanned: listing.targets.length,
    readFailures: listing.readFailures + read.readFailures,
    parseFailures: read.parseFailures,
  };
}

// --outbox-dir 가 주어졌을 때만 이 수집기를 부른다(미결선 호출자 회귀 0 · 새 CLI 인자 0). 예기치 못한 throw 는
// 보고 전체를 죽이지 않고 수집 실패(사유)로 접는다 -- 0 으로 접지 않는다.
function resolvePermissionResult({
  outboxDir,
  sessionHomeDir,
  windowStartMs,
  windowEndMs,
  readdirFn,
  readFn,
  statFn,
}) {
  if (!outboxDir) return null;
  try {
    return collectPermissionAnswers({
      homeDir: sessionHomeDir ?? homedir(),
      interpreterRoot: parentDirOf(outboxDir),
      windowStartMs,
      windowEndMs,
      readdirFn,
      readFn,
      statFn,
    });
  } catch (err) {
    return {
      known: false,
      reason: `수집기 오류(${err && err.message ? err.message : String(err)})`,
    };
  }
}

// 수집기 «진단 줄». 필드 없는 세션(S) · 읽기 실패는 수집 실패(FAIL)다 -- 그날 끊김. 미결선 = 줄 0개.
function buildPermissionCollectorEntry(permissionResult) {
  if (!permissionResult) return null;
  const name = "권한기록수집기";
  const ok =
    permissionResult.known === true &&
    !(permissionResult.fieldMissingSessions > 0) &&
    !(permissionResult.readFailures > 0);
  return {
    name,
    ok,
    detail: renderPermissionCollectorDetail(permissionResult),
  };
}

function buildCollectors({
  deliveredResult,
  consumedResult,
  watchOk,
  watchSkipped,
  gate4,
  outboxResult,
  externalEvidence,
  gateAux,
  permissionResult,
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
  collectors.push(buildIndependentLnCollectorEntry(externalEvidence));
  const outboxEntry = buildOutboxCollectorEntry(outboxResult);
  if (outboxEntry) collectors.push(outboxEntry);
  const externalEntry = buildExternalEvidenceCollectorEntry(externalEvidence);
  if (externalEntry) collectors.push(externalEntry);
  const gateAuxEntry = buildGateAuxCollectorEntry(gateAux);
  if (gateAuxEntry) collectors.push(gateAuxEntry);
  const permissionEntry = buildPermissionCollectorEntry(permissionResult);
  if (permissionEntry) collectors.push(permissionEntry);
  return collectors;
}

// HYK-255-g-aux-render-1 -- ㄱ 보조 관측 4칸의 «진단 줄»(관측 건강). 보고서 ㄱ 절
// 줄은 문면 고정 1줄(칸마다 짧은 사유)이라, 실패한 칸의 자세한 사유(체인이 어느
// 이슈에서 깨졌는지 등)는 여기에 남는다. 한 칸이라도 못 읽었으면 FAIL.
function buildGateAuxCollectorEntry(gateAux) {
  if (!gateAux) return null;
  const cells = [
    ["ㄱ-1", gateAux.gate1],
    ["ㄱ-2", gateAux.gate2],
    ["ㄱ-6", gateAux.gate6],
    ["ㄱ-7", gateAux.gate7],
  ];
  const parts = cells.map(([label, cell]) =>
    cell.known === true
      ? `${label} OK`
      : `${label} FAIL(${cell.reason}${cell.detail ? `: ${cell.detail}` : ""})`,
  );
  return {
    name: "ㄱ보조관측수집기",
    ok: cells.every(([, cell]) => cell.known === true),
    detail: parts.join(" · "),
  };
}

// HYK-255-ln-update-branch-1 -- «독립ㄴ수집기» 진단 줄의 사실 문면. 옛 줄은 «FAIL(부재 --
// 이 라운드 결선 없음 · ㄴ 확인은 원리적으로 불가)» 였지만 이제 Update branch 확인이 ㄴ
// 분자라(외부독립증거후보수집기) 수집기가 돈 회차에 그 문면은 사실이 아니다.
//   - 외부 증거 입력 없음(미결선 호출자): 옛 문면 그대로(그 호출자에겐 사실이다).
//   - 수집 실패(known:false): FAIL(수집 실패: 사유) -- 조용히 «확인 0건» 으로 접지 않는다.
//   - 수집 성공: OK -- 다만 Update branch 한 유형만 결선이라는 사실을 줄에 남긴다.
function buildIndependentLnCollectorEntry(externalEvidence) {
  const name = "독립ㄴ수집기";
  if (!externalEvidence) {
    return {
      name,
      ok: false,
      detail: "부재 — 이 라운드 결선 없음(ㄴ 확인은 원리적으로 불가)",
    };
  }
  if (externalEvidence.known !== true) {
    return {
      name,
      ok: false,
      detail: `수집 실패: ${externalEvidence.reason ?? "사유 미상"}`,
    };
  }
  return {
    name,
    ok: true,
    detail:
      "GitHub 웹 Update branch 확인분만 결선(외부독립증거후보수집기) — 그 밖 ㄴ 유형은 결선 없음",
  };
}

// HYK-255-ln-github-anchor-1 -- 새 수집기의 «진단 줄»(관측 건강). ㄴ 절 줄은
// 문면 고정 1줄이라 미조회 사유의 내역(예산 · rate limit · 조회 실패와 그
// 사유)은 여기에 남는다.
function buildExternalEvidenceCollectorEntry(externalEvidence) {
  if (!externalEvidence) return null;
  const name = "외부독립증거후보수집기";
  if (externalEvidence.known !== true) {
    return { name, ok: false, detail: externalEvidence.reason };
  }
  const e = externalEvidence;
  const parts = [
    `후보 ${e.candidatesInWindow}건 · 조회 ${e.checked}건 · 확인 ${e.confirmed}`,
    `서명·작성자 불일치 ${e.notConfirmed}`,
    // 403/429(rate limit)는 판정 문면 «미조회(예산)» 안에 묶어 «예산(rate limit 포함)»
    // 으로 적는다(검토 P2-2). 합 = 예산 + rate limit, 그중 rate limit 은 따로 병기.
    `미조회: 예산(rate limit 포함) ${e.uncheckedByBudget + e.uncheckedByRateLimit}(그중 rate limit ${e.uncheckedByRateLimit}) · 조회 실패 ${e.uncheckedByFailure}`,
  ];
  // HYK-255-g7-token-diag-1 (판정 1410 ⓐ · «예산 낙차는 진단 줄로») -- 미조회 때문에
  // 확인이 직전 확인값보다 떨어진 회차(stalePrevious 가 붙은 회차 = 미조회 > 0 이고
  // 직전 확인 M > 이번 확인 N)에만 «낙차 M→N(미조회)» 1토막. 낙차 없는 회차엔 0토막.
  // ⛔표시일 뿐이다 -- 확인 N · ㄴ 분자 · 통지 조건 · 장 수는 이 토막과 무관하다.
  if (e.stalePrevious) {
    parts.push(`낙차 ${e.stalePrevious.confirmed}→${e.confirmed}(미조회)`);
  }
  if (e.diagnostics.length > 0) parts.push(e.diagnostics.join("; "));
  return { name, ok: true, detail: parts.join(" · ") };
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
    maxExternalEvidenceChecks:
      options.maxExternalEvidenceChecks ?? DEFAULT_MAX_EXTERNAL_EVIDENCE_CHECKS,
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
    // HYK-255-p5a-perm-1 -- 세션 기록 홈(기본 = os.homedir()). 시험이 합성 홈을 주입한다. 새 CLI 인자 아님.
    sessionHomeDir: options.sessionHomeDir ?? null,
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

// externalEvidence(collectExternalEvidenceCandidates 결과) -> ㄴ 분자 사건 배열.
// known !== true(수집 실패 · 미결선)면 [] -- 0 으로 «접는» 것이 아니라 줄은 따로
// «수집 실패(사유)» 로 찍힌다. stalePrevious 는 표시 전용이라 여기 들어오지 않는다.
function buildConfirmedLnEvents(externalEvidence) {
  if (externalEvidence?.known !== true) return [];
  return externalEvidence.confirmedShas.map((sha) => ({
    source: "GitHub 웹 Update branch(외부 독립 증거)",
    ref: sha,
  }));
}

function assemblePartialCountReportText({
  now,
  windowStartMs,
  windowEndMs,
  deliveredResult,
  consumedResult,
  watch,
  gate4,
  externalEvidence,
  // 보조 수집기 묶음 {outboxResult, relayResult, gateAux} -- runPartialCountOnce 의
  // eslint max-lines-per-function 예산 때문에 한 덩어리로 받는다(값 · 순서 무변).
  aux,
  // HYK-255-p1-daily-1 -- watch-run 일별 단계가 만든 «연속 확인-0 일수» 줄(없으면 undefined = 새 줄 0개).
  confirmedZeroStreakLine,
}) {
  const { outboxResult, relayResult, gateAux, permissionResult } = aux;
  return buildPartialCountReport({
    permissionAnswers: permissionResult ?? undefined,
    confirmedZeroStreakLine,
    generatedAtMs: now,
    windowStartMs,
    windowEndMs,
    delivered: deliveredResult.delivered,
    consumed: consumedResult.consumed,
    missingReceipts: deriveMissingReceipts(deliveredResult, consumedResult),
    gate4,
    auxNote: outboxResult ? renderOutboxAuxNote(outboxResult) : undefined,
    uncountedExamples: selectUncountedExamples({ outboxResult, relayResult }),
    // ㄴ 분자 = 독립 수집기가 «그 회차 REST 응답으로» 확인한 사건뿐이다(확인 없음 =
    // [] = «확인 0건» 렌더링). HYK-255-ln-update-branch-1 -- Update branch 수집기의
    // 확인분(confirmedShas)이 분류 확정(한용 2026-11-13 15:3x)으로 여기에 들어간다.
    // 수집 실패(known:false) · 미조회 · 불일치 · 스테일 직전 값은 confirmedShas 에 없다.
    confirmedLnEvents: buildConfirmedLnEvents(externalEvidence),
    externalEvidence,
    suspected: watch.suspected,
    collectors: buildCollectors({
      deliveredResult,
      consumedResult,
      watchOk: watch.watchOk,
      watchSkipped: watch.skipped,
      gate4,
      outboxResult,
      externalEvidence,
      gateAux,
      permissionResult,
    }),
    lastAliveMs: watch.lastAliveMs,
    coverageGaps: watch.coverageGaps,
    relayLedgerResult: relayResult,
    // HYK-255-g-aux-render-1 -- ㄱ 보조 관측(독립 아님). null -> 줄 0개.
    gateAuxObservation: gateAux ?? undefined,
  });
}

// HYK-255-p1-daily-1 -- 일별 마감 줄의 «이 회차 값». 보고문이 방금 센 값과 같은 원천(같은 externalEvidence ·
// 같은 수집기 목록 · 같은 미계수 예시 선택)에서 뽑는다 -- 재조회 0 · REST 무증가. 순수(buildCollectors ·
// selectUncountedExamples 는 읽기·계산만이라 assemblePartialCountReportText 와 한 번 더 불러도 같은 값).
function buildDailyTick({
  deliveredResult,
  consumedResult,
  watch,
  gate4,
  externalEvidence,
  aux,
  windowStartMs,
}) {
  const { outboxResult, relayResult, gateAux, permissionResult } = aux;
  return buildDailyTickValues({
    windowStartMs,
    externalEvidence,
    permissionAnswers: permissionResult ?? undefined,
    collectors: buildCollectors({
      deliveredResult,
      consumedResult,
      watchOk: watch.watchOk,
      watchSkipped: watch.skipped,
      gate4,
      outboxResult,
      externalEvidence,
      gateAux,
      permissionResult,
    }),
    delivered: deliveredResult.delivered,
    uncountedExamples: selectUncountedExamples({ outboxResult, relayResult }),
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
  maxExternalEvidenceChecks,
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
  // HYK-255-ln-github-anchor-1 -- ㄱ-4 와 독립인 ㄴ 후보 수집기(자기 상한).
  const externalEvidence = attachExternalEvidenceStale({
    externalEvidence: await collectExternalEvidenceSafely({
      fetchJson,
      git,
      allowlistPath,
      windowStartMs,
      windowEndMs,
      maxChecks: maxExternalEvidenceChecks,
    }),
    watchLogPath,
    readFn,
    nowMs: windowEndMs,
  });
  return { deliveredResult, consumedResult, watch, gate4, externalEvidence };
}

// HYK-255-relay-aux-1 -- runPartialCountOnce 본문이 relayResult 한 줄
// 추가로 max-lines-per-function(상한 80) 예산을 넘겼다(실측 81). 보조
// 수집기 두 개(outbox·relay) 호출만 떼어낸다 -- 로직·순서·값은 원문과
// 완전히 동일.
function resolveAuxCollectorResults({
  outboxDir,
  relayGlob,
  inboxDir,
  sessionHomeDir,
  repoRoot,
  windowStartMs,
  windowEndMs,
  readdirFn,
  readFn,
  statFn,
  existsFn,
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
  const gateAux = resolveGateAuxResult({
    outboxDir,
    inboxDir,
    repoRoot,
    windowStartMs,
    windowEndMs,
    readdirFn,
    readFn,
    statFn,
    existsFn,
  });
  const permissionResult = resolvePermissionResult({
    outboxDir,
    sessionHomeDir,
    windowStartMs,
    windowEndMs,
    readdirFn,
    readFn,
    statFn,
  });
  return { outboxResult, relayResult, gateAux, permissionResult };
}

export async function runPartialCountOnce(options = {}) {
  const {
    now,
    windowHours,
    maxMergeChecks,
    maxExternalEvidenceChecks,
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
    sessionHomeDir,
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

  const { deliveredResult, consumedResult, watch, gate4, externalEvidence } =
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
      maxExternalEvidenceChecks,
      readFn,
      readdirFn,
      existsFn,
      gitWorktreeListExecFn,
    });

  const aux = resolveAuxCollectorResults({
    outboxDir,
    relayGlob,
    inboxDir,
    sessionHomeDir,
    repoRoot,
    windowStartMs,
    windowEndMs,
    readdirFn,
    readFn,
    statFn,
    existsFn,
  });

  return buildPartialCountOnceResult({
    now,
    windowStartMs,
    windowEndMs,
    deliveredResult,
    consumedResult,
    watch,
    gate4,
    externalEvidence,
    aux,
    confirmedZeroStreakLine: options.confirmedZeroStreakLine,
  });
}

// 보고문 조립 + 결과 모양 -- runPartialCountOnce 에서 떼어낸 것(eslint max-lines-per-function 예산,
// HYK-255-p1-daily-1 이 dailyTick 한 칸을 더하면서 80줄을 넘었다). 결과의 키 · 값 · 순서는 원문 그대로이고
// `dailyTick`(일별 마감 줄의 «이 회차 값»)만 새로 붙는다.
function buildPartialCountOnceResult({
  now,
  windowStartMs,
  windowEndMs,
  deliveredResult,
  consumedResult,
  watch,
  gate4,
  externalEvidence,
  aux,
  confirmedZeroStreakLine,
}) {
  const reportText = assemblePartialCountReportText({
    now,
    windowStartMs,
    windowEndMs,
    deliveredResult,
    consumedResult,
    watch,
    gate4,
    externalEvidence,
    aux,
    confirmedZeroStreakLine,
  });
  return {
    reportText,
    dailyTick: buildDailyTick({
      deliveredResult,
      consumedResult,
      watch,
      gate4,
      externalEvidence,
      aux,
      windowStartMs,
    }),
    gate4,
    externalEvidence,
    suspected: watch.suspected,
    coverageGaps: watch.coverageGaps,
    ...aux,
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
