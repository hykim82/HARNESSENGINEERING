// HYK-442: relay-handshake.mjs의 근접-미스 탐지(BLOCKED_ANYWHERE_RE/
// BLOCKED_BARE_COLUMN0_RE)는 파일 «어디에나» 있는 표지-모양 문자열을 센다
// -- 인용부호로 감싼 인용(워커가 자기점검 산문에서 "표지 형식은 이렇다"고
// 설명하려고 `>>> BLOCKED:` 를 그대로 인용한 자리)까지 「근접-미스 표지
// 흔적」으로 세어, 정상 종료(well-formed 1개)를 "유효+깨짐 혼재"로 승격
// 시켜 소비를 막는 실사고가 있었다(2026-09-05, coder-task.md 1R §1-1, 실물
// 재현 coder-437-PRE-EDIT-1758.md 166행 -- 이 파일 아래 (1)이 그 구조를
// 재현한다) 및 표지 자체가 아예 없는 라운드에서도 인용문 하나만으로
// MALFORMED_BLOCKED로 잘못 승격되는 사고(coder-5R-blocked.md 185행 -- 이
// 파일 아래 (2)가 그 구조를 재현한다).
//
// HYK-442 2R: 1R은 «인용부호»를 백틱 «한 원소»로만 좁게 정의했다 -- 그
// 직후 같은 보고서 자신이 «작은따옴표»로 인용한 두 줄에 똑같이 걸려 정지
// 종결이 다시 막혔다(실물 재현: coder-laneB-PRE-EDIT.md 50/54행 -- 이 파일
// 아래 (1b)가 그 구조를 재현한다). 2R 수리는 인용부호 category를 표준
// 3종(백틱·홑따옴표·겹따옴표) 전부 한 번에 닫는다(relay-handshake.mjs의
// stripQuotedSpansForNearMissScan 자신의 헤더 참조 -- 왜 이 셋이 "닫힌
// category"이고 괄호/표 셀은 범위 밖인지).
//
// 이 파일이 고정하는 것:
//   1. 백틱 인용 + 진짜 well-formed 표지 1개 공존 -> state=BLOCKED (혼재
//      아님).
//   1b. (2R 신규) 홑따옴표 인용(coder-laneB-PRE-EDIT.md 실물 구조) + 진짜
//      well-formed 표지 1개 공존 -> state=BLOCKED (혼재 아님).
//   1c. (2R 신규) 겹따옴표 인용 + 진짜 well-formed 표지 1개 공존 ->
//      state=BLOCKED (다음 인용부호가 나와도 다시 막히지 않음을 미리 증명).
//   2. 백틱 인용만 있고 진짜 표지가 없음 -> state=NONE(PENDING) (근접-미스
//      아님).
//   3-7. §4 회귀 ⓐ-ⓔ(비타협) -- 인용부호 없는 진짜 근접-미스/모호/부재는
//      전부 기존과 동일하게 계속 잡힌다(약화 0).
//   8. 되돌림 변이(RED): stripQuotedSpansForNearMissScan을 항등함수로
//      되돌리면 (1)/(1b)/(1c)가 다시 MALFORMED_BLOCKED로 떨어짐을 확인 --
//      이 fix가 실제로 그 결과를 만드는 원인임을 증명한다. 실 소스는
//      바이트 동일 복원.
//
// HYK-442 4R: 검토 1R이 2R을 P1으로 뚫었다(`paired-apostrophes-span-marker`)
// -- 인용부호 «집합»을 넓힌 2R 수리가, 홑따옴표의 두 얼굴(인용 구분자 /
// 단어 속 아포스트로피)을 구별하지 않아 자연어 축약형 두 개 사이에 놓인
// «진짜» 근접-미스 표지를 통째로 지웠다(막아야 할 것을 놓치는 fail-open).
// 4R은 집합을 넓히지도 좁히지도 않고 판별 «근거»를 두 축으로 바꾼다 --
// 축 A(구분자 «역할»로 판별: 여는 홑따옴표는 단어 문자 뒤에 오지 않는다) ·
// 축 B(줄-선두 표지 시도는 어떤 문장부호로도 가려지지 않는다). 근거 원문은
// relay-handshake.mjs의 stripQuotedSpansForNearMissScan 헤더.
// 이 파일이 4R에서 추가로 고정하는 것:
//   8(4R). 검토자 공격의 재현 -- 아포스트로피에 숨은 진짜 근접-미스가
//      감지된다(MALFORMED_BLOCKED).
//   9(4R). ★양방향 동시 성립 -- 원래 사고 파일 2건은 여전히 정상 소비되고
//      (과차단 0), 같은 판별기가 위 공격은 잡는다(누락 0).
//   10(4R). 축 B: 줄-선두 표지 시도는 같은 줄의 인용부호에 삼켜지지 않는다.
//   되돌림 변이 2종(축 A 되돌림 -> 공격 재통과 / 스트립 전체 되돌림 ->
//      원래 사고 2건 재과차단).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { checkRelayHandshake } from "./relay-handshake.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const RELAY_HANDSHAKE_PATH = join(CHECK_DIR, "relay-handshake.mjs");

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "hyk442-quote-nm-test-"));
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

