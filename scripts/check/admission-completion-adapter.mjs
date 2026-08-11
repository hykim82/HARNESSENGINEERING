// HYK-224 (coder-task.md §1 항 2) -- "완료는 워커의 자기신고가 아니다 --
// 결과 소비자가 dispatch 결속을 검증한 뒤 «중립 실행부」가 기록한다."
//
// checkRelayHandshake (relay-handshake.mjs) is exactly that 중립 실행부: by
// the point it calls this adapter, it has ALREADY independently verified
// task_id binding (task file's task_id === result file's echoed task_id,
// HYK-183 anti-forgery) and staleness (DONE postdates dropped_at). The
// worker's own result file text never determines completion by itself --
// this only fires after checkRelayHandshake's own checks already passed,
// mirroring exactly where autoArchiveRoundEnvelope/autoRecordRejectStreak
// are wired (same call site, same "never mutates the caller's verdict"
// contract).
//
// 정직 한계(S11, same pattern as concurrency-cap-adapter.mjs's `live=false`):
// this is env-gated (`ADMISSION_LEDGER_PATH`), not wired into every relay-
// handshake invocation unconditionally. Reason: the admission ledger is a
// GLOBAL, cross-repo/cross-worktree file (관제실 소유, coder-task §4 -- the
// ps1 side owns that path, not this repo), so this repo cannot hardcode it
// without breaking the isolated-clone CI runner (scripts/check/isolated-
// suite-runner.mjs clones this repo into a disposable tmp dir per run --
// a hardcoded real-world path would make CI runs silently mutate 관제실
// state, or fail there, neither of which this task's scope covers). Until
// the invoking environment (관제실's own launcher/orchestrator wiring, NOT
// this repo) sets that env var, this adapter is a documented no-op
// (`attempted:false`) -- exactly like concurrency-cap-adapter.mjs's own
// "no live caller yet" honesty note when it was first added.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { completeReservation } from "../supervisor/admission-ledger-core.mjs";
import { withLedgerLock } from "../supervisor/admission-ledger-store.mjs";

// HYK-224-3R §3 (REVIEW 2R 반려): 검토자 실측 -- 잘못된 ledger로 이 adapter가
// 실패해도 relay-handshake CLI는 exit 0, 부모 경고는 non-fatal, 게다가 사유
// 텍스트 자체가 비어 있었다("세부 오류가 비어 있었다"). 원인은 아래 두
// 실패 분기(ledger unreadable / store unavailable)가 `readResult.reasonCode`
// /`outcome.reasonCode`만 문자열에 넣고 그 옆의 `.detail`(실제 I/O 에러
// 메시지)을 버리고 있었던 것 -- reasonCode 하나만으로는 "무엇이" 잘못됐는지
// 사람이 알 수 없다. 아래 세 실패 분기 모두 이제 `detail`을 반드시 포함한다.
function reasonWithDetail(reasonCode, detail) {
  return `${reasonCode}${detail ? ` -- ${detail}` : " (no detail available)"}`;
}

export function completeAdmissionReservation({
  reservationId,
  ledgerPath,
  lockPath,
  now = new Date().toISOString(),
}) {
  const outcome = withLedgerLock(ledgerPath, lockPath, (readResult) => {
    if (!readResult.ok) {
      return {
        result: {
          ok: false,
          reasonCode: readResult.reasonCode,
          reason: `admission-completion-adapter: ledger unreadable (${reasonWithDetail(readResult.reasonCode, readResult.detail)}) -- reservation '${reservationId}' NOT released`,
        },
      };
    }
    const complete = completeReservation(readResult.ledger, {
      reservationId,
      now,
    });
    if (!complete.ok) {
      return {
        result: {
          ok: false,
          reasonCode: complete.reasonCode,
          reason: `admission-completion-adapter: completeReservation rejected (${complete.reasonCode}) for '${reservationId}' -- the reservation could not be transitioned to COMPLETED in the current ledger snapshot`,
        },
      };
    }
    return {
      result: {
        ok: true,
        reason: `admission-completion-adapter: reservation '${reservationId}' released (changed=${complete.changed})`,
      },
      nextLedger: complete.changed ? complete.ledger : null,
    };
  });
  if (!outcome.ok) {
    return {
      ok: false,
      reasonCode: outcome.reasonCode,
      reason: `admission-completion-adapter: store unavailable (${reasonWithDetail(outcome.reasonCode, outcome.detail)}) -- reservation '${reservationId}' NOT released`,
    };
  }
  return outcome.result;
}

