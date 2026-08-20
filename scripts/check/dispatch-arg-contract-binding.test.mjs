// HYK-319-argcheck-1 (coder-task.md §2-2) -- ★비타협: 선언(레지스트리)만
// 있고 CLI가 실제로는 그 인자 없이도 도는 «헛선언»이면 이 검사기는 값이
// 없다. 이 파일은 dispatch-arg-contract-registry.mjs가 선언한 각 CLI의
// requiredArgs를 하나씩 빼고, 각 CLI 자신의 프로덕션 진입점(export된
// run* 함수 -- CLI 하단 `invokedDirectly` 블록이 부르는 바로 그 함수, 또는
// 그 로직이 export되지 않은 dispatch-start-confirm-cli.mjs만 실제 subprocess
// 구동)을 직접 돌려 «거부(비정상 종료/실패)»하는지 확인한다.
//
// hard=true 선언: 빼면 실제로 죽는다(아래에서 직접 증명).
// hard=false 선언: 빼도 그 CLI 프로세스 자신은 안 죽는다 -- 레지스트리의
//   note에 그 이유와 "그런데도 유지하는 근거"가 있다. 이 파일은 그 소프트
//   선언에 대해 "빼도 여전히 같은 결과(ALLOW/성공)"임을 직접 보여 정직하게
//   기록한다(§2-2 "선언을 조용히 지우지 마라").
//
// ★이 파일은 scripts/check/*·scripts/supervisor/* CLI 3개(dispatch-gate-
// decision·admission-cli·dispatch-start-confirm-cli)만 다룬다.
// scripts/relay/* CLI 2개(dispatch-receipt-cli·dispatch-worker-seat-proof-
// gate)는 scripts/relay/dispatch-arg-contract-binding-relay.test.mjs에
// 있다 -- 이 저장소 ESLint 아키텍처 규칙(scripts/check/*는 scripts/relay/*
// 를 import할 수 없음, A3 inventory HYK-148) 때문에 한 파일로 합칠 수
// 없다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_CONTRACTS } from "./dispatch-arg-contract-registry.mjs";
import { runDispatchGateDecision } from "./dispatch-gate-decision.mjs";
import { writeLedger } from "./reject-streak.mjs";
import { runAdmissionCli } from "../supervisor/admission-cli.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const START_CONFIRM_CLI_PATH = join(
  THIS_DIR,
  "..",
  "supervisor",
  "dispatch-start-confirm-cli.mjs",
);

function withFixtureDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function contractOf(id) {
  const c = CLI_CONTRACTS.find((x) => x.id === id);
  assert.ok(c, `registry has no contract '${id}' -- test/registry drifted`);
  return c;
}

function requiredFlagsOf(cli) {
  // 이 파일은 대표 플래그 하나만 쓴다(anyOf 항목은 flags[0]).
  return cli.requiredArgs.map((r) => r.flags[0]);
}

// ---------------------------------------------------------------------------
// (A) dispatch-gate-decision.mjs
// ---------------------------------------------------------------------------
const GATE_CLI = contractOf("dispatch-gate-decision");

test("(A-hard) dispatch-gate-decision: positional task-path 빠지면 usage로 즉시 거부(allow:false)", () => {
  assert.equal(GATE_CLI.requiresPositionalArg, true);
  const result = runDispatchGateDecision([
    "--expect-repo-root",
    "C:\\anything",
    "--dispatch-receipt-path",
    "C:\\anything.jsonl",
  ]);
  assert.equal(result.allow, false);
  assert.match(result.lines[0], /usage:/);
});

