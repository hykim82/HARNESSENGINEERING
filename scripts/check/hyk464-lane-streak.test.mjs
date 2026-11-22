import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { foldLaneStreaks, laneKeyFrom } from "./reject-streak.mjs";

// HYK-464 추기 4 (조각 1): 레인 단위 연속 반려 계수.
// 이 파일의 시험은 «프로덕션 진입점»(node scripts/check/reject-streak.mjs
// gate | diagnostic-gate | lanes · dispatch-gate-decision.mjs)을 자식
// 프로세스로 직접 구동한다. 모든 원장 · 지시서는 mkdtemp 안 합성 파일이고
// `--ledger` 를 항상 명시한다 -- 실제 `.harness` 는 읽지도 쓰지도 않는다.
// 기대값은 아래 합성 원장에서 «손으로» 정한 숫자다(같은 함수로 만들지 않는다).
// 계수는 시각을 쓰지 않으므로 시계 의존 단언은 없다(TZ=UTC 로도 같은 값).

const RS = fileURLToPath(new URL("./reject-streak.mjs", import.meta.url));
const DGD = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk464-lane-streak-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runNode(script, args, env = {}) {
  const r = spawnSync("node", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const rej = (task_id) => ({ task_id, verdict: "rejected", at: "t" });
const app = (task_id) => ({ task_id, verdict: "approved", at: "t" });

// 이슈 HYK-900 의 두 레인: a-lane(= 레인 1) · b-lane(= 레인 2).
// `streak` 는 각 합성 원장에서 손으로 적은 «이슈 단위 저장값»이다.
function ledgerOf(streak, history) {
  return { schema_version: 1, issues: { "HYK-900": { streak, history } } };
}

// 진리표 1: 레인2 반려 → 레인1 승인 → 레인2 반려 (이슈 streak 1 · 레인2 = 2)
const H1 = [
  rej("HYK-900-b-lane-1"),
  app("HYK-900-a-lane-1"),
  rej("HYK-900-b-lane-2"),
];

const ENVELOPE = [
  "<!-- reject-streak-envelope",
  "원인 분류: 모델 한계",
  "ORCH 조치:",
  "- 모델 변경: sonnet -> opus 승격",
  "-->",
].join("\n");
const DIAG_ENVELOPE = [
  "<!-- reject-streak-envelope",
  "원인 분류: 모델 한계",
  "재현 증거 포인터: 합성 시험 칸(.harness 없음)",
  "ORCH 조치:",
  "- 모델 변경: sonnet -> opus 승격",
  "-->",
].join("\n");

// 한 번 구동: 합성 원장 + 지시서(task_id 줄 + 선택 본문) → sub 의 결과
function drive(sub, { ledger, taskId, body = "" }) {
  return withDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
    writeFileSync(taskPath, `task_id: ${taskId}\n${body}\n`, "utf8");
    return runNode(RS, [sub, taskPath, "--ledger", ledgerPath]);
  });
}
const gate = (o) => drive("gate", o);
const diag = (o) => drive("diagnostic-gate", o);

// ---------------------------------------------------------------------------
// ⑴ laneKeyFrom 표 -- 부록 B 실측 라벨 12개(줄기 6 + null 6)
// ---------------------------------------------------------------------------
test("laneKeyFrom: 실측 라벨 12개 -- 줄기 6 · 꼴 밖 null 6", () => {
  const table = [
    ["HYK-255-s1-seal-order-4", "HYK-255-s1-seal-order"],
    ["HYK-255-s1-seal-order-3-review-1", "HYK-255-s1-seal-order"],
    ["HYK-464-load-timing-1-r4", "HYK-464-load-timing"],
    ["HYK-464-load-timing-2", "HYK-464-load-timing"],
    ["HYK-402-seat-role-s1-1", "HYK-402-seat-role-s1"],
    ["HYK-209-install-closure-1-r2", "HYK-209-install-closure"],
    ["HYK-142-review-3", null],
    ["HYK-160", null],
    ["HYK-502-onepr-guard-orch", null],
    ["HYK-165-coder-1,", null],
    ["HYK-135-review-ci1", null],
    ["HYK-344+347+350", null],
  ];
  assert.equal(table.length, 12);
  for (const [label, expected] of table) {
    assert.equal(laneKeyFrom(label), expected, label);
  }
  // 문자열이 아니면 던지지 않고 null
  for (const junk of [undefined, null, 7, {}, []]) {
    assert.equal(laneKeyFrom(junk), null);
  }
});

