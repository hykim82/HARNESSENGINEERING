// HYK-439-launch-rules-1 (coder-task.md §2) -- tests for
// scripts/supervisor/worker-launch-rules.mjs: the repo file holding the
// foreground-runner launch rule (관제실 worker-dispatch-rule.md §6-c) as an
// engine-agnostic text block. Drives the real CLI as a child process
// (§2ⓓ, no 헛시험) in addition to the exported function, and exercises the
// four mutation-table rows (§2ⓕ) as in-memory negative controls --
// constructing a deliberately-wrong variant and showing the SAME assertion
// this file's own positive tests use goes RED against it (the established
// pattern in this repo, e.g. templates/harness-init/install-g1-adapter-
// list.test.mjs's "V1/V2 negative control" rows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_ROLES,
  KNOWN_ENGINES,
  LAUNCH_RULE_BODY,
  buildLaunchRuleBlock,
} from "./worker-launch-rules.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(HERE, "worker-launch-rules.mjs");

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" });
}

// §2ⓑ ⑴~⑹: 본문 필수 항목 6개가 모두 들어 있다. 각 단언은 그 항목의
// 의미를 특정하는 한국어 문구로 찾는다(숫자 동그라미가 아니라 실제 규칙
// 문구 -- 숫자만 지우는 변이를 잡지 못하는 헛시험을 피한다).
const REQUIRED_PHRASES = [
  [
    "⑴ Start-Process pwsh -WindowStyle Hidden -PassThru 로 띄우고 PID 출력",
    /Start-Process pwsh -WindowStyle Hidden -PassThru 로 띄우고, 그 호출은 PID 를 출력/,
  ],
  [
    "⑵ Wait-Process -Id <PID> -Timeout 540 반복",
    /Wait-Process -Id <PID> -Timeout 540 을 반복/,
  ],
  ["⑶ run_in_background 금지", /run_in_background/],
  ["⑶ 배경 폴링 루프 금지", /배경 폴링 루프/],
  ["⑶ & 백그라운드 잡 금지", /백그라운드 잡/],
  ["⑶ 배경 셸 안 Start-Process 금지", /배경 셸 안 Start-Process/],
  [
    "⑷ 로그·rc 파일은 워크트리 밖 고정 경로",
    /로그 파일과 rc\(종료코드\) 파일은 워크트리 «밖» 고정 경로/,
  ],
  [
    "⑸ 끊김 시 결과 파일 1줄(시각·PID·0B 영수증 여부), 흔적 삭제 금지",
    /끊긴 시각 · 끊긴 프로세스\(PID\) · 영수증이 0 B 인지 여부를 1줄로 적는다 -- 끊긴 흔적을 지우지 않는다/,
  ],
  [
    "⑹ 지시서·규칙이 다르면 지시서가 우선(지시서가 더 좁게 정할 수 있다)",
    /launch_rule 이 다르면 지시서가 우선한다\(지시서가 더 좁게 정할 수 있다\)/,
  ],
];

for (const [label, re] of REQUIRED_PHRASES) {
  test(`LAUNCH_RULE_BODY contains required item ${label}`, () => {
    assert.match(LAUNCH_RULE_BODY, re);
  });
}

// HYK-439-launch-rules-2 (coder-task.md §2ⓒ⑵): 6번의 옛 문장("지시서가 더
// 좁게 정한 쪽을 우선" -- "지시서가 넓게 정하면 규칙이 이긴다"로 오독되는
// 문장, H11 검토 1R P2-2)이 더 이상 본문에 없다.
test("LAUNCH_RULE_BODY no longer contains the old (misreadable) item ⑹ wording", () => {
  assert.doesNotMatch(LAUNCH_RULE_BODY, /지시서가 더 좁게 정한 쪽을 우선/);
});

// §2ⓑ 가변값 0: 본문에 관제실 절대경로(D:\ 또는 C:\Users 로 시작하는
// 드라이브 경로)나 ISO 날짜가 들어 있지 않다.
test("LAUNCH_RULE_BODY contains no control-room absolute path or ISO date literal (no variable values)", () => {
  assert.doesNotMatch(LAUNCH_RULE_BODY, /[A-Za-z]:\\/);
  assert.doesNotMatch(LAUNCH_RULE_BODY, /\d{4}-\d{2}-\d{2}/);
});

