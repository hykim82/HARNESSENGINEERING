// HYK-255-g-aux-render-1 커밋 1 (coder-task.md §2 ⓒ) -- ㄱ «보조 관측(독립 아님)»
// 4종(ㄱ-1 · ㄱ-2 · ㄱ-6 · ㄱ-7)의 계약 시험. ⛔헛시험 금지: 프로덕션 export
// (collectGateAuxObservations · renderGateAuxObservationLine ·
// buildPartialCountReport · runPartialCountOnce)를 직접 구동하고, 입력은 전부
// mkdtemp 합성 저장소(합성 reject-streak.json + 체인 · 합성 보내는함 · 합성
// 받는함)다. 이 시험에서 실제 원장 · 관제실 · 받는함 · 네트워크 접촉은 0 이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as report from "./partial-count-report.mjs";
import * as core from "./partial-count-core.mjs";
import { HARD_STOP_STREAK } from "../check/reject-streak.mjs";
import { catchUpCheckpoints } from "../check/reject-streak-chain.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T10:00:00.000Z"); // 2026-11-12 19:00 KST
const WINDOW_END = NOW;
const WINDOW_START = NOW - 24 * HOUR; // 2026-11-11 19:00 KST
const AUX_PREFIX = "- 보조 관측(독립 아님): ";

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// 창 안 · 창 밖 파일 mtime -- 보내는함 보조 수집기(collectOutboxHeaderCounts)와
// 같은 mtime 규칙을 쓴다.
const IN_WINDOW_MS = NOW - 2 * HOUR;
const OUT_WINDOW_MS = NOW - 48 * HOUR;

function putFile(dir, name, text, mtimeMs = IN_WINDOW_MS) {
  const full = join(dir, name);
  fs.writeFileSync(full, text, "utf8");
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
}

