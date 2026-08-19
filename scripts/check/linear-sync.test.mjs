import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  parseStatusOpenIssues,
  parseStatusOpenIssuesDetailed,
  parseStatusSevenCandidates,
  checkSevenCandidateReferences,
  diffSync,
  loadLinearApiKey,
  normalizeStatusState,
  resolveSyncExitCode,
  resolveSyncVerdict,
  SYNC_VERDICT,
  SYNC_VERDICT_EXIT_CODE,
  buildDriftEntries,
  computeDriftTransition,
  parseDriftReportPathArg,
  resolveDriftReportPath,
  readPreviousDriftKeys,
  writeDriftReport,
  reportDriftDetails,
  clearDriftReportForInSync,
} from "./linear-sync.mjs";

const LINEAR_SYNC_SCRIPT = fileURLToPath(
  new URL("./linear-sync.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "linear-sync-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A trimmed but structurally real slice of this repo's own STATUS.md §6/§7,
// including the parenthetical Done-rollup line and a priority-annotated state
// (`*Todo, **High***`) that must not break state extraction.
const REAL_SHAPED_STATUS = `
## B. 진행 파악 (매번 덮어씀)

### 5) 활성 릴레이 슬롯
\`coder = HYK-93-coder-1 (go 대기)\`

### 6) 열린 이슈 (Linear)
- **HYK-85** 대표 CORE 플로우(제품/TEAM10) — *In Progress* (1단계 완결)
- **HYK-98** install.mjs gitignore 구블록 중복 append — *Todo* (위생/멱등성, Low)
- **HYK-93** STATUS↔Linear 정합성(SoT 기계화) — *Todo, **High*** (배치 1 마지막)
- (HYK-97·100·101·92·91·68 = Done 처리됨, §7 참고)

### 7) 직전 완료 (최근 3)
- **HYK-97** Scope A 게이트 갭 — merge \`c11003e\` PR #14 → **Done**
- **HYK-101** git 훅 worktree 이식성 — merge \`75784a0\` → **Done**
`;

test("(1) §6 parsing: extracts id+state from real-shaped fixture, excludes rollup line and §7", () => {
  const issues = parseStatusOpenIssues(REAL_SHAPED_STATUS);
  assert.deepEqual(issues, [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-98", state: "Todo" },
    { id: "HYK-93", state: "Todo" },
  ]);
  // §7's HYK-97/HYK-101 and the parenthetical rollup's ids must never appear.
  const ids = issues.map((i) => i.id);
  assert.ok(!ids.includes("HYK-97"));
  assert.ok(!ids.includes("HYK-101"));
});

test("(2) diffSync: staleInStatus fires when §6 lists an issue Linear already completed", () => {
  const statusIssues = [{ id: "HYK-97", state: "Todo" }];
  const linearIssues = [
    { id: "HYK-97", stateName: "Done", stateType: "completed" },
  ];
  const { staleInStatus, missingInStatus } = diffSync(
    statusIssues,
    linearIssues,
  );
  assert.equal(staleInStatus.length, 1);
  assert.equal(staleInStatus[0].id, "HYK-97");
  assert.equal(staleInStatus[0].linearState, "Done");
  assert.equal(missingInStatus.length, 0);
});

test("(2b) diffSync: canceled counts as stale too, not just completed", () => {
  const statusIssues = [{ id: "HYK-68", state: "In Progress" }];
  const linearIssues = [
    { id: "HYK-68", stateName: "Canceled", stateType: "canceled" },
  ];
  const { staleInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(staleInStatus.length, 1);
  assert.equal(staleInStatus[0].id, "HYK-68");
});

test("(3) diffSync: missingInStatus fires when Linear has an open issue absent from §6", () => {
  const statusIssues = [{ id: "HYK-93", state: "Todo" }];
  const linearIssues = [
    { id: "HYK-93", stateName: "Todo", stateType: "unstarted" },
    { id: "HYK-102", stateName: "Todo", stateType: "unstarted" },
  ];
  const { staleInStatus, missingInStatus } = diffSync(
    statusIssues,
    linearIssues,
  );
  assert.equal(staleInStatus.length, 0);
  assert.equal(missingInStatus.length, 1);
  assert.equal(missingInStatus[0].id, "HYK-102");
});

test("(4) diffSync: matched state, no drift on either side", () => {
  const statusIssues = [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-93", state: "Todo" },
  ];
  const linearIssues = [
    { id: "HYK-85", stateName: "In Progress", stateType: "started" },
    { id: "HYK-93", stateName: "Todo", stateType: "unstarted" },
    { id: "HYK-97", stateName: "Done", stateType: "completed" }, // done, absent from §6 -- fine, not open
  ];
  const { staleInStatus, missingInStatus } = diffSync(
    statusIssues,
    linearIssues,
  );
  assert.equal(staleInStatus.length, 0);
  assert.equal(missingInStatus.length, 0);
});

test("(5) loadLinearApiKey: no env var, no .env.local -> fail-open null, no value ever surfaced", () => {
  withFixtureDir((dir) => {
    const result = loadLinearApiKey(dir, {});
    assert.equal(result, null);
  });
});

test("(5b) loadLinearApiKey: env var present -> returns it with source 'env'", () => {
  withFixtureDir((dir) => {
    const result = loadLinearApiKey(dir, { LINEAR_API_KEY: "dummy-key-alpha" });
    assert.deepEqual(result, { key: "dummy-key-alpha", source: "env" });
  });
});

test("(5c) loadLinearApiKey: no env var, key present in .env.local -> read from file", () => {
  withFixtureDir((dir) => {
    writeFileSync(
      join(dir, ".env.local"),
      "OTHER_KEY=x\nLINEAR_API_KEY=dummy-key-from-file\n",
      "utf8",
    );
    const result = loadLinearApiKey(dir, {});
    assert.deepEqual(result, {
      key: "dummy-key-from-file",
      source: ".env.local",
    });
  });
});

test("(5d) loadLinearApiKey: .env.local exists but has no LINEAR_API_KEY line -> fail-open null", () => {
  withFixtureDir((dir) => {
    writeFileSync(join(dir, ".env.local"), "OTHER_KEY=x\n", "utf8");
    const result = loadLinearApiKey(dir, {});
    assert.equal(result, null);
  });
});

test("(6) normalizeStatusState: known names normalize case-insensitively", () => {
  assert.equal(normalizeStatusState("Todo"), "Todo");
  assert.equal(normalizeStatusState("in review"), "In Review");
  assert.equal(normalizeStatusState("IN PROGRESS"), "In Progress");
});

test("(6b) normalizeStatusState: trailing annotation on §6 text still normalizes (prefix match)", () => {
  assert.equal(normalizeStatusState("Todo(루프 상설)"), "Todo");
});

test("(6c) normalizeStatusState: In Progress and In Review don't collide (diverge right after 'In ')", () => {
  assert.equal(normalizeStatusState("In Progress"), "In Progress");
  assert.equal(normalizeStatusState("In Review"), "In Review");
});

test("(6d) normalizeStatusState: unrecognized text -> null (judged unable, never guessed)", () => {
  assert.equal(normalizeStatusState("Blocked"), null);
  assert.equal(normalizeStatusState(""), null);
});

test("(7) diffSync: stateDrift fires when §6=Todo but Linear=In Progress (both open)", () => {
  const statusIssues = [{ id: "HYK-93", state: "Todo" }];
  const linearIssues = [
    { id: "HYK-93", stateName: "In Progress", stateType: "started" },
  ];
  const { stateDrift, staleInStatus, missingInStatus } = diffSync(
    statusIssues,
    linearIssues,
  );
  assert.equal(stateDrift.length, 1);
  assert.deepEqual(stateDrift[0], {
    id: "HYK-93",
    statusState: "Todo",
    linearState: "In Progress",
  });
  assert.equal(staleInStatus.length, 0);
  assert.equal(missingInStatus.length, 0);
});

test("(7b) diffSync: stateDrift fires when §6=In Progress but Linear=In Review (different type, same 'open')", () => {
  const statusIssues = [{ id: "HYK-128", state: "In Progress" }];
  const linearIssues = [
    { id: "HYK-128", stateName: "In Review", stateType: "backlog" },
  ];
  const { stateDrift } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 1);
  assert.deepEqual(stateDrift[0], {
    id: "HYK-128",
    statusState: "In Progress",
    linearState: "In Review",
  });
});

test("(7c) diffSync: matching open states on both sides -> no stateDrift", () => {
  const statusIssues = [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-93", state: "Todo" },
  ];
  const linearIssues = [
    { id: "HYK-85", stateName: "In Progress", stateType: "started" },
    { id: "HYK-93", stateName: "Todo", stateType: "unstarted" },
  ];
  const { stateDrift } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 0);
});

test("(7d) diffSync: unnormalizable §6 state never produces a false-positive stateDrift", () => {
  const statusIssues = [{ id: "HYK-99", state: "Blocked" }];
  const linearIssues = [
    { id: "HYK-99", stateName: "In Progress", stateType: "started" },
  ];
  const { stateDrift } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 0);
});

