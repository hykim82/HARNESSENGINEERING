// HYK-472 (coder-task.md §2 -- 배달기가 엔진을 «역할」이 아니라 «좌석 실측」으로
// 정하게 한다). 판단은 여기(저장소 CLI) 몫이고, 관제실
// dispatch-worker.ps1은 이 CLI를 부르고 종료코드/출력으로만 분기하는 얇은
// 껍데기다(HYK-217/HYK-299 계열과 같은 관례).
//
// 계기(coder-task.md §1, ORCH-71 2026-09-16 실측): dispatch-worker.ps1이
// `$engine = if ($Role -eq "REVIEW" -or $Role -eq "PM") { "codex" } else
// { "claude" }`로 «역할」만 보고 엔진을 정했다. 2026-09-15 한용 확정으로
// REVIEW 좌석이 claude 엔진(orca-review-claude-seat.ps1 임시 래퍼)으로
// 뜨는데도 배달기는 여전히 REVIEW=codex로 믿어, ⑴ claude 좌석에 codex용
// 배달 경로(terminal send "go")를 태우고 ⑵ 착수 확인이 codex 세션 폴더를
// 관측해 실물은 정상 완주했는데도 NOT_STARTED(오탐)를 냈다(REVIEW 배달
// 4회 전부 재현).
//
// 이 모듈은 좌석이 실제로 화면에 찍은 배너 텍스트(orca terminal
// list/show의 preview 필드)에서 엔진 고유 마커를 찾는다 -- 역할이 무엇을
// "기대"하는지는 보지 않는다. 마커가 모호하거나(둘 다 매치·둘 다 없음)
// 아직 아무것도 안 찍힌 갓 생긴 좌석이면 엔진을 고르지 않고 거부한다(HYK-472
// 2R: 옛 역할-추정 폴백을 걷어냈다 -- 역할로 추측하면 claude 좌석에 codex
// 배달 경로가 태워지는 사고가 그대로 난다). 거부는 CLI 종료코드 2(기존 실패
// 코드)로 나오며, 배달기(관제실 dispatch-worker.ps1)는 그 비0을 fail-closed로
// 받는다. 기다림은 배달기 쪽 짧은 재시도가 맡는다(패치 문서 참고).

import { readFileSync } from "node:fs";
import {
  matchEngineByPreviewMarkers,
  describePreviewMarkerPatterns,
  getKnownEngines,
} from "./engine-profile.mjs";

// 배너 마커는 실제 CLI가 기동 직후 화면에 찍는, 서로 겹치지 않는 고유
// 문자열만 쓴다(코드 실측 -- 관제실 dispatch-worker.ps1:102의 기존
// Looks-Like-Agent 마커 집합 중 엔진 고유분만 골랐다. `weekly \d`·
// `[CODER]`/`[REVIEW]`는 두 엔진 모두에서 나올 수 있어 제외 -- "에이전트인가"
// 판정과 "어느 엔진인가" 판정은 서로 다른 질문이다).
//
// ★실측 수정(2026-09-16, 이 라운드 자신의 라이브 시험): "MCP startup"은
// 원래 claude 전용 마커로 가정했으나, 실제로 띄운 codex REVIEW 좌석의
// preview에도 "⚠ MCP startup incomplete (failed: linear-server)"가 그대로
// 찍혔다(codex도 MCP 서버를 로드하며 같은 문구를 쓴다) -- claude 전용이
// 아니었다. 넣어 뒀다면 codex 좌석을 claude로 오판정했을 것이다(양쪽
// 마커가 다 매치 -> unknown으로만 떨어지므로 실제 사고로 이어지진
// 않았겠지만, "고유 마커"라는 전제 자체가 거짓이었다). 제거.
//
// HYK-153-engine-profile-1 (piece B): 이 마커 패턴과 "어느 엔진으로
// 판정됐나"의 엔진 이름 자체는 이제 scripts/check/engine-profiles.json
// 한 곳에서 읽는다(matchEngineByPreviewMarkers) -- 이 파일은 엔진 이름
// 리터럴을 전혀 쓰지 않는다(설정이 돌려주는 데이터로만 다룬다).
export function detectSeatEngine(previewText) {
  return matchEngineByPreviewMarkers(previewText) ?? "unknown";
}

