// HYK-255-outbox-aux-1-r3 (coder-task.md §2 ⓐ · REVIEW-r2 P1-1 "고치는
// 길" 그대로, 2R 고쳐 씀) -- 2R의 시험은 buildPartialCountStepOptions만
// import해 직접 불렀다. 그 함수 본문은 항등 함수 한 줄이라, watch-run.mjs
// CLI의 실제 argv 해석(:--outbox-dir 분기)이나 그 호출부(runWatchOnce
// 뒤 "전달" 줄)가 지워져도 그 시험은 계속 초록이었다(헛시험 grep 결과 ·
// 결과 파일 §2 참조). 이 파일은 그 둘을 "그대로" 옮겨 온
// runWatchCliPartialCountStep을 구동해, 프로덕션 경로(argv -> 호출부 ->
// runPartialCountStepFn)가 실제로 끊기면 RED가 되게 고정한다. runWatchOnce
// (ㄱ-4 GitHub 조회)는 거치지 않는다 -- runPartialCountStepFn을 가짜로
// 주입해 그 경로만 단위 시험으로 잡는다(api.github.com 0회 축과 안
// 겹친다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  forwardArgvToPartialCountStep,
  runWatchCliPartialCountStep,
} from "./watch-run.mjs";

const watchRunPath = fileURLToPath(new URL("./watch-run.mjs", import.meta.url));

test("runWatchCliPartialCountStep: argv의 --outbox-dir가 실제로 options.outboxDir까지 전달된다(변이 10 -- argv 분기 또는 호출부 전달이 끊기면 이 단언이 RED)", async () => {
  let received = null;
  const fakeStepFn = async ({ options }) => {
    received = options;
    return { ran: true, ok: true };
  };
  const result = await runWatchCliPartialCountStep({
    argv: ["--outbox-dir", "D:/문서관리/통역/보내는함", "--no-reach"],
    repoRoot: "/repo",
    watchDir: "/repo/watch",
    now: 1000,
    result: { logPath: "/repo/watch/watch.log" },
    runPartialCountStepFn: fakeStepFn,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(received, {
    repoRoot: "/repo",
    watchLogPath: "/repo/watch/watch.log",
    outboxDir: "D:/문서관리/통역/보내는함",
  });
});

test("runWatchCliPartialCountStep: --outbox-dir을 안 주면(CLI 기본값) options.outboxDir도 null -- 미결선 호출자는 회귀 0", async () => {
  let received = null;
  const fakeStepFn = async ({ options }) => {
    received = options;
    return { ran: true, ok: true };
  };
  await runWatchCliPartialCountStep({
    argv: ["--repo-root", "/repo", "--watch-dir", "/repo/watch"],
    repoRoot: "/repo",
    watchDir: "/repo/watch",
    now: 1000,
    result: { logPath: "/repo/watch/watch.log" },
    runPartialCountStepFn: fakeStepFn,
  });
  assert.equal(received.outboxDir, null);
  assert.equal(received.repoRoot, "/repo");
  assert.equal(received.watchLogPath, "/repo/watch/watch.log");
});

// HYK-439-entry-wiring-1 §2 ⓒ: forwardArgvToPartialCountStep -- the
// invokedDirectly block's own call-site wiring that hands its real argv
// (not a stand-in like []) into runWatchCliPartialCountStep. Driven
// directly with a stub injected via runWatchCliPartialCountStepFn, so this
// stays a unit test instead of driving runWatchOnce's real GitHub-querying
// end-to-end path.
test("forwardArgvToPartialCountStep: forwards the entry point's own real argv (and the other call-site args) into runWatchCliPartialCountStep unchanged", async () => {
  let received = null;
  const realArgv = ["--repo-root", "/repo", "--outbox-dir", "/outbox"];
  const outcome = await forwardArgvToPartialCountStep({
    argv: realArgv,
    repoRoot: "/repo",
    watchDir: "/repo/watch",
    now: 1000,
    result: { logPath: "/repo/watch/watch.log" },
    runWatchCliPartialCountStepFn: async (args) => {
      received = args;
      return { ran: true, ok: true };
    },
  });
  assert.equal(outcome.ok, true);
  assert.equal(received.argv, realArgv);
  assert.equal(received.repoRoot, "/repo");
  assert.equal(received.watchDir, "/repo/watch");
  assert.equal(received.now, 1000);
  assert.equal(received.result.logPath, "/repo/watch/watch.log");
});

// HYK-439-entry-wiring-1-r2 §2 ⓑ (REVIEW-r1 P1 fix, proposed verbatim by
// the reviewer): the test above drives forwardArgvToPartialCountStep()
// directly, so it stays green even if the invokedDirectly block's OWN call
// site stops passing its real argv (e.g. a stand-in like argv: []) or stops
// calling the wrapper at all. Action-based coverage was considered first
// and ruled out: driving the real CLI entry point for real means driving
// runWatchOnce's GitHub-querying end-to-end path, which this round's
// network-ban axis forbids; no short-circuit flag exists in product_scope
// to stop short of it. So this is a source-string cell: slice the file
// from the invokedDirectly block to EOF and assert (a) the call site's
// first key is the bare `argv` variable, not a literal stand-in, (b) that
// `argv` variable is itself bound to the entry point's own
// process.argv.slice(2), and (c) the block never calls the wrapped
// function directly, bypassing the wrapper. Honesty limit: this checks the
// call site's SHAPE (which identifiers/keys are written), not runtime
// behavior -- a same-meaning call spelled a different way would be a false
// red/miss here.
test("CLI entry point (invokedDirectly block): forwards the entry point's own real argv into forwardArgvToPartialCountStep, never bypassing it (source-string cell)", () => {
  const source = readFileSync(watchRunPath, "utf8");
  const blockStart = source.indexOf("if (invokedDirectly) {");
  assert.ok(blockStart >= 0, "invokedDirectly block marker not found");
  const block = source.slice(blockStart);
  assert.match(
    block,
    /const argv = process\.argv\.slice\(2\);/,
    "invokedDirectly block must bind argv to process.argv.slice(2)",
  );
  assert.match(
    block,
    /forwardArgvToPartialCountStep\(\{\s*argv,/,
    "invokedDirectly block's forwardArgvToPartialCountStep call must pass its own argv variable as-is (not a stand-in like argv: [])",
  );
  const bareCalls = block.match(/\brunWatchCliPartialCountStep\(/g);
  assert.strictEqual(
    bareCalls,
    null,
    `invokedDirectly block must not call runWatchCliPartialCountStep(...) directly (bypasses forwardArgvToPartialCountStep's unit-test seam), found: ${JSON.stringify(bareCalls)}`,
  );
});
