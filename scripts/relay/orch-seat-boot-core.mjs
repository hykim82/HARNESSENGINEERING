// orch-seat-boot-core.mjs -- HYK-389 조각 2 저장소 몫 (기록 단계 · OBSERVER · 앵커 아님).
//
// ORCH 좌석 부팅 판정의 «순수 코어». 파일시스템 · 프로세스 전역을 읽지 않는다:
// 파일 실재 여부 · 시각 · 환경 값은 전부 호출자(orch-seat-boot.mjs)가 값으로 넘긴다.
// 하는 일은 셋뿐이다:
//   (1) 진짜 orca 경로 · shim 파일 · shim CLI 실재 값으로 `shim=enabled|disabled` +
//       사유 코드를 판정한다.
//   (2) 원장에 덧붙일 `orch_seat_boot` 한 줄(JSON 객체)을 조립한다.
//   (3) 런처가 읽을 stdout 한 줄 JSON(판정 결과)을 조립한다.
//
// 원장 줄 스키마 결정(사전 확인 근거 1줄): 조각 1 의 쓰기 줄은 `schema`
// = "orca-direct-ledger/1" 이고 `event` 칸이 «없다» -- 그 줄을 읽는 쪽은 이 저장소에
// 시험(orca-shim.test.mjs)뿐이며 시험은 자기 합성 원장만 읽는다. 그래서 부팅 줄은
// «같은 파일 · 같은 schema 문자열» 에 `event: "orch_seat_boot"` 칸을 «더해» 섞고,
// 읽는 쪽은 `event` 유무로 갈라 읽는다(쓰기 줄의 domain · verb · actor 칸을 부팅 줄이
// 갖지 않는다 -- 부팅 줄을 쓰기 줄로 오인하지 않게 `event` 로만 판별).
//
// ⚠️정직 한계: OBSERVER 다 -- 막는 장치가 아니다(이 판정은 어떤 경우에도 ORCH 기동을
// 거부하지 않는다 · 종료코드는 언제나 0). 런처를 거치지 않은 ORCH(옛 부팅줄 폴백 ·
// 손 실행)는 이 줄이 없고 기록 밖이다. 같은 권한 행위자는 원장 · 런처 · PATH 를
// 바꿀 수 있다. 앵커가 아니다(docs/enforcement-known-gaps.md gap#102).

import { LEDGER_SCHEMA } from "./orca-shim-core.mjs";

export const BOOT_EVENT = "orch_seat_boot";
export const BOOT_RESULT_SCHEMA = "orch-seat-boot/1";

export const SHIM_ENABLED = "enabled";
export const SHIM_DISABLED = "disabled";

// 사유 코드(disabled 일 때만). 판정 순서 = 이 목록 순서(첫 실패가 `reason`).
export const REASON_REAL_BIN_MISSING = "REAL_BIN_MISSING";
export const REASON_SHIM_MISSING = "SHIM_MISSING";
export const REASON_CLI_MISSING = "CLI_MISSING";
export const REASON_LEDGER_UNSET = "LEDGER_UNSET";
// 런처(ps1)가 부팅 판정 CLI 자체를 못 불렀을 때 쓰는 값(예: node 부재). 코어는 이
// 코드를 «만들지» 않는다 -- 런처 쪽 문자열과 맞추는 단일 출처로만 둔다.
export const REASON_BOOT_CLI_FAILED = "BOOT_CLI_FAILED";
export const REASON_BOOT_INTERNAL_ERROR = "BOOT_INTERNAL_ERROR";

export const LEDGER_WRITTEN = "written";
export const LEDGER_WRITE_FAILED = "write_failed";
export const LEDGER_NOT_CONFIGURED = "not_configured";

// shim 디렉터리에서 «있어야 하는» 파일 이름 -- 하나라도 있으면 SHIM 은 실재한다고
// 본다(PowerShell 좌석은 orca.ps1 · Git Bash 좌석은 orca 를 집는다).
export const SHIM_FILE_NAMES = Object.freeze(["orca.ps1", "orca"]);

function present(value) {
  return typeof value === "string" && value !== "";
}

// 판정. facts = { realBinPath, realBinExists, shimDirPath, shimFilesFound(문자열 배열),
// shimCliPath, shimCliExists, ledgerPath }. 반환 = { shim, reason, reasons }.
// `reasons` 는 «모든» 실패 사유(진단용) · `reason` 은 그 첫 값(없으면 null).
function realBinOk(f) {
  return present(f.realBinPath) && f.realBinExists === true;
}

function shimOk(f) {
  const found = Array.isArray(f.shimFilesFound) ? f.shimFilesFound : [];
  return present(f.shimDirPath) && found.length > 0;
}

function cliOk(f) {
  return present(f.shimCliPath) && f.shimCliExists === true;
}

export function decideBoot(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const checks = [
    [realBinOk(f), REASON_REAL_BIN_MISSING],
    [shimOk(f), REASON_SHIM_MISSING],
    [cliOk(f), REASON_CLI_MISSING],
    [present(f.ledgerPath), REASON_LEDGER_UNSET],
  ];
  const reasons = checks.filter(([ok]) => !ok).map(([, code]) => code);
  return {
    shim: reasons.length === 0 ? SHIM_ENABLED : SHIM_DISABLED,
    reason: reasons.length === 0 ? null : reasons[0],
    reasons,
  };
}

// 원장 한 줄(JSON 객체). `role` = 부팅 프로세스 환경의 HARNESS_ROLE(없으면 null) ·
// `launcher_mark` = 런처 표지(HARNESS_ORCA_SHIM = 런처 기동 시각 · 없으면 null).
export function buildBootLedgerEntry({ decision, role, mark, cwd, nowIso }) {
  return {
    schema: LEDGER_SCHEMA,
    event: BOOT_EVENT,
    ts: nowIso,
    shim: decision.shim,
    reason: decision.reason,
    reasons: decision.reasons,
    role: present(role) ? role : null,
    launcher_mark: present(mark) ? mark : null,
    cwd: typeof cwd === "string" ? cwd : null,
  };
}

export function formatBootLedgerLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}

// stdout 한 줄 JSON -- 런처가 «PATH 앞에 얹을지 · 무엇을 env 로 줄지» 를 읽는 값.
export function buildBootResult({
  decision,
  ledgerState,
  ledgerError,
  realBinPath,
  shimDirPath,
  shimCliPath,
  ledgerPath,
  mark,
}) {
  return {
    schema: BOOT_RESULT_SCHEMA,
    shim: decision.shim,
    reason: decision.reason,
    reasons: decision.reasons,
    ledger: ledgerState,
    ledger_error: ledgerError ?? null,
    real_bin: present(realBinPath) ? realBinPath : null,
    shim_dir: present(shimDirPath) ? shimDirPath : null,
    shim_cli: present(shimCliPath) ? shimCliPath : null,
    ledger_path: present(ledgerPath) ? ledgerPath : null,
    mark: present(mark) ? mark : null,
  };
}

// 어떤 예외가 나도 ORCH 기동을 막지 않는다 -- 내부 오류는 disabled 로 접는다.
export function buildInternalErrorResult(message) {
  const decision = {
    shim: SHIM_DISABLED,
    reason: REASON_BOOT_INTERNAL_ERROR,
    reasons: [REASON_BOOT_INTERNAL_ERROR],
  };
  return {
    ...buildBootResult({
      decision,
      ledgerState: LEDGER_NOT_CONFIGURED,
      ledgerError: typeof message === "string" ? message : null,
    }),
  };
}
