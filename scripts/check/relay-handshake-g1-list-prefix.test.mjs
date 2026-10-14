// HYK-425 §2 item7 -- HYK-434 3R 검토 P2-2(세 키 목록 범주 통일) 편입.
//
// 1R에는 `pane_match:`만 목록 접두(`+ `/`1. `)를 받고
// `dispatch_verified:`/`task_id_from_dispatch:`는 `-`/`*`만 받아, 같은
// 모양의 줄인데도 두 키는 "형식 거부"(found mid-line)됐다(정본 =
// 관제실 아카이브 2026-10-11-B76-하네스-G1기계대조\pr314-review\review.md
// P2-2). 이 파일은 세 키가 같은 목록 접두 범주(`-`/`*`/`+`/`1. `)를 같은
// 규칙으로 받는지, 그리고 값이 다를 때는 (형식 거부가 아니라) 값 불일치로
// 거부되는지를 고정한다.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isolatedChildEnv } from "./admission-ledger-env-isolation.mjs";
import { RELAY_HANDSHAKE_STATIC_SIBLINGS } from "./relay-handshake-fixture-siblings.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, "relay-handshake.mjs");
const SIBLING_DEPS = RELAY_HANDSHAKE_STATIC_SIBLINGS;

const SCRATCH_ROOT = join(tmpdir(), "hyk425-g1-prefix-scratch");

