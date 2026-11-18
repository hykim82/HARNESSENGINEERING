// orch-seat-boot.mjs -- HYK-389 조각 2 저장소 몫: ORCH 좌석 부팅 판정 CLI
// (기록 단계 · OBSERVER · 앵커 아님 · 막는 장치 아님).
//
// 사용(보통 templates/orca-shim/orca-orch-seat.ps1 런처가 부른다):
//   node orch-seat-boot.mjs [--real-bin <진짜 orca>] [--shim-dir <shim 디렉터리>]
//        [--shim-cli <orca-shim-cli.mjs>] [--ledger <원장>] [--mark <런처 표지>]
//        [--role <역할>]
// 인자가 없으면 환경 변수를 읽는다(인자가 우선): HARNESS_ORCA_REAL_BIN ·
// HARNESS_ORCA_SHIM_DIR · HARNESS_ORCA_SHIM_CLI · HARNESS_ORCA_SHIM_LEDGER ·
// HARNESS_ORCA_SHIM(런처 표지) · HARNESS_ROLE. 관제실 · 사용자 절대 경로는 이 파일에
// 하드코딩하지 않는다(전부 주입).
//
// 하는 일:
//   1. 진짜 orca 경로가 파일인가 · shim 디렉터리에 shim 파일이 있는가 · shim CLI 가
//      파일인가 · 원장 경로가 주어졌는가를 «값으로» 잰다.
//   2. `shim=enabled` 또는 `shim=disabled` + 사유 코드를 판정한다.
//   3. 원장에 `event=orch_seat_boot` 1줄을 덧붙인다(실패해도 던지지 않는다).
//   4. stdout 에 한 줄 JSON 을 쓴다(런처가 PATH 앞에 shim 을 얹을지 · 무엇을 env 로
//      줄지 읽는다).
//
// ⭐⭐종료코드는 «언제나 0» 이다: 어떤 실패(진짜 경로 부재 · shim 부재 · 원장 쓰기
// 실패 · 내부 예외)도 ORCH 기동을 막지 않는다(마비 금지). 실패는 JSON 의
// `shim=disabled` · `reason` · `ledger=write_failed` 로만 알린다.
//
// ⚠️정직 한계: 이것은 OBSERVER 다 -- 부팅 판정이 기동을 거부하는 경로는 없다.
// 런처를 거치지 않은 ORCH(옛 부팅줄 폴백 · 손 실행)는 이 줄이 없어 기록 밖이다.
// 같은 권한 행위자는 원장 · 런처 · PATH 를 바꿀 수 있다. 앵커가 아니다(gap#102).
// ⛔이 파일은 진짜 orca 를 «실행하지 않는다» -- 경로가 파일인지 stat 만 한다.

import { appendFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_LEDGER, ENV_REAL_BIN } from "./orca-shim-cli.mjs";
import {
  LEDGER_NOT_CONFIGURED,
  LEDGER_WRITE_FAILED,
  LEDGER_WRITTEN,
  SHIM_FILE_NAMES,
  buildBootLedgerEntry,
  buildBootResult,
  buildInternalErrorResult,
  decideBoot,
  formatBootLedgerLine,
} from "./orch-seat-boot-core.mjs";

export const ENV_SHIM_DIR = "HARNESS_ORCA_SHIM_DIR";
export const ENV_SHIM_CLI = "HARNESS_ORCA_SHIM_CLI";
// 런처 표지 = 런처 기동 시각(설계 §다 `HARNESS_ORCA_SHIM=<런처 기동 시각>`).
export const ENV_LAUNCHER_MARK = "HARNESS_ORCA_SHIM";
export const ENV_ROLE = "HARNESS_ROLE";

const OPTION_ENV = Object.freeze({
  "--real-bin": ENV_REAL_BIN,
  "--shim-dir": ENV_SHIM_DIR,
  "--shim-cli": ENV_SHIM_CLI,
  "--ledger": ENV_LEDGER,
  "--mark": ENV_LAUNCHER_MARK,
  "--role": ENV_ROLE,
});

function isFile(target, statFn) {
  try {
    return statFn(target).isFile();
  } catch {
    return false;
  }
}

// 인자 -> 값 표. `--name value` 와 `--name=value`. 모르는 옵션은 무시한다(어떤
// 입력도 기동을 막지 않는다).
function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string") continue;
    const eq = token.indexOf("=");
    const name = eq > 0 ? token.slice(0, eq) : token;
    if (!Object.hasOwn(OPTION_ENV, name)) continue;
    if (eq > 0) {
      values[name] = token.slice(eq + 1);
    } else if (i + 1 < argv.length && typeof argv[i + 1] === "string") {
      values[name] = argv[i + 1];
      i += 1;
    }
  }
  return values;
}

