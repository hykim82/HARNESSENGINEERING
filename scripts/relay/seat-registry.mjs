// HYK-171 사이클4b-2b-1 (coder-task.md §2-A) -- 좌석 대장(registry).
//
// 기록 시점 = 좌석 "생성 응답"을 받은 그 자리 -- 사후에 terminal list를
// 훑어 "그 워크트리에 있으니 우리 것"이라고 등록하지 않는다(PM Q4 반례:
// 사람이 직접 연 탭도 무해 참조로 잡혀 지워지는 사고를 막는다). 이 파일은
// 순수 상태 변환(normalizeSeatRecord/recordSeatCreation)과 fs 조회/쓰기
// 주입(loadRegistry/saveRegistry)만 갖는다 -- observer-store.mjs 전례를
// 따르되 재사용이 아니라 별도 store다(그 store는 advisory outbox 전용).
//
// 이 모듈은 orca/dispatch/teardown/worker input 호출을 절대 하지 않는다.
// teardownSeat/relayStep/dispatch 어느 프로덕션 진입점도 이 파일을
// import하지 않는다(coder-task.md §1 "결선 0" -- 판정·기록만, 프로덕션
// 호출자 0).

export const SCHEMA_VERSION = 1;

// 권위 응답 스키마가 경로마다 다르다(coder-task.md §2-A 실측: `terminal
// create`(--focus 없음)는 ptyId+paneKey를 주지만 --focus를 준 응답에는
// 둘 다 없었다. `worktree create` 응답에는 터미널 정보가 아예 없다). 결손
// 필드는 null로 정직하게 기록한다 -- 있는 척 채우지 않는다.
const RECORD_FIELDS = [
  "ptyId",
  "handle",
  "tabId",
  "leafId",
  "paneKey",
  "worktreeId",
  "worktreePath",
  "role",
  "taskId",
  "dispatchId",
  "capturedAt",
];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function createEmptyRegistry() {
  return { schemaVersion: SCHEMA_VERSION, seats: [] };
}

// creationResponse: 좌석 생성 CLI 응답(권위 응답) 그 자체에서 뽑아낸 필드만
// 받는다 -- 조회를 하지 않는 순수 함수(사후 수집 금지를 시그니처 층위에서
// 강제: 이 함수는 "생성 응답 하나"만 받게 생겼고, 목록/배열을 넘겨도
// isPlainObject 검사에서 걸려 전 필드가 null로 접힌다).
export function normalizeSeatRecord(creationResponse = {}) {
  const src = isPlainObject(creationResponse) ? creationResponse : {};
  const record = { schemaVersion: SCHEMA_VERSION };
  for (const field of RECORD_FIELDS) {
    const v = src[field];
    record[field] = typeof v === "string" && v.length > 0 ? v : null;
  }
  return record;
}

// 순수 append -- 이미 존재하는 ptyId라도 막지 않는다(중복 등록 감지/차단은
// seat-identity-core.mjs의 SEAT_REGISTRY_CONFLICT 판정 몫이다 -- 이 대장은
// "생성 응답을 있는 그대로 적재"만 하고, 정합성 판단은 판정 코어 층위에서
// 한다). 입력 registry는 변형하지 않는다(새 객체 반환).
export function recordSeatCreation(registry, creationResponse) {
  const base = isPlainObject(registry) ? registry : createEmptyRegistry();
  const record = normalizeSeatRecord(creationResponse);
  return {
    registry: {
      schemaVersion: SCHEMA_VERSION,
      seats: [...(Array.isArray(base.seats) ? base.seats : []), record],
    },
    record,
  };
}

export function findByPtyId(registry, ptyId) {
  const base = isPlainObject(registry) ? registry : createEmptyRegistry();
  if (typeof ptyId !== "string" || ptyId.length === 0) return [];
  return (Array.isArray(base.seats) ? base.seats : []).filter(
    (r) => isPlainObject(r) && r.ptyId === ptyId,
  );
}

// ---- fs 결속(observer-store.mjs parseStoreText/loadStore 전례 계승) ----
// 손상(JSON.parse 실패)·스키마 불일치는 항상 ok:false -- 이 경우 호출자는
// 이번 tick에서 어떤 등록도 진행하지 않는다(fail-closed). 파일 부재는
// 손상이 아니라 "첫 실행"이므로 빈 registry로 정상 취급한다.
export function parseRegistryText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "corrupt-json" };
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: "schema-mismatch" };
  }
  if (!Array.isArray(parsed.seats)) {
    return { ok: false, reason: "schema-mismatch" };
  }
  return { ok: true, registry: parsed };
}

// opts: { existsFn, readFn } -- 둘 다 (path) => value 형태.
export function loadRegistry(path, opts = {}) {
  const { existsFn, readFn } = opts;
  if (typeof existsFn !== "function" || typeof readFn !== "function") {
    return { ok: false, reason: "loadRegistry: existsFn/readFn required" };
  }
  if (!existsFn(path)) {
    return { ok: true, registry: createEmptyRegistry(), rawText: null };
  }
  let text;
  try {
    text = readFn(path);
  } catch (err) {
    return {
      ok: false,
      reason: `loadRegistry: read threw (${err?.message})`,
    };
  }
  const parsed = parseRegistryText(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  return { ok: true, registry: parsed.registry, rawText: text };
}

// opts: { writeFn, renameFn } -- tmp write + rename로 원자성 근사(둘 다 주입).
export function saveRegistry(path, registry, opts = {}) {
  const { writeFn, renameFn } = opts;
  if (typeof writeFn !== "function" || typeof renameFn !== "function") {
    return { ok: false, reason: "saveRegistry: writeFn/renameFn required" };
  }
  const tmpPath = `${path}.tmp`;
  const text = JSON.stringify(
    isPlainObject(registry) ? registry : createEmptyRegistry(),
    null,
    2,
  );
  try {
    writeFn(tmpPath, text);
    renameFn(tmpPath, path);
  } catch (err) {
    return {
      ok: false,
      reason: `saveRegistry: write threw (${err?.message})`,
    };
  }
  return { ok: true, rawText: text };
}
