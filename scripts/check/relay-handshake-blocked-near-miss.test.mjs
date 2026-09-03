// HYK-333-blocked-marker-1: 관제실 워커 규칙 §3-b가 2026-08-21까지 `>>>`
// 없이 column-0 `BLOCKED: <사유>` / `NEEDS_INPUT: <사유>` 를 쓰라고
// 가르쳤다(취소선으로 보존된 옛 문면, 규칙 문서 자체는 이미 고쳤다). 그
// 시기 규칙을 정확히 지킨 워커의 정지 표지는 relay-handshake.mjs의 두
// 패턴(BLOCKED_RE/BLOCKED_ANYWHERE_RE) 모두 `>>>`를 요구해 매치하지 못하고
// state=NONE(조용한 유실)으로 떨어졌다(ORCH 재현, coder-task.md §1).
//
// 이 파일은 그 확장(BLOCKED_BARE_COLUMN0_RE, relay-handshake.mjs)을
// checkRelayHandshake의 공개 계약(ok/state) 수준에서 고정한다 -- 설계
// 판정 「A」(coder-task.md §2)의 비대칭 요구대로, `>>>` 없는 표지는
// MALFORMED_BLOCKED로 «보고»만 되고 «유효한 정지(BLOCKED/NEEDS_INPUT)로
// 수락»되지는 않는다는 것을 각 시험이 명시적으로 단언한다.
//
// ⚠️HYK-333 2R (검토 P2-2, 한계 명시): BLOCKED_BARE_COLUMN0_RE는 column
// 0(줄 맨 앞) 여부만 보고 그 줄이 «진짜 정지 표지»인지 «인용/코드 예시»인지
// 구별하지 못한다. 예: 결과 파일 본문의 코드 펜스(```) 안에 예시로 적은
// column-0 `BLOCKED: quoted example` 도 이 패턴에 걸려 MALFORMED_BLOCKED가
// 된다(검토자 실측). 고치지 않는다 -- 코드 펜스 파싱까지 들어가면 그
// 자체가 새로운 오탐/누락의 원천이 되고, 이 설계의 전제(§2, 설계 판정
// 「A」)는 애초에 "놓친 정지(조용한 무한 대기)가 오탐(MALFORMED_BLOCKED로
// 잘못 보고)보다 훨씬 나쁘다"는 비대칭이다 -- 인용문 오탐 몇 건을 감수하고
// column 0을 신뢰 신호로 삼는 편이, 진짜 정지 표지를 또 한 번 놓치는 것보다
// 낫다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";

// relay-handshake.test.mjs와 동일한 fixture 관례(mkdtempSync -> writeTask/
// writeResult -> checkRelayHandshake) -- 새 계약을 새 시험 파일에서
// 재발명하지 않고 기존 시험이 이미 검증한 것과 같은 harness 계약(task_id
// echo + dropped_at)을 그대로 재사용한다.
function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "relay-handshake-blocked-nm-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTask(dir, role, content) {
  writeFileSync(join(dir, `${role}-task.md`), content, "utf8");
}

function writeResult(dir, role, content) {
  writeFileSync(join(dir, `${role}.md`), content, "utf8");
}

const TASK_HEADER = "task_id: HYK-1\ndropped_at: 2026-08-08 21:00 KST\n";

test("HYK-333 (1) regression: '>>> BLOCKED: <사유>' (정상, arrows 있음) -> 여전히 state=BLOCKED로 수락되고 사유가 그대로 나온다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: orca ask 가 계속 실패해 진행 불가\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(result.reason, /orca ask 가 계속 실패해 진행 불가/);
  });
});

test("HYK-333 (2) 'BLOCKED: <사유>' (>>> 없음 · column 0) -> state=MALFORMED_BLOCKED로 보고되고, BLOCKED로는 수락되지 않는다 (fail-closed 유지)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nBLOCKED: orca ask 가 계속 실패해 진행 불가\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "MALFORMED_BLOCKED",
      "이전에는 이 입력이 두 패턴 모두 매치하지 못해 state=NONE(PENDING류)으로 조용히 묻혔다 -- HYK-333이 고치는 지점",
    );
    assert.notEqual(
      result.state,
      "BLOCKED",
      "설계 판정 「A」: 보고는 하되 유효한 정지로 승격하지 않는다 -- >>> 없는 표지가 BLOCKED로 수락되면 fail-closed 원칙이 깨진다",
    );
  });
});

