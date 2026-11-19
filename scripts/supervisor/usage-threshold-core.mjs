// HYK-406 조각 A (HYK-406-usage-watch-1) -- 예약 감시 사용량 임계 축의 순수 판정.
//
// ⛔⭐OBSERVER 이다 -- 앵커(위조 불가 기준점)가 아니다. 이 판정이 읽는 원천은
// 상태줄 생성기(harness-hud.mjs)가 사용자 권한으로 쓰는 JSON 파일
// (`<HUD 디렉터리>/ratelimit-<역할>.json`) 뿐이고, 그 파일은 ORCH 도 같은
// 사용자 권한으로 덮어쓸 수 있다. 그래서 이 축의 «정상» 은 «ORCH 가 정상이다»
// 의 증거가 아니다. 이 축은 «경계에 들어섰다 / 값이 낡았다 / 읽을 수 없다» 를
// 사람 눈 없이 미리 알리는 용도로만 쓴다.
//
// 정직 한계(이 파일 머리 · scripts/check/enforcement-inventory.json ·
// docs/enforcement-known-gaps.md 에 같은 문면):
//  1. 위조 차단 0 -- HUD 파일은 ORCH 도 쓸 수 있다(OBSERVER · 앵커 아님).
//  2. 감지는 최대 15분(예약 주기) + HUD 갱신 간격만큼 늦다. ctx 65→75 를 한
//     주기 안에 건너뛸 수 있다(그 경우 통지는 75 띠 1장이다).
//  3. HUD 는 좌석이 활동할 때만 갱신된다 -- 유휴 ORCH 의 값은 낡을 뿐 틀리지
//     않는다. 그래서 60분 넘게 갱신이 없으면 «낡음» 으로 따로 알린다.
//  4. 같은 역할의 좌석 둘은 같은 파일에 마지막 값으로 덮어쓴다(ctx 는 ORCH 만
//     판정하므로 무해하지만, wk 는 «가장 신선한 파일» 이라 어느 좌석 값인지
//     구별되지 않는다).
//  5. 벤더가 필드를 빼면 «관측 불가» 로 떨어진다. 0% 로 접지 않는다.
//  6. env(HARNESS_ROLE) 없이 뜬 ORCH 좌석은 ratelimit-NOROLE.json 에 쓴다 --
//     ORCH 파일이 조용히 낡는다. 낡음 통지가 «더 새로운 역할 없는 파일이
//     있다» 를 함께 말한다(판정 2041 ② 범위 확장). 그 파일의 ctx 는 어느
//     좌석 것인지 알 수 없어 ORCH ctx 판정에 섞지 않는다.
//  7. wk(주간) 는 «값이 있는 파일 중 가장 신선한 것» 이다. 오래 비어 있던
//     좌석 집합에서는 며칠 전 값일 수 있다 -- 통지문과 watch.log 에 그 값의
//     나이를 항상 싣는다(낡음 띠는 ORCH 파일 하나에만 건다).
//
// 모든 함수는 순수 -- I/O 0 · 시계 읽기 0 (now 는 인자).
// Node 20 호환 -- ESM 표준 API 만.

export const ORCH_ROLE = "ORCH";
export const NOROLE_KEY = "NOROLE";
// ORCH 파일의 `at` 이 이보다 오래되면 STALE (판정 2041 · 60분).
export const STALE_AFTER_MS = 60 * 60 * 1000;
// 시계 어긋남 허용 -- `at` 이 이보다 더 미래면 믿지 않는다(관측 불가).
export const FUTURE_SKEW_MS = 5 * 60 * 1000;

export const CTX_BANDS = Object.freeze({
  OK: "OK",
  C65: "ctx65",
  C75: "ctx75",
});
export const WK_BANDS = Object.freeze({ OK: "OK", W90: "wk90", W95: "wk95" });
export const ALERTS = Object.freeze({
  STALE: "STALE",
  UNOBSERVABLE: "UNOBSERVABLE",
});
export const KIND = Object.freeze({
  OBSERVED: "OBSERVED",
  STALE: ALERTS.STALE,
  UNOBSERVABLE: ALERTS.UNOBSERVABLE,
});

const CTX_RANK = { OK: 0, ctx65: 1, ctx75: 2 };
const WK_RANK = { OK: 0, wk90: 1, wk95: 2 };

