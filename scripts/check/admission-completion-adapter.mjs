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
// 정직 한계(S11, same pattern as concurrency-cap-adapter.mjs's `live=false`)
// -- 1R: this was purely env-gated (`ADMISSION_LEDGER_PATH`), never wired
// unconditionally. Reason: the admission ledger is a GLOBAL, cross-repo/
// cross-worktree file (관제실 소유, coder-task §4 -- the ps1 side owns that
// path, not this repo), so this repo cannot hardcode it without breaking
// the isolated-clone CI runner (scripts/check/isolated-suite-runner.mjs
// clones this repo into a disposable tmp dir per run -- a hardcoded
// real-world path would make CI runs silently mutate 관제실 state, or fail
// there, neither of which 1R's scope covered). 1R shipped that env-only
// gate and escalated: nothing in this repo or 관제실 ever SET that env var,
// so in production the adapter was a 100% no-op regardless of how correct
// the call-site wiring was (1R's own coder.md 결과, confirmed by a live
// incident the same night -- ORCH had to hand-run
// `admission-cli complete` because nothing auto-released the slot).
//
// HYK-227 2R §2 (한용 판정 2026-08-12 08:56): env stays first-priority (a
// caller that explicitly sets it always wins, e.g. this file's own test
// suite), but resolvePersistentLedgerPaths() below adds a SECOND source --
// a small JSON pointer file the installer (templates/harness-init/
// install.mjs) writes once, at the one location every process (regardless
// of worktree) can find via mainRepoRoot() -- the exact "one place
// regardless of which worktree runs this" resolution relay-handshake.mjs's
// own reject-streak ledger already relies on (see that file's
// mainRepoRoot(), duplicated here rather than imported to keep this file's
// own isolated-fixture dependency closure unchanged -- see this file's
// own header on why a NEW static import here is exactly the risk 1R's
// spawn-not-import design avoided at the relay-handshake.mjs boundary).
// ⛔ this is "env-priority + persistent fallback", NOT "env got wired in" --
// when BOTH are absent, the adapter is still the exact same documented
// no-op (`attempted:false`) it always was; that branch's behavior and
// message text are UNCHANGED by this round (HYK-227 2R §3 항1 요구).
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { completeReservation } from "../supervisor/admission-ledger-core.mjs";
import { withLedgerLock } from "../supervisor/admission-ledger-store.mjs";

// repoRoot/mainRepoRoot -- duplicated from relay-handshake.mjs's own
// (exported) versions rather than imported. This mirrors the repo-wide
// convention (every scripts/check/*.mjs file that needs this resolves it
// locally -- grep confirms ~30 independent copies) precisely because each
// of these files must stay independently copyable into an isolated
// fixture/target repo without dragging in an unrelated module's full
// import graph (relay-handshake.mjs alone pulls in reject-streak.mjs,
// envelope-archive.mjs, time-authority.mjs -- none of which this adapter
// needs).
function repoRoot() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
    }).trim();
  } catch {
    return process.cwd();
  }
}

function mainRepoRoot() {
  const root = repoRoot();
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf8",
      cwd: root,
    }).trim();
    const absCommonDir = /^([A-Za-z]:[\\/]|\/)/.test(commonDir)
      ? commonDir
      : join(root, commonDir);
    return absCommonDir.replace(/[\\/]\.git$/, "");
  } catch {
    return root;
  }
}

const PERSISTENT_LEDGER_POINTER_FILENAME = "admission-ledger-path.json";

