// HYK-467 (coder-task.md §B-3) -- probe-budget.mjs 시험.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import {
  readFileSync as fsReadFileSync,
  writeFileSync as fsWriteFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  judgeProbeBudget,
  recordProbe,
  DEFAULT_CAP_PER_HOUR,
  DEFAULT_WINDOW_MS,
} from "./probe-budget.mjs";

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "probe-budget-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- core: judgeProbeBudget (pure) -----------------------------------------

test("judgeProbeBudget: 창 안에 상한 미만이면 ok:true", () => {
  const now = 1_000_000_000;
  const result = judgeProbeBudget({
    priorProbeTimestampsMs: [now - 1000, now - 2000],
    nowMs: now,
    capPerHour: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.countInWindow, 2);
});

test("judgeProbeBudget: 창 안에 상한과 같거나 넘으면 ok:false", () => {
  const now = 1_000_000_000;
  const result = judgeProbeBudget({
    priorProbeTimestampsMs: [now - 1, now - 2, now - 3],
    nowMs: now,
    capPerHour: 3,
  });
  assert.equal(result.ok, false);
  assert.equal(result.countInWindow, 3);
});

test("judgeProbeBudget: 창 밖(1시간 이전) 기록은 세지 않는다(가지치기)", () => {
  const now = DEFAULT_WINDOW_MS * 10;
  const result = judgeProbeBudget({
    priorProbeTimestampsMs: [now - DEFAULT_WINDOW_MS - 1, now - 100],
    nowMs: now,
    capPerHour: 1,
  });
  assert.equal(result.countInWindow, 1, "창 밖 기록 1개는 제외되어야 한다");
  assert.equal(result.ok, false, "남은 1개가 상한(1)과 같으므로 소진");
  assert.deepEqual(result.prunedTimestampsMs, [now - 100]);
});

test("judgeProbeBudget: 손상된/비배열 입력은 '기록 없음'으로 안전하게 처리(과잉 차단 없음)", () => {
  const result = judgeProbeBudget({
    priorProbeTimestampsMs: "not-an-array",
    nowMs: 1000,
    capPerHour: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.countInWindow, 0);
});

test("judgeProbeBudget: 기본값(생략) -- DEFAULT_CAP_PER_HOUR/DEFAULT_WINDOW_MS 사용", () => {
  const result = judgeProbeBudget({ nowMs: 1000 });
  assert.equal(result.capPerHour, DEFAULT_CAP_PER_HOUR);
});

// ---- adapter: recordProbe (file-based, simulates independent watchers) ----

function fsAdapters() {
  return {
    readFn: fsReadFileSync,
    writeFn: fsWriteFileSync,
    mkdirFn: mkdirSync,
    existsFn: existsSync,
    dirnameFn: dirname,
  };
}

test("recordProbe: 첫 호출은 파일이 없어도 허용되고, 상태 파일을 만든다", () => {
  withDir((dir) => {
    const budgetPath = join(dir, "sub", "probe-budget.json");
    const r = recordProbe({
      budgetPath,
      nowMs: 1000,
      capPerHour: 5,
      ...fsAdapters(),
    });
    assert.equal(r.ok, true);
    assert.equal(r.countInWindow, 1);
    assert.ok(existsSync(budgetPath));
    const saved = JSON.parse(readFileSync(budgetPath, "utf8"));
    assert.deepEqual(saved.probeTimestampsMs, [1000]);
  });
});

// ★핵심(coder-task.md §B-5-4): "감시기 2개 이상 동시 가동 상태에서
// 실제로 합산" -- 서로 다른 두 "감시기" 호출자를 시뮬레이션한다. 같은
// budgetPath를 공유한다는 사실 하나만으로 두 번째 호출자가 첫 번째
// 호출자의 소비를 그대로 물려받는다(개별 예산이었다면 각자 5/5로 둘 다
// ok:true였을 상황).
test("★핵심: 두 개의 «독립된» 감시기가 같은 공유 예산 파일을 가리키면, 합계로 카운트된다 -- 개별 예산이었다면 놓쳤을 초과를 잡는다", () => {
  withDir((dir) => {
    const budgetPath = join(dir, "shared-probe-budget.json");
    const cap = 4;
    const adapters = fsAdapters();

    // "감시기 A"가 3회 프로브(자기 혼자 보기엔 상한 4 미만, 안전해 보임).
    const watcherAResults = [];
    for (let i = 0; i < 3; i++) {
      watcherAResults.push(
        recordProbe({
          budgetPath,
          nowMs: 1000 + i,
          capPerHour: cap,
          ...adapters,
        }),
      );
    }
    assert.ok(
      watcherAResults.every((r) => r.ok),
      "감시기 A 혼자서는 상한 안에 있다",
    );

    // "감시기 B"(완전히 별개 호출자, 자기 카운터가 있다면 1/4로 여유로워
    // 보일 것) -- 하지만 공유 파일을 보므로 A의 3회가 이미 반영돼 있다.
    const watcherB1 = recordProbe({
      budgetPath,
      nowMs: 2000,
      capPerHour: cap,
      ...adapters,
    });
    assert.equal(watcherB1.ok, true, "합계 3 -> 이번이 4번째, 아직 상한 미만");
    assert.equal(watcherB1.countInWindow, 4);

    // 감시기 B의 두 번째 시도 -- 합계가 이미 4(상한)에 도달했으므로 거부.
    const watcherB2 = recordProbe({
      budgetPath,
      nowMs: 2001,
      capPerHour: cap,
      ...adapters,
    });
    assert.equal(
      watcherB2.ok,
      false,
      "합계가 상한에 도달했으므로 서로 다른 감시기여도 거부되어야 한다",
    );
    assert.equal(watcherB2.countInWindow, 4);
  });
});

test("recordProbe: 예산 소진 시 거부된 시도는 상태 파일에 흔적을 남기지 않는다(과잉 억제 방지)", () => {
  withDir((dir) => {
    const budgetPath = join(dir, "probe-budget.json");
    const adapters = fsAdapters();
    recordProbe({ budgetPath, nowMs: 1000, capPerHour: 1, ...adapters });
    const before = JSON.parse(readFileSync(budgetPath, "utf8"));
    assert.deepEqual(before.probeTimestampsMs, [1000]);

    const rejected = recordProbe({
      budgetPath,
      nowMs: 1001,
      capPerHour: 1,
      ...adapters,
    });
    assert.equal(rejected.ok, false);
    const after = JSON.parse(readFileSync(budgetPath, "utf8"));
    assert.deepEqual(
      after.probeTimestampsMs,
      [1000],
      "거부된 프로브의 시각(1001)이 기록에 추가되면 안 된다",
    );
  });
});

test("recordProbe: 손상된 상태 파일은 '기록 없음'으로 취급된다(과잉 차단 없음)", () => {
  withDir((dir) => {
    const budgetPath = join(dir, "probe-budget.json");
    fsWriteFileSync(budgetPath, "{ not valid json", "utf8");
    const r = recordProbe({
      budgetPath,
      nowMs: 1000,
      capPerHour: 1,
      ...fsAdapters(),
    });
    assert.equal(r.ok, true);
  });
});

test("recordProbe: 창 밖으로 나간 과거 기록은 새 프로브 판정에서 제외된다(시간 경과로 예산이 회복)", () => {
  withDir((dir) => {
    const budgetPath = join(dir, "probe-budget.json");
    const adapters = fsAdapters();
    recordProbe({ budgetPath, nowMs: 0, capPerHour: 1, ...adapters });
    const stillWithin = recordProbe({
      budgetPath,
      nowMs: DEFAULT_WINDOW_MS - 1,
      capPerHour: 1,
      ...adapters,
    });
    assert.equal(stillWithin.ok, false, "창 안이므로 여전히 거부");

    const afterWindow = recordProbe({
      budgetPath,
      nowMs: DEFAULT_WINDOW_MS + 1,
      capPerHour: 1,
      ...adapters,
    });
    assert.equal(afterWindow.ok, true, "창을 벗어났으므로 예산이 회복된다");
  });
});
