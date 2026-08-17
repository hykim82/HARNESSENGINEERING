// HYK-292 (coder-task.md §3-1 요건 2) -- 문서 예산 숫자(64KiB/96KiB)의
// 출처는 사람이다(HYK-193 S-5 선례). 코드에 65536/98304를 상수로 박지
// 않고, 커밋되는 `docs-budget-config.json`에서 읽는다. 새로 발명하지
// 않고 `scripts/supervisor/concurrency-cap-adapter.mjs`의 계약을 그대로
// 따른다: schema_version이 있는 작은 커밋 JSON + throw로 판정을 대신하지
// 않는 fail-closed 어댑터.
//
// 비타협(coder-task.md §3-1 요건 3):
// - fail-closed -- 파일 부재·읽기 실패·JSON 파싱 실패·스키마 불일치
//   (schema_version 불일치 포함)·바이트 예산 필드가 양의 정수가 아님,
//   전부 실패 객체다. ⛔어떤 경로도 숫자 기본값(«상한 없음»)으로
//   폴백하지 않는다.
// - PM 산출물 크기 예산(pm_output_budget_bytes)만은 예외로 `null`을
//   허용한다(§3-2) -- 사람 승인 숫자가 아직 없기 때문이며, 이 필드가
//   `null`이어도 스키마 위반이 아니다. `null`이 아닌데 양의 정수가
//   아니면 여전히 스키마 불일치다.

import { readFileSync } from "node:fs";

export const DOCS_BUDGET_CONFIG_REASON = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  FILE_UNREADABLE: "FILE_UNREADABLE",
  MALFORMED_JSON: "MALFORMED_JSON",
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",
});

export const DOCS_BUDGET_CONFIG_SCHEMA_VERSION = "docs-budget/v1";

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isPositiveInteger(v) {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v > 0
  );
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
function isNullOrPositiveInteger(v) {
  return v === null || isPositiveInteger(v);
}

function isWellFormedConfigSchema(parsed) {
  return (
    isPlainObject(parsed) &&
    parsed.schema_version === DOCS_BUDGET_CONFIG_SCHEMA_VERSION &&
    isPositiveInteger(parsed.status_budget_bytes) &&
    isPositiveInteger(parsed.orch_boot_budget_bytes) &&
    isNullOrPositiveInteger(parsed.pm_output_budget_bytes)
  );
}

// readDocsBudgetConfig({configPath, readFn}) ->
//   {ok:true, statusBudgetBytes, orchBootBudgetBytes, pmOutputBudgetBytes, configPath} |
//   {ok:false, reason, detail}
//
// readFn은 시험 주입용(기본 fs.readFileSync).
export function readDocsBudgetConfig(args) {
  if (!isPlainObject(args)) {
    return {
      ok: false,
      reason: DOCS_BUDGET_CONFIG_REASON.INVALID_ARGUMENTS,
      detail: "readDocsBudgetConfig arguments missing/invalid",
    };
  }
  const { configPath, readFn } = args;
  if (!isNonEmptyString(configPath)) {
    return {
      ok: false,
      reason: DOCS_BUDGET_CONFIG_REASON.INVALID_ARGUMENTS,
      detail: "configPath missing/invalid",
    };
  }
  const read = readFn === undefined ? readFileSync : readFn;
  if (typeof read !== "function") {
    return {
      ok: false,
      reason: DOCS_BUDGET_CONFIG_REASON.INVALID_ARGUMENTS,
      detail: "readFn must be a function when provided",
    };
  }

  let raw;
  try {
    raw = read(configPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: DOCS_BUDGET_CONFIG_REASON.FILE_UNREADABLE,
      detail: err && err.message ? err.message : String(err),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: DOCS_BUDGET_CONFIG_REASON.MALFORMED_JSON,
      detail: err && err.message ? err.message : String(err),
    };
  }

  if (!isWellFormedConfigSchema(parsed)) {
    return {
      ok: false,
      reason: DOCS_BUDGET_CONFIG_REASON.SCHEMA_MISMATCH,
      detail:
        "schema mismatch (schema_version must equal " +
        JSON.stringify(DOCS_BUDGET_CONFIG_SCHEMA_VERSION) +
        ", status_budget_bytes/orch_boot_budget_bytes must be positive integers, " +
        "pm_output_budget_bytes must be null or a positive integer)",
    };
  }

  return {
    ok: true,
    statusBudgetBytes: parsed.status_budget_bytes,
    orchBootBudgetBytes: parsed.orch_boot_budget_bytes,
    pmOutputBudgetBytes: parsed.pm_output_budget_bytes,
    configPath,
  };
}