export function ctxBandOf(value) {
  if (value >= 75) return CTX_BANDS.C75;
  if (value >= 65) return CTX_BANDS.C65;
  return CTX_BANDS.OK;
}

export function wkBandOf(value) {
  if (value >= 95) return WK_BANDS.W95;
  if (value >= 90) return WK_BANDS.W90;
  return WK_BANDS.OK;
}

// 퍼센트 필드 -- 유한한 0..100 숫자만 값으로 인정한다. null · 문자열 · NaN ·
// 범위 밖은 전부 «값 없음(null)» 이다 -- ⛔0 으로 접지 않는다.
export function pctOrNull(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0 || raw > 100) return null;
  return raw;
}

// pctOrNull 이 null 로 접는 값 중 «유한한 숫자인데 0..100 밖» 인 것만 그 값을 돌려준다
// (없으면 null). 사유 문구를 «값이 비었다» 와 «범위 밖» 으로 가르기 위한 판별이다 --
// 이 값으로 판정을 바꾸지 않는다(HYK-406-wk-gate-1 · 조각 A 검토 P2-1).
export function outOfRangePct(raw) {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return raw < 0 || raw > 100 ? raw : null;
}

// 파일 한 개 -> 정규화된 표본. raw 는 파일 텍스트(읽기 실패면 null),
// readError 는 읽기 실패 사유 토큰(없으면 null).
export function parseSnapshot({ role, raw, readError }) {
  const base = {
    role,
    readable: false,
    reason: null,
    atMs: null,
    ctx: null,
    fiveHour: null,
    sevenDay: null,
    ctxOutOfRange: null,
    sevenDayOutOfRange: null,
  };
  if (readError) return { ...base, reason: readError };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...base, reason: "깨진 JSON(쓰는 도중에 읽었을 수 있다)" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...base, reason: "JSON 이 객체가 아님" };
  }
  const atMs = typeof parsed.at === "string" ? Date.parse(parsed.at) : NaN;
  return {
    ...base,
    readable: true,
    atMs: Number.isNaN(atMs) ? null : atMs,
    ctx: pctOrNull(parsed.ctx),
    fiveHour: pctOrNull(parsed.five_hour),
    sevenDay: pctOrNull(parsed.seven_day),
    ctxOutOfRange: outOfRangePct(parsed.ctx),
    sevenDayOutOfRange: outOfRangePct(parsed.seven_day),
  };
}

function minutes(ms) {
  return Math.max(0, Math.round(ms / 60000));
}

// ORCH 컨텍스트 판정. ORCH 파일 하나만 본다(다른 파일의 ctx 는 섞지 않는다).
export function judgeOrchCtx({ orch, nowMs }) {
  if (!orch || !orch.readable) {
    return {
      kind: KIND.UNOBSERVABLE,
      reason: orch?.reason ?? "ORCH 파일 없음",
    };
  }
  if (orch.atMs === null) {
    return {
      kind: KIND.UNOBSERVABLE,
      reason: "ORCH 파일에 at(시각)이 없거나 형식이 틀림",
    };
  }
  const ageMs = nowMs - orch.atMs;
  if (ageMs > STALE_AFTER_MS) {
    return { kind: KIND.STALE, ageMs, atMs: orch.atMs, ctx: orch.ctx };
  }
  if (ageMs < -FUTURE_SKEW_MS) {
    return {
      kind: KIND.UNOBSERVABLE,
      reason: "ORCH 파일의 at 이 미래 시각이다(시계 어긋남)",
    };
  }
  if (orch.ctx === null) {
    // 범위 밖(예: transcript 추정 경로의 100 넘는 값)은 «비었다» 가 아니다 -- 사유를 가른다.
    if (orch.ctxOutOfRange !== null) {
      return {
        kind: KIND.UNOBSERVABLE,
        reason: `ORCH 파일의 ctx 값이 범위 밖이다(0..100 아님: ${orch.ctxOutOfRange})`,
      };
    }
    return {
      kind: KIND.UNOBSERVABLE,
      reason: "ORCH 파일의 ctx 값이 비었다(null)",
    };
  }
  return {
    kind: KIND.OBSERVED,
    band: ctxBandOf(orch.ctx),
    value: orch.ctx,
    ageMs: Math.max(0, ageMs),
    atMs: orch.atMs,
  };
}

