// HYK-257-done-stamp-2 §2 범위2 ⓑ -- dispatch-gate-decision.mjs's new
// best-effort dropped_at machine-stamp step.
//
// 실재 앵커(관제실 dispatch-worker.ps1, 읽기 전용 실측 원문): 배달 직전
// 항상 `node scripts/check/dispatch-gate-decision.mjs <roleTaskFile>
// --expect-repo-root <worktree>`를 부른다 -- 그 첫 인자가 이 파일이 새로
// 손대는 대상이다. 이 시험은 (a) 이미 있는 dropped_at: 줄이 새 기계
// 스탬프로 덮어써지고 그 외 내용은 바이트 동일하게 남는지, (b) 이 CLI의
// 기존 게이트/exit-code 계약이 전혀 바뀌지 않는지를 증명한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { writeLedger } from "./reject-streak.mjs";
import { checkRelayHandshake } from "./relay-handshake.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./dispatch-gate-decision.mjs", import.meta.url),
);

const ONE_B_BLOCK =
  "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n";

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-gate-stamp-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// HYK-342 4R §1: this file's fixtures never seed a sibling result file, so
// every run here is the "missing result file" bootstrap path. Since 4R now
// REJECTs when the receipt path can't be confirmed at all (unset path/env),
// give every call a readable, confirmably-empty receipt so these
// dropped_at/ALLOW-REJECT-axis tests keep meaning "genuine first delivery"
// instead of accidentally exercising the new UNSET/REJECT case. A single
// shared empty receipts file (module-scoped, never written to) covers this
// for the whole file.
const SHARED_EMPTY_RECEIPT_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-stamp-test-receipts-")),
  "dispatch-receipts.jsonl",
);
writeFileSync(SHARED_EMPTY_RECEIPT_PATH, "", "utf8");

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
      env: { ...process.env, DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// HYK-479-486 (m): a `--import` preload module that overrides the global
// `Date.now` BEFORE dispatch-gate-decision.mjs (and, transitively,
// dropped-at-stamp-core.mjs's `stampDroppedAt`) ever gets a chance to read
// it -- this is the ONLY way to inject an arbitrary machine-clock reading
// into a real subprocess invocation of the actual CLI (no env-var hook
// exists in production code, and none should be added just for this test --
// that would be a test-only branch in production logic, exactly what this
// repo's house style forbids). Reads FAKE_NOW_MS from the environment so a
// single preload file serves every injected-clock call in this file.
const FAKE_CLOCK_PRELOAD_PATH = join(
  mkdtempSync(join(tmpdir(), "dispatch-gate-stamp-test-clock-")),
  "fake-clock.mjs",
);
writeFileSync(
  FAKE_CLOCK_PRELOAD_PATH,
  `if (process.env.FAKE_NOW_MS) {\n  const fixed = Number(process.env.FAKE_NOW_MS);\n  Date.now = () => fixed;\n}\n`,
  "utf8",
);
const FAKE_CLOCK_PRELOAD_URL = pathToFileURL(FAKE_CLOCK_PRELOAD_PATH).href;

function runCliWithFakeClock(args, fakeNowMs) {
  try {
    const stdout = execFileSync(
      "node",
      ["--import", FAKE_CLOCK_PRELOAD_URL, SCRIPT_PATH, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISPATCH_RECEIPT_PATH: SHARED_EMPTY_RECEIPT_PATH,
          FAKE_NOW_MS: String(fakeNowMs),
        },
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

const DROPPED_AT_RE = /^dropped_at:\s*(.+)$/im;

test("(a) HYK-479-486 write-once: existing dropped_at: line is PRESERVED verbatim (re-gate must not overwrite the first-drop timestamp), rest of file byte-identical", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // HYK-465: this fixture pre-seeds a result_file: line so the OTHER
    // best-effort injection (bestEffortInjectResultPaths) is a no-op here
    // -- this test's only concern is dropped_at write-once behavior in
    // isolation.
    const original = `task_id: HYK-9101-stamp-1\ndropped_at: 2020-01-01 00:00 KST\nresult_file: (pre-seeded, HYK-465 injection must not touch this fixture)\nrole: CODER\nsome body line\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);

    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stdout,
      /dropped_at already present -- write-once/,
      "write-once skip must be visible in delivery-time stdout",
    );

    // HYK-479-486: a dropped_at: line that already carries a value must be
    // byte-for-byte UNCHANGED -- this producer never overwrites a first
    // drop timestamp on a re-gate. This is the flip of the old (pre-486)
    // contract, which this same test used to assert (see git history):
    // that contract silently destroyed the audit value of dropped_at
    // whenever the same ALLOW round was gated more than once.
    const rewritten = readFileSync(taskPath, "utf8");
    assert.equal(
      rewritten,
      original,
      "existing dropped_at: value (and everything else in the file) must be untouched",
    );
    const match = rewritten.match(DROPPED_AT_RE);
    assert.ok(match, "dropped_at: line must still be present");
    assert.equal(match[1].trim(), "2020-01-01 00:00 KST");
  });
});

test("(m) HYK-479-486 §4 비타협: 값이 이미 있는 파일을 ALLOW로 재게이트해도 sha256 바이트 동일(완전 멱등) -- 시각원을 인위로 분 경계 넘겨 주입해도 불변", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `task_id: HYK-9105-idempotent-1\ndropped_at: 2020-01-01 00:00 KST\nresult_file: (pre-seeded, HYK-465 injection must not touch this fixture)\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const originalSha256 = createHash("sha256").update(original).digest("hex");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    // Run 1: inject a fixed clock reading (2026-01-01 12:00 KST).
    const t1Ms = Date.UTC(2026, 0, 1, 3, 0, 0); // 2026-01-01 03:00 UTC = 12:00 KST
    const r1 = runCliWithFakeClock([taskPath, "--ledger", ledgerPath], t1Ms);
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /ALLOW/);
    const afterRun1 = readFileSync(taskPath, "utf8");
    const shaRun1 = createHash("sha256").update(afterRun1).digest("hex");
    assert.equal(
      shaRun1,
      originalSha256,
      "run1 자체도 write-once이므로 원본과 sha256 동일해야 한다",
    );

    // Run 2: inject a clock reading in a DIFFERENT KST minute than run1 --
    // proves the write-once contract is not merely "happened to land in the
    // same minute" but structurally ignores the current clock reading
    // entirely once a value already exists (the exact regression this
    // round fixes: see the §1 diff-proof in the round's result file, where
    // an UNPATCHED CLI overwrote 12:00 KST with 12:05 KST across this same
    // minute-boundary crossing).
    const t2Ms = Date.UTC(2026, 0, 1, 3, 5, 0); // 5 minutes later, different minute
    const r2 = runCliWithFakeClock([taskPath, "--ledger", ledgerPath], t2Ms);
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /ALLOW/);
    assert.match(r2.stdout, /dropped_at already present -- write-once/);

    const afterRun2 = readFileSync(taskPath, "utf8");
    const shaRun2 = createHash("sha256").update(afterRun2).digest("hex");
    assert.equal(
      afterRun2,
      original,
      "재게이트 후에도 파일 전체가 원본과 바이트 단위로 동일해야 한다",
    );
    assert.equal(
      shaRun2,
      originalSha256,
      "(m) 비타협 단정: sha256 전/후 완전 동일(완전 멱등) -- 분 경계를 인위로 넘겨도 불변",
    );
  });
});