const TASK_HEADER = "task_id: HYK-1\ndropped_at: 2026-09-05 21:00 KST\n";
// HYK-414 (time-judgment-now-injection ratchet): this file's fixtures embed
// absolute timestamps (TASK_HEADER's dropped_at) -- checkRelayHandshake must
// always be called with an explicit `now` fixed shortly after that value,
// never the real Date.now() default (coder-task.md's own ratchet catches
// the omission).
const FIXED_NOW = Date.parse("2026-09-05T12:05:00Z"); // 2026-09-05 21:05 KST

// coder-437-PRE-EDIT-1758.md 166/177행 구조의 최소 재현: 자기점검 산문 한
// 줄 안에 백틱으로 감싼 `>>> BLOCKED:` 인용 + 별도 줄의 진짜 well-formed
// 표지.
const QUOTE_PLUS_REAL_MARKER_BODY =
  `${TASK_HEADER.replace("task_id: HYK-1\n", "")}` +
  "task_id: HYK-1\n\n" +
  "- 표지 확인: `>>> DONE:`은 아직 못 찍는다(막히면 `>>> BLOCKED:` 한 줄, DONE과 배타).\n\n" +
  ">>> BLOCKED: 러너 재실행 상한 도달, 표본 수집으로 전환\n";

// coder-laneB-PRE-EDIT.md 50/54행 구조의 최소 재현(2R 실사고): 자기점검
// 산문 안에 «홑따옴표»로 감싼 `>>> BLOCKED:` 인용 두 곳 + 별도 줄의 진짜
// well-formed 표지. 1R의 백틱 전용 수리는 이 구조를 못 벗겨 정지 종결이
// 다시 막혔었다.
const SINGLE_QUOTE_PLUS_REAL_MARKER_BODY =
  "task_id: HYK-1\n\n" +
  "✔ 회귀 ⓐ: 백틱 없는 앞 공백 마커(' >>> BLOCKED: x') -> 여전히 MALFORMED_BLOCKED\n" +
  "✔ 회귀 ⓔ: 백틱 없는 콜론 없는 '>>> BLOCKED x' -> 여전히 MALFORMED_BLOCKED\n\n" +
  ">>> BLOCKED: 완료조건 미충족, 정지\n";

// 다음 인용부호(겹따옴표)가 나와도 같은 방식으로 다시 막히지 않음을
// 미리 증명 -- 책임자가 경계한 "다음엔 겹따옴표"에 대한 선제 대응.
const DOUBLE_QUOTE_PLUS_REAL_MARKER_BODY =
  "task_id: HYK-1\n\n" +
  '자기점검: "표지는 >>> BLOCKED: 형태로 한 줄이어야 한다"는 계약을 확인했다.\n\n' +
  ">>> BLOCKED: 완료조건 미충족, 정지\n";

