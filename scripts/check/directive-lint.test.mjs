// HYK-488-directive-lint-1 (coder-task.md §2 product_scope ③): lintDirective
// 자체(판정 1/2/3 각각 양성·음성) + dispatch-gate-decision.mjs 결선(린트
// 거부 -> runDispatchGateDecision allow:false + 사유 줄) 1개. 3종 in-place
// 변이(§2ⓒ)는 이 파일의 양성 케이스를 그대로 RED 표적으로 쓴다(검사 호출을
// 지우면 해당 양성이 다시 ok:true가 된다) -- 그 절차는 커밋 전 1회성
// 수작업(결과 파일에 TAP 원문 + sha256 기록)이라 이 파일 자체에는 별도
// mutation 테스트를 두지 않는다(product_scope ③ 원문: 양성·음성 + 게이트
// 결선 1개뿐).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { lintDirective } from "./directive-lint.mjs";
import { writeLedger } from "./reject-streak.mjs";

const GATE_SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

// dispatch-gate-decision.test.mjs 자신의 ONE_B_BLOCK 관례 그대로(그 파일
// 원문 인용) -- 1-B 축이 이미 이 CLI에 걸려 있으므로 ALLOW를 기대하는
// 모든 fixture는 이 블록도 함께 갖춰야 한다(지시서 린트 축과 무관).
const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "directive-lint-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ===========================================================================
// ⓘ 결합 금지 줄: ⛔ 2개 이상 또는 다른 "키:"가 같은 줄에 낌 -> 거부.
// ===========================================================================

test("(ⓘ-pos-a) 금지 키 줄에 ⛔ 2개 -> 거부", () => {
  const text =
    "load_repro_rule: ⛔부하 재현 0(⛔실제 메모리를 소모시키는 실행 금지)\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, false);
  assert.ok(reasons.some((r) => r.includes("ⓘ 금지 키 결합 줄")));
});

test("(ⓘ-pos-b) 금지 키 줄에 다른 키: 가 끼어 있음(결합 줄) -> 거부", () => {
  const text =
    "dev_server_rule: ⛔개발 서버 0 · wsl_ban: ⛔WSL 0(비고) · tool_ban_chrome: ⛔claude-in-chrome 0.\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, false);
  assert.ok(reasons.some((r) => r.includes("ⓘ 금지 키 결합 줄")));
});

test("(ⓘ-neg) 같은 금지 3개를 줄마다 쪼개면 -> 통과", () => {
  const text =
    "dev_server_rule: ⛔개발 서버 0\nwsl_ban: ⛔WSL 0(비고)\ntool_ban_chrome: ⛔claude-in-chrome 0.\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true, `expected pass, reasons=${JSON.stringify(reasons)}`);
});

test("(ⓘ-neg-not-ban) _ban으로 끝나지 않고 load_repro_rule도 아닌 키는 ⛔가 여럿이어도 통과", () => {
  const text =
    "env_rule: ⛔하나 · ⛔둘 · ⛔셋 — 이 키는 검사 대상이 아니다.\n---\n";
  const { ok } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true);
});

// ===========================================================================
// ⓘⓘ remnant_forbid 잔재: 값이 그 키 줄 "밖" 어디든 있으면 거부.
// ===========================================================================

test("(ⓘⓘ-pos) remnant_forbid 값이 다른 줄에 다시 나타나면 -> 거부", () => {
  const text =
    "remnant_forbid: hyk477rep1 | runner.temp\nnote: 이전 라운드 잔재 hyk477rep1 이 또 보인다\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, false);
  assert.ok(reasons.some((r) => r.includes("ⓘⓘ remnant_forbid 잔재")));
  assert.ok(reasons.some((r) => r.includes("hyk477rep1")));
});

test("(ⓘⓘ-neg-clean) remnant_forbid 키가 있어도 값이 밖에서 안 보이면 -> 통과", () => {
  const text =
    "remnant_forbid: hyk477rep1 | runner.temp\nnote: 깨끗하다\n---\n";
  const { ok } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true);
});

test("(ⓘⓘ-neg-no-key) remnant_forbid 키 자체가 없으면 -> 통과(정직 한계: 생성기가 안 적으면 못 잡는다)", () => {
  const text =
    "note: hyk477rep1 이 본문에 나와도 remnant_forbid 키가 없으면 검사되지 않는다\n---\n";
  const { ok } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true);
});

// ===========================================================================
// ⓘⓘⓘ 머리 키 값 안의 시각(KST)이 파일 mtime보다 미래면 거부.
// ===========================================================================

test("(ⓘⓘⓘ-pos) 머리의 시각이 파일 mtime보다 미래 -> 거부", () => {
  const text = "dropped_at: 2099-01-01 00:00 KST\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, false);
  assert.ok(reasons.some((r) => r.includes("ⓘⓘⓘ 미래 시각")));
});

test("(ⓘⓘⓘ-neg) 머리의 시각이 파일 mtime보다 과거 -> 통과", () => {
  const mtimeMs = Date.UTC(2026, 10, 2, 0, 20, 0); // 2026-11-02T00:20:00Z
  const text = "dropped_at: 2026-11-02 09:18 KST\n---\n"; // KST 09:18 == UTC 00:18 (과거)
  const { ok } = lintDirective(text, { mtimeMs });
  assert.equal(ok, true);
});

