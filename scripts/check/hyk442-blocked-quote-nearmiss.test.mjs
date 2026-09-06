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
// HYK-442 4R: 검토 1R이 2R을 P1으로 뚫었고(`paired-apostrophes-span-marker`),
// 4R은 인용부호 집합을 그대로 둔 채 판별 «근거»를 두 축(여는-자리 역할 ·
// 줄-선두 불가침)으로 바꿨다. 검토 2R이 그 두 축도 여섯 입력으로 뚫었다
// (`'tis`/`'26`/문장-시작 홑따옴표/비대칭 닫기/BOM/제로폭).
//
// ★HYK-442 5R: 세 번의 실패는 전부 «이 따옴표가 인용인가»를 문장부호로
// 추정한 데서 왔다. 5R은 그 축 자체를 버렸다 -- 인용부호를 한 글자도 다루지
// 않고, 근접-미스의 «정의»를 구조로 좁힌다: ★표지 모양 앞에 글자도 숫자도
// 없는 줄만 «표지를 쓰려는 시도»로 센다. 근거 원문은 relay-handshake.mjs의
// countNearMissMarkerShapes 헤더(스트립 함수 자체가 사라졌다).
// ⚠️(1)(1b)(1c)(2)의 «인용 언급» 케이스가 계속 초록인 이유도 이제 인용부호가
// 아니라 «줄 앞에 산문이 있다»는 사실 하나다.
// 이 파일이 5R에서 추가로 고정하는 것:
//   8. 검토 2R 여덟 라벨 전부 MALFORMED_BLOCKED(여섯은 4R HEAD에서 fail-open).
//   9. ★양방향 동시 성립 -- 원래 사고 파일 2건은 여전히 정상 소비되고
//      (과차단 0), 같은 판별기가 여덟 공격을 전부 잡는다(누락 0).
//   10. 보이지 않는 문자 정규화 -- BOM 뒤 칼럼0 표지 시도도 잡힌다.
//   11. 좁아진 정의의 반대쪽(정직 한계의 시험화) -- 앞에 산문이 있는 줄
//      중간 표지 모양은 인용부호 유무와 무관하게 근접-미스가 아니다.
//   되돌림 변이 2종(줄-앞 산문 판별 되돌림 -> 원래 사고 2건 재과차단 /
//      보이지 않는 문자 정규화 되돌림 -> BOM 뒤 시도 재유실).
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

// ===========================================================================
// HYK-442 5R (검토 2R P1-ⓐ): «인용인지 추정하는» 축을 버린 뒤의 계약.
//
// 검토 2R은 4R의 두 축(여는-자리 역할 · 줄-선두 불가침)을 여섯 입력으로
// 뚫었다. 5R은 축을 정교하게 만드는 대신 근접-미스의 «정의»를 구조로 좁혔다:
//   ★표지 모양 앞에 «글자도 숫자도 없는» 줄만 표지 «시도»로 센다.
// 인용부호는 글자도 숫자도 아니므로 판정에 관여하지 않는다 -- 백틱·홑따옴표·
// 겹따옴표·유니코드 유사 따옴표·괄호·BOM·제로폭 문자 중 어느 것도 «묻지
// 않는다»(근거 원문: relay-handshake.mjs의 countNearMissMarkerShapes 헤더).
// ===========================================================================

// 검토 2R의 여덟 라벨을 이 라운드의 픽스처로 재현한다. 각 본문은 «정상 종료
// 한 줄(well-formed)» + «숨긴 표지 시도 한 줄»로 이뤄진다 -- 숨긴 쪽이 세어
// 지면 MALFORMED_BLOCKED(혼재), 지워지면 BLOCKED(fail-open)로 갈린다.
// ⚠️각 공격 줄의 표지 시도는 «줄 머리»에서 시작한다(앞에는 인용부호·글머리
// 표·기호·보이지 않는 문자만 온다) -- 즉 잃어버리면 안 되는 «진짜 정지
// 신호»다. 이 여덟 픽스처의 4R HEAD/5R 판정 원문은 coder.md §3-1에 붙였다.
const ATTACK_VALID_TAIL = "\n\n>>> BLOCKED: 완료조건 미충족, 정지\n";
const attackBody = (line) => `task_id: HYK-1\n\n${line}${ATTACK_VALID_TAIL}`;

