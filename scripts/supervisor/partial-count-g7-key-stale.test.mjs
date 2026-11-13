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
import { execFileSync } from "node:child_process";
import * as report from "./partial-count-report.mjs";
import * as core from "./partial-count-core.mjs";
import { runReachOnce } from "./reach-report.mjs";
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
  // HYK-255-g7-token-diag-1: 토큰 경계(lookbehind)가 «상신» 앞에 들어와 정규식 모양이
  // 바뀌었다 -- «판정-|상신)(\d{4})» 연속 문자열 대신 «상신)(\d{4})» 정의 1개 + 경계 존재.
  const defs = src.match(/상신\)\(\\d\{4\}\)/g) ?? [];
  assert.equal(defs.length, 1, `짝 키 토큰 정의가 ${defs.length}곳`);
  assert.ok(
    src.includes("(?<![\\p{L}\\p{N}])상신)(\\d{4})"),
    "토큰 경계(상신 앞 글자·숫자 금지)가 정의에 있다",
  );
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

// ---------------------------------------------------------------------------
// 커밋 3 -- D1 «외부 독립 증거 후보» 줄의 스테일 표기 + 통지는 확인 «증가»에만
//   · 미조회(예산 · rate limit · 조회 실패)로 확인을 못 한 회차에 «확인» 은 그 회차
//     REST 응답만 센다(캐시는 승인 권위 아님). 직전 확인값 + 마지막 확인 HH:MM 은
//     «확인» 과 구분된 표기로 «표시» 만 한다 -- 분자 · REST 는 무변.
//   · 직전 확인값과 시각 = 이미 쓰는 감시 상태 파일(reach-notify-state.json)의
//     `__externalEvidenceCandidates` 한 키({confirmed, atMs}).
// ---------------------------------------------------------------------------

const EXT_PREFIX = "- 외부 독립 증거 후보: ";
const STALE_AT_MS = Date.parse("2026-11-12T02:05:00.000Z"); // 2026-11-12 11:05 KST
const STATE_KEY = "__externalEvidenceCandidates";

function staleLine(confirmed, unchecked, stalePrevious) {
  return core.renderExternalEvidenceCandidateLine({
    known: true,
    confirmed,
    unchecked,
    stalePrevious,
  });
}

test("커밋3 렌더: 스테일 입력이 있으면 «확인 0 · 미조회 1 · ㄴ 분자 반영 · 스테일 표시(확인 아님): 직전 확인 1 · 마지막 확인 11:05 KST» (확인은 이번 회차 값 그대로)", () => {
  assert.equal(
    staleLine(0, 1, { confirmed: 1, atMs: STALE_AT_MS, nowMs: NOW }),
    `${EXT_PREFIX}확인 0 · 미조회 1 · ㄴ 분자 반영 · 스테일 표시(확인 아님): 직전 확인 1 · 마지막 확인 11:05 KST`,
  );
});

test("커밋3 렌더: 마지막 확인이 어제면 날짜를 붙이고(MM-DD HH:MM) · 시각을 모르면 «시각 미상» 이다 -- 스테일이 오늘 값처럼 읽히지 않는다", () => {
  assert.ok(
    staleLine(0, 2, {
      confirmed: 3,
      atMs: Date.parse("2026-11-11T14:50:00.000Z"),
      nowMs: NOW,
    }).endsWith("직전 확인 3 · 마지막 확인 11-11 23:50 KST"),
  );
  assert.ok(
    staleLine(0, 1, { confirmed: 1, atMs: null, nowMs: NOW }).endsWith(
      "직전 확인 1 · 마지막 확인 시각 미상",
    ),
  );
});

test("커밋3 렌더: 스테일 입력이 없으면 줄은 옛 문면 그대로다 (회귀 0)", () => {
  assert.equal(
    staleLine(1, 0, undefined),
    `${EXT_PREFIX}확인 1 · 미조회 0 · ㄴ 분자 반영`,
  );
});