export const UNKNOWN_SEAT_ENGINE_REASON = "UNKNOWN_SEAT_ENGINE";

// 실측이 claude/codex 로 나오면 role 과 달라도 실측을 따른다(HYK-472 1R 이
// 고친 사고 형태). 실측이 unknown 이면 엔진을 고르지 않는다 -- role 로 추측
// 하던 옛 폴백(role-fallback-ambiguous-preview)은 2R 에서 걷어냈다: 프로덕션
// 호출자가 없었고, 남겨 두면 다음 호출자가 조용히 다시 쓸 수 있는 문이었다.
export function resolveSeatEngine({ previewText, role }) {
  const measured = detectSeatEngine(previewText);
  if (measured === "unknown") {
    return {
      refused: true,
      reason: UNKNOWN_SEAT_ENGINE_REASON,
      measured,
      role: role ?? null,
      detail: describeUnknown(previewText, role),
    };
  }
  return {
    engine: measured,
    measured,
    source: "measured-preview",
    role: role ?? null,
  };
}

// HYK-153-engine-profile-1 (piece B): the engine names and marker patterns
// quoted in this message now come from config (describePreviewMarkerPatterns)
// -- this file no longer writes "claude"/"codex" as a literal anywhere.
// Display-only: a `\.` regex escape (e.g. codex's "gpt-5\.6") is rendered as
// a plain "." for a human reader, matching this message's pre-config byte
// shape exactly (verified by seat-engine-detect.test.mjs's own assertions).
function describeUnknown(previewText, role) {
  const text = String(previewText ?? "");
  const patterns = describePreviewMarkerPatterns();
  const entries = Object.entries(patterns);
  const matchedCount = entries.filter(
    ([, pattern]) => pattern && new RegExp(pattern).test(text),
  ).length;
  const kind = matchedCount >= 2 ? "BOTH_ENGINE_MARKERS" : "NO_ENGINE_MARKER";
  const markerDesc = entries
    .map(([engine, pattern]) => `${engine}[${pattern.replace(/\\\./g, ".")}]`)
    .join(" / ");
  return (
    `${kind} role=${role ?? "(none)"} preview_chars=${text.length} ` +
    `찾던 마커: ${markerDesc} -- ` +
    "엔진을 추측하지 않고 거부한다"
  );
}

function parseArgs(argv) {
  const out = { previewFile: null, preview: null, role: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help") out.help = true;
    else if (a === "--preview-file") out.previewFile = argv[++i];
    else if (a === "--preview") out.preview = argv[++i];
    else if (a === "--role") out.role = argv[++i];
  }
  return out;
}

// HYK-153-engine-profile-2 (coder-task.md §2 P2-11): exit codes this CLI
// documents and commits to. 0/2 existed before (success / UNKNOWN_SEAT_
// ENGINE refusal); CONFIG_LOAD_FAILED is new -- previously a broken
// engine-profiles.json (unreadable/invalid JSON/invalid schema) threw
// uncaught out of getKnownEngines()/matchEngineByPreviewMarkers (the
// latter reached even via --help, since USAGE itself calls
// getKnownEngines()), crashing with a raw Node stack trace and Node's own
// generic exit 1 -- no documented code, no one-line reason, and not even
// consistently 1 (uncaught-exception exit codes aren't a stable contract).
export const EXIT_CODE = Object.freeze({
  OK: 0,
  UNKNOWN_SEAT_ENGINE: 2,
  CONFIG_LOAD_FAILED: 3,
});
export const ENGINE_PROFILE_CONFIG_FAILURE_REASON =
  "ENGINE_PROFILE_CONFIG_FAILURE";