// 값이 있고 at 이 믿을 만한 파일 중 가장 신선한 것 한 개를 고른다.
function pickFreshest(snaps, field, nowMs) {
  let best = null;
  for (const s of snaps) {
    if (!s.readable || s.atMs === null || s[field] === null) continue;
    if (s.atMs - nowMs > FUTURE_SKEW_MS) continue;
    if (best === null || s.atMs > best.atMs) best = s;
  }
  return best;
}

// 주간(wk) -- 모든 역할 파일 중 값이 있는 가장 신선한 것(지갑은 하나다).
export function judgeWeekly({ snaps, nowMs }) {
  const best = pickFreshest(snaps, "sevenDay", nowMs);
  if (best === null) {
    const readable = snaps.filter((s) => s.readable).length;
    const outOfRange = snaps
      .filter((s) => s.readable && s.sevenDayOutOfRange !== null)
      .map((s) => `${s.role}=${s.sevenDayOutOfRange}`);
    const rangeNote =
      outOfRange.length > 0
        ? ` · seven_day 값이 범위 밖(0..100 아님)인 파일: ${outOfRange.join(", ")}`
        : "";
    return {
      kind: KIND.UNOBSERVABLE,
      reason: `읽을 수 있는 파일 ${readable}개 · 파일 ${snaps.length}개 중 seven_day 값이 있는 것이 없다${rangeNote}`,
    };
  }
  return {
    kind: KIND.OBSERVED,
    band: wkBandOf(best.sevenDay),
    value: best.sevenDay,
    role: best.role,
    ageMs: Math.max(0, nowMs - best.atMs),
    atMs: best.atMs,
  };
}

// 5h -- 기록만 한다(통지 0). 없으면 null(접지 않는다).
export function judgeFiveHour({ snaps, nowMs }) {
  const best = pickFreshest(snaps, "fiveHour", nowMs);
  if (best === null) return null;
  return {
    value: best.fiveHour,
    role: best.role,
    atMs: best.atMs,
    ageMs: Math.max(0, nowMs - best.atMs),
  };
}

// env 없이 뜬 좌석(NOROLE 파일)이 ORCH 파일보다 새로운가 -- 낡음/관측 불가
// 통지문에서 구별하기 위한 힌트. ORCH 파일이 없거나 at 이 없는 경우에도
// NOROLE 파일이 믿을 만한 at 을 가지면 힌트를 준다.
export function norolePresence({ snaps, orch }) {
  const norole = snaps.find((s) => s.role === NOROLE_KEY);
  if (!norole || !norole.readable || norole.atMs === null) return null;
  const orchAt = orch && orch.readable ? orch.atMs : null;
  if (orchAt !== null && norole.atMs <= orchAt) return null;
  return { atMs: norole.atMs, ctx: norole.ctx };
}

function stepAxis({ prevBand, prevAlert, judged, rank }) {
  if (judged.kind === KIND.OBSERVED) {
    const rising = rank[judged.band] > rank[prevBand];
    const falling = rank[judged.band] < rank[prevBand];
    return {
      band: judged.band,
      alert: null,
      event: rising ? { kind: "BAND", band: judged.band } : null,
      descent: falling ? { from: prevBand, to: judged.band } : null,
      recovered: prevAlert !== null,
    };
  }
  // STALE / UNOBSERVABLE -- 새로 들어섰을 때만 사건이다(같은 알림이 이어지면 0).
  const entered = prevAlert !== judged.kind;
  return {
    band: prevBand,
    alert: judged.kind,
    event: entered ? { kind: judged.kind } : null,
    descent: null,
    recovered: false,
  };
}

const EMPTY_STATE = Object.freeze({
  version: 1,
  ctxBand: CTX_BANDS.OK,
  ctxAlert: null,
  wkBand: WK_BANDS.OK,
  wkAlert: null,
  fiveHour: null,
});

export function normalizeState(raw) {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE };
  return {
    version: 1,
    ctxBand: raw.ctxBand in CTX_RANK ? raw.ctxBand : CTX_BANDS.OK,
    ctxAlert:
      raw.ctxAlert === ALERTS.STALE || raw.ctxAlert === ALERTS.UNOBSERVABLE
        ? raw.ctxAlert
        : null,
    wkBand: raw.wkBand in WK_RANK ? raw.wkBand : WK_BANDS.OK,
    wkAlert: raw.wkAlert === ALERTS.UNOBSERVABLE ? raw.wkAlert : null,
    fiveHour:
      raw.fiveHour && typeof raw.fiveHour === "object" ? raw.fiveHour : null,
  };
}

