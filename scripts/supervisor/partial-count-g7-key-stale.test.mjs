// HYK-255-g7-key-stale-1 (coder-task.md §2) -- D5 묶음 계약 시험.
//   커밋 1 = ㄱ-7 짝 키: 보내는함 판정 파일 이름의 «판정-HHMM» 머리 «또는» 이름
//            어디든 «상신HHMM» 토큰이 짝 키다. 같은 키를 D2 보조 ㄱ-7 짝 수와 기존
//            «ㄱ-7 기록 누락» 계수가 «한 정의»에서 읽는다.
//   커밋 2 = 시각 불명 전이가 보조 칸에 표면화되는 반례(#366 검토 P2-2).
//   커밋 3 = D1 «외부 독립 증거 후보» 줄의 스테일 표기 + 통지는 확인 «증가»에만.
// ⛔헛시험 금지: 프로덕션 export(collectGateAuxObservations · collectRelayLedger ·
// renderGateAuxObservationLine · buildPartialCountReport · runPartialCountOnce ·
// runReachOnce)를 직접 구동한다. 입력은 전부 mkdtemp 합성(보내는함 · 받는함 ·
// 원장 · 상태 파일 · 주입 가짜 fetchJson)이며, 실제 원장 · 관제실 · 받는함 · 네트워크
// 접촉은 0 이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as report from "./partial-count-report.mjs";
import * as core from "./partial-count-core.mjs";
import { catchUpCheckpoints } from "../check/reject-streak-chain.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-12T10:00:00.000Z"); // 2026-11-12 19:00 KST
const WINDOW_START = NOW - 24 * HOUR;
const IN_WINDOW_MS = NOW - 2 * HOUR;

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function putFile(dir, name, text, mtimeMs = IN_WINDOW_MS) {
  const full = join(dir, name);
  fs.writeFileSync(full, text, "utf8");
  fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
}

