// HYK-292 I2 -- CLI shell around orch-boot-budget-core.mjs.
//
// ⛔저장소 코드에 관제실 절대경로를 하드코딩하지 않는다 -- 관제실
// 디렉터리는 --control-room/HARNESS_CONTROL_ROOM_PATH로, 부팅 계약
// 문서 경로는 --charter-paths/HARNESS_BOOT_CHARTER_PATHS(쉼표 구분)로
// 주입받는다(controlroom-fresh.mjs·stale-pointer-check.mjs의 기존
// 관례와 동일한 방식).
//
// 4R (coder-task.md §1·§2) -- 부팅 필독 집합은 더 이상 계약 문서의
// 부팅줄 산문이나 번호 목록을 정규식으로 흉내내지 않고, 계약 문서 안의
// `<!-- orch-boot-set: PHASE-HANDOFF.md, STATUS.md -->` 기계 판독 표식
// 블록 하나에서 그대로 읽는다(orch-boot-budget-core.mjs의
// deriveOrchBootManifest 참조). 표식이 없거나·비어 있거나·둘 이상이면
// "두 파일만 쓴다"로 조용히 축소하지 않고 exit 2로 fail-closed한다
// (요건 2·3 -- 가짜 유도·조용한 다수결보다 정직한 정지).
//
// 출력 계약(PM 사람이 칠 명령과 동일 관측 단위): 정확히 1줄
// `ORCH_BOOT_BYTES=<n>`, 종료코드 0(예산 안)/1(예산 밖)/2(설정
// 파일·계약 문서 자체가 못 읽히거나 표식 유도가 실패함 -- fail-closed).
// 어디서 유도했는지는 diagnostic(항상 stderr)에 남긴다(요건 4) --
// 이름·문구는 "전체 부팅 집합"을 주장하지 않는다(요건 5): 실제로는
// "계약 문서의 orch-boot-set 표식에서 유도한 필독 파일 집합"이며, 그
// 범위를 diagnostic이 그대로 말한다.
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkOrchBootBudget,
  deriveOrchBootManifest,
} from "./orch-boot-budget-core.mjs";
import { readDocsBudgetConfig } from "./docs-budget-config-adapter.mjs";

const DEFAULT_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "docs-budget-config.json",
);

function splitPaths(value) {
  return (value ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseArgs(argv) {
  let controlRoomPath = process.env.HARNESS_CONTROL_ROOM_PATH;
  let configPath =
    process.env.HARNESS_DOCS_BUDGET_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  let charterPaths = splitPaths(process.env.HARNESS_BOOT_CHARTER_PATHS);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--control-room") controlRoomPath = argv[++i];
    else if (argv[i] === "--config-path") configPath = argv[++i];
    else if (argv[i] === "--charter-paths")
      charterPaths = splitPaths(argv[++i]);
  }
  return { controlRoomPath, configPath, charterPaths };
}

export function runOrchBootBudgetCheck(argv) {
  const { controlRoomPath, configPath, charterPaths } = parseArgs(argv);

  if (!controlRoomPath || charterPaths.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      lines: [
        "orch-boot-budget-check: usage: node orch-boot-budget-check.mjs --control-room <dir> --charter-paths <doc1.md,doc2.md,...> [--config-path <docs-budget-config.json>]",
      ],
    };
  }

  const config = readDocsBudgetConfig({ configPath });
  if (!config.ok) {
    return {
      ok: false,
      exitCode: 2,
      lines: [
        `orch-boot-budget-check: CONFIG_REJECTED reason=${config.reason} detail=${config.detail}`,
      ],
    };
  }

  const charterDocs = [];
  for (const charterPath of charterPaths) {
    if (!existsSync(charterPath)) {
      return {
        ok: false,
        exitCode: 2,
        lines: [
          `orch-boot-budget-check: MANIFEST_DERIVATION_FAILED charter document not found: ${charterPath}`,
        ],
      };
    }
    charterDocs.push({
      path: charterPath,
      text: readFileSync(charterPath, "utf8"),
    });
  }

  const manifest = deriveOrchBootManifest(charterDocs);
  if (!manifest.ok) {
    const reasonText = {
      no_marker: `"<!-- orch-boot-set: ... -->" 표식을 하나도 못 찾음`,
      empty_marker: `표식은 찾았으나 파일명이 0개`,
      multiple_markers: `표식이 ${manifest.markerCount}개 발견됨 -- 어느 것이 정본인지 결정할 수 없음`,
    }[manifest.reason];
    return {
      ok: false,
      exitCode: 2,
      lines: [
        `orch-boot-budget-check: MANIFEST_DERIVATION_FAILED 넘겨받은 계약 문서(${charterPaths.join(",")})에서 ${reasonText} -- fail-closed(추측 유도 금지)`,
      ],
    };
  }

  const fileSizes = [];
  for (const entry of manifest.files) {
    const filePath = join(controlRoomPath, entry.basename);
    if (!existsSync(filePath)) {
      return {
        ok: false,
        exitCode: 2,
        lines: [
          `orch-boot-budget-check: manifest file not found: ${filePath} (derived from ${entry.source})`,
        ],
      };
    }
    fileSizes.push({
      basename: entry.basename,
      bytes: statSync(filePath).size,
    });
  }

  const result = checkOrchBootBudget({
    fileSizes,
    orchBootBudgetBytes: config.orchBootBudgetBytes,
  });
  // 요건 4·6: 어디서·몇 개를 유도했는지, 이 집합이 "전체"가 아니라
  // 넘겨받은 계약 문서 범위임을 진단 줄에 남긴다(항상 stderr, PASS/RED
  // 모두) -- 성공 경로의 "정확히 1줄" 지표 계약(1b_shown)은 이 진단
  // 줄과 분리해 stdout에서 그대로 유지한다.
  const diagnostic = `manifest_derived_from=${charterPaths.join("+")} files=${fileSizes.map((f) => f.basename).join(",")} count=${fileSizes.length} scope=계약 문서의 orch-boot-set 표식에서 유도(전체 ORCH 부팅 집합을 주장하지 않음)`;
  const lines = [...result.reasons, `ORCH_BOOT_BYTES=${result.totalBytes}`];
  return { ok: result.ok, exitCode: result.ok ? 0 : 1, lines, diagnostic };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/orch-boot-budget-check.mjs");
if (invokedDirectly) {
  const { ok, exitCode, lines, diagnostic } = runOrchBootBudgetCheck(
    process.argv.slice(2),
  );
  if (diagnostic) console.error(diagnostic);
  for (const line of lines) {
    if (ok) console.log(line);
    else console.error(line);
  }
  process.exit(exitCode);
}
