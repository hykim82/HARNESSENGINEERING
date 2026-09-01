// HYK-350: this repo has TWO agent-seat-marker definitions --
//   운영본(canonical, production-verified) = orca-adapter.mjs's
//   AGENT_MARKER_RE (HYK-345, ported byte-for-byte from the control room's
//   dispatch-worker.ps1 `Looks-Like-Agent`, wired into classifySeatPreview
//   -> resolveSeatLivenessCandidate -> the real dispatch-start decision).
//   사본(copy, UNVERIFIED, opt-in-only) = seat-candidate-adapter.mjs's
//   CLAUDE_AGENT_MARKERS/CODEX_AGENT_MARKERS, used only by that file's own
//   createReferenceSeatCandidateDetector() -- confirmed by repo-wide grep
//   (below, and pasted into coder.md) that NO production call site ever
//   injects that detector; it is exercised only by
//   seat-candidate-adapter.test.mjs's own fixtures.
//
// ⛔coder-task.md §3 비타협: this round does NOT change either marker set
// (that would be changing detection LOGIC, out of scope, and risks HYK-345's
// already-merged seat-population behavior). ★Choice made (§3 "둘 중 하나를
// 골라라"): (b), NOT (a) -- the reference detector is NOT dead weight to
// delete; it is load-bearing test scaffolding for ~15 existing tests in
// seat-candidate-adapter.test.mjs (collectSeatCandidates/observeSeatCandidates
// end-to-end fixtures, the review-1 P1 idle/occupied repro battery). Deleting
// it would force rewriting all of those with ad-hoc inline fakes for no
// behavioral gain (it is provably unreachable from any production path
// already, so deleting it would not close any real risk either). Instead:
// this file PINS today's known, already-documented divergence between the
// two marker sets, so that if either list is edited in the future WITHOUT a
// human consciously updating this file too, the divergence set changes and
// this test goes RED -- exactly coder-task.md §3's "두 정의가 어긋나면
// 빨강이 되는 계약 시험" requirement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_MARKER_RE } from "./orca-adapter.mjs";
import {
  CLAUDE_AGENT_MARKERS,
  CODEX_AGENT_MARKERS,
} from "./seat-candidate-adapter.mjs";

// splitRegexAlternation -- turns `/a|b\.c|\[d\]/`'s source into
// ["a","b.c","[d]"] (plain backslash-escape stripped, good enough for this
// file's own literal marker tokens -- this is a LOCK/PIN helper, not a
// general regex engine). Only used inside this test file.
function splitRegexAlternation(re) {
  return re.source.split("|").map((token) => token.replace(/\\(.)/g, "$1"));
}

// HYK-408-seat-decide: 두 마커 소스 다 `[CODER]`/`[REVIEW]`에서
// `[CODER seat]`/`[REVIEW seat]`(+ 사본은 `[VERIFY seat]`도)로 갱신됐다 --
// 실제 런처 배너(`[$Role seat] worktree=...`, orca-adapter.mjs
// AGENT_MARKER_RE 주석 참조)와 글자 그대로 일치시키는 수리다(그 전에는
// 한 번도 일치한 적이 없었다). 아래 두 pin은 "지금 그대로"를 새 정본으로
// 다시 고정한다.
test("HYK-350 계약 ⓐ (pin, 운영본): AGENT_MARKER_RE의 소스 문자열이 지금 그대로다 -- 바뀌면 이 시험이 먼저 빨강이 된다(계약 문서화)", () => {
  assert.equal(
    AGENT_MARKER_RE.source,
    "gpt-5\\.6|Sonnet|Opus|\\[CODER seat\\]|\\[REVIEW seat\\]|bypass permissions|MCP startup|weekly \\d",
  );
});

test("HYK-350 계약 ⓑ (pin, 사본): CLAUDE_AGENT_MARKERS/CODEX_AGENT_MARKERS가 지금 그대로다 -- 바뀌면 이 시험이 먼저 빨강이 된다(계약 문서화)", () => {
  assert.deepEqual(CLAUDE_AGENT_MARKERS, [
    "Sonnet",
    "Opus",
    "Haiku",
    "[CODER seat]",
    "[REVIEW seat]",
    "[VERIFY seat]",
    "bypass permissions",
  ]);
  assert.deepEqual(CODEX_AGENT_MARKERS, ["gpt-5.6", "codex"]);
});

// HYK-350 §3 핵심: 두 정의의 "차이 집합" 자체를 고정한다 -- 지금은 이미
// 어긋나 있다는 사실을 그대로 문서화하되, 그 차이가 «이 두 목록» 밖으로
// 한 발짝이라도 더 벌어지면(=예상 밖의 새로운 어긋남) 빨강이 된다.
test("HYK-350 계약 ⓒ (divergence pin, 핵심): 두 정의의 차이 집합이 지금 알려진 그대로다 -- 예상 밖으로 더 벌어지면(마커 추가/삭제가 한쪽에서만 일어나면) 이 시험이 빨강이 된다", () => {
  const canonical = splitRegexAlternation(AGENT_MARKER_RE);
  const local = [...CLAUDE_AGENT_MARKERS, ...CODEX_AGENT_MARKERS];

  const canonicalOnly = canonical.filter((m) => !local.includes(m)).sort();
  const localOnly = local.filter((m) => !canonical.includes(m)).sort();

  assert.deepEqual(
    canonicalOnly,
    ["MCP startup", "weekly d"],
    "운영본에만 있고 사본에는 없는 마커 -- 이 목록이 바뀌면 누군가 한쪽만 고쳤다는 뜻",
  );
  assert.deepEqual(
    localOnly,
    ["Haiku", "[VERIFY seat]", "codex"],
    "사본에만 있고 운영본에는 없는 마커 -- 이 목록이 바뀌면 누군가 한쪽만 고쳤다는 뜻",
  );
});
