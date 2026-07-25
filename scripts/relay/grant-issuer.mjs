import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  acquireArmMutex,
  releaseArmMutex,
  saveStoreAtomic,
} from "./arm-state.mjs";
import { judgeAdmission } from "./admission-core.mjs";
import {
  claimIntentTx,
  markIntentIssued,
  markIntentPaused,
  resumeIntentAfterHumanAck,
} from "./stable-intent.mjs";

// HYK-171 사이클3A (PM 보고서 §4/§10.5): bounded human delegation의 원자
// 소비 + 그 범위 내 정확 task hash 1개에 대한 하위 sub-grant 발급.
//
// ⚠️ 스코프 경계(coder-task.md §4, 비타협): delegation의 구체 서명
// 매체·크립토(사람 개인키로 실제 서명하는 메커니즘)는 이 사이클의 몫이
// 아니다 -- 사람 결정·후속 작업이다. 이 파일은 **소비 계약**(delegation
// 필드 + 원자 소비 + 범위 검증)을 FAKE/test delegation 객체로 설계·검증
// 한다. 실 사람키 서명기를 이 사이클에서 발명하지 않는다. 아래
// `delegation`은 항상 이미 "사람이 서명했다고 가정하는" 평문 필드 묶음
// (테스트에서는 합성 fixture)이며, 이 모듈은 그 서명 검증 자체를 하지
// 않는다(서명 검증은 후속 작업이 채울 자리).
//
// 사람 개인키 비접촉(coder-task.md 비타협): 이 파일은 개인키를 인자로도,
// import로도 전혀 다루지 않는다 -- `auth-grant-seal.mjs`처럼 개인키를
// 읽는 "봉인 세리모니" 함수 전체를 재사용하지 않는 이유이기도 하다(그
// 함수는 사람이 매 grant를 대화형으로 확인하는 모델을 전제해 이 무인
// 발급 모델과 안 맞기도 하다). 아래 `buildSubGrantFields`는 delegation
// 객체의 필드를 통째로 spread하지 않고 **화이트리스트로 골라 담는다** --
// 그래서 delegation 객체에 사람이 실수로/공격자가 의도적으로
// `human_private_key` 같은 낯선 필드를 얹어도 발급된 sub-grant 파일에는
// 그 내용이 절대 새어나가지 않는다(§6 mutation #9 런타임 증거).
//
// 재사용(패턴만, coder-task.md 지침): `auth-grant-seal.mjs`의
// create-new-only(`wx`) + read-back-and-compare(`writeSealedEnvelope`)
// 패턴을 아래 `writeSubGrantEnvelope`에 그대로 옮긴다. mutex/원자저장은
// arm-state.mjs의 `acquireArmMutex`/`releaseArmMutex`/`saveStoreAtomic`을
// stable-intent.mjs/auth-grant-ledger.mjs와 동일한 방식으로 재사용한다
// (재구현 0) -- 소비 유일성 키만 새로 정의한다: `delegation_id+task_hash`.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isSafeCount(v) {
  return Number.isSafeInteger(v) && v >= 0;
}
function errText(err) {
  try {
    if (err && typeof err === "object") {
      const m = err.message;
      if (typeof m === "string") return m;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

export const REASON = Object.freeze({
  DELEGATION_INVALID: "DELEGATION_INVALID",
  DELEGATION_EXPIRED: "DELEGATION_EXPIRED",
  DELEGATION_ROLE_MISMATCH: "DELEGATION_ROLE_MISMATCH",
  DELEGATION_TASK_HASH_OUT_OF_SCOPE: "DELEGATION_TASK_HASH_OUT_OF_SCOPE",
  DELEGATION_BUDGET_EXCEEDED: "DELEGATION_BUDGET_EXCEEDED",
  DELEGATION_ALREADY_CONSUMED: "DELEGATION_ALREADY_CONSUMED",
  DELEGATION_CONSUME_FAILED: "DELEGATION_CONSUME_FAILED",
  CONSUMPTION_STORE_DEGRADED: "CONSUMPTION_STORE_DEGRADED",
  ENVELOPE_WRITE_FAILED: "ENVELOPE_WRITE_FAILED",
  // P1-1 (review-1 반려): 프로덕션 발급 진입점(issueSubGrant)이 stable-intent
  // 단일승자 claim과 admission 6게이트를 스스로 강제하며 내는 거부 사유.
  ADMISSION_DENIED: "ADMISSION_DENIED",
  INTENT_CLAIM_REQUIRED: "INTENT_CLAIM_REQUIRED",
  INTENT_CLAIM_DENIED: "INTENT_CLAIM_DENIED",
  INTENT_RESUME_DENIED: "INTENT_RESUME_DENIED",
  ISSUED: "ISSUED",
});

function deny(reason, detail) {
  return { ok: false, issued: false, reason, detail: detail ?? null };
}

// delegation 필드 계약(§4, fake/test delegation -- 실 서명 검증은 후속):
//   schema_version          -- 고정 1
//   delegation_id           -- 이 delegation 인스턴스의 고유 id
//   scope_issue_id          -- 이 delegation이 묶인 이슈/패킷 경계
//   role                    -- 위임된 역할(예: "CODER")
//   allowed_task_hashes     -- 이 delegation 범위 안의 정확한 task hash
//                              목록(사람이 서명 시점에 명시한 화이트리스트
//                              -- "그 범위 내 정확 task hash에만" 요구를
//                              구조적으로 강제한다)
//   max_start_budget        -- 단일 소비 요청이 넘을 수 없는 시작 예산 상한
//   expires_at              -- ISO-8601 만료 시각
//   max_consecutive_rejections -- 2연속반려정지 정책(이 모듈은 값의 존재만
//                              검증한다 -- 실제 반려 카운트 집행은
//                              admission-core.mjs의 gates.consecutiveRejections)
//   excludes_north_star     -- 고정 true(북극성 승인 필요 task는 이 위임
//                              범위 밖이라는 서명 사실 자체)
//   excludes_hard_stop      -- 고정 true(hard-stop task는 이 위임 범위 밖)
const REQUIRED_STRING_FIELDS = [
  "delegation_id",
  "scope_issue_id",
  "role",
  "expires_at",
];

// quality-check.mjs complexity 래칫(상한 12) 준수를 위해 validateDelegation의
// 체크를 세 그룹(문자열류/배열·예산류/고정 플래그류)으로 나눈다 -- 판정
// 내용은 그대로, 오케스트레이션만 분리한다(pull-authorization.mjs 등 기존
// 파일의 collect*Problems 분리 패턴 재사용).
function collectDelegationStringProblems(delegation) {
  const problems = [];
  if (delegation.schema_version !== 1) {
    problems.push("schema_version must be fixed 1");
  }
  for (const f of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(delegation[f])) {
      problems.push(`'${f}' must be a non-empty string`);
    }
  }
  if (
    isNonEmptyString(delegation.expires_at) &&
    Number.isNaN(Date.parse(delegation.expires_at))
  ) {
    problems.push("'expires_at' must be an ISO-8601 date string");
  }
  return problems;
}

function collectDelegationScopeProblems(delegation) {
  const problems = [];
  if (
    !Array.isArray(delegation.allowed_task_hashes) ||
    delegation.allowed_task_hashes.length === 0 ||
    !delegation.allowed_task_hashes.every(isNonEmptyString)
  ) {
    problems.push(
      "'allowed_task_hashes' must be a non-empty array of non-empty strings",
    );
  }
  if (
    !isSafeCount(delegation.max_start_budget) ||
    delegation.max_start_budget < 1
  ) {
    problems.push("'max_start_budget' must be a positive safe integer");
  }
  if (!isSafeCount(delegation.max_consecutive_rejections)) {
    problems.push(
      "'max_consecutive_rejections' must be a non-negative safe integer",
    );
  }
  return problems;
}

function collectDelegationExclusionProblems(delegation) {
  const problems = [];
  if (delegation.excludes_north_star !== true) {
    problems.push("'excludes_north_star' must be fixed true");
  }
  if (delegation.excludes_hard_stop !== true) {
    problems.push("'excludes_hard_stop' must be fixed true");
  }
  return problems;
}

function validateDelegation(delegation) {
  if (!isPlainObject(delegation)) {
    return ["delegation is not a plain object"];
  }
  return [
    ...collectDelegationStringProblems(delegation),
    ...collectDelegationScopeProblems(delegation),
    ...collectDelegationExclusionProblems(delegation),
  ];
}

// 서명범위 이탈(§6 mutation #8) 판정: role/task hash/예산이 delegation의
// 서명된 범위 밖이면 거부한다. allowed_task_hashes는 인덱스 루프로만
// 검사한다(외부 객체의 .includes/prototype 조작 불신뢰, arm-state.mjs I3
// 원칙 재적용).
function taskHashInScope(allowedTaskHashes, taskHash) {
  for (let i = 0; i < allowedTaskHashes.length; i++) {
    if (allowedTaskHashes[i] === taskHash) return true;
  }
  return false;
}

function checkDelegationScope(delegation, request, nowMs) {
  const { taskHash, role, startBudgetRequested } = request;
  if (!isNonEmptyString(taskHash)) {
    return deny(
      REASON.DELEGATION_TASK_HASH_OUT_OF_SCOPE,
      "request.taskHash is missing/empty",
    );
  }
  if (!isNonEmptyString(role) || role !== delegation.role) {
    return deny(
      REASON.DELEGATION_ROLE_MISMATCH,
      `delegation is scoped to role=${JSON.stringify(delegation.role)}, request has ${JSON.stringify(role)}`,
    );
  }
  if (!taskHashInScope(delegation.allowed_task_hashes, taskHash)) {
    return deny(
      REASON.DELEGATION_TASK_HASH_OUT_OF_SCOPE,
      `task_hash ${JSON.stringify(taskHash)} is not in delegation.allowed_task_hashes`,
    );
  }
  const requested = isSafeCount(startBudgetRequested)
    ? startBudgetRequested
    : 1;
  if (requested > delegation.max_start_budget) {
    return deny(
      REASON.DELEGATION_BUDGET_EXCEEDED,
      `requested start budget ${requested} exceeds delegation.max_start_budget=${delegation.max_start_budget}`,
    );
  }
  const expiresMs = Date.parse(delegation.expires_at);
  if (
    !Number.isSafeInteger(nowMs) ||
    Number.isNaN(expiresMs) ||
    nowMs > expiresMs
  ) {
    return deny(
      REASON.DELEGATION_EXPIRED,
      `delegation expires_at=${delegation.expires_at}, now=${Number.isSafeInteger(nowMs) ? new Date(nowMs).toISOString() : "invalid"}`,
    );
  }
  return null;
}

// ---- delegation 소비 원장(auth-grant-ledger.mjs/stable-intent.mjs와 동일
// 모양 -- mutex+원자저장 재사용, 유일성 키만 delegation_id+task_hash) ----
function consumptionRecordId(delegationId, taskHash) {
  return createHash("sha256")
    .update(JSON.stringify([delegationId, taskHash]), "utf8")
    .digest("hex");
}
function consumptionRecordPath(consumptionDir, recordId) {
  return join(consumptionDir, `delegation-consume-${recordId}.json`);
}
function defaultMutexWrite(path, content) {
  writeFileSync(path, content, { flag: "wx" });
}
function normalizeConsumeDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    existsFn: typeof d.existsFn === "function" ? d.existsFn : existsSync,
    readFileFn:
      typeof d.readFileFn === "function"
        ? d.readFileFn
        : (p) => readFileSync(p, "utf8"),
    writeFn: typeof d.writeFn === "function" ? d.writeFn : defaultMutexWrite,
    readdirFn: typeof d.readdirFn === "function" ? d.readdirFn : readdirSync,
  };
}

