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
import {
  appendFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  completeReservation,
  COMPLETION_REASON,
} from "../supervisor/admission-ledger-core.mjs";
import { withLedgerLock } from "../supervisor/admission-ledger-store.mjs";
// HYK-398 §2-⑶ (책임자에게 위임된 설계 판단, 이 라운드의 결정과 근거):
// 이 파일 헤더(위 §2-A 이하)는 "무겁게 참조되는 모듈(dispatch-gate-
// decision.mjs 등)을 끌어들이지 않기 위해 작은 것들은 복제한다"는 원칙을
// 세워 두었고, retirement-record-core.mjs를 정적 import하지 «않는» 것은
// 지금까지 그 원칙의 결과가 아니라 단지 "아직 이 축을 쓰는 완료 사유가
// 없었다"는 사실의 반영이었을 뿐이다(§1 실측: 이 회차 전까지 완료 사유는
// BLOCKED_TERMINATION_RELEASED 하나뿐). retirement-record-core.mjs 자신은
// §2(모듈 헤더)가 명시하는 "zero-import 코어"다 -- node 내장도, 이 저장소의
// 다른 파일도 import하지 않는다(직접 확인: 이 파일 맨 위에 import 문이
// 하나도 없다). 이미 이 파일이 정적 import하는 admission-ledger-core.mjs·
// admission-ledger-store.mjs·ledger-pointer-shared.mjs와 정확히 같은
// 무게(0)다 -- dispatch-gate-decision.mjs를 끌어들일 때와 같은 위험(그
// 파일의 전체 의존성 트리, 이 어댑터를 격리 픽스처에 스폰하는 여러
// mutation 시험의 고정 파일 목록 붕괴)이 전혀 없다. 그래서 이 회차는 그
// 의도를 "바꾼다": zero-import 코어는 정적으로 들여오고, retirement-
// record-core.mjs가 스스로 읽지 않는 사실들(은퇴 기록 후보 로딩·아카이브
// 사본 위치/지문 대조·기계로 확인 가능한 사유 재확인)만 이 파일이 직접
// 재현한다(아래 헬퍼들) -- dispatch-gate-decision.mjs의 동명 로직과
// «같은 계약»이되, 이 파일 자신의 신뢰 경계(캐치되지 않는 무거운 import
// 0)를 지킨다.
import {
  checkRetirementRecord,
  RETIREMENT_RECORD_STATE,
  RETIREMENT_BLOCK_REASON,
  MECHANICALLY_CONFIRMABLE_BLOCK_REASONS,
} from "./retirement-record-core.mjs";
// HYK-302/355 §2-A: single-source these two (previously duplicated here and
// in orch-stall-detect.mjs / relay-handshake.mjs respectively) -- see
// ledger-pointer-shared.mjs's own header for why this is now imported
// rather than duplicated a third time, and coder.md for the fixture sibling
// lists this round updated to keep every isolated mutation test loadable.
import {
  PERSISTENT_LEDGER_POINTER_FILENAME,
  isInsideGitWorktree,
} from "./ledger-pointer-shared.mjs";
// HYK-342 2R P1-1 (검토 원문 "회수 표식의 생산자 권한이 검증되지 않는다"):
// ⛔처음에는 relay-handshake.mjs에서 resolveResultTaskId/
// resolveResultBlockedState를 static import했으나, 실측 결과 이 파일을
// 고정 파일 목록으로 격리 clone하는 mutation 시험이 실제로 있었다
// (admission-completion-worktree-isolation.test.mjs·admission-completion-
// persistent-source.test.mjs 등 -- 실행해서 MODULE_NOT_FOUND로 직접 확인,
// "0건"이라던 최초 추정이 틀렸다). 그래서 이 파일 헤더가 위(§51-59
// repoRoot/mainRepoRoot 주석)에서 이미 설명한 그 원칙("무거운/많이 참조되는
// 모듈을 끌어들이지 않기 위해 작은 것들은 복제한다") 그대로, task_id 에코·
// BLOCKED/NEEDS_INPUT 표지 판정에 필요한 최소 조각만 아래에 복제한다 --
// relay-handshake.mjs의 TASK_ID_RE_G/BLOCKED_RE와 **바이트 동일**(그 파일
// 자신의 정의를 그대로 인용) -- "새로 발명"이 아니라 "같은 계약을 옮겨
// 적은 것"이다. 이 두 파일이 갈라지면(예: 근접-미스 처리가 relay-
// handshake.mjs에서 갱신되는데 여기가 안 따라가면) 그 자체가 회귀이므로,
// 이 상수들을 고칠 때는 반드시 relay-handshake.mjs의 동명 상수와
// 대조하라(주석으로만 강제되는 계약 -- 기계 강제는 이번 범위 밖).
const TASK_ID_RE_G = /^task_id:\s*(\S+)/gim;
const BLOCKED_RE = /^>>>[ \t]*(BLOCKED|NEEDS_INPUT):[ \t]*(\S.*?)[ \t]*$/gim;

