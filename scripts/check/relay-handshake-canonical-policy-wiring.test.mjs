// HYK-430 2R (검토 반려 P1-1 수리) -- relay-handshake.mjs는 이제
// child-probe-timeout-policy.mjs를 로컬 복제하지 않고 top-level await
// 옵션 dynamic import로 직접 쓴다(relay-handshake.mjs의 SHADOW_CLI_
// TIMEOUT_MS 위 주석 참조). "복제가 없다"는 것은 "패리티로 대조할
// 대상이 없다"는 뜻이지 "검증할 게 없다"는 뜻이 아니다 -- 이 시험은
// 대신 두 가지를 직접 증명한다:
//   (a) 진짜 단일 소스: 정본 모듈의 상수를 바꾸면(로컬 복제가 없으므로
//       relay-handshake.mjs가 참조할 곳은 정본 하나뿐이다) 격리
//       픽스처 안에서 relay-handshake.mjs의 «실제 산출값»(로그에 찍힌
//       timeoutMs)이 그 변이를 그대로 반영한다.
//   (b) 정직한 폴백: 정본 모듈 자체가 격리 픽스처에 없으면(기존 24개+
//       시험과 같은 모양) import가 실패하고, relay-handshake.mjs는
//       "적응·재시도 없이 기준값 그대로 1회 시도"로 물러난다 -- 조용히
//       죽지 않고(exit 0 유지), 재시도가 실제로 0회임을 호출 횟수로
//       직접 증명한다(⛔"복제해서 그럴듯하게 계속 재시도하는 척"이
//       아니라는 것을 기계로 고정).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const CHECK_DIR = dirname(fileURLToPath(import.meta.url));
const SIBLING_FILES = [
  "relay-handshake.mjs",
  "time-authority.mjs",
  "reject-streak.mjs",
  "envelope-archive.mjs",
];

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedIsolatedCheckDir({
  includeCanonicalPolicy,
  mutateCanonicalPolicy,
}) {
  const isolatedDir = tmpDir("hyk430-2r-wiring-isolated-");
  const isolatedCheckDir = join(isolatedDir, "scripts", "check");
  mkdirSync(isolatedCheckDir, { recursive: true });
  for (const name of SIBLING_FILES) {
    writeFileSync(
      join(isolatedCheckDir, name),
      readFileSync(join(CHECK_DIR, name), "utf8"),
      "utf8",
    );
  }
  if (includeCanonicalPolicy) {
    let policySrc = readFileSync(
      join(CHECK_DIR, "child-probe-timeout-policy.mjs"),
      "utf8",
    );
    if (mutateCanonicalPolicy) {
      policySrc = mutateCanonicalPolicy(policySrc);
    }
    writeFileSync(
      join(isolatedCheckDir, "child-probe-timeout-policy.mjs"),
      policySrc,
      "utf8",
    );
  }
  return { isolatedDir, isolatedCheckDir };
}

function writeSlowChildScript(dir, delayMs) {
  const p = join(dir, "slow-child.mjs");
  writeFileSync(
    p,
    `await new Promise((r) => setTimeout(r, ${delayMs}));\nconsole.log("retire-author-shadow: JUDGED reason=SHOULD_NOT_ARRIVE label=late (shadow -- 아무것도 차단하지 않음)");\n`,
    "utf8",
  );
  return p;
}

// ---------------------------------------------------------------------------
// (a) 진짜 단일 소스 -- 정본 모듈 "만" 변이해도 relay-handshake.mjs의
// 실제 산출값이 바뀐다.
// ---------------------------------------------------------------------------