function makeDirs() {
  const root = tmpDir("nc-g7-key-");
  const dirs = {
    root,
    repoRoot: join(root, "repo"),
    outbox: join(root, "보내는함"),
    inbox: join(root, "받는함"),
    relay: join(root, "기록"),
  };
  for (const d of [dirs.repoRoot, dirs.outbox, dirs.inbox, dirs.relay]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return dirs;
}

// issues = { "HYK-1": [["rejected", "2026-11-12 10:00 KST" | undefined], ...] } ->
// 합성 원장 + 올바른 해시 체인(실제 reject-streak-chain 의 catchUpCheckpoints).
function writeSyntheticLedger(repoRoot, issues) {
  const harnessDir = join(repoRoot, ".harness");
  fs.mkdirSync(harnessDir, { recursive: true });
  const ledger = { schema_version: 1, issues: {} };
  for (const [issueId, rows] of Object.entries(issues)) {
    let streak = 0;
    const history = rows.map(([verdict, at], i) => {
      streak = verdict === "rejected" ? streak + 1 : 0;
      const entry = { task_id: `${issueId}-coder-${i + 1}`, verdict };
      if (at !== undefined) entry.at = at;
      return entry;
    });
    ledger.issues[issueId] = { streak, history };
  }
  let chain = { schema_version: 1, issues: {} };
  for (const issueId of Object.keys(ledger.issues)) {
    chain = catchUpCheckpoints(ledger, chain, issueId);
  }
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

function collectAux(dirs) {
  return report.collectGateAuxObservations({
    repoRoot: dirs.repoRoot,
    outboxDir: dirs.outbox,
    inboxDir: dirs.inbox,
    windowStartMs: WINDOW_START,
    windowEndMs: NOW,
  });
}

// ---------------------------------------------------------------------------
// 커밋 1 -- ㄱ-7 짝 키
// ---------------------------------------------------------------------------

const QUOTE_LINE = (n) => `[책임자 경유] 한용 «${n}번째 인용 문장입니다」\n`;

function writeRelayFormatStart(relayDir) {
  // 형식 머리줄이 1개 있어야 «형식 시작» 이 잡혀 항목이 형식 이전으로 빠지지 않는다.
  fs.writeFileSync(
    join(relayDir, "전달-2026-11-01.md"),
    [
      "[책임자 경유 · 한용 확정 · #20261101-1000 · 2026-11-01 10:00 KST · 지시 · ㄱ-1]",
      "> 한용: «형식 시작을 만드는 항목»",
      "",
    ].join("\n"),
    "utf8",
  );
}

function collectMissing(dirs) {
  writeRelayFormatStart(dirs.relay);
  return report.collectRelayLedger({
    relayGlob: join(dirs.relay, "전달-*.md").replace(/\\/g, "/"),
    outboxDir: dirs.outbox,
    inboxDir: dirs.inbox,
  });
}

// 받는함 «상신» 6 · 보내는함 판정 6(새 모양 · 옛 모양 · 두 모양 한 이름 · 함정 3).
function seedKeyShapes(d) {
  putFile(d.inbox, "2026-11-12-1530-상신-A.md", "x");
  putFile(d.inbox, "2026-11-12-1600-상신-B.md", "x");
  putFile(d.inbox, "2026-11-12-1700-상신-C.md", "x");
  putFile(d.inbox, "2026-11-12-1800-상신-D.md", "x");
  putFile(d.inbox, "2026-11-12-1830-상신-E.md", "x");
  putFile(d.inbox, "2026-11-12-1900-상신-F.md", "x");
  // 새 모양: 이름 어디든 «상신HHMM» 토큰(날짜 = 이름 머리).
  putFile(d.outbox, "2026-11-12-1535-게이트7-상신1530-판정.md", QUOTE_LINE(1));
  // 옛 모양: «판정-HHMM».
  putFile(d.outbox, "2026-11-12-1605-판정-1600.md", QUOTE_LINE(2));
  // 두 모양이 한 이름에 같이 -> 짝 1(중복 0).
  putFile(d.outbox, "2026-11-12-1705-판정-1700-상신1700.md", QUOTE_LINE(3));
  // 숫자 함정 3: «상신» 뒤가 아닌 4자리 · «상신-» 하이픈 · «상신» 뒤 5자리.
  putFile(d.outbox, "2026-11-12-1805-게이트7-1800-메모.md", QUOTE_LINE(4));
  putFile(d.outbox, "2026-11-12-1835-상신-1830-메모.md", QUOTE_LINE(5));
  putFile(d.outbox, "2026-11-12-1905-상신19000-메모.md", QUOTE_LINE(6));
}

test("커밋1 새 모양: «…-상신HHMM-…» 이름만 있는 판정도 보조 ㄱ-7 짝 1 · 기록 누락 1 (둘 다)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    putFile(d.inbox, "2026-11-12-1530-상신-A.md", "x");
    putFile(
      d.outbox,
      "2026-11-12-1535-게이트7-상신1530-판정.md",
      QUOTE_LINE(1),
    );
    assert.equal(collectAux(d).gate7.count, 1, "보조 ㄱ-7 짝");
    const r = collectMissing(d);
    assert.equal(r.known, true);
    assert.equal(r.gate7MissingCount, 1, "ㄱ-7 기록 누락");
    assert.equal(r.candidateCount, 0, "짝이 있으면 ㄴ 후보가 아니다");
  } finally {
    cleanup(d.root);
  }
});

test("커밋1 옛 모양: «판정-HHMM» 머리는 여전히 짝 1 (보조 · 기록 누락 둘 다)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    putFile(d.inbox, "2026-11-12-1600-상신-B.md", "x");
    putFile(d.outbox, "2026-11-12-1605-판정-1600.md", QUOTE_LINE(2));
    assert.equal(collectAux(d).gate7.count, 1);
    assert.equal(collectMissing(d).gate7MissingCount, 1);
  } finally {
    cleanup(d.root);
  }
});

test("커밋1 두 모양이 한 이름에 같이 있으면 짝 1 (중복 0)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    putFile(d.inbox, "2026-11-12-1700-상신-C.md", "x");
    putFile(d.outbox, "2026-11-12-1705-판정-1700-상신1700.md", QUOTE_LINE(3));
    assert.equal(collectAux(d).gate7.count, 1);
    assert.equal(collectMissing(d).gate7MissingCount, 1);
  } finally {
    cleanup(d.root);
  }
});

