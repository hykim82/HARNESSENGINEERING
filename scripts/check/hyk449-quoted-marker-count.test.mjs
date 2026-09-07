// HYK-449 1R -- 「인용된 표지」가 「진짜 표지」로 세어져 정상 라운드를 막는
// 결함을 고정한다.
//
// 실사고(2026-09-06): 검토자가 러너 영수증 **원문**을 코드블록에 그대로
// 붙였고, 그 안의 `head_commit:` 줄이 칼럼 0 이라 소비기가 표지 2개로 세어
// 「어느 것이 최종인지 결정할 수 없다」로 거부했다 -- ★두 줄의 값은 완전히
// 동일했다. 첫 관측이 이미 고정된 뒤라 고칠 수도 없어 양방향 교착이 됐다.
//
// ★이 시험군이 재는 것은 「백틱을 벗겼는가」가 아니라 **범주**다.
// HYK-442 1R 이 정확히 그 실수(백틱 하나만 벗기고 홑따옴표에 다시 뚫림)로
// 반려됐으므로, 아래 「범주 원소」 시험군이 ``` · ~~~ · 임의 길이 펜스 ·
// 들여쓴 펜스 · 정보 문자열 · 닫히지 않은 펜스 · HTML 주석을 함께 잰다.
// 그리고 「범주 밖」 시험군이 **왜 인용 블록·들여쓴 코드·인라인 코드는
// 손대지 않아도 되는지**(칼럼 0 이 아니라 애초에 매치하지 않는다)를 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  checkRelayHandshake,
  resolveResultTaskId,
  countVerdictLines,
  maskQuotedMarkerRegions,
} from "./relay-handshake.mjs";

function lines(...rows) {
  return `${rows.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// 1. 판별식 자체(maskQuotedMarkerRegions) -- 범주 원소 전수
// ---------------------------------------------------------------------------

test("HYK-449 판별식: 길이를 보존한다(호출자가 매치 .index 로 원문을 자른다)", () => {
  const text = lines(
    "task_id: A-1",
    "```text",
    "task_id: QUOTED",
    "```",
    "end",
  );
  const masked = maskQuotedMarkerRegions(text);
  assert.equal(masked.length, text.length);
  assert.equal(masked.split("\n").length, text.split("\n").length);
  // 마스킹된 줄에는 표지 글자가 남지 않는다.
  assert.equal(/QUOTED/.test(masked), false);
  // 마스킹 안 된 줄은 글자 그대로다.
  assert.match(masked, /^task_id: A-1$/m);
});

test("HYK-449 범주 원소: ``` · ~~~ · 5중 백틱 · 들여쓴 펜스 · 정보 문자열 -- 전부 인용으로 본다", () => {
  const cases = [
    ["백틱 3", lines("```", "task_id: QUOTED", "```")],
    ["백틱 + 정보문자열", lines("```text", "task_id: QUOTED", "```")],
    ["틸드 3", lines("~~~", "task_id: QUOTED", "~~~")],
    ["틸드 + 정보문자열", lines("~~~json", "task_id: QUOTED", "~~~")],
    ["백틱 5", lines("`````", "task_id: QUOTED", "`````")],
    ["3칸 들여쓴 펜스", lines("   ```", "task_id: QUOTED", "   ```")],
  ];
  for (const [label, quoted] of cases) {
    const r = resolveResultTaskId(`task_id: A-1\n${quoted}`);
    assert.equal(r.ok, true, `${label}: ${r.reason ?? ""}`);
    assert.equal(r.id, "A-1", label);
  }
});

test("HYK-449 범주 원소: 긴 펜스 안의 짧은 펜스는 블록을 닫지 못한다(CommonMark)", () => {
  const text = lines(
    "task_id: A-1",
    "`````",
    "```",
    "task_id: QUOTED",
    "```",
    "`````",
  );
  const r = resolveResultTaskId(text);
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.id, "A-1");
});

