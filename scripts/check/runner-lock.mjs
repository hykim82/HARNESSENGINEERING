// HYK-494: machine-wide mutual-exclusion lock for isolated-suite-runner.mjs.
//
// §1 왜 (coder-task.md §1, ORCH 직접 영수증 대조): 두 작업 공간(워크트리)의
// 전건 러너가 같은 시각에 돌아 서로의 메모리/CPU를 갉아먹고, 그 경합이
// 이 저장소와 무관한 시험(hyk387 등, 시계·파일 경합에 민감)을 빨갛게
// 만들었다 -- 레인마다 "직전 node 수를 재고 비면 시작"(parallel_rule)이라는
// 자기 측정 규율뿐이라, 두 좌석이 같은 박자로 재면 둘 다 "0"을 보고 같이
// 시작할 수 있었다. 이 모듈은 그 경합을 코드로(사람 규율이 아니라) 막는다
// -- 저장소 밖, 머신 전체가 보는 고정 경로의 잠금 파일 하나로.
//
// §1-2 왜 2R인가 (HYK-494-runner-lock-1-review-1 §4, rejected): 1R의 고아
// 회수는 "읽고 → 판단 → 무조건 지운다"였다 -- 두 진입자가 같은 죽은-pid
// 잠금을 동시에 보면 둘 다 "회수"하고 둘 다 시험을 돌렸다(실측 10회 중
// 7회 완전 겹침). "읽기 실패(빈 내용·막 지워짐)=고아" 판정은 멀쩡히 막
// 잡힌 새 주인의 잠금을 3자 경합에서 지웠다(50회 중 3회). 영수증에는
// 앞 소유자·대기 시작/끝이 없었다(명시 계약 미이행). 중첩 우회 표시는
// 값의 진위를 전혀 보지 않아 바깥 셸이 아무 값이나 켜면 통째로 꺼졌다.
// 이 2R은 그 네 가지를 고친다 -- §2(회수) · §6(영수증) · §8(우회) ·
// §12(heartbeat) 참조.
//
// §2 범위: 이 모듈은 잠금 그 자체(획득/대기/고아 회수/해제)만 안다.
// 어디서 잠그고 언제 푸는지(측정·시험 실행 전/후)는 isolated-suite-
// runner.mjs의 몫이다 -- 두 관심사를 한 파일에 섞으면 잠금 자체의 단위
// 시험이 전건 클론·spawn 없이는 돌 수 없게 된다.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 저장소 밖, 머신 공용 고정 경로 -- HYK-494 2R 선택 ②: os.homedir() 아래
// 고정 이름. os.tmpdir()에서 homedir()로 바꾼 근거(review P2-4): tmpdir()
// 은 프로세스의 TEMP/TMP를 따른다 -- 좌석(또는 사용자 세션)마다 TEMP가
// 다르면 잠금 파일이 갈라져 상호 배제가 애초에 성립하지 않는다(실측:
// TEMP를 바꾸면 os.tmpdir()의 반환값도 바뀐다). os.homedir()은 사용자
// 계정 단위로 고정이고 세션/프로세스의 환경변수에 좌우되지 않는다 --
// "이 사용자가 돌리는 모든 워크트리/세션이 같은 파일을 본다"는 이
// 모듈의 유일한 존재 이유(§1)에 더 가깝다. 여전히 "다른 사용자 계정"
// 경계는 못 막는다(§11-2, 정직 한계 그대로).
export const DEFAULT_LOCK_FILENAME = "harness-isolated-suite-runner.lock";

export function defaultRunnerLockPath({ homedirFn = homedir } = {}) {
  return join(homedirFn(), DEFAULT_LOCK_FILENAME);
}

// 중첩 실행 신호 -- isolated-suite-runner.mjs의 NESTED_CONCURRENCY_ENV_VAR
// (HARNESS_TEST_CONCURRENCY)와 같은 자리의 메커니즘: 잠금을 "실제로" 쥔
// 프로세스가 이 env var를 자기 process.env에 심어 두면, 그 프로세스가
// (직접 또는 간접으로, env는 spawn 때마다 ...process.env로 계속 상속되는
// 한) 띄우는 모든 자식이 이 값을 본다. isolated-suite-runner.test.mjs
// 자신이 CLI를 자식으로 띄워 구동하는 시험들(이 라운드 ⓐ⑵ grep으로 확인한
// 유일한 "러너가 러너를 자식으로 띄우는" 지점)이 전건 러너의 clone 안에서
// 돌 때, 이 신호가 없으면 바깥 러너가 쥔 잠금을 자식이 다시 기다리다
// 교착한다(바깥은 그 자식이 끝나길 spawnSync로 동기 대기 중이므로 서로
// 영원히 못 풂).
//
// HYK-494 2R P2-1 수리: 이 값의 "의미"가 바뀐다 -- 1R은 pid를 심었고
// acquireRunnerLock은 값이 "있기만 하면" 무조건 믿었다(review 재현: 바깥
// 셸이 아무 값이나 켜면 살아 있는 주인이 있어도 0ms로 통과). 2R은 이
// 값에 "지금 쥐고 있는 잠금의 토큰"(아래 lockId, 잠금 파일에만 기록되는
// 난수)을 심는다 -- 그 값이 "지금 그 경로의 잠금 파일"의 lockId와
// 정확히 같을 때만 우회한다(§8). 바깥에서 값을 손으로 켜도, 그 값이 그
// 순간 그 경로의 진짜 lockId와 같을 수 없으므로(난수) 더 이상 통과하지
// 못한다.
export const NESTED_LOCK_BYPASS_ENV_VAR = "HARNESS_RUNNER_LOCK_HELD_BY";

