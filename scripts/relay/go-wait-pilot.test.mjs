import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as supervisor from "./go-wait-supervisor.mjs";
import {
  createArmStore,
  saveStoreAtomic,
  loadStore,
  armStorePath,
  claimTx,
  startTx,
  STATE,
  DISARM_CAUSE,
} from "./arm-state.mjs";
import { watchResult } from "./watch-result.mjs";
import { checkRelayHandshake } from "../check/relay-handshake.mjs";

// HYK-142 6A (패킷-초안.md §4 그룹6·§8): G1~G11 통합 property + 무권한 합성 파일럿 1회.
// 새 상태기계 로직은 0 -- 그룹1~5가 이미 approved한 arm-state Tx(claimTx/startTx/
// finishAttemptTx)·supervisor(runSupervisedAttempt)·watch-result·relay-handshake를
// **조합**했을 때도 계약이 성립하는지만 증명한다. 실 agent 기동 0(adapterFn 전부 stub),
// repo/Linear/외부 쓰기·publish·시크릿·owner 자격 0 -- 전부 os.tmpdir() 기반 격리
// 디렉터리 안에서만 동작한다(패킷 §9, 그룹1~5 테스트 관례 그대로).
//
// 파일럿 5기준(§8, 전부 0이어야 PASS): ① 중복 기동 ② arm 상한 초과 ③ 조용한 질문 정지
// (question이 발생했는데 receipt로 남지 않아 관측 불가능해지는 경우) ④ 타 레인/타 설정
// 소비 ⑤ 사람 게이트 우회(publish_allowed:false 불변 위반). 아래 각 시나리오는 이 5개
// 카운터 중 자신이 검증하는 것을 tally에 더한다 -- 정상 동작이면 전부 0인 채로 끝난다.
//
// coder-2 (HYK-142 review-1 처방, 게이트 3b 국소 수리): coder-1 버전은 S1~S10을 개별
// `test(...)`로 등록해 node:test의 소스-선언 순서대로 실행하고, 파일 끝에서 이름 배열만
// `seededShuffle`해 `shuffled_order=...` 로그로 남겼다 -- seed가 실행 순서·fault 조합에
// 아무 영향도 주지 못하는 감사 문자열에 불과했다(REVIEW 직접 재현: 로그는
// `S3,S10,S6,...`인데 실제 실행은 S1→S10). 이번 버전은 시나리오 본문을 **callable
// registry**로 바꾸고, `seededShuffle(REGISTRY, PILOT_SEED)`가 반환한 순서 그대로 단일
// dispatch test가 순차 `await`로 실제 호출한다 -- planned_order와 actual_execution_order를
// 같은 로그에 남기고 두 값이 정말 같은지 단언한다(§8 요구를 문언대로 충족).
//
// RED(수리 전) -> GREEN(수리 후) 실측: 수리 전 코드는 `shuffled_order` 로그를 만드는
// `SHUFFLED_ORDER` 계산과, S1~S10을 소스 순서대로 등록·실행하는 별개의 `test(...)` 10개가
// 완전히 분리돼 있어 -- planned_order를 바꿔도(seed를 다른 값으로 바꿔도) 실제 실행 순서
// 로그(node --test의 출력 순서)는 절대 안 바뀌었다(review-1이 직접 재현한 결함). 이번
// 버전은 `for (const name of order) await REGISTRY_BY_NAME.get(name).run(tally)` 한
// 루프뿐이라 `order`를 바꾸면 `actual_execution_order`도 구조적으로 함께 바뀐다 -- 더 이상
// 두 값이 우연히 같아 보이는 게 아니라 하나가 다른 하나를 직접 구동한다.
//
// coder-3 (HYK-142 review-2 처방, §9 초과 재설계 라운드): review-2가 S10(arm 상한)이
// **헛단언**임을 실증했다 -- 첫 attempt가 arm을 terminal DISARMED로 만든 뒤 두 번째가
// 실패하므로, 그 실패는 "상한" 때문이 아니라 "이미 해제됨" 때문이었다(cap 1->2로 변조해도
// GREEN). 근본 문제는 "clean 실행 5기준=0"만 보는 파일럿은 각 오라클이 실제로 살아있는지
// (=위반을 실제로 잡는지) 증명하지 못한다는 것이다. 이번 라운드는 5 오라클 각각에
// **negative control**을 더한다: 그 기준을 실제로 위반하는 조건을 주입하면 오라클의 결정이
// 위반을 탐지하는 방향으로 뒤집히고(무주입 기대를 적용하면 RED), 주입을 제거하면 다시
// GREEN이 되는 "주입->RED, 무주입->GREEN" 대비를 오라클마다 성립시킨다. S10은 review-2
// 처방대로 terminal DISARMED에 기대지 않고 arm-state의 실제 예산 경로(G3-2: ARMED이지만
// 예산 소진)를 조합해 재설계했고(아래), 5 오라클의 mutation 증명은 파일 끝 "PILOT NEGATIVE
// CONTROLS" 테스트가 각 오라클의 clean/inject 결정을 나란히 실측·단언한다. arm-state·
// supervisor·watch-result·handshake는 여전히 import/호출만 -- 기능 변경 0.
//
// negative control의 함정 하나(review-2가 S10에서 지적한 것과 동형): 어떤 오라클이 검증하려는
// 바로 그 변수 대신 **부수 조건**이 결정을 좌우하면, 그 변수를 변조해도 결정이 안 바뀌어
// 오라클이 헛단다. 예산 경로에선 makeGrant 기본 max_rejections=0이면 "attempts_total>0 &&
// rejections>=max_rejections"(0>=0)가 항상 참이라 상한 분기를 가려버린다 -- 그래서 상한
// 오라클의 seed는 max_rejections를 높여 오직 max_starts_total만이 결정 변수가 되게 한다.

// ---- 고정 seed PRNG(mulberry32) -- 시나리오 dispatch 순서를 재현 가능하게 섞는다(§8 "고정
// seed로 섞는다"). Date.now()/Math.random() 대신 이 seed만 쓴다(harness 관례). ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PILOT_SEED = 20260714; // 패킷 드롭일 -- 고정, 매 실행 동일 순서
function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function freshDir(label) {
  return mkdtempSync(join(tmpdir(), `go-wait-pilot-${label}-`));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}
