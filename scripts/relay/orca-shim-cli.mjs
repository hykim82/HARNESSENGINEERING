// orca-shim-cli.mjs -- HYK-389 조각 1 (기록 단계 · 앵커 아님).
//
// 사용: node orca-shim-cli.mjs <orca argv...>   (보통 templates/orca-shim/ 의
// 얇은 shim 이 부른다 -- shim 이 PATH 앞에 놓인 좌석에서 `orca ...` 를 치면
// 여기로 온다).
//
// 동작:
//   1. 진짜 orca 바이너리 = 환경 변수 HARNESS_ORCA_REAL_BIN(주입 값 · 하드코딩
//      0). 없거나 파일이 아니면 «위임 0 · 비0(127) · 조회 실패 ≠ 위반 없음».
//   2. argv 를 코어로 분류한다. 쓰기 동사면 원장(HARNESS_ORCA_SHIM_LEDGER)에 1줄
//      덧붙인다 -- 위임 «전에». 조회 동사 · 독립 `--help` 는 원장 0줄.
//   3. 원장 쓰기가 실패해도 «위임은 한다» -- stderr 에 ORCA_SHIM_LEDGER_WRITE_FAILED
//      경고만 남긴다.
//   4. argv 를 그대로(한 글자도 바꾸지 않고) 진짜 바이너리로 넘기고 종료코드를
//      그대로 돌려준다.
//
// ⚠️정직 한계: OBSERVER 다 -- 차단하지 않는다(거부 모드 = 조각 4). 이 shim 을
// 우회하는 경로(절대 경로 orca.exe · PATH 재설정 · node spawn)는 기록되지
// 않는다. 앵커 아님. ⛔이 파일은 문자열 리터럴 "orca" 를 spawn 하지 않는다 --
// 그러면 PATH 앞의 shim 자신을 다시 불러 무한 재귀가 된다(경계 시험이 고정).

import { spawnSync } from "node:child_process";
import { appendFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildLedgerEntry,
  classifyArgv,
  formatLedgerLine,
} from "./orca-shim-core.mjs";

export const ENV_REAL_BIN = "HARNESS_ORCA_REAL_BIN";
// 선택: 진짜 바이너리 «앞에» 끼울 인자 목록(JSON 문자열 배열). 인터프리터로
// 도는 시험 대역(node + 스크립트)용이며 운영에서는 설정하지 않는다.
export const ENV_REAL_BIN_PREFIX = "HARNESS_ORCA_REAL_BIN_PREFIX";
export const ENV_LEDGER = "HARNESS_ORCA_SHIM_LEDGER";

export const EXIT_REAL_BIN_MISSING = 127;
export const EXIT_DELEGATE_FAILED = 126;

export const MSG_REAL_BIN_MISSING = "ORCA_SHIM_REAL_BIN_MISSING";
export const MSG_LEDGER_WRITE_FAILED = "ORCA_SHIM_LEDGER_WRITE_FAILED";
export const MSG_DELEGATE_FAILED = "ORCA_SHIM_DELEGATE_FAILED";
export const MSG_NOT_VERIFIED = "조회 실패 ≠ 위반 없음";

function isFile(path, statFn) {
  try {
    return statFn(path).isFile();
  } catch {
    return false;
  }
}

function parsePrefix(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function exitCodeOf(result) {
  if (typeof result.status === "number") return result.status;
  return EXIT_DELEGATE_FAILED;
}

// 진짜 바이너리 해석: { ok:true, realBin, prefix } 또는 { ok:false, message }.
// 없으면 «위임 0» -- 호출자가 비0 으로 끝낸다.
function resolveRealBin(env, statFn) {
  const realBin = env[ENV_REAL_BIN];
  if (
    typeof realBin !== "string" ||
    realBin === "" ||
    !isFile(realBin, statFn)
  ) {
    return {
      ok: false,
      message: `${MSG_REAL_BIN_MISSING}: 진짜 orca 바이너리 경로(${ENV_REAL_BIN})가 없거나 파일이 아니다 -- 위임하지 않았다. ${MSG_NOT_VERIFIED}: 이 호출은 기록도 실행도 되지 않았다.\n`,
    };
  }
  const prefix = parsePrefix(env[ENV_REAL_BIN_PREFIX]);
  if (prefix === null) {
    return {
      ok: false,
      message: `${MSG_REAL_BIN_MISSING}: ${ENV_REAL_BIN_PREFIX} 가 JSON 문자열 배열이 아니다 -- 위임하지 않았다. ${MSG_NOT_VERIFIED}.\n`,
    };
  }
  return { ok: true, realBin, prefix };
}

// 쓰기 동사 1건을 원장에 덧붙인다. 실패해도 던지지 않고 경고 문구를 돌려준다
// (호출자는 그래도 위임한다). 성공이면 null.
function recordWrite({ classified, env, cwd, nowFn, appendFn }) {
  try {
    const ledgerPath = env[ENV_LEDGER];
    if (typeof ledgerPath !== "string" || ledgerPath === "") {
      throw new Error(`${ENV_LEDGER} 가 설정되지 않았다`);
    }
    const entry = buildLedgerEntry({
      classified,
      env,
      cwd,
      nowIso: nowFn().toISOString(),
    });
    appendFn(ledgerPath, formatLedgerLine(entry), "utf8");
    return null;
  } catch (error) {
    return `${MSG_LEDGER_WRITE_FAILED}: ${error?.message ?? String(error)} -- 기록 없이 그대로 위임한다. ${MSG_NOT_VERIFIED}.\n`;
  }
}

// 의존을 인자로 받는 본체(시험이 직접 부를 수 있다). 반환 = 프로세스 종료코드.
export function runShim({
  argv,
  env,
  cwd,
  stderr,
  spawnSyncFn = spawnSync,
  appendFn = appendFileSync,
  statFn = statSync,
  nowFn = () => new Date(),
}) {
  const resolved = resolveRealBin(env, statFn);
  if (!resolved.ok) {
    stderr(resolved.message);
    return EXIT_REAL_BIN_MISSING;
  }

  const classified = classifyArgv(argv);
  if (classified.kind === "write") {
    const warning = recordWrite({ classified, env, cwd, nowFn, appendFn });
    if (warning !== null) stderr(warning);
  }

  const result = spawnSyncFn(resolved.realBin, [...resolved.prefix, ...argv], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) {
    stderr(
      `${MSG_DELEGATE_FAILED}: ${result.error.message} -- 진짜 바이너리를 실행하지 못했다.\n`,
    );
    return EXIT_DELEGATE_FAILED;
  }
  return exitCodeOf(result);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = runShim({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stderr: (text) => process.stderr.write(text),
  });
}
