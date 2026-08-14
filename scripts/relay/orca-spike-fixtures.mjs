import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArmStore, armStorePath, hashContent } from "./arm-state.mjs";

// HYK-162 coder-8 (M1, 보고서-pm2.md §4.4): 이 파일은 **테스트 전용** 합성
// packet/arm/task fixture 빌더다. review-7이 rejected한 결함(합성 fixture로
// request/expected를 동시 조립해 "발사 자격의 자기대조"가 생기는 문제)의
// 재발을 막기 위해, 이 파일의 어떤 함수도 `orca-spike-live.mjs`(라이브 진입)의
// 정적 코드에서 import/호출되지 않는다 -- 테스트(`orca-spike-live.test.mjs`)와
// 리허설 목적의 러너 계약 검증에서만 쓰인다.

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

export const DEFAULT_TASK_ID = "SPIKE-LIVE-1";

// opts: {
//   human_approval_ref, arm_id, cycle_id  -- grant/request 양쪽에 동일 주입
//   issued_at, expires_at                 -- ISO 문자열
//   target                                -- dispatch --to 받을 worker 터미널 handle
//   role                                  -- 기본 "CODER"
//   nowMs                                 -- predispatch 판정 시각(만료 재현용)
// }
// deps(테스트 주입용, 생략 시 실제 fs): { mkdtempFn, mkdirFn, writeFileFn }
const REQUIRED_FIXTURE_FIELDS = [
  "human_approval_ref",
  "arm_id",
  "cycle_id",
  "issued_at",
  "expires_at",
  "target",
];

function missingFixtureField(o) {
  for (const f of REQUIRED_FIXTURE_FIELDS) {
    if (!isNonEmptyString(o[f])) return f;
  }
  return null;
}

function resolveFixtureDeps(deps) {
  return {
    mkdtempFn:
      typeof deps.mkdtempFn === "function" ? deps.mkdtempFn : mkdtempSync,
    mkdirFn: typeof deps.mkdirFn === "function" ? deps.mkdirFn : mkdirSync,
    writeFileFn:
      typeof deps.writeFileFn === "function" ? deps.writeFileFn : writeFileSync,
  };
}

function writeSyntheticArmStore(dir, o, writeFileFn) {
  const grant = {
    arm_id: o.arm_id,
    cycle_id: o.cycle_id,
    human_approval_ref: o.human_approval_ref,
    issued_at: o.issued_at,
    expires_at: o.expires_at,
    allowed_lanes: ["CODER"],
    allowed_task_ids: [DEFAULT_TASK_ID],
    max_starts_total: 1,
    max_starts_per_lane: 1,
    max_rejections: 3,
    publish_allowed: false,
    question_policy: "pause",
    error_policy: "pause",
  };
  const created = createArmStore(grant, { at: o.issued_at });
  if (!created.ok) {
    return {
      ok: false,
      reason: `orca-spike-fixtures: createArmStore refused -- ${created.reason}`,
    };
  }
  const storePath = armStorePath(dir, o.arm_id);
  writeFileFn(storePath, JSON.stringify(created.store), "utf8");
  return { ok: true, storePath };
}

export function buildSyntheticFixture(opts, deps = {}) {
  const o = isPlainObject(opts) ? opts : {};
  const { mkdtempFn, mkdirFn, writeFileFn } = resolveFixtureDeps(deps);

  const missing = missingFixtureField(o);
  if (missing) {
    return {
      ok: false,
      reason: `orca-spike-fixtures: buildSyntheticFixture requires non-empty string opts.${missing}`,
    };
  }
  const role = isNonEmptyString(o.role) ? o.role : "CODER";
  const nowMs = Number.isSafeInteger(o.nowMs)
    ? o.nowMs
    : Date.parse(o.issued_at);

  const dir = mkdtempFn(join(tmpdir(), "orca-spike-live-"));

  const packetPath = join(dir, "packet.md");
  writeFileFn(
    packetPath,
    `packet_id: PKT-LIVE-1\n승인: OK ${o.human_approval_ref}\n`,
    "utf8",
  );

  const armResult = writeSyntheticArmStore(dir, o, writeFileFn);
  if (!armResult.ok) return armResult;

  const taskContent = buildSyntheticTaskContent(o.issued_at);
  const taskFilePath = join(dir, "spike-live-task.md");
  writeFileFn(taskFilePath, taskContent, "utf8");
  const content_hash = hashContent(taskContent);

  const harnessDir = join(dir, "harness");
  mkdirFn(harnessDir, { recursive: true });

  const request = {
    human_approval_ref: o.human_approval_ref,
    arm_id: o.arm_id,
    cycle_id: o.cycle_id,
    task_id: DEFAULT_TASK_ID,
    content_hash,
    target: o.target,
    role,
  };

  return {
    ok: true,
    dir,
    packetPath,
    storePath: armResult.storePath,
    taskFilePath,
    harnessDir,
    task_id: DEFAULT_TASK_ID,
    predispatch: {
      packetPath,
      armDir: dir,
      arm_id: o.arm_id,
      taskFilePath,
      nowMs,
      request,
      expected: { target: o.target, role },
    },
  };
}

function buildSyntheticTaskContent(issuedAtIso) {
  const droppedAtKst = isoToKstLabel(issuedAtIso);
  return [
    `task_id: ${DEFAULT_TASK_ID}`,
    `dropped_at: ${droppedAtKst}`,
    "",
    "Orca 라이브 스파이크 합성 지시 (HYK-162 사이클2, 관찰 전용 -- 이 문서 하나로 자족).",
    "당신은 다음 세 가지만 정확히 수행하고, 그 외 어떤 행동도 하지 않는다:",
    "1. 이 작업 디렉토리의 `spike-live-result.md` 파일에 정확히 한 줄을 기록한다:",
    "   `>>> DONE: spike @ <실제 완료 시각, YYYY-MM-DD HH:MM:SS KST>`(초 단위 필수, HYK-244)",
    "2. Orca 주입 preamble이 안내하는 방식으로 worker_done을 정확히 1회 전송한다",
    "   (preamble이 제공하는 taskId/dispatchId를 그대로 사용 -- 임의로 지어내지 않는다).",
    "3. 그 외의 파일 읽기·쓰기·명령 실행·질문·에스컬레이션·시크릿/개인정보/작업전문",
    "   포함은 전부 금지.",
    "",
  ].join("\n");
}

function isoToKstLabel(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const kst = new Date(ms + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} KST`;
}
