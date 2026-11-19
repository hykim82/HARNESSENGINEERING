import { getBannerMarkerPattern } from "../check/engine-profile.mjs";

// HYK-402 S1 (seat-role-s1-1) -- 역할 결속 좌석 선별 코어. 순수 함수 · 호출마다
// I/O 0 (모듈 로드 때 엔진 설정 파일을 한 번 읽는다 -- 위 import) · `orca` 호출 0 ·
// 네트워크 0 (입력 = 이미 받아 둔 terminal list 객체 + 등록부 레코드 배열).
//
// 왜 (HYK-402 본문): HYK-400 레인에서 CODER 2R · REVIEW 2R · CODER 3R 이 전부
// 같은 좌석에 배정돼 «작성자와 검토자가 동일 세션»이 됐다. 배달기의 좌석
// 선별(관제실 dispatch-worker.ps1 [1/3])은 `$Role` 을 한 번도 참조하지 않는다.
// 이 파일은 그 선별의 «판단»을 저장소로 가져온다(관제실은 얇은 껍데기 -- HYK-217
// 계열 관례). S1 은 코어 + CLI 까지다: 배달기에 결선하는 일(S2)은 이 라운드가
// 하지 않으므로 이 파일이 있어도 살아 있는 배달은 바뀌지 않는다.
//
// 판정 규칙 (순서가 의미다):
//   1. 이 워크트리의 «등록된 살아 있는 에이전트 좌석»이 2개 이상 -> 거부
//      MULTI_AGENT_SEAT_IN_WORKTREE (어느 역할을 요청하든 · --handle 로도 못 푼다
//      -- «한 워크트리 1 에이전트 좌석» 불변식은 요청이 아니라 워크트리의 성질).
//   2. 미등록인데 preview 가 에이전트처럼 보이는 좌석이 1개라도 있으면 -> 거부
//      UNREGISTERED_AGENT (HYK-211 «판별 불가가 1개라도 있으면 승자 없음» 승계).
//   3. --handle 이 있으면 그 좌석의 등록 역할을 요청 역할과 대조한다.
//   4. 없으면 등록된 에이전트 좌석 1개의 등록 역할이 요청 역할과 같을 때만 선택.
//   빈 pwsh 탭(미등록 · 마커 없음)은 후보에서 조용히 빠진다(D12 회귀 방지).
//
// 역할은 «화면 문자열 추측»이 아니라 등록부(seat-launch-registry.jsonl --
// orca-worker-seat.ps1 가 좌석 기동 직전에 남기는 paneKey -> role 기록)에서만
// 읽는다. preview 는 «에이전트처럼 보이는가» 한 가지에만 쓰이고 역할 판정에는
// 절대 쓰이지 않는다.
//
// 정직 한계 (결과 파일에도 같은 문장):
// - 등록부는 «런처가 정상적으로 기록했을 때»만 있다 -- 손으로 띄운 좌석 · 기록
//   실패 좌석은 미등록이고, 위 규칙 2 에 따라 에이전트처럼 보이면 거부된다
//   (오거부 쪽 = 안전 쪽으로 틀린다).
// - 등록부는 죽은 pane 을 지우지 않는다 -- 살아 있음은 preview tail 이 PS
//   프롬프트인지(D15)로만 판정한다.
// - ORCH 가 `--role` 자체를 틀리게 주면 통과한다(gap#81 과 같은 한계).
// - 이 코어는 `terminal list` 가 «그 순간» 준 목록을 믿는다 -- 목록 이후에
//   생긴 좌석은 보지 못한다(TOCTOU).

export const KNOWN_SEAT_ROLES = Object.freeze([
  "CODER",
  "REVIEW",
  "VERIFY",
  "PM",
]);