test("커밋1 숫자 함정: «상신» 뒤가 아닌 4자리 · «상신-1830» · «상신19000» 은 키가 아니다 (보조 0 · 기록 누락 0 · 대응 없음 3)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    putFile(d.inbox, "2026-11-12-1800-상신-D.md", "x");
    putFile(d.inbox, "2026-11-12-1830-상신-E.md", "x");
    putFile(d.inbox, "2026-11-12-1900-상신-F.md", "x");
    putFile(d.outbox, "2026-11-12-1805-게이트7-1800-메모.md", QUOTE_LINE(4));
    putFile(d.outbox, "2026-11-12-1835-상신-1830-메모.md", QUOTE_LINE(5));
    putFile(d.outbox, "2026-11-12-1905-상신19000-메모.md", QUOTE_LINE(6));
    assert.equal(collectAux(d).gate7.count, 0, "보조 ㄱ-7 짝");
    const r = collectMissing(d);
    assert.equal(r.gate7MissingCount, 0, "ㄱ-7 기록 누락");
    assert.equal(r.candidateCount, 3, "함정 이름은 짝이 아니라 대응 없음 후보");
  } finally {
    cleanup(d.root);
  }
});

test("커밋1 날짜는 이름 머리 구조 토큰이다: 다른 날 같은 HHMM 의 «상신HHMM» 판정은 짝이 아니다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    putFile(d.inbox, "2026-11-12-1530-상신-A.md", "x");
    putFile(
      d.outbox,
      "2026-11-11-1535-게이트7-상신1530-판정.md",
      QUOTE_LINE(1),
    );
    assert.equal(collectAux(d).gate7.count, 0);
    assert.equal(collectMissing(d).gate7MissingCount, 0);
  } finally {
    cleanup(d.root);
  }
});

test("커밋1 정의 일치: 같은 입력(6 모양)에서 보조 ㄱ-7 짝 집합과 «기록 누락» 이 같은 3 건이다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {});
    seedKeyShapes(d);
    const aux = collectAux(d).gate7.count;
    const missing = collectMissing(d).gate7MissingCount;
    assert.equal(aux, 3, "새 모양 1 + 옛 모양 1 + 두 모양 한 이름 1");
    assert.equal(missing, aux, "두 계수가 같은 짝 집합을 센다");
  } finally {
    cleanup(d.root);
  }
});

test("커밋1 짝 키 정의는 소스에 «한 곳» 이다 (상신HHMM 토큰 정규식 정의 1개)", () => {
  const src = fs.readFileSync(
    new URL("./partial-count-report.mjs", import.meta.url),
    "utf8",
  );
  const defs = src.match(/판정-\|상신\)\(\\d\{4\}\)/g) ?? [];
  assert.equal(defs.length, 1, `짝 키 토큰 정의가 ${defs.length}곳`);
  assert.ok(!src.includes("OUTBOX_PANJEONG_HHMM_RE"), "옛 정의가 남아 있다");
});

// ---------------------------------------------------------------------------
// 커밋 2 -- 시각 불명 전이(원장 항목 `at` 를 못 읽음)가 보조 칸에 표면화된다
// (#366 검토 P2-2 -- 이 칸이 없으면 undated 계수를 지워도 시험이 안 깨진다)
// ---------------------------------------------------------------------------

const AUX_PREFIX = "- 보조 관측(독립 아님): ";
const DATED_IN_WINDOW = "2026-11-12 09:00 KST"; // 창 안(창 = 11-11 19:00 ~ 11-12 19:00 KST)

function rows(...ats) {
  return ats.map((at) => ["rejected", at]);
}

function reportWithAux(aux) {
  return core.buildPartialCountReport(reportInput({ gateAuxObservation: aux }));
}

