// HYK-430 5R (§0 재설계 -- 폴백을 지우고 정적 import로 바꾼다):
// relay-handshake.mjs는 이제 child-probe-timeout-policy.mjs를 로컬
// 복제도, 옵션 동적 import도 하지 않고 평범한 정적 import로 직접 쓴다.
// "복제가 없다"는 것은 "패리티로 대조할 대상이 없다"는 뜻이지 "검증할
// 게 없다"는 뜻이 아니다 -- 이 시험은 다음을 직접 증명한다:
//   (a)/(a-2) 진짜 단일 소스: 정본 모듈을 변이하면(로컬 복제가 없으므로
//       relay-handshake.mjs가 참조할 곳은 정본 하나뿐이다) 격리
//       픽스처 안에서 relay-handshake.mjs의 «실제 산출값»이 그 변이를
//       그대로 반영한다.
//   (b)★ 5R: 정본 모듈 자체가 격리 픽스처에 없으면(scripts/check/
//       relay-handshake-fixture-siblings.mjs가 요구하는 형제 목록에서
//       의도적으로 하나를 뺀 경우) 더 이상 "조용한 폴백"으로 물러나지
//       않는다 -- 정적 import이므로 relay-handshake.mjs 자신의 모듈
//       로드가 그 자리에서 거부된다(2R~4R이 지키려던 "정직한 폴백"이
//       아니라, 그 폴백이 필요한 상황 자체가 없어졌다는 뜻).
//   (c)/(d)/(e) 정본 모듈이 «있는데 망가진» 경우(top-level throw·
//       문법 오류·의존성 누락)도 동일하게 모듈 로드 자체가 거부된다
//       (정적 import는 원래 이 세 형태 모두에서 로드를 거부한다 --
//       동적 import 시절처럼 "부재와 망가짐을 코드로 갈라야" 할 필요가
//       없어졌다는 것 자체가 이 라운드의 단순화다).
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

// includeCanonicalPolicy defaults to true (5R: 이 시험 파일의 정상
// 시나리오는 이제 «정책이 있는» 경우다 -- 부재는 (b) 하나만 별도로
// 확인한다).
function seedIsolatedCheckDir({
  includeCanonicalPolicy = true,
  mutateCanonicalPolicy,
} = {}) {
  const isolatedDir = tmpDir("hyk430-5r-wiring-isolated-");
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
      taskId: "HYK-430-5R-WIRING-A-1",
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
      `재시도 1회 포함 정확히 2회 시도해야 한다: ${JSON.stringify(lines)}`,
    );
    // "로컬 복제가 있었다면 절대 참조하지 않았을 이름의 심볼
    // (MAX_MULTIPLIER=100)이 로드 자체를 깨지 않고 실제로 이 파일의
    // 모듈 그래프 안에 들어갔다"는 것 자체가 단일 소스의 증거다.
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
      taskId: "HYK-430-5R-WIRING-A2-1",
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
// (b)★ HYK-430 5R -- 폴백이 없으므로, 정본 모듈이 격리 픽스처에 없으면
// "적응 없이 기준값 그대로 물러나는" 대신 relay-handshake.mjs 자신의
// 모듈 로드가 거부된다(정적 import는 대상이 없으면 그 자리에서 실패).
// 이 시험은 «그 실패가 실제로 일어나는지»를 직접 확인해, "정책 파일을
// 형제로 복사하지 않은 픽스처는 즉시 깨진다"(coder-task.md §2⑶ⓒ)는
// 이 라운드의 전제 자체를 고정한다.
// ---------------------------------------------------------------------------

test("(b)★ 5R: 정본 모듈이 격리 픽스처에 없으면 조용한 폴백이 아니라 relay-handshake.mjs 자신의 모듈 로드가 거부된다(MODULE_NOT_FOUND)", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    includeCanonicalPolicy: false,
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    await assert.rejects(
      () => import(isolatedRelayHandshake),
      (err) => {
        assert.equal(err.code, "ERR_MODULE_NOT_FOUND");
        assert.match(err.message, /child-probe-timeout-policy\.mjs/);
        return true;
      },
      "정책 파일을 형제로 복사하지 않은 픽스처는 이제 폴백으로 물러나지 않고 relay-handshake.mjs의 정적 import 자체가 실패해야 한다",
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (c)/(d)/(e) HYK-430 4R에서 도입된, "모듈 부재"와 "모듈이 있는데
// 망가졌다"를 가르는 검증 -- 5R에서 정적 import로 바뀐 뒤에도 이
// 세 형태(top-level throw·문법 오류·의존성 누락) 모두 여전히 모듈
// 로드 자체가 거부되어야 한다(정적 import는 애초에 이 구분을 코드로
// 만들 필요가 없다 -- Node 자신이 세 경우 모두 로드를 거부한다).
// ---------------------------------------------------------------------------

test("(c) 정본 모듈이 top-level에서 throw하면(문법은 정상, 초기화 실패) 모듈 로드 자체가 거부된다", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    // export 선언은 그대로 두고(ESM linker의 정적 export 검사를
    // 통과시켜야 "부재"가 아니라 "초기화 실패"를 재현한다) 맨 앞에
    // throw를 추가해 실행 단계에서 던지게 한다.
    mutateCanonicalPolicy: (src) =>
      `throw new Error("policy load exploded");\n${src}`,
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    await assert.rejects(
      () => import(isolatedRelayHandshake),
      /policy load exploded/,
      "정본 모듈이 망가졌으면(부재가 아니라 초기화 실패) 이 파일을 import하는 것 자체가 실패해야 한다",
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("(d) 문법 오류(SyntaxError)도 모듈 로드가 거부된다", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    mutateCanonicalPolicy: () => "export function broken( {\n",
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    await assert.rejects(
      () => import(isolatedRelayHandshake),
      "문법 오류가 있는 정본 모듈도 모듈 로드 자체가 거부되어야 한다",
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test("(e) 의존성 누락(정본 파일 자신은 있지만 그 파일이 import하는 다른 파일이 없음)도 모듈 로드가 거부된다", async () => {
  const { isolatedDir, isolatedCheckDir } = seedIsolatedCheckDir({
    mutateCanonicalPolicy: (src) =>
      `import { nothingHere } from "./this-file-does-not-exist.mjs";\n${src}`,
  });
  try {
    const isolatedRelayHandshake = pathToFileURL(
      join(isolatedCheckDir, "relay-handshake.mjs"),
    ).href;
    await assert.rejects(
      () => import(isolatedRelayHandshake),
      /this-file-does-not-exist\.mjs/,
      "정본 파일 자신이 아니라 «그 파일의 의존성»이 없는 경우도 모듈 로드가 거부되어야 한다",
    );
  } finally {
    rmSync(isolatedDir, { recursive: true, force: true });
  }
});
