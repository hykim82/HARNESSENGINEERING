// shim-ledger-report-core.mjs -- HYK-389 조각 2 저장소 몫: 아침 보고 «ORCH 좌석 직접
// 쓰기» 한 줄의 순수 코어(기록 단계 · OBSERVER · 앵커 아님).
//
// zero-import: fs · process 전역을 읽지 않는다. 원장 «텍스트» · 시각 · 문 목록은 전부
// 호출자(reach-report.mjs)가 값으로 넘긴다.
//
// 읽는 원장 = orca shim 의 `orca-direct-ledger.jsonl`. 두 종류의 줄이 섞여 있다:
//   - 부팅 줄:  { event: "orch_seat_boot", ts, shim: "enabled"|"disabled", reason, ... }
//   - 쓰기 줄:  { ts, domain, verb, actor: "orch"|"unattributed", caller_script, ... }
//               (조각 1 · `event` 칸이 없다)
//
// 센 것:
//   ⓐ 부팅 수 -- enabled · disabled(사유별).
//   ⓑ ORCH 좌석 직접 쓰기 -- actor=orch 쓰기 줄 중 «설계된 문 밖» 수(동사별).
//      ★«설계된 문 밖» 정의(설계 문서 §(마) 조각 4 행 · 근거 부록 E6 원문): 설계된 문
//      = 정본 경로의 dispatch-worker / memory-gate / orca-worktree-create 스크립트
//      호출 스택. 조각 1 원장은 직접 호출자 스크립트 경로(`caller_script`)를 남기므로
//      «caller_script 의 정규화된 전체 경로가 정본 경로 목록(주입 가능 · 기본 =
//      DEFAULT_DESIGNED_DOOR_PATHS)에 없거나 비어 있으면 문 밖» 이다. 이름만 같고
//      위치가 다른 스크립트는 문 밖이다(HYK-389-orch-launch-2 P2-1 · 조각 3 의 7일
//      관측이 이 수를 재료로 쓰므로 «지표가 좋아 보이는 쪽으로» 틀리지 않게 한다).
//
// ★관측 불가 ≠ 0 (HYK-389-orch-launch-2 P2-4 로 «부분 관측» 단계가 생겼다):
//   - 전체 관측 불가(unobservable) = 원장을 못 읽었거나(없음 · 읽기 실패) «읽을 수 있는
//     줄이 0» 일 때만. 어느 쪽이든 «0 건» 으로 접지 않는다.
//   - 부분 관측(partial) = 읽을 수 있는 줄이 있고 깨진 줄(찢긴 줄 포함)도 있을 때. 깨진
//     줄은 건수로 따로 세어 보고 줄 머리에 적고, 나머지 줄은 집계하되 «하한» 이다
//     (깨진 줄 안에 있었을 부팅 · 쓰기는 세지 못했다). 깨진 줄을 0 으로 접지 않는다.
//
// ⚠️정직 한계(한 줄 끝에도 적힌다): OBSERVER 다 -- 막은 건수가 아니라 «남은 줄» 의 수다.
// 런처를 거치지 않은 ORCH · 절대 경로 orca.exe · PATH 재설정 · node spawn 은 기록 밖이다.
// 문 판정은 «직접 호출자 스크립트 1개» 의 전체 경로 대조다(문 안 스크립트가 다른
// 스크립트를 거쳐 부르면 문 밖) · 경로 정규화는 문자열만 본다(파일 시스템을 읽지 않는다).
// 같은 권한 행위자는 원장을 고칠 수 있다. 앵커가 아니다.

export const LEDGER_SCHEMA_EXPECTED = "orca-direct-ledger/1";
export const BOOT_EVENT = "orch_seat_boot";

// 설계된 문 = 정본 경로의 dispatch-worker / memory-gate / orca-worktree-create.
// 정본 경로 = 관제실 루트의 세 스크립트(호출 지점 근거 = 설계 부록 E6 의
// dispatch-worker.ps1 · memory-gate.ps1 · orca-worktree-create.ps1). 관제실 경로 상수는
// reach-report.mjs 의 DEFAULT_* 와 같은 모양이고, 호출자가 목록 전체를 주입할 수 있다.
export const DEFAULT_DESIGNED_DOOR_ROOT = "D:/문서관리/하네스-관제실";
export const DEFAULT_DESIGNED_DOOR_PATHS = Object.freeze([
  `${DEFAULT_DESIGNED_DOOR_ROOT}/dispatch-worker.ps1`,
  `${DEFAULT_DESIGNED_DOOR_ROOT}/memory-gate.ps1`,
  `${DEFAULT_DESIGNED_DOOR_ROOT}/orca-worktree-create.ps1`,
]);

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STATUS_OK = "ok";
export const STATUS_PARTIAL = "partial";
export const STATUS_UNOBSERVABLE = "unobservable";