export const SEAT_BIND_REASON = Object.freeze({
  MULTI_AGENT_SEAT_IN_WORKTREE: "MULTI_AGENT_SEAT_IN_WORKTREE",
  UNREGISTERED_AGENT: "UNREGISTERED_AGENT",
  ROLE_MISMATCH: "ROLE_MISMATCH",
  NO_SEAT_IN_WORKTREE: "NO_SEAT_IN_WORKTREE",
  NO_AGENT_SEAT: "NO_AGENT_SEAT",
  HANDLE_NOT_IN_WORKTREE: "HANDLE_NOT_IN_WORKTREE",
  HANDLE_SEAT_UNREGISTERED: "HANDLE_SEAT_UNREGISTERED",
  HANDLE_SEAT_NOT_LIVE_AGENT: "HANDLE_SEAT_NOT_LIVE_AGENT",
  HANDLE_ROLE_MISMATCH: "HANDLE_ROLE_MISMATCH",
  REGISTRY_LOAD_FAILED: "REGISTRY_LOAD_FAILED",
  TERMINAL_LIST_INVALID: "TERMINAL_LIST_INVALID",
  INVALID_ROLE: "INVALID_ROLE",
  INVALID_WORKTREE: "INVALID_WORKTREE",
});

// 좌석 하나의 분류 (state).
export const SEAT_STATE = Object.freeze({
  REGISTERED_AGENT: "REGISTERED_AGENT",
  DEAD_SHELL: "DEAD_SHELL",
  UNREGISTERED_AGENT: "UNREGISTERED_AGENT",
  NON_AGENT: "NON_AGENT",
});

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function normalizeRole(role) {
  return typeof role === "string" ? role.trim().toUpperCase() : "";
}

// 배달기(dispatch-worker.ps1 Norm)와 같은 규칙: 역슬래시 -> 슬래시 · 끝 슬래시
// 제거 · 소문자. 빈 값은 빈 문자열(= 어디와도 같지 않다).
export function normalizeWorktreePath(p) {
  if (typeof p !== "string" || p.trim() === "") return "";
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// 배달기 Looks-Like-Agent 와 같은 «모양»의 판정(D12 + D15). 이 함수는 역할
// 판정에 쓰이지 않고 «에이전트처럼 보이는가»에만 쓰인다.
//
// 배너 마커는 여기에 새로 적지 않는다 -- 저장소의 단일 설정(engine-profiles.json
// bannerMarkerPatterns.seatCensusAgentBanner, HYK-153 piece B)에서 읽는다
// (그래서 이 파일에는 엔진 이름 리터럴이 0이다 -- engine-name-literal 허용 목록을
// 늘리지 않는다). 배달기 ps1 의 마커 목록과의 차이 2가지(실측 · 정직 한계):
// ⑴ 설정판은 `Fable` 이 하나 더 있다 ⑵ 설정판은 대소문자를 무시한다 -- PowerShell
// `-match` 도 기본이 대소문자 무시라서 ps1 쪽과 같은 방향이다.
// 이 코어가 «에이전트처럼 보인다»를 배달기보다 조금 더 넓게 볼 수 있다는 뜻이다
// (미등록 에이전트 거부 쪽으로 기운다 = 안전 쪽).
const SHELL_PROMPT_TAIL_RE = /PS [A-Za-z]:\\[^\r\n]*>\s*$/;
const AGENT_MARKER_RE = new RegExp(
  getBannerMarkerPattern("seatCensusAgentBanner"),
  "i",
);

export function endsWithShellPrompt(preview) {
  return typeof preview === "string" && SHELL_PROMPT_TAIL_RE.test(preview);
}

export function looksLikeAgentPreview(preview) {
  if (!isNonEmptyString(preview)) return false;
  if (endsWithShellPrompt(preview)) return false;
  return AGENT_MARKER_RE.test(preview);
}

// tab 단위로 유일한 pane key (dispatch-worker.ps1 `$paneKey`와 같은 모양).
export function paneKeyOf(seat) {
  if (!isPlainObject(seat)) return "";
  if (!isNonEmptyString(seat.tabId) || !isNonEmptyString(seat.leafId))
    return "";
  return `${seat.tabId}:${seat.leafId}`;
}

// 등록부는 append-only 라 같은 pane key 가 여러 번 나올 수 있다(재기동).
// asOfMs 가 없으면 «지금 기준 마지막 등록», 있으면 «그 시각 이전(포함)에 한
// 마지막 등록»(과거 영수증 집계용). launchedAt 이 읽히지 않는 줄은 asOf 모드에서
// 시각을 매길 수 없으므로 후보에서 뺀다. 후보가 비었을 때 «읽을 수 있는 등록 시각이 하나라도
// 있으나 전부 asOf 뒤»면 NOT_YET_REGISTERED(등록이 늦음), «읽을 수 있는 시각이 하나도 없음»이면
// LAUNCHED_AT_UNREADABLE(시각 해석 불가) -- 두 원인을 갈라 둔다(S2 후속 정리 ⓓ).
// -> { status: "FOUND", role } | { status: "NOT_IN_REGISTRY" |
//      "NOT_YET_REGISTERED" | "LAUNCHED_AT_UNREADABLE" | "ROLE_MISSING" }
export function lookupRegisteredRole(records, paneKey, { asOfMs } = {}) {
  const own = (Array.isArray(records) ? records : []).filter(
    (r) =>
      isPlainObject(r) && isNonEmptyString(paneKey) && r.paneKey === paneKey,
  );
  if (own.length === 0) return { status: "NOT_IN_REGISTRY" };
  let eligible = own;
  if (Number.isFinite(asOfMs)) {
    const timed = own.map((r, index) => ({
      r,
      index,
      t: Date.parse(r.launchedAt),
    }));
    eligible = timed
      .filter((x) => Number.isFinite(x.t) && x.t <= asOfMs)
      .sort((a, b) => a.t - b.t || a.index - b.index)
      .map((x) => x.r);
    if (eligible.length === 0) {
      return timed.some((x) => Number.isFinite(x.t))
        ? { status: "NOT_YET_REGISTERED" }
        : { status: "LAUNCHED_AT_UNREADABLE" };
    }
  }
  const role = normalizeRole(eligible[eligible.length - 1].role);
  if (role === "") return { status: "ROLE_MISSING" };
  return { status: "FOUND", role };
}

// terminal list 텍스트 -> { ok:true, terminals } | { ok:false, detail }.
// orca 원본 응답({ok, result:{terminals}}) · 맨 배열 · UTF-8 BOM 모두 받는다.
export function parseTerminalListText(text) {
  const stripped =
    typeof text === "string" && text.charCodeAt(0) === 0xfeff
      ? text.slice(1)
      : text;
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      detail: `terminal list is not valid JSON (${err.message})`,
    };
  }
  const terminals = Array.isArray(parsed) ? parsed : parsed?.result?.terminals;
  if (!Array.isArray(terminals)) {
    return { ok: false, detail: "terminal list has no result.terminals array" };
  }
  return { ok: true, terminals };
}