// coder-5R-blocked.md 185행 구조의 최소 재현: 백틱 인용만 있고 실제 표지는
// 없음.
const QUOTE_ONLY_NO_REAL_MARKER_BODY =
  "task_id: HYK-1\n\n" +
  "- 표지 4종 각 1개 유지(`>>> DONE:` 자리에 `>>> BLOCKED:` -- 완료가 아니므로).\n";

// ---------------------------------------------------------------------------
// HYK-442 4R (검토 1R P1-ⓐ). 아래 세 상수가 이 라운드의 «양방향» 축이다.
//
// ⓐ/ⓑ 원래 사고 파일 «2건»의 표지-관련 줄 원문(과차단 0 회귀 기준).
//    ⛔발췌 기준은 임의가 아니다: 두 파일 전체를 `BLOCKED|NEEDS_INPUT`으로
//    훑어 «매치 후보가 되는 줄 전부»를 그대로 옮겼다(근접-미스 계수는
//    BLOCKED_ANYWHERE_RE/BLOCKED_BARE_COLUMN0_RE 두 정규식에만 의존하고,
//    두 정규식은 그 낱말이 없는 줄에는 원리적으로 매치하지 않는다). 그래서
//    이 픽스처의 판정은 원본 파일 전체의 판정과 같다.
// ⓒ 검토자가 P1으로 뚫은 공격(`paired-apostrophes-span-marker`)의 재현:
//    자연어 축약형 아포스트로피 두 개가 «진짜» 근접-미스 표지를 사이에 두고
//    나타난다 -- 2R의 "홑따옴표는 언제나 인용 구분자" 규칙은 그 사이를
//    통째로 인용으로 보고 지워, 표지가 사라졌다(fail-open).
// ---------------------------------------------------------------------------

// coder-437-PRE-EDIT-1758.md 166행(백틱 인용)·177행(진짜 표지) 원문 그대로.
const ACCIDENT_437_MARKER_LINES_BODY =
  "task_id: HYK-1\n\n" +
  "- 표지 4종(`task_id:`·`role:`·`head_commit:`·`>>> DONE:`) 각 정확히 1개 — 이 시점 확인. `>>> DONE:`은 완료 조건 5(전체 러너 초록)를 못 채워 **찍지 않는다**(§3-b: 막히면 `>>> BLOCKED:` 한 줄, DONE과 배타).\n\n" +
  ">>> BLOCKED: §3 완료조건 5(전체 러너 초록) 미충족 — 러너 재실행 상한(2회) 도달 후 ORCH가 3회차 진행 중 직접 중단 지시(23:5x KST), 표본 수집으로 전환해 위 §4에 두 실패 원문·측정값을 기록했다.\n";

