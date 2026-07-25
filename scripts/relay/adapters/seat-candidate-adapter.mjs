// HYK-171-cycle4a1-1: 좌석 "후보 전체" 관측 + versioned 정규화.
//
// PM 반증 (c) 대응 (coder-task.md §1): 기존 resolveSeatHandle(orca-adapter.mjs)
// 은 후보가 2개 이상이면 preview를 아예 안 읽고 즉시 AMBIGUOUS를 반환한다
// -- 죽은 셸 여러 개 사이에 살아있는 agent가 정확히 1개 섞여 있어도 그걸
// 가려낼 방법이 없다(§5 mutation 9/10). 이 파일은 그 대신 "워크트리의
// 모든 후보를 관측하고 각각을 정규화 분류"하는 계약을 낸다 -- 선택은
// 여기서 하지 않는다(선택=seat-readiness.mjs의 judgeSeatReadiness 몫).
//
// S6/G9: `orca` 프로세스를 이 파일이 직접 spawn하지 않는다 -- 명령 빌더/
// 파서는 orca-adapter.mjs의 것만 재사용한다(재구현 금지, 좌석 preview 조회
// 계약은 seat-signal-adapter.mjs와 동형). raw preview 문자열은 이 파일과
// 어댑터 경계 안에만 머문다 -- normalizeSeatCandidate가 코어(seat-readiness.mjs)
// 로 내보내는 값은 {handle, state, occupied, observable}뿐이다.
//
// 정직 경계 (coder-task.md §4 "detector 정확도 UNVERIFIED"): 이 파일이
// 내보내는 createReferenceSeatCandidateDetector()는 실 vendor UI(claude/
// codex TUI) 대상 라이브 표본으로 검증되지 않았다 -- PM이 적시한 마커
// 예시(Sonnet/[CODER]/bypass permissions, gpt-5.6, PS 프롬프트 정규식)를
// 그대로 코드화한 것뿐이며, 캡슐 밖으로 "이게 정답"이라고 주장하지 않는다.
// **자동 적용 0**: normalizeSeatCandidate/collectSeatCandidates 어느
// 것도 이 reference detector를 기본값으로 쓰지 않는다 -- 호출자가
// opts.capabilities로 명시적으로 주입해야만 분류가 일어난다. 주입이
// 없으면 그 후보는 항상 state:"unknown"(capability 부재 = UNKNOWN,
// seat-signal-adapter.mjs CAPABILITY_STATUS 선언 전례 계승) ->
// judgeSeatReadiness가 fail-closed로 UNOBSERVABLE 처리한다.

import {
  buildTerminalListCommand,
  parseTerminalList,
  buildSeatShowCommand,
  parseSeatPreview,
  isOrphanSeat,
  isGhostTab,
  createOrcaExecFn,
} from "./orca-adapter.mjs";

export const SCHEMA_VERSION = 1;

