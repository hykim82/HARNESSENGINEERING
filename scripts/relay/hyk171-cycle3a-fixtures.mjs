import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { canonicalizePullGrant } from "./pull-grant-canonical.mjs";
import { canonicalizeAuthorization } from "./pull-authorization.mjs";
import { sign } from "./auth-grant-ed25519.mjs";

// HYK-171 사이클3A -- stable-intent/admission-core/grant-issuer 테스트
// 공용 픽스처. 전부 합성(synthetic)/fake다:
//   - pull-admission 번들(signed-grant/authorization/arm-state)은
//     pull-admission.test.mjs와 동일 패턴으로 테스트 시점에 생성하는
//     ephemeral Ed25519 키쌍으로 서명한다(M1 격리 -- 실 정본 파일 미접촉).
//   - delegation은 **실 사람키 서명기가 없는 fake 객체**다(coder-task.md
//     §4 스코프 경계 -- 이 사이클은 delegation 소비 계약만 검증하지, 실
//     서명 크립토를 발명하지 않는다).
// S6 봉인: 이 파일은 orca 모듈을 import하지 않고 CLI를 호출하지 않는다
// (grep-checkable).

export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
export function pem(keyObj, type) {
  return type === "public"
    ? keyObj.export({ type: "spki", format: "pem" }).toString()
    : keyObj.export({ type: "pkcs8", format: "pem" }).toString();
}

export function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk171-cycle3a-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function writePin(dir, entries) {
  const pinPath = join(dir, "pin.json");
  writeJson(pinPath, { trusted_keys: entries });
  return pinPath;
}

export const ISSUED_AT = "2026-07-25T00:00:00.000Z";
export const EXPIRES_AT = "2026-07-25T00:20:00.000Z";
export const IN_WINDOW_NOW = Date.parse("2026-07-25T00:10:00.000Z");

export const ARM_ID = "arm-3a-1";
export const JTI = "jti-3a-1";

export const TASK_HEADER_SHA256 = sha256("hyk171-cycle3a-synthetic-task");
export const LAUNCH_PROFILE_SHA256 = sha256("hyk171-cycle3a-launch-profile");
export const WORKER_CONFIG_SHA256 = sha256("hyk171-cycle3a-worker-config");

export const AUTHORIZATION_FIELDS = Object.freeze({
  schema_version: 1,
  arm_id: ARM_ID,
  cycle_id: "cycle-3a-1",
  task_id: "HYK-171-cycle3a-1",
  resolved_task_path: "C:\\fake\\.harness\\coder-task.md",
  task_header_id: "HYK-171-cycle3a-1",
  task_header_sha256: TASK_HEADER_SHA256,
  lane: "CODER",
  cwd: "C:\\fake\\repo",
  worktree: "C:\\fake\\repo",
  launch_profile_sha256: LAUNCH_PROFILE_SHA256,
  worker_config_sha256: WORKER_CONFIG_SHA256,
  person_approval_ref: "PKT-TEST-3A:승인:OK:2026-07-25",
  publish_allowed: false,
  retry_allowed: false,
  on_question: "pause",
  on_error: "pause",
});

function authorizationSha256() {
  const canon = canonicalizeAuthorization(AUTHORIZATION_FIELDS);
  if (!canon.ok)
    throw new Error(
      `fixture canonicalizeAuthorization failed: ${canon.reason}`,
    );
  return canon.sha256;
}

export const GRANT_FIELDS = Object.freeze({
  schema_version: 2,
  policy_version: 1,
  packet_sha256: sha256("hyk171-cycle3a-synthetic-packet"),
  addendum_sha256: sha256("hyk171-cycle3a-synthetic-addendum"),
  authorization_sha256: authorizationSha256(),
  task_sha256: TASK_HEADER_SHA256,
  task_id: "HYK-171-cycle3a-1",
  target: Object.freeze({
    handle: "test-terminal",
    fingerprint: "test-fingerprint",
    agent_instance: "test-agent-instance",
    launch_profile_sha256: LAUNCH_PROFILE_SHA256,
  }),
  audience: "CODER",
  channel: "harness-signed-pull-v1",
  arm_id: ARM_ID,
  cycle_id: "cycle-3a-1",
  issued_at: ISSUED_AT,
  expires_at: EXPIRES_AT,
  budget: Object.freeze({ max_starts_total: 1 }),
  jti: JTI,
});

export const ARM_STATE_FIELDS = Object.freeze({
  arm_id: ARM_ID,
  cycle_id: GRANT_FIELDS.cycle_id,
  task_id: GRANT_FIELDS.task_id,
  lane: AUTHORIZATION_FIELDS.lane,
  expires_at: EXPIRES_AT,
  budget: { max_starts_total: 1 },
});

export const GOOD_SIGNER = generateKeyPairSync("ed25519");
export const GOOD_SIGNER_FINGERPRINT = sha256(
  pem(GOOD_SIGNER.publicKey, "public"),
);

