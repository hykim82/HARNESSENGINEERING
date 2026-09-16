// HYK-464 (coder-task.md §3 항목 3): "고아 좌석 판별·처분 절차 -- 배정 0 +
// 등록부 미기재 좌석을 안전하게 식별하는 기준. 살아 있는 좌석을 잘못 닫지
// 않는 «음성 확인» 포함."
//
// 판정 기준(정직하게 좁힌다 -- coder.md §정직 한계에 그대로 옮길 것):
//   ⑴ "에이전트로 보이는" 좌석인가(seat-census.mjs의 AGENT 또는 AMBIGUOUS
//      -- EMPTY_SHELL은 애초에 처분 대상이 아니므로 후보에서 뺀다).
//   ⑵ seat-origin-registry.mjs 등록부에 이 좌석의 pane key(=tabId:leafId)
//      기록이 «하나도 없는가»(§2 마커 부재 = "배정 0" 대신 이 라운드가 쓸
//      수 있는 유일한 기계 신호 -- 아래 "왜 «배정 0»을 직접 못 재는가" 참고).
// 둘 다 참이면 ORPHAN_CANDIDATE다. 이 도구는 «후보를 보고»만 한다 -- 절대
// 좌석을 닫거나 프로세스를 건드리지 않는다(coder-task.md §4 프로세스
// 불가침, 처분은 ORCH·사람 몫).
//
// 왜 "배정 0"을 직접 재지 못하는가(정직 한계, 실측): Orca의
// `orchestration task-list`는 호출자의 Run에 바인딩된 태스크만 보여준다
// (`run_required` 오류로 실측 확인, 2026-09-16) -- 이 워커 좌석에서
// 시스템 전체의 "지금 배정된 pane key 집합"을 열거할 명령이 없다. 그래서
// "배정 0"의 대리 신호로 "등록부 미기재"를 쓴다: 정본 런처를 거친 좌석은
// 뜨자마자(배달 전에) 등록되므로, 등록이 없다는 것은 최소한 "이 라운드가
// 아는 방식으로는 아무도 이 좌석에 정식 배달을 준비하지 않았다"는 뜻이다
// -- 이것은 "배정 0"의 완전한 동의어가 아니라 근사다(아래 §음성 확인 참고).
//
// §음성 확인(살아 있는 좌석을 잘못 닫지 않기 위한 조치, 비타협):
//   ⓐ 이 도구의 출력은 "닫아라"가 아니라 "확인 후보"다 -- 사람/ORCH가
//      개별적으로 `orca orchestration dispatch-show`나 화면으로 재확인한
//      뒤에만 처분한다.
//   ⓑ 콜드 스타트 갭(§seat-origin-registry.mjs 정직 한계) -- 이 패치
//      이전에 뜬 좌석은 전부 미등록이라 오탐(false positive)이 날 수
//      있다. 이 도구는 그 사실을 출력에 항상 경고로 남긴다.
//   ⓒ EMPTY_SHELL은 애초에 후보에서 제외한다(살아 있는 에이전트를 오인해
//      닫을 위험이 없는 대상만 아예 안전판 밖으로 뺀 것이 아니라, 반대로
//      "에이전트로 보이는" 쪽만 후보로 좁혀 실수로 넓게 잡지 않는다).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { censusSeats, SEAT_KIND } from "./seat-census.mjs";
import { isPaneRegistered } from "./seat-origin-registry.mjs";

export function detectOrphans({ terminals, registryPath }) {
  const census = censusSeats(terminals);
  const candidates = [];
  for (const row of census.rows) {
    if (row.kind === SEAT_KIND.EMPTY_SHELL) continue; // 처분 대상 아님
    if (!row.paneKey) continue; // pane key를 못 구하면 판정 불가(미상)
    const registered = isPaneRegistered(registryPath, row.paneKey);
    if (!registered) {
      candidates.push({ ...row, reason: "UNREGISTERED_PANE" });
    }
  }
  return {
    census,
    orphanCandidates: candidates,
    coldStartWarning:
      "이 패치 이전에 뜬 좌석은 등록부에 없다 -- 후보 목록에 최근 배포 " +
      "이전부터 떠 있던 «정상» 좌석이 섞일 수 있다(콜드 스타트 갭, " +
      "seat-origin-registry.mjs 정직 한계 참고). 닫기 전에 반드시 개별 " +
      "확인하라.",
  };
}

export function formatOrphanReport(result) {
  const lines = [
    `고아 후보(ORPHAN_CANDIDATE): ${result.orphanCandidates.length}건 / 전체 좌석 ${result.census.total}개 중 에이전트+미상 ${result.census.agentCount + result.census.ambiguousCount}개 검사`,
  ];
  for (const c of result.orphanCandidates) {
    lines.push(
      `  - [${c.kind}] ${c.handle}  paneKey=${c.paneKey}  worktree=${c.worktreePath}  title=${c.title}  사유=${c.reason}`,
    );
  }
  lines.push(`⚠️ ${result.coldStartWarning}`);
  lines.push(
    "⛔ 이 목록은 «보고»일 뿐이다 -- 이 도구는 어떤 좌석도 닫지 않는다. " +
      "처분 전 개별 확인(음성 확인)은 사람/ORCH 몫이다.",
  );
  return lines.join("\n");
}

function readTerminalsFromFile(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const terminals = raw?.result?.terminals ?? raw?.terminals ?? raw;
  if (!Array.isArray(terminals)) {
    throw new Error("INVALID_TERMINAL_LIST_JSON");
  }
  return terminals;
}

function parseArgs(argv) {
  const out = {
    terminalListFile: null,
    registryPath: null,
    orcaBin: "orca",
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help") out.help = true;
    else if (a === "--terminal-list-file") out.terminalListFile = argv[++i];
    else if (a === "--registry-path") out.registryPath = argv[++i];
    else if (a === "--orca-bin") out.orcaBin = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

const USAGE =
  "Usage: node seat-orphan-detect.mjs --registry-path <path> [--terminal-list-file <path>] [--json]\n" +
  "Reports (never closes) seats that look like agents but have no matching\n" +
  "seat-origin-registry.mjs record for their pane key.";

export function runSeatOrphanDetectCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { ok: true, help: true };
  if (!parsed.registryPath)
    return { ok: false, reason: "MISSING_REGISTRY_PATH" };
  let terminals;
  if (parsed.terminalListFile) {
    terminals = readTerminalsFromFile(parsed.terminalListFile);
  } else {
    const out = execFileSync(parsed.orcaBin, ["terminal", "list", "--json"], {
      encoding: "utf8",
    });
    const parsedOut = JSON.parse(out);
    if (!parsedOut.ok) {
      return {
        ok: false,
        reason: "TERMINAL_LIST_FAILED",
        detail: parsedOut.error,
      };
    }
    terminals = parsedOut.result.terminals;
  }
  const result = detectOrphans({
    terminals,
    registryPath: parsed.registryPath,
  });
  return { ok: true, result, json: parsed.json };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-orphan-detect.mjs");
if (invokedDirectly) {
  const outcome = runSeatOrphanDetectCli(process.argv.slice(2));
  if (outcome.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!outcome.ok) {
    console.error(`FAILED reason=${outcome.reason}`);
    process.exit(2);
  }
  if (outcome.json) {
    console.log(JSON.stringify(outcome.result));
  } else {
    console.log(formatOrphanReport(outcome.result));
  }
  process.exit(0);
}