const REVIEW_2R_ATTACKS = [
  // 축 A ⓵ 여는 홑따옴표가 «단어 문자 뒤»가 아니어서 구분자로 오인된다
  // (`'tis` 축약형이 같은 줄에서 닫는 자리로 쓰인다).
  ["apostrophe-tis", attackBody("⛔ ' >>> BLOCKED cap reached 'tis over'")],
  // 축 A ⓶ 연도 축약(`'26`)이 닫는 자리로 오인된다.
  ["apostrophe-year", attackBody("- ' >>> BLOCKED cap reached in '26 hours'")],
  // 축 A ⓷ 문장 시작 홑따옴표.
  ["sentence-start-apostrophe", attackBody("' >>> BLOCKED cap reached'")],
  // 축 A ⓸ 여는 자리만 제한하고 닫는 자리는 제한하지 않은 비대칭.
  [
    "asymmetric-close",
    attackBody("(' >>> BLOCKED cap reached, the runner don't stop')"),
  ],
  // 축 B ⓹ BOM이 줄 앞에 오면 4R의 줄-선두 보호가 작동하지 않았다.
  ["axis-bom", attackBody("﻿'>>> BLOCKED cap reached'")],
  // 축 B ⓺ 제로폭 문자도 같다.
  ["axis-zero-width", attackBody("​'>>> BLOCKED cap reached'")],
  // 대조군 ⓐ CRLF -- 4R HEAD에서도 잡혔고 5R에서도 잡힌다.
  [
    "axis-crlf",
    "task_id: HYK-1\r\n\r\n >>> BLOCKED cap reached\r\n\r\n>>> BLOCKED: 완료조건 미충족, 정지\r\n",
  ],
  // 대조군 ⓑ 유니코드 유사 따옴표(U+2019) -- 4R의 집합 밖이라 잡혔다.
  ["unicode-lookalike-quotes", attackBody("’ >>> BLOCKED cap reached’")],
];

test("HYK-442 5R (8) 검토 2R 여덟 라벨 전부 MALFORMED_BLOCKED -- 어떤 문장부호·보이지 않는 문자로 둘러싸도 줄 머리에서 시작한 표지 시도는 사라지지 않는다", () => {
  const observed = [];
  for (const [label, body] of REVIEW_2R_ATTACKS) {
    withFixtureDir((dir) => {
      writeTask(dir, "coder", TASK_HEADER);
      writeResult(dir, "coder", body);
      const result = checkRelayHandshake({
        role: "coder",
        harnessDir: dir,
        now: FIXED_NOW,
      });
      observed.push({ label, state: result.state });
    });
  }
  // 관측 원문을 그대로 남긴다(결과 파일에 붙일 근거).
  for (const row of observed) console.log(JSON.stringify(row));
  assert.deepEqual(
    observed,
    REVIEW_2R_ATTACKS.map(([label]) => ({
      label,
      state: "MALFORMED_BLOCKED",
    })),
    "여섯 공격은 4R HEAD에서 BLOCKED(=지워짐, fail-open)였다 -- 검토 2R 4절 원문",
  );
});

test("HYK-442 5R (9) ★양방향 동시 성립: 원래 사고 파일 2건은 여전히 정상 소비(BLOCKED)되고, 같은 판별기가 여덟 공격은 전부 잡는다", () => {
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

  // ⓑ 누락 0 -- 같은 판별기가, 같은 실행 안에서, 숨긴 표지 시도는 전부 잡는다.
  for (const [label, body] of REVIEW_2R_ATTACKS) {
    withFixtureDir((dir) => {
      writeTask(dir, "coder", TASK_HEADER);
      writeResult(dir, "coder", body);
      assert.equal(
        checkRelayHandshake({ role: "coder", harnessDir: dir, now: FIXED_NOW })
          .state,
        "MALFORMED_BLOCKED",
        `누락 0(${label}): 이 조각의 값은 정확히 ⓐ와 ⓑ 사이에 있다`,
      );
    });
  }
});

