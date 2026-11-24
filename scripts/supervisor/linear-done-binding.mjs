// HYK-255-linear-binding-1 (묶음 B · 조각 B2 · 전달 #20261123-1740 확정 4 · S3) -- Linear Done «결속 확인».
//
// 무엇: 창 안에서 Linear 이슈가 Done(completed)으로 전이된 사건마다, 그 이슈의 «Done 이전 가장 최근 병합» PR 이 ㄱ-4 판정에서 한용 승인(APPROVED)이었는지를 본다.
// ⚠️ 이것은 «결속 확인» 이지 독립 증거가 아니다 -- Linear 행위자는 기계가 쓰는 키의 주인과 같은 계정일 수 있어 근거가 되지 못한다(그 건수를 줄에 같이 적는다).
// 결속 수는 커버리지 · 독립 확인 수 · ㄴ 분자 어디에도 더하지 않고, 아무것도 막지 않는다(차단 0).
//
// 쓰기 0 의 기계 보장: 포트는 아래 «상수 문서 1개» 만 POST 한다. 다른 문서(mutation 포함) · 다른 변수 모양은 요청 전에 거부하고, 포트에는 읽기 메서드 둘(request · readDoneHistory)뿐이다.
// 키: linear-sync 의 loadLinearApiKey 를 그대로 import 한다(env -> repoRoot/.env.local) -- 새 자격 0. 키 값은 Authorization 헤더에만 가고 보고문 · 결과 · 오류 문면 어디에도 싣지 않는다.
//
// 이슈 <-> PR: 로컬 git 병합 제목 «Merge pull request #N from <owner>/hyk<NNN>-…» 의 가지 이름(REST 0). ㄱ-4 판정: 이번 회차 판정 · 캐시가 이미 쥔 값(gate4.shaStatuses -- 추가 REST 0).
//
// [추측 표식] Linear GraphQL 스키마(필드 이름 · history 정렬 · 한도)는 이 저장소 안 실물(linear-sync.mjs 의 issues 질의)에서 `issues` · `nodes` · `identifier` · `state{type}` 까지만 근거가
// 있다. completedAt 필터 · history · toState · actor · pageInfo 는 [추측] 이라 응답이 이 모양이 아니면 UNKNOWN(모양 위반)으로 드러난다(0 으로 접지 않는다).
import { loadLinearApiKey } from "../check/linear-sync.mjs";
import { APPROVAL_STATUS } from "./approval-authority-adapter.mjs";

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// 상수 문서(읽기 전용 query 1개). 식별자 필터는 문서가 아니라 응답 처리에서 ^HYK-\d+$ 만 센다(linear-sync 와 같은 관례).
export const LINEAR_DONE_QUERY = `query DoneBinding($since: DateTimeOrDuration) {
  viewer { id }
  issues(filter: { completedAt: { gte: $since } }, first: 50) {
    pageInfo { hasNextPage }
    nodes {
      identifier
      history(first: 50) {
        pageInfo { hasNextPage }
        nodes { createdAt actor { id } toState { type } }
      }
    }
  }
}`;

const ISSUE_ID_RE = /^HYK-\d+$/;
const MERGE_SUBJECT_RE =
  /^([0-9a-f]{40}) (\S+) Merge pull request #(\d+) from [^/\s]+\/hyk(\d+)-/i;
export const MERGE_LOG_ARGS = Object.freeze([
  "log",
  "--first-parent",
  "--merges",
  "--format=%H %cI %s",
  "-n",
  "200",
  "origin/master",
]);

// 사유 문면 1줄 -- 키 값을 가리고 길이를 자른다(오류 문면에 키가 섞여 돌아와도 보고문에 실리지 않는다).
function sanitizeReason(text, apiKey) {
  let out = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (apiKey) out = out.split(apiKey).join("[키]");
  out = out.replace(/lin_api_[A-Za-z0-9]+/g, "[키]");
  return out.length > 120 ? `${out.slice(0, 117)}...` : out;
}

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// 이 포트가 보내도 되는 요청 = 상수 문서 + 변수 {since} 하나뿐.
function isAllowedRequest({ query, variables }) {
  if (query !== LINEAR_DONE_QUERY) return false;
  if (!isPlainObject(variables)) return false;
  const keys = Object.keys(variables);
  return (
    keys.length === 1 &&
    keys[0] === "since" &&
    typeof variables.since === "string"
  );
}

const failure = (text, apiKey) => ({
  ok: false,
  reason: sanitizeReason(text, apiKey),
});