function buildUsage() {
  return (
    "Usage: node seat-engine-detect.mjs --role <Role> (--preview-file <path> | --preview <text>)\n" +
    "Prints JSON {engine, measured, source, role} on stdout, exit 0.\n" +
    `engine in {${getKnownEngines().join(", ")}}; source = measured-preview.\n` +
    `unknown measurement -> REFUSED: stderr 'FAILED reason=UNKNOWN_SEAT_ENGINE ...', exit ${EXIT_CODE.UNKNOWN_SEAT_ENGINE} (no engine guessed).\n` +
    `engine-profiles.json unreadable/invalid JSON/invalid schema -> stderr 'FAILED reason=<ENGINE_PROFILE_LOAD_REASON or ${ENGINE_PROFILE_CONFIG_FAILURE_REASON}> detail=...', exit ${EXIT_CODE.CONFIG_LOAD_FAILED} (no engine guessed, not a silent default).`
  );
}

export function runSeatEngineDetectCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { ok: true, help: true };
  let previewText = parsed.preview;
  if (previewText === null && parsed.previewFile) {
    try {
      previewText = readFileSync(parsed.previewFile, "utf8");
    } catch (err) {
      return {
        ok: false,
        reason: "PREVIEW_FILE_UNREADABLE",
        detail: err.message,
        exitCode: EXIT_CODE.UNKNOWN_SEAT_ENGINE,
      };
    }
  }
  let result;
  try {
    result = resolveSeatEngine({
      previewText: previewText ?? "",
      role: parsed.role,
    });
  } catch (err) {
    return {
      ok: false,
      reason:
        err && err.name === "EngineProfileLoadError"
          ? err.reason
          : ENGINE_PROFILE_CONFIG_FAILURE_REASON,
      detail: err.message,
      exitCode: EXIT_CODE.CONFIG_LOAD_FAILED,
    };
  }
  if (result.refused) {
    return {
      ok: false,
      reason: result.reason,
      detail: result.detail,
      exitCode: EXIT_CODE.UNKNOWN_SEAT_ENGINE,
    };
  }
  return { ok: true, result };
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1]
    .replace(/\\/g, "/")
    .endsWith("scripts/check/seat-engine-detect.mjs");
if (invokedDirectly) {
  try {
    const outcome = runSeatEngineDetectCli(process.argv.slice(2));
    if (outcome.help) {
      console.log(buildUsage());
      process.exit(EXIT_CODE.OK);
    }
    if (!outcome.ok) {
      console.error(
        `FAILED reason=${outcome.reason} detail=${outcome.detail ?? ""}`,
      );
      process.exit(outcome.exitCode ?? EXIT_CODE.UNKNOWN_SEAT_ENGINE);
    }
    console.log(JSON.stringify(outcome.result));
    process.exit(EXIT_CODE.OK);
  } catch (err) {
    // HYK-153-engine-profile-3 (review-4 §3 P2-E): the --help path reaches
    // buildUsage() -> getKnownEngines() above, which throws the same
    // EngineProfileLoadError a broken config throws on the execution path
    // (runSeatEngineDetectCli already narrows that to its specific reason,
    // see the try/catch inside it) -- this outer catch used to collapse
    // every escaping error to the generic ENGINE_PROFILE_CONFIG_FAILURE_REASON,
    // so --help on a broken config reported a less specific reason than the
    // same broken config's normal run. Same narrowing here closes that gap.
    const reason =
      err && err.name === "EngineProfileLoadError"
        ? err.reason
        : ENGINE_PROFILE_CONFIG_FAILURE_REASON;
    console.error(`FAILED reason=${reason} detail=${err.message}`);
    process.exit(EXIT_CODE.CONFIG_LOAD_FAILED);
  }
}