test("HYK-449 범주 원소: 닫히지 않은 펜스는 문서 끝까지 인용이다 -- 방향은 fail-closed(표지가 «생기지» 않는다)", () => {
  const r = resolveResultTaskId(lines("```text", "task_id: QUOTED"));
  assert.equal(r.ok, false);
  assert.equal(r.kind, "MISSING");
});

test("HYK-449 범주 원소: HTML 주석 <!-- … --> 안의 표지도 세지 않는다(한 줄/여러 줄)", () => {
  const multi = resolveResultTaskId(
    lines("task_id: A-1", "<!--", "task_id: QUOTED", "-->"),
  );
  assert.equal(multi.ok, true, multi.reason ?? "");
  assert.equal(multi.id, "A-1");

  const single = resolveResultTaskId(
    lines("task_id: A-1", "<!-- archived: task_id: QUOTED -->"),
  );
  assert.equal(single.ok, true, single.reason ?? "");
  assert.equal(single.id, "A-1");
});

// ---------------------------------------------------------------------------
// 2. 「범주 밖」 -- 왜 손대지 않아도 되는가(추측이 아니라 시험으로)
// ---------------------------------------------------------------------------

test("HYK-449 범주 밖: 인용 블록(`> `)·4칸 들여쓴 코드·인라인 코드는 애초에 칼럼 0 이 아니라 표지로 세어진 적이 없다", () => {
  const text = lines(
    "task_id: A-1",
    "> task_id: QUOTED-BLOCKQUOTE",
    "    task_id: QUOTED-INDENTED",
    "`task_id: QUOTED-INLINE`",
  );
  const r = resolveResultTaskId(text);
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.id, "A-1");
  // ★그 줄들은 마스킹 대상이 아니다(글자가 그대로 남는다) -- 즉 이 통과는
  // 「마스킹이 지워줘서」가 아니라 「원래 표지가 아니어서」다.
  const masked = maskQuotedMarkerRegions(text);
  assert.match(masked, /QUOTED-BLOCKQUOTE/);
  assert.match(masked, /QUOTED-INDENTED/);
  assert.match(masked, /QUOTED-INLINE/);
});

// ---------------------------------------------------------------------------
// 3. 형제 축 -- verdict / task_id (순수 함수로 직접)
// ---------------------------------------------------------------------------

test("HYK-449 형제 축(verdict): 인용된 판정 줄은 세지 않는다 -- 진짜 2개는 여전히 2로 센다", () => {
  assert.equal(
    countVerdictLines(
      lines("verdict: approved", "```text", "verdict: rejected", "```"),
    ),
    1,
  );
  assert.equal(
    countVerdictLines(lines("verdict: approved", "verdict: rejected")),
    2,
  );
  assert.equal(countVerdictLines(lines("no verdict here")), 0);
});

test("HYK-449 과차단 0(task_id): «진짜» 표지 2개는 여전히 ambiguous 로 거부된다", () => {
  const r = resolveResultTaskId(lines("task_id: A-1", "task_id: A-2"));
  assert.equal(r.ok, false);
  assert.equal(r.kind, "AMBIGUOUS");
});

// ---------------------------------------------------------------------------
// 4. 프로덕션 진입점(checkRelayHandshake) -- head_commit / DONE / ⛔BLOCKED
// ---------------------------------------------------------------------------

