import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolveHeaderTaskId } from "./header-task-id-shared.mjs";

const SCRIPT_PATH = new URL(
  "./header-task-id-shared.mjs",
  import.meta.url,
).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const HERE = new URL(".", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);

// HYK-468 2R -- 시험 4종:
// ⓐ 본문에 산문으로 소개된(코드펜스 없는) task_id: 인용 1 + 헤더 선언 1
//   -> 확정 (1R 반려 재현: reviewer's exact repro)
// ⓑ 같은 블록 안 헤더 선언 2 -> 거부
// ⓒ 선언 0 -> 거부
// ⓓ HYK-183 회귀: 빈 줄로 나뉜 «진짜» 선언 2개(옛 라운드 유지 + 새 라운드
//   추가, 산문 없음) -> 여전히 거부 (2R 1차 시도가 이 축을 실제로 깼다 --
//   전체 러너에서 nc-relay-handshake.test.mjs의 NC-2가 RED로 잡음)
const REVIEWER_REPRO_CONTENT =
  "task_id: HYK-465-467-channel-loss-1\n" +
  "for: HYK-465 + HYK-467\n" +
  "role: CODER\n" +
  "\n" +
  "예를 들어 다음과 같은 줄이 주입된다:\n" +
  "task_id: HYK-9201-inject-1\n" +
  "dropped_at: 2026-09-14 10:58 KST\n";

test("ⓐ HYK-468: header declaration + a later PROSE-introduced (unfenced) task_id: example -> resolved (reviewer's exact 1R-reject repro)", () => {
  const result = resolveHeaderTaskId(REVIEWER_REPRO_CONTENT);
  assert.deepEqual(result, { ok: true, id: "HYK-465-467-channel-loss-1" });
});

test("ⓑ HYK-468: two task_id: declarations back-to-back (no prose between) -> reject (genuine ambiguity still blocked)", () => {
  const content =
    "task_id: HYK-468-first\n" + "task_id: HYK-468-second\n" + "role: CODER\n";
  const result = resolveHeaderTaskId(content);
  assert.equal(result.ok, false);
  assert.equal(result.count, 2);
});

test("ⓒ HYK-468: zero task_id: declarations anywhere -> reject", () => {
  const content = "for: HYK-468\nrole: CODER\n\n# no declaration at all\n";
  const result = resolveHeaderTaskId(content);
  assert.equal(result.ok, false);
  assert.equal(result.count, 0);
});

test("ⓓ HYK-183 회귀(★1R draft가 실제로 깬 축): 빈 줄로 나뉜 두 개의 «진짜» 블록(옛 라운드 유지 + 새 라운드 추가, 산문 없음) -> 여전히 거부", () => {
  // nc-relay-handshake.test.mjs의 NC-2 fixture와 같은 모양 -- 두 번째
  // task_id: 는 빈 줄 바로 다음 줄이지만, 그 빈 줄 «앞»의 가장 가까운
  // 비어있지 않은 줄은 `>>> DONE: ...`(구조적 표지)이지 산문이 아니다.
  const content =
    "task_id: HYK-0000-stale-round\n" +
    ">>> DONE: old round @ 2026-07-30 09:00 KST\n" +
    "\n" +
    "task_id: HYK-9001-x\n" +
    ">>> DONE: new round @ 2026-07-31 10:05 KST\n";
  const result = resolveHeaderTaskId(content);
  assert.equal(result.ok, false);
  assert.equal(result.count, 2);
});

test("ⓔ 두 번째 실측 회귀(★2R draft가 실제로 깬 축): 정상 한 줄 envelope-archive HTML 주석 뒤의 선언 -> 확정(주석은 빈 줄과 동일하게 건너뛴다)", () => {
  // envelope-archive.mjs가 아카이브 사본에 실제로 붙이는 모양 --
  // 파일 맨 앞이 <!-- ... --> 한 줄 주석이고 빈 줄이 전혀 없다.
  const content =
    "<!-- envelope-archive: role=CODER kind=task dropped_at=2026-08-18 12:00:00 KST -->\n" +
    "task_id: HYK-298-abort-record-2\n" +
    "dropped_at: 2026-08-18 12:00:00 KST\n";
  const result = resolveHeaderTaskId(content);
  assert.deepEqual(result, { ok: true, id: "HYK-298-abort-record-2" });
});

test("ⓕ 세 번째 실측 회귀(★'모든 <!--는 구조적' 초안이 새로 깼던 축): 일부러 깨진(닫는 --> 가 다음 줄로 밀린) 다줄 주석 뒤에서도 여전히 확정된다 -- 그 손상 자체는 이 축의 관심사가 아니다", () => {
  const content =
    "<!-- envelope-archive: role=CODER kind=task dropped_at=X dispatch_id=ctx_1\n" +
    " -->\n" +
    "task_id: HYK-9613-newline-shape-1\n" +
    "dropped_at: 2026-08-26 12:00:00 KST\n";
  const result = resolveHeaderTaskId(content);
  assert.deepEqual(result, { ok: true, id: "HYK-9613-newline-shape-1" });
});

// RED 변이 (필수, coder-task.md §2-3): "구조적 선행 맥락" 검사를 제거하고
// (되돌려) 모든 열0 task_id: 줄을 무조건 세던 동작으로 되돌리면, ⓐ의
// 합성 입력이 다시 "2개" 로 세어 REJECT로 샌다 -- header-task-id-
// shared.mjs 자신은 조금도 건드리지 않는다(합성 mutant는 격리 tmpdir
// 사본에만 적용).
test("RED(변이, 필수): 구조적 선행 맥락 검사를 제거하면(모든 열0 task_id: 무조건 인정) ⓐ가 다시 REJECT로 샌다", async () => {
  const realSource = readFileSync(SCRIPT_PATH, "utf8");
  const target =
    "    if (!hasStructuralPredecessor(lines, i)) continue;\n    candidates.push(m[1]);";
  assert.equal(
    [...realSource.matchAll(new RegExp(escapeRegExp(target), "g"))].length,
    1,
    "mutation anchor must appear exactly once in the real source (test would be vacuous otherwise)",
  );
  const mutatedSource = realSource.replace(
    target,
    "    candidates.push(m[1]); // MUTATED: structural-predecessor check removed",
  );

  const dir = mkdtempSync(join(tmpdir(), "header-task-id-red-"));
  try {
    // header-task-id-shared.mjs imports maskQuotedMarkerRegions from
    // "./reject-streak.mjs" -- stage a real copy alongside the mutant so
    // that relative import resolves inside the tmp dir.
    writeFileSync(
      join(dir, "reject-streak.mjs"),
      readFileSync(join(HERE, "reject-streak.mjs"), "utf8"),
      "utf8",
    );
    const mutantPath = join(dir, "header-task-id-shared-mutant.mjs");
    writeFileSync(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);
    const mutatedResult = mutant.resolveHeaderTaskId(REVIEWER_REPRO_CONTENT);
    assert.equal(
      mutatedResult.ok,
      false,
      "RED: with the structural-predecessor check removed, the same ⓐ input must go back to REJECT (count 2)",
    );
    assert.equal(mutatedResult.count, 2);

    // Confirm the real source file was never touched.
    const afterSource = readFileSync(SCRIPT_PATH, "utf8");
    assert.equal(
      afterSource,
      realSource,
      "the real source file must be byte-identical after this mutation test",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