// issues = { "HYK-1": [["rejected", "2026-11-12 10:00 KST"], ...] } -> 합성 원장 +
// 올바른 해시 체인(실제 reject-streak-chain 의 catchUpCheckpoints 로 만든다).
function writeSyntheticLedger(repoRoot, issues, { tamperChain } = {}) {
  const harnessDir = join(repoRoot, ".harness");
  fs.mkdirSync(harnessDir, { recursive: true });
  const ledger = { schema_version: 1, issues: {} };
  for (const [issueId, rows] of Object.entries(issues)) {
    let streak = 0;
    const history = rows.map(([verdict, at], i) => {
      streak = verdict === "rejected" ? streak + 1 : 0;
      return { task_id: `${issueId}-coder-${i + 1}`, verdict, at };
    });
    ledger.issues[issueId] = { streak, history };
  }
  let chain = { schema_version: 1, issues: {} };
  for (const issueId of Object.keys(ledger.issues)) {
    chain = catchUpCheckpoints(ledger, chain, issueId);
  }
  if (tamperChain) tamperChain(chain);
  fs.writeFileSync(
    join(harnessDir, "reject-streak.json"),
    JSON.stringify(ledger, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    join(harnessDir, "reject-streak-chain.json"),
    JSON.stringify(chain, null, 2) + "\n",
    "utf8",
  );
}

function collect(dirs, extra = {}) {
  return report.collectGateAuxObservations({
    repoRoot: dirs.repoRoot,
    outboxDir: dirs.outbox,
    inboxDir: dirs.inbox,
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
    ...extra,
  });
}

function makeDirs() {
  const root = tmpDir("nc-g-aux-");
  const dirs = {
    root,
    repoRoot: join(root, "repo"),
    outbox: join(root, "보내는함"),
    inbox: join(root, "받는함"),
  };
  fs.mkdirSync(dirs.repoRoot, { recursive: true });
  fs.mkdirSync(dirs.outbox, { recursive: true });
  fs.mkdirSync(dirs.inbox, { recursive: true });
  return dirs;
}

// ---------------------------------------------------------------------------
// ㄱ-1 -- 보내는함 파일 이름 «게이트1» (창 안 개수)
// ---------------------------------------------------------------------------

test("ㄱ-1: 보내는함 이름에 «게이트1» 이 든 창 안 파일 2개 -> a=2 (다른 이름 · «게이트10» 은 세지 않는다)", () => {
  const d = makeDirs();
  try {
    putFile(d.outbox, "2026-11-12-0900-게이트1-다음작업.md", "x");
    putFile(d.outbox, "2026-11-12-1000-판정-게이트1-선택.md", "x");
    putFile(d.outbox, "2026-11-12-1100-게이트10-다른것.md", "x");
    putFile(d.outbox, "2026-11-12-1200-판정-1200.md", "x");
    writeSyntheticLedger(d.repoRoot, {});
    const aux = collect(d);
    assert.deepEqual(
      { known: aux.gate1.known, count: aux.gate1.count },
      { known: true, count: 2 },
    );
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-1: «게이트1» 파일이 창 밖(mtime 48시간 전)이면 0 이다 -- 읽을 수 있었던 진짜 0", () => {
  const d = makeDirs();
  try {
    putFile(d.outbox, "2026-11-10-0900-게이트1-옛것.md", "x", OUT_WINDOW_MS);
    writeSyntheticLedger(d.repoRoot, {});
    const aux = collect(d);
    assert.deepEqual(
      { known: aux.gate1.known, count: aux.gate1.count },
      { known: true, count: 0 },
    );
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-1: 보내는함 폴더를 못 읽으면 bare 0 이 아니라 known:false + 사유다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    const aux = collect({ ...d, outbox: join(d.root, "없는-보내는함") });
    assert.equal(aux.gate1.known, false);
    assert.match(aux.gate1.reason, /보내는함/);
    assert.equal(aux.gate1.count, undefined);
  } finally {
    cleanup(d.root);
  }
});

// ---------------------------------------------------------------------------
// ㄱ-2 -- reject-streak 원장의 streak ≥2 «전이» (창 안 · 이슈 수)
// ---------------------------------------------------------------------------

test("ㄱ-2: streak 1->2 전이가 창 안이면 그 이슈 1건 · 2->3 은 새 전이가 아니다(이슈 수) · 창 앞에서 이미 2 였던 이슈의 3 은 세지 않는다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      // A: 창 안에서 1->2 -> 3 (전이 1회 = 이슈 1)
      "HYK-A": [
        ["rejected", "2026-11-12 09:00 KST"],
        ["rejected", "2026-11-12 10:00 KST"],
        ["rejected", "2026-11-12 11:00 KST"],
      ],
      // B: 1->2 는 창 앞(11-10), 2->3 만 창 안 -> 새 전이 아님 -> 0
      "HYK-B": [
        ["rejected", "2026-11-10 09:00 KST"],
        ["rejected", "2026-11-10 10:00 KST"],
        ["rejected", "2026-11-12 11:00 KST"],
      ],
      // C: 반려 -> 승인 -> 반려, 2 에 닿지 않는다 -> 0
      "HYK-C": [
        ["rejected", "2026-11-12 09:00 KST"],
        ["approved", "2026-11-12 10:00 KST"],
        ["rejected", "2026-11-12 11:00 KST"],
      ],
    });
    const aux = collect(d);
    assert.deepEqual(
      { known: aux.gate2.known, count: aux.gate2.count },
      { known: true, count: 1 },
    );
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-2: 두 이슈가 각각 창 안에서 2 에 닿으면 2 (이슈 수)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-A": [
        ["rejected", "2026-11-12 09:00 KST"],
        ["rejected", "2026-11-12 10:00 KST"],
      ],
      "HYK-B": [
        ["rejected", "2026-11-12 12:00 KST"],
        ["rejected", "2026-11-12 13:00 KST"],
      ],
    });
    assert.equal(collect(d).gate2.count, 2);
  } finally {
    cleanup(d.root);
  }
});

// ---------------------------------------------------------------------------
// ㄱ-6 -- 같은 원장의 하드스톱 문턱 도달 전이 (문턱 = HARD_STOP_STREAK)
// ---------------------------------------------------------------------------

function rejectedRows(n, day = "2026-11-12") {
  return Array.from({ length: n }, (_, i) => [
    "rejected",
    `${day} ${String(8 + i).padStart(2, "0")}:00 KST`,
  ]);
}