// HYK-383: REVIEW 계열 소비는 head_commit: 축(축 ⓐ+ⓑ)도 통과해야 한다 --
// 축 ⓑ가 harnessDir에서 `git rev-parse HEAD`를 직접 읽으므로, "review"
// lane을 쓰는 시나리오는 그 harnessDir를 진짜 git 저장소로 만들어야 한다.
function ensureGitHeadCommit(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync(
    "git",
    ["commit", "-q", "--allow-empty", "-m", "go-wait-pilot test fixture"],
    { cwd: dir },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}
function counter() {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return fn.impl ? fn.impl(...args) : { exitCode: 0, signal: null };
  };
  fn.calls = () => calls;
  fn.count = () => calls.length;
  return fn;
}

const NOW_OK = () => Date.parse("2026-07-14T21:30:00.000Z");

function makeGrant(overrides = {}) {
  return {
    arm_id: "arm-pilot",
    cycle_id: "cycle-pilot",
    human_approval_ref: "sign-pilot",
    issued_at: "2026-07-14T21:00:00.000Z",
    expires_at: "2026-07-14T23:00:00.000Z",
    allowed_lanes: ["coder"],
    allowed_task_ids: ["HYK-142-pilot-1"],
    max_starts_total: 5,
    max_starts_per_lane: 5,
    max_rejections: 0,
    question_policy: "pause",
    error_policy: "pause",
    publish_allowed: false,
    ...overrides,
  };
}
function seedArm(dir, arm_id, grantOverrides = {}) {
  const created = createArmStore(makeGrant({ arm_id, ...grantOverrides }), {
    at: "t0",
  });
  assert.equal(
    created.ok,
    true,
    `seedArm: grant construction must succeed -- ${JSON.stringify(created)}`,
  );
  const path = armStorePath(dir, arm_id);
  const saved = saveStoreAtomic(path, created.store);
  assert.equal(saved.ok, true);
  return path;
}
function makeTask(overrides = {}) {
  return {
    task_id: "HYK-142-pilot-1",
    lane: "coder",
    cycle_id: "cycle-pilot",
    attempt_id: "attempt-1",
    content_hash: "hash-a",
    at: "2026-07-14 21:30 KST",
    cwd: "C:/work/repo",
    config: "coder-profile.json",
    ...overrides,
  };
}
const SCOPE = {
  lane: "coder",
  cwd: "C:/work/repo",
  config: "coder-profile.json",
  allowedTaskIds: ["HYK-142-pilot-1"],
};

// coder-3: G3-2 실제 예산 경로 seed -- arm은 ARMED이지만 예산이 이미 소진된 상태
// (attempts_total==cap). terminal DISARMED가 아니므로 다음 admissible task의 claim은
// **오직 max_starts_total 상한**(claim()의 budget 분기)에 걸려 거부돼야 한다. max_rejections를
// 높게 둬서 "attempts_total>0 && rejections>=max_rejections" 부수 분기가 상한 분기를 가리지
// 않게 한다 -- 그래야 cap 1->2 변조가 결정을 뒤집는다(부수분기 마스킹=또 다른 헛단언).
function seedArmAtCap(
  dir,
  arm_id,
  { max_starts_total, attempts_total, allowed_task_ids },
) {
  const created = createArmStore(
    makeGrant({
      arm_id,
      max_starts_total,
      max_starts_per_lane: 5,
      max_rejections: 5,
      allowed_task_ids,
    }),
    { at: "t0" },
  );
  assert.equal(
    created.ok,
    true,
    `seedArmAtCap: grant must be valid -- ${JSON.stringify(created)}`,
  );
  const atCap = {
    ...created.store,
    state: STATE.ARMED,
    attempts_total,
    attempts_per_lane: { coder: attempts_total },
  };
  const path = armStorePath(dir, arm_id);
  const saved = saveStoreAtomic(path, atCap);
  assert.equal(saved.ok, true);
  return path;
}

// coder-3: terminal-DISARMED 영속이 유실/롤백된 상황(재-ARMED)을 디스크에서 흉내낸다 --
// 중복 기동 오라클(①)이 방어하는 바로 그 실패. ARMED store는 claim 레코드를 갖지 않아야
// 하므로(decodeStore 의미 규칙 line 300) claims를 비우고 disarm 흔적을 지운다.
function reArmOnDisk(path) {
  const loaded = loadStore(path);
  assert.equal(
    loaded.ok,
    true,
    `reArmOnDisk: store must load -- ${loaded.reason ?? ""}`,
  );
  const reArmed = {
    ...loaded.store,
    state: STATE.ARMED,
    claims: {},
    disarm_cause: null,
    disarmed_at: null,
    needs_human_ack: false,
  };
  const saved = saveStoreAtomic(path, reArmed);
  assert.equal(saved.ok, true);
}

// ---------------------------------------------------------------------------
// S1: 동시 watcher 2개 · 서로 다른 task/lane -- 각자 격리된 harnessDir을 폴링,
// 서로의 파일을 절대 못 봄(cross-consumption 0). watchResult를 fake sleepFn(즉시
// resolve)+fake nowFn으로 동시 구동한다(promise 동시성, 진짜 프로세스 병렬은 아님 --
// 무권한 합성 파일럿의 stub 범위, 관찰 항목으로 분리 -- review-1 관찰란 그대로).
// ---------------------------------------------------------------------------
async function scenarioS1(tally) {
  const dirA = freshDir("watchA");
  const dirB = freshDir("watchB");
  try {
    writeFileSync(
      join(dirA, "coder-task.md"),
      "task_id: HYK-142-pilot-A\ndropped_at: 2026-07-14 21:00 KST\n",
      "utf8",
    );
    const headCommitB = ensureGitHeadCommit(dirB);
    writeFileSync(
      join(dirB, "review-task.md"),
      `task_id: HYK-142-pilot-B\ndropped_at: 2026-07-14 21:00 KST\nhead_commit: ${headCommitB}\n`,
      "utf8",
    );
    // A finishes immediately; B is still pending when the loop starts, then finishes on tick 1.
    writeFileSync(
      join(dirA, "coder.md"),
      "task_id: HYK-142-pilot-A\n\n>>> DONE: CODER @ 2026-07-14 21:05:00 KST\ndone_stamped_by: finalize-done\n",
      "utf8",
    );

    let bTicks = 0;
    const fakeSleep = () => Promise.resolve();
    const [resA, resB] = await Promise.all([
      watchResult({
        role: "coder",
        harnessDir: dirA,
        intervalS: 1,
        maxWaitS: 60,
        sleepFn: fakeSleep,
        nowFn: () => Date.now(),
      }),
      (async () => {
        const r = await watchResult({
          role: "review",
          harnessDir: dirB,
          intervalS: 1,
          maxWaitS: 60,
          sleepFn: async () => {
            bTicks += 1;
            if (bTicks === 1)
              writeFileSync(
                join(dirB, "review.md"),
                `task_id: HYK-142-pilot-B\nhead_commit: ${headCommitB}\n\n>>> DONE: REVIEW @ 2026-07-14 21:06:00 KST\ndone_stamped_by: finalize-done\n`,
                "utf8",
              );
          },
          nowFn: () => Date.now(),
        });
        return r;
      })(),
    ]);

    assert.equal(resA.status, "done");
    assert.equal(resB.status, "done");
    // cross-consumption check: A's own checkFn (default checkRelayHandshake) against dirB
    // must fail to find A's task there -- lanes are structurally isolated by harnessDir.
    const crossCheck = checkRelayHandshake({ role: "coder", harnessDir: dirB });
    if (crossCheck.ok) tally.crossConsumption += 1;
    assert.equal(
      crossCheck.ok,
      false,
      "coder role must not resolve against review's harnessDir",
    );
  } finally {
    cleanup(dirA);
    cleanup(dirB);
  }
}

