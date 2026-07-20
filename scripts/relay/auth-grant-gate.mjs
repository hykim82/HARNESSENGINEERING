import { canonicalizeGrant } from "./auth-grant-canonical.mjs";
import { verify as ed25519Verify } from "./auth-grant-ed25519.mjs";
import { loadPinnedPublicKeys, findKeyById } from "./auth-grant-pin.mjs";

// HYK-163 사이클 1 (G1/G2/G4): fail-closed 인증 grant 판정기.
//
// orca-predispatch.mjs의 패턴을 그대로 승계한다(재발명 금지, 지침 인용):
// distinct REASON 상수 + `checkA(...) ?? checkB(...) ?? ...` 체이닝 + ALLOW는
// 전 조건 통과 시에만. 이 게이트는 개인키를 읽지 않는다(auth-grant-ed25519의
// verify()가 공개키만 받으므로 타입상 개인키가 이 경로로 들어올 수 없다).
//
// 이중 방어(honesty로 남긴다 -- 둘 다 필요한 이유):
//  (a) 서명 검증: canonical 바이트가 pin된 공개키로 서명됐는지. G2 각 필드가
//      canonical에 포함되므로, grant 값을 하나라도 사후 변조하면 서명이
//      깨진다(SIGNATURE_INVALID) -- "canonical 필드 변조" 반사실은 대부분
//      여기서 잡힌다.
//  (b) expected 필드 결속: 서명 자체는 유효하지만(다른 정당한 목적으로 발급된
//      grant), 이번 호출 맥락(task_id/arm_id/cycle_id/target/audience/channel)과
//      다른 grant를 갖다붙이는 재사용(replay-into-wrong-context)을 막는다.
//      서명 검증만으로는 이 경우를 못 잡는다 -- 서명 자체는 진짜이기 때문.
//
// 정직 한계: target.agent_instance는 필드 존재·canonical 결속만 검사한다.
// "이 agent_instance가 지금 실제로 살아있는가"(liveness)는 여기서 판단하지
// 않는다 -- 사이클 2(B게이트 PEP·claim·liveness) 몫.

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
  CANONICAL_INVALID: "CANONICAL_INVALID",
  SCHEMA_VERSION_MISMATCH: "SCHEMA_VERSION_MISMATCH",
  POLICY_VERSION_MISMATCH: "POLICY_VERSION_MISMATCH",
  KEY_ID_MISSING: "KEY_ID_MISSING",
  PIN_UNAVAILABLE: "PIN_UNAVAILABLE",
  KEY_UNKNOWN: "KEY_UNKNOWN",
  KEY_REVOKED: "KEY_REVOKED",
  PIN_MISMATCH: "PIN_MISMATCH",
  SIGNATURE_MISSING: "SIGNATURE_MISSING",
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  TASK_ID_MISMATCH: "TASK_ID_MISMATCH",
  ARM_ID_MISMATCH: "ARM_ID_MISMATCH",
  CYCLE_ID_MISMATCH: "CYCLE_ID_MISMATCH",
  TARGET_MISMATCH: "TARGET_MISMATCH",
  AUDIENCE_MISMATCH: "AUDIENCE_MISMATCH",
  CHANNEL_MISMATCH: "CHANNEL_MISMATCH",
  EXPIRED: "EXPIRED",
  ALLOW: "ALLOW",
});

function deny(reason, detail) {
  return { ok: false, reason, detail: detail ?? null };
}

function checkVersions(fields, expected) {
  if (
    !isSafeCount(expected.schema_version) ||
    fields.schema_version !== expected.schema_version
  ) {
    return deny(
      REASON.SCHEMA_VERSION_MISMATCH,
      `expected schema_version=${JSON.stringify(expected.schema_version)}, grant has ${fields.schema_version}`,
    );
  }
  if (
    !isSafeCount(expected.policy_version) ||
    fields.policy_version !== expected.policy_version
  ) {
    return deny(
      REASON.POLICY_VERSION_MISMATCH,
      `expected policy_version=${JSON.stringify(expected.policy_version)}, grant has ${fields.policy_version}`,
    );
  }
  return null;
}