// P1-3 (review-1 반려): 소비 store 안의 레코드 하나가 손상돼도(JSON 파싱
// 실패·schema 불일치) 그 delegation_id+task_hash 키만 의심하는 게 아니라
// **store(디렉터리) 전체**를 degraded로 본다. 이유: consumptionRecordId는
// delegationId+taskHash의 해시라서, 손상된 레코드의 실제 delegation_id를
// 우리는 신뢰할 수 없다 -- 그 손상이 다른 (delegationId, taskHash) 조합의
// 유일성 보장을 몰래 깨고 있지 않다는 걸 개별 파일 존재 검사만으로는
// 증명할 수 없다. 그래서 소비 시도마다 store 전체를 훑어 손상 레코드가
// 하나라도 있으면 그 store 전체에서 발급 0(사람이 손상을 정리할 때까지).
function isValidConsumptionRecord(v) {
  return (
    isPlainObject(v) &&
    v.schema_version === 1 &&
    isNonEmptyString(v.delegation_id) &&
    isNonEmptyString(v.task_hash) &&
    isNonEmptyString(v.role)
  );
}

function checkConsumptionStoreIntegrity(consumptionDir, deps) {
  let entries;
  try {
    entries = deps.readdirFn(consumptionDir);
  } catch (err) {
    return {
      ok: false,
      reason: `grant-issuer: fail-closed -- could not list consumption store '${consumptionDir}' (${errText(err)})`,
    };
  }
  if (!Array.isArray(entries)) {
    return {
      ok: false,
      reason:
        "grant-issuer: fail-closed -- consumption store listing is not an array",
    };
  }
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    if (
      typeof name !== "string" ||
      !name.startsWith("delegation-consume-") ||
      !name.endsWith(".json")
    ) {
      continue;
    }
    const recordCheck = readConsumptionRecordForIntegrity(
      join(consumptionDir, name),
      name,
      deps,
    );
    if (!recordCheck.ok) return recordCheck;
  }
  return { ok: true };
}