// §2ⓒ 엔진 무관 증명: 같은 역할이면 claude·codex 출력이 바이트 동일.
for (const role of KNOWN_ROLES) {
  test(`buildLaunchRuleBlock({role: "${role}"}) is byte-identical across engines (claude vs codex)`, () => {
    const claude = buildLaunchRuleBlock({ role, engine: "claude" });
    const codex = buildLaunchRuleBlock({ role, engine: "codex" });
    assert.equal(claude, codex);
  });
}

// 역할이 다르면 머리줄만 다르고, 그 아래 본문은 여전히 같다.
test("buildLaunchRuleBlock body (everything after the first line) is identical across different roles", () => {
  const a = buildLaunchRuleBlock({ role: "CODER", engine: "claude" });
  const b = buildLaunchRuleBlock({ role: "REVIEW", engine: "codex" });
  const bodyOf = (s) => s.slice(s.indexOf("\n") + 1);
  assert.equal(bodyOf(a), bodyOf(b));
  assert.notEqual(a, b, "head line must still differ by role");
});

// 결정성: 같은 인자로 두 번 호출해도 바이트 단위로 같다 (§2ⓒ).
test("buildLaunchRuleBlock is deterministic: two calls with the same args produce byte-identical output (same sha256)", () => {
  const first = buildLaunchRuleBlock({ role: "CODER", engine: "claude" });
  const second = buildLaunchRuleBlock({ role: "CODER", engine: "claude" });
  assert.equal(first, second);
  assert.equal(sha256(first), sha256(second));
});

test("buildLaunchRuleBlock throws on an unknown role", () => {
  assert.throws(
    () => buildLaunchRuleBlock({ role: "NOT_A_ROLE", engine: "claude" }),
    /unknown role/,
  );
});

test("buildLaunchRuleBlock throws on an unknown engine", () => {
  assert.throws(
    () => buildLaunchRuleBlock({ role: "CODER", engine: "not-an-engine" }),
    /unknown engine/,
  );
});

// §2ⓓ 프로덕션 진입점 시험: export 함수가 아니라 실제 CLI 를 자식
// 프로세스로 실행해 출력을 단언한다 -- 함수 호출만으로는 argv 파싱·
// process.exit 경로가 전혀 검증되지 않는다.
for (const engine of KNOWN_ENGINES) {
  test(`real CLI child process: --role CODER --engine ${engine} prints exactly buildLaunchRuleBlock's output, exit 0`, () => {
    const out = execFileSync(
      process.execPath,
      [CLI_PATH, "--role", "CODER", "--engine", engine],
      { encoding: "utf8" },
    );
    assert.equal(out, buildLaunchRuleBlock({ role: "CODER", engine }));
  });
}

test("real CLI child process: claude and codex stdout are byte-identical for the same role (engine-agnostic proof, §2ⓒ)", () => {
  const claudeOut = execFileSync(
    process.execPath,
    [CLI_PATH, "--role", "REVIEW", "--engine", "claude"],
    { encoding: "utf8" },
  );
  const codexOut = execFileSync(
    process.execPath,
    [CLI_PATH, "--role", "REVIEW", "--engine", "codex"],
    { encoding: "utf8" },
  );
  assert.equal(claudeOut, codexOut);
  assert.equal(sha256(claudeOut), sha256(codexOut));
});

test("real CLI child process invoked twice with identical args produces identical stdout (determinism, sha256 equal)", () => {
  const out1 = execFileSync(
    process.execPath,
    [CLI_PATH, "--role", "CODER", "--engine", "claude"],
    { encoding: "utf8" },
  );
  const out2 = execFileSync(
    process.execPath,
    [CLI_PATH, "--role", "CODER", "--engine", "claude"],
    { encoding: "utf8" },
  );
  assert.equal(sha256(out1), sha256(out2));
});

