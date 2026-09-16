// HYK-464 (coder-task.md §3 항목 5): "«좌석 수」의 정본을 한 곳으로 -- 에이전트
// 좌석과 빈 셸이 같은 목록에서 구분되게. 인계서·STATUS의 «좌석 N」이 무엇을
// 센 숫자인지 명시되게."
//
// 왜 새로 만들었나(중복 아님, 정직 한계로 남긴다): 관제실 dispatch-worker.ps1의
// 기존 Looks-Like-Agent 함수(102행)는 "이 워크트리 안 여러 후보 중 방금 막
// 뜬 진짜 에이전트가 어느 것인가"라는 좁은 질문(AMBIGUOUS 해소, 갓 생긴
// 좌석이 전제라 배너가 아직 preview 안에 남아 있다)에 맞춰져 있다. 이
// 모듈의 질문은 다르다: "지금 떠 있는 모든 좌석을 세었을 때, 오래 실행된
// 에이전트도 포함해 에이전트/빈 셸을 가른다" -- 오래 실행된 에이전트는
// 배너 마커가 스크롤백 밖으로 밀려나 preview(짧은 꼬리)에 안 남을 수 있다
// (실측: 이 라운드 자신을 부팅한 ORCH 좌석의 현재 preview에 배너 마커가
// 하나도 없다 -- 활발히 일하는 실제 에이전트인데도). 그래서 이 모듈은
// Looks-Like-Agent와 같은 마커 집합을 "확실한 에이전트" 신호로 재사용하되
// (판단 로직은 여기 하나로 합치지 않는다 -- ps1의 그 함수는 이 라운드
// 범위 밖이라 손대지 않는다, 아래 §정직한계 참고), 마커가 없다고 곧바로
// "빈 셸"로 단정하지 않는다. 대신 "완전히 비어 있음"(프롬프트 한 줄뿐,
// 다른 산출물이 전혀 없음)만 확실한 "빈 셸" 신호로 인정하고, 그 사이
// (마커도 없고 완전히 비지도 않은) 구간은 AMBIGUOUS로 정직하게 남겨
// 사람/추가 조회(seat-census.mjs의 라이브 enrichment, --terminal-read 참고)
// 몫으로 돌린다 -- 억지로 이분류하면 오분류가 조용히 숨는다.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readRegistryDiagnostics } from "./seat-origin-registry.mjs";

export const AGENT_BANNER_MARKERS =
  /gpt-5\.6|Sonnet|Opus|Fable|\[CODER\]|\[REVIEW\]|bypass permissions|MCP startup|weekly \d/i;

// 관제실 dispatch-worker.ps1:101의 "죽은 셸" 정규식과 의도적으로 동일하게
// 맞춘다(D15) -- 프롬프트로 "끝나는" 것이 아니라 이 함수에서는 프리뷰
// 전체가 "오직" 프롬프트 한 줄뿐인지를 본다(더 엄격 -- 아래 참고).
const BARE_PROMPT_LINE = /^PS [A-Za-z]:\\.*>\s*$/;

export const SEAT_KIND = Object.freeze({
  AGENT: "agent",
  EMPTY_SHELL: "empty_shell",
  AMBIGUOUS: "ambiguous",
});

export function classifySeatText(text) {
  const trimmed = String(text ?? "").trim();
  // HYK-464 추기 수리: "증거 없음"(preview가 비었다 -- 아직 못 읽었거나
  // 스크롤백이 유실됐을 수 있다)과 "빈 셸이라는 증거"(프롬프트 한 줄뿐인
  // 스크롤백을 실제로 읽었다)는 다르다. 예전 코드는 이 둘을 뭉뚱그려
  // trimmed===""을 EMPTY_SHELL로 단정했는데, 실측(2026-09-16 ORCH-71)으로
  // 살아 있는 ORCH 에이전트 좌석의 preview가 비어 있었던 사례가 나왔다 --
  // 그 좌석을 "빈 셸"로 잘못 접으면 사람이 그 근거로 살아 있는 좌석을
  // 끌 수 있다(되돌릴 수 없다). 그래서 증거가 전혀 없으면 AMBIGUOUS로
  // 정직하게 남긴다(아래 fallthrough) -- "빈 셸" 판정은 실제 프롬프트
  // 텍스트(BARE_PROMPT_LINE)를 읽었을 때만 내린다.
  if (trimmed === "") return SEAT_KIND.AMBIGUOUS;
  if (AGENT_BANNER_MARKERS.test(trimmed)) return SEAT_KIND.AGENT;
  // "완전히 빈 셸" = 스크롤백 전체가 프롬프트 한 줄뿐(다른 줄 없음). 여러
  // 줄이더라도 전부 빈 프롬프트 반복이면 여전히 미사용 셸이다.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length > 0 && lines.every((l) => BARE_PROMPT_LINE.test(l.trim()))) {
    return SEAT_KIND.EMPTY_SHELL;
  }
  return SEAT_KIND.AMBIGUOUS;
}