export const EXPECTED = Object.freeze({
  schema_version: GRANT_FIELDS.schema_version,
  policy_version: GRANT_FIELDS.policy_version,
  task_id: GRANT_FIELDS.task_id,
  arm_id: GRANT_FIELDS.arm_id,
  cycle_id: GRANT_FIELDS.cycle_id,
  target: Object.freeze({ ...GRANT_FIELDS.target }),
  audience: GRANT_FIELDS.audience,
  channel: GRANT_FIELDS.channel,
  pinned_key_fingerprint: GOOD_SIGNER_FINGERPRINT,
  resolved_task_path: AUTHORIZATION_FIELDS.resolved_task_path,
  task_header_id: AUTHORIZATION_FIELDS.task_header_id,
  lane: AUTHORIZATION_FIELDS.lane,
  cwd: AUTHORIZATION_FIELDS.cwd,
  worktree: AUTHORIZATION_FIELDS.worktree,
  worker_config_sha256: AUTHORIZATION_FIELDS.worker_config_sha256,
  packet_sha256: GRANT_FIELDS.packet_sha256,
});

function grantEnvelope(fields, signerPrivateKey, keyId) {
  const canon = canonicalizePullGrant(fields);
  if (!canon.ok)
    throw new Error(`fixture canonicalizePullGrant failed: ${canon.reason}`);
  const sig = sign(canon.canonicalBytes, signerPrivateKey);
  return {
    grantRaw: { ...fields, key_id: keyId },
    signature: sig.toString("base64"),
  };
}

// writePullAdmissionBundle: bundleDir에 signed-grant/authorization/arm-state
// 3파일 + pin manifest를 쓴다. overrides로 개별 필드 변조 가능(반사실용).
// jti를 다르게 넘기면(overrides.grantFields.jti + overrides.filenameJti)
// "같은 stall, 다른 jti의 valid grant 2개" 반사실(§6 mutation #1)을 만들
// 수 있다.
export function writePullAdmissionBundle(dir, overrides = {}) {
  const grantFields = { ...GRANT_FIELDS, ...(overrides.grantFields ?? {}) };
  const authFields = {
    ...AUTHORIZATION_FIELDS,
    ...(overrides.authFields ?? {}),
  };
  const armFields = { ...ARM_STATE_FIELDS, ...(overrides.armFields ?? {}) };
  const armId = overrides.filenameArmId ?? grantFields.arm_id ?? ARM_ID;
  const jti = overrides.filenameJti ?? grantFields.jti ?? JTI;

  const pinPath = writePin(dir, [
    {
      key_id: "k-good",
      public_key_pem: pem(GOOD_SIGNER.publicKey, "public"),
      status: "active",
    },
  ]);
  const env = grantEnvelope(grantFields, GOOD_SIGNER.privateKey, "k-good");
  writeJson(join(dir, `signed-grant-${armId}-${jti}.json`), env);
  writeJson(join(dir, `authorization-${armId}.json`), authFields);
  writeJson(join(dir, `arm-${armId}.json`), armFields);
  return { pinPath, armId, jti };
}

export function pullAdmissionInput(dir, pinPath, overrides = {}) {
  return {
    bundleDir: dir,
    armId: ARM_ID,
    jti: JTI,
    pinnedPublicKeyPath: pinPath,
    expected: EXPECTED,
    nowMs: IN_WINDOW_NOW,
    ...overrides,
  };
}

// ---- admission-core gates fixture ----
export function makeAllowGates(overrides = {}) {
  return {
    storeCorrupt: false,
    authorityKnown: true,
    hardStop: false,
    dangerousExecution: false,
    newIssueBoundary: false,
    consecutiveRejections: 0,
    northStarApprovalReceipt: "receipt-3a-north-star-ok",
    packetScopeChanged: false,
    sameIssueFirstRework: true,
    withinApprovedScopeBudget: true,
    ...overrides,
  };
}

// ---- stable-intent fields fixture ----
export function makeStableIntentFields(overrides = {}) {
  return {
    issueId: "HYK-171",
    role: "CODER",
    dispatchGeneration: "dispatch-gen-1",
    stallEpisodeId: "stall-episode-1",
    taskContentGeneration: "task-content-gen-1",
    redeliveryGeneration: "redelivery-gen-1",
    ...overrides,
  };
}

// ---- fake delegation fixture (no real human-key signer -- §4 스코프
// 경계) ----
export const DELEGATION_TASK_HASH = TASK_HEADER_SHA256;
export const DELEGATION_EXPIRES_AT = "2026-07-25T00:30:00.000Z";
export const DELEGATION_IN_WINDOW_NOW = Date.parse("2026-07-25T00:10:00.000Z");

export function makeFakeDelegation(overrides = {}) {
  return {
    schema_version: 1,
    delegation_id: "delegation-3a-1",
    scope_issue_id: "HYK-171",
    role: "CODER",
    allowed_task_hashes: [DELEGATION_TASK_HASH],
    max_start_budget: 1,
    expires_at: DELEGATION_EXPIRES_AT,
    max_consecutive_rejections: 2,
    excludes_north_star: true,
    excludes_hard_stop: true,
    // 사람 개인키/서명은 여기 없다 -- 이 필드는 사람이 이 delegation을
    // 발급했다는 감사용 참조 문자열일 뿐, 이 모듈이 검증하지 않는다(후속
    // 작업 몫).
    human_approval_ref: "PKT-TEST-3A:delegation:fake",
    ...overrides,
  };
}