// ---------------------------------------------------------------------------
// ⑵ foldLaneStreaks 순수 진리표
// ---------------------------------------------------------------------------
test("foldLaneStreaks: 레인마다 반려 +1 · 승인 0 · 줄기 없는 항목은 건너뜀 · 던지지 않음", () => {
  assert.deepEqual(foldLaneStreaks(H1), {
    "HYK-900-b-lane": 2,
    "HYK-900-a-lane": 0,
  });
  assert.deepEqual(
    foldLaneStreaks([
      rej("HYK-900-a-lane-1"),
      rej("HYK-900-a-lane-2"),
      rej("HYK-900-b-lane-1"),
    ]),
    { "HYK-900-a-lane": 2, "HYK-900-b-lane": 1 },
  );
  assert.deepEqual(
    foldLaneStreaks([rej("HYK-900-a-lane-1"), app("HYK-900-a-lane-2")]),
    { "HYK-900-a-lane": 0 },
  );
  // 검토 라운드는 작성 라운드와 같은 레인
  assert.deepEqual(
    foldLaneStreaks([
      rej("HYK-900-a-lane-1"),
      rej("HYK-900-a-lane-1-review-1"),
    ]),
    { "HYK-900-a-lane": 2 },
  );
  // 줄기를 못 뽑는 항목(맨 번호 · 묶음)은 레인 계수에 안 들어간다
  assert.deepEqual(foldLaneStreaks([rej("HYK-900"), rej("HYK-900+901")]), {});
  // 항목 형태가 이상해도 던지지 않는다
  assert.deepEqual(foldLaneStreaks(undefined), {});
  assert.deepEqual(foldLaneStreaks("x"), {});
  assert.deepEqual(foldLaneStreaks([null, 3, {}, { task_id: 5 }]), {});
});

