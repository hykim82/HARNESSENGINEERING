// HYK-255-ln-update-branch-1 (coder-task.md §2 ⓑ · 커밋 2 · 책임자 판정 2026-11-13 17:0x 항목 2)
//   ㄱ-7 짝 키의 «판정-HHMM» 머리도 «상신HHMM» 과 같은 토큰 경계를 갖는다 -- 바로 앞이
//   글자·숫자(\p{L} · \p{N})면 키가 아니다(`…-미판정-1530` = 키 아님 · #370 검토 1R 상신
//   대상 ①). 구분자·기호·이름 시작이면 키다. 정의는 한 곳(GATE7_PAIR_TOKEN_RE)이고 보조
//   ㄱ-7 짝 수와 «기록 누락» 이 공용한다.
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
  const root = tmpDir("nc-g7-judg-");
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

test("ⓑ «판정-» 앞에 글자·숫자가 붙으면(미판정-1530 · X판정-1530 · a판정-1530 · 3판정-1530) 짝 키가 아니다 -- 보조 0 · 기록 누락 0 · 대응 없음 후보 1", () => {
  for (const prefix of ["미", "X", "a", "3", "비", "재"]) {
    const outboxName = `2026-11-12-1535-게이트7-${prefix}판정-1530.md`;
    assert.deepEqual(
      measure({ outboxName, inboxNames: [INBOX_1530] }),
      { aux: 0, missing: 0, candidates: 1 },
      outboxName,
    );
  }
});

test("ⓑ 반례(판정 1705 상신 대상 ①): «…-미판정-1530» 은 키가 아니다 -- 날짜 머리 뒤 이름 끝에 붙어도 같다", () => {
  assert.deepEqual(
    measure({
      outboxName: "2026-11-12-1535-미판정-1530.md",
      inboxNames: [INBOX_1530],
    }),
    { aux: 0, missing: 0, candidates: 1 },
  );
  assert.deepEqual(
    report.extractGate7PairTokens("2026-11-12-1535-미판정-1530.md"),
    [],
  );
});

test("ⓑ «판정-» 바로 앞이 구분자(- _ 공백 . ( [ +)이면 짝 키다 -- 보조 1 · 기록 누락 1 (두 계수 같은 결과)", () => {
  for (const sep of ["-", "_", " ", ".", "(", "[", "+"]) {
    const outboxName = `2026-11-12-1535-게이트7${sep}판정-1530-메모.md`;
    assert.deepEqual(
      measure({ outboxName, inboxNames: [INBOX_1530] }),
      { aux: 1, missing: 1, candidates: 0 },
      outboxName,
    );
  }
});

test("ⓑ 토큰 함수(extractGate7PairTokens): 이름 시작의 «판정-HHMM» 은 키 · 접두 글자·숫자가 붙은 것은 거른다 -- 이름 시작도 경계다", () => {
  assert.deepEqual(report.extractGate7PairTokens("판정-1530-메모.md"), [
    "1530",
  ]);
  assert.deepEqual(report.extractGate7PairTokens("미판정-1530-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("X판정-1530-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("3판정-1530-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("a-판정-1530-메모.md"), [
    "1530",
  ]);
  // 기존 모양 무회귀: 날짜 머리 뒤 «-판정-HHMM» · 5자리 · «판정» 뒤 하이픈 없음.
  assert.deepEqual(
    report.extractGate7PairTokens("2026-11-12-1605-판정-1600.md"),
    ["1600"],
  );
  assert.deepEqual(report.extractGate7PairTokens("a-판정-19000-메모.md"), []);
  assert.deepEqual(report.extractGate7PairTokens("a-판정1530-메모.md"), []);
});

test("ⓑ 한 정의 유지: «상신» 경계와 «판정-» 경계가 같은 함수 안에서 함께 동작한다 (접두가 붙은 쪽만 거르고 정상 토큰은 유지)", () => {
  assert.deepEqual(
    report.extractGate7PairTokens("2026-11-12-1630-미판정-1530-상신1610.md"),
    ["1610"],
  );
  assert.deepEqual(
    report.extractGate7PairTokens("2026-11-12-1630-판정-1530-미상신1610.md"),
    ["1530"],
  );
  assert.deepEqual(
    report.extractGate7PairTokens("2026-11-12-1630-미판정-1530-미상신1610.md"),
    [],
  );
});

test("ⓑ 정의 일치: 접두·구분자가 섞인 입력에서 보조 ㄱ-7 짝 수와 «기록 누락» 이 같은 값이다 (미판정 은 대응 없음 후보)", () => {
  const d = makeDirs();
  try {
    putFile(d.inbox, INBOX_1530, "x");
    putFile(d.inbox, INBOX_1610, "x");
    putFile(d.inbox, "2026-11-12-1700-상신-C.md", "x");
    putFile(d.outbox, "2026-11-12-1535-게이트7-미판정-1530.md", QUOTE_LINE(1));
    putFile(d.outbox, "2026-11-12-1615-게이트7-판정-1610.md", QUOTE_LINE(2));
    putFile(d.outbox, "2026-11-12-1705-게이트7-X판정-1700.md", QUOTE_LINE(3));
    const aux = collectAux(d).gate7.count;
    const missing = collectMissing(d);
    assert.equal(aux, 1, "경계를 통과한 1610 하나만");
    assert.equal(missing.gate7MissingCount, aux);
    assert.equal(missing.candidateCount, 2, "미판정 · X판정 은 대응 없음 후보");
  } finally {
    cleanup(d.root);
  }
});

test("ⓑ 현재 정의 고정: 날짜 머리(YYYY-MM-DD-HHMM)가 없는 이름은 «판정-HHMM» 이 이름 시작이어도 짝 키가 아니다 (이름 시작 인정은 토큰 함수 수준)", () => {
  const d = makeDirs();
  try {
    putFile(d.inbox, INBOX_1530, "x");
    putFile(d.outbox, "판정-1530-날짜머리없음.md", QUOTE_LINE(1));
    assert.equal(collectAux(d).gate7.count, 0);
    assert.equal(collectMissing(d).gate7MissingCount, 0);
  } finally {
    cleanup(d.root);
  }
});