test("(7e) diffSync: closed Linear side (e.g. Done) never produces stateDrift, even if §6 text differs", () => {
  const statusIssues = [{ id: "HYK-97", state: "Todo" }];
  const linearIssues = [
    { id: "HYK-97", stateName: "Done", stateType: "completed" },
  ];
  const { stateDrift, staleInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(stateDrift.length, 0);
  assert.equal(staleInStatus.length, 1); // this pair is staleInStatus's job, not stateDrift's
});

test("(8) diffSync: Linear 'Duplicate' (type duplicate) counts as closed -- staleInStatus fires, not stateDrift", () => {
  const statusIssues = [{ id: "HYK-68", state: "In Progress" }];
  const linearIssues = [
    { id: "HYK-68", stateName: "Duplicate", stateType: "duplicate" },
  ];
  const { staleInStatus, stateDrift, missingInStatus } = diffSync(
    statusIssues,
    linearIssues,
  );
  assert.equal(staleInStatus.length, 1);
  assert.equal(staleInStatus[0].id, "HYK-68");
  assert.equal(staleInStatus[0].linearState, "Duplicate");
  assert.equal(stateDrift.length, 0);
  assert.equal(missingInStatus.length, 0);
});

test("(8b) diffSync: Linear 'Duplicate' open issue absent from §6 counts as closed -- no missingInStatus", () => {
  const statusIssues = [];
  const linearIssues = [
    { id: "HYK-68", stateName: "Duplicate", stateType: "duplicate" },
  ];
  const { missingInStatus } = diffSync(statusIssues, linearIssues);
  assert.equal(missingInStatus.length, 0);
});

// --- HYK-131: advisory exit-code normalization (G4) ---
// This check's CLI never exits 2, even on a confirmed drift -- exit 2 is
// reserved for the ORCH-only blocking checks (clear-safe-check.mjs,
// controlroom-fresh.mjs). The fail-open paths (missing key/STATUS
// file/network error) are untouched by this function -- they exit 0 directly
// in main() before diffSync is ever called.

test("(9) resolveSyncExitCode: no drift of any kind -> 0", () => {
  assert.equal(
    resolveSyncExitCode({
      staleInStatus: [],
      missingInStatus: [],
      stateDrift: [],
    }),
    0,
  );
});

test("(9b) resolveSyncExitCode: staleInStatus present -> 1, never 2", () => {
  assert.equal(
    resolveSyncExitCode({
      staleInStatus: [{ id: "HYK-97" }],
      missingInStatus: [],
      stateDrift: [],
    }),
    1,
  );
});

test("(9c) resolveSyncExitCode: missingInStatus present -> 1, never 2", () => {
  assert.equal(
    resolveSyncExitCode({
      staleInStatus: [],
      missingInStatus: [{ id: "HYK-102" }],
      stateDrift: [],
    }),
    1,
  );
});

test("(9d) resolveSyncExitCode: stateDrift present -> 1, never 2", () => {
  assert.equal(
    resolveSyncExitCode({
      staleInStatus: [],
      missingInStatus: [],
      stateDrift: [{ id: "HYK-93" }],
    }),
    1,
  );
});

test("(9e) resolveSyncExitCode: all three present at once -> still 1, not accumulated to a higher code", () => {
  assert.equal(
    resolveSyncExitCode({
      staleInStatus: [{ id: "HYK-97" }],
      missingInStatus: [{ id: "HYK-102" }],
      stateDrift: [{ id: "HYK-93" }],
    }),
    1,
  );
});

// --- HYK-235 §2-2: §6 format-deviation must never be a silent drop ---

test("(10) parseStatusOpenIssuesDetailed: real-shaped fixture -> headerFound true, skippedCount 0 (rollup line recognized, not a deviation)", () => {
  const r = parseStatusOpenIssuesDetailed(REAL_SHAPED_STATUS);
  assert.equal(r.headerFound, true);
  assert.equal(r.skippedCount, 0);
  assert.deepEqual(r.skippedSamples, []);
  assert.deepEqual(r.issues, [
    { id: "HYK-85", state: "In Progress" },
    { id: "HYK-98", state: "Todo" },
    { id: "HYK-93", state: "Todo" },
  ]);
});

test("(10b) parseStatusOpenIssuesDetailed: §6 heading never matched -> headerFound false, distinct from 'genuinely 0 open issues'", () => {
  const noHeading = `\n## Something else entirely\n\nno §6 here at all\n`;
  const r = parseStatusOpenIssuesDetailed(noHeading);
  assert.equal(r.headerFound, false);
  assert.deepEqual(r.issues, []);
});

test("(10c) parseStatusOpenIssuesDetailed: genuinely empty §6 (header found, no bullets) -> headerFound true, issues [], distinguishable from (10b)", () => {
  const emptySix = `\n### 6) 열린 이슈 (Linear)\n<!-- nothing open right now -->\n\n### 7) 다음\n`;
  const r = parseStatusOpenIssuesDetailed(emptySix);
  assert.equal(r.headerFound, true);
  assert.deepEqual(r.issues, []);
  assert.equal(r.skippedCount, 0);
});

// RED->GREEN fixture (contract §2-4 ⓐ): a line inside §6 that is a bullet
// but does not match the `- **HYK-N** ... — *State*` shape -- e.g. a
// hand-typed note without the bold id, or a bullet using the wrong dash
// character -- must be counted and surfaced, never silently dropped.
const SIX_WITH_FORMAT_DEVIATION = `
### 6) 열린 이슈 (Linear)
- **HYK-85** 대표 CORE 플로우 — *In Progress* (정상 행)
- HYK-90 잘못 적음(볼드 없음) - 이건 기존 정규식과 안 맞는다
- **HYK-93** STATUS↔Linear 정합성 — *Todo* (정상 행)
- (HYK-97·100 = Done 처리됨, §7 참고)

### 7) 다음
`;

test("(10d) parseStatusOpenIssuesDetailed: a malformed §6 bullet is counted in skippedCount and its text surfaces in skippedSamples -- never silently dropped", () => {
  const r = parseStatusOpenIssuesDetailed(SIX_WITH_FORMAT_DEVIATION);
  assert.equal(r.issues.length, 2);
  assert.deepEqual(
    r.issues.map((i) => i.id),
    ["HYK-85", "HYK-93"],
  );
  assert.equal(r.skippedCount, 1);
  assert.equal(r.skippedSamples.length, 1);
  assert.ok(
    r.skippedSamples[0].includes("HYK-90"),
    "skipped sample must be identifiable, not just a bare count",
  );
  // the parenthetical rollup line is a recognized §6 convention, not a deviation
  assert.ok(!r.skippedSamples.some((s) => s.includes("HYK-97")));
});

// O탐 분모 (contract): at least 5 of the *current* real STATUS.md §6 rows,
// copied verbatim at the moment this task ran (2026-08-11, ORCH-managed
// STATUS.md), must all parse cleanly with 0 false-positive skips. This is a
// frozen snapshot (STATUS.md is a live file another parallel track edits),
// not a live read -- it exists to prove the parser handles real production
// shapes, not just the hand-built REAL_SHAPED_STATUS fixture above.
const REAL_STATUS_SIX_LIVE_SAMPLE = [
  "- **HYK-226** 동시 상한 이슈2 — 커밋된 런타임 배포·활성화 불변식 — *Todo* (2026-08-11 13:38 **책임자 등재** · ★**오늘 13:07 실사고가 이 이슈의 근거**: 관제실 배달기가 **대상 워크트리의 미커밋 파일**을 런타임 의존성으로 삼아 **hyk224 외 전 워크트리 배달 불가**(메인·pm-lane 포함). **PM 판정** = *««얇은 껍데기」 원칙 자체가 원인이 아니라, 관제실 활성화가 저장소 병합보다 먼저 나갔고 껍데기가 미커밋 파일에 의존한 두 조건이 실패를 내장»*. 닫힘 = 대상 워크트리에 CLI 가 없어도 **활성 설치본**으로 같은 판정 · 미병합 엔진을 가리키는 관제실 변경은 **활성화 거부** · rollback 원자성. **착수 금지**(순서 2번))",
  "- **HYK-227** 동시 상한 이슈3 — 정상 완료의 전 호출경로 결선 — *Todo* (2026-08-11 13:38 **책임자 등재** · **PM 제4안 핵심** = *«입장 예약의 내구 결속을 **모든 검증된 결과 소비자**가 의무 소비»* — env 선택적 no-op 제거. ★**PM 실측**: in-process 호출자가 **실제로 5파일 존재**(`relay-core`·`watch-result`·`seat-signal-adapter`·`orca-spike-live`·`orca-spike-runner`) ⇒ ⛔**`gap#100` 의 «실재 여부 미확인» 문면은 사실과 다름**(HYK-225 에서 «틀린 사실만» 최소 정정 지시). 닫힘 = **ACTIVE→COMPLETED 가 사람 손 없이** · CLI·in-process **결과 동일** · 완료 capability 없으면 **dispatch 전 거부**. **착수 금지**(순서 3번))",
  "- **HYK-228** 동시 상한 이슈4 — 비정상 종료 복구 + 수거기 생존 보증 — *Todo* (2026-08-11 13:38 **책임자 등재** · **PM 실측** = `sweepAndRecover` 는 있으나 **프로덕션 호출자 0** · `OrchStallWatch` 는 admission sweep 미실행. ★**근거 사건** = 08-11 05:09 재부팅(끝 신호 영영 없음) · 08-11 자정 **스케줄러 «기한 만료»로 조용히 죽음**(`State=Ready`·`LastTaskResult=0` 인데 `NextRunTime` 만 공백). 닫힘 = **만료·`NextRunTime` 공백 주입 시 freshness gate RED + 새 배달 차단** · periodic·event **서로 복구** · 좌석 생존 sweeper 가 **정상 완료를 가로채지 않음**. ⛔*«등록됨»·`LastTaskResult=0` 은 생존 증거가 아니다.* **착수 금지**(순서 4번))",
  "- **HYK-230** 문서관리 P1-2 — 아카이브 활성화·생존 게이트·파일럿 — *Todo* (2026-08-11 15:44 **책임자 등재** · **P1-1 선행** · 실파일 이동은 **활성 PR·배달 없는 정비창에서만** · 닫힘 = canary 신선도 · **`NextRunTime` 공백·실행기 중단 RED** · active `--body-file` 보호 실관제실 확인. ⛔*«등록됨·`LastTaskResult=0`」만으로 초록이면 시험 실패»*. **착수 금지**)",
  "- **HYK-231** 문서관리 P2-1 — 분할 인덱스·인벤토리·정본 검사 기반 — *Todo* (2026-08-11 15:44 **책임자 등재** · ⛔**HYK-225 병합 후**(`docs/enforcement-known-gaps.md` **정확히 겹침**) · 닫힘 = 분할 전 구조 snapshot + 참조 소비자 목록 고정 · 누락·중복·상한초과가 **정본 검사에서 RED**. **실측 참조 소비자** = `known-gaps` 16파일/32매치 · `v1` 24파일/43매치. **착수 금지**)",
  "- **HYK-232** 문서관리 P2-2 — `enforcement-known-gaps` 분할 — *Todo* (2026-08-11 15:44 **책임자 등재** · **P2-1 선행** · ★**실측 = master 333.21 KiB · HYK-225 HEAD 338.92 KiB 로 둘 다 256 KiB 초과** ⇒ 어떤 에이전트도 한 번에 못 읽음. 닫힘 = 구조 항목 **무손실 이관** · root 는 인덱스 · **새 append route 단일화**(구 root 직접 append 시 검사 실패) · 분할 창 동안 **쓰기 동결**. ★**S14 적용 불가**(PM 판정: *«추가 전용」 전제를 분할이 스스로 깬다*). **착수 금지**)",
];

test("(10e) parseStatusOpenIssuesDetailed: 6 real STATUS.md §6 rows (frozen snapshot, sample n=6 >= contract minimum 5) all parse, 0 false-positive skips", () => {
  const text = `\n### 6) 열린 이슈 (Linear)\n${REAL_STATUS_SIX_LIVE_SAMPLE.join("\n")}\n### 7) 다음\n`;
  const r = parseStatusOpenIssuesDetailed(text);
  assert.equal(r.headerFound, true);
  assert.equal(r.skippedCount, 0);
  assert.equal(r.issues.length, REAL_STATUS_SIX_LIVE_SAMPLE.length);
  assert.deepEqual(
    r.issues.map((i) => i.id),
    ["HYK-226", "HYK-227", "HYK-228", "HYK-230", "HYK-231", "HYK-232"],
  );
});

// --- HYK-235 §2-1/§2-2: §7 table parser (contract "B" -- lookup only) ---

const SEVEN_FIXTURE = `
### 7) 인수인계 큐 (미처리)
<!-- 큐 설명 주석 -->

부팅 규약: 이 줄은 표가 아니라 프로즈다.

| 등록 | 출처 | 내용 | 승격 대상 | 상태 |
|---|---|---|---|---|
| 2026-08-11 | ORCH 실측 | **정상 항목** — HYK-219 와 같은 뿌리 | **신규 이슈 후보(강)** — HYK-221 과 같은 뿌리 | 미처리 |
| 2026-08-10 | ORCH 관측 | 승격 대상 없는 일반 관측 항목 | **후보** — 아직 신규 이슈로 안 올림 | 미처리 |
| 2026-08-09 | 깨진 행 | 이 행은 칸이 4개뿐 | 신규 이슈 후보 |
| 2026-08-08 | ORCH 자인 | 규율만 등재 | **규율(즉시 채택)** — 이슈 승격 대상 아님 | 미처리 |

### 8) 다음
`;

test("(11) parseStatusSevenCandidates: extracts only rows whose 승격 대상 cell says '신규 이슈 후보', collects referenced HYK-N ids from content+promotion cells", () => {
  const r = parseStatusSevenCandidates(SEVEN_FIXTURE);
  assert.equal(r.headerFound, true);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].date, "2026-08-11");
  assert.deepEqual(
    new Set(r.candidates[0].referencedIds),
    new Set(["HYK-219", "HYK-221"]),
  );
});