function classifySeat(seat, registryRecords, asOfMs) {
  const paneKey = paneKeyOf(seat);
  // HYK-402 S2: asOfMs 는 «배달 순간» 판정(decideSeatBindAtDelivery)만 준다.
  // 없으면 지금까지와 똑같이 «지금 기준 마지막 등록»(S1 동작 무변).
  const found = lookupRegisteredRole(
    registryRecords,
    paneKey,
    Number.isFinite(asOfMs) ? { asOfMs } : {},
  );
  const base = { handle: seat.handle, paneKey };
  if (found.status === "FOUND") {
    return {
      ...base,
      role: found.role,
      state: endsWithShellPrompt(seat.preview)
        ? SEAT_STATE.DEAD_SHELL
        : SEAT_STATE.REGISTERED_AGENT,
    };
  }
  return {
    ...base,
    role: null,
    state: looksLikeAgentPreview(seat.preview)
      ? SEAT_STATE.UNREGISTERED_AGENT
      : SEAT_STATE.NON_AGENT,
  };
}

function candidateSeats(terminals, worktree) {
  const target = normalizeWorktreePath(worktree);
  return terminals.filter(
    (t) =>
      isPlainObject(t) &&
      isNonEmptyString(t.handle) &&
      normalizeWorktreePath(t.worktreePath) !== "" &&
      normalizeWorktreePath(t.worktreePath) === target,
  );
}

// 거부·선택 양쪽에서 «어느 좌석이 어떤 역할로 판별됐는지»가 보여야 한다.
export function describeSeat(seat) {
  let label = seat.role;
  if (seat.state === SEAT_STATE.UNREGISTERED_AGENT) label = "UNREGISTERED";
  if (seat.state === SEAT_STATE.NON_AGENT) label = "NON_AGENT";
  return {
    handle: seat.handle,
    paneKey: seat.paneKey,
    role: label,
    state: seat.state,
  };
}

