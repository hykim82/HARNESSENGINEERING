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
// §1-2 왜 3R인가 (reject-streak-envelope, HYK-494-runner-lock-1-review-2
// §3 P1-A·P1-B): 2R의 고아 회수는 "훔친 뒤 검증·틀리면 되돌림"(낙관적
// 회수)이었다 -- rename으로 훔친 내용이 기대와 다르면 link로 되돌리는데,
// 그 되돌리는 틈에 4번째 진입자가 빈 이름을 채우면 되돌리기가 EEXIST로
// 생략되어 "살아 있는 새 주인의 잠금"이 영영 사라졌다(실 측정: 잠금
// 함수 15/30, 실제 러너 진입점 9/10 완전 겹침). heartbeat 낡음을 "회수
// 판정"으로 쓴 것도 문제였다 -- 60초 넘게 기다린 뒤 잡은 주인은 잡는
// 순간 aliveAtMs가 이미 대기 시작 시각이라 곧바로 "낡음"으로 보여, 첫
// heartbeat(2R 기준 30초) 전까지 다른 진입자가 "고아"로 회수했다(실측
// 겹침 5,005 ms).
//
// 이 3R은 PM 설계(D:\문서관리\하네스-관제실\PM\산출물\하네스\
// 2026-11-06-러너잠금-알고리즘\러너잠금-경합알고리즘-설계.md (d), 책임자
// 판정 23:5x §1 ①′+③+④′ 확정)를 그대로 구현한다 -- 되돌림이 전혀 없는
// 세대 번호 회수권 + 잡는 순간 heartbeat + "낡음은 신원 질의의 방아쇠일
// 뿐, 회수 사유가 아니다"(이탈 1, 책임자 승인).
//
// 불변식(설계 (d) 원문): L이라는 이름을 지울 수 있는 "살아 있는" 프로세스는
// 언제나 1개 이하다 -- 살아 있는 주인 자신이거나, 주인이 DEAD일 때 그
// 인스턴스의 유일한 살아 있는 회수권자다. L의 생성은 link로 1명만 이기므로
// "두 주인"은 불가능하다.
//
// §2 범위: 이 모듈은 잠금 그 자체(획득/대기/고아 회수/해제)만 안다.
// 어디서 잠그고 언제 푸는지(측정·시험 실행 전/후)는 isolated-suite-
// runner.mjs의 몫이다.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  linkSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// 저장소 밖, 머신 공용 고정 경로 -- HYK-494 2R 선택 ②(review P2-4): 3R도
// 그대로 쓴다(이 칸은 닫혀 있다, 변경 없음).
export const DEFAULT_LOCK_FILENAME = "harness-isolated-suite-runner.lock";

export function defaultRunnerLockPath({ homedirFn = homedir } = {}) {
  return join(homedirFn(), DEFAULT_LOCK_FILENAME);
}

// 중첩 실행 신호 -- 2R과 동일 메커니즘/동일 근거(바뀌지 않는다): 잠금을
// "실제로" 쥔 프로세스가 이 env var에 "지금 그 경로의 잠금 파일"의
// lockId를 심어 두면, 그 프로세스가 (직접/간접으로) 띄우는 모든 자식이
// 이 값을 보고 파일을 건드리지 않고 통과한다 -- isolated-suite-runner.
// test.mjs 자신이 CLI를 자식으로 띄우는 시험들이 전건 러너의 clone 안에서
// 돌 때 교착을 막는다.
export const NESTED_LOCK_BYPASS_ENV_VAR = "HARNESS_RUNNER_LOCK_HELD_BY";

// 대기 간격·상한 -- 2R과 동일(무변, product_scope "폴 1초와 상한 20분은
// 무변이다").
export const LOCK_POLL_INTERVAL_MS = 1000;
export const LOCK_WAIT_TIMEOUT_MS = 20 * 60 * 1000;

// HYK-494 3R (판정 23:5x §1 ⑴ "N(간격)=10초·M(기한)=3분 -- 판정 제안과
// 같다"): 2R의 30초/90초에서 교체. 이 설계에서 M은 "안전값"이 아니다 --
// 낡음은 신원 질의를 부를 뿐 회수하지 않기 때문이다(judge 참조). M은
// "pid 재사용 고아"를 알아차리는 데 걸리는 최대 지연만 정한다(3분 ≪
// 대기 상한 20분). M/N = 18이라 사이드카가 17번 연속 늦어야 질의 1회가
// 생긴다(비용만 든다, PM 설계 (d) "N·M" 절 근거 그대로).
export const HEARTBEAT_INTERVAL_MS = 10 * 1000;
export const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

// Atomics.wait 기반 동기 sleep -- 2R과 동일(이 파일의 호출 그래프는 전부
// 동기식을 유지한다).
function defaultSleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, Math.max(0, Number(ms) || 0));
}

// 이 머신에 그 pid가 "살아 있는가" -- 2R과 동일(signal 0, ESRCH만 false).
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

// §(d) startIdentity(pid) -- PM 설계 원문: Linux는 /proc/<pid>/stat의 22번째
// 필드(부팅 후 tick, comm 필드 뒤 마지막 ")"부터 파싱 -- comm 자체가
// 공백/괄호를 포함할 수 있어 첫 "("가 아니라 "마지막 ")"을 기준으로
// 자른다), Windows는 PowerShell `(Get-Process -Id N).StartTime.
// ToFileTimeUtc()`를 1회 부른다. 그 밖/실패는 null(§(d) 전제 A1: "신원을
// 모르면 ALIVE로 본다" -- 이 함수가 null을 돌리면 judge가 보수적으로
// ALIVE 처리한다). 비교는 항상 원문 문자열이 같은지로만 한다(§(d)).
//
// platform/readFileFn/execFileSyncFn은 시험 seam -- 이 Windows 개발 머신
// 에서 Linux 분기를 실제로 못 돌려 보므로(〔못쟀다〕, universal_claim_
// discipline), platform을 주입해 그 분기의 파싱 로직만이라도 결정론적으로
// 시험한다.
function linuxStartIdentity(pid, readFileFn) {
  try {
    const raw = readFileFn(`/proc/${pid}/stat`, "utf8");
    const afterComm = raw.slice(raw.lastIndexOf(")") + 2);
    const fields = afterComm.trim().split(/\s+/);
    // afterComm[0] == 원본 필드(3)=state이므로 필드(22)=starttime은
    // afterComm 배열의 인덱스 22-3=19.
    const starttime = fields[19];
    return starttime || null;
  } catch {
    return null;
  }
}

