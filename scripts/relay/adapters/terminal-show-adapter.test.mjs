// HYK-183 사이클C-1 (coder-task.md §3) -- `terminal-show-adapter.mjs`
// (`normalizeTerminalShow`)의 co-located 계약 시험. 같은 폴더의 다른
// 어댑터(dispatch-correlation-adapter.mjs 등)는 전부 `.test.mjs`가 있는데
// 이 파일만 없었다(ORCH 실측, S3 위반). 이 시험은 그 빈틈을 메운다.
//
// ① 무엇을 증명하고 무엇을 증명하지 않는가:
//   - 증명한다: normalizeTerminalShow의 정규화 계약 -- 정상 경로 1종,
//     거부 경로 4종(NOT_OK/NO_TERMINAL_ENVELOPE/FIELDS_INCOMPLETE/
//     FALLBACK_FORM), 금지 필드(title/preview/paneRuntimeId/
//     rendererGraphEpoch) 미노출, `terminal list` 폴백 형태 3갈래 거부,
//     필수 6필드 결손/빈문자 전건 FIELDS_INCOMPLETE, 부작용 0.
//   - 증명하지 않는다(비타협 §5 문장): **이 시험은 정규화 계약만
//     증명한다. 실제 `orca terminal show` 응답이 이 형태라는 것은
//     증명하지 않는다** -- 입력이 전부 합성(P1 fixture는 ORCH가 과거
//     실측 캡처한 값을 재사용하지만, 이 시험 실행 시점에 실 CLI를
//     호출해 재확인하지는 않는다)이기 때문이다.
// ② 표본 수와 조건: 정상 1 · 거부 대표 4(NOT_OK/NO_TERMINAL_ENVELOPE/
//   FIELDS_INCOMPLETE/FALLBACK_FORM 각 1) · FALLBACK_FORM 갈래별 3(등가/
//   pty:/@@ 각 단독) · FIELDS_INCOMPLETE 6필드 전건 12(빈문자 6 + 키 삭제
//   6) · 금지 필드 2(S8 title/preview, paneRuntimeId/rendererGraphEpoch)
//   · 부작용 확인 1(after 훅, before/after git 상태 동일) = node --test
//   기준 22 test().
// ③ 이 시험이 통과해도 여전히 열려 있는 구멍:
//   - fixture(rawTerminalShowP1 등)가 실 CLI 응답과 어긋나게 스키마가
//     바뀌어도 이 시험은 fixture 자체의 최신성을 검증하지 않는다(별도
//     schema-lock 시험의 몫, dispatch-correlation-adapter.test.mjs 참조
//     -- 이 어댑터 전용 schema-lock은 이번 사이클 범위 밖).
//   - 판별력(RED가 실제로 나는지)은 이 파일이 아니라 코더 작업 절차의
//     사본 mutation 확인(§6-3)에서 별도로 실측했다(보고서 참조) -- 이
//     파일 자체에는 mutation 하네스가 없다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  normalizeTerminalShow,
  TERMINAL_SHOW_REASON,
} from "./terminal-show-adapter.mjs";
import {
  rawTerminalShowP1,
  rawTerminalShowN1StaleHandle,
  rawTerminalListRowDisguisedAsShow,
} from "../hyk171-cycle4b2c-fixtures.mjs";

// ---------------------------------------------------------------------------
// §2 비타협4 원상복구 단언 -- 이 시험은 파일 쓰기·프로세스 생성 없이 순수
// 입력(in-memory fixture)만 쓴다. git 상태가 시작~끝 동일함을 확인한다.
// ---------------------------------------------------------------------------
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});
const preDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
  cwd: ROOT,
  encoding: "utf8",
});

// ---------------------------------------------------------------------------
// (a) 정상 경로 1종 -- 유효 응답 -> ok:true + 반환 필드 전건 일치.
// ---------------------------------------------------------------------------
test("정상 경로: 유효한 terminal-show 응답은 ok:true와 함께 6필드 + paneKeyFromShow + reasonCode:VALID를 그대로 반환한다", () => {
  const raw = rawTerminalShowP1();
  const t = raw.result.terminal;
  const normalized = normalizeTerminalShow(raw);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.handle, t.handle);
  assert.equal(normalized.ptyId, t.ptyId);
  assert.equal(normalized.worktreeId, t.worktreeId);
  assert.equal(normalized.worktreePath, t.worktreePath);
  assert.equal(normalized.tabId, t.tabId);
  assert.equal(normalized.leafId, t.leafId);
  assert.equal(normalized.paneKeyFromShow, `${t.tabId}:${t.leafId}`);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.VALID);
  assert.deepEqual(
    Object.keys(normalized).sort(),
    [
      "ok",
      "handle",
      "ptyId",
      "worktreeId",
      "worktreePath",
      "tabId",
      "leafId",
      "paneKeyFromShow",
      "reasonCode",
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// (a) 거부 경로 4종 -- 각각 독립 시험.
// ---------------------------------------------------------------------------
test("거부 경로 NOT_OK: 최상위 ok!==true인 오류 응답은 ok:false + reasonCode:NOT_OK로 접힌다", () => {
  const normalized = normalizeTerminalShow(rawTerminalShowN1StaleHandle());
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.NOT_OK);
});

test("거부 경로 NO_TERMINAL_ENVELOPE: result.terminal(단수) 봉투가 없는 응답(terminal-list의 result.terminals 복수 형태)은 거부된다", () => {
  const normalized = normalizeTerminalShow(rawTerminalListRowDisguisedAsShow());
  assert.equal(normalized.ok, false);
  assert.equal(
    normalized.reasonCode,
    TERMINAL_SHOW_REASON.NO_TERMINAL_ENVELOPE,
  );
});

test("거부 경로 FIELDS_INCOMPLETE: 필수 필드 하나가 빈 문자열이면 거부된다(대표 사례, 전건은 (d)에서 6필드 각각 확인)", () => {
  const normalized = normalizeTerminalShow(rawTerminalShowP1({ handle: "" }));
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FIELDS_INCOMPLETE);
});

