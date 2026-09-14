// HYK-468 2R -- P1 반려 재현/수리 증명. 1R은 header-task-id-shared.mjs
// (공유 모듈 단독)만 시험했다 -- 검토자가 정확히 지적한 대로, 실제
// 소비/배달 경로(relay-handshake.mjs의 exported resolveResultTaskId,
// dispatch-gate-decision.mjs의 classifyTaskIdLabel)는 여전히 전체 파일을
// 스캔해 코드펜스 «없이» 본문에 그대로 인용한 예시가 진짜 선언과 충돌해
// AMBIGUOUS/BROKEN으로 거부됐다. 이 파일은 검토자가 쓴 «그 호출»
// (실제 exported 함수)에 «그 입력»(본문 인용 1 + 헤더 선언 1)을 그대로
// 주입해 ok:false -> ok:true로 뒤집히는 것을 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveResultTaskId } from "./relay-handshake.mjs";

const RELAY_HANDSHAKE_PATH = fileURLToPath(
  new URL("./relay-handshake.mjs", import.meta.url),
);
const HERE = fileURLToPath(new URL(".", import.meta.url));
// relay-handshake.mjs's own static import graph (no transitive siblings --
// each of these four only imports node: builtins). The mutant needs these
// alongside it so its relative imports resolve inside the tmp dir.
const RELAY_HANDSHAKE_SIBLINGS = [
  "reject-streak.mjs",
  "envelope-archive.mjs",
  "time-authority.mjs",
  "child-probe-timeout-policy.mjs",
];
const STUCK_FILE_PATH =
  "C:\\Users\\Administrator\\orca\\workspaces\\HARNESSENGINEERING\\hyk442-blocked-door-1\\.harness\\coder.md";

// 검토자가 반려문에서 직접 쓴 그 합성 입력 형태: 코드펜스로 감싸지 «않은»
// 채(마스킹 대상이 아님) 본문에 그대로 인용한 task_id: 예시.
const REVIEWER_REPRO_CONTENT =
  "task_id: HYK-465-467-channel-loss-1\n" +
  "for: HYK-465 + HYK-467\n" +
  "role: CODER\n" +
  "\n" +
  "예를 들어 다음과 같은 줄이 주입된다:\n" +
  "task_id: HYK-9201-inject-1\n" +
  "dropped_at: 2026-09-14 10:58 KST\n";

test("ⓐ 실제 소비 경로 회귀: relay-handshake.mjs의 exported resolveResultTaskId에 검토자의 그 입력(코드펜스 없는 본문 인용 1 + 헤더 선언 1)을 넣으면 AMBIGUOUS가 아니라 확정된다", () => {
  const result = resolveResultTaskId(REVIEWER_REPRO_CONTENT);
  assert.deepEqual(result, {
    ok: true,
    id: "HYK-465-467-channel-loss-1",
  });
});

test("ⓑ 반대 방향 유지 (실제 exported 함수): 헤더 선언 2개 -> 여전히 AMBIGUOUS로 거부", () => {
  const result = resolveResultTaskId("task_id: A-1\ntask_id: A-2\n");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "AMBIGUOUS");
});

test("ⓑ 반대 방향 유지 (실제 exported 함수): 선언 0개 -> 여전히 MISSING으로 거부", () => {
  const result = resolveResultTaskId("for: HYK-468\nrole: CODER\n");
  assert.equal(result.ok, false);
  assert.equal(result.kind, "MISSING");
});

test("ⓑ HYK-183 회귀 방지(실제 exported 함수, ★2R 초안이 실제로 깬 축): 빈 줄로 나뉜 두 개의 «진짜» 블록(옛 라운드 유지 + 새 라운드 추가, 산문 없음) -> 여전히 AMBIGUOUS로 거부, 스테일 값으로 조용히 확정되지 않는다", () => {
  const content =
    "task_id: HYK-0000-stale-round\n" +
    ">>> DONE: old round @ 2026-07-30 09:00 KST\n" +
    "\n" +
    "task_id: HYK-9001-x\n" +
    ">>> DONE: new round @ 2026-07-31 10:05 KST\n";
  const result = resolveResultTaskId(content);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "AMBIGUOUS");
});