function windowsStartIdentity(pid, execFileSyncFn) {
  if (!Number.isInteger(pid)) return null;
  try {
    const out = execFileSyncFn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    const trimmed = String(out).trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

export function defaultGetStartIdentity(
  pid,
  {
    platform = process.platform,
    readFileFn = readFileSync,
    execFileSyncFn = defaultExecFileSync,
  } = {},
) {
  if (platform === "win32") return windowsStartIdentity(pid, execFileSyncFn);
  if (platform === "linux") return linuxStartIdentity(pid, readFileFn);
  return null; // 그 밖 플랫폼(§(g) 정직 한계 1): 신원 모름 -> judge가 ALIVE로.
}

// node:child_process의 spawnSync를 execFileSync 대신 쓰는 이유:
// isolated-suite-runner.mjs의 다른 샘플러들도 이미 spawnSync를 쓰고,
// 이 파일의 호출 그래프 전체가 동기식이라는 제약(defaultSleepSync의
// 헤더)과 같은 결을 유지한다 -- 실패 시 throw, 호출자(windowsStartIdentity)
// 가 catch한다.
function defaultExecFileSync(cmd, args, opts) {
  const result = spawnSync(cmd, args, { ...opts, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(
      `defaultExecFileSync: ${cmd} exited ${result.status}: ${result.stderr}`,
    );
    throw err;
  }
  return result.stdout;
}

// §(d) createExclusive -- "없을 때만 만들기"를 하드 링크로 구현한다: 전체
// 내용을 임시 파일에 다 쓴 뒤 link(tmp, path) -- path가 있으면 EEXIST로
// 실패하고 path를 덮어쓰지 않는다(T0-1, 이 라운드 실측 확인). 빈 path가
// 생기는 순간이 없다(T0-3) -- tmp는 항상 "전체 내용이 다 쓰인 뒤"에만
// link된다. EPERM/EBUSY/EACCES(백신·삭제 대기 등 일시 실패, PM 설계 (b)
// 영향 2-3)는 "busy"로 구분해 호출자가 연속 상한 뒤 throw할 수 있게 한다
// -- EEXIST만 "다른 주인이 있다"는 사실이다(PM 설계 (b) 영향 3).
const BUSY_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function createExclusive({
  path,
  content,
  writeFileFn,
  linkFn,
  unlinkFn,
  randomSuffixFn,
}) {
  const tmpPath = `${path}.tmp.${randomSuffixFn()}`;
  writeFileFn(tmpPath, JSON.stringify(content));
  try {
    linkFn(tmpPath, path);
  } catch (err) {
    try {
      unlinkFn(tmpPath);
    } catch {
      // best-effort -- a leaked tmp file costs disk space, not correctness.
    }
    if (err.code === "EEXIST") return { ok: false, busy: false };
    if (BUSY_ERROR_CODES.has(err.code)) return { ok: false, busy: true, err };
    throw err;
  }
  try {
    unlinkFn(tmpPath);
  } catch {
    // best-effort -- the link at `path` is a separate directory entry to
    // the same inode; failing to remove the tmp NAME leaks a byte of disk,
    // never affects correctness of `path` itself.
  }
  return { ok: true };
}

// 연속 busy(EPERM/EBUSY/EACCES) 상한 -- PM 설계 (b) 영향 2 "연속 30초를
// 넘기면 throw"의 근거 그대로. "다른 주인이 있다"(EEXIST)와 달리 busy는
// 백신/삭제 대기 같은 일시 현상이라 재시도하되, 무한정 삼키면 상호 배제
// 보장이 거짓으로 참인 척하게 된다(2R acquireRunnerLock 헤더의 tryClaim
// 주석과 같은 근거) -- 그래서 bounded 뒤 던진다.
export const BUSY_RETRY_TIMEOUT_MS = 30 * 1000;

function randomSuffix() {
  return `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

// 두 파일 사이 경로 유틸 -- 잠금 파일 L 자체가 아니라 그 "곁에" 사는
// heartbeat/회수권 파일들의 이름을 만든다. 모두 `dirname(L)` 아래,
// `basename(L)` 접두로 산다(PM 설계 (d) 의사 코드 머리말 그대로).
function aliveFilePath(lockPath, lockId) {
  return join(dirname(lockPath), `${basename(lockPath)}.alive.${lockId}`);
}

// HYK-494 후속 5R P2-c(검토 2R §3 참고 지적, 이번 라운드 명시 범위): 사이드카
// stop()의 child.kill()이 HEARTBEAT_SCRIPT의 write(tmp)·rename(alivePath)
// 사이를 끊으면(SIGTERM은 그 스크립트의 catch를 거치지 않고 프로세스를
// 바로 끝낸다) `${alivePath}.tmp.*`가 남는다. 해제(release) 경로는 보통
// stop() 보다 뒤에 불려 kill 신호가 이미 정착할 시간이 있었으므로, 여기서
// "자기 token" 접두만(남의 사이드카 tmp는 무접촉) best-effort로 쓸어
// 담는다 -- 불변식과 무관한 공간 누수일 뿐이다(cleanupOwnAliveFileBestEffort/
// P2-7과 같은 근거, "정확히 0 보장"은 하지 않는다).
function cleanupOwnAliveTmpLeftovers({ alivePath, readdirFn, unlinkFn }) {
  try {
    const dir = dirname(alivePath);
    const ownPrefix = `${basename(alivePath)}.tmp.`;
    for (const name of readdirFn(dir)) {
      if (!name.startsWith(ownPrefix)) continue;
      try {
        unlinkFn(join(dir, name));
      } catch {
        // best-effort.
      }
    }
  } catch {
    // best-effort (listing may fail / dir missing).
  }
}

function reclaimTicketPath(lockPath, lockId, k) {
  return join(
    dirname(lockPath),
    `${basename(lockPath)}.reclaim.${lockId}.${k}`,
  );
}

function reclaimTicketPrefix(lockPath, lockId) {
  return `${basename(lockPath)}.reclaim.${lockId}.`;
}

// 현재 lockId O에 대한 회수권 중 가장 큰 번호 k(없으면 0) -- PM 설계 (d)
// "k = 이미 있는 O의 권한 중 최대 번호(없으면 0)". 디렉터리 목록을 한 번
// 읽어 접두사로 거른다(디렉터리 자체가 없으면 0 -- 레이스가 아니라
// "아직 아무도 회수권을 안 만들었다"는 평범한 사실).
function maxReclaimTicketNumber({ lockPath, lockId, readdirFn }) {
  let names;
  try {
    names = readdirFn(dirname(lockPath));
  } catch {
    return 0;
  }
  const prefix = reclaimTicketPrefix(lockPath, lockId);
  let max = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const k = Number(suffix);
    if (Number.isInteger(k) && k > max) max = k;
  }
  return max;
}

// 회수권/잠금 보유자의 신원을 읽어 DEAD 여부만 판정한다(heartbeat 축 없이
// -- 회수권 자체는 heartbeat로 신선도를 유지하지 않는, 짧게 사는 표식이라
// 매번 pid-dead/pid-reused를 직접 확인한다). PM 설계 (d) judge의 핵심
// 두 축(①pid 사망 ②시작 신원 불일치)만 공유한다 -- heartbeat 낡음 축은
// judgeOwner(아래)에서만 쓴다(회수권에는 heartbeat 파일이 없다).
function identityIsDead({ content, isPidAliveFn, getStartIdentityFn }) {
  if (!content || !Number.isInteger(content.pid)) {
    return { dead: true, reason: "pid-dead" };
  }
  if (!isPidAliveFn(content.pid)) return { dead: true, reason: "pid-dead" };
  const nowIdentity = getStartIdentityFn(content.pid);
  if (
    nowIdentity != null &&
    content.procStart != null &&
    nowIdentity !== content.procStart
  ) {
    return { dead: true, reason: "pid-reused" };
  }
  return { dead: false, reason: null };
}

// §(d) judge(O) -- 잠금 L의 현재 주인 O가 DEAD인지 판정한다.
//
// 1) pid 사망(ESRCH) -> DEAD("pid-dead"), 즉시(값은 §(d) "싼 경로").
// 2) heartbeat 파일 L.alive.<O.lockId>의 나이가 M(heartbeatStaleMs) 이하면
//    -> ALIVE("alive-fresh"), 더 비싼 신원 질의를 하지 않는다(싼 경로).
// 3) 낡았으면(또는 heartbeat 파일 자체가 없으면, age=Infinity로 취급) --
//    그 사실 자체는 회수 사유가 아니다(이탈 1, 판정 23:5x §1 ⑴). 비로소
//    시작 신원을 질의한다(비싼 경로, M/N=18이라 드물게만 탄다). 신원이
//    둘 다 있고 다르면 -> DEAD("pid-reused"). 그 밖(신원 모름, 또는 같음)
//    -> ALIVE("alive-heartbeat-stale") -- 절대 이 축만으로는 회수하지
//    않는다. 사이드카 사망(F5)·절전 재개(벽시계 점프)·잠깐의 스케줄링
//    지연이 전부 이 가지로 떨어져 안전하게 "회수 안 함"이 된다.
function judgeOwner({
  content,
  isPidAliveFn,
  readAliveAgeMsFn,
  heartbeatStaleMs,
  getStartIdentityFn,
}) {
  if (!content || !Number.isInteger(content.pid)) {
    return { dead: true, reason: "pid-dead" };
  }
  if (!isPidAliveFn(content.pid)) return { dead: true, reason: "pid-dead" };
  const ageMs = readAliveAgeMsFn(content.lockId);
  if (ageMs <= heartbeatStaleMs) return { dead: false, reason: "alive-fresh" };
  // 낡음(또는 heartbeat 파일 부재) -- 방아쇠일 뿐, 신원을 질의해야만 판정.
  const nowIdentity = getStartIdentityFn(content.pid);
  if (
    nowIdentity != null &&
    content.procStart != null &&
    nowIdentity !== content.procStart
  ) {
    return { dead: true, reason: "pid-reused" };
  }
  return { dead: false, reason: "alive-heartbeat-stale" };
}

// L.alive.<lockId>의 나이(ms)를 읽는다. 파일이 없거나 못 읽으면 Infinity
// -- "신선함의 증거가 없다"는 사실을 안전한 방향(= judgeOwner의 "낡음"
// 가지, 신원 질의로 이어짐)으로만 떨어지게 한다. 절대 "신선하다"고 거짓
// 보증하지 않는다.
function readAliveAgeMs({ lockPath, lockId, readFileFn, nowMs }) {
  try {
    const raw = readFileFn(aliveFilePath(lockPath, lockId), "utf8");
    const parsed = JSON.parse(raw);
    if (!Number.isFinite(parsed.aliveAtMs)) return Infinity;
    return nowMs() - parsed.aliveAtMs;
  } catch {
    return Infinity;
  }
}

// 읽기 실패(ENOENT·부분 쓰기 등)와 "고아"는 다른 사실이다(2R P1-1 수리,
// 이 축은 3R에서도 무변 -- F3는 닫힌 칸). {ok:false}를 돌리면 호출자가
// "바쁘다"로 보고 폴링을 한 바퀴 더 돈다.
function readLockContentResult(readFileFn, lockPath) {
  try {
    return { ok: true, content: JSON.parse(readFileFn(lockPath, "utf8")) };
  } catch {
    return { ok: false, content: null };
  }
}

// HYK-494 후속 P2-2: readLockContentResult와 달리 ENOENT와 그 밖의 읽기
// 실패(일시적 공유 위반·EBUSY/EPERM·쓰기 도중의 부분/빈 내용 등)를 갈라
// 돌려준다 -- 회수권 보유자를 읽을 때만 쓴다. ENOENT는 "보유자가 이미
// 지웠다"는 평범한 사실(다음 판정으로 진행해도 안전)이지만, 그 밖의
// 실패는 보유자가 여전히 살아 있을 수도 있다는 뜻이라 "고아"로 보면
// 안 된다(2R이 L 자체에 대해 닫은 "읽기 실패 ≠ 고아"(F3) 원칙을 회수권
// 판독에도 적용).
function readLockContentResultDetailed(readFileFn, path) {
  let raw;
  try {
    raw = readFileFn(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT")
      return { ok: false, content: null, enoent: true };
    return { ok: false, content: null, enoent: false };
  }
  try {
    return { ok: true, content: JSON.parse(raw) };
  } catch {
    // 부분/손상 내용(비원자적 쓰기 중간을 본 경우) -- ENOENT가 아니므로
    // "보유자가 지웠다"로 보지 않는다, 위와 같은 이유.
    return { ok: false, content: null, enoent: false };
  }
}

// best-effort 청소 -- O의 heartbeat 파일 + O의 회수권 전부(반드시 L 삭제
// "뒤", PM 설계 (d) "best-effort: unlink O의 heartbeat 파일 · O의 권한
// 전부"). 실패해도 삼킨다(공간 누수일 뿐, 불변식에는 영향이 없다 -- §(d)
// "번호가 늦게 만들어지는 경우" 문단과 같은 근거: 이 lockId를 다시 참조할
// 길이 없으면 누수는 harmless하다).
// HYK-498 §13-9 수리: 접두 매칭(name.startsWith(prefix))만으로 지우면
// 다른 회수권자가 createExclusive로 ticket k+1을 만드는 중(write(tmp)
// 끝, link(tmp, path) 전)인 `<prefix><k+1>.tmp.<suffix>` 이름도 걸린다 --
// 그 tmp 이름 자체가 이 prefix로 시작하기 때문이다(review 3R §2 ⓐ-3
// 결정적 재현: 세 번째 회수권자가 그 tmp를 지우면 원래 주인의 `linkSync`
// 가 ENOENT로 throw한다, createExclusive의 catch는 EEXIST/busy만 받고
// 그 밖은 던진다). maxReclaimTicketNumber(위)가 이미 같은 구분을
// "suffix가 숫자뿐인가"로 하고 있다(Number("<k>.tmp.<suffix>")===NaN) --
// 여기도 같은 테스트를 적용해 **완성된(link된) 티켓 이름만**(suffix가
// 정수 하나) 지운다. 다른 회수권자의 진행 중 tmp는 이 함수가 절대
// 건드리지 않는다 -- 그 쪽의 createExclusive 자신의 catch(실패 시)나
// 성공 뒤 자기 unlink(tmpPath)가 치운다(PM 설계 불변식·회수 경로
// 되돌림 0 무변, 살아 있는 회수권자 ≤1도 무변 -- 이 함수는 "이미
// link되어 끝난" 티켓만 청소 대상으로 본다).
// HYK-498 §2 ⓘⓘ(P2-B, docs/HYK-494-runner-lock-design.md §15-2 "대가"
// 문단 그대로): write(tmp)와 link 사이에서 죽은 회수자가 남긴
// `<prefix><k>.tmp.<suffix>`는 위 루프가 (suffix가 숫자뿐이 아니라서)
// 그냥 지나친다 -- §13-9 수리가 "다른 회수자의 진행 중 tmp를 절대
// 건드리지 않는다"를 지키려고 일부러 전부 건너뛰게 했기 때문이다. 그
// 결과 "죽은" 경우도 같이 걸러져 그 tmp 이름이 영구히 남는다(디스크
// 공간 누수뿐, 불변식에는 영향 없음 -- 아무도 그 이름을 다시 참조하지
// 않는다). 이 함수가 그 이름만(완성 티켓은 건드리지 않음) 대상으로
// "쓴 사람이 죽었다고 확정될 때만" 지운다 -- §13-9가 금지한 "살아 있는
// 다른 회수자의 진행 중 tmp를 지우는 규칙"이 되지 않는 이유: tmp의
// 내용(createExclusive가 link 전에 이미 다 쓴 `{pid, procStart}`)을
// 읽어 identityIsDead로 판정한다. 그 회수자가 아직 살아 있으면(보통
// 경로) isPidAliveFn이 true를 돌려 반드시 dead:false가 되어 지우지
// 않는다 -- D2 "before-ticket-link" 칸(actor A가 바로 이 자리에 멈춰
// 있는 동안 actor B가 같은 lockId로 이 함수를 부르는 시험)이 이를
// 실측으로 지킨다. 읽기/파싱이 실패하면(쓰는 중 · 이미 자기 자신이
// 치운 뒤 등) 모호한 쪽은 손대지 않는다(아래 §0 답, 변이 ④/⑤ 참고).
// Pulled out of cleanupAfterReclaim below purely to keep that function's
// own complexity gate happy (same line-count/complexity-gate reasoning as
// every other extraction in this file). Handles exactly one stray
// `<k>.tmp.<suffix>` name: deletes it only if the tmp's own content
// (already fully written by createExclusive before link, §(d)) names a
// writer that identityIsDead confirms dead -- never on ambiguity (can't
// read/parse) and never while the writer is still alive. See
// cleanupAfterReclaim's own header comment for why this can never
// reintroduce §13-9 (a live reclaimer's in-flight tmp always resolves
// isPidAliveFn===true -> dead:false -> skipped).
function maybeCleanupDeadReclaimerTmp({
  namePath,
  readFileFn,
  unlinkFn,
  isPidAliveFn,
  getStartIdentityFn,
}) {
  if (!readFileFn || !isPidAliveFn || !getStartIdentityFn) return; // 주입 안 됐으면 생략(best-effort).
  let tmpContent;
  try {
    tmpContent = JSON.parse(readFileFn(namePath, "utf8"));
  } catch {
    return; // 쓰는 중이거나 이미 지워졌다 -- 모호하면 손대지 않는다.
  }
  const verdict = identityIsDead({
    content: tmpContent,
    isPidAliveFn,
    getStartIdentityFn,
  });
  if (!verdict.dead) return; // 살아 있는 회수자의 진행 중 tmp -- 절대 지우지 않는다.
  try {
    unlinkFn(namePath);
  } catch {
    // best-effort.
  }
}

function cleanupAfterReclaim({
  lockPath,
  lockId,
  unlinkFn,
  readdirFn,
  readFileFn,
  isPidAliveFn,
  getStartIdentityFn,
}) {
  try {
    unlinkFn(aliveFilePath(lockPath, lockId));
  } catch {
    // best-effort.
  }
  let names;
  try {
    names = readdirFn(dirname(lockPath));
  } catch {
    return;
  }
  const prefix = reclaimTicketPrefix(lockPath, lockId);
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      // 완성(link된) 티켓 -- 기존 동작 그대로, 무회귀.
      try {
        unlinkFn(join(dirname(lockPath), name));
      } catch {
        // best-effort.
      }
      continue;
    }
    if (!/^\d+\.tmp\./.test(suffix)) continue; // 알려진 모양이 아니면 손대지 않는다.
    maybeCleanupDeadReclaimerTmp({
      namePath: join(dirname(lockPath), name),
      readFileFn,
      unlinkFn,
      isPidAliveFn,
      getStartIdentityFn,
    });
  }
}

// Pulled out of resolveContendedStep below -- the "재확인 읽기 -> 성공하면
// lockId 일치 시 unlink L, 그 뒤에만 청소" 단계(§(d) 의사 코드 "reread ="
// 그대로). 새 회수권을 막 만든 바로 다음(기존 경로)과, 다음 라운드에
// "자기 자신의" 살아 있는 회수권 k를 다시 쥔 채로 재시도하는 경로(HYK-494
// 후속 P1-1 수리, 아래) 둘 다 이 단계를 그대로 재사용한다. 반환값은
// reread가 성공했는지(reread.ok) -- 자기-회수권 재시도 경로만 그 값으로
// "claim-again"과 "바쁨 재시도" 중 무엇을 할지 고른다(기존 경로는 무조건
// claim-again, 무회귀).
function rereadLockAndMaybeCleanup({
  lockPath,
  content,
  readFileFn,
  unlinkFn,
  readdirFn,
  isPidAliveFn,
  getStartIdentityFn,
}) {
  const reread = readLockContentResult(readFileFn, lockPath);
  if (reread.ok) {
    if (reread.content?.lockId === content.lockId) {
      try {
        unlinkFn(lockPath);
      } catch {
        // L이 그 사이 사라졌다면(또 다른 경합) 유일한 삭제 지점이 이미 비어
        // 있다는 뜻 -- 상태는 우리가 원하는 대로다(L에 O가 없다), 삼킨다.
      }
    }
    // L 삭제 "뒤"에만 청소한다(§(d) 순서 그대로).
    cleanupAfterReclaim({
      lockPath,
      lockId: content.lockId,
      unlinkFn,
      readdirFn,
      readFileFn,
      isPidAliveFn,
      getStartIdentityFn,
    });
  }
  return reread.ok;
}

// §(d) 한 번의 경합 라운드가 orphan O를 만나 취하는 다음 단계. 반환:
// - step:"claim-again" -- 우리가 회수권 k+1을 얻어 L을 지웠다(또는 L이
//   이미 사라져 있었다). 다음 루프에서 즉시 createExclusive(L)을 재시도
//   한다(sleep 없음, §(d) "continue (sleep 없음)").
// - step:"wait" -- O가 아직 ALIVE(판정에서), 또는 회수권 k가 아직 (남이)
//   살아 있는 보유자를 두고 있어 우리가 끼어들지 않는다, 또는 회수권
//   생성 자체에서 졌다(EEXIST, 다른 1명이 이미 k+1을 잡음) -- 전부
//   보통의 폴 대기로 떨어진다.
function resolveContendedStep({
  lockPath,
  content,
  verdict,
  pid,
  procStart,
  readFileFn,
  writeFileFn,
  linkFn,
  unlinkFn,
  readdirFn,
  randomSuffixFn,
  isPidAliveFn,
  getStartIdentityFn,
}) {
  if (!verdict.dead) return { step: "wait" };
  const k = maxReclaimTicketNumber({
    lockPath,
    lockId: content.lockId,
    readdirFn,
  });
  if (k > 0) {
    const holderResult = readLockContentResultDetailed(
      readFileFn,
      reclaimTicketPath(lockPath, content.lockId, k),
    );
    if (holderResult.ok) {
      const isSelf =
        holderResult.content?.pid === pid &&
        holderResult.content?.procStart === procStart;
      if (isSelf) {
        // HYK-494 후속(followup-3) P1-1 교착 수리: 회수권 k는 우리 자신의
        // 것이다 -- 이전 라운드에서 재확인 읽기가 실패해(EBUSY 등) L
        // 삭제를 확인 못 한 채 claim-again만 하고 청소를 건너뛰었을
        // 뿐이다(P2-3 그대로 유지). 그 회수권의 pid가 "살아 있다"는
        // identityIsDead 판정은 사실이지만(우리가 살아 있으니까), 그걸
        // "이미 누가 회수 중이니 기다린다"로 읽으면 자기 자신을 기다리는
        // 교착이 된다(검토 1R P1-1, runner-lock.mjs:429-440 실측 3/3).
        // 기다리지 않고 재확인·삭제 단계를 그 자리에서 재시도한다 -- 새
        // 회수권을 또 만들지 않는다(k 그대로 재사용, "살아 있는 회수권자
        // ≤1" 불변식 무변, 회수 경로 되돌림 0). 선택 ②(바쁨 상한 안에서
        // 그 자리 재시도)를 택한 근거: 재시도를 무조건 claim-again(기존
        // k==0 경로와 같은 모양)으로 두면 reread가 계속 실패하는 동안
        // sleep 없는 타이트 스핀이 된다 -- 이미 검증된 P2-2의 바쁨-
        // 상한-뒤-throw 메커니즘(ticketReadBusy)을 재사용하면 폴 간격
        // sleep과 BUSY_RETRY_TIMEOUT_MS 상한을 둘 다 그대로 얻는다(20분
        // LOCK_WAIT_TIMEOUT_MS 전체를 자기 자신에게 쓰지 않는다).
        const confirmed = rereadLockAndMaybeCleanup({
          lockPath,
          content,
          readFileFn,
          unlinkFn,
          readdirFn,
          isPidAliveFn,
          getStartIdentityFn,
        });
        if (confirmed) return { step: "claim-again" };
        return { step: "wait", ticketReadBusy: true };
      }
      const holderVerdict = identityIsDead({
        content: holderResult.content,
        isPidAliveFn,
        getStartIdentityFn,
      });
      if (!holderVerdict.dead) return { step: "wait" }; // 이미 "남이" 회수 중.
    } else if (!holderResult.enoent) {
      // HYK-494 후속 P2-2: ENOENT 외의 읽기 실패(일시적 공유 위반 등)는
      // "보유자가 지웠다"는 뜻이 아니다 -- 판정 없이 k+1로 가지 않는다
      // (살아 있는 회수권자 ≤1 불변식을 지키려면 여기서 "모르면 기다린다"
      // 로 떨어져야 한다). 호출자가 BUSY_RETRY_TIMEOUT_MS와 같은 상한 뒤
      // throw한다(handleTicketReadBusy).
      return { step: "wait", ticketReadBusy: true };
    }
    // holderResult.enoent===true(표식 자체가 ENOENT)는 "보유자가 이미
    // 지웠다"는 평범한 사실이다 -- 아래에서 k+1을 "시도"하되, 이미 다른
    // 1명이 더 빨리 같은 결론에 이르렀다면 link의 EEXIST가 우리를
    // 걸러낸다(세대 번호 자체가 "정확히 1명" 보장의 원천).
  }
  const myTicket = createExclusive({
    path: reclaimTicketPath(lockPath, content.lockId, k + 1),
    content: { pid, procStart },
    writeFileFn,
    linkFn,
    unlinkFn,
    randomSuffixFn,
  });
  if (!myTicket.ok) return { step: "wait" }; // k+1을 못 얻음(EEXIST) -- 다음 폴.
  // HYK-494 후속 P2-3: 재확인 읽기 자체가 실패하면(반환값 false) L을
  // 지웠는지 확인할 길이 없다 -- 이 경우 청소를 건너뛴다(설계 논증 4·5의
  // 전제 "청소 = L 삭제 뒤"를 글자대로 지킨다). 우리 회수권(과 O의
  // heartbeat 파일)은 그대로 남아 "살아 있는 회수권자 ≤1"을 계속
  // 보장한다 -- 다음 라운드가 (바로 위 isSelf 분기로) L을 다시 읽어
  // 확인한다. 성공/실패 어느 쪽이든 무조건 claim-again -- 기존 동작
  // 무변(무회귀, isSelf 분기만 그 값을 보고 갈라진다).
  rereadLockAndMaybeCleanup({
    lockPath,
    content,
    readFileFn,
    unlinkFn,
    readdirFn,
    isPidAliveFn,
    getStartIdentityFn,
  });
  return { step: "claim-again" };
}

// Static (call-independent) defaults -- object spread, 2R과 같은 이유
// (ESLint complexity gate, 2R의 ACQUIRE_LOCK_STATIC_DEFAULTS 주석 그대로).
const ACQUIRE_LOCK_STATIC_DEFAULTS = {
  worktree: null,
  head: null,
  nowMs: Date.now,
  sleepFn: defaultSleepSync,
  pollIntervalMs: LOCK_POLL_INTERVAL_MS,
  timeoutMs: LOCK_WAIT_TIMEOUT_MS,
  heartbeatStaleMs: HEARTBEAT_STALE_MS,
  busyRetryTimeoutMs: BUSY_RETRY_TIMEOUT_MS,
  writeFileFn: writeFileSync,
  readFileFn: readFileSync,
  unlinkFn: unlinkSync,
  linkFn: linkSync,
  readdirFn: readdirSync,
  randomSuffixFn: randomSuffix,
  isPidAliveFn: defaultIsPidAlive,
  getStartIdentityFn: defaultGetStartIdentity,
  // HYK-494 후속 P2-1: 기본은 no-op -- 이 값을 언급하지 않는 기존/다른
  // 모든 호출자는 이 변경 전과 똑같이 조용하다(product_scope 무회귀,
  // useAutoConcurrency/startHeartbeatFn과 같은 "기본은 OFF" 패턴).
  logFn: () => {},
  env: process.env,
  nestedEnvVar: NESTED_LOCK_BYPASS_ENV_VAR,
};

// `pid`/`startedAtMs`/`procStart`는 매 호출마다 새로 구해야 하는 seam --
// process.pid는 호출 간 사실상 불변이지만 Date.now()는 아니다(static
// 객체에 박으면 모듈 로드 시각에 얼어붙는다, 2R resolveAcquireLockOptions
// 주석과 같은 근거). procStart는 getStartIdentityFn(resolveAcquireLock
// Options가 최종 결정한 값)로 "나 자신"의 시작 신원을 구한다 -- 이 값이
// 나중에 "내 잠금을 누가 재사용-오판하지 않게"(§(g) 2) 쓰인다.
function resolveAcquireLockOptions(opts) {
  const merged = {
    pid: process.pid,
    startedAtMs: Date.now(),
    ...ACQUIRE_LOCK_STATIC_DEFAULTS,
    ...opts,
  };
  return {
    ...merged,
    procStart: merged.getStartIdentityFn(merged.pid),
  };
}

// Pulled out of acquireRunnerLock below -- 2R tryNestedBypass와 동일
// 역할/동일 근거(line-count gate). 값이 "지금 이 경로의 잠금"의 lockId와
// 정확히 같을 때만 통과시킨다(바깥에서 손으로 켠 값은 난수와 맞을 수
// 없다).
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
        reclaimReason: null,
        priorOwner: null,
        timedOut: false,
        nestedBypassRejected: false,
      },
    };
  }
  return { attempted: true, result: null };
}

function buildClaimedResult({
  lockPath,
  waitStartMs,
  nowMs,
  pollCount,
  reclaimedOrphan,
  reclaimReason,
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
    reclaimReason,
    priorOwner,
    timedOut: false,
    nestedBypassRejected,
    lockId,
  };
}

// HYK-494 후속(followup-3) P2-3: 시간 초과 결과는 "회수를 시도했지만
// 확정하지 못했다"는 뜻이다 -- claim-again이 state.reclaimedOrphan=true를
// 낙관적으로 세워도(재확인 읽기가 실패해 L 삭제를 확인 못 한 채 반복
// 됐을 수 있다, 위 isSelf 분기), 최종 결과가 timedOut이면 "회수함" 플래그
// (와 그 사유)를 지운다 -- 둘 중 하나만 지우면 reclaimReason만 남아
// 더 헷갈린다(영수증 lock_reclaimed_orphan 오독 방지, 검토 1R P2-3 참고).
// `reclaimedOrphan`/`reclaimReason`을 더 이상 받지 않는다(호출자가
// 여전히 넘겨도 무시한다 -- 무회귀).
function buildTimedOutResult({
  lockPath,
  waitStartMs,
  elapsed,
  nowMs,
  pollCount,
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
    reclaimedOrphan: false,
    reclaimReason: null,
    priorOwner,
    timedOut: true,
    nestedBypassRejected,
  };
}

// ③ 잡는 순간 heartbeat -- 매 라운드 갱신. best-effort(쓰기 실패해도
// claim 시도 자체는 계속한다, sidecar가 이어서 또 시도한다).
function refreshOwnAliveFile({ lockPath, lockId, writeFileFn, nowMs }) {
  try {
    writeFileFn(
      aliveFilePath(lockPath, lockId),
      JSON.stringify({ aliveAtMs: nowMs() }),
    );
  } catch {
    // best-effort.
  }
}

// Pulled out of handleFailedClaim's two timeout-check sites below -- purely
// to keep that function's own line-count gate happy (same reasoning as
// every other small extraction in this file). Returns the timed-out result
// or `null` ("not yet, caller should sleep and poll again").
function maybeTimeOut({ nowMs, waitStartMs, timeoutMs, ...resultFields }) {
  const elapsed = nowMs() - waitStartMs;
  if (elapsed < timeoutMs) return null;
  return buildTimedOutResult({ waitStartMs, elapsed, nowMs, ...resultFields });
}

// Pulled out of handleContendedClaim's two "poll once more, unless we've
// hit the upper bound" sites below -- same line-count-gate reasoning.
// Always increments `state.pollCount`; returns the timed-out result or
// sleeps and returns `null`.
function sleepOrTimeOut({
  state,
  nowMs,
  waitStartMs,
  timeoutMs,
  sleepFn,
  pollIntervalMs,
  timedOutFields,
}) {
  state.pollCount += 1;
  const timedOut = maybeTimeOut({
    nowMs,
    waitStartMs,
    timeoutMs,
    ...timedOutFields(),
  });
  if (timedOut) return timedOut;
  sleepFn(pollIntervalMs);
  return null;
}

// Pulled out of handleFailedClaim below -- the "busy" (EPERM/EBUSY/EACCES,
// transient) branch only, same line-count-gate reasoning as every other
// extraction in this file. Mutates `state.busySinceMs`/`state.pollCount`.
// Throws past the bounded retry window (createExclusive's own header);
// otherwise always returns `null` (sleep already applied, loop continues).
function handleBusyClaim({
  claim,
  state,
  lockPath,
  nowMs,
  sleepFn,
  pollIntervalMs,
  busyRetryTimeoutMs,
}) {
  if (state.busySinceMs === null) state.busySinceMs = nowMs();
  if (nowMs() - state.busySinceMs > busyRetryTimeoutMs) {
    throw new Error(
      `runner-lock: createExclusive busy (${claim.err?.code}) for over ` +
        `${busyRetryTimeoutMs}ms at ${lockPath} -- refusing to wait forever`,
    );
  }
  state.pollCount += 1;
  sleepFn(pollIntervalMs);
  return null;
}

// HYK-494 후속 P2-2: the bounded-retry-then-throw counterpart of
// handleBusyClaim above, for a reclaim ticket read that keeps failing
// (non-ENOENT) -- same BUSY_RETRY_TIMEOUT_MS-shaped reasoning (an unknown
// ticket holder must never be treated as "safely absent" forever; past the
// bound this throws rather than silently waiting past LOCK_WAIT_TIMEOUT_MS
// too, same "정직 > 낙관" posture as handleBusyClaim). Mutates
// `state.ticketReadBusySinceMs`/`state.pollCount`.
function handleTicketReadBusy({
  state,
  lockPath,
  nowMs,
  sleepFn,
  pollIntervalMs,
  busyRetryTimeoutMs,
}) {
  if (state.ticketReadBusySinceMs === null)
    state.ticketReadBusySinceMs = nowMs();
  if (nowMs() - state.ticketReadBusySinceMs > busyRetryTimeoutMs) {
    throw new Error(
      `runner-lock: reclaim ticket read busy (non-ENOENT) for over ` +
        `${busyRetryTimeoutMs}ms at ${lockPath} -- refusing to advance past ` +
        `a possibly-alive ticket holder without a verdict`,
    );
  }
  state.pollCount += 1;
  sleepFn(pollIntervalMs);
  return null;
}

// Pulled out of handleContendedClaim below -- judge the existing owner O,
// then act on that verdict via resolveContendedStep. Same line-count-gate
// reasoning as every other extraction in this file.
function judgeAndResolveStep({
  existing,
  lockPath,
  pid,
  procStart,
  readFileFn,
  writeFileFn,
  linkFn,
  unlinkFn,
  readdirFn,
  randomSuffixFn,
  isPidAliveFn,
  getStartIdentityFn,
  heartbeatStaleMs,
  nowMs,
}) {
  const verdict = judgeOwner({
    content: existing,
    isPidAliveFn,
    readAliveAgeMsFn: (lockId2) =>
      readAliveAgeMs({ lockPath, lockId: lockId2, readFileFn, nowMs }),
    heartbeatStaleMs,
    getStartIdentityFn,
  });
  const step = resolveContendedStep({
    lockPath,
    content: existing,
    verdict,
    pid,
    procStart,
    readFileFn,
    writeFileFn,
    linkFn,
    unlinkFn,
    readdirFn,
    randomSuffixFn,
    isPidAliveFn,
    getStartIdentityFn,
  });
  return { verdict, step };
}

// Pulled out of handleFailedClaim below -- the EEXIST (a real other owner)
// branch only: read O, judge it, act on resolveContendedStep's verdict. Same
// line-count-gate reasoning/mutate-`state`-in-place contract as
// handleBusyClaim above.
// Pulled out of handleContendedClaim below -- purely to keep that
// function's own line-count gate happy (same reasoning as every other
// small extraction in this file). HYK-494 후속 P2-1: judge(O)가 "낡음
// 만으로는 회수 안 함"(alive-heartbeat-stale)으로 떨어질 때 대기자 로그에
// 1줄 남긴다(설계 (d) 원문). 매 폴 반복해도 상태가 그대로면(여전히
// alive-heartbeat-stale) 또 찍지 않는다 -- 상태가 "바뀔 때"만(여기
// 들어오거나 벗어날 때) 1번. Mutates `state.aliveHeartbeatStaleLogged`.
function logAliveHeartbeatStaleOnce({ state, verdict, existing, logFn }) {
  if (verdict.reason !== "alive-heartbeat-stale") {
    state.aliveHeartbeatStaleLogged = false;
    return;
  }
  if (state.aliveHeartbeatStaleLogged) return;
  logFn(
    `[runner-lock] waiting: owner (pid ${existing?.pid}) heartbeat is ` +
      `stale but startIdentity still matches -- NOT reclaiming ` +
      `(alive-heartbeat-stale)`,
  );
  state.aliveHeartbeatStaleLogged = true;
}

function handleContendedClaim({
  state,
  lockPath,
  pid,
  procStart,
  waitStartMs,
  nestedBypassRejected,
  readFileFn,
  writeFileFn,
  linkFn,
  unlinkFn,
  readdirFn,
  randomSuffixFn,
  isPidAliveFn,
  getStartIdentityFn,
  nowMs,
  heartbeatStaleMs,
  sleepFn,
  pollIntervalMs,
  timeoutMs,
  busyRetryTimeoutMs,
  logFn,
}) {
  const timedOutFields = () => ({
    lockPath,
    pollCount: state.pollCount,
    reclaimedOrphan: state.reclaimedOrphan,
    reclaimReason: state.reclaimReason,
    priorOwner: state.priorOwner,
    nestedBypassRejected,
  });
  const readResult = readLockContentResult(readFileFn, lockPath);
  if (!readResult.ok) {
    // 읽기 실패 != 고아(2R P1-1 수리, 무변) -- 그냥 바쁘다로 보고 재시도.
    return sleepOrTimeOut({
      state,
      nowMs,
      waitStartMs,
      timeoutMs,
      sleepFn,
      pollIntervalMs,
      timedOutFields,
    });
  }
  const existing = readResult.content;
  state.priorOwner = existing;
  const { verdict, step } = judgeAndResolveStep({
    existing,
    lockPath,
    pid,
    procStart,
    readFileFn,
    writeFileFn,
    linkFn,
    unlinkFn,
    readdirFn,
    randomSuffixFn,
    isPidAliveFn,
    getStartIdentityFn,
    heartbeatStaleMs,
    nowMs,
  });
  logAliveHeartbeatStaleOnce({ state, verdict, existing, logFn });
  return dispatchContendedStep({
    state,
    step,
    verdict,
    lockPath,
    nowMs,
    waitStartMs,
    timeoutMs,
    sleepFn,
    pollIntervalMs,
    busyRetryTimeoutMs,
    timedOutFields,
  });
}

// Pulled out of handleContendedClaim above -- purely to keep that
// function's own line-count gate happy (same reasoning as every other
// small extraction in this file). Acts on judgeAndResolveStep's verdict:
// "claim-again" (no sleep), a ticket-read-busy bounded wait (P2-2), or the
// ordinary poll-and-maybe-timeout wait.
function dispatchContendedStep({
  state,
  step,
  verdict,
  lockPath,
  nowMs,
  waitStartMs,
  timeoutMs,
  sleepFn,
  pollIntervalMs,
  busyRetryTimeoutMs,
  timedOutFields,
}) {
  if (step.step === "claim-again") {
    state.reclaimedOrphan = true;
    state.reclaimReason = verdict.reason;
    state.ticketReadBusySinceMs = null;
    return null; // §(d) "continue (sleep 없음)".
  }
  if (step.ticketReadBusy) {
    return handleTicketReadBusy({
      state,
      lockPath,
      nowMs,
      sleepFn,
      pollIntervalMs,
      busyRetryTimeoutMs,
    });
  }
  state.ticketReadBusySinceMs = null;
  return sleepOrTimeOut({
    state,
    nowMs,
    waitStartMs,
    timeoutMs,
    sleepFn,
    pollIntervalMs,
    timedOutFields,
  });
}

// Everything runAcquireLoop's loop body does once a claim attempt FAILS --
// dispatches to the busy-vs-contended branch (same line-count-gate
// reasoning as every other extraction in this file). Mutates `state` in
// place so the caller's own result-building can read it after the loop
// returns. Returns a timed-out result object to propagate, or `null`
// meaning "the loop should go around again".
function handleFailedClaim({
  claim,
  state,
  lockPath,
  nowMs,
  sleepFn,
  pollIntervalMs,
  busyRetryTimeoutMs,
  ...rest
}) {
  if (claim.busy) {
    return handleBusyClaim({
      claim,
      state,
      lockPath,
      nowMs,
      sleepFn,
      pollIntervalMs,
      busyRetryTimeoutMs,
    });
  }
  state.busySinceMs = null; // EEXIST -- a real other owner, not transient busy.
  return handleContendedClaim({
    state,
    lockPath,
    nowMs,
    sleepFn,
    pollIntervalMs,
    busyRetryTimeoutMs,
    ...rest,
  });
}

// §(d) acquire 루프 그대로:
//   loop: write L.alive.<me.lockId> = now         # ③ 잡는 순간 = 이 줄,
//         매 라운드 갱신 -- 대기가 얼마나 길었든 "우리가 이길 그 순간"의
//         heartbeat는 항상 최대 한 폴 간격만큼만 늙어 있다(P1-B가 닫히는
//         바로 그 자리).
//         r = createExclusive(L, {...}) -> true: 끝(claimed)
//         O = read L -> 실패/없음: sleep; continue  (F3 수리 유지)
//         v = judge(O) -> ALIVE: sleep; timeout?; continue
//         k = ...; createExclusive(L.reclaim...) -> 등(resolveContendedStep)
//         continue (claim-again이면 sleep 없음)
function runAcquireLoop(opts) {
  const {
    lockPath,
    content,
    lockId,
    waitStartMs,
    nestedBypassRejected,
    writeFileFn,
    linkFn,
    unlinkFn,
    randomSuffixFn,
    nowMs,
  } = opts;
  const state = {
    pollCount: 0,
    reclaimedOrphan: false,
    reclaimReason: null,
    priorOwner: null,
    busySinceMs: null,
    ticketReadBusySinceMs: null, // HYK-494 후속 P2-2
    aliveHeartbeatStaleLogged: false, // HYK-494 후속 P2-1
  };
  for (;;) {
    refreshOwnAliveFile({ lockPath, lockId, writeFileFn, nowMs });
    const claim = createExclusive({
      path: lockPath,
      content,
      writeFileFn,
      linkFn,
      unlinkFn,
      randomSuffixFn,
    });
    if (claim.ok) {
      return buildClaimedResult({
        lockPath,
        waitStartMs,
        nowMs,
        pollCount: state.pollCount,
        reclaimedOrphan: state.reclaimedOrphan,
        reclaimReason: state.reclaimReason,
        priorOwner: state.priorOwner,
        nestedBypassRejected,
        lockId,
      });
    }
    const timedOut = handleFailedClaim({ claim, state, ...opts });
    if (timedOut) return timedOut;
  }
}

// 반환 모양: { acquired, nested, lockPath, waitMs, waitStartMs, waitEndMs,
//   pollCount, reclaimedOrphan, reclaimReason, priorOwner, timedOut,
//   nestedBypassRejected, lockId? }
// - reclaimReason(HYK-494 3R 신규): "pid-dead" | "pid-reused" | null --
//   reclaimedOrphan===true일 때만 의미 있다(judge가 DEAD로 판정한 이유).
export function acquireRunnerLock(opts) {
  const {
    lockPath,
    pid,
    startedAtMs,
    procStart,
    worktree,
    head,
    nowMs,
    sleepFn,
    pollIntervalMs,
    timeoutMs,
    heartbeatStaleMs,
    busyRetryTimeoutMs,
    writeFileFn,
    readFileFn,
    linkFn,
    unlinkFn,
    readdirFn,
    randomSuffixFn,
    isPidAliveFn,
    getStartIdentityFn,
    logFn,
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
  const nestedBypassRejected = bypass.attempted;

  const lockId = randomUUID();
  const content = { pid, startedAtMs, procStart, worktree, head, lockId };
  try {
    const result = runAcquireLoop({
      lockPath,
      content,
      lockId,
      pid,
      procStart,
      waitStartMs: nowMs(),
      nestedBypassRejected,
      writeFileFn,
      readFileFn,
      linkFn,
      unlinkFn,
      readdirFn,
      randomSuffixFn,
      isPidAliveFn,
      getStartIdentityFn,
      logFn,
      nowMs,
      heartbeatStaleMs,
      sleepFn,
      pollIntervalMs,
      timeoutMs,
      busyRetryTimeoutMs,
    });
    if (!result.acquired) {
      // HYK-494 후속 P2-7: 시간 초과로 포기한 대기자는 자기 heartbeat
      // 파일을 best-effort로 지운다 -- 안 그러면 LOCK_TIMEOUT 1회마다
      // 잠금 디렉터리에 파일이 하나씩 누수된다(불변식 무관, 공간 누수일
      // 뿐 -- cleanupAfterReclaim과 같은 근거).
      cleanupOwnAliveFileBestEffort({ lockPath, lockId, unlinkFn });
    }
    return result;
  } catch (err) {
    // 같은 이유로, 바쁨 상한을 넘겨 throw하는 경로(P2-7의 "또는 busy
    // throw")도 자기 heartbeat 파일을 지운 뒤에 던진다.
    cleanupOwnAliveFileBestEffort({ lockPath, lockId, unlinkFn });
    throw err;
  }
}

// HYK-494 후속 P2-7: a waiter that gives up (timeout OR a bounded-busy
// throw) must remove its OWN L.alive.<lockId> heartbeat file -- best-effort,
// same "space leak only, invariant unaffected" reasoning as
// cleanupAfterReclaim above.
function cleanupOwnAliveFileBestEffort({ lockPath, lockId, unlinkFn }) {
  try {
    unlinkFn(aliveFilePath(lockPath, lockId));
  } catch {
    // best-effort.
  }
}

// §(d) release -- "if read(L).lockId==me.lockId: unlink L else lock_lost=
// true; ...; unlink L.alive.<me>". lockId로만 대조한다(2R까지의 pid
// 대조에서 교체, F11 닫힘) -- 해제는 "그 특정 획득 인스턴스"가 지우는
// 것이지 "그 pid"가 지우는 게 아니다(같은 pid가 재사용되어 새로 잡았을
// 수도 있다는 사실을 F6/judge가 이미 다루지만, 해제 축도 독립적으로
// lockId라는 더 정확한 키를 쓴다). lockId가 맞지 않거나(다른 주인) 파일
// 자체가 없으면(이미 누가 치웠다) 지우지 않고 lockLost:true를 돌린다 --
// 호출자(guardLockForRun)가 이것을 LOCK_LOST(러너 exit 1)로 번역한다.
//
// HYK-494-runner-lock-3-fix1 (라이브 발견, 1R 전건 러너 1회차 실측): L
// 자체는 지워지는데 자기 소유 `L.alive.<lockId>` heartbeat 파일이 영원히
// 남았다 -- §(d) 의사 코드의 "unlink L.alive.<me>" 줄을 빠뜨렸다. L이
// 지워졌는지(lockLost) 여부와 무관하게 항상 best-effort로 치운다 --
// 우리 소유의 파일이고(lockId는 우리가 생성한 난수), 더 이상 참조할
// 길이 없는 채로 남으면 홈 디렉터리에 누수만 쌓인다(§(d) 회수권 청소와
// 같은 "best-effort, 공간 누수일 뿐 불변식 무관" 근거).
export function releaseRunnerLock({
  lockPath,
  lockId,
  readFileFn = readFileSync,
  readdirFn = readdirSync,
  unlinkFn = unlinkSync,
} = {}) {
  const { ok, content } = readLockContentResult(readFileFn, lockPath);
  const cleanupAliveFile = () => {
    if (!lockId) return;
    const alivePath = aliveFilePath(lockPath, lockId);
    try {
      unlinkFn(alivePath);
    } catch {
      // best-effort.
    }
    // P2-c: best-effort sweep of our OWN leftover heartbeat tmp file(s),
    // see cleanupOwnAliveTmpLeftovers's header above.
    cleanupOwnAliveTmpLeftovers({ alivePath, readdirFn, unlinkFn });
  };
  if (!ok || !content || !lockId || content.lockId !== lockId) {
    cleanupAliveFile();
    return {
      released: false,
      lockLost: true,
      reason: "not-our-lock-or-missing",
    };
  }
  try {
    unlinkFn(lockPath);
    cleanupAliveFile();
    return { released: true, lockLost: false, reason: null };
  } catch (err) {
    // 지우기 자체가 실패(권한 등) -- 우리 것이었던 게 맞지만 못 지웠다.
    // 이것도 "더 이상 우리가 안전하게 비웠다고 보증 못 한다"는 뜻이라
    // lockLost로 분류한다(러너는 LOCK_LOST로 끝낸다, 정직 > 낙관).
    cleanupAliveFile();
    return { released: false, lockLost: true, reason: err.message };
  }
}

const DEFAULT_RELEASE_SIGNALS = ["SIGINT", "SIGTERM"];

// SIGINT/SIGTERM에서도 자기 잠금을 해제한다 -- 2R과 동일(정직 한계도 동일,
// 아래 주석 무변): 이 파일의 호출자(runIsolatedSuite)는 spawnSync/Atomics.
// wait로 완전히 동기 차단되는 호출 그래프다. Windows에서는 이 핸들러
// 자체가 전혀 안 돌 수 있다 -- 그 경우 잠금은 "주인이 안 지운" 상태로
// 남지만, 그 주인의 pid는 이미 죽었으므로 다음 획득 시도가 judge()로
// 안전하게 회수한다(ESRCH -> DEAD, 즉시).
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
        // best-effort -- exitFn은 반드시 부른다.
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

// §(d) sidecar -- "매 N: if kill(owner,0) ok -> write L.alive.<token>=now
// (실패해도 계속 · 멈추지 않음). owner 죽으면 종료. L 자체는 열지도 쓰지도
// 않는다"(F8 수리, PM 발견 -- 2R 사이드카는 L을 직접 읽고 고쳐 썼다, 이
// 3R 사이드카는 정적으로 L의 경로 문자열 자체를 아예 참조하지 않는다,
// `lockPath` 인자조차 받지 않는다). `-e` 인라인 스크립트(2R과 같은 기법,
// product_scope 명시 파일 목록 밖의 새 파일을 만들지 않는다).
// `export`: HYK-494 후속(followup-3) P2-2 -- 이 문자열 자체를 결정적으로
// 검사하는 스위트-내 회귀 칸(아래 CI-1 anchor test)이 import해 쓴다(실제
// 사이드카 자식 프로세스를 띄우고 타이밍에 기대는 대신, "쓰기 관용구가
// 여전히 tmp+rename인지"를 소스 문자열로 바로 확인한다 -- 되돌림 변이가
// 스위트 안에서 결정적으로 RED가 된다, 검토 1R P2-2).
export const HEARTBEAT_SCRIPT = [
  "const fs=require('node:fs');",
  "const alivePath=process.argv[1];",
  "const ownerPid=Number(process.argv[2]);",
  "const intervalMs=Number(process.argv[3]);",
  "function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e&&e.code!=='ESRCH';}}",
  "function tick(){",
  "if(!alive(ownerPid)){clearInterval(timer);return;}",
  // HYK-494 후속 CI-1: writeFileSync(alivePath, ...)는 open(O_TRUNC)으로
  // 먼저 비운 뒤 write하는 두 단계라, 그 사이에 (다른 프로세스가) 읽으면
  // 빈 파일을 본다(master CI 541bc95 enforce 빨강,
  // hyk494-runner-lock.test.mjs:1379 "Unexpected end of JSON input" --
  // 읽는 "자리"는 L이 아니라 이 alive 파일, 쓰기가 비원자적이었다). tmp에
  // 전체 내용을 다 쓴 뒤 rename(대상이 있으면 덮어쓴다, design doc §3-1
  // ④ 실측)으로 교체 -- 빈 내용 순간이 전혀 없다(createExclusive의 tmp+
  // link 관용구와 같은 원리, rename은 EEXIST가 없다는 점만 다르다).
  // HYK-494 후속(followup-3) P2-1: Windows에서 rename 자체가 공유 위반으로
  // 실패할 수 있다(검토 1R 실측: 1ms 간격 50회 중 tmp 2108개, 20ms 간격
  // 50회 중 425개 잔존) -- catch에서 tmp를 best-effort unlink한다(지우기도
  // 실패하면 삼킨다, "공간 누수일 뿐 불변식 무관" 근거는 이 파일의 다른
  // best-effort 청소들과 같다). `tmp`를 try 밖에서 선언해 catch가 볼 수
  // 있게 한다.
  "let tmp;try{tmp=alivePath+'.tmp.'+process.pid+'.'+Date.now()+'.'+Math.random().toString(36).slice(2,8);fs.writeFileSync(tmp,JSON.stringify({aliveAtMs:Date.now()}));fs.renameSync(tmp,alivePath);}catch(e){if(tmp){try{fs.unlinkSync(tmp);}catch(e2){}}}",
  "}",
  "const timer=setInterval(tick,intervalMs);",
].join("\n");

// 실제 사이드카를 띄운다(production 전용 -- 단위 시험은 startHeartbeatFn
// 자체를 스텁한다). `stdio:"ignore"` + `unref()`: 2R과 동일 근거.
function defaultSpawnHeartbeat({ alivePath, pid, intervalMs }) {
  const child = spawn(
    process.execPath,
    ["-e", HEARTBEAT_SCRIPT, "--", alivePath, String(pid), String(intervalMs)],
    { stdio: "ignore" },
  );
  child.unref?.();
  return child;
}

// 이 잠금을 "실제로"(nested 아님) 쥔 직후에만 부른다(isolated-suite-
// runner.mjs의 guardLockForRun). `token`은 acquireRunnerLock이 돌린
// lockId -- 사이드카가 쓰는 파일(L.alive.<token>)을 결정한다. 실패해도
// 조용히 no-op 핸들을 돌려준다(heartbeat는 견고성 보강, 잠금 자체의
// 상호 배제는 그게 없어도 깨지지 않는다).
export function startLockHeartbeat({
  lockPath,
  token,
  pid,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  spawnHeartbeatFn = defaultSpawnHeartbeat,
} = {}) {
  try {
    const child = spawnHeartbeatFn({
      alivePath: aliveFilePath(lockPath, token),
      pid,
      intervalMs,
    });
    return {
      stop: () => {
        try {
          child.kill();
        } catch {
          // best-effort.
        }
      },
    };
  } catch {
    return { stop: () => {} };
  }
}
