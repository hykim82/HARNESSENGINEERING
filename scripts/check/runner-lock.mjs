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
// §2 범위: 이 모듈은 잠금 그 자체(획득/대기/고아 회수/해제)만 안다.
// 어디서 잠그고 언제 푸는지(측정·시험 실행 전/후)는 isolated-suite-
// runner.mjs의 몫이다 -- 두 관심사를 한 파일에 섞으면 잠금 자체의 단위
// 시험이 전건 클론·spawn 없이는 돌 수 없게 된다.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 저장소 밖, 머신 공용 고정 경로 -- os.tmpdir()은 이 머신의 모든 워크트리/
// 사용자 세션이 공유하는 디렉터리이므로(관제실 경로를 저장소 코드에 박지
// 말라는 지시서 live_watch_rule과 별개 근거: 이 파일은 관제실 존재를
// 전혀 모른다), 어느 워크트리에서 실행하든 같은 파일을 본다. 고정 이름
// (경쟁 걱정 없이 항상 같은 글자)이라야 "머신 전체에 하나"가 성립한다.
export const DEFAULT_LOCK_FILENAME = "harness-isolated-suite-runner.lock";

export function defaultRunnerLockPath({ tmpdirFn = tmpdir } = {}) {
  return join(tmpdirFn(), DEFAULT_LOCK_FILENAME);
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
// 영원히 못 풂). 값을 세팅/해제하는 책임은 isolated-suite-runner.mjs에
// 있다(이 모듈은 읽기만) -- 두 관심사를 가르는 같은 원칙(§2).
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

function readLockContent(readFileFn, lockPath) {
  try {
    return JSON.parse(readFileFn(lockPath, "utf8"));
  } catch {
    return null;
  }
}

// ⛔정직 한계(pid 재사용): 죽은 pid는 명확히 죽었다(ESRCH) -- 그 방향의
// 회수는 안전하다. 반대 방향(그 pid가 이미 "다른", 전혀 무관한 새
// 프로세스에게 재사용되어 "살아있다"로 보이는 경우)는 이 신호만으로는
// 구분할 수 없다 -- 그 경우 이 함수는 "아직 누가 쥐고 있다"로 오판해
// 상한까지 기다리게 만들 뿐이지(안전 쪽 오차), 두 실행이 동시에 들어가는
// 사고(이 모듈이 막아야 하는 바로 그것)로는 이어지지 않는다. 설계
// 메모(docs/HYK-494-runner-lock-design.md)에 같은 문단을 둔다.
function isOrphan({ content, isPidAliveFn }) {
  if (!content || !Number.isInteger(content.pid)) return true;
  return !isPidAliveFn(content.pid);
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

// 고아(죽은 pid) 회수 한 번 시도 -- 성공하면 true, 경쟁에서 져서(다른
// 프로세스가 먼저 지웠거나 먼저 다시 차지했으면) false(호출자가 루프에서
// 그냥 다시 시도한다, 그 자체가 "경쟁 안전성"의 근거 -- allocateRunSlot의
// EEXIST 재시도와 같은 모양).
function tryReclaim({ lockPath, unlinkFn }) {
  try {
    unlinkFn(lockPath);
    return true;
  } catch {
    return false;
  }
}

// 머신 공용 잠금을 획득한다 -- 측정(resolveAutoConcurrency)·시험 실행
// 둘 다보다 먼저 호출돼야 한다(isolated-suite-runner.mjs의 runIsolatedSuite
// 맨 앞).
//
// Static (call-independent) defaults, merged via object spread rather than
// `= default` destructuring -- a quality-gate fix, not a behavior change:
// ESLint's `complexity` rule here (eslint.config.mjs, max 12) counts EACH
// `= default` as its own branch, and this function's ~13 optional seams
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
  writeFileFn: writeFileSync,
  readFileFn: readFileSync,
  unlinkFn: unlinkSync,
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

// 반환 모양: { acquired, nested, lockPath, waitMs, pollCount,
//   reclaimedOrphan, priorOwner, timedOut }
// - acquired=false는 오직 timedOut=true일 때뿐(상한을 넘겨 결국 못 잡음).
// - nested=true는 바깥 프로세스가 이미 이 잠금을 쥐고 있다는 신호(env)를
//   보고 "이번 호출은 파일을 건드리지 않고 통과시킨다"는 뜻 -- 교착 방지
//   (§2 위 주석).
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
    writeFileFn,
    readFileFn,
    unlinkFn,
    isPidAliveFn,
    env,
    nestedEnvVar,
  } = resolveAcquireLockOptions(opts);
  if (env[nestedEnvVar]) {
    return {
      acquired: true,
      nested: true,
      lockPath,
      waitMs: 0,
      pollCount: 0,
      reclaimedOrphan: false,
      priorOwner: null,
      timedOut: false,
    };
  }
  const content = { pid, startedAtMs, worktree, head };
  const waitStartMs = nowMs();
  let pollCount = 0;
  let reclaimedOrphan = false;
  let priorOwner = null;
  for (;;) {
    if (tryClaim({ lockPath, writeFileFn, content })) {
      return {
        acquired: true,
        nested: false,
        lockPath,
        waitMs: nowMs() - waitStartMs,
        pollCount,
        reclaimedOrphan,
        priorOwner,
        timedOut: false,
      };
    }
    const existing = readLockContent(readFileFn, lockPath);
    priorOwner = existing;
    if (isOrphan({ content: existing, isPidAliveFn })) {
      reclaimedOrphan = tryReclaim({ lockPath, unlinkFn }) || reclaimedOrphan;
      continue; // 회수(또는 남이 먼저 회수/재획득)했으니 즉시 재시도.
    }
    const elapsed = nowMs() - waitStartMs;
    if (elapsed >= timeoutMs) {
      return {
        acquired: false,
        nested: false,
        lockPath,
        waitMs: elapsed,
        pollCount,
        reclaimedOrphan,
        priorOwner,
        timedOut: true,
      };
    }
    pollCount += 1;
    sleepFn(pollIntervalMs);
  }
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
  const content = readLockContent(readFileFn, lockPath);
  if (!content || content.pid !== pid) {
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
