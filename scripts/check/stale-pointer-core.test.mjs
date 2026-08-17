import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStalePointers,
  findStalePointerHits,
  KNOWN_STALE_POINTER_PATTERNS,
} from "./stale-pointer-core.mjs";

test("findStalePointerHits: finds a known stale pointer phrase with correct path/line/label", () => {
  const files = [
    {
      path: "policy.md",
      content: "line one\n낡은 규칙: STATUS §8 참조\nline three",
    },
  ];
  const hits = findStalePointerHits(files);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "policy.md");
  assert.equal(hits[0].lineNumber, 2);
  assert.equal(hits[0].label, "STATUS §8");
});

test("findStalePointerHits: CRLF documents still resolve correct line numbers", () => {
  const files = [{ path: "p.md", content: "a\r\nb\r\nSTATUS §8\r\nd" }];
  const hits = findStalePointerHits(files);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lineNumber, 3);
});

test("findStalePointerHits: second known pattern (STATUS.md(§1 슬롯·§4) also matches", () => {
  const files = [{ path: "p.md", content: "참조: STATUS.md(§1 슬롯·§4 표)" }];
  const hits = findStalePointerHits(files);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "STATUS.md(§1 슬롯·§4");
});

test("findStalePointerHits: multiple files, multiple hits, each attributed to its own file", () => {
  const files = [
    { path: "a.md", content: "STATUS §8" },
    { path: "b.md", content: "clean, no stale pointer here" },
    { path: "c.md", content: "STATUS §8\nSTATUS §8" },
  ];
  const hits = findStalePointerHits(files);
  assert.equal(hits.length, 3);
  assert.deepEqual(
    hits.map((h) => h.path),
    ["a.md", "c.md", "c.md"],
  );
});

test("findStalePointerHits: zero hits on clean content", () => {
  const files = [{ path: "clean.md", content: "nothing stale in here at all" }];
  assert.deepEqual(findStalePointerHits(files), []);
});

test("findStalePointerHits: custom injected patterns override the default known-set", () => {
  const files = [{ path: "p.md", content: "custom-marker here" }];
  const hits = findStalePointerHits(files, [
    { label: "custom", pattern: "custom-marker" },
  ]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].label, "custom");
});

test("KNOWN_STALE_POINTER_PATTERNS: exactly the 2 patterns PM-r9.md's literal rg command searched for", () => {
  assert.equal(KNOWN_STALE_POINTER_PATTERNS.length, 2);
});

// ---------------------------------------------------------------------------
// 되돌리면 RED -- 있음/없음 양쪽을 모두 보인다 (coder-task.md §3-1 요건 8).
// ---------------------------------------------------------------------------
test("checkStalePointers: no stale pointers -> ok:true, staleHits=0", () => {
  const result = checkStalePointers({
    files: [{ path: "p.md", content: "all clean" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.staleHits, 0);
});

test("checkStalePointers: one stale pointer -> ok:false, staleHits=1, exact hit surfaced", () => {
  const result = checkStalePointers({
    files: [{ path: "p.md", content: "STATUS §8" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.staleHits, 1);
  assert.equal(result.hits[0].path, "p.md");
});