// coder-laneB-PRE-EDIT.md 15·50·51·52·54·84·196행 원문 그대로(홑따옴표
// 인용 3종 + 백틱 인용 + 진짜 표지 1개).
const ACCIDENT_LANEB_MARKER_LINES_BODY =
  "task_id: HYK-1\n\n" +
  '**원인**: `scripts/check/relay-handshake.mjs`의 근접-미스 탐지(`BLOCKED_ANYWHERE_RE`/`BLOCKED_BARE_COLUMN0_RE`)가 파일 «어디에나» 있는 표지-모양 문자열을 센다. 워커가 자기점검 산문에서 표지 문법을 인라인 코드(백틱)로 인용한 자리("- 표지 확인: `>>> DONE:`은 아직 못 찍는다(막히면 `>>> BLOCKED:` 한 줄...)")까지 근접-미스로 세어, 정상 종료(well-formed 1개)를 "유효+깨짐 혼재"(`MALFORMED_BLOCKED`)로 잘못 승격시켰다.\n' +
  "✔ HYK-442 (3) §4 회귀 ⓐ: 백틱 없는 앞 공백 마커(' >>> BLOCKED: x') -> 여전히 MALFORMED_BLOCKED\n" +
  "✔ HYK-442 (4) §4 회귀 ⓑ: 백틱 없는 '>>>' 없는 칼럼0 근접실패('BLOCKED: x') -> 여전히 MALFORMED_BLOCKED\n" +
  "✔ HYK-442 (5) §4 회귀 ⓒ: 백틱 없는 진짜 표지 2개 -> 여전히 AMBIGUOUS_BLOCKED\n" +
  "✔ HYK-442 (7) §4 회귀 ⓔ: 백틱 없는 콜론 없는 '>>> BLOCKED x' -> 여전히 MALFORMED_BLOCKED\n" +
  "✔ HYK-442 되돌림 변이: 인라인 코드 스팬 제외 로직을 항등함수로 되돌리면 (1)의 백틱 인용이 다시 근접-미스로 세져 MALFORMED_BLOCKED로 떨어진다(RED), 실 소스는 바이트 동일 복원\n\n" +
  ">>> BLOCKED: 완료조건 6(npm test 정본 명령 연속 2회 초록)만 미충족 -- 재실행 여부·시점은 ORCH 판단에 맡기고 정지한다.\n";

// 검토 1R `paired-apostrophes-span-marker` 재현. 축약형 두 개(couldn't /
// don't)의 아포스트로피가 «진짜» 근접-미스 표지(콜론 없는 화살표 표지)를
// 사이에 끼고 있다 -- 인용하려는 의도가 조금도 없는 자연어 한 줄이다.
// 2R HEAD: 그 사이가 통째로 스트립돼 근접-미스가 0개로 세어져 유효 표지
// 1개만 남은 것으로 판정(state=BLOCKED) = fail-open.
// 4R: 여는 자리 규칙(축 A)이 두 아포스트로피를 구분자로 인정하지 않으므로
// 표지가 그대로 세어져 "유효 1 + 근접-미스 1" 혼재(MALFORMED_BLOCKED).
const APOSTROPHE_HIDDEN_NEAR_MISS_BODY =
  "task_id: HYK-1\n\n" +
  "We couldn't finish the runner, so >>> BLOCKED cap reached is what I don't want to lose here.\n\n" +
  ">>> BLOCKED: 완료조건 미충족, 정지\n";

test("HYK-442 (1) 백틱 인용 + 진짜 well-formed 표지 1개 공존 -> state=BLOCKED (유효+깨짐 혼재로 잘못 승격되지 않는다)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", QUOTE_PLUS_REAL_MARKER_BODY);
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "BLOCKED",
      "백틱으로 감싼 인용은 근접-미스로 세면 안 된다 -- 세면 이전처럼 MALFORMED_BLOCKED로 잘못 떨어진다",
    );
    assert.match(result.reason, /러너 재실행 상한 도달, 표본 수집으로 전환/);
  });
});

test("HYK-442 2R (1b) 홑따옴표 인용(coder-laneB-PRE-EDIT.md 실물 구조) + 진짜 well-formed 표지 1개 공존 -> state=BLOCKED (1R이 놓친 인용부호도 이제 벗겨진다)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", SINGLE_QUOTE_PLUS_REAL_MARKER_BODY);
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "BLOCKED",
      "홑따옴표로 감싼 인용도 근접-미스로 세면 안 된다 -- 1R은 백틱만 벗겨 이 구조에서 다시 막혔었다(coder-task.md 2R §1-1)",
    );
    assert.match(result.reason, /완료조건 미충족, 정지/);
  });
});

test("HYK-442 2R (1c) 겹따옴표 인용 + 진짜 well-formed 표지 1개 공존 -> state=BLOCKED (다음 인용부호도 선제 방어)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", DOUBLE_QUOTE_PLUS_REAL_MARKER_BODY);
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "BLOCKED");
    assert.match(result.reason, /완료조건 미충족, 정지/);
  });
});

