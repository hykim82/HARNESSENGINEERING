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
//      «caller_script 의 파일 이름이 설계된 문 목록에 없거나 비어 있으면 문 밖» 이다.
//      문 목록은 주입 가능(기본 = DEFAULT_DESIGNED_DOORS).
//
// ★관측 불가 ≠ 0: 원장이 없거나(읽기 실패) 깨진 줄이 하나라도 있으면 상태는
// «unobservable» 이고 «0 건» 으로 접지 않는다 -- 읽은 줄만 센 값은 «하한» 으로만 적는다.
//
// ⚠️정직 한계(한 줄 끝에도 적힌다): OBSERVER 다 -- 막은 건수가 아니라 «남은 줄» 의 수다.
// 런처를 거치지 않은 ORCH · 절대 경로 orca.exe · PATH 재설정 · node spawn 은 기록 밖이다.
// 문 판정은 파일 이름 기준이다(같은 이름의 다른 스크립트도 문 안으로 센다 -- 정본 경로
// 대조는 하지 않는다). 같은 권한 행위자는 원장을 고칠 수 있다. 앵커가 아니다.

export const LEDGER_SCHEMA_EXPECTED = "orca-direct-ledger/1";
export const BOOT_EVENT = "orch_seat_boot";

// 설계된 문 = 정본 경로의 dispatch-worker / memory-gate / orca-worktree-create.
export const DEFAULT_DESIGNED_DOORS = Object.freeze([
  "dispatch-worker.ps1",
  "memory-gate.ps1",
  "orca-worktree-create.ps1",
]);

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const STATUS_OK = "ok";
export const STATUS_UNOBSERVABLE = "unobservable";

function baseName(value) {
  if (typeof value !== "string") return "";
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1].toLowerCase();
}

export function isInsideDoor(callerScript, designedDoors) {
  const name = baseName(callerScript);
  if (name === "") return false;
  const doors = Array.isArray(designedDoors) ? designedDoors : [];
  return doors.some((door) => baseName(door) === name);
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
export function summarizeShimLedger({
  text,
  readError = null,
  nowMs,
  windowMs = DEFAULT_WINDOW_MS,
  designedDoors = DEFAULT_DESIGNED_DOORS,
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
  if (summary.brokenLines > 0) {
    summary.status = STATUS_UNOBSERVABLE;
    summary.unobservableReasons.push(`깨진 줄 ${summary.brokenLines}건`);
  }
  return summary;
}

function countMap(map) {
  const keys = Object.keys(map).sort();
  return keys.length === 0 ? "" : keys.map((k) => `${k} ${map[k]}`).join(", ");
}

const LIMIT_NOTE =
  "OBSERVER · 앵커 아님 -- 런처 밖 ORCH · 절대 경로 orca.exe · PATH 재설정은 기록 밖 · 문 판정은 파일 이름 기준";

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

// 아침 보고 한 줄 -- 첫머리 = 사람이 읽는 결론.
export function formatShimLedgerLine(summary, { sourceLabel = "" } = {}) {
  const source = sourceLabel ? ` · source: ${sourceLabel}` : "";
  if (summary.status !== STATUS_OK) {
    const lower =
      summary.readLines > 0
        ? ` 읽은 줄만 센 하한: ${bootClause(summary.boots)} · ${writeClause(summary.orchWrites)}.`
        : "";
    return `ORCH 좌석 직접 쓰기: 관측 불가(${summary.unobservableReasons.join(" · ")}) -- 0건이 아니다.${lower} (${LIMIT_NOTE})${source}`;
  }
  const unattributed =
    summary.unattributedWrites > 0
      ? ` · 귀속 불명 쓰기 ${summary.unattributedWrites}건(참고)`
      : "";
  return `${bootClause(summary.boots)} · ${writeClause(summary.orchWrites)}${unattributed} (${LIMIT_NOTE})${source}`;
}
