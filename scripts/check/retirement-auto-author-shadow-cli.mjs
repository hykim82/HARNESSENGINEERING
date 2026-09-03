// HYK-419-wire-1 (coder-task.md §2⑵) -- retire-author-shadow의 CLI 진입점.
//
// ★왜 CLI로 분리했는가 (relay-handshake.mjs에 직접 정적 import하지 않은
// 이유): 이 파일이 처음 이 관측을 relay-handshake.mjs 안에 assembleAuto
// AuthorFacts/evaluateAutoAuthorAuthorization의 **정적 import**로 심었을
// 때, 이 저장소의 격리 픽스처 시험 24개(admission-completion-spawn.test.mjs
// 등 -- relay-handshake.mjs를 "정확히 알려진 형제 파일 목록"(time-authority/
// reject-streak/envelope-archive)만 복사해 격리 디렉터리에서 서브프로세스로
// 돌리는 시험들)가 전부 MODULE_NOT_FOUND로 깨졌다(실측: npm test 5819개 중
// 60개 실패). abort-record-writer.mjs/admission-completion-adapter.mjs가
// 이미 정확히 같은 이유로 "정적 import 대신 서브프로세스 스폰"을 쓰고
// 있었다(spawnAbortRecordWriter의 자기 주석: "a 5th static import ... would
// break module resolution for every one of those tests at LOAD time; a spawn
// only fails at CALL time, absorbed by the try/catch") -- 이 라운드는 그
// 선례를 그대로 따른다: relay-handshake.mjs는 이 파일을 정적 import하지
// 않고, `node retirement-auto-author-shadow-cli.mjs <role> <taskId>
// [harnessDir] [doneAt]`로 스폰만 한다. 이 CLI 파일 자신이 격리 픽스처에
// 없으면 스폰이 실패하고(child_process 에러), 부모(relay-handshake.mjs)의
// 자체 try/catch가 그 실패를 흡수한다 -- 이 파일이 있든 없든 소비 자체는
// 절대 막히지 않는다(coder-task.md §2⑷ 차단 0).
//
// ★계약: 이 CLI는 무엇을 하든 표준출력에 정확히 한 줄
// (`retire-author-shadow: ...`)을 찍고 **항상 exit 0**으로 끝난다 -- 판정
// 불가/조립 불가/예상 밖 예외 어느 것도 이 CLI 자신의 종료코드에 반영되지
// 않는다(부모가 exit code를 읽지 않고 stdout만 그대로 console.log하기
// 때문에, exit 0이 아니면 부모의 execFileSync가 예외를 던져 그 stdout 자체를
// 잃는다 -- 이 CLI는 그 경로를 만들지 않는다).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { assembleAutoAuthorFacts } from "./retirement-auto-author-facts.mjs";
import { evaluateAutoAuthorAuthorization } from "./retirement-auto-author-core.mjs";
import { PERSISTENT_LEDGER_POINTER_FILENAME } from "./ledger-pointer-shared.mjs";