test("(11b) parseStatusSevenCandidates: a table row with the wrong cell count is counted as malformed, not silently dropped or crashing", () => {
  const r = parseStatusSevenCandidates(SEVEN_FIXTURE);
  assert.equal(r.malformedRowCount, 1);
  assert.equal(r.malformedRowSamples.length, 1);
  assert.ok(r.malformedRowSamples[0].includes("깨진 행"));
});

test("(11c) parseStatusSevenCandidates: header row, separator row, and non-table prose are never treated as candidates or malformed rows", () => {
  const r = parseStatusSevenCandidates(SEVEN_FIXTURE);
  // total data rows in fixture = 4 (candidate + plain + malformed + discipline-only);
  // header+separator+prose must not inflate either count.
  assert.equal(r.candidates.length + r.malformedRowCount, 2);
});

test("(11d) parseStatusSevenCandidates: no §7 heading present -> headerFound false, empty result, no crash", () => {
  const r = parseStatusSevenCandidates(
    "### 6) 열린 이슈 (Linear)\n- **HYK-1** x — *Todo*\n",
  );
  assert.equal(r.headerFound, false);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.malformedRowCount, 0);
});

// --- HYK-235 §2-3/§2-4 ⓒ: §7 existence check is read-only, 0 writes ---

test("(12) checkSevenCandidateReferences: an id present in the already-fetched Linear issue list is marked exists:true", () => {
  const candidates = [
    {
      date: "2026-08-11",
      source: "x",
      promotionText: "y",
      referencedIds: ["HYK-219", "HYK-999"],
    },
  ];
  const linearIssues = [
    { id: "HYK-219", stateName: "Done", stateType: "completed" },
  ];
  const { checked, missing } = checkSevenCandidateReferences(
    candidates,
    linearIssues,
  );
  assert.equal(checked.length, 2);
  assert.deepEqual(
    checked.find((c) => c.id === "HYK-219"),
    { id: "HYK-219", exists: true, fromCandidateDate: "2026-08-11" },
  );
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, "HYK-999");
});