function refuse(reason, detail, seats) {
  return { ok: false, reason, detail, seats: seats.map(describeSeat) };
}

function select(seat, seats) {
  return {
    ok: true,
    handle: seat.handle,
    paneKey: seat.paneKey,
    role: seat.role,
    seats: seats.map(describeSeat),
  };
}

function decideByHandle({ seats, role, handle }) {
  const seat = seats.find((s) => s.handle === handle);
  if (!seat) {
    return refuse(
      SEAT_BIND_REASON.HANDLE_NOT_IN_WORKTREE,
      `handle '${handle}' is not a live seat of this worktree`,
      seats,
    );
  }
  if (seat.state === SEAT_STATE.DEAD_SHELL) {
    return refuse(
      SEAT_BIND_REASON.HANDLE_SEAT_NOT_LIVE_AGENT,
      `handle '${handle}' is registered as ${seat.role} but its screen ends at a shell prompt`,
      seats,
    );
  }
  if (seat.state !== SEAT_STATE.REGISTERED_AGENT) {
    return refuse(
      SEAT_BIND_REASON.HANDLE_SEAT_UNREGISTERED,
      `handle '${handle}' has no seat registry record -- its role cannot be verified`,
      seats,
    );
  }
  if (seat.role !== role) {
    return refuse(
      SEAT_BIND_REASON.HANDLE_ROLE_MISMATCH,
      `handle '${handle}' is registered as ${seat.role}, requested ${role}`,
      seats,
    );
  }
  return select(seat, seats);
}

function decide({ seats, role, handle }) {
  const registered = seats.filter(
    (s) => s.state === SEAT_STATE.REGISTERED_AGENT,
  );
  const unregistered = seats.filter(
    (s) => s.state === SEAT_STATE.UNREGISTERED_AGENT,
  );
  if (registered.length >= 2) {
    return refuse(
      SEAT_BIND_REASON.MULTI_AGENT_SEAT_IN_WORKTREE,
      `${registered.length} registered agent seats share this worktree -- one worktree must hold one agent seat`,
      seats,
    );
  }
  if (unregistered.length >= 1) {
    return refuse(
      SEAT_BIND_REASON.UNREGISTERED_AGENT,
      `${unregistered.length} seat(s) look like an agent but have no seat registry record -- refusing to declare a winner while any agent seat's role is unknown`,
      seats,
    );
  }
  if (isNonEmptyString(handle)) return decideByHandle({ seats, role, handle });
  if (registered.length === 0) {
    return refuse(
      SEAT_BIND_REASON.NO_AGENT_SEAT,
      "no registered live agent seat in this worktree",
      seats,
    );
  }
  if (registered[0].role !== role) {
    return refuse(
      SEAT_BIND_REASON.ROLE_MISMATCH,
      `the only agent seat is registered as ${registered[0].role}, requested ${role}`,
      seats,
    );
  }
  return select(registered[0], seats);
}

// terminals: terminal list 의 terminals 배열. worktree: 대상 워크트리 경로.
// role: 요청 역할. registryRecords: 등록부 레코드 배열. handle: 선택(사람 지정).
// -> { ok:true, handle, paneKey, role, seats } | { ok:false, reason, detail, seats }
export function selectRoleBoundSeat({
  terminals,
  worktree,
  role,
  registryRecords,
  handle,
  asOfMs,
} = {}) {
  const wanted = normalizeRole(role);
  if (!KNOWN_SEAT_ROLES.includes(wanted)) {
    return refuse(
      SEAT_BIND_REASON.INVALID_ROLE,
      `role '${String(role)}' is not one of ${KNOWN_SEAT_ROLES.join("|")}`,
      [],
    );
  }
  if (normalizeWorktreePath(worktree) === "") {
    return refuse(
      SEAT_BIND_REASON.INVALID_WORKTREE,
      "worktree path is empty",
      [],
    );
  }
  const candidates = candidateSeats(
    Array.isArray(terminals) ? terminals : [],
    worktree,
  );
  if (candidates.length === 0) {
    return refuse(
      SEAT_BIND_REASON.NO_SEAT_IN_WORKTREE,
      "no live seat is attached to this worktree",
      [],
    );
  }
  const seats = candidates.map((c) => classifySeat(c, registryRecords, asOfMs));
  return decide({ seats, role: wanted, handle });
}