function checkKey(grantRaw, expected, pinnedPublicKeyPath, pinDeps) {
  const keyId = isPlainObject(grantRaw) ? grantRaw.key_id : undefined;
  if (!isNonEmptyString(keyId)) {
    return {
      denied: deny(REASON.KEY_ID_MISSING, "grantRaw.key_id is missing/empty"),
    };
  }
  let loaded;
  try {
    loaded = loadPinnedPublicKeys(pinnedPublicKeyPath, pinDeps);
  } catch (err) {
    return {
      denied: deny(
        REASON.PIN_UNAVAILABLE,
        `loadPinnedPublicKeys threw: ${errText(err)}`,
      ),
    };
  }
  if (!loaded.ok)
    return { denied: deny(REASON.PIN_UNAVAILABLE, loaded.reason) };

  const key = findKeyById(loaded.keys, keyId);
  if (!key) {
    return {
      denied: deny(
        REASON.KEY_UNKNOWN,
        `key_id ${JSON.stringify(keyId)} not found in pin manifest`,
      ),
    };
  }
  if (key.status === "revoked") {
    return {
      denied: deny(
        REASON.KEY_REVOKED,
        `key_id ${JSON.stringify(keyId)} is revoked`,
      ),
    };
  }
  if (
    isNonEmptyString(expected.pinned_key_fingerprint) &&
    expected.pinned_key_fingerprint !== key.fingerprint
  ) {
    return {
      denied: deny(
        REASON.PIN_MISMATCH,
        `pin manifest resolved key_id ${JSON.stringify(keyId)} to fingerprint ${key.fingerprint}, but expected anchor is ${expected.pinned_key_fingerprint}`,
      ),
    };
  }
  return { key };
}

function checkSignature(inp, canonicalBytes, publicKeyPem) {
  if (!isNonEmptyString(inp.signature)) {
    return deny(REASON.SIGNATURE_MISSING, "signature is missing/empty");
  }
  let signatureBuf;
  try {
    signatureBuf = Buffer.from(inp.signature, "base64");
  } catch (err) {
    return deny(
      REASON.SIGNATURE_INVALID,
      `signature is not valid base64 (${errText(err)})`,
    );
  }
  if (signatureBuf.length === 0) {
    return deny(
      REASON.SIGNATURE_MISSING,
      "signature decodes to an empty buffer",
    );
  }
  const verified = ed25519Verify(canonicalBytes, signatureBuf, publicKeyPem);
  if (!verified) {
    return deny(
      REASON.SIGNATURE_INVALID,
      "Ed25519 signature does not verify against the pinned public key for this canonical payload",
    );
  }
  return null;
}

// 각 결속 필드를 독립 헬퍼로 분리한다(checkFieldBindings 자체의 복잡도를
// 낮추기 위함 -- quality-check.mjs complexity 래칫). orca-predispatch.mjs의
// `checkA(...) ?? checkB(...) ?? ...` 체이닝 패턴 재사용.
function checkTaskIdBinding(fields, expected) {
  if (
    !isNonEmptyString(expected.task_id) ||
    fields.task_id !== expected.task_id
  ) {
    return deny(
      REASON.TASK_ID_MISMATCH,
      `expected task_id=${JSON.stringify(expected.task_id)}, grant has ${JSON.stringify(fields.task_id)}`,
    );
  }
  return null;
}

function checkArmIdBinding(fields, expected) {
  if (!isNonEmptyString(expected.arm_id) || fields.arm_id !== expected.arm_id) {
    return deny(
      REASON.ARM_ID_MISMATCH,
      `expected arm_id=${JSON.stringify(expected.arm_id)}, grant has ${JSON.stringify(fields.arm_id)}`,
    );
  }
  return null;
}

function checkCycleIdBinding(fields, expected) {
  if (
    !isNonEmptyString(expected.cycle_id) ||
    fields.cycle_id !== expected.cycle_id
  ) {
    return deny(
      REASON.CYCLE_ID_MISMATCH,
      `expected cycle_id=${JSON.stringify(expected.cycle_id)}, grant has ${JSON.stringify(fields.cycle_id)}`,
    );
  }
  return null;
}

