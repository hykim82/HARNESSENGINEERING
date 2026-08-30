// HYK-400 2R -- 수신부 능력 확인기 시험. 1R 검토 반려(P1-1/P1-2/P1-3/P2)가
// 잡은 세 축(격리·의미·경계)과 "검사 대상을 호출자가 고르지 못하게"(I4)를
// 전부 적대 표본 + 되돌림 변이로 재확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkReceiptCliFlagSupport,
  deriveOptionalFlags,
  resolveVerifiedTargetPath,
} from "./hyk400-receiver-guard.mjs";

const GUARD_PATH = fileURLToPath(
  new URL("./hyk400-receiver-guard.mjs", import.meta.url),
);
const RUNNER_PATH = fileURLToPath(
  new URL("./hyk400-receiver-probe-runner.mjs", import.meta.url),
);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

const REAL_DELIVERY_ARGS = [
  "--role",
  "CODER",
  "--task-label",
  "hyk400-real-label",
  "--receipt-path",
  "hyk400-real-receipt-path",
  "--harness-dir",
  "hyk400-real-harness-dir",
];

function seedReceiptCli(worktree, fixtureName) {
  const relayDir = join(worktree, "scripts/relay");
  mkdirSync(relayDir, { recursive: true });
  const dest = join(relayDir, "dispatch-receipt-cli.mjs");
  copyFileSync(join(FIXTURES_DIR, fixtureName), dest);
  return dest;
}