test("(b) HYK-316-dropped-stamp-1: no dropped_at: line but task_id: IS present -- a machine dropped_at is INSERTED right after task_id:, ALLOW unaffected", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // HYK-465: pre-seeded result_file: line, same reason as test (a) above.
    const original = `task_id: HYK-9102-nodropped-1\nresult_file: (pre-seeded, HYK-465 injection must not touch this fixture)\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ALLOW/);
    assert.match(
      r.stdout,
      /dropped_at MISSING -- machine-inserted/,
      "insertion must be visible in the delivery-time stdout (§2 요건: 조용히 고치지 말 것)",
    );
    const after = readFileSync(taskPath, "utf8");
    assert.notEqual(
      after,
      original,
      "file must have been rewritten -- a dropped_at: line was inserted",
    );
    const lines = after.split("\n");
    assert.equal(lines[0], "task_id: HYK-9102-nodropped-1");
    assert.match(
      lines[1],
      /^dropped_at: \d{4}-\d{2}-\d{2} \d{2}:\d{2} KST$/,
      "inserted dropped_at: line must sit immediately after task_id:",
    );
    assert.equal(
      after,
      `${lines[0]}\n${lines[1]}\n${original.slice(lines[0].length + 1)}`,
      "everything else in the file must be preserved verbatim around the inserted line",
    );
  });
});

test("(b2) HYK-316-dropped-stamp-1: neither dropped_at: nor task_id: line present -- stamp step is still a no-op, file untouched", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    const original = `role: CODER\nno task_id line at all here\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    const after = readFileSync(taskPath, "utf8");
    assert.equal(
      after,
      original,
      "file must be byte-identical when neither dropped_at: nor task_id: line exists",
    );
    void r;
  });
});