function checkTargetBinding(fields, expected) {
  const et = isPlainObject(expected.target) ? expected.target : {};
  if (
    !isNonEmptyString(et.handle) ||
    !isNonEmptyString(et.fingerprint) ||
    fields.target.handle !== et.handle ||
    fields.target.fingerprint !== et.fingerprint
  ) {
    return deny(
      REASON.TARGET_MISMATCH,
      `expected target ${JSON.stringify(et)}, grant has {handle:${JSON.stringify(fields.target.handle)}, fingerprint:${JSON.stringify(fields.target.fingerprint)}}`,
    );
  }
  return null;
}

function checkAudienceBinding(fields, expected) {
  if (
    !isNonEmptyString(expected.audience) ||
    fields.audience !== expected.audience
  ) {
    return deny(
      REASON.AUDIENCE_MISMATCH,
      `expected audience=${JSON.stringify(expected.audience)}, grant has ${JSON.stringify(fields.audience)}`,
    );
  }
  return null;
}

function checkChannelBinding(fields, expected) {
  if (
    !isNonEmptyString(expected.channel) ||
    fields.channel !== expected.channel
  ) {
    return deny(
      REASON.CHANNEL_MISMATCH,
      `expected channel=${JSON.stringify(expected.channel)}, grant has ${JSON.stringify(fields.channel)}`,
    );
  }
  return null;
}

function checkFieldBindings(fields, expected) {
  return (
    checkTaskIdBinding(fields, expected) ??
    checkArmIdBinding(fields, expected) ??
    checkCycleIdBinding(fields, expected) ??
    checkTargetBinding(fields, expected) ??
    checkAudienceBinding(fields, expected) ??
    checkChannelBinding(fields, expected)
  );
}

function checkExpiry(fields, nowMs) {
  const expMs = Date.parse(fields.expires_at);
  if (!Number.isSafeInteger(nowMs) || Number.isNaN(expMs) || nowMs > expMs) {
    return deny(
      REASON.EXPIRED,
      `grant expires_at=${fields.expires_at}, now=${Number.isSafeInteger(nowMs) ? new Date(nowMs).toISOString() : "invalid"}`,
    );
  }
  return null;
}

// verifyAuthGrant({ grantRaw, signature, pinnedPublicKeyPath, expected, nowMs }, opts)
// opts.pinDeps -- loadPinnedPublicKeys용 의존 함수 주입(테스트 전용, 기본은 실 fs 읽기).
// 반환: { ok, reason, detail } -- ok===true일 때만 reason===REASON.ALLOW.
export function verifyAuthGrant(input, opts) {
  const inp = isPlainObject(input) ? input : {};
  const expected = isPlainObject(inp.expected) ? inp.expected : {};
  const nowMs = Number.isSafeInteger(inp.nowMs) ? inp.nowMs : Date.now();
  const o = isPlainObject(opts) ? opts : {};

  let canon;
  try {
    canon = canonicalizeGrant(inp.grantRaw);
  } catch (err) {
    return deny(
      REASON.CANONICAL_INVALID,
      `canonicalizeGrant threw: ${errText(err)}`,
    );
  }
  if (!canon.ok) return deny(REASON.CANONICAL_INVALID, canon.reason);
  const { fields, canonicalBytes } = canon;

  const denied =
    checkVersions(fields, expected) ??
    (() => {
      const keyResult = checkKey(
        inp.grantRaw,
        expected,
        inp.pinnedPublicKeyPath,
        o.pinDeps,
      );
      if (keyResult.denied) return keyResult.denied;
      return (
        checkSignature(inp, canonicalBytes, keyResult.key.public_key_pem) ??
        checkFieldBindings(fields, expected) ??
        checkExpiry(fields, nowMs)
      );
    })();
  if (denied) return denied;

  return { ok: true, reason: REASON.ALLOW, detail: null };
}