export function classifySeat(terminal) {
  return classifySeatText(terminal?.preview);
}

export function censusSeats(terminals) {
  const rows = (terminals ?? []).map((t) => ({
    handle: t.handle,
    worktreePath: t.worktreePath ?? "",
    title: t.title ?? "",
    paneKey: t.tabId && t.leafId ? `${t.tabId}:${t.leafId}` : null,
    kind: classifySeat(t),
  }));
  const counts = { agent: 0, empty_shell: 0, ambiguous: 0 };
  for (const r of rows) counts[r.kind] += 1;
  return {
    total: rows.length,
    agentCount: counts.agent,
    emptyShellCount: counts.empty_shell,
    ambiguousCount: counts.ambiguous,
    rows,
  };
}

export function formatCensus(census) {
  const lines = [
    `좌석 수(정본): 전체=${census.total} · 에이전트=${census.agentCount} · 빈셸=${census.emptyShellCount} · 미상=${census.ambiguousCount}`,
  ];
  for (const r of census.rows) {
    const registryTag = r.registryNote ? "  [registry-guard]" : "";
    lines.push(
      `  - [${r.kind}] ${r.handle}  worktree=${r.worktreePath}  title=${r.title}${registryTag}`,
    );
  }
  if (census.ambiguousCount > 0) {
    lines.push(
      "  (미상 항목은 preview 꼬리에 확실한 신호가 없다 -- 배너가 " +
        "스크롤백 밖으로 밀려난 오래된 에이전트일 수 있다. " +
        "`orca terminal read --terminal <handle> --limit 400 --json`로 더 " +
        "긴 이력을 읽어 사람이 확인하라. --enrich 플래그로 이 스크립트가 " +
        "직접 그 조회를 하게 할 수도 있다.)",
    );
  }
  if (census.registryOverrideCount > 0) {
    lines.push(
      `  (등록부 보강: ${census.registryOverrideCount}건이 빈 셸로 보였지만 ` +
        "seat-origin-registry에 등록된 pane이라 미상으로 재분류됐다 -- " +
        "각 행의 [registry-guard] 표시 참고.)",
    );
  }
  if (census.registryCorruptedLineCount > 0) {
    lines.push(
      `⛔ 등록부(seat-origin-registry) 손상 줄 ${census.registryCorruptedLineCount}건 ` +
        "발견 -- 그만큼의 등록 기록이 조회에서 누락됐을 수 있다(P2-1: 등록 " +
        "실패를 조용히 지나가지 않게 표시한다). 사람이 확인하라.",
    );
  }
  return lines.join("\n");
}

function readTerminalsFromFile(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const terminals = raw?.result?.terminals ?? raw?.terminals ?? raw;
  if (!Array.isArray(terminals)) {
    throw new Error(
      "INVALID_TERMINAL_LIST_JSON: expected .result.terminals[] (orca terminal list --json shape) or a bare array",
    );
  }
  return terminals;
}