test("ㄱ-6: HARD_STOP_STREAK 번째 반려가 창 안이면 문턱 도달 1 · 한 칸 모자라면 0 (문턱은 reject-streak.mjs 상수)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-HIT": rejectedRows(HARD_STOP_STREAK),
      "HYK-NEAR": rejectedRows(HARD_STOP_STREAK - 1),
    });
    const aux = collect(d);
    assert.deepEqual(
      { known: aux.gate6.known, count: aux.gate6.count },
      { known: true, count: 1 },
    );
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-6: 문턱 상수가 바뀌면 따라간다 -- 주입한 문턱 3 이면 반려 3번째에서 1, 상수를 무시하면 0", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, { "HYK-T3": rejectedRows(3) });
    const followed = collect(d, { hardStopStreak: 3 });
    assert.equal(followed.gate6.count, 1);
    const pinnedDefault = collect(d);
    assert.equal(
      pinnedDefault.gate6.count,
      HARD_STOP_STREAK <= 3 ? 1 : 0,
      "기본 문턱 = reject-streak.mjs 의 HARD_STOP_STREAK",
    );
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-6: 소스에 문턱 숫자 4 리터럴이 없고 reject-streak.mjs 의 HARD_STOP_STREAK 를 import 한다", () => {
  const src = fs.readFileSync(
    new URL("./partial-count-report.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    src,
    /import\s*\{[^}]*\bHARD_STOP_STREAK\b[^}]*\}\s*from\s*"\.\.\/check\/reject-streak\.mjs"/,
  );
  assert.doesNotMatch(src, /hardStopStreak\s*=\s*4\b/);
  assert.doesNotMatch(src, /streak\s*>=\s*4\b/);
});

// ---------------------------------------------------------------------------
// 체인 검증 실패 / 원장 못 읽음 -> 그 칸만 수집 실패 (bare 0 금지)
// ---------------------------------------------------------------------------

function tamperFirstEntryVerdict(chain) {
  const first = Object.values(chain.issues)[0].entries[0];
  first.verdict = first.verdict === "rejected" ? "approved" : "rejected";
}

test("체인이 깨지면(해시 불일치) ㄱ-2 · ㄱ-6 은 known:false + 사유 «체인» -- 0 으로 접지 않고, ㄱ-1 · ㄱ-7 은 영향 없다", () => {
  const d = makeDirs();
  try {
    putFile(d.outbox, "2026-11-12-0900-게이트1-다음작업.md", "x");
    writeSyntheticLedger(
      d.repoRoot,
      { "HYK-A": rejectedRows(HARD_STOP_STREAK) },
      { tamperChain: tamperFirstEntryVerdict },
    );
    const aux = collect(d);
    for (const cell of [aux.gate2, aux.gate6]) {
      assert.equal(cell.known, false);
      assert.equal(cell.reason, "체인");
      assert.equal(cell.count, undefined);
      assert.match(cell.detail, /HYK-A/);
    }
    assert.equal(aux.gate1.known, true);
    assert.equal(aux.gate1.count, 1);
    assert.equal(aux.gate7.known, true);
  } finally {
    cleanup(d.root);
  }
});

test("체인 파일이 없으면 검증할 수 없으므로 ㄱ-2 · ㄱ-6 은 수집 실패(체인) 이고 원장 파일이 없으면 수집 실패(원장 없음)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, { "HYK-A": rejectedRows(2) });
    fs.rmSync(join(d.repoRoot, ".harness", "reject-streak-chain.json"));
    const noChain = collect(d);
    assert.equal(noChain.gate2.known, false);
    assert.equal(noChain.gate2.reason, "체인");
    fs.rmSync(join(d.repoRoot, ".harness", "reject-streak.json"));
    const noLedger = collect(d);
    assert.equal(noLedger.gate2.known, false);
    assert.equal(noLedger.gate2.reason, "원장 없음");
    assert.equal(noLedger.gate6.known, false);
  } finally {
    cleanup(d.root);
  }
});

test("원장이 JSON 이 아니면 ㄱ-2 · ㄱ-6 은 수집 실패(원장 읽기 실패) 다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    fs.writeFileSync(
      join(d.repoRoot, ".harness", "reject-streak.json"),
      "{ not json",
      "utf8",
    );
    const aux = collect(d);
    assert.equal(aux.gate2.known, false);
    assert.equal(aux.gate2.reason, "원장 읽기 실패");
    assert.equal(aux.gate6.known, false);
  } finally {
    cleanup(d.root);
  }
});