test("HYK-442 5R (10) 보이지 않는 문자 정규화: BOM 뒤의 칼럼0 근접-미스(화살표 없는 형태)도 잡힌다 -- 4R HEAD는 이 입력을 놓쳤다", () => {
  withFixtureDir((dir) => {
    writeTask(dir, "coder", TASK_HEADER);
    writeResult(
      dir,
      "coder",
      "task_id: HYK-1\n\n﻿BLOCKED: cap reached\n\n>>> BLOCKED: 완료조건 미충족, 정지\n",
    );
    assert.equal(
      checkRelayHandshake({ role: "coder", harnessDir: dir, now: FIXED_NOW })
        .state,
      "MALFORMED_BLOCKED",
      "칼럼0 판정은 보이지 않는 형식 문자를 지운 뒤에 한다 -- 안 그러면 BOM 하나로 표지 시도가 사라진다",
    );
  });
});

test("HYK-442 5R (11) 좁아진 정의의 «반대쪽»(정직 한계의 시험화): 앞에 산문이 있는 줄 중간 표지 모양은 근접-미스가 아니다 -- 인용부호 유무와 무관하게 동일하다", () => {
  // ⛔이 시험은 «바람직함»이 아니라 «현재 계약»을 고정한다. 두 입력은 인용
  // 부호 유무 말고는 구조가 완전히 같다(coder.md §2-1의 불가능성 증명) --
  // 그래서 둘을 다르게 판정하는 규칙은 반드시 «인용 추정»이 되고, 그 축은
  // 이 이슈에서 세 번 뚫렸다. 5R은 둘 다 «문장의 일부»로 본다.
  for (const [label, line] of [
    ["인용부호 있음(실사고 구조)", "설명: `>>> BLOCKED: 형식`은 이렇게 쓴다"],
    ["인용부호 없음", "status note: >>> BLOCKED midline prose"],
  ]) {
    withFixtureDir((dir) => {
      writeTask(dir, "coder", TASK_HEADER);
      writeResult(dir, "coder", attackBody(line));
      assert.equal(
        checkRelayHandshake({ role: "coder", harnessDir: dir, now: FIXED_NOW })
          .state,
        "BLOCKED",
        `${label}: 줄 앞에 산문이 있으면 표지 시도가 아니다(좁아진 정의)`,
      );
    });
  }
});

// --- 되돌림 변이 (coder-task.md §4-5) ---------------------------------------
// 두 수리 각각에 결함을 주입해 RED를 확인하고, 실 소스가 바이트 동일하게
// 복원됨을 증명한다. 격리 픽스처는 relay-handshake.mjs가 정적 import하는
// 형제 파일을 함께 복사한다(단일 소스 RELAY_HANDSHAKE_STATIC_SIBLINGS 재사용,
// relay-handshake-marker-promotion.test.mjs와 동일한 house style).
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

// 변이 ①: 줄-앞 산문 판별(이 라운드 수리의 핵심 한 줄)을 빼면 모든 표지 모양이
// 다시 세어져 «원래 사고»(인용 언급 때문에 정상 종료가 막힘)가 되살아난다.
const PROSE_GUARD_TARGET =
  "    if (!PROSE_CHAR_RE.test(scan.slice(lineStart, m.index))) count += 1;\n";
const PROSE_GUARD_PRE_FIX = "    count += 1;\n";

// 변이 ②: 보이지 않는 형식 문자 정규화를 빼면 BOM 하나로 칼럼0 표지 시도가
// 사라진다(누락 방향).
const INVISIBLE_NORMALIZE_TARGET =
  '  const scan = resultContent.replace(INVISIBLE_FORMAT_CHAR_RE, "");\n';
