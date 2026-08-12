// HYK-228 (coder-task.md §2 항1) -- admission sweep의 "발동 주체" 결선.
//
// 출발점(coder-task §1 실측, 이 파일이 메우는 구멍): `sweep` CLI
// (admission-cli.mjs cmdSweep)는 이미 있었지만 프로덕션 호출자가 0건이었다
// -- `orca-stall-detect`/`watch-run`도 sweep을 부르지 않았다. 이 파일이
// 그 "발동 주체" 그 자체다.
//
// 설계 선택(§2 항1 "스케줄러 기반 / 이벤트 기반 중 근거를 대고 선택"):
// **주기(스케줄러) 기반, 기존 watch-run.mjs 사이클에 얹는다** -- 새 병렬
// 스케줄 인프라를 만들지 않는다(coder-task 힌트: "기존 주기 사이클에
// 얹는 것을 선호"). 근거 3가지:
//   1. watch-run.mjs는 이미 OS 스케줄러(schedule-wire.mjs register)가
//      "부르는 실제 러너"다 -- 새 스케줄 등록을 또 하면 이 라운드가 잡으려는
//      "장치는 있는데 발동 안 함"의 실물 사고(§1, OrchStallWatch가 실제로
//      NextRunTime 공백으로 죽었던 사고)를 새 장치에서 또 겪을 위험만
//      늘어난다.
//   2. watch-run.mjs가 매 사이클 남기는 `last-run.json`(생존 기록)과
//      `schedule-wire.mjs status`(freshness 게이트)를 그대로 물려받는다 --
//      sweep 트리거가 이 사이클 안에서 죽으면 watch-run 자신의 생존
//      기록도 갱신되지 않으므로(같은 프로세스, 같은 실행), 요건③(생존
//      보증 게이트)이 별도 장치 없이 이미 성립한다. 아래 CODER 보고서
//      §북극성 1-B 요건③ 참조.
//   3. 이 파일이 하는 일은 "언제 부를지"뿐이다(판단 로직은 여기 없다) --
//      실제 판정(좌석 목록 권위·fail-closed)은 admission-sweep-trigger-
//      core.mjs(순수 코어)에 전부 위임한다("판단은 저장소" 원칙,
//      coder-task §2 설계 제약 그대로).
//
// ★이벤트 트리거 후보(§2 항3 "periodic ↔ event 상호 복구"에 대한 답):
// 이 파일이 내보내는 `runAdmissionSweepTrigger`는 순수 함수 조합(주입된
// execFn·ledgerPath·lockPath만으로 동작, watch-run.mjs의 상태를 전혀
// 읽지 않는다) -- 그래서 **watch-run 사이클(주기)과 별개로, 이 함수를
// 다른 코드 경로(예: 사람이 직접, 또는 향후 relay-handshake.mjs가 "비정상
// 좌석 종료 감지" 시점에)에서 그대로 호출해도 동일하게 동작한다**(이
// 파일 하단 CLI 진입점이 바로 그 "사람이 직접 부르는 이벤트 경로"의
// 실물). 즉 두 트리거(주기적 watch-run 사이클 / 즉시 CLI 호출)는 서로
// 다른 *호출자*일 뿐, 판단·부작용은 완전히 같은 함수 하나로 수렴한다 --
// 한쪽 호출자(스케줄러)가 죽어도 다른 쪽(사람이 CLI를 직접 침)이 정확히
// 같은 결과를 낼 수 있다(admission-sweep-wire.test.mjs "§mutual-recovery"
// 참조, 코드 상태 공유 0을 직접 확증). 진짜 "완전 자동" 이벤트(예:
// dispatch-worker.ps1이 좌석 teardown 직후 자동으로 이 CLI를 호출)는
// 관제실 실행 파일 수정이 필요해 이 라운드 범위 밖이다(§3 비타협) --
// CODER 보고서 §5에 정확한 훅 지점과 문안을 제안만 한다.
//
// ⛔이 파일 자신은 실 관제실 파일을 만들거나 고치지 않는다. `orca`
// 문자열 리터럴 spawn은 orca-adapter.mjs의 createOrcaExecFn 안에서만
// 일어난다(G9, 기존 저장소 규율 그대로 재사용 -- 이 파일이 새로 spawn을
// 열지 않는다).

import { withLedgerLock } from "./admission-ledger-store.mjs";
import { sweepAndRecover } from "./admission-ledger-core.mjs";
import {
  judgeSweepTrigger,
  SWEEP_TRIGGER_VERDICT,
} from "./admission-sweep-trigger-core.mjs";
import {
  buildTerminalListCommand,
  parseTerminalList,
  createOrcaExecFn,
} from "../relay/adapters/orca-adapter.mjs";

export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
export const DEFAULT_RECOVERY_GRACE_MS = 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

