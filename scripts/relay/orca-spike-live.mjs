import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArmStore, armStorePath, hashContent } from "./arm-state.mjs";
import { runSpikeAttempt, writeReceiptLedger } from "./orca-spike-runner.mjs";

// HYK-162 사이클2 (coder-7, PKT-20260719-HYK162-ORCA-HYBRID-SPIKE §4): 러너
// (orca-spike-runner.mjs, review-6 approved)를 실제 orca 바이너리에 잇는 라이브
// 드라이버. **이 파일이 실 orca를 부르는 유일한 경로는 CLI 진입(맨 아래)뿐이고,
// 그마저 명시적 `--live` 플래그 없이는 아무 것도 하지 않는다** -- 이 커밋 자체는
// 발사가 아니다(review-7 S7 선행 필요, 이 태스크에서 실 orca 호출 0).
//
// 어댑터가 하는 일은 딱 두 가지뿐이다: (1) orca stdout을 JSON으로 파싱해 그대로
// 돌려주기(task-create/dispatch), (2) check 응답만 러너가 기대하는 outcome 어휘로
// 변환하기. 그 외 판단(화이트리스트·predispatch·완료 권위)은 전부 러너·predispatch
// 소유 -- 여기서 재구현하지 않는다.

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

export const DEFAULT_TASK_ID = "SPIKE-LIVE-1";

// ---- ① 합성 입력 구성 (실 .harness·실 arm 원장 절대 안 건드림 -- 전부 임시 디렉토리) ----
// opts: {
//   human_approval_ref, arm_id, cycle_id  -- grant/request 양쪽에 동일 주입
//   issued_at, expires_at                 -- ISO 문자열(발사 시각 + 여유, 호출자가 계산해 넘김)
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

// arm store 생성 + 디스크 기록까지 한 단계로 묶는다(buildSyntheticFixture 라인수 절감용
// 분리 -- 의미상 독립 책임이기도 하다: grant 구성은 여기, 조립은 호출부).
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
      reason: `orca-spike-live: createArmStore refused -- ${created.reason}`,
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
      reason: `orca-spike-live: buildSyntheticFixture requires non-empty string opts.${missing}`,
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