test("(12b) checkSevenCandidateReferences + parseStatusSevenCandidates: never call fetch -- structural 0-writes proof (RED if either function ever reaches for the network)", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error(
      "checkSevenCandidateReferences/parseStatusSevenCandidates must never call fetch -- lookup only, 0 writes",
    );
  };
  try {
    const parsed = parseStatusSevenCandidates(SEVEN_FIXTURE);
    const result = checkSevenCandidateReferences(parsed.candidates, [
      { id: "HYK-219", stateName: "Done", stateType: "completed" },
    ]);
    assert.equal(result.checked.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- HYK-235 §2-3: closed 3-state verdict (IN_SYNC / DRIFT / UNJUDGABLE) ---

test("(13) resolveSyncVerdict: §6 header not found -> UNJUDGABLE regardless of diff contents (never read as '0 open issues' clean)", () => {
  const v = resolveSyncVerdict({
    headerFound: false,
    apiJudgable: true,
    staleInStatus: [],
    missingInStatus: [],
    stateDrift: [],
  });
  assert.equal(v, SYNC_VERDICT.UNJUDGABLE);
});

test("(13b) resolveSyncVerdict: API/network not judgable -> UNJUDGABLE, never collapsed into IN_SYNC", () => {
  const v = resolveSyncVerdict({
    headerFound: true,
    apiJudgable: false,
    staleInStatus: [],
    missingInStatus: [],
    stateDrift: [],
  });
  assert.equal(v, SYNC_VERDICT.UNJUDGABLE);
});

test("(13c) resolveSyncVerdict: header found + API judgable + clean diff -> IN_SYNC", () => {
  const v = resolveSyncVerdict({
    headerFound: true,
    apiJudgable: true,
    staleInStatus: [],
    missingInStatus: [],
    stateDrift: [],
  });
  assert.equal(v, SYNC_VERDICT.IN_SYNC);
});

test("(13d) resolveSyncVerdict: header found + API judgable + confirmed drift -> DRIFT", () => {
  const v = resolveSyncVerdict({
    headerFound: true,
    apiJudgable: true,
    staleInStatus: [{ id: "HYK-97" }],
    missingInStatus: [],
    stateDrift: [],
  });
  assert.equal(v, SYNC_VERDICT.DRIFT);
});

test("(13e) SYNC_VERDICT_EXIT_CODE: IN_SYNC=0, DRIFT=1, UNJUDGABLE=3 -- UNJUDGABLE is never exit 2 (this check has no resolveStopBlock wiring)", () => {
  assert.equal(SYNC_VERDICT_EXIT_CODE.IN_SYNC, 0);
  assert.equal(SYNC_VERDICT_EXIT_CODE.DRIFT, 1);
  assert.equal(SYNC_VERDICT_EXIT_CODE.UNJUDGABLE, 3);
  assert.notEqual(SYNC_VERDICT_EXIT_CODE.UNJUDGABLE, 2);
});

// --- HYK-305: reportDriftDetails screen summarization + drift-report file ---
// Judgment (SYNC_VERDICT/SYNC_VERDICT_EXIT_CODE, tests 9-13e above) is
// completely untouched by this section -- only reportDriftDetails' *output*
// changed. All fixture paths below live under the test's own tmpdir, never
// the real control room (§3 requirement: no test may touch the real path).

function captureConsoleError(fn) {
  const lines = [];
  const original = console.error;
  console.error = (msg) => lines.push(msg);
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const DRIFT_3 = {
  staleInStatus: [{ id: "HYK-1", statusState: "Todo", linearState: "Done" }],
  missingInStatus: [{ id: "HYK-2", linearState: "Todo" }],
  stateDrift: [
    { id: "HYK-3", statusState: "Todo", linearState: "In Progress" },
  ],
};

test("(14) buildDriftEntries: flattens stale/missing/state into ordered {key,text} entries with the exact pre-existing detail text", () => {
  const entries = buildDriftEntries(DRIFT_3);
  assert.deepEqual(
    entries.map((e) => e.key),
    ["stale:HYK-1", "missing:HYK-2", "state:HYK-3"],
  );
  assert.ok(entries[0].text.includes("staleInStatus: HYK-1"));
  assert.ok(entries[1].text.includes("missingInStatus: HYK-2"));
  assert.ok(entries[2].text.includes("stateDrift: HYK-3"));
});

test("(15) computeDriftTransition: previousKeys null (first run / unreadable) -> every entry is new", () => {
  const entries = buildDriftEntries(DRIFT_3);
  const newEntries = computeDriftTransition(entries, null);
  assert.equal(newEntries.length, 3);
});

test("(15b) computeDriftTransition: previousKeys has all current keys -> nothing new", () => {
  const entries = buildDriftEntries(DRIFT_3);
  const previousKeys = new Set(entries.map((e) => e.key));
  const newEntries = computeDriftTransition(entries, previousKeys);
  assert.equal(newEntries.length, 0);
});

test("(15c) computeDriftTransition: only entries absent from previousKeys are new, disappeared ones are never re-surfaced by this function", () => {
  const entries = buildDriftEntries(DRIFT_3);
  const previousKeys = new Set([
    "stale:HYK-1",
    "missing:HYK-2",
    "state:HYK-999",
  ]);
  const newEntries = computeDriftTransition(entries, previousKeys);
  assert.deepEqual(
    newEntries.map((e) => e.key),
    ["state:HYK-3"],
  );
});

test("(16) parseDriftReportPathArg + resolveDriftReportPath: explicit --drift-report is respected verbatim", () => {
  const arg = parseDriftReportPathArg([
    "--status",
    "x",
    "--drift-report",
    "C:/tmp/custom.json",
  ]);
  assert.equal(arg, "C:/tmp/custom.json");
  assert.equal(
    resolveDriftReportPath(arg, "C:/whatever/STATUS.md"),
    "C:/tmp/custom.json",
  );
});

test("(16b) resolveDriftReportPath: no --drift-report -> defaults to <status dir>/watch/linear-sync-drift.json", () => {
  const arg = parseDriftReportPathArg(["--status", "x"]);
  assert.equal(arg, undefined);
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    assert.equal(
      resolveDriftReportPath(arg, statusPath),
      join(dir, "watch", "linear-sync-drift.json"),
    );
  });
});

test("(17) reportDriftDetails: drift with no previous file -> screen shows summary + all 3 detail lines, drift-report file has all 3", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    const lines = captureConsoleError(() =>
      reportDriftDetails(DRIFT_3, reportPath),
    );
    assert.ok(lines[0].startsWith("linear-sync verdict: DRIFT detected:"));
    assert.ok(
      lines[1].includes("linear-sync: DRIFT 어긋남 3건") &&
        lines[1].includes("stale 1") &&
        lines[1].includes("missing 1") &&
        lines[1].includes("state 1") &&
        lines[1].includes(reportPath),
    );
    const detailLines = lines.slice(2);
    assert.equal(detailLines.length, 3);
    const saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(saved.keys, [
      "stale:HYK-1",
      "missing:HYK-2",
      "state:HYK-3",
    ]);
    assert.equal(saved.counts.stale, 1);
    assert.equal(saved.lines.length, 3);
  });
});