test("HYK-442 (2) 백틱 인용만 있고 진짜 표지가 없음 -> state=PENDING(NONE 경로), MALFORMED_BLOCKED로 잘못 승격되지 않는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", QUOTE_ONLY_NO_REAL_MARKER_BODY);
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "PENDING",
      "표지를 쓰려는 시도가 전혀 없는 라운드(인용문 하나뿐)는 근접-미스가 아니라 그냥 진행중이다",
    );
  });
});

test("HYK-442 (3) §4 회귀 ⓐ: 인용부호 없는 앞 공백 마커(공백 후 화살표+BLOCKED) -> 여전히 MALFORMED_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n >>> BLOCKED: leading space\n",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
  });
});

test("HYK-442 (4) §4 회귀 ⓑ: 인용부호 없는 화살표 없는 칼럼0 근접실패(BLOCKED: x) -> 여전히 MALFORMED_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\nBLOCKED: no arrows\n");
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
  });
});

test("HYK-442 (5) §4 회귀 ⓒ: 인용부호 없는 진짜 표지 2개 -> 여전히 AMBIGUOUS_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n>>> BLOCKED: first\n>>> BLOCKED: second\n",
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "AMBIGUOUS_BLOCKED");
  });
});

test("HYK-442 (6) §4 회귀 ⓓ: 표지 0개(인용부호도 없음) -> 여전히 PENDING", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\n작업 진행 중, 표지 없음\n");
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "PENDING");
  });
});

test("HYK-442 (7) §4 회귀 ⓔ: 인용부호 없는 콜론 없는 화살표+BLOCKED -> 여전히 MALFORMED_BLOCKED", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", "task_id: HYK-1\n\n>>> BLOCKED no colon here\n");
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "MALFORMED_BLOCKED");
  });
});

// --- HYK-442 4R: 검토 1R P1-ⓐ 공격 + «양방향» 동시 성립 -------------------

test("HYK-442 4R (8) 검토 1R P1-ⓐ 공격 재현(paired-apostrophes-span-marker): 자연어 축약형 아포스트로피 두 개 사이에 놓인 «진짜» 근접-미스 표지가 이제 감지된다(MALFORMED_BLOCKED)", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", APOSTROPHE_HIDDEN_NEAR_MISS_BODY);
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(result.ok, false);
    assert.equal(
      result.state,
      "MALFORMED_BLOCKED",
      "2R(HEAD)는 여기서 BLOCKED를 돌려줬다 -- 아포스트로피 쌍이 진짜 근접-미스를 삼켜 «막아야 할 것을 놓치는» fail-open(검토 1R 34행)",
    );
  });
});

test("HYK-442 4R (9) ★양방향 동시 성립: 원래 사고 파일 2건은 여전히 정상 소비(BLOCKED)되고, 같은 판별기가 아포스트로피에 숨은 근접-미스는 잡는다", () => {
  // ⓐ 과차단 0 -- 이 조각이 애초에 구제하려던 두 파일.
  for (const [label, body, expectedReason] of [
    [
      "coder-437-PRE-EDIT-1758.md",
      ACCIDENT_437_MARKER_LINES_BODY,
      /완료조건 5/,
    ],
    ["coder-laneB-PRE-EDIT.md", ACCIDENT_LANEB_MARKER_LINES_BODY, /완료조건 6/],
  ]) {
    withFixtureDir((dir) => {
      writeTask(dir, "coder", TASK_HEADER);
      writeResult(dir, "coder", body);
      const result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW,
      });
      assert.equal(
        result.state,
        "BLOCKED",
        `${label}: 인용 언급은 계속 무시돼야 한다(과차단 0) -- 이것이 무너지면 원래 사고가 되살아난다`,
      );
      assert.match(result.reason, expectedReason, `${label}: 사유 원문 추출`);
    });
  }

  // ⓑ 누락 0 -- 같은 판별기가, 같은 실행 안에서, 숨긴 근접-미스는 잡는다.
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(dir, "coder", APOSTROPHE_HIDDEN_NEAR_MISS_BODY);
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(
      result.state,
      "MALFORMED_BLOCKED",
      "누락 0: 아포스트로피에 둘러싸인 진짜 근접-미스는 놓치지 않는다 -- 이 조각의 값은 정확히 ⓐ와 ⓑ 사이에 있다",
    );
  });
});

