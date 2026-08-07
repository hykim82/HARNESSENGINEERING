// HYK-191-reach-1 (coder-task.md) -- 예약 감시 4축(watch-run.mjs가 이미
// 만드는 watch.log)이 "이미 잡는" 신호를 사람이 읽을 수 있는 보고문으로
// 바꾸는 순수 코어. I/O는 0(파일 읽기·쓰기는 이 파일을 부르는 wire쪽,
// reach-report.mjs가 한다) -- watch-freshness-core.mjs/orch-progress-
// core.mjs와 같은 "코어는 순수, 수집/출력은 wire" 원칙을 재사용한다.
//
// ★새 감지 축 금지(coder-task.md §3): 이 파일은 seat-liveness/seat-idle/
// dispatch-start/unconsumed 네 축이 이미 내놓은 verdict/status 문자열을
// "열려 있는 이상인가"로 분류할 뿐, 그 네 축의 판정 로직 자체를 재구현하지
// 않는다 -- watch.log 한 줄(buildLogLine, watch-run.mjs)의 문자열 형식만
// 파싱한다.
//
// 왜 "지금 열려 있는 이상"이 사람이 직접 읽는 값 위에 있어야 하는가
// (coder-task.md §4, 실측): 2026-08-05 05:06 ~ 08-06 22:36 KST 사이
// 좌석 방치 경보가 104회·약 41.5시간 울렸다. 신호는 그 41.5시간 내내
// **같은 값**이었으므로 "전이"는 맨 처음 1번뿐이었다 -- 그 1번을 놓치면
// 41시간 침묵한다. 그래서 이 파일은 매번 전체 로그를 다시 훑어 "지금도
// 여전히 열려 있다면 언제부터인지"를 매번 처음부터 다시 계산한다(전이
// 통지 1건에 기대지 않는다).

