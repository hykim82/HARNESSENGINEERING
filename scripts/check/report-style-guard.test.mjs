import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  checkReportStyle,
  classifyWatchedPath,
  matchSignatureA,
  matchSignatureB,
} from "./report-style-guard.mjs";

// HYK-143: report-style-guard. known-bad(5단 골격 세트·지침 복사) / known-good(정상 태스크의
// "한계" 단어·게이트 카드 인용·이 태스크 파일 자체) / UNJUDGABLE / 비대상 경로 / 매니페스트 자기 등재.

function repoRoot() {
  return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
}
const ROOT = repoRoot();
const TASK_PATH = `${ROOT}/.harness/coder-task.md`;

function status(
  content,
  { filePath = TASK_PATH, toolName = "Write", toolInput } = {},
) {
  return checkReportStyle({
    toolName,
    filePath,
    toolInput: toolInput ?? { content },
    repoRoot: ROOT,
  });
}

// ---------------------------------------------------------------------------
// 감시 대상 경로 분류
// ---------------------------------------------------------------------------
test("classifyWatchedPath: watched vs non-watched", () => {
  assert.equal(
    classifyWatchedPath(`${ROOT}/.harness/coder-task.md`, ROOT),
    "harness-task",
  );
  assert.equal(
    classifyWatchedPath(`${ROOT}/.harness/review-task.md`, ROOT),
    "harness-task",
  );
  assert.equal(
    classifyWatchedPath(`${ROOT}/templates/harness-init/x.md`, ROOT),
    "templates",
  );
  assert.equal(
    classifyWatchedPath(
      "D:/문서관리/하네스-관제실/PM/relay/coder-task.md",
      ROOT,
    ),
    "pm-relay-task",
  );
  assert.equal(
    classifyWatchedPath(
      "C:/Users/x/.claude-team/projects/p/memory/note.md",
      ROOT,
    ),
    "memory",
  );
  // non-watched
  assert.equal(
    classifyWatchedPath(`${ROOT}/scripts/check/foo.mjs`, ROOT),
    null,
  );
  assert.equal(classifyWatchedPath(`${ROOT}/.harness/review.md`, ROOT), null); // not a *-task.md
  assert.equal(
    classifyWatchedPath(`${ROOT}/docs/enforcement-v1.md`, ROOT),
    null,
  );
  assert.equal(classifyWatchedPath(undefined, ROOT), null);
});

// ---------------------------------------------------------------------------
// HYK-164: repo-relative(insideRepo) 판정이 절대경로(/pm/relay/, /memory/) 폴백보다
// 먼저 발동해야 한다 -- repo/worktree가 우연히 `.../PM/relay/...` 아래에 체크아웃되어도
// repo 내부 파일은 항상 repo 라벨(harness-task/templates)로 분류되어야 함.
// ---------------------------------------------------------------------------
test("HYK-164 core regression: repo checked out under a .../PM/relay/... path still classifies its own .harness/*-task.md as harness-task, not pm-relay-task", () => {
  const fakeRoot = "D:/문서관리/하네스-관제실/PM/relay/review-wt-hyk164";
  const filePath = `${fakeRoot}/.harness/coder-task.md`;
  assert.equal(classifyWatchedPath(filePath, fakeRoot), "harness-task");
});
test("HYK-164 core regression: repo checked out under .../PM/relay/... still classifies templates/** as templates", () => {
  const fakeRoot = "D:/문서관리/하네스-관제실/PM/relay/review-wt-hyk164";
  const filePath = `${fakeRoot}/templates/harness-init/x.md`;
  assert.equal(classifyWatchedPath(filePath, fakeRoot), "templates");
});
test("HYK-164 fallback preserved: outside-repo absolute PM/relay/*-task.md is still pm-relay-task", () => {
  const fakeRoot = "D:/문서관리/하네스-관제실/CTRL/some-other-repo";
  assert.equal(
    classifyWatchedPath(
      "D:/문서관리/하네스-관제실/PM/relay/pm-task.md",
      fakeRoot,
    ),
    "pm-relay-task",
  );
});
test("HYK-164 fallback preserved: outside-repo absolute /memory/ path is still memory", () => {
  const fakeRoot = "D:/문서관리/하네스-관제실/CTRL/some-other-repo";
  assert.equal(
    classifyWatchedPath(
      "C:/Users/x/.claude-team/projects/p/memory/note.md",
      fakeRoot,
    ),
    "memory",
  );
});
test("HYK-164 Windows path variants: backslashes and mixed case (PM/Relay) still classify correctly", () => {
  const fakeRoot = "D:\\문서관리\\하네스-관제실\\PM\\Relay\\review-wt-hyk164";
  const insidePath = `${fakeRoot}\\.harness\\coder-task.md`;
  assert.equal(classifyWatchedPath(insidePath, fakeRoot), "harness-task");

  const outsideRoot = "D:\\문서관리\\하네스-관제실\\CTRL\\some-other-repo";
  const outsidePath = "D:\\문서관리\\하네스-관제실\\PM\\Relay\\pm-task.md";
  assert.equal(classifyWatchedPath(outsidePath, outsideRoot), "pm-relay-task");
});