// queryTerminalList -- "지금 살아있는 좌석"의 권위 출처 조회 그 자체
// (admission-sweep-trigger-core.mjs 헤더 §4 선언). execFn이 던지거나
// 형식이 이상한 응답을 돌려주면 {ok:false}로 접는다 -- judgeSweepTrigger
// 가 이걸 SEAT_QUERY_FAILED로 fail-closed 처리한다.
export function queryTerminalList(execFn) {
  let response;
  try {
    response = execFn(buildTerminalListCommand());
  } catch (err) {
    return {
      ok: false,
      reason: err && err.message ? err.message : String(err),
    };
  }
  const terminals = parseTerminalList(response);
  if (!terminals) {
    return {
      ok: false,
      reason:
        "orca terminal list query returned no result.terminals (query failed or malformed response)",
    };
  }
  return { ok: true, terminals };
}

// runAdmissionSweepTrigger -- 발동 주체의 몸통. 순수 함수 조합(모든 I/O는
// 주입된 execFn 하나로만 나간다) -- watch-run.mjs의 last-run.json이나
// 다른 어떤 프로세스 상태도 읽지 않는다(주기/이벤트 두 호출자가 완전히
// 같은 결과를 내는 이유, 위 헤더 참조).
export function runAdmissionSweepTrigger({
  ledgerPath,
  lockPath,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  recoveryGraceMs = DEFAULT_RECOVERY_GRACE_MS,
  execFn,
  now = nowIso(),
  terminalListOverride, // 시험 전용 -- execFn 없이 조회 결과를 직접 주입.
}) {
  const terminalList =
    terminalListOverride !== undefined
      ? terminalListOverride
      : queryTerminalList(execFn ?? createOrcaExecFn());
  const judged = judgeSweepTrigger({ terminalList });
  if (judged.verdict !== SWEEP_TRIGGER_VERDICT.PROCEED) {
    // ★비타협(coder-task §4): 여기서 sweepAndRecover를 부르지 않는다 --
    // "조회 실패 -> 좌석 0건 -> 전부 회수"를 이 계층에서 막는다(코어의
    // ABSTAIN 판정을 그대로 존중).
    return {
      ok: false,
      status: "SWEEP_TRIGGER_ABSTAIN",
      reasonCode: judged.reasonCode,
      changed: null,
    };
  }
  const outcome = withLedgerLock(ledgerPath, lockPath, (readResult) => {
    if (!readResult.ok) {
      return {
        result: {
          kind: "state_unavailable",
          reasonCode: readResult.reasonCode,
        },
        nextLedger: null,
      };
    }
    const swept = sweepAndRecover(readResult.ledger, {
      now,
      liveSeatKeys: judged.liveSeatKeys,
      staleAfterMs,
      recoveryGraceMs,
    });
    if (!swept.ok) {
      return {
        result: { kind: "state_unavailable", reasonCode: swept.reasonCode },
        nextLedger: null,
      };
    }
    return {
      result: { kind: "ok", changed: swept.changed },
      nextLedger: swept.changed.length ? swept.ledger : null,
    };
  });
  if (!outcome.ok) {
    return {
      ok: false,
      status: "SWEEP_TRIGGER_STATE_UNAVAILABLE",
      reasonCode: outcome.reasonCode,
      changed: null,
    };
  }
  if (outcome.result.kind === "state_unavailable") {
    return {
      ok: false,
      status: "SWEEP_TRIGGER_STATE_UNAVAILABLE",
      reasonCode: outcome.result.reasonCode,
      changed: null,
    };
  }
  return {
    ok: true,
    status: "SWEEP_TRIGGER_SWEPT",
    reasonCode: "OK",
    changed: outcome.result.changed,
    liveSeatKeyCount: judged.liveSeatKeys.length,
  };
}

// ---- CLI 진입점 -- "이벤트(즉시) 트리거" 그 자체(위 헤더 §이벤트 후보) ----
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

export function runAdmissionSweepWireCli(argv) {
  const args = parseArgs(argv);
  const { ledger: ledgerPath, lock: lockPath } = args;
  if (!ledgerPath || !lockPath) {
    console.error(
      "usage: admission-sweep-wire.mjs --ledger <path> --lock <path> [--stale-after-ms <n>] [--recovery-grace-ms <n>]",
    );
    return 2;
  }
  const result = runAdmissionSweepTrigger({
    ledgerPath,
    lockPath,
    staleAfterMs: args["stale-after-ms"]
      ? Number(args["stale-after-ms"])
      : undefined,
    recoveryGraceMs: args["recovery-grace-ms"]
      ? Number(args["recovery-grace-ms"])
      : undefined,
  });
  if (!result.ok) {
    console.log(`${result.status} reason=${result.reasonCode}`);
    return 4;
  }
  console.log(
    `${result.status} live_seats=${result.liveSeatKeyCount} changed=${JSON.stringify(result.changed)}`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/supervisor/admission-sweep-wire.mjs");
if (invokedDirectly) {
  process.exit(runAdmissionSweepWireCli(process.argv.slice(2)));
}