// ---- 배달 순간 «기록만» 판정 (HYK-402 S2 · 판정 2026-11-18 08:38 ⑤) ------------
//
// 배달 «순간»의 등록부로 S1 선별(selectRoleBoundSeat)을 한 번 돌려, 그 결과를
// 4종 판정으로 옮긴다. 이 함수는 «기록할 값»만 만든다 -- 배달 결과를 바꾸는
// 경로(exit · 좌석 교체 · 배달 중단 · 영수증 기록 거부)는 이 파일 어디에도 없다.
//
//   MATCH       S1 선별이 이 배달을 받아들였다(등록 역할 = 요청 역할).
//   MISMATCH    S1 선별이 «양의 증거»로 거부했다: 등록 역할이 요청과 다르다
//               (ROLE_MISMATCH · HANDLE_ROLE_MISMATCH) 또는 등록된 살아 있는 에이전트
//               좌석이 한 워크트리에 둘 이상이다(MULTI_AGENT_SEAT_IN_WORKTREE --
//               «역할은 맞을 수 있으나 불변식이 깨졌다»; 사유 칸으로 가른다).
//   UNDECIDABLE 판정할 근거가 없다: 등록부 공백 · 등록부 없음 · 그 pane 이 등록부에
//               없음 · 등록이 배달보다 «늦다»(또는 등록 시각을 읽을 수 없다 -- 사유 코드가 갈린다) · 에이전트 좌석 없음 · 미등록 에이전트
//               좌석 · 죽은 셸. ⛔MATCH 로 접지 않는다(거부도 아니다).
//   ERROR       입력이 깨졌다: 알 수 없는 역할 · 워크트리 비어 있음 · terminal list
//               해석 불가 · 등록부 읽기 오류 · 매핑에 없는 거부 사유.
//
// ⛔correction 키 건너뛰기(classifyReceiptBinding)는 «지난 영수증 집계»에만 쓴다.
// 이 함수는 영수증을 받지 않고, 입력에 correction* 키가 있어도 보지 않는다 --
// 판정 2026-11-18 08:38 ⑤(다). 차단 전환의 선행 조건에 «이 규칙 닫기»가 있다.
export const DELIVERY_BIND_VERDICT = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  UNDECIDABLE: "UNDECIDABLE",
  ERROR: "ERROR",
});

const DELIVERY_VERDICT_BY_REFUSAL = Object.freeze({
  [SEAT_BIND_REASON.ROLE_MISMATCH]: DELIVERY_BIND_VERDICT.MISMATCH,
  [SEAT_BIND_REASON.HANDLE_ROLE_MISMATCH]: DELIVERY_BIND_VERDICT.MISMATCH,
  [SEAT_BIND_REASON.MULTI_AGENT_SEAT_IN_WORKTREE]:
    DELIVERY_BIND_VERDICT.MISMATCH,
  [SEAT_BIND_REASON.UNREGISTERED_AGENT]: DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.HANDLE_SEAT_UNREGISTERED]:
    DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.HANDLE_SEAT_NOT_LIVE_AGENT]:
    DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.HANDLE_NOT_IN_WORKTREE]: DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.NO_AGENT_SEAT]: DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.NO_SEAT_IN_WORKTREE]: DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.REGISTRY_LOAD_FAILED]: DELIVERY_BIND_VERDICT.UNDECIDABLE,
  [SEAT_BIND_REASON.TERMINAL_LIST_INVALID]: DELIVERY_BIND_VERDICT.ERROR,
  [SEAT_BIND_REASON.INVALID_ROLE]: DELIVERY_BIND_VERDICT.ERROR,
  [SEAT_BIND_REASON.INVALID_WORKTREE]: DELIVERY_BIND_VERDICT.ERROR,
});

// 영수증 `seat_bind_candidates` 칸 문자열: `<paneKey>=<ROLE|UNREGISTERED|NON_AGENT>/<STATE>`
// 를 쉼표로 이은 것. 기록·사람 눈 확인용이며 판정에는 쓰이지 않는다.
export function formatSeatCandidates(seats) {
  return (Array.isArray(seats) ? seats : [])
    .map((s) => `${s.paneKey || "(none)"}=${s.role}/${s.state}`)
    .join(",");
}

