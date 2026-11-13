// HYK-255-g7-token-diag-1 (coder-task.md §2) -- 커밋 2 시험.
//   ⓑ ㄱ-7 짝 키의 «상신HHMM» 토큰 경계 -- «상신» 바로 앞이 글자·숫자면
//      (미상신1530 · X상신1530 · 3상신1530) 키가 아니다. 구분자 · 이름 시작은 키다.
//      짝 키 정의는 한 곳(GATE7_PAIR_TOKEN_RE)이고 보조 ㄱ-7 · «기록 누락» 이 공용한다.
//   ⓒ 한 이름에 서로 다른 HHMM 토큰 둘 -- 현재 정의의 동작을 시험으로 고정한다.
// ⛔헛시험 금지: 프로덕션 export(collectGateAuxObservations · collectRelayLedger ·
// extractGate7PairTokens)를 직접 구동한다. 입력은 전부 mkdtemp 합성(보내는함 · 받는함)이며
// 실제 원장 · 관제실 · 받는함 · 네트워크 접촉은 0 이다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as report from "./partial-count-report.mjs";

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
  const root = tmpDir("nc-g7-token-");
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

const QUOTE_LINE = (n) => `[책임자 경유] 한용 «${n}번째 인용 문장입니다」\n`;

function collectAux(dirs) {
  return report.collectGateAuxObservations({
    repoRoot: dirs.repoRoot,
    outboxDir: dirs.outbox,
    inboxDir: dirs.inbox,
    windowStartMs: WINDOW_START,
    windowEndMs: NOW,
  });
}

function collectMissing(dirs) {
  fs.writeFileSync(
    join(dirs.relay, "전달-2026-11-01.md"),
    [
      "[책임자 경유 · 한용 확정 · #20261101-1000 · 2026-11-01 10:00 KST · 지시 · ㄱ-1]",
      "> 한용: «형식 시작을 만드는 항목»",
      "",
    ].join("\n"),
    "utf8",
  );
  return report.collectRelayLedger({
    relayGlob: join(dirs.relay, "전달-*.md").replace(/\\/g, "/"),
    outboxDir: dirs.outbox,
    inboxDir: dirs.inbox,
  });
}

// 이름 하나 · 받는함 상신들로 «보조 ㄱ-7 짝 수 · 기록 누락 · ㄴ 후보» 를 함께 잰다.
function measure({ outboxName, inboxNames }) {
  const d = makeDirs();
  try {
    for (const n of inboxNames) putFile(d.inbox, n, "x");
    putFile(d.outbox, outboxName, QUOTE_LINE(1));
    const missing = collectMissing(d);
    return {
      aux: collectAux(d).gate7.count,
      missing: missing.gate7MissingCount,
      candidates: missing.candidateCount,
    };
  } finally {
    cleanup(d.root);
  }
}

const INBOX_1530 = "2026-11-12-1530-상신-A.md";
const INBOX_1610 = "2026-11-12-1610-상신-B.md";

test("ⓑ «상신» 앞에 글자·숫자가 붙으면(미상신1530 · X상신1530 · a상신1530 · 3상신1530) 짝 키가 아니다 -- 보조 0 · 기록 누락 0 · 대응 없음 후보 1", () => {
  for (const prefix of ["미", "X", "a", "3", "비"]) {
    const outboxName = `2026-11-12-1535-게이트7-${prefix}상신1530-판정.md`;
    assert.deepEqual(
      measure({ outboxName, inboxNames: [INBOX_1530] }),
      { aux: 0, missing: 0, candidates: 1 },
      outboxName,
    );
  }
});

test("ⓑ «상신» 바로 앞이 구분자(- _ 공백 . ( [ +)이면 짝 키다 -- 보조 1 · 기록 누락 1 (두 계수 같은 결과)", () => {
  const closing = { "(": ")", "[": "]" };
  for (const sep of ["-", "_", " ", ".", "(", "[", "+"]) {
    const outboxName = `2026-11-12-1535-게이트7${sep}상신1530${closing[sep] ?? "-"}판정.md`;
    assert.deepEqual(
      measure({ outboxName, inboxNames: [INBOX_1530] }),
      { aux: 1, missing: 1, candidates: 0 },
      outboxName,
    );
  }
});