// ---- 축 정의 ----
// prefix: watch.log 한 줄의 필드 접두사(watch-run.mjs의 axisLogSegment와
// 동일한 이름 -- seat_/idle_/start_/unconsumed_).
// badVerdicts: 이 axis의 verdict 필드가 이 값이면 "열려 있는 이상"이다.
// badStatuses: verdict 필드와 별개로, status 자체가 "관측 수집 실패"류면
// 그것도 이상이다(§2-3 "판정 불가를 조용함으로 접지 않는다"의 확장 --
// 사람에게도 "관측이 실패하고 있다"는 알려야 한다).
export const AXES = Object.freeze([
  Object.freeze({
    key: "seat",
    prefix: "seat",
    label: "좌석 무응답",
    badVerdicts: Object.freeze(["SUSPECTED_UNRESPONSIVE"]),
    badStatuses: Object.freeze([
      "SEAT_LIVENESS_COLLECTION_FAILED",
      "SEAT_LIVENESS_SCAN_WORKTREE_LIST_FAILED",
      "SEAT_LIVENESS_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  Object.freeze({
    key: "idle",
    prefix: "idle",
    label: "좌석 유휴 방치",
    badVerdicts: Object.freeze(["SUSPECTED_ABANDONED"]),
    badStatuses: Object.freeze([
      "SEAT_IDLE_COLLECTION_FAILED",
      "SEAT_IDLE_SCAN_WORKTREE_LIST_FAILED",
      "SEAT_IDLE_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  Object.freeze({
    key: "start",
    prefix: "start",
    label: "배달 후 미착수",
    badVerdicts: Object.freeze(["NOT_STARTED"]),
    badStatuses: Object.freeze([
      "DISPATCH_START_COLLECTION_FAILED",
      "DISPATCH_START_SCAN_WORKTREE_LIST_FAILED",
      "DISPATCH_START_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
  Object.freeze({
    key: "unconsumed",
    prefix: "unconsumed",
    label: "워커 결과 미소비",
    badVerdicts: Object.freeze(["SUSPECTED_UNCONSUMED"]),
    badStatuses: Object.freeze([
      "UNCONSUMED_COLLECTION_FAILED",
      "UNCONSUMED_SCAN_WORKTREE_LIST_FAILED",
      "UNCONSUMED_SCAN_HARNESS_READ_FAILED",
    ]),
  }),
]);

// HYK-191-reach-1 실측 수리: 4축 필드(seat_*/idle_*/start_*/unconsumed_*)가
// 아직 없던 구세대 watch.log 줄(reason= 뒤에 아무것도 없이 줄이 끝남,
// 실물 D:/문서관리/하네스-관제실/watch/watch.log 278줄 중 47줄이 이
// 형태였다 -- gap#69 도입 직후~seat-wire 이전 구간)도 파싱돼야 한다.
// 뒤쪽 축 세그먼트를 통째로 옵셔널로 둔다(없으면 axes 전부 null/이상
// 아님으로 처리 -- fields가 그냥 비게 된다).
const LOG_LINE_RE =
  /^(\S+)\s+exit=(\S+)\s+verdict=(\S+)\s+reason=(\S+)(?:\s+(.*))?$/;

function parseFieldTokens(rest) {
  const fields = {};
  for (const tok of rest.split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    fields[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return fields;
}

function numOrNull(raw) {
  return raw && raw !== "NONE" ? Number(raw) : null;
}

function buildAxesFromFields(fields) {
  const axes = {};
  for (const axis of AXES) {
    const status = fields[`${axis.prefix}_status`] ?? null;
    const verdictField = fields[`${axis.prefix}_verdict`] ?? null;
    axes[axis.key] = {
      status: status === "NONE" ? null : status,
      verdict: verdictField === "NONE" ? null : verdictField,
      worstCount: numOrNull(fields[`${axis.prefix}_worst_count`]),
      worktrees: numOrNull(fields[`${axis.prefix}_worktrees`]),
    };
  }
  return axes;
}

// watch.log 한 줄 -> {tsMs, verdict, reasonCode, axes:{seat:{status,verdict,
// worstCount,worktrees}, ...}} | null(파싱 불가 -- RUNNER_FAILURE 줄, 빈
// 줄, 미래 형식 변경 등). 판단 불가는 그냥 건너뛴다(호출부가 배열에서
// null을 걸러낸다) -- 사람이 읽는 보고문에서 "이 줄은 못 읽었다"를 굳이
// 조용히 삼키지 않도록 parseWatchLog(아래)가 스킵 건수를 따로 센다.
export function parseLogLine(line) {
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = trimmed.match(LOG_LINE_RE);
  if (!m) return null;
  const [, tsRaw, , verdict, reasonCode, restRaw] = m;
  const tsMs = Date.parse(tsRaw);
  if (Number.isNaN(tsMs)) return null;
  const fields = parseFieldTokens(restRaw ?? "");
  return { tsMs, verdict, reasonCode, axes: buildAxesFromFields(fields) };
}

// watch.log 전체 텍스트 -> {entries, skipped}. entries는 시간순(오름차순,
// 로그 append 순서 그대로) 배열이다.
export function parseWatchLog(text) {
  const lines = typeof text === "string" ? text.split(/\r?\n/) : [];
  const entries = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseLogLine(line);
    if (parsed) entries.push(parsed);
    else skipped += 1;
  }
  return { entries, skipped };
}

function isAxisAnomalous(axisEntry, axis) {
  if (!axisEntry) return false;
  if (axisEntry.status && axis.badStatuses.includes(axisEntry.status)) {
    return true;
  }
  if (axisEntry.verdict && axis.badVerdicts.includes(axisEntry.verdict)) {
    return true;
  }
  return false;
}

// entries(시간순) + nowMs -> 현재 "열려 있는 이상" 배열. 각 axis마다:
// 가장 최근 entry가 이상이 아니면 건너뛴다. 이상이면, 끝에서부터 거꾸로
// 훑어 "연속으로 이상이었던" 구간의 시작 시각(sinceMs)을 찾는다 -- 중간에
// 정상(비이상) entry가 하나라도 있으면 그 직후부터 다시 연속 구간이
// 시작된다.
export function computeOpenAnomalies(entries, nowMs) {
  const list = Array.isArray(entries) ? entries : [];
  const open = [];
  if (list.length === 0) return open;
  const latest = list[list.length - 1];
  for (const axis of AXES) {
    const latestAxisEntry = latest.axes[axis.key];
    if (!isAxisAnomalous(latestAxisEntry, axis)) continue;
    let sinceMs = latest.tsMs;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!isAxisAnomalous(e.axes[axis.key], axis)) break;
      sinceMs = e.tsMs;
    }
    const openMs = Math.max(
      0,
      (typeof nowMs === "number" ? nowMs : latest.tsMs) - sinceMs,
    );
    open.push({
      axisKey: axis.key,
      label: axis.label,
      verdict: latestAxisEntry.verdict,
      status: latestAxisEntry.status,
      sinceMs,
      openMs,
    });
  }
  return open;
}

// 지난 windowMs(기본 24시간) 동안 각 axis가 이상 상태로 관측된 샘플 수 --
// "지난 24시간 요약"용. 열려 있는 이상(computeOpenAnomalies)과는 별개
// 절이다(coder-task.md §4 "지난 24시간 요약과 지금 열려 있는 이상은
// 다르다").
export const DEFAULT_SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function computeRecentSummary(
  entries,
  nowMs,
  windowMs = DEFAULT_SUMMARY_WINDOW_MS,
) {
  const list = Array.isArray(entries) ? entries : [];
  const cutoff = (typeof nowMs === "number" ? nowMs : 0) - windowMs;
  const inWindow = list.filter((e) => e.tsMs >= cutoff);
  const summary = {};
  for (const axis of AXES) {
    let anomalousSamples = 0;
    for (const e of inWindow) {
      if (isAxisAnomalous(e.axes[axis.key], axis)) anomalousSamples += 1;
    }
    summary[axis.key] = {
      label: axis.label,
      sampleCount: inWindow.length,
      anomalousSamples,
    };
  }
  return summary;
}

// N시간 M분 형식(coder-task.md §4 "몇 시간째"가 결정적 정보라는 실측
// 근거를 그대로 반영 -- 분 단위까지 보여 "방금 넘겼다"와 "한참 됐다"를
// 구별시킨다).
export function formatDurationKo(ms) {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}분`;
  return `${hours}시간 ${minutes}분`;
}

function formatKstIsh(ms) {
  return new Date(ms).toISOString();
}

// 사람이 읽는 보고문 본문(요건 2). 맨 위에 "지금 열려 있는 이상"(비어
// 있어도 "없음"을 명시적으로 찍는다 -- 빈 출력 금지), 그 아래 "지난
// 24시간 요약".
export function formatMorningReport({
  entries,
  nowMs,
  skipped = 0,
  sourceLabel = "",
}) {
  const openAnomalies = computeOpenAnomalies(entries, nowMs);
  const summary = computeRecentSummary(entries, nowMs);
  const lines = [];
  lines.push(`# 예약 감시 아침 보고 -- ${formatKstIsh(nowMs)} 기준`);
  if (sourceLabel) lines.push(`source: ${sourceLabel}`);
  lines.push("");
  lines.push("## 지금 열려 있는 이상");
  if (openAnomalies.length === 0) {
    lines.push(
      "없음 -- 열려 있는 이상이 없습니다(4축 전부 정상 또는 관측 대상 없음).",
    );
  } else {
    for (const a of openAnomalies) {
      lines.push(
        `- **${a.label}** (${a.verdict ?? a.status}) -- ${formatKstIsh(a.sinceMs)}부터, ${formatDurationKo(a.openMs)}째`,
      );
    }
  }
  lines.push("");
  lines.push("## 지난 24시간 요약");
  if (entries.length === 0) {
    lines.push(
      "없음 -- 지난 24시간 내 로그 항목이 없습니다(watch.log 비어있음 또는 감시 미실행).",
    );
  } else {
    for (const axis of AXES) {
      const s = summary[axis.key];
      lines.push(
        `- ${s.label}: 표본 ${s.sampleCount}건 중 이상 ${s.anomalousSamples}건`,
      );
    }
  }
  if (skipped > 0) {
    lines.push("");
    lines.push(`(참고: 파싱 못한 로그 줄 ${skipped}개는 이 보고에서 제외됨)`);
  }
  return lines.join("\n") + "\n";
}