const INVISIBLE_NORMALIZE_PRE_FIX = "  const scan = resultContent;\n";

test("HYK-442 5R 되돌림 변이 ①(줄-앞 산문 판별): 그 한 줄을 빼면 원래 사고 파일 2건이 다시 MALFORMED_BLOCKED로 과차단된다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const mutated = mutateExactlyOnce(
    src,
    PROSE_GUARD_TARGET,
    PROSE_GUARD_PRE_FIX,
    "countNearMissMarkerShapes prose guard",
  );
  try {
    for (const [tag, label, body] of [
      ["a1", "coder-437-PRE-EDIT-1758.md", ACCIDENT_437_MARKER_LINES_BODY],
      ["a2", "coder-laneB-PRE-EDIT.md", ACCIDENT_LANEB_MARKER_LINES_BODY],
      ["a3", "(1) 백틱 최소 재현", QUOTE_PLUS_REAL_MARKER_BODY],
      ["a4", "(1b) 홑따옴표 최소 재현", SINGLE_QUOTE_PLUS_REAL_MARKER_BODY],
    ]) {
      assert.equal(
        await stateUnderMutatedSource(mutated, body, tag),
        "MALFORMED_BLOCKED",
        `RED(${label}): 줄-앞 산문 판별 없이는 산문 속 언급이 다시 근접-미스로 세져 유효+깨짐 혼재로 잘못 승격된다`,
      );
    }
    // 같은 변이가 «공격 쪽»은 바꾸지 않는다 -- 변이가 정확히 한 방향만
    // 바꿈을 고정(줄 머리 시도는 두 소스 모두에서 잡힌다).
    assert.equal(
      await stateUnderMutatedSource(mutated, REVIEW_2R_ATTACKS[0][1], "a5"),
      "MALFORMED_BLOCKED",
    );
  } finally {
    assertRelayHandshakeRestored(src);
  }
});

test("HYK-442 5R 되돌림 변이 ②(보이지 않는 문자 정규화): 정규화를 빼면 BOM 뒤 칼럼0 표지 시도가 다시 사라진다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const mutated = mutateExactlyOnce(
    src,
    INVISIBLE_NORMALIZE_TARGET,
    INVISIBLE_NORMALIZE_PRE_FIX,
    "countNearMissMarkerShapes invisible-format normalization",
  );
  const bomBareBody =
    "task_id: HYK-1\n\n﻿BLOCKED: cap reached\n\n>>> BLOCKED: 완료조건 미충족, 정지\n";
  try {
    assert.equal(
      await stateUnderMutatedSource(mutated, bomBareBody, "b1"),
      "BLOCKED",
      "RED: 정규화가 없으면 BOM 한 글자로 칼럼0 표지 시도가 판정에서 사라진다",
    );
  } finally {
    assertRelayHandshakeRestored(src);
  }
});

// 변이 ③(6R): 줄 머리 계산을 5R의 «LF 하나»로 되돌리면 LF가 아닌 네 경계
// 뒤의 표지 시도가 다시 사라진다 -- 검토 3R P1의 정확한 재현이다.
const LINE_BOUNDARY_TARGET =
  "    if (LINE_BOUNDARY_CHAR_RE.test(scan[i])) return i + 1;\n";
const LINE_BOUNDARY_PRE_FIX = '    if (scan[i] === "\\n") return i + 1;\n';