test("커밋3 분자 무변: 스테일이 붙어도 ㄴ 확인 사건은 «확인 0건» · 커버리지 줄 무변 · 다른 줄은 한 글자도 안 바뀐다", () => {
  const plain = core.buildPartialCountReport(
    reportInput({
      externalEvidence: { known: true, confirmed: 0, unchecked: 1 },
    }),
  );
  const stale = core.buildPartialCountReport(
    reportInput({
      externalEvidence: {
        known: true,
        confirmed: 0,
        unchecked: 1,
        stalePrevious: { confirmed: 1, atMs: STALE_AT_MS, nowMs: NOW },
      },
    }),
  );
  assert.ok(stale.includes("- 외부 독립 증거로 확인된 사건: 확인 0건\n"));
  assert.ok(!stale.includes("외부 독립 증거로 확인된 사건: 1건"));
  const strip = (t) =>
    t
      .split("\n")
      .filter((l) => !l.startsWith(EXT_PREFIX))
      .join("\n");
  assert.equal(strip(stale), strip(plain), "후보 줄 말고는 무변");
  assert.ok(stale.includes("스테일 표시(확인 아님)"));
});

test("커밋3 파서 왕복: 스테일 줄도 «이번 회차 확인 · 미조회» 로 읽힌다 (직전 값은 확인으로 읽히지 않는다)", () => {
  const text = core.buildPartialCountReport(
    reportInput({
      externalEvidence: {
        known: true,
        confirmed: 0,
        unchecked: 1,
        stalePrevious: { confirmed: 1, atMs: STALE_AT_MS, nowMs: NOW },
      },
    }),
  );
  const parsed = core.parseExternalEvidenceCandidateLine(text);
  assert.equal(parsed.state, "count");
  assert.equal(parsed.confirmed, 0);
  assert.equal(parsed.unchecked, 1);
});

// ---- 감시 상태 파일에서 직전 확인값을 읽는 보고서 조립 (runPartialCountOnce) ----

function git(cwd, args, env = {}) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      ...env,
    },
  }).trim();
}

const REPO_FULL = "hykim82/HARNESSENGINEERING";
const ALLOWLIST_PATH = "scripts/supervisor/approver-allowlist.json";

// 합성 저장소 -- GitHub 웹 «Update branch» 병합 커밋 후보 1개가 origin/master 에 닿는다.
function buildCandidateRepo() {
  const dir = tmpDir("nc-g7-stale-repo-");
  git(dir, ["init", "-q"]);
  fs.mkdirSync(join(dir, "scripts", "supervisor"), { recursive: true });
  fs.writeFileSync(
    join(dir, ALLOWLIST_PATH),
    JSON.stringify({
      schema_version: "approver-allowlist/v1",
      repo: REPO_FULL,
      approvers: [{ login: "hykim82", id: 286230306 }],
    }),
    "utf8",
  );
  git(dir, ["add", "-A"]);
  const tree = git(dir, ["write-tree"]);
  const ident = (name, email, atMs) => ({
    GIT_AUTHOR_NAME: "hykim82",
    GIT_AUTHOR_EMAIL: "hykim82@users.noreply.github.com",
    GIT_AUTHOR_DATE: new Date(atMs).toISOString(),
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: new Date(atMs).toISOString(),
  });
  const human = (atMs) => ident("hykim82", "hykim82@example.com", atMs);
  const web = (atMs) => ident("GitHub", "noreply@github.com", atMs);
  const root = git(
    dir,
    ["commit-tree", tree, "-m", "root"],
    human(NOW - 100 * 24 * HOUR),
  );
  git(dir, ["remote", "add", "origin", `https://github.com/${REPO_FULL}.git`]);
  const work = git(
    dir,
    ["commit-tree", tree, "-p", root, "-m", "feat: work"],
    human(NOW - 90 * 24 * HOUR),
  );
  const candidate = git(
    dir,
    [
      "commit-tree",
      tree,
      "-p",
      work,
      "-p",
      root,
      "-m",
      "Merge branch 'master' into feat/x",
    ],
    web(NOW - 30 * 60 * 1000),
  );
  const mainline = git(
    dir,
    [
      "commit-tree",
      tree,
      "-p",
      root,
      "-p",
      candidate,
      "-m",
      "Merge pull request #1 from hykim82/feat-x",
    ],
    web(NOW - 5 * 60 * 1000),
  );
  git(dir, ["update-ref", "refs/remotes/origin/master", mainline]);
  return { dir, candidate };
}

function validPayload(sha) {
  return {
    sha,
    commit: {
      verification: { verified: true, reason: "valid" },
      committer: { name: "GitHub", email: "noreply@github.com" },
    },
    author: { login: "hykim82", id: 286230306 },
    committer: { login: "web-flow", id: 19864447 },
  };
}

function makeFetch(handler) {
  const calls = [];
  return {
    calls,
    fetchJson: async (opts) => {
      calls.push(opts);
      return handler(opts);
    },
  };
}

