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

test("HYK-442 2R 되돌림 변이: 인용부호 제외 로직을 항등함수로 되돌리면 (1)/(1b) 둘 다 다시 근접-미스로 세져 MALFORMED_BLOCKED로 떨어진다(RED), 실 소스는 바이트 동일 복원", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  // 카운트 전용 스캔이라 오프셋/길이 보존이 필요 없다 -- 스팬 전체를 빈\n" +
    "  // 문자열로 치환해 매치 대상에서 완전히 제거한다. 세 인용부호 종류를\n" +
    "  // 한 정규식(교대, alternation)으로 동시에 처리 -- 순서 의존성이나\n" +
    "  // 다회 패스로 인한 교차-종류 간섭이 없다(각 대안이 자기 종류의 짝만\n" +
    "  // 찾고, 다른 종류의 문자는 `[^X\\n]*` 안에서 그냥 일반 문자로 통과한다).\n" +
    '  return resultContent.replace(/`[^`\\n]*`|\'[^\'\\n]*\'|"[^"\\n]*"/g, "");\n';
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target (stripQuotedSpansForNearMissScan body) must appear exactly once in the current working-tree source (found ${count})`,
  );
  const mutated = src.replace(target, "  return resultContent;\n");
  assert.notEqual(mutated, src, "mutation must actually change the source");

  const rootDir = mkdtempSync(join(tmpdir(), "hyk442-mut-root-"));
  const harnessDirBacktick = mkdtempSync(
    join(tmpdir(), "hyk442-mut-harness-bt-"),
  );
  const harnessDirSingle = mkdtempSync(
    join(tmpdir(), "hyk442-mut-harness-sq-"),
  );
  try {
    const { checkDir } = stageMinimalRelayHandshakeDeps(rootDir);
    writeFileSync(join(checkDir, "relay-handshake.mjs"), mutated, "utf8");

    writeFileSync(
      join(harnessDirBacktick, "coder-task.md"),
      TASK_HEADER,
      "utf8",
    );
    writeFileSync(
      join(harnessDirBacktick, "coder.md"),
      QUOTE_PLUS_REAL_MARKER_BODY,
      "utf8",
    );
    writeFileSync(join(harnessDirSingle, "coder-task.md"), TASK_HEADER, "utf8");
    writeFileSync(
      join(harnessDirSingle, "coder.md"),
      SINGLE_QUOTE_PLUS_REAL_MARKER_BODY,
      "utf8",
    );

    const mod = await import(
      `file://${join(checkDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const resultBacktick = mod.checkRelayHandshake({
      role: "coder",
      harnessDir: harnessDirBacktick,
      now: FIXED_NOW,
    });
    const resultSingle = mod.checkRelayHandshake({
      role: "coder",
      harnessDir: harnessDirSingle,
      now: FIXED_NOW,
    });

    assert.equal(
      resultBacktick.state,
      "MALFORMED_BLOCKED",
      "RED(백틱): 인용부호 제외 없이는 백틱 인용이 다시 근접-미스로 세져 유효+깨짐 혼재로 잘못 승격된다",
    );
    assert.equal(
      resultSingle.state,
      "MALFORMED_BLOCKED",
      "RED(홑따옴표): 인용부호 제외 없이는 홑따옴표 인용도 다시 근접-미스로 세져 유효+깨짐 혼재로 잘못 승격된다 -- 이 fix가 원인임을 증명",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(harnessDirBacktick, { recursive: true, force: true });
    rmSync(harnessDirSingle, { recursive: true, force: true });
    const after = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
    assert.equal(
      after,
      src,
      "원복 증명 실패: 실제 relay-handshake.mjs가 이 시험 도중 바뀌었다",
    );
  }
});