function tmpWorktree(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [GUARD_PATH, ...args], {
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

function deliveryArgsFor(worktree) {
  return [
    "--role",
    "CODER",
    "--task-label",
    "probe-label",
    "--receipt-path",
    join(worktree, "receipt.jsonl"),
    "--harness-dir",
    join(worktree, ".harness"),
  ];
}

// ============================================================
// I4 -- 검사 대상 플래그는 호출자가 고르지 않는다(실제 배달 인자에서 유도)
// ============================================================

test("I4: 실제 ps1 delivery 리터럴을 그대로 넣으면 --harness-dir 하나만 유도된다(오늘 현실을 고정)", () => {
  const result = deriveOptionalFlags(REAL_DELIVERY_ARGS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.flags, ["--harness-dir"]);
});

test("I4: deliveryArgs가 비어 있으면(캡션 생략) 조용히 통과하지 않고 거부한다", () => {
  const result = deriveOptionalFlags([]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

test("I4: deliveryArgs가 undefined면(안 넘김) 거부한다 -- 1R의 opt-out 구멍 삭제 확인", () => {
  const result = deriveOptionalFlags(undefined);
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

test("I4: 필수 3필드가 없는 배열은 '진짜 배달 인자'로 보지 않고 거부한다", () => {
  const result = deriveOptionalFlags(["--harness-dir", "x"]);
  assert.equal(result.ok, false);
  assert.match(result.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

test("I4: 필수 3필드만 있고 선택 플래그가 없으면(진짜 배달 인자) 검사 대상 0개로 유도된다", async () => {
  const args = ["--role", "R", "--task-label", "L", "--receipt-path", "P"];
  const derived = deriveOptionalFlags(args);
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.flags, []);

  const result = await checkReceiptCliFlagSupport({
    worktree: "/this/path/does/not/exist/at/all",
    deliveryArgs: args,
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
  assert.equal(result.reason, "NO_OPTIONAL_FLAGS_IN_DELIVERY");
});

test("I4 되돌림: 0-flags 통과는 '구조적으로 유도된 사실'이지 '캡션 생략'이 아니다 -- 진짜 배달 인자가 아니면 여전히 거부됨을 대조", async () => {
  const emptyResult = await checkReceiptCliFlagSupport({
    worktree: REPO_ROOT,
    deliveryArgs: [],
  });
  assert.equal(
    emptyResult.ok,
    false,
    "빈 배열은 여전히 거부(RED가 아니어야 함)",
  );
  assert.match(emptyResult.reason, /RECEIVER_GUARD_BAD_INPUT/);
});

// ============================================================
// I3 -- 경계: realpath가 워크트리 밖을 가리키면 거부
// ============================================================

test("I3: 심링크가 다른 저장소를 가리키면 거부된다(RECEIVER_CLI_BOUNDARY_ESCAPE)", () => {
  const worktree = tmpWorktree("hyk400-boundary-worktree-");
  const outside = tmpWorktree("hyk400-boundary-outside-");
  try {
    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    const outsideFile = join(outside, "evil-receipt-cli.mjs");
    copyFileSync(
      join(FIXTURES_DIR, "hyk400-hostile-different-meaning.mjs.txt"),
      outsideFile,
    );
    symlinkSync(
      outsideFile,
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "file",
    );

    const resolved = resolveVerifiedTargetPath({ worktree });
    assert.equal(resolved.ok, false);
    assert.match(resolved.reason, /RECEIVER_CLI_BOUNDARY_ESCAPE/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("I3 되돌림: 경계 검사를 끄면 같은 심링크가 통과해 버린다(RED) -- 원본 소스는 손대지 않는다", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    "if (targetReal !== worktreeReal && !targetReal.startsWith(boundary)) {\n    return rejected(\n      `RECEIVER_CLI_BOUNDARY_ESCAPE: ${candidatePath} 가 워크트리 경계 밖(${targetReal})을 가리킨다(심링크/다른 저장소/경로 탈출 의심)`,\n    );\n  }";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(anchor, "/* I3 mutated off */");
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i3-mutant-");
  const worktree = tmpWorktree("hyk400-i3-boundary-worktree-");
  const outside = tmpWorktree("hyk400-i3-boundary-outside-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );

    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    // 밖을 가리키는 대상은 --harness-dir을 «정말로» 지원하는(=이 저장소 실물)
    // 파일이어야 한다 -- 경계 검사가 살아 있을 때 거부의 원인이 "경계"뿐임을
    // 확실히 하기 위해서다(의미 검사까지 우연히 걸려 RED가 안 나오는 것을 방지).
    const outsideFile = join(outside, "real-receipt-cli.mjs");
    copyFileSync(
      join(REPO_ROOT, "scripts/relay/dispatch-receipt-cli.mjs"),
      outsideFile,
    );
    symlinkSync(
      outsideFile,
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "file",
    );

    // I1(--allow-fs-read이 worktreeReal로 스코프됨)이 이 축과 별개로
    // "경계 밖 파일을 읽지도 못하게" 이미 막는다(의도된 이중 방어) --
    // 그래서 이 변이는 전체 파이프라인이 아니라 I3를 «직접» 구현하는
    // resolveVerifiedTargetPath 단위에서 확인한다(I1의 방어가 신호를
    // 가리는 것을 피하기 위해).
    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const resolved = mutatedGuard.resolveVerifiedTargetPath({ worktree });
    assert.equal(
      resolved.ok,
      true,
      "I3 변이 후에는 경계 탈출 대상의 realpath 검사가 통과해 버린다(RED, 경계 검사가 실제로 이 축을 막고 있었다는 증거)",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(
      afterGuardSrc,
      originalGuardSrc,
      "원본 hyk400-receiver-guard.mjs 바이트가 변형된 채로 남았다",
    );
    assert.equal(
      afterRunnerSrc,
      originalRunnerSrc,
      "원본 hyk400-receiver-probe-runner.mjs 바이트가 변형된 채로 남았다",
    );
  }
});

// ============================================================
// I1 -- 격리: 대상 코드는 이 프로세스 안에서 절대 실행되지 않는다
// ============================================================

test("ⓐ 최상위에서 파일을 쓰는 수신부: 거부되고 실제로 파일이 안 생긴다", async () => {
  const worktree = tmpWorktree("hyk400-hostile-write-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-write.mjs.txt");
    const proofPath = join(worktree, "hyk400-hostile-write-proof.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_IMPORT_FAILED/);
    assert.throws(
      () => readFileSync(proofPath, "utf8"),
      "적대 표본이 실제로 파일을 만들었다 -- 격리 실패",
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓐ 되돌림: --permission 격리를 끄면 같은 대상이 실제로 파일을 쓴다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    '["--permission", `--allow-fs-read=${worktreeReal}`, RUNNER_PATH, payload],';
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    "[RUNNER_PATH, payload], // I1 mutated off (no --permission)",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i1-mutant-");
  const worktree = tmpWorktree("hyk400-i1-write-worktree-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedReceiptCli(worktree, "hyk400-hostile-write.mjs.txt");
    const proofPath = join(worktree, "hyk400-hostile-write-proof.txt");

    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    await mutatedGuard.checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });

    assert.doesNotThrow(
      () => readFileSync(proofPath, "utf8"),
      "I1(--permission) 변이 후에는 적대 파일이 실제로 써진다(RED, 격리가 실제로 이 축을 막고 있었다는 증거)",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(afterGuardSrc, originalGuardSrc);
    assert.equal(afterRunnerSrc, originalRunnerSrc);
  }
});

test("ⓑ 무한 top-level await(이벤트 루프를 살려 둔 채): 제한시간 안에 거부된다", async () => {
  const worktree = tmpWorktree("hyk400-hostile-hang-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-hang.mjs.txt");
    const startedAt = Date.now();
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      timeoutMs: 800,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_PROBE_TIMEOUT/);
    assert.ok(
      elapsedMs < 5000,
      `타임아웃이 제한시간(800ms) 근처에서 걸려야 하는데 ${elapsedMs}ms 걸렸다`,
    );
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

async function assertAbnormalExitRejected(fixtureName, label) {
  const worktree = tmpWorktree(`hyk400-${label}-worktree-`);
  try {
    seedReceiptCli(worktree, fixtureName);
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(
      result.ok,
      false,
      `${label}: 비정상 child는 ok:false여야 한다`,
    );
    assert.equal(
      result.supported,
      false,
      `${label}: 비정상 child가 supported:true가 되면 안 된다`,
    );
    assert.match(result.reason, /RECEIVER_CLI_PROBE_CRASHED/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

test("ⓐ I1′: 정상 JSON 출력 후 SIGTERM 자살은 stdout과 무관하게 거부된다", async () => {
  await assertAbnormalExitRejected(
    "hyk400-hostile-output-sigterm.mjs.txt",
    "output-sigterm",
  );
});

test("ⓑ I1′: 정상 JSON 출력 후 process.exitCode=1은 stdout과 무관하게 거부된다", async () => {
  await assertAbnormalExitRejected(
    "hyk400-hostile-output-exitcode.mjs.txt",
    "output-exitcode",
  );
});

test("ⓒ I1′: 정상 JSON 출력 후 process.exit(3)은 stdout과 무관하게 거부된다", async () => {
  await assertAbnormalExitRejected(
    "hyk400-hostile-output-exit3.mjs.txt",
    "output-exit3",
  );
});

test("I1′ 되돌림: 종료 상태 검사를 끄면 ⓐⓑⓒ가 다시 통과하고 원본 바이트는 복원된다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
  const crashRejectStart = originalGuardSrc.indexOf(
    "    return rejected(\n      `RECEIVER_CLI_PROBE_CRASHED:",
  );
  assert.notEqual(
    crashRejectStart,
    -1,
    "I1′ mutation anchor not found -- guard source drifted",
  );
  const crashRejectEndMarker = "\n    );";
  const crashRejectEnd = originalGuardSrc.indexOf(
    crashRejectEndMarker,
    crashRejectStart,
  );
  assert.ok(
    crashRejectEnd > crashRejectStart,
    "I1′ mutation anchor not found -- guard source drifted",
  );
  const crashRejectAnchor = originalGuardSrc.slice(
    crashRejectStart,
    crashRejectEnd + crashRejectEndMarker.length,
  );
  const mutatedSrc = originalGuardSrc.replace(
    crashRejectAnchor,
    [
      "    stdout = err.stdout;",
      "    if (!isNonEmptyString(stdout)) {",
      '      return rejected("RECEIVER_CLI_PROBE_CRASHED: mutated status check");',
      "    }",
    ].join("\n"),
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i1-status-mutant-");
  const specimens = [
    ["hyk400-hostile-output-sigterm.mjs.txt", "SIGTERM"],
    ["hyk400-hostile-output-exitcode.mjs.txt", "exitCode=1"],
    ["hyk400-hostile-output-exit3.mjs.txt", "exit(3)"],
  ];
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    for (const [fixtureName, label] of specimens) {
      const worktree = tmpWorktree(`hyk400-i1-status-${label}-`);
      try {
        seedReceiptCli(worktree, fixtureName);
        const result = await mutatedGuard.checkReceiptCliFlagSupport({
          worktree,
          deliveryArgs: deliveryArgsFor(worktree),
        });
        assert.equal(
          result.supported,
          true,
          `${label}: 종료 상태 검사를 끄면 유효 stdout 때문에 다시 통과해야 RED다`,
        );
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    assert.equal(
      readFileSync(GUARD_PATH, "utf8"),
      originalGuardSrc,
      "원본 guard 바이트가 변형된 채로 남았다",
    );
    assert.equal(
      readFileSync(RUNNER_PATH, "utf8"),
      originalRunnerSrc,
      "원본 runner 바이트가 변형된 채로 남았다",
    );
  }
});

test("ⓑ 되돌림: 격리 프로세스 실패(타임아웃 포함)를 거부가 아니라 '건너뛰기'로 바꾸면(제한시간 자체는 여전히 작동) RED가 된다", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  // runIsolatedProbe 자신의 타임아웃 감지(SIGKILL/ETIMEDOUT)는 그대로 두고
  // (제한시간이 실제로 프로세스를 죽이는 능력은 이 변이가 끄지 않는다),
  // 그 실패를 최종 판정에 반영하는 «호출부»만 무력화한다 -- probe가 실패해도
  // continue로 넘어가 마지막에 supported:true로 떨어지게 만든다. 이렇게
  // 해야 "타임아웃이 실제로 걸렸다"와 "그 실패를 거부로 연결한다"를 각각
  // 별도로 확인할 수 있다(앞 시험이 전자, 이 시험이 후자).
  const anchor =
    "    if (!probe.ok) {\n      return { ...probe, checkedFlags: derived.flags, failedFlag: flag };\n    }";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    "    if (!probe.ok) {\n      continue; // I1 probe-failure handling mutated off\n    }",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i1-timeout-mutant-");
  const worktree = tmpWorktree("hyk400-i1-hang-worktree-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedReceiptCli(worktree, "hyk400-hostile-hang.mjs.txt");

    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const result = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
      timeoutMs: 800,
    });
    assert.equal(
      result.supported,
      true,
      "I1 타임아웃 판정 변이 후에는 무한 대기 대상이 supported:true로 새 버린다(RED)",
    );
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(afterGuardSrc, originalGuardSrc);
    assert.equal(afterRunnerSrc, originalRunnerSrc);
  }
});

// ============================================================
// I2 -- 의미: 파싱 성공이 아니라 값이 실제로 반영됐는지 본다
// ============================================================

test("ⓒ 다른 의미로 처리하는 수신부(값을 고정 상수로 치환): 거부되고 사유가 SEMANTIC_MISMATCH다", async () => {
  const worktree = tmpWorktree("hyk400-different-meaning-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-different-meaning.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓔ 문자열만 언급하고 실제로는 무시하는 수신부: 거부되고 사유가 SEMANTIC_MISMATCH다(정적 텍스트 검사였다면 오탐했을 표본)", async () => {
  const worktree = tmpWorktree("hyk400-string-mention-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-hostile-string-mention.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_SEMANTIC_MISMATCH/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓒ/ⓔ 되돌림: 의미 대조를 끄면(sentinel 확인 없이 ok:true만 보면) 두 표본 다 supported:true로 새 버린다(RED)", async () => {
  const originalGuardSrc = readFileSync(GUARD_PATH, "utf8");
  const originalRunnerSrc = readFileSync(RUNNER_PATH, "utf8");

  const anchor =
    "  if (!responseCarriesSentinel(baseline, withFlag, sentinel)) {\n    return {\n      ok: true,\n      supported: false,\n      reason: `RECEIVER_CLI_SEMANTIC_MISMATCH: '${flag}'가 파싱은 되지만(ok:true) 넘긴 값이 응답 어디에도 반영되지 않았다(다른 의미로 처리하거나 값을 버리는 것으로 의심)`,\n    };\n  }\n  return { ok: true, supported: true, reason: null };";
  assert.ok(
    originalGuardSrc.includes(anchor),
    "mutation anchor not found -- guard source drifted",
  );
  const mutatedSrc = originalGuardSrc.replace(
    anchor,
    "  return { ok: true, supported: true, reason: null }; // I2 mutated off",
  );
  assert.notEqual(mutatedSrc, originalGuardSrc);

  const mutDir = tmpWorktree("hyk400-i2-mutant-");
  const worktreeC = tmpWorktree("hyk400-i2-c-worktree-");
  const worktreeE = tmpWorktree("hyk400-i2-e-worktree-");
  try {
    writeFileSync(join(mutDir, "hyk400-receiver-guard.mjs"), mutatedSrc);
    writeFileSync(
      join(mutDir, "hyk400-receiver-probe-runner.mjs"),
      originalRunnerSrc,
    );
    seedReceiptCli(worktreeC, "hyk400-hostile-different-meaning.mjs.txt");
    seedReceiptCli(worktreeE, "hyk400-hostile-string-mention.mjs.txt");

    const mutatedGuard = await import(
      pathToFileURL(join(mutDir, "hyk400-receiver-guard.mjs")).href
    );
    const resultC = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree: worktreeC,
      deliveryArgs: deliveryArgsFor(worktreeC),
    });
    const resultE = await mutatedGuard.checkReceiptCliFlagSupport({
      worktree: worktreeE,
      deliveryArgs: deliveryArgsFor(worktreeE),
    });
    assert.equal(resultC.supported, true, "ⓒ가 I2 변이 후 새 버려야 한다(RED)");
    assert.equal(resultE.supported, true, "ⓔ가 I2 변이 후 새 버려야 한다(RED)");
  } finally {
    rmSync(mutDir, { recursive: true, force: true });
    rmSync(worktreeC, { recursive: true, force: true });
    rmSync(worktreeE, { recursive: true, force: true });
    const afterGuardSrc = readFileSync(GUARD_PATH, "utf8");
    const afterRunnerSrc = readFileSync(RUNNER_PATH, "utf8");
    assert.equal(afterGuardSrc, originalGuardSrc);
    assert.equal(afterRunnerSrc, originalRunnerSrc);
  }
});

// ============================================================
// ⓕ 확인 자체가 실패(구문 오류·export 부재·파일 부재) -- 거부
// ============================================================

test("ⓕ 수신부 CLI 파일 자체가 없으면 거부(RECEIVER_CLI_MISSING)", async () => {
  const worktree = tmpWorktree("hyk400-missing-worktree-");
  try {
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_MISSING/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓕ 구문 오류가 있는 수신부는 거부(RECEIVER_CLI_IMPORT_FAILED) -- 격리 프로세스 안에서 잡힌다", async () => {
  const worktree = tmpWorktree("hyk400-syntax-error-worktree-");
  try {
    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "this is not valid javascript {{{",
      "utf8",
    );
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_IMPORT_FAILED/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("ⓕ parseDispatchReceiptArgs export가 없는 수신부는 거부(RECEIVER_CLI_CONTRACT_MISSING)", async () => {
  const worktree = tmpWorktree("hyk400-nocontract-worktree-");
  try {
    const relayDir = join(worktree, "scripts/relay");
    mkdirSync(relayDir, { recursive: true });
    writeFileSync(
      join(relayDir, "dispatch-receipt-cli.mjs"),
      "export const somethingElse = 1;\n",
      "utf8",
    );
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.supported, false);
    assert.match(result.reason, /RECEIVER_CLI_CONTRACT_MISSING/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

// ============================================================
// ⓖ 가드 CLI 자체 부재 -- I5 실측 코드(ps1 exit 10 도달 가능성)
// ============================================================

test("ⓖ/I5: Write-Error 뒤 exit N은 $ErrorActionPreference=Stop 아래서 도달 불가하다(1R 반려 사유 재현)", () => {
  const dir = tmpWorktree("hyk400-i5-deadcode-");
  try {
    const script = join(dir, "deadcode.ps1");
    writeFileSync(
      script,
      [
        '$ErrorActionPreference = "Stop"',
        'Write-Error "SOME ERROR"',
        "exit 10",
      ].join("\n"),
      "utf8",
    );
    let status;
    try {
      execFileSync("pwsh", ["-File", script], { stdio: "pipe" });
      status = 0;
    } catch (err) {
      status = err.status;
    }
    assert.equal(
      status,
      1,
      "Write-Error 뒤 exit 10은 도달 불가하다 -- 실제 관측 코드는 암묵 1이어야 한다(1R 반려 실측과 동일)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ⓖ/I5 복원: Write-Host로 바꾸면 exit 10이 실제로 도달한다(이번 패치가 쓰는 형태)", () => {
  const dir = tmpWorktree("hyk400-i5-fixed-");
  try {
    const script = join(dir, "fixed.ps1");
    writeFileSync(
      script,
      [
        '$ErrorActionPreference = "Stop"',
        'Write-Host "RECEIVER_GUARD_CLI_MISSING: synthetic" -ForegroundColor Red',
        "exit 10",
      ].join("\n"),
      "utf8",
    );
    let status;
    try {
      execFileSync("pwsh", ["-File", script], { stdio: "pipe" });
      status = 0;
    } catch (err) {
      status = err.status;
    }
    assert.equal(status, 10, "Write-Host 뒤 exit 10은 실제로 도달해야 한다");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================
// 지원/미지원 -- 정본 수신부 vs HYK-396 이전 수신부(회귀 확인)
// ============================================================

test("지원: 이 저장소 자신의 dispatch-receipt-cli.mjs는 --harness-dir을 의미대로 지원한다", async () => {
  const result = await checkReceiptCliFlagSupport({
    worktree: REPO_ROOT,
    deliveryArgs: REAL_DELIVERY_ARGS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.supported, true);
  assert.deepEqual(result.checkedFlags, ["--harness-dir"]);
});

test("지원 CLI: 지원 워크트리 -> exit 0 + SUPPORTED", () => {
  const args = ["--worktree", REPO_ROOT];
  for (const tok of REAL_DELIVERY_ARGS) args.push("--delivery-arg", tok);
  const { status, stdout } = runCli(args);
  assert.equal(status, 0);
  assert.match(stdout, /^SUPPORTED/);
});

test("미지원: HYK-396 이전 dispatch-receipt-cli.mjs(커밋 8ac19a0)는 unrecognized flag로 거부된다", async () => {
  const worktree = tmpWorktree("hyk400-unsupported-worktree-");
  try {
    seedReceiptCli(worktree, "hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt");
    const result = await checkReceiptCliFlagSupport({
      worktree,
      deliveryArgs: deliveryArgsFor(worktree),
    });
    assert.equal(result.ok, true, "판정 자체는 성공(결론 = 미지원)");
    assert.equal(result.supported, false);
    assert.match(result.reason, /unrecognized flag '--harness-dir'/);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("미지원 CLI: worktree 인자가 없으면 usage + exit 1(부작용 없이 거부)", () => {
  const { status, stderr } = runCli([]);
  assert.notEqual(status, 0);
  assert.match(stderr, /usage:/);
});

// Q4류 되돌림 -- 가드 없이 미지원 CLI를 직접 부르면 오늘 실사고 그대로의
// 옛 오류로 깨진다(부작용 없음도 같은 시험이 확인).
test("가드 없이 미지원 CLI를 직접 부르면 오늘 실사고와 같은 문구로 깨진다(변이 = 가드를 아예 거치지 않음)", () => {
  const dir = tmpWorktree("hyk400-direct-call-");
  try {
    const cliPath = seedReceiptCli(
      dir,
      "hyk400-dispatch-receipt-cli-pre-hyk396.mjs.txt",
    );
    let status, stdout;
    try {
      stdout = execFileSync(
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
      status = 0;
    } catch (err) {
      status = err.status;
      stdout = err.stdout ?? "";
    }
    assert.notEqual(status, 0);
    assert.equal(
      stdout.trim(),
      "FAILED reason=unrecognized flag '--harness-dir'",
    );
    assert.throws(() => readFileSync(join(dir, "receipt.jsonl"), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