// UNDECIDABLE 의 사유를 «왜 근거가 없는가»로 좁힌다(관측 때 7건 등록부 공백 ·
// 1건 늦은 등록을 가르기 위해). 좁힐 수 없으면 S1 사유를 그대로 쓴다.
function refineUndecidableReason({
  selectReason,
  registryRecords,
  terminals,
  worktree,
  handle,
  deliveredAtMs,
}) {
  const records = Array.isArray(registryRecords) ? registryRecords : [];
  if (records.length === 0) return "REGISTRY_EMPTY";
  if (!isNonEmptyString(handle)) return selectReason;
  const seat = candidateSeats(
    Array.isArray(terminals) ? terminals : [],
    worktree,
  ).find((s) => s.handle === handle);
  if (!seat) return selectReason;
  const found = lookupRegisteredRole(records, paneKeyOf(seat), {
    asOfMs: deliveredAtMs,
  });
  if (found.status === "NOT_YET_REGISTERED")
    return "PANE_REGISTERED_AFTER_DELIVERY";
  if (found.status === "LAUNCHED_AT_UNREADABLE")
    return "PANE_LAUNCHED_AT_UNREADABLE";
  if (found.status === "NOT_IN_REGISTRY") return "PANE_NOT_IN_REGISTRY";
  return selectReason;
}

// -> { verdict, reason, selectReason, candidates, candidateSeats }
// deliveredAtMs: «배달 순간»(밀리초). 없으면 호출 시각(Date.now) -- 이 함수는 배달기가
// 배달 직전에 부르는 용도라 «지금»이 배달 순간이다. 이 시각 «뒤»에 찍힌 등록은
// «아직 등록 안 됨»으로 본다(등록이 배달보다 늦음 = UNDECIDABLE).
export function decideSeatBindAtDelivery({
  terminals,
  worktree,
  role,
  registryRecords,
  handle,
  deliveredAtMs,
} = {}) {
  const at = Number.isFinite(deliveredAtMs) ? deliveredAtMs : Date.now();
  const decision = selectRoleBoundSeat({
    terminals,
    worktree,
    role,
    registryRecords,
    handle,
    asOfMs: at,
  });
  const seatsView = decision.seats ?? [];
  const base = {
    candidateSeats: seatsView,
    candidates: formatSeatCandidates(seatsView),
  };
  if (decision.ok) {
    return {
      verdict: DELIVERY_BIND_VERDICT.MATCH,
      reason: "ROLE_MATCH",
      selectReason: null,
      ...base,
    };
  }
  const verdict =
    DELIVERY_VERDICT_BY_REFUSAL[decision.reason] ?? DELIVERY_BIND_VERDICT.ERROR;
  if (verdict === DELIVERY_BIND_VERDICT.ERROR) {
    return {
      verdict,
      reason: DELIVERY_VERDICT_BY_REFUSAL[decision.reason]
        ? decision.reason
        : `UNMAPPED_REFUSAL_${String(decision.reason)}`,
      selectReason: decision.reason,
      ...base,
    };
  }
  const reason =
    verdict === DELIVERY_BIND_VERDICT.UNDECIDABLE
      ? refineUndecidableReason({
          selectReason: decision.reason,
          registryRecords,
          terminals,
          worktree,
          handle,
          deliveredAtMs: at,
        })
      : decision.reason;
  return { verdict, reason, selectReason: decision.reason, ...base };
}

// ---- 읽기 전용 집계: 지난 영수증 x 등록부 ---------------------------------

export const RECEIPT_VERDICT = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  UNDECIDABLE: "UNDECIDABLE",
  SKIPPED_CORRECTION: "SKIPPED_CORRECTION",
});