// 좌석 하나의 더 긴 스크롤백을 읽어와 재분류용 텍스트로 편다. 읽기
// 자체가 실패하면(좌석이 그새 닫혔다 등) 그대로 던진다 -- 호출부
// (enrichAmbiguous)가 그 좌석 한 건만 실패로 기록하고 나머지는 계속
// 처리한다(복잡도 축소를 위한 분리).
function readSeatTailForReclassification(handle, { orcaBin, limit }) {
  const out = execFileSync(
    orcaBin,
    [
      "terminal",
      "read",
      "--terminal",
      handle,
      "--limit",
      String(limit),
      "--json",
    ],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  return (parsed?.result?.lines ?? parsed?.result?.text ?? []).toString();
}

function recountCensus(census) {
  const counts = { agent: 0, empty_shell: 0, ambiguous: 0 };
  for (const r of census.rows) counts[r.kind] += 1;
  census.agentCount = counts.agent;
  census.emptyShellCount = counts.empty_shell;
  census.ambiguousCount = counts.ambiguous;
  return census;
}

// 라이브 enrichment: AMBIGUOUS로 남은 좌석만, 더 긴 스크롤백을 읽어
// 재분류한다. orca 바이너리가 없는 환경(CI)에서는 이 경로를 타지 않는다
// (테스트는 순수 함수 classifySeatText/censusSeats만 부른다).
function enrichAmbiguous(census, { orcaBin = "orca", limit = 400 } = {}) {
  for (const row of census.rows) {
    if (row.kind !== SEAT_KIND.AMBIGUOUS || !row.handle) continue;
    try {
      const text = readSeatTailForReclassification(row.handle, {
        orcaBin,
        limit,
      });
      const reclassified = classifySeatText(text);
      if (reclassified !== SEAT_KIND.AMBIGUOUS) {
        row.kind = reclassified;
        row.enrichedVia = "terminal-read";
      }
    } catch (err) {
      row.enrichError = err.message;
    }
  }
  return recountCensus(census);
}

// HYK-464 §2 범위 A 항목 2 -- 등록부 교차 보강: seat-origin-registry에
// 그 pane key가 등록돼 있으면(=정본 런처 orca-worker-seat.ps1이 띄운
// 좌석이면) 그 좌석은 빈 셸일 수 없다. classifySeatText 단독은 preview
// 스냅숏 하나만 보므로(§2-1 수리 이후에도), 마침 그 스냅숏이 우연히
// BARE_PROMPT_LINE 모양이거나(대화형 UI 오버레이라 실제 pty 스크롤백이
// 프롬프트만 남는 경우, 실측 ORCH-71 원인 정황) --enrich가 긴 스크롤백을
// 읽고서도 같은 모양으로 재분류하면 여전히 "빈 셸"로 오판될 수 있다 --
// 그래서 이 보강은 --enrich 뒤에도 적용해 두 경로 다 방어한다(runSeatCensusCli
// 참고). 등록부에 없다고 "빈 셸"로 단정하지는 않는다(그건 §3 orphan
// 판별 몫 -- seat-orphan-detect.mjs) -- 이 함수는 EMPTY_SHELL을
// AMBIGUOUS로 "내리는" 방향으로만 쓴다(fail-closed 강화, 반대 방향 없음).
export function applyRegistryGuard(census, registryPath) {
  if (!registryPath) return census;
  const { records, corruptedLineCount } = readRegistryDiagnostics(registryPath);
  const registeredPaneKeys = new Set(records.map((r) => r.paneKey));
  let overrideCount = 0;
  for (const row of census.rows) {
    if (
      row.kind === SEAT_KIND.EMPTY_SHELL &&
      row.paneKey &&
      registeredPaneKeys.has(row.paneKey)
    ) {
      row.kind = SEAT_KIND.AMBIGUOUS;
      row.registryNote =
        "REGISTERED_PANE_CANNOT_BE_EMPTY_SHELL: preview looked like a bare " +
        "shell prompt, but this pane key appears in seat-origin-registry " +
        "(launched by orca-worker-seat.ps1) -- downgraded to ambiguous for " +
        "human check instead of trusting the empty-shell read.";
      overrideCount += 1;
    }
  }
  recountCensus(census);
  census.registryOverrideCount = overrideCount;
  // P2-1: 등록 실패(=손상된 줄)가 조용히 지나가지 않도록 개수를 census에
  // 실어 formatCensus/--json 양쪽 출력에 드러낸다.
  census.registryCorruptedLineCount = corruptedLineCount;
  return census;
}

function parseArgs(argv) {
  const out = {
    terminalListFile: null,
    enrich: false,
    orcaBin: "orca",
    registryPath: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help") out.help = true;
    else if (a === "--terminal-list-file") out.terminalListFile = argv[++i];
    else if (a === "--enrich") out.enrich = true;
    else if (a === "--orca-bin") out.orcaBin = argv[++i];
    else if (a === "--registry-path") out.registryPath = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

const USAGE =
  "Usage: node seat-census.mjs [--terminal-list-file <path>] [--enrich] [--orca-bin <path>] [--registry-path <path>] [--json]\n" +
  "Without --terminal-list-file, runs `orca terminal list --json` live.\n" +
  "--registry-path (optional): cross-check seat-origin-registry -- a pane\n" +
  "registered there can never be reported empty_shell (downgraded to\n" +
  "ambiguous instead); a corrupted registry line count is surfaced too.\n" +
  'Classifies every live seat as agent / empty_shell / ambiguous -- single source of truth for "seat count N".';

export function runSeatCensusCli(argv, { orcaBin: defaultOrcaBin } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { ok: true, help: true };
  let terminals;
  if (parsed.terminalListFile) {
    terminals = readTerminalsFromFile(parsed.terminalListFile);
  } else {
    const bin = parsed.orcaBin ?? defaultOrcaBin ?? "orca";
    const out = execFileSync(bin, ["terminal", "list", "--json"], {
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
  let census = censusSeats(terminals);
  if (parsed.enrich && !parsed.terminalListFile) {
    census = enrichAmbiguous(census, { orcaBin: parsed.orcaBin });
  }
  if (parsed.registryPath) {
    census = applyRegistryGuard(census, parsed.registryPath);
  }
  return { ok: true, census, json: parsed.json };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/seat-census.mjs");
if (invokedDirectly) {
  const outcome = runSeatCensusCli(process.argv.slice(2));
  if (outcome.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!outcome.ok) {
    console.error(`FAILED reason=${outcome.reason}`);
    process.exit(2);
  }
  if (outcome.json) {
    console.log(JSON.stringify(outcome.census));
  } else {
    console.log(formatCensus(outcome.census));
  }
  process.exit(0);
}
