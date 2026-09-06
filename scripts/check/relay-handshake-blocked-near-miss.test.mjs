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

// ⛔HYK-442 5R에서 «계약이 바뀐» 유일한 시험이다(회귀 0을 지키지 못한 한 건 --
// coder.md §2-1에 등급과 불가능성 증명과 함께 기재). 원래 기대는
// MALFORMED_BLOCKED였다: "유효 표지 한 줄 + 줄 중간 깨진 마커"를 혼재로 본다.
//
// 왜 바뀌었나: 이 입력의 둘째 줄(`status: >>> BLOCKED: midline`)은 2026-09-05
// 실사고의 두 결과 파일이 «인용»한 줄(coder-437-PRE-EDIT-1758.md 166행 ·
// coder-laneB-PRE-EDIT.md 50/54행)과 구조가 완전히 같다 -- 둘 다 «줄 앞에
// 산문이 있고 줄 중간에 표지 모양이 나오는» 줄이고, 다른 점은 오직 표지
// 모양을 인용부호가 감싸고 있느냐뿐이다. 그래서 이 둘을 다르게 판정하려면
// 반드시 «인용인지 추정»해야 하고, 그 축은 이 이슈에서 세 번(1R 좁힘 · 2R
// 넓힘 · 4R 배치 규칙) 뚫렸다(검토 1R/2R 실측). 책임자 지시(coder-task.md 5R
// §2-1)가 그 축을 버리고 근접-미스의 «정의»를 구조로 좁히라고 요구했고, 그
// 정의 아래에서 «줄 중간·앞에 산문»은 표지 «시도»가 아니라 문장의 일부다.
//
// 안전 방향: 표지를 «수락»하는 경로(BLOCKED_RE, column-0 한 줄)는 조금도
// 바뀌지 않았다 -- 이 변화는 «유효 표지 하나만 있는 파일을 혼재로 보지
// 않는다»는 것뿐이고, 잃어버릴 수 있는 정지 신호는 «줄 머리에서 시작한
// 시도»뿐인데 그쪽은 이 라운드가 오히려 넓혔다(BOM·제로폭·기호 접두 전부).
test("HYK-442 5R (구 HYK-333 (6), 계약 변경): 유효 '>>> BLOCKED:' 한 줄 + «앞에 산문이 있는» 줄중간 표지 모양 -> BLOCKED (줄 중간 언급은 표지 시도가 아니다)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: valid\nstatus: >>> BLOCKED: midline\n",
    );
    const result = checkRelayHandshake({ role: "coder", harnessDir: dir });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(
      result.reason,
      /valid/,
      "유효 표지 한 줄의 사유가 그대로 채택된다",
    );
  });
});

test("HYK-442 5R (구 HYK-333 (6)의 안전 축은 유지): 같은 파일에서 둘째 표지가 «줄 머리»에서 시작하면(앞에 산문 없음) 여전히 MALFORMED_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: valid\n- >>> BLOCKED: broken attempt\n",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      // HYK-414 래칫: 새로 추가하는 호출은 now를 명시한다(이 파일 픽스처의
      // dropped_at 2026-08-08 21:00 KST 직후로 고정).
      now: Date.parse("2026-08-08T12:05:00Z"),
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "MALFORMED_BLOCKED",
      "혼재 판정 자체는 살아 있다 -- 사라진 것은 «줄 중간 언급»뿐이고, 글머리표·기호가 앞에 붙은 진짜 시도는 계속 잡힌다",
    );
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