// 대기 간격·상한 -- 이름 붙은 상수 + 근거 1줄(product_scope ⓘⓘ).
// 간격 1초: 이 저장소의 전건 러너는 수십 초~분 단위(runner_axis 주석,
// 실측 ~623초)로 걸리므로, 더 촘촘한 폴링은 CPU만 태우고 체감 대기 시간을
// 줄이지 못한다.
export const LOCK_POLL_INTERVAL_MS = 1000;
// 상한 20분: 이 저장소가 실측한 가장 긴 전건 러너(~623초 ≈ 10.4분, 위
// 주석 인용)의 약 2배 -- 정상적인 앞선 실행이 끝나길 기다리는 시간으로는
// 충분히 넉넉하고, 죽지 않은 채 걸린(진짜 교착/매우 느린 머신) 경우를
// 무한정 기다리지 않고 "시험 0 + 구분된 사유"로 끝내기 위한 바깥 울타리다.
export const LOCK_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

// HYK-494 2R 선택 ① heartbeat -- 이름 붙은 간격·기한 + 근거(product_scope
// ⓘⓘⓘⓘ "전건 러너 최장 소요보다 heartbeat 간격이 짧아야 한다").
// 30초: 이 저장소의 전건 러너 최장 실측(~623초)보다 훨씬 촘촘해서, 사이드카
// 프로세스(§12, 메인 스레드의 spawnSync 블로킹과 무관하게 독립적으로 돈다)
// 가 정상 실행 내내 여러 번(약 20회) 갱신을 남긴다.
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;
// 90초(간격의 3배): 한 번의 tick이 일시적인 스케줄링 지연으로 늦어도 바로
// orphan으로 오판하지 않을 여유를 주면서도, LOCK_WAIT_TIMEOUT_MS(20분)
// 보다 훨씬 작아 pid 재사용/신호사망(§7-1) 상황에서 다른 러너들이 20분을
// 다 기다리지 않게 한다.
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 3;

// Atomics.wait 기반 동기 sleep -- isolated-suite-runner.mjs의
// defaultSleepSync와 같은 근거(이 파일도 synchronous 호출 그래프를 유지
// 한다: acquireRunnerLock은 폴링 "중"에는 async/await을 쓰지 않는다 --
// 호출자인 runIsolatedSuite 자체가 이미 전부 동기식이므로, 여기서만
// 비동기로 바꾸면 그 호출자 쪽에 await 전파가 필요해진다).
function defaultSleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, Math.max(0, Number(ms) || 0));
}

// 이 머신에 그 pid가 "살아 있는가" -- signal 0은 실제로 신호를 보내지
// 않고 프로세스 존재/권한만 검사한다(Node 문서 공식 동작, POSIX·Windows
// 양쪽에서 동작 확인). ESRCH(또는 Windows의 대응 에러)면 죽은 pid ->
// false. 다른 에러(EPERM 등, 남의 pid라 권한이 없어 존재는 확인되는 경우)
// 는 "존재는 한다"로 보아 true -- 살아있는지 모르겠으면 "살아있다"(보수적
// 으로 기다리는 쪽, 섣부른 회수로 두 실행이 겹치는 사고보다 안전하다).
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

// HYK-494 2R P1-1(둘째 발견): "읽기 실패"와 "고아"는 다른 사실이다 --
// JSON.parse가 던지는 이유는 파일이 아예 없음(ENOENT, 방금 지워짐/아직
// 안 생김)이거나 쓰는 중이라 내용이 비었거나 깨졌을 때(같은 tryClaim의
// writeFileSync는 한 호출이지만, 다른 프로세스가 "그 사이"를 보는 경쟁은
// 이론상 배제되지 않는다)뿐이다. 둘 다 "고아"(죽은 주인)라는 증거가
// 아니다 -- {ok:false}를 돌려주면 호출자가 그냥 "바쁘다"로 보고 폴링을
// 한 바퀴 더 돈다(다음 바퀴의 tryClaim이 파일이 진짜 사라졌으면 스스로
// 성공한다, 회수/unlink 없이).
function readLockContentResult(readFileFn, lockPath) {
  try {
    return { ok: true, content: JSON.parse(readFileFn(lockPath, "utf8")) };
  } catch {
    return { ok: false, content: null };
  }
}