function withIsolatedHarness(buildResult) {
  const dir = mkdtempSync(join(tmpdir(), "hyk449-harness-"));
  const prev = {
    ledger: process.env.ADMISSION_LEDGER_PATH,
    lock: process.env.ADMISSION_LOCK_PATH,
    receipt: process.env.DISPATCH_RECEIPT_PATH,
  };
  try {
    mkdirSync(dir, { recursive: true });
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "t@example.invalid"', { cwd: dir });
    execSync('git config user.name "t"', { cwd: dir });
    execSync('git commit -q --allow-empty -m "hyk449 fixture"', { cwd: dir });
    const sha = execSync("git rev-parse HEAD", {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const taskId = "HYK-449-FIXTURE-REVIEW-1";
    writeFileSync(
      join(dir, "review-task.md"),
      lines(
        `task_id: ${taskId}`,
        "dropped_at: 2026-08-01 09:00 KST",
        `head_commit: ${sha}`,
      ),
      "utf8",
    );
    writeFileSync(join(dir, "review.md"), buildResult(sha, taskId), "utf8");
    // ⛔전역 원장/영수증에 절대 쓰지 않는다 -- 세 경로를 이 임시 폴더로.
    process.env.ADMISSION_LEDGER_PATH = join(dir, "ledger.json");
    process.env.ADMISSION_LOCK_PATH = join(dir, "ledger.lock");
    process.env.DISPATCH_RECEIPT_PATH = join(dir, "dispatch-receipt.json");
    // ★`now` 를 주입한다(time-judgment-now-injection 의 baseline ratchet 이
    // 요구하는 «권장» 경로다 -- 절대시각 fixture 를 시간 판정 진입점에
    // now 없이 넘기면 그 시험이 RED 가 된다. 정본 러너가 이 누락을 잡았다).
    // 값은 이 fixture 의 시각들과 일관되게: dropped_at 09:00 · DONE 09:12:41
    // 보다 뒤인 같은 날 09:20 KST.
    const now = Date.parse("2026-08-01T09:20:00+09:00");
    return checkRelayHandshake({ role: "review", harnessDir: dir, now });
  } finally {
    process.env.ADMISSION_LEDGER_PATH = prev.ledger ?? "";
    process.env.ADMISSION_LOCK_PATH = prev.lock ?? "";
    process.env.DISPATCH_RECEIPT_PATH = prev.receipt ?? "";
    rmSync(dir, { recursive: true, force: true });
  }
}

const DONE_TAIL = [
  ">>> DONE: REVIEW @ 2026-08-01 09:12:41 KST",
  "done_stamped_by: finalize-done",
];

test("HYK-449 ★실사고 재현(head_commit): 영수증을 코드블록에 인용했을 뿐인데 표지 2개로 거부되던 결과 파일이 이제 정상 해석된다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      "verdict: approved",
      "",
      "```text",
      "schema_version: 1",
      "runner_exit: 0",
      `head_commit: ${sha}`,
      "```",
      "",
      ...DONE_TAIL,
    ),
  );
  assert.doesNotMatch(
    r.reason ?? "",
    /standalone 'head_commit:' lines/,
    "인용된 영수증 줄이 표지로 세어지면 안 된다",
  );
});

test("HYK-449 과차단 0(head_commit): «진짜» 표지 2개인 결과 파일은 여전히 거부된다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      `head_commit: ${sha}`,
      "verdict: approved",
      "",
      ...DONE_TAIL,
    ),
  );
  assert.match(r.reason ?? "", /standalone 'head_commit:' lines/);
});

test("HYK-449 형제 축(>>> DONE): 인용된 DONE 줄은 세지 않는다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      "verdict: approved",
      "",
      "```text",
      ">>> DONE: REVIEW @ 2026-08-01 08:00:00 KST",
      "```",
      "",
      ...DONE_TAIL,
    ),
  );
  assert.doesNotMatch(r.reason ?? "", /'>>> DONE:' lines/);
});

// ---------------------------------------------------------------------------
// 5. ⛔회귀 0 -- BLOCKED 축의 「어디에 있든 센다」는 «의도된 fail-closed»다.
//    이 시험이 그 성질을 지킨다: 인용 안이라도 «여전히» 세어져야 한다.
//    (HYK-333/HYK-442 · coder-task.md §2 -- 여기에 인용 제외를 넣는 것은
//     안전 성질 약화 회귀다.)
// ---------------------------------------------------------------------------

test("HYK-449 ⛔BLOCKED 축 회귀 0: 코드블록 안의 '>>> BLOCKED:' 도 여전히 표지로 세어진다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      "",
      "```text",
      ">>> BLOCKED: quoted inside a fence -- must STILL count",
      "```",
    ),
  );
  assert.equal(r.state, "BLOCKED");
  assert.match(r.reason ?? "", /quoted inside a fence/);
});

