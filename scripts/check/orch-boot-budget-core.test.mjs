import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkOrchBootBudget,
  deriveOrchBootManifest,
  findOrchBootSetMarkers,
  parseOrchBootSetList,
} from "./orch-boot-budget-core.mjs";

// 실물 relay-terminal-setup.md §1.5 부팅줄 바로 아래에 ORCH가 추가한
// 기계 판독 표식의 형태를 그대로 옮긴 픽스처(4R -- coder-task.md §1-1).
const CHARTER_FIXTURE = `# 릴레이 터미널 설정

## 1.5 ORCH 부팅줄

① 부팅 시 아래 순서로 PHASE-HANDOFF.md 와 STATUS.md만 읽고 이어가라.
불확실하면 docs/claude-orchestrator-handoff.md 도 확인하라.

<!-- orch-boot-set: PHASE-HANDOFF.md, STATUS.md -->
<!-- 기계 판독용(HYK-292 I2). 위 부팅줄의 "만 읽고" 목록과 일치 유지. 목록 변경 시 두 곳을 함께 고칠 것 -->

## 2. 다음
`;

test("findOrchBootSetMarkers: extracts the raw comma list inside the orch-boot-set comment", () => {
  const markers = findOrchBootSetMarkers(CHARTER_FIXTURE);
  assert.deepEqual(markers, ["PHASE-HANDOFF.md, STATUS.md"]);
});

test("findOrchBootSetMarkers: no marker present -> empty array", () => {
  assert.deepEqual(findOrchBootSetMarkers("# 아무 문서\n그냥 산문."), []);
});

test("findOrchBootSetMarkers: multiple markers in one doc -> both returned (caller decides ambiguity)", () => {
  const text = `<!-- orch-boot-set: A.md, B.md -->\n\n<!-- orch-boot-set: C.md -->`;
  assert.deepEqual(findOrchBootSetMarkers(text), ["A.md, B.md", "C.md"]);
});

test("parseOrchBootSetList: splits comma list, trims, drops empty items", () => {
  assert.deepEqual(parseOrchBootSetList(" PHASE-HANDOFF.md ,STATUS.md ,, "), [
    "PHASE-HANDOFF.md",
    "STATUS.md",
  ]);
});

test("parseOrchBootSetList: empty/undefined -> empty array", () => {
  assert.deepEqual(parseOrchBootSetList(""), []);
  assert.deepEqual(parseOrchBootSetList(undefined), []);
});

// ---------------------------------------------------------------------------
// deriveOrchBootManifest -- 4R: 유도 원천이 번호 목록에서 orch-boot-set
// 표식 블록으로 바뀌었다(coder-task.md §2).
// ---------------------------------------------------------------------------
test("deriveOrchBootManifest: single marker -> ok:true with basenames + source", () => {
  const manifest = deriveOrchBootManifest([
    { path: "/fake/charter.md", text: CHARTER_FIXTURE },
  ]);
  assert.equal(manifest.ok, true);
  assert.deepEqual(
    manifest.files.map((f) => f.basename),
    ["PHASE-HANDOFF.md", "STATUS.md"],
  );
  assert.ok(manifest.files.every((f) => f.source === "/fake/charter.md"));
});

test("deriveOrchBootManifest: 표식 목록에 항목이 늘면 코드 수정 없이 집합이 자동으로 따라온다 (판정 질문 요건 6)", () => {
  const withExtra = CHARTER_FIXTURE.replace(
    "<!-- orch-boot-set: PHASE-HANDOFF.md, STATUS.md -->",
    "<!-- orch-boot-set: PHASE-HANDOFF.md, STATUS.md, 새필독.md -->",
  );
  const manifest = deriveOrchBootManifest([
    { path: "/fake/charter.md", text: withExtra },
  ]);
  assert.equal(manifest.ok, true);
  assert.ok(manifest.files.some((f) => f.basename === "새필독.md"));
});

test("deriveOrchBootManifest: fail-closed -- no marker anywhere -> ok:false reason no_marker", () => {
  const manifest = deriveOrchBootManifest([
    { path: "/fake/empty.md", text: "# 아무 문서\n그냥 산문." },
  ]);
  assert.equal(manifest.ok, false);
  assert.equal(manifest.reason, "no_marker");
});

test("deriveOrchBootManifest: fail-closed -- marker present but file list empty -> ok:false reason empty_marker", () => {
  const manifest = deriveOrchBootManifest([
    { path: "/fake/charter.md", text: "<!-- orch-boot-set:  -->" },
  ]);
  assert.equal(manifest.ok, false);
  assert.equal(manifest.reason, "empty_marker");
});

test("deriveOrchBootManifest: 표식이 둘 이상(같은 문서) -> ok:false reason multiple_markers (조용히 첫 번째를 고르지 않는다)", () => {
  const manifest = deriveOrchBootManifest([
    {
      path: "/fake/charter.md",
      text: "<!-- orch-boot-set: A.md, B.md -->\n<!-- orch-boot-set: C.md -->",
    },
  ]);
  assert.equal(manifest.ok, false);
  assert.equal(manifest.reason, "multiple_markers");
  assert.equal(manifest.markerCount, 2);
});

test("deriveOrchBootManifest: 표식이 둘 이상(서로 다른 문서에 걸쳐) -> ok:false reason multiple_markers", () => {
  const manifest = deriveOrchBootManifest([
    { path: "/fake/a.md", text: "<!-- orch-boot-set: A.md -->" },
    { path: "/fake/b.md", text: "<!-- orch-boot-set: B.md -->" },
  ]);
  assert.equal(manifest.ok, false);
  assert.equal(manifest.reason, "multiple_markers");
  assert.equal(manifest.markerCount, 2);
});

// ---------------------------------------------------------------------------
// 되돌리면 RED -- 예산 안/밖 양쪽을 모두 보인다 (coder-task.md §3-1 요건 8).
// ---------------------------------------------------------------------------
test("checkOrchBootBudget: sum within budget -> ok:true", () => {
  const result = checkOrchBootBudget({
    fileSizes: [
      { basename: "STATUS.md", bytes: 40000 },
      { basename: "PHASE-HANDOFF.md", bytes: 40000 },
    ],
    orchBootBudgetBytes: 98304,
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 80000);
  assert.deepEqual(result.reasons, []);
});

test("checkOrchBootBudget: sum exactly at the budget boundary -> ok (inclusive)", () => {
  const result = checkOrchBootBudget({
    fileSizes: [
      { basename: "STATUS.md", bytes: 49152 },
      { basename: "PHASE-HANDOFF.md", bytes: 49152 },
    ],
    orchBootBudgetBytes: 98304,
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 98304);
});

test("checkOrchBootBudget: sum over budget -> ok:false with a reason carrying the exact total", () => {
  const result = checkOrchBootBudget({
    fileSizes: [
      { basename: "STATUS.md", bytes: 155905 },
      { basename: "PHASE-HANDOFF.md", bytes: 27820 },
    ],
    orchBootBudgetBytes: 98304,
  });
  assert.equal(result.ok, false);
  assert.equal(result.totalBytes, 183725);
  assert.ok(result.reasons.some((r) => r.includes("ORCH_BOOT_BYTES=183725")));
});

test("checkOrchBootBudget: zero files -> total 0, ok:true (no manifest entries is a caller-level concern, not this function's)", () => {
  const result = checkOrchBootBudget({
    fileSizes: [],
    orchBootBudgetBytes: 98304,
  });
  assert.equal(result.ok, true);
  assert.equal(result.totalBytes, 0);
});