test("(18) reportDriftDetails: identical drift rerun (previous file present) -> screen is summary only, 0 detail lines, file still has all 3", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    reportDriftDetails(DRIFT_3, reportPath); // first run writes the previous-state file
    const lines = captureConsoleError(() =>
      reportDriftDetails(DRIFT_3, reportPath),
    );
    assert.equal(
      lines.length,
      2,
      "only the verdict line + summary line, no detail lines",
    );
    const saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(saved.keys.length, 3);
  });
});

test("(19) reportDriftDetails: one new drift item added -> screen shows only the new item's detail line, file grows to 4", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    reportDriftDetails(DRIFT_3, reportPath);
    const DRIFT_4 = {
      ...DRIFT_3,
      staleInStatus: [
        ...DRIFT_3.staleInStatus,
        { id: "HYK-4", statusState: "Todo", linearState: "Done" },
      ],
    };
    const lines = captureConsoleError(() =>
      reportDriftDetails(DRIFT_4, reportPath),
    );
    assert.ok(lines[1].includes("DRIFT 어긋남 4건"));
    const detailLines = lines.slice(2);
    assert.equal(detailLines.length, 1);
    assert.ok(detailLines[0].includes("HYK-4"));
    const saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(saved.keys.length, 4);
  });
});

test("(20) reportDriftDetails: one drift item disappears -> summary count drops, 0 detail lines, file shrinks", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    reportDriftDetails(DRIFT_3, reportPath);
    const DRIFT_2 = {
      staleInStatus: DRIFT_3.staleInStatus,
      missingInStatus: [],
      stateDrift: DRIFT_3.stateDrift,
    };
    const lines = captureConsoleError(() =>
      reportDriftDetails(DRIFT_2, reportPath),
    );
    assert.ok(lines[1].includes("DRIFT 어긋남 2건"));
    const detailLines = lines.slice(2);
    assert.equal(detailLines.length, 0);
    const saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(saved.keys, ["stale:HYK-1", "state:HYK-3"]);
  });
});