test("HYK-333 (3) 'NEEDS_INPUT: <사유>' (>>> 없음 · column 0) -> state=MALFORMED_BLOCKED로 보고되고, NEEDS_INPUT으로는 수락되지 않는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nNEEDS_INPUT: 다음 단계 승인 필요\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
    assert.notEqual(
      result.state,
      "NEEDS_INPUT",
      "설계 판정 「A」: NEEDS_INPUT도 BLOCKED와 동일하게 -- 보고만 하고 수락하지 않는다",
    );
  });
});

test("HYK-333 (4) 줄 중간의 '... BLOCKED: ...' (column 0 아님, >>> 없음) -> near-miss로 세지 않는다 (state=NONE 경로 유지, 무한 확장 방지)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\nstatus note: currently BLOCKED: not a real marker, just prose\n\n>>> DONE: CODER @ 2026-08-08 21:30:00 KST\ndone_stamped_by: finalize-done\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(
      result.ok,
      true,
      "column 0이 아닌 우연한 'BLOCKED:' 문자열은 near-miss로 세면 안 된다 -- DONE 경로가 정상 처리되어야 한다",
    );
  });
});

test("HYK-333 (5) regression: 표지가 정말 없는 결과 -> 여전히 state=PENDING (NONE 경로, 조용히 MALFORMED로 새지 않는다)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 진행 중\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "PENDING");
  });
});

test("HYK-333 (6) regression: 유효 '>>> BLOCKED:' 한 줄 + 줄중간 깨진 마커 공존 -> 여전히 MALFORMED_BLOCKED (기존 valid+malformed 혼재 경로 회귀 0)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: valid\nstatus: >>> BLOCKED: midline\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
  });
});

test("HYK-333 (7) regression: 두 BLOCKED 표지(둘 다 >>> 있음) -> 여전히 AMBIGUOUS_BLOCKED (bare-column0 확장이 기존 AMBIGUOUS 분기를 건드리지 않는다)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: first reason\n>>> BLOCKED: second reason\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "AMBIGUOUS_BLOCKED");
  });
});

test("HYK-333 2R (8) 'BLOCKED:' 뒤에 사유도 화살표도 없이 개행 -> state=MALFORMED_BLOCKED로 보고된다 (검토 P2-1: 이전에는 이 입력이 근본적으로 어떤 near-miss 패턴에도 안 걸려 state=PENDING으로 조용히 묻혔다)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\nBLOCKED:\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "MALFORMED_BLOCKED",
      "1R의 BLOCKED_BARE_COLUMN0_RE는 콜론 뒤 최소 한 글자(\\S)를 요구해 이 입력에 매치하지 않았고, `>>>`도 없어 BLOCKED_ANYWHERE_RE도 못 잡아 state=PENDING으로 조용히 묻혔다(검토 1R 실측 -- '`>>> BLOCKED:`도 사유 없인 거부되니 대칭'이라는 1R의 설명은 근거가 틀렸다: `>>>` 쪽은 near-miss가 받아 내지만 여기는 애초에 받아 낼 곳이 없는 사각지대였다). 2R에서 BLOCKED_BARE_COLUMN0_RE가 사유 요구 없이 넓어져 이제 잡힌다",
    );
    assert.notEqual(
      result.state,
      "BLOCKED",
      "설계 판정 「A」: 사유 없는 arrowless 표지도 «보고»만 되고 «수락»되지는 않는다",
    );
  });
});

test("HYK-333 2R (9) 'NEEDS_INPUT:' 뒤에 사유도 화살표도 없이 개행 -> state=MALFORMED_BLOCKED로 보고된다 (검토 P2-1, BLOCKED와 동일한 방식)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\nNEEDS_INPUT:\n");
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
    assert.notEqual(
      result.state,
      "NEEDS_INPUT",
      "설계 판정 「A」: 사유 없는 arrowless NEEDS_INPUT도 «보고»만 되고 «수락»되지는 않는다",
    );
  });
});
