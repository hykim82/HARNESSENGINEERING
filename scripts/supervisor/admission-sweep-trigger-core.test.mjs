// HYK-228 (coder-task.md §5) -- admission-sweep-trigger-core.mjs 계약 시험.
//
// 이 시험이 보장하지 않는 것(S11):
// 1. "orca terminal list가 실제로 정확하다"를 증명하지 않는다 -- 이
//    코어는 주입된 `terminalList`만 판정한다.
// 2. 표본 수 -- 각 test 이름에 분모를 명시한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeSweepTrigger,
  SWEEP_TRIGGER_VERDICT,
  SWEEP_TRIGGER_REASON,
} from "./admission-sweep-trigger-core.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}
const ROOT = repoRoot();
const preStatus = execFileSync("git", ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf8",
});

test("PROCEED: successful terminal list yields deduped, non-empty-string handles only (1/1 fixture)", () => {
  const result = judgeSweepTrigger({
    terminalList: {
      ok: true,
      terminals: [
        { handle: "seat-a" },
        { handle: "seat-b" },
        { handle: "seat-a" }, // duplicate -- must not double-count
        { handle: "" }, // empty string -- must be dropped
        { notHandle: "x" }, // missing handle -- must be dropped
        "not-an-object", // malformed entry -- must be dropped, not thrown
      ],
    },
  });
  assert.equal(result.verdict, SWEEP_TRIGGER_VERDICT.PROCEED);
  assert.equal(result.reasonCode, SWEEP_TRIGGER_REASON.OK);
  assert.deepEqual(result.liveSeatKeys, ["seat-a", "seat-b"]);
});

test("ABSTAIN (fail-closed): seat query failure never yields liveSeatKeys:[] (3/3: ok:false, malformed shape, undefined)", () => {
  const cases = [
    { ok: false, reason: "orca not reachable" },
    "not-an-object",
    undefined,
  ];
  for (const terminalList of cases) {
    const result = judgeSweepTrigger({ terminalList });
    assert.equal(
      result.verdict,
      SWEEP_TRIGGER_VERDICT.ABSTAIN,
      `expected ABSTAIN for terminalList=${JSON.stringify(terminalList)}`,
    );
    assert.notEqual(
      result.liveSeatKeys,
      [],
      "ABSTAIN must carry liveSeatKeys:null, not an empty array that could be mistaken for '0 live seats observed'",
    );
    assert.equal(result.liveSeatKeys, null);
  }
});

test("ABSTAIN: ok:true but terminals is not an array -> SEAT_LIST_MALFORMED, not silently []", () => {
  const result = judgeSweepTrigger({
    terminalList: { ok: true, terminals: "oops" },
  });
  assert.equal(result.verdict, SWEEP_TRIGGER_VERDICT.ABSTAIN);
  assert.equal(result.reasonCode, SWEEP_TRIGGER_REASON.SEAT_LIST_MALFORMED);
});

test("never throws regardless of input shape (doesNotThrow, 4/4)", () => {
  for (const bad of [null, undefined, 42, []]) {
    assert.doesNotThrow(() => judgeSweepTrigger({ terminalList: bad }));
  }
});

// ---------------------------------------------------------------------------
// ⓔ mutation RED + revert proof (coder-task §5-ⓔ, watch-freshness-core.
// test.mjs의 copy-and-mutate 관례 그대로).
// ---------------------------------------------------------------------------
let CORE_SRC = null;
try {
  CORE_SRC = execFileSync(
    "git",
    ["show", "HEAD:scripts/supervisor/admission-sweep-trigger-core.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
} catch {
  CORE_SRC = null;
}
const SRC_COMMITTED = CORE_SRC !== null;
const NOT_COMMITTED_SKIP_REASON =
  "admission-sweep-trigger-core.mjs가 신규 파일이라 아직 커밋되지 않아 git HEAD 추적본에 없다 -- 커밋 후 이 mutation은 자동으로 실행된다(no-op 아님, SRC_COMMITTED가 그때 true가 되어 이 skip이 해제됨). coder-task §7 '커밋 0' 비타협 때문에 이 라운드에서는 이 시험이 항상 skip된다 -- CODER 보고서에 명시.";

async function importMutatedCopy(mutate) {
  const dir = fs.mkdtempSync(
    join(tmpdir(), "nc-admission-sweep-trigger-core-mutant-"),
  );
  const mutated = mutate(CORE_SRC);
  const filePath = join(dir, "admission-sweep-trigger-core.mutant.mjs");
  fs.writeFileSync(filePath, mutated, "utf8");
  try {
    return await import(`file://${filePath.replace(/\\/g, "/")}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test(
  "NC mutation/admission-sweep-trigger-core #1 (필수, §4 비타협 표적): fail-closed 가드(`terminalList.ok !== true`) 제거 -> RED (조회 실패가 PROCEED로 샘 = '전부 회수'로 새는 문)",
  { skip: !SRC_COMMITTED && NOT_COMMITTED_SKIP_REASON },
  async () => {
    // coder-r2 rejection-1: 이전 입력 `{ok:false, reason:"review mutation"}`은
    // 표적 가드(`terminalList.ok !== true`)만 지워도 여전히 ABSTAIN이었다 --
    // `terminals`가 undefined라 뒤의 `Array.isArray(terminalList.terminals)`
    // 가드가 대신 막아버리기 때문(검토자 실측, review-r1.md). 표적 가드
    // *하나만* 분리해서 때리려면 `terminals: []`를 함께 줘야 한다 -- 그러면
    // ok:true 분기로 잘못 새어 들어갔을 때 Array.isArray는 통과하고(빈
    // 배열도 배열이므로) PROCEED까지 도달한다. 표적 가드가 있으면 이 지점
    // 이전에 ABSTAIN으로 막힌다. present/removed 두 변형을 직접 실행해
    // 확인한 값(.harness/coder.md 참조): present -> ABSTAIN/SEAT_QUERY_FAILED,
    // removed -> PROCEED/OK/liveSeatKeys:[].
    const mutant = await importMutatedCopy((src) =>
      src.replace(
        "  if (terminalList.ok !== true) {\n    return abstain(SWEEP_TRIGGER_REASON.SEAT_QUERY_FAILED);\n  }\n",
        "",
      ),
    );
    const result = mutant.judgeSweepTrigger({
      terminalList: { ok: false, reason: "query failed", terminals: [] },
    });
    assert.notEqual(
      result.verdict,
      "ABSTAIN",
      "mutant must fail to abstain on a failed seat query (RED signal; proves the fail-closed guard is load-bearing)",
    );
  },
);

after(() => {
  const postStatus = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(
    postStatus,
    preStatus,
    "admission-sweep-trigger-core.test.mjs must leave the real worktree exactly as it found it (git diff --exit-code proof of revert, coder-task §5-ⓔ)",
  );
});