// ---------------------------------------------------------------------------
// ㄱ-7 -- 받는함 «상신» ↔ 보내는함 «판정-HHMM» 이름 쌍 중 «짝 있음»
// ---------------------------------------------------------------------------

function seedGate7(d) {
  // 받는함 상신 3 (15:30 · 16:00 · 17:00) · 보내는함 판정 2 (15:30 · 16:00)
  putFile(d.inbox, "2026-11-12-1530-상신-A.md", "x");
  putFile(d.inbox, "2026-11-12-1600-상신-B.md", "x");
  putFile(d.inbox, "2026-11-12-1700-상신-C.md", "x");
  putFile(d.inbox, "2026-11-12-1530-메모-노트.md", "x");
  putFile(d.outbox, "2026-11-12-1535-판정-1530.md", "x");
  putFile(d.outbox, "2026-11-12-1605-판정-1600.md", "x");
}

test("ㄱ-7: 상신 3 · 판정 짝 2 -> d=2 (같은 날짜 + 같은 HHMM 구조 대조, 상신 아닌 파일은 세지 않는다)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    seedGate7(d);
    const aux = collect(d);
    assert.deepEqual(
      { known: aux.gate7.known, count: aux.gate7.count },
      { known: true, count: 2 },
    );
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-7: 다른 날 같은 HHMM 의 판정은 짝이 아니다 (날짜까지 구조로 대조)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    putFile(d.inbox, "2026-11-12-1530-상신-A.md", "x");
    putFile(d.outbox, "2026-11-11-1535-판정-1530.md", "x");
    assert.equal(collect(d).gate7.count, 0);
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-7: 받는함 경로가 없거나 폴더를 못 읽으면 known:false + 사유(bare 0 금지)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    const noPath = collect({ ...d, inbox: null });
    assert.equal(noPath.gate7.known, false);
    assert.match(noPath.gate7.reason, /받는함/);
    const unreadable = collect({ ...d, inbox: join(d.root, "없음") });
    assert.equal(unreadable.gate7.known, false);
    assert.match(unreadable.gate7.reason, /받는함/);
  } finally {
    cleanup(d.root);
  }
});

test("ㄱ-7: 기존 «ㄱ-7 기록 누락» 계수(collectRelayLedger)는 보조 관측을 들여도 무변이다", () => {
  const d = makeDirs();
  try {
    // 보내는함 판정 파일 첫 줄에 한용 인용 -> S1 항목 -> 받는함 같은 HHMM 상신이
    // 있으면 «ㄱ-7 기록 누락» 으로 센다(기존 동작).
    putFile(
      d.outbox,
      "2026-11-12-1535-판정-1530.md",
      "[책임자 경유] 한용 «첫째 인용 문장입니다」\n",
    );
    putFile(
      d.outbox,
      "2026-11-12-1605-판정-1600.md",
      "[책임자 경유] 한용 «둘째 인용 문장입니다」\n",
    );
    putFile(d.inbox, "2026-11-12-1530-상신-A.md", "x");
    putFile(d.inbox, "2026-11-12-1600-상신-B.md", "x");
    const relayDir = join(d.root, "기록");
    fs.mkdirSync(relayDir, { recursive: true });
    // 형식 머리줄이 1개 있어야 «형식 시작» 이 잡혀 두 항목이 형식 이전으로 빠지지 않는다.
    fs.writeFileSync(
      join(relayDir, "전달-2026-11-01.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-1000 · 2026-11-01 10:00 KST · 지시 · ㄱ-1]",
        "> 한용: «형식 시작을 만드는 항목»",
        "",
      ].join("\n"),
      "utf8",
    );
    const r = report.collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md").replace(/\\/g, "/"),
      outboxDir: d.outbox,
      inboxDir: d.inbox,
    });
    assert.equal(r.known, true);
    assert.equal(r.gate7MissingCount, 2);
    assert.equal(r.candidateCount, 0);
  } finally {
    cleanup(d.root);
  }
});

// ---------------------------------------------------------------------------
// 렌더 -- core 순수 함수 · 보고서 줄 · 독립 앵커 커버리지 무변
// ---------------------------------------------------------------------------