// ---------------------------------------------------------------------------
// HYK-164-coder-2 (review-1 반려 수리): root(두 번째 인자) 미지정/이상값 호출에서도
// repo-relative 판정을 시도하지 않고 절대경로 폴백으로 안전하게 내려가야 한다 -- 예외 0.
// ---------------------------------------------------------------------------
test("HYK-164-coder-2 regression: root omitted -- external pm/relay task path still classifies as pm-relay-task, no throw", () => {
  assert.doesNotThrow(() => {
    const r = classifyWatchedPath(
      "D:/문서관리/하네스-관제실/PM/relay/coder-task.md",
      undefined,
    );
    assert.equal(r, "pm-relay-task");
  });
});
test("HYK-164-coder-2 regression: root omitted -- external memory path still classifies as memory, no throw", () => {
  assert.doesNotThrow(() => {
    const r = classifyWatchedPath(
      "C:/Users/x/.claude-team/projects/p/memory/note.md",
      undefined,
    );
    assert.equal(r, "memory");
  });
});
test("HYK-164-coder-2 regression: root omitted -- non-watched path is still null, no throw", () => {
  assert.doesNotThrow(() => {
    const r = classifyWatchedPath(`${ROOT}/scripts/check/foo.mjs`, undefined);
    assert.equal(r, null);
  });
});
test("HYK-164-coder-2 regression: checkReportStyle with root omitted does not throw and returns a normal status", () => {
  const r = checkReportStyle({
    toolName: "Write",
    filePath: "D:/문서관리/하네스-관제실/PM/relay/coder-task.md",
    toolInput: { content: "ordinary task content" },
  });
  assert.equal(r.status, "PASS");
  assert.equal(r.ok, true);
});
test("HYK-164-coder-2 regression: root as empty string / null / number is handled without throw (defined fallback, not fail-open)", () => {
  for (const badRoot of ["", null, 0, 42]) {
    assert.doesNotThrow(
      () => {
        const r = classifyWatchedPath(
          "D:/문서관리/하네스-관제실/PM/relay/coder-task.md",
          badRoot,
        );
        assert.equal(r, "pm-relay-task");
      },
      `root=${JSON.stringify(badRoot)} must not throw`,
    );
  }
});

// ---------------------------------------------------------------------------
// known-bad: 5단 보고 골격 세트 (signature B)
// ---------------------------------------------------------------------------
test("BLOCK: 5-part report skeleton set as headings", () => {
  const r = status(
    "task_id: x\n\n## 결론\n좋음\n\n## 진단\n원인 A\n\n## 정직 한계\n없음\n",
  );
  assert.equal(r.status, "BLOCK");
  assert.equal(r.signature, "B");
});
test("BLOCK: skeleton as bold-numbered items (**1. 결론**)", () => {
  assert.equal(
    status("**1. 결론**\na\n**2. 진단**\nb\n**5. 정직 한계**\nc\n").status,
    "BLOCK",
  );
});
test("BLOCK: skeleton as plain numbered items (1. 결론)", () => {
  assert.equal(status("1. 결론\n2. 진단\n3. 정직 한계\n").status, "BLOCK");
});

// ---------------------------------------------------------------------------
// known-bad: 지침 자체 복사 (signature A)
// ---------------------------------------------------------------------------
test("BLOCK: report-style guide title heading copied", () => {
  const r = status("# 기술 답변 톤\n항상 결론부터 쓴다.\n");
  assert.equal(r.status, "BLOCK");
  assert.equal(r.signature, "A");
});
test("BLOCK: guide slug as a heading", () => {
  assert.equal(status("## orchestrator-report-style\n...\n").status, "BLOCK");
});