// 경로 정규화(문자열만 · 파일 시스템 안 읽음): 구분자 `\` -> `/` · 중복 `/` 접기 · `.` ·
// `..` 접기 · 소문자(관제실은 Windows -- 대소문자 무시 파일 시스템). 전체 경로(드라이브 ·
// UNC · 절대 `/`)가 아니거나 `~` 가 든 마디(8.3 짧은 이름 `HARNES~1` · 홈 `~` 는 파일
// 시스템 없이는 확장할 수 없다)이거나 루트 위로 올라가는 `..` 이면 null = «정본이라고
// 증명할 수 없다» -> 문 밖(과소 계수 방향으로 틀리지 않는다).
export function normalizeFullPath(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\\/g, "/");
  let root;
  let rest;
  const drive = /^([A-Za-z]:)\/(.*)$/s.exec(text);
  if (drive) {
    root = `${drive[1].toLowerCase()}/`;
    rest = drive[2];
  } else if (/^\/\/[^/]/.test(text)) {
    root = "//";
    rest = text.slice(2);
  } else if (text.startsWith("/")) {
    root = "/";
    rest = text.slice(1);
  } else {
    return null;
  }
  const segments = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (segment.includes("~")) return null;
    segments.push(segment.toLowerCase());
  }
  return segments.length === 0 ? null : `${root}${segments.join("/")}`;
}

// 호출자 스크립트가 «정본 경로 목록» 에 있는가. 목록 항목도 같은 정규화를 거친다 --
// 이름만 적힌 항목(전체 경로가 아님)은 어떤 호출자와도 일치하지 않는다.
export function isInsideDoor(callerScript, designedDoorPaths) {
  const caller = normalizeFullPath(callerScript);
  if (caller === null) return false;
  const doors = Array.isArray(designedDoorPaths) ? designedDoorPaths : [];
  return doors.some((door) => normalizeFullPath(door) === caller);
}

function tsMsOf(entry) {
  if (typeof entry.ts !== "string") return null;
  const ms = Date.parse(entry.ts);
  return Number.isFinite(ms) ? ms : null;
}