test("ⓒ 갇힌 실물: hyk442-blocked-door-1/.harness/coder.md(열0 task_id 2개, 읽기 전용)를 실제 exported 함수가 HYK-465-467-channel-loss-1로 확정한다", () => {
  const stuckContent = readFileSync(STUCK_FILE_PATH, "utf8");
  // 실물 확인: 이 파일이 정말로 그 실사고 모양(열 0 task_id: 2개)인지
  // 먼저 확인한다 -- 그렇지 않으면 아래 확정 단언이 무엇을 증명하는지
  // 불분명해진다(헛통과 방지).
  const columnZeroCount = [...stuckContent.matchAll(/^task_id:/gim)].length;
  assert.equal(
    columnZeroCount,
    2,
    "이 시험은 갇힌 파일이 실제로 열0 task_id: 2개인 그 모양일 때만 의미가 있다",
  );

  const result = resolveResultTaskId(stuckContent);
  assert.deepEqual(result, {
    ok: true,
    id: "HYK-465-467-channel-loss-1",
  });
});

// 되돌림 변이(필수, 완료조건 §4-2): relay-handshake.mjs의 구조적 선행
// 맥락 검사(hasStructuralPredecessor 적용)를 제거하고 옛 전체-스캔
// 동작으로 되돌린 «격리 tmp 사본»을 동적 import해, ⓐ의 같은 입력이
// 다시 AMBIGUOUS로 새는지 확인한다. 실 소스 파일은 이 시험 과정에서
// 단 한 번도 변이되지 않는다(mutant는 tmp 사본에만 씀) -- 시험 끝에
// 바이트 동일까지 재확인.
test("RED(변이, 필수): relay-handshake.mjs의 구조적 선행 맥락 검사를 제거하면 ⓐ가 다시 AMBIGUOUS로 샌다", async () => {
  const realSource = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    '  const lines = scan.replace(/\\r\\n/g, "\\n").split("\\n");\n  const resultIdMatches = [];\n  for (let i = 0; i < lines.length; i++) {\n    const m = lines[i].match(/^task_id:\\s*(\\S+)/i);\n    if (!m) continue;\n    if (!hasStructuralPredecessor(lines, i)) continue;\n    resultIdMatches.push(m);\n  }';
  assert.equal(
    [...realSource.matchAll(new RegExp(escapeRegExp(target), "g"))].length,
    1,
    "mutation anchor must appear exactly once in the real source (test would be vacuous or ambiguous otherwise)",
  );
  const mutatedSource = realSource.replace(
    target,
    "  // MUTATED: structural-predecessor check removed, reverted to whole-file scan.\n  const resultIdMatches = [...scan.matchAll(/^task_id:\\s*(\\S+)/gim)];",
  );

  const dir = mkdtempSync(join(tmpdir(), "hyk468-2r-relay-handshake-red-"));
  try {
    // relay-handshake.mjs imports these siblings by relative path
    // ("./reject-streak.mjs" etc.) -- staging the mutant under the SAME
    // filename in the tmp dir, alongside real copies of its siblings, lets
    // those relative imports resolve without dragging in the rest of
    // scripts/check.
    for (const name of RELAY_HANDSHAKE_SIBLINGS) {
      writeFileSync(
        join(dir, name),
        readFileSync(join(HERE, name), "utf8"),
        "utf8",
      );
    }
    const mutantPath = join(dir, "relay-handshake.mjs");
    writeFileSync(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);
    const mutatedResult = mutant.resolveResultTaskId(REVIEWER_REPRO_CONTENT);
    assert.equal(
      mutatedResult.ok,
      false,
      "RED: with header-block scoping removed, the reviewer's exact input must go back to AMBIGUOUS",
    );
    assert.equal(mutatedResult.kind, "AMBIGUOUS");

    const afterSource = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
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