test("HYK-442 6R 되돌림 변이 ③(줄 경계 부류): 줄 머리 계산을 LF 하나로 되돌리면 네 경계 뒤의 정지 시도가 다시 유실된다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const mutated = mutateExactlyOnce(
    src,
    LINE_BOUNDARY_TARGET,
    LINE_BOUNDARY_PRE_FIX,
    "lineStartOffset line-boundary class",
  );
  try {
    for (const [i, [label, boundary]] of NON_LF_LINE_BOUNDARIES.entries()) {
      assert.equal(
        await stateUnderMutatedSource(
          mutated,
          boundaryAttackBody(boundary),
          `c${i}`,
        ),
        "BLOCKED",
        `RED(${label}): LF만 보면 앞줄 산문이 딸려 들어와 깨진 시도가 «시도가 아니다»로 사라진다(fail-open) -- 검토 3R 실측과 같은 상태`,
      );
    }
    // 같은 변이가 «LF 경계»는 바꾸지 않는다 -- 변이가 정확히 이 한 축만
    // 되돌림을 고정한다(줄 머리 시도는 두 소스 모두에서 잡힌다).
    assert.equal(
      await stateUnderMutatedSource(
        mutated,
        attackBody("⛔ >>> BLOCKED cap reached"),
        "c9",
      ),
      "MALFORMED_BLOCKED",
    );
  } finally {
    assertRelayHandshakeRestored(src);
  }
});

// ===========================================================================
// HYK-442 6R (검토 3R P1 -- 유일한 반려 사유).
//
// 5R의 «판별 축»(표지 모양 앞에 글자도 숫자도 없는 줄만 시도로 센다)은
// 검토 3R의 여덟 공격을 전부 버텼다. 뚫린 곳은 축이 아니라 그 축이 서는
// 자리 -- ★«그 줄이 어디서 시작하는가»의 계산이었다. 5R은 줄 머리를
// `lastIndexOf("\n")` 하나로 구했고, 그래서 LF가 «아닌» 줄 경계 뒤에 온 표지
// 시도는 앞줄 산문이 그대로 딸려 들어와 «시도가 아니다»로 판정됐다.
//
// 검토 3R 실측(네 경계 각각): «깨진 시도 + 유효한 정지 결과»를 함께 두면
// 네 경우 모두 BLOCKED(=시도를 놓침, fail-open). 유효 표지를 빼면 PENDING --
// 즉 ★유효 표지가 있을 때만 드러나는 fail-open이다. 아래 (12)가 그 두
// 방향을 «같은 픽스처»로 함께 고정한다.
// ===========================================================================

// 최소 집합(coder-task.md 6R §2-1): LF · CR 단독 · CRLF · U+2028 · U+2029 ·
// 폼피드. CRLF는 (13)에서 «한 개의» 경계임을 따로 고정하고, LF는 이 파일의
// 나머지 전부가 이미 고정하므로, 여기서는 5R이 놓쳤던 «네 경계»만 센다.
const NON_LF_LINE_BOUNDARIES = [
  ["cr-only", "\r"],
  ["u2028-line-separator", "\u2028"],
  ["u2029-paragraph-separator", "\u2029"],
  ["form-feed", "\f"],
];

// 앞줄에 산문을 두고, 그 산문과 «깨진 표지 시도» 사이에 LF가 아닌 줄 경계
// 하나만 넣는다. 시도 자체는 5R 계약 그대로 «줄 머리»에서 시작한다(앞에는
// 공백뿐) -- 그러므로 이것은 잃어버리면 안 되는 진짜 정지 신호다.
const boundaryAttackLine = (boundary) =>
  `앞 줄에 산문이 있다${boundary} >>> BLOCKED cap reached`;
const boundaryAttackBody = (boundary) =>
  `task_id: HYK-1\n\n${boundaryAttackLine(boundary)}${ATTACK_VALID_TAIL}`;
// 같은 픽스처에서 «유효한 정지 결과»만 뺀 것 -- 검토 3R이 PENDING을 관측한
// 대조군이다(시도를 놓쳤다는 사실 자체는 이쪽에서도 드러난다).
const boundaryAttackBodyNoValidMarker = (boundary) =>
  `task_id: HYK-1\n\n${boundaryAttackLine(boundary)}\n`;