test("HYK-449 ⛔BLOCKED 축 회귀 0: HTML 주석 안의 '>>> NEEDS_INPUT:' 도 여전히 세어진다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      "",
      "<!--",
      ">>> NEEDS_INPUT: commented out but must STILL count",
      "-->",
    ),
  );
  assert.equal(r.state, "NEEDS_INPUT");
});

// ★이 두 시험은 되돌림 변이 M7 이 **GREEN 으로 새는 것을 보고** 추가했다:
// BLOCKED 축은 「잘 만들어진 표지」와 「깨진 표지(near-miss)」 **두 갈래**로
// 세는데, 위 두 시험은 앞 갈래만 잡고 있었다. §2 가 지키라고 한 성질의
// 핵심은 오히려 뒤 갈래다 -- 「유효+깨짐 혼재를 조용히 유효 쪽으로 풀지
// 않는다」. 그래서 인용된 «깨진» 표지도 여전히 세어져야 한다.
test("HYK-449 ⛔BLOCKED 축 회귀 0(near-miss 갈래): 코드블록 안의 «이유 없는» '>>> BLOCKED:' 도 여전히 MALFORMED 로 fail-closed 된다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      "",
      "```text",
      ">>> BLOCKED:",
      "```",
    ),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /doesn't match the required column-0/);
});

test("HYK-449 ⛔BLOCKED 축 회귀 0(near-miss 갈래): HTML 주석 안의 '>>> NEEDS_INPUT' near-miss 도 여전히 세어진다", () => {
  const r = withIsolatedHarness((sha, taskId) =>
    lines(
      `task_id: ${taskId}`,
      `head_commit: ${sha}`,
      "",
      "<!-- >>> NEEDS_INPUT -->",
    ),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /doesn't match the required column-0/);
});

// ★이 시험은 «내가 만든 회귀»를 잡아 세운 것이다(HYK-449 1R 자기 정정).
// 이 저장소의 결과 파일은 실제로 **CRLF** 다. 줄을 `\n` 으로 가르면 각 줄
// 끝에 `\r` 가 남는데, 닫는 펜스 대조가 그것을 허용하지 않으면 **닫는 펜스를
// 못 알아보고** 첫 펜스가 문서 끝까지 삼킨다 -- 그러면 표지가 «사라져»
// 정상 라운드가 PENDING 으로 막힌다. 내 결과 파일이 실제로 그렇게 막혔고,
// 그때까지 이 시험군은 전부 LF fixture 라 아무도 그것을 못 봤다.
test("HYK-449 CRLF: 닫는 펜스가 CR 로 끝나도 블록은 닫힌다 -- 그 뒤의 표지는 살아 있어야 한다", () => {
  const crlf = ["task_id: A-1", "```text", "task_id: QUOTED", "```", ""].join(
    "\r\n",
  );
  const r = resolveResultTaskId(crlf);
  assert.equal(r.ok, true, r.reason ?? "");
  assert.equal(r.id, "A-1");
});

test("HYK-449 CRLF: 펜스 «뒤»의 DONE/head_commit 표지가 CRLF 파일에서도 사라지지 않는다", () => {
  const crlf = [
    "head_commit: " + "a".repeat(40),
    "```text",
    "head_commit: " + "b".repeat(40),
    "```",
    ">>> DONE: CODER @ 2026-08-01 09:12:41 KST",
    "",
  ].join("\r\n");
  const masked = maskQuotedMarkerRegions(crlf);
  // 인용된 b… 는 지워지고, 표지 a… 와 그 뒤의 DONE 줄은 그대로 남는다.
  assert.equal(/b{40}/.test(masked), false);
  assert.match(masked, /^head_commit: a{40}/m);
  assert.match(masked, /^>>> DONE: CODER @/m);
});
