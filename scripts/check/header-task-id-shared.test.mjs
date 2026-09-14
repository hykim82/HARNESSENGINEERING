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

// HYK-468 coder-task.md §1 commit ③, 시험 3종 (⛔전부 필수):
// ⓐ 본문 인용 1 + 헤더 선언 1 -> 확정
// ⓑ 헤더 선언 2 -> 거부
// ⓒ 선언 0 -> 거부
//
// This is the exact shape of the real incident
// (hyk442-blocked-door-1/.harness/coder.md): a header block with ONE real
// `task_id:` declaration, followed (after the blank line that ends the
// header) by a body that quotes a *different* `task_id:` line verbatim at
// column 0 inside a fenced code block -- documenting exactly what
// dispatch-gate-decision.mjs's bestEffortInjectResultPaths injected. The
// old whole-file scan counted both and rejected a fine round.

test("ⓐ HYK-468: header declaration + a later body-quoted task_id: example -> resolved (the real hyk442 incident shape)", () => {
  const content =
    "task_id: HYK-465-467-channel-loss-1\n" +
    "for: HYK-465 + HYK-467\n" +
    "role: CODER\n" +
    "\n" +
    "# 결과\n" +
    "\n" +
    "주입된 파일 내용(발췌, 실측):\n" +
    "```\n" +
    "task_id: HYK-9201-inject-1\n" +
    "dropped_at: 2026-09-14 10:58 KST\n" +
    "```\n";
  const result = resolveHeaderTaskId(content);
  assert.deepEqual(result, { ok: true, id: "HYK-465-467-channel-loss-1" });
});

test("ⓑ HYK-468: two task_id: declarations INSIDE the header block -> reject (genuine ambiguity still blocked)", () => {
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

// RED 변이 (필수, coder-task.md §2-3): header-block 한정을 제거하고
// (되돌려) 전체 파일을 훑던 옛 동작으로 되돌리면, ⓐ의 합성 입력이 다시
// "2개" 로 세어 REJECT로 샌다 -- header-task-id-shared.mjs 자신은 조금도
// 건드리지 않는다(합성 mutant는 격리 tmpdir 사본에만 적용).
test("RED(변이, 필수): header-block 한정을 되돌리면(전체 파일 스캔) ⓐ가 다시 REJECT로 샌다", async () => {
  const realSource = readFileSync(SCRIPT_PATH, "utf8");
  const mutatedSource = realSource.replace(
    "return blankLineIdx === -1 ? normalized : normalized.slice(0, blankLineIdx);",
    "return normalized; // MUTATED: header-block scoping removed",
  );
  assert.notEqual(
    mutatedSource,
    realSource,
    "mutation string replace must actually match the real source (test would be vacuous otherwise)",
  );

  const dir = mkdtempSync(join(tmpdir(), "header-task-id-red-"));
  try {
    const mutantPath = join(dir, "header-task-id-shared-mutant.mjs");
    writeFileSync(mutantPath, mutatedSource, "utf8");
    const mutant = await import(pathToFileURL(mutantPath).href);
    const content =
      "task_id: HYK-465-467-channel-loss-1\n" +
      "for: HYK-465 + HYK-467\n" +
      "role: CODER\n" +
      "\n" +
      "# 결과\n" +
      "\n" +
      "주입된 파일 내용(발췌, 실측):\n" +
      "```\n" +
      "task_id: HYK-9201-inject-1\n" +
      "dropped_at: 2026-09-14 10:58 KST\n" +
      "```\n";
    const mutatedResult = mutant.resolveHeaderTaskId(content);
    assert.equal(
      mutatedResult.ok,
      false,
      "RED: with header-block scoping removed, the same ⓐ input must go back to REJECT (count 2)",
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