test("real CLI child process: unknown --role exits non-zero and writes nothing useful to stdout", () => {
  const result = runCli(["--role", "NOT_A_ROLE", "--engine", "claude"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("real CLI child process: unknown --engine exits non-zero", () => {
  const result = runCli(["--role", "CODER", "--engine", "not-an-engine"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("real CLI child process: unknown flag exits non-zero (usage error)", () => {
  const result = runCli(["--role", "CODER", "--engine", "claude", "--bogus"]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("real CLI child process: missing --role exits non-zero", () => {
  const result = runCli(["--engine", "claude"]);
  assert.notEqual(result.status, 0);
});

test("real CLI child process: missing --engine exits non-zero", () => {
  const result = runCli(["--role", "CODER"]);
  assert.notEqual(result.status, 0);
});

// -----------------------------------------------------------------------
// §2ⓕ 변이 표 -- 4행, 실제 제자리 소스 변이(sha256 선기록 -> 변이 -> 단독
// 시험 -> 바이트 복원 -> sha256 재확인)는 코더 결과 파일(.harness/coder.md)
// §2 변이 표 절에 실측 기록으로 남긴다(evidence_rule). 아래 네 시험은 그와
// 별개로, 같은 네 변이를 "실제 production 문자열의 in-memory 사본"에 적용해
// 이 테스트 파일 자신의 양성 단언이 그 사본에 대해서는 RED(실패)가 됨을
// 상시 자동 회귀망으로 고정한다 -- install-g1-adapter-list.test.mjs의
// "V1/V2 negative control" 행과 같은 패턴.
// -----------------------------------------------------------------------

test("mutation guard ⑴: deleting the ⑶ forbidden-launch-mode line from the body makes the forbidden-phrase assertions fail", () => {
  const mutatedBody = LAUNCH_RULE_BODY.split("\n")
    .filter((line) => !line.includes("run_in_background"))
    .join("\n");
  assert.doesNotMatch(mutatedBody, /run_in_background/);
  assert.doesNotMatch(mutatedBody, /배경 폴링 루프/);
  assert.doesNotMatch(mutatedBody, /배경 셸 안 Start-Process/);
  // production 본문 자신은 여전히 멀쩡하다(대조).
  assert.match(LAUNCH_RULE_BODY, /run_in_background/);
});

test("mutation guard ⑵: a hypothetical engine-branching variant of buildLaunchRuleBlock (codex body differs) fails the engine-agnostic equality assertion this file's own positive test relies on", () => {
  function brokenBuildLaunchRuleBlock({ role, engine }) {
    const body =
      engine === "codex"
        ? LAUNCH_RULE_BODY + "\n(codex-only line)"
        : LAUNCH_RULE_BODY;
    return `[worker-launch-rules] role=${role}\n${body}\n`;
  }
  const claude = brokenBuildLaunchRuleBlock({
    role: "CODER",
    engine: "claude",
  });
  const codex = brokenBuildLaunchRuleBlock({ role: "CODER", engine: "codex" });
  assert.notEqual(
    claude,
    codex,
    "the broken variant must actually branch by engine for this control to mean anything",
  );
  // 실제 production 함수는 branching 하지 않으므로 여전히 같다(대조).
  assert.equal(
    buildLaunchRuleBlock({ role: "CODER", engine: "claude" }),
    buildLaunchRuleBlock({ role: "CODER", engine: "codex" }),
  );
});

test("mutation guard ⑶: a CLI that prints an empty block instead of the real one fails the non-empty/equality assertion the real-CLI tests rely on", () => {
  const brokenOutput = "";
  assert.notEqual(
    brokenOutput,
    buildLaunchRuleBlock({ role: "CODER", engine: "claude" }),
  );
  assert.equal(brokenOutput.length, 0);
  // 실제 CLI는 빈 출력을 내지 않는다(대조, 자식 프로세스 실측).
  const realOut = execFileSync(
    process.execPath,
    [CLI_PATH, "--role", "CODER", "--engine", "claude"],
    { encoding: "utf8" },
  );
  assert.ok(realOut.length > 0);
});

test("mutation guard ⑷: a CLI that exits 0 for an unknown role fails the non-zero-exit assertion the real-CLI tests rely on", () => {
  const brokenExitCodeForUnknownRole = 0;
  assert.throws(
    () => assert.notEqual(brokenExitCodeForUnknownRole, 0),
    /AssertionError/,
    "a broken CLI that exits 0 for an unknown role must make the real test's notEqual(status, 0) assertion throw",
  );
  // 실제 CLI는 0이 아닌 종료코드를 낸다(대조, 자식 프로세스 실측).
  const real = runCli(["--role", "NOT_A_ROLE", "--engine", "claude"]);
  assert.notEqual(real.status, 0);
});