// ---------------------------------------------------------------------------
// S2: stale DONE -- arm이 이미 DONE/DISARMED된 뒤 같은 task로 재드롭(지연된 워커
// 재시도 등)돼도 중복 spawn 0.
// ---------------------------------------------------------------------------
function scenarioS2(tally) {
  const dir = freshDir("stale-done");
  const arm_id = "arm-pilot-stale";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: null });
    const first = supervisor.runSupervisedAttempt(
      dir,
      arm_id,
      SCOPE,
      makeTask(),
      { nowFn: NOW_OK, adapterFn },
    );
    assert.equal(first.ok, true);
    assert.equal(first.outcome, "done");
    assert.equal(adapterFn.count(), 1);

    // Stale retry: same arm, same task, a later attempt_id (simulating a watcher that
    // woke up late and re-dropped the same relay task after it already completed).
    const retry = supervisor.runSupervisedAttempt(
      dir,
      arm_id,
      SCOPE,
      makeTask({ attempt_id: "attempt-stale-retry" }),
      { nowFn: NOW_OK, adapterFn },
    );
    assert.equal(
      retry.ok,
      false,
      "a DISARMED arm must refuse any further claim",
    );
    if (adapterFn.count() !== 1) tally.duplicateSpawns += 1;
    assert.equal(
      adapterFn.count(),
      1,
      "stale re-claim must not invoke the adapter a second time",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S3: claim/start 전후 save crash -- start 단계의 원자 저장(RUNNING persist)이
// 실패하면 spawn은 절대 호출되지 않는다(I2). 중복 spawn 0.
// ---------------------------------------------------------------------------
function scenarioS3(tally) {
  const dir = freshDir("save-crash");
  const arm_id = "arm-pilot-crash";
  try {
    seedArm(dir, arm_id);
    const task = makeTask();
    const claimed = claimTx(dir, arm_id, task, { nowFn: NOW_OK });
    assert.equal(claimed.spawnAllowed, true);

    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: null });
    let writeCalls = 0;
    const crashingWriteFileFn = () => {
      writeCalls += 1;
      if (writeCalls === 1)
        throw new Error("simulated crash: disk full writing RUNNING state");
      return undefined;
    };
    const started = startTx(
      dir,
      arm_id,
      { task_id: task.task_id, attempt_id: task.attempt_id, at: task.at },
      {
        nowFn: NOW_OK,
        spawnFn: () => {
          adapterFn();
        },
        writeFileFn: crashingWriteFileFn,
      },
    );
    assert.equal(
      started.spawned,
      false,
      "start must fail closed when RUNNING cannot be persisted",
    );
    if (adapterFn.count() !== 0) tally.duplicateSpawns += 1;
    assert.equal(
      adapterFn.count(),
      0,
      "spawn must never be invoked before RUNNING is durably saved (I2)",
    );

    // On-disk truth must still reflect CLAIMED (never a phantom RUNNING) -- the crashed
    // save must have left the store byte-for-byte at its pre-start state.
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.ok, true);
    assert.equal(
      disk.store.state,
      STATE.CLAIMED,
      "a failed RUNNING persist must never leave RUNNING on disk",
    );

    // Recovery: a fresh attempt_id (a real restart would mint a new one, same as group4's
    // restart-recovery contract) must still be refused -- it was never claimed.
    const retried = startTx(
      dir,
      arm_id,
      { task_id: task.task_id, attempt_id: "attempt-1-retry", at: task.at },
      {
        nowFn: NOW_OK,
        spawnFn: () => {
          adapterFn();
        },
      },
    );
    assert.equal(
      retried.spawned,
      false,
      "a mismatched attempt_id (never claimed) must be refused, not silently started",
    );
    assert.equal(
      adapterFn.count(),
      0,
      "still zero spawns -- the crashed attempt has no valid path to a phantom start",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S4: corrupt store -- 디스크 store가 손상돼 있으면 claim 자체가 거부되고 spawn 0.
// ---------------------------------------------------------------------------
function scenarioS4(tally) {
  const dir = freshDir("corrupt-store");
  const arm_id = "arm-pilot-corrupt";
  try {
    const path = armStorePath(dir, arm_id);
    writeFileSync(path, "{ this is not valid JSON at all", "utf8");
    const adapterFn = counter();
    const r = supervisor.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), {
      nowFn: NOW_OK,
      adapterFn,
    });
    assert.equal(r.ok, false);
    if (adapterFn.count() !== 0) tally.duplicateSpawns += 1;
    assert.equal(
      adapterFn.count(),
      0,
      "a corrupt store must never reach the adapter",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S5: question -> 새 arm 재개 -- question은 조용히 사라지지 않는다(receipt로 관측
// 가능), 같은 arm은 절대 재사용되지 않고 재개는 오직 새 arm에서만 가능하다.
// ---------------------------------------------------------------------------
function scenarioS5(tally) {
  const dir = freshDir("question-resume");
  const oldArmId = "arm-pilot-q-old";
  const newArmId = "arm-pilot-q-new";
  try {
    seedArm(dir, oldArmId);
    const adapterFn = counter();
    adapterFn.impl = () => ({
      exitCode: 0,
      signal: null,
      question: { question_id: "q-pilot-1" },
    });
    const r = supervisor.runSupervisedAttempt(
      dir,
      oldArmId,
      SCOPE,
      makeTask(),
      { nowFn: NOW_OK, adapterFn },
    );
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "question");

    const disk = loadStore(armStorePath(dir, oldArmId));
    assert.equal(disk.ok, true);
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.QUESTION);
    const qReceipt = disk.store.receipts.find(
      (rec) => rec.event === "question",
    );
    if (!qReceipt) tally.silentQuestionPauses += 1;
    assert.ok(
      qReceipt,
      "question outcome must leave a discoverable receipt -- a silent pause is a real defect",
    );
    assert.equal(qReceipt.detail.question_id, "q-pilot-1");

    // The old arm must refuse any further claim (no in-place resume).
    const retryOnOld = claimTx(
      dir,
      oldArmId,
      makeTask({ attempt_id: "attempt-resume-attempt" }),
      { nowFn: NOW_OK },
    );
    assert.equal(
      retryOnOld.spawnAllowed,
      false,
      "resuming a QUESTION-disarmed arm in place must be refused",
    );

    // Resume must go through a brand-new arm (new grant, new store).
    seedArm(dir, newArmId);
    const resumed = supervisor.runSupervisedAttempt(
      dir,
      newArmId,
      SCOPE,
      makeTask({ attempt_id: "attempt-resume-2" }),
      { nowFn: NOW_OK, adapterFn: counter() },
    );
    assert.equal(
      resumed.ok,
      true,
      "a fresh arm must be able to carry the resumed attempt",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S6: supervisor 재시작 -- RUNNING 상태로 죽은 채 재기동되면 자동 재실행 금지
// (recover만, spawn 0).
// ---------------------------------------------------------------------------
function scenarioS6(tally) {
  const dir = freshDir("restart");
  const arm_id = "arm-pilot-restart";
  try {
    seedArm(dir, arm_id);
    const task = makeTask();
    const claimed = claimTx(dir, arm_id, task, { nowFn: NOW_OK });
    assert.equal(claimed.spawnAllowed, true);
    // Simulate the process being killed exactly after RUNNING was persisted but before
    // finishAttemptTx ever ran -- startTx persists RUNNING first, then calls spawnFn; we
    // stop right there by making spawnFn itself simulate the kill (no finish call).
    const started = startTx(
      dir,
      arm_id,
      { task_id: task.task_id, attempt_id: task.attempt_id, at: task.at },
      { nowFn: NOW_OK, spawnFn: () => {} },
    );
    assert.equal(started.spawned, true);
    const midCrash = loadStore(armStorePath(dir, arm_id));
    assert.equal(
      midCrash.store.state,
      STATE.RUNNING,
      "arm must be left RUNNING to simulate an orphaned crash",
    );

    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: null });
    const restarted = supervisor.runSupervisedAttempt(
      dir,
      arm_id,
      SCOPE,
      task,
      { nowFn: NOW_OK, adapterFn },
    );
    assert.equal(restarted.phase, "restart_recovery");
    if (adapterFn.count() !== 0) tally.duplicateSpawns += 1;
    assert.equal(
      adapterFn.count(),
      0,
      "restart recovery must never blindly re-spawn a possibly-still-running attempt",
    );

    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.state, STATE.DISARMED);
    assert.equal(
      disk.store.disarm_cause,
      DISARM_CAUSE.INCOMPLETE_CLAIM_RESTART,
    );
    assert.equal(
      disk.store.needs_human_ack,
      true,
      "restart recovery must require a human ack, not silently resolve itself",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S7: Claude/codex abnormal exit -- 비정상 종료가 "done"으로 위장되지 않는다.
// ---------------------------------------------------------------------------
function scenarioS7() {
  const dir = freshDir("abnormal-exit");
  const arm_id = "arm-pilot-abnormal";
  try {
    seedArm(dir, arm_id);
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 1, signal: null }); // e.g. codex CLI crash, no question packet
    const r = supervisor.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), {
      nowFn: NOW_OK,
      adapterFn,
    });
    assert.equal(
      r.ok,
      true,
      "the supervisor call itself completes -- the *outcome* is what must reflect the failure",
    );
    assert.notEqual(
      r.outcome,
      "done",
      "a non-zero exit with no question must never be recorded as done",
    );
    assert.equal(r.outcome, "cli_abnormal_exit");
    const disk = loadStore(armStorePath(dir, arm_id));
    assert.equal(disk.store.disarm_cause, DISARM_CAUSE.ERROR);
    const rec = disk.store.receipts.find(
      (x) => x.event === "cli_abnormal_exit",
    );
    assert.ok(
      rec,
      "the abnormal exit must leave a discoverable receipt, not vanish",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S8: STATUS 편집 실패 -- 선보고 실패 시 claim/spawn 자체가 시작되지 않는다.
// ---------------------------------------------------------------------------
function scenarioS8(tally) {
  const dir = freshDir("status-fail");
  const arm_id = "arm-pilot-status";
  try {
    const path = seedArm(dir, arm_id);
    const before = loadStore(path);
    const adapterFn = counter();
    const reportStatusFn = () => {
      throw new Error("STATUS.md locked by a concurrent editor");
    };
    const r = supervisor.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), {
      nowFn: NOW_OK,
      adapterFn,
      reportStatusFn,
    });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "status_report");
    if (adapterFn.count() !== 0) tally.duplicateSpawns += 1;
    assert.equal(adapterFn.count(), 0);
    const after = loadStore(path);
    assert.equal(
      after.store.attempts_total,
      before.store.attempts_total,
      "a refused pre-claim status report must not spend any budget",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S9: 게이트 known-bad -- 사람 게이트 불변(publish_allowed:false)을 디스크에서 직접
// 뒤집어도(공격/손상 흉내) claim은 거부된다. 우회 0.
// ---------------------------------------------------------------------------
function scenarioS9(tally) {
  const dir = freshDir("known-bad-gate");
  const arm_id = "arm-pilot-tamper";
  try {
    const path = seedArm(dir, arm_id);
    const loadedRaw = loadStore(path);
    assert.equal(loadedRaw.ok, true);
    // Directly hand-edit the on-disk JSON to flip the immutable human-gate field --
    // exactly the "known-bad" tamper this gate exists to catch, not a normal API call.
    const tampered = {
      ...loadedRaw.store,
      grant: { ...loadedRaw.store.grant, publish_allowed: true },
    };
    saveStoreAtomic(path, tampered);

    const adapterFn = counter();
    const r = supervisor.runSupervisedAttempt(dir, arm_id, SCOPE, makeTask(), {
      nowFn: NOW_OK,
      adapterFn,
    });
    assert.equal(
      r.ok,
      false,
      "a tampered publish_allowed:true grant must never be accepted as valid",
    );
    if (adapterFn.count() !== 0) tally.humanGateBypass += 1;
    assert.equal(
      adapterFn.count(),
      0,
      "the human-gate bypass attempt must never reach the adapter",
    );
    // coder-4 (review-3 게이트3 국소 수리): 정확한 손상 사유를 고정한다(실측: 손상된
    // grant는 loadStore에서 STATE_CORRUPT로 거부되고, disarm_cause=state_corrupt,
    // reason에 "publish_allowed"가 포함된다 -- 다른 claim 실패와 혼동될 여지를 없앤다).
    assert.equal(
      r.claim?.store?.disarm_cause,
      DISARM_CAUSE.STATE_CORRUPT,
      "the tamper refusal's disarm_cause must be state_corrupt, not some other claim failure",
    );
    assert.ok(
      typeof r.claim?.reason === "string" &&
        r.claim.reason.includes("publish_allowed"),
      `the tamper refusal's reason must name the tampered field -- got '${r.claim?.reason}'`,
    );

    const after = loadStore(path);
    if (
      after.ok &&
      after.store.grant &&
      after.store.grant.publish_allowed === true
    )
      tally.humanGateBypass += 1;
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// S10 (coder-3 재설계, review-2 처방): arm 상한 초과 -- max_starts_total을 넘는 claim은
// 반드시 거부된다. review-2가 지적한 헛단언(첫 attempt가 arm을 terminal DISARMED로 만든
// 뒤 두 번째가 "이미 해제됨"으로 실패 -> cap 1->2 변조에도 GREEN)을 제거하기 위해, 여기서는
// arm-state의 실제 예산 경로(G3-2: ARMED이지만 attempts_total==cap)를 조합한다. arm은
// terminal DISARMED가 아니라 ARMED이므로, 두 번째 admissible task의 거부는 오직
// max_starts_total 상한(claim()의 budget 분기) 때문이다 -- cap을 1->2로 바꾸면 이 시나리오는
// RED가 된다(그 mutation 증명은 파일 끝 negative-control ②가 실측). arm-state는 호출만.
// ---------------------------------------------------------------------------
function scenarioS10(tally) {
  const dir = freshDir("budget-cap");
  const arm_id = "arm-pilot-budget";
  try {
    seedArmAtCap(dir, arm_id, {
      max_starts_total: 1,
      attempts_total: 1,
      allowed_task_ids: ["HYK-142-pilot-1", "HYK-142-pilot-2"],
    });
    const adapterFn = counter();
    adapterFn.impl = () => ({ exitCode: 0, signal: null });
    // A second admissible task on an ARMED-but-budget-spent arm must be refused at the
    // claim/budget stage -- never reaching a spawn. This is the cap, not a terminal state.
    const r = supervisor.runSupervisedAttempt(
      dir,
      arm_id,
      { ...SCOPE, allowedTaskIds: ["HYK-142-pilot-1", "HYK-142-pilot-2"] },
      makeTask({ task_id: "HYK-142-pilot-2", attempt_id: "attempt-2" }),
      { nowFn: NOW_OK, adapterFn },
    );
    assert.equal(
      r.ok,
      false,
      "a claim beyond max_starts_total must be refused",
    );
    assert.equal(
      r.phase,
      "claim",
      "the refusal must be the claim/budget stage, not a terminal-state artifact",
    );
    if (adapterFn.count() !== 0) tally.budgetExceeded += 1;
    assert.equal(
      adapterFn.count(),
      0,
      "no spawn past the arm cap -- a start after budget exhaustion is a real breach",
    );
    // coder-4 (review-3 게이트3 국소 수리): spawnAllowed/phase만으론 "다른 claim 실패"와
    // 구분되지 않는다 -- 정확한 원인(disarm_cause·reason)을 실측·고정한다(실측값: reason=
    // "arm-state: claim refused -- budget exhausted", disarm_cause="budget_exhausted").
    assert.equal(
      r.claim?.store?.disarm_cause,
      DISARM_CAUSE.BUDGET_EXHAUSTED,
      "the refusal's disarm_cause must be the budget-exhausted cause, not some other claim failure",
    );
    assert.ok(
      typeof r.claim?.reason === "string" &&
        r.claim.reason.includes("budget exhausted"),
      `the refusal's reason must name budget exhaustion -- got '${r.claim?.reason}'`,
    );

    const disk = loadStore(armStorePath(dir, arm_id));
    if (disk.ok && disk.store.attempts_total > 1) tally.budgetExceeded += 1;
    assert.ok(
      !disk.ok || disk.store.attempts_total <= 1,
      "attempts_total must never exceed the cap",
    );
    assert.equal(
      disk.store.disarm_cause,
      DISARM_CAUSE.BUDGET_EXHAUSTED,
      "the on-disk disarm_cause must independently confirm the budget cause",
    );
  } finally {
    cleanup(dir);
  }
}

// ---------------------------------------------------------------------------
// Registry: 이름 -> 실행 함수. 이 배열 순서는 오직 등록용이고, 실제 dispatch 순서는
// 아래 단일 test가 seededShuffle(REGISTRY_NAMES, PILOT_SEED)로 정한 순서를 그대로
// 따른다 -- 등록 순서와 무관하게 seed가 실제 실행 순서를 구동한다(review-1 처방 핵심).
// ---------------------------------------------------------------------------
const REGISTRY = [
  { name: "S1", run: scenarioS1 },
  { name: "S2", run: scenarioS2 },
  { name: "S3", run: scenarioS3 },
  { name: "S4", run: scenarioS4 },
  { name: "S5", run: scenarioS5 },
  { name: "S6", run: scenarioS6 },
  { name: "S7", run: scenarioS7 },
  { name: "S8", run: scenarioS8 },
  { name: "S9", run: scenarioS9 },
  { name: "S10", run: scenarioS10 },
];
const REGISTRY_BY_NAME = new Map(REGISTRY.map((s) => [s.name, s]));

test("PILOT DISPATCH: seed-ordered execution matches the seed's planned order, 5 criteria all 0", async () => {
  const tally = {
    duplicateSpawns: 0,
    budgetExceeded: 0,
    silentQuestionPauses: 0,
    crossConsumption: 0,
    humanGateBypass: 0,
  };
  const plannedOrder = seededShuffle(
    REGISTRY.map((s) => s.name),
    PILOT_SEED,
  );
  const executedOrder = [];

  // Sequential await, in plannedOrder -- this loop IS the dispatch. There is no separate
  // registration step that could drift from it (the coder-1 defect this replaces).
  for (const name of plannedOrder) {
    const scenario = REGISTRY_BY_NAME.get(name);
    assert.ok(scenario, `planned order named an unknown scenario '${name}'`);
    executedOrder.push(name);
    await scenario.run(tally);
  }

  console.log(
    `[go-wait-pilot] seed=${PILOT_SEED} planned_order=${plannedOrder.join(",")}`,
  );
  console.log(
    `[go-wait-pilot] actual_execution_order=${executedOrder.join(",")}`,
  );
  console.log(`[go-wait-pilot] scenarios_run=${executedOrder.length}/10`);
  console.log(
    `[go-wait-pilot] criteria: 중복기동=${tally.duplicateSpawns} arm상한초과=${tally.budgetExceeded} 조용한질문정지=${tally.silentQuestionPauses} 타레인소비=${tally.crossConsumption} 사람게이트우회=${tally.humanGateBypass}`,
  );

  // The core §8 assertion: the seed's planned order and the order actually dispatched
  // must be identical, element for element -- not "close," not "same set," identical.
  assert.deepEqual(
    executedOrder,
    plannedOrder,
    "seed-planned order must equal the order actually dispatched",
  );
  assert.equal(
    executedOrder.length,
    10,
    "all 10 registry scenarios must have been dispatched",
  );

  assert.equal(
    tally.duplicateSpawns,
    0,
    "criterion 1 (중복 기동) must be exactly 0",
  );
  assert.equal(
    tally.budgetExceeded,
    0,
    "criterion 2 (arm 상한 초과) must be exactly 0",
  );
  assert.equal(
    tally.silentQuestionPauses,
    0,
    "criterion 3 (조용한 질문 정지) must be exactly 0",
  );
  assert.equal(
    tally.crossConsumption,
    0,
    "criterion 4 (타 레인/타 설정 소비) must be exactly 0",
  );
  assert.equal(
    tally.humanGateBypass,
    0,
    "criterion 5 (사람 게이트 우회) must be exactly 0",
  );
});

// ===========================================================================
// PILOT NEGATIVE CONTROLS (coder-3, HYK-142 review-2 재설계): 위 dispatch는 "clean 실행
// 5기준=0"만 본다 -- review-2가 실증했듯 그것만으론 각 오라클이 실제로 살아있는지(위반을
// 잡는지) 증명하지 못한다. 아래 테스트는 5 오라클 각각에 대해 그 기준을 **실제로 위반하는
// 조건을 주입**했을 때 오라클의 결정이 위반을 탐지하는 방향으로 뒤집히는지(무주입 기대를
// 적용하면 RED), 주입을 제거하면 다시 GREEN인지를 나란히 실측·단언한다. 어느 오라클이든
// 주입해도 결정이 안 바뀌면(=위반을 못 잡으면) 그 단언이 실패해 이 테스트가 RED가 된다 --
// 헛단언은 통과하지 못한다. arm-state·supervisor·handshake는 import/호출만(기능 변경 0).
// ===========================================================================
// HYK-244 2R-c (한용 확정 2026-08-14 08:29, 조정 금지 -- 예외는 이 함수
// 한 곳뿐): 이 테스트 본문은 max-lines-per-function 상한(80줄)을 훨씬
// 넘는다(266줄) -- 5개 오라클을 나란히 "주입->탐지, 무주입->clean"으로
// 실측하는 단일 서사적 흐름이라 쪼개면 각 오라클이 공유하는 report[]
// 누적/픽스처 상태를 어떻게 나눠도 동작이 바뀔 위험이 있다. 이 트랙
// (HYK-244 소비 완료 영수증)과 무관한 시험이므로 지금 쪼개지 않고,
// 이 함수 하나에만 범위를 한정한 eslint-disable로 예외 처리한다.
// eslint-disable-next-line max-lines-per-function
test("PILOT NEGATIVE CONTROLS: 5 오라클 전부 load-bearing (위반 주입 -> 탐지, 무주입 -> clean)", () => {
  const report = [];

  // ---- 오라클 ② arm 상한 초과 (review-2 핵심 처방, G3-2 실제 예산 경로) --------------
  // 예산이 소진된(attempts_total==cap) ARMED arm에 두 번째 admissible task가 claim한다.
  // 무주입(cap=1): 상한에 걸려 거부. 주입(cap=2): 유일하게 바뀐 변수가 max_starts_total뿐인데
  // 동일 claim이 admit된다 -- 즉 "거부" 기대가 RED가 된다. 거부가 상한을 추적함이 증명된다
  // (terminal DISARMED가 아니라 예산이 결정 변수 -- review-2가 놓쳤던 바로 그 경로).
  {
    const dirClean = freshDir("nc2-clean");
    const dirInject = freshDir("nc2-inject");
    try {
      seedArmAtCap(dirClean, "arm-nc2", {
        max_starts_total: 1,
        attempts_total: 1,
        allowed_task_ids: ["HYK-142-pilot-1", "HYK-142-pilot-2"],
      });
      seedArmAtCap(dirInject, "arm-nc2", {
        max_starts_total: 2,
        attempts_total: 1,
        allowed_task_ids: ["HYK-142-pilot-1", "HYK-142-pilot-2"],
      });
      const t = makeTask({
        task_id: "HYK-142-pilot-2",
        attempt_id: "attempt-2",
      });
      const clean = claimTx(dirClean, "arm-nc2", t, { nowFn: NOW_OK });
      const inject = claimTx(dirInject, "arm-nc2", t, { nowFn: NOW_OK });
      assert.equal(
        clean.spawnAllowed,
        false,
        "무주입(cap=1): 상한 초과 claim은 거부돼야 한다",
      );
      assert.equal(
        inject.spawnAllowed,
        true,
        "주입(cap=2): 상한만 올리면 동일 claim이 admit돼야 한다 -- 안 바뀌면 상한 단언은 헛단언(S10 review-2 결함)",
      );
      // coder-4 (review-3 게이트3): 무주입 거부가 "상한"이라는 사유로 증명되게 -- 불리언
      // 거부가 아니라 disarm_cause/reason으로 원인을 고정한다(실측: budget_exhausted).
      assert.equal(
        clean.store?.disarm_cause,
        DISARM_CAUSE.BUDGET_EXHAUSTED,
        "무주입 거부의 disarm_cause는 budget_exhausted여야 한다 -- cap 때문에 거부됨이 사유로 증명돼야 함",
      );
      assert.ok(
        typeof clean.reason === "string" &&
          clean.reason.includes("budget exhausted"),
        `무주입 거부의 reason에 budget exhausted가 포함돼야 한다 -- got '${clean.reason}'`,
      );
      report.push(
        `오라클② arm상한초과: 무주입(cap=1)->REFUSED(budget_exhausted)=GREEN | 주입(cap=2)->ADMITTED (무주입 기대 'REFUSED' 적용 시 RED) ⇒ 상한 단언 load-bearing`,
      );
    } finally {
      cleanup(dirClean);
      cleanup(dirInject);
    }
  }

  // ---- 오라클 ① 중복 기동 --------------------------------------------------------------
  // 완료돼 DISARMED된(=예산을 쓴) arm은 재드롭돼도 두 번째 agent를 절대 기동하지 않는다.
  // 무주입: 완료된 arm에 다른 admissible task 재드롭 -> 거부, spawn=1 유지. 주입: terminal
  // DISARMED 영속이 유실/롤백된 상황(재-ARMED)을 디스크에서 흉내내면 동일 재드롭이 admit돼
  // 두 번째 spawn이 발생한다(spawn=2) -- DISARMED terminality가 중복 기동을 막는 실제 가드임이
  // 증명된다(무주입 기대 'spawn=1' 적용 시 RED).
  {
    const dir = freshDir("nc1");
    const arm_id = "arm-nc1";
    try {
      seedArm(dir, arm_id, {
        allowed_task_ids: ["HYK-142-pilot-1", "HYK-142-pilot-2"],
        max_rejections: 5,
      });
      const adapter = counter();
      adapter.impl = () => ({ exitCode: 0, signal: null });
      const scope2 = {
        ...SCOPE,
        allowedTaskIds: ["HYK-142-pilot-1", "HYK-142-pilot-2"],
      };
      const first = supervisor.runSupervisedAttempt(
        dir,
        arm_id,
        scope2,
        makeTask(),
        { nowFn: NOW_OK, adapterFn: adapter },
      );
      assert.equal(first.outcome, "done");
      assert.equal(adapter.count(), 1);
      // 무주입: spent(DISARMED) arm에 다른 admissible task -> 거부, 재기동 없음.
      const cleanRetry = supervisor.runSupervisedAttempt(
        dir,
        arm_id,
        scope2,
        makeTask({ task_id: "HYK-142-pilot-2", attempt_id: "attempt-2" }),
        { nowFn: NOW_OK, adapterFn: adapter },
      );
      assert.equal(
        cleanRetry.ok,
        false,
        "무주입: 소진된 DISARMED arm은 어떤 재드롭도 거부해야 한다",
      );
      const countAfterClean = adapter.count();
      // 주입: terminality 유실(재-ARMED) -> 동일 재드롭이 admit -> 두 번째 spawn.
      reArmOnDisk(armStorePath(dir, arm_id));
      supervisor.runSupervisedAttempt(
        dir,
        arm_id,
        scope2,
        makeTask({ task_id: "HYK-142-pilot-2", attempt_id: "attempt-2" }),
        { nowFn: NOW_OK, adapterFn: adapter },
      );
      const countAfterInject = adapter.count();
      assert.equal(
        countAfterClean,
        1,
        "무주입: 소진된 arm은 다시 기동하지 않는다(spawn=1)",
      );
      assert.equal(
        countAfterInject,
        2,
        "주입: terminality가 유실되면 arm이 재기동한다 -- DISARMED 가드가 중복 기동을 막는 것임이 증명됨(안 바뀌면 헛단언)",
      );
      report.push(
        `오라클① 중복기동   : 무주입(소진 arm)->REFUSED(spawns=1)=GREEN | 주입(재-ARMED)->ADMITTED(spawns=2) (무주입 기대 'spawns=1' 적용 시 RED) ⇒ 중복기동 단언 load-bearing`,
      );
    } finally {
      cleanup(dir);
    }
  }

  // ---- 오라클 ③ 조용한 질문 정지 -------------------------------------------------------
  // question outcome은 조용히 사라지지 않고 관측 가능한 receipt를 남겨야 한다. 무주입:
  // question 후 디스크에 "question" receipt가 있어 find로 관측된다. 주입: receipt를 영속
  // store에서 제거(=아무 것도 기록 못 한 buggy pause 흉내)하면 find가 not-found로 뒤집혀
  // 정지가 silent가 된다 -- S5의 `assert.ok(qReceipt)` 관측 단언이 receipt 존재에 실제로
  // 의존함이 증명된다(무주입 기대 'found' 적용 시 RED).
  {
    const dir = freshDir("nc3");
    const arm_id = "arm-nc3";
    try {
      seedArm(dir, arm_id);
      const adapter = counter();
      adapter.impl = () => ({
        exitCode: 0,
        signal: null,
        question: { question_id: "q-nc3" },
      });
      const r = supervisor.runSupervisedAttempt(
        dir,
        arm_id,
        SCOPE,
        makeTask(),
        { nowFn: NOW_OK, adapterFn: adapter },
      );
      assert.equal(r.outcome, "question");
      const path = armStorePath(dir, arm_id);
      const cleanDisk = loadStore(path);
      const cleanFound = !!cleanDisk.store.receipts.find(
        (x) => x.event === "question",
      );
      // 주입: question receipt를 벗겨 영속 -- 관측 불가능해진 silent pause.
      const stripped = {
        ...cleanDisk.store,
        receipts: cleanDisk.store.receipts.filter(
          (x) => x.event !== "question",
        ),
      };
      saveStoreAtomic(path, stripped);
      const injectDisk = loadStore(path);
      const injectFound = !!injectDisk.store.receipts.find(
        (x) => x.event === "question",
      );
      assert.equal(
        cleanFound,
        true,
        "무주입: question outcome은 관측 가능한 receipt를 남겨야 한다",
      );
      assert.equal(
        injectFound,
        false,
        "주입: receipt를 벗기면 정지가 silent가 돼 관측 단언이 not-found로 뒤집혀야 한다(안 바뀌면 헛단언)",
      );
      report.push(
        `오라클③ 조용한질문 : 무주입->receipt FOUND(관측가능)=GREEN | 주입(receipt strip)->NOT FOUND(silent) (무주입 기대 'FOUND' 적용 시 RED) ⇒ 관측 단언 load-bearing`,
      );
    } finally {
      cleanup(dir);
    }
  }

  // ---- 오라클 ④ 타 레인/타 설정 소비 ---------------------------------------------------
  // supervisor는 자기 lane/cwd/config/task만 소비한다. 무주입: 자기 lane(coder) task는
  // 소비된다(spawn=1). 주입: 타 lane(review) task를 coder supervisor에 드롭하면 arm-state를
  // 건드리기 전(phase own_consumption)에 거부돼 절대 소비되지 않는다(spawn=0). 유일하게 바뀐
  // 변수가 task.lane뿐이므로 소비 여부가 lane match를 추적함이 증명된다(무주입 기대 'spawn=1'
  // 적용 시 RED). (harnessDir 격리 교차소비는 S1이 handshake로 이미 커버.)
  {
    const dirClean = freshDir("nc4-clean");
    const dirInject = freshDir("nc4-inject");
    try {
      seedArm(dirClean, "arm-nc4");
      seedArm(dirInject, "arm-nc4");
      const adapterClean = counter();
      adapterClean.impl = () => ({ exitCode: 0, signal: null });
      const adapterInject = counter();
      adapterInject.impl = () => ({ exitCode: 0, signal: null });
      const clean = supervisor.runSupervisedAttempt(
        dirClean,
        "arm-nc4",
        SCOPE,
        makeTask(),
        { nowFn: NOW_OK, adapterFn: adapterClean },
      );
      const inject = supervisor.runSupervisedAttempt(
        dirInject,
        "arm-nc4",
        SCOPE,
        makeTask({ lane: "review" }),
        { nowFn: NOW_OK, adapterFn: adapterInject },
      );
      assert.equal(
        adapterClean.count(),
        1,
        "무주입: 자기 lane task는 정확히 1회 소비된다",
      );
      assert.equal(clean.outcome, "done");
      assert.equal(
        adapterInject.count(),
        0,
        "주입: 타 lane task는 절대 소비되면 안 된다 -- 소비되면 교차소비가 실재",
      );
      assert.equal(
        inject.phase,
        "own_consumption",
        "주입: 거부는 lane 가드(own_consumption) 때문이어야 한다 -- 우연한 다른 실패가 아니라",
      );
      report.push(
        `오라클④ 타레인소비 : 무주입(lane=coder)->CONSUMED(spawns=1)=GREEN | 주입(lane=review)->REFUSED(own_consumption, spawns=0) (무주입 기대 'spawns=1' 적용 시 RED) ⇒ 소비경계 단언 load-bearing`,
      );
    } finally {
      cleanup(dirClean);
      cleanup(dirInject);
    }
  }

  // ---- 오라클 ⑤ 사람 게이트 우회 -------------------------------------------------------
  // publish_allowed:false는 사람 게이트 불변식이다. 무주입: 정상 grant는 admit된다. 주입:
  // 디스크 JSON에서 publish_allowed를 false->true로 손수 뒤집으면(=공격/손상 흉내) claim이
  // 거부된다(decodeStore가 grant를 STATE_CORRUPT로 거부). 유일하게 바뀐 변수가
  // publish_allowed뿐이므로 거부가 이 게이트를 추적함이 증명된다 -- S9는 손상측만 단언했는데,
  // clean측(false->admit)을 더해 변수를 격리한다(review-2 ⑤ 처방: mutation으로 확인·강화).
  {
    const dirClean = freshDir("nc5-clean");
    const dirInject = freshDir("nc5-inject");
    try {
      seedArm(dirClean, "arm-nc5");
      const pathInject = seedArm(dirInject, "arm-nc5");
      const raw = loadStore(pathInject);
      assert.equal(raw.ok, true);
      const tampered = {
        ...raw.store,
        grant: { ...raw.store.grant, publish_allowed: true },
      };
      saveStoreAtomic(pathInject, tampered);
      const t = makeTask();
      const clean = claimTx(dirClean, "arm-nc5", t, { nowFn: NOW_OK });
      const inject = claimTx(dirInject, "arm-nc5", t, { nowFn: NOW_OK });
      assert.equal(
        clean.spawnAllowed,
        true,
        "무주입(publish_allowed:false): 정상 grant는 admit된다",
      );
      assert.equal(
        inject.spawnAllowed,
        false,
        "주입(publish_allowed:true): 변조된 사람 게이트는 거부돼야 한다 -- admit되면 게이트 우회 실재(안 바뀌면 헛단언)",
      );
      // coder-4 (review-3 게이트3): 주입 거부의 정확한 사유를 실측·고정 -- decodeStore가
      // publish_allowed 변조 grant를 STATE_CORRUPT로 거부함을 disarm_cause/reason으로 증명.
      assert.equal(
        inject.store?.disarm_cause,
        DISARM_CAUSE.STATE_CORRUPT,
        "주입 거부의 disarm_cause는 state_corrupt여야 한다 -- 손상 사유가 정확히 이 게이트를 추적함이 증명돼야 함",
      );
      assert.ok(
        typeof inject.reason === "string" &&
          inject.reason.includes("publish_allowed"),
        `주입 거부의 reason에 publish_allowed가 포함돼야 한다 -- got '${inject.reason}'`,
      );
      report.push(
        `오라클⑤ 사람게이트 : 무주입(publish=false)->ADMITTED=GREEN | 주입(publish=true)->REFUSED(state_corrupt) (무주입 기대 'ADMITTED' 적용 시 RED) ⇒ 게이트 단언 load-bearing`,
      );
    } finally {
      cleanup(dirClean);
      cleanup(dirInject);
    }
  }

  console.log(
    "[go-wait-pilot][negative-control] 각 오라클: 위반 주입 시 탐지(무주입 기대 적용 시 RED), 무주입 시 통과(GREEN) 대비 --",
  );
  for (const line of report) console.log(`  ${line}`);
  assert.equal(
    report.length,
    5,
    "5 오라클 negative control이 전부 실행돼야 한다",
  );
});