export const CANDIDATE_STATE = Object.freeze({
  AGENT: "agent",
  SHELL: "shell",
  STARTING: "starting",
  IDLE_OR_READY: "idle-or-ready",
  UNKNOWN: "unknown",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

// ---- 순수 분류: 후보 1개의 raw tail(preview 원문)을 정규화 상태로 ----
//
// capabilities: { classify(tail) -> "shell"|"starting"|"idle"|"busy"|null }
// classify가 함수가 아니면(capability 미주입) -> UNKNOWN(observable:false).
// classify가 인식 못 하면(null/그 외 문자열) -> UNKNOWN(observable:false).
//
// occupied: classify와 별개 신호 -- "이미 일하는 좌석 배제"(coder-task.md
// §2, PM 위험 4). idle-or-ready로 분류된 후보에 한해 capabilities.
// detectActiveWork(raw)가 true면 occupied:true를 얹는다(READY pool에서
// 제외되지만 state 자체는 idle-or-ready로 유지 -- "붙여넣기 도착 신호와
// idle 증거를 혼동하지 않는다"는 PM 위험 2 경고를 여기서 재사용하지
// 않는다: previewShowsBusySignal은 이 판정에 관여하지 않는다, 별도
// 개념이다).
export function classifySeatCandidate(raw = {}, capabilities = {}) {
  const r = isPlainObject(raw) ? raw : {};
  const caps = isPlainObject(capabilities) ? capabilities : {};

  if (typeof caps.classify !== "function") {
    return { state: CANDIDATE_STATE.UNKNOWN, occupied: undefined, observable: false };
  }

  let outcome;
  try {
    outcome = caps.classify(r.tail);
  } catch {
    return { state: CANDIDATE_STATE.UNKNOWN, occupied: undefined, observable: false };
  }

  if (outcome === "shell") {
    return { state: CANDIDATE_STATE.SHELL, occupied: undefined, observable: true };
  }
  if (outcome === "starting") {
    return { state: CANDIDATE_STATE.STARTING, occupied: undefined, observable: true };
  }
  if (outcome === "busy") {
    return { state: CANDIDATE_STATE.AGENT, occupied: undefined, observable: true };
  }
  if (outcome === "idle") {
    let occupied = false;
    if (typeof caps.detectActiveWork === "function") {
      try {
        occupied = caps.detectActiveWork(r) === true;
      } catch {
        return { state: CANDIDATE_STATE.UNKNOWN, occupied: undefined, observable: false };
      }
    }
    return {
      state: CANDIDATE_STATE.IDLE_OR_READY,
      occupied,
      observable: true,
    };
  }
  // 인식 못 하는 반환값(오탈자/미래 확장 값 포함) -- 지어내지 않는다,
  // UNKNOWN으로 접는다.
  return { state: CANDIDATE_STATE.UNKNOWN, occupied: undefined, observable: false };
}

// ctx: { handle, tail } (단일 후보). capabilities: 위 classifySeatCandidate
// 참조. 순수 함수(부작용 0) -- schemaVersion을 얹어 내보낸다(§0 "versioned
// 정규화").
export function normalizeSeatCandidate(ctx = {}, capabilities = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const { state, occupied, observable } = classifySeatCandidate(c, capabilities);
  return {
    schemaVersion: SCHEMA_VERSION,
    handle: isNonEmptyString(c.handle) ? c.handle : undefined,
    state,
    occupied,
    observable,
  };
}

// candidates: [{handle, tail}, ...] (raw, 이미 조회된 것 -- 이 함수는
// execFn을 부르지 않는다, 순수). 워크트리의 "후보 전체"를 versioned
// 정규화 배열로 낸다 -- 선택(1개로 좁히기)은 하지 않는다(judgeSeatReadiness
// 몫).
export function normalizeSeatCandidates(candidates, capabilities = {}) {
  if (!Array.isArray(candidates)) return null;
  return candidates.map((c) => normalizeSeatCandidate(c, capabilities));
}

// ---- 수집(impure) 경로: opts.execFn으로 terminal list -> worktreePath
// 일치 후보 전원의 terminal show(tail)를 모아 normalizeSeatCandidates에
// 넘긴다. G9: 명령 빌더/파서는 orca-adapter.mjs 재사용(재구현 금지).
// 고아 좌석(isOrphanSeat)과 유령 탭(isGhostTab)은 애초에 후보에서 뺀다
// -- 이건 "readiness 판정 이전" 필터라 D15 heuristic과 다른 층위다(그
// heuristic이 하던 2+ 즉시-AMBIGUOUS는 여기 없다).
function canonicalizeWorktreePath(p) {
  return typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : "";
}

export function collectSeatCandidates(ctx = {}, opts = {}) {
  const c = isPlainObject(ctx) ? ctx : {};
  const execFn =
    typeof opts.execFn === "function" ? opts.execFn : createOrcaExecFn();
  const capabilities = isPlainObject(opts.capabilities) ? opts.capabilities : {};

  let listResponse;
  try {
    listResponse = execFn(buildTerminalListCommand());
  } catch {
    return null;
  }
  const list = parseTerminalList(listResponse);
  if (!list) return null;

  const target = canonicalizeWorktreePath(c.worktreePath);
  const matches = list.filter(
    (entry) =>
      isPlainObject(entry) &&
      isNonEmptyString(entry.handle) &&
      !isOrphanSeat({ worktreePath: entry.worktreePath }) &&
      !isGhostTab(entry.tabId) &&
      canonicalizeWorktreePath(entry.worktreePath) === target,
  );

  const raw = matches.map((entry) => {
    let showResponse;
    try {
      showResponse = execFn(buildSeatShowCommand(entry.handle));
    } catch {
      return { handle: entry.handle, tail: undefined, showFailed: true };
    }
    const preview = parseSeatPreview(showResponse);
    return {
      handle: entry.handle,
      tail: preview === null ? undefined : preview,
      showFailed: preview === null,
    };
  });

  return raw.map((r) =>
    r.showFailed
      ? {
          schemaVersion: SCHEMA_VERSION,
          handle: r.handle,
          state: CANDIDATE_STATE.UNKNOWN,
          occupied: undefined,
          observable: false,
        }
      : normalizeSeatCandidate(r, capabilities),
  );
}

// ---- reference detector (opt-in only, UNVERIFIED -- 위 파일 헤더 참조) ----
//
// PM이 적시한 마커(coder-task.md §2): claude=Sonnet/[CODER]/[REVIEW]/
// [VERIFY]/bypass permissions, codex=gpt-5.6, 죽은셸=tail이 PS 프롬프트로
// 끝남. §3 비타협: "죽은 셸(tail이 PS 프롬프트로 끝남)은 스크롤백에 옛
// 마커 있어도 shell로 분류"(D15) -- 그래서 아래 판정은 **PS 프롬프트
// 검사를 먼저** 하고, 통과 못 하면 "그 밖의 라인에 마커가 있었는가"를
// 절대 보지 않는다(라인 anchoring: 마지막 비어있지 않은 줄만 본다 --
// substring-only 오탐 방지, §5 mutation 7).
const DEAD_SHELL_PROMPT_RE = /^PS [A-Za-z]:\\.*>\s*$/;
const CLAUDE_AGENT_MARKERS = [
  "Sonnet",
  "Opus",
  "Haiku",
  "[CODER]",
  "[REVIEW]",
  "[VERIFY]",
  "bypass permissions",
];
const CODEX_AGENT_MARKERS = ["gpt-5.6", "codex"];
const IDLE_PROMPT_MARKERS = ["? for shortcuts", "Ctrl+C to exit"];

function lastNonEmptyLine(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== "") return lines[i].trim();
  }
  return "";
}

export function createReferenceSeatCandidateDetector() {
  return {
    classify(tail) {
      const text = typeof tail === "string" ? tail : "";
      const tailLine = lastNonEmptyLine(text);
      // D15 (§3 비타협): PS 프롬프트로 끝나면 무조건 shell -- 스크롤백에
      // agent 마커가 남아 있어도 뒤집지 않는다.
      if (DEAD_SHELL_PROMPT_RE.test(tailLine)) return "shell";
      if (text.trim() === "") return "shell";

      const hasAgentMarker =
        CLAUDE_AGENT_MARKERS.some((m) => text.includes(m)) ||
        CODEX_AGENT_MARKERS.some((m) => text.includes(m));
      if (!hasAgentMarker) return "starting";

      return IDLE_PROMPT_MARKERS.some((m) => text.includes(m))
        ? "idle"
        : "busy";
    },
  };
}