// 요청 1회 -> {ok:true, json} | {ok:false, reason}. 키는 Authorization 헤더로만 가고 실패 문면에서는 가린다.
async function postDocument({ doFetch, apiKey, query, variables }) {
  let res;
  try {
    res = await doFetch(LINEAR_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    return failure(err?.message ?? err, apiKey);
  }
  if (!res || res.ok !== true)
    return { ok: false, reason: `HTTP ${res?.status ?? "?"}` };
  try {
    return { ok: true, json: await res.json() };
  } catch (err) {
    return failure(err?.message ?? err, apiKey);
  }
}

// GraphQL 오류 응답이면 첫 오류 문면 · 아니면 null.
function graphqlErrorOf(json) {
  const errors = isPlainObject(json) ? json.errors : null;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors[0]?.message ?? "GraphQL errors";
}

// 포트 -- request(문서 + 변수) · readDoneHistory({sinceIso}). 결과 모양 = {ok:true, json} | {ok:false, reason}.
export function createLinearHistoryPort({ apiKey, linearFetch }) {
  const doFetch = linearFetch ?? globalThis.fetch;
  async function request({ query, variables }) {
    if (!isAllowedRequest({ query, variables }))
      return { ok: false, reason: "상수 밖 문서 거부" };
    const res = await postDocument({ doFetch, apiKey, query, variables });
    if (!res.ok) return res;
    const gqlError = graphqlErrorOf(res.json);
    return gqlError === null ? res : failure(gqlError, apiKey);
  }
  return {
    request,
    readDoneHistory: ({ sinceIso }) =>
      request({ query: LINEAR_DONE_QUERY, variables: { since: sinceIso } }),
  };
}

const SHAPE_VIOLATION = { known: false, reason: "모양 위반" };
const TRUNCATED = { known: false, reason: "목록 잘림" };

// null · undefined 허용 · 있으면 문자열 `key` 를 가진 객체여야 한다(toState.type · actor.id).
const isNullableWith = (v, key) =>
  v === null ||
  v === undefined ||
  (isPlainObject(v) && typeof v[key] === "string");

function parseHistoryNode(n) {
  if (!isPlainObject(n) || typeof n.createdAt !== "string") return null;
  const atMs = Date.parse(n.createdAt);
  if (!Number.isFinite(atMs)) return null;
  if (!isNullableWith(n.toState, "type") || !isNullableWith(n.actor, "id"))
    return null;
  return { atMs, type: n.toState?.type ?? null, actorId: n.actor?.id ?? null };
}

// 이슈 한 건 -> {truncated, events} | null(모양 위반). Done 사건 = toState.type == "completed" ∧ createdAt 창 안.
function parseIssueNode(node, { windowStartMs, windowEndMs }) {
  const h = node.history;
  if (
    !isPlainObject(h) ||
    !isPlainObject(h.pageInfo) ||
    !Array.isArray(h.nodes)
  )
    return null;
  const events = [];
  for (const raw of h.nodes) {
    const e = parseHistoryNode(raw);
    if (!e) return null;
    if (
      e.type === "completed" &&
      e.atMs >= windowStartMs &&
      e.atMs <= windowEndMs
    ) {
      events.push({
        identifier: node.identifier,
        atMs: e.atMs,
        actorId: e.actorId,
      });
    }
  }
  return { truncated: h.pageInfo.hasNextPage === true, events };
}

// 응답 바깥 모양(viewer.id · issues.pageInfo · issues.nodes) 검사 -> {viewerId, issues} | null(모양 위반).
function readIssuesEnvelope(json) {
  const data = json?.data;
  const issues = data?.issues;
  if (typeof data?.viewer?.id !== "string" || !isPlainObject(issues))
    return null;
  if (!isPlainObject(issues.pageInfo) || !Array.isArray(issues.nodes))
    return null;
  return { viewerId: data.viewer.id, issues };
}

// Linear 응답 -> {known:true, viewerId, events} | {known:false, reason}. 순수 · 던지지 않는다.
export function parseLinearDoneEvents(json, { windowStartMs, windowEndMs }) {
  const env = readIssuesEnvelope(json);
  if (!env) return SHAPE_VIOLATION;
  const events = [];
  let truncated = env.issues.pageInfo.hasNextPage === true;
  for (const node of env.issues.nodes) {
    if (!isPlainObject(node) || typeof node.identifier !== "string")
      return SHAPE_VIOLATION;
    if (!ISSUE_ID_RE.test(node.identifier)) continue;
    const parsed = parseIssueNode(node, { windowStartMs, windowEndMs });
    if (!parsed) return SHAPE_VIOLATION;
    truncated = truncated || parsed.truncated;
    events.push(...parsed.events);
  }
  if (truncated) return TRUNCATED;
  return { known: true, viewerId: env.viewerId, events };
}

// git log(%H %cI %s) 출력 -> [{sha, tsMs, pull, issue}] (최신부터). 가지 이름 관례(hyk<NNN>-) 밖 · 병합 아닌 줄은 연결 없음 -- 건너뛴다.
export function parseMergeLinks(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const m = MERGE_SUBJECT_RE.exec(line.trim());
    if (!m) continue;
    const tsMs = Date.parse(m[2]);
    if (!Number.isFinite(tsMs)) continue;
    out.push({
      sha: m[1],
      tsMs,
      pull: Number(m[3]),
      issue: `HYK-${Number(m[4])}`,
    });
  }
  return out;
}