// ⛔정직 한계(pid 재사용): 죽은 pid는 명확히 죽었다(ESRCH) -- 그 방향의
// 회수는 안전하다. 반대 방향(그 pid가 이미 "다른", 전혀 무관한 새
// 프로세스에게 재사용되어 "살아있다"로 보이는 경우)는 pid 신호만으로는
// 구분할 수 없다 -- HYK-494 2R은 그 방향을 heartbeat(§12)로 보강한다:
// aliveAtMs가 staleMs를 넘겨 멈췄다는 것은 "그 pid가 (재사용되었든
// 아니든) 더 이상 '그 때 그 잠금을 쥔 프로세스'가 아니다"라는 증거다 --
// heartbeat 정보가 전혀 없는(구버전/합성 fixture) 잠금은 이 축을 아예
// 건너뛴다(pid-alive만으로 판단, 1R 칸 무회귀).
function isOrphan({ content, isPidAliveFn, nowMs, heartbeatStaleMs }) {
  if (!content || !Number.isInteger(content.pid)) return true;
  if (!isPidAliveFn(content.pid)) return true;
  if (!Number.isFinite(content.aliveAtMs)) return false;
  return nowMs() - content.aliveAtMs > heartbeatStaleMs;
}

function tryClaim({ lockPath, writeFileFn, content }) {
  try {
    writeFileFn(lockPath, JSON.stringify(content), { flag: "wx" });
    return true;
  } catch (err) {
    if (err.code === "EEXIST") return false;
    // ⛔잠금 경로 자체가 쓰기 불가(ENOENT: 디렉터리 부재 · EACCES 등) --
    // 이 함수의 유일한 존재 이유가 "상호 배제를 보장한다"인데, 쓰기가
    // 안 되면 그 보장을 할 수도, 안 할 수도 없는 상태다. 조용히 "그냥
    // 잠긴 걸로 치고 진행"하면 상호 배제가 거짓으로 참인 척하게 되므로
    // (이 모듈이 막으려는 사고를 스스로 재현), 여기서는 삼키지 않고
    // 그대로 던진다 -- 호출자(runIsolatedSuite)가 이 예외로 전체 러너를
    // 실패시킨다(초록으로 접히지 않는다, product_scope ⓘⓘⓘⓘⓘⓘ).
    throw err;
  }
}

// 두 잠금 내용이 "같은 그 잠금"을 가리키는가 -- pid/startedAtMs/lockId
// 세 값 모두 같아야 한다(lockId는 난수라 이것만으로도 충분히 유일하지만,
// pid/startedAtMs까지 같이 보는 것은 "비교 후 삭제"가 정확히 무엇을
// 비교하는지 코드만 읽어도 알 수 있게 하기 위한 중복 방어다).
function sameLockIdentity(a, b) {
  return (
    !!a &&
    !!b &&
    a.pid === b.pid &&
    a.startedAtMs === b.startedAtMs &&
    a.lockId === b.lockId
  );
}