test("(ⓘⓘⓘ-neg-no-mtime) mtimeMs를 안 넘기면 판정 불가로 보고 건너뜀(거부하지 않음)", () => {
  const text = "dropped_at: 2099-01-01 00:00 KST\n---\n";
  const { ok } = lintDirective(text, {});
  assert.equal(ok, true);
});

// ===========================================================================
// ⓘⓘⓘⓘ CODER 지시서 머리의 head_commit: 키(HYK-424): 레거시 base 표기가
// CODER 지시서에 다시 실리면 거부. REVIEW 지시서의 head_commit:(=판정
// 대상 커밋)은 그대로 허용(과차단 0).
// ===========================================================================

test("(ⓘⓘⓘⓘ-pos) role: CODER 머리에 head_commit: 키 -> 거부", () => {
  const text =
    "task_id: HYK-424-C\nrole: CODER\nhead_commit: " +
    "a".repeat(40) +
    "\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, false);
  assert.ok(
    reasons.some((r) => r.includes("ⓘⓘⓘⓘ CODER 지시서 머리에 head_commit:")),
  );
});

test("(ⓘⓘⓘⓘ-neg-review) role: REVIEW 머리에 head_commit: 키 -> 통과(판정 대상 커밋이라는 다른 뜻, 과차단 0)", () => {
  const text =
    "task_id: HYK-424-R\nrole: REVIEW\nhead_commit: " +
    "a".repeat(40) +
    "\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true, `expected pass, reasons=${JSON.stringify(reasons)}`);
});

test("(ⓘⓘⓘⓘ-neg-no-headcommit) role: CODER 머리에 head_commit: 키가 없으면(정식 base_commit_of_this_round:만 있으면) -> 통과", () => {
  const text =
    "task_id: HYK-424-C\nrole: CODER\nbase_commit_of_this_round: " +
    "a".repeat(40) +
    "\n---\n";
  const { ok, reasons } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true, `expected pass, reasons=${JSON.stringify(reasons)}`);
});

test("(ⓘⓘⓘⓘ-neg-no-role) role: 줄 자체가 없으면 -> 판정 보류(거부하지 않는다, fail-open)", () => {
  const text = "task_id: HYK-424-X\nhead_commit: " + "a".repeat(40) + "\n---\n";
  const { ok } = lintDirective(text, { mtimeMs: Date.now() });
  assert.equal(ok, true);
});

// ===========================================================================
// 게이트 결선: 린트 거부 -> runDispatchGateDecision이 allow:false + 사유
// 줄을 그대로 낸다. CLI를 실제로 실행하는 (관제실이 호출하는 바로 그 것)
// dispatch-gate-head-commit-wire.test.mjs 자신의 runCli 관례를 그대로 쓴다.
// ===========================================================================

const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "directive-lint-test-receipts-")),
  "dispatch-receipts.jsonl",
);
writeFileSync(SHARED_EMPTY_RECEIPT_PATH, "", "utf8");

function runGateCli(args) {
  try {
    const stdout = execFileSync("node", [GATE_SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function freshLedger(dir) {
  const ledgerPath = join(dir, "reject-streak.json");
  writeLedger(ledgerPath, { schema_version: 1, issues: {} });
  return ledgerPath;
}

test("(wire-1) 결합 금지 줄이 든 CODER task -> dispatch-gate-decision CLI가 REJECT, exit 1, 지시서 린트 사유 줄", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9403-coder-1\nload_repro_rule: ⛔부하 재현 0(⛔금지 두 번)\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = freshLedger(dir);
    const r = runGateCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, `expected REJECT exit 1, stdout=${r.stdout}`);
    assert.match(r.stderr, /지시서 린트\(HYK-488\) 위반/);
    assert.match(r.stderr, /ⓘ 금지 키 결합 줄/);
    assert.match(r.stderr, /dispatch-gate-decision: REJECT/);
  });
});

test("(wire-2) 같은 금지가 줄마다 쪼개져 있으면(안전 모양) -> ALLOW, exit 0(무회귀)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9404-coder-1\nload_repro_rule: ⛔부하 재현 0\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = freshLedger(dir);
    const r = runGateCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, `expected ALLOW exit 0, stderr=${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});

test("(wire-3, HYK-424) role: CODER 머리에 head_commit: 키가 든 CODER task -> dispatch-gate-decision CLI가 REJECT, exit 1, HYK-424 사유 줄", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9405-coder-1\nrole: CODER\nhead_commit: ${"a".repeat(40)}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = freshLedger(dir);
    const r = runGateCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1, `expected REJECT exit 1, stdout=${r.stdout}`);
    assert.match(r.stderr, /지시서 린트\(HYK-488\) 위반/);
    assert.match(r.stderr, /ⓘⓘⓘⓘ CODER 지시서 머리에 head_commit:/);
    assert.match(r.stderr, /dispatch-gate-decision: REJECT/);
  });
});

test("(wire-4, HYK-424) role: REVIEW 머리에 head_commit: 키가 든 REVIEW task -> ALLOW, exit 0(과차단 0 -- 판정 대상 커밋이라는 다른 뜻)", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "review-task.md");
    writeFileSync(
      taskPath,
      `task_id: HYK-9406-review-1\nrole: REVIEW\nhead_commit: ${"a".repeat(40)}\n${ONE_B_BLOCK}`,
      "utf8",
    );
    const ledgerPath = freshLedger(dir);
    const r = runGateCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0, `expected ALLOW exit 0, stderr=${r.stderr}`);
    assert.match(r.stdout, /ALLOW/);
  });
});