function bump(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function newSummary() {
  return {
    status: STATUS_OK,
    unobservableReasons: [],
    brokenLines: 0,
    readLines: 0,
    boots: { total: 0, enabled: 0, disabled: 0, byReason: {} },
    orchWrites: { total: 0, insideDoor: 0, outsideDoor: 0, outsideByVerb: {} },
    unattributedWrites: 0,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReadableWriteLine(entry) {
  return (
    typeof entry.domain === "string" &&
    typeof entry.verb === "string" &&
    typeof entry.actor === "string"
  );
}

// 읽을 수 있는 줄인가 -> "boot" | "write" | null(= 깨진 줄).
function classifyEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (entry.schema !== LEDGER_SCHEMA_EXPECTED) return null;
  if (tsMsOf(entry) === null) return null;
  if (entry.event === BOOT_EVENT) {
    return entry.shim === "enabled" || entry.shim === "disabled"
      ? "boot"
      : null;
  }
  return isReadableWriteLine(entry) ? "write" : null;
}

function countBoot(entry, summary) {
  summary.boots.total += 1;
  if (entry.shim === "enabled") {
    summary.boots.enabled += 1;
    return;
  }
  summary.boots.disabled += 1;
  const hasReason = typeof entry.reason === "string" && entry.reason !== "";
  bump(summary.boots.byReason, hasReason ? entry.reason : "REASON_UNKNOWN");
}

function countWrite(entry, summary, designedDoors) {
  if (entry.actor !== "orch") {
    summary.unattributedWrites += 1;
    return;
  }
  summary.orchWrites.total += 1;
  if (isInsideDoor(entry.caller_script, designedDoors)) {
    summary.orchWrites.insideDoor += 1;
    return;
  }
  summary.orchWrites.outsideDoor += 1;
  bump(summary.orchWrites.outsideByVerb, `${entry.domain} ${entry.verb}`);
}

// 한 줄을 읽어 요약에 더한다. 읽을 수 없으면 false(= 깨진 줄).
function ingestEntry({ entry, summary, nowMs, windowMs, designedDoors }) {
  const kind = classifyEntry(entry);
  if (kind === null) return false;
  summary.readLines += 1;
  if (tsMsOf(entry) < nowMs - windowMs) return true; // 읽었으나 보고 기간 밖
  if (kind === "boot") countBoot(entry, summary);
  else countWrite(entry, summary, designedDoors);
  return true;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// 원장 «텍스트» 요약. text === null 이면 «원장을 못 읽었다» (readError = 사유 문자열).
// designedDoors = 정본 경로 목록(전체 경로 문자열 배열 · 주입 가능).
export function summarizeShimLedger({
  text,
  readError = null,
  nowMs,
  windowMs = DEFAULT_WINDOW_MS,
  designedDoors = DEFAULT_DESIGNED_DOOR_PATHS,
}) {
  const summary = newSummary();
  if (typeof text !== "string") {
    summary.status = STATUS_UNOBSERVABLE;
    summary.unobservableReasons.push(
      `원장을 읽지 못했다(${readError ?? "없음"})`,
    );
    return summary;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const entry = parseJsonLine(line);
    const ok = ingestEntry({ entry, summary, nowMs, windowMs, designedDoors });
    if (!ok) summary.brokenLines += 1;
  }
  if (summary.readLines === 0) {
    // 읽을 수 있는 줄 0(빈 원장 · 깨진 줄뿐) = 전체 관측 불가. 0 건과 구별한다.
    summary.status = STATUS_UNOBSERVABLE;
    summary.unobservableReasons.push(
      "읽을 수 있는 줄 0",
      `깨진 줄 ${summary.brokenLines}건`,
    );
  } else if (summary.brokenLines > 0) {
    summary.status = STATUS_PARTIAL; // 깨진 줄은 건수로 드러내고 나머지는 집계한다
  }
  return summary;
}

function countMap(map) {
  const keys = Object.keys(map).sort();
  return keys.length === 0 ? "" : keys.map((k) => `${k} ${map[k]}`).join(", ");
}

const LIMIT_NOTE =
  "OBSERVER · 앵커 아님 -- 런처 밖 ORCH · 절대 경로 orca.exe · PATH 재설정은 기록 밖 · 문 판정은 직접 호출자 스크립트의 정본 경로(전체 경로) 대조";

function bootClause(boots) {
  const reasons = countMap(boots.byReason);
  const off = reasons === "" ? "" : `: ${reasons}`;
  return `ORCH 부팅 ${boots.total}(기록 켬 ${boots.enabled} · 끔 ${boots.disabled}${off})`;
}

function writeClause(writes) {
  const verbs = countMap(writes.outsideByVerb);
  const detail = verbs === "" ? "" : ` [${verbs}]`;
  return `설계된 문 밖 직접 쓰기 ${writes.outsideDoor}건${detail} (문 안 ${writes.insideDoor}건)`;
}

// 아침 보고 한 줄 -- 첫머리 = 사람이 읽는 결론(전체 관측 불가 · 부분 관측이면 그 표지).
export function formatShimLedgerLine(summary, { sourceLabel = "" } = {}) {
  const source = sourceLabel ? ` · source: ${sourceLabel}` : "";
  if (summary.status === STATUS_UNOBSERVABLE) {
    return `ORCH 좌석 직접 쓰기: 관측 불가(${summary.unobservableReasons.join(" · ")}) -- 0건이 아니다. (${LIMIT_NOTE})${source}`;
  }
  const unattributed =
    summary.unattributedWrites > 0
      ? ` · 귀속 불명 쓰기 ${summary.unattributedWrites}건(참고)`
      : "";
  const counts = `${bootClause(summary.boots)} · ${writeClause(summary.orchWrites)}${unattributed}`;
  if (summary.status === STATUS_PARTIAL) {
    const n = summary.brokenLines;
    return `[부분 관측 · 깨진 줄 ${n}건] ${counts} -- 깨진 줄 ${n}건은 세지 못했다: 위 수는 하한이고 0건으로 접지 않는다 (읽은 줄 ${summary.readLines}건 · ${LIMIT_NOTE})${source}`;
  }
  return `${counts} (${LIMIT_NOTE})${source}`;
}