function receiptTimeMs(receipt) {
  const recorded = Date.parse(receipt.recorded_at);
  if (Number.isFinite(recorded)) return recorded;
  // 응답 시각은 표시자 없는 UTC 문자열이다("YYYY-MM-DD HH:MM:SS").
  const text = receipt.dispatch_timestamp_utc;
  if (!isNonEmptyString(text)) return NaN;
  return Date.parse(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
}

function verdictOf(kind, reason, receipt, registeredRole = null) {
  return {
    verdict: kind,
    reason,
    dispatchId: isNonEmptyString(receipt?.dispatch_id)
      ? receipt.dispatch_id
      : null,
    registeredRole,
  };
}

// 영수증 1건의 `role`(배달기가 요청한 역할)과 그 시점 등록부의
// `assignee_pane_key -> role` 을 맞댄다. 판정 불가를 일치로 접지 않는다.
export function classifyReceiptBinding(receipt, registryRecords) {
  const r = isPlainObject(receipt) ? receipt : {};
  if (Object.keys(r).some((k) => k.startsWith("correction"))) {
    return verdictOf(RECEIPT_VERDICT.SKIPPED_CORRECTION, "HAND_CORRECTION", r);
  }
  const role = normalizeRole(r.role);
  const undecidable = (reason) =>
    verdictOf(RECEIPT_VERDICT.UNDECIDABLE, reason, r);
  if (role === "") return undecidable("ROLE_MISSING");
  if (!isNonEmptyString(r.assignee_pane_key))
    return undecidable("PANE_KEY_MISSING");
  const asOfMs = receiptTimeMs(r);
  if (!Number.isFinite(asOfMs)) return undecidable("TIME_MISSING");
  const found = lookupRegisteredRole(registryRecords, r.assignee_pane_key, {
    asOfMs,
  });
  if (found.status === "NOT_IN_REGISTRY")
    return undecidable("PANE_NOT_IN_REGISTRY");
  // 지난 자료 집계(S1)는 «시각 해석 불가» 도 예전과 같은 사유 문자열로 둔다(ⓓ 는 배달 순간 판정의 분리 · 집계 무변).
  if (
    found.status === "NOT_YET_REGISTERED" ||
    found.status === "LAUNCHED_AT_UNREADABLE"
  ) {
    return undecidable("PANE_NOT_REGISTERED_AT_DISPATCH");
  }
  if (found.status !== "FOUND") return undecidable("REGISTRY_ROLE_MISSING");
  const kind =
    found.role === role ? RECEIPT_VERDICT.MATCH : RECEIPT_VERDICT.MISMATCH;
  return verdictOf(
    kind,
    kind === RECEIPT_VERDICT.MATCH ? "ROLE_MATCH" : "ROLE_MISMATCH",
    r,
    found.role,
  );
}

function emptyCounts() {
  return { MATCH: 0, MISMATCH: 0, UNDECIDABLE: 0, SKIPPED_CORRECTION: 0 };
}

function earliestLaunchMs(registryRecords) {
  const times = (Array.isArray(registryRecords) ? registryRecords : [])
    .map((r) => Date.parse(r?.launchedAt))
    .filter((t) => Number.isFinite(t));
  return times.length === 0 ? NaN : Math.min(...times);
}

export function summarizeReceiptBindings(receipts, registryRecords) {
  const list = Array.isArray(receipts) ? receipts : [];
  const counts = emptyCounts();
  const sinceRegistryStart = { receipts: 0, counts: emptyCounts() };
  const undecidableByReason = {};
  const mismatchDispatchIds = [];
  const registryStartMs = earliestLaunchMs(registryRecords);
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const receipt of list) {
    const v = classifyReceiptBinding(receipt, registryRecords);
    counts[v.verdict] += 1;
    if (v.verdict === RECEIPT_VERDICT.UNDECIDABLE) {
      undecidableByReason[v.reason] = (undecidableByReason[v.reason] ?? 0) + 1;
    }
    if (v.verdict === RECEIPT_VERDICT.MISMATCH)
      mismatchDispatchIds.push(v.dispatchId);
    const t = receiptTimeMs(isPlainObject(receipt) ? receipt : {});
    if (Number.isFinite(t)) {
      firstMs = Math.min(firstMs, t);
      lastMs = Math.max(lastMs, t);
    }
    if (
      Number.isFinite(t) &&
      Number.isFinite(registryStartMs) &&
      t >= registryStartMs
    ) {
      sinceRegistryStart.receipts += 1;
      sinceRegistryStart.counts[v.verdict] += 1;
    }
  }
  const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    total: list.length,
    counts,
    undecidableByReason,
    mismatchDispatchIds,
    sinceRegistryStart,
    period: {
      first: iso(firstMs),
      last: iso(lastMs),
      registryFirst: iso(registryStartMs),
    },
  };
}