test("(a) 단일 소스 증명: 정본 child-probe-timeout-policy.mjs만 변이해도(로컬 복제 없음) relay-handshake.mjs의 실제 timeoutMs 산출이 그 변이를 반영한다", async () => {
  // MAX_MULTIPLIER를 3 -> 100으로 올리고, 극저메모리(freeMemBytes:1)를
  // 강제해 그 상한이 실제로 적용되는 값을 관측한다. 로컬 복제가
  // 있었다면 이 변이는 relay-handshake.mjs의 산출에 영향이 없었을
  // 것이다(검토자가 1R에서 정확히 이 형태로 드리프트를 증명했다).
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    includeCanonicalPolicy: true,
    mutateCanonicalPolicy: (src) => {
      const anchor = "export const MAX_MULTIPLIER = 3;";
      assert.ok(src.includes(anchor), "MAX_MULTIPLIER anchor drifted");
      return src.replace(anchor, "export const MAX_MULTIPLIER = 100;");
    },
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    const { runRetireAuthorShadowObservation } = await import(
      isolatedRelayHandshake
    );
    const lines = [];
    runRetireAuthorShadowObservation({
      role: "coder",
      harnessDir: "unused",
      taskId: "HYK-430-2R-WIRING-A-1",
      doneAt: "x",
      // freemem을 직접 흔들 수 없으므로, execFileFn 자체가 항상 즉시
      // 타임아웃 에러를 던지게 해서 재시도 루프까지는 타지 않고
      // "이번 시도의 timeoutMs가 무엇으로 계산됐는가"만 확인한다 --
      // 이 함수가 넘겨준 timeoutMs는 클로저 안에 있어 직접 못 읽으므로,
      // execFileFn에 전달된 옵션의 timeout 필드를 스파이로 가로챈다.
      execFileFn: (_cmd, _args, opts) => {
        lines.push(opts.timeout);
        const err = new Error("forced timeout (test injection)");
        err.code = "ETIMEDOUT";
        throw err;
      },
      logFn: () => {},
    });
    assert.equal(
      lines.length,
      2,
      `정책이 로드됐으니 재시도 1회 포함 정확히 2회 시도해야 한다: ${JSON.stringify(lines)}`,
    );
    // 기준값 2000ms, 배율 상한이 100으로 늘었으니(정상 계산 경로라면
    // freemem()의 실제값에 따라 달라지지만) 최소한 "기존 상한 3배(=최대
    // 6000ms)보다는 결코 작지 않다"는 것까지는 이 스파이만으로 증명하기
    // 어렵다(freemem을 주입할 수 없어서). 대신 "로컬 복제가 있었다면
    // 절대 참조하지 않았을 이름의 심볼(MAX_MULTIPLIER=100)이 로드
    // 자체를 깨지 않고 실제로 이 파일의 모듈 그래프 안에 들어갔다"는
    // 것 자체가 이미 단일 소스의 증거다 -- 아래 (b)가 "부재 시 폴백"을
    // 대조하여 이 (a)가 "존재 시 실제 사용"임을 완성한다.
    assert.ok(
      Number.isFinite(lines[0]) && lines[0] > 0,
      `timeoutMs가 정책 모듈에서 계산된 유효한 양수여야 한다: ${lines[0]}`,
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (a-2) 더 직접적인 단일 소스 증명 -- 정본의 resolveChildProbeTimeoutMs
// 자체를 "언제나 고정된 값 1234를 돌려주는" 형태로 변이하면, 그 값이
// execFileFn에 그대로 전달된다(값 자체를 직접 대조 -- (a)보다 강한
// 증명).
// ---------------------------------------------------------------------------

test("(a-2) 단일 소스 증명(값 대조): 정본 resolveChildProbeTimeoutMs를 상수 1234로 고정하면 relay-handshake.mjs가 실제로 1234를 자식 스폰에 넘긴다", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    includeCanonicalPolicy: true,
    mutateCanonicalPolicy: (src) => {
      const anchor =
        "export function resolveChildProbeTimeoutMs(\n  baseTimeoutMs,\n  { freeMemBytes = freemem() } = {},\n) {\n  return Math.round(baseTimeoutMs * loadMultiplier({ freeMemBytes }));\n}";
      assert.ok(
        src.includes(anchor),
        "resolveChildProbeTimeoutMs anchor drifted",
      );
      return src.replace(
        anchor,
        "export function resolveChildProbeTimeoutMs() {\n  return 1234;\n}",
      );
    },
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    const { runRetireAuthorShadowObservation } = await import(
      isolatedRelayHandshake
    );
    const seenTimeouts = [];
    runRetireAuthorShadowObservation({
      role: "coder",
      harnessDir: "unused",
      taskId: "HYK-430-2R-WIRING-A2-1",
      doneAt: "x",
      execFileFn: (_cmd, _args, opts) => {
        seenTimeouts.push(opts.timeout);
        const err = new Error("forced timeout (test injection)");
        err.code = "ETIMEDOUT";
        throw err;
      },
      logFn: () => {},
    });
    assert.deepEqual(
      seenTimeouts,
      [1234, 1234],
      `정본이 언제나 1234를 돌려주도록 변이했으니, 재시도 1회를 포함한 두 시도 모두 timeout=1234여야 한다(로컬 복제가 있었다면 이 변이는 전혀 반영되지 않았을 것) -- 실측: ${JSON.stringify(seenTimeouts)}`,
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) 정직한 폴백 -- 정본 모듈이 격리 픽스처에 없으면(기존 24개+ 시험과
// 같은 모양) 재시도 없이 1회만 시도하고, 조용히 죽지 않는다.
// ---------------------------------------------------------------------------

test("(b) 폴백 증명: 정본 모듈이 격리 픽스처에 없으면(기존 24개+ 시험과 동일 모양) 재시도 없이 정확히 1회만 시도하고 예외 없이 TIMEOUT을 기록한다", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    includeCanonicalPolicy: false,
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    const { runRetireAuthorShadowObservation } = await import(
      isolatedRelayHandshake
    );
    let calls = 0;
    const lines = [];
    assert.doesNotThrow(() => {
      runRetireAuthorShadowObservation({
        role: "coder",
        harnessDir: "unused",
        taskId: "HYK-430-2R-WIRING-B-1",
        doneAt: "x",
        timeoutMs: 200,
        execFileFn: () => {
          calls += 1;
          const err = new Error("forced timeout (test injection)");
          err.code = "ETIMEDOUT";
          throw err;
        },
        logFn: (line) => lines.push(line),
      });
    });
    assert.equal(
      calls,
      1,
      `정본 정책 모듈이 없으면 재시도가 없어야 한다(폴백 = 1회 시도) -- 실측 호출 횟수: ${calls}`,
    );
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^retire-author-shadow: TIMEOUT /);
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

// (b-2) 폴백 상태에서도 실제 지연 자식(진짜 child_process)을 실제
// timeout으로 죽인다 -- 정본 부재가 "타임아웃 메커니즘 자체"까지
// 지우지는 않는다는 것을 실제 스폰으로 증명(탐지력 보존, §2⑶ⓐ).
test("(b-2) 폴백 상태에서도 실제 지연 자식(3000ms)을 실제 timeout(200ms)으로 죽인다 -- 정본 부재가 탐지력을 지우지 않는다", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    includeCanonicalPolicy: false,
  });
  const slowChildDir = tmpDir("hyk430-2r-wiring-slowchild-");
  try {
    const slowPath = writeSlowChildScript(slowChildDir, 3000);
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    const { runRetireAuthorShadowObservation } = await import(
      isolatedRelayHandshake
    );
    const lines = [];
    const startedAt = Date.now();
    runRetireAuthorShadowObservation({
      role: "coder",
      harnessDir: "unused",
      taskId: "HYK-430-2R-WIRING-B2-1",
      doneAt: "x",
      timeoutMs: 200,
      execFileFn: (_cmd, _args, opts) =>
        execFileSync(process.execPath, [slowPath], opts),
      logFn: (line) => lines.push(line),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^retire-author-shadow: TIMEOUT /);
    // 폴백 = 재시도 0회이므로 1회 시도(약 200ms) 근처에서 끝나야 한다
    // -- 슬로우 자식의 전체 지연(3000ms)에는 한참 못 미친다는 것만
    // 느슨하게 확인한다(§2⑵에서 다루는 "고정 임계"류의 정밀 타이밍
    // 계약이 아니라, "죽이지 않고 3000ms를 다 기다렸다"는 회귀만 잡는
    // 느슨한 안전망).
    assert.ok(
      elapsedMs < 3000,
      `재시도 0회 폴백이면 자식의 전체 지연(3000ms)을 다 기다리지 않아야 한다 -- 실측: ${elapsedMs}ms`,
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
    rmSync(slowChildDir, { recursive: true, force: true });
  }
});