const AUX_OK = {
  gate1: { known: true, count: 2 },
  gate2: { known: true, count: 1 },
  gate6: { known: true, count: 1 },
  gate7: { known: true, count: 2 },
};

function reportInput(extra = {}) {
  return {
    generatedAtMs: NOW,
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
    delivered: { known: true, count: 1 },
    consumed: { known: true, count: 1 },
    missingReceipts: { known: true, count: 0 },
    gate4: {
      known: true,
      candidatesInWindow: 0,
      checked: 0,
      approved: 0,
      notApproved: 0,
      undecidable: 0,
      uncheckedByBudget: 0,
      approvedEvents: [],
    },
    suspected: { known: true, closedCount: 0, openCount: 0 },
    coverageGaps: { known: true, count: 0, totalMs: 0 },
    ...extra,
  };
}

test("렌더: 4종 정상 -> «보조 관측(독립 아님): ㄱ-1 a · ㄱ-2 b · ㄱ-6 c · ㄱ-7 d» 한 줄", () => {
  assert.equal(
    core.renderGateAuxObservationLine(AUX_OK),
    `${AUX_PREFIX}ㄱ-1 2 · ㄱ-2 1 · ㄱ-6 1 · ㄱ-7 2`,
  );
});

test("렌더: 못 읽은 칸은 «ㄱ-N 수집 실패(사유)» 이고 bare 0 으로 접히지 않는다 (체인 실패 모양)", () => {
  const line = core.renderGateAuxObservationLine({
    ...AUX_OK,
    gate2: { known: false, reason: "체인", detail: "HYK-A: 해시 불일치" },
    gate6: { known: false, reason: "체인", detail: "HYK-A: 해시 불일치" },
  });
  assert.equal(
    line,
    `${AUX_PREFIX}ㄱ-1 2 · ㄱ-2 수집 실패(체인) · ㄱ-6 수집 실패(체인) · ㄱ-7 2`,
  );
  assert.doesNotMatch(line, /ㄱ-2 0/);
  assert.doesNotMatch(line, /ㄱ-6 0/);
});

test("렌더: 읽을 수 있었던 진짜 0 은 0 으로 낸다 (실패와 구별)", () => {
  const zero = core.renderGateAuxObservationLine({
    gate1: { known: true, count: 0 },
    gate2: { known: true, count: 0 },
    gate6: { known: true, count: 0 },
    gate7: { known: true, count: 0 },
  });
  assert.equal(zero, `${AUX_PREFIX}ㄱ-1 0 · ㄱ-2 0 · ㄱ-6 0 · ㄱ-7 0`);
});

test("보고서: ㄱ 절에 보조 관측 줄이 생기고 독립 앵커 유형 커버리지는 1/6 그대로 (보조 값 0 · 아주 큰 값 둘 다)", () => {
  const withAux = core.buildPartialCountReport(
    reportInput({ gateAuxObservation: AUX_OK }),
  );
  const huge = core.buildPartialCountReport(
    reportInput({
      gateAuxObservation: {
        gate1: { known: true, count: 50 },
        gate2: { known: true, count: 60 },
        gate6: { known: true, count: 70 },
        gate7: { known: true, count: 80 },
      },
    }),
  );
  const zero = core.buildPartialCountReport(
    reportInput({
      gateAuxObservation: {
        gate1: { known: true, count: 0 },
        gate2: { known: true, count: 0 },
        gate6: { known: true, count: 0 },
        gate7: { known: true, count: 0 },
      },
    }),
  );
  for (const text of [withAux, huge, zero]) {
    assert.match(text, /^- 독립 앵커 유형 커버리지: 1\/6$/m);
    assert.match(text, /^- 보조 관측\(독립 아님\): ㄱ-1 /m);
  }
  assert.deepEqual(core.INDEPENDENT_ANCHOR_COVERED_GATE_NUMBERS, [4]);
  // 줄은 ㄱ 절 안에 있다 (ㄴ 절 앞).
  const gaStart = withAux.indexOf("ㄱ 설계된 정지:");
  const lnStart = withAux.indexOf("ㄴ 계획 밖 개입:");
  const auxAt = withAux.indexOf(AUX_PREFIX);
  assert.ok(gaStart >= 0 && auxAt > gaStart && auxAt < lnStart);
});