test("(A-soft x3) dispatch-gate-decision: --expect-repo-root/--dispatch-receipt-path/--admission-ledger-path 셋 다 빠져도 ALLOW 기준선은 그대로다(§2-2 헛선언 증명)", () => {
  withFixtureDir("hyk319-gate-", (dir) => {
    const taskPath = join(dir, "coder-task.md");
    writeFileSync(
      taskPath,
      "task_id: HYK-9319-argcheck-1\nsome body\n" +
        "1b_exec_line: node scripts/check/dispatch-gate-decision.mjs <task-path>\n" +
        "1b_shown: ALLOW 또는 REJECT 한 줄과 사유\n" +
        "1b_reach_path: CLI 종료코드가 관제실 화면에 즉시 뜬다\n",
      "utf8",
    );
    const ledgerPath = join(dir, "reject-streak.json");
    writeLedger(ledgerPath, { schema_version: 1, issues: {} });

    // 기준선: 둘 다 없음 -> ALLOW (이 자체가 "필수라서 죽는다"는 주장과
    // 반대되는 관측 -- 그래서 hard:false다).
    const baseline = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
    ]);
    assert.equal(baseline.allow, true);

    // --dispatch-receipt-path를 (존재하지 않는 경로로) 추가해도 이 부트
    // 스트랩 픽스처(직전 라운드 결과 파일이 아예 없음)에서는 소비 확인
    // 축 자체가 관여하지 않아 결과가 바뀌지 않는다(evaluateConsumptionDecision
    // 이 결과 파일 부재 시 null을 반환하고 물러나는 실측 그대로).
    const withReceiptPath = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
      "--dispatch-receipt-path",
      join(dir, "no-such-receipts.jsonl"),
    ]);
    assert.equal(withReceiptPath.allow, true);

    // HYK-319-argcheck-2 (검토 1R P1 수리): --admission-ledger-path도
    // (존재하지 않는 경로로) 추가해도 결과가 바뀌지 않는다 -- 이
    // 부트스트랩 픽스처는 결과 파일 자체가 없어 harnessTaskLabel이
    // classifyTaskIdLabel에서 MISSING으로 분류되지 않는다(task_id: 줄이
    // 있는 taskPath 원문이 아니라 결과 파일 부재로 evaluateConsumptionDecision
    // 이 조기에 null을 반환 -- abort-record 축 자체가 진입하지 않는다).
    // 즉 이 인자도 CLI 프로세스 자체를 죽이지 않는다는 것을 같은 방식으로
    // 보여준다(abort-record 축이 실제로 REJECT_ABORT_RECORD_RECOVERY_MARKER_MISSING
    // 을 내는 시나리오는 abort record 후보 파일·영수증·원장까지 갖춘 훨씬
    // 무거운 픽스처가 필요해 이 라운드 범위에서는 구성하지 않았다 --
    // 레지스트리 note와 검토 P1 원문의 코드 인용이 그 인과를 이미 코드
    // 라인 단위로 증명한다).
    const withAdmissionLedgerPath = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
      "--admission-ledger-path",
      join(dir, "no-such-admission-ledger.json"),
    ]);
    assert.equal(withAdmissionLedgerPath.allow, true);

    // --expect-repo-root를 추가하면(이 tmpdir은 git 저장소가 아니므로)
    // «인자가 없어서 죽는» 것과는 다른 축(레포 결속 확인, HYK-220 2R)이
    // 걸려 오히려 REJECT로 뒤집힌다 -- 즉 이 인자의 부재가 실패 원인이
    // 아니라는 것을 정확히 보여준다(부재가 원인이면 "부재->OK, 존재->OK"
    // 여야 하는데 실측은 "부재->OK, 존재->REJECT(다른 사유)"다).
    const withExpectRepoRoot = runDispatchGateDecision([
      taskPath,
      "--ledger",
      ledgerPath,
      "--expect-repo-root",
      dir,
    ]);
    assert.equal(withExpectRepoRoot.allow, false);
    assert.match(
      withExpectRepoRoot.lines.join("\n"),
      /REJECT_LEDGER_PATH_UNRESOLVABLE|저장소를 식별하지 못함/,
    );
  });
});

// ---------------------------------------------------------------------------
// (B) admission-cli.mjs admit
// ---------------------------------------------------------------------------
const ADMISSION_HARD_FLAGS = ["--ledger", "--lock", "--reservation-id"]; // --cap-path는 anyOf라 별도 시험.
const ADMISSION_SOFT_FLAGS = ["--role", "--seat-key"];

function admissionBaselineArgs(ledger, lock) {
  return [
    "admit",
    "--ledger",
    ledger,
    "--lock",
    lock,
    "--reservation-id",
    "HYK-9319-argcheck-1",
    "--cap-path",
    // 실 concurrency-cap.json을 그대로 --cap-path로 넘긴다(관제실 실물과
    // 동일한 값의 출처 -- HYK-193 S-5, 하드코딩 금지 원칙을 시험에서도
    // 지킨다).
    join(THIS_DIR, "..", "supervisor", "concurrency-cap.json"),
    "--role",
    "CODER",
    "--seat-key",
    "seat-argcheck-1",
  ];
}

