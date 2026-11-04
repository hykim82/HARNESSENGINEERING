// HYK-255-relay-aux-4(게이트 2 판정 A, 1604 상신 답 · coder-task.md §2 ⓑ)
// -- 정규식 밖 `[책임자 경유 · ` 줄 하나의 "own 시각"(줄 안 토큰 -> 없으면
// 전달 파일 이름의 날짜 -> 둘 다 없으면 시각 미정) 대 형식 시작 시각으로
// 형식 오류 E/형식 이전/시각 미정을 줄 단위로 가르는 계약을 고정한다.
// ⛔공허 시험 금지: collectRelayLedger·renderRelayLedgerAuxLines·
// runPartialCountStep(전부 프로덕션 export, partial-count-report.mjs·
// partial-count-core.mjs·watch-run.mjs) 를 직접 구동한다 -- 이 파일 안의
// 헬퍼는 fixture 작성용 I/O뿐이고 판정 로직 자체는 재구현하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectRelayLedger } from "./partial-count-report.mjs";
import { renderRelayLedgerAuxLines } from "./partial-count-core.mjs";
import { runPartialCountStep } from "./watch-run.mjs";

const NOW = Date.parse("2026-11-04T08:00:00.000Z");

function tmpDir(prefix) {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

// coder-task.md §2 ⓑ⑴→⑵→⑶ -- 같은 폴더에 누적(실물 모양). 각 단계마다
// collectRelayLedger(ㄴ 절 값)와 runPartialCountStep(통지)을 둘 다 실제로
// 구동해, "형식 시작 전 옛 줄은 E 0" -> "첫 유효 머리줄을 더해도 E
// 불변·통지 0(옛 줄 소급 없음)" -> "형식 시작 뒤에 새로 생긴 정규식 밖
// 줄만 E 1·통지 1"의 전체 사슬을 한 폴더에서 증명한다. 세 단계를 별도
// 함수로 뽑은 이유는 eslint max-lines-per-function 예산(이 파일의 다른
// 수집기 분리와 같은 이유) -- 로직은 그대로다.

// ⑴ 옛 형식 전달 파일 1편(파일 이름 날짜 = 형식 시작 두 달 전) ·
// 정규식 밖 줄 2 · 유효 머리줄 0.
async function checkStep1({
  relayGlob,
  outboxDir,
  inboxDir,
  relayDir,
  watchDir,
  notifyDir,
}) {
  fs.writeFileSync(
    join(relayDir, "전달-2026-09-01-옛형식.md"),
    [
      "[책임자 경유 · 한용 확정] 옛 형식 줄 1",
      "[책임자 경유 · B-9] 옛 형식 줄 2",
      "",
    ].join("\n"),
    "utf8",
  );
  const r1 = collectRelayLedger({ relayGlob, outboxDir, inboxDir });
  assert.equal(r1.known, true);
  assert.equal(r1.formatErrorCount, 0);
  assert.equal(r1.beforeFormatCount, 2);
  assert.equal(r1.undeterminedCount, 0);
  const aux1 = renderRelayLedgerAuxLines(r1);
  assert.ok(aux1[0].includes("형식 오류 0건"));
  assert.ok(aux1[0].includes("형식 이전 구간 미계수 2건"));

  const step1 = await runPartialCountStep({
    watchDir,
    now: NOW,
    notifyDir,
    runPartialCountOnceFn: async () => ({
      reportText: "집계 성격: PARTIAL — 전수 아님\n⑴\n",
      relayResult: r1,
    }),
  });
  assert.equal(step1.relayNotify.attempted, true);
  assert.equal(
    fs.readdirSync(notifyDir).length,
    1,
    "⑴ 최초 회차는 상태 기준선을 세우며 통지 1건을 낸다",
  );
}

// ⑵ 같은 폴더에 첫 유효 머리줄 1편을 추가(옛 줄 무변) -- 형식 시작 =
// 2026-11-03 21:40. 판정 원문 "소급 0" -- 옛 두 줄은 여전히 형식 이전.
async function checkStep2({
  relayGlob,
  outboxDir,
  inboxDir,
  relayDir,
  watchDir,
  notifyDir,
}) {
  fs.writeFileSync(
    join(relayDir, "전달-2026-11-03-형식시작.md"),
    [
      "[책임자 경유 · 한용 확정 · #20261103-2140 · 2026-11-03 21:40 KST · 지시 · ㄱ-2]",
      "> 한용: «형식 시작»",
      "",
    ].join("\n"),
    "utf8",
  );
  const r2 = collectRelayLedger({ relayGlob, outboxDir, inboxDir });
  assert.equal(r2.known, true);
  assert.equal(r2.formatErrorCount, 0, "옛 줄 E 증가 0");
  assert.equal(r2.beforeFormatCount, 2, "형식 이전 2 그대로");
  assert.equal(r2.undeterminedCount, 0);
  const aux2 = renderRelayLedgerAuxLines(r2);
  assert.ok(aux2[0].includes("형식 오류 0건"));

  const step2 = await runPartialCountStep({
    watchDir,
    now: NOW + 1000,
    notifyDir,
    runPartialCountOnceFn: async () => ({
      reportText: "집계 성격: PARTIAL — 전수 아님\n⑵\n",
      relayResult: r2,
    }),
  });
  assert.equal(step2.relayNotify.suppressed, true);
  assert.equal(
    fs.readdirSync(notifyDir).length,
    1,
    "값이 안 바뀌었으니 통지 0(파일 수 그대로 1)",
  );
}

// ⑶ 형식 시작 "뒤" 시각 토큰(2026-11-04 08:00 > 형식 시작 21:40)을
// 가진 정규식 밖 줄 1개를 새로 추가 -- 이 줄만 E.
async function checkStep3({
  relayGlob,
  outboxDir,
  inboxDir,
  relayDir,
  watchDir,
  notifyDir,
}) {
  fs.writeFileSync(
    join(relayDir, "전달-2026-11-04-추가.md"),
    ["[책임자 경유 · 형식 깨짐] 2026-11-04 08:00 메모", ""].join("\n"),
    "utf8",
  );
  const r3 = collectRelayLedger({ relayGlob, outboxDir, inboxDir });
  assert.equal(r3.known, true);
  assert.equal(r3.formatErrorCount, 1);
  assert.equal(r3.beforeFormatCount, 2, "옛 두 줄은 그대로 형식 이전");
  assert.equal(r3.undeterminedCount, 0);
  const aux3 = renderRelayLedgerAuxLines(r3);
  assert.ok(aux3[0].includes("형식 오류 1건"));
  assert.ok(aux3[0].includes("형식 이전 구간 미계수 2건"));

  const step3 = await runPartialCountStep({
    watchDir,
    now: NOW + 2000,
    notifyDir,
    runPartialCountOnceFn: async () => ({
      reportText: "집계 성격: PARTIAL — 전수 아님\n⑶\n",
      relayResult: r3,
    }),
  });
  assert.equal(step3.relayNotify.sent, true);
  assert.equal(
    fs.readdirSync(notifyDir).length,
    2,
    "형식 오류가 바뀌었으니 통지 1건 추가(합계 2)",
  );
}

test("⑴→⑵→⑶ 같은 폴더 누적(실물 모양): 형식 시작 전 옛 줄 E 0, 첫 유효 머리줄 추가는 E 불변·통지 0, 형식 시작 뒤 새 정규식 밖 줄은 E 1·통지 1(게이트 2 판정 A)", async () => {
  const root = tmpDir("nc-pc-relay-lt-123-");
  const watchDir = join(root, "watch");
  const notifyDir = join(watchDir, "받는함");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함-S");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    const relayGlob = join(relayDir, "전달-*.md");
    const ctx = {
      relayGlob,
      outboxDir,
      inboxDir,
      relayDir,
      watchDir,
      notifyDir,
    };

    await checkStep1(ctx);
    await checkStep2(ctx);
    await checkStep3(ctx);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// coder-task.md §2 ⓑ⑷ -- 줄 안 시각 토큰도 전달 파일 이름의 날짜도 없는
// 정규식 밖 줄("시각 미정")은, 형식이 이미 시작된 뒤에도 형식 오류 E가
// 아니라 "형식 이전 + 시각 미정" 별도 칸으로 간다(E 0 유지).
test("⑷ 시각 토큰도 파일 이름 날짜도 없는 정규식 밖 줄은 형식 이전 + 시각 미정 1(E 0 유지)", () => {
  const root = tmpDir("nc-pc-relay-lt-4-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      join(relayDir, "전달-2026-11-01-start.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-1000 · 2026-11-01 10:00 KST · 지시 · ㄱ-2]",
        "> 한용: «형식 시작»",
        "",
      ].join("\n"),
      "utf8",
    );
    // 파일 이름에 날짜 숫자가 전혀 없다(전달-메모.md) -- 파일 이름
    // 날짜 fallback도 실패해야 "시각 미정"이 된다.
    fs.writeFileSync(
      join(relayDir, "전달-메모.md"),
      ["[책임자 경유 · 아무 말] 그냥 메모", ""].join("\n"),
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.equal(result.formatErrorCount, 0);
    assert.equal(result.beforeFormatCount, 1);
    assert.equal(result.undeterminedCount, 1);
    const aux = renderRelayLedgerAuxLines(result);
    assert.ok(aux[0].includes("시각 미정 1건"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// coder-task.md §2 ⓑ⑸ -- 같은 전달 파일 "한 편" 안에 형식 시작 앞·뒤
// 줄이 섞인 실물 모양(옛 줄은 파일 이름 날짜로 형식 이전, 그 뒤에 새로
// 덧붙여진 줄은 own 줄 안 토큰으로 형식 오류) -- 판정은 "파일" 단위가
// 아니라 "줄" 단위로 갈린다는 것을 한 파일 안에서 보인다.
test("⑸ 같은 파일 안에 형식 시작 앞·뒤 줄이 섞인 누적 1파일(실물 모양): 앞 줄 = 형식 이전 · 뒤 줄 = E(줄 단위)", () => {
  const root = tmpDir("nc-pc-relay-lt-5-");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    // 형식 시작(2026-11-01 10:00)은 별도 파일에서 선다.
    fs.writeFileSync(
      join(relayDir, "전달-2026-11-01-elsewhere.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-1000 · 2026-11-01 10:00 KST · 지시 · ㄱ-2]",
        "> 한용: «형식 시작»",
        "",
      ].join("\n"),
      "utf8",
    );
    // 누적 1파일 -- 파일 이름 날짜(09-21)는 형식 시작보다 두 달 전.
    // 첫 줄은 own 토큰이 없어 파일 이름 날짜로 형식 이전. 둘째 줄은
    // 형식 시작 "뒤"에 새로 덧붙여진 모양이라 own 줄 안 토큰(11-02)을
    // 달고 있다 -- 그 토큰이 파일 이름 날짜를 이긴다(줄 단위 1순위).
    fs.writeFileSync(
      join(relayDir, "전달-2026-09-21-blend.md"),
      [
        "[책임자 경유 · 옛 메모] 그냥 흘러간 말",
        "[책임자 경유 · 새로 깨진 줄] 2026-11-02 09:00 메모",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.equal(result.formatErrorCount, 1, "둘째 줄(11-02 토큰)만 E");
    assert.equal(
      result.beforeFormatCount,
      1,
      "첫째 줄(파일명 09-21)은 형식 이전",
    );
    assert.equal(result.undeterminedCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// coder-task.md §2 ⓑ⑹ · P2-1(2R) ⓘⓘ -- 짝 없는 `전달 #번호`("없는 번호를
// 가리킴")는 ㄴ 후보 수치에는 이미 들어가 있었지만(2R 동작) 그 사유 자체가
// 보조 관측 줄·통지 문면 어디에도 보이지 않았다(검토 2R P2-1 지적). 이제
// 사유 문자열이 실제로 렌더된다.
test("⑹ 짝 없는 전달 #번호는 보조 관측 줄과 통지 문면에 «없는 번호를 가리킴» 사유를 실제로 낸다", async () => {
  const root = tmpDir("nc-pc-relay-lt-6-");
  const watchDir = join(root, "watch");
  const notifyDir = join(watchDir, "받는함");
  try {
    const relayDir = join(root, "기록");
    const outboxDir = join(root, "보내는함");
    const inboxDir = join(root, "받는함");
    fs.mkdirSync(relayDir, { recursive: true });
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(
      join(relayDir, "전달-2026-11-01-badnum.md"),
      [
        "[책임자 경유 · 한용 확정 · #20261101-0900 · 2026-11-01 09:00 KST · 지시 · ㄱ-2]",
        "> 한용: «번호 불일치 창안 발화»",
        "",
      ].join("\n"),
      "utf8",
    );
    // 시각은 전달 #0900과 5분 차(창 안)지만, 토큰이 가리키는 번호
    // #20261101-9999는 전달 파일에 없다 -- "없는 번호를 가리킴".
    fs.writeFileSync(
      join(outboxDir, "2026-11-01-0905-없는번호.md"),
      "[책임자 경유 · 한용 확정 · 전달 #20261101-9999] 한용 «번호 불일치 창안 발화 그대로»\n",
      "utf8",
    );
    const result = collectRelayLedger({
      relayGlob: join(relayDir, "전달-*.md"),
      outboxDir,
      inboxDir,
    });
    assert.equal(result.known, true);
    assert.equal(result.matchedCount, 0);
    assert.equal(result.candidateCount, 1);
    assert.equal(result.numberMismatchCandidateCount, 1);
    const aux = renderRelayLedgerAuxLines(result);
    assert.ok(aux[0].includes("없는 번호를 가리킴 1건"));

    await runPartialCountStep({
      watchDir,
      now: NOW,
      notifyDir,
      runPartialCountOnceFn: async () => ({
        reportText: "집계 성격: PARTIAL — 전수 아님\n⑹\n",
        relayResult: result,
      }),
    });
    const files = fs.readdirSync(notifyDir);
    assert.equal(files.length, 1);
    const text = fs.readFileSync(join(notifyDir, files[0]), "utf8");
    assert.ok(text.includes("없는 번호를 가리킴: 1건"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