// ---------------------------------------------------------------------------
// ⑶ 설계 진리표 1~8 -- 프로덕션 CLI 종료 코드
// ---------------------------------------------------------------------------
test("진리표 1: 레인2 반려 → 레인1 승인 → 레인2 반려, 다음 = 레인2, 봉투 없음 -> gate 종료 2 · lane[..]=2 eff=2", () => {
  const r = gate({ ledger: ledgerOf(1, H1), taskId: "HYK-900-b-lane-3" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /lane\[HYK-900-b-lane\]=2 eff=2/);
  assert.match(r.stderr, /streak=1/);
});

test("진리표 1': 같은 원장, 다음 = 레인1 -> gate 종료 0 (lane=0 eff=1)", () => {
  const r = gate({ ledger: ledgerOf(1, H1), taskId: "HYK-900-a-lane-2" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /lane\[HYK-900-a-lane\]=0 eff=1/);
});

test("진리표 2: 레인1 반려 → 레인1 승인, 다음 = 레인1 -> 종료 0 (eff=0)", () => {
  const ledger = ledgerOf(0, [
    rej("HYK-900-a-lane-1"),
    app("HYK-900-a-lane-2"),
  ]);
  const r = gate({ ledger, taskId: "HYK-900-a-lane-3" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /lane\[HYK-900-a-lane\]=0 eff=0/);
});

test("진리표 3: 레인1 반려 → 레인2 반려 (이슈 2 · 레인 1) -> 어느 레인이든 종료 2 (오늘과 같음)", () => {
  const ledger = ledgerOf(2, [
    rej("HYK-900-a-lane-1"),
    rej("HYK-900-b-lane-1"),
  ]);
  for (const taskId of ["HYK-900-a-lane-2", "HYK-900-b-lane-2"]) {
    const r = gate({ ledger, taskId });
    assert.equal(r.status, 2, taskId + r.stdout + r.stderr);
    assert.match(r.stderr, /eff=2/);
  }
});

test("진리표 4: 레인1 반려 × 2 연속, 다음 = 레인1 -> 종료 2 · lane=2 eff=2", () => {
  const ledger = ledgerOf(2, [
    rej("HYK-900-a-lane-1"),
    rej("HYK-900-a-lane-2"),
  ]);
  const r = gate({ ledger, taskId: "HYK-900-a-lane-3" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /lane\[HYK-900-a-lane\]=2 eff=2/);
});

test("진리표 5: 레인2 반려 × 3 (사이사이 레인1 승인, 이슈 1 · 레인 3) -> gate 종료 2 · eff=3 · 진단 게이트는 아직 0", () => {
  const ledger = ledgerOf(1, [
    rej("HYK-900-b-lane-1"),
    app("HYK-900-a-lane-1"),
    rej("HYK-900-b-lane-2"),
    app("HYK-900-a-lane-2"),
    rej("HYK-900-b-lane-3"),
  ]);
  const g = gate({ ledger, taskId: "HYK-900-b-lane-4" });
  assert.equal(g.status, 2, g.stdout + g.stderr);
  assert.match(g.stderr, /lane\[HYK-900-b-lane\]=3 eff=3/);
  const d = diag({ ledger, taskId: "HYK-900-b-lane-4" });
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /lane\[HYK-900-b-lane\]=3 eff=3/);
});

test("진리표 6: 1번 뒤 형식 밖 라벨 -> 가장 나쁜 레인(2)을 물려받아 종료 2 (옆문 차단)", () => {
  for (const taskId of ["HYK-900-weird", "HYK-900"]) {
    const r = gate({ ledger: ledgerOf(1, H1), taskId });
    assert.equal(r.status, 2, taskId + r.stdout + r.stderr);
    assert.match(r.stderr, /lane\[\*worst\]=2 eff=2/);
  }
});

test("진리표 6 대조: 형식 밖 라벨이어도 반려 이력이 없거나 레인이 전부 0 이면 통과 (무관한 과제를 통째로 막지 않는다)", () => {
  const none = gate({ ledger: ledgerOf(0, []), taskId: "HYK-900-weird" });
  assert.equal(none.status, 0, none.stdout + none.stderr);
  const allZero = gate({
    ledger: ledgerOf(0, [rej("HYK-900-a-lane-1"), app("HYK-900-a-lane-2")]),
    taskId: "HYK-900-weird",
  });
  assert.equal(allZero.status, 0, allZero.stdout + allZero.stderr);
  assert.match(allZero.stdout, /lane\[\*worst\]=0 eff=0/);
});

test("진리표 7: 레인2 반려 × 4 (사이사이 레인1 승인, 이슈 1 · 레인 4) -> diagnostic-gate 종료 2 (진단 봉투 필요) · 진단 봉투가 있으면 0", () => {
  const ledger = ledgerOf(1, [
    rej("HYK-900-b-lane-1"),
    app("HYK-900-a-lane-1"),
    rej("HYK-900-b-lane-2"),
    app("HYK-900-a-lane-2"),
    rej("HYK-900-b-lane-3"),
    app("HYK-900-a-lane-3"),
    rej("HYK-900-b-lane-4"),
  ]);
  const bare = diag({ ledger, taskId: "HYK-900-b-lane-5" });
  assert.equal(bare.status, 2, bare.stdout + bare.stderr);
  assert.match(bare.stderr, /DIAGNOSTIC_REQUIRED/);
  assert.match(bare.stderr, /lane\[HYK-900-b-lane\]=4 eff=4/);
  const ordinary = diag({
    ledger,
    taskId: "HYK-900-b-lane-5",
    body: ENVELOPE,
  });
  assert.equal(ordinary.status, 2, ordinary.stdout + ordinary.stderr);
  assert.match(ordinary.stderr, /DIAGNOSTIC_FIELD_MISSING/);
  const full = diag({
    ledger,
    taskId: "HYK-900-b-lane-5",
    body: DIAG_ENVELOPE,
  });
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.match(full.stdout, /lane\[HYK-900-b-lane\]=4 eff=4/);
  // 같은 배달에서 일반 게이트도 같은 max 에 걸린다
  const g = gate({ ledger, taskId: "HYK-900-b-lane-5" });
  assert.equal(g.status, 2, g.stdout + g.stderr);
});

test("진리표 8: 1번 + 봉투 있음 -> gate 종료 0 (설계된 문) · 사유에 lane · eff 가 남는다", () => {
  const r = gate({
    ledger: ledgerOf(1, H1),
    taskId: "HYK-900-b-lane-3",
    body: ENVELOPE,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /envelope complete/);
  assert.match(r.stdout, /lane\[HYK-900-b-lane\]=2 eff=2/);
});

test("검토 라운드 라벨은 작성 라운드와 같은 레인으로 판정된다 (-review-<n> 을 뗀다)", () => {
  // 레인 a = 2 연속 반려 · 레인 b 승인으로 이슈 streak 0. 다음이 b 의 검토
  // 라운드이면 b 레인(= 0)으로 읽혀 통과해야 한다. 줄기를 못 뽑았다면
  // «가장 나쁜 레인»(a = 2)을 물려받아 막혔을 것이다.
  const ledger = ledgerOf(0, [
    rej("HYK-900-a-lane-1"),
    rej("HYK-900-a-lane-2"),
    app("HYK-900-b-lane-1"),
  ]);
  const review = gate({ ledger, taskId: "HYK-900-b-lane-2-review-1" });
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.match(review.stdout, /lane\[HYK-900-b-lane\]=0 eff=0/);
  // 대조: a 레인의 검토 라운드는 a 레인 계수 2 로 막힌다
  const aReview = gate({ ledger, taskId: "HYK-900-a-lane-3-review-1" });
  assert.equal(aReview.status, 2, aReview.stdout + aReview.stderr);
  assert.match(aReview.stderr, /lane\[HYK-900-a-lane\]=2 eff=2/);
});

test("오늘보다 약해지지 않는다: 이슈 계수만 2 이고 레인 계수는 1 인 경우(진리표 3) · 레인 정보가 없는 옛 맨 번호 이력도 이슈 계수로 막힌다", () => {
  const bare = ledgerOf(2, [rej("HYK-900"), rej("HYK-900")]);
  const r = gate({ ledger: bare, taskId: "HYK-900-a-lane-1" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /streak=2/);
  assert.match(r.stderr, /lane\[HYK-900-a-lane\]=0 eff=2/);
});

test("기존 사유 문구는 그대로: 이슈 계수 0 이면 streak=0 (<2) 이 남고 lane · eff 가 뒤에 붙는다", () => {
  const r = gate({ ledger: ledgerOf(0, []), taskId: "HYK-900-a-lane-1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /streak=0 \(<2\) -- envelope not required/);
  assert.match(r.stdout, /lane\[HYK-900-a-lane\]=0 eff=0$/m);
});

// ---------------------------------------------------------------------------
// ⑷ lanes -- 읽기 전용
// ---------------------------------------------------------------------------
test("lanes --issue: 이슈 계수와 레인별 계수를 한 줄씩 보이고 원장 바이트는 전후로 같다 (쓰기 0)", () => {
  withDir((dir) => {
    const ledgerPath = join(dir, "reject-streak.json");
    const ledger = ledgerOf(1, [
      ...H1,
      rej("HYK-900"), // 줄기를 못 뽑는 항목
    ]);
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
    const before = readFileSync(ledgerPath);
    const mtimeBefore = statSync(ledgerPath).mtimeMs;
    const r = runNode(RS, [
      "lanes",
      "--issue",
      "HYK-900",
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(
      r.stdout,
      /HYK-900 issue streak=1 history=4 lanes=2 no-lane-key=1/,
    );
    assert.match(r.stdout, /^lane\[HYK-900-a-lane\]=0$/m);
    assert.match(r.stdout, /^lane\[HYK-900-b-lane\]=2$/m);
    const after = readFileSync(ledgerPath);
    assert.equal(
      createHash("sha256").update(after).digest("hex"),
      createHash("sha256").update(before).digest("hex"),
    );
    assert.equal(statSync(ledgerPath).mtimeMs, mtimeBefore);
    // 이슈가 원장에 없으면 0 · 레인 0개, 그래도 쓰기 0
    const none = runNode(RS, [
      "lanes",
      "--issue",
      "HYK-901",
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(none.status, 0);
    assert.match(none.stdout, /HYK-901 issue streak=0 history=0 lanes=0/);
    assert.equal(readFileSync(ledgerPath).equals(before), true);
  });
});

test("lanes: 원장 파일이 없어도 만들지 않는다 · --issue 없음/꼴 밖은 종료 1", () => {
  withDir((dir) => {
    const missing = join(dir, "no-such-ledger.json");
    const r = runNode(RS, ["lanes", "--issue", "HYK-900", "--ledger", missing]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /issue streak=0 history=0 lanes=0/);
    assert.equal(existsSync(missing), false, "lanes 가 원장 파일을 만들었다");
    const noIssue = runNode(RS, ["lanes", "--ledger", missing]);
    assert.equal(noIssue.status, 1);
    const bad = runNode(RS, ["lanes", "--issue", "255", "--ledger", missing]);
    assert.equal(bad.status, 1);
  });
});

// ---------------------------------------------------------------------------
// ⑸ NOTE -- 다른 레인 ≥1 인 이슈에 새 줄기 · 막지 않음
// ---------------------------------------------------------------------------
test("NOTE: 다른 레인이 반려 중인 이슈에 새 줄기가 처음 나타나면 사유에 NOTE · 종료 코드는 그대로(0)", () => {
  const ledger = ledgerOf(1, [rej("HYK-900-a-lane-1")]);
  const r = gate({ ledger, taskId: "HYK-900-c-lane-1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /NOTE: new lane stem 'HYK-900-c-lane'/);
  assert.match(r.stdout, /HYK-900-a-lane=1/);
  assert.equal(
    r.stdout.trim().split("\n").length,
    1,
    "NOTE 는 같은 사유 줄 안",
  );
});

test("NOTE: 막아야 할 판정(이슈 2)이면 NOTE 가 붙어도 종료 2 그대로", () => {
  const ledger = ledgerOf(2, [
    rej("HYK-900-a-lane-1"),
    rej("HYK-900-a-lane-2"),
  ]);
  const r = gate({ ledger, taskId: "HYK-900-c-lane-1" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /NOTE: new lane stem 'HYK-900-c-lane'/);
});

test("NOTE 대조: 같은 줄기 · 이미 한 번 나온 줄기(승인으로 0) · 이력 없음 · 모든 레인 0 이면 NOTE 없음", () => {
  const cases = [
    [ledgerOf(1, [rej("HYK-900-a-lane-1")]), "HYK-900-a-lane-2"],
    [
      ledgerOf(1, [rej("HYK-900-a-lane-1"), app("HYK-900-b-lane-1")]),
      "HYK-900-b-lane-2",
    ],
    [ledgerOf(0, []), "HYK-900-c-lane-1"],
    [
      ledgerOf(0, [rej("HYK-900-a-lane-1"), app("HYK-900-a-lane-2")]),
      "HYK-900-c-lane-1",
    ],
    [ledgerOf(1, [rej("HYK-900-a-lane-1")]), "HYK-900-weird"],
  ];
  for (const [ledger, taskId] of cases) {
    const r = gate({ ledger, taskId });
    assert.doesNotMatch(r.stdout + r.stderr, /NOTE/, taskId);
  }
});

// ---------------------------------------------------------------------------
// ⑹ 배달 게이트 CLI 처음부터 끝까지 1회 (합성 원장 · 합성 영수증)
// ---------------------------------------------------------------------------
test("배달 게이트(dispatch-gate-decision) 끝까지: 진리표 1 원장에서 레인2 과제는 REJECT · 레인1 과제는 ALLOW", () => {
  const oneB =
    "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";
  withDir((dir) => {
    const receipts = join(dir, "dispatch-receipts.jsonl");
    writeFileSync(receipts, "", "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeFileSync(
      ledgerPath,
      JSON.stringify(ledgerOf(1, H1), null, 2) + "\n",
      "utf8",
    );
    const run = (taskId) => {
      const taskPath = join(dir, "coder-task.md");
      writeFileSync(taskPath, `task_id: ${taskId}\nbody\n${oneB}`, "utf8");
      return runNode(DGD, [taskPath, "--ledger", ledgerPath], {
        DISPATCH_RECEIPT_PATH: receipts,
      });
    };
    const blocked = run("HYK-900-b-lane-3");
    assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
    assert.match(blocked.stderr, /BLOCK\(exit 2\)|REJECT_BLOCKED/);
    assert.match(blocked.stderr, /lane\[HYK-900-b-lane\]=2 eff=2/);
    const allowed = run("HYK-900-a-lane-2");
    assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
    assert.match(allowed.stdout, /ALLOW/);
  });
});
