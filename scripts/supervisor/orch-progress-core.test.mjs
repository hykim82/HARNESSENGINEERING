// HYK-185 B (coder-task.md §7, §3) -- orch-progress-core.mjs 계약 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. §6 fixture 4건은 "그때 찍힌 계측 데이터"가 아니다 -- 관제실 기록
//    (PHASE-HANDOFF 델타)에 적힌 타임라인을 손으로 복원한 SYNTHETIC
//    값이다. 각 fixture 주석에 출처를 그대로 인용한다(coder-task.md §6
//    비타협).
// 2. 이 스위트가 100% 통과해도 "진입점이 실제로 이 형태의 관측을
//    모은다"를 증명하지 않는다 -- 그건 orch-stall-detect.test.mjs의
//    몫이다.
// 3. 표본 수와 조건 -- 각 test 이름/설명에 분모를 명시한다.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import child_process from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeOrchProgress,
  ORCH_PROGRESS_VERDICT,
  ORCH_PROGRESS_REASON,
  ARTIFACT_KIND,
  PLEDGE_RESOLUTION_STATUS,
  DEFAULT_THRESHOLD_SECONDS,
} from "./orch-progress-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();

function pledge(overrides = {}) {
  return {
    pledgeId: "p1",
    content: "다음에 X를 한다.",
    expectedArtifact: { kind: ARTIFACT_KIND.FILE_EXISTS_AFTER, path: "x.md" },
    recordedAt: "2026-08-01T10:00:00+09:00",
    resolution: { status: PLEDGE_RESOLUTION_STATUS.OPEN },
    ...overrides,
  };
}

const RECORDED_MS = Date.parse("2026-08-01T10:00:00+09:00");