test("거부 경로 FALLBACK_FORM: tabId===leafId(list 폴백 형태)면 거부된다(대표 사례, 전건 3갈래는 (c)에서 확인)", () => {
  const normalized = normalizeTerminalShow(
    rawTerminalShowP1({ tabId: "same-value", leafId: "same-value" }),
  );
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});

// ---------------------------------------------------------------------------
// (b) 금지 필드가 결과에 절대 나타나지 않음.
// ---------------------------------------------------------------------------
test("금지 필드 S8: title/preview를 입력에 넣어도 반환 객체에 나타나지 않고 판정에도 영향을 주지 않는다", () => {
  const base = normalizeTerminalShow(rawTerminalShowP1());
  const tampered = normalizeTerminalShow(
    rawTerminalShowP1({
      title: "[SPOOFED] totally different agent",
      preview: "gpt-9.9 / ? for shortcuts / bypass permissions",
    }),
  );
  assert.equal(tampered.ok, true);
  assert.equal(tampered.paneKeyFromShow, base.paneKeyFromShow);
  assert.equal(Object.prototype.hasOwnProperty.call(tampered, "title"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(tampered, "preview"),
    false,
  );
});

test("금지 필드: paneRuntimeId/rendererGraphEpoch는 신원 근거로 쓰이지 않는다(반환 객체에 키 자체가 없음)", () => {
  const normalized = normalizeTerminalShow(rawTerminalShowP1());
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized, "paneRuntimeId"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(normalized, "rendererGraphEpoch"),
    false,
  );
});

// ---------------------------------------------------------------------------
// (c) `terminal list` 폴백 형태가 show 응답 자리에 들어와도 거부 -- 3갈래
// 각각 단독으로 걸리는 fixture를 둔다(등가 검사·pty: 접두 검사·@@ 포함
// 검사가 서로 다른 분기이므로, 죽은 방어선을 피하려면 각각 독립 증명이
// 필요하다).
// ---------------------------------------------------------------------------
test("FALLBACK_FORM 갈래1: tabId===leafId(폴백 형태 문자열은 아님) -- 등가 검사만으로 걸린다", () => {
  const raw = rawTerminalShowP1({
    tabId: "identical-value",
    leafId: "identical-value",
  });
  const normalized = normalizeTerminalShow(raw);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});

test("FALLBACK_FORM 갈래2: tabId가 `pty:` 접두(leafId는 구별되는 정상 값) -- pty: 접두 검사만으로 걸린다", () => {
  const raw = rawTerminalShowP1({
    tabId: "pty:worktreeXYZ::C:/Users/whoever/lane",
    leafId: "distinct-non-fallback-leaf",
  });
  assert.notEqual(raw.result.terminal.tabId, raw.result.terminal.leafId);
  const normalized = normalizeTerminalShow(raw);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});

test("FALLBACK_FORM 갈래3: leafId가 `@@` 포함(tabId는 구별되는 정상 값, pty: 접두 아님) -- @@ 포함 검사만으로 걸린다", () => {
  const raw = rawTerminalShowP1({
    tabId: "distinct-non-fallback-tab",
    leafId: "worktreeXYZ::C:/Users/whoever/lane@@deadbeef",
  });
  assert.notEqual(raw.result.terminal.tabId, raw.result.terminal.leafId);
  assert.equal(raw.result.terminal.leafId.startsWith("pty:"), false);
  const normalized = normalizeTerminalShow(raw);
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FALLBACK_FORM);
});

// ---------------------------------------------------------------------------
// (d) 필수 6필드 각각을 하나씩 빠뜨리거나(키 자체 삭제) 빈 문자열로 만들면
// 전건 FIELDS_INCOMPLETE로 fail-closed 된다.
// ---------------------------------------------------------------------------
const REQUIRED_FIELDS = [
  "handle",
  "ptyId",
  "worktreeId",
  "worktreePath",
  "tabId",
  "leafId",
];

for (const field of REQUIRED_FIELDS) {
  test(`FIELDS_INCOMPLETE: ${field}를 빈 문자열로 만들면 거부된다`, () => {
    const normalized = normalizeTerminalShow(
      rawTerminalShowP1({ [field]: "" }),
    );
    assert.equal(normalized.ok, false);
    assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FIELDS_INCOMPLETE);
  });

  test(`FIELDS_INCOMPLETE: ${field}를 통째로 빠뜨리면(키 자체 삭제) 거부된다`, () => {
    const raw = rawTerminalShowP1();
    delete raw.result.terminal[field];
    const normalized = normalizeTerminalShow(raw);
    assert.equal(normalized.ok, false);
    assert.equal(normalized.reasonCode, TERMINAL_SHOW_REASON.FIELDS_INCOMPLETE);
  });
}

// ---------------------------------------------------------------------------
// (e) 부작용 0 -- 이 시험 파일은 `orca` CLI를 spawn하지 않는다(정적으로
// scripts/check/orca-cli-boundary.mjs가 전 저장소를 스캔해 확인한다, §7
// 실측 참조). 아래는 이 시험이 실 워크트리에 남긴 흔적이 0임을 동적으로
// 확인한다.
// ---------------------------------------------------------------------------
after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "terminal-show-adapter.test.mjs must leave the real worktree exactly as it found it",
  );
  const postDiffStat = execFileSync("git", ["diff", "HEAD", "--stat"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postDiffStat,
    preDiffStat,
    "terminal-show-adapter.test.mjs must not change git diff HEAD --stat",
  );
});