test("(21) readPreviousDriftKeys: missing file -> null (never throws)", () => {
  withFixtureDir((dir) => {
    const result = readPreviousDriftKeys(join(dir, "nope.json"));
    assert.equal(result, null);
  });
});

test("(21b) readPreviousDriftKeys: malformed JSON -> null, not a throw", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{ not valid json", "utf8");
    const result = readPreviousDriftKeys(p);
    assert.equal(result, null);
  });
});

test("(22) writeDriftReport: succeeds and creates missing parent directories", () => {
  withFixtureDir((dir) => {
    const p = join(dir, "a", "b", "drift.json");
    const result = writeDriftReport(p, {
      generatedAt: "2026-08-19T00:00:00.000Z",
      counts: { stale: 1, missing: 0, state: 0 },
      keys: ["stale:HYK-1"],
      lines: ["  staleInStatus: HYK-1 ..."],
    });
    assert.equal(result.ok, true);
    const saved = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(saved.keys, ["stale:HYK-1"]);
  });
});

test("(23) reportDriftDetails: drift-report write failure -> screen still shows summary + warning line, judgment/exit code untouched (fail toward showing detail, not hiding it)", () => {
  withFixtureDir((dir) => {
    // "watch" exists as a plain file, so mkdirSync(dirname, {recursive:true})
    // for "watch/linear-sync-drift.json" is forced to fail -- a reliable,
    // cross-platform way to trigger the write-failure path without touching
    // real filesystem permissions.
    const watchAsFile = join(dir, "watch");
    writeFileSync(watchAsFile, "not a directory", "utf8");
    const reportPath = join(watchAsFile, "linear-sync-drift.json");

    const lines = captureConsoleError(() =>
      reportDriftDetails(DRIFT_3, reportPath),
    );
    assert.ok(lines[0].startsWith("linear-sync verdict: DRIFT detected:"));
    assert.ok(lines[1].includes("DRIFT 어긋남 3건"));
    // first run against an unwritable report path: no previous file readable
    // either (dirname is a file, so existsSync(reportPath) is false) -> all
    // 3 shown, per §2-4's "show, don't hide" fail-open rule.
    const detailLines = lines.slice(2, 5);
    assert.equal(detailLines.length, 3);
    const warningLine = lines[lines.length - 1];
    assert.ok(warningLine.includes("상세 파일을 쓰지 못했습니다"));
    assert.ok(warningLine.includes("판정에는 영향 없음"));
  });
});