async function runWithState({ stateEntry, fetchHandler, extra = {} }) {
  const repo = buildCandidateRepo();
  const root = tmpDir("nc-g7-stale-run-");
  try {
    if (stateEntry !== undefined) {
      fs.writeFileSync(
        join(root, "reach-notify-state.json"),
        typeof stateEntry === "string"
          ? stateEntry
          : JSON.stringify({ [STATE_KEY]: stateEntry }),
        "utf8",
      );
    }
    const { fetchJson, calls } = makeFetch(fetchHandler);
    const result = await report.runPartialCountOnce({
      now: NOW,
      repoRoot: repo.dir,
      dispatchReceiptsPath: join(root, "none.jsonl"),
      watchLogPath: join(root, "watch.log"),
      extraRepoRoots: [],
      archiveRoot: join(root, "archive-missing"),
      maxMergeChecks: 0,
      fetchJson,
      git: report.createProcessGitPort(repo.dir),
      gitWorktreeListExecFn: () => "",
      ...extra,
    });
    const line = result.reportText
      .split("\n")
      .find((l) => l.startsWith(EXT_PREFIX));
    return { result, line, calls, candidate: repo.candidate };
  } finally {
    cleanup(root);
    cleanup(repo.dir);
  }
}

const rateLimited = () => ({
  ok: false,
  status: 403,
  json: null,
  linkHeader: null,
});
const confirmedResponse = ({ url }) => ({
  ok: true,
  status: 200,
  json: validPayload(url.split("/commits/")[1]),
  linkHeader: null,
});

test("커밋3 조립: 직전 확인 1 · 이번 회차 403(미조회) -> «확인 0 · 미조회 1» + 스테일 표시, REST 는 1 회뿐 · 분자 확인 0건", async () => {
  const { result, line, calls } = await runWithState({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
  });
  assert.equal(
    line,
    `${EXT_PREFIX}확인 0 · 미조회 1 · ㄴ 분자 반영 · 스테일 표시(확인 아님): 직전 확인 1 · 마지막 확인 11:05 KST`,
  );
  assert.equal(calls.length, 1, "REST 호출 수 무변(재시도 0)");
  assert.equal(result.externalEvidence.confirmed, 0, "직전 값은 확인이 아니다");
  assert.ok(
    result.reportText.includes("- 외부 독립 증거로 확인된 사건: 확인 0건\n"),
  );
});

test("커밋3 조립: 예산 미조회(상한 0 -> REST 0회) 에도 스테일이 붙는다", async () => {
  const { line, calls } = await runWithState({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: rateLimited,
    extra: { maxExternalEvidenceChecks: 0 },
  });
  assert.equal(calls.length, 0);
  assert.ok(
    line.includes("확인 0 · 미조회 1 · ㄴ 분자 반영 · 스테일 표시"),
    line,
  );
});

test("커밋3 조립: 조회 실패(HTTP 500) 미조회에도 스테일이 붙는다", async () => {
  const { line } = await runWithState({
    stateEntry: { confirmed: 2, atMs: STALE_AT_MS },
    fetchHandler: () => ({
      ok: false,
      status: 500,
      json: null,
      linkHeader: null,
    }),
  });
  assert.ok(line.includes("직전 확인 2 · 마지막 확인 11:05 KST"), line);
});

test("커밋3 조립: 이번 회차 REST 가 확인하면 스테일 없이 옛 문면 그대로다 (확인 1 · 미조회 0)", async () => {
  const { line, result } = await runWithState({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: confirmedResponse,
  });
  assert.equal(line, `${EXT_PREFIX}확인 1 · 미조회 0 · ㄴ 분자 반영`);
  assert.equal(result.externalEvidence.confirmed, 1);
});

test("커밋3 조립: 전부 조회했는데 확인이 줄었으면(미조회 0) 진짜 감소다 -- 스테일이 아니다", async () => {
  const { line } = await runWithState({
    stateEntry: { confirmed: 1, atMs: STALE_AT_MS },
    fetchHandler: ({ url }) => ({
      ok: true,
      status: 200,
      json: {
        ...validPayload(url.split("/commits/")[1]),
        commit: { verification: { verified: false, reason: "unsigned" } },
      },
      linkHeader: null,
    }),
  });
  assert.equal(line, `${EXT_PREFIX}확인 0 · 미조회 0 · ㄴ 분자 반영`);
});

