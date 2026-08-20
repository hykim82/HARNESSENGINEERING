// HYK-319-argcheck-3 (coder-task.md §2-1, 책임자 판정 2026-08-20 11:31
// "가. 재설계 지시") -- 회귀 방지 시험 2종 중 첫 번째: **레지스트리를
// 순회하지 않는 고정 단언**.
//
// ★뿌리(검토 2R P1, review-r2-원문.md): 1R/2R까지의 유일한 회귀 시험
// (dispatch-arg-contract-core.test.mjs의 "(합성-2)")은 기대 항목 집합을
// `CLI_CONTRACTS`(레지스트리) 자신에서 순회해 뽑았다 -- `--admission-
// ledger-path` 선언 블록을 지우면 "기대"와 "실제"가 함께 24→23으로
// 줄어 시험이 계속 GREEN이었다(자기참조, 검토자가 실제로 재현: 선언을
// 지운 뒤 실물 대조는 `ALL_OK`로 거짓 통과했는데 이 파일 안 시험은
// `tests 40 / pass 40 / fail 0`였다). 이 파일은 그 구조적 결함을 없앤다:
// 아래 각 시험의 "기대" 목록은 이 파일 안에 **문자열 리터럴로 직접**
// 적혀 있다 -- `CLI_CONTRACTS`를 읽는 것은 "지금 실제로 선언된 것"(실제
// 쪽)을 얻기 위해서일 뿐, "무엇을 기대하는지"(기대 쪽)는 레지스트리
// 내용과 무관하게 이 파일이 손으로 못박는다. 레지스트리에서 항목이
// 지워지면 "실제" 집합만 줄고 "기대" 리터럴은 그대로이므로 반드시 RED다.
//
// ★★책임자 조건① (드리프트 비용, 반드시 그대로 유지) — **이 목록은
// 레지스트리와 별개로 손으로 유지해야 한다.** 레지스트리에 항목을
// «정당하게» 더하거나 뺄 때 이 시험도 함께 고쳐야 하며, 그 이중 유지가
// 이 시험이 값을 하는 대가다. (예: HYK-315류 정당한 새 필수 인자가
// 생기면, 레지스트리 추가 커밋과 같은 커밋 안에서 이 파일의 EXPECTED_*
// 상수에도 그 플래그를 추가해야 한다 -- 안 하면 이 시험은 "새 항목이
// 아직 선언 안 됐다"는 거짓 정보를 계속 준다는 뜻이 아니라, 그 새 항목의
// «부재»를 검증하지 않는다는 뜻일 뿐이다. 반대로 항목을 정당하게 빼는
// 경우 EXPECTED_*에서 지우지 않으면 이 시험이 영구히 RED로 남는다.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { CLI_CONTRACTS } from "./dispatch-arg-contract-registry.mjs";

// "실제" 쪽 헬퍼 -- 지금 레지스트리가 실제로 선언한 플래그 집합을 읽는다.
// ⛔이 함수가 반환하는 값은 "기대"가 아니다 -- 아래 각 시험의 EXPECTED_*
// 상수(문자열 리터럴)와 대조하는 대상일 뿐이다.
function actualRequiredFlags(cliId) {
  const cli = CLI_CONTRACTS.find((c) => c.id === cliId);
  assert.ok(
    cli,
    `registry has no contract '${cliId}' -- 시험/레지스트리 drift`,
  );
  const set = new Set();
  for (const req of cli.requiredArgs) for (const f of req.flags) set.add(f);
  return set;
}

// ---------------------------------------------------------------------------
// dispatch-gate-decision -- 이번 P1의 직접 고정. --admission-ledger-path가
// 레지스트리 requiredArgs에서 지워지면 이 시험이 RED다(§2-3 변이 표적 ⓐ).
// ---------------------------------------------------------------------------
const EXPECTED_GATE_DECISION_FLAGS = [
  "--expect-repo-root",
  "--dispatch-receipt-path",
  "--admission-ledger-path", // HYK-319-argcheck-2/3 -- HYK-315 P1 고정.
];