function reportInput(extra = {}) {
  return {
    generatedAtMs: NOW,
    windowStartMs: WINDOW_START,
    windowEndMs: NOW,
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

test("커밋2 시각 불명: 2 에 닿는 반려 항목의 `at` 가 없으면 ㄱ-2 는 count 0 · undated 1 이고 «시각 불명 1건» 이 줄에 나온다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-U": rows(DATED_IN_WINDOW, undefined),
    });
    const aux = collectAux(d);
    assert.deepEqual(
      {
        known: aux.gate2.known,
        count: aux.gate2.count,
        undated: aux.gate2.undated,
      },
      { known: true, count: 0, undated: 1 },
    );
    assert.equal(
      core.renderGateAuxObservationLine(aux),
      `${AUX_PREFIX}ㄱ-1 0 · ㄱ-2 0(시각 불명 1건) · ㄱ-6 0 · ㄱ-7 0`,
    );
  } finally {
    cleanup(d.root);
  }
});

test("커밋2 시각 불명: `at` 가 있지만 읽을 수 없는 모양(KST 형식 아님)도 시각 불명이다 -- 창 밖으로 접히지 않는다", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-BAD": rows(DATED_IN_WINDOW, "어제 오후 3시경"),
    });
    const aux = collectAux(d);
    assert.equal(aux.gate2.count, 0);
    assert.equal(aux.gate2.undated, 1);
  } finally {
    cleanup(d.root);
  }
});

test("커밋2 시각 불명은 읽은 전이와 따로 센다: 창 안 전이 1 + 시각 불명 1 -> «ㄱ-2 1(시각 불명 1건)» (서로의 칸에 섞이지 않는다)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-D": rows(DATED_IN_WINDOW, "2026-11-12 10:00 KST"),
      "HYK-U": rows(DATED_IN_WINDOW, undefined),
    });
    const aux = collectAux(d);
    assert.equal(aux.gate2.count, 1, "읽은 전이만 count");
    assert.equal(aux.gate2.undated, 1, "못 읽은 전이만 undated");
    assert.ok(
      core.renderGateAuxObservationLine(aux).includes("ㄱ-2 1(시각 불명 1건)"),
    );
  } finally {
    cleanup(d.root);
  }
});

test("커밋2 시각 불명은 ㄱ-6 칸에도 표면화된다 (4 번째 반려 `at` 불명 -> ㄱ-6 0(시각 불명 1건) · ㄱ-2 는 2 번째 반려가 읽혀 1)", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-S": rows(
        "2026-11-12 08:00 KST",
        "2026-11-12 09:00 KST",
        "2026-11-12 10:00 KST",
        undefined,
      ),
    });
    const aux = collectAux(d);
    assert.deepEqual(
      { count: aux.gate2.count, undated: aux.gate2.undated },
      { count: 1, undated: 0 },
    );
    assert.deepEqual(
      { count: aux.gate6.count, undated: aux.gate6.undated },
      { count: 0, undated: 1 },
    );
    assert.ok(
      core.renderGateAuxObservationLine(aux).includes("ㄱ-6 0(시각 불명 1건)"),
    );
  } finally {
    cleanup(d.root);
  }
});

test("커밋2 시각 불명 칸은 보고서 본문(buildPartialCountReport)의 보조 관측 줄에 그대로 실린다 -- 독립 커버리지 줄은 무변", () => {
  const d = makeDirs();
  try {
    writeSyntheticLedger(d.repoRoot, {
      "HYK-U": rows(DATED_IN_WINDOW, undefined),
    });
    const withUndated = reportWithAux(collectAux(d));
    assert.ok(
      withUndated.includes(
        `${AUX_PREFIX}ㄱ-1 0 · ㄱ-2 0(시각 불명 1건) · ㄱ-6 0 · ㄱ-7 0\n`,
      ),
      withUndated,
    );
    const clean = reportWithAux(
      (() => {
        writeSyntheticLedger(d.repoRoot, {});
        return collectAux(d);
      })(),
    );
    assert.ok(!clean.includes("시각 불명"), "원장이 비면 칸도 없다");
    const coverage = (text) =>
      text.split("\n").find((l) => l.startsWith("- 독립 앵커 유형 커버리지"));
    assert.equal(coverage(withUndated), coverage(clean));
  } finally {
    cleanup(d.root);
  }
});