// HYK-494 2R P1-1(첫째 발견) 수리 -- 고아 회수를 "비교 후 삭제"로:
//
// 1R은 isOrphan이 true면 그냥 unlinkSync(lockPath)였다 -- 읽은 시점과
// 지우는 시점 사이에 다른 진입자가 먼저 지우고 새로 잡으면, 그 "새
// 주인의" 잠금을 지웠다(10회 중 7회 완전 겹침 재현, review §2 ⓑ⑶).
//
// 이 함수는 product_scope의 힌트("고유 이름으로 rename → 옮긴 내용 대조
// → 다르면 되돌리고 대기")를 그대로 따르되, 그 힌트의 글자 그대로("되돌릴
// 때 rename으로 덮어쓰기")는 자신이 복원하는 그 순간에 "세 번째 진입자"가
// 이미 새로 잡은 잠금을 덮어써 지울 수 있다는 구멍이 있어 한 군데
// 강화한다: 복원은 rename이 아니라 linkSync(hard link, "그 이름이 없을
// 때만 생긴다" -- EEXIST로 실패하면 이미 누가 잡았다는 뜻)로 한다.
//
// 1. renameSync(lockPath, tempPath) -- 원자적 "훔치기": 이 이름을 가진
//    파일을 다른 이름으로 옮기는 호출은 같은 원본 경로를 두고 경쟁하는
//    모든 호출 중 정확히 하나만 성공한다(나머지는 ENOENT -- 원본이 이미
//    사라졌으므로). 성공한 쪽은 "그 순간 그 경로에 있던 내용"을 배타적
//    으로 손에 넣는다.
// 2. 그 내용을 읽어 "우리가 애초에 고아라고 판단한 그 내용"과 비교한다.
// 3. 같으면: 진짜 그 죽은 주인의 잠금이었다 -- tempPath를 지우고 끝
//    (reclaimed:true).
// 4. 다르면: 우리가 읽은 뒤 rename하기 전 사이에 누군가 새로 잠금을
//    잡았다는 뜻 -- 그 새 주인의 것을 지우면 안 된다. linkSync로
//    되돌린다(이름이 비어 있으면 성공, 그 사이 "세 번째" 진입자가 이미
//    같은 이름으로 또 새로 잡았으면 EEXIST로 실패 -- 그 경우 우리는
//    그냥 아무것도 되돌리지 않는다, 세 번째 진입자의 몫을 덮어쓰지
//    않는다). 어느 쪽이든 tempPath는 치운다(reclaimed:false,
//    reason:"mismatch" -- 호출자는 이걸 "지금은 살아있는 다른 주인이
//    있다"로 보고 평범하게 기다린다).
function tryReclaimOrphan({
  lockPath,
  expectedContent,
  renameFn,
  linkFn,
  unlinkFn,
  readFileFn,
  pid,
  nowMs,
}) {
  const tempPath = `${lockPath}.reclaim.${pid}.${nowMs()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    renameFn(lockPath, tempPath);
  } catch {
    // 훔치기 자체가 실패(ENOENT 등) -- 이미 사라졌다(진짜 해제됐거나 다른
    // 회수자가 먼저 가져갔다). "회수할 것이 없었다"일 뿐, 실패가 아니다
    // -- 다음 바퀴의 tryClaim이 스스로 판단한다.
    return { reclaimed: false, reason: "gone" };
  }
  let movedContent = null;
  try {
    movedContent = JSON.parse(readFileFn(tempPath, "utf8"));
  } catch {
    // leaves movedContent at its null default -- an unreadable moved file
    // can never match expectedContent below, so it takes the restore path.
  }
  if (sameLockIdentity(movedContent, expectedContent)) {
    try {
      unlinkFn(tempPath);
    } catch {
      // best-effort -- 이미 우리 소유의 임시 이름이라 지우기 실패는 공간
      // 누수일 뿐, 상호 배제 불변식(이 잠금은 더는 lockPath에 없다)에는
      // 영향이 없다.
    }
    return { reclaimed: true, reason: "matched" };
  }
  try {
    linkFn(tempPath, lockPath);
  } catch {
    // EEXIST -- 되돌리는 그 틈에 세 번째 진입자가 이미 lockPath를
    // 다시 잡았다. 그 진입자의 몫을 덮어쓰지 않는 것이 핵심이라 여기서는
    // 아무것도 하지 않는다(복원 생략, 세 번째 진입자의 잠금을 그대로 둔다).
  }
  try {
    unlinkFn(tempPath);
  } catch {
    // best-effort, 위와 같은 근거.
  }
  return { reclaimed: false, reason: "mismatch" };
}

// Static (call-independent) defaults, merged via object spread rather than
// `= default` destructuring -- a quality-gate fix, not a behavior change:
// ESLint's `complexity` rule here (eslint.config.mjs, max 12) counts EACH
// `= default` as its own branch, and this function's many optional seams
// would otherwise push it well over budget (same "keeps the complexity
// gate happy" reasoning as every small extraction in isolated-suite-
// runner.mjs -- see e.g. that file's HYK-439 §2 ⓕ-2 comment on the same
// class of fix). A plain object-spread merge costs nothing under this rule.
const ACQUIRE_LOCK_STATIC_DEFAULTS = {
  worktree: null,
  head: null,
  nowMs: Date.now,
  sleepFn: defaultSleepSync,
  pollIntervalMs: LOCK_POLL_INTERVAL_MS,
  timeoutMs: LOCK_WAIT_TIMEOUT_MS,
  heartbeatStaleMs: HEARTBEAT_STALE_MS,
  writeFileFn: writeFileSync,
  readFileFn: readFileSync,
  unlinkFn: unlinkSync,
  renameFn: renameSync,
  linkFn: linkSync,
  isPidAliveFn: defaultIsPidAlive,
  env: process.env,
  nestedEnvVar: NESTED_LOCK_BYPASS_ENV_VAR,
};

// `pid`/`startedAtMs` are the two seams that must be resolved FRESH on
// every call (process.pid is call-independent in practice, but Date.now()
// is not -- baking it into the static object above would freeze every
// unspecified `startedAtMs` to this module's load time, not this call's
// real time).
function resolveAcquireLockOptions(opts) {
  return {
    pid: process.pid,
    startedAtMs: Date.now(),
    ...ACQUIRE_LOCK_STATIC_DEFAULTS,
    ...opts,
  };
}

// Pulled out of acquireRunnerLock below -- purely to keep that function's
// own line-count gate happy (max-lines-per-function, eslint.config.mjs;
// same "extraction for the gate, not a behavior change" reasoning as every
// other small extraction in this repo, e.g. isolated-suite-runner.mjs's
// HYK-439 §2 ⓕ-2 comment). Returns the full bypass-accepted result when the
// env marker's value matches the CURRENT lock's own lockId, or `null` to
// mean "fall through to the normal acquire path" -- `attempted` tells the
// caller whether to record a rejection (product_scope P2-1 "영수증에
// «우회 거부» 기록"; `attempted && !result` is exactly that case).
function tryNestedBypass({ env, nestedEnvVar, readFileFn, lockPath, nowMs }) {
  if (!env[nestedEnvVar]) return { attempted: false, result: null };
  const bypassCheck = readLockContentResult(readFileFn, lockPath);
  if (bypassCheck.ok && bypassCheck.content?.lockId === env[nestedEnvVar]) {
    const nowValue = nowMs();
    return {
      attempted: true,
      result: {
        acquired: true,
        nested: true,
        lockPath,
        waitMs: 0,
        waitStartMs: nowValue,
        waitEndMs: nowValue,
        pollCount: 0,
        reclaimedOrphan: false,
        priorOwner: null,
        timedOut: false,
        nestedBypassRejected: false,
      },
    };
  }
  // HYK-494 2R P2-1 수리: 마커가 있어도 "지금 이 경로의 잠금"의 토큰과
  // 맞지 않으면 믿지 않는다 -- result:null이라 호출자는 평범한 획득
  // 경로로 떨어지고, attempted:true로 거부 사실만 알린다.
  return { attempted: true, result: null };
}

// Pulled out of acquireRunnerLock's polling loop below, same reasoning as
// tryNestedBypass above. One contended iteration's "읽고 → 고아면 비교
// 후 삭제" step, reduced to a single verdict the loop can act on:
// - step:"claim-again" -- either reclaimed (reclaimed:true) or the lock
//   was simply gone by the time we tried (reclaimed:false, reason:"gone")
//   -- either way, retry tryClaim on the NEXT loop iteration immediately,
//   no sleep.
// - step:"wait" -- a read failure (HYK-494 2R P1-1 2nd fix: never treated
//   as orphan), a live non-stale owner, or a reclaim mismatch (a live,
//   DIFFERENT owner raced in -- HYK-494 2R P1-1 1st fix) -- all three fall
//   through to the same bounded sleep-and-recheck-timeout branch.
// `priorOwner` is `undefined` (not `null`) on a read failure specifically,
// so the caller can tell "don't overwrite the last-known owner" apart from
// "we now know there is no owner" (never actually returned here, but kept
// as an honest distinction for any future reader).
function resolveContendedStep({
  readFileFn,
  lockPath,
  isPidAliveFn,
  nowMs,
  heartbeatStaleMs,
  renameFn,
  linkFn,
  unlinkFn,
  pid,
}) {
  const readResult = readLockContentResult(readFileFn, lockPath);
  if (!readResult.ok) {
    return { step: "wait", priorOwner: undefined, reclaimed: false };
  }
  const existing = readResult.content;
  if (!isOrphan({ content: existing, isPidAliveFn, nowMs, heartbeatStaleMs })) {
    return { step: "wait", priorOwner: existing, reclaimed: false };
  }
  const reclaim = tryReclaimOrphan({
    lockPath,
    expectedContent: existing,
    renameFn,
    linkFn,
    unlinkFn,
    readFileFn,
    pid,
    nowMs,
  });
  if (reclaim.reclaimed) {
    return { step: "claim-again", priorOwner: existing, reclaimed: true };
  }
  if (reclaim.reason === "gone") {
    return { step: "claim-again", priorOwner: existing, reclaimed: false };
  }
  return { step: "wait", priorOwner: existing, reclaimed: false }; // "mismatch"
}

// Pulled out of acquireRunnerLock's two "I'm done" return sites below --
// same line-count-gate reasoning as the two helpers above. The two result
// shapes differ only in acquired/nested/timedOut/waitMs/lockId, so a single
// shared "carry the common fields" helper would cost MORE lines (an extra
// merge step at both call sites) than just two small, named builders.
function buildClaimedResult({
  lockPath,
  waitStartMs,
  nowMs,
  pollCount,
  reclaimedOrphan,
  priorOwner,
  nestedBypassRejected,
  lockId,
}) {
  const waitEndMs = nowMs();
  return {
    acquired: true,
    nested: false,
    lockPath,
    waitMs: waitEndMs - waitStartMs,
    waitStartMs,
    waitEndMs,
    pollCount,
    reclaimedOrphan,
    priorOwner,
    timedOut: false,
    nestedBypassRejected,
    lockId,
  };
}

function buildTimedOutResult({
  lockPath,
  waitStartMs,
  elapsed,
  nowMs,
  pollCount,
  reclaimedOrphan,
  priorOwner,
  nestedBypassRejected,
}) {
  return {
    acquired: false,
    nested: false,
    lockPath,
    waitMs: elapsed,
    waitStartMs,
    waitEndMs: nowMs(),
    pollCount,
    reclaimedOrphan,
    priorOwner,
    timedOut: true,
    nestedBypassRejected,
  };
}

// 반환 모양: { acquired, nested, lockPath, waitMs, waitStartMs, waitEndMs,
//   pollCount, reclaimedOrphan, priorOwner, timedOut, nestedBypassRejected,
//   lockId? }
// - acquired=false는 오직 timedOut=true일 때뿐(상한을 넘겨 결국 못 잡음).
// - nested=true는 바깥 프로세스가 이미 이 잠금을 쥐고 있다는 신호(env +
//   토큰 일치, §8)를 보고 "이번 호출은 파일을 건드리지 않고 통과시킨다"
//   는 뜻 -- 교착 방지(§2 위 주석).
// - nestedBypassRejected=true는 env 마커가 있었지만 지금 그 경로의 잠금
//   토큰과 맞지 않아 무시하고 정상 경로로 진행했다는 뜻(product_scope
//   P2-1 "영수증에 «우회 거부» 기록").
// - waitStartMs/waitEndMs(HYK-494 2R product_scope ⓘⓘ 명시 요구)는 이
//   호출이 대기를 "시작"/"끝낸" epoch ms -- waitMs는 그 차이와 항상
//   일치한다(중복이지만, 영수증 쪽은 길이가 아니라 "언제"를 보고 싶어
//   한다는 1R 검토 지적).
// - lockId는 이 호출이 실제로 획득했을 때(acquired && !nested)만 있다 --
//   heartbeat(§12)·중첩 우회(§8) 둘 다 이 토큰으로 "지금 쥔 그 잠금"을
//   식별한다.
// The polling loop itself, pulled out of acquireRunnerLock below -- same
// line-count-gate reasoning as every other extraction in this file. Takes
// the already-resolved seams plus the freshly-built `content`/`lockId`/
// `waitStartMs`/`nestedBypassRejected` this round's bypass check produced,
// and runs until it returns a claimed or timed-out result (never both).
function runAcquireLoop({
  lockPath,
  content,
  lockId,
  waitStartMs,
  nestedBypassRejected,
  writeFileFn,
  readFileFn,
  isPidAliveFn,
  nowMs,
  heartbeatStaleMs,
  renameFn,
  linkFn,
  unlinkFn,
  pid,
  sleepFn,
  pollIntervalMs,
  timeoutMs,
}) {
  let pollCount = 0;
  let reclaimedOrphan = false;
  let priorOwner = null;
  for (;;) {
    if (tryClaim({ lockPath, writeFileFn, content })) {
      return buildClaimedResult({
        lockPath,
        waitStartMs,
        nowMs,
        pollCount,
        reclaimedOrphan,
        priorOwner,
        nestedBypassRejected,
        lockId,
      });
    }
    const step = resolveContendedStep({
      readFileFn,
      lockPath,
      isPidAliveFn,
      nowMs,
      heartbeatStaleMs,
      renameFn,
      linkFn,
      unlinkFn,
      pid,
    });
    // HYK-494 2R P1-1 둘째 수리: 읽기 실패(priorOwner===undefined)일 때는
    // priorOwner를 갱신하지 않는다 -- 마지막으로 "읽을 수 있었던" 소유자
    // 정보를 그대로 둔다(순간적인 읽기 실패로 null로 지우면 영수증의
    // "누구를 기다렸는지"가 오히려 덜 정확해진다).
    if (step.priorOwner !== undefined) priorOwner = step.priorOwner;
    if (step.reclaimed) reclaimedOrphan = true;
    if (step.step === "claim-again") continue; // 회수했거나 이미 사라짐 -- 즉시 재시도.
    const elapsed = nowMs() - waitStartMs;
    if (elapsed >= timeoutMs) {
      return buildTimedOutResult({
        lockPath,
        waitStartMs,
        elapsed,
        nowMs,
        pollCount,
        reclaimedOrphan,
        priorOwner,
        nestedBypassRejected,
      });
    }
    pollCount += 1;
    sleepFn(pollIntervalMs);
  }
}

export function acquireRunnerLock(opts) {
  const {
    lockPath,
    pid,
    startedAtMs,
    worktree,
    head,
    nowMs,
    sleepFn,
    pollIntervalMs,
    timeoutMs,
    heartbeatStaleMs,
    writeFileFn,
    readFileFn,
    unlinkFn,
    renameFn,
    linkFn,
    isPidAliveFn,
    env,
    nestedEnvVar,
  } = resolveAcquireLockOptions(opts);

  const bypass = tryNestedBypass({
    env,
    nestedEnvVar,
    readFileFn,
    lockPath,
    nowMs,
  });
  if (bypass.result) return bypass.result;
  // 이 호출이 결국 어떻게 끝나든(즉시 획득/대기 뒤 획득/타임아웃) 아래
  // 모든 return에 이 플래그를 실어 영수증에 "우회를 시도했지만 거부됐다"
  // (product_scope P2-1)가 남게 한다.
  const nestedBypassRejected = bypass.attempted;

  const lockId = randomUUID();
  const content = {
    pid,
    startedAtMs,
    worktree,
    head,
    lockId,
    aliveAtMs: startedAtMs,
  };
  return runAcquireLoop({
    lockPath,
    content,
    lockId,
    waitStartMs: nowMs(),
    nestedBypassRejected,
    writeFileFn,
    readFileFn,
    isPidAliveFn,
    nowMs,
    heartbeatStaleMs,
    renameFn,
    linkFn,
    unlinkFn,
    pid,
    sleepFn,
    pollIntervalMs,
    timeoutMs,
  });
}

// 자기 잠금만 해제한다 -- 파일 내용의 pid가 호출자 자신의 pid와 일치할
// 때만 지운다(남의 잠금 삭제 0, product_scope ⓘⓘⓘⓘⓘ). nested 경로
// (acquireRunnerLock이 파일을 건드리지 않은 경우)에서 호출자가 실수로
// 이 함수를 불러도, 그 파일의 pid는 바깥(진짜 소유) 프로세스의 pid이지
// 우리 pid가 아니므로 이 pid 대조 자체가 추가 방어선이 된다.
export function releaseRunnerLock({
  lockPath,
  pid = process.pid,
  readFileFn = readFileSync,
  unlinkFn = unlinkSync,
} = {}) {
  const { ok, content } = readLockContentResult(readFileFn, lockPath);
  if (!ok || !content || content.pid !== pid) {
    return { released: false, reason: "not-our-lock-or-missing" };
  }
  try {
    unlinkFn(lockPath);
    return { released: true, reason: null };
  } catch (err) {
    return { released: false, reason: err.message };
  }
}

const DEFAULT_RELEASE_SIGNALS = ["SIGINT", "SIGTERM"];

// SIGINT/SIGTERM에서도 자기 잠금을 해제한다(product_scope ⓘⓘⓘⓘⓘ).
// ⛔정직 한계(설계 메모에도 같은 문단): 이 파일의 호출자(runIsolatedSuite)
// 는 spawnSync/Atomics.wait로 완전히 동기 차단되는 호출 그래프다 --
// Node는 블로킹 시스템 콜이 반환되기 전까지는 신호 핸들러를 포함한 어떤
// JS도 실행할 수 없으므로, 이 핸들러는 "이벤트 루프가 다시 돌 수 있는
// 틈"(블로킹 호출 사이)에 도착한 신호만 즉시 처리한다. 블로킹 호출 "도중"
// 도착한 신호는 그 호출이 반환된 뒤에야 처리된다(OS가 신호 자체를
// 들고 있다가 전달 -- 신호를 잃어버리지는 않는다, 단지 즉시성이 없다).
// Windows에서는(§9-1) 이 핸들러 자체가 전혀 안 돌 수 있다(강제 종료와
// 동일하게 처리됨) -- 그 경우 잠금은 "주인이 안 지운" 상태로 남지만,
// 그 주인의 pid는 이미 죽었으므로 다음 획득 시도가 §(비교 후 삭제)로
// 안전하게 회수한다. heartbeat(§12)는 그 pid가 "다른 누군가에게
// 재사용"되어 죽은 걸로 안 보이는 더 드문 경우까지 덮는다.
export function installLockReleaseOnSignal({
  processRef = process,
  signals = DEFAULT_RELEASE_SIGNALS,
  release,
  exitFn = (code) => processRef.exit(code),
} = {}) {
  const installed = [];
  for (const signal of signals) {
    const handler = () => {
      try {
        release();
      } catch {
        // best-effort -- 신호 처리 중 해제 실패로 프로세스가 아예 못
        // 끝나면(uncaught) 잠금이 영원히 orphan도 아닌 채 남는다. 실패해도
        // exitFn은 반드시 부른다.
      }
      exitFn(1);
    };
    processRef.on(signal, handler);
    installed.push({ signal, handler });
  }
  return function uninstall() {
    for (const { signal, handler } of installed) {
      processRef.removeListener(signal, handler);
    }
  };
}

// §12 heartbeat 사이드카 -- isolated-suite-runner.mjs의 자기 자신의
// 샘플러들(node-concurrency-sampler.mjs 모듈 헤더 · 이 파일의
// FREE_MEM_SAMPLER_SCRIPT)과 같은 근거로 "별도 프로세스, in-process
// 타이머 아님"을 쓴다: 이 잠금을 쥔 프로세스(isolated-suite-runner.mjs의
// runIsolatedSuite)는 실행 내내 spawnSync/Atomics.wait로 동기 차단돼
// 있으므로, 같은 프로세스 안의 setInterval은 그 블로킹 "도중"에는 돌 수
// 없다(installLockReleaseOnSignal의 §9-1과 같은 제약).
//
// 사이드카 자신이 "주인 pid가 여전히 살아 있는가"를 매 tick 확인하고,
// 죽었으면 더는 갱신하지 않고 스스로 멈춘다(clearInterval -> 프로세스
// 자연 종료) -- 이게 핵심이다: 주인이 죽는 순간 aliveAtMs는 그 즉시
// "멈춘다"(그 이후로는 아무도 갱신하지 않는다), 그 pid가 나중에 전혀
// 무관한 새 프로세스에게 재사용돼 "살아있다"로 보이기 시작하더라도
// 이미 멈춰 버린 aliveAtMs 값은 바뀌지 않는다 -- isOrphan의 staleness
// 검사(위)가 바로 이 사실에 기대어 pid 재사용을 가려낸다. 또한 토큰
// (lockId)이 안 맞으면(이미 풀려서 다른 주인이 새로 잡은 경우) 역시
// 스스로 멈춘다 -- 남의 잠금을 갱신하지 않는다.
//
// `-e` 인라인 스크립트(새 파일 아님, product_scope가 명시한 파일 목록
// 밖) -- CommonJS 컨텍스트(require, FREE_MEM_SAMPLER_SCRIPT와 같은
// 기법)라 --input-type=module이 필요 없다.
const HEARTBEAT_SCRIPT = [
  "const fs=require('node:fs');",
  "const lockPath=process.argv[1];",
  "const token=process.argv[2];",
  "const ownerPid=Number(process.argv[3]);",
  "const intervalMs=Number(process.argv[4]);",
  "function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e&&e.code!=='ESRCH';}}",
  "function tick(){",
  "if(!alive(ownerPid)){clearInterval(timer);return;}",
  "let content;",
  "try{content=JSON.parse(fs.readFileSync(lockPath,'utf8'));}catch(e){clearInterval(timer);return;}",
  "if(content.lockId!==token){clearInterval(timer);return;}",
  "content.aliveAtMs=Date.now();",
  "try{fs.writeFileSync(lockPath,JSON.stringify(content));}catch(e){}",
  "}",
  "const timer=setInterval(tick,intervalMs);",
].join("\n");

// 실제 사이드카를 띄운다(production 전용 -- 이 함수를 직접 부르는 건 이
// 파일의 startLockHeartbeat뿐, 단위 시험은 전부 startHeartbeatFn 자체를
// 스텁한다). `stdio:"ignore"` + `unref()`: 이 파일의 다른 spawn 호출이
// 없어 직접 비교할 선례는 없지만, isolated-suite-runner.mjs의
// startConcurrencySampler/startFreeMemSampler가 정확히 같은 두 옵션을
// 쓴다(그 파일들의 모듈 헤더가 각각 근거를 적어 둔다) -- 같은 "메인
// 러너 종료와 무관하게 떠 있어야 하는 백그라운드 프로세스" 패턴.
function defaultSpawnHeartbeat({ lockPath, token, pid, intervalMs }) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      HEARTBEAT_SCRIPT,
      "--",
      lockPath,
      String(token),
      String(pid),
      String(intervalMs),
    ],
    { stdio: "ignore" },
  );
  child.unref?.();
  return child;
}

// 이 잠금을 "실제로"(nested 아님) 쥔 직후에만 부른다(isolated-suite-
// runner.mjs의 guardLockForRun). 실패해도(스폰 자체가 안 됨) 조용히
// no-op 핸들을 돌려준다 -- heartbeat는 견고성 보강이지, 그게 없다고
// 잠금 자체의 상호 배제(§3 wx 배타 생성)가 깨지지는 않는다(startConcurrency
// Sampler/startFreeMemSampler와 같은 "인프라 실패는 측정 불가로 격하,
// 러너 자체를 막지 않는다" 자세).
export function startLockHeartbeat({
  lockPath,
  token,
  pid,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  spawnHeartbeatFn = defaultSpawnHeartbeat,
} = {}) {
  try {
    const child = spawnHeartbeatFn({ lockPath, token, pid, intervalMs });
    return {
      stop: () => {
        try {
          child.kill();
        } catch {
          // best-effort -- 이미 죽은 프로세스를 다시 죽이려는 실패는
          // 무시한다(startConcurrencySampler/stopConcurrencySampler와
          // 같은 자세).
        }
      },
    };
  } catch {
    return { stop: () => {} };
  }
}