// 합성 워커 지시(패킷 §5: 시크릿·작업전문·개인정보 금지) -- 자족적: 워커가 이 문서
// 하나만으로 정확히 3가지만 하도록 지시한다. taskId/dispatchId는 이 시점(task-create
// 이전)엔 존재하지 않으므로, worker_done 전송 시 그 값을 채우는 건 Orca의 주입
// preamble이 이미 하는 일에 맡긴다(이 문서는 그 값을 강제로 지어내지 않는다).
function buildSyntheticTaskContent(issuedAtIso) {
  const droppedAtKst = isoToKstLabel(issuedAtIso);
  return [
    `task_id: ${DEFAULT_TASK_ID}`,
    `dropped_at: ${droppedAtKst}`,
    "",
    "Orca 라이브 스파이크 합성 지시 (HYK-162 사이클2, 관찰 전용 -- 이 문서 하나로 자족).",
    "당신은 다음 세 가지만 정확히 수행하고, 그 외 어떤 행동도 하지 않는다:",
    "1. 이 작업 디렉토리의 `spike-live-result.md` 파일에 정확히 한 줄을 기록한다:",
    "   `>>> DONE: spike @ <실제 완료 시각, YYYY-MM-DD HH:MM KST>`",
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

// ---- ② 실 orca execFn 어댑터 ----
// check --wait --json의 실제 응답 형태(관찰, dry-run): { ok, result: { messages: [...],
// count } } -- 러너의 classifyCheckOutcome은 {outcome} 어휘(worker_done/escalation/timeout)를
// 기대하므로 여기서만 변환한다. task-create/dispatch는 원형(parsed JSON) 그대로 반환 --
// 러너의 parseRuntimeTaskId가 `result.task.id`를 직접 읽는다.
//
// honesty: message.type 위치는 dry-run 관찰(`--type worker_done`으로 전송하므로 응답도
// 대칭적으로 `message.type`일 것이라는 추정)일 뿐, 실제 라이브 1회 실행에서 확정되지
// 않았다. 라이브 최초 실행 후 이 가정이 틀렸다면 이 함수만 국소 수리하면 된다(러너·
// predispatch는 무관).
export function mapCheckResponse(parsed) {
  if (!isPlainObject(parsed) || parsed.ok !== true) {
    return {
      ok: false,
      reason: `orca-spike-live: check response not ok -- ${JSON.stringify(parsed)}`,
    };
  }
  const messages = Array.isArray(parsed.result?.messages)
    ? parsed.result.messages
    : [];
  let outcome = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const type = isPlainObject(m) ? m.type : undefined;
    if (type === "worker_done") {
      outcome = "worker_done";
      break;
    }
    if (type === "escalation") {
      outcome = "escalation";
      break;
    }
  }
  if (!outcome) outcome = "timeout"; // 없음(빈 messages)·미인식 타입 전부 timeout으로 수렴
  return { ok: true, outcome, raw: parsed };
}

// raw spawnSync 결과를 안전 필드로 정규화(claude-adapter.mjs의 raw.error 판별 전례
// 동형 -- error가 있고 signal·status가 둘 다 null이면 프로세스가 아예 못 뜬 것).
function normalizeSpawnResult(raw) {
  const isObj = isPlainObject(raw);
  return {
    stdout: isObj && typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: isObj && typeof raw.stderr === "string" ? raw.stderr : "",
    status: isObj && typeof raw.status === "number" ? raw.status : null,
    spawnError:
      isObj && raw.error != null && raw.signal == null && raw.status == null
        ? errText(raw.error)
        : null,
  };
}

// stdout을 JSON으로 파싱(spawnError가 이미 있으면 시도조차 하지 않음 -- 프로세스가
// 못 뜬 경우 stdout은 애초에 의미 없는 빈 문자열이다).
function parseStdoutJson(stdout, spawnError) {
  if (spawnError) return { parsed: null, parseError: null };
  try {
    return { parsed: JSON.parse(stdout), parseError: null };
  } catch (err) {
    return { parsed: null, parseError: errText(err) };
  }
}

// spawnSyncFn 주입(claude-adapter.mjs 전례와 동형 -- shell:false, encoding:utf8, 명시 인자만).
// dumps: task-create/dispatch/check 각 단계의 실제 stdout/stderr/parsed 원형을 **매핑
// 성공 여부와 무관하게 항상** 기록한다(G-b 관찰 정본).
export function createLiveExecFn({ spawnSyncFn = spawnSync } = {}) {
  const dumps = [];
  function execFn(argv) {
    const cmd = Array.isArray(argv) ? argv[1] : undefined;
    const raw = spawnSyncFn("orca", argv, { shell: false, encoding: "utf8" });
    const { stdout, stderr, status, spawnError } = normalizeSpawnResult(raw);
    const { parsed, parseError } = parseStdoutJson(stdout, spawnError);

    dumps.push({
      argv,
      cmd,
      status,
      stdout,
      stderr,
      spawnError,
      parsed,
      parseError,
    });

    if (spawnError) {
      return {
        ok: false,
        reason: `orca-spike-live: orca process never started -- ${spawnError}`,
      };
    }
    if (parseError) {
      return {
        ok: false,
        reason: `orca-spike-live: orca stdout is not valid JSON -- ${parseError}`,
      };
    }
    return cmd === "check" ? mapCheckResponse(parsed) : parsed;
  }
  execFn.dumps = dumps;
  return execFn;
}

// ---- ③ 원형 응답 덤프 저장(사람 판독용) ----
export function writeRawDump(path, dumps) {
  writeFileSync(path, JSON.stringify(dumps, null, 2), "utf8");
}

// ---- CLI (실 orca 호출은 여기뿐 -- --live 플래그 없으면 아무 것도 안 함) ----
// 오발사 방지: invokedDirectly가 참이어도 shouldRunLive(argv)가 거짓이면 즉시 종료.
export function shouldRunLive(argv) {
  return Array.isArray(argv) && argv.includes("--live");
}

function flagValue(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
}

// 이번 사이클엔 절대 호출되지 않는다(테스트는 이 함수를 부르지 않고, CLI 진입은
// invokedDirectly && --live 둘 다 참이어야 도달 -- 이 실행에선 --live를 주지 않았다).
// review-7 승인 후 별도 발사 런북에서 `--live`와 함께 실행될 때만 실 orca를 부른다.
export function runLive(argv) {
  const nowIso = new Date().toISOString();
  const fixture = buildSyntheticFixture({
    human_approval_ref: flagValue(argv, "--human-approval-ref"),
    arm_id: flagValue(argv, "--arm-id"),
    cycle_id: flagValue(argv, "--cycle-id"),
    issued_at: nowIso,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    target: flagValue(argv, "--target"),
    role: "CODER",
  });
  if (!fixture.ok) {
    console.error(fixture.reason);
    return 1;
  }

  const execFn = createLiveExecFn();
  const result = runSpikeAttempt(
    {
      predispatch: fixture.predispatch,
      task_id: fixture.task_id,
      terminalHandle: flagValue(argv, "--target"),
      coordinatorHandle: flagValue(argv, "--coordinator"),
      timeoutMs: Number(flagValue(argv, "--timeout-ms") ?? "60000"),
      handshake: { role: "spike-live", harnessDir: fixture.harnessDir },
    },
    { execFn, nowFn: () => new Date().toISOString() },
  );

  const outDir = flagValue(argv, "--output-dir") ?? fixture.dir;
  writeReceiptLedger(
    join(outDir, "spike-live-receipts.json"),
    result.receipts ?? [],
  );
  writeRawDump(join(outDir, "spike-live-raw-dump.json"), execFn.dumps);

  console.log(JSON.stringify({ ok: result.ok, reason: result.reason, outDir }));
  return result.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/relay/orca-spike-live.mjs");
if (invokedDirectly) {
  if (!shouldRunLive(process.argv)) {
    console.error(
      "orca-spike-live: --live 플래그 없이는 실행하지 않는다(오발사 방지). 실제 발사는 review-7(S7) 승인 + ORCH·사람 참관 하에서만, 이 사이클엔 호출되지 않는다.",
    );
    process.exit(1);
  }
  process.exit(runLive(process.argv));
}