// resolveResultTaskId(relay-handshake.mjs)의 최소 재현 -- "정확히 하나의
// 줄머리 task_id: 값만 인정, 0개/2개 이상은 확정하지 않는다"는 동일 계약.
function resolveEchoedTaskId(resultContent) {
  const matches = [...resultContent.matchAll(TASK_ID_RE_G)];
  if (matches.length !== 1) return { ok: false, count: matches.length };
  return { ok: true, id: matches[0][1] };
}

// resolveResultBlockedState(relay-handshake.mjs)의 최소 재현 -- "정확히
// 하나의 well-formed '>>> BLOCKED:'/'>>> NEEDS_INPUT:' 줄만 인정"은 그대로
// 옮기되, 이 검증은 relay-handshake.mjs 자신의 전체 5-상태 판정(근접-미스
// 세분류 포함)을 재구현하지 않는다 -- 여기 필요한 질문은 "유효한 표지가
// 정확히 하나 있는가" 하나뿐이다(모호/근접-미스는 전부 "없음"으로 접어
// 거부한다 -- 안전측 기본값, relay-handshake.mjs보다 엄격하면 엄격했지
// 느슨하지 않다).
function hasWellFormedBlockedMarker(resultContent) {
  const matches = [...resultContent.matchAll(BLOCKED_RE)];
  return matches.length === 1;
}

// HYK-342 3R §0/§2 (신뢰 경계 교정: 결과 파일은 워커가 쓴다 -- "워커가
// 만들어 낼 수 없는 것"이 아니다): 검토자가 2R에서 재현한 우회로 -- 워커가
// 자기 결과 파일에 지어낸 task_id(`HYK-342-fake-result-1`)와 지어낸
// `>>> BLOCKED:` 표지를 함께 써 두면, 위 두 확인(task_id 에코 일치·
// 표지 존재)만으로는 그대로 통과했다. 그 둘 다 워커가 쓸 수 있는 파일
// 안에서만 확인하기 때문이다. 이 라운드는 세 번째 확인을 추가한다: 그
// task_id가 실제로 관제실 배달 영수증(dispatch-receipts.jsonl, 워커가
// 쓸 수 없는 파일)에 이 role로 실재하는가. dispatch-gate-decision.mjs의
// lookupDispatchId와 동일한 계약(role 대소문자 무관, harness_task_label
// 정확히 일치, 마지막 매치 채택, 손상된 줄 건너뜀)을 최소 재현한다
// (⛔새 조회 로직 발명 금지 -- 이 파일 헤더가 이미 설명한 "무겁게 참조되는
// 모듈을 끌어들이지 않기 위해 작은 것들은 복제한다" 원칙 그대로, dispatch-
// gate-decision.mjs는 abort-record-core/consumption-receipt-core/
// retirement-record-core/reject-streak 등을 정적 import하는 무거운
// 파일이라 그 파일 자체를 끌어들이면 이 파일의 격리 시험들이 다시 깨진다
// -- P1-1 때 relay-handshake.mjs를 정적 import했다가 실측으로 확인한 것과
// 동일한 위험).
function hasDispatchReceiptForRound(role, harnessTaskLabel, receiptPath) {
  if (!isNonEmptyString(receiptPath) || !isNonEmptyString(harnessTaskLabel)) {
    return false;
  }
  let raw;
  try {
    raw = readFileSync(receiptPath, "utf8");
  } catch {
    return false;
  }
  let found = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof rec.role === "string" &&
      rec.role.toUpperCase() === role.toUpperCase() &&
      rec.harness_task_label === harnessTaskLabel
    ) {
      found = true;
    }
  }
  return found;
}

