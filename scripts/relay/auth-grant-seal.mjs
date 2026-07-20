import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { join } from "node:path";
import { canonicalizeGrant } from "./auth-grant-canonical.mjs";
import { sign as ed25519Sign, verify as ed25519Verify } from "./auth-grant-ed25519.mjs";

// HYK-163 사이클 2 (pm-2 §3.5): 봉인 세리모니 -- 사람이 `!`로 1회 실행해 canonical
// grant에 실제 Ed25519 서명을 얹는 유일한 지점. **이 파일만 개인키를 읽는다**
// (게이트/러너/원장 어디에도 개인키 인자가 없다 -- auth-grant-ed25519.mjs의
// verify()가 공개키만 받는 타입 계약이 그 경계를 강제한다).
//
// HYK-162 arm-seal.mjs의 사람 확인·create-new-only·재읽기 검증 흐름을 그대로
// 승계한다(재발명 금지). 차이는 두 가지뿐이다:
//   ① 서명된 addendum 텍스트를 파싱하는 대신, 이미 구조화된 G2 grant 필드를
//      canonicalizeGrant로 검증하고 그 canonical 바이트에 실제 Ed25519 서명을
//      얹는다.
//   ② 산출(bearer signed grant+signature)을 workspace가 아닌 **protected grant
//      store**(호출자가 지정하는, repo/workspace 밖 고정 경로)에 create-new-only로
//      쓴다.
//
// 이번 사이클은 이 스크립트만 만들고 **실 서명을 실행하지 않는다**(coder-task
// 지침) -- 테스트는 그때그때 생성한 임시(ephemeral) Ed25519 키쌍만 쓴다(M1).
//
// TOFU 금지(pm-2 §3.5): `expectedPinnedKeyFingerprint`는 필수 입력이다. 이
// 세리모니는 이 앵커와 "지금 읽은 개인키가 실제로 대응하는 공개키"의 지문이
// 일치할 때만 서명을 진행한다 -- 잘못된(엉뚱한) 로컬 개인키 파일을 실수로
// 가리켜도 서명 전에 걸린다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
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