// ---------------------------------------------------------------------------
// (a) 순수 함수 + I/O 0 -- 주입된 감시자(spy)로 실제 호출 횟수가 0임을
// 단언한다("안 했다"는 서술이 아니라 호출되지 않았음의 단언, budget-
// core.test.mjs 선례 재사용). Date.now()/새 Date()도 감시한다(현재
// 시각을 인자로만 받는다는 비타협의 직접 증거).
// ---------------------------------------------------------------------------
test("side effects: fs write/read-family functions are never invoked while judging a batch of 4 pledges", () => {
  const watched = [
    "readFile",
    "readFileSync",
    "writeFile",
    "writeFileSync",
    "existsSync",
    "statSync",
    "mkdirSync",
    "rmSync",
  ];
  const mocks = watched
    .filter((n) => typeof fs[n] === "function")
    .map((n) =>
      mock.method(fs, n, () => {
        throw new Error(`unexpected fs.${n} call from judgeOrchProgress`);
      }),
    );
  try {
    judgeOrchProgress({
      pledges: [pledge(), pledge({ pledgeId: "p2" })],
      observation: {},
      now: RECORDED_MS + 1000,
    });
    for (const m of mocks) assert.equal(m.mock.calls.length, 0);
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});

test("side effects: child_process spawn-family functions are never invoked (covers 'orca' CLI calls too)", () => {
  const watched = [
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
  ];
  const mocks = watched
    .filter((n) => typeof child_process[n] === "function")
    .map((n) =>
      mock.method(child_process, n, () => {
        throw new Error(`unexpected child_process.${n} call`);
      }),
    );
  try {
    judgeOrchProgress({
      pledges: [pledge()],
      observation: {},
      now: RECORDED_MS + 1000,
    });
    for (const m of mocks) assert.equal(m.mock.calls.length, 0);
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});

test("side effects: global fetch (network) is never invoked", () => {
  const hasFetch = typeof globalThis.fetch === "function";
  const fetchMock = hasFetch
    ? mock.method(globalThis, "fetch", () => {
        throw new Error("unexpected fetch call");
      })
    : null;
  try {
    judgeOrchProgress({
      pledges: [pledge()],
      observation: {},
      now: RECORDED_MS + 1000,
    });
    if (fetchMock) assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    if (fetchMock) fetchMock.mock.restore();
  }
});

test("side effects: Date.now is never called -- current time is only ever taken from the injected `now` argument", () => {
  const dateNowMock = mock.method(Date, "now", () => {
    throw new Error("unexpected Date.now() call from judgeOrchProgress");
  });
  try {
    judgeOrchProgress({
      pledges: [
        pledge({ resolution: { status: PLEDGE_RESOLUTION_STATUS.RESOLVED } }),
      ],
      observation: {},
      now: RECORDED_MS + 1000,
    });
    assert.equal(dateNowMock.mock.calls.length, 0);
  } finally {
    dateNowMock.mock.restore();
  }
});

const SRC_TEXT = fs.readFileSync(
  join(ROOT, "scripts", "supervisor", "orch-progress-core.mjs"),
  "utf8",
);
test("static: orch-progress-core.mjs has zero imports (structurally no I/O surface)", () => {
  assert.equal(/^import /m.test(SRC_TEXT), false);
});

// ---------------------------------------------------------------------------
// (b) 4상태만 + 사람 게이트 ↔ STALLED 양방향 반례(§3-b 비타협 그대로).
// ---------------------------------------------------------------------------
test("(b) bidirectional counter-example: overdue pledge WITHOUT a registered gate reason -> STALLED, not WAITING_HUMAN_GATE", () => {
  const now = RECORDED_MS + (DEFAULT_THRESHOLD_SECONDS + 60) * 1000;
  const result = judgeOrchProgress({
    pledges: [pledge()],
    observation: { p1: { collected: true, exists: false, mtimeMs: null } },
    now,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
});

test("(b) bidirectional counter-example: overdue pledge WITH a registered human-gate reason -> WAITING_HUMAN_GATE, not STALLED", () => {
  const now = RECORDED_MS + (DEFAULT_THRESHOLD_SECONDS + 60) * 1000;
  const result = judgeOrchProgress({
    pledges: [
      pledge({
        resolution: {
          status: PLEDGE_RESOLUTION_STATUS.HUMAN_GATE,
          reason: "PR 승인 대기 -- 사람 게이트 1",
        },
      }),
    ],
    observation: { p1: { collected: true, exists: false, mtimeMs: null } },
    now,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE);
  assert.equal(result.reasonCode, ORCH_PROGRESS_REASON.HUMAN_GATE_REGISTERED);
});

test("(b) verdict is always one of exactly 4 values across a matrix of 8 varied inputs (no third value)", () => {
  const inputs = [
    { pledges: [], observation: {}, now: RECORDED_MS },
    { pledges: [pledge()], observation: {}, now: RECORDED_MS },
    { pledges: "not-array", observation: {}, now: RECORDED_MS },
    { pledges: [pledge()], observation: "not-object", now: RECORDED_MS },
    { pledges: [pledge()], observation: {}, now: "not-a-number" },
    {
      pledges: [pledge()],
      observation: {},
      now: RECORDED_MS,
      thresholdSeconds: -1,
    },
    { pledges: [null], observation: {}, now: RECORDED_MS },
    "not-an-object",
  ];
  const allowed = new Set(Object.values(ORCH_PROGRESS_VERDICT));
  for (const input of inputs) {
    const result = judgeOrchProgress(input);
    assert.equal(allowed.has(result.verdict), true, JSON.stringify(input));
  }
});

// ---------------------------------------------------------------------------
// (c) 관측 결손·형식 위반은 UNDECIDABLE로 닫히고 PROGRESSING으로 새지
// 않는다(fail-closed).
// ---------------------------------------------------------------------------
test("(c) fail-closed: observation entry missing entirely for an OPEN pledge -> UNDECIDABLE, not PROGRESSING", () => {
  const result = judgeOrchProgress({
    pledges: [pledge()],
    observation: {},
    now: RECORDED_MS + 1000,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
  assert.equal(
    result.reasonCode,
    ORCH_PROGRESS_REASON.OBSERVATION_MISSING_FOR_PLEDGE,
  );
});

test("(c) fail-closed: observation entry malformed (missing required field) -> UNDECIDABLE, not PROGRESSING", () => {
  const result = judgeOrchProgress({
    pledges: [pledge()],
    observation: { p1: { collected: true } },
    now: RECORDED_MS + 1000,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
  assert.equal(
    result.reasonCode,
    ORCH_PROGRESS_REASON.OBSERVATION_MALFORMED_FOR_PLEDGE,
  );
});

test("(c) fail-closed: observation entry reports collected:false -> UNDECIDABLE, not PROGRESSING", () => {
  const result = judgeOrchProgress({
    pledges: [pledge()],
    observation: { p1: { collected: false } },
    now: RECORDED_MS + 1000,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
});

test("(c) fail-closed: malformed pledge (expectedArtifact missing) -> UNDECIDABLE (PLEDGE_INVALID), never thrown", () => {
  assert.doesNotThrow(() => {
    const result = judgeOrchProgress({
      pledges: [
        {
          pledgeId: "p1",
          content: "x",
          recordedAt: "2026-08-01T10:00:00+09:00",
          resolution: { status: "OPEN" },
        },
      ],
      observation: {},
      now: RECORDED_MS + 1000,
    });
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
    assert.equal(result.reasonCode, ORCH_PROGRESS_REASON.PLEDGE_INVALID);
  });
});

test("(c) fail-closed: HUMAN_GATE resolution without a non-empty reason is structurally invalid -> UNDECIDABLE (not WAITING_HUMAN_GATE)", () => {
  const result = judgeOrchProgress({
    pledges: [
      pledge({ resolution: { status: PLEDGE_RESOLUTION_STATUS.HUMAN_GATE } }),
    ],
    observation: {},
    now: RECORDED_MS + 1000,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
  assert.equal(result.reasonCode, ORCH_PROGRESS_REASON.PLEDGE_INVALID);
});

test("(c) fail-closed: args entirely malformed (not a plain object) -> ok:false, verdict UNDECIDABLE, never thrown", () => {
  assert.doesNotThrow(() => {
    const result = judgeOrchProgress("not-an-object");
    assert.equal(result.ok, false);
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
  });
  assert.doesNotThrow(() => {
    const result = judgeOrchProgress();
    assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.UNDECIDABLE);
  });
});

// ---------------------------------------------------------------------------
// (e) 약속 미기록 -> 조용히 검사 밖(PROGRESSING/NO_PLEDGES_RECORDED). 이건
// "진행 중이 관측됐다"가 아니라 "검사할 약속이 없다"는 뜻이며, 그 한계를
// 감추지 않는다(coder-task.md §5-D 헤더 2번째 문단, HYK-185 정직 한계 1).
// ---------------------------------------------------------------------------
test("(e) unrecorded pledges are silently out of scope: empty pledges array -> PROGRESSING/NO_PLEDGES_RECORDED (documents the limit, does not claim real progress)", () => {
  const result = judgeOrchProgress({
    pledges: [],
    observation: {},
    now: RECORDED_MS,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.PROGRESSING);
  assert.equal(result.reasonCode, ORCH_PROGRESS_REASON.NO_PLEDGES_RECORDED);
});

// ---------------------------------------------------------------------------
// (f) 정상 케이스 오탐 0(분모 3) -- 진행 중(임계 이내) · 산출물 이미 관측
// · 사유 등록된 사람 게이트 대기(경과 무관) 전부 STALLED가 아니어야 한다.
// ---------------------------------------------------------------------------
test("(f) false-positive count is 0 across 3 independently-varied legitimate-non-stall fixtures (denominator=3)", () => {
  const fixtures = [
    {
      label: "fresh pledge within threshold, artifact not yet observed",
      pledges: [pledge({ pledgeId: "fp1" })],
      observation: { fp1: { collected: true, exists: false, mtimeMs: null } },
      now: RECORDED_MS + 30_000,
    },
    {
      label: "artifact already observed after recordedAt",
      pledges: [pledge({ pledgeId: "fp2" })],
      observation: {
        fp2: { collected: true, exists: true, mtimeMs: RECORDED_MS + 5_000 },
      },
      now: RECORDED_MS + (DEFAULT_THRESHOLD_SECONDS + 999) * 1000,
    },
    {
      label: "human gate with reason, wildly overdue",
      pledges: [
        pledge({
          pledgeId: "fp3",
          resolution: {
            status: PLEDGE_RESOLUTION_STATUS.HUMAN_GATE,
            reason: "PR 승인 대기",
          },
        }),
      ],
      observation: { fp3: { collected: true, exists: false, mtimeMs: null } },
      now: RECORDED_MS + 999 * DEFAULT_THRESHOLD_SECONDS * 1000,
    },
  ];
  let falsePositives = 0;
  for (const f of fixtures) {
    const result = judgeOrchProgress(f);
    if (result.verdict === ORCH_PROGRESS_VERDICT.STALLED) falsePositives++;
  }
  assert.equal(falsePositives, 0, "denominator=3");
});

// ---------------------------------------------------------------------------
// §6 실제 정지 4건 -- 관제실 기록 타임라인 복원(계측 데이터 아님, 위 파일
// 헤더 주석 참조). 각 fixture는 서로 다른 ARTIFACT_KIND 경로로 STALLED에
// 도달한다(coder-task.md §6 "요구").
// ---------------------------------------------------------------------------

// 1) 10시간 48분 -- 출처: PHASE 델타-AD ④(2026-08-01).
// > "23:04 REVIEW에 표지 정정을 배달하며 감시기·폴러를 걸지 않았다. REVIEW는
// > 23:06:44에 2분 만에 완료했고 ORCH는 09:56 통역 통지로 알았다 ...
// > 실제 정지는 10시간 48분(좌석 lastOutputAt 35,262s/38,984s 실측으로
// > ORCH가 정정)."
// 형태 = 워커는 끝났는데 ORCH가 결과를 소비하지 않음(기대 산출물 = 소비
// 후 다음 드롭·커밋 등) -> ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER, 다음
// 태스크 파일이 끝내 드롭되지 않은 것으로 재현.
test("(d) real stall #1 (10h48m, PHASE delta-AD④ 2026-08-01, reconstructed timeline not raw telemetry): TASK_FILE_DROPPED_AFTER never observed -> STALLED/STALLED_RESULT_NOT_CONSUMED", () => {
  const recordedAt = "2026-08-01T23:06:44+09:00";
  const now = Date.parse(recordedAt) + (10 * 3600 + 48 * 60) * 1000; // 10h48m
  const result = judgeOrchProgress({
    pledges: [
      pledge({
        pledgeId: "stall-1",
        content: "REVIEW 결과를 소비하고 다음 태스크를 드롭한다.",
        expectedArtifact: {
          kind: ARTIFACT_KIND.TASK_FILE_DROPPED_AFTER,
          path: ".harness/coder-task.md",
        },
        recordedAt,
      }),
    ],
    observation: {
      "stall-1": { collected: true, taskFileExists: false, droppedAtMs: null },
    },
    now,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
  assert.equal(
    result.reasonCode,
    ORCH_PROGRESS_REASON.STALLED_RESULT_NOT_CONSUMED,
  );
});

// 2) 8시간 35분 -- 출처: PHASE 델타-AE ④(2026-08-01).
// > "11:18~19:54 -- '이제 2번→3번 순으로 갑니다'라고 적고 아무것도 시작하지
// > 않은 채 턴 종료. 배달을 안 했으니 감시기도 없었다."
// 형태 = 선언만 있고 산출물 0(배달·파일 변경 어느 것도 없음) ->
// ARTIFACT_KIND.FILE_EXISTS_AFTER, 파일이 끝내 생기지 않은 것으로 재현.
test("(d) real stall #2 (8h35m, PHASE delta-AE④ 2026-08-01, reconstructed timeline not raw telemetry): FILE_EXISTS_AFTER never observed -> STALLED/STALLED_ARTIFACT_NEVER_APPEARED", () => {
  const recordedAt = "2026-08-01T11:18:00+09:00";
  const now = Date.parse(recordedAt) + (8 * 3600 + 35 * 60) * 1000; // 8h35m
  const result = judgeOrchProgress({
    pledges: [
      pledge({
        pledgeId: "stall-2",
        content: "이제 2번→3번 순으로 간다(배달 파일 작성).",
        expectedArtifact: {
          kind: ARTIFACT_KIND.FILE_EXISTS_AFTER,
          path: ".harness/coder-task.md",
        },
        recordedAt,
      }),
    ],
    observation: {
      "stall-2": { collected: true, exists: false, mtimeMs: null },
    },
    now,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
  assert.equal(
    result.reasonCode,
    ORCH_PROGRESS_REASON.STALLED_ARTIFACT_NEVER_APPEARED,
  );
});

// 3) 83분 -- 출처: PHASE 델타-AH ⑥(2026-08-02).
// > "`dispatch --inject`가 `injected:true`를 반환해도 워커가 시작되지
// > 않는다 ... 1회차 = REVIEW 83분 무진행(발견은 통역·한용의 눈 ·
// > `watch-result`는 결과 파일만 봐서 구조적으로 못 잡음)." 배달 11:56:32
// > · 좌석 마지막 출력 11:56:33.
// 형태 = 배달은 했으나 결과 산출물이 오지 않음 -> ARTIFACT_KIND.
// RESULT_FILE_APPEARS_AFTER, 결과 파일이 끝내 생기지 않은 것으로 재현.
// ⚠️주의(coder-task.md §6 그대로): 근본 원인은 워커 쪽이지만 이 감지기는
// "누가 멈췄는가"를 판정하지 않는다 -- "약속한 산출물이 기한 안에 오지
// 않았다"만 본다.
test("(d) real stall #3 (83min, PHASE delta-AH⑥ 2026-08-02, reconstructed timeline not raw telemetry): RESULT_FILE_APPEARS_AFTER never observed -> STALLED/STALLED_RESULT_FILE_MISSING", () => {
  const recordedAt = "2026-08-02T11:56:32+09:00";
  const now = Date.parse(recordedAt) + 83 * 60 * 1000; // 83분
  const result = judgeOrchProgress({
    pledges: [
      pledge({
        pledgeId: "stall-3",
        content: "REVIEW 워커의 결과 파일이 온다.",
        expectedArtifact: {
          kind: ARTIFACT_KIND.RESULT_FILE_APPEARS_AFTER,
          path: ".harness/review.md",
        },
        recordedAt,
      }),
    ],
    observation: {
      "stall-3": { collected: true, exists: false, mtimeMs: null },
    },
    now,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
  assert.equal(
    result.reasonCode,
    ORCH_PROGRESS_REASON.STALLED_RESULT_FILE_MISSING,
  );
});

// 4) 18분 -- 출처: PHASE 델타-AK ⑦(2026-08-03·오늘).
// > "'이제 발행하겠습니다' 후 턴 종료. 기다리던 게이트 없음 ... 감시기
// > 2쌍은 워커를 보고 있었고 둘 다 정상 종료 상태였다. 발견은 통역의 눈
// > (축 = 좌석 마지막 출력 고정 + 커밋이 원격에 없음)." 커밋 15:37 ·
// > 확인 16:05.
// 형태 = 로컬 산출물은 있으나 약속한 다음 산출물(원격 push·PR)이 없음
// -> ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT, 원격 ref가 그 커밋을
// 포함하지 않는 것으로 재현. ⚠️기록에 "약속을 기록한 정확한 시각"이
// 없다 -- 가장 가까운 문서화된 앵커(커밋 시각 15:37)를 recordedAt으로
// 쓰고, 제목의 18분 간격만 보존한다(기록에 없는 값을 지어내지 않는다,
// coder-task.md §6).
test("(d) real stall #4 (18min, PHASE delta-AK⑦ 2026-08-03, reconstructed timeline not raw telemetry; exact pledge timestamp absent from the record -- nearest documented anchor (commit time) used, 18-minute gap from the title preserved): REMOTE_REF_CONTAINS_COMMIT observed false -> STALLED/STALLED_REMOTE_ARTIFACT_MISSING", () => {
  const recordedAt = "2026-08-03T15:37:00+09:00";
  const now = Date.parse(recordedAt) + 18 * 60 * 1000; // 18분
  const result = judgeOrchProgress({
    pledges: [
      pledge({
        pledgeId: "stall-4",
        content: "이제 발행하겠습니다(원격 push).",
        expectedArtifact: {
          kind: ARTIFACT_KIND.REMOTE_REF_CONTAINS_COMMIT,
          remoteRef: "origin/master",
          commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        },
        recordedAt,
      }),
    ],
    observation: {
      "stall-4": { collected: true, contains: false },
    },
    now,
  });
  assert.equal(result.verdict, ORCH_PROGRESS_VERDICT.STALLED);
  assert.equal(
    result.reasonCode,
    ORCH_PROGRESS_REASON.STALLED_REMOTE_ARTIFACT_MISSING,
  );
});

// ---------------------------------------------------------------------------
// §3(g) 판별력 자동화 -- copy-and-mutate 층(task-drop-core.test.mjs 선례
// 재사용). 추적본(git show HEAD:)에서 소스를 읽어 mkdtemp에 변조 사본을
// 쓰고 동적 import()로 불러온다. 신규 파일이라 아직 HEAD에 없으면 명시적
// 사유로 skip한다(커밋 후 자동 실행 -- no-op 아님).
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/orch-progress-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "orch-progress-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본(이 시험이 `git show HEAD:`로 읽는 스냅샷)에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨).";

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(join(tmpdir(), "nc-orch-progress-core-mutant-"));
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "orch-progress-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/orch-progress-core #1 (필수): 사람 게이트 구별 제거 -> RED (사유 등록된 overdue 게이트가 STALLED로 오탐)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (pledge.resolution.status === PLEDGE_RESOLUTION_STATUS.HUMAN_GATE) {\n    return pledgeResult(\n      pledge.pledgeId,\n      ORCH_PROGRESS_VERDICT.WAITING_HUMAN_GATE,\n      ORCH_PROGRESS_REASON.HUMAN_GATE_REGISTERED,\n    );\n  }\n",
        "",
      ),
    );
    const now = RECORDED_MS + (DEFAULT_THRESHOLD_SECONDS + 60) * 1000;
    const result = mutant.judgeOrchProgress({
      pledges: [
        {
          pledgeId: "g1",
          content: "게이트",
          expectedArtifact: {
            kind: mutant.ARTIFACT_KIND.FILE_EXISTS_AFTER,
            path: "x.md",
          },
          recordedAt: "2026-08-01T10:00:00+09:00",
          resolution: {
            status: mutant.PLEDGE_RESOLUTION_STATUS.HUMAN_GATE,
            reason: "승인 대기",
          },
        },
      ],
      observation: { g1: { collected: true, exists: false, mtimeMs: null } },
      now,
    });
    assert.equal(
      result.verdict,
      mutant.ORCH_PROGRESS_VERDICT.STALLED,
      "mutant must misjudge a legitimately-gated overdue pledge as STALLED (RED signal; proves the human-gate distinction is load-bearing)",
    );
  },
);

test(
  "NC mutation/orch-progress-core #2 (필수): 경과 임계 검사 제거 -> RED (방금 한 약속도 즉시 STALLED)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (now - recordedAtMs <= thresholdMs) {\n    return pledgeResult(\n      pledge.pledgeId,\n      ORCH_PROGRESS_VERDICT.PROGRESSING,\n      ORCH_PROGRESS_REASON.WITHIN_THRESHOLD,\n    );\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeOrchProgress({
      pledges: [
        {
          pledgeId: "fresh",
          content: "방금 한 약속",
          expectedArtifact: {
            kind: mutant.ARTIFACT_KIND.FILE_EXISTS_AFTER,
            path: "x.md",
          },
          recordedAt: "2026-08-01T10:00:00+09:00",
          resolution: { status: mutant.PLEDGE_RESOLUTION_STATUS.OPEN },
        },
      ],
      observation: { fresh: { collected: true, exists: false, mtimeMs: null } },
      now: RECORDED_MS, // elapsed === 0
    });
    assert.equal(
      result.verdict,
      mutant.ORCH_PROGRESS_VERDICT.STALLED,
      "mutant must flag a just-made pledge (elapsed=0) as STALLED (RED signal; proves the elapsed-threshold guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/orch-progress-core #3 (필수): 관측 결손 fail-closed 제거 -> RED (결손이 PROGRESSING으로 샘)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (!isValidObservationEntry(kind, entry)) {\n    return pledgeResult(\n      pledge.pledgeId,\n      ORCH_PROGRESS_VERDICT.UNDECIDABLE,\n      ORCH_PROGRESS_REASON.OBSERVATION_MALFORMED_FOR_PLEDGE,\n    );\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeOrchProgress({
      pledges: [
        {
          pledgeId: "malformed-obs",
          content: "결손 관측",
          expectedArtifact: {
            kind: mutant.ARTIFACT_KIND.FILE_EXISTS_AFTER,
            path: "x.md",
          },
          recordedAt: "2026-08-01T10:00:00+09:00",
          resolution: { status: mutant.PLEDGE_RESOLUTION_STATUS.OPEN },
        },
      ],
      observation: { "malformed-obs": { collected: false } },
      now: RECORDED_MS + 1000, // still within threshold
    });
    assert.equal(
      result.verdict,
      mutant.ORCH_PROGRESS_VERDICT.PROGRESSING,
      "mutant must let a collection failure leak into PROGRESSING (RED signal; proves the observation fail-closed guard is load-bearing)",
    );
  },
);

test(
  "NC mutation/orch-progress-core #4 (필수): 기대 산출물 확인 제거 -> RED (이미 관측된 산출물이 STALLED로 오탐)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (artifactAppeared(kind, entry, recordedAtMs)) {\n    return pledgeResult(\n      pledge.pledgeId,\n      ORCH_PROGRESS_VERDICT.PROGRESSING,\n      ORCH_PROGRESS_REASON.ARTIFACT_OBSERVED,\n    );\n  }\n",
        "",
      ),
    );
    const now = RECORDED_MS + (DEFAULT_THRESHOLD_SECONDS + 60) * 1000; // overdue
    const result = mutant.judgeOrchProgress({
      pledges: [
        {
          pledgeId: "appeared",
          content: "산출물이 이미 나왔다",
          expectedArtifact: {
            kind: mutant.ARTIFACT_KIND.FILE_EXISTS_AFTER,
            path: "x.md",
          },
          recordedAt: "2026-08-01T10:00:00+09:00",
          resolution: { status: mutant.PLEDGE_RESOLUTION_STATUS.OPEN },
        },
      ],
      observation: {
        appeared: {
          collected: true,
          exists: true,
          mtimeMs: RECORDED_MS + 5000,
        },
      },
      now,
    });
    assert.equal(
      result.verdict,
      mutant.ORCH_PROGRESS_VERDICT.STALLED,
      "mutant must misjudge an already-delivered artifact as STALLED (RED signal; proves the artifact-appeared check is load-bearing)",
    );
  },
);