// resolveDispatchReceiptPath(dispatch-gate-decision.mjs)와 동일한 arg-
// with-env-fallback 관례(같은 env 이름, `DISPATCH_RECEIPT_PATH` --
// dispatch-receipt-cli.mjs가 이미 쓰는 바로 그 이름) -- 관제실 절대경로
// 하드코딩 금지.
//
// HYK-347 §1 경로 계약 (이 파일에서의 사용): 출처는 dispatch-gate-
// decision.mjs 위 주석과 동일(관제실이 자식 프로세스에 상속시키는 env,
// 이 저장소 어디도 기본값을 만들지 않는다). 미설정(및 `receiptPathArg`도
// 없음) 시 이 함수는 null을 돌려주고, 그 null은
// verifyBlockedTerminationEvidence -> hasDispatchReceiptForRound로 흘러가
// 즉시 `false`(증거 없음, 아래 hasDispatchReceiptForRound 헤더 참조)가
// 되어 BLOCKED_TERMINATION_RELEASED 완료 자체가 거부(fail-closed)된다 --
// "정말 배달 안 됨"과 "경로를 몰라서 확인 못 함"이 이 지점에서는 둘 다
// 거부라는 같은 결과로 이어지지만(§0 신뢰 경계: 워커가 위조할 수 있는
// 표식만으로 자리를 반납하지 않는다는 요구가 우선), reason 문자열은
// receiptPath 자체를 그대로 담아(§0 아래 verifyBlockedTerminationEvidence
// 참조) "(경로 미설정)"과 실제 경로 문자열을 구별해 남긴다 -- 판정
// 로직(거부 여부)은 바꾸지 않는다.
function resolveReceiptPathForVerification(receiptPathArg, env) {
  if (isNonEmptyString(receiptPathArg)) return receiptPathArg;
  if (isNonEmptyString(env?.DISPATCH_RECEIPT_PATH)) {
    return env.DISPATCH_RECEIPT_PATH;
  }
  return null;
}

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

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// HYK-344 §1-3 항1/항2 -- distinguishes the three outcomes a completion
// rejection can now carry (RESERVATION_NOT_FOUND vs the new RESERVATION_
// KEY_MISMATCH from admission-ledger-core.mjs's completeReservation; the
// third, "ledger unreadable", is already a structurally different code path
// -- see `reasonWithDetail` above and the `outcome.ok`-false branch below,
// neither of which ever calls this function). Both the expected key
// (reservationId) and what was actually found in the ledger (candidates, or
// explicitly none) are always named -- never collapsed to a bare "failed".
function buildCompletionRejectionReason(reservationId, complete) {
  if (complete.reasonCode === "RESERVATION_KEY_MISMATCH") {
    const found = complete.candidates
      .map((c) => `${c.reservationId} (status=${c.status})`)
      .join(", ");
    return `admission-completion-adapter: completeReservation rejected (RESERVATION_KEY_MISMATCH) -- expected reservation key '${reservationId}' not found, but ${complete.candidates.length} OTHER active/suspect reservation(s) exist in this ledger snapshot: ${found} -- this looks like a key drift (e.g. GoLabel/Task mismatch), NOT "no reservation was ever made"`;
  }
  return `admission-completion-adapter: completeReservation rejected (${complete.reasonCode}) for '${reservationId}' -- the reservation could not be transitioned to COMPLETED in the current ledger snapshot (no other active/suspect reservation exists in this ledger snapshot either -- no reservation was ever admitted under any key visible here)`;
}

// HYK-342 2R P1-1 -- the closed set of `reason` values this adapter will
// ever act on. 검토자 원문: "completeReservation은 비어 있지 않은 임의
// 문자열을 completion_reason으로 기록한다" -- 어댑터가 그 임의성을
// 그대로 통과시키던 것이 결함의 절반이었다. `undefined`(정상 완료, 기존
// ok:true 경로)는 이 집합 밖에서 별도로 허용된다(아래 completeAdmission
// Reservation 참조) -- 이 집합은 "완료 사유를 명시하는" 값만 닫는다.
const KNOWN_COMPLETION_REASONS = new Set([
  COMPLETION_REASON.BLOCKED_TERMINATION_RELEASED,
  COMPLETION_REASON.RETIREMENT_RELEASED,
]);