function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m) => lines.push(String(m));
  console.error = (m) => lines.push(String(m));
  try {
    return { exit: fn(), lines };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("(B-baseline) admission-cli admit: 필수 인자 전부 있으면(옵션 포함) init-cutover 뒤 exit 0", () => {
  withFixtureDir("hyk319-admit-", (dir) => {
    const ledger = join(dir, "ledger.json");
    const lock = join(dir, "ledger.lock");
    captureConsole(() =>
      runAdmissionCli([
        "init-cutover",
        "--ledger",
        ledger,
        "--lock",
        lock,
        "--live-seats",
        "[]",
      ]),
    );
    const { exit } = captureConsole(() =>
      runAdmissionCli(admissionBaselineArgs(ledger, lock)),
    );
    assert.equal(exit, 0);
  });
});

for (const flag of ADMISSION_HARD_FLAGS) {
  test(`(B-hard) admission-cli admit: --${flag.slice(2)} 빠지면 usage로 즉시 거부(exit 2)`, () => {
    withFixtureDir("hyk319-admit-", (dir) => {
      const ledger = join(dir, "ledger.json");
      const lock = join(dir, "ledger.lock");
      const full = admissionBaselineArgs(ledger, lock);
      const idx = full.indexOf(flag);
      const withoutFlag = [...full.slice(0, idx), ...full.slice(idx + 2)];
      const { exit, lines } = captureConsole(() =>
        runAdmissionCli(withoutFlag),
      );
      assert.equal(exit, 2, `flag=${flag} lines=${lines.join(" | ")}`);
    });
  });
}

test("(B-hard anyOf) admission-cli admit: --cap-path와 --cap 둘 다 없으면 usage로 즉시 거부(exit 2)", () => {
  withFixtureDir("hyk319-admit-", (dir) => {
    const ledger = join(dir, "ledger.json");
    const lock = join(dir, "ledger.lock");
    const full = admissionBaselineArgs(ledger, lock);
    const idx = full.indexOf("--cap-path");
    const withoutCap = [...full.slice(0, idx), ...full.slice(idx + 2)];
    const { exit } = captureConsole(() => runAdmissionCli(withoutCap));
    assert.equal(exit, 2);
  });
});

for (const flag of ADMISSION_SOFT_FLAGS) {
  test(`(B-soft) admission-cli admit: --${flag.slice(2)} 빠져도 exit 0 그대로(§2-2 헛선언 증명)`, () => {
    withFixtureDir("hyk319-admit-", (dir) => {
      const ledger = join(dir, "ledger.json");
      const lock = join(dir, "ledger.lock");
      captureConsole(() =>
        runAdmissionCli([
          "init-cutover",
          "--ledger",
          ledger,
          "--lock",
          lock,
          "--live-seats",
          "[]",
        ]),
      );
      const full = admissionBaselineArgs(ledger, lock);
      const idx = full.indexOf(flag);
      const withoutFlag = [...full.slice(0, idx), ...full.slice(idx + 2)];
      const { exit, lines } = captureConsole(() =>
        runAdmissionCli(withoutFlag),
      );
      assert.equal(exit, 0, `flag=${flag} lines=${lines.join(" | ")}`);
    });
  });
}

// ---------------------------------------------------------------------------
// (E) dispatch-start-confirm-cli.mjs -- 판정 로직(runDispatchStartConfirm)과
// 인자 존재 확인(usage)이 분리돼 있고 후자는 export되지 않는다(CLI
// 하단 invokedDirectly 블록 안에서만 검사) -- 그래서 이 CLI만 실제
// subprocess로 프로덕션 진입점을 그대로 구동한다(§2-2 "프로덕션 진입점
// 직접 구동" 문언 그대로).
// ---------------------------------------------------------------------------
const START_CONFIRM_CLI = contractOf("dispatch-start-confirm-cli");

function runStartConfirmCli(args) {
  try {
    const stdout = execFileSync("node", [START_CONFIRM_CLI_PATH, ...args], {
      encoding: "utf8",
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

function startConfirmBaselineArgs(dir) {
  return [
    "--repo-root",
    dir,
    "--dispatched-at-ms",
    "0",
    "--notify-dir",
    join(dir, "notify"),
    "--timeout-ms",
    "50",
    "--poll-interval-ms",
    "10",
  ];
}

test("(E-baseline) dispatch-start-confirm-cli: 필수 3개 전부 있으면 usage 오류 없이 판정 루프까지 도달한다(exit 1 NOT_STARTED, 짧은 타임아웃)", () => {
  withFixtureDir("hyk319-confirm-", (dir) => {
    const r = runStartConfirmCli(startConfirmBaselineArgs(dir));
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /usage:/);
  });
});

for (const flag of requiredFlagsOf(START_CONFIRM_CLI)) {
  test(`(E-hard) dispatch-start-confirm-cli: --${flag.slice(2)} 빠지면 usage로 즉시 거부(exit 2)`, () => {
    withFixtureDir("hyk319-confirm-", (dir) => {
      const full = startConfirmBaselineArgs(dir);
      const idx = full.indexOf(flag);
      const withoutFlag = [...full.slice(0, idx), ...full.slice(idx + 2)];
      const r = runStartConfirmCli(withoutFlag);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /usage:/);
    });
  });
}