// --- HYK-305-quiet-2: review r1 rejected P1 (IN_SYNC never cleared the
// drift-report file, so a resolved item's recurrence was never "new") + P2
// (no test drove main()/the real CLI entry point with a mocked Linear
// response). Both addressed below. ---

test("(24) clearDriftReportForInSync: overwrites a previously-populated report file with an empty key set", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    reportDriftDetails(DRIFT_3, reportPath); // seed the file with 3 keys
    let saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.equal(saved.keys.length, 3);

    clearDriftReportForInSync(reportPath);
    saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(saved.keys, []);
    assert.deepEqual(saved.lines, []);
    assert.deepEqual(saved.counts, { stale: 0, missing: 0, state: 0 });
  });
});

test("(25) clearDriftReportForInSync + reportDriftDetails: a cleared item that recurs is judged 'new' again (the exact P1 bug shape, at the helper level)", () => {
  withFixtureDir((dir) => {
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    reportDriftDetails(DRIFT_3, reportPath); // first: all 3 are "new"
    clearDriftReportForInSync(reportPath); // resolved -> IN_SYNC clears it
    const lines = captureConsoleError(() =>
      reportDriftDetails(DRIFT_3, reportPath),
    ); // same 3 recur
    const detailLines = lines.slice(2);
    assert.equal(
      detailLines.length,
      3,
      "after a clear, a full recurrence must show all 3 as new -- not 0 (the P1 defect)",
    );
  });
});