// ---------------------------------------------------------------------------
// known-good (계약 §5): "한계" 단어 산문 · 게이트 카드 인용 · 이 태스크 파일 자체
// ---------------------------------------------------------------------------
test("PASS: prose use of 한계/결론/진단 words is not a skeleton", () => {
  assert.equal(
    status("## 계약\n이번 한계는 A다. 결론적으로 진행한다. 진단 결과 양호.\n")
      .status,
    "PASS",
  );
});
test("PASS: only 2 of the 3 skeleton tokens present", () => {
  assert.equal(status("## 결론\nx\n## 진단\ny\n").status, "PASS");
});
test("PASS: a gate-card citation", () => {
  assert.equal(
    status("게이트: RG1·RG2·RG8 준수. 한계: Tier2.\n").status,
    "PASS",
  );
});
test("PASS: a HYK-143-style task file (cites the guide slug/filename + prose skeleton words) is known-good", () => {
  // known-good §5: an HYK-143-family task file references the style guide's *filename* in
  // prose/backticks and even quotes the bare slug in its §2A spec text, AND uses the words
  // 결론/진단/한계 in prose -- none of that is a leak, so it must pass.
  //
  // HYK-143-coder-3 (CI fix): this used to `readFileSync` the live `.harness/coder-task.md`,
  // but `.harness/` is gitignored, so a clean CI checkout hit ENOENT (run 29305800475).
  // The fixture below inlines the exact adversarial known-good properties of that task file
  // (bare-slug backtick, `.md` filename citation, prose skeleton tokens, and a non-guide
  // heading) so the test is environment-independent -- no real file read.
  const taskFileFixture = [
    "task_id: HYK-143-coder-1",
    "게이트: 상시 S1·S3·S4(honesty note)",
    "",
    "# HYK-143 coder-1 — report-style-guard: 보고 형식의 작업 문서 유입 기계 차단",
    "",
    "## 배경",
    "사람 대상 보고 톤 지침(관제실 `orchestrator-report-style.md`)이 도입됨. 이 보고 형식이",
    "워커 태스크 파일로 새어 들어가는 것을 기계로 차단하라는 지시.",
    "",
    "## 계약",
    "2. 차단 시그니처: A. 지침 자체 복사(`기술 답변 톤` 헤딩 또는 `orchestrator-report-style` 문자열),",
    "   B. 5단 보고 골격 세트(`결론`·`진단`·`정직 한계`가 모두 구조 항목일 때만).",
    "   ('한계'·'결론' 단어의 일반 산문 사용은 통과 — known-good로 증명.) 결론적으로 진단 결과 양호.",
    "",
    "## 상시",
    "이번 한계는 Tier2. push·PR·커밋 금지.",
    "",
  ].join("\n");
  const r = status(taskFileFixture);
  assert.equal(
    r.status,
    "PASS",
    `an HYK-143-style task file must be known-good, got: ${r.reason}`,
  );
});
test("PASS: a task merely naming orchestrator-report-style.md (filename citation) is not a copy", () => {
  assert.equal(
    status(
      "배경: 관제실 `orchestrator-report-style.md` 지침 도입됨. 결론 단어는 여기 산문.\n",
    ).status,
    "PASS",
  );
});

// ---------------------------------------------------------------------------
// UNJUDGABLE / SKIP
// ---------------------------------------------------------------------------
test("UNJUDGABLE: watched path but no string content (fail-open)", () => {
  const r = checkReportStyle({
    toolName: "Write",
    filePath: TASK_PATH,
    toolInput: {},
    repoRoot: ROOT,
  });
  assert.equal(r.status, "UNJUDGABLE");
  assert.equal(r.ok, true);
});
test("UNJUDGABLE: no file path (fail-open)", () => {
  const r = checkReportStyle({
    toolName: "Write",
    filePath: undefined,
    toolInput: { content: "# 기술 답변 톤" },
    repoRoot: ROOT,
  });
  assert.equal(r.status, "UNJUDGABLE");
  assert.equal(r.ok, true);
});
test("SKIP: non-watched path is never inspected (even with a skeleton)", () => {
  const r = status("## 결론\n## 진단\n## 정직 한계\n", {
    filePath: `${ROOT}/scripts/check/x.mjs`,
  });
  assert.equal(r.status, "SKIP");
});
test("SKIP: non-write tool", () => {
  assert.equal(
    checkReportStyle({
      toolName: "Read",
      filePath: TASK_PATH,
      toolInput: {},
      repoRoot: ROOT,
    }).status,
    "SKIP",
  );
});
test("Edit tool uses new_string, not content", () => {
  const r = checkReportStyle({
    toolName: "Edit",
    filePath: TASK_PATH,
    toolInput: { new_string: "## 결론\n## 진단\n## 정직 한계\n" },
    repoRoot: ROOT,
  });
  assert.equal(r.status, "BLOCK");
});

// ---------------------------------------------------------------------------
// signature helpers directly
// ---------------------------------------------------------------------------
test("matchSignatureA/B helpers", () => {
  assert.equal(matchSignatureA("# 기술 답변 톤\n").matched, true);
  assert.equal(
    matchSignatureA("`orchestrator-report-style` 를 언급만 함").matched,
    false,
  ); // prose/backtick citation, not a heading
  assert.equal(
    matchSignatureB("## 결론\n## 진단\n## 정직 한계\n").matched,
    true,
  );
  assert.equal(matchSignatureB("## 결론\n## 진단\n").matched, false);
});

// ---------------------------------------------------------------------------
// selfcheck manifest 자기 등재 (HYK-133 R5 전례): 이 체커가 자신의 매니페스트 등재를
// 자기 테스트로 검증한다.
// ---------------------------------------------------------------------------
test("self-registration: report-style-guard is listed in enforcement-inventory.json with matching script+test", () => {
  const manifest = JSON.parse(
    readFileSync(
      join(ROOT, "scripts", "check", "enforcement-inventory.json"),
      "utf8",
    ),
  );
  const entry = manifest.checks.find((c) => c.id === "report-style-guard");
  assert.ok(
    entry,
    "report-style-guard must be registered in enforcement-inventory.json",
  );
  assert.equal(entry.script, "scripts/check/report-style-guard.mjs");
  assert.equal(entry.test, "scripts/check/report-style-guard.test.mjs");
});
