// HYK-255-outbox-aux-1-r2 (coder-task.md §2 ⓑ) -- 새 시험 파일 1개(사유
// 1줄): watch-run.mjs CLI(invokedDirectly 블록)의 --outbox-dir 전달
// "1곳"은 전체 CLI 종단 실행(runWatchOnce -- ㄱ-4 GitHub 조회가 걸려
// api.github.com 0회 축과 겹친다, REVIEW-r1 P2-3 ⑽)을 거쳐야만 깨지는지
// 알 수 있었다. buildPartialCountStepOptions로 그 전달만 뽑아낸 뒤, 이
// 파일에서 그 전달 하나만 단위 시험으로 고정한다(변이 10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPartialCountStepOptions } from "./watch-run.mjs";

test("buildPartialCountStepOptions: outboxDir이 options.outboxDir로 그대로 전달된다(변이 10 -- 이 전달이 끊기면 이 단언이 RED)", () => {
  const result = buildPartialCountStepOptions({
    repoRoot: "/repo",
    watchLogPath: "/repo/watch.log",
    outboxDir: "D:/문서관리/통역/보내는함",
  });
  assert.deepEqual(result, {
    repoRoot: "/repo",
    watchLogPath: "/repo/watch.log",
    outboxDir: "D:/문서관리/통역/보내는함",
  });
});

test("buildPartialCountStepOptions: outboxDir을 안 주면(CLI 기본값 null) options.outboxDir도 null -- 미결선 호출자는 회귀 0", () => {
  const result = buildPartialCountStepOptions({
    repoRoot: "/repo",
    watchLogPath: "/repo/watch.log",
    outboxDir: null,
  });
  assert.equal(result.outboxDir, null);
  assert.equal(result.repoRoot, "/repo");
  assert.equal(result.watchLogPath, "/repo/watch.log");
});