test("(26) reportVerdictAndExit's UNJUDGABLE path never calls clearDriftReportForInSync -- a pre-existing report file survives untouched (verified at the CLI level, no LINEAR_API_KEY -> UNJUDGABLE before driftReportPath is ever reached)", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    writeFileSync(
      statusPath,
      "### 6) 열린 이슈 (Linear)\n- **HYK-1** 테스트 — *Todo*\n",
      "utf8",
    );
    const reportPath = join(dir, "watch", "linear-sync-drift.json");
    const seeded = {
      generatedAt: "2026-01-01T00:00:00.000Z",
      counts: { stale: 1, missing: 0, state: 0 },
      keys: ["stale:HYK-1"],
      lines: ["  staleInStatus: HYK-1 ..."],
    };
    writeDriftReport(reportPath, seeded);

    const env = { ...process.env };
    delete env.LINEAR_API_KEY;
    const result = spawnSync(
      process.execPath,
      [
        LINEAR_SYNC_SCRIPT,
        "--status",
        statusPath,
        "--drift-report",
        reportPath,
      ],
      { encoding: "utf8", env, cwd: process.cwd() },
    );
    assert.equal(result.status, SYNC_VERDICT_EXIT_CODE.UNJUDGABLE);
    assert.ok(result.stdout.includes("UNJUDGABLE"));
    const saved = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.deepEqual(
      saved,
      seeded,
      "UNJUDGABLE must leave the report file byte-for-byte alone",
    );
  });
});

// --- P2: drive the real CLI entry point (main()), Linear response mocked
// via an --import preload that overrides globalThis.fetch, matching the
// technique the reviewer used to independently verify r1. ---

function writeFetchPreload(dir) {
  const preloadPath = join(dir, "mock-fetch-preload.mjs");
  writeFileSync(
    preloadPath,
    [
      "globalThis.fetch = async () => ({",
      "  ok: true,",
      "  json: async () => ({",
      '    data: { issues: { nodes: JSON.parse(process.env.MOCK_LINEAR_ISSUES || "[]") } },',
      "  }),",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return preloadPath;
}

function runLinearSyncCli({ dir, statusPath, driftReportPath, mockIssues }) {
  const preloadPath = writeFetchPreload(dir);
  return spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preloadPath).href,
      LINEAR_SYNC_SCRIPT,
      "--status",
      statusPath,
      "--drift-report",
      driftReportPath,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LINEAR_API_KEY: "dummy-test-key-for-cli-mock",
        MOCK_LINEAR_ISSUES: JSON.stringify(mockIssues),
      },
      cwd: process.cwd(),
    },
  );
}

test("(27) P2 + reviewer's exact 4-step reproduction, driven through the real CLI entry point (main()) with a mocked Linear response: resolved-then-recurring drift shows new detail again, never silently swallowed", () => {
  withFixtureDir((dir) => {
    const statusPath = join(dir, "STATUS.md");
    writeFileSync(
      statusPath,
      "### 6) 열린 이슈 (Linear)\n- **HYK-1** 테스트 — *Todo*\n",
      "utf8",
    );
    const driftReportPath = join(dir, "watch", "linear-sync-drift.json");
    const staleIssue = [
      { identifier: "HYK-1", state: { name: "Done", type: "completed" } },
    ];
    const matchingIssue = [
      { identifier: "HYK-1", state: { name: "Todo", type: "unstarted" } },
    ];

    // (1) first run, stale -- exit 1, summary + 1 detail line.
    const r1 = runLinearSyncCli({
      dir,
      statusPath,
      driftReportPath,
      mockIssues: staleIssue,
    });
    assert.equal(r1.status, SYNC_VERDICT_EXIT_CODE.DRIFT);
    assert.ok(r1.stderr.includes("DRIFT 어긋남 1건"));
    assert.ok(r1.stderr.includes("staleInStatus: HYK-1"));

    // (2) same drift again -- exit 1, summary only.
    const r2 = runLinearSyncCli({
      dir,
      statusPath,
      driftReportPath,
      mockIssues: staleIssue,
    });
    assert.equal(r2.status, SYNC_VERDICT_EXIT_CODE.DRIFT);
    assert.ok(r2.stderr.includes("DRIFT 어긋남 1건"));
    assert.ok(!r2.stderr.includes("staleInStatus: HYK-1"));

    // (3) resolved -- IN_SYNC, exit 0, and the report file must now read 0.
    const r3 = runLinearSyncCli({
      dir,
      statusPath,
      driftReportPath,
      mockIssues: matchingIssue,
    });
    assert.equal(r3.status, SYNC_VERDICT_EXIT_CODE.IN_SYNC);
    assert.ok(r3.stdout.includes("IN_SYNC"));
    const clearedReport = JSON.parse(readFileSync(driftReportPath, "utf8"));
    assert.deepEqual(clearedReport.keys, []);

    // (4) the P1 bug shape: same stale item recurs -- must show new detail,
    // not just the summary (r1 rejected r1's coder submission on exactly
    // this step being silent).
    const r4 = runLinearSyncCli({
      dir,
      statusPath,
      driftReportPath,
      mockIssues: staleIssue,
    });
    assert.equal(r4.status, SYNC_VERDICT_EXIT_CODE.DRIFT);
    assert.ok(r4.stderr.includes("DRIFT 어긋남 1건"));
    assert.ok(
      r4.stderr.includes("staleInStatus: HYK-1"),
      "recurrence after IN_SYNC must show detail again -- this is the exact P1 defect the review rejected",
    );
  });
});