// HYK-342 2R P1-1 / 3R §0/§2 -- «회수 표식의 생산자 권한» 검증. 검토자가
// 재현한 공격(중단 핸드셰이크를 거치지 않고 이 어댑터를 직접 실행해
// completion_reason=BLOCKED_TERMINATION_RELEASED를 찍는 것)을 막는다.
//
// ⚠️3R §0 신뢰 경계 교정: 2R은 "harnessDir/role이 가리키는 결과 파일의
// task_id 에코 + BLOCKED 표지"를 «호출자가 만들어 낼 수 없는 것»으로
// 잘못 취급했다 -- 결과 파일은 워커가 쓰는 파일이므로 워커가 지어낸
// task_id + 지어낸 표지를 직접 써 두면 그 둘만으로는 여전히 통과했다
// (검토자 2R §1 항1 실측). 워커가 쓸 수 없는 곳은 관제실 배달 영수증
// (dispatch-receipts.jsonl)뿐이다(§0). 그래서 이 함수는 이제 **셋**을
// 확인한다 -- (a) 결과 파일이 실제로 존재하고 (b) 그 결과 파일의 task_id
// 에코가 정확히 이 reservationId와 일치하고(HYK-183 anti-forgery) (c) 그
// 결과 파일이 정확히 BLOCKED/NEEDS_INPUT 상태이며 **(d, 신규) 그
// reservationId가 실제로 dispatch-receipts.jsonl에 이 role로 배달된 적이
// 있다**(hasDispatchReceiptForRound, 워커가 못 쓰는 파일). 넷 중
// 하나라도 아니면 거부(fail-closed) -- 표식 문자열 자체나 비밀값에
// 기대지 않는다(⛔검토자가 금지한 그 경로).
//
// ★남는 표면(3R §2 "닫으려 하지 마라"): 워커가 «자기 실제(진짜 배달된)
// 라벨»로 가짜 정지 표지를 쓰는 경우는 이 확인으로 막히지 않는다 --
// BLOCKED 선언 자체는 이 하네스가 정상 신호로 받아들이기로 설계한
// 것이므로, 이 검증이 닫는 것은 "배달된 적 없는 라운드로 표식을 만드는
// 것"뿐이다(coder.md 정직 한계 절에도 명시).
function verifyBlockedTerminationEvidence({
  harnessDir,
  role,
  reservationId,
  receiptPath,
}) {
  if (!isNonEmptyString(harnessDir) || !isNonEmptyString(role)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 요청에 harnessDir/role이 없음 -- 증거를 확인할 대상 자체를 특정할 수 없음, 거부(안전측 기본값)`,
    };
  }
  // resolveLiveRoundFilePaths(relay-handshake.mjs)와 동일한 파일명 관례
  // (role을 소문자화해 `<role>.md`) -- Windows는 대소문자를 구별하지
  // 않지만 Linux(CI)는 구별하므로 그대로 맞춘다.
  const resultPath = join(harnessDir, `${String(role).toLowerCase()}.md`);
  let resultContent;
  try {
    resultContent = readFileSync(resultPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- 결과 파일을 읽을 수 없음('${resultPath}': ${err.message}), 거부(안전측 기본값)`,
    };
  }
  const taskIdResolved = resolveEchoedTaskId(resultContent);
  if (!taskIdResolved.ok || taskIdResolved.id !== reservationId) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- 결과 파일('${resultPath}')의 task_id 에코가 reservationId('${reservationId}')와 일치하지 않거나 확정되지 않음(${taskIdResolved.ok ? `실제: ${taskIdResolved.id}` : `task_id 줄 ${taskIdResolved.count}개`}), 거부(안전측 기본값)`,
    };
  }
  if (!hasWellFormedBlockedMarker(resultContent)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- 결과 파일('${resultPath}')에 유효한 '>>> BLOCKED:'/'>>> NEEDS_INPUT:' 표지가 정확히 하나 있지 않음, 거부(안전측 기본값)`,
    };
  }
  if (!hasDispatchReceiptForRound(role, reservationId, receiptPath)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: BLOCKED_TERMINATION_RELEASED 증거 확인 실패 -- reservationId('${reservationId}')가 role='${role}'로 실제 배달된 기록이 dispatch-receipts.jsonl(${receiptPath ?? "(경로 미설정)"})에 없음 -- 워커가 지어낸 이름표로 의심, 거부(안전측 기본값, HYK-342 3R §2)`,
    };
  }
  return { ok: true };
}

// HYK-398 §2-⑶: RETIREMENT_RELEASED 증거 확인. resultPath 재읽기는
// verifyBlockedTerminationEvidence와 같은 사유(독립 재검증, 호출자를
// 신뢰하지 않음)로 여기서도 다시 한다 -- reservationId를 그대로 믿지
// 않고, harnessDir/role이 가리키는 실제 파일들에서 다시 유도한다.
//
// dispatch-gate-decision.mjs의 evaluateRetirementDecision와 «같은 계약»
// (같은 다섯 관문 -- role+harnessTaskLabel 일치·아카이브 존재·지문 대조
// (아카이브+live 둘 다)·사유 코드 유효성/기계 재확인·후속 이름표)을
// checkRetirementRecord(코어, 정적 import)에 위임해 재현한다. 이 파일이
// 스스로 하는 일은 오직 "그 코어가 요구하는 사실들을 harnessDir 아래
// 실제 파일에서 다시 읽어 구조화하는 것"뿐이다(§2 zero-import 코어
// 계약과 동일한 분업, 위 import 헤더 참조).
const RETIREMENT_TASK_ID_RE_G = /^task_id:\s*(\S+)/gim;
const RETIREMENT_DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;
const RETIREMENT_ARCHIVE_ENVELOPE_HEADER_RE =
  /^<!-- envelope-archive: role=\S+ archived_at=.*? -->\n/;

// computeResultFingerprint(relay-handshake.mjs)/computeConsumptionResultFingerprint
// (dispatch-gate-decision.mjs)와 바이트 동일(sha256 hex of utf8 text) --
// 이 파일 헤더가 이미 설명한 "작은 것은 복제한다" 원칙 그대로.
function computeRetirementFingerprint(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function stripRetirementArchiveEnvelopeHeader(content) {
  const match = content.match(RETIREMENT_ARCHIVE_ENVELOPE_HEADER_RE);
  return match ? content.slice(match[0].length) : content;
}

// dispatch-gate-decision.mjs의 readRetirementRecordFiles와 동일한 계약:
// 디렉터리 부재 -> []. 손상/파싱 실패한 개별 파일은 건너뛴다(치명적이지
// 않음, 코어가 후보 필터링을 맡는다).
function readRetirementRecordFilesForAdapter(harnessDir, role) {
  const retirementsDir = join(harnessDir, "retirements");
  let names;
  try {
    names = readdirSync(retirementsDir);
  } catch {
    return [];
  }
  const pattern = new RegExp(`^${role}-retire-r\\d+\\.json$`, "i");
  const records = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    try {
      records.push(
        JSON.parse(readFileSync(join(retirementsDir, name), "utf8")),
      );
    } catch {
      continue;
    }
  }
  return records;
}

// dispatch-gate-decision.mjs의 resolveRetirementArchiveCandidate와 동일한
// 계약: `.harness/rounds/<role>-r<N>.md` 중 봉투 헤더를 벗긴 뒤 자신의
// task_id 에코가 harnessTaskLabel과 일치하는 사본을 찾는다(record.archivePath
// 를 그대로 믿지 않는다 -- 내용으로 찾는다). 정확히 하나면 그 지문을
// claimedFingerprint와 대조, 0개면 ARCHIVE_MISSING으로 이어지는
// exists:false, 2개 이상이면 안전측 기본값(exists:true, fingerprintMatches:false).
function resolveRetirementArchiveCandidateForAdapter(
  harnessDir,
  role,
  harnessTaskLabel,
  claimedFingerprint,
) {
  const roundsDir = join(harnessDir, "rounds");
  let names;
  try {
    names = readdirSync(roundsDir);
  } catch {
    return { exists: false, fingerprintMatches: false };
  }
  const pattern = new RegExp(`^${role}-r\\d+\\.md$`, "i");
  const matches = [];
  for (const name of names) {
    if (!pattern.test(name)) continue;
    let raw;
    try {
      raw = readFileSync(join(roundsDir, name), "utf8");
    } catch {
      continue;
    }
    const stripped = stripRetirementArchiveEnvelopeHeader(raw);
    const idMatches = [...stripped.matchAll(RETIREMENT_TASK_ID_RE_G)];
    if (idMatches.length !== 1 || idMatches[0][1] !== harnessTaskLabel) {
      continue;
    }
    matches.push({ fingerprint: computeRetirementFingerprint(stripped) });
  }
  if (matches.length === 0) {
    return { exists: false, fingerprintMatches: false };
  }
  if (matches.length > 1) {
    return { exists: true, fingerprintMatches: false };
  }
  return {
    exists: true,
    fingerprintMatches: matches[0].fingerprint === claimedFingerprint,
  };
}

function parseRetirementKstToMs(str) {
  if (typeof str !== "string") return null;
  const cleaned = str.trim().replace(/\s*KST\s*$/i, "");
  const match = cleaned.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/,
  );
  if (!match) return null;
  const date = new Date(`${match[1]}T${match[2]}+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

// dispatch-gate-decision.mjs의 confirmRetirementBlockReason와 동일한
// 계약(같은 두 기계-확인-가능 사유, 같은 판정 규칙) -- 여기서는 resultContent
// 자신에서 DONE을, taskContent에서 dropped_at을 각각 재추출/재파싱한다
// (retirement-record-core.mjs §3-4 "ORCH가 그렇다고 했다만으로는 통과 못
// 한다" 원칙 그대로, 이 파일 자신의 신뢰 경계 안에서 다시 구현).
function confirmRetirementBlockReasonForAdapter(
  record,
  resultContent,
  droppedAtRaw,
) {
  if (!MECHANICALLY_CONFIRMABLE_BLOCK_REASONS.has(record?.blockReasonCode)) {
    return null;
  }
  const doneMatches = [
    ...resultContent.matchAll(/^>>>\s*DONE:.*@\s*(.+?)\s*$/gim),
  ];
  const doneAtRaw = doneMatches.length === 1 ? doneMatches[0][1] : null;
  if (
    record.blockReasonCode ===
    RETIREMENT_BLOCK_REASON.DONE_TIMESTAMP_NOT_PARSEABLE
  ) {
    return (
      isNonEmptyString(doneAtRaw) && parseRetirementKstToMs(doneAtRaw) === null
    );
  }
  if (
    record.blockReasonCode === RETIREMENT_BLOCK_REASON.DONE_PREDATES_DROPPED_AT
  ) {
    const doneAtMs = parseRetirementKstToMs(doneAtRaw);
    const droppedAtMs = parseRetirementKstToMs(droppedAtRaw);
    return doneAtMs !== null && droppedAtMs !== null && doneAtMs < droppedAtMs;
  }
  return null;
}

// verifyRetirementEvidence -- RETIREMENT_RELEASED의 진입점. reservationId를
// harnessTaskLabel로 삼아 harnessDir 아래 실제 파일에서 독립적으로 다시
// 사실을 유도하고, checkRetirementRecord(코어)에 그대로 넘긴다. RETIRED가
// 아니면 어떤 상태든(NO_RECORD/AMBIGUOUS/ARCHIVE_MISSING/FINGERPRINT_
// MISMATCH/INVALID_REASON_CODE/BLOCK_REASON_UNCONFIRMED/SUCCESSOR_LABEL_
// MISSING) 거부(fail-closed) -- verdict.reason을 그대로 실어 사람이 읽을
// 수 있게 한다(§4 완료조건 2 "증거가 하나라도 빠지면 거부" 요구 그대로).
function verifyRetirementEvidence({ harnessDir, role, reservationId }) {
  if (!isNonEmptyString(harnessDir) || !isNonEmptyString(role)) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 요청에 harnessDir/role이 없음 -- 증거를 확인할 대상 자체를 특정할 수 없음, 거부(안전측 기본값)`,
    };
  }
  const resultPath = join(harnessDir, `${String(role).toLowerCase()}.md`);
  let resultContent;
  try {
    resultContent = readFileSync(resultPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 증거 확인 실패 -- 결과 파일을 읽을 수 없음('${resultPath}': ${err.message}), 거부(안전측 기본값)`,
    };
  }
  const taskIdResolved = resolveEchoedTaskId(resultContent);
  if (!taskIdResolved.ok || taskIdResolved.id !== reservationId) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 증거 확인 실패 -- 결과 파일('${resultPath}')의 task_id 에코가 reservationId('${reservationId}')와 일치하지 않거나 확정되지 않음(${taskIdResolved.ok ? `실제: ${taskIdResolved.id}` : `task_id 줄 ${taskIdResolved.count}개`}), 거부(안전측 기본값)`,
    };
  }
  const taskPath = join(harnessDir, `${String(role).toLowerCase()}-task.md`);
  let droppedAtRaw = null;
  try {
    const taskContent = readFileSync(taskPath, "utf8");
    const droppedMatch = taskContent.match(RETIREMENT_DROPPED_AT_RE);
    droppedAtRaw = droppedMatch ? droppedMatch[1].trim() : null;
  } catch {
    droppedAtRaw = null;
  }
  const roleUpper = String(role).toUpperCase();
  const records = readRetirementRecordFilesForAdapter(harnessDir, roleUpper);
  const liveFingerprint = computeRetirementFingerprint(resultContent);
  const candidates = records.map((record) => {
    const archiveInfo = resolveRetirementArchiveCandidateForAdapter(
      harnessDir,
      roleUpper,
      reservationId,
      record?.archiveFingerprintClaimed,
    );
    return {
      record,
      archiveExists: archiveInfo.exists,
      archiveFingerprintMatches: archiveInfo.fingerprintMatches,
      liveFingerprintMatches:
        liveFingerprint === record?.archiveFingerprintClaimed,
      blockReasonConfirmed: confirmRetirementBlockReasonForAdapter(
        record,
        resultContent,
        droppedAtRaw,
      ),
    };
  });
  const verdict = checkRetirementRecord({
    role: roleUpper,
    harnessTaskLabel: reservationId,
    candidates,
  });
  if (verdict.state !== RETIREMENT_RECORD_STATE.RETIRED) {
    return {
      ok: false,
      reason: `admission-completion-adapter: RETIREMENT_RELEASED 증거 확인 실패 -- ${verdict.reason}`,
    };
  }
  return { ok: true };
}

// HYK-342/HYK-249: `reason` is a NEW, optional field threaded straight
// through to completeReservation's own `args.reason` (admission-ledger-
// core.mjs) -- see that function's header for the stamping contract. Every
// pre-existing caller (the ok:true completion path) omits it, so this
// function's behavior for them is byte-identical to before this round.
//
// HYK-398 §2-⑶: quality-check max-lines-per-function 상한을 지키려고
// completeAdmissionReservation 몸통에서 뽑았다(HYK-244-receipt-core-1b
// 선례와 동일한 이유, 판정/사유 문구는 조금도 바뀌지 않는다) -- reason별
// evidence 확인 두 갈래(BLOCKED_TERMINATION_RELEASED/RETIREMENT_RELEASED)
// 를 하나로 묶는다. 통과(evidence 불필요 포함)면 null, 실패면 그
// completeAdmissionReservation이 즉시 돌려줄 {ok:false, reasonCode, reason}.
function checkCompletionReasonEvidence({
  reason,
  harnessDir,
  role,
  reservationId,
  receiptPath,
}) {
  if (reason === COMPLETION_REASON.BLOCKED_TERMINATION_RELEASED) {
    const evidence = verifyBlockedTerminationEvidence({
      harnessDir,
      role,
      reservationId,
      receiptPath: resolveReceiptPathForVerification(receiptPath, process.env),
    });
    if (!evidence.ok) {
      return {
        ok: false,
        reasonCode: "BLOCKED_TERMINATION_EVIDENCE_MISSING",
        reason: `${evidence.reason} -- reservation '${reservationId}' NOT released`,
      };
    }
  }
  // HYK-398 §2-⑶: RETIREMENT_RELEASED도 같은 fail-closed 원칙 -- evidence
  // 확인이 완료 호출(completeReservation) 자체보다 먼저 실행되고, 실패하면
  // 완료는 아예 시도되지 않는다(이 축이 새로 만드는 유일한 완료 통로).
  if (reason === COMPLETION_REASON.RETIREMENT_RELEASED) {
    const evidence = verifyRetirementEvidence({
      harnessDir,
      role,
      reservationId,
    });
    if (!evidence.ok) {
      return {
        ok: false,
        reasonCode: "RETIREMENT_EVIDENCE_MISSING",
        reason: `${evidence.reason} -- reservation '${reservationId}' NOT released`,
      };
    }
  }
  return null;
}

// HYK-342 2R P1-1: `reason` is no longer trusted at face value -- a non-
// empty value MUST be one of KNOWN_COMPLETION_REASONS (closed set), and
// BLOCKED_TERMINATION_RELEASED specifically requires `harnessDir`/`role`
// and passes verifyBlockedTerminationEvidence BEFORE completeReservation is
// ever called -- a failed verification means NO completion happens at all
// (fail-closed: this release path either has real corroborating evidence,
// or it does not run).
export function completeAdmissionReservation({
  reservationId,
  ledgerPath,
  lockPath,
  now = new Date().toISOString(),
  reason,
  harnessDir,
  role,
  receiptPath,
}) {
  if (reason !== undefined && !KNOWN_COMPLETION_REASONS.has(reason)) {
    return {
      ok: false,
      reasonCode: "UNKNOWN_COMPLETION_REASON",
      reason: `admission-completion-adapter: 알 수 없는 completion reason('${reason}') -- 닫힌 집합(${[...KNOWN_COMPLETION_REASONS].join(", ")}) 밖의 값은 거부(안전측 기본값, HYK-342 2R P1-1) -- reservation '${reservationId}' NOT released`,
    };
  }
  const evidenceFailure = checkCompletionReasonEvidence({
    reason,
    harnessDir,
    role,
    reservationId,
    receiptPath,
  });
  if (evidenceFailure) return evidenceFailure;
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
      reason,
    });
    if (!complete.ok) {
      return {
        result: {
          ok: false,
          reasonCode: complete.reasonCode,
          reason: buildCompletionRejectionReason(reservationId, complete),
          // HYK-344 §1-3 항1: surfaced as its own field (not just folded
          // into the `reason` string) so an automated caller/monitoring
          // script can act on it without parsing prose -- the durable audit
          // record below (appendCompletionFailureAudit) also carries this.
          candidates: complete.candidates ?? [],
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
  candidates,
  now,
}) {
  const auditPath = `${ledgerPath}.completion-failures.jsonl`;
  const record = {
    at: now,
    reservationId,
    reasonCode: reasonCode ?? "UNKNOWN",
    reason,
    // HYK-344 §1-3 항1/항3: durable, machine-parseable record of "what was
    // actually found" alongside "what was expected" (reservationId above) --
    // present (possibly empty array) only when the failure came from
    // completeAdmissionReservation's RESERVATION_NOT_FOUND/RESERVATION_KEY_
    // MISMATCH branch; absent for other failure shapes (e.g. ledger
    // unreadable) where it would not mean anything.
    ...(candidates !== undefined ? { candidates } : {}),
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

// isInsideGitWorktree -- HYK-312 §1's original gate against the exact
// 2026-08-19 실사고 shape (a scratch/temp `.harness` copy outside any git
// worktree still resolving the real persistent pointer via cwd-derived
// `mainRepoRoot()`). Now imported from ledger-pointer-shared.mjs (HYK-302/
// 355 §2-A dedup) -- see that file's header for the full history and the
// one prior behavioral difference (relay-handshake.mjs's `!dir` guard) it
// carries forward unchanged for this file's call site below.

// HYK-302/355 §2-C (coder-task.md, «최소 요구»): under `node --test`
// (persistentFallbackAllowed()===false), this stays the exact
// byte-identical pre-existing no-op -- HYK-227 2R §3 항1's "사유 문구를
// 바꾸지 마라" still applies to this branch (admission-completion-
// persistent-source.test.mjs's ⓒ/ⓒ-2/ⓒ-3 pin exactly this shape under
// `node --test`, and the entire local test suite runs there). Outside
// `node --test`, with genuinely NEITHER source resolved (no
// ADMISSION_LEDGER_PATH, no installer-written pointer file), the
// pre-existing behavior was an equally silent {attempted:false} -- the
// exact "quiet default" HYK-289's own header calls out as not a safety
// net. This now reuses the SAME loud, already-tested channel HYK-312's own
// UNISOLATED_HARNESS_DIR gate established (`blocked:true`, CLI exit 1, and
// -- via relay-handshake.mjs's existing
// exitDistinctlyOnAdmissionCompletionFailure, unchanged by this round --
// the round's own CLI surfaces this as exit 3, not a silent 0) instead of
// inventing a new one. 정직 한계: in real production this branch should
// essentially never fire (ORCH confirmed the real control-room pointer
// file is already installed) -- this closes the "nobody configured
// anything at all" shape, the exact one HYK-227 1R's silent no-op let
// through into a real incident (see this file's own header).
function unconfiguredLedgerOutcome() {
  if (!persistentFallbackAllowed()) {
    return { attempted: false };
  }
  return {
    attempted: false,
    blocked: true,
    reasonCode: "LEDGER_PATH_UNCONFIGURED",
    reason: `admission-completion-adapter: no admission ledger path configured -- set ADMISSION_LEDGER_PATH, or ensure the installer-written .harness/${PERSISTENT_LEDGER_POINTER_FILENAME} pointer file exists at the main repo root -- see HYK-302`,
  };
}

// HYK-342/HYK-249: `reason` (optional) is forwarded to completeAdmission
// Reservation below unchanged -- see that function's own header. Every
// pre-existing caller omits it (byte-identical no-op stamping behavior).
// HYK-342 2R P1-1: `role` (optional) is forwarded alongside `reason` --
// required only when reason===BLOCKED_TERMINATION_RELEASED (see
// verifyBlockedTerminationEvidence); every pre-existing caller omits both.
// HYK-342 3R §2: `receiptPath` (optional) is forwarded alongside `reason`/
// `role` -- required (directly or via DISPATCH_RECEIPT_PATH env,
// resolveReceiptPathForVerification) only when reason===
// BLOCKED_TERMINATION_RELEASED. Every pre-existing caller omits it.
export function autoCompleteAdmission({
  reservationId,
  harnessDir,
  reason,
  role,
  receiptPath,
}) {
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
    return unconfiguredLedgerOutcome();
  }
  const lockPath =
    process.env.ADMISSION_LOCK_PATH ||
    persistentLockPath ||
    `${ledgerPath}.lock`;
  const outcome = completeAdmissionReservation({
    reservationId,
    ledgerPath,
    lockPath,
    reason,
    harnessDir,
    role,
    receiptPath,
  });
  if (!outcome.ok) {
    appendCompletionFailureAudit({
      ledgerPath,
      reservationId,
      reasonCode: outcome.reasonCode,
      reason: outcome.reason,
      candidates: outcome.candidates,
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
  // HYK-342/HYK-249: 4th positional arg, optional, backward-compatible --
  // pre-existing callers (relay-handshake.mjs's ok:true spawn) pass only
  // 2-3 args, so `reason` is undefined and completeReservation's stamping
  // stays off (see completeAdmissionReservation's own header).
  const reason = process.argv[4];
  // HYK-342 2R P1-1: 5th positional arg, optional -- required only when
  // reason===BLOCKED_TERMINATION_RELEASED (verifyBlockedTerminationEvidence
  // rejects that reason without it). Every pre-2R call site (and the
  // ok:true normal-completion path) never passes a 5th arg.
  const role = process.argv[5];
  // HYK-342 3R §2: 6th positional arg, optional -- explicit override for
  // the receipt path (falls back to DISPATCH_RECEIPT_PATH env otherwise,
  // resolveReceiptPathForVerification). Every pre-3R call site never
  // passes a 6th arg.
  const receiptPath = process.argv[6];
  const outcome = autoCompleteAdmission({
    reservationId,
    harnessDir,
    reason,
    role,
    receiptPath,
  });
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