// HYK-412 1R -- 이 CLI는 relay-handshake.mjs가 `env`를 명시로 넘기지 않고
// 스폰하는데(부모 환경을 상속), 그 환경변수(ADMISSION_LEDGER_PATH/
// DISPATCH_RECEIPT_PATH)를 세팅하는 주체가 실제 배달 경로 어디에도 없어
// 매번 undefined -> LEDGER_UNREADABLE로 죽었다(실측 5건, coder-task.md
// §1). 아래 두 resolve* 함수는 admission-completion-adapter.mjs의
// resolvePersistentLedgerPaths()(포인터 파일 `.harness/admission-ledger-
// path.json`, mainRepoRoot 기준 -- 모든 워크트리에서 같은 파일로
// 수렴한다)와 relay-handshake.mjs 자신의 resolveDispatchLedgerPath()
// (포인터 파일 `<harnessDir>/dispatch-receipt-path.txt`)와 **같은 개념**
// 이다 -- coder-task.md §2⑵ "이미 있는 관용구를 재사용하라, 새 방식을
// 발명하지 마라"에 따라 새로 지어내지 않았다. relay-handshake.mjs를
// 정적 import하지 않고 로직만 재현한 이유는 이 파일 자신의 헤더(위)가
// 이미 밝힌 것과 같다: 이 CLI가 relay-handshake.mjs의 전체 import
// 그래프(reject-streak/envelope-archive/time-authority 등)에 묶이면,
// admission-completion-spawn.test.mjs 등이 고정한 "정확히 이 4개 형제
// 파일만" 격리 픽스처 모양이 이 파일을 통해 다시 깨질 위험이 생긴다
// (admission-completion-adapter.mjs가 mainRepoRoot()/repoRoot()를
// import 대신 복제한 것과 동일한 이유, 그 파일 자신의 주석 참조).
//
// ⚠️ mainRepoRoot는 여기서 **git 서브프로세스를 스폰하지 않는다**(1차
// 구현은 admission-completion-adapter.mjs와 똑같이 `execSync("git ...",
// {cwd: harnessDir})`를 그대로 재현했으나, 그 1차 구현이 실측으로 드러낸
// 새 회귀가 있었다: 이 CLI는 매 소비마다 스폰되고(부모 relay-handshake.mjs
// 자신도 이미 이 CLI를 스폰한다, 3단 프로세스), harnessDir을 cwd로 git을
// 또 스폰하면 Windows에서 그 디렉터리가 곧이어 rmSync되는 시험 20개가
// EPERM(디렉터리 사용 중)으로 무더기 실패했다 -- npm test 재실행 실측,
// 이 라운드 자신의 1차 커밋에서 발견. git 서브프로세스가 필요한 진짜
// 이유는 "링크드 워크트리의 .git이 디렉터리가 아니라 상위 저장소를
// 가리키는 포인터 파일"이라는 사실 하나뿐이고, 그 사실은 git 바이너리 없이
// 파일시스템만으로도 그대로 읽을 수 있다(git 자신의 온디스크 규약 --
// `.git`가 파일이면 그 내용이 정확히 `gitdir: <메인>/.git/worktrees/
// <이름>`이다, 이 워크트리 자신의 `.git` 파일로 직접 확인). 아래는 그
// 파싱을 재현한 것 -- "git-common-dir을 구한다"는 목적은 그대로이고
// (같은 관용구, 다른 실행 수단), 서브프로세스 스폰 0이라 위 회귀 자체가
// 구조적으로 없다.
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function findGitEntry(startDir) {
  let dir = startDir;
  for (;;) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) return gitPath;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const WORKTREE_GITDIR_SUFFIX_RE = /[\\/]worktrees[\\/][^\\/]+[\\/]?$/;

function mainRepoRoot(startDir) {
  if (!isNonEmptyString(startDir)) return startDir;
  const gitPath = findGitEntry(startDir);
  if (!gitPath) return startDir;
  let stat;
  try {
    stat = statSync(gitPath);
  } catch {
    return startDir;
  }
  if (stat.isDirectory()) {
    // 메인 저장소 자신 -- .git이 디렉터리다, 그 부모가 곧 루트.
    return dirname(gitPath);
  }
  // 링크드 워크트리 -- .git은 "gitdir: <메인>/.git/worktrees/<이름>"
  // 한 줄짜리 파일이다(git 자신의 온디스크 규약).
  try {
    const raw = readFileSync(gitPath, "utf8").trim();
    const m = raw.match(/^gitdir:\s*(.+)$/);
    if (!m) return startDir;
    const worktreeGitDir = m[1].trim();
    if (!WORKTREE_GITDIR_SUFFIX_RE.test(worktreeGitDir)) return startDir;
    const mainGitDir = worktreeGitDir.replace(WORKTREE_GITDIR_SUFFIX_RE, "");
    return dirname(mainGitDir);
  } catch {
    return startDir;
  }
}