export function sha256Hex(text) {
  if (typeof text !== "string") {
    throw new TypeError("auth-grant-seal: sha256Hex requires a string");
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function fail(reason, extra = {}) {
  return { ok: false, reason: `auth-grant-seal: ${reason}`, ...extra };
}

function normalizeDeps(deps) {
  const d = isPlainObject(deps) ? deps : {};
  return {
    readFileFn:
      typeof d.readFileFn === "function" ? d.readFileFn : (p) => readFileSync(p, "utf8"),
    writeFileFn: typeof d.writeFileFn === "function" ? d.writeFileFn : writeFileSync,
    existsFn: typeof d.existsFn === "function" ? d.existsFn : existsSync,
    nowFn: typeof d.nowFn === "function" ? d.nowFn : () => new Date().toISOString(),
    readlineFn:
      typeof d.readlineFn === "function"
        ? d.readlineFn
        : async () => {
            try {
              return readFileSync(0, "utf8").split(/\r?\n/)[0] ?? "";
            } catch {
              return "";
            }
          },
  };
}

function exclusiveWrite(path, content, writeFileFn) {
  writeFileFn(path, content, { flag: "wx" });
}

// 개인키 PEM에서 대응 공개키 PEM을 유도한다(개인키 원문 자체는 반환하지 않음
// -- 호출자는 fingerprint 대조와 서명에만 이 함수의 결과를 쓴다).
function derivePublicKeyPem(privateKeyPem) {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function buildSummary(canonicalFields, canonicalHash, expectedPhrase) {
  return [
    `task_id: ${canonicalFields.task_id}`,
    `target: ${JSON.stringify(canonicalFields.target)}`,
    `audience/channel: ${canonicalFields.audience}/${canonicalFields.channel}`,
    `arm_id/cycle_id: ${canonicalFields.arm_id}/${canonicalFields.cycle_id}`,
    `expires_at: ${canonicalFields.expires_at}`,
    `jti: ${canonicalFields.jti}`,
    `budget: ${JSON.stringify(canonicalFields.budget)}`,
    `canonical_sha256: ${canonicalHash}`,
    `사람이 정확히 다음 문구를 입력해야 진행합니다: ${expectedPhrase}`,
  ].join("\n");
}

function deriveConfirmationPhrase(fields) {
  if (!isNonEmptyString(fields.arm_id) || !isNonEmptyString(fields.task_id) || !isNonEmptyString(fields.jti)) {
    return null;
  }
  return `SEAL ${fields.arm_id} ${fields.task_id} ${fields.jti}`;
}

async function confirmHuman(canonicalFields, canonicalHash, deps) {
  const expectedPhrase = deriveConfirmationPhrase(canonicalFields);
  if (!expectedPhrase) {
    return fail("could not derive human confirmation phrase from arm_id/task_id/jti");
  }
  const summary = buildSummary(canonicalFields, canonicalHash, expectedPhrase);
  const typed = await deps.readlineFn(summary);
  if (typed !== expectedPhrase) {
    return fail(
      `human confirmation mismatch -- expected exact '${expectedPhrase}', got ${JSON.stringify(typed)} (no partial success)`,
    );
  }
  return { ok: true, expectedPhrase };
}

function loadAndCheckPrivateKey(privateKeyPath, expectedPinnedKeyFingerprint, deps) {
  if (!isNonEmptyString(expectedPinnedKeyFingerprint)) {
    // pm-2 §3.5: 앵커 누락은 항상 DENY(workspace/로컬 파일이 스스로 신뢰 앵커가
    // 되는 TOFU를 원천 차단). 개인키를 읽기 **전에** 이 검사를 먼저 한다.
    return fail("expectedPinnedKeyFingerprint is required (no TOFU on a local key file)");
  }
  let privateKeyPem;
  try {
    privateKeyPem = deps.readFileFn(privateKeyPath);
  } catch (err) {
    return fail(`cannot read private key at '${privateKeyPath}' (${errText(err)})`);
  }
  let derived;
  try {
    derived = derivePublicKeyPem(privateKeyPem);
  } catch (err) {
    return fail(`private key at '${privateKeyPath}' is not a usable Ed25519 key (${errText(err)})`);
  }
  const actualFingerprint = sha256Hex(derived.publicKeyPem);
  if (actualFingerprint !== expectedPinnedKeyFingerprint) {
    return fail(
      `private key's derived public key fingerprint ${actualFingerprint} does not match expectedPinnedKeyFingerprint ${expectedPinnedKeyFingerprint} -- refusing to sign with the wrong local key`,
    );
  }
  return { ok: true, privateKey: derived.privateKey, publicKeyPem: derived.publicKeyPem };
}

function writeSealedEnvelope(envelopePath, envelope, deps) {
  const content = JSON.stringify(envelope, null, 2) + "\n";
  try {
    exclusiveWrite(envelopePath, content, deps.writeFileFn);
  } catch (err) {
    return fail(
      `could not create sealed envelope '${envelopePath}' (${errText(err)}) -- no partial success, refusing to report ARMED`,
    );
  }
  let reread;
  try {
    reread = deps.readFileFn(envelopePath);
  } catch (err) {
    return fail(`could not re-read sealed envelope after write (${errText(err)})`);
  }
  if (reread !== content) {
    return fail("sealed envelope re-read mismatch after write -- refusing to report ARMED");
  }
  return { ok: true };
}

// sealAuthGrant(opts) -> Promise<{ok, reason?, envelopePath?, canonicalHash?}>
//   opts: {
//     fields,                      -- G2 canonical grant 후보 필드(schema/policy
//                                     version·해시 4종·task_id·target·audience·
//                                     channel·arm_id·cycle_id·expires_at·budget·jti)
//     keyId,                       -- 공개키 pin manifest의 key_id(이 서명이
//                                     어떤 공개키로 검증돼야 하는지 lookup용,
//                                     canonical에 결속되지 않는 비서명 메타데이터)
//     privateKeyPath,               -- repo/workspace 밖 고정 파일(개인키 PEM)
//     expectedPinnedKeyFingerprint,  -- 필수, 외부 사전 설치 앵커
//     outDir,                       -- protected grant store(workspace 밖)
//     deps: { readFileFn, writeFileFn, existsFn, nowFn, readlineFn }
//   }
export async function sealAuthGrant(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const deps = normalizeDeps(o.deps);

  if (!isNonEmptyString(o.keyId)) return fail("keyId is required");
  if (!isNonEmptyString(o.privateKeyPath)) return fail("privateKeyPath is required");
  if (!isNonEmptyString(o.outDir)) return fail("outDir is required");

  const canon = canonicalizeGrant(o.fields);
  if (!canon.ok) return fail(`candidate grant fields invalid -- ${canon.reason}`);
  const canonicalHash = sha256Hex(canon.canonicalJson);

  const keyCheck = loadAndCheckPrivateKey(o.privateKeyPath, o.expectedPinnedKeyFingerprint, deps);
  if (!keyCheck.ok) return keyCheck;

  const envelopePath = join(o.outDir, `signed-grant-${canon.fields.arm_id}-${canon.fields.jti}.json`);
  if (deps.existsFn(envelopePath)) {
    return fail(`refusing to overwrite existing sealed envelope '${envelopePath}' -- same arm_id/jti already sealed`);
  }

  const confirmed = await confirmHuman(canon.fields, canonicalHash, deps);
  if (!confirmed.ok) return confirmed;

  // 서명 직전 마지막 자기검증: 지금 만들 서명이 그 자리에서 바로 검증되는지
  // (개인키/공개키 페어가 실제로 대응하는지 다시 한번 실증 -- 부분 산출 방지).
  const signature = ed25519Sign(canon.canonicalBytes, keyCheck.privateKey);
  const selfVerified = ed25519Verify(canon.canonicalBytes, signature, keyCheck.publicKeyPem);
  if (!selfVerified) {
    return fail("freshly-produced signature failed self-verification -- refusing to seal (no partial success)");
  }

  const envelope = {
    schema_version: 1,
    grantRaw: { ...canon.fields, key_id: o.keyId },
    signature: signature.toString("base64"),
    sealed_at: deps.nowFn(),
    canonical_sha256: canonicalHash,
  };
  const written = writeSealedEnvelope(envelopePath, envelope, deps);
  if (!written.ok) return written;

  return { ok: true, envelopePath, canonicalHash, keyId: o.keyId };
}

// ---- CLI: `node auth-grant-seal.mjs <fields.json> <keyId> <privateKeyPath> <expectedPinnedKeyFingerprint> <outDir>` ----
// (§3.5: "이번 사이클엔 스크립트만 만들고 실 서명 실행 안 함" -- CLI 진입점은
// 존재하지만 이 사이클의 테스트/완료 절차는 이 경로를 실행하지 않는다.)
const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/relay/auth-grant-seal.mjs");
if (invokedDirectly) {
  const [fieldsPath, keyId, privateKeyPath, expectedPinnedKeyFingerprint, outDir] = process.argv.slice(2);
  if (!fieldsPath || !keyId || !privateKeyPath || !expectedPinnedKeyFingerprint || !outDir) {
    console.error(
      "usage: node auth-grant-seal.mjs <fields.json> <keyId> <privateKeyPath> <expectedPinnedKeyFingerprint> <outDir>",
    );
    process.exit(1);
  }
  const fields = JSON.parse(readFileSync(fieldsPath, "utf8"));
  const result = await sealAuthGrant({ fields, keyId, privateKeyPath, expectedPinnedKeyFingerprint, outDir });
  if (result.ok) {
    // 개인키·raw signature bytes는 절대 출력하지 않는다 -- 경로/해시만.
    console.log(JSON.stringify({ ok: true, envelopePath: result.envelopePath, canonicalHash: result.canonicalHash }));
    process.exit(0);
  }
  console.error(result.reason);
  process.exit(1);
}