test("보고서: 입력이 없으면(미결선 호출자) 보조 관측 줄 0개 -- 나머지 보고서는 줄 하나만 빼면 바이트 동일", () => {
  const without = core.buildPartialCountReport(reportInput());
  assert.doesNotMatch(without, /보조 관측\(독립 아님\)/);
  const withAux = core.buildPartialCountReport(
    reportInput({ gateAuxObservation: AUX_OK }),
  );
  const stripped = withAux
    .split("\n")
    .filter((l) => !l.startsWith(AUX_PREFIX))
    .join("\n");
  assert.equal(stripped, without);
});

// ---------------------------------------------------------------------------
// 끝까지: runPartialCountOnce (합성 입력 + 가짜 포트)
// ---------------------------------------------------------------------------

function fakePorts() {
  return {
    git: { run: () => ({ code: 1, stdout: "", stderr: "synthetic" }) },
    fetchJson: async () => {
      throw new Error("network must not be called in this test");
    },
    gitWorktreeListExecFn: () => "",
  };
}

async function runOnce(d, extra = {}) {
  return report.runPartialCountOnce({
    now: NOW,
    repoRoot: d.repoRoot,
    dispatchReceiptsPath: join(d.root, "none.jsonl"),
    watchLogPath: join(d.root, "none.log"),
    extraRepoRoots: [],
    archiveRoot: join(d.root, "archive-missing"),
    maxMergeChecks: 0,
    maxExternalEvidenceChecks: 0,
    ...fakePorts(),
    ...extra,
  });
}

test("end-to-end: 합성 보내는함 · 받는함 · 원장으로 보고서에 보조 관측 줄이 찍히고 커버리지 1/6 이다", async () => {
  const d = makeDirs();
  try {
    putFile(d.outbox, "2026-11-12-0900-게이트1-A.md", "x");
    putFile(d.outbox, "2026-11-12-1000-게이트1-B.md", "x");
    seedGate7(d);
    writeSyntheticLedger(d.repoRoot, {
      "HYK-A": rejectedRows(HARD_STOP_STREAK),
    });
    const result = await runOnce(d, { outboxDir: d.outbox, inboxDir: d.inbox });
    assert.match(
      result.reportText,
      /^- 보조 관측\(독립 아님\): ㄱ-1 2 · ㄱ-2 1 · ㄱ-6 1 · ㄱ-7 2$/m,
    );
    assert.match(result.reportText, /^- 독립 앵커 유형 커버리지: 1\/6$/m);
    assert.equal(result.gateAux.gate1.count, 2);
  } finally {
    cleanup(d.root);
  }
});

test("end-to-end: --outbox-dir 가 없으면(미결선) 보조 관측 줄 0개 · 읽기만 -- 합성 파일이 바뀌지 않는다", async () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, { "HYK-A": rejectedRows(2) });
    const ledgerPath = join(d.repoRoot, ".harness", "reject-streak.json");
    const before = fs.readFileSync(ledgerPath, "utf8");
    const result = await runOnce(d);
    assert.doesNotMatch(result.reportText, /보조 관측\(독립 아님\)/);
    const withDir = await runOnce(d, {
      outboxDir: d.outbox,
      inboxDir: d.inbox,
    });
    assert.match(withDir.reportText, /보조 관측\(독립 아님\)/);
    assert.equal(fs.readFileSync(ledgerPath, "utf8"), before);
  } finally {
    cleanup(d.root);
  }
});

test("end-to-end: 체인이 깨진 합성 원장 -> 보고서 줄에 «ㄱ-2 수집 실패(체인)» 가 찍히고 관측 건강 줄에 사유가 남는다", async () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(
      d.repoRoot,
      { "HYK-A": rejectedRows(2) },
      { tamperChain: tamperFirstEntryVerdict },
    );
    const result = await runOnce(d, { outboxDir: d.outbox, inboxDir: d.inbox });
    assert.match(result.reportText, /ㄱ-2 수집 실패\(체인\)/);
    assert.doesNotMatch(result.reportText, /ㄱ-2 0/);
    assert.match(
      result.reportText,
      /ㄱ보조관측수집기 FAIL\(.*ㄱ-2 FAIL\(체인: /,
    );
  } finally {
    cleanup(d.root);
  }
});