// 이전 상태 + 이번 판정 -> 다음 상태 + «띠에 들어선» 사건들.
// 같은 띠 반복 = 사건 0. 띠 하강 = 통지 없이 상태만 낮춘다(descents 에 기록).
export function decideTransitions({ prevState, ctx, wk, fiveHour, norole }) {
  const prev = normalizeState(prevState);
  const c = stepAxis({
    prevBand: prev.ctxBand,
    prevAlert: prev.ctxAlert,
    judged: ctx,
    rank: CTX_RANK,
  });
  const w = stepAxis({
    prevBand: prev.wkBand,
    prevAlert: prev.wkAlert,
    judged: wk,
    rank: WK_RANK,
  });
  const events = [];
  if (c.event) events.push({ axis: "ctx", ...c.event, judged: ctx, norole });
  if (w.event) events.push({ axis: "wk", ...w.event, judged: wk });
  const descents = [];
  if (c.descent) descents.push({ axis: "ctx", ...c.descent });
  if (w.descent) descents.push({ axis: "wk", ...w.descent });
  const nextFive = fiveHour
    ? {
        value: fiveHour.value,
        role: fiveHour.role,
        atIso: new Date(fiveHour.atMs).toISOString(),
      }
    : prev.fiveHour;
  return {
    state: {
      version: 1,
      ctxBand: c.band,
      ctxAlert: c.alert,
      wkBand: w.band,
      wkAlert: w.alert,
      fiveHour: nextFive,
    },
    events,
    descents,
  };
}

// ---- 통지문 ----------------------------------------------------------

const SEVERITY = {
  "ctx:BAND:ctx75": 100,
  "wk:BAND:wk95": 90,
  "ctx:STALE": 80,
  "ctx:UNOBSERVABLE": 70,
  "wk:UNOBSERVABLE": 60,
  "ctx:BAND:ctx65": 50,
  "wk:BAND:wk90": 40,
};

function eventKey(e) {
  return e.kind === "BAND" ? `${e.axis}:BAND:${e.band}` : `${e.axis}:${e.kind}`;
}

function pct(v) {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
}

// 한 줄 결론 -- 통지 파일 첫 줄에 그대로 들어간다(사람이 읽는 문장).
export function conclusionOf(e) {
  const k = eventKey(e);
  if (k === "ctx:BAND:ctx75") {
    return `ORCH 컨텍스트 ${pct(e.judged.value)}% — 하드선 75% 넘음 · 교대 필요`;
  }
  if (k === "ctx:BAND:ctx65") {
    return `ORCH 컨텍스트 ${pct(e.judged.value)}% — 교대 권장선 65% 넘음 · 교대 준비`;
  }
  if (k === "wk:BAND:wk95") {
    return `주간 사용량 ${pct(e.judged.value)}% — 유휴선 95% 넘음 · 작업을 접고 유휴`;
  }
  if (k === "wk:BAND:wk90") {
    return `주간 사용량 ${pct(e.judged.value)}% — 접기선 90% 넘음 · 새 좌석 개시 자제`;
  }
  if (k === "ctx:STALE") {
    const tail = e.norole
      ? " · 역할 값 없이 뜬 좌석의 더 새 값이 있음(그 좌석이 ORCH 일 수 있다)"
      : "";
    return `ORCH 사용량 값이 낡음 — 마지막 갱신 ${minutes(e.judged.ageMs)}분 전 · 지금 ORCH 컨텍스트를 모름${tail}`;
  }
  if (k === "ctx:UNOBSERVABLE") {
    const tail = e.norole
      ? " · 역할 값 없이 뜬 좌석의 파일은 있음(그 좌석이 ORCH 일 수 있다)"
      : "";
    return `ORCH 컨텍스트를 읽을 수 없음 — ${e.judged.reason} · 0% 로 보지 않음${tail}`;
  }
  return `주간 사용량을 읽을 수 없음 — ${e.judged.reason} · 0% 로 보지 않음`;
}