// appendCompletionFailureAudit -- HYK-224-3R §3's "최소 감사 기록" 요구:
// a failure that only ever reached the screen (console.error) is lost the
// moment the terminal scrolls or the process's stdout isn't captured
// anywhere -- "화면에만 = 도달로 안 침" (coder-task §3). This durably
// appends one JSON line per failure to a file co-located with the ledger
// (`${ledgerPath}.completion-failures.jsonl` -- no new env var, no new
// "얇은 껍데기" surface: derivable from the one path the caller already
// gave us). Best-effort: a failure to even WRITE the audit record is itself
// logged to stderr (never silently swallowed) but never thrown past this
// function's boundary -- an audit-logging failure must not cascade into a
// second, different kind of silent failure.
function appendCompletionFailureAudit({
  ledgerPath,
  reservationId,
  reasonCode,
  reason,
  now,
}) {
  const auditPath = `${ledgerPath}.completion-failures.jsonl`;
  const record = {
    at: now,
    reservationId,
    reasonCode: reasonCode ?? "UNKNOWN",
    reason,
  };
  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    console.error(
      `admission-completion-adapter: FAILED TO WRITE AUDIT RECORD (${auditPath}): ${err.message} -- original failure was: ${reason}`,
    );
  }
}

// autoCompleteAdmission -- the relay-handshake.mjs call-site wrapper.
// `attempted:false` (env var unset) is deliberately distinct from
// `attempted:true, ok:false` (env var set, but the release itself failed) --
// a caller/reader must never conflate "not wired here yet" with "wired and
// silently failing."
export function autoCompleteAdmission({ reservationId }) {
  const ledgerPath = process.env.ADMISSION_LEDGER_PATH;
  if (!ledgerPath) {
    return { attempted: false };
  }
  const lockPath = process.env.ADMISSION_LOCK_PATH || `${ledgerPath}.lock`;
  const outcome = completeAdmissionReservation({
    reservationId,
    ledgerPath,
    lockPath,
  });
  if (!outcome.ok) {
    appendCompletionFailureAudit({
      ledgerPath,
      reservationId,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      now: new Date().toISOString(),
    });
  }
  return { attempted: true, ...outcome };
}

// HYK-224-2R §3 옵션3 -- "제3의 자리(완료를 기록하는 중립 실행부를
// handshake 밖에 두기)". relay-handshake.mjs는 이 파일을 IMPORT하지
// 않는다(1R에서 정확히 그 import가 6개 mutation 시험 파일의 stageTree
// 고정 의존성 목록을 깨서 19건 RED를 냈다 -- coder.md 1R §4). 대신
// relay-handshake.mjs의 CLI 진입점(맨 아래 invokedDirectly 블록)만이
// checkRelayHandshake가 ok:true를 반환한 "뒤"에 이 파일을 별도 자식
// 프로세스로 스폰한다 -- import가 아니라 execFileSync 스폰이므로, 이
// 파일이 격리 픽스처 디렉터리에 없을 때(스폰 자체가 ENOENT로 실패) 그
// 실패는 relay-handshake.mjs 모듈 "로드 시점"이 아니라 "호출 시점"에
// 일어나고, 그 호출부가 try/catch로 감싸 무시한다 -- 그래서 기존
// mutation 시험들의 소규모 격리 의존성 목록을 하나도 건드리지 않는다.
// 정직 한계: in-process로 checkRelayHandshake를 호출하는 호출자(주석에
// 언급된 relay-core.mjs 등)는 이 완료 결선을 받지 못한다 -- CLI 스폰
// 지점에만 있다(autoArchiveRoundEnvelope/autoRecordRejectStreak처럼
// "모든 호출자가 받는다"는 이 파일 안 주석과 달리, 이 축은 CLI 전용).
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/admission-completion-adapter.mjs")
) {
  const reservationId = process.argv[2];
  if (!reservationId) {
    console.error(
      "usage: node admission-completion-adapter.mjs <reservationId>",
    );
    process.exit(1);
  }
  const outcome = autoCompleteAdmission({ reservationId });
  if (!outcome.attempted) {
    console.log(
      "admission-completion-adapter: not attempted (ADMISSION_LEDGER_PATH unset)",
    );
    process.exit(0);
  }
  // HYK-224-3R §3: failures go to stderr, not stdout -- relay-handshake.mjs's
  // spawn wrapper captures BOTH streams separately (stdio:["ignore","pipe",
  // "pipe"]) and its own catch-block logging reads `err.stderr`, which was
  // previously empty for this exact case because this line used console.log
  // for the failure text too (검토자 실측: "세부 오류가 비어 있었다").
  if (outcome.ok) {
    console.log(outcome.reason);
  } else {
    console.error(outcome.reason);
  }
  process.exit(outcome.ok ? 0 : 1);
}