test("고정 단언: dispatch-gate-decision은 --admission-ledger-path를 반드시 필수 선언해야 한다(HYK-315 P1)", () => {
  const actual = actualRequiredFlags("dispatch-gate-decision");
  for (const flag of EXPECTED_GATE_DECISION_FLAGS) {
    assert.ok(
      actual.has(flag),
      `dispatch-gate-decision 레지스트리에 '${flag}'가 없다 -- 고정 기대 목록(레지스트리 순회 아님)과 어긋남`,
    );
  }
  const gateCli = CLI_CONTRACTS.find((c) => c.id === "dispatch-gate-decision");
  assert.equal(
    gateCli.requiresPositionalArg,
    true,
    "dispatch-gate-decision은 위치 인자(task 파일 경로)를 반드시 요구해야 한다",
  );
});

// ---------------------------------------------------------------------------
// 나머지 4개 CLI -- 각각 최소 1개가 아니라 "실제로 CLI가 usage로 죽는"
// hard 항목 전체를 손으로 못박는다(더 강한 고정 -- 최소 요건은 §2-1이
// 요구한 "각 CLI 최소 1개"를 이미 넘어선다).
// ---------------------------------------------------------------------------

const EXPECTED_ADMISSION_CLI_FLAGS = [
  "--ledger",
  "--lock",
  "--reservation-id",
  "--cap-path", // anyOf(--cap-path|--cap) 대표값 -- 실물 배달기가 쓰는 쪽.
];

test("고정 단언: admission-cli-admit은 --ledger/--lock/--reservation-id/--cap-path를 반드시 필수 선언해야 한다", () => {
  const actual = actualRequiredFlags("admission-cli-admit");
  for (const flag of EXPECTED_ADMISSION_CLI_FLAGS) {
    assert.ok(
      actual.has(flag),
      `admission-cli-admit 레지스트리에 '${flag}'가 없다`,
    );
  }
  const admissionCli = CLI_CONTRACTS.find(
    (c) => c.id === "admission-cli-admit",
  );
  assert.equal(
    admissionCli.requiresSubcommand,
    "admit",
    "admission-cli는 'admit' 서브커맨드를 반드시 요구해야 한다",
  );
});

const EXPECTED_RECEIPT_CLI_FLAGS = ["--role", "--task-label", "--receipt-path"];

test("고정 단언: dispatch-receipt-cli는 --role/--task-label/--receipt-path를 반드시 필수 선언해야 한다", () => {
  const actual = actualRequiredFlags("dispatch-receipt-cli");
  for (const flag of EXPECTED_RECEIPT_CLI_FLAGS) {
    assert.ok(
      actual.has(flag),
      `dispatch-receipt-cli 레지스트리에 '${flag}'가 없다`,
    );
  }
});

const EXPECTED_SEAT_PROOF_GATE_FLAGS = [
  "--dispatch-show",
  "--terminal-show",
  "--harness-task-id",
  "--runtime-task-id",
  "--dispatch-id",
  "--worktree-id",
  "--worktree-path",
];

test("고정 단언: dispatch-worker-seat-proof-gate는 7개 배정 신원 플래그를 전부 반드시 필수 선언해야 한다", () => {
  const actual = actualRequiredFlags("dispatch-worker-seat-proof-gate");
  for (const flag of EXPECTED_SEAT_PROOF_GATE_FLAGS) {
    assert.ok(
      actual.has(flag),
      `dispatch-worker-seat-proof-gate 레지스트리에 '${flag}'가 없다`,
    );
  }
});

const EXPECTED_START_CONFIRM_CLI_FLAGS = [
  "--repo-root",
  "--dispatched-at-ms",
  "--notify-dir",
];

test("고정 단언: dispatch-start-confirm-cli는 --repo-root/--dispatched-at-ms/--notify-dir를 반드시 필수 선언해야 한다", () => {
  const actual = actualRequiredFlags("dispatch-start-confirm-cli");
  for (const flag of EXPECTED_START_CONFIRM_CLI_FLAGS) {
    assert.ok(
      actual.has(flag),
      `dispatch-start-confirm-cli 레지스트리에 '${flag}'가 없다`,
    );
  }
});

// ---------------------------------------------------------------------------
// §2-3 변이 표적 ⓒ 대상 고정 -- "2-1에서 손으로 적은 다른 CLI 항목 하나를
// 레지스트리에서 지우면 RED인가"를 결과 파일에서 admission-cli의
// --reservation-id로 시연한다(위 admission-cli 시험이 이미 그 항목을
// 포함하므로 별도 시험을 추가하지 않는다 -- 같은 EXPECTED_ADMISSION_CLI_FLAGS
// 배열의 항목이 대상이다).
// ---------------------------------------------------------------------------