function readConsumptionRecordForIntegrity(path, name, deps) {
  let raw;
  try {
    raw = deps.readFileFn(path);
  } catch (err) {
    return {
      ok: false,
      reason: `grant-issuer: fail-closed -- consumption record '${name}' unreadable (${errText(err)})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: `grant-issuer: fail-closed -- consumption record '${name}' is not valid JSON (${errText(err)})`,
    };
  }
  if (!isValidConsumptionRecord(parsed)) {
    return {
      ok: false,
      reason: `grant-issuer: fail-closed -- consumption record '${name}' fails schema validation`,
    };
  }
  return { ok: true };
}

function underConsumeMutex(
  recordPath,
  delegationId,
  taskHash,
  role,
  at,
  deps,
  saveDeps,
) {
  let exists;
  try {
    exists = deps.existsFn(recordPath);
  } catch (err) {
    return {
      ok: false,
      claimed: false,
      reason: `grant-issuer: existsFn threw (${errText(err)})`,
    };
  }
  if (exists) {
    return {
      ok: false,
      claimed: false,
      duplicate: true,
      reason: `grant-issuer: delegation ${delegationId} already consumed for task_hash ${taskHash}`,
    };
  }
  const record = {
    schema_version: 1,
    delegation_id: delegationId,
    task_hash: taskHash,
    role,
    consumed_at: at ?? null,
  };
  const saved = saveStoreAtomic(recordPath, record, saveDeps);
  if (!saved.ok) {
    return {
      ok: false,
      claimed: false,
      reason: `grant-issuer: fail-closed -- ${saved.reason}`,
    };
  }
  return { ok: true, claimed: true, record, path: recordPath };
}

// consumeDelegationTx({ consumptionDir, delegationId, taskHash, role, at }, opts)
// -> exactly-once 소비. consumptionDir은 호출자 trusted config(그룹1
// 계약과 동일한 이유로 delegation/task 필드에서 유도 금지).
export function consumeDelegationTx(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const { consumptionDir, delegationId, taskHash, role, at } = inp;
  if (!isNonEmptyString(consumptionDir)) {
    return {
      ok: false,
      claimed: false,
      reason: "grant-issuer: consumptionDir must be a non-empty string",
    };
  }
  if (!isNonEmptyString(delegationId) || !isNonEmptyString(taskHash)) {
    return {
      ok: false,
      claimed: false,
      reason: "grant-issuer: delegationId/taskHash must be non-empty strings",
    };
  }
  const deps = normalizeConsumeDeps(opts);
  const integrity = checkConsumptionStoreIntegrity(consumptionDir, deps);
  if (!integrity.ok) {
    return {
      ok: false,
      claimed: false,
      degraded: true,
      reason: integrity.reason,
    };
  }
  const recordId = consumptionRecordId(delegationId, taskHash);
  const recordPath = consumptionRecordPath(consumptionDir, recordId);

  const mtx = acquireArmMutex(consumptionDir, recordId, deps);
  if (!mtx.ok) {
    return {
      ok: false,
      claimed: false,
      reason: mtx.reason,
      paused: mtx.paused === true,
    };
  }
  let result;
  try {
    result = underConsumeMutex(
      recordPath,
      delegationId,
      taskHash,
      role,
      at,
      deps,
      opts,
    );
  } catch (err) {
    const rel = releaseArmMutex(mtx, deps);
    return {
      ok: false,
      claimed: false,
      reason: `grant-issuer: transaction body threw (${errText(err)})`,
      mutex_release_failed: rel.released === false,
    };
  }
  const rel = releaseArmMutex(mtx, deps);
  if (rel.released === false) {
    return {
      ...result,
      mutex_release_failed: true,
      mutex_release_reason: rel.reason,
    };
  }
  return result;
}

// ---- sub-grant envelope 발급 (create-new-only + read-back-and-compare,
// auth-grant-seal.mjs writeSealedEnvelope 패턴 이식) ----
function normalizeWriteDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    writeFileFn:
      typeof d.writeFileFn === "function" ? d.writeFileFn : writeFileSync,
    readFileFn:
      typeof d.readFileFn === "function"
        ? d.readFileFn
        : (p) => readFileSync(p, "utf8"),
  };
}

// 화이트리스트 필드만 담는다(delegation 객체를 통째로 spread하지 않음 --
// 위 헤더 주석/§6 mutation #9 참고). signature 관련 필드는 명시적으로
// null/note로 채워 "실 서명 아님"을 산출물 자체에 남긴다.
function buildSubGrantFields({
  delegation,
  taskHash,
  role,
  stableIntentId,
  at,
}) {
  return {
    schema_version: 1,
    delegation_id: delegation.delegation_id,
    scope_issue_id: delegation.scope_issue_id,
    role,
    task_hash: taskHash,
    stable_intent_id: stableIntentId ?? null,
    issued_at: at ?? null,
    delegation_expires_at: delegation.expires_at,
    max_start_budget_consumed: 1,
    signature: null,
    signature_note:
      "3A fake/test delegation -- no real human-key signer. Real delegation signing is future work (coder-task.md §4).",
  };
}

function writeSubGrantEnvelope(envelopePath, envelope, deps) {
  const content = JSON.stringify(envelope, null, 2) + "\n";
  try {
    deps.writeFileFn(envelopePath, content, { flag: "wx" });
  } catch (err) {
    return deny(
      REASON.ENVELOPE_WRITE_FAILED,
      `could not create sub-grant envelope '${envelopePath}' (${errText(err)}) -- no partial success`,
    );
  }
  let reread;
  try {
    reread = deps.readFileFn(envelopePath);
  } catch (err) {
    return deny(
      REASON.ENVELOPE_WRITE_FAILED,
      `could not re-read sub-grant envelope after write (${errText(err)})`,
    );
  }
  if (reread !== content) {
    return deny(
      REASON.ENVELOPE_WRITE_FAILED,
      "sub-grant envelope re-read mismatch after write -- refusing to report issued",
    );
  }
  return { ok: true };
}

// P1-1 (review-1 반려, 비타협): 이 함수는 delegation 소비뿐 아니라
// stable-intent 단일승자 claim과 admission 6게이트를 **스스로** 강제한다
// -- 별도 오케스트레이션 helper가 이 둘을 먼저 조립해줘야 안전한 게
// 아니라, 이 진입점 하나를 직접 불러도 우회가 불가능해야 한다(REVIEW가
// 직접 재현한 결함: delegation_id만 바꿔 이 함수를 두 번 부르면 grant가
// 2개 나왔다 -- 이제는 같은 stableIntentId면 두 번째 호출이 claim 단계에서
// 막힌다).
//
// resumeHumanRef가 있으면(§ P2-1) claimIntentTx를 다시 부르지 않는다 --
// claim은 exactly-once라 재claim은 구조적으로 duplicate가 나기 때문에,
// PAUSED에서 벗어나는 유일한 문은 stable-intent.mjs의
// resumeIntentAfterHumanAck다(사람이 명시적으로 supply하는 참조 문자열
// 없이는 이 분기 자체에 들어올 수 없다).
function resolveIntentWin(inp, opts) {
  const { intentDir, stableIntentId, winner, resumeHumanRef, at } = inp;
  if (!isNonEmptyString(stableIntentId)) {
    return {
      ok: false,
      deny: deny(
        REASON.INTENT_CLAIM_REQUIRED,
        "stableIntentId is required to issue a sub-grant",
      ),
    };
  }
  if (isNonEmptyString(resumeHumanRef)) {
    const resumed = resumeIntentAfterHumanAck(
      { intentDir, stableIntentId, humanResumeRef: resumeHumanRef, at },
      opts,
    );
    if (!resumed.ok) {
      return {
        ok: false,
        deny: deny(REASON.INTENT_RESUME_DENIED, resumed.reason),
      };
    }
    return { ok: true };
  }
  const claim = claimIntentTx(
    { intentDir, stableIntentId, winner: winner ?? null, at },
    opts,
  );
  if (!claim.ok || claim.claimed !== true) {
    return { ok: false, deny: deny(REASON.INTENT_CLAIM_DENIED, claim.reason) };
  }
  return { ok: true };
}

// crash/degraded 발생 시 intent를 PAUSED로 남긴다(best-effort 감사 표식 --
// 이게 실패해도 이 호출이 이미 fail-closed로 deny하고 있다는 사실 자체는
// 바뀌지 않는다, 그래서 반환값을 호출자에 강제하지 않는다).
function pauseIntentBestEffort(inp, opts, reason) {
  try {
    markIntentPaused(
      {
        intentDir: inp.intentDir,
        stableIntentId: inp.stableIntentId,
        at: inp.at,
        reason,
      },
      opts,
    );
  } catch {
    // 감사 표식일 뿐 -- 여기서 던지면 진짜 deny 사유를 가릴 수 있어 삼킨다.
  }
}

// issueSubGrant({ delegation, taskHash, role, startBudgetRequested,
//   stableIntentId, intentDir, winner, resumeHumanRef, pullAdmission, gates,
//   consumptionDir, outDir, nowMs, at }, opts)
// opts.writeFileFn/readFileFn -- 파일 I/O 주입(테스트 전용). opts는
// judgeAdmission/claimIntentTx/consumeDelegationTx에도 그대로 전달(mutex/
// save/pin I/O 주입 -- 키가 겹치지 않아 하나의 opts로 모두 결선된다).
//
// 순서(비타협): ① delegation 형식 검증 ② 서명범위 대조(§6 mutation #8) ③
// stable-intent 단일승자 claim(§ P1-1 -- 진 후보는 여기서 즉시 멈춘다) ④
// admission 6게이트 ALLOW(§ P1-1) ⑤ delegation 원자 소비(1회, §6 mutation
// #2/#10) ⑥ 소비 성공 시에만 sub-grant 파일 발급(§6 mutation #6: ⑤에서
// 죽으면 ⑥은 절대 실행되지 않는다 -- 이 함수엔 재시도 루프가 없으므로
// "crash 뒤 자동 재실행"은 구조적으로 불가능하다. ⑤/⑥에서의 실패는 intent를
// PAUSED로 남긴다 -- 사람이 resumeHumanRef로 명시 재개하기 전까지 같은
// stableIntentId로는 두 번 다시 발급을 시도할 수 없다).
// quality-check.mjs complexity/length 래칫 준수를 위해 issueSubGrant를
// 세 단계(① 형식+scope ② intent+admission ③ 소비+발급)로 오케스트레이션만
// 분리한다 -- 판정 순서·내용은 그대로다(위 헤더 주석의 비타협 순서 참고).
function checkDelegationFormatAndScope(inp, nowMs) {
  const { delegation, taskHash, role, startBudgetRequested, outDir } = inp;
  const problems = validateDelegation(delegation);
  if (problems.length > 0) {
    return deny(
      REASON.DELEGATION_INVALID,
      `delegation invalid -- ${problems.join("; ")}`,
    );
  }
  if (!isNonEmptyString(outDir)) {
    return deny(REASON.DELEGATION_INVALID, "outDir must be a non-empty string");
  }
  return checkDelegationScope(
    delegation,
    { taskHash, role, startBudgetRequested },
    nowMs,
  );
}

function consumeAndIssueEnvelope(inp, opts) {
  const {
    delegation,
    taskHash,
    role,
    stableIntentId,
    intentDir,
    consumptionDir,
    outDir,
    at,
  } = inp;
  const consumed = consumeDelegationTx(
    {
      consumptionDir,
      delegationId: delegation.delegation_id,
      taskHash,
      role,
      at,
    },
    opts,
  );
  if (!consumed.ok || consumed.claimed !== true) {
    if (consumed.duplicate !== true) {
      pauseIntentBestEffort(inp, opts, consumed.reason);
    }
    return deny(
      consumed.degraded
        ? REASON.CONSUMPTION_STORE_DEGRADED
        : consumed.duplicate
          ? REASON.DELEGATION_ALREADY_CONSUMED
          : REASON.DELEGATION_CONSUME_FAILED,
      consumed.reason,
    );
  }

  const envelope = buildSubGrantFields({
    delegation,
    taskHash,
    role,
    stableIntentId,
    at,
  });
  const envelopePath = join(
    outDir,
    `sub-grant-${delegation.delegation_id}-${taskHash}.json`,
  );
  const written = writeSubGrantEnvelope(
    envelopePath,
    envelope,
    normalizeWriteDeps(opts),
  );
  if (!written.ok) {
    pauseIntentBestEffort(inp, opts, written.detail ?? written.reason);
    return written;
  }

  markIntentIssued({ intentDir, stableIntentId, at }, opts);
  return {
    ok: true,
    issued: true,
    reason: REASON.ISSUED,
    envelope,
    envelopePath,
  };
}

export function issueSubGrant(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const nowMs = Number.isSafeInteger(inp.nowMs) ? inp.nowMs : Date.now();

  const formatOrScopeDenied = checkDelegationFormatAndScope(inp, nowMs);
  if (formatOrScopeDenied) return formatOrScopeDenied;

  const intentResolved = resolveIntentWin(inp, opts);
  if (!intentResolved.ok) return intentResolved.deny;

  const admission = judgeAdmission(
    { pullAdmission: inp.pullAdmission, gates: inp.gates },
    opts,
  );
  if (!admission.ok) {
    return deny(REASON.ADMISSION_DENIED, {
      admission_reason: admission.reason,
      admission_detail: admission.detail,
    });
  }

  return consumeAndIssueEnvelope(inp, opts);
}
