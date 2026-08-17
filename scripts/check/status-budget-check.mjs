// HYK-292 I1 -- CLI shell around status-budget-core.mjs.
//
// ⛔저장소 코드에 관제실 절대경로(D:\문서관리\...)를 하드코딩하지 않는다
// (coder-task.md §3-1 요건 1) -- --status-path/HARNESS_STATUS_PATH로
// 주입받는다. 예산 숫자도 하드코딩하지 않고 docs-budget-config.json에서
// 읽는다(요건 2) -- 설정 파일이 없거나 스키마가 깨지면 «상한 없음»으로
// 통과시키지 않고 거부한다(요건 3, fail-closed).
//
// 출력 계약(PM 사람이 칠 명령과 동일 관측 단위): 정확히 1줄
// `bytes=<n> role_rows=<n>`, 종료코드 0(예산 안)/1(예산 밖 또는
// role_rows!=6)/2(설정 파일 자체가 못 읽히거나 §1 표를 못 찾음 --
// fail-closed, 별도 사유 코드).
//
// 2R 수리 1 (coder-task.md §2 수리 1) -- pm_output_budget_bytes가
// null이어도(사람 승인 숫자가 아직 없음, §3-2) 그 사실을 이 실행
// 출력에 "소리내어" 남긴다(진단 줄, PASS/RED 모두 stderr) -- 값을
// 지어내지 않고, 미판정임을 명시한다(formatPmOutputBudgetStatus).
// 이 축은 STATUS.md 자체의 bytes와는 별개 예산이라 I1의 ok/exitCode에
// 섞지 않는다(예산 미설정을 I1의 pass/fail로 둔갑시키지 않는다).
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkStatusBudget } from "./status-budget-core.mjs";
import { readDocsBudgetConfig } from "./docs-budget-config-adapter.mjs";
import { formatPmOutputBudgetStatus } from "./pm-output-budget-core.mjs";

const DEFAULT_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "docs-budget-config.json",
);

function parseArgs(argv) {
  let statusPath = process.env.HARNESS_STATUS_PATH;
  let configPath =
    process.env.HARNESS_DOCS_BUDGET_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--status-path") statusPath = argv[++i];
    else if (argv[i] === "--config-path") configPath = argv[++i];
  }
  return { statusPath, configPath };
}

export function runStatusBudgetCheck(argv) {
  const { statusPath, configPath } = parseArgs(argv);

  if (!statusPath) {
    return {
      ok: false,
      exitCode: 2,
      lines: [
        "status-budget-check: usage: node status-budget-check.mjs --status-path <STATUS.md> [--config-path <docs-budget-config.json>]",
      ],
    };
  }

  const config = readDocsBudgetConfig({ configPath });
  if (!config.ok) {
    return {
      ok: false,
      exitCode: 2,
      lines: [
        `status-budget-check: CONFIG_REJECTED reason=${config.reason} detail=${config.detail}`,
      ],
    };
  }

  if (!existsSync(statusPath)) {
    return {
      ok: false,
      exitCode: 2,
      lines: [`status-budget-check: file not found: ${statusPath}`],
    };
  }

  const byteLength = statSync(statusPath).size;
  const statusText = readFileSync(statusPath, "utf8");
  const result = checkStatusBudget({
    statusText,
    byteLength,
    statusBudgetBytes: config.statusBudgetBytes,
  });

  const pmOutputStatus = formatPmOutputBudgetStatus({
    pmOutputBudgetBytes: config.pmOutputBudgetBytes,
    bytes: byteLength,
  });

  if (result.sectionFound === false) {
    return {
      ok: false,
      exitCode: 2,
      lines: result.reasons,
      diagnostic: pmOutputStatus.line,
    };
  }

  const lines = [
    ...result.reasons,
    `bytes=${result.bytes} role_rows=${result.roleRows}`,
  ];
  return {
    ok: result.ok,
    exitCode: result.ok ? 0 : 1,
    lines,
    diagnostic: pmOutputStatus.line,
  };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/status-budget-check.mjs");
if (invokedDirectly) {
  const { ok, exitCode, lines, diagnostic } = runStatusBudgetCheck(
    process.argv.slice(2),
  );
  if (diagnostic) console.error(diagnostic);
  for (const line of lines) {
    if (ok) console.log(line);
    else console.error(line);
  }
  process.exit(exitCode);
}