// admission-completion-adapter.mjs의 resolvePersistentLedgerPaths()와
// 같은 계약: 포인터 파일 부재/파싱 실패/빈 값은 전부 null(호출자가 "경로를
// 못 찾음"으로 접는다), 새 실패 모드를 얹지 않는다.
function resolvePersistentLedgerPath(harnessDir) {
  const pointerPath = join(
    mainRepoRoot(harnessDir),
    ".harness",
    PERSISTENT_LEDGER_POINTER_FILENAME,
  );
  if (!existsSync(pointerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
    return isNonEmptyString(parsed.ledgerPath) ? parsed.ledgerPath : null;
  } catch {
    return null;
  }
}

// relay-handshake.mjs의 DISPATCH_RECEIPT_POINTER_FILENAME과 같은 이름/같은
// 위치(harnessDir 바로 아래) -- 배달기가 이미 그 라운드의 harnessDir에
// 적어 두는 파일이므로 mainRepoRoot 조회조차 필요 없다.
const DISPATCH_RECEIPT_POINTER_FILENAME = "dispatch-receipt-path.txt";

function resolvePersistentReceiptPath(harnessDir) {
  if (!isNonEmptyString(harnessDir)) return null;
  try {
    const raw = readFileSync(
      join(harnessDir, DISPATCH_RECEIPT_POINTER_FILENAME),
      "utf8",
    ).trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

function resolveLedgerPathForShadow(harnessDir) {
  if (isNonEmptyString(process.env.ADMISSION_LEDGER_PATH)) {
    return process.env.ADMISSION_LEDGER_PATH;
  }
  return resolvePersistentLedgerPath(harnessDir);
}

function resolveReceiptPathForShadow(harnessDir) {
  if (isNonEmptyString(process.env.DISPATCH_RECEIPT_PATH)) {
    return process.env.DISPATCH_RECEIPT_PATH;
  }
  return resolvePersistentReceiptPath(harnessDir);
}

// coder-task.md §2⑶ -- "경로를 못 찾음"(env도 없고 포인터 파일도 없어 확인
// 자체를 못 함)과 "원장이 진짜 없음/손상"(경로는 확보했으나 그 경로의
// 파일을 못 읽음)을 같은 사유 코드로 뭉뚱그리지 않는다. facts.mjs 자신은
// 여전히 "경로 하드코딩/추측 0" 계약을 지킨다(호출자가 넘긴 값만 읽는다,
// 이 파일이 바뀌지 않는다) -- 구별은 여기, 호출자 쪽에서 "그 경로가 애초에
// resolve됐었는가"를 알고 있을 때만 라벨을 바꿔 붙인다.
function relabelUnresolvedPathReason(code, { ledgerPath, receiptPath }) {
  if (code === "LEDGER_UNREADABLE" && !isNonEmptyString(ledgerPath)) {
    return "LEDGER_PATH_UNRESOLVABLE";
  }
  if (code === "RECEIPT_UNREADABLE" && !isNonEmptyString(receiptPath)) {
    return "RECEIPT_PATH_UNRESOLVABLE";
  }
  return code;
}

export function buildShadowLine({ role, taskId, harnessDir, doneAt }) {
  try {
    const ledgerPath = resolveLedgerPathForShadow(harnessDir);
    const receiptPath = resolveReceiptPathForShadow(harnessDir);
    const assembled = assembleAutoAuthorFacts({
      role,
      harnessTaskLabel: taskId,
      harnessDir,
      ledgerPath,
      receiptPath,
      recordedAt: doneAt,
    });
    if (!assembled.ok) {
      const reason = relabelUnresolvedPathReason(assembled.code, {
        ledgerPath,
        receiptPath,
      });
      return `retire-author-shadow: ASSEMBLE_FAILED reason=${reason} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
    }
    const verdict = evaluateAutoAuthorAuthorization(assembled.facts);
    return `retire-author-shadow: JUDGED reason=${verdict.state} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
  } catch (err) {
    return `retire-author-shadow: OBSERVATION_ERROR reason=${err.message} label=${taskId} (shadow -- 아무것도 차단하지 않음)`;
  }
}

if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/retirement-auto-author-shadow-cli.mjs")
) {
  const [, , role, taskId, harnessDir, doneAt] = process.argv;
  console.log(buildShadowLine({ role, taskId, harnessDir, doneAt }));
  process.exit(0);
}