// resolvePersistentLedgerPaths -- reads the installer-written pointer file
// (see install.mjs's installAdmissionLedgerPointer). Fail-open on every
// error shape (file absent, unreadable, malformed JSON, missing/blank
// `ledgerPath` field) -- treated identically to "nothing configured here",
// never a new failure mode layered on top of the pre-existing no-op.
function resolvePersistentLedgerPaths() {
  const pointerPath = join(
    mainRepoRoot(),
    ".harness",
    PERSISTENT_LEDGER_POINTER_FILENAME,
  );
  if (!existsSync(pointerPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
    if (typeof parsed.ledgerPath !== "string" || !parsed.ledgerPath) {
      return null;
    }
    return {
      ledgerPath: parsed.ledgerPath,
      lockPath:
        typeof parsed.lockPath === "string" && parsed.lockPath
          ? parsed.lockPath
          : null,
    };
  } catch {
    return null;
  }
}

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
// `attempted:false` (no ledger path resolved from EITHER source) is
// deliberately distinct from `attempted:true, ok:false` (a path was
// resolved, but the release itself failed) -- a caller/reader must never
// conflate "not wired here yet" with "wired and silently failing."
//
// HYK-227 2R §2/§3 항1: `ADMISSION_LEDGER_PATH` still wins whenever it is
// set (unchanged 1R priority -- e.g. this file's own test suite always
// takes this branch). Only when it is ABSENT does this now fall through to
// resolvePersistentLedgerPaths()'s installer-written pointer file. When
// NEITHER source resolves a path, the outcome is byte-for-byte the exact
// same `{ attempted: false }` 1R always returned -- this branch's shape and
// meaning are unchanged (§3 항1's explicit "사유 문구를 바꾸지 마라").
// HYK-289 (coder-task.md §2-1, "조용한 기본값은 안전장치가 아니다"): the
// persistent-pointer branch below is itself a silent, unconfirmable default
// -- ORCH measured it firing for real from a plain `node
// scripts/check/selfcheck-smoke.mjs` run (no `--test`, no fixture isolation
// at all), durably mutating the REAL control-room ledger's side file. The
// persistent pointer is legitimate PRODUCTION behavior for this adapter's
// real in-process callers (checkRelayHandshake, imported directly by
// scripts/relay/{watch-result,relay-core,orca-spike-runner,orca-spike-live}.mjs
// and scripts/relay/adapters/seat-signal-adapter.mjs -- none of these run
// under `node --test`, ORCH confirmed via repo-wide grep) -- so it cannot
// simply be removed or gated behind a brand-new opt-in nobody would ever
// set. `process.env.NODE_TEST_CONTEXT` is a Node.js-builtin var the
// `node --test` runner sets on its OWN process (confirmed empirically: a
// plain `node foo.mjs` never has it, `node --test foo.test.mjs` always
// does) -- not a guess, not derived from this adapter's own
// reservationId/args. Any child spawned without an `env` override inherits
// process.env, so this signal propagates through the existing spawn chain
// (checkRelayHandshake -> spawnAdmissionCompletion -> this file's CLI) for
// every `node --test` run that forgets sweep-ledger-isolation.mjs's
// `--import` preload (coder-task.md §1's "확장된" scope), with zero changes
// to relay-handshake.mjs. This does NOT close every gap (정직 한계, see
// coder.md): a plain `node <check-script>.mjs` invocation that is neither
// run under `node --test` NOR self-isolating (like this file's own
// selfcheck-smoke.mjs fix) is still indistinguishable from a real
// production caller from inside this function alone -- §2-1's "애매하면
// 거부" is satisfied here only for the `node --test` class, not that
// residual one.
//
// HYK-289 2R (coder-task.md §★★경계 계약, 책임자 확정 2026-08-18): this is
// NOT "block the fallback everywhere except when told not to" -- the
// boundary is drawn on PURPOSE, not as a residual gap:
//   막는 것 (blocked)   = `node --test` + 점검·스모크 진입점 (test/check
//                          entry points -- e.g. this file's own test suite,
//                          selfcheck-smoke.mjs).
//   유지하는 것 (kept)  = production consumption/monitoring entry points'
//                          pointer fallback -- `relay-handshake.mjs` (its
//                          CLI), `scripts/relay/watch-result.mjs`,
//                          `scripts/relay/orca-spike-live.mjs`, and the
//                          library callers `relay-core.mjs`,
//                          `adapters/seat-signal-adapter.mjs`,
//                          `orca-spike-runner.mjs`.
// Why keeping it is correct, not a hole: the persistent pointer file is a
// device HYK-227 built ON PURPOSE ("설치기가 써 두는 것") specifically so
// these production callers get a working ledger path WITHOUT every 관제실
// script having to set one -- and 관제실 never does: ORCH's repo-wide grep
// found zero 관제실 scripts that set `ADMISSION_LEDGER_PATH`. Blocking the
// fallback for these callers would not close a leak, it would silently kill
// real reservation-release/monitoring in production. A strictly stronger
// contract (reject everywhere unless explicitly opted in) is intentionally
// NOT this round's scope -- tracked separately as HYK-302.
function persistentFallbackAllowed() {
  return !process.env.NODE_TEST_CONTEXT;
}

// isInsideGitWorktree -- HYK-312 §1: the persistent-pointer fallback resolves
// the ledger path via `mainRepoRoot()`, which is derived from THIS PROCESS'S
// cwd, not from `harnessDir` (the round directory actually being consumed).
// 2026-08-19 오전 실사고: ORCH ran the production CLI entry point
// (`relay-handshake.mjs CODER <scratch-copy-of-.harness>`) from inside the
// real repo checkout -- cwd resolved to the real repo, so the real pointer
// file was found and the real global ledger got mutated, even though the
// `.harness` actually being consumed was a plain filesystem copy outside any
// git worktree. This function is the gate that catches exactly that shape:
// "is the round directory the caller told us to consume itself inside SOME
// git worktree" -- a plain `git rev-parse --is-inside-work-tree` run with
// cwd=harnessDir. A scratch/temp copy (never `git init`-ed) fails this
// immediately.
// 정직 한계 (coder-task.md §1 원문 그대로): a deliberate SEPARATE git clone
// used for an experiment still passes this check (it genuinely is inside a
// worktree) -- this gate closes the "plain filesystem copy" shape the actual
// incident took, not every conceivable isolation escape. Documented, not
// silently swept under "fixed".
function isInsideGitWorktree(dir) {
  if (!existsSync(dir)) return false;
  try {
    const out = execSync("git rev-parse --is-inside-work-tree", {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "true";
  } catch {
    return false;
  }
}

export function autoCompleteAdmission({ reservationId, harnessDir }) {
  let ledgerPath = process.env.ADMISSION_LEDGER_PATH;
  // HYK-312 §1: gate the persistent-pointer fallback below (never the
  // explicit ADMISSION_LEDGER_PATH env path just above, which is this
  // file's own "designed door", coder-task.md §4 ⓒ) behind a harnessDir
  // isolation check, checked and returned BEFORE the pre-existing
  // persistent-fallback block so that block's own source text (pinned
  // byte-for-byte by admission-completion-persistent-source.test.mjs's ⓓ
  // mutation target) stays untouched. `harnessDir` is optional/backward-
  // compatible: callers that don't pass it (every pre-HYK-312 in-process
  // caller/test) get the exact unchanged pre-HYK-312 behavior -- this is a
  // strictly additive gate, not a stricter default.
  if (
    !ledgerPath &&
    harnessDir &&
    persistentFallbackAllowed() &&
    !isInsideGitWorktree(harnessDir)
  ) {
    return {
      attempted: false,
      blocked: true,
      reasonCode: "UNISOLATED_HARNESS_DIR",
      reason: `admission-completion-adapter: refusing persistent-pointer fallback -- harnessDir '${harnessDir}' is not inside a registered git worktree (test/experiment consumption context without an explicit ADMISSION_LEDGER_PATH) -- see HYK-312`,
    };
  }
  let persistentLockPath = null;
  if (!ledgerPath && persistentFallbackAllowed()) {
    const persistent = resolvePersistentLedgerPaths();
    if (persistent) {
      ledgerPath = persistent.ledgerPath;
      persistentLockPath = persistent.lockPath;
    }
  }
  if (!ledgerPath) {
    return { attempted: false };
  }
  const lockPath =
    process.env.ADMISSION_LOCK_PATH ||
    persistentLockPath ||
    `${ledgerPath}.lock`;
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
// relay-handshake.mjs가 이 파일을 별도 자식 프로세스로 스폰한다 --
// import가 아니라 execFileSync 스폰이므로, 이 파일이 격리 픽스처
// 디렉터리에 없을 때(스폰 자체가 ENOENT로 실패) 그 실패는 relay-
// handshake.mjs 모듈 "로드 시점"이 아니라 "호출 시점"에 일어나고, 그
// 호출부가 try/catch로 감싸 무시한다 -- 그래서 기존 mutation 시험들의
// 소규모 격리 의존성 목록을 하나도 건드리지 않는다.
// HYK-227 1R 갱신 (이 문단은 1R 전 상태를 그대로 남겨둔 채였던 오기 --
// 2R에서 정정): 스폰 호출 자체는 더 이상 relay-handshake.mjs의 CLI
// 진입점(`invokedDirectly` 블록)에만 있지 않다 -- checkRelayHandshake
// 함수 본문(ok:true 분기, autoArchiveRoundEnvelope/autoRecordRejectStreak
// 바로 다음)으로 옮겨져 CLI·in-process 호출자 6곳(relay-core.mjs·
// watch-result.mjs·seat-signal-adapter.mjs·orca-spike-live.mjs·
// orca-spike-runner.mjs·CLI 진입점) 전부가 동일하게 이 스폰을 거친다.
// 그 "부르는 지점"의 결선은 2R 시점 기준 모든 저장소 호출자를 덮는다 --
// 다만 이 스폰이 실제로 슬롯을 반납하는지는 여전히 이 함수가 얻는
// `ledgerPath`(env 우선 + 영속 기본값, 위 §2 참고)에 달려 있다.
if (
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/admission-completion-adapter.mjs")
) {
  const reservationId = process.argv[2];
  if (!reservationId) {
    console.error(
      "usage: node admission-completion-adapter.mjs <reservationId> [harnessDir]",
    );
    process.exit(1);
  }
  const harnessDir = process.argv[3];
  const outcome = autoCompleteAdmission({ reservationId, harnessDir });
  // HYK-312 §1: a blocked persistent-fallback attempt is the one outcome
  // shape that must NOT be treated like the pre-existing silent no-op below
  // -- it is a refusal (거부), not "not attempted", so it gets its own
  // nonzero exit + reason on stderr instead of exit 0 on stdout.
  if (outcome.blocked) {
    console.error(outcome.reason);
    process.exit(1);
  }
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
