// HYK-400 1R -- 수신부(대상 워크트리의 dispatch-receipt-cli.mjs) 능력 확인기
// 시험. coder-task.md Q3 표본표 4종 + Q4 되돌림 변이를 그대로 덮는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReceiptCliFlagSupport } from "./hyk400-receiver-guard.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./hyk400-receiver-guard.mjs", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const UNSUPPORTED_FIXTURE = fileURLToPath(
  new URL(
    "./fixtures/hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt",
    import.meta.url,
  ),
);

function seedUnsupportedReceiptCli(worktree) {
  const relayDir = join(worktree, "scripts/relay");
  mkdirSync(relayDir, { recursive: true });
  const dest = join(relayDir, "dispatch-receipt-cli.mjs");
  copyFileSync(UNSUPPORTED_FIXTURE, dest);
  return dest;
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
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

// ⓐ 지원 워크트리 -> 통과
test("Q3-a: --harness-dir를 아는 워크트리(이 저장소 자신)는 supported:true", async () => {
  const result = await checkReceiptCliFlagSupport({
    worktree: REPO_ROOT,
    flag: "--harness-dir",
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
});

test("Q3-a CLI: 지원 워크트리 -> exit 0 + SUPPORTED", () => {
  const { status, stdout } = runCli([
    "--worktree",
    REPO_ROOT,
    "--flag",
    "--harness-dir",
  ]);
  assert.equal(status, 0);
  assert.match(stdout, /^SUPPORTED flag=--harness-dir/);
});

// ⓑ 미지원 워크트리 -> 거부 + 사유 문구에 "무엇이 없는지"가 나온다
test("Q3-b: HYK-396 이전 CLI를 심은 워크트리는 supported:false, 사유에 플래그 이름이 나온다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-unsupported-"));
  try {
    seedUnsupportedReceiptCli(dir);
    const result = await checkReceiptCliFlagSupport({
      worktree: dir,
      flag: "--harness-dir",
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(result.supported, false);
    assert.match(result.reason, /unrecognized flag '--harness-dir'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q3-b CLI: 미지원 워크트리 -> exit 0이 아니고, 사유에 플래그 이름이 나온다", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-cli-test-"));
  try {
    seedUnsupportedReceiptCli(dir);
    const { status, stderr } = runCli([
      "--worktree",
      dir,
      "--flag",
      "--harness-dir",
    ]);
    assert.notEqual(status, 0);
    assert.match(stderr, /REJECTED/);
    assert.match(stderr, /unrecognized flag '--harness-dir'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ⓒ 확인 자체가 실패(파일 없음·읽기 실패) -> 거부
test("Q3-c: 수신부 CLI 파일 자체가 없으면 supported:false, RECEIVER_CLI_MISSING", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-missing-"));
  try {
    const result = await checkReceiptCliFlagSupport({
      worktree: dir,
      flag: "--harness-dir",
    });
    assert.equal(result.ok, false);
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q3-c: 수신부 CLI가 있지만 import에 실패하면(구문 오류) supported:false, RECEIVER_CLI_IMPORT_FAILED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-broken-"));
  try {
    const relayDir = join(dir, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "this is not valid javascript {{{",
      "utf8",
    );
    const result = await checkReceiptCliFlagSupport({
      worktree: dir,
      flag: "--harness-dir",
    });
    assert.equal(result.ok, false);
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_IMPORT_FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q3-c: parseDispatchReceiptArgs export가 없는 파일은 RECEIVER_CLI_CONTRACT_MISSING", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-nocontract-"));
  try {
    const relayDir = join(dir, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "export const somethingElse = 1;\n",
      "utf8",
    );
    const result = await checkReceiptCliFlagSupport({
      worktree: dir,
      flag: "--harness-dir",
    });
    assert.equal(result.ok, false);
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_CONTRACT_MISSING/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Q3-c CLI: worktree 인자가 없으면 usage + exit 1(부작용 없이 거부)", () => {
  const { status, stderr } = runCli(["--flag", "--harness-dir"]);
  assert.notEqual(status, 0);
  assert.match(stderr, /usage:/);
});

// ⓓ 인자 없는 배달(그 기능을 안 쓰는 경우) -> 통과(회귀 0)
test("Q3-d: flag를 요구하지 않는 호출은 워크트리가 없어도/틀려도 무조건 통과", async () => {
  const result = await checkReceiptCliFlagSupport({
    worktree: "/this/path/does/not/exist/at/all",
    flag: undefined,
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
  assert.equal(result.reason, "NO_FLAG_REQUESTED");
});

// Q4 되돌림 변이 -- 가드가 없다면(=이 확인기를 거치지 않고 곧바로 수신부
// CLI를 불렀다면) ⓑ가 오늘 실사고 그대로의 옛 오류로 깨졌을 것임을 실측
// 재현한다. 이 호출은 부작용이 없다 -- classifyFlag가 인자 파싱 단계에서
// 즉시 실패해(unrecognized flag) appendFileSync에 도달하기 전에
// runDispatchReceiptCli가 반환한다(dispatch-receipt-cli.mjs 소스 확인:
// parseDispatchReceiptArgs 실패 시 extractDispatchEnvelope/
// appendReceiptLine 모두 호출되지 않는다).
test("Q4: 가드 없이 미지원 CLI를 직접 부르면 오늘 실사고와 같은 문구로 깨진다", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-q4-"));
  try {
    const cliPath = seedUnsupportedReceiptCli(dir);
    const { status, stdout } = (() => {
      try {
        const out = execFileSync(
          "node",
          [
            cliPath,
            "--role",
            "CODER",
            "--task-label",
            "hyk400-q4-probe",
            "--receipt-path",
            join(dir, "receipt.jsonl"),
            "--harness-dir",
            join(dir, ".harness"),
          ],
          { input: "{}", encoding: "utf8" },
        );
        return { status: 0, stdout: out };
      } catch (err) {
        return { status: err.status, stdout: err.stdout ?? "" };
      }
    })();
    assert.notEqual(status, 0);
    assert.equal(
      stdout.trim(),
      "FAILED reason=unrecognized flag '--harness-dir'",
    );
    // 부작용 없음 확인 -- 영수증 파일이 만들어지지 않았어야 한다.
    assert.throws(() => readFileSync(join(dir, "receipt.jsonl"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Q4 복원 확인 -- 가드가 있으면 같은 미지원 워크트리를 배달 «전»에 거부해,
// 위 옛 오류(RECEIPT_FAILED)까지 가지 않는다(더 이른 지점에서, 더 명확한
// 사유로 멈춘다).
test("Q4 복원: 가드는 같은 미지원 워크트리를 배달 전에 먼저 거부한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyk400-receiver-guard-restore-"));
  try {
    seedUnsupportedReceiptCli(dir);
    const result = await checkReceiptCliFlagSupport({
      worktree: dir,
      flag: "--harness-dir",
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /unrecognized flag '--harness-dir'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