test("HYK-442 4R (10) 축 B(줄-선두 불가침): 줄이 표지 모양으로 «시작»하면 같은 줄 어디에 어떤 인용부호가 있어도 그 줄은 스트립되지 않는다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    // 선행 공백 근접-미스 표지 한 줄인데, 그 줄 안에 백틱/겹따옴표 인용이
    // 함께 있다 -- 축 A만 있었다면 인용 처리 순서에 따라 삼켜질 수 있는
    // 자리다. 축 B는 그런 줄을 아예 스트립 대상에서 뺀다.
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n" +
        ' >>> BLOCKED: `러너` 실패 -- "표본 수집"으로 전환\n',
    );
    const result = checkRelayHandshake({
      role: "coder",
      harnessDir: dir,
      now: FIXED_NOW,
    });
    assert.equal(
      result.state,
      "MALFORMED_BLOCKED",
      "줄-선두 표지 시도는 무엇으로도 가려지지 않는다",
    );
  });
});

// --- 되돌림 변이 (coder-task.md 2R §3 조건4): stripQuotedSpansForNearMissScan을
// 항등함수로 되돌려 (1)/(1b)가 다시 MALFORMED_BLOCKED로 떨어지는지(RED)
// 확인하고, 실 소스 파일이 바이트 동일하게 복원됨을 증명한다. 격리 픽스처는
// relay-handshake.mjs가 정적 import하는 형제 파일을 함께 복사한다(단일 소스
// RELAY_HANDSHAKE_STATIC_SIBLINGS 재사용, relay-handshake-marker-promotion.
// test.mjs와 동일한 house style).
// ---------------------------------------------------------------------------

