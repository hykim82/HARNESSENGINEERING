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
  if (trimmed === "") return SEAT_KIND.EMPTY_SHELL;
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
    lines.push(
      `  - [${r.kind}] ${r.handle}  worktree=${r.worktreePath}  title=${r.title}`,
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

function parseArgs(argv) {
  const out = {
    terminalListFile: null,
    enrich: false,
    orcaBin: "orca",
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help") out.help = true;
    else if (a === "--terminal-list-file") out.terminalListFile = argv[++i];
    else if (a === "--enrich") out.enrich = true;
    else if (a === "--orca-bin") out.orcaBin = argv[++i];
    else if (a === "--json") out.json = true;
  }
  return out;
}

const USAGE =
  "Usage: node seat-census.mjs [--terminal-list-file <path>] [--enrich] [--orca-bin <path>] [--json]\n" +
  "Without --terminal-list-file, runs `orca terminal list --json` live.\n" +
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