// Done 사건의 연결 병합 = 그 이슈의 병합 중 «Done 시각 이전(포함)» 가장 최근 1개.
function linkedMerge(merges, event) {
  let best = null;
  for (const m of merges) {
    if (m.issue !== event.identifier || m.tsMs > event.atMs) continue;
    if (best === null || m.tsMs > best.tsMs) best = m;
  }
  return best;
}

// 순수 판정 -- Done 사건마다 결속(b) · 미결속(승인 아님 u1 · PR 연결 없음 u2) · 미조회(q).
//   ㄱ-4 가 모르는 회차(gate4Known:false)면 전부 미조회. 연결 병합의 판정이 APPROVED 가 아니고 NOT_APPROVED 도 아니면(UNDECIDABLE · 창 밖 · 못 본 것) 미조회(0 으로 접지 않는다).
export function judgeLinearDoneBinding({
  events,
  merges,
  shaStatuses,
  gate4Known,
  viewerId,
}) {
  const statusOf = new Map((shaStatuses ?? []).map((s) => [s.sha, s.status]));
  const r = {
    known: true,
    total: events.length,
    bound: 0,
    unbound: 0,
    unboundNotApproved: 0,
    unboundNoPr: 0,
    unchecked: 0,
    sameActor: 0,
  };
  for (const e of events) {
    if (viewerId && e.actorId === viewerId) r.sameActor += 1;
    if (gate4Known !== true) {
      r.unchecked += 1;
      continue;
    }
    const link = linkedMerge(merges, e);
    if (!link) {
      r.unbound += 1;
      r.unboundNoPr += 1;
      continue;
    }
    const status = statusOf.get(link.sha);
    if (status === APPROVAL_STATUS.APPROVED) r.bound += 1;
    else if (status === APPROVAL_STATUS.NOT_APPROVED) {
      r.unbound += 1;
      r.unboundNotApproved += 1;
    } else r.unchecked += 1;
  }
  return r;
}

const unknown = (reason) => ({ known: false, reason });

function readKey({ loadKeyFn, repoRoot, env }) {
  try {
    return loadKeyFn(repoRoot, env) ?? null;
  } catch {
    return null;
  }
}

// 수집 1회 -- 키(S1) -> 병합 목록(S5) -> Linear 1회(S2 · S3 · S4) -> 판정. 던지지 않는다(예외도 UNKNOWN). 반환 = {known:true, …counts} | {known:false, reason}.
export async function collectLinearDoneBinding({
  repoRoot,
  env,
  loadKeyFn = loadLinearApiKey,
  linearFetch,
  git,
  windowStartMs,
  windowEndMs,
  gate4,
}) {
  const keyInfo = readKey({ loadKeyFn, repoRoot, env });
  if (!keyInfo?.key) return unknown("키 없음");
  const apiKey = keyInfo.key;
  try {
    const log = git.run([...MERGE_LOG_ARGS]);
    if (log.code !== 0) return unknown("병합 목록 실패");
    const merges = parseMergeLinks(log.stdout);
    const port = createLinearHistoryPort({ apiKey, linearFetch });
    const res = await port.readDoneHistory({
      sinceIso: new Date(windowStartMs).toISOString(),
    });
    if (!res.ok) return unknown(`Linear 응답 실패: ${res.reason}`);
    const parsed = parseLinearDoneEvents(res.json, {
      windowStartMs,
      windowEndMs,
    });
    if (parsed.known !== true) return unknown(parsed.reason);
    return judgeLinearDoneBinding({
      events: parsed.events,
      merges,
      shaStatuses: gate4?.shaStatuses,
      gate4Known: gate4?.known === true,
      viewerId: parsed.viewerId,
    });
  } catch (err) {
    return unknown(`수집 예외: ${sanitizeReason(err?.message ?? err, apiKey)}`);
  }
}