test("HYK-442 6R (12) LF가 아닌 줄 경계 네 가지(CR 단독·U+2028·U+2029·폼피드) 뒤의 깨진 정지 시도도 근접-미스로 세어진다 -- 유효한 정지 결과가 함께 있어도 놓치지 않는다", () => {
  const observed = [];
  for (const [label, boundary] of NON_LF_LINE_BOUNDARIES) {
    for (const [variant, body] of [
      ["with-valid-marker", boundaryAttackBody(boundary)],
      ["no-valid-marker", boundaryAttackBodyNoValidMarker(boundary)],
    ]) {
      withFixtureDir((dir) => {
        writeTask(dir, "coder", TASK_HEADER);
        writeResult(dir, "coder", body);
        const result = checkRelayHandshake({
          role: "coder",
          harnessDir: dir,
          now: FIXED_NOW,
        });
        observed.push({ label, variant, state: result.state });
      });
    }
  }
  // 관측 원문을 그대로 남긴다(결과 파일에 붙일 근거).
  for (const row of observed) console.log(JSON.stringify(row));
  assert.deepEqual(
    observed,
    NON_LF_LINE_BOUNDARIES.flatMap(([label]) => [
      // 유효 표지와 «혼재» -- 5R HEAD(50f85d9)에서는 BLOCKED였다(fail-open).
      { label, variant: "with-valid-marker", state: "MALFORMED_BLOCKED" },
      // 유효 표지 없이 깨진 시도 하나뿐 -- 5R HEAD에서는 PENDING이었다.
      { label, variant: "no-valid-marker", state: "MALFORMED_BLOCKED" },
    ]),
    "줄 머리를 LF만으로 계산하면 이 네 경계 뒤의 시도는 앞줄 산문에 가려 사라진다(검토 3R P1 원문)",
  );
});

test("HYK-442 6R (13) CRLF는 «한 개»의 줄 경계다 -- 같은 본문의 LF판과 CRLF판이 모든 방향에서 동일하게 판정된다(빈 줄이 생기지 않는다)", () => {
  // ⛔이 시험이 막는 것: 줄 경계를 «문자 부류»로 넓히면서 \r과 \n을 각각
  // 하나씩 세면 CRLF 사이에 빈 줄이 생겨, 그 빈 줄 뒤에 온 표지 모양이
  // «앞에 산문이 없는 줄»로 잘못 승격될 수 있다. 네 방향(과차단·누락·
  // 칼럼0·정상)을 한꺼번에 대조한다.
  const CASES = [
    ["과차단 0(원래 사고 파일)", ACCIDENT_437_MARKER_LINES_BODY, "BLOCKED"],
    [
      "누락 0(줄 머리 시도)",
      attackBody("⛔ >>> BLOCKED cap reached"),
      "MALFORMED_BLOCKED",
    ],
    [
      "줄 중간 표지 모양(5R 정의상 시도 아님)",
      attackBody("status note: >>> BLOCKED midline prose"),
      "BLOCKED",
    ],
    [
      "칼럼0 화살표 없는 시도",
      `task_id: HYK-1\n\nBLOCKED: no arrows${ATTACK_VALID_TAIL}`,
      "MALFORMED_BLOCKED",
    ],
  ];
  const observed = [];
  for (const [label, lfBody, expected] of CASES) {
    const crlfBody = lfBody.replace(/\n/g, "\r\n");
    const states = ["lf", "crlf"].map((eol) => {
      let state;
      withFixtureDir((dir) => {
        writeTask(dir, "coder", TASK_HEADER);
        writeResult(dir, "coder", eol === "lf" ? lfBody : crlfBody);
        state = checkRelayHandshake({
          role: "coder",
          harnessDir: dir,
          now: FIXED_NOW,
        }).state;
      });
      return state;
    });
    observed.push({ label, lf: states[0], crlf: states[1] });
    assert.equal(states[0], expected, `${label}: LF판 기준선`);
    assert.equal(
      states[1],
      expected,
      `${label}: CRLF판이 LF판과 달라지면 \r\n을 두 개의 줄 경계로 센 것이다`,
    );
  }
  for (const row of observed) console.log(JSON.stringify(row));
});