function kst(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} KST`;
}

function detailLines(e, nowMs) {
  const j = e.judged;
  const lines = [];
  if (e.axis === "ctx" && e.kind === "BAND") {
    lines.push(
      `- ORCH ctx ${pct(j.value)}% · 파일 갱신 ${kst(j.atMs)} (${minutes(j.ageMs)}분 전)`,
    );
  } else if (e.axis === "ctx" && e.kind === "STALE") {
    lines.push(
      `- ORCH 파일 갱신 ${kst(j.atMs)} (${minutes(j.ageMs)}분 전 · 기준 ${minutes(STALE_AFTER_MS)}분) — 낡은 ctx 값 ${j.ctx === null ? "없음" : `${pct(j.ctx)}%`} 은 판정에 쓰지 않았다`,
    );
  } else if (e.axis === "wk" && e.kind === "BAND") {
    lines.push(
      `- 주간 ${pct(j.value)}% · 값을 가진 가장 신선한 파일 = ${j.role} · 갱신 ${kst(j.atMs)} (${minutes(j.ageMs)}분 전)`,
    );
  } else {
    lines.push(`- 사유: ${j.reason}`);
  }
  if (e.norole) {
    lines.push(
      `- 역할 값 없이 뜬 좌석(ratelimit-${NOROLE_KEY}.json)이 더 새롭다: 갱신 ${kst(e.norole.atMs)} · ctx ${e.norole.ctx === null ? "값 없음" : `${pct(e.norole.ctx)}%`} (어느 좌석인지 알 수 없어 ORCH 판정에는 섞지 않았다)`,
    );
  }
  lines.push(`- 통지 시각 ${kst(nowMs)}`);
  return lines;
}

// 통지 파일 본문. ⭐첫 줄 = 사람이 읽는 한 줄 결론(가장 심한 사건 + «외 N건»).
export function buildNoticeText({ events, nowMs }) {
  const sorted = [...events].sort(
    (a, b) => (SEVERITY[eventKey(b)] ?? 0) - (SEVERITY[eventKey(a)] ?? 0),
  );
  const head = conclusionOf(sorted[0]);
  const more = sorted.length > 1 ? ` (외 ${sorted.length - 1}건)` : "";
  const out = [`${head}${more}`, ""];
  for (const e of sorted) {
    out.push(`## ${conclusionOf(e)}`);
    out.push(...detailLines(e, nowMs));
    out.push("");
  }
  out.push(
    "※ OBSERVER 통지입니다 — 앵커(위조 불가 기준점)가 아닙니다. 값은 상태줄 생성기가 쓰는 파일이고 ORCH 도 그 파일을 쓸 수 있습니다.",
  );
  out.push(
    "※ 감지는 예약 주기(15분)와 상태줄 갱신(좌석이 활동할 때만)만큼 늦습니다. 같은 띠가 이어지면 다시 알리지 않습니다.",
  );
  return `${out.join("\n")}\n`;
}

// watch.log 한 줄 안의 `usage-threshold:` 구간(토큰은 key=value, NONE = 없음).
export function buildLogSegment({ ctx, wk, fiveHour, events, descents }) {
  const ctxBand = ctx.kind === KIND.OBSERVED ? ctx.band : ctx.kind;
  const ctxPct = ctx.kind === KIND.OBSERVED ? pct(ctx.value) : "NONE";
  const wkBand = wk.kind === KIND.OBSERVED ? wk.band : wk.kind;
  const wkPct = wk.kind === KIND.OBSERVED ? pct(wk.value) : "NONE";
  const wkAge = wk.kind === KIND.OBSERVED ? minutes(wk.ageMs) : "NONE";
  const parts = [
    "usage-threshold:",
    `ctx_band=${ctxBand}`,
    `ctx_pct=${ctxPct}`,
    `wk_band=${wkBand}`,
    `wk_pct=${wkPct}`,
    `wk_age_min=${wkAge}`,
    `h5_pct=${fiveHour ? pct(fiveHour.value) : "NONE"}`,
    `events=${events.length}`,
  ];
  if (descents.length > 0) {
    parts.push(
      `descended=${descents.map((d) => `${d.axis}:${d.from}>${d.to}`).join(",")}`,
    );
  }
  return parts.join(" ");
}