test("커밋3 조립: 상태 파일이 없거나 · 깨졌거나 · 직전 확인이 0 이면 스테일 없음 (옛 문면)", async () => {
  for (const stateEntry of [
    undefined,
    "{ not json",
    { confirmed: 0 },
    { confirmed: "1" },
  ]) {
    const { line } = await runWithState({
      stateEntry,
      fetchHandler: rateLimited,
    });
    assert.equal(
      line,
      `${EXT_PREFIX}확인 0 · 미조회 1 · ㄴ 분자 반영`,
      JSON.stringify(stateEntry),
    );
  }
});

test("커밋3 조립: 직전 확인 시각을 모르는 옛 상태({confirmed:1})도 스테일은 «시각 미상» 으로 표시된다", async () => {
  const { line } = await runWithState({
    stateEntry: { confirmed: 1 },
    fetchHandler: rateLimited,
  });
  assert.ok(line.endsWith("직전 확인 1 · 마지막 확인 시각 미상"), line);
});

// ---- reach-report 통지: 확인 «증가» 에만 ---------------------------------

function writeReachFixture(root, extLine) {
  const watchLogPath = join(root, "watch.log");
  const t0 = Date.parse("2026-11-12T00:00:00.000Z");
  if (!fs.existsSync(watchLogPath)) {
    fs.writeFileSync(
      watchLogPath,
      `${new Date(t0).toISOString()} exit=0 verdict=PROGRESSING reason=OK ` +
        `seat_status=SEAT_LIVENESS_NOT_APPLICABLE seat_verdict=NONE seat_worst_count=NONE seat_worktrees=1 ` +
        `idle_status=SEAT_IDLE_NOT_APPLICABLE idle_verdict=NONE idle_worst_count=NONE idle_worktrees=1 ` +
        `start_status=DISPATCH_START_NOT_APPLICABLE start_verdict=NONE start_worst_count=NONE start_worktrees=1 ` +
        `unconsumed_status=UNCONSUMED_NOT_APPLICABLE unconsumed_verdict=NONE unconsumed_worst_count=NONE unconsumed_worktrees=1`,
      "utf8",
    );
  }
  fs.writeFileSync(
    join(root, "partial-count-report.md"),
    [
      "집계 성격: PARTIAL — 전수 아님",
      "생성 시각: 2026-11-12 09:00:00 KST",
      "ㄴ 계획 밖 개입:",
      "- 외부 독립 증거로 확인된 사건: 확인 0건",
      extLine,
      "관측 건강:",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    root,
    watchLogPath,
    partialCountPath: join(root, "partial-count-report.md"),
    reportOutPath: join(root, "morning-report.md"),
    statePath: join(root, "state.json"),
    notifyDir: join(root, "받는함"),
    now: t0 + 3_600_000,
  };
}

function tick(fx, extLine, offsetMs) {
  writeReachFixture(fx.root, extLine);
  return runReachOnce({
    watchLogPath: fx.watchLogPath,
    partialCountPath: fx.partialCountPath,
    reportOutPath: fx.reportOutPath,
    statePath: fx.statePath,
    notifyDir: fx.notifyDir,
    now: fx.now + offsetMs,
  });
}

function notices(fx) {
  return fs.existsSync(fx.notifyDir) ? fs.readdirSync(fx.notifyDir) : [];
}

function stateEntry(fx) {
  return JSON.parse(fs.readFileSync(fx.statePath, "utf8"))[STATE_KEY];
}

const EXT = (n, u = 0) => `${EXT_PREFIX}확인 ${n} · 미조회 ${u} · ㄴ 분자 반영`;
const EXT_STALE = (u, prev) =>
  staleLine(0, u, { confirmed: prev, atMs: STALE_AT_MS, nowMs: NOW });

function reachFx() {
  const root = tmpDir("nc-g7-reach-");
  return { ...writeReachFixture(root, EXT(0)), root };
}

test("커밋3 통지: 1 -> (미조회로 0) -> 1 흔들림은 통지 0장 (처음 1 의 기준선 통지 1장만 있다)", () => {
  const fx = reachFx();
  try {
    assert.ok(tick(fx, EXT(1), 0).noticePath, "첫 관측 N>0 -- 통지 1장");
    assert.equal(notices(fx).length, 1);
    assert.equal(tick(fx, EXT(0, 3), 1000).noticePath, null, "1 -> 0(미조회)");
    assert.equal(
      tick(fx, EXT(1, 0), 2000).noticePath,
      null,
      "0 -> 1 로 돌아옴",
    );
    assert.equal(tick(fx, EXT(0, 3), 3000).noticePath, null);
    assert.equal(tick(fx, EXT(1, 0), 4000).noticePath, null);
    assert.equal(notices(fx).length, 1, "매 회차 통지 0");
  } finally {
    cleanup(fx.root);
  }
});

test("커밋3 통지: 스테일 줄(production 렌더)도 같다 -- 미조회 회차에 통지 0장이고 직전 확인값 · 시각은 상태 파일에 그대로 남는다", () => {
  const fx = reachFx();
  try {
    tick(fx, EXT(1), 0);
    const before = stateEntry(fx);
    assert.deepEqual(before, { confirmed: 1, atMs: fx.now });
    assert.equal(tick(fx, EXT_STALE(1, 1), 5000).noticePath, null);
    assert.deepEqual(
      stateEntry(fx),
      before,
      "미조회 회차는 기준선 · 시각을 지우지 않는다",
    );
    assert.equal(notices(fx).length, 1);
  } finally {
    cleanup(fx.root);
  }
});

test("커밋3 통지: 0 -> 1 은 1장 · 1 -> 2 는 1장 · 같은 값 반복은 0장", () => {
  const fx = reachFx();
  try {
    assert.equal(tick(fx, EXT(0), 0).noticePath, null, "기준선 0");
    assert.ok(tick(fx, EXT(1, 0), 1000).noticePath, "0 -> 1");
    assert.equal(notices(fx).length, 1);
    assert.equal(tick(fx, EXT(1, 0), 2000).noticePath, null);
    const up = tick(fx, EXT(2, 0), 3000);
    assert.ok(up.noticePath, "1 -> 2");
    assert.equal(notices(fx).length, 2);
    assert.match(fs.readFileSync(up.noticePath, "utf8"), /1 -> 2/);
  } finally {
    cleanup(fx.root);
  }
});

test("커밋3 통지: 감소는 통지 0장 -- 전부 조회한 진짜 감소(2 -> 1)는 기준선을 낮추고, 미조회 감소는 기준선을 지키며, 낮아진 뒤 다시 오르면 증가다", () => {
  const fx = reachFx();
  try {
    tick(fx, EXT(2), 0);
    assert.equal(notices(fx).length, 1);
    assert.equal(tick(fx, EXT(1, 1), 1000).noticePath, null, "미조회 감소");
    assert.equal(stateEntry(fx).confirmed, 2, "미조회 감소는 기준선 유지");
    assert.equal(
      tick(fx, EXT(2, 0), 2000).noticePath,
      null,
      "기준선 복귀 -- 증가 아님",
    );
    assert.equal(tick(fx, EXT(1, 0), 3000).noticePath, null, "진짜 감소");
    assert.equal(stateEntry(fx).confirmed, 1, "진짜 감소는 기준선을 낮춘다");
    assert.ok(tick(fx, EXT(2, 0), 4000).noticePath, "낮아진 뒤 1 -> 2 는 증가");
    assert.equal(notices(fx).length, 2);
  } finally {
    cleanup(fx.root);
  }
});

test("커밋3 통지: 직전 확인 시각은 «이번 회차에 값이 확인된» 회차에만 갱신된다 (같은 값 재확인 -> 갱신 · 미조회 -> 유지)", () => {
  const fx = reachFx();
  try {
    tick(fx, EXT(1), 0);
    tick(fx, EXT(0, 2), 10_000);
    assert.equal(
      stateEntry(fx).atMs,
      fx.now,
      "미조회 회차는 시각을 올리지 않는다",
    );
    tick(fx, EXT(1, 0), 20_000);
    assert.equal(
      stateEntry(fx).atMs,
      fx.now + 20_000,
      "다시 확인되면 시각 갱신",
    );
  } finally {
    cleanup(fx.root);
  }
});

test("커밋3 통지: 수집 실패 · 줄 없음 은 여전히 통지 0장이고 기준선 · 시각이 유지된다 (무회귀)", () => {
  const fx = reachFx();
  try {
    tick(fx, EXT(1), 0);
    const before = stateEntry(fx);
    assert.equal(tick(fx, `${EXT_PREFIX}수집 실패(x)`, 1000).noticePath, null);
    assert.deepEqual(stateEntry(fx), before);
  } finally {
    cleanup(fx.root);
  }
});