function withFixtureDir(prefix, fn) {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

after(() => {
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function formatKst(ms, { seconds = false } = {}) {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const p2 = (n) => String(n).padStart(2, "0");
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(
    d.getUTCDate(),
  )} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${base}:${p2(d.getUTCSeconds())} KST` : `${base} KST`;
}

const NOW_MS = Date.now();
const DEFAULT_DROPPED_MS = Math.floor((NOW_MS - 30 * 60 * 1000) / 1000) * 1000;
const DEFAULT_DONE_MS = Math.floor((NOW_MS - 10 * 60 * 1000) / 1000) * 1000;
const DEFAULT_RECORDED_AT_MS = DEFAULT_DROPPED_MS + 60 * 1000;

const RUNTIME_TASK_ID = "task_aaaaaaaaaaaa";
const PANE_KEY =
  "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222";

// 세 키가 같은 목록 접두 범주를 공유하는지 보는 고정 칸 -- (-, *, +, 1. ).
const LIST_PREFIXES = ["- ", "* ", "+ ", "1. "];

// `prefixedKey`에만 `prefix`를 붙이고, 나머지 두 줄은 접두 없는 기본
// 모양 그대로 둔다 -- 한 번에 한 키씩만 바꿔 어느 키가 거부되는지 고립한다.
function g1BlockPrefixed(prefixedKey, prefix, overrides = {}) {
  const dv = overrides.dispatchVerified ?? "yes";
  const tid = overrides.taskIdFromDispatch ?? RUNTIME_TASK_ID;
  const pl = overrides.paneLeft ?? PANE_KEY;
  const pr = overrides.paneRight ?? PANE_KEY;
  const pv = overrides.paneVerdict ?? "일치";
  const p = (key) => (prefixedKey === key ? prefix : "");
  return (
    `${p("dispatch_verified")}dispatch_verified: ${dv}\n` +
    `${p("task_id_from_dispatch")}task_id_from_dispatch: ${tid}\n` +
    `${p("pane_match")}pane_match: ${pl} == ${pr} ? ${pv}\n`
  );
}

function writeCoderRound(
  dir,
  {
    taskId = "HYK-425-T",
    doneAtMs = DEFAULT_DONE_MS,
    droppedAtMs = DEFAULT_DROPPED_MS,
    g1,
  } = {},
) {
  writeFileSync(
    join(dir, "coder-task.md"),
    `task_id: ${taskId}\ndropped_at: ${formatKst(droppedAtMs)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "coder.md"),
    `task_id: ${taskId}\n${g1}\n>>> DONE: CODER @ ${formatKst(doneAtMs, {
      seconds: true,
    })}\ndone_stamped_by: finalize-done\n`,
    "utf8",
  );
}

function ledgerLine(record) {
  return JSON.stringify(record) + "\n";
}

function validReceipt({
  role = "coder",
  taskId = "HYK-425-T",
  recordedAtMs = DEFAULT_RECORDED_AT_MS,
  runtimeTaskId = RUNTIME_TASK_ID,
  paneKey = PANE_KEY,
} = {}) {
  return {
    recorded_at: new Date(recordedAtMs).toISOString(),
    runtime_task_id: runtimeTaskId,
    dispatch_id: "ctx_1",
    assignee_pane_key: paneKey,
    dispatch_timestamp_utc: new Date(DEFAULT_DROPPED_MS).toISOString(),
    dispatch_timestamp_source: "response.dispatched_at",
    role,
    harness_task_label: taskId,
  };
}

function withLedger(dir, records) {
  const ledgerPath = join(dir, "dispatch-receipts.jsonl");
  writeFileSync(ledgerPath, records.map((r) => ledgerLine(r)).join(""), "utf8");
  return ledgerPath;
}

function runCli(args, { ledgerPath } = {}) {
  if (ledgerPath) {
    writeFileSync(
      join(args[1], "dispatch-receipt-path.txt"),
      ledgerPath,
      "utf8",
    );
  }
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  assert.notEqual(res.status, null, "process must not be signal-killed");
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageMutatedRelayHandshake(stageDir, mutateFn) {
  const nestedDir = join(stageDir, "scripts", "check");
  mkdirSync(nestedDir, { recursive: true });
  const original = readFileSync(CLI_PATH, "utf8");
  const mutated = mutateFn(original);
  assert.notEqual(
    mutated,
    original,
    "mutation must actually change the source",
  );
  writeFileSync(join(nestedDir, "relay-handshake.mjs"), mutated, "utf8");
  for (const dep of SIBLING_DEPS) {
    writeFileSync(
      join(nestedDir, dep),
      readFileSync(join(HERE, dep), "utf8"),
      "utf8",
    );
  }
  return join(nestedDir, "relay-handshake.mjs");
}

// (g1p-m5) 자신의 줄 수를 줄이기 위해(eslint max-lines-per-function) 세
// 라운드(ⓐⓑⓒ)를 같은 모양으로 조립하는 부분만 뽑는다 -- 판정/사유는
// 조금도 바뀌지 않는다.
function runPrefixRoundAgainstCli(parentDir, name, key, prefix, cliPath) {
  const dir = join(parentDir, name);
  mkdirSync(dir);
  writeCoderRound(dir, { g1: g1BlockPrefixed(key, prefix) });
  const ledgerPath = withLedger(dir, [validReceipt()]);
  writeFileSync(join(dir, "dispatch-receipt-path.txt"), ledgerPath, "utf8");
  return { dir, ledgerPath, result: runMutatedCli(cliPath, ["coder", dir]) };
}

function runMutatedCli(mutatedCliPath, args) {
  const env = isolatedChildEnv({});
  const res = spawnSync(process.execPath, [mutatedCliPath, ...args], {
    encoding: "utf8",
    env,
  });
  assert.equal(
    res.error,
    undefined,
    `spawn must succeed: ${res.error?.message}`,
  );
  return {
    exit: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// ===========================================================================
// 고정 칸(필수): 세 키 각각 × 목록 접두 모양(-, *, +, 1. ) × 값 같음 -> 소비.
// ===========================================================================
for (const key of [
  "dispatch_verified",
  "task_id_from_dispatch",
  "pane_match",
]) {
  for (const prefix of LIST_PREFIXES) {
    test(`(g1p-ok)★ ${key}: 목록 접두 '${prefix.trim()}' + 값이 원장과 같음 -> 소비(exit 0)`, () => {
      withFixtureDir(`g1p-ok-${key}-`, (dir) => {
        writeCoderRound(dir, { g1: g1BlockPrefixed(key, prefix) });
        const ledgerPath = withLedger(dir, [validReceipt()]);
        const res = runCli(["coder", dir], { ledgerPath });
        assert.equal(
          res.exit,
          0,
          `expected clean pass for key=${key} prefix='${prefix}': ${res.stderr}`,
        );
      });
    });
  }
}

// ===========================================================================
// 고정 칸(필수): 세 키 각각 -- 목록 접두가 있어도 값이 원장과 다르면
// "값 불일치"로 거부된다(형식 거부가 아니다 -- 접두 자체가 거부 사유가
// 되면 안 된다는 것을 값 쪽에서도 다시 확인한다).
// ===========================================================================
test("(g1p-mismatch-dv) dispatch_verified: '+ ' 접두 + 값 'no'(기대 'yes') -> 값 불일치 거부(형식 거부 아님)", () => {
  withFixtureDir("g1p-mismatch-dv-", (dir) => {
    writeCoderRound(dir, {
      g1: g1BlockPrefixed("dispatch_verified", "+ ", {
        dispatchVerified: "no",
      }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'dispatch_verified:' line value mismatch/);
    assert.doesNotMatch(res.stderr, /no standalone column-0 line found/);
    assert.doesNotMatch(res.stderr, /found mid-line/);
  });
});

test("(g1p-mismatch-tid) task_id_from_dispatch: '1. ' 접두 + 값이 원장과 다름 -> 값 불일치 거부(형식 거부 아님)", () => {
  withFixtureDir("g1p-mismatch-tid-", (dir) => {
    writeCoderRound(dir, {
      g1: g1BlockPrefixed("task_id_from_dispatch", "1. ", {
        taskIdFromDispatch: "task_bbbbbbbbbbbb",
      }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'task_id_from_dispatch:' line value mismatch/);
    assert.doesNotMatch(res.stderr, /no standalone column-0 line found/);
    assert.doesNotMatch(res.stderr, /found mid-line/);
  });
});

test("(g1p-mismatch-pane) pane_match: '+ ' 접두 + pane key가 원장과 다름 -> 값 불일치 거부(형식 거부 아님, 기존 pane_match 접두 지원의 회귀 아님을 확인)", () => {
  withFixtureDir("g1p-mismatch-pane-", (dir) => {
    const OTHER_PANE_KEY =
      "99999999-9999-9999-9999-999999999999:88888888-8888-8888-8888-888888888888";
    writeCoderRound(dir, {
      g1: g1BlockPrefixed("pane_match", "+ ", {
        paneLeft: OTHER_PANE_KEY,
        paneRight: OTHER_PANE_KEY,
      }),
    });
    const ledgerPath = withLedger(dir, [validReceipt()]);
    const res = runCli(["coder", dir], { ledgerPath });
    assert.notEqual(res.exit, 0);
    assert.match(res.stderr, /'pane_match:' line value mismatch/);
    assert.doesNotMatch(res.stderr, /no standalone column-0 line found/);
    assert.doesNotMatch(res.stderr, /found mid-line/);
  });
});

// ===========================================================================
// M5: 공유를 끊어 두 키만 옛(narrow) 판독으로 되돌린다 -> 그 두 키의
// '+'/'1. ' 접두 칸만 RED(다시 형식 거부), pane_match는 영향 없음(대조군).
// ===========================================================================
test("(g1p-m5)★ 되돌림 변이 M5: dispatch_verified/task_id_from_dispatch의 목록 접두 범주를 옛(-, * 만) 모양으로 되돌리면 -- '+ '/'1. ' 접두를 쓴 표본이 다시 형식 거부로 RED(pane_match는 대조군으로 그대로 통과)", () => {
  withFixtureDir("g1p-m5-", (dir) => {
    const original = readFileSync(CLI_PATH, "utf8");
    const target1 =
      "const DISPATCH_VERIFIED_RE_G =\n  /^[ \\t]*(?:[-*+][ \\t]+|\\d+\\.[ \\t]+)?\\*{0,2}dispatch_verified\\*{0,2}[ \\t]*[:：][ \\t]*(\\S.*?)[ \\t]*$/gim;";
    const target2 =
      "const TASK_ID_FROM_DISPATCH_RE_G =\n  /^[ \\t]*(?:[-*+][ \\t]+|\\d+\\.[ \\t]+)?\\*{0,2}task_id_from_dispatch\\*{0,2}[ \\t]*[:：][ \\t]*(\\S.*?)[ \\t]*$/gim;";
    assertExactlyOneMatch(
      original,
      target1,
      "dispatch_verified regex (widened)",
    );
    assertExactlyOneMatch(
      original,
      target2,
      "task_id_from_dispatch regex (widened)",
    );

    const mutateFn = (src) =>
      src
        .replace(
          target1,
          "const DISPATCH_VERIFIED_RE_G =\n  /^[ \\t]*(?:[-*][ \\t]+)?\\*{0,2}dispatch_verified\\*{0,2}[ \\t]*[:：][ \\t]*(\\S.*?)[ \\t]*$/gim; // HYK-425 되돌림 변이 M5",
        )
        .replace(
          target2,
          "const TASK_ID_FROM_DISPATCH_RE_G =\n  /^[ \\t]*(?:[-*][ \\t]+)?\\*{0,2}task_id_from_dispatch\\*{0,2}[ \\t]*[:：][ \\t]*(\\S.*?)[ \\t]*$/gim; // HYK-425 되돌림 변이 M5",
        );

    const stageDir = join(dir, "stage");
    mkdirSync(stageDir);
    const mutatedCliPath = stageMutatedRelayHandshake(stageDir, mutateFn);

    // ⓐ dispatch_verified + '+ ' 접두 -> 되돌린 뒤에는 RED(형식 거부로
    // 되돌아감). 대조군: 되돌리기 전(원본 CLI)은 같은 표본을 통과시킨다.
    const a = runPrefixRoundAgainstCli(
      dir,
      "round-a",
      "dispatch_verified",
      "+ ",
      mutatedCliPath,
    );
    assert.notEqual(
      a.result.exit,
      0,
      `RED 필수: 되돌림 뒤 dispatch_verified '+ ' 접두가 다시 거부돼야 한다. stderr: ${a.result.stderr}`,
    );
    const origResA = runCli(["coder", a.dir], { ledgerPath: a.ledgerPath });
    assert.equal(
      origResA.exit,
      0,
      `원본(되돌리기 전)은 같은 표본을 통과시켜야 한다(대조군): ${origResA.stderr}`,
    );

    // ⓑ task_id_from_dispatch + '1. ' 접두 -> 되돌린 뒤에는 RED.
    const b = runPrefixRoundAgainstCli(
      dir,
      "round-b",
      "task_id_from_dispatch",
      "1. ",
      mutatedCliPath,
    );
    assert.notEqual(
      b.result.exit,
      0,
      `RED 필수: 되돌림 뒤 task_id_from_dispatch '1. ' 접두가 다시 거부돼야 한다. stderr: ${b.result.stderr}`,
    );

    // ⓒ 대조군: pane_match + '+ ' 접두는 이 변이의 영향 밖(공유를 끊은
    // 두 키만 되돌렸다) -- 되돌린 CLI로도 여전히 통과한다.
    const c = runPrefixRoundAgainstCli(
      dir,
      "round-c",
      "pane_match",
      "+ ",
      mutatedCliPath,
    );
    assert.equal(
      c.result.exit,
      0,
      `대조군: pane_match는 이 변이의 영향 밖이어야 한다. stderr: ${c.result.stderr}`,
    );

    const after = readFileSync(CLI_PATH, "utf8");
    assert.equal(
      after,
      original,
      "원본 relay-handshake.mjs는 한 바이트도 변경되지 않았다",
    );
  });
});