function stageMinimalRelayHandshakeDeps(rootDir) {
  const checkDir = join(rootDir, "scripts", "check");
  mkdirSync(checkDir, { recursive: true });
  for (const name of RELAY_HANDSHAKE_STATIC_SIBLINGS) {
    writeFileSync(
      join(checkDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  return { checkDir };
}

// 변이 소스를 격리 픽스처에 심고 결과 본문 하나의 판정 상태를 돌려준다
// (ESLint max-lines-per-function 상한 회피용 추출, HYK-148 house style).
async function stateUnderMutatedSource(mutated, body, tag) {
  const rootDir = mkdtempSync(join(tmpdir(), `hyk442-mut-root-${tag}-`));
  const harnessDir = mkdtempSync(join(tmpdir(), `hyk442-mut-h-${tag}-`));
  try {
    const { checkDir } = stageMinimalRelayHandshakeDeps(rootDir);
    writeFileSync(join(checkDir, "relay-handshake.mjs"), mutated, "utf8");
    writeFileSync(join(harnessDir, "coder-task.md"), TASK_HEADER, "utf8");
    writeFileSync(join(harnessDir, "coder.md"), body, "utf8");
    const mod = await import(
      `file://${join(checkDir, "relay-handshake.mjs")}?t=${Date.now()}-${tag}`
    );
    return mod.checkRelayHandshake({
      role: "coder",
      harnessDir,
      now: FIXED_NOW,
    }).state;
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

function mutateExactlyOnce(src, target, replacement, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (${label}) must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, replacement);
  assert.notEqual(mutated, src, "mutation must actually change the source");
  return mutated;
}

function assertRelayHandshakeRestored(src) {
  const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  assert.equal(
    after,
    src,
    "원복 증명 실패: 실제 relay-handshake.mjs가 이 시험 도중 바뀌었다",
  );
}

// 축 A 되돌림: 여는-자리 규칙을 빼고 2R의 "홑따옴표는 언제나 구분자"로
// 되돌리면 (8)의 공격이 다시 통과(BLOCKED = fail-open)해야 한다.
const AXIS_A_TARGET =
  "const NEAR_MISS_QUOTED_SPAN_RE =\n" +
  "  /`[^`\\n]*`|\"[^\"\\n]*\"|(?<![\\p{L}\\p{N}])'[^'\\n]*'/gu;\n";
const AXIS_A_PRE_FIX =
  "const NEAR_MISS_QUOTED_SPAN_RE = /`[^`\\n]*`|\"[^\"\\n]*\"|'[^'\\n]*'/g;\n";

// 스트립 전체 되돌림: 항등함수로 되돌리면 원래 사고 파일 2건이 다시
// 과차단(MALFORMED_BLOCKED)돼야 한다.
const STRIP_BODY_TARGET =
  "  return resultContent\n" +
  '    .split("\\n")\n' +
  "    .map((line) =>\n" +
  "      NEAR_MISS_LINE_LEADING_ATTEMPT_RE.test(line)\n" +
  "        ? line\n" +
  '        : line.replace(NEAR_MISS_QUOTED_SPAN_RE, ""),\n' +
  "    )\n" +
  '    .join("\\n");\n';

test("HYK-442 4R 되돌림 변이 ①(축 A): 여는-자리 규칙을 2R의 무조건 구분자로 되돌리면 (8) 아포스트로피 공격이 다시 삼켜져 BLOCKED로 통과한다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const mutated = mutateExactlyOnce(
    src,
    AXIS_A_TARGET,
    AXIS_A_PRE_FIX,
    "NEAR_MISS_QUOTED_SPAN_RE (축 A)",
  );
  try {
    assert.equal(
      await stateUnderMutatedSource(
        mutated,
        APOSTROPHE_HIDDEN_NEAR_MISS_BODY,
        "a",
      ),
      "BLOCKED",
      "RED: 축 A 없이는 축약형 아포스트로피 쌍이 진짜 근접-미스를 다시 삼킨다 -- 이 규칙이 P1-ⓐ를 닫는 원인임을 증명",
    );
    assert.equal(
      await stateUnderMutatedSource(
        mutated,
        ACCIDENT_LANEB_MARKER_LINES_BODY,
        "a2",
      ),
      "BLOCKED",
      "축 A 되돌림은 «과차단» 쪽은 건드리지 않는다(원래 사고 파일은 두 소스 모두에서 정상 소비) -- 변이가 정확히 한 방향만 바꿈을 고정",
    );
  } finally {
    assertRelayHandshakeRestored(src);
  }
});

test("HYK-442 4R 되돌림 변이 ②(스트립 전체): 인용 제외를 항등함수로 되돌리면 원래 사고 파일 2건이 다시 MALFORMED_BLOCKED로 과차단된다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const mutated = mutateExactlyOnce(
    src,
    STRIP_BODY_TARGET,
    "  return resultContent;\n",
    "stripQuotedSpansForNearMissScan body",
  );
  try {
    for (const [tag, label, body] of [
      ["b1", "coder-437-PRE-EDIT-1758.md", ACCIDENT_437_MARKER_LINES_BODY],
      ["b2", "coder-laneB-PRE-EDIT.md", ACCIDENT_LANEB_MARKER_LINES_BODY],
      ["b3", "(1) 백틱 최소 재현", QUOTE_PLUS_REAL_MARKER_BODY],
      ["b4", "(1b) 홑따옴표 최소 재현", SINGLE_QUOTE_PLUS_REAL_MARKER_BODY],
    ]) {
      assert.equal(
        await stateUnderMutatedSource(mutated, body, tag),
        "MALFORMED_BLOCKED",
        `RED(${label}): 인용 제외 없이는 인용 언급이 다시 근접-미스로 세져 유효+깨짐 혼재로 잘못 승격된다`,
      );
    }
  } finally {
    assertRelayHandshakeRestored(src);
  }
});