function pick(values, env, option) {
  const fromArg = values[option];
  if (typeof fromArg === "string" && fromArg !== "") return fromArg;
  const fromEnv = env[OPTION_ENV[option]];
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : null;
}

// shim CLI 기본 위치 = orca.ps1 이 쓰는 파생과 같다(shim 디렉터리 기준 ../../scripts/relay/).
function defaultShimCli(shimDir) {
  return path.resolve(
    shimDir,
    "..",
    "..",
    "scripts",
    "relay",
    "orca-shim-cli.mjs",
  );
}

function collectFacts({ values, env, statFn }) {
  const realBinPath = pick(values, env, "--real-bin");
  const shimDirPath = pick(values, env, "--shim-dir");
  const ledgerPath = pick(values, env, "--ledger");
  let shimCliPath = pick(values, env, "--shim-cli");
  if (shimCliPath === null && shimDirPath !== null) {
    shimCliPath = defaultShimCli(shimDirPath);
  }
  const shimFilesFound =
    shimDirPath === null
      ? []
      : SHIM_FILE_NAMES.filter((name) =>
          isFile(path.join(shimDirPath, name), statFn),
        );
  return {
    realBinPath,
    realBinExists: realBinPath !== null && isFile(realBinPath, statFn),
    shimDirPath,
    shimFilesFound,
    shimCliPath,
    shimCliExists: shimCliPath !== null && isFile(shimCliPath, statFn),
    ledgerPath,
  };
}

// 원장에 부팅 줄 1개. 던지지 않는다 -> { state, error }.
function recordBoot({ ledgerPath, entry, appendFn }) {
  if (ledgerPath === null) return { state: LEDGER_NOT_CONFIGURED, error: null };
  try {
    appendFn(ledgerPath, formatBootLedgerLine(entry), "utf8");
    return { state: LEDGER_WRITTEN, error: null };
  } catch (error) {
    return {
      state: LEDGER_WRITE_FAILED,
      error: error?.message ?? String(error),
    };
  }
}

// 판정 -> 원장 1줄 -> stdout JSON. 던질 수 있다(runBoot 이 삼킨다).
function bootOnce({ argv, env, cwd, stdout, stderr, statFn, appendFn, nowFn }) {
  const values = parseArgs(Array.isArray(argv) ? argv : []);
  const facts = collectFacts({ values, env, statFn });
  const decision = decideBoot(facts);
  const mark = pick(values, env, "--mark");
  const entry = buildBootLedgerEntry({
    decision,
    role: pick(values, env, "--role"),
    mark,
    cwd,
    nowIso: nowFn().toISOString(),
  });
  const recorded = recordBoot({
    ledgerPath: facts.ledgerPath,
    entry,
    appendFn,
  });
  if (recorded.state === LEDGER_WRITE_FAILED) {
    stderr(
      `ORCH_SEAT_BOOT_LEDGER_WRITE_FAILED: ${recorded.error} -- 부팅 줄을 남기지 못했다. 기동은 막지 않는다(조회 실패 ≠ 위반 없음).\n`,
    );
  }
  stdout(
    `${JSON.stringify(
      buildBootResult({
        decision,
        ledgerState: recorded.state,
        ledgerError: recorded.error,
        realBinPath: facts.realBinPath,
        shimDirPath: facts.shimDirPath,
        shimCliPath: facts.shimCliPath,
        ledgerPath: facts.ledgerPath,
        mark,
      }),
    )}\n`,
  );
}

// 본체(시험이 직접 부를 수 있다). 반환 = 종료코드 -- «언제나 0».
export function runBoot({
  argv,
  env,
  cwd,
  stdout,
  stderr,
  statFn = statSync,
  appendFn = appendFileSync,
  nowFn = () => new Date(),
}) {
  try {
    bootOnce({
      argv,
      env: env ?? {},
      cwd,
      stdout,
      stderr,
      statFn,
      appendFn,
      nowFn,
    });
  } catch (error) {
    // 마지막 방어선: 어떤 예외도 기동을 막지 않는다.
    try {
      stdout(
        `${JSON.stringify(buildInternalErrorResult(error?.message ?? String(error)))}\n`,
      );
    } catch {
      // stdout 마저 못 쓰면 더 할 수 있는 것이 없다 -- 그래도 0 으로 끝낸다.
    }
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = runBoot({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