test("ⓑ 토큰 함수(extractGate7PairTokens)는 이름 시작의 «상신HHMM» 을 인정하고 접두 글자가 붙은 것은 거른다 -- 이름 시작도 경계다", () => {
  assert.deepEqual(report.extractGate7PairTokens("상신1530-메모.md"), ["1530"]);
  assert.deepEqual(report.extractGate7PairTokens("미상신1530-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("X상신1530-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("3상신1530-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("a-상신1530-메모.md"), [
    "1530",
  ]);
  // 기존 모양 무회귀: «판정-HHMM» 머리 · 5자리 · «상신-» 하이픈.
  assert.deepEqual(
    report.extractGate7PairTokens("2026-11-12-1605-판정-1600.md"),
    ["1600"],
  );
  assert.deepEqual(report.extractGate7PairTokens("a-상신19000-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("a-상신-1830-메모.md"), []);
});

test("ⓑ 현재 정의 고정: 날짜 머리(YYYY-MM-DD-HHMM)가 없는 이름은 «상신HHMM» 이 이름 시작이어도 짝 키가 아니다 (이름 시작 인정은 토큰 함수 수준)", () => {
  const d = makeDirs();
  try {
    putFile(d.inbox, INBOX_1530, "x");
    putFile(d.outbox, "상신1530-날짜머리없음.md", QUOTE_LINE(1));
    assert.equal(collectAux(d).gate7.count, 0);
    assert.equal(collectMissing(d).gate7MissingCount, 0);
  } finally {
    cleanup(d.root);
  }
});

test("ⓑ 정의 일치: 접두·구분자가 섞인 입력에서 보조 ㄱ-7 짝 수와 «기록 누락» 이 같은 값이다", () => {
  const d = makeDirs();
  try {
    putFile(d.inbox, INBOX_1530, "x");
    putFile(d.inbox, INBOX_1610, "x");
    putFile(d.inbox, "2026-11-12-1700-상신-C.md", "x");
    putFile(
      d.outbox,
      "2026-11-12-1535-게이트7-미상신1530-판정.md",
      QUOTE_LINE(1),
    );
    putFile(
      d.outbox,
      "2026-11-12-1615-게이트7-상신1610-판정.md",
      QUOTE_LINE(2),
    );
    putFile(
      d.outbox,
      "2026-11-12-1705-게이트7-X상신1700-판정.md",
      QUOTE_LINE(3),
    );
    const aux = collectAux(d).gate7.count;
    const missing = collectMissing(d);
    assert.equal(aux, 1, "경계를 통과한 1610 하나만");
    assert.equal(missing.gate7MissingCount, aux);
    assert.equal(missing.candidateCount, 2, "미상신 · X상신 은 대응 없음 후보");
  } finally {
    cleanup(d.root);
  }
});

// ⓒ 한 이름에 서로 다른 HHMM 토큰 둘.
//   현재 정의(partial-count-report.mjs): parseGate7PairKey 가 이름의 서로 다른 HHMM
//   «전부» 를 hhmms 집합에 담고(parseGate7PairKey), isGate7MissingCandidate 는 받는함
//   상신의 날짜 + HHMM 이 그 집합에 «들어 있으면» 짝으로 본다. 그러므로
//   · 두 토큰 모두 받는함 짝이 있으면 보조 ㄱ-7 는 «받는함 상신 파일 수» = 2 를 세고
//     (collectGate7AuxCell 은 받는함 파일 기준),
//   · «기록 누락» 은 보내는함 «항목 수» 기준이라 1 이다(classifySourceItems).
//   · 한쪽 토큰만 짝이어도 짝이다(첫 것만도 · 둘째만도 아니다 -- 있는 쪽 전부).
const TWO_TOKEN_NAME =
  "2026-11-12-1630-게이트7-상신1530-판정-상신1610-재판정.md";

test("ⓒ 한 이름에 서로 다른 HHMM 토큰 둘 · 받는함에 둘 다 짝: 보조 2(받는함 파일 수) · 기록 누락 1(보내는함 항목 수) · 후보 0", () => {
  assert.deepEqual(
    measure({
      outboxName: TWO_TOKEN_NAME,
      inboxNames: [INBOX_1530, INBOX_1610],
    }),
    { aux: 2, missing: 1, candidates: 0 },
  );
});

test("ⓒ 한 이름에 서로 다른 HHMM 토큰 둘 · 둘째 토큰만(또는 첫째만) 받는함 짝이어도 짝이다 -- 첫 것만 보지 않는다", () => {
  assert.deepEqual(
    measure({ outboxName: TWO_TOKEN_NAME, inboxNames: [INBOX_1610] }),
    { aux: 1, missing: 1, candidates: 0 },
    "둘째만",
  );
  assert.deepEqual(
    measure({ outboxName: TWO_TOKEN_NAME, inboxNames: [INBOX_1530] }),
    { aux: 1, missing: 1, candidates: 0 },
    "첫째만",
  );
});

test("ⓒ 한 이름에 서로 다른 HHMM 토큰 둘 · 받는함에 둘 다 짝이 없으면 거부가 아니라 «대응 없음 후보 1» 이다", () => {
  assert.deepEqual(
    measure({
      outboxName: TWO_TOKEN_NAME,
      inboxNames: ["2026-11-12-1700-상신-C.md"],
    }),
    { aux: 0, missing: 0, candidates: 1 },
  );
});

test("ⓒ 토큰 함수: 서로 다른 둘은 등장 순서대로 둘 · 같은 HHMM 반복은 1개(중복 0)", () => {
  assert.deepEqual(report.extractGate7PairTokens(TWO_TOKEN_NAME), [
    "1530",
    "1610",
  ]);
  assert.deepEqual(
    report.extractGate7PairTokens(
      "2026-11-12-1630-판정-1530-상신1530-상신1530.md",
    ),
    ["1530"],
  );
});