test("(c) HYK-479 §A: pre-existing REJECT fixture shape (streak 2, no envelope) still REJECTs, AND the task file is now byte-for-byte unchanged -- rejecting must not touch dropped_at", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // HYK-465: pre-seed a result_file: line so bestEffortInjectResultPaths
    // (the OTHER best-effort write, unconditional and out of this round's
    // scope -- HYK-479 coder-task.md §B explicitly leaves it untouched) is
    // a no-op here, same convention as tests (a)/(b) above. That isolates
    // this test's whole-file sha256 comparison to the ONE axis actually in
    // scope: the dropped_at stamp.
    const original = `task_id: HYK-9103-reject-1\ndropped_at: 2020-01-01 00:00 KST\nresult_file: (pre-seeded, HYK-465 injection must not touch this fixture)\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const originalSha256 = createHash("sha256").update(original).digest("hex");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, {
      schema_version: 1,
      issues: {
        "HYK-9103": {
          streak: 2,
          history: [
            { task_id: "HYK-9103-coder-1", verdict: "rejected", at: "x" },
            { task_id: "HYK-9103-coder-2", verdict: "rejected", at: "y" },
          ],
        },
      },
    });
    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT/);
    // HYK-479 §A (469 mask-3 실사고 수리): 거부하면 아무것도 바뀌지 않는다
    // -- dropped_at을 포함해 task 파일이 단 1바이트도 바뀌면 안 된다. 이
    // 시험은 이전에는 정확히 반대(거부돼도 dropped_at이 덮어써진다)를
    // 고정했었다 -- 그것이 바로 이 축이 고치는 실사고였다.
    const rewritten = readFileSync(taskPath, "utf8");
    assert.equal(
      rewritten,
      original,
      "REJECT 라운드는 task 파일 바이트가 전/후 완전히 동일해야 한다(dropped_at 포함)",
    );
    const rewrittenSha256 = createHash("sha256")
      .update(rewritten)
      .digest("hex");
    assert.equal(
      rewrittenSha256,
      originalSha256,
      "sha256 전/후 동일 -- 거부 갈래 ⓐ(연속반려 streak)",
    );
  });
});

test("(c2) HYK-479 §A/§B-1: DIFFERENT reject 갈래(1-B 누락 전제조건 위반)에서도 task 파일 sha256이 전/후 동일하다 -- 갈래를 하나만 보고 일반화하지 않는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // ⛔ONE_B_BLOCK을 일부러 안 넣는다 -- checkOneBPrecondition이 이
    // 갈래를 REJECT시킨다(reject-streak 서브프로세스 자체가 아니라 이
    // CLI 안 in-process 전제조건 축이라, (c)의 «연속반려» 갈래와 코드
    // 경로가 다르다 -- B-1이 요구하는 "«게이트 호출 후» 거부되는 갈래
    // 최소 2가지"를 서로 다른 두 축으로 충족한다).
    const original = `task_id: HYK-9104-oneb-reject-1\ndropped_at: 2020-01-01 00:00 KST\nresult_file: (pre-seeded, HYK-465 injection must not touch this fixture)\n`;
    writeFileSync(taskPath, original, "utf8");
    const originalSha256 = createHash("sha256").update(original).digest("hex");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /REJECT/);
    assert.match(
      r.stderr,
      /1b_exec_line|1b_shown|1b_reach_path/,
      "이 갈래는 (c)와 다른 사유(1-B 누락)로 거부돼야 한다 -- 표본이 실제로 다른 코드 경로를 탔는지 확인",
    );

    const rewritten = readFileSync(taskPath, "utf8");
    assert.equal(
      rewritten,
      original,
      "REJECT 라운드는 task 파일 바이트가 전/후 완전히 동일해야 한다(dropped_at 포함) -- 갈래 ⓑ(1-B 누락)",
    );
    const rewrittenSha256 = createHash("sha256")
      .update(rewritten)
      .digest("hex");
    assert.equal(
      rewrittenSha256,
      originalSha256,
      "sha256 전/후 동일 -- 거부 갈래 ⓑ(1-B 누락 전제조건 위반)",
    );
  });
});

// ---------------------------------------------------------------------------
// (d) HYK-316-dropped-stamp-1 §5-2: 어제(08-20) 실사고 재현 -- 프로덕션
// 소비 경로(relay-handshake.mjs의 checkRelayHandshake, helper 아님)로
// «missing dropped_at header» 거부가 더는 발생하지 않음을 고정한다.
// dropped_at 없이 배달된 task 파일이 이 CLI를 거치고 나면(=삽입됨),
// checkRelayHandshake는 dropped_at 단계를 통과해 그 다음 단계(DONE 줄
// 판정)에서만 멈춘다 -- 어제 실사고의 정확한 그 거부 문구
// "task file missing dropped_at header (required for staleness check)"가
// 다시는 이 경로에서 나오지 않는다는 것이 이 시험의 유일한 단언 대상이다.
// ---------------------------------------------------------------------------
test("(d) 프로덕션 경로: dropped_at 없이 배달된 지시서가 이 CLI를 거친 뒤에는, 실제 checkRelayHandshake가 더 이상 'missing dropped_at header'로 거부하지 않는다", () => {
  withFixtureDir((dir) => {
    const taskPath = join(dir, "coder-task.md");
    // 어제 실사고와 같은 모양: task_id는 있지만 dropped_at이 없는 수기
    // 지시서.
    const original = `task_id: HYK-9110-relay-real-1\nrole: CODER\n${ONE_B_BLOCK}`;
    writeFileSync(taskPath, original, "utf8");
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    const r = runCli([taskPath, "--ledger", ledgerPath]);
    assert.equal(r.status, 0);
    const stamped = readFileSync(taskPath, "utf8");
    assert.match(stamped, DROPPED_AT_RE, "dropped_at must now be present");

    // 아직 결과 파일이 없다(워커가 완료하지 않음) -- resolveTaskAndResultFiles
    // 단계에서 'result file not found'로 그친다. dropped_at 판정까지도
    // 가지 않는다는 점을 먼저 고정한다(참고용 하한선).
    const beforeResult = checkRelayHandshake({
      role: "CODER",
      harnessDir: dir,
    });
    assert.equal(beforeResult.ok, false);
    assert.match(beforeResult.reason, /result file not found/);

    // 결과 파일을 만들되(>>> DONE: 줄은 아직 없음) -- 이제
    // resolveTaskAndResultFiles/resolveMatchedTaskId를 지나 dropped_at
    // 판정 단계에 실제로 도달한다.
    writeFileSync(
      join(dir, "coder.md"),
      `task_id: HYK-9110-relay-real-1\n(아직 완료 안 함)\n`,
      "utf8",
    );
    const result = checkRelayHandshake({ role: "CODER", harnessDir: dir });
    assert.equal(
      result.ok,
      false,
      "DONE 줄이 없으므로 여전히 ok:false여야 한다(이 시험의 관심사는 '어느 사유로 거부되는가'다)",
    );
    assert.doesNotMatch(
      result.reason,
      /missing dropped_at header/,
      "어제(08-20) 실사고의 정확히 그 거부 문구가 더는 나오면 안 된다 -- dropped_at 판정은 이제 통과해야 한다",
    );
    assert.match(
      result.reason,
      /missing ">>> DONE:/,
      "dropped_at을 통과했으므로 다음 단계(DONE 줄 판정)에서만 멈춰야 한다",
    );
  });
});
